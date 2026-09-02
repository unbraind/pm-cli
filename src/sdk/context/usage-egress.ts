/**
 * @module sdk/context/usage-egress
 *
 * Keeps post-projection context feedback best-effort without weakening the
 * response contract returned by embedded SDK and MCP hosts.
 */
import { finalizeContextUsageDelivery } from "../context-usage.js";

/** Finalize derived usage feedback and attach a stable warning on failure. */
export async function finalizeContextUsageEgress(
  pmRoot: string,
  projected: unknown,
  finalize: typeof finalizeContextUsageDelivery = finalizeContextUsageDelivery,
): Promise<void> {
  try {
    await finalize({ pmRoot, result: projected });
  } catch {
    if (
      typeof projected === "object" &&
      projected !== null &&
      !Array.isArray(projected)
    ) {
      const record = projected as Record<string, unknown>;
      const warnings = Array.isArray(record.warnings)
        ? record.warnings.filter(
            (warning): warning is string => typeof warning === "string",
          )
        : [];
      record.warnings = [
        ...new Set([...warnings, "context_usage_feedback_write_failed"]),
      ].sort();
    }
  }
}
