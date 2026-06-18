/**
 * @module core/telemetry/runtime
 *
 * Captures consent-aware telemetry and observability events for Runtime.
 */
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, statSync } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { GlobalOptions } from "../shared/command-types.js";
import { resolvePmPackageRootFromModule } from "../packages/root.js";
import { appendLineAtomic, readFileIfExists, writeFileAtomic } from "../fs/fs-utils.js";
import { resolveTelemetryErrorCategory, type TelemetryErrorCategory } from "../shared/constants.js";
import { nowIso } from "../shared/time.js";
import { resolveGlobalPmRoot } from "../store/paths.js";
import { readSettings, writeSettings } from "../store/settings.js";
import {
  deriveTelemetryCommandResolution,
  deriveTelemetryCommandTaxonomy,
  inferTelemetryErrorCode,
  type TelemetryCommandResolution,
  type TelemetryCommandTaxonomy,
  type TelemetryResolutionStage,
} from "./observability.js";

const TELEMETRY_QUEUE_RELATIVE_PATH = path.join("runtime", "telemetry", "events.jsonl");
const TELEMETRY_STATE_RELATIVE_PATH = path.join("runtime", "telemetry", "state.json");
const TELEMETRY_OTEL_SPANS_RELATIVE_PATH = path.join("runtime", "telemetry", "otel-spans.jsonl");
// Kept small so a worst-case batch against a blackholed collector
// (TELEMETRY_OTEL_SPANS_FLUSH_BATCH_SIZE * TELEMETRY_HTTP_TIMEOUT_MS plus the
// preceding event flush) stays well under TELEMETRY_FLUSH_LOCK_STALE_MS (60s).
// Otherwise a later command could treat the still-held flush lock as stale and
// start a second concurrent worker.
const TELEMETRY_OTEL_SPANS_FLUSH_BATCH_SIZE = 8;
const TELEMETRY_OTEL_SPANS_MAX_PENDING = 500;
export const TELEMETRY_SCHEMA_VERSION = 1;
const TELEMETRY_CLIENT_SCHEMA_VERSION = 1;
const TELEMETRY_FLUSH_BATCH_SIZE = 100;
const TELEMETRY_MAX_RETRY_DELAY_MS = 3_600_000;
const TELEMETRY_RETRY_BASE_DELAY_MS = 30_000;
const TELEMETRY_HTTP_TIMEOUT_MS = 5_000;
const MILLISECONDS_PER_DAY = 86_400_000;
const TELEMETRY_MAX_EVENT_BYTES = 65_536;
const TELEMETRY_SANITIZE_MAX_DEPTH = 6;
const TELEMETRY_SANITIZE_MAX_ARRAY_ITEMS = 20;
export const TELEMETRY_MAX_QUEUE_ENTRY_ATTEMPTS = 15;
const TELEMETRY_RESULT_PREVIEW_MAX_BYTES = 8_192;
const TELEMETRY_QUEUE_REWRITE_RETRY_DELAYS_MS = [25, 50, 100, 200] as const;
const TELEMETRY_QUEUE_TMP_ORPHAN_MAX_AGE_MS = 60 * 60 * 1000;
const TELEMETRY_FLUSH_LOCK_STALE_MS = 60_000;
const TELEMETRY_FLUSH_SPAWN_LOCK_STALE_MS = 60_000;
const OTEL_TRACES_ENDPOINT_ENV = "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT";
const OTEL_BASE_ENDPOINT_ENV = "OTEL_EXPORTER_OTLP_ENDPOINT";
const OTEL_SERVICE_NAME_ENV = "OTEL_SERVICE_NAME";
const PM_TELEMETRY_DISABLED_ENV = "PM_TELEMETRY_DISABLED";
const PM_NO_TELEMETRY_ENV = "PM_NO_TELEMETRY";
const PM_TELEMETRY_DISABLED_VALUES = new Set(["1", "true", "yes", "on"]);
const PM_TELEMETRY_OTEL_DISABLED_ENV = "PM_TELEMETRY_OTEL_DISABLED";
const PM_TELEMETRY_OTEL_DISABLED_VALUES = new Set(["1", "true", "yes", "on"]);
const PM_TELEMETRY_INLINE_FLUSH_ENV = "PM_TELEMETRY_INLINE_FLUSH";
const PM_TELEMETRY_FLUSH_CHILD_ENV = "PM_TELEMETRY_FLUSH_CHILD";
const PM_TELEMETRY_SOURCE_CONTEXT_ENV = "PM_TELEMETRY_SOURCE_CONTEXT";
const PM_AUTHOR_ENV = "PM_AUTHOR";
export const PM_TELEMETRY_SOURCE_CONTEXT_VALUES = ["user", "automation", "test", "dogfood", "audit_smoke"] as const;

let _lastFlushPromise: Promise<void> = Promise.resolve();
let _queueMutationPromise: Promise<unknown> = Promise.resolve();

