/**
 * @module core/output/output-control
 *
 * Defines the structural protocol for commands that own their output stream.
 */

const SUPPRESS_HOST_OUTPUT_KEY = "__pm_suppress_host_output";

/** Collision-resistant wire marker understood by pm hosts when a package already emitted output. */
export const SUPPRESS_HOST_OUTPUT_MARKER =
  "@unbrained/pm-cli:suppress-host-output:v1";

/** A handled result that tells a pm host not to render or write another payload. */
export interface SuppressedHostOutput<TResult = unknown> {
  /** Explicit protocol marker consumed by CLI and SDK-built presentation hosts. */
  readonly __pm_suppress_host_output: typeof SUPPRESS_HOST_OUTPUT_MARKER;
  /** Optional structured result retained for hooks, telemetry, and embedding hosts. */
  readonly result?: TResult;
}

/** Return from a command/exporter after it has written its own streaming, binary, or pre-rendered output. */
export function suppressHostOutput<TResult = undefined>(
  result?: TResult,
): SuppressedHostOutput<TResult> {
  return result === undefined
    ? { __pm_suppress_host_output: SUPPRESS_HOST_OUTPUT_MARKER }
    : { __pm_suppress_host_output: SUPPRESS_HOST_OUTPUT_MARKER, result };
}

/** Detect the public suppression result without relying on object identity across package boundaries. */
export function isHostOutputSuppressed(
  value: unknown,
): value is SuppressedHostOutput {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>)[SUPPRESS_HOST_OUTPUT_KEY] ===
      SUPPRESS_HOST_OUTPUT_MARKER
  );
}
