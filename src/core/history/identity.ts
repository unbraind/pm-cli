/** @module core/history/identity
 * Identifies multiple genesis records without inferring an unrecorded writer.
 */
import type { HistoryEntry } from "../../types/index.js";

/** Evidence of a second subject occupying one append-only identity stream. */
export interface HistoryIdentityDiscontinuity {
  /** One-based physical ordinal of the original create or retained baseline. */
  prior_genesis_index: number;
  /** One-based physical ordinal of the later create record. */
  repeated_create_index: number;
  /** Observed record sequence, not an assertion about branch or writer origin. */
  sequence:
    | "delete_then_create"
    | "multiple_creates"
    | "checkpoint_then_create";
}

/** Find every repeated genesis, including histories that start at a checkpoint. */
export function findHistoryIdentityDiscontinuities(
  entries: readonly HistoryEntry[],
): HistoryIdentityDiscontinuity[] {
  const findings: HistoryIdentityDiscontinuity[] = [];
  const checkpoint = entries[0]?.op === "history_compact_baseline";
  let genesis = checkpoint ? 1 : undefined;
  let deleted = false;
  for (const [index, entry] of entries.entries()) {
    if (entry.op === "delete") deleted = true;
    if (entry.op !== "create") continue;
    if (genesis !== undefined) {
      findings.push({
        prior_genesis_index: genesis,
        repeated_create_index: index + 1,
        sequence: deleted
          ? "delete_then_create"
          : checkpoint
            ? "checkpoint_then_create"
            : "multiple_creates",
      });
    }
    genesis ??= index + 1;
    deleted = false;
  }
  return findings;
}
