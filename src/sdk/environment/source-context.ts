/**
 * @module sdk/environment/source-context
 *
 * Defines the inherited source-workspace access contract used by sandboxed
 * commands that retain read-only project identity.
 */

/** Environment key declaring how a child may use inherited source coordinates. */
export const SOURCE_CONTEXT_ACCESS_ENV = "PM_SOURCE_CONTEXT_ACCESS";
/** Environment key permitting one explicit source-context write invocation. */
export const SOURCE_CONTEXT_WRITE_OVERRIDE_ENV =
  "PM_ALLOW_SOURCE_CONTEXT_WRITES";

/** Supported inherited source-context access modes. */
export type SourceContextAccessMode = "read_only" | "write";

/** Structured policy used by SDK adapters before selecting source coordinates. */
export interface SourceContextWritePolicy {
  /** Declared access mode, with absent legacy context retaining write behavior. */
  access: SourceContextAccessMode;
  /** Whether the one-invocation write override was accepted. */
  write_override_applied: boolean;
  /** Whether a mutation may select inherited source coordinates. */
  source_writes_allowed: boolean;
}

/** Resolve inherited source-coordinate write policy without reading filesystem state. */
export function resolveSourceContextWritePolicy(
  environment: Readonly<Record<string, string | undefined>>,
): SourceContextWritePolicy {
  const access =
    environment[SOURCE_CONTEXT_ACCESS_ENV]?.trim().toLowerCase() ===
    "read_only"
      ? "read_only"
      : "write";
  const writeOverrideApplied =
    access === "read_only" &&
    environment[SOURCE_CONTEXT_WRITE_OVERRIDE_ENV]?.trim() === "1";
  return {
    access,
    write_override_applied: writeOverrideApplied,
    source_writes_allowed: access === "write" || writeOverrideApplied,
  };
}
