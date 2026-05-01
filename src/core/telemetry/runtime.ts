import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { GlobalOptions } from "../shared/command-types.js";
import { appendLineAtomic, readFileIfExists, writeFileAtomic } from "../fs/fs-utils.js";
import { resolveGlobalPmRoot } from "../store/paths.js";
import { readSettings, writeSettings } from "../store/settings.js";

const TELEMETRY_QUEUE_RELATIVE_PATH = path.join("runtime", "telemetry", "events.jsonl");
const TELEMETRY_STATE_RELATIVE_PATH = path.join("runtime", "telemetry", "state.json");
const TELEMETRY_SCHEMA_VERSION = 1;
const TELEMETRY_FLUSH_BATCH_SIZE = 100;
const TELEMETRY_MAX_RETRY_DELAY_MS = 3_600_000;
const TELEMETRY_RETRY_BASE_DELAY_MS = 30_000;
const TELEMETRY_HTTP_TIMEOUT_MS = 2_500;
const MILLISECONDS_PER_DAY = 86_400_000;
const TELEMETRY_MAX_EVENT_BYTES = 512_000;
const TELEMETRY_SANITIZE_MAX_DEPTH = 6;
const TELEMETRY_SANITIZE_MAX_ARRAY_ITEMS = 20;
const TELEMETRY_MAX_QUEUE_ENTRY_ATTEMPTS = 15;
const OTEL_TRACES_ENDPOINT_ENV = "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT";
const OTEL_BASE_ENDPOINT_ENV = "OTEL_EXPORTER_OTLP_ENDPOINT";
const OTEL_SERVICE_NAME_ENV = "OTEL_SERVICE_NAME";
const PM_TELEMETRY_DISABLED_ENV = "PM_TELEMETRY_DISABLED";
const PM_TELEMETRY_DISABLED_VALUES = new Set(["1", "true", "yes", "on"]);
const PM_TELEMETRY_OTEL_DISABLED_ENV = "PM_TELEMETRY_OTEL_DISABLED";
const PM_TELEMETRY_OTEL_DISABLED_VALUES = new Set(["1", "true", "yes", "on"]);
const PM_TELEMETRY_SOURCE_CONTEXT_ENV = "PM_TELEMETRY_SOURCE_CONTEXT";
const PM_TELEMETRY_SOURCE_CONTEXT_VALUES = ["user", "automation", "test", "dogfood", "audit_smoke"] as const;
const PM_TELEMETRY_SOURCE_CONTEXT_SET = new Set<string>(PM_TELEMETRY_SOURCE_CONTEXT_VALUES);
const BOOLEAN_TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const PROCESS_SESSION_ID = crypto.randomUUID();

const SENSITIVE_KEYWORDS = [
  "token",
  "secret",
  "password",
  "passwd",
  "api_key",
  "apikey",
  "authorization",
  "cookie",
  "session",
  "credentials",
  "bearer",
] as const;
const SENSITIVE_INLINE_KEY_PATTERN =
  "(?:token|secret|password|passwd|api[_-]?key|apikey|authorization|cookie|session|credentials|bearer)";
