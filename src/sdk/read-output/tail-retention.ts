/**
 * @module sdk/read-output/tail-retention
 *
 * Declares which read collections are chronological (oldest first) and must
 * keep their newest rows when bounded (pm-8s53lj). Kept free of runtime
 * imports so the surface contracts can read it while their module initializes.
 */
import type { PmReadOutputSurface } from "../read-output-contracts.js";

/**
 * Declared retention for a chronological (oldest-first) collection whose
 * bounded reads must keep the newest entries: budget compaction and
 * `--output-limit` retain the tail and the continuation pages backwards.
 */
export interface PmReadOutputTailRetentionPolicy {
  /** Declared row paths whose entries are stored oldest first. */
  paths: readonly string[];
  /** Top-level key that reports the complete collection size beside `count` when rows are withheld. */
  total_key: "total_count";
  /** Envelope counters of delivered rows whose field equals a value, recounted whenever rows are withheld. */
  delivered_row_counters?: readonly PmReadOutputDeliveredRowCounter[];
}

/** One envelope counter of delivered rows, such as the structured events among delivered notes. */
export interface PmReadOutputDeliveredRowCounter {
  /** Top-level envelope key holding the count. */
  key: string;
  /** Row field compared against {@link equals}. */
  field: string;
  /** Value that makes a delivered row count. */
  equals: string;
}

/** Read surfaces whose newest entries are the ones a bounded read must deliver (pm-8s53lj). */
export const PM_READ_OUTPUT_TAIL_RETENTION_POLICIES: Readonly<
  Partial<Record<PmReadOutputSurface, PmReadOutputTailRetentionPolicy>>
> = Object.freeze({
  comments: Object.freeze({ paths: Object.freeze(["comments"]), total_key: "total_count" }),
  notes: Object.freeze({
    paths: Object.freeze(["notes"]),
    total_key: "total_count",
    delivered_row_counters: Object.freeze([
      Object.freeze({ key: "structured_event_count", field: "format", equals: "json" }),
    ]),
  }),
  learnings: Object.freeze({ paths: Object.freeze(["learnings"]), total_key: "total_count" }),
});

/** Whether bounded reads of one declared row path keep its newest tail. */
export function readOutputRetainsTail(
  command: PmReadOutputSurface | string | undefined,
  path: string,
): boolean {
  if (command === undefined) return false;
  const policy = Object.hasOwn(PM_READ_OUTPUT_TAIL_RETENTION_POLICIES, command)
    ? PM_READ_OUTPUT_TAIL_RETENTION_POLICIES[command as PmReadOutputSurface]
    : undefined;
  return policy?.paths.includes(path) === true;
}
