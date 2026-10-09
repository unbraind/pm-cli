/** @module sdk/governance/reliability
 * Evaluates recorded attempts over an explicit window without erasing failures on repair.
 */
import { isRfc3339DateTime } from "../../core/shared/time.js";

/** One original attempt in a caller-defined recurrence family. */
export interface ReliabilityAttempt {
  /** Unique occurrence identity; retries retain the original occurrence separately. */
  id: string;
  /** Stable family identity independent of the occurrence's lifecycle. */
  family: string;
  /** Recorded start instant, used for half-open window membership. */
  started_at: string;
  /** Original outcome; a successful retry must not replace a failure. */
  outcome: "success" | "failure" | "pending";
  /** Observed repair instant, when supported by independent evidence. */
  repaired_at?: string;
  /** Evidence-backed cause; leave unknown when no classification is available. */
  cause?: "product" | "infrastructure" | "unknown";
}

/** Explicit population and thresholds for a reproducible reliability query. */
export interface ReliabilityWindowPolicy {
  /** Inclusive UTC window boundary. */
  window_start: string;
  /** Exclusive UTC window boundary and repair-observation cutoff. */
  window_end: string;
  /** Expected families, including families with no observed attempts. */
  families: readonly string[];
  /** Maximum permitted original-attempt failure fraction in [0, 1). */
  max_failure_rate: number;
  /** Minimum completed attempts required to establish coverage. */
  min_completed_attempts: number;
}

/** Bounded aggregate evidence for one recurrence family. */
export interface ReliabilityFamilyReport {
  /** Stable identity from the declared population. */
  family: string;
  /** All original attempts in the selected window. */
  attempts: number;
  /** Attempts with a terminal original outcome. */
  completed: number;
  /** Originally failed attempts, including repaired occurrences. */
  failed: number;
  /** Attempts whose original outcome remains pending. */
  pending: number;
  /** Null denotes absent completed evidence, distinct from zero failures. */
  failure_rate: number | null;
  /** UTC dates carrying at least one original failure. */
  affected_days: string[];
  /** Sorted observed repair durations in minutes; missing repairs are excluded. */
  repair_minutes: number[];
  /** Failures without a repair observed before the query cutoff. */
  unresolved: number;
  /** Cause counts retain unclassified failures instead of guessing attribution. */
  causes: Record<"product" | "infrastructure" | "unknown", number>;
  /** Coverage or rate findings that enforce the declared policy. */
  violations: Array<"insufficient_completed_attempts" | "failure_rate">;
  /** True only when both coverage and the rate satisfy policy. */
  ok: boolean;
}

/** Reproducible aggregate verdict suitable for a package, gate, or recorded measurement. */
export interface ReliabilityWindowReport {
  /** Versioned result schema for persisted evidence. */
  schema: "pm-reliability-window/1";
  /** Normalized inclusive query boundary. */
  window_start: string;
  /** Normalized exclusive query boundary. */
  window_end: string;
  /** True only when every expected family satisfies policy. */
  ok: boolean;
  /** Reports preserve the caller's declared family order. */
  families: ReliabilityFamilyReport[];
}

/** Parse an observed instant, refusing missing or malformed evidence. */
function instant(value: string): number {
  if (typeof value !== "string" || !isRfc3339DateTime(value)) throw new TypeError("Invalid reliability timestamp.");
  return Date.parse(value);
}

/** Validate the explicit population and thresholds before inspecting any attempts. */
function validatePolicy(policy: ReliabilityWindowPolicy): { start: number; end: number } {
  const start = instant(policy.window_start);
  const end = instant(policy.window_end);
  if (start >= end || !Number.isFinite(policy.max_failure_rate) || policy.max_failure_rate < 0 || policy.max_failure_rate >= 1 || !Number.isSafeInteger(policy.min_completed_attempts) || policy.min_completed_attempts < 1) {
    throw new TypeError("Invalid reliability window policy.");
  }
  if (policy.families.length === 0 || policy.families.some((family) => typeof family !== "string" || family.trim().length === 0) || new Set(policy.families).size !== policy.families.length) {
    throw new TypeError("Expected unique, nonempty reliability families.");
  }
  return { start, end };
}

/** Admit valid original occurrences and group only attempts inside the declared window. */
function groupAttempts(attempts: readonly ReliabilityAttempt[], families: readonly string[], start: number, end: number): Map<string, ReliabilityAttempt[]> {
  const groups = new Map<string, ReliabilityAttempt[]>(families.map((family) => [family, []]));
  const ids = new Set<string>();
  for (const attempt of attempts) {
    if (typeof attempt.id !== "string" || attempt.id.trim().length === 0 || ids.has(attempt.id)) throw new TypeError("Invalid or duplicate reliability attempt identity.");
    ids.add(attempt.id);
    const group = groups.get(attempt.family);
    if (!group || !["success", "failure", "pending"].includes(attempt.outcome) || (attempt.cause !== undefined && !["product", "infrastructure", "unknown"].includes(attempt.cause))) throw new TypeError("Invalid reliability attempt family, outcome or cause.");
    const created = instant(attempt.started_at);
    if (attempt.repaired_at !== undefined && (instant(attempt.repaired_at) < created || attempt.outcome !== "failure")) throw new TypeError("Invalid reliability repair chronology.");
    if (created >= start && created < end) group.push(attempt);
  }
  return groups;
}

/**
 * Evaluate original attempts in [start, end), keeping repair and cause evidence separate.
 * Reject duplicate identities, undeclared families, invalid outcomes and chronology.
 * Empty families fail coverage; they never masquerade as healthy zero-rate evidence.
 */
export function evaluateReliabilityWindow(attempts: readonly ReliabilityAttempt[], policy: ReliabilityWindowPolicy): ReliabilityWindowReport {
  const { start, end } = validatePolicy(policy);
  const groups = groupAttempts(attempts, policy.families, start, end);
  const families = [...groups].map(([family, rows]): ReliabilityFamilyReport => {
    const failed = rows.filter((row) => row.outcome === "failure");
    const completed = rows.filter((row) => row.outcome !== "pending").length;
    const rate = completed === 0 ? null : failed.length / completed;
    const repairs = failed.filter((row) => row.repaired_at !== undefined && instant(row.repaired_at) < end);
    const causes = { product: 0, infrastructure: 0, unknown: 0 };
    for (const row of failed) causes[row.cause ?? "unknown"] += 1;
    const violations: ReliabilityFamilyReport["violations"] = [];
    if (completed < policy.min_completed_attempts) violations.push("insufficient_completed_attempts");
    if (rate !== null && rate > policy.max_failure_rate) violations.push("failure_rate");
    return {
      family, attempts: rows.length, completed, failed: failed.length,
      pending: rows.length - completed, failure_rate: rate,
      affected_days: [...new Set(failed.map((row) => new Date(instant(row.started_at)).toISOString().slice(0, 10)))].sort(),
      repair_minutes: repairs.map((row) => (instant(row.repaired_at!) - instant(row.started_at)) / 60_000).sort((a, b) => a - b),
      unresolved: failed.length - repairs.length, causes, violations, ok: violations.length === 0,
    };
  });
  return { schema: "pm-reliability-window/1", window_start: new Date(start).toISOString(), window_end: new Date(end).toISOString(), ok: families.every((family) => family.ok), families };
}