const INLINE_SENSITIVE_ASSIGNMENT_PATTERN = new RegExp(
  `\\b(${SENSITIVE_INLINE_KEY_PATTERN})\\s*([:=])\\s*([^\\s,;]+)`,
  "giu",
);
const INLINE_SENSITIVE_FLAG_PATTERN = new RegExp(
  `(--${SENSITIVE_INLINE_KEY_PATTERN})(=|\\s+)([^\\s,;]+)`,
  "giu",
);
const ABSOLUTE_PATH_TOKEN_PATTERN = /(^|[\s"'`(=])\/(?:[^\s"'`),;]+)/g;

interface TelemetryEvent {
  schema_version: number;
  event_id: string;
  event_type: "command_start" | "command_finish";
  occurred_at: string;
  installation_id: string;
  session_id: string;
  command: string;
  payload: Record<string, unknown>;
}

interface QueuedTelemetryEvent {
  event: TelemetryEvent;
  attempts: number;
  last_attempt_at?: string;
  next_attempt_after?: string;
}

interface TelemetryRuntimeState {
  last_attempted_flush_at?: string;
  last_successful_flush_at?: string;
  last_failed_flush_at?: string;
  last_failed_flush_error?: string;
  endpoint?: string;
  queue_entries?: number;
}

type TelemetryCaptureLevel = "minimal" | "redacted" | "max";
type TelemetrySourceContext = (typeof PM_TELEMETRY_SOURCE_CONTEXT_VALUES)[number];
type TelemetrySourceContextSource = "inferred" | "env_override";

interface ResolvedTelemetrySourceContext {
  source_context: TelemetrySourceContext;
  source_context_source: TelemetrySourceContextSource;
}

export interface ActiveTelemetryCommand {
  started_at: string;
  started_at_ms: number;
  command: string;
  pm_version: string;
  source_context: TelemetrySourceContext;
  source_context_source: TelemetrySourceContextSource;
  installation_id: string;
  pm_root_hash: string;
  cwd_hash: string;
  endpoint: string;
  retention_days: number;
  global_pm_root: string;
  capture_level: TelemetryCaptureLevel;
  otel_traces_endpoint?: string;
  otel_trace_id?: string;
  otel_span_id?: string;
}

export interface TelemetryCommandContext {
  command: string;
  pm_version: string;
  args: string[];
  options: Record<string, unknown>;
  global: GlobalOptions;
  pm_root: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function queuePath(globalPmRoot: string): string {
  return path.join(globalPmRoot, TELEMETRY_QUEUE_RELATIVE_PATH);
}

function runtimeStatePath(globalPmRoot: string): string {
  return path.join(globalPmRoot, TELEMETRY_STATE_RELATIVE_PATH);
}

async function readRuntimeState(globalPmRoot: string): Promise<TelemetryRuntimeState> {
  const raw = await readFileIfExists(runtimeStatePath(globalPmRoot));
  if (!raw || raw.trim().length === 0) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as TelemetryRuntimeState;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    return parsed;
  } catch {
    return {};
  }
}

async function writeRuntimeState(globalPmRoot: string, patch: TelemetryRuntimeState): Promise<void> {
  try {
    const current = await readRuntimeState(globalPmRoot);
    const next: TelemetryRuntimeState = {
      ...current,
      ...patch,
    };
    const normalized = Object.fromEntries(
      Object.entries(next)
        .filter(([, value]) => value !== undefined)
        .sort((left, right) => left[0].localeCompare(right[0])),
    );
    await writeFileAtomic(runtimeStatePath(globalPmRoot), `${JSON.stringify(normalized, null, 2)}\n`);
  } catch {
    // Runtime state persistence is best effort and must not block command execution.
  }
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.trim().toLowerCase().replaceAll("-", "_").replaceAll(/[^a-z0-9_]+/g, "_");
  const tokens = normalized.split("_").filter((token) => token.length > 0);
  return SENSITIVE_KEYWORDS.some(
    (keyword) => normalized === keyword || normalized.endsWith(`_${keyword}`) || tokens.includes(keyword),
  );
}

function redactInlineSensitiveAssignments(input: string): string {
  const withoutAssignments = input.replaceAll(
    INLINE_SENSITIVE_ASSIGNMENT_PATTERN,
    (_match: string, key: string, delimiter: string): string => `${key}${delimiter}[redacted]`,
  );
  return withoutAssignments.replaceAll(
    INLINE_SENSITIVE_FLAG_PATTERN,
    (_match: string, flag: string, delimiter: string): string => `${flag}${delimiter}[redacted]`,
  );
}

function redactAbsolutePathTokens(input: string): string {
  return input.replaceAll(
    ABSOLUTE_PATH_TOKEN_PATTERN,
    (_match: string, prefix: string): string => `${prefix}[redacted_path]`,
  );
}

function sanitizeStringRedacted(input: string): string {
  const withoutEmails = input.replaceAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, "[redacted_email]");
  const withoutBearer = withoutEmails.replaceAll(/bearer\s+[a-z0-9._=-]+/giu, "bearer [redacted_token]");
  const withoutInlineSecrets = redactInlineSensitiveAssignments(withoutBearer);
  const withoutAbsolutePaths = redactAbsolutePathTokens(withoutInlineSecrets);
  const trimmed = withoutAbsolutePaths.trim();
  if (trimmed.startsWith("/") && trimmed.length > 1) {
    return "[redacted_path]";
  }
  if (withoutAbsolutePaths.length > 512) {
    return `${withoutAbsolutePaths.slice(0, 509)}...`;
  }
  return withoutAbsolutePaths;
}

function sanitizeStringMax(input: string): string {
  const withoutBearer = input.replaceAll(/bearer\s+[a-z0-9._=-]+/giu, "bearer [redacted_token]");
  const withoutInlineSecrets = redactInlineSensitiveAssignments(withoutBearer);
  if (withoutInlineSecrets.length > 2048) {
    return `${withoutInlineSecrets.slice(0, 2045)}...`;
  }
  return withoutInlineSecrets;
}

function sanitizeString(input: string, captureLevel: Exclude<TelemetryCaptureLevel, "minimal"> = "redacted"): string {
  if (captureLevel === "max") {
    return sanitizeStringMax(input);
  }
  return sanitizeStringRedacted(input);
}

function sanitizeValue(
  value: unknown,
  keyHint?: string,
  captureLevel: Exclude<TelemetryCaptureLevel, "minimal"> = "redacted",
  depth = 0,
): unknown {
  if (keyHint && isSensitiveKey(keyHint)) {
    return "[redacted]";
  }
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "string") {
    return sanitizeString(value, captureLevel);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (depth >= TELEMETRY_SANITIZE_MAX_DEPTH) {
    return "[depth_truncated]";
  }
  if (Array.isArray(value)) {
    return value.slice(0, TELEMETRY_SANITIZE_MAX_ARRAY_ITEMS).map((entry) => sanitizeValue(entry, undefined, captureLevel, depth + 1));
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sanitized: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(record)) {
      sanitized[key] = sanitizeValue(nested, key, captureLevel, depth + 1);
    }
    return sanitized;
  }
  return String(value);
}

