/**
 * @module core/telemetry/policy
 *
 * Resolves process-wide telemetry consent before storage or network activity.
 * Diagnostics and capture share this policy so an opt-out cannot be bypassed
 * by a worker, prompt, or endpoint probe.
 */
import { createHash } from "node:crypto";

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
/** Supported explicit classifications for intentional telemetry delivery. */
export const PM_TELEMETRY_SOURCE_CONTEXT_VALUES = ["user", "automation", "test", "dogfood"] as const;
const SOURCE_CONTEXTS = new Set<string>(PM_TELEMETRY_SOURCE_CONTEXT_VALUES);

/** Resolve privacy-bounded execution attribution without consent, identity or network work. */
export function resolveTelemetrySourceAttribution(
  options: { json?: boolean; quiet?: boolean } = {},
  env: Readonly<Record<string, string | undefined>> = process.env,
  interactive = process.stdin.isTTY === true && process.stdout.isTTY === true,
): { source_context: typeof PM_TELEMETRY_SOURCE_CONTEXT_VALUES[number]; source_context_source: "env_override" | "inferred" | "env_override_rejected" } {
  const override = (env.PM_TELEMETRY_SOURCE_CONTEXT ?? "").trim().toLowerCase();
  const inferredTest = isTelemetryTestEnvironment(env);
  // Inside a test runner only `test` labels explicitly (GH-1735): an inherited non-test context
  // labels whoever exported it, not the test children that inherited it.
  if (SOURCE_CONTEXTS.has(override) && (!inferredTest || override === "test")) return {
    source_context: override as typeof PM_TELEMETRY_SOURCE_CONTEXT_VALUES[number],
    source_context_source: "env_override",
  };
  const source = override && !SOURCE_CONTEXTS.has(override) ? "env_override_rejected" : "inferred";
  if (inferredTest) return { source_context: "test", source_context_source: source };
  const automated = !interactive || telemetryEnvironmentFlag("CI", env) || options.json === true || options.quiet === true;
  return { source_context: automated ? "automation" : "user", source_context_source: source };
}

/** The environment variable that marks the process as running inside a test runner, or undefined. */
export function telemetryTestEnvironmentSignal(
  env: Readonly<Record<string, string | undefined>> = process.env,
): "VITEST" | "VITEST_WORKER_ID" | "NODE_TEST_CONTEXT" | "NODE_ENV" | undefined {
  if (typeof env.VITEST === "string") return "VITEST";
  if (typeof env.VITEST_WORKER_ID === "string") return "VITEST_WORKER_ID";
  if (typeof env.NODE_TEST_CONTEXT === "string") return "NODE_TEST_CONTEXT";
  return (env.NODE_ENV ?? "").trim().toLowerCase() === "test" ? "NODE_ENV" : undefined;
}

/** Share native and package test signals across consent, attribution and flush lifetime. */
export function isTelemetryTestEnvironment(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return telemetryTestEnvironmentSignal(env) !== undefined;
}
/** Fixed core reads eligible only after runtime ownership has been established. */
export const TELEMETRY_SAMPLEABLE_READS: ReadonlySet<string> = new Set([
  "stats", "ops stats", "list", "get", "next", "context", "activity", "aggregate",
]);

/** Resolve explicit read sampling only for core-only invocations with no write-capable extensions. */
export function resolveTelemetryReadSampleRate(
  command: string,
  noExtensions: boolean,
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const raw = env.PM_TELEMETRY_READ_SAMPLE_RATE?.trim();
  if (!raw || !noExtensions || !TELEMETRY_SAMPLEABLE_READS.has(command)) return 1;
  const rate = Number(raw);
  return Number.isFinite(rate) && rate > 0 && rate <= 1 ? rate : 1;
}

/** Read one telemetry boolean using the documented case-insensitive vocabulary. */
function telemetryEnvironmentFlag(
  key: string,
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return TRUE_VALUES.has((env[key] ?? "").trim().toLowerCase());
}

/**
 * Resolve the `PM_TELEMETRY_ENDPOINT` event-delivery override (GH-1660). Only an
 * absolute http(s) URL is used. Any other non-empty value is `invalid`, which
 * disables delivery instead of falling back to the configured endpoint.
 */
export function resolveTelemetryEndpointOverride(
  env: Readonly<Record<string, string | undefined>> = process.env,
): { endpoint: string | null; invalid: boolean } {
  const raw = (env.PM_TELEMETRY_ENDPOINT ?? "").trim();
  const protocol = URL.canParse(raw) ? new URL(raw).protocol : "";
  if (protocol === "http:" || protocol === "https:") return { endpoint: raw, invalid: false };
  return { endpoint: null, invalid: raw.length > 0 };
}

/**
 * The runtime file holding event-queue or delivery state for an endpoint
 * override (GH-1660). Override events and their state live in files of their
 * own, keyed by the override, which no flush without the same override and no
 * older client reads, so they never reach the configured endpoint.
 */
export function telemetryRuntimeFileName(
  base: "events.jsonl" | "state.json",
  override: string | null = resolveTelemetryEndpointOverride().endpoint,
): string {
  if (override === null) return base;
  const key = createHash("sha256").update(override).digest("hex").slice(0, 16);
  return base.replace(/\.(jsonl|json)$/u, `.${key}.$1`);
}

