/**
 * @module cli/commands/activity
 *
 * Implements the pm activity command surface and its agent-facing runtime behavior.
 */
import fs from "node:fs/promises";
import path from "node:path";
import {
  getActiveExtensionRegistrations,
  runActiveOnReadHooks,
  pathExists,
  enforceHistoryStreamPolicyForItems,
  resolveItemTypeRegistry,
  EXIT_CODE,
  type GlobalOptions,
  PmCliError,
  compareTimestampStrings,
  nowIso,
  resolveIsoOrRelative,
  listAllItemMetadataLight,
  getSettingsPath,
  resolvePmRoot,
  readSettings,
} from "../../sdk/runtime-primitives.js";
import { readHistoryEntries } from "./history.js";
import { parseLimit } from "../shared-parsers.js";
import type { HistoryEntry } from "../../types/index.js";

const DEFAULT_COMPACT_ACTIVITY_LIMIT = 20;
const DEFAULT_FULL_ACTIVITY_LIMIT = 5;

/** Documents the activity command options payload exchanged by command, SDK, and package integrations. */
export interface ActivityCommandOptions {
  /** Stable identifier used to reference this record across commands and storage. */
  id?: string;
  /** Value that configures or reports op for this contract. */
  op?: string;
  /** Value that configures or reports author for this contract. */
  author?: string;
  /** Value that configures or reports from for this contract. */
  from?: string;
  /** Value that configures or reports to for this contract. */
  to?: string;
  /** Value that configures or reports limit for this contract. */
  limit?: string;
  /** Value that configures or reports compact for this contract. */
  compact?: boolean;
  /** Explicitly disables the default activity bound. */
  unbounded?: boolean;
}

/** Documents the activity entry payload exchanged by command, SDK, and package integrations. */
export interface ActivityEntry extends HistoryEntry {
  /** Stable identifier used to reference this record across commands and storage. */
  id: string;
}

/** Documents the compact activity entry payload exchanged by command, SDK, and package integrations. */
export interface CompactActivityEntry {
  /** Stable identifier used to reference this record across commands and storage. */
  id: string;
  /** Value that configures or reports op for this contract. */
  op: string;
  /** Value that configures or reports ts for this contract. */
  ts: string;
  /** Value that configures or reports author for this contract. */
  author: string;
  /** Value that configures or reports msg for this contract. */
  msg?: string;
}

/** Documents the activity result payload exchanged by command, SDK, and package integrations. */
export interface ActivityResult {
  /** Value that configures or reports activity for this contract. */
  activity: ActivityEntry[];
  /** Value that configures or reports compact activity for this contract. */
  compact_activity?: CompactActivityEntry[];
  /** Value that configures or reports compact for this contract. */
  compact: boolean;
  /** Value that configures or reports count for this contract. */
  count: number;
  /** Total matching rows before the applied bound. */
  total_count: number;
  /** Value that configures or reports limit for this contract. */
  limit: number | null;
  /** Number of matching rows withheld by the applied bound. */
  omitted_count: number;
  /** Whether matching rows remain available through a larger or unbounded request. */
  has_more: boolean;
  /** Describes whether the effective bound came from a default, caller input, or an explicit opt-out. */
  applied_bound: {
    kind: "limit" | "unbounded";
    source: "default" | "explicit";
    value: number | null;
  };
}

interface ActivityFilters {
  id: string | undefined;
  op: string | undefined;
  author: string | undefined;
  from: string | undefined;
  to: string | undefined;
  limit: number | undefined;
  limitSource: "default" | "explicit";
}

interface ActivityRuntimeContext {
  pmRoot: string;
  settings: Awaited<ReturnType<typeof readSettings>>;
}

function parseNonEmptyFilter(
  raw: string | undefined,
  flagLabel: string,
): string | undefined {
  if (raw === undefined) return undefined;
  const normalized = raw.trim();
  if (normalized.length === 0) {
    throw new PmCliError(`${flagLabel} must not be empty`, EXIT_CODE.USAGE);
  }
  return normalized;
}

