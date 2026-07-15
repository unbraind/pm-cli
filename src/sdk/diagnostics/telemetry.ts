/**
 * @module sdk/diagnostics/telemetry
 *
 * Implements the pm telemetry command surface and its agent-facing runtime behavior.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { pathExists, readFileIfExists } from "../../core/fs/fs-utils.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { nowIso } from "../../core/shared/time.js";
import { resolveGlobalPmRoot } from "../../core/store/paths.js";
import { readSettings, writeSettings } from "../../core/store/settings.js";
import { flushTelemetryQueueNow } from "../../core/telemetry/runtime.js";

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

/** Snapshot of consent, queue, and last-flush telemetry state. */
export interface TelemetryStatusSummary {
  /** Whether project telemetry consent currently permits collection. */
  enabled: boolean;
  /** Configured delivery endpoint, or an empty string when absent. */
  endpoint: string;
  /** Absolute path of the local durable event queue. */
  queue_path: string;
  /** Absolute path of the local flush-attempt state record. */
  state_path: string;
  /** Total newline-delimited rows encountered in the queue. */
  queue_rows_total: number;
  /** Number of valid queued telemetry event envelopes. */
  queue_entries: number;
  /** Number of malformed queue rows ignored by diagnostics. */
  queue_invalid_rows: number;
  /** Current queue file size in bytes. */
  queue_size_bytes: number;
  /** Timestamp of the most recent flush attempt, when recorded. */
  last_attempted_flush_at: string | null;
  /** Timestamp of the most recent successful flush, when recorded. */
  last_successful_flush_at: string | null;
  /** Timestamp of the most recent failed flush, when recorded. */
  last_failed_flush_at: string | null;
  /** Sanitized diagnostic from the most recent failed flush. */
  last_failed_flush_error: string | null;
}

/** Documents the telemetry command options payload exchanged by command, SDK, and package integrations. */
export interface TelemetryCommandOptions {
  /** Value that configures or reports subcommand for this contract. */
  subcommand?: string;
  /** Value that configures or reports limit for this contract. */
  limit?: string | number;
}

