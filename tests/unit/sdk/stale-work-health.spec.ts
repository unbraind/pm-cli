import { describe, expect, it } from "vitest";
import { _testOnlyHealthCommand } from "../../../src/sdk/governance/health.js";

describe("stale in-progress health contract", () => {
  it("keeps stale work advisory while surfacing remediation", () => {
    const result = _testOnlyHealthCommand.buildStaleInProgressHealthSummary({
      threshold_hours: 72,
      count: 1,
      items: [
        {
          id: "pm-stale",
          last_activity_at: "2026-07-01T00:00:00.000Z",
          age_hours: 564,
        },
      ],
      remediation: "claim or reopen",
    });
    expect(result).toMatchObject({
      scan: { count: 1 },
      warnings: ["stale_in_progress_items:1"],
    });
    expect(
      _testOnlyHealthCommand.isAdvisoryHealthWarning(
        "stale_in_progress_items:1",
      ),
    ).toBe(true);
    expect(
      _testOnlyHealthCommand.buildStaleInProgressHealthSummary({
        threshold_hours: 72,
        count: 0,
        items: [],
        remediation: "claim or reopen",
      }),
    ).toMatchObject({
      scan: { count: 0 },
      warnings: [],
    });
  });
});
