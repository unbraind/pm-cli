import fs from "node:fs/promises";
import { createHistoryEntry } from "../../core/history/history.js";
import { executeHistoryRewrite } from "../../core/history/history-rewrite.js";
import {
  cloneEmptyReplayDocument,
  historyEntriesToRaw,
  replayHash,
  replayToItemDocument,
  toReplayDocument,
  tryApplyReplayPatch,
  verifyHistoryChain,
  type ReplayDocument,
} from "../../core/history/replay.js";
import { resolveItemTypeRegistry } from "../../core/item/type-registry.js";
import { pathExists, readFileIfExists, writeFileAtomic } from "../../core/fs/fs-utils.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { nowIso } from "../../core/shared/time.js";
import { getActiveExtensionRegistrations, runActiveOnWriteHooks } from "../../core/extensions/index.js";
import { readLocatedItem } from "../../core/store/item-store.js";
import { getSettingsPath, resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import { resolveAuthor } from "../../core/shared/author.js";
import type { HistoryEntry } from "../../types/index.js";
import { readHistoryEntries } from "./history.js";
import { resolveHistorySubject } from "./history-redact.js";

export interface HistoryCompactCommandOptions {
  before?: string;
  dryRun?: boolean;
  author?: string;
  message?: string;
  force?: boolean;
}

type HistoryCompactBoundaryKind = "default" | "version" | "timestamp";

interface HistoryCompactBoundary {
  kind: HistoryCompactBoundaryKind;
  raw: string | null;
  compactCount: number;
  retainedCount: number;
}

export interface HistoryCompactResult {
  id: string;
  dry_run: boolean;
  changed: boolean;
  compact_boundary: {
    kind: HistoryCompactBoundaryKind;
    before: string | null;
    entries_compacted: number;
    entries_retained: number;
    first_retained_entry: number | null;
  };
  history: {
    path: string;
    entries_scanned: number;
    entries_after: number;
    baseline_entry_added: boolean;
    audit_entry_added: boolean;
    verify_ok: boolean;
    verify_errors: string[];
  };
  item: {
    exists: boolean;
    path: string | null;
    matched_chain_before: boolean | null;
  };
  warnings: string[];
  generated_at: string;
}

function parseBeforeBoundary(before: string | undefined, entries: HistoryEntry[]): HistoryCompactBoundary {
  if (before === undefined) {
    return {
      kind: "default",
      raw: null,
      compactCount: entries.length,
      retainedCount: 0,
    };
  }

  const raw = before.trim();
  if (raw.length === 0) {
    throw new PmCliError("history-compact --before requires a non-empty value.", EXIT_CODE.USAGE);
  }

  if (/^\d+$/.test(raw)) {
    const version = Number.parseInt(raw, 10);
    if (!Number.isSafeInteger(version) || version < 1 || version > entries.length + 1) {
      throw new PmCliError(
        `history-compact --before version must be between 1 and ${entries.length + 1}.`,
        EXIT_CODE.USAGE,
      );
    }
    const compactCount = Math.max(0, Math.min(entries.length, version - 1));
    return {
      kind: "version",
      raw,
      compactCount,
      retainedCount: entries.length - compactCount,
    };
  }

  const beforeTs = Date.parse(raw);
  if (!Number.isFinite(beforeTs)) {
    throw new PmCliError(
      `Invalid history-compact --before value "${before}". Use a version number or ISO timestamp.`,
      EXIT_CODE.USAGE,
    );
  }

  let compactCount = 0;
  for (const [index, entry] of entries.entries()) {
    const entryTs = Date.parse(entry.ts);
    if (!Number.isFinite(entryTs)) {
      throw new PmCliError(
        `History for this item contains invalid timestamp at entry ${index + 1}.`,
        EXIT_CODE.GENERIC_FAILURE,
      );
    }
    if (entryTs >= beforeTs) {
      break;
    }
    compactCount += 1;
  }

  return {
    kind: "timestamp",
    raw,
    compactCount,
    retainedCount: entries.length - compactCount,
  };
}

function applyHistoryPatch(current: ReplayDocument, entry: HistoryEntry, entryNumber: number): ReplayDocument {
  const result = tryApplyReplayPatch(current, entry.patch);
  if (!result.ok) {
    throw new PmCliError(
      `history-compact failed to apply patch at entry ${entryNumber} (op=${entry.op}): ${
        result.error instanceof Error ? result.error.message : String(result.error)
      }`,
      EXIT_CODE.GENERIC_FAILURE,
    );
  }
  return result.document;
}

function replayHistoryAndResolveCheckpoint(
  entries: HistoryEntry[],
  compactCount: number,
): {
  checkpoint: ReplayDocument;
  finalReplay: ReplayDocument;
} {
  let replay = cloneEmptyReplayDocument();
  let checkpoint = cloneEmptyReplayDocument();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (replayHash(replay) !== entry.before_hash) {
      throw new PmCliError(
        `history-compact detected before-hash drift at entry ${index + 1}; run pm history-repair first.`,
        EXIT_CODE.CONFLICT,
      );
    }
    replay = applyHistoryPatch(replay, entry, index + 1);
    if (replayHash(replay) !== entry.after_hash) {
      throw new PmCliError(
        `history-compact detected after-hash drift at entry ${index + 1}; run pm history-repair first.`,
        EXIT_CODE.CONFLICT,
      );
    }
    if (index + 1 === compactCount) {
      checkpoint = structuredClone(replay);
    }
  }
  return {
    checkpoint,
    finalReplay: replay,
  };
}

