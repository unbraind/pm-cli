/**
 * @module sdk/telemetry
 *
 * Implements the pm telemetry command surface and its agent-facing runtime behavior.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { pathExists, readFileIfExists } from "../core/fs/fs-utils.js";
import { EXIT_CODE } from "../core/shared/constants.js";
import type { GlobalOptions } from "../core/shared/command-types.js";
import { PmCliError } from "../core/shared/errors.js";
import { nowIso } from "../core/shared/time.js";
import { resolveGlobalPmRoot } from "../core/store/paths.js";
import { readSettings, writeSettings } from "../core/store/settings.js";
import { flushTelemetryQueueNow } from "../core/telemetry/runtime.js";

const TELEMETRY_QUEUE_RELATIVE_PATH = path.join(
  "runtime",
  "telemetry",
  "events.jsonl",
);
const TELEMETRY_STATE_RELATIVE_PATH = path.join(
  "runtime",
  "telemetry",
  "state.json",
);
const TELEMETRY_RUNTIME_RELATIVE_PATH = path.join("runtime", "telemetry");
const DEFAULT_STATS_LIMIT = 20;

/** Public contract for telemetry subcommands, shared by SDK and presentation-layer consumers. */
export const TELEMETRY_SUBCOMMANDS = [
  "status",
  "flush",
  "stats",
  "clear",
] as const;
/** Restricts telemetry subcommand values accepted by command, SDK, and storage contracts. */
export type TelemetrySubcommand = (typeof TELEMETRY_SUBCOMMANDS)[number];

interface TelemetryRuntimeStateRecord {
  endpoint?: string;
  queue_entries?: number;
  last_attempted_flush_at?: string;
  last_successful_flush_at?: string;
  last_failed_flush_at?: string;
  last_failed_flush_error?: string;
}

interface QueuedTelemetryEventRecord {
  attempts: number;
  client_schema_version?: number;
  event: {
    event_id?: string;
    event_type?: string;
    schema_version?: number;
    command?: string;
    payload?: Record<string, unknown>;
  };
}

interface ParsedTelemetryQueue {
  rows_total: number;
  valid_entries: number;
  invalid_rows: number;
  entries: QueuedTelemetryEventRecord[];
}

interface TelemetryStatusSummary {
  enabled: boolean;
  endpoint: string;
  queue_path: string;
  state_path: string;
  queue_rows_total: number;
  queue_entries: number;
  queue_invalid_rows: number;
  queue_size_bytes: number;
  last_attempted_flush_at: string | null;
  last_successful_flush_at: string | null;
  last_failed_flush_at: string | null;
  last_failed_flush_error: string | null;
}

/** Documents the telemetry command options payload exchanged by command, SDK, and package integrations. */
export interface TelemetryCommandOptions {
  /** Value that configures or reports subcommand for this contract. */
  subcommand?: string;
  /** Value that configures or reports limit for this contract. */
  limit?: string | number;
}

interface TelemetryStatsBucket {
  command: string;
  count: number;
  event_type_counts: Record<string, number>;
  max_attempts: number;
  event_schema_versions: number[];
  client_schema_versions: number[];
  /** Latency percentiles (nearest-rank) over `duration_ms` from the bucket's `command_finish` events. Present only when at least one finish event carries a finite `duration_ms`; `command_start`/`command_error` events are excluded. */
  duration_p50_ms?: number;
  duration_p95_ms?: number;
  duration_max_ms?: number;
  /** Success/failure tally derived from `command_finish` payload `ok`. A finish event whose `ok` is missing or not strictly `true` is counted as an error (conservative). Present only when the bucket has at least one finish event; `ok_count + error_count` equals that finish-event count. */
  ok_count?: number;
  error_count?: number;
  error_rate?: number;
  /** Distribution of `command_resolution` over `command_finish` events; present only when non-empty. */
  command_resolution_counts?: Record<string, number>;
}

interface TelemetryStatsBucketAccumulator {
  count: number;
  max_attempts: number;
  event_type_counts: Record<string, number>;
  event_schema_versions: Set<number>;
  client_schema_versions: Set<number>;
  finish_durations_ms: number[];
  ok_count: number;
  error_count: number;
  resolution_counts: Record<string, number>;
}

