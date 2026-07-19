/**
 * @module sdk/governance/storage-integrity
 *
 * Post-merge storage-integrity check for `pm validate`: fails the workspace
 * when tracker storage is provably corrupted in ways the ordinary read path
 * silently tolerates — unparseable item documents (skipped by the list scan),
 * history streams containing unresolved merge-conflict markers, deleted items
 * silently resurrected by a delete/modify merge, and configuration or schema
 * files whose parse failure would otherwise fall back to defaults behind a
 * green gate. This is the detection half of the tracker merge-semantics
 * contract; the merge drivers in `sdk/merge` are the prevention half.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { readFileIfExists } from "../../core/fs/fs-utils.js";
import {
  parseItemDocument,
  type ItemDocumentFormatOptions,
} from "../../core/item/item-format.js";
import { findFirstMergeConflictMarker } from "../../core/shared/conflict-markers.js";
import {
  getSettingsPath,
  ITEM_FILE_EXTENSIONS,
} from "../../core/store/paths.js";
import type { HistoryEntry } from "../../types/index.js";

/** Documents one unreadable item-file finding surfaced by the storage-integrity check. */
export interface UnreadableItemFileRow {
  /** Tracker-relative path of the item file that failed to parse. */
  path: string;
  /** Item id derived from the file name. */
  id: string;
}

/** Documents one history-stream finding surfaced by the storage-integrity check. */
export interface HistoryStreamIntegrityRow {
  /** Item id whose history stream is affected. */
  id: string;
  /** Tracker-relative path of the history stream. */
  path: string;
  /** Line number of the first offending content, when line-addressable. */
  line?: number;
  /** Failure detail (conflict marker text or parse failure reason). */
  detail: string;
}

/** Documents one resurrection-candidate finding: a live item whose history says it was deleted. */
export interface ResurrectedItemRow {
  /** Live item id whose newest history operation is a delete. */
  id: string;
  /** Timestamp of the recorded delete operation. */
  deleted_at: string;
  /** Author of the recorded delete operation. */
  deleted_by: string;
}

/** Documents one duplicate-item-id finding: one id claimed by multiple item documents (cross-branch add/add collision or duplicated format variant). */
export interface DuplicateItemIdRow {
  /** Item id claimed by more than one on-disk document. */
  id: string;
  /** Tracker-relative paths of every document claiming the id, sorted for determinism. */
  paths: string[];
}

/** Documents one unparseable configuration/schema file finding. */
export interface UnparseableConfigRow {
  /** Tracker-relative path of the configuration file. */
  path: string;
  /** Failure detail (conflict marker location or JSON parse failure). */
  detail: string;
}

/** Documents the storage-integrity scan result consumed by the validate check builder. */
export interface StorageIntegrityScanResult {
  /** Number of item files present on disk across all type folders. */
  item_files_on_disk: number;
  /** Number of distinct item ids present on disk. */
  item_ids_on_disk: number;
  /** Number of items the standard read path successfully parsed. */
  parsed_items: number;
  /** Item files whose ids the standard read path could not parse (silently skipped elsewhere). */
  unreadable_item_files: UnreadableItemFileRow[];
  /** Ids claimed by more than one item document (post-merge add/add id collisions across type folders or format variants; GH-600). */
  duplicate_item_ids: DuplicateItemIdRow[];
  /** Number of history streams scanned. */
  history_streams_scanned: number;
  /** History streams containing unresolved merge-conflict markers. */
  history_conflict_marker_streams: HistoryStreamIntegrityRow[];
  /** History streams containing an entry that is not a JSON object. */
  history_unparseable_streams: HistoryStreamIntegrityRow[];
  /** Live items whose newest history operation is a delete (delete/modify merge resurrection candidates). */
  resurrected_items: ResurrectedItemRow[];
  /** Streams whose final entry is a non-empty history_repair reconciliation patch — the post-repair divergence signal (informational, not a failure). */
  history_repair_reconciliations: number;
  /** Number of configuration/schema files scanned. */
  config_files_scanned: number;
  /** Configuration/schema files that cannot be parsed (silent-defaults fallback risk). */
  unparseable_config_files: UnparseableConfigRow[];
}

