import { describe, expect, it } from "vitest";
import { scorePmRefusalClosure } from "../../../../src/sdk/agent/refusal-closure.js";

describe("refusal closure scoring", () => {
  const closed = {
    probe_id: "list-invalid-intent",
    entrypoint: "pm list --for invalid",
    exit_code: 2,
    rejected_value: "invalid",
    allowed_values: ["triage"],
    suggested_retry: "pm list --for triage",
    retry_succeeded: true,
  } as const;

  it("reports complete executable recovery as full closure", () => {
    expect(scorePmRefusalClosure([closed])).toEqual({
      ok: true,
      probe_count: 1,
      closed_probe_count: 1,
      closure_fraction: 1,
      findings: [],
    });
  });

  it("rejects a vacuous corpus", () => {
    expect(scorePmRefusalClosure([])).toEqual({
      ok: false,
      probe_count: 0,
      closed_probe_count: 0,
      closure_fraction: 0,
      findings: [
        {
          code: "empty_corpus",
          probe_id: "corpus",
          detail: "At least one real refusal observation is required.",
        },
      ],
    });
  });

  it("fails closed for missing, contradictory, duplicated, or broken recovery", () => {
    const broken = {
      ...closed,
      exit_code: 0,
      allowed_values: ["invalid"],
      suggested_retry: "",
      retry_succeeded: false,
    };
    const report = scorePmRefusalClosure([broken, broken]);
    expect(report).toMatchObject({
      ok: false,
      probe_count: 1,
      closed_probe_count: 0,
      closure_fraction: 0,
    });
    expect(report.findings.map(({ code }) => code)).toEqual([
      "accepted_rejected_value",
      "duplicate_probe",
      "missing_suggested_retry",
      "non_refusal_exit",
      "retry_failed",
    ]);
    expect(
      scorePmRefusalClosure([{ ...broken, allowed_values: [] }]).findings.map(
        ({ code }) => code,
      ),
    ).toContain("missing_allowed_values");
    expect(
      scorePmRefusalClosure([
        broken,
        { ...broken, probe_id: "second-broken-probe" },
      ]).findings,
    ).toHaveLength(8);
  });
});
