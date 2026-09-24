/** Tests schedule-only denominators, original attempts, timing and honest missing evidence. */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parseDocument } from "yaml";
import { evaluateReleaseReliability } from "../../../../scripts/release/release-reliability.mjs";

const policy = {
  schema: "release-reliability-policy/1",
  window_days: 30,
  cron_hour_utc: 2,
  cron_minute_utc: 35,
  max_dispatch_delay_minutes: 60,
  max_failure_rate: 0.1,
  min_completed_runs: 1,
};
const now = "2026-09-24T08:00:00Z";

function run(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id, run_attempt: 1, event: "schedule", status: "completed",
    conclusion: "success", created_at: "2026-09-24T02:40:00Z",
    run_started_at: "2026-09-24T02:42:00Z", ...overrides,
  };
}

describe("release reliability", () => {
  it("binds the configured clock to the production cron and enforces the reporting verdict", () => {
    const configured = JSON.parse(readFileSync("config/release-reliability-policy.json", "utf8"));
    const production = parseDocument(readFileSync(".github/workflows/auto-release.yml", "utf8"));
    expect(production.errors).toEqual([]);
    expect(production.getIn(["on", "schedule", 0, "cron"])).toBe(`${configured.cron_minute_utc} ${configured.cron_hour_utc} * * *`);
    const source = readFileSync(".github/workflows/release-reliability.yml", "utf8");
    const reporting = parseDocument(source);
    expect(reporting.errors).toEqual([]);
    expect(reporting.getIn(["jobs", "report", "permissions", "actions"])).toBe("read");
    expect(reporting.getIn(["jobs", "report", "steps", 0, "with", "persist-credentials"])).toBe(false);
    expect(source).toContain("process.exitCode = report.ok ? 0 : 1");
    expect(source).toContain("ref: ${{ github.event.repository.default_branch }}");
    expect(reporting.getIn(["jobs", "report", "steps", 3, "if"])).toBe("always()");
    expect(reporting.getIn(["on", "workflow_run", "types", 0])).toBe("completed");
  });
  it("keeps recovery triggers out of the scheduled denominator and names failures", () => {
    const report = evaluateReleaseReliability([
      run(1, { conclusion: "failure", failure_stage: "coverage-gate" }),
      run(2, { event: "workflow_dispatch" }),
      run(3, { event: "issues" }),
      run(4, { outcome: "same_day_verified" }),
      run(5, { outcome: "no_changes_since_last_tag" }),
    ], policy, now);
    expect(report.completed).toBe(3);
    expect(report.failure_rate).toBe(1 / 3);
    expect(report.excluded_events).toEqual({ issues: 1, workflow_dispatch: 1 });
    expect(report.outcomes).toEqual({ failed: 1, same_day_verified: 1, no_changes_since_last_tag: 1 });
    expect(report.failure_stages).toEqual({ "coverage-gate": 1 });
    expect(report.violations).toEqual(["scheduled_failure_rate"]);
    expect(report.ok).toBe(false);
  });

  it("reports dispatch and queue delay independently and flags missing schedules", () => {
    const report = evaluateReleaseReliability([run(1, {
      created_at: "2026-09-23T07:35:00Z", run_started_at: "2026-09-23T07:45:00Z",
    })], policy, now);
    expect(report.items[0]).toMatchObject({ dispatch_delay_minutes: 300, queue_delay_minutes: 10 });
    expect(report.violations).toContain("dispatch_window");
    expect(report.violations).toContain("missing_scheduled_run");
    expect(report.latest_expected_occurrence).toBe("2026-09-24T02:35:00.000Z");
  });

  it("does not turn no data or unfinished runs into healthy zero failure", () => {
    expect(evaluateReleaseReliability([], policy, now)).toMatchObject({ ok: false, failure_rate: null });
    const report = evaluateReleaseReliability([run(1, { status: "in_progress", conclusion: null })], policy, now);
    expect(report.completed).toBe(0);
    expect(report.pending).toBe(1);
    expect(report.violations).toContain("insufficient_completed_runs");
  });

  it("preserves unclassified success and fails closed on unproved first attempts", () => {
    const report = evaluateReleaseReliability([run(1)], policy, now);
    expect(report.failure_rate).toBe(0);
    expect(report.outcomes).toEqual({ unknown_success: 1 });
    expect(report.outcome_evidence_complete).toBe(false);
    expect(() => evaluateReleaseReliability([run(1, { run_attempt: 2 })], policy, now)).toThrow("first attempt");
    expect(() => evaluateReleaseReliability([run(1), run(1)], policy, now)).toThrow("Duplicate");
  });

  it("uses a half-open window and counts non-success terminal outcomes as failures", () => {
    const report = evaluateReleaseReliability([
      run(1, { created_at: "2026-08-25T08:00:00Z", run_started_at: "2026-08-25T08:00:00Z", conclusion: "cancelled" }),
      run(2, { created_at: now, run_started_at: now }),
      run(3, { created_at: "2026-08-25T07:59:59Z", run_started_at: "2026-08-25T07:59:59Z" }),
    ], policy, now);
    expect(report.completed).toBe(1);
    expect(report.failure_rate).toBe(1);
    expect(report.failure_stages).toEqual({ unrecorded: 1 });
  });

  it("validates policy and timestamps instead of silently dropping malformed evidence", () => {
    expect(() => evaluateReleaseReliability([], { ...policy, max_failure_rate: 2 }, now)).toThrow("policy");
    expect(() => evaluateReleaseReliability([], policy, "bad")).toThrow("timestamp");
    expect(() => evaluateReleaseReliability([run(1, { created_at: "bad" })], policy, now)).toThrow("timestamp");
    expect(() => evaluateReleaseReliability([run(1, { run_started_at: "2026-09-23T00:00:00Z" })], policy, now)).toThrow("before creation");
    for (const changed of [{ schema: "other" }, { window_days: 0 }, { window_days: 91 }, { window_days: 1.5 }, { max_failure_rate: -1 }, { max_failure_rate: NaN }]) {
      expect(() => evaluateReleaseReliability([], { ...policy, ...changed }, now)).toThrow("policy");
    }
    for (const id of [0, 1.5]) expect(() => evaluateReleaseReliability([run(id)], policy, now)).toThrow("first attempt");
    expect(() => evaluateReleaseReliability([run(1, { created_at: null })], policy, now)).toThrow("timestamp");
  });

  it("handles pre-cron observations, queued runs, chronology, and repeated dimensions", () => {
    const report = evaluateReleaseReliability([
      run(2, { created_at: "2026-09-24T01:00:00Z", run_started_at: null }),
      run(1, { created_at: "2026-09-23T02:40:00Z", run_started_at: null }),
      run(3, { created_at: "2026-09-24T02:40:00Z", run_started_at: null }),
    ], policy, now);
    expect(report.items[0]?.id).toBe(1);
    expect(report.items[1]?.nominal_occurrence).toBe("2026-09-23T02:35:00.000Z");
    expect(report.items[1]?.queue_delay_minutes).toBeNull();
    expect(report.outcomes).toEqual({ unknown_success: 3 });
  });
});