/** Runtime schema context used to parse every physical item file exactly as the ordinary read path does. */
export interface StorageIntegrityItemParseOptions {
  /** Active runtime schema, including unknown-field policy and custom field definitions. */
  schema?: ItemDocumentFormatOptions["schema"];
  /** Item fields contributed by active extensions and therefore valid under a rejecting schema. */
  extensionFieldNames?: readonly string[];
}

async function listItemFilesOnDisk(
  pmRoot: string,
  typeToFolder: Record<string, string>,
): Promise<Array<{ relativePath: string; id: string }>> {
  const folders = [...new Set(Object.values(typeToFolder))];
  const found: Array<{ relativePath: string; id: string }> = [];
  await Promise.all(
    folders.map(async (folder) => {
      let entries: string[];
      try {
        entries = await fs.readdir(path.join(pmRoot, folder));
      } catch {
        return;
      }
      for (const entry of entries) {
        for (const extension of ITEM_FILE_EXTENSIONS) {
          if (entry.toLowerCase().endsWith(extension)) {
            found.push({
              relativePath: `${folder}/${entry}`,
              id: entry.slice(0, -extension.length),
            });
            break;
          }
        }
      }
    }),
  );
  return found.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );
}

interface HistoryStreamScanAccumulator {
  conflictMarkers: HistoryStreamIntegrityRow[];
  unparseable: HistoryStreamIntegrityRow[];
  resurrected: ResurrectedItemRow[];
  repairReconciliations: number;
  scanned: number;
}

function scanHistoryStreamContent(
  accumulator: HistoryStreamAccumulatorInput,
  raw: string,
): void {
  const { id, relativePath, liveItemIds, out } = accumulator;
  out.scanned += 1;
  const conflictMarker = findFirstMergeConflictMarker(raw);
  if (conflictMarker) {
    out.conflictMarkers.push({
      id,
      path: relativePath,
      line: conflictMarker.line,
      detail: `unresolved merge conflict marker ${conflictMarker.marker}`,
    });
    return;
  }
  let latestEntry: HistoryEntry | null = null;
  const lines = raw
    .split(/\r?\n/)
    .map((line, index) => ({ content: line.trim(), number: index + 1 }))
    .filter((line) => line.content.length > 0);
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line.content) as unknown;
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        throw new TypeError("history entry must be an object");
      }
      latestEntry = parsed as HistoryEntry;
    } catch {
      out.unparseable.push({
        id,
        path: relativePath,
        line: line.number,
        detail: "history line is not a valid JSON object",
      });
      return;
    }
  }
  if (latestEntry === null) {
    return;
  }
  if (latestEntry.op === "delete" && liveItemIds.has(id)) {
    out.resurrected.push({
      id,
      deleted_at: typeof latestEntry.ts === "string" ? latestEntry.ts : "",
      deleted_by:
        typeof latestEntry.author === "string" ? latestEntry.author : "",
    });
  }
  if (
    latestEntry.op === "history_repair" &&
    Array.isArray(latestEntry.patch) &&
    latestEntry.patch.length > 0
  ) {
    out.repairReconciliations += 1;
  }
}

interface HistoryStreamAccumulatorInput {
  id: string;
  relativePath: string;
  liveItemIds: Set<string>;
  out: HistoryStreamScanAccumulator;
}

async function scanHistoryStreams(
  pmRoot: string,
  liveItemIds: Set<string>,
): Promise<HistoryStreamScanAccumulator> {
  const out: HistoryStreamScanAccumulator = {
    conflictMarkers: [],
    unparseable: [],
    resurrected: [],
    repairReconciliations: 0,
    scanned: 0,
  };
  let entries: string[];
  try {
    entries = await fs.readdir(path.join(pmRoot, "history"));
  } catch {
    return out;
  }
  for (const entry of entries.sort((left, right) =>
    left.localeCompare(right),
  )) {
    if (!entry.endsWith(".jsonl")) {
      continue;
    }
    const raw = await fs.readFile(path.join(pmRoot, "history", entry), "utf8");
    scanHistoryStreamContent(
      {
        id: entry.slice(0, -".jsonl".length),
        relativePath: `history/${entry}`,
        liveItemIds,
        out,
      },
      raw,
    );
  }
  return out;
}

function describeUnparseableJson(raw: string): string | null {
  const conflictMarker = findFirstMergeConflictMarker(raw);
  if (conflictMarker) {
    return `unresolved merge conflict marker ${conflictMarker.marker} at line ${conflictMarker.line}`;
  }
  try {
    JSON.parse(raw);
    return null;
  } catch (error) {
    return `invalid JSON (${String(error)})`;
  }
}