/** Wait for the most recent background flush to settle. Test-only helper. */
export async function waitForPendingFlush(): Promise<void> {
  await _lastFlushPromise;
  await _queueMutationPromise;
}
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
const BEARER_TOKEN_PATTERN = /bearer\s+[a-z0-9._=-]+/giu;
const PRIVATE_IP_PATTERN =
  /\b(?:10\.(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.(?:25[0-5]|2[0-4]\d|[01]?\d?\d)|172\.(?:1[6-9]|2\d|3[01])\.(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.(?:25[0-5]|2[0-4]\d|[01]?\d?\d)|192\.168\.(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.(?:25[0-5]|2[0-4]\d|[01]?\d?\d))\b/g;

interface TelemetryEvent {
  schema_version: number;
  event_id: string;
  event_type: "command_start" | "command_finish" | "command_error";
  occurred_at: string;
  installation_id: string;
  session_id: string;
  command: string;
  payload: Record<string, unknown>;
}

interface QueuedTelemetryEvent {
  client_schema_version?: number;
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
  pending_otel_spans?: number;
  last_otel_attempt_at?: string;
  last_otel_success_at?: string;
  last_otel_failure_at?: string;
  last_otel_failure_error?: string;
}

/**
 * A built OpenTelemetry span request awaiting export. Persisted to a small,
 * bounded queue so the OTLP trace POST happens in the detached, unref'd flush
 * worker instead of inline in the foreground command. This keeps the CLI process
 * from staying alive while a connecting socket to an unreachable traces endpoint
 * drains its 5s timeout (the GH-209 root cause). `payload` is the fully built
 * OTLP resourceSpans body; `endpoint` is the per-span traces endpoint.
 */
interface PendingOtelSpan {
  /**
   * Stable id used to reconcile the queue after the network flush: the worker
   * re-reads the file and removes/updates only the spans it processed, by id, so
   * spans appended by a concurrent foreground process during the flush are never
   * overwritten. Mirrors the event-queue's event_id-based reconciliation.
   */
  id: string;
  endpoint: string;
  payload: unknown;
  enqueued_at: string;
  attempts: number;
  next_attempt_after?: string;
}

type TelemetryCaptureLevel = "minimal" | "redacted" | "max";
type TelemetrySourceContext = (typeof PM_TELEMETRY_SOURCE_CONTEXT_VALUES)[number];
type TelemetrySourceContextSource = "inferred" | "env_override";

interface ResolvedTelemetrySourceContext {
  source_context: TelemetrySourceContext;
  source_context_source: TelemetrySourceContextSource;
}

/**
 * Documents the active telemetry command payload exchanged by command, SDK, and package integrations.
 */
export interface ActiveTelemetryCommand {
  started_at: string;
  started_at_ms: number;
  command: string;
  command_taxonomy: TelemetryCommandTaxonomy;
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

/**
 * Documents the telemetry command context payload exchanged by command, SDK, and package integrations.
 */
export interface TelemetryCommandContext {
  command: string;
  pm_version: string;
  args: string[];
  options: Record<string, unknown>;
  global: GlobalOptions;
  pm_root: string;
}

/**
 * Documents the telemetry command outcome payload exchanged by command, SDK, and package integrations.
 */
export interface TelemetryCommandOutcome {
  ok: boolean;
  error?: string;
  result?: unknown;
  exit_code?: number;
  error_code?: string;
  error_category?: TelemetryErrorCategory;
  command_resolution?: TelemetryCommandResolution;
  resolution_stage?: TelemetryResolutionStage;
}

/**
 * Documents the telemetry error event context payload exchanged by command, SDK, and package integrations.
 */
export interface TelemetryErrorEventContext {
  command: string;
  args: string[];
  options: Record<string, unknown>;
  global: GlobalOptions;
  pm_version: string;
  pm_root: string;
  error_code: string;
  error_message: string;
  exit_code: number;
  error_category?: TelemetryErrorCategory;
  command_resolution?: TelemetryCommandResolution;
  resolution_stage?: TelemetryResolutionStage;
}


function queuePath(globalPmRoot: string): string {
  return path.join(globalPmRoot, TELEMETRY_QUEUE_RELATIVE_PATH);
}

function otelSpansQueuePath(globalPmRoot: string): string {
  return path.join(globalPmRoot, TELEMETRY_OTEL_SPANS_RELATIVE_PATH);
}

function telemetryRuntimeDirectory(globalPmRoot: string): string {
  return path.dirname(queuePath(globalPmRoot));
}

function runtimeStatePath(globalPmRoot: string): string {
  return path.join(globalPmRoot, TELEMETRY_STATE_RELATIVE_PATH);
}

function flushLockPath(globalPmRoot: string): string {
  return path.join(globalPmRoot, "runtime", "telemetry", "flush.lock");
}

function flushSpawnLockPath(globalPmRoot: string): string {
  return path.join(globalPmRoot, "runtime", "telemetry", "flush.spawn.lock");
}

function telemetryFlushRunnerPath(): string {
  return path.join(resolvePmPackageRootFromModule(import.meta.url, ["../../.."]), "dist", "cli", "telemetry-flush.js");
}

function shouldFlushInline(): boolean {
  if (parseBooleanTrueLike(process.env[PM_TELEMETRY_INLINE_FLUSH_ENV])) {
    return true;
  }
  if (parseBooleanTrueLike(process.env[PM_TELEMETRY_FLUSH_CHILD_ENV])) {
    return true;
  }
  const nodeEnv = (process.env.NODE_ENV ?? "").trim().toLowerCase();
  return typeof process.env.VITEST === "string" || typeof process.env.VITEST_WORKER_ID === "string" || nodeEnv === "test";
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

function isAsciiLetterOrDigitCode(code: number): boolean {
  const isUpper = code >= 65 && code <= 90;
  const isLower = code >= 97 && code <= 122;
  const isDigit = code >= 48 && code <= 57;
  return isUpper || isLower || isDigit;
}

function isEmailLocalCharacter(character: string | undefined): boolean {
  if (!character) {
    return false;
  }
  const code = character.charCodeAt(0);
  if (isAsciiLetterOrDigitCode(code)) {
    return true;
  }
  return character === "." || character === "_" || character === "%" || character === "+" || character === "-";
}

function isEmailDomainCharacter(character: string | undefined): boolean {
  if (!character) {
    return false;
  }
  const code = character.charCodeAt(0);
  if (isAsciiLetterOrDigitCode(code)) {
    return true;
  }
  return character === "." || character === "-";
}

function looksLikeEmailToken(token: string): boolean {
  const atIndex = token.indexOf("@");
  if (atIndex <= 0 || atIndex !== token.lastIndexOf("@") || atIndex === token.length - 1) {
    return false;
  }
  const localPart = token.slice(0, atIndex);
  const domainPart = token.slice(atIndex + 1);
  const lastDot = domainPart.lastIndexOf(".");
  if (lastDot <= 0 || lastDot === domainPart.length - 1) {
    return false;
  }
  if (domainPart.length - (lastDot + 1) < 2) {
    return false;
  }
  for (const character of localPart) {
    if (!isEmailLocalCharacter(character)) {
      return false;
    }
  }
  for (const character of domainPart) {
    if (!isEmailDomainCharacter(character)) {
      return false;
    }
  }
  return true;
}

function redactEmailTokens(input: string): string {
  let redacted = "";
  let cursor = 0;
  while (cursor < input.length) {
    const atIndex = input.indexOf("@", cursor);
    if (atIndex < 0) {
      redacted += input.slice(cursor);
      break;
    }
    let start = atIndex - 1;
    while (start >= cursor && isEmailLocalCharacter(input[start])) {
      start -= 1;
    }
    start += 1;
    let end = atIndex + 1;
    while (end < input.length && isEmailDomainCharacter(input[end])) {
      end += 1;
    }
    const candidate = input.slice(start, end);
    if (looksLikeEmailToken(candidate)) {
      redacted += input.slice(cursor, start);
      redacted += "[redacted_email]";
      cursor = end;
      continue;
    }
    redacted += input.slice(cursor, atIndex + 1);
    cursor = atIndex + 1;
  }
  return redacted;
}

function sanitizeCommonSensitiveTokens(input: string): string {
  const withoutEmails = redactEmailTokens(input);
  const withoutBearer = withoutEmails.replaceAll(BEARER_TOKEN_PATTERN, "bearer [redacted_token]");
  return withoutBearer.replaceAll(PRIVATE_IP_PATTERN, "[redacted_ip]");
}

function sanitizeStringRedacted(input: string): string {
  const withoutCommonSensitiveTokens = sanitizeCommonSensitiveTokens(input);
  const withoutInlineSecrets = redactInlineSensitiveAssignments(withoutCommonSensitiveTokens);
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
  const withoutCommonSensitiveTokens = sanitizeCommonSensitiveTokens(input);
  const withoutInlineSecrets = redactInlineSensitiveAssignments(withoutCommonSensitiveTokens);
  const withoutAbsolutePaths = redactAbsolutePathTokens(withoutInlineSecrets);
  const trimmed = withoutAbsolutePaths.trim();
  if (trimmed.startsWith("/") && trimmed.length > 1) {
    return "[redacted_path]";
  }
  if (withoutAbsolutePaths.length > 2048) {
    return `${withoutAbsolutePaths.slice(0, 2045)}...`;
  }
  return withoutAbsolutePaths;
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
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length > 0 ? trimmed : "0.0.0";
}

function normalizeTelemetryErrorCode(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function normalizeTelemetryExitCode(exitCode: number | undefined, ok: boolean): number {
  if (Number.isFinite(exitCode)) {
    return Math.max(0, Math.trunc(exitCode as number));
  }
  return ok ? 0 : 1;
}

function normalizeTelemetryErrorCategory(params: {
  ok: boolean;
  errorCode?: string;
  errorCategory?: TelemetryErrorCategory;
}): TelemetryErrorCategory | undefined {
  if (params.ok) {
    return undefined;
  }
  if (typeof params.errorCategory === "string" && params.errorCategory.trim().length > 0) {
    return params.errorCategory;
  }
  if (typeof params.errorCode === "string" && params.errorCode.trim().length > 0) {
    return resolveTelemetryErrorCategory(params.errorCode);
  }
  return "unknown";
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

/**
 * Builds the agent-identity dimension for a telemetry payload from `PM_AUTHOR`.
 *
 * The raw `PM_AUTHOR` value (e.g. `claude-code-agent`) is never emitted. At
 * non-minimal capture levels a stable `author_context_hash` is attached — the
 * same installation-id-keyed one-way hash used for `pm_root_hash`/`cwd_hash`, so
 * agent-driven invocations can be segmented in Sentry/dashboards while the same
 * author hashes differently across installations. Because the field is a one-way
 * hash, it intentionally bypasses the {@link SENSITIVE_KEYWORDS} redaction path.
 * At minimal capture only a `has_author_context` boolean is surfaced.
 */
function buildAuthorContextPayloadFields(
  captureLevel: TelemetryCaptureLevel,
  installationId: string,
): Record<string, unknown> {
  const author = (process.env[PM_AUTHOR_ENV] ?? "").trim();
  if (captureLevel === "minimal") {
    return { has_author_context: author.length > 0 };
  }
  return author.length > 0
    ? { author_context_hash: hashWithInstallationId(installationId, author) }
    : {};
}

function normalizeForHash(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (depth >= TELEMETRY_SANITIZE_MAX_DEPTH) {
    return "[depth_truncated]";
  }
  if (Array.isArray(value)) {
    return value.slice(0, TELEMETRY_SANITIZE_MAX_ARRAY_ITEMS).map((entry) => normalizeForHash(entry, depth + 1));
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const normalized: Record<string, unknown> = {};
    const sortedKeys = Object.keys(record).sort((left, right) => left.localeCompare(right));
    for (const key of sortedKeys) {
      normalized[key] = normalizeForHash(record[key], depth + 1);
    }
    return normalized;
  }
  return String(value);
}

function hashTelemetryValue(installationId: string, value: unknown): string {
  return hashWithInstallationId(installationId, JSON.stringify(normalizeForHash(value)));
}

function hashCommandArgs(installationId: string, args: string[]): { hashes: string[]; digest: string } {
  return {
    hashes: args.map((arg) => hashWithInstallationId(installationId, arg)),
    digest: hashWithInstallationId(installationId, args.join("\u0000")),
  };
}

function hashTelemetryErrorFingerprint(
  installationId: string,
  command: string,
  errorCode: string | undefined,
  errorMessage: string | undefined,
): string {
  const normalizedMessage = sanitizeString(typeof errorMessage === "string" ? errorMessage : "", "redacted");
  const normalizedCode = typeof errorCode === "string" && errorCode.length > 0 ? errorCode : "unknown_error";
  const fingerprintSource = `${command}\u0000${normalizedCode}\u0000${normalizedMessage}`;
  return hashWithInstallationId(installationId, fingerprintSource);
}

function telemetryDisabledByEnvironment(): boolean {
  return (
    PM_TELEMETRY_DISABLED_VALUES.has((process.env[PM_TELEMETRY_DISABLED_ENV] ?? "").trim().toLowerCase()) ||
    PM_TELEMETRY_DISABLED_VALUES.has((process.env[PM_NO_TELEMETRY_ENV] ?? "").trim().toLowerCase())
  );
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

/**
 * Build the OTLP trace-export request for a finished command without performing
 * any network I/O. Returns `null` when OTLP export is not configured (no traces
 * endpoint / trace ids). The actual POST is deferred to the detached flush worker
 * via {@link enqueuePendingOtelSpan} so the foreground command never blocks on a
 * connecting socket (GH-209).
 */
function buildOtelSpanRequest(
  activeCommand: ActiveTelemetryCommand,
  outcome: { ok: boolean; error?: string; exit_code?: number; error_code?: string; error_category?: TelemetryErrorCategory },
  finishedAtIso: string,
  durationMs: number,
): { endpoint: string; payload: unknown } | null {
  if (
    typeof activeCommand.otel_traces_endpoint !== "string" ||
    activeCommand.otel_traces_endpoint.trim().length === 0 ||
    typeof activeCommand.otel_trace_id !== "string" ||
    activeCommand.otel_trace_id.length === 0 ||
    typeof activeCommand.otel_span_id !== "string" ||
    activeCommand.otel_span_id.length === 0
  ) {
    return null;
  }

  const serviceNameCandidate = sanitizeString((process.env[OTEL_SERVICE_NAME_ENV] ?? "").trim());
  const serviceName = serviceNameCandidate.length > 0 ? serviceNameCandidate : "pm-cli";
  const normalizedExitCode = normalizeTelemetryExitCode(outcome.exit_code, outcome.ok);
  const normalizedErrorCode = normalizeTelemetryErrorCode(outcome.error_code);
  const normalizedErrorCategory = normalizeTelemetryErrorCategory({
    ok: outcome.ok,
    errorCode: normalizedErrorCode,
    errorCategory: outcome.error_category,
  });
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
    otlpIntAttribute("pm.exit_code", normalizedExitCode),
    otlpIntAttribute("pm.duration_ms", durationMs),
  ];
  if (typeof normalizedErrorCode === "string") {
    attributes.push(otlpStringAttribute("pm.error_code", normalizedErrorCode));
  }
  if (typeof normalizedErrorCategory === "string") {
    attributes.push(otlpStringAttribute("pm.error_category", normalizedErrorCategory));
  }
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
                  message: outcome.ok
                    ? ""
                    : sanitizeString(typeof outcome.error === "string" ? outcome.error : "command_failed"),
                },
              },
            ],
          },
        ],
      },
    ],
  };

  return { endpoint: activeCommand.otel_traces_endpoint, payload };
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
    let previewBytes = 0;
    for (const key of keys.slice(0, 25)) {
      const sanitizedValue = sanitizeValue(record[key], key, captureLevel);
      const entrySize = JSON.stringify(sanitizedValue).length;
      if (previewBytes + entrySize > TELEMETRY_RESULT_PREVIEW_MAX_BYTES) {
        sanitized[key] = "[preview_truncated]";
        break;
      }
      previewBytes += entrySize;
      sanitized[key] = sanitizedValue;
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
  const commandTaxonomy = deriveTelemetryCommandTaxonomy(context.command);
  const hashedArgs = hashCommandArgs(installationId, context.args);
  const commandInvocationDigest = hashWithInstallationId(installationId, `${context.command}\u0000${context.args.join("\u0000")}`);
  const commandOptionsDigest = hashTelemetryValue(installationId, context.options);
  const globalOptionsDigest = hashTelemetryValue(installationId, context.global);
  const authorContextFields = buildAuthorContextPayloadFields(captureLevel, installationId);
  if (captureLevel === "minimal") {
    return {
      capture_level: captureLevel,
      pm_version: pmVersion,
      source_context: sourceContext.source_context,
      source_context_source: sourceContext.source_context_source,
      command_taxonomy: commandTaxonomy,
      command_args_digest: hashedArgs.digest,
      command_invocation_digest: commandInvocationDigest,
      command_options_digest: commandOptionsDigest,
      global_options_digest: globalOptionsDigest,
      ...authorContextFields,
    };
  }
  return {
    pm_version: pmVersion,
    source_context: sourceContext.source_context,
    source_context_source: sourceContext.source_context_source,
    command_taxonomy: commandTaxonomy,
    ...authorContextFields,
    command_args: sanitizeCommandArgs(context.args, captureLevel),
    command_args_hashes: hashedArgs.hashes,
    command_args_digest: hashedArgs.digest,
    command_invocation_digest: commandInvocationDigest,
    command_options: sanitizeValue(context.options, undefined, captureLevel) as Record<string, unknown>,
    command_options_digest: commandOptionsDigest,
    global_options: sanitizeValue(context.global, undefined, captureLevel) as Record<string, unknown>,
    global_options_digest: globalOptionsDigest,
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
  outcome: TelemetryCommandOutcome;
  durationMs: number;
  startedAt: string;
  command: string;
  installationId: string;
  commandTaxonomy: TelemetryCommandTaxonomy;
  exitCode: number;
  errorCode?: string;
  errorCategory?: TelemetryErrorCategory;
  commandResolution: TelemetryCommandResolution;
  resolutionStage: TelemetryResolutionStage;
}): Record<string, unknown> {
  const {
    captureLevel,
    pmVersion,
    sourceContext,
    outcome,
    durationMs,
    startedAt,
    command,
    installationId,
    commandTaxonomy,
    exitCode,
    errorCode,
    errorCategory,
    commandResolution,
    resolutionStage,
  } = params;
  const errorFingerprint =
    outcome.ok === false
      ? hashTelemetryErrorFingerprint(installationId, command, errorCode, outcome.error)
      : undefined;
  const authorContextFields = buildAuthorContextPayloadFields(captureLevel, installationId);
  if (captureLevel === "minimal") {
    return {
      capture_level: captureLevel,
      pm_version: pmVersion,
      source_context: sourceContext.source_context,
      source_context_source: sourceContext.source_context_source,
      command_taxonomy: commandTaxonomy,
      command_resolution: commandResolution,
      resolution_stage: resolutionStage,
      ok: outcome.ok,
      exit_code: exitCode,
      error_code: errorCode,
      error_category: errorCategory,
      error: outcome.error ? sanitizeString(outcome.error, "redacted") : undefined,
      error_fingerprint: errorFingerprint,
      duration_ms: durationMs,
      ...authorContextFields,
    };
  }
  return {
    capture_level: captureLevel,
    pm_version: pmVersion,
    source_context: sourceContext.source_context,
    source_context_source: sourceContext.source_context_source,
    command_taxonomy: commandTaxonomy,
    command_resolution: commandResolution,
    resolution_stage: resolutionStage,
    ...authorContextFields,
    ok: outcome.ok,
    exit_code: exitCode,
    error_code: errorCode,
    error_category: errorCategory,
    error: outcome.error ? sanitizeString(outcome.error, captureLevel) : undefined,
    error_fingerprint: errorFingerprint,
    duration_ms: durationMs,
    started_at: startedAt,
    result_summary: summarizeResult(outcome.result, captureLevel),
  };
}

