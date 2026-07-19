/**
 * @module sdk/merge/driver
 *
 * File-level git merge driver runner for tracker artifacts. Git invokes the
 * driver with the base (%O), ours (%A), and theirs (%B) temporary files; the
 * driver writes the merged content back to the ours path and reports whether
 * unresolvable conflicts remain. Conflicted artifacts are still written as
 * parseable documents (resolved toward the preferred side) so a conflicted
 * merge never corrupts tracker storage the way raw conflict markers do.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getActiveExtensionRegistrations } from "../../core/extensions/index.js";
import { collectRegisteredItemFieldNames } from "../../core/extensions/item-fields.js";
import { pathExists } from "../../core/fs/fs-utils.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { nowIso } from "../../core/shared/time.js";
import { getSettingsPath, resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import type { ItemFormat, PmSettings } from "../../types/index.js";
import {
  mergeHistoryStreams,
  mergeItemDocuments,
  mergeJsonDocuments,
  type MergePreferredSide,
} from "./three-way.js";

/** Supported values accepted by the merge driver artifact contract across CLI, SDK, and MCP surfaces. */
export const MERGE_DRIVER_ARTIFACT_VALUES = [
  "item",
  "history",
  "json",
] as const;
/** Restricts merge driver artifact values accepted by command, SDK, and storage contracts. */
export type MergeDriverArtifact = (typeof MERGE_DRIVER_ARTIFACT_VALUES)[number];

/** Documents the merge driver options payload exchanged by command, SDK, and package integrations. */
export interface MergeDriverOptions {
  /** Artifact class being merged: item document, history JSONL stream, or key-level JSON config. */
  artifact: string;
  /** Path to the common-ancestor version (git %O). */
  basePath: string;
  /** Path to the current-branch version (git %A); also the default output path per the git merge-driver protocol. */
  oursPath: string;
  /** Path to the other-branch version (git %B). */
  theirsPath: string;
  /** Optional explicit output path overriding the git default of writing to the ours path. */
  outputPath?: string;
  /** Original repository-relative item path supplied by Git as `%P`, used to detect item format when temporary side paths lack extensions. */
  itemPath?: string;
  /** Side that wins unresolvable conflicts (default "ours"). */
  prefer?: string;
}

/** Documents the merge driver result payload exchanged by command, SDK, and package integrations. */
export interface MergeDriverResult {
  /** Whether the merge completed without unresolvable conflicts. */
  ok: boolean;
  /** Artifact class that was merged. */
  artifact: MergeDriverArtifact;
  /** Path the merged content was written to. */
  output_path: string;
  /** Side unresolvable conflicts were resolved toward. */
  preferred: MergePreferredSide;
  /** Unresolvable conflict labels: metadata field names (item), dotted key paths (json). Empty for history merges. */
  conflicts: string[];
  /** History-merge strategy and entry accounting; present only for the history artifact. */
  history?: {
    strategy: string;
    common_entries: number;
    entries_from_ours: number;
    entries_from_theirs: number;
    entries_total: number;
    reanchored: boolean;
  };
  /** Item-merge field accounting; present only for the item artifact. */
  item?: {
    fields_from_theirs: string[];
    union_fields: string[];
  };
  /** JSON-merge key accounting; present only for the json artifact. */
  json?: {
    paths_from_theirs: string[];
  };
  /** Guidance for resolving remaining conflicts or verifying the merged workspace. */
  guidance: string[];
  /** ISO 8601 timestamp recording when generated occurred. */
  generated_at: string;
}

function resolveArtifact(value: string): MergeDriverArtifact {
  const normalized = value.trim().toLowerCase();
  if (
    (MERGE_DRIVER_ARTIFACT_VALUES as readonly string[]).includes(normalized)
  ) {
    return normalized as MergeDriverArtifact;
  }
  throw new PmCliError(
    `Unknown merge artifact "${value}". Supported values: ${MERGE_DRIVER_ARTIFACT_VALUES.join(", ")}.`,
    EXIT_CODE.USAGE,
  );
}

function resolvePreferredSide(value: string | undefined): MergePreferredSide {
  if (value === undefined) {
    return "ours";
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "ours" || normalized === "theirs") {
    return normalized;
  }
  throw new PmCliError(
    `Unknown --prefer value "${value}". Supported values: ours, theirs.`,
    EXIT_CODE.USAGE,
  );
}

