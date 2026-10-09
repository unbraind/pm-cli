/** Prove original-outcome, half-open-window and fail-closed population contracts. */
import { describe, expect, it } from "vitest";
import { evaluateReliabilityWindow, type ReliabilityAttempt, type ReliabilityWindowPolicy } from "../../../../src/sdk/governance.js";

const policy: ReliabilityWindowPolicy = {
  window_start: "2026-10-01T00:00:00Z", window_end: "2026-10-09T00:00:00Z",
  families: ["windows", "linux"], max_failure_rate: 0.1, min_completed_attempts: 1,
};
const attempt: ReliabilityAttempt = { id: "one", family: "windows", started_at: "2026-10-02T12:00:00Z", outcome: "failure" };

describe("public reliability window primitive", () => {
  it("retains repaired failures and unknown causes while separating clean families", () => {
    const report = evaluateReliabilityWindow([
      { ...attempt, repaired_at: "2026-10-02T12:30:00Z", cause: "product" },
      { ...attempt, id: "two", repaired_at: "2026-10-02T13:00:00Z", cause: "infrastructure" },
      { ...attempt, id: "three", started_at: "2026-10-03T12:00:00Z" },
      { ...attempt, id: "pending", outcome: "pending" },
      { ...attempt, id: "clean", family: "linux", outcome: "success" },
    ], policy);
    expect(report.ok).toBe(false);
    expect(report.families[0]).toEqual({
      family: "windows", attempts: 4, completed: 3, failed: 3, pending: 1,
      failure_rate: 1, affected_days: ["2026-10-02", "2026-10-03"],
      repair_minutes: [30, 60], unresolved: 1, causes: { product: 1, infrastructure: 1, unknown: 1 },
      violations: ["failure_rate"], ok: false,
    });
    expect(report.families[1]).toMatchObject({ failed: 0, failure_rate: 0, affected_days: [], repair_minutes: [], ok: true });
  });

  it("distinguishes missing evidence from a measured zero and honors both window boundaries", () => {
    const report = evaluateReliabilityWindow([
      { ...attempt, outcome: "success", started_at: policy.window_start },
      { ...attempt, id: "end", started_at: policy.window_end },
      { ...attempt, id: "before", started_at: "2026-09-30T23:59:59Z" },
    ], policy);
    expect(report.families[0]).toMatchObject({ attempts: 1, failure_rate: 0, ok: true });
    expect(report.families[1]).toMatchObject({ attempts: 0, failure_rate: null, violations: ["insufficient_completed_attempts"], ok: false });
    expect(evaluateReliabilityWindow([{ ...attempt, outcome: "pending" }], policy).families[0]).toMatchObject({ completed: 0, pending: 1, failure_rate: null });
    expect(evaluateReliabilityWindow([{ ...attempt, repaired_at: policy.window_end }], policy).families[0]?.unresolved).toBe(1);
    expect(evaluateReliabilityWindow([{ ...attempt, cause: "unknown" }], policy).families[0]?.causes.unknown).toBe(1);
  });

  it("accepts the exact rate threshold and returns a deterministic verdict without mutating inputs", () => {
    const rows = Object.freeze([
      Object.freeze(attempt),
      Object.freeze({ ...attempt, id: "clean", outcome: "success" as const }),
    ]);
    const configured = { ...policy, families: ["windows"], max_failure_rate: 0.5 };
    const report = evaluateReliabilityWindow(rows, configured);
    expect(report.ok).toBe(true);
    expect(report.families[0]?.failure_rate).toBe(0.5);
    expect(evaluateReliabilityWindow([...rows].reverse(), configured)).toEqual(report);
  });

  it.each([
    { window_start: "bad" }, { window_end: "bad" }, { window_start: "3" },
    { window_end: "2026-02-30T00:00:00Z" }, { window_start: policy.window_end },
    { max_failure_rate: -1 }, { max_failure_rate: 1 }, { max_failure_rate: NaN },
    { min_completed_attempts: 0 }, { min_completed_attempts: 1.5 },
    { families: [] }, { families: [" "] }, { families: ["x", "x"] },
    { families: [1] as unknown as string[] },
  ])("refuses malformed policy %j", (change) => {
    expect(() => evaluateReliabilityWindow([], { ...policy, ...change })).toThrow(TypeError);
  });

  it.each([
    { id: "" }, { id: 1 }, { family: "undeclared" }, { outcome: "unknown" },
    { cause: "guessed" }, { started_at: "bad" }, { started_at: null },
    { started_at: "2026-10-32T00:00:00Z" },
    { repaired_at: "bad" }, { repaired_at: "2026-10-01T00:00:00Z" },
    { outcome: "success", repaired_at: "2026-10-03T00:00:00Z" },
  ])("refuses malformed occurrence %j", (change) => {
    expect(() => evaluateReliabilityWindow([{ ...attempt, ...change } as ReliabilityAttempt], policy)).toThrow(TypeError);
  });

  it("refuses duplicate occurrence identities even when they belong to different families", () => {
    expect(() => evaluateReliabilityWindow([attempt, { ...attempt, family: "linux" }], policy)).toThrow("duplicate");
  });
});
