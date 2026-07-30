import { describe, expect, it } from "vitest";
import { _testOnlyHealthCommand } from "../../../src/sdk/governance/health.js";

describe("health check-only projection contract", () => {
  it("defaults to a verdict-only projection while retaining complete checks", () => {
    const policy = _testOnlyHealthCommand.resolveHealthSkipPolicy({
      checkOnly: true,
    });
    expect(policy).toEqual({
      summaryMode: true,
      skipIntegrity: false,
      skipDrift: false,
      skipVectors: false,
    });

    const projected = _testOnlyHealthCommand.projectHealthResult(
      {
        ok: true,
        checks: [
          { name: "settings", status: "ok", details: { path: "/private" } },
          { name: "integrity", status: "ok", details: { skipped: true } },
        ],
        warnings: [],
        generated_at: "2026-07-30T00:00:00.000Z",
      },
      { checkOnly: true },
      policy.summaryMode,
    );
    expect(projected).toMatchObject({
      ok: true,
      checks: [{ name: "settings", status: "ok", details: {} }],
      warning_count: 0,
      warnings: [],
      projection: {
        mode: "summary",
        omitted_checks: ["integrity"],
      },
    });
    expect(JSON.stringify(projected)).not.toContain("/private");
  });

  it("keeps full evidence as an explicit check-only override", () => {
    expect(
      _testOnlyHealthCommand.resolveHealthSkipPolicy({
        checkOnly: true,
        full: true,
      }),
    ).toEqual({
      summaryMode: false,
      skipIntegrity: false,
      skipDrift: false,
      skipVectors: false,
    });
  });
});