function sanitizeCommandArgs(
  args: string[],
  captureLevel: Exclude<TelemetryCaptureLevel, "minimal"> = "redacted",
): string[] {
  const sanitized: string[] = [];
  let nextIsSensitiveValue = false;
  for (const rawArg of args) {
    const arg = sanitizeString(rawArg, captureLevel);
    if (nextIsSensitiveValue) {
      sanitized.push("[redacted]");
      nextIsSensitiveValue = false;
      continue;
    }
    if (arg.startsWith("--")) {
      const withoutPrefix = arg.slice(2);
      const delimiterIndex = withoutPrefix.indexOf("=");
      if (delimiterIndex >= 0) {
        const key = withoutPrefix.slice(0, delimiterIndex);
        const value = withoutPrefix.slice(delimiterIndex + 1);
        if (isSensitiveKey(key)) {
          sanitized.push(`--${key}=[redacted]`);
        } else {
          sanitized.push(`--${key}=${sanitizeString(value, captureLevel)}`);
        }
        continue;
      }
      if (isSensitiveKey(withoutPrefix)) {
        sanitized.push(`--${withoutPrefix}`);
        nextIsSensitiveValue = true;
        continue;
      }
    }
    sanitized.push(arg);
  }
  return sanitized;
}

function normalizeCaptureLevel(value: string | undefined): TelemetryCaptureLevel {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "minimal" || normalized === "redacted" || normalized === "max") {
    return normalized;
  }
  return "redacted";
}

function parseBooleanTrueLike(value: string | undefined): boolean {
  return BOOLEAN_TRUE_VALUES.has((value ?? "").trim().toLowerCase());
}

function normalizePmVersion(value: string | undefined): string {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : "0.0.0";
}

function resolveTelemetrySourceContext(globalOptions: GlobalOptions): ResolvedTelemetrySourceContext {
  const override = (process.env[PM_TELEMETRY_SOURCE_CONTEXT_ENV] ?? "").trim().toLowerCase();
  if (PM_TELEMETRY_SOURCE_CONTEXT_SET.has(override)) {
    return {
      source_context: override as TelemetrySourceContext,
      source_context_source: "env_override",
    };
  }
  const nodeEnv = (process.env.NODE_ENV ?? "").trim().toLowerCase();
  if (typeof process.env.VITEST === "string" || typeof process.env.VITEST_WORKER_ID === "string" || nodeEnv === "test") {
    return {
      source_context: "test",
      source_context_source: "inferred",
    };
  }
  const nonTty = process.stdin.isTTY !== true || process.stdout.isTTY !== true;
  const ci = parseBooleanTrueLike(process.env.CI);
  const scriptLikeMode = globalOptions.json === true || globalOptions.quiet === true;
  if (nonTty || ci || scriptLikeMode) {
    return {
      source_context: "automation",
      source_context_source: "inferred",
    };
  }
  return {
    source_context: "user",
    source_context_source: "inferred",
  };
}