async function readSideFile(filePath: string, label: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    throw new PmCliError(
      `Cannot read merge ${label} file at ${filePath}.`,
      EXIT_CODE.NOT_FOUND,
    );
  }
}

/**
 * Load the workspace settings when a tracker is initialized at the resolved pm
 * root, or fall back to format defaults when the driver runs outside a tracker
 * (git can invoke merge drivers before `pm init`, e.g. while rebasing the
 * commit that introduces the tracker).
 */
async function loadOptionalSettings(
  global: GlobalOptions,
): Promise<PmSettings | null> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    return null;
  }
  return readSettings(pmRoot);
}

function itemFormatForPath(
  filePath: string,
  settings: PmSettings | null,
): ItemFormat {
  if (filePath.endsWith(".md")) {
    return "json_markdown";
  }
  if (filePath.endsWith(".toon")) {
    return "toon";
  }
  return settings?.item_format ?? "toon";
}

/**
 * Execute one git merge-driver invocation for a tracker artifact. Reads the
 * three per-side versions, applies the artifact's field-aware merge semantics,
 * writes the merged content (parseable even when conflicted) to the output
 * path, and reports remaining conflicts so the CLI can exit non-zero and let
 * git mark the path unmerged.
 */
export async function runMergeDriver(
  options: MergeDriverOptions,
  global: GlobalOptions,
): Promise<MergeDriverResult> {
  const artifact = resolveArtifact(options.artifact);
  const preferred = resolvePreferredSide(options.prefer);
  const outputPath = path.resolve(options.outputPath ?? options.oursPath);
  const [baseRaw, oursRaw, theirsRaw] = await Promise.all([
    readSideFile(options.basePath, "base"),
    readSideFile(options.oursPath, "ours"),
    readSideFile(options.theirsPath, "theirs"),
  ]);

  let merged: string;
  const conflicts: string[] = [];
  const result: Partial<MergeDriverResult> = {};
  if (artifact === "history") {
    const historyMerge = mergeHistoryStreams(baseRaw, oursRaw, theirsRaw);
    merged = historyMerge.merged;
    result.history = {
      strategy: historyMerge.strategy,
      common_entries: historyMerge.common_entries,
      entries_from_ours: historyMerge.entries_from_ours,
      entries_from_theirs: historyMerge.entries_from_theirs,
      entries_total: historyMerge.entries_total,
      reanchored: historyMerge.reanchored,
    };
  } else if (artifact === "item") {
    const settings = await loadOptionalSettings(global);
    const itemMerge = mergeItemDocuments(baseRaw, oursRaw, theirsRaw, {
      format: itemFormatForPath(options.itemPath ?? outputPath, settings),
      schema: settings?.schema,
      extensionFieldNames: collectRegisteredItemFieldNames(
        getActiveExtensionRegistrations(),
      ),
      preferred,
    });
    merged = itemMerge.merged;
    conflicts.push(...itemMerge.conflict_fields);
    result.item = {
      fields_from_theirs: itemMerge.fields_from_theirs,
      union_fields: itemMerge.union_fields,
    };
  } else {
    const jsonMerge = mergeJsonDocuments(baseRaw, oursRaw, theirsRaw, {
      preferred,
    });
    merged = jsonMerge.merged;
    conflicts.push(...jsonMerge.conflict_paths);
    result.json = {
      paths_from_theirs: jsonMerge.paths_from_theirs,
    };
  }

  await writeFile(outputPath, merged, "utf8");
  const guidance: string[] = [];
  if (conflicts.length > 0) {
    guidance.push(
      `Both branches changed ${conflicts.join(", ")}; the ${preferred} value was kept. Review the merged file, re-apply the losing change if needed, then "git add" it.`,
    );
  }
  if (artifact === "history" && result.history?.reanchored) {
    guidance.push(
      'The merged history chain was re-anchored. Run "pm validate --check-history-drift" and "pm history-repair --all" after the merge to reconcile item state with merged history.',
    );
  }
  return {
    ok: conflicts.length === 0,
    artifact,
    output_path: outputPath,
    preferred,
    conflicts,
    ...result,
    guidance,
    generated_at: nowIso(),
  };
}