function buildCommandErrorPayload(params: {
  captureLevel: TelemetryCaptureLevel;
  pmVersion: string;
  sourceContext: ResolvedTelemetrySourceContext;
  command: string;
  commandTaxonomy: TelemetryCommandTaxonomy;
  commandResolution: TelemetryCommandResolution;
  resolutionStage: TelemetryResolutionStage;
  args: string[];
  options: Record<string, unknown>;
  pmRootHash: string;
  cwdHash: string;
  installationId: string;
  errorCode: string;
  errorMessage: string;
  errorCategory: TelemetryErrorCategory;
  exitCode: number;
}): Record<string, unknown> {
  const {
    captureLevel,
    pmVersion,
    sourceContext,
    command,
    commandTaxonomy,
    commandResolution,
    resolutionStage,
    args,
    options,
    pmRootHash,
    cwdHash,
    installationId,
    errorCode,
    errorMessage,
    errorCategory,
    exitCode,
  } = params;
  const attemptedArgHashes = hashCommandArgs(installationId, args);
  const attemptedCommandDigest = hashWithInstallationId(installationId, command);
  const attemptedOptionsDigest = hashTelemetryValue(installationId, options);
  const errorFingerprint = hashTelemetryErrorFingerprint(installationId, command, errorCode, errorMessage);
  if (captureLevel === "minimal") {
    return {
      capture_level: captureLevel,
      pm_version: pmVersion,
      source_context: sourceContext.source_context,
      source_context_source: sourceContext.source_context_source,
      command_taxonomy: commandTaxonomy,
      command_resolution: commandResolution,
      resolution_stage: resolutionStage,
      attempted_command_digest: attemptedCommandDigest,
      attempted_args_digest: attemptedArgHashes.digest,
      attempted_options_digest: attemptedOptionsDigest,
      error_code: errorCode,
      error_category: errorCategory,
      exit_code: exitCode,
      error: sanitizeString(errorMessage, "redacted"),
      error_fingerprint: errorFingerprint,
    };
  }

  return {
    capture_level: captureLevel,
    pm_version: pmVersion,
    source_context: sourceContext.source_context,
    source_context_source: sourceContext.source_context_source,
    command_taxonomy: commandTaxonomy,
    command_resolution: commandResolution,
    resolution_stage: resolutionStage,
    attempted_command: sanitizeString(command, captureLevel),
    attempted_command_digest: attemptedCommandDigest,
    attempted_args: sanitizeCommandArgs(args, captureLevel),
    attempted_args_hashes: attemptedArgHashes.hashes,
    attempted_args_digest: attemptedArgHashes.digest,
    attempted_options: sanitizeValue(options, undefined, captureLevel) as Record<string, unknown>,
    attempted_options_digest: attemptedOptionsDigest,
    error_code: errorCode,
    error_category: errorCategory,
    exit_code: exitCode,
    error: sanitizeString(errorMessage, captureLevel),
    error_fingerprint: errorFingerprint,
    pm_root_hash: pmRootHash,
    cwd_hash: cwdHash,
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
    client_schema_version: TELEMETRY_CLIENT_SCHEMA_VERSION,
    event,
    attempts: 0,
  };
  let serialized = JSON.stringify(queued);
  if (serialized.length > TELEMETRY_MAX_EVENT_BYTES) {
    const trimmed = { ...event, payload: { ...event.payload, result_summary: { truncated: true, reason: "payload_size_exceeded", original_bytes: serialized.length } } };
    const trimmedQueued: QueuedTelemetryEvent = {
      client_schema_version: TELEMETRY_CLIENT_SCHEMA_VERSION,
      event: trimmed,
      attempts: 0,
    };
    serialized = JSON.stringify(trimmedQueued);
  }
  await withQueueMutation(async () => {
    await appendLineAtomic(queuePath(globalPmRoot), serialized);
  });
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
        typeof parsed.attempts === "number" &&
        (
          parsed.client_schema_version === undefined ||
          (typeof parsed.client_schema_version === "number" && Number.isFinite(parsed.client_schema_version))
        )
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

function isDueForRetryAt(nextAttemptAfter: string | undefined): boolean {
  if (typeof nextAttemptAfter !== "string" || nextAttemptAfter.trim().length === 0) {
    return true;
  }
  const dueAtMs = Date.parse(nextAttemptAfter);
  if (Number.isNaN(dueAtMs)) {
    return true;
  }
  return dueAtMs <= Date.now();
}

function isDueForRetry(entry: QueuedTelemetryEvent): boolean {
  return isDueForRetryAt(entry.next_attempt_after);
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
    const serializedSize = JSON.stringify(entry).length;
    const oversized = serializedSize > TELEMETRY_MAX_EVENT_BYTES;
    if (oversized || isExpiredQueueEntry(entry, cutoffMs) || entry.attempts >= TELEMETRY_MAX_QUEUE_ENTRY_ATTEMPTS) {
      prunedCount += 1;
      continue;
    }
    retained.push(entry);
  }
  return { entries: retained, prunedCount };
}