function hashWithInstallationId(installationId: string, value: string): string {
  return crypto.createHash("sha256").update(`${installationId}:${value}`).digest("hex");
}

function telemetryDisabledByEnvironment(): boolean {
  return PM_TELEMETRY_DISABLED_VALUES.has((process.env[PM_TELEMETRY_DISABLED_ENV] ?? "").trim().toLowerCase());
}

function resolveOtelTracesEndpoint(): string | null {
  if (PM_TELEMETRY_OTEL_DISABLED_VALUES.has((process.env[PM_TELEMETRY_OTEL_DISABLED_ENV] ?? "").trim().toLowerCase())) {
    return null;
  }

  const directEndpoint = (process.env[OTEL_TRACES_ENDPOINT_ENV] ?? "").trim();
  if (directEndpoint.length > 0) {
    try {
      return new URL(directEndpoint).toString();
    } catch {
      return null;
    }
  }

  const baseEndpoint = (process.env[OTEL_BASE_ENDPOINT_ENV] ?? "").trim();
  if (baseEndpoint.length === 0) {
    return null;
  }

  try {
    const url = new URL(baseEndpoint);
    const normalizedPath = url.pathname.replace(/\/+$/, "");
    if (!normalizedPath.endsWith("/v1/traces")) {
      url.pathname = `${normalizedPath.length === 0 ? "" : normalizedPath}/v1/traces`;
    }
    return url.toString();
  } catch {
    return null;
  }
}

function isoToUnixNano(iso: string): string {
  const parsedMs = Date.parse(iso);
  const epochMs = Number.isNaN(parsedMs) ? Date.now() : parsedMs;
  return `${BigInt(epochMs) * 1_000_000n}`;
}

function otlpStringAttribute(key: string, value: string): { key: string; value: { stringValue: string } } {
  return {
    key,
    value: { stringValue: value },
  };
}

function otlpBoolAttribute(key: string, value: boolean): { key: string; value: { boolValue: boolean } } {
  return {
    key,
    value: { boolValue: value },
  };
}

function otlpIntAttribute(key: string, value: number): { key: string; value: { intValue: string } } {
  return {
    key,
    value: { intValue: String(Math.max(0, Math.trunc(value))) },
  };
}