function parseRangeBound(
  raw: string | undefined,
  nowValue: string,
  fieldLabel: string,
): string | undefined {
  if (raw === undefined) return undefined;
  const normalized = raw.trim();
  if (normalized.length === 0) {
    throw new PmCliError(
      "Activity time bounds must not be empty",
      EXIT_CODE.USAGE,
    );
  }
  const relativeInput =
    fieldLabel === "--from" && /^\d+[hdwm]$/iu.test(normalized)
      ? `-${normalized}`
      : normalized;
  return resolveIsoOrRelative(relativeInput, new Date(nowValue), fieldLabel);
}

function includeByTimeWindow(
  entry: ActivityEntry,
  from: string | undefined,
  to: string | undefined,
): boolean {
  if (entry.ts.length === 0 && (from || to)) {
    return false;
  }
  if (from && compareTimestampStrings(entry.ts, from) < 0) {
    return false;
  }
  if (to && compareTimestampStrings(entry.ts, to) >= 0) {
    return false;
  }
  return true;
}

function limitEntries<T>(values: T[], limit: number | undefined): T[] {
  if (limit === undefined) return values;
  return values.slice(0, limit);
}

function readActivityString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function normalizeActivityEntry(
  id: string,
  entry: HistoryEntry,
): ActivityEntry {
  return {
    ...entry,
    id,
    ts: readActivityString(entry.ts),
    author: readActivityString(entry.author, "unknown"),
    op: readActivityString(entry.op, "unknown"),
    patch: Array.isArray(entry.patch) ? entry.patch : [],
    before_hash: readActivityString(entry.before_hash),
    after_hash: readActivityString(entry.after_hash),
  };
}

function sortActivity(entries: ActivityEntry[]): ActivityEntry[] {
  return [...entries].sort((a, b) => {
    const byTimestamp = b.ts.localeCompare(a.ts);
    if (byTimestamp !== 0) return byTimestamp;
    const byId = a.id.localeCompare(b.id);
    if (byId !== 0) return byId;
    return a.op.localeCompare(b.op);
  });
}

async function listHistoryFiles(historyDir: string): Promise<string[]> {
  try {
    return (await fs.readdir(historyDir))
      .filter((entry) => entry.endsWith(".jsonl"))
      .sort((a, b) => a.localeCompare(b));
  } catch (error: unknown) {
    // Activity should degrade gracefully when optional history storage is absent.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function resolveActivityFilters(
  options: ActivityCommandOptions,
): ActivityFilters {
  const nowValue = nowIso();
  const from = parseRangeBound(options.from, nowValue, "--from");
  const to = parseRangeBound(options.to, nowValue, "--to");
  if (from && to && compareTimestampStrings(from, to) >= 0) {
    throw new PmCliError(
      "Activity --from must be before --to",
      EXIT_CODE.USAGE,
    );
  }
  const explicitLimit = parseLimit(options.limit);
  if (options.unbounded === true && explicitLimit !== undefined) {
    throw new PmCliError(
      "Activity --unbounded cannot be combined with --limit",
      EXIT_CODE.USAGE,
    );
  }
  return {
    id: parseNonEmptyFilter(options.id, "Activity --id"),
    op: parseNonEmptyFilter(options.op, "Activity --op"),
    author: parseNonEmptyFilter(options.author, "Activity --author"),
    from,
    to,
    limit:
      options.unbounded === true
        ? undefined
        : (explicitLimit ??
          (options.compact === true
            ? DEFAULT_COMPACT_ACTIVITY_LIMIT
            : DEFAULT_FULL_ACTIVITY_LIMIT)),
    limitSource:
      options.unbounded === true || explicitLimit !== undefined
        ? "explicit"
        : "default",
  };
}

async function resolveActivityRuntimeContext(
  global: GlobalOptions,
): Promise<ActivityRuntimeContext> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(
      `Tracker is not initialized at ${pmRoot}. Run pm init first.`,
      EXIT_CODE.NOT_FOUND,
    );
  }
  return {
    pmRoot,
    settings: await readSettings(pmRoot),
  };
}

