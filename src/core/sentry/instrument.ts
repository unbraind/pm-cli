/**
 * @module core/sentry/instrument
 *
 * Integrates Sentry instrumentation and release diagnostics for Instrument.
 */
import * as SentryModule from "@sentry/node";
import type { NodeOptions } from "@sentry/node";
import { resolvePmCliVersion } from "../packages/root.js";

const OPT_OUT_VALUES = new Set(["1", "true", "yes", "on"]);

function isSentryDisabled(): boolean {
  if (
    OPT_OUT_VALUES.has(
      (process.env.PM_SENTRY_DISABLED ?? "").trim().toLowerCase(),
    )
  )
    return true;
  if (
    OPT_OUT_VALUES.has(
      (process.env.PM_TELEMETRY_DISABLED ?? "").trim().toLowerCase(),
    )
  )
    return true;
  if (process.env.VITEST || process.env.VITEST_WORKER_ID) return true;
  return false;
}

const SENSITIVE_KEY_PATTERN =
  /(?:token|secret|password|passwd|api[_-]?key|apikey|authorization|cookie|credentials|bearer|dsn)/i;

const INLINE_SENSITIVE_ASSIGNMENT_RE = new RegExp(
  `\\b(${SENSITIVE_KEY_PATTERN.source})\\s*[:=]\\s*([^\\s,;]+)`,
  "giu",
);
const ABSOLUTE_PATH_TOKEN_RE = /(^|[\s"'`(=])\/(?:[^\s"'`),;]+)/g;
const FILE_URL_PATH_RE = /file:\/\/\/?[^\s"'`),;]+/giu;
const WINDOWS_PATH_TOKEN_RE = /\b[A-Za-z]:\\[^\s"'`),;]+/g;
const PRIVATE_IP_RE =
  /\b(?:10\.(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.(?:25[0-5]|2[0-4]\d|[01]?\d?\d)|172\.(?:1[6-9]|2\d|3[01])\.(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.(?:25[0-5]|2[0-4]\d|[01]?\d?\d)|192\.168\.(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.(?:25[0-5]|2[0-4]\d|[01]?\d?\d))\b/g;
const PATH_FIELD_KEY_PATTERN =
  /(?:^|[_-])(path|filename|file|module|cwd|dir|directory|location|source|script)s?$/i;
/**
 * Upper bound on {@link KNOWN_NOISY_CONSOLE_MESSAGE_PATTERNS}. Enforced by a
 * governance test so the allowlist cannot silently accumulate stale filters.
 */
const MAX_KNOWN_NOISY_CONSOLE_MESSAGE_PATTERNS = 15;
/**
 * Substrings (lowercased) of console output that first-party example
 * extensions emit at activation. Matching events/breadcrumbs are confirmed
 * false-positives and are dropped before they reach Sentry.
 *
 * Policy: add a pattern only when a marketplace-shipped extension generates
 * confirmed false-positive console captures, and remove it when that extension
 * leaves the ecosystem. The list is capped at
 * {@link MAX_KNOWN_NOISY_CONSOLE_MESSAGE_PATTERNS} to keep the filter bounded
 * and prevent stale entries from masking genuine errors.
 */
const KNOWN_NOISY_CONSOLE_MESSAGE_PATTERNS = [
  "[starter-extension] activating",
  "[starter-extension] all 8 capabilities registered.",
  "[starter-extension] commands:",
  "[starter] preflight check for workspace",
  "[starter] output_format service override active",
  "[pm-ext-ts-starter] activating",
  "[pm-ext-ts-starter] all capabilities registered.",
  "run `pm init` first to initialise a pm workspace",
] as const;

function looksLikeFilesystemPath(value: string): boolean {
  const normalized = value.trim();
  if (normalized.length === 0) {
    return false;
  }
  if (normalized.startsWith("/") || normalized.startsWith("file://")) {
    return true;
  }
  if (/^[A-Za-z]:\\/.test(normalized) || normalized.startsWith("\\\\")) {
    return true;
  }
  return normalized.includes("/home/");
}

function scrubString(value: string, keyHint?: string): string {
  if (
    keyHint &&
    PATH_FIELD_KEY_PATTERN.test(keyHint) &&
    looksLikeFilesystemPath(value)
  ) {
    return "[scrubbed_path]";
  }
  const scrubbed = value
    .replaceAll(
      INLINE_SENSITIVE_ASSIGNMENT_RE,
      (_m, key: string) => `${key}=[scrubbed]`,
    )
    .replaceAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, "[scrubbed_email]")
    .replaceAll(/bearer\s+[a-z0-9._=-]+/giu, "bearer [scrubbed]")
    .replaceAll(/sntr[ysu]_[A-Za-z0-9_-]+/g, "[scrubbed_sentry_token]")
    .replaceAll(PRIVATE_IP_RE, "[scrubbed_ip]")
    .replaceAll(FILE_URL_PATH_RE, "[scrubbed_path]")
    .replaceAll(WINDOWS_PATH_TOKEN_RE, "[scrubbed_path]")
    .replaceAll(
      ABSOLUTE_PATH_TOKEN_RE,
      (_match: string, prefix: string) => `${prefix}[scrubbed_path]`,
    );
  if (looksLikeFilesystemPath(scrubbed)) {
    return "[scrubbed_path]";
  }
  return scrubbed;
}

function scrubEventData(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      result[key] = "[scrubbed]";
    } else if (typeof value === "string") {
      result[key] = scrubString(value, key);
    } else if (Array.isArray(value)) {
      result[key] = value.map((entry) => {
        if (typeof entry === "string") {
          return scrubString(entry, key);
        }
        if (entry && typeof entry === "object") {
          return scrubEventData(entry as Record<string, unknown>);
        }
        return entry;
      });
    } else if (value && typeof value === "object") {
      result[key] = scrubEventData(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function scrubStackFrame(frame: Record<string, unknown>): void {
  for (const key of ["filename", "absPath", "abs_path", "module"]) {
    const rawValue = frame[key];
    if (typeof rawValue === "string") {
      frame[key] = scrubString(rawValue, key);
    }
  }
  const contextLine = frame.context_line;
  if (typeof contextLine === "string") {
    frame.context_line = scrubString(contextLine, "context_line");
  }
  for (const key of ["pre_context", "post_context"]) {
    const context = frame[key];
    if (!Array.isArray(context)) {
      continue;
    }
    frame[key] = context.map((entry) =>
      typeof entry === "string" ? scrubString(entry, key) : entry,
    );
  }
  if (frame.vars && typeof frame.vars === "object") {
    frame.vars = scrubEventData(frame.vars as Record<string, unknown>);
  }
  if (frame.data && typeof frame.data === "object") {
    frame.data = scrubEventData(frame.data as Record<string, unknown>);
  }
}

type SentryLike = typeof SentryModule;

let _sentry: SentryLike | undefined;
let _initDone = false;

const PM_CLI_SENTRY_DSN =
  "https://bf7ad2ec76c0051c2ee94e48e8bd6868@o4510603477712896.ingest.de.sentry.io/4511316775338064";

function hasPmCliErrorPrefix(value: string): boolean {
  return /^\s*PmCliError:/.test(value);
}

function isKnownNoisyConsoleMessage(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0) {
    return false;
  }
  return KNOWN_NOISY_CONSOLE_MESSAGE_PATTERNS.some((pattern) =>
    normalized.includes(pattern),
  );
}

function isKnownNoisyConsoleEvent(event: {
  logger?: string;
  message?: string;
  exception?: { values?: Array<{ value?: string }> };
}): boolean {
  if (event.logger !== "console") {
    return false;
  }
  if (
    typeof event.message === "string" &&
    isKnownNoisyConsoleMessage(event.message)
  ) {
    return true;
  }
  return (
    Array.isArray(event.exception?.values) &&
    event.exception.values.some(
      (entry) =>
        typeof entry.value === "string" &&
        isKnownNoisyConsoleMessage(entry.value),
    )
  );
}

function isExpectedCliErrorEvent(event: {
  exception?: { values?: Array<{ type?: string; value?: string }> };
  message?: string;
  extra?: Record<string, unknown>;
  logger?: string;
}): boolean {
  if (event.exception?.values?.some((ex) => ex.type === "PmCliError"))
    return true;

  if (
    event.exception?.values?.some(
      (ex) => typeof ex.value === "string" && hasPmCliErrorPrefix(ex.value),
    )
  )
    return true;

  if (
    event.logger === "console" &&
    typeof event.message === "string" &&
    hasPmCliErrorPrefix(event.message)
  )
    return true;

  return false;
}

function isPmCliErrorBreadcrumb(breadcrumb: {
  category?: string;
  message?: string;
}): boolean {
  return (
    breadcrumb.category === "console" &&
    typeof breadcrumb.message === "string" &&
    hasPmCliErrorPrefix(breadcrumb.message)
  );
}

function isKnownNoisyConsoleBreadcrumb(breadcrumb: {
  category?: string;
  message?: string;
}): boolean {
  return (
    breadcrumb.category === "console" &&
    typeof breadcrumb.message === "string" &&
    isKnownNoisyConsoleMessage(breadcrumb.message)
  );
}

function resolveCliVersion(): string {
  return resolvePmCliVersion(import.meta.url, ["../../.."]) ?? "0.0.0";
}

function resolveEnvironment(): string {
  const explicit = process.env.SENTRY_ENVIRONMENT?.trim();
  if (explicit && explicit.length > 0) return explicit;
  if (
    process.env.VITEST ||
    process.env.VITEST_WORKER_ID ||
    process.env.NODE_ENV === "test"
  )
    return "test";
  if (process.env.CI) return "ci";
  return "production";
}

const DEFAULT_TRACES_SAMPLE_RATE = 0.2;

/**
 * Resolves the Sentry performance-tracing sample rate, honouring the standard
 * `SENTRY_TRACES_SAMPLE_RATE` env var when it parses to a fraction in `[0, 1]`.
 *
 * The default (20%) keeps span volume modest for a low-frequency developer CLI
 * while leaving an operational lever for full-trace performance debugging
 * (`SENTRY_TRACES_SAMPLE_RATE=1`) or fully disabling traces (`=0`). Unset,
 * non-numeric, or out-of-range values fall back to the default with no
 * behaviour change for existing installs.
 */
function resolveTracesSampleRate(): number {
  const raw = process.env.SENTRY_TRACES_SAMPLE_RATE?.trim();
  if (!raw) return DEFAULT_TRACES_SAMPLE_RATE;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    return DEFAULT_TRACES_SAMPLE_RATE;
  }
  return parsed;
}

function scrubSentryExceptionValues(event: {
  exception?: {
    values?: Array<{ value?: string; stacktrace?: { frames?: unknown[] } }>;
  };
}): void {
  if (!event.exception?.values) {
    return;
  }
  for (const exception of event.exception.values) {
    if (exception.value) {
      exception.value = scrubString(exception.value, "value");
    }
    if (exception.stacktrace?.frames) {
      for (const frame of exception.stacktrace.frames) {
        scrubStackFrame(frame as Record<string, unknown>);
      }
    }
  }
}

function scrubSentryBreadcrumbs(event: {
  breadcrumbs?: Array<{ message?: string; data?: unknown }>;
}): void {
  if (!event.breadcrumbs) {
    return;
  }
  for (const breadcrumb of event.breadcrumbs) {
    if (breadcrumb.message) {
      breadcrumb.message = scrubString(breadcrumb.message);
    }
    if (breadcrumb.data && typeof breadcrumb.data === "object") {
      breadcrumb.data = scrubEventData(
        breadcrumb.data as Record<string, unknown>,
      );
    }
  }
}

function scrubSentryContexts(event: {
  contexts?: Record<string, unknown>;
}): void {
  if (!event.contexts) {
    return;
  }
  for (const [ctxKey, ctx] of Object.entries(event.contexts)) {
    if (ctx && typeof ctx === "object") {
      event.contexts[ctxKey] = scrubEventData(ctx as Record<string, unknown>);
    }
  }
}

function scrubSentryRecordField(event: object, key: string): void {
  const target = event as Record<string, unknown>;
  const value = target[key];
  if (value && typeof value === "object") {
    target[key] = scrubEventData(value as Record<string, unknown>);
  }
}

const beforeSend: NonNullable<NodeOptions["beforeSend"]> = (event) => {
  if (isExpectedCliErrorEvent(event) || isKnownNoisyConsoleEvent(event)) return null;
  if (event.message) event.message = scrubString(event.message, "message");
  if (event.transaction) event.transaction = scrubString(event.transaction, "transaction");
  scrubSentryExceptionValues(event);
  scrubSentryBreadcrumbs(event);
  scrubSentryRecordField(event, "extra");
  scrubSentryContexts(event);
  for (const key of ["request", "user", "tags"]) scrubSentryRecordField(event, key);
  return event;
};

const beforeSendTransaction: NonNullable<NodeOptions["beforeSendTransaction"]> = (event) => {
  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs.filter(
      (breadcrumb) => !isPmCliErrorBreadcrumb(breadcrumb) && !isKnownNoisyConsoleBreadcrumb(breadcrumb),
    );
    scrubSentryBreadcrumbs(event);
  }
  scrubSentryContexts(event);
  return event;
};

const beforeBreadcrumb: NonNullable<NodeOptions["beforeBreadcrumb"]> = (breadcrumb) => {
  if (isPmCliErrorBreadcrumb(breadcrumb) || isKnownNoisyConsoleBreadcrumb(breadcrumb)) return null;
  if (breadcrumb.message) breadcrumb.message = scrubString(breadcrumb.message, "message");
  if (breadcrumb.data && typeof breadcrumb.data === "object") {
    breadcrumb.data = scrubEventData(breadcrumb.data as Record<string, unknown>);
  }
  return breadcrumb;
};

/** Implements ensure sentry init for the public runtime surface of this module. */
export async function ensureSentryInit(): Promise<SentryLike | undefined> {
  if (_initDone) return _sentry;
  _initDone = true;

  if (isSentryDisabled()) return undefined;

  _sentry = SentryModule;

  const dsn = process.env.SENTRY_DSN?.trim() || PM_CLI_SENTRY_DSN;
  const release = resolveCliVersion();

  SentryModule.init({
    dsn,
    release: `pm-cli@${release}`,
    environment: resolveEnvironment(),

    tracesSampleRate: resolveTracesSampleRate(),
    enableLogs: true,
    attachStacktrace: true,
    normalizeDepth: 6,
    shutdownTimeout: 3000,
    sendDefaultPii: false,
    serverName: undefined,

    integrations: [
      SentryModule.extraErrorDataIntegration({ depth: 4 }),
      SentryModule.captureConsoleIntegration({ levels: ["warn", "error"] }),
    ],

    initialScope: {
      tags: {
        "cli.name": "pm-cli",
        "cli.version": release,
        "runtime.node": process.version,
        "runtime.platform": process.platform,
        "runtime.arch": process.arch,
      },
    },

    beforeSend,
    beforeSendTransaction,
    beforeBreadcrumb,
  });

  return SentryModule;
}

/** Implements get sentry for the public runtime surface of this module. */
export function getSentry(): SentryLike | undefined {
  return _sentry;
}

/** Public contract for test only, shared by SDK and presentation-layer consumers. */
export const _testOnly = {
  isExpectedCliErrorEvent,
  isKnownNoisyConsoleEvent,
  isPmCliErrorBreadcrumb,
  isKnownNoisyConsoleBreadcrumb,
  scrubString,
  scrubEventData,
  resolveTracesSampleRate,
  KNOWN_NOISY_CONSOLE_MESSAGE_PATTERNS,
  MAX_KNOWN_NOISY_CONSOLE_MESSAGE_PATTERNS,
  resetSentryStateForTests() {
    _sentry = undefined;
    _initDone = false;
  },
};