interface NormalizedTelemetryQueueEntry {
  command: string;
  eventType: string;
  eventSchemaVersion: number | undefined;
  clientSchemaVersion: number | undefined;
}

/**
 * Returns the nearest-rank percentile of an ascending-sorted, non-empty array.
 *
 * Uses the nearest-rank method (rank = ceil(fraction × n), 1-based, clamped into
 * range) so the result is always an observed sample value with no interpolation.
 */
const nearestRankPercentile = (
  sortedAscending: number[],
  fraction: number,
): number => {
  const rank = Math.ceil(fraction * sortedAscending.length);
  const index = Math.min(sortedAscending.length - 1, Math.max(0, rank - 1));
  return sortedAscending[index];
};

/** Normalizes optional text while substituting a stable fallback for blanks. */
const normalizeTelemetryText = (value: unknown, fallback: string): string => {
  if (typeof value !== "string") {
    return fallback;
  }
  return value.trim().length > 0 ? value : fallback;
};

/** Truncates finite numeric metadata while rejecting other runtime shapes. */
const normalizeFiniteInteger = (value: unknown): number | undefined => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.trunc(value);
};

const normalizeTelemetryQueueEntry = (
  entry: QueuedTelemetryEventRecord,
): NormalizedTelemetryQueueEntry => {
  return {
    command: normalizeTelemetryText(entry.event.command, "<unknown>"),
    eventType: normalizeTelemetryText(entry.event.event_type, "unknown"),
    eventSchemaVersion: normalizeFiniteInteger(entry.event.schema_version),
    clientSchemaVersion: normalizeFiniteInteger(entry.client_schema_version),
  };
};

const createTelemetryStatsAccumulator = (): TelemetryStatsBucketAccumulator => {
  return {
    count: 0,
    max_attempts: 0,
    event_type_counts: {},
    event_schema_versions: new Set<number>(),
    client_schema_versions: new Set<number>(),
    finish_durations_ms: [],
    ok_count: 0,
    error_count: 0,
    resolution_counts: {},
  };
};

/** Keeps a finite duration sample from an optional finish payload. */
const readTelemetryDuration = (
  payload: Record<string, unknown> | undefined,
): number | undefined => {
  const value = payload?.duration_ms;
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
};

/** Keeps a non-blank resolution from an optional finish payload. */
const readTelemetryResolution = (
  payload: Record<string, unknown> | undefined,
): string | undefined => {
  const value = payload?.command_resolution;
  return normalizeTelemetryText(value, "") || undefined;
};

/** Increments a named counter in an object-backed frequency map. */
const incrementTelemetryCount = (
  counts: Record<string, number>,
  key: string,
): void => {
  counts[key] = (counts[key] ?? 0) + 1;
};

const recordTelemetryFinishPayload = (
  current: TelemetryStatsBucketAccumulator,
  payload: Record<string, unknown> | undefined,
): void => {
  const durationMs = readTelemetryDuration(payload);
  if (durationMs !== undefined) {
    current.finish_durations_ms.push(durationMs);
  }
  if (payload?.ok === true) {
    current.ok_count += 1;
  } else {
    current.error_count += 1;
  }
  const resolution = readTelemetryResolution(payload);
  if (resolution !== undefined) {
    incrementTelemetryCount(current.resolution_counts, resolution);
  }
};

/** Normalizes retry attempts to a non-negative finite integer. */
const normalizeTelemetryAttempts = (attempts: number): number =>
  Number.isFinite(attempts) ? Math.max(0, Math.trunc(attempts)) : 0;

/** Adds a defined numeric value to a set-backed telemetry dimension. */
const addTelemetryDimension = (
  values: Set<number>,
  value: number | undefined,
): void => {
  if (value !== undefined) {
    values.add(value);
  }
};

const recordTelemetryQueueEntry = (
  grouped: Map<string, TelemetryStatsBucketAccumulator>,
  entry: QueuedTelemetryEventRecord,
): void => {
  const normalized = normalizeTelemetryQueueEntry(entry);
  const current =
    grouped.get(normalized.command) ?? createTelemetryStatsAccumulator();
  current.count += 1;
  current.max_attempts = Math.max(
    current.max_attempts,
    normalizeTelemetryAttempts(entry.attempts),
  );
  incrementTelemetryCount(current.event_type_counts, normalized.eventType);
  addTelemetryDimension(
    current.event_schema_versions,
    normalized.eventSchemaVersion,
  );
  addTelemetryDimension(
    current.client_schema_versions,
    normalized.clientSchemaVersion,
  );
  if (normalized.eventType === "command_finish") {
    recordTelemetryFinishPayload(current, entry.event.payload);
  }
  grouped.set(normalized.command, current);
};