async function rewriteQueue(globalPmRoot: string, entries: QueuedTelemetryEvent[]): Promise<void> {
  const serialized = entries.map((entry) => JSON.stringify(entry)).join("\n");
  const contents = serialized.length > 0 ? `${serialized}\n` : "";
  for (let attempt = 0; ; attempt += 1) {
    try {
      await writeFileAtomic(queuePath(globalPmRoot), contents);
      return;
    } catch (error: unknown) {
      const retryDelay = TELEMETRY_QUEUE_REWRITE_RETRY_DELAYS_MS[attempt];
      if (retryDelay === undefined || !isRetryableQueueRewriteError(error)) {
        throw error;
      }
      await sleep(retryDelay);
    }
  }
}

function isRetryableQueueRewriteError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return code === "EACCES" || code === "EBUSY" || code === "EPERM";
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

/**
 * Append a built OTLP span request to the bounded pending-spans queue. The
 * detached flush worker drains and POSTs these so the foreground command never
 * performs OTLP network I/O (GH-209). Best effort: a write failure never blocks
 * the command, and the span is simply not exported.
 */
async function enqueuePendingOtelSpan(globalPmRoot: string, request: { endpoint: string; payload: unknown }): Promise<void> {
  const pending: PendingOtelSpan = {
    id: crypto.randomUUID(),
    endpoint: request.endpoint,
    payload: request.payload,
    enqueued_at: nowIso(),
    attempts: 0,
  };
  const serialized = JSON.stringify(pending);
  // Drop oversized spans rather than poison the queue; they would never flush.
  if (serialized.length > TELEMETRY_MAX_EVENT_BYTES) {
    return;
  }
  await withQueueMutation(async () => {
    await appendLineAtomic(otelSpansQueuePath(globalPmRoot), serialized);
  });
}

