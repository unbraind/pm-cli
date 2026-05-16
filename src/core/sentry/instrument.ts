import fs from "node:fs";
import path from "node:path";
import { resolvePmPackageRootFromModule } from "../packages/root.js";

const OPT_OUT_VALUES = new Set(["1", "true", "yes", "on"]);

function isSentryDisabled(): boolean {
  if (OPT_OUT_VALUES.has((process.env.PM_SENTRY_DISABLED ?? "").trim().toLowerCase())) return true;
  if (OPT_OUT_VALUES.has((process.env.PM_TELEMETRY_DISABLED ?? "").trim().toLowerCase())) return true;
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
const PATH_FIELD_KEY_PATTERN = /(?:^|[_-])(path|filename|file|module|cwd|dir|directory|location|source|script)s?$/i;
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
  if (keyHint && PATH_FIELD_KEY_PATTERN.test(keyHint) && looksLikeFilesystemPath(value)) {
    return "[scrubbed_path]";
  }
  const scrubbed = value
    .replaceAll(INLINE_SENSITIVE_ASSIGNMENT_RE, (_m, key: string) => `${key}=[scrubbed]`)
    .replaceAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, "[scrubbed_email]")
    .replaceAll(/bearer\s+[a-z0-9._=-]+/giu, "bearer [scrubbed]")
    .replaceAll(/sntr[ysu]_[A-Za-z0-9_-]+/g, "[scrubbed_sentry_token]")
    .replaceAll(PRIVATE_IP_RE, "[scrubbed_ip]")
    .replaceAll(FILE_URL_PATH_RE, "[scrubbed_path]")
    .replaceAll(WINDOWS_PATH_TOKEN_RE, "[scrubbed_path]")
    .replaceAll(ABSOLUTE_PATH_TOKEN_RE, (_match: string, prefix: string) => `${prefix}[scrubbed_path]`);
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
    frame[key] = context.map((entry) => (typeof entry === "string" ? scrubString(entry, key) : entry));
  }
  if (frame.vars && typeof frame.vars === "object") {
    frame.vars = scrubEventData(frame.vars as Record<string, unknown>);
  }
  if (frame.data && typeof frame.data === "object") {
    frame.data = scrubEventData(frame.data as Record<string, unknown>);
  }
}

type SentryLike = typeof import("@sentry/node");

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
  return KNOWN_NOISY_CONSOLE_MESSAGE_PATTERNS.some((pattern) => normalized.includes(pattern));
}

function isKnownNoisyConsoleEvent(event: {
  logger?: string;
  message?: string;
  exception?: { values?: Array<{ value?: string }> };
}): boolean {
  if (event.logger !== "console") {
    return false;
  }
  if (typeof event.message === "string" && isKnownNoisyConsoleMessage(event.message)) {
    return true;
  }
  return (
    Array.isArray(event.exception?.values) &&
    event.exception.values.some((entry) => typeof entry.value === "string" && isKnownNoisyConsoleMessage(entry.value))
  );
}

function isExpectedCliErrorEvent(event: {
  exception?: { values?: Array<{ type?: string; value?: string }> };
  message?: string;
  extra?: Record<string, unknown>;
  logger?: string;
}): boolean {
  if (event.exception?.values?.some((ex) => ex.type === "PmCliError")) return true;

  if (event.exception?.values?.some((ex) => typeof ex.value === "string" && hasPmCliErrorPrefix(ex.value)))
    return true;

  if (event.logger === "console" && typeof event.message === "string" && hasPmCliErrorPrefix(event.message))
    return true;

  return false;
}

function isPmCliErrorBreadcrumb(breadcrumb: { category?: string; message?: string }): boolean {
  return (
    breadcrumb.category === "console" &&
    typeof breadcrumb.message === "string" &&
    hasPmCliErrorPrefix(breadcrumb.message)
  );
}

function isKnownNoisyConsoleBreadcrumb(breadcrumb: { category?: string; message?: string }): boolean {
  return breadcrumb.category === "console" && typeof breadcrumb.message === "string" && isKnownNoisyConsoleMessage(breadcrumb.message);
}

function resolveCliVersion(): string {
  try {
    const candidate = path.join(resolvePmPackageRootFromModule(import.meta.url, ["../../.."]), "package.json");
    if (fs.existsSync(candidate)) {
      const parsed = JSON.parse(fs.readFileSync(candidate, "utf8")) as { version?: string };
      if (typeof parsed.version === "string") return parsed.version;
    }
  } catch {
    // Version resolution must never block startup.
  }
  return "0.0.0";
}

