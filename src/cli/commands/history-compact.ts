/**
 * @module cli/commands/history-compact
 *
 * Implements the pm history compact command surface and its agent-facing runtime behavior.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createHistoryEntry } from "../../core/history/history.js";
import {
  selectHistoryCompactBulkTargets,
  type HistoryCompactBulkCandidate,
  type HistoryCompactBulkSkipReason,
  type HistoryCompactScope,
} from "../../core/history/history-compact-bulk.js";
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
import { lifecycleClassifierFromStatusRegistry } from "../../core/governance/metadata-coverage.js";
import { resolveRuntimeStatusRegistry } from "../../core/schema/runtime-schema.js";
import { listAllFrontMatterLight } from "../../core/store/item-store.js";
import { pathExists, readFileIfExists, writeFileAtomic } from "../../core/fs/fs-utils.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { nowIso } from "../../core/shared/time.js";
import {
  getActiveExtensionRegistrations,
  runActiveOnReadHooks,
  runActiveOnWriteHooks,
} from "../../core/extensions/index.js";
import { readLocatedItem } from "../../core/store/item-store.js";
import { getSettingsPath, resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import { resolveAuthor } from "../../core/shared/author.js";
import type { HistoryEntry } from "../../types/index.js";
import { readHistoryEntries } from "./history.js";
import { resolveHistorySubject } from "./history-redact.js";

/**
 * Documents the history compact command options payload exchanged by command, SDK, and package integrations.
 */
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

interface HistoryCompactCurrentItem {
  loadedItem: Awaited<ReturnType<typeof readLocatedItem>> | null;
  currentItemRawBeforeLock: string | null;
  matchedChainBefore: boolean | null;
}

/**
 * Documents the history compact result payload exchanged by command, SDK, and package integrations.
 */
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

async function loadHistoryCompactCurrentItem(
  subject: Awaited<ReturnType<typeof resolveHistorySubject>>,
  settings: Awaited<ReturnType<typeof readSettings>>,
  historyEntries: HistoryEntry[],
): Promise<HistoryCompactCurrentItem> {
  const loadedItem = subject.located ? await readLocatedItem(subject.located, { schema: settings.schema }) : null;
  if (!loadedItem) {
    return { loadedItem: null, currentItemRawBeforeLock: null, matchedChainBefore: null };
  }
  return {
    loadedItem,
    currentItemRawBeforeLock: loadedItem.raw,
    matchedChainBefore: replayHash(toReplayDocument(loadedItem.document)) === historyEntries[historyEntries.length - 1]?.after_hash,
  };
}

function buildHistoryCompactMessage(options: HistoryCompactCommandOptions, boundary: HistoryCompactBoundary): string {
  if (typeof options.message === "string" && options.message.trim().length > 0) {
    return options.message;
  }
  if (boundary.raw === null) {
    return `history-compact compacted full stream (${boundary.compactCount} entr${
      boundary.compactCount === 1 ? "y" : "ies"
    }).`;
  }
  return `history-compact compacted ${boundary.compactCount} entr${
    boundary.compactCount === 1 ? "y" : "ies"
  } before ${boundary.raw}.`;
}

function buildHistoryCompactBaselineMessage(boundary: HistoryCompactBoundary): string {
  if (boundary.raw === null) {
    return `history-compact baseline snapshot after compacting ${boundary.compactCount} entr${
      boundary.compactCount === 1 ? "y" : "ies"
    }.`;
  }
  return `history-compact baseline snapshot before ${boundary.raw}.`;
}