async function scanConfigFiles(pmRoot: string): Promise<{
  scanned: number;
  unparseable: UnparseableConfigRow[];
}> {
  const unparseable: UnparseableConfigRow[] = [];
  let scanned = 0;
  const settingsRaw = await readFileIfExists(getSettingsPath(pmRoot));
  if (settingsRaw !== null) {
    scanned += 1;
    const detail = describeUnparseableJson(settingsRaw);
    if (detail !== null) {
      unparseable.push({ path: "settings.json", detail });
    }
  }
  let schemaEntries: string[];
  try {
    schemaEntries = await fs.readdir(path.join(pmRoot, "schema"));
  } catch {
    return { scanned, unparseable };
  }
  for (const entry of schemaEntries.sort((left, right) =>
    left.localeCompare(right),
  )) {
    if (!entry.endsWith(".json")) {
      continue;
    }
    const raw = await fs.readFile(path.join(pmRoot, "schema", entry), "utf8");
    scanned += 1;
    const detail = describeUnparseableJson(raw);
    if (detail !== null) {
      unparseable.push({ path: `schema/${entry}`, detail });
    }
  }
  return { scanned, unparseable };
}

/**
 * Scan tracker storage for integrity failures the ordinary read path masks.
 * `parsedItemIds` are the ids the standard cached list scan successfully
 * parsed; any on-disk item file whose id is missing from that set is an
 * unreadable document that `pm get` would hard-error on while list-based
 * commands silently skip it.
 */
export async function scanStorageIntegrity(
  pmRoot: string,
  parsedItemIds: ReadonlySet<string>,
  typeToFolder: Record<string, string>,
  itemParseOptions: StorageIntegrityItemParseOptions = {},
): Promise<StorageIntegrityScanResult> {
  const itemFiles = await listItemFilesOnDisk(pmRoot, typeToFolder);
  const idsOnDisk = new Set(itemFiles.map((file) => file.id));
  const pathsById = new Map<string, string[]>();
  for (const file of itemFiles) {
    pathsById.set(file.id, [...(pathsById.get(file.id) ?? []), file.relativePath]);
  }
  const duplicateItemIds: DuplicateItemIdRow[] = [...pathsById.entries()]
    .filter(([, paths]) => paths.length > 1)
    .map(([id, paths]) => ({
      id,
      paths: [...paths].sort((left, right) => left.localeCompare(right)),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const unreadableItemFiles = (
    await Promise.all(
      itemFiles.map(async (file): Promise<UnreadableItemFileRow | null> => {
        if (!parsedItemIds.has(file.id)) {
          return { path: file.relativePath, id: file.id };
        }
        try {
          const absolutePath = path.join(pmRoot, file.relativePath);
          parseItemDocument(await fs.readFile(absolutePath, "utf8"), {
            format: absolutePath.toLowerCase().endsWith(".md")
              ? "json_markdown"
              : "toon",
            schema: itemParseOptions.schema,
            extensionFieldNames: itemParseOptions.extensionFieldNames,
          });
          return null;
        } catch {
          return { path: file.relativePath, id: file.id };
        }
      }),
    )
  ).filter((row): row is UnreadableItemFileRow => row !== null);
  // "Live" for resurrection detection means an item file exists on disk —
  // deleted items keep their history stream but lose the document, so a
  // delete-terminated stream is only suspicious when the document is back.
  const historyScan = await scanHistoryStreams(pmRoot, idsOnDisk);
  const configScan = await scanConfigFiles(pmRoot);
  return {
    item_files_on_disk: itemFiles.length,
    item_ids_on_disk: idsOnDisk.size,
    parsed_items: parsedItemIds.size,
    unreadable_item_files: unreadableItemFiles,
    duplicate_item_ids: duplicateItemIds,
    history_streams_scanned: historyScan.scanned,
    history_conflict_marker_streams: historyScan.conflictMarkers,
    history_unparseable_streams: historyScan.unparseable,
    resurrected_items: historyScan.resurrected,
    history_repair_reconciliations: historyScan.repairReconciliations,
    config_files_scanned: configScan.scanned,
    unparseable_config_files: configScan.unparseable,
  };
}
