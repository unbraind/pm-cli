/**
 * Pure release reliability evaluation. Original scheduled attempts form the
 * denominator; manual and issue recovery can never rewrite their conclusions.
 * Unknown historical outcomes remain unknown instead of becoming publication.
 */
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const KNOWN_OUTCOMES = new Set([
  "published", "same_day_verified", "no_changes_since_last_tag",
  "tracker_only_changes_since_last_tag", "release_already_cut_today",
  "empty_generated_changelog_section_for_target_version", "dry_run",
]);

/** Reject malformed observation times before they can affect a denominator. */
function timestamp(value) {
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(parsed)) throw new Error("Invalid observation timestamp.");
  return parsed;
}

/** Validate the versioned, bounded policy rather than accepting vacuous thresholds. */
export function validateReliabilityPolicy(policy) {
  const integerRanges = {
    window_days: [1, 90], cron_hour_utc: [0, 23], cron_minute_utc: [0, 59],
    max_dispatch_delay_minutes: [0, 1439], min_completed_runs: [1, 1000],
  };
  if (policy?.schema !== "release-reliability-policy/1") throw new Error("Invalid reliability policy schema.");
  for (const [key, [minimum, maximum]] of Object.entries(integerRanges)) {
    if (!Number.isInteger(policy[key]) || policy[key] < minimum || policy[key] > maximum) {
      throw new Error(`Invalid reliability policy ${key}.`);
    }
  }
  if (!Number.isFinite(policy.max_failure_rate) || policy.max_failure_rate < 0 || policy.max_failure_rate >= 1) {
    throw new Error("Invalid reliability policy max_failure_rate.");
  }
  return policy;
}

/**
 * Infer the nearest preceding daily UTC occurrence. GitHub does not expose the
 * intended scheduled instant, so this cannot attribute delays exceeding a day.
 */
function nominalOccurrence(instant, policy) {
  const date = new Date(instant);
  date.setUTCHours(policy.cron_hour_utc, policy.cron_minute_utc, 0, 0);
  return date.getTime() > instant ? date.getTime() - DAY_MS : date.getTime();
}

/** Convert one authoritative first-attempt run into a compact timing/outcome row. */
function observation(run, policy) {
  if (!Number.isSafeInteger(run.id) || run.id < 1 || run.run_attempt !== 1) {
    throw new Error("Expected a positive run id and authoritative first attempt.");
  }
  const created = timestamp(run.created_at);
  const started = run.run_started_at === null ? null : timestamp(run.run_started_at);
  if (started !== null && started < created) throw new Error("Run started before creation.");
  const nominal = nominalOccurrence(created, policy);
  const completed = run.status === "completed";
  const failed = completed && run.conclusion !== "success";
  let outcome = "pending";
  if (completed) {
    outcome = failed ? "failed" : KNOWN_OUTCOMES.has(run.outcome) ? run.outcome : "unknown_success";
  }
  return {
    id: run.id, created_at: new Date(created).toISOString(),
    nominal_occurrence: new Date(nominal).toISOString(),
    dispatch_delay_minutes: (created - nominal) / MINUTE_MS,
    queue_delay_minutes: started === null ? null : (started - created) / MINUTE_MS,
    conclusion: run.conclusion, completed, failed, outcome,
    failure_stage: failed ? run.failure_stage || "unrecorded" : null,
  };
}

/** Count a declared dimension without treating missing observations as zero-rate proof. */
function counts(rows, field) {
  const result = {};
  for (const row of rows) {
    const key = row[field];
    Object.defineProperty(result, key, {
      value: (Object.hasOwn(result, key) ? result[key] : 0) + 1,
      enumerable: true, configurable: true, writable: true,
    });
  }
  return result;
}

/**
 * Evaluate a complete run census in [now-window, now). A red historical rate
 * is an operational report, independent of the gates judging a candidate tree.
 */
export function evaluateReleaseReliability(runs, policy, now) {
  validateReliabilityPolicy(policy);
  const end = timestamp(now);
  const start = end - policy.window_days * DAY_MS;
  const ids = new Set();
  const selected = [];
  const excluded = [];
  for (const run of runs) {
    const created = timestamp(run.created_at);
    if (created < start || created >= end) continue;
    if (ids.has(run.id)) throw new Error(`Duplicate run id ${run.id}.`);
    ids.add(run.id);
    if (run.event !== "schedule") { excluded.push(run); continue; }
    selected.push(observation(run, policy));
  }
  selected.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id);
  const completed = selected.filter((row) => row.completed);
  const failed = completed.filter((row) => row.failed);
  const failureRate = completed.length === 0 ? null : failed.length / completed.length;
  const expected = nominalOccurrence(end - policy.max_dispatch_delay_minutes * MINUTE_MS, policy);
  const violations = [];
  if (completed.length < policy.min_completed_runs) violations.push("insufficient_completed_runs");
  if (failureRate !== null && failureRate > policy.max_failure_rate) violations.push("scheduled_failure_rate");
  if (selected.some((row) => row.dispatch_delay_minutes > policy.max_dispatch_delay_minutes)) violations.push("dispatch_window");
  if (!selected.some((row) => timestamp(row.nominal_occurrence) >= expected)) violations.push("missing_scheduled_run");
  return {
    schema: "release-reliability/1", ok: violations.length === 0, violations,
    window_start: new Date(start).toISOString(), window_end: new Date(end).toISOString(),
    policy, attempt: 1, timing_attribution: "nearest_preceding_utc_occurrence",
    latest_expected_occurrence: new Date(expected).toISOString(),
    completed: completed.length, failed: failed.length, pending: selected.length - completed.length,
    failure_rate: failureRate, outcomes: counts(completed, "outcome"),
    failure_stages: counts(failed, "failure_stage"), excluded_events: counts(excluded, "event"),
    outcome_evidence_complete: completed.every((row) => row.outcome !== "unknown_success" && (!row.failed || row.failure_stage !== "unrecorded")),
    items: selected,
  };
}
