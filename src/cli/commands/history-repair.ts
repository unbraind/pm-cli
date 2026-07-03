/**
 * @module cli/commands/history-repair
 *
 * Implements the pm history repair command surface and its agent-facing runtime behavior.
 */
import jsonPatch from "fast-json-patch";
import { pathExists, readFileIfExists } from "../../core/fs/fs-utils.js";
import { executeHistoryRewrite, writeHistoryRawWithRollback } from "../../core/history/history-rewrite.js";
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

/**
 * Documents the history repair command options payload exchanged by command, SDK, and package integrations.
 */
export interface HistoryRepairCommandOptions {
  dryRun?: boolean;
  author?: string;
  message?: string;
  force?: boolean;
}

/**
 * Documents the history repair result payload exchanged by command, SDK, and package integrations.
 */
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

interface HistoryRepairItemReplayContext {
  currentItemReplay: ReplayDocument | null;
  currentItemPath: string | null;
  matchedChainBefore: boolean | null;
  currentItemRawBeforeLock: string | null;
  loadedItem: Awaited<ReturnType<typeof readLocatedItem>> | null;
}

function toAuthor(candidate: string | undefined, defaultAuthor: string): string {
  /* c8 ignore next -- PM_AUTHOR fallback branch is environment-dependent in CI. */
  const resolved = candidate ?? process.env.PM_AUTHOR ?? defaultAuthor;
  const trimmed = resolved.trim();
  return trimmed.length > 0 ? trimmed : "unknown";
}

async function loadHistoryRepairItemReplay(
  subject: Awaited<ReturnType<typeof resolveHistorySubject>>,
  settings: Awaited<ReturnType<typeof readSettings>>,
  historyEntries: HistoryEntry[],
): Promise<HistoryRepairItemReplayContext> {
  const currentItemPath = subject.located?.itemPath ?? null;
  const loadedItem = subject.located ? await readLocatedItem(subject.located, { schema: settings.schema }) : null;
  if (!loadedItem) {
    return {
      currentItemReplay: null,
      currentItemPath,
      matchedChainBefore: null,
      currentItemRawBeforeLock: null,
      loadedItem: null,
    };
  }
  const currentItemReplay = toReplayDocument(loadedItem.document);
  const lastOriginalAfterHash = historyEntries[historyEntries.length - 1]?.after_hash;
  return {
    currentItemReplay,
    currentItemPath,
    matchedChainBefore: replayHash(currentItemReplay) === lastOriginalAfterHash,
    currentItemRawBeforeLock: loadedItem.raw,
    loadedItem,
  };
}

function buildHistoryRepairMessage(params: {
  message: string | undefined;
  entriesRehashed: number;
  entriesPatchRepaired: number;
  reconcileNeeded: boolean;
}): string {
  if (typeof params.message === "string" && params.message.trim().length > 0) {
    return params.message;
  }
  /* v8 ignore start -- message suffix/plural variants are deterministic formatting fallbacks around the covered repair outcomes */
  return `history-repair re-anchored ${params.entriesRehashed} entr${
    params.entriesRehashed === 1 ? "y" : "ies"
  }${params.entriesPatchRepaired > 0 ? `, repaired ${params.entriesPatchRepaired} patch(es)` : ""}${
    params.reconcileNeeded ? ", reconciled chain with on-disk item" : ""
  }.`;
  /* v8 ignore stop */
}

function buildHistoryRepairEntries(params: {
  reanchorEntries: HistoryEntry[];
  changed: boolean;
  reconcileNeeded: boolean;
  currentItemReplay: ReplayDocument | null;
  finalReplay: ReplayDocument;
  author: string;
  message: string;
}): { rewrittenEntries: HistoryEntry[]; auditEntryAdded: boolean } {
  const rewrittenEntries: HistoryEntry[] = [...params.reanchorEntries];
  if (!params.changed) {
    return { rewrittenEntries, auditEntryAdded: false };
  }
  const afterReplay = params.reconcileNeeded && params.currentItemReplay ? params.currentItemReplay : params.finalReplay;
  rewrittenEntries.push({
    ts: nowIso(),
    author: params.author,
    op: "history_repair",
    patch: params.reconcileNeeded && params.currentItemReplay
      ? (jsonPatch.compare(params.finalReplay, params.currentItemReplay) as HistoryPatchOp[])
      : [],
    before_hash: replayHash(params.finalReplay),
    after_hash: replayHash(afterReplay),
    message: params.message,
  });
  return { rewrittenEntries, auditEntryAdded: true };
}

