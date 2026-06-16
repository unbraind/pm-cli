import fs from "node:fs/promises";
import jsonPatch from "fast-json-patch";
import { pathExists, readFileIfExists, writeFileAtomic } from "../../core/fs/fs-utils.js";
import {
  checkHistoryRewriteOwnership,
  verifyHistoryRewriteNoDrift,
} from "../../core/history/history-rewrite.js";
import {
  historyEntriesToRaw,
  reanchorHistoryEntries,
  replayHash,
  toReplayDocument,
  verifyHistoryChain,
  type ReplayDocument,
} from "../../core/history/replay.js";
import { scanHistoryDrift } from "../../core/history/drift-scan.js";
import { resolveItemTypeRegistry } from "../../core/item/type-registry.js";
import { acquireLock } from "../../core/lock/lock.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { nowIso } from "../../core/shared/time.js";
import { getActiveExtensionRegistrations, runActiveOnWriteHooks } from "../../core/extensions/index.js";
import { listAllFrontMatterWithBody, readLocatedItem } from "../../core/store/item-store.js";
import { getSettingsPath, resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import type { HistoryEntry, HistoryPatchOp, ItemMetadata } from "../../types/index.js";
import { readHistoryEntries } from "./history.js";
import { resolveHistorySubject } from "./history-redact.js";

export interface HistoryRepairCommandOptions {
  dryRun?: boolean;
  author?: string;
  message?: string;
  force?: boolean;
}

export interface HistoryRepairResult {
  id: string;
  dry_run: boolean;
  changed: boolean;
  history: {
    path: string;
    entries_scanned: number;
    chain_drift_before: boolean;
    entries_rehashed: number;
    entries_patch_repaired: number;
    converted_replace_to_add: number;
    skipped_ops: number;
    reconciled_with_item: boolean;
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

function toAuthor(candidate: string | undefined, defaultAuthor: string): string {
  /* c8 ignore next -- PM_AUTHOR fallback branch is environment-dependent in CI. */
  const resolved = candidate ?? process.env.PM_AUTHOR ?? defaultAuthor;
  const trimmed = resolved.trim();
  return trimmed.length > 0 ? trimmed : "unknown";
}

export async function runHistoryRepair(
  id: string,
  options: HistoryRepairCommandOptions,
  global: GlobalOptions,
): Promise<HistoryRepairResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(`Tracker is not initialized at ${pmRoot}. Run pm init first.`, EXIT_CODE.NOT_FOUND);
  }

  const settings = await readSettings(pmRoot);
  const typeRegistry = resolveItemTypeRegistry(settings, getActiveExtensionRegistrations());
  const subject = await resolveHistorySubject(pmRoot, id, settings, typeRegistry.type_to_folder);

  if (!(await pathExists(subject.historyPath))) {
    throw new PmCliError(`No history stream exists for ${subject.id}.`, EXIT_CODE.NOT_FOUND);
  }
  const historyRawBeforeLock = await readFileIfExists(subject.historyPath);
  const historyEntries = await readHistoryEntries(subject.historyPath, subject.id);
  if (historyEntries.length === 0) {
    throw new PmCliError(`No history entries exist for ${subject.id}; nothing to repair.`, EXIT_CODE.USAGE);
  }

  const chainBefore = verifyHistoryChain(historyEntries);
  const reanchor = reanchorHistoryEntries(historyEntries);

  // Reconcile the replayed chain with the current on-disk item document so the
  // latest after_hash matches what pm validate/health compute for the item.
  let currentItemReplay: ReplayDocument | null = null;
  const currentItemPath: string | null = subject.located?.itemPath ?? null;
  let matchedChainBefore: boolean | null = null;
  const loadedItem = subject.located
    ? await readLocatedItem(subject.located, { schema: settings.schema })
    : null;
  const currentItemRawBeforeLock = loadedItem?.raw ?? null;
  if (loadedItem) {
    // Use the shared canonical replay form so reconciliation hashing matches the
    // semantics pm validate/health use for the on-disk item (avoids hash divergence).
    currentItemReplay = toReplayDocument(loadedItem.document);
    const lastOriginalAfterHash = historyEntries[historyEntries.length - 1]?.after_hash;
    matchedChainBefore = replayHash(currentItemReplay) === lastOriginalAfterHash;
  }

  const finalReplay = reanchor.finalDocument;
  const reconcileNeeded =
    currentItemReplay !== null && replayHash(finalReplay) !== replayHash(currentItemReplay);

  const changed = reanchor.entriesRehashed > 0 || reanchor.entriesPatchRepaired > 0 || reconcileNeeded;
  const author = toAuthor(options.author, settings.author_default);
  const dryRun = Boolean(options.dryRun);

  const repairMessage =
    /* c8 ignore next -- generated repair summaries include optional clauses based on rare drift shapes. */
    typeof options.message === "string" && options.message.trim().length > 0
      ? options.message
      : `history-repair re-anchored ${reanchor.entriesRehashed} entr${
          reanchor.entriesRehashed === 1 ? "y" : "ies"
        }${reanchor.entriesPatchRepaired > 0 ? `, repaired ${reanchor.entriesPatchRepaired} patch(es)` : ""}${
          reconcileNeeded ? ", reconciled chain with on-disk item" : ""
        }.`;

  const rewrittenEntries: HistoryEntry[] = [...reanchor.entries];
  let auditEntryAdded = false;
  if (changed) {
    /* c8 ignore next -- reconcile append branch requires hash-drift plus loadable on-disk replay. */
    if (reconcileNeeded && currentItemReplay) {
      rewrittenEntries.push({
        ts: nowIso(),
        author,
        op: "history_repair",
        patch: jsonPatch.compare(finalReplay, currentItemReplay) as HistoryPatchOp[],
        before_hash: replayHash(finalReplay),
        after_hash: replayHash(currentItemReplay),
        message: repairMessage,
      });
    } else {
      rewrittenEntries.push({
        ts: nowIso(),
        author,
        op: "history_repair",
        patch: [],
        before_hash: replayHash(finalReplay),
        after_hash: replayHash(finalReplay),
        message: repairMessage,
      });
    }
    auditEntryAdded = true;
  }

  const historyVerify = verifyHistoryChain(rewrittenEntries);
  if (!historyVerify.ok) {
    throw new PmCliError(
      `history-repair produced an invalid rewritten chain (${historyVerify.errors.join(", ")}).`,
      EXIT_CODE.GENERIC_FAILURE,
    );
  }

  const warnings: string[] = [];
  if (!changed) {
    warnings.push("history_repair_no_changes");
  }
  if (reanchor.skippedOps > 0) {
    warnings.push(`history_repair_skipped_unresolvable_ops:${reanchor.skippedOps}`);
  }

  if (changed && !dryRun) {
    warnings.push(
      ...checkHistoryRewriteOwnership({
        itemDocument: loadedItem?.document ?? null,
        subjectId: subject.id,
        author,
        force: options.force,
        settings,
      }),
    );

    const releaseLock = await acquireLock(
      pmRoot,
      subject.id,
      settings.locks.ttl_seconds,
      author,
      Boolean(options.force),
      settings.governance.force_required_for_stale_lock,
    );
    try {
      const { historyRawUnderLock } = await verifyHistoryRewriteNoDrift({
        pmRoot,
        subject,
        settings,
        typeRegistry,
        historyRawBeforeLock,
        currentItemRawBeforeLock,
        operation: "history-repair",
      });
      try {
        await writeFileAtomic(subject.historyPath, historyEntriesToRaw(rewrittenEntries));
      } catch (error) {
        if (historyRawUnderLock === null) {
          await fs.rm(subject.historyPath, { force: true });
        } else {
          await writeFileAtomic(subject.historyPath, historyRawUnderLock);
        }
        throw error;
      }
      warnings.push(
        ...(await runActiveOnWriteHooks({
          path: subject.historyPath,
          scope: "project",
          op: "history_repair:history",
        })),
      );
    } finally {
      await releaseLock();
    }
  }

  return {
    id: subject.id,
    dry_run: dryRun,
    changed,
    history: {
      path: subject.historyPath,
      entries_scanned: historyEntries.length,
      chain_drift_before: !chainBefore.ok,
      entries_rehashed: reanchor.entriesRehashed,
      entries_patch_repaired: reanchor.entriesPatchRepaired,
      converted_replace_to_add: reanchor.convertedReplaceToAdd,
      skipped_ops: reanchor.skippedOps,
      reconciled_with_item: reconcileNeeded,
      audit_entry_added: auditEntryAdded,
      verify_ok: historyVerify.ok,
      verify_errors: historyVerify.errors,
    },
    item: {
      exists: currentItemPath !== null,
      path: currentItemPath,
      matched_chain_before: matchedChainBefore,
    },
    warnings: [...new Set(warnings)].sort((left, right) => left.localeCompare(right)),
    generated_at: nowIso(),
  };
}

export interface HistoryRepairAllStreamResult {
  id: string;
  outcome: "repaired" | "skipped_clean" | "failed";
  entries_rehashed?: number;
  entries_patch_repaired?: number;
  reconciled_with_item?: boolean;
  error?: string;
}

export interface HistoryRepairAllResult {
  all: true;
  dry_run: boolean;
  scanned_streams: number;
  drifted_streams: number;
  /** One compact row per drifted stream (clean streams are summarized by the counts only). */
  streams: HistoryRepairAllStreamResult[];
  totals: { repaired: number; skipped_clean: number; failed: number };
  warnings: string[];
  generated_at: string;
}

/**
 * Enforce the `pm history-repair` target contract shared by the CLI and MCP
 * surfaces: exactly one of an item `<id>` or `--all` must be provided.
 */
export function assertHistoryRepairTarget(id: string | undefined, all: boolean): void {
  if (all && id !== undefined) {
    throw new PmCliError(
      "history-repair: <id> and --all are mutually exclusive; pass an item id to repair one stream or --all to repair every drifted stream.",
      EXIT_CODE.USAGE,
    );
  }
  if (!all && id === undefined) {
    throw new PmCliError(
      "history-repair: provide an item <id> or pass --all to repair every drifted stream.",
      EXIT_CODE.USAGE,
    );
  }
}

/**
 * Bulk drift repair: scan every item's history stream with the same drift scan
 * `pm health` uses, then run the audited single-stream repair (ownership check,
 * lock, no-drift verification, audit marker) for each drifted stream. One
 * failing stream never aborts the rest; failures are collected per row and the
 * caller decides the exit code from `totals.failed`.
 */
export async function runHistoryRepairAll(
  options: HistoryRepairCommandOptions,
  global: GlobalOptions,
): Promise<HistoryRepairAllResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(`Tracker is not initialized at ${pmRoot}. Run pm init first.`, EXIT_CODE.NOT_FOUND);
  }

  const settings = await readSettings(pmRoot);
  const typeRegistry = resolveItemTypeRegistry(settings, getActiveExtensionRegistrations());
  const itemReadWarnings: string[] = [];
  const items = await listAllFrontMatterWithBody(
    pmRoot,
    settings.item_format,
    typeRegistry.type_to_folder,
    itemReadWarnings,
    settings.schema,
  );
  const drift = await scanHistoryDrift(pmRoot, items as Array<ItemMetadata & { body: string }>);

  const streams: HistoryRepairAllStreamResult[] = [];
  const totals = { repaired: 0, skipped_clean: 0, failed: 0 };
  for (const driftedId of drift.driftedItems) {
    try {
      const result = await runHistoryRepair(driftedId, options, global);
      /* c8 ignore next -- mixed repaired/clean outcomes depend on live drift composition. */
      const outcome = result.changed ? "repaired" : "skipped_clean";
      totals[outcome] += 1;
      streams.push({
        id: driftedId,
        outcome,
        entries_rehashed: result.history.entries_rehashed,
        entries_patch_repaired: result.history.entries_patch_repaired,
        reconciled_with_item: result.history.reconciled_with_item,
      });
    } catch (error) {
      totals.failed += 1;
      streams.push({
        id: driftedId,
        outcome: "failed",
        /* c8 ignore next -- non-Error throws are normalized in defensive fallback. */
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    all: true,
    dry_run: Boolean(options.dryRun),
    scanned_streams: items.length,
    drifted_streams: drift.driftedItems.length,
    streams,
    totals,
    warnings: [...new Set(itemReadWarnings)].sort((left, right) => left.localeCompare(right)),
    generated_at: nowIso(),
  };
}