/** Aggregated telemetry outcomes and latency distribution for one command. */
export interface TelemetryStatsBucket {
  /** Canonical command name represented by this aggregate. */
  command: string;
  /** Number of queued events attributed to the command. */
  count: number;
  /** Per-event-type occurrence counts. */
  event_type_counts: Record<string, number>;
  /** Highest delivery-attempt count observed in the bucket. */
  max_attempts: number;
  /** Sorted telemetry envelope schema versions observed. */
  event_schema_versions: number[];
  /** Sorted client schema versions observed. */
  client_schema_versions: number[];
  /** Latency percentiles (nearest-rank) over `duration_ms` from the bucket's `command_finish` events. Present only when at least one finish event carries a finite `duration_ms`; `command_start`/`command_error` events are excluded. */
  duration_p50_ms?: number;
  /** Nearest-rank 95th-percentile command duration. */
  duration_p95_ms?: number;
  /** Longest observed command duration. */
  duration_max_ms?: number;
  /** Success/failure tally derived from `command_finish` payload `ok`. A finish event whose `ok` is missing or not strictly `true` is counted as an error (conservative). Present only when the bucket has at least one finish event; `ok_count + error_count` equals that finish-event count. */
  ok_count?: number;
  /** Conservative failed-finish count for the command. */
  error_count?: number;
  /** Failed finishes divided by all finish events. */
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

/** Structured status response returned by the telemetry SDK primitive. */
export interface TelemetryStatusResult {
  /** Stable action discriminator for telemetry result envelopes. */
  action: "telemetry";
  /** Operation discriminator identifying a status read. */
  subcommand: "status";
  /** Consent, queue, and flush-state snapshot. */
  status: TelemetryStatusSummary;
  /** ISO timestamp at which the snapshot was produced. */
  generated_at: string;
}

/** Structured queue-flush response returned by the telemetry SDK primitive. */
export interface TelemetryFlushResult {
  /** Stable action discriminator for telemetry result envelopes. */
  action: "telemetry";
  /** Operation discriminator identifying a flush attempt. */
  subcommand: "flush";
  /** Valid queued entry count before delivery. */
  queue_entries_before: number;
  /** Valid queued entry count remaining after delivery. */
  queue_entries_after: number;
  /** Whether delivery left no valid entries queued. */
  queue_drained: boolean;
  /** Post-flush consent, queue, and attempt state. */
  status: TelemetryStatusSummary;
  /** ISO timestamp at which the flush result was produced. */
  generated_at: string;
}

/** Structured aggregate response returned by telemetry stats. */
export interface TelemetryStatsResult {
  /** Stable action discriminator for telemetry result envelopes. */
  action: "telemetry";
  /** Operation discriminator identifying aggregation. */
  subcommand: "stats";
  /** Maximum command buckets requested by the caller. */
  limit: number;
  /** Distinct command count before result truncation. */
  total_commands: number;
  /** Number of valid entries considered from the queue. */
  queue_entries: number;
  /** Number of malformed queue rows omitted from aggregation. */
  queue_invalid_rows: number;
  /** Total queue rows considered during parsing. */
  queue_rows_total: number;
  /** Whether the bucket limit omitted lower-ranked commands. */
  truncated: boolean;
  /** Per-command telemetry aggregates ordered by activity. */
  stats: TelemetryStatsBucket[];
  /** ISO timestamp at which aggregation completed. */
  generated_at: string;
}

/** Structured consent and local-runtime cleanup response. */
export interface TelemetryClearResult {
  /** Stable action discriminator for telemetry result envelopes. */
  action: "telemetry";
  /** Operation discriminator identifying consent and runtime cleanup. */
  subcommand: "clear";
  /** Whether persisted telemetry settings changed. */
  settings_changed: boolean;
  /** Whether the local telemetry runtime directory was removed. */
  runtime_dir_removed: boolean;
  /** Whether a queue artifact unexpectedly remains after cleanup. */
  queue_exists_after: boolean;
  /** Whether a flush-state artifact unexpectedly remains after cleanup. */
  state_exists_after: boolean;
  /** Post-cleanup consent, queue, and attempt state. */
  status: TelemetryStatusSummary;
  /** ISO timestamp at which cleanup completed. */
  generated_at: string;
}

/** Complete typed result union for {@link runTelemetry}. */
export type TelemetryResult =
  | TelemetryStatusResult
  | TelemetryFlushResult
  | TelemetryStatsResult
  | TelemetryClearResult;

/**
 * Returns the nearest-rank percentile of an ascending-sorted, non-empty array.
 *
 * Uses the nearest-rank method (rank = ceil(fraction × n), 1-based, clamped into
 * range) so the result is always an observed sample value with no interpolation.
 */
function nearestRankPercentile(
  sortedAscending: number[],
  fraction: number,
): number {
  const rank = Math.ceil(fraction * sortedAscending.length);
  const index = Math.min(sortedAscending.length - 1, Math.max(0, rank - 1));
  return sortedAscending[index];
}

function normalizeTelemetryQueueEntry(
  entry: QueuedTelemetryEventRecord,
): NormalizedTelemetryQueueEntry {
  const command =
    typeof entry.event.command === "string" &&
    entry.event.command.trim().length > 0
      ? entry.event.command
      : "<unknown>";
  const eventType =
    typeof entry.event.event_type === "string" &&
    entry.event.event_type.trim().length > 0
      ? entry.event.event_type
      : "unknown";
  const eventSchemaVersion =
    typeof entry.event.schema_version === "number" &&
    Number.isFinite(entry.event.schema_version)
      ? Math.trunc(entry.event.schema_version)
      : undefined;
  const clientSchemaVersion =
    typeof entry.client_schema_version === "number" &&
    Number.isFinite(entry.client_schema_version)
      ? Math.trunc(entry.client_schema_version)
      : undefined;
  return { command, eventType, eventSchemaVersion, clientSchemaVersion };
}

function createTelemetryStatsAccumulator(): TelemetryStatsBucketAccumulator {
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
}

function recordTelemetryFinishPayload(
  current: TelemetryStatsBucketAccumulator,
  payload: Record<string, unknown> | undefined,
): void {
  const durationMs =
    typeof payload?.duration_ms === "number" &&
    Number.isFinite(payload.duration_ms)
      ? payload.duration_ms
      : undefined;
  if (durationMs !== undefined) {
    current.finish_durations_ms.push(durationMs);
  }
  if (payload?.ok === true) {
    current.ok_count += 1;
  } else {
    current.error_count += 1;
  }
  const resolution =
    typeof payload?.command_resolution === "string" &&
    payload.command_resolution.trim().length > 0
      ? payload.command_resolution
      : undefined;
  if (resolution !== undefined) {
    current.resolution_counts[resolution] =
      (current.resolution_counts[resolution] ?? 0) + 1;
  }
}

function recordTelemetryQueueEntry(
  grouped: Map<string, TelemetryStatsBucketAccumulator>,
  entry: QueuedTelemetryEventRecord,
): void {
  const normalized = normalizeTelemetryQueueEntry(entry);
  const current =
    grouped.get(normalized.command) ?? createTelemetryStatsAccumulator();
  const attempts = Number.isFinite(entry.attempts)
    ? Math.max(0, Math.trunc(entry.attempts))
    : 0;
  current.count += 1;
  current.max_attempts = Math.max(current.max_attempts, attempts);
  current.event_type_counts[normalized.eventType] =
    (current.event_type_counts[normalized.eventType] ?? 0) + 1;
  if (normalized.eventSchemaVersion !== undefined) {
    current.event_schema_versions.add(normalized.eventSchemaVersion);
  }
  if (normalized.clientSchemaVersion !== undefined) {
    current.client_schema_versions.add(normalized.clientSchemaVersion);
  }
  if (normalized.eventType === "command_finish") {
    recordTelemetryFinishPayload(current, entry.event.payload);
  }
  grouped.set(normalized.command, current);
}

function buildTelemetryStatsBucket(
  command: string,
  value: TelemetryStatsBucketAccumulator,
): TelemetryStatsBucket {
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
}

function normalizeTelemetrySubcommand(
  value: string | undefined,
): TelemetrySubcommand {
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
}

function parseTelemetryStatsLimit(raw: string | number | undefined): number {
  if (raw === undefined) {
    return DEFAULT_STATS_LIMIT;
  }
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || !Number.isInteger(raw) || raw <= 0) {
      throw new PmCliError(
        "--limit must be a positive integer",
        EXIT_CODE.USAGE,
      );
    }
    return raw;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0 || !/^\d+$/.test(trimmed)) {
    throw new PmCliError("--limit must be a positive integer", EXIT_CODE.USAGE);
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new PmCliError("--limit must be a positive integer", EXIT_CODE.USAGE);
  }
  return parsed;
}