function buildHistoryCompactEntries(params: {
  historyEntries: HistoryEntry[];
  boundary: HistoryCompactBoundary;
  changed: boolean;
  dryRun: boolean;
  author: string;
  options: HistoryCompactCommandOptions;
}): { rewrittenEntries: HistoryEntry[]; baselineEntryAdded: boolean; auditEntryAdded: boolean } {
  if (!params.changed) {
    return { rewrittenEntries: params.historyEntries, baselineEntryAdded: false, auditEntryAdded: false };
  }
  const { checkpoint, finalReplay } = replayHistoryAndResolveCheckpoint(params.historyEntries, params.boundary.compactCount);
  const retained = params.historyEntries.slice(params.boundary.compactCount);
  const reanchored = reanchorRetainedEntries(retained, checkpoint, params.boundary.compactCount);
  const baselineEntry = createHistoryEntry({
    nowIso: nowIso(),
    author: params.author,
    op: "history_compact_baseline",
    before: replayToItemDocument(cloneEmptyReplayDocument()),
    after: replayToItemDocument(checkpoint),
    message: buildHistoryCompactBaselineMessage(params.boundary),
  });
  const rewrittenEntries = [baselineEntry, ...reanchored.entries];
  if (!params.dryRun) {
    rewrittenEntries.push(
      createHistoryEntry({
        nowIso: nowIso(),
        author: params.author,
        op: "history_compact",
        before: replayToItemDocument(finalReplay),
        after: replayToItemDocument(finalReplay),
        message: buildHistoryCompactMessage(params.options, params.boundary),
      }),
    );
  }
  return { rewrittenEntries, baselineEntryAdded: true, auditEntryAdded: !params.dryRun };
}

async function applyHistoryCompactRewrite(params: {
  pmRoot: string;
  subject: Awaited<ReturnType<typeof resolveHistorySubject>>;
  settings: Awaited<ReturnType<typeof readSettings>>;
  typeRegistry: ReturnType<typeof resolveItemTypeRegistry>;
  historyRawBeforeLock: string;
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
    operation: "history-compact",
    author: params.author,
    force: params.force,
    itemDocument: params.loadedItem?.document ?? null,
    applyRewrite: async ({ historyRawUnderLock }) => {
      try {
        await writeFileAtomic(params.historyPath, historyEntriesToRaw(params.rewrittenEntries));
      } catch (error) {
        if (historyRawUnderLock === null) {
          await fs.rm(params.historyPath, { force: true });
        } else {
          await writeFileAtomic(params.historyPath, historyRawUnderLock);
        }
        throw error;
      }
    },
    applyPostRewrite: async () =>
      runActiveOnWriteHooks({
        path: params.historyPath,
        scope: "project",
        op: "history_compact:history",
      }),
  });
}

/**
 * Implements run history compact for the public runtime surface of this module.
 */
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

  const currentItem = await loadHistoryCompactCurrentItem(subject, settings, historyEntries);
  if (currentItem.matchedChainBefore === false) {
    warnings.push("history_compact_item_chain_mismatch");
  }

  const { rewrittenEntries, baselineEntryAdded, auditEntryAdded } = buildHistoryCompactEntries({
    historyEntries,
    boundary,
    changed,
    dryRun,
    author,
    options,
  });

  const rewrittenVerify = verifyHistoryChain(rewrittenEntries);
  if (!rewrittenVerify.ok) {
    throw new PmCliError(
      `history-compact produced an invalid rewritten chain (${rewrittenVerify.errors.join(", ")}).`,
      EXIT_CODE.GENERIC_FAILURE,
    );
  }

  if (changed && !dryRun) {
    warnings.push(
      ...(await applyHistoryCompactRewrite({
        pmRoot,
        subject,
        settings,
        typeRegistry,
        historyRawBeforeLock,
        currentItemRawBeforeLock: currentItem.currentItemRawBeforeLock,
        author,
        force: options.force,
        loadedItem: currentItem.loadedItem,
        historyPath,
        rewrittenEntries,
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
      matched_chain_before: currentItem.matchedChainBefore,
    },
    warnings: [...new Set(warnings)].sort((left, right) => left.localeCompare(right)),
    generated_at: nowIso(),
  };
}

/** Default entry floor below which a stream is treated as already compact. */
export const HISTORY_COMPACT_BULK_DEFAULT_MIN_ENTRIES = 3;

/**
 * Documents the bulk history compact command options payload exchanged by command, SDK, and package integrations.
 */
export interface HistoryCompactBulkCommandOptions {
  ids?: string[];
  scope?: HistoryCompactScope;
  allOver?: number;
  minEntries?: number;
  dryRun?: boolean;
  author?: string;
  message?: string;
  force?: boolean;
}

/** Per-item outcome row in a bulk compaction pass. */
export interface HistoryCompactBulkItemResult {
  id: string;
  outcome: "compacted" | "skipped" | "errored";
  entries_before: number;
  entries_after: number | null;
  skip_reason: HistoryCompactBulkSkipReason | null;
  changed: boolean;
  error: string | null;
}

/**
 * Documents the bulk history compact result payload exchanged by command, SDK, and package integrations.
 */
export interface HistoryCompactBulkResult {
  bulk: true;
  dry_run: boolean;
  mode: "ids" | "scan";
  scope: HistoryCompactScope | null;
  criteria: {
    min_entries: number;
    all_over: number | null;
    policy_threshold_applied: boolean;
  };
  totals: {
    streams_considered: number;
    selected: number;
    items_compacted: number;
    items_skipped: number;
    items_errored: number;
  };
  results: HistoryCompactBulkItemResult[];
  generated_at: string;
}

/**
 * Enforce the `pm history-compact` target contract shared by the CLI and MCP
 * surfaces: exactly one selection mode — a single item `<id>`, an explicit
 * `--ids` list, or a scan selector (`--all-over` / `--closed` / `--all-streams`).
 */
export function assertHistoryCompactTarget(
  id: string | undefined,
  bulk: { ids?: string[]; allOver?: number; scope?: HistoryCompactScope },
): void {
  const hasIds = bulk.ids !== undefined && bulk.ids.length > 0;
  const hasScan = bulk.allOver !== undefined || bulk.scope !== undefined;
  const selectorCount = (id !== undefined ? 1 : 0) + (hasIds ? 1 : 0) + (hasScan ? 1 : 0);
  if (selectorCount === 0) {
    throw new PmCliError(
      "history-compact: provide an item <id>, or a bulk selector (--ids, --all-over <N>, --closed, or --all-streams).",
      EXIT_CODE.USAGE,
    );
  }
  if (id !== undefined && (hasIds || hasScan)) {
    throw new PmCliError(
      "history-compact: <id> and bulk selectors (--ids/--all-over/--closed/--all-streams) are mutually exclusive; pass one item id, or use bulk mode without a positional id.",
      EXIT_CODE.USAGE,
    );
  }
  if (hasIds && hasScan) {
    throw new PmCliError(
      "history-compact: --ids is mutually exclusive with --all-over/--closed/--all-streams; pass an explicit id list or a scan selector, not both.",
      EXIT_CODE.USAGE,
    );
  }
}

function countHistoryStreamEntries(raw: string): number {
  let count = 0;
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim().length > 0) {
      count += 1;
    }
  }
  return count;
}

