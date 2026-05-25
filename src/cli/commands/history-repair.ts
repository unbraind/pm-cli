import fs from "node:fs/promises";
import jsonPatch from "fast-json-patch";
import { pathExists, readFileIfExists, writeFileAtomic } from "../../core/fs/fs-utils.js";
import {
  historyEntriesToRaw,
  reanchorHistoryEntries,
  replayHash,
  toReplayDocument,
  verifyHistoryChain,
  type ReplayDocument,
} from "../../core/history/replay.js";
import { resolveItemTypeRegistry } from "../../core/item/type-registry.js";
import { acquireLock } from "../../core/lock/lock.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { nowIso } from "../../core/shared/time.js";
import { getActiveExtensionRegistrations, runActiveOnWriteHooks } from "../../core/extensions/index.js";
import { locateItem, readLocatedItem } from "../../core/store/item-store.js";
import { getSettingsPath, resolvePmRoot } from "../../core/store/paths.js";
import { readSettings, resolveGovernanceKnobs } from "../../core/store/settings.js";
import type { HistoryEntry, HistoryPatchOp } from "../../types/index.js";
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
    if (loadedItem) {
      const governance = resolveGovernanceKnobs(settings);
      const assigned = loadedItem.document.metadata.assignee?.trim();
      if (assigned && assigned !== author && !options.force) {
        if (governance.ownership_enforcement === "strict") {
          throw new PmCliError(
            `Item ${subject.id} is assigned to ${assigned}. Use --force to override.`,
            EXIT_CODE.CONFLICT,
          );
        }
        if (governance.ownership_enforcement === "warn") {
          warnings.push(`ownership_warning:assignee_conflict:${subject.id}:${assigned}`);
        }
      }
    }

    const releaseLock = await acquireLock(
      pmRoot,
      subject.id,
      settings.locks.ttl_seconds,
      author,
      Boolean(options.force),
      settings.governance.force_required_for_stale_lock,
    );
    try {
      const historyRawUnderLock = await readFileIfExists(subject.historyPath);
      if (historyRawUnderLock !== historyRawBeforeLock) {
        throw new PmCliError(
          `History for ${subject.id} changed while waiting for lock; retry history-repair.`,
          EXIT_CODE.CONFLICT,
        );
      }
      const locatedUnderLock = await locateItem(
        pmRoot,
        subject.id,
        settings.id_prefix,
        settings.item_format,
        typeRegistry.type_to_folder,
      );
      const loadedItemUnderLock = locatedUnderLock
        ? await readLocatedItem(locatedUnderLock, { schema: settings.schema })
        : null;
      if ((loadedItemUnderLock?.raw ?? null) !== currentItemRawBeforeLock) {
        throw new PmCliError(
          `Item ${subject.id} changed while waiting for lock; retry history-repair.`,
          EXIT_CODE.CONFLICT,
        );
      }
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