function parseTelemetryQueue(raw: string | null): ParsedTelemetryQueue {
  if (raw === null || raw.trim().length === 0) {
    return {
      rows_total: 0,
      valid_entries: 0,
      invalid_rows: 0,
      entries: [],
    };
  }
  const entries: QueuedTelemetryEventRecord[] = [];
  let rowsTotal = 0;
  let invalidRows = 0;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    rowsTotal += 1;
    try {
      const parsed = JSON.parse(trimmed) as QueuedTelemetryEventRecord;
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        typeof parsed.attempts === "number" &&
        typeof parsed.event === "object" &&
        parsed.event !== null
      ) {
        entries.push(parsed);
      } else {
        invalidRows += 1;
      }
    } catch {
      invalidRows += 1;
    }
  }
  return {
    rows_total: rowsTotal,
    valid_entries: entries.length,
    invalid_rows: invalidRows,
    entries,
  };
}

async function readTelemetryRuntimeState(
  statePath: string,
): Promise<TelemetryRuntimeStateRecord> {
  const stateRaw = await readFileIfExists(statePath);
  if (stateRaw === null || stateRaw.trim().length === 0) {
    return {};
  }
  try {
    const parsed = JSON.parse(stateRaw) as TelemetryRuntimeStateRecord;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      return parsed;
    }
  } catch {
    // Ignore malformed state files; status command is observational.
  }
  return {};
}