/**
 * Derive a stable id for a legacy id-less pending span from its identity fields.
 * Deterministic so the same on-disk line yields the same id across reads, which
 * is what lets reconciliation remove/update it after a flush.
 */
function backfillPendingOtelSpanId(entry: { endpoint: string; enqueued_at: string; payload: unknown }): string {
  const material = JSON.stringify([entry.endpoint, entry.enqueued_at, entry.payload]);
  return crypto.createHash("sha256").update(material).digest("hex").slice(0, 32);
}

function parsePendingOtelSpanLines(raw: string): PendingOtelSpan[] {
  const entries: PendingOtelSpan[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as PendingOtelSpan;
      if (
        parsed &&
        typeof parsed === "object" &&
        typeof parsed.endpoint === "string" &&
        parsed.endpoint.trim().length > 0 &&
        "payload" in parsed &&
        typeof parsed.attempts === "number" &&
        Number.isFinite(parsed.attempts)
      ) {
        // Backfill an id for legacy entries written before id tracking existed.
        // It MUST be deterministic from the entry's content so the post-flush
        // re-read derives the same id and reconciliation can address the entry;
        // a random id would differ between reads and strand the span.
        if (typeof parsed.id !== "string" || parsed.id.length === 0) {
          parsed.id = backfillPendingOtelSpanId(parsed);
        }
        entries.push(parsed);
      }
    } catch {
      // Drop malformed lines to preserve forward progress.
    }
  }
  return entries;
}

function isExpiredPendingOtelSpan(entry: PendingOtelSpan, cutoffMs: number): boolean {
  if (typeof entry.enqueued_at !== "string" || entry.enqueued_at.trim().length === 0) {
    return false;
  }
  const enqueuedAtMs = Date.parse(entry.enqueued_at);
  if (Number.isNaN(enqueuedAtMs)) {
    return false;
  }
  return enqueuedAtMs < cutoffMs;
}

function prunePendingOtelSpans(
  entries: PendingOtelSpan[],
  retentionDays: number,
): { entries: PendingOtelSpan[]; prunedCount: number } {
  const cutoffMs = retentionCutoffMs(retentionDays);
  const retained: PendingOtelSpan[] = [];
  let prunedCount = 0;
  for (const entry of entries) {
    const oversized = JSON.stringify(entry).length > TELEMETRY_MAX_EVENT_BYTES;
    if (oversized || isExpiredPendingOtelSpan(entry, cutoffMs) || entry.attempts >= TELEMETRY_MAX_QUEUE_ENTRY_ATTEMPTS) {
      prunedCount += 1;
      continue;
    }
    retained.push(entry);
  }
  if (retained.length > TELEMETRY_OTEL_SPANS_MAX_PENDING) {
    const overflow = retained.length - TELEMETRY_OTEL_SPANS_MAX_PENDING;
    prunedCount += overflow;
    // Keep the most recently enqueued spans; oldest beyond the cap are dropped.
    return { entries: retained.slice(overflow), prunedCount };
  }
  return { entries: retained, prunedCount };
}

async function rewritePendingOtelSpans(globalPmRoot: string, entries: PendingOtelSpan[]): Promise<void> {
  const serialized = entries.map((entry) => JSON.stringify(entry)).join("\n");
  const contents = serialized.length > 0 ? `${serialized}\n` : "";
  for (let attempt = 0; ; attempt += 1) {
    try {
      await writeFileAtomic(otelSpansQueuePath(globalPmRoot), contents);
      return;
    } catch (error: unknown) {
      const retryDelay = TELEMETRY_QUEUE_REWRITE_RETRY_DELAYS_MS[attempt];
      if (retryDelay === undefined || !isRetryableQueueRewriteError(error)) {
        throw error;
      }
      await sleep(retryDelay);
    }
  }
}

/**
 * Drain the pending OTLP span queue and POST due spans to their traces endpoint.
 * Runs only inside the flush worker (detached child) or the inline test path, so
 * the foreground command never makes OTLP network calls. Failures increment
 * per-span attempts with backoff and are retried by a later flush; runtime state
 * records OTLP export diagnostics for `pm health` (GH-205).
 */
/**
 * Re-read the spans queue under the mutation serializer and rewrite it with the
 * processed spans removed/updated by id, preserving any spans a concurrent
 * foreground process appended during the (network) flush window. `succeededIds`
 * are dropped; `failedUpdates` patch attempts/next_attempt_after by id; all other
 * (incl. newly-appended) entries are retained, then pruned. Returns the count of
 * spans left in the queue. Mirrors removeFlushedEntriesFromCurrentQueue.
 */
async function reconcilePendingOtelSpansAfterFlush(
  globalPmRoot: string,
  retentionDays: number,
  succeededIds: ReadonlySet<string>,
  failedUpdates: ReadonlyMap<string, { attempts: number; next_attempt_after: string }>,
): Promise<number> {
  return withQueueMutation(async () => {
    const raw = await readFileIfExists(otelSpansQueuePath(globalPmRoot));
    const current = raw === null ? [] : parsePendingOtelSpanLines(raw);
    const reconciled: PendingOtelSpan[] = [];
    for (const entry of current) {
      if (succeededIds.has(entry.id)) {
        continue;
      }
      const failure = failedUpdates.get(entry.id);
      reconciled.push(failure ? { ...entry, attempts: failure.attempts, next_attempt_after: failure.next_attempt_after } : entry);
    }
    const { entries: retained } = prunePendingOtelSpans(reconciled, retentionDays);
    await rewritePendingOtelSpans(globalPmRoot, retained);
    return retained.length;
  });
}

