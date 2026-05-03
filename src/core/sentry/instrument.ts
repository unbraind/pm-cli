import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

function scrubString(value: string): string {
  return value
    .replaceAll(INLINE_SENSITIVE_ASSIGNMENT_RE, (_m, key: string) => `${key}=[scrubbed]`)
    .replaceAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, "[scrubbed_email]")
    .replaceAll(/bearer\s+[a-z0-9._=-]+/giu, "bearer [scrubbed]")
    .replaceAll(/sntr[ysu]_[A-Za-z0-9_-]+/g, "[scrubbed_sentry_token]");
}

function scrubEventData(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      result[key] = "[scrubbed]";
    } else if (typeof value === "string") {
      result[key] = scrubString(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

type SentryLike = typeof import("@sentry/node");

let _sentry: SentryLike | undefined;
let _initDone = false;

const PM_CLI_SENTRY_DSN =
  "https://bf7ad2ec76c0051c2ee94e48e8bd6868@o4510603477712896.ingest.de.sentry.io/4511316775338064";

function hasPmCliErrorPrefix(value: string): boolean {
  return /^\s*PmCliError:/.test(value);
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

function resolveCliVersion(): string {
  try {
    const thisFile = fileURLToPath(import.meta.url);
    const candidates = [
      path.resolve(thisFile, "../../../../package.json"),
      path.resolve(thisFile, "../../../package.json"),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        const parsed = JSON.parse(fs.readFileSync(candidate, "utf8")) as { version?: string };
        if (typeof parsed.version === "string") return parsed.version;
      }
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
      if (isExpectedCliErrorEvent(event)) {
        return null;
      }

      if (event.exception?.values) {
        for (const exception of event.exception.values) {
          if (exception.value) {
            exception.value = scrubString(exception.value);
          }
          if (exception.stacktrace?.frames) {
            for (const frame of exception.stacktrace.frames) {
              if (frame.vars) {
                frame.vars = scrubEventData(frame.vars as Record<string, unknown>);
              }
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

      return event;
    },

    beforeSendTransaction(event) {
      if (event.breadcrumbs) {
        event.breadcrumbs = event.breadcrumbs.filter((bc) => !isPmCliErrorBreadcrumb(bc));
        for (const breadcrumb of event.breadcrumbs) {
          if (breadcrumb.message) {
            breadcrumb.message = scrubString(breadcrumb.message);
          }
        }
      }
      return event;
    },

    beforeBreadcrumb(breadcrumb) {
      if (isPmCliErrorBreadcrumb(breadcrumb)) {
        return null;
      }
      if (breadcrumb.message) {
        breadcrumb.message = scrubString(breadcrumb.message);
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
  isPmCliErrorBreadcrumb,
};