function collectHistoryRepairWarnings(changed: boolean, skippedOps: number): string[] {
  const warnings: string[] = [];
  if (!changed) {
    warnings.push("history_repair_no_changes");
  }
  if (skippedOps > 0) {
    warnings.push(`history_repair_skipped_unresolvable_ops:${skippedOps}`);
  }
  return warnings;
}

async function applyHistoryRepairRewrite(params: {
  pmRoot: string;
  subject: Awaited<ReturnType<typeof resolveHistorySubject>>;
  settings: Awaited<ReturnType<typeof readSettings>>;
  typeRegistry: ReturnType<typeof resolveItemTypeRegistry>;
  historyRawBeforeLock: string | null;
  currentItemRawBeforeLock: string | null;
  author: string;
  force: boolean | undefined;
  loadedItem: Awaited<ReturnType<typeof readLocatedItem>> | null;
  historyPath: string;
  rewrittenEntries: HistoryEntry[];
}): Promise<string[]> {
  return executeHistoryRewrite({
    pmRoot: params.pmRoot,
    subject: params.subject,
    settings: params.settings,
    typeRegistry: params.typeRegistry,
    historyRawBeforeLock: params.historyRawBeforeLock,
    currentItemRawBeforeLock: params.currentItemRawBeforeLock,
    operation: "history-repair",
    author: params.author,
    force: params.force,
    itemDocument: params.loadedItem?.document ?? null,
    applyRewrite: async ({ historyRawUnderLock }) =>
      writeHistoryRawWithRollback({
        historyPath: params.historyPath,
        nextHistoryRaw: historyEntriesToRaw(params.rewrittenEntries),
        historyRawUnderLock,
      }),
    applyPostRewrite: async () =>
      runActiveOnWriteHooks({
        path: params.historyPath,
        scope: "project",
        op: "history_repair:history",
      }),
  });
}

/**
 * Implements run history repair for the public runtime surface of this module.
 */
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

  const itemReplayContext = await loadHistoryRepairItemReplay(subject, settings, historyEntries);

  const finalReplay = reanchor.finalDocument;
  const reconcileNeeded =
    itemReplayContext.currentItemReplay !== null && replayHash(finalReplay) !== replayHash(itemReplayContext.currentItemReplay);

  const changed = reanchor.entriesRehashed > 0 || reanchor.entriesPatchRepaired > 0 || reconcileNeeded;
  const author = toAuthor(options.author, settings.author_default);
  const dryRun = Boolean(options.dryRun);

  const repairMessage = buildHistoryRepairMessage({
    message: options.message,
    entriesRehashed: reanchor.entriesRehashed,
    entriesPatchRepaired: reanchor.entriesPatchRepaired,
    reconcileNeeded,
  });
  const { rewrittenEntries, auditEntryAdded } = buildHistoryRepairEntries({
    reanchorEntries: reanchor.entries,
    changed,
    reconcileNeeded,
    currentItemReplay: itemReplayContext.currentItemReplay,
    finalReplay,
    author,
    message: repairMessage,
  });

  const historyVerify = verifyHistoryChain(rewrittenEntries);
  if (!historyVerify.ok) {
    throw new PmCliError(
      `history-repair produced an invalid rewritten chain (${historyVerify.errors.join(", ")}).`,
      EXIT_CODE.GENERIC_FAILURE,
    );
  }

  const warnings = collectHistoryRepairWarnings(changed, reanchor.skippedOps);

  if (changed && !dryRun) {
    warnings.push(
      ...(await applyHistoryRepairRewrite({
        pmRoot,
        subject,
        settings,
        typeRegistry,
        historyRawBeforeLock,
        currentItemRawBeforeLock: itemReplayContext.currentItemRawBeforeLock,
        author,
        force: options.force,
        loadedItem: itemReplayContext.loadedItem,
        historyPath: subject.historyPath,
        rewrittenEntries,
      })),
    );
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
      exists: itemReplayContext.currentItemPath !== null,
      path: itemReplayContext.currentItemPath,
      matched_chain_before: itemReplayContext.matchedChainBefore,
    },
    warnings: [...new Set(warnings)].sort((left, right) => left.localeCompare(right)),
    generated_at: nowIso(),
  };
}

/**
 * Documents the history repair all stream result payload exchanged by command, SDK, and package integrations.
 */
export interface HistoryRepairAllStreamResult {
  id: string;
  outcome: "repaired" | "skipped_clean" | "failed";
  entries_rehashed?: number;
  entries_patch_repaired?: number;
  reconciled_with_item?: boolean;
  error?: string;
}

/**
 * Documents the history repair all result payload exchanged by command, SDK, and package integrations.
 */
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