async function flushPendingOtelSpans(globalPmRoot: string, retentionDays: number): Promise<void> {
  const raw = await readFileIfExists(otelSpansQueuePath(globalPmRoot));
  if (raw === null || raw.trim().length === 0) {
    await writeRuntimeState(globalPmRoot, { pending_otel_spans: 0 });
    return;
  }
  const entries = parsePendingOtelSpanLines(raw);
  const { entries: retained, prunedCount } = prunePendingOtelSpans(entries, retentionDays);
  const due = retained.filter((entry) => isDueForRetryAt(entry.next_attempt_after)).slice(
    0,
    TELEMETRY_OTEL_SPANS_FLUSH_BATCH_SIZE,
  );
  if (due.length === 0) {
    // Nothing to POST. Still reconcile so pruning persists, but only if pruning
    // actually changed the on-disk set (avoids a redundant rewrite each command).
    const remaining = prunedCount > 0 ? await reconcilePendingOtelSpansAfterFlush(globalPmRoot, retentionDays, new Set(), new Map()) : retained.length;
    await writeRuntimeState(globalPmRoot, { pending_otel_spans: remaining });
    return;
  }

  const attemptTime = nowIso();
  const succeededIds = new Set<string>();
  const failedUpdates = new Map<string, { attempts: number; next_attempt_after: string }>();
  let succeededCount = 0;
  let lastError: string | undefined;
  // Export the batch concurrently so a slow/blackholed collector caps the worker
  // at one TELEMETRY_HTTP_TIMEOUT_MS rather than batch-size x timeout — keeping it
  // well within the flush-lock TTL. The Set/Map/counter mutations are synchronous
  // and safe under Node's single-threaded event loop.
  await Promise.all(
    due.map(async (span) => {
      try {
        const response = await fetch(span.endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(span.payload),
          signal: AbortSignal.timeout(TELEMETRY_HTTP_TIMEOUT_MS),
        });
        if (!response.ok) {
          throw new Error(`local_otel_export_http_${response.status}`);
        }
        succeededIds.add(span.id);
        succeededCount += 1;
      } catch (error: unknown) {
        lastError = error instanceof Error ? sanitizeString(error.message, "redacted") : "local_otel_export_failed";
        const nextAttempts = span.attempts + 1;
        failedUpdates.set(span.id, { attempts: nextAttempts, next_attempt_after: nextRetryIso(nextAttempts) });
      }
    }),
  );

  const remaining = await reconcilePendingOtelSpansAfterFlush(globalPmRoot, retentionDays, succeededIds, failedUpdates);
  const statePatch: TelemetryRuntimeState = {
    pending_otel_spans: remaining,
    last_otel_attempt_at: attemptTime,
  };
  if (succeededCount > 0) {
    statePatch.last_otel_success_at = attemptTime;
  }
  if (lastError !== undefined) {
    statePatch.last_otel_failure_at = attemptTime;
    statePatch.last_otel_failure_error = lastError;
  } else if (remaining === 0) {
    // Only clear the failure diagnostic once the queue is fully drained. A
    // clean batch while other (not-yet-due) spans still wait could be hiding
    // earlier failures; keep the last known failure until nothing is pending.
    statePatch.last_otel_failure_at = undefined;
    statePatch.last_otel_failure_error = undefined;
  }
  await writeRuntimeState(globalPmRoot, statePatch);
}

/**
 * Flush both telemetry artifacts under the same worker invocation: the event
 * ingest queue and the pending OTLP span queue. Used by the detached flush
 * worker and the inline (test) path so OTLP export always happens off the
 * foreground command's critical path.
 */
async function flushTelemetryArtifacts(globalPmRoot: string, endpoint: string, retentionDays: number): Promise<void> {
  // Isolate the two artifacts: a failure flushing the event queue (e.g. a corrupt
  // queue file) must not strand the OTLP span flush in the same pass, and vice
  // versa. Both are best effort and retried on the next dispatch.
  try {
    await flushQueue(globalPmRoot, endpoint, retentionDays);
  } catch {
    // Best effort; event-queue flush is retried on the next dispatch.
  }
  try {
    await flushPendingOtelSpans(globalPmRoot, retentionDays);
  } catch {
    // Best effort; span flush is retried on the next dispatch.
  }
}

async function cleanupTelemetryQueueTempOrphans(
  globalPmRoot: string,
  maxAgeMs = TELEMETRY_QUEUE_TMP_ORPHAN_MAX_AGE_MS,
): Promise<void> {
  try {
    const dirPath = telemetryRuntimeDirectory(globalPmRoot);
    const entries = await readdir(dirPath, { withFileTypes: true });
    const cutoffMs = Date.now() - Math.max(0, maxAgeMs);
    await Promise.all(
      entries
        .filter((entry) => entry.isFile() && /^\.events\.jsonl\.\d+\.\d+\.[a-f0-9]+\.tmp$/.test(entry.name))
        .map(async (entry) => {
          const candidate = path.join(dirPath, entry.name);
          const candidateStats = await stat(candidate);
          if (candidateStats.mtimeMs < cutoffMs) {
            await rm(candidate, { force: true });
          }
        }),
    );
  } catch {
    // Telemetry cleanup is best-effort and must not affect command execution.
  }
}

async function withQueueMutation<T>(operation: () => Promise<T>): Promise<T> {
  const run = _queueMutationPromise.catch(
    /* c8 ignore next */
    () => {},
  ).then(operation);
  _queueMutationPromise = run.catch(
    /* c8 ignore next */
    () => {},
  );
  return run;
}

async function readCurrentQueueEntries(globalPmRoot: string): Promise<QueuedTelemetryEvent[]> {
  const raw = await readFileIfExists(queuePath(globalPmRoot));
  if (raw === null || raw.trim().length === 0) {
    return [];
  }
  return parseQueueLines(raw);
}

async function removeFlushedEntriesFromCurrentQueue(
  globalPmRoot: string,
  flushedIds: ReadonlySet<string>,
  retentionDays: number,
): Promise<QueuedTelemetryEvent[]> {
  return withQueueMutation(async () => {
    const currentEntries = await readCurrentQueueEntries(globalPmRoot);
    const { entries: retainedEntries } = pruneExpiredQueueEntries(currentEntries, retentionDays);
    const remaining = retainedEntries.filter((entry) => !flushedIds.has(entry.event.event_id));
    await rewriteQueue(globalPmRoot, remaining);
    return remaining;
  });
}