function resolveEnvironment(): string {
  const explicit = process.env.SENTRY_ENVIRONMENT?.trim();
  if (explicit && explicit.length > 0) return explicit;
  if (process.env.VITEST || process.env.VITEST_WORKER_ID || process.env.NODE_ENV === "test") return "test";
  if (process.env.CI) return "ci";
  return "production";
}

export async function ensureSentryInit(): Promise<SentryLike | undefined> {
  if (_initDone) return _sentry;
  _initDone = true;

  if (isSentryDisabled()) return undefined;

  const SentryModule = await import("@sentry/node");
  _sentry = SentryModule;

  const dsn = process.env.SENTRY_DSN?.trim() || PM_CLI_SENTRY_DSN;
  const release = resolveCliVersion();

  SentryModule.init({
    dsn,
    release: `pm-cli@${release}`,
    environment: resolveEnvironment(),

    tracesSampleRate: 0.2,
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

    beforeSend(event) {
      if (isExpectedCliErrorEvent(event) || isKnownNoisyConsoleEvent(event)) {
        return null;
      }
      if (event.message) {
        event.message = scrubString(event.message, "message");
      }
      if (event.transaction) {
        event.transaction = scrubString(event.transaction, "transaction");
      }

      if (event.exception?.values) {
        for (const exception of event.exception.values) {
          if (exception.value) {
            exception.value = scrubString(exception.value, "value");
          }
          if (exception.stacktrace?.frames) {
            for (const frame of exception.stacktrace.frames) {
              scrubStackFrame(frame as unknown as Record<string, unknown>);
            }
          }
        }
      }

      if (event.breadcrumbs) {
        for (const breadcrumb of event.breadcrumbs) {
          if (breadcrumb.message) {
            breadcrumb.message = scrubString(breadcrumb.message);
          }
          if (breadcrumb.data && typeof breadcrumb.data === "object") {
            breadcrumb.data = scrubEventData(breadcrumb.data as Record<string, unknown>);
          }
        }
      }

      if (event.extra && typeof event.extra === "object") {
        event.extra = scrubEventData(event.extra as Record<string, unknown>);
      }

      if (event.contexts) {
        for (const [ctxKey, ctx] of Object.entries(event.contexts)) {
          if (ctx && typeof ctx === "object") {
            event.contexts![ctxKey] = scrubEventData(ctx as Record<string, unknown>);
          }
        }
      }
      if (event.request && typeof event.request === "object") {
        event.request = scrubEventData(event.request as Record<string, unknown>) as typeof event.request;
      }
      if (event.user && typeof event.user === "object") {
        event.user = scrubEventData(event.user as Record<string, unknown>) as typeof event.user;
      }
      if (event.tags && typeof event.tags === "object") {
        event.tags = scrubEventData(event.tags as Record<string, unknown>) as typeof event.tags;
      }

      return event;
    },

    beforeSendTransaction(event) {
      if (event.breadcrumbs) {
        event.breadcrumbs = event.breadcrumbs.filter(
          (bc) => !isPmCliErrorBreadcrumb(bc) && !isKnownNoisyConsoleBreadcrumb(bc),
        );
        for (const breadcrumb of event.breadcrumbs) {
          if (breadcrumb.message) {
            breadcrumb.message = scrubString(breadcrumb.message, "message");
          }
          if (breadcrumb.data && typeof breadcrumb.data === "object") {
            breadcrumb.data = scrubEventData(breadcrumb.data as Record<string, unknown>);
          }
        }
      }
      if (event.contexts) {
        for (const [ctxKey, ctx] of Object.entries(event.contexts)) {
          if (ctx && typeof ctx === "object") {
            event.contexts![ctxKey] = scrubEventData(ctx as Record<string, unknown>);
          }
        }
      }
      return event;
    },

    beforeBreadcrumb(breadcrumb) {
      if (isPmCliErrorBreadcrumb(breadcrumb) || isKnownNoisyConsoleBreadcrumb(breadcrumb)) {
        return null;
      }
      if (breadcrumb.message) {
        breadcrumb.message = scrubString(breadcrumb.message, "message");
      }
      if (breadcrumb.data && typeof breadcrumb.data === "object") {
        breadcrumb.data = scrubEventData(breadcrumb.data as Record<string, unknown>);
      }
      return breadcrumb;
    },
  });

  return SentryModule;
}

export function getSentry(): SentryLike | undefined {
  return _sentry;
}

export const _testOnly = {
  isExpectedCliErrorEvent,
  isKnownNoisyConsoleEvent,
  isPmCliErrorBreadcrumb,
  isKnownNoisyConsoleBreadcrumb,
  scrubString,
  scrubEventData,
};
