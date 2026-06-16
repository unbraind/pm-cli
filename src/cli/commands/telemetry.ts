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

const TELEMETRY_QUEUE_RELATIVE_PATH = path.join("runtime", "telemetry", "events.jsonl");
const TELEMETRY_STATE_RELATIVE_PATH = path.join("runtime", "telemetry", "state.json");
const TELEMETRY_RUNTIME_RELATIVE_PATH = path.join("runtime", "telemetry");
const DEFAULT_STATS_LIMIT = 20;

export const TELEMETRY_SUBCOMMANDS = ["status", "flush", "stats", "clear"] as const;
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

export interface TelemetryCommandOptions {
  subcommand?: string;
  limit?: string | number;
}

interface TelemetryStatsBucket {
  command: string;
  count: number;
  event_type_counts: Record<string, number>;
  max_attempts: number;
  event_schema_versions: number[];
  client_schema_versions: number[];
}

function normalizeTelemetrySubcommand(value: string | undefined): TelemetrySubcommand {
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
      throw new PmCliError("--limit must be a positive integer", EXIT_CODE.USAGE);
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

async function readTelemetryRuntimeState(statePath: string): Promise<TelemetryRuntimeStateRecord> {
  const stateRaw = await readFileIfExists(statePath);
  if (stateRaw === null || stateRaw.trim().length === 0) {
    return {};
  }
  try {
    const parsed = JSON.parse(stateRaw) as TelemetryRuntimeStateRecord;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // Ignore malformed state files; status command is observational.
  }
  return {};
}

async function buildTelemetryStatusSummary(globalPmRoot: string): Promise<TelemetryStatusSummary> {
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
    queue_size_bytes: queueRaw === null ? 0 : Buffer.byteLength(queueRaw, "utf8"),
    last_attempted_flush_at: runtimeState.last_attempted_flush_at ?? null,
    last_successful_flush_at: runtimeState.last_successful_flush_at ?? null,
    last_failed_flush_at: runtimeState.last_failed_flush_at ?? null,
    last_failed_flush_error: runtimeState.last_failed_flush_error ?? null,
  };
}

function buildTelemetryStatsBuckets(entries: QueuedTelemetryEventRecord[]): TelemetryStatsBucket[] {
  const grouped = new Map<
    string,
    {
      count: number;
      max_attempts: number;
      event_type_counts: Record<string, number>;
      event_schema_versions: Set<number>;
      client_schema_versions: Set<number>;
    }
  >();
  for (const entry of entries) {
    const command = typeof entry.event.command === "string" && entry.event.command.trim().length > 0
      ? entry.event.command
      : "<unknown>";
    const eventType = typeof entry.event.event_type === "string" && entry.event.event_type.trim().length > 0
      ? entry.event.event_type
      : "unknown";
    const eventSchemaVersion = typeof entry.event.schema_version === "number" && Number.isFinite(entry.event.schema_version)
      ? Math.trunc(entry.event.schema_version)
      : undefined;
    const clientSchemaVersion =
      typeof entry.client_schema_version === "number" && Number.isFinite(entry.client_schema_version)
        ? Math.trunc(entry.client_schema_version)
        : undefined;
    const current = grouped.get(command) ?? {
      count: 0,
      max_attempts: 0,
      event_type_counts: {},
      event_schema_versions: new Set<number>(),
      client_schema_versions: new Set<number>(),
    };
    current.count += 1;
    current.max_attempts = Math.max(current.max_attempts, Math.max(0, Math.trunc(entry.attempts)));
    current.event_type_counts[eventType] = (current.event_type_counts[eventType] ?? 0) + 1;
    if (eventSchemaVersion !== undefined) {
      current.event_schema_versions.add(eventSchemaVersion);
    }
    if (clientSchemaVersion !== undefined) {
      current.client_schema_versions.add(clientSchemaVersion);
    }
    grouped.set(command, current);
  }
  return [...grouped.entries()]
    .map(([command, value]) => ({
      command,
      count: value.count,
      event_type_counts: Object.fromEntries(
        Object.entries(value.event_type_counts).sort((left, right) => left[0].localeCompare(right[0])),
      ),
      max_attempts: value.max_attempts,
      event_schema_versions: [...value.event_schema_versions].sort((left, right) => left - right),
      client_schema_versions: [...value.client_schema_versions].sort((left, right) => left - right),
    }))
    .sort((left, right) => right.count - left.count || left.command.localeCompare(right.command));
}

export async function runTelemetry(options: TelemetryCommandOptions, _global: GlobalOptions): Promise<Record<string, unknown>> {
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
  const previousFirstRunPromptCompleted = settings.telemetry.first_run_prompt_completed;
  settings.telemetry.enabled = false;
  settings.telemetry.first_run_prompt_completed = true;
  settings.telemetry.installation_id = "";
  const settingsChanged =
    previousEnabled !== settings.telemetry.enabled ||
    previousInstallationId !== settings.telemetry.installation_id ||
    previousFirstRunPromptCompleted !== settings.telemetry.first_run_prompt_completed;
  if (settingsChanged) {
    await writeSettings(globalPmRoot, settings, "telemetry:clear");
  }

  const telemetryRuntimePath = path.join(globalPmRoot, TELEMETRY_RUNTIME_RELATIVE_PATH);
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