/** Remove `user:password@` from every URL-like authority in a text, such as a transport error message. */
export function stripUrlCredentials(text: string): string {
  return text.replaceAll(/(\/\/)[^/?#\s]*@/gu, "$1");
}

/** An endpoint as diagnostics may show it: credentials, query and fragment removed, also from text that is not a valid URL. */
export function redactTelemetryEndpoint(rawEndpoint: string): string {
  const trimmed = rawEndpoint.trim();
  if (!URL.canParse(trimmed)) return stripUrlCredentials(trimmed).replace(/[?#].*$/su, "");
  const parsed = new URL(trimmed);
  parsed.username = "";
  parsed.password = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

/** Redact every URL in free text, such as a transport error, the way redactTelemetryEndpoint redacts the endpoint: no credentials, query or fragment (GH-1660). */
export function redactUrlsInText(text: string): string {
  return text.replaceAll(/\b[a-z][a-z\d+.-]*:\/\/[^\s"'<>]+/giu, (url) => redactTelemetryEndpoint(url));
}

/** The endpoint events go to: the `PM_TELEMETRY_ENDPOINT` override, else the configured one. */
export function effectiveTelemetryEndpoint(
  configured: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return resolveTelemetryEndpointOverride(env).endpoint ?? configured;
}

/** The environment input that decided process telemetry consent (`env:<VARIABLE>`). */
export type TelemetryEnvironmentDecision =
  | "env:DO_NOT_TRACK"
  | "env:PM_TELEMETRY_DISABLED"
  | "env:PM_NO_TELEMETRY"
  | "env:PM_TELEMETRY_ENDPOINT"
  | "env:VITEST"
  | "env:VITEST_WORKER_ID"
  | "env:NODE_TEST_CONTEXT"
  | "env:NODE_ENV"
  | "env:PM_TELEMETRY_SOURCE_CONTEXT"
  | "env:PM_TELEMETRY_SEND_TEST_EVENTS";

/** The first hard opt-out set in the environment, in precedence order. */
function hardTelemetryOptOut(
  env: Readonly<Record<string, string | undefined>>,
  endpointInvalid: boolean,
): TelemetryEnvironmentDecision | undefined {
  if (telemetryEnvironmentFlag("DO_NOT_TRACK", env)) return "env:DO_NOT_TRACK";
  if (telemetryEnvironmentFlag("PM_TELEMETRY_DISABLED", env)) return "env:PM_TELEMETRY_DISABLED";
  if (telemetryEnvironmentFlag("PM_NO_TELEMETRY", env)) return "env:PM_NO_TELEMETRY";
  return endpointInvalid ? "env:PM_TELEMETRY_ENDPOINT" : undefined;
}

/**
 * Explain process opt-outs and the event endpoint override without reading
 * settings or creating installation identity. Inside a detected test runner
 * only an explicit test opt-in (`PM_TELEMETRY_SOURCE_CONTEXT=test` or
 * `PM_TELEMETRY_SEND_TEST_EVENTS`) re-enables telemetry: an inherited
 * `automation`, `user` or `dogfood` context labels whoever exported it, not
 * the test children that inherited it (GH-1735). `decided_by` names the input
 * that settled consent: a hard opt-out, the test-runner signal that
 * suppressed it, or the test opt-in that allowed it; null when no environment
 * input decides and settings do.
 */
export function resolveTelemetryEnvironmentPolicy(
  env: Readonly<Record<string, string | undefined>> = process.env,
): {
  telemetry_disabled: boolean;
  do_not_track: boolean;
  test_suppressed: boolean;
  endpoint_override: string | null;
  endpoint_override_invalid: boolean;
  decided_by: TelemetryEnvironmentDecision | null;
} {
  const endpoint = resolveTelemetryEndpointOverride(env);
  const override = (env.PM_TELEMETRY_SOURCE_CONTEXT ?? "").trim().toLowerCase();
  const testSignal = telemetryTestEnvironmentSignal(env);
  const testOptIn: TelemetryEnvironmentDecision | undefined = override === "test"
    ? "env:PM_TELEMETRY_SOURCE_CONTEXT"
    : telemetryEnvironmentFlag("PM_TELEMETRY_SEND_TEST_EVENTS", env) ? "env:PM_TELEMETRY_SEND_TEST_EVENTS" : undefined;
  const testSuppressed = testSignal !== undefined && testOptIn === undefined;
  const optOut = hardTelemetryOptOut(env, endpoint.invalid);
  const testDecision = testSignal === undefined ? undefined : testOptIn ?? (`env:${testSignal}` as const);
  return {
    telemetry_disabled: optOut !== undefined || testSuppressed,
    do_not_track: optOut === "env:DO_NOT_TRACK",
    test_suppressed: testSuppressed,
    endpoint_override: endpoint.endpoint === null ? null : redactTelemetryEndpoint(endpoint.endpoint),
    endpoint_override_invalid: endpoint.invalid,
    decided_by: optOut ?? testDecision ?? null,
  };
}