async function collectHistoryCompactBulkCandidates(params: {
  pmRoot: string;
  settings: Awaited<ReturnType<typeof readSettings>>;
  typeToFolder: Record<string, string>;
}): Promise<{ candidates: HistoryCompactBulkCandidate[]; preselectionErrors: HistoryCompactBulkItemResult[] }> {
  const statusRegistry = resolveRuntimeStatusRegistry(params.settings.schema);
  const classifier = lifecycleClassifierFromStatusRegistry(statusRegistry);
  const items = await listAllFrontMatterLight(
    params.pmRoot,
    params.settings.item_format,
    params.typeToFolder,
    undefined,
    params.settings.schema,
  );
  const bucketById = new Map(items.map((item) => [item.id, classifier.classify(item.status)] as const));
  const historyDir = path.join(params.pmRoot, "history");
  const candidates: HistoryCompactBulkCandidate[] = [];
  const preselectionErrors: HistoryCompactBulkItemResult[] = [];
  if (!(await pathExists(historyDir))) {
    return { candidates, preselectionErrors };
  }
  const historyFiles = (await fs.readdir(historyDir))
    .filter((entry) => entry.endsWith(".jsonl"))
    .sort((left, right) => left.localeCompare(right));
  for (const fileName of historyFiles) {
    const historyPath = path.join(historyDir, fileName);
    const id = fileName.slice(0, -".jsonl".length);
    try {
      const raw = await fs.readFile(historyPath, "utf8");
      await runActiveOnReadHooks({ path: historyPath, scope: "project" });
      candidates.push({ id, entries: countHistoryStreamEntries(raw), bucket: bucketById.get(id) ?? null });
    } catch (error) {
      preselectionErrors.push({
        id,
        outcome: "errored",
        entries_before: 0,
        entries_after: null,
        skip_reason: null,
        changed: false,
        /* c8 ignore next -- non-Error throws are normalized in defensive fallback. */
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { candidates, preselectionErrors };
}

async function runHistoryCompactBulkRow(params: {
  row: ReturnType<typeof selectHistoryCompactBulkTargets>[number];
  options: HistoryCompactBulkCommandOptions;
  dryRun: boolean;
  global: GlobalOptions;
}): Promise<{ result: HistoryCompactBulkItemResult; selected: boolean; compacted: boolean; errored: boolean }> {
  if (!params.row.selected) {
    return {
      selected: false,
      compacted: false,
      errored: false,
      result: {
        id: params.row.id,
        outcome: "skipped",
        entries_before: params.row.entries,
        entries_after: null,
        skip_reason: params.row.skip_reason,
        changed: false,
        error: null,
      },
    };
  }
  try {
    const result = await runHistoryCompact(
      params.row.id,
      {
        dryRun: params.dryRun,
        author: params.options.author,
        message: params.options.message,
        force: params.options.force,
      },
      params.global,
    );
    return {
      selected: true,
      compacted: true,
      errored: false,
      result: {
        id: params.row.id,
        outcome: "compacted",
        entries_before: params.row.entries,
        entries_after: result.history.entries_after,
        skip_reason: null,
        changed: result.changed,
        error: null,
      },
    };
  } catch (error) {
    return {
      selected: true,
      compacted: false,
      errored: true,
      result: {
        id: params.row.id,
        outcome: "errored",
        entries_before: params.row.entries,
        entries_after: null,
        skip_reason: null,
        changed: false,
        /* c8 ignore next -- non-Error throws are normalized in defensive fallback. */
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/**
 * Bulk history compaction: compact every history stream matching the requested
 * selection (explicit `--ids`, a `--scope` lifecycle filter, and/or an
 * `--all-over <N>` entry threshold) in one audited pass. Each selected stream is
 * compacted with the same single-item logic ({@link runHistoryCompact}); one
 * failing stream never aborts the rest, and the caller decides the exit code
 * from `totals.items_errored`.
 *
 * When `history.compact_policy` is enabled and no explicit `--all-over` is
 * given, the policy's `max_entries` is used as the scan threshold so the
 * configured policy drives the sweep.
 */
export async function runHistoryCompactBulk(
  options: HistoryCompactBulkCommandOptions,
  global: GlobalOptions,
): Promise<HistoryCompactBulkResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(`Tracker is not initialized at ${pmRoot}. Run pm init first.`, EXIT_CODE.NOT_FOUND);
  }

  const settings = await readSettings(pmRoot);
  const typeRegistry = resolveItemTypeRegistry(settings, getActiveExtensionRegistrations());
  const { candidates, preselectionErrors } = await collectHistoryCompactBulkCandidates({
    pmRoot,
    settings,
    typeToFolder: typeRegistry.type_to_folder,
  });

  const mode: "ids" | "scan" = options.ids !== undefined && options.ids.length > 0 ? "ids" : "scan";
  const minEntries = options.minEntries ?? HISTORY_COMPACT_BULK_DEFAULT_MIN_ENTRIES;
  const policy = settings.history.compact_policy;
  const policyThresholdApplied = mode === "scan" && options.allOver === undefined && policy.enabled;
  const allOver = options.allOver ?? (policyThresholdApplied ? policy.max_entries : undefined);

  const selection = selectHistoryCompactBulkTargets(candidates, {
    ids: options.ids,
    scope: options.scope,
    minEntries,
    allOver,
  });

  const dryRun = Boolean(options.dryRun);
  const results: HistoryCompactBulkItemResult[] = [...preselectionErrors];
  const totals = {
    streams_considered: candidates.length + preselectionErrors.length,
    selected: 0,
    items_compacted: 0,
    items_skipped: 0,
    items_errored: preselectionErrors.length,
  };
  for (const row of selection) {
    const outcome = await runHistoryCompactBulkRow({ row, options, dryRun, global });
    results.push(outcome.result);
    if (!outcome.selected) {
      totals.items_skipped += 1;
      continue;
    }
    totals.selected += 1;
    if (outcome.compacted) {
      totals.items_compacted += 1;
    }
    if (outcome.errored) {
      totals.items_errored += 1;
    }
  }

  return {
    bulk: true,
    dry_run: dryRun,
    mode,
    scope: options.scope ?? null,
    criteria: {
      min_entries: minEntries,
      all_over: allOver ?? null,
      policy_threshold_applied: policyThresholdApplied,
    },
    totals,
    results,
    generated_at: nowIso(),
  };
}