const buildTelemetryStatsBucket = (
  command: string,
  value: TelemetryStatsBucketAccumulator,
): TelemetryStatsBucket => {
  const finishCount = value.ok_count + value.error_count;
  const sortedDurations = [...value.finish_durations_ms].sort(
    (left, right) => left - right,
  );
  const resolutionEntries = Object.entries(value.resolution_counts).sort(
    (left, right) => left[0].localeCompare(right[0]),
  );
  return {
    command,
    count: value.count,
    event_type_counts: Object.fromEntries(
      Object.entries(value.event_type_counts).sort((left, right) =>
        left[0].localeCompare(right[0]),
      ),
    ),
    max_attempts: value.max_attempts,
    event_schema_versions: [...value.event_schema_versions].sort(
      (left, right) => left - right,
    ),
    client_schema_versions: [...value.client_schema_versions].sort(
      (left, right) => left - right,
    ),
    ...(sortedDurations.length > 0
      ? {
          duration_p50_ms: nearestRankPercentile(sortedDurations, 0.5),
          duration_p95_ms: nearestRankPercentile(sortedDurations, 0.95),
          duration_max_ms: sortedDurations[sortedDurations.length - 1],
        }
      : {}),
    ...(finishCount > 0
      ? {
          ok_count: value.ok_count,
          error_count: value.error_count,
          error_rate: value.error_count / finishCount,
        }
      : {}),
    ...(resolutionEntries.length > 0
      ? { command_resolution_counts: Object.fromEntries(resolutionEntries) }
      : {}),
  };
};

const normalizeTelemetrySubcommand = (
  value: string | undefined,
): TelemetrySubcommand => {
  const normalized = (value ?? "status").trim().toLowerCase();
  if ((TELEMETRY_SUBCOMMANDS as readonly string[]).includes(normalized)) {
    return normalized as TelemetrySubcommand;
  }
  // `value` is always a defined string here: an undefined subcommand normalizes
  // to "status" above (a valid value) and never reaches this throw.
  throw new PmCliError(
    `Unknown pm telemetry subcommand "${value}". Allowed: ${TELEMETRY_SUBCOMMANDS.join(", ")}`,
    EXIT_CODE.USAGE,
    {
      code: "unknown_subcommand",
      examples: [
        "pm telemetry status",
        "pm telemetry flush",
        "pm telemetry stats --limit 10",
        "pm telemetry clear",
      ],
    },
  );
};

/** Throws the stable usage diagnostic for invalid telemetry stats windows. */
const throwInvalidTelemetryLimit = (): never => {
  throw new PmCliError("--limit must be a positive integer", EXIT_CODE.USAGE);
};

/** Validates one already-parsed stats limit. */
const requirePositiveTelemetryLimit = (value: number): number => {
  if (
    [!Number.isFinite(value), !Number.isInteger(value), value <= 0].includes(
      true,
    )
  ) {
    return throwInvalidTelemetryLimit();
  }
  return value;
};

/** Parses and validates the string form accepted by the CLI flag surface. */
const parseTelemetryStringLimit = (raw: string): number => {
  const trimmed = raw.trim();
  if ([trimmed.length === 0, !/^\d+$/.test(trimmed)].includes(true)) {
    return throwInvalidTelemetryLimit();
  }
  return requirePositiveTelemetryLimit(Number.parseInt(trimmed, 10));
};

const parseTelemetryStatsLimit = (raw: unknown): number => {
  if (raw === undefined) {
    return DEFAULT_STATS_LIMIT;
  }
  if (typeof raw === "number") {
    return requirePositiveTelemetryLimit(raw);
  }
  if (typeof raw === "string") {
    return parseTelemetryStringLimit(raw);
  }
  return throwInvalidTelemetryLimit();
};

/** Recognizes the persisted telemetry queue record shape. */
const isTelemetryQueueEntry = (
  value: unknown,
): value is QueuedTelemetryEventRecord => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<QueuedTelemetryEventRecord>;
  return (
    typeof candidate.attempts === "number" &&
    typeof candidate.event === "object" &&
    candidate.event !== null
  );
};