async function markFailedEntriesInCurrentQueue(
  globalPmRoot: string,
  failedIds: ReadonlySet<string>,
  attemptTime: string,
  retentionDays: number,
): Promise<QueuedTelemetryEvent[]> {
  return withQueueMutation(async () => {
    const currentEntries = await readCurrentQueueEntries(globalPmRoot);
    const { entries: retainedEntries } = pruneExpiredQueueEntries(currentEntries, retentionDays);
    const retried = retainedEntries.map((entry) => {
      if (!failedIds.has(entry.event.event_id)) {
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
    return retried;
  });
}

async function flushQueue(globalPmRoot: string, endpoint: string, retentionDays: number): Promise<void> {
  await cleanupTelemetryQueueTempOrphans(globalPmRoot);
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
    await rewriteQueue(globalPmRoot, []);
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
  const requestHeaders: Record<string, string> = {
    "content-type": "application/json",
  };
  const ingestKey = process.env.PM_TELEMETRY_INGEST_KEY?.trim();
  if (ingestKey) {
    requestHeaders["x-pm-telemetry-key"] = ingestKey;
  }

  try {
    const response = await fetch(normalizedEndpoint, {
      method: "POST",
      headers: requestHeaders,
      body: JSON.stringify({
        schema_version: TELEMETRY_SCHEMA_VERSION,
        events: dueEntries.map((entry) => entry.event),
      }),
      signal: AbortSignal.timeout(TELEMETRY_HTTP_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`telemetry_flush_http_${response.status}`);
    }
  } catch (error: unknown) {
    const retried = await markFailedEntriesInCurrentQueue(globalPmRoot, dueIds, attemptTime, retentionDays);
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
    return;
  }

  try {
    const remaining = await removeFlushedEntriesFromCurrentQueue(globalPmRoot, dueIds, retentionDays);
    await writeRuntimeState(globalPmRoot, {
      endpoint: normalizedEndpoint,
      queue_entries: remaining.length,
      last_attempted_flush_at: attemptTime,
      last_successful_flush_at: attemptTime,
      last_failed_flush_at: undefined,
      last_failed_flush_error: undefined,
    });
  /* c8 ignore start */
  } catch (error: unknown) {
    const errorMessage = (() => {
      if (error instanceof Error) {
        return sanitizeString(error.message, "redacted");
      }
      return "telemetry_flush_failed";
    })();
    const currentEntries = await readCurrentQueueEntries(globalPmRoot).catch(() => retainedEntries);
    await writeRuntimeState(globalPmRoot, {
      endpoint: normalizedEndpoint,
      queue_entries: currentEntries.length,
      last_attempted_flush_at: attemptTime,
      last_failed_flush_at: attemptTime,
      last_failed_flush_error: errorMessage,
    });
  }
  /* c8 ignore stop */
}

async function acquireTelemetryFlushLock(globalPmRoot: string): Promise<boolean> {
  const lockPath = flushLockPath(globalPmRoot);
  await mkdir(path.dirname(lockPath), { recursive: true });
  try {
    await mkdir(lockPath);
    return true;
  } catch (error: unknown) {
    if (typeof error !== "object" || error === null || !("code" in error) || (error as { code?: unknown }).code !== "EEXIST") {
      throw error;
    }
  }

  try {
    const lockStats = await stat(lockPath);
    if (Date.now() - lockStats.mtimeMs < TELEMETRY_FLUSH_LOCK_STALE_MS) {
      return false;
    }
    await rm(lockPath, { recursive: true, force: true });
    await mkdir(lockPath);
    return true;
  } catch {
    return false;
  }
}

function isFreshDirectoryLock(lockPath: string, staleMs: number): boolean {
  try {
    return Date.now() - statSync(lockPath).mtimeMs < staleMs;
  } catch {
    return false;
  }
}

function removeDirectoryLockBestEffort(lockPath: string): void {
  try {
    rmSync(lockPath, { recursive: true, force: true });
  } catch {
    // Flush scheduling is best effort and must never fail user commands.
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function createDirectoryLock(lockPath: string): boolean {
  try {
    mkdirSync(lockPath);
    return true;
  } catch (error: unknown) {
    const code = errorCode(error);
    if (code === "EEXIST") {
      return false;
    }
    if (code !== "ENOENT") {
      return false;
    }
  }

  /* c8 ignore start */
  try {
    mkdirSync(path.dirname(lockPath), { recursive: true });
    mkdirSync(lockPath);
    return true;
  } catch {
    return false;
  }
  /* c8 ignore stop */
}

function acquireTelemetryFlushSpawnGate(globalPmRoot: string): boolean {
  if (isFreshDirectoryLock(flushLockPath(globalPmRoot), TELEMETRY_FLUSH_LOCK_STALE_MS)) {
    return false;
  }

  const lockPath = flushSpawnLockPath(globalPmRoot);
  try {
    if (Date.now() - statSync(lockPath).mtimeMs < TELEMETRY_FLUSH_SPAWN_LOCK_STALE_MS) {
      return false;
    }
    removeDirectoryLockBestEffort(lockPath);
  } catch (error: unknown) {
    if (errorCode(error) !== "ENOENT") {
      return false;
    }
  }

  return createDirectoryLock(lockPath);
}

function releaseTelemetryFlushSpawnGate(globalPmRoot: string): void {
  removeDirectoryLockBestEffort(flushSpawnLockPath(globalPmRoot));
}

export const _testOnly = {
  acquireTelemetryFlushSpawnGate,
  acquireTelemetryFlushLock,
  buildAuthorContextPayloadFields,
  buildCommandErrorPayload,
  buildCommandFinishPayload,
  buildCommandStartPayload,
  buildOtelSpanRequest,
  createDirectoryLock,
  enqueuePendingOtelSpan,
  enqueueTelemetryEvent,
  errorCode,
  flushPendingOtelSpans,
  flushQueue,
  flushQueueWithProcessLock,
  flushTelemetryArtifacts,
  hashTelemetryErrorFingerprint,
  hashTelemetryValue,
  isEmailDomainCharacter,
  isEmailLocalCharacter,
  isExpiredPendingOtelSpan,
  isExpiredQueueEntry,
  isFreshDirectoryLock,
  isDueForRetry,
  isDueForRetryAt,
  isRetryableQueueRewriteError,
  looksLikeEmailToken,
  otelSpansQueuePath,
  parseBooleanTrueLike,
  parsePendingOtelSpanLines,
  prunePendingOtelSpans,
  reconcilePendingOtelSpansAfterFlush,
  retentionCutoffMs,
  resolveOtelTracesEndpoint,
  rewritePendingOtelSpans,
  normalizeForHash,
  normalizeCaptureLevel,
  normalizePmVersion,
  normalizeTelemetryErrorCategory,
  normalizeTelemetryErrorCode,
  normalizeTelemetryExitCode,
  parseQueueLines,
  pruneExpiredQueueEntries,
  readRuntimeState,
  readCurrentQueueEntries,
  releaseTelemetryFlushSpawnGate,
  removeFlushedEntriesFromCurrentQueue,
  removeDirectoryLockBestEffort,
  resolveTelemetrySourceContext,
  rewriteQueue,
  sanitizeCommandArgs,
  sanitizeStringMax,
  sanitizeStringRedacted,
  sanitizeValue,
  scheduleTelemetryFlush,
  shouldFlushInline,
  sleep,
  summarizeResult,
  telemetryFlushRunnerPath,
  withQueueMutation,
  flushLockPath,
  flushSpawnLockPath,
  runtimeStatePath,
  writeRuntimeState,
};

async function flushQueueWithProcessLock(globalPmRoot: string, endpoint: string, retentionDays: number): Promise<void> {
  const acquired = await acquireTelemetryFlushLock(globalPmRoot);
  releaseTelemetryFlushSpawnGate(globalPmRoot);
  if (!acquired) {
    return;
  }
  try {
    await flushTelemetryArtifacts(globalPmRoot, endpoint, retentionDays);
  } finally {
    try {
      await rm(flushLockPath(globalPmRoot), { recursive: true, force: true });
    } catch {
      // Best effort lock cleanup; stale locks are recovered by TTL checks.
    }
  }
}

function scheduleTelemetryFlush(globalPmRoot: string, endpoint: string, retentionDays: number): void {
  if (shouldFlushInline()) {
    const previousFlush = _lastFlushPromise;
    const nextFlush = flushTelemetryArtifacts(globalPmRoot, endpoint, retentionDays);
    _lastFlushPromise = Promise.allSettled([previousFlush, nextFlush]).then(() => {});
    return;
  }

  try {
    const acquiredSpawnGate = acquireTelemetryFlushSpawnGate(globalPmRoot);
    if (!acquiredSpawnGate) {
      return;
    }
    const child = spawn(process.execPath, [telemetryFlushRunnerPath()], {
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        PM_GLOBAL_PATH: globalPmRoot,
        [PM_TELEMETRY_FLUSH_CHILD_ENV]: "1",
      },
    });
    child.unref();
  } catch {
    releaseTelemetryFlushSpawnGate(globalPmRoot);
    // Flush scheduling is best effort and must not keep the CLI alive.
  }
}

/**
 * Implements flush telemetry queue now for the public runtime surface of this module.
 */
export async function flushTelemetryQueueNow(globalPmRoot = resolveGlobalPmRoot(process.cwd())): Promise<void> {
  if (telemetryDisabledByEnvironment()) {
    return;
  }
  try {
    const settings = await readSettings(globalPmRoot);
    if (!settings.telemetry.enabled) {
      return;
    }
    const { endpoint, retentionDays } = await ensureInstallationId(globalPmRoot);
    await flushQueueWithProcessLock(globalPmRoot, endpoint, retentionDays);
  } catch {
    // Telemetry workers are best effort and must never fail user commands.
  }
}

/**
 * Implements start telemetry command for the public runtime surface of this module.
 */
export async function startTelemetryCommand(context: TelemetryCommandContext): Promise<ActiveTelemetryCommand | null> {
  if (telemetryDisabledByEnvironment()) {
    return null;
  }
  if (
    context.command === "telemetry" &&
    context.args.some((token) => token.trim().toLowerCase() === "clear")
  ) {
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
    scheduleTelemetryFlush(globalPmRoot, endpoint, retentionDays);
    const commandTaxonomy = deriveTelemetryCommandTaxonomy(context.command);
    return {
      started_at: occurredAt,
      started_at_ms: Date.now(),
      command: context.command,
      command_taxonomy: commandTaxonomy,
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

/**
 * Implements finish telemetry command for the public runtime surface of this module.
 */
export async function finishTelemetryCommand(
  activeCommand: ActiveTelemetryCommand | null,
  outcome: TelemetryCommandOutcome,
): Promise<void> {
  if (!activeCommand) {
    return;
  }
  try {
    const finishedAt = nowIso();
    const durationMs = Math.max(0, Date.now() - activeCommand.started_at_ms);
    const normalizedErrorCode = normalizeTelemetryErrorCode(
      inferTelemetryErrorCode({
        ok: outcome.ok,
        errorCode: outcome.error_code,
        errorMessage: outcome.error,
        exitCode: outcome.exit_code,
      }),
    );
    const normalizedErrorCategory = normalizeTelemetryErrorCategory({
      ok: outcome.ok,
      errorCode: normalizedErrorCode,
      errorCategory: outcome.error_category,
    });
    const normalizedExitCode = normalizeTelemetryExitCode(outcome.exit_code, outcome.ok);
    const commandResolution =
      outcome.command_resolution ??
      deriveTelemetryCommandResolution({
        ok: outcome.ok,
        errorCode: normalizedErrorCode,
        errorCategory: normalizedErrorCategory,
      });
    const resolutionStage = outcome.resolution_stage ?? "execute";
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
        command: activeCommand.command,
        installationId: activeCommand.installation_id,
        commandTaxonomy: activeCommand.command_taxonomy,
        exitCode: normalizedExitCode,
        errorCode: normalizedErrorCode,
        errorCategory: normalizedErrorCategory,
        commandResolution,
        resolutionStage,
      }),
    };
    await enqueueTelemetryEvent(activeCommand.global_pm_root, event);
    const otelRequest = buildOtelSpanRequest(
      activeCommand,
      {
        ...outcome,
        exit_code: normalizedExitCode,
        error_code: normalizedErrorCode,
        error_category: normalizedErrorCategory,
      },
      finishedAt,
      durationMs,
    );
    if (otelRequest) {
      // Persist the span for the detached worker; never POST inline so the
      // foreground command exits promptly even if the traces endpoint is
      // unreachable (GH-209).
      await enqueuePendingOtelSpan(activeCommand.global_pm_root, otelRequest);
    }
    scheduleTelemetryFlush(activeCommand.global_pm_root, activeCommand.endpoint, activeCommand.retention_days);
  } catch {
    // Telemetry must never block command execution.
  }
}

/**
 * Implements emit telemetry error event for the public runtime surface of this module.
 */
export async function emitTelemetryErrorEvent(context: TelemetryErrorEventContext): Promise<void> {
  if (telemetryDisabledByEnvironment()) {
    return;
  }
  try {
    const globalPmRoot = resolveGlobalPmRoot(process.cwd());
    const settings = await readSettings(globalPmRoot);
    if (!settings.telemetry.enabled) {
      return;
    }
    const captureLevel = normalizeCaptureLevel(settings.telemetry.capture_level);
    const { installationId, endpoint, retentionDays } = await ensureInstallationId(globalPmRoot);
    const pmVersion = normalizePmVersion(context.pm_version);
    const sourceContext = resolveTelemetrySourceContext(context.global);
    const pmRootHash = hashWithInstallationId(installationId, context.pm_root);
    const cwdHash = hashWithInstallationId(installationId, process.cwd());
    const occurredAt = nowIso();
    const normalizedErrorCode =
      normalizeTelemetryErrorCode(
        inferTelemetryErrorCode({
          ok: false,
          errorCode: context.error_code,
          errorMessage: context.error_message,
          exitCode: context.exit_code,
        }),
      ) as string;
    const normalizedErrorCategory =
      context.error_category ?? resolveTelemetryErrorCategory(normalizedErrorCode);
    const normalizedExitCode = normalizeTelemetryExitCode(context.exit_code, false);
    const normalizedCommand = context.command.trim().length > 0 ? context.command : "<unknown>";
    const commandTaxonomy = deriveTelemetryCommandTaxonomy(normalizedCommand);
    const commandResolution =
      context.command_resolution ??
      deriveTelemetryCommandResolution({
        ok: false,
        errorCode: normalizedErrorCode,
        errorCategory: normalizedErrorCategory,
      });
    const resolutionStage = context.resolution_stage ?? "unknown";

    const event: TelemetryEvent = {
      schema_version: TELEMETRY_SCHEMA_VERSION,
      event_id: crypto.randomUUID(),
      event_type: "command_error",
      occurred_at: occurredAt,
      installation_id: installationId,
      session_id: PROCESS_SESSION_ID,
      command: sanitizeString(normalizedCommand, "redacted"),
      payload: buildCommandErrorPayload({
        captureLevel,
        pmVersion,
        sourceContext,
        command: normalizedCommand,
        commandTaxonomy,
        commandResolution,
        resolutionStage,
        args: context.args,
        options: context.options,
        pmRootHash,
        cwdHash,
        installationId,
        errorCode: normalizedErrorCode,
        errorCategory: normalizedErrorCategory,
        exitCode: normalizedExitCode,
        errorMessage: context.error_message,
      }),
    };
    await enqueueTelemetryEvent(globalPmRoot, event);
    scheduleTelemetryFlush(globalPmRoot, endpoint, retentionDays);
  } catch {
    // Telemetry must never block command execution.
  }
}