async function exportLocalOtelSpan(
  activeCommand: ActiveTelemetryCommand,
  outcome: { ok: boolean; error?: string },
  finishedAtIso: string,
  durationMs: number,
): Promise<void> {
  if (
    typeof activeCommand.otel_traces_endpoint !== "string" ||
    activeCommand.otel_traces_endpoint.trim().length === 0 ||
    typeof activeCommand.otel_trace_id !== "string" ||
    activeCommand.otel_trace_id.length === 0 ||
    typeof activeCommand.otel_span_id !== "string" ||
    activeCommand.otel_span_id.length === 0
  ) {
    return;
  }

  const serviceNameCandidate = sanitizeString((process.env[OTEL_SERVICE_NAME_ENV] ?? "").trim());
  const serviceName = serviceNameCandidate.length > 0 ? serviceNameCandidate : "pm-cli";
  const attributes: Array<
    | ReturnType<typeof otlpStringAttribute>
    | ReturnType<typeof otlpBoolAttribute>
    | ReturnType<typeof otlpIntAttribute>
  > = [
    otlpStringAttribute("pm.command", sanitizeString(activeCommand.command)),
    otlpStringAttribute("pm.version", activeCommand.pm_version),
    otlpStringAttribute("pm.source_context", activeCommand.source_context),
    otlpStringAttribute("pm.source_context_source", activeCommand.source_context_source),
    otlpStringAttribute("pm.installation_id", activeCommand.installation_id),
    otlpStringAttribute("pm.session_id", PROCESS_SESSION_ID),
    otlpStringAttribute("pm.pm_root_hash", activeCommand.pm_root_hash),
    otlpStringAttribute("pm.cwd_hash", activeCommand.cwd_hash),
    otlpBoolAttribute("pm.ok", outcome.ok),
    otlpIntAttribute("pm.duration_ms", durationMs),
  ];
  if (typeof outcome.error === "string" && outcome.error.trim().length > 0) {
    attributes.push(otlpStringAttribute("pm.error", sanitizeString(outcome.error)));
  }

  const payload = {
    resourceSpans: [
      {
        resource: {
          attributes: [otlpStringAttribute("service.name", serviceName)],
        },
        scopeSpans: [
          {
            scope: {
              name: "pm-cli.telemetry",
              version: "1",
            },
            spans: [
              {
                traceId: activeCommand.otel_trace_id,
                spanId: activeCommand.otel_span_id,
                name: `pm.command.${sanitizeString(activeCommand.command)}`,
                kind: 1,
                startTimeUnixNano: isoToUnixNano(activeCommand.started_at),
                endTimeUnixNano: isoToUnixNano(finishedAtIso),
                attributes,
                status: {
                  code: outcome.ok ? 1 : 2,
                  message: outcome.ok ? "" : sanitizeString(outcome.error ?? "command_failed"),
                },
              },
            ],
          },
        ],
      },
    ],
  };

  const response = await fetch(activeCommand.otel_traces_endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(TELEMETRY_HTTP_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`local_otel_export_http_${response.status}`);
  }
}

function summarizeResult(
  result: unknown,
  captureLevel: Exclude<TelemetryCaptureLevel, "minimal"> = "redacted",
): Record<string, unknown> {
  if (result === null || result === undefined) {
    return { type: "nullish" };
  }
  if (typeof result === "string") {
    return { type: "string", value: sanitizeString(result, captureLevel) };
  }
  if (typeof result === "number" || typeof result === "boolean") {
    return { type: typeof result, value: result };
  }
  if (Array.isArray(result)) {
    return {
      type: "array",
      length: result.length,
      sample: result.slice(0, 5).map((entry) => sanitizeValue(entry, undefined, captureLevel)),
    };
  }
  if (typeof result === "object") {
    const record = result as Record<string, unknown>;
    const keys = Object.keys(record).sort((left, right) => left.localeCompare(right));
    const sanitized: Record<string, unknown> = {};
    for (const key of keys.slice(0, 25)) {
      sanitized[key] = sanitizeValue(record[key], key, captureLevel);
    }
    return {
      type: "object",
      key_count: keys.length,
      keys_preview: keys.slice(0, 50),
      preview: sanitized,
    };
  }
  return { type: typeof result, value: String(result) };
}

function buildCommandStartPayload(params: {
  captureLevel: TelemetryCaptureLevel;
  context: TelemetryCommandContext;
  pmVersion: string;
  sourceContext: ResolvedTelemetrySourceContext;
  pmRootHash: string;
  cwdHash: string;
  installationId: string;
}): Record<string, unknown> {
  const { captureLevel, context, pmVersion, sourceContext, pmRootHash, cwdHash, installationId } = params;
  if (captureLevel === "minimal") {
    return {
      capture_level: captureLevel,
      pm_version: pmVersion,
      source_context: sourceContext.source_context,
      source_context_source: sourceContext.source_context_source,
    };
  }
  return {
    pm_version: pmVersion,
    source_context: sourceContext.source_context,
    source_context_source: sourceContext.source_context_source,
    command_args: sanitizeCommandArgs(context.args, captureLevel),
    command_options: sanitizeValue(context.options, undefined, captureLevel) as Record<string, unknown>,
    global_options: sanitizeValue(context.global, undefined, captureLevel) as Record<string, unknown>,
    pm_root_hash: pmRootHash,
    cwd_hash: cwdHash,
    capture_level: captureLevel,
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      hostname_hash: hashWithInstallationId(installationId, os.hostname()),
      stdin_tty: process.stdin.isTTY === true,
      stdout_tty: process.stdout.isTTY === true,
    },
  };
}