async function prepareActivityHistoryRead(
  context: ActivityRuntimeContext,
): Promise<string> {
  const typeRegistry = resolveItemTypeRegistry(
    context.settings,
    getActiveExtensionRegistrations(),
  );
  const items = await listAllItemMetadataLight(
    context.pmRoot,
    context.settings.item_format,
    typeRegistry.type_to_folder,
    undefined,
    context.settings.schema,
  );
  await enforceHistoryStreamPolicyForItems({
    pmRoot: context.pmRoot,
    settings: context.settings,
    itemIds: items.map((item) => item.id),
    commandLabel: "activity",
  });
  const historyDir = path.join(context.pmRoot, "history");
  await runActiveOnReadHooks({
    path: historyDir,
    scope: "project",
  });
  return historyDir;
}

function includeActivityEntry(
  entry: HistoryEntry,
  candidate: ActivityEntry,
  filters: ActivityFilters,
): boolean {
  // Preserve legacy filter semantics: op/author filters compare the raw
  // history row before missing metadata is normalized to "unknown" for display.
  if (filters.op && entry.op !== filters.op) {
    return false;
  }
  if (filters.author && entry.author !== filters.author) {
    return false;
  }
  return includeByTimeWindow(candidate, filters.from, filters.to);
}

async function collectActivityEntries(
  historyDir: string,
  filters: ActivityFilters,
): Promise<ActivityEntry[]> {
  const combined: ActivityEntry[] = [];
  for (const file of await listHistoryFiles(historyDir)) {
    const id = file.slice(0, -".jsonl".length);
    if (filters.id && id !== filters.id) {
      continue;
    }
    const entries = await readHistoryEntries(path.join(historyDir, file), id);
    for (const entry of entries) {
      const candidate = normalizeActivityEntry(id, entry);
      if (includeActivityEntry(entry, candidate, filters)) {
        combined.push(candidate);
      }
    }
  }
  return combined;
}

function formatCompactActivity(
  activity: ActivityEntry[],
): CompactActivityEntry[] {
  return activity.map(
    (entry): CompactActivityEntry => ({
      id: entry.id,
      op: entry.op,
      ts: entry.ts,
      author: entry.author,
      ...(entry.message ? { msg: entry.message } : {}),
    }),
  );
}

/** Public contract for test only, shared by SDK and presentation-layer consumers. */
export const _testOnly = {
  parseNonEmptyFilter,
  parseRangeBound,
  includeByTimeWindow,
  limitEntries,
  readActivityString,
  normalizeActivityEntry,
  sortActivity,
  listHistoryFiles,
};

/** Implements run activity for the public runtime surface of this module. */
export async function runActivity(
  options: ActivityCommandOptions,
  global: GlobalOptions,
): Promise<ActivityResult> {
  const context = await resolveActivityRuntimeContext(global);
  const filters = resolveActivityFilters(options);
  const historyDir = await prepareActivityHistoryRead(context);
  const matchingActivity = sortActivity(
    await collectActivityEntries(historyDir, filters),
  );
  const activity = limitEntries(matchingActivity, filters.limit);
  const compact = options.compact === true;
  const compactActivity = compact ? formatCompactActivity(activity) : undefined;
  const omittedCount = matchingActivity.length - activity.length;
  return {
    activity: compact ? [] : activity,
    compact_activity: compactActivity,
    compact,
    count: activity.length,
    total_count: matchingActivity.length,
    limit: filters.limit ?? null,
    omitted_count: omittedCount,
    has_more: omittedCount > 0,
    applied_bound: {
      kind: filters.limit === undefined ? "unbounded" : "limit",
      source: filters.limitSource,
      value: filters.limit ?? null,
    },
  };
}