function reanchorRetainedEntries(
  retainedEntries: HistoryEntry[],
  seed: ReplayDocument,
  retainedEntryOffset: number,
): {
  entries: HistoryEntry[];
  finalReplay: ReplayDocument;
} {
  let replay = structuredClone(seed);
  const rewritten: HistoryEntry[] = [];
  for (const [index, entry] of retainedEntries.entries()) {
    const beforeHash = replayHash(replay);
    replay = applyHistoryPatch(replay, entry, retainedEntryOffset + index + 1);
    rewritten.push({
      ...entry,
      before_hash: beforeHash,
      after_hash: replayHash(replay),
    });
  }
  return {
    entries: rewritten,
    finalReplay: replay,
  };
}

export async function runHistoryCompact(
  id: string,
  options: HistoryCompactCommandOptions,
  global: GlobalOptions,
): Promise<HistoryCompactResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(`Tracker is not initialized at ${pmRoot}. Run pm init first.`, EXIT_CODE.NOT_FOUND);
  }

  const settings = await readSettings(pmRoot);
  const typeRegistry = resolveItemTypeRegistry(settings, getActiveExtensionRegistrations());
  const subject = await resolveHistorySubject(pmRoot, id, settings, typeRegistry.type_to_folder);
  const historyPath = subject.historyPath;
  const historyRawBeforeLock = await readFileIfExists(historyPath);
  if (historyRawBeforeLock === null) {
    throw new PmCliError(`No history stream exists for ${subject.id}.`, EXIT_CODE.NOT_FOUND);
  }
  const historyEntries = await readHistoryEntries(historyPath, subject.id);
  if (historyEntries.length === 0) {
    throw new PmCliError(`No history entries exist for ${subject.id}; nothing to compact.`, EXIT_CODE.USAGE);
  }

  const chainVerification = verifyHistoryChain(historyEntries);
  if (!chainVerification.ok) {
    throw new PmCliError(
      `history-compact requires a valid history chain (${chainVerification.errors.join(", ")}). Run pm history-repair ${subject.id} first.`,
      EXIT_CODE.CONFLICT,
    );
  }

  const boundary = parseBeforeBoundary(options.before, historyEntries);
  const changed = boundary.compactCount > 0;
  const dryRun = Boolean(options.dryRun);
  const author = resolveAuthor(options.author, settings.author_default);
  const warnings: string[] = [];
  if (!changed) {
    warnings.push("history_compact_noop_before_boundary");
  }

  const loadedItem = subject.located ? await readLocatedItem(subject.located, { schema: settings.schema }) : null;
  const currentItemRawBeforeLock = loadedItem?.raw ?? null;
  const matchedChainBefore =
    loadedItem === null
      ? null
      : replayHash(toReplayDocument(loadedItem.document)) === historyEntries[historyEntries.length - 1]?.after_hash;
  if (matchedChainBefore === false) {
    warnings.push("history_compact_item_chain_mismatch");
  }

  let rewrittenEntries: HistoryEntry[] = historyEntries;
  let baselineEntryAdded = false;
  let auditEntryAdded = false;

  if (changed) {
    const { checkpoint, finalReplay } = replayHistoryAndResolveCheckpoint(historyEntries, boundary.compactCount);
    const retained = historyEntries.slice(boundary.compactCount);
    const reanchored = reanchorRetainedEntries(retained, checkpoint, boundary.compactCount);
    const baselineEntry = createHistoryEntry({
      nowIso: nowIso(),
      author,
      op: "history_compact_baseline",
      before: replayToItemDocument(cloneEmptyReplayDocument()),
      after: replayToItemDocument(checkpoint),
      message:
        boundary.raw === null
          ? `history-compact baseline snapshot after compacting ${boundary.compactCount} entr${
              boundary.compactCount === 1 ? "y" : "ies"
            }.`
          : `history-compact baseline snapshot before ${boundary.raw}.`,
    });
    rewrittenEntries = [baselineEntry, ...reanchored.entries];
    baselineEntryAdded = true;
    const compactMessage =
      typeof options.message === "string" && options.message.trim().length > 0
        ? options.message
        : boundary.raw === null
          ? `history-compact compacted full stream (${boundary.compactCount} entr${
              boundary.compactCount === 1 ? "y" : "ies"
            }).`
          : `history-compact compacted ${boundary.compactCount} entr${
              boundary.compactCount === 1 ? "y" : "ies"
            } before ${boundary.raw}.`;
    if (!dryRun) {
      rewrittenEntries.push(
        createHistoryEntry({
          nowIso: nowIso(),
          author,
          op: "history_compact",
          before: replayToItemDocument(finalReplay),
          after: replayToItemDocument(finalReplay),
          message: compactMessage,
        }),
      );
      auditEntryAdded = true;
    }
  }

  const rewrittenVerify = verifyHistoryChain(rewrittenEntries);
  if (!rewrittenVerify.ok) {
    throw new PmCliError(
      `history-compact produced an invalid rewritten chain (${rewrittenVerify.errors.join(", ")}).`,
      EXIT_CODE.GENERIC_FAILURE,
    );
  }

  if (changed && !dryRun) {
    warnings.push(
      ...(await executeHistoryRewrite({
        pmRoot,
        subject,
        settings,
        typeRegistry,
        historyRawBeforeLock,
        currentItemRawBeforeLock,
        operation: "history-compact",
        author,
        force: options.force,
        itemDocument: loadedItem?.document ?? null,
        applyRewrite: async ({ historyRawUnderLock }) => {
          try {
            await writeFileAtomic(historyPath, historyEntriesToRaw(rewrittenEntries));
          } catch (error) {
            if (historyRawUnderLock === null) {
              await fs.rm(historyPath, { force: true });
            } else {
              await writeFileAtomic(historyPath, historyRawUnderLock);
            }
            throw error;
          }
        },
        applyPostRewrite: async () =>
          runActiveOnWriteHooks({
            path: historyPath,
            scope: "project",
            op: "history_compact:history",
          }),
      })),
    );
  }

  const firstRetainedEntry = boundary.retainedCount > 0 ? boundary.compactCount + 1 : null;
  return {
    id: subject.id,
    dry_run: dryRun,
    changed,
    compact_boundary: {
      kind: boundary.kind,
      before: boundary.raw,
      entries_compacted: boundary.compactCount,
      entries_retained: boundary.retainedCount,
      first_retained_entry: firstRetainedEntry,
    },
    history: {
      path: historyPath,
      entries_scanned: historyEntries.length,
      entries_after: rewrittenEntries.length,
      baseline_entry_added: baselineEntryAdded,
      audit_entry_added: auditEntryAdded,
      verify_ok: rewrittenVerify.ok,
      verify_errors: rewrittenVerify.errors,
    },
    item: {
      exists: subject.located !== null,
      path: subject.located?.itemPath ?? null,
      matched_chain_before: matchedChainBefore,
    },
    warnings: [...new Set(warnings)].sort((left, right) => left.localeCompare(right)),
    generated_at: nowIso(),
  };
}