function buildCommandFinishPayload(params: {
  captureLevel: TelemetryCaptureLevel;
  pmVersion: string;
  sourceContext: ResolvedTelemetrySourceContext;
  outcome: { ok: boolean; error?: string; result?: unknown };
  durationMs: number;
  startedAt: string;
}): Record<string, unknown> {
  const { captureLevel, pmVersion, sourceContext, outcome, durationMs, startedAt } = params;
  if (captureLevel === "minimal") {
    return {
      capture_level: captureLevel,
      pm_version: pmVersion,
      source_context: sourceContext.source_context,
      source_context_source: sourceContext.source_context_source,
      ok: outcome.ok,
      error: outcome.error ? sanitizeString(outcome.error, "redacted") : undefined,
      duration_ms: durationMs,
    };
  }
  return {
    capture_level: captureLevel,
    pm_version: pmVersion,
    source_context: sourceContext.source_context,
    source_context_source: sourceContext.source_context_source,
    ok: outcome.ok,
    error: outcome.error ? sanitizeString(outcome.error, captureLevel) : undefined,
    duration_ms: durationMs,
    started_at: startedAt,
    result_summary: summarizeResult(outcome.result, captureLevel),
  };
}

async function ensureInstallationId(
  globalPmRoot: string,
): Promise<{ installationId: string; endpoint: string; retentionDays: number }> {
  const settings = await readSettings(globalPmRoot);
  let changed = false;
  if (settings.telemetry.installation_id.trim().length === 0) {
    settings.telemetry.installation_id = crypto.randomUUID();
    changed = true;
  }
  if (changed) {
    await writeSettings(globalPmRoot, settings, "telemetry:install_id");
  }
  return {
    installationId: settings.telemetry.installation_id,
    endpoint: settings.telemetry.endpoint,
    retentionDays: Math.max(1, Math.trunc(settings.telemetry.retention_days)),
  };
}

async function enqueueTelemetryEvent(globalPmRoot: string, event: TelemetryEvent): Promise<void> {
  const queued: QueuedTelemetryEvent = {
    event,
    attempts: 0,
  };
  let serialized = JSON.stringify(queued);
  if (serialized.length > TELEMETRY_MAX_EVENT_BYTES) {
    const trimmed = { ...event, payload: { ...event.payload, result_summary: { truncated: true, reason: "payload_size_exceeded", original_bytes: serialized.length } } };
    const trimmedQueued: QueuedTelemetryEvent = { event: trimmed, attempts: 0 };
    serialized = JSON.stringify(trimmedQueued);
  }
  await appendLineAtomic(queuePath(globalPmRoot), serialized);
}

function parseQueueLines(raw: string): QueuedTelemetryEvent[] {
  const entries: QueuedTelemetryEvent[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as QueuedTelemetryEvent;
      if (
        parsed &&
        typeof parsed === "object" &&
        parsed.event &&
        typeof parsed.event === "object" &&
        typeof parsed.attempts === "number"
      ) {
        entries.push(parsed);
      }
    } catch {
      // Drop malformed lines to preserve queue forward progress.
    }
  }
  return entries;
}

function nextRetryIso(attempts: number): string {
  const delay = Math.min(TELEMETRY_RETRY_BASE_DELAY_MS * 2 ** Math.max(attempts - 1, 0), TELEMETRY_MAX_RETRY_DELAY_MS);
  return new Date(Date.now() + delay).toISOString();
}

function isDueForRetry(entry: QueuedTelemetryEvent): boolean {
  if (typeof entry.next_attempt_after !== "string" || entry.next_attempt_after.trim().length === 0) {
    return true;
  }
  const dueAtMs = Date.parse(entry.next_attempt_after);
  if (Number.isNaN(dueAtMs)) {
    return true;
  }
  return dueAtMs <= Date.now();
}

function retentionCutoffMs(retentionDays: number): number {
  const normalizedDays = Number.isFinite(retentionDays) ? Math.max(1, Math.trunc(retentionDays)) : 1;
  return Date.now() - normalizedDays * MILLISECONDS_PER_DAY;
}