/** Parses one non-blank queue row without leaking JSON failures. */
const parseTelemetryQueueRow = (
  row: string,
): QueuedTelemetryEventRecord | undefined => {
  try {
    const parsed: unknown = JSON.parse(row);
    return isTelemetryQueueEntry(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

/** Splits queue content into non-blank persisted rows. */
const splitTelemetryQueueRows = (raw: string | null): string[] => {
  if (raw === null) {
    return [];
  }
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
};

const parseTelemetryQueue = (raw: string | null): ParsedTelemetryQueue => {
  const rows = splitTelemetryQueueRows(raw);
  const entries: QueuedTelemetryEventRecord[] = [];
  let invalidRows = 0;
  for (const row of rows) {
    const parsed = parseTelemetryQueueRow(row);
    if (parsed === undefined) {
      invalidRows += 1;
    } else {
      entries.push(parsed);
    }
  }
  return {
    rows_total: rows.length,
    valid_entries: entries.length,
    invalid_rows: invalidRows,
    entries,
  };
};

/** Recognizes an object-shaped telemetry runtime state payload. */
const isTelemetryRuntimeState = (
  value: unknown,
): value is TelemetryRuntimeStateRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Parses observational runtime state while treating malformed content as empty. */
const parseTelemetryRuntimeState = (
  raw: string,
): TelemetryRuntimeStateRecord => {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isTelemetryRuntimeState(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

const readTelemetryRuntimeState = async (
  statePath: string,
): Promise<TelemetryRuntimeStateRecord> => {
  const stateRaw = await readFileIfExists(statePath);
  if (stateRaw === null || stateRaw.trim().length === 0) {
    return {};
  }
  return parseTelemetryRuntimeState(stateRaw);
};

/** Converts an optional telemetry state value to an explicit nullable field. */
const nullableTelemetryStateValue = (
  value: string | undefined,
): string | null => value ?? null;

const buildTelemetryStatusSummary = async (
  globalPmRoot: string,
): Promise<TelemetryStatusSummary> => {
  const settings = await readSettings(globalPmRoot);
  const queuePath = path.join(globalPmRoot, TELEMETRY_QUEUE_RELATIVE_PATH);
  const statePath = path.join(globalPmRoot, TELEMETRY_STATE_RELATIVE_PATH);
  const queueRaw = await readFileIfExists(queuePath);
  const queue = parseTelemetryQueue(queueRaw);
  const runtimeState = await readTelemetryRuntimeState(statePath);
  return {
    enabled: settings.telemetry.enabled,
    endpoint: settings.telemetry.endpoint,
    queue_path: queuePath,
    state_path: statePath,
    queue_rows_total: queue.rows_total,
    queue_entries: queue.valid_entries,
    queue_invalid_rows: queue.invalid_rows,
    queue_size_bytes: Buffer.byteLength(queueRaw ?? "", "utf8"),
    last_attempted_flush_at: nullableTelemetryStateValue(
      runtimeState.last_attempted_flush_at,
    ),
    last_successful_flush_at: nullableTelemetryStateValue(
      runtimeState.last_successful_flush_at,
    ),
    last_failed_flush_at: nullableTelemetryStateValue(
      runtimeState.last_failed_flush_at,
    ),
    last_failed_flush_error: nullableTelemetryStateValue(
      runtimeState.last_failed_flush_error,
    ),
  };
};

const buildTelemetryStatsBuckets = (
  entries: QueuedTelemetryEventRecord[],
): TelemetryStatsBucket[] => {
  const grouped = new Map<string, TelemetryStatsBucketAccumulator>();
  for (const entry of entries) {
    // Latency + outcome distribution come from command_finish payloads only:
    // command_finish always carries duration_ms/ok/command_resolution at every
    // capture level, while start/error events do not.
    recordTelemetryQueueEntry(grouped, entry);
  }
  return [...grouped.entries()]
    .map(([command, value]) => buildTelemetryStatsBucket(command, value))
    .sort(
      (left, right) =>
        right.count - left.count || left.command.localeCompare(right.command),
    );
};

interface TelemetryCommandContext {
  globalPmRoot: string;
  queuePath: string;
  statePath: string;
}

type TelemetryCommandHandler = (
  options: TelemetryCommandOptions,
  context: TelemetryCommandContext,
) => Promise<Record<string, unknown>>;

/** Returns current telemetry queue and runtime state without mutation. */
const runTelemetryStatus: TelemetryCommandHandler = async (
  _options,
  context,
) => ({
  action: "telemetry",
  subcommand: "status",
  status: await buildTelemetryStatusSummary(context.globalPmRoot),
  generated_at: nowIso(),
});

/** Flushes queued telemetry and reports the before/after queue state. */
const runTelemetryFlush: TelemetryCommandHandler = async (
  _options,
  context,
) => {
  const before = await buildTelemetryStatusSummary(context.globalPmRoot);
  await flushTelemetryQueueNow(context.globalPmRoot);
  const after = await buildTelemetryStatusSummary(context.globalPmRoot);
  return {
    action: "telemetry",
    subcommand: "flush",
    queue_entries_before: before.queue_entries,
    queue_entries_after: after.queue_entries,
    queue_drained: after.queue_entries < before.queue_entries,
    status: after,
    generated_at: nowIso(),
  };
};

/** Aggregates the offline telemetry queue into bounded command statistics. */
const runTelemetryStats: TelemetryCommandHandler = async (options, context) => {
  const limit = parseTelemetryStatsLimit(options.limit);
  const queueRaw = await readFileIfExists(context.queuePath);
  const queue = parseTelemetryQueue(queueRaw);
  const buckets = buildTelemetryStatsBuckets(queue.entries);
  const selected = buckets.slice(0, limit);
  return {
    action: "telemetry",
    subcommand: "stats",
    limit,
    total_commands: buckets.length,
    queue_entries: queue.valid_entries,
    queue_invalid_rows: queue.invalid_rows,
    queue_rows_total: queue.rows_total,
    truncated: buckets.length > selected.length,
    stats: selected,
    generated_at: nowIso(),
  };
};

/** Clears local telemetry consent identifiers, queue data, and runtime state. */
const runTelemetryClear: TelemetryCommandHandler = async (
  _options,
  context,
) => {
  const settings = await readSettings(context.globalPmRoot);
  const settingsChanged = [
    settings.telemetry.enabled !== false,
    settings.telemetry.installation_id !== "",
    settings.telemetry.first_run_prompt_completed !== true,
  ].includes(true);
  settings.telemetry.enabled = false;
  settings.telemetry.first_run_prompt_completed = true;
  settings.telemetry.installation_id = "";
  if (settingsChanged) {
    await writeSettings(context.globalPmRoot, settings, "telemetry:clear");
  }
  const telemetryRuntimePath = path.join(
    context.globalPmRoot,
    TELEMETRY_RUNTIME_RELATIVE_PATH,
  );
  const existed = await pathExists(telemetryRuntimePath);
  await fs.rm(telemetryRuntimePath, { recursive: true, force: true });
  return {
    action: "telemetry",
    subcommand: "clear",
    settings_changed: settingsChanged,
    runtime_dir_removed: existed && !(await pathExists(telemetryRuntimePath)),
    queue_exists_after: await pathExists(context.queuePath),
    state_exists_after: await pathExists(context.statePath),
    status: await buildTelemetryStatusSummary(context.globalPmRoot),
    generated_at: nowIso(),
  };
};

const TELEMETRY_COMMAND_HANDLERS: Record<
  TelemetrySubcommand,
  TelemetryCommandHandler
> = {
  status: runTelemetryStatus,
  flush: runTelemetryFlush,
  stats: runTelemetryStats,
  clear: runTelemetryClear,
};

/** Implements run telemetry for the public runtime surface of this module. */
export const runTelemetry = async (
  options: TelemetryCommandOptions,
  _global: GlobalOptions,
): Promise<Record<string, unknown>> => {
  void _global;
  const subcommand = normalizeTelemetrySubcommand(options.subcommand);
  const globalPmRoot = resolveGlobalPmRoot(process.cwd());
  return TELEMETRY_COMMAND_HANDLERS[subcommand](options, {
    globalPmRoot,
    queuePath: path.join(globalPmRoot, TELEMETRY_QUEUE_RELATIVE_PATH),
    statePath: path.join(globalPmRoot, TELEMETRY_STATE_RELATIVE_PATH),
  });
};
