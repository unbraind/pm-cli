import { describe, expect, it } from "vitest";
import { _testOnlyHealthCommand } from "../../../src/sdk/governance/health.js";

describe("health check-only projection contract", () => {
  it("keeps legacy healthy extension detail concise and full authoritative over brief", () => {
    const result = {
      ok: true,
      checks: [{ name: "extensions" as const, status: "ok" as const, details: {} }],
      warnings: [],
      findings: [],
      failed_because: [],
      generated_at: "2026-10-17T00:00:00.000Z",
    };
    const standard = _testOnlyHealthCommand.projectHealthResult(result, {}, false);
    expect(standard.projection?.mode).toBe("standard");
    expect(standard.checks[0]?.details).toMatchObject({ loaded_count: 0, warning_count: 0 });
    const full = _testOnlyHealthCommand.projectHealthResult(result, { brief: true, full: true }, false);
    expect(full.projection).toBeUndefined();
    expect(full.checks[0]?.details).toEqual({});
  });

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