function isExpiredQueueEntry(entry: QueuedTelemetryEvent, cutoffMs: number): boolean {
  const occurredAt = entry.event?.occurred_at;
  if (typeof occurredAt !== "string" || occurredAt.trim().length === 0) {
    return false;
  }
  const occurredAtMs = Date.parse(occurredAt);
  if (Number.isNaN(occurredAtMs)) {
    return false;
  }
  return occurredAtMs < cutoffMs;
}

function pruneExpiredQueueEntries(
  entries: QueuedTelemetryEvent[],
  retentionDays: number,
): { entries: QueuedTelemetryEvent[]; prunedCount: number } {
  const cutoffMs = retentionCutoffMs(retentionDays);
  const retained: QueuedTelemetryEvent[] = [];
  let prunedCount = 0;
  for (const entry of entries) {
    if (isExpiredQueueEntry(entry, cutoffMs) || entry.attempts >= TELEMETRY_MAX_QUEUE_ENTRY_ATTEMPTS) {
      prunedCount += 1;
      continue;
    }
    retained.push(entry);
  }
  return { entries: retained, prunedCount };
}

async function rewriteQueue(globalPmRoot: string, entries: QueuedTelemetryEvent[]): Promise<void> {
  const serialized = entries.map((entry) => JSON.stringify(entry)).join("\n");
  await writeFileAtomic(queuePath(globalPmRoot), serialized.length > 0 ? `${serialized}\n` : "");
}

async function flushQueue(globalPmRoot: string, endpoint: string, retentionDays: number): Promise<void> {
  const normalizedEndpoint = endpoint.trim();
  if (normalizedEndpoint.length === 0) {
    return;
  }
  const raw = await readFileIfExists(queuePath(globalPmRoot));
  if (raw === null || raw.trim().length === 0) {
    await writeRuntimeState(globalPmRoot, {
      endpoint: normalizedEndpoint,
      queue_entries: 0,
    });
    return;
  }
  const queueEntries = parseQueueLines(raw);
  if (queueEntries.length === 0) {
    await writeRuntimeState(globalPmRoot, {
      endpoint: normalizedEndpoint,
      queue_entries: 0,
    });
    return;
  }
  const { entries: retainedEntries, prunedCount } = pruneExpiredQueueEntries(queueEntries, retentionDays);
  if (retainedEntries.length === 0) {
    if (prunedCount > 0) {
      await rewriteQueue(globalPmRoot, []);
    }
    await writeRuntimeState(globalPmRoot, {
      endpoint: normalizedEndpoint,
      queue_entries: 0,
    });
    return;
  }
  const dueEntries = retainedEntries.filter((entry) => isDueForRetry(entry)).slice(0, TELEMETRY_FLUSH_BATCH_SIZE);
  if (dueEntries.length === 0) {
    if (prunedCount > 0) {
      await rewriteQueue(globalPmRoot, retainedEntries);
    }
    await writeRuntimeState(globalPmRoot, {
      endpoint: normalizedEndpoint,
      queue_entries: retainedEntries.length,
    });
    return;
  }
  const dueIds = new Set(dueEntries.map((entry) => entry.event.event_id));
  const attemptTime = nowIso();

  try {
    const response = await fetch(normalizedEndpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        schema_version: TELEMETRY_SCHEMA_VERSION,
        events: dueEntries.map((entry) => entry.event),
      }),
      signal: AbortSignal.timeout(TELEMETRY_HTTP_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`telemetry_flush_http_${response.status}`);
    }
    const remaining = retainedEntries.filter((entry) => !dueIds.has(entry.event.event_id));
    await rewriteQueue(globalPmRoot, remaining);
    await writeRuntimeState(globalPmRoot, {
      endpoint: normalizedEndpoint,
      queue_entries: remaining.length,
      last_attempted_flush_at: attemptTime,
      last_successful_flush_at: attemptTime,
      last_failed_flush_at: undefined,
      last_failed_flush_error: undefined,
    });
  } catch (error: unknown) {
    const retried = retainedEntries.map((entry) => {
      if (!dueIds.has(entry.event.event_id)) {
        return entry;
      }
      const attempts = entry.attempts + 1;
      return {
        ...entry,
        attempts,
        last_attempt_at: attemptTime,
        next_attempt_after: nextRetryIso(attempts),
      };
    });
    await rewriteQueue(globalPmRoot, retried);
    const errorMessage = (() => {
      if (error instanceof Error) {
        return sanitizeString(error.message, "redacted");
      }
      return "telemetry_flush_failed";
    })();
    await writeRuntimeState(globalPmRoot, {
      endpoint: normalizedEndpoint,
      queue_entries: retried.length,
      last_attempted_flush_at: attemptTime,
      last_failed_flush_at: attemptTime,
      last_failed_flush_error: errorMessage,
    });
  }
}