async function buildTelemetryStatusSummary(
  globalPmRoot: string,
): Promise<TelemetryStatusSummary> {
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
    queue_size_bytes:
      queueRaw === null ? 0 : Buffer.byteLength(queueRaw, "utf8"),
    last_attempted_flush_at: runtimeState.last_attempted_flush_at ?? null,
    last_successful_flush_at: runtimeState.last_successful_flush_at ?? null,
    last_failed_flush_at: runtimeState.last_failed_flush_at ?? null,
    last_failed_flush_error: runtimeState.last_failed_flush_error ?? null,
  };
}

function buildTelemetryStatsBuckets(
  entries: QueuedTelemetryEventRecord[],
): TelemetryStatsBucket[] {
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
}

/** Implements run telemetry for the public runtime surface of this module. */
export async function runTelemetry(
  options: TelemetryCommandOptions,
  _global: GlobalOptions,
): Promise<TelemetryResult> {
  void _global;
  const subcommand = normalizeTelemetrySubcommand(options.subcommand);
  const globalPmRoot = resolveGlobalPmRoot(process.cwd());
  const queuePath = path.join(globalPmRoot, TELEMETRY_QUEUE_RELATIVE_PATH);
  const statePath = path.join(globalPmRoot, TELEMETRY_STATE_RELATIVE_PATH);
  if (subcommand === "status") {
    return {
      action: "telemetry",
      subcommand,
      status: await buildTelemetryStatusSummary(globalPmRoot),
      generated_at: nowIso(),
    };
  }

  if (subcommand === "flush") {
    const before = await buildTelemetryStatusSummary(globalPmRoot);
    await flushTelemetryQueueNow(globalPmRoot);
    const after = await buildTelemetryStatusSummary(globalPmRoot);
    return {
      action: "telemetry",
      subcommand,
      queue_entries_before: before.queue_entries,
      queue_entries_after: after.queue_entries,
      queue_drained: after.queue_entries < before.queue_entries,
      status: after,
      generated_at: nowIso(),
    };
  }

  if (subcommand === "stats") {
    const limit = parseTelemetryStatsLimit(options.limit);
    const queueRaw = await readFileIfExists(queuePath);
    const queue = parseTelemetryQueue(queueRaw);
    const buckets = buildTelemetryStatsBuckets(queue.entries);
    const selected = buckets.slice(0, limit);
    return {
      action: "telemetry",
      subcommand,
      limit,
      total_commands: buckets.length,
      queue_entries: queue.valid_entries,
      queue_invalid_rows: queue.invalid_rows,
      queue_rows_total: queue.rows_total,
      truncated: buckets.length > selected.length,
      stats: selected,
      generated_at: nowIso(),
    };
  }

  const settings = await readSettings(globalPmRoot);
  const previousEnabled = settings.telemetry.enabled;
  const previousInstallationId = settings.telemetry.installation_id;
  const previousFirstRunPromptCompleted =
    settings.telemetry.first_run_prompt_completed;
  settings.telemetry.enabled = false;
  settings.telemetry.first_run_prompt_completed = true;
  settings.telemetry.installation_id = "";
  const settingsChanged =
    previousEnabled !== settings.telemetry.enabled ||
    previousInstallationId !== settings.telemetry.installation_id ||
    previousFirstRunPromptCompleted !==
      settings.telemetry.first_run_prompt_completed;
  if (settingsChanged) {
    await writeSettings(globalPmRoot, settings, "telemetry:clear");
  }

  const telemetryRuntimePath = path.join(
    globalPmRoot,
    TELEMETRY_RUNTIME_RELATIVE_PATH,
  );
  const existed = await pathExists(telemetryRuntimePath);
  await fs.rm(telemetryRuntimePath, { recursive: true, force: true });
  const queueExistsAfter = await pathExists(queuePath);
  const stateExistsAfter = await pathExists(statePath);
  return {
    action: "telemetry",
    subcommand,
    settings_changed: settingsChanged,
    runtime_dir_removed: existed && !(await pathExists(telemetryRuntimePath)),
    queue_exists_after: queueExistsAfter,
    state_exists_after: stateExistsAfter,
    status: await buildTelemetryStatusSummary(globalPmRoot),
    generated_at: nowIso(),
  };
}
