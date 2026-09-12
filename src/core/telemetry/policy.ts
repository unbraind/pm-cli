/**
 * @module core/telemetry/policy
 *
 * Resolves process-wide telemetry consent before storage or network activity.
 * Diagnostics and capture share this policy so an opt-out cannot be bypassed
 * by a worker, prompt, or endpoint probe.
 */
const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
/** Supported explicit classifications for intentional telemetry delivery. */
export const PM_TELEMETRY_SOURCE_CONTEXT_VALUES = ["user", "automation", "test", "dogfood"] as const;
const SOURCE_CONTEXTS = new Set<string>(PM_TELEMETRY_SOURCE_CONTEXT_VALUES);
const SAMPLEABLE_READS = new Set([
  "stats", "ops stats", "list", "get", "next", "context", "activity", "aggregate",
]);

/** Resolve explicit read sampling only for core-only invocations with no write-capable extensions. */
export function resolveTelemetryReadSampleRate(
  command: string,
  noExtensions: boolean,
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const raw = env.PM_TELEMETRY_READ_SAMPLE_RATE?.trim();
  if (!raw || !noExtensions || !SAMPLEABLE_READS.has(command)) return 1;
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

/** Explain process opt-outs without reading settings or creating installation identity. */
export function resolveTelemetryEnvironmentPolicy(
  env: Readonly<Record<string, string | undefined>> = process.env,
): { telemetry_disabled: boolean; do_not_track: boolean; test_suppressed: boolean } {
  const doNotTrack = telemetryEnvironmentFlag("DO_NOT_TRACK", env);
  const override = (env.PM_TELEMETRY_SOURCE_CONTEXT ?? "").trim().toLowerCase();
  const inferredTest = typeof env.VITEST === "string" ||
    typeof env.VITEST_WORKER_ID === "string" ||
    (env.NODE_ENV ?? "").trim().toLowerCase() === "test";
  const testSuppressed = inferredTest && !SOURCE_CONTEXTS.has(override) &&
    !telemetryEnvironmentFlag("PM_TELEMETRY_SEND_TEST_EVENTS", env);
  return {
    telemetry_disabled: doNotTrack || testSuppressed ||
      telemetryEnvironmentFlag("PM_TELEMETRY_DISABLED", env) ||
      telemetryEnvironmentFlag("PM_NO_TELEMETRY", env),
    do_not_track: doNotTrack,
    test_suppressed: testSuppressed,
  };
}