export async function startTelemetryCommand(context: TelemetryCommandContext): Promise<ActiveTelemetryCommand | null> {
  if (telemetryDisabledByEnvironment()) {
    return null;
  }
  try {
    const globalPmRoot = resolveGlobalPmRoot(process.cwd());
    const settings = await readSettings(globalPmRoot);
    if (!settings.telemetry.enabled) {
      return null;
    }
    const captureLevel = normalizeCaptureLevel(settings.telemetry.capture_level);
    const { installationId, endpoint, retentionDays } = await ensureInstallationId(globalPmRoot);
    const pmVersion = normalizePmVersion(context.pm_version);
    const sourceContext = resolveTelemetrySourceContext(context.global);
    const pmRootHash = hashWithInstallationId(installationId, context.pm_root);
    const cwdHash = hashWithInstallationId(installationId, process.cwd());
    const otelTracesEndpoint = resolveOtelTracesEndpoint();
    const occurredAt = nowIso();
    const event: TelemetryEvent = {
      schema_version: TELEMETRY_SCHEMA_VERSION,
      event_id: crypto.randomUUID(),
      event_type: "command_start",
      occurred_at: occurredAt,
      installation_id: installationId,
      session_id: PROCESS_SESSION_ID,
      command: context.command,
      payload: buildCommandStartPayload({
        captureLevel,
        context,
        pmVersion,
        sourceContext,
        pmRootHash,
        cwdHash,
        installationId,
      }),
    };
    await enqueueTelemetryEvent(globalPmRoot, event);
    await flushQueue(globalPmRoot, endpoint, retentionDays);
    return {
      started_at: occurredAt,
      started_at_ms: Date.now(),
      command: context.command,
      pm_version: pmVersion,
      source_context: sourceContext.source_context,
      source_context_source: sourceContext.source_context_source,
      installation_id: installationId,
      pm_root_hash: pmRootHash,
      cwd_hash: cwdHash,
      endpoint,
      retention_days: retentionDays,
      global_pm_root: globalPmRoot,
      capture_level: captureLevel,
      otel_traces_endpoint: otelTracesEndpoint ?? undefined,
      otel_trace_id: otelTracesEndpoint ? crypto.randomBytes(16).toString("hex") : undefined,
      otel_span_id: otelTracesEndpoint ? crypto.randomBytes(8).toString("hex") : undefined,
    };
  } catch {
    // Telemetry must never block command execution.
    return null;
  }
}

export async function finishTelemetryCommand(
  activeCommand: ActiveTelemetryCommand | null,
  outcome: { ok: boolean; error?: string; result?: unknown },
): Promise<void> {
  if (!activeCommand) {
    return;
  }
  try {
    const finishedAt = nowIso();
    const durationMs = Math.max(0, Date.now() - activeCommand.started_at_ms);
    const event: TelemetryEvent = {
      schema_version: TELEMETRY_SCHEMA_VERSION,
      event_id: crypto.randomUUID(),
      event_type: "command_finish",
      occurred_at: finishedAt,
      installation_id: activeCommand.installation_id,
      session_id: PROCESS_SESSION_ID,
      command: activeCommand.command,
      payload: buildCommandFinishPayload({
        captureLevel: activeCommand.capture_level,
        pmVersion: activeCommand.pm_version,
        sourceContext: {
          source_context: activeCommand.source_context,
          source_context_source: activeCommand.source_context_source,
        },
        outcome,
        durationMs,
        startedAt: activeCommand.started_at,
      }),
    };
    await enqueueTelemetryEvent(activeCommand.global_pm_root, event);
    await flushQueue(activeCommand.global_pm_root, activeCommand.endpoint, activeCommand.retention_days);
    await exportLocalOtelSpan(activeCommand, outcome, finishedAt, durationMs);
  } catch {
    // Telemetry must never block command execution.
  }
}
