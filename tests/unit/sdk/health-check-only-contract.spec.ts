import { describe, expect, it } from "vitest";
import { _testOnlyHealthCommand, type HealthFinding, type HealthResult, type RunHealthOptions } from "../../../src/sdk/governance/health.js";
import { projectHealthResult } from "../../../src/sdk/governance/health/projection.js";

describe("health check-only projection contract", () => {
  it("retains all blocking findings beyond warning samples without reordering or deduplicating them", () => {
    const warnings = Array.from({ length: 220 }, (_, index) => `warning:${index}`);
    const failures = [...warnings.slice(120), "blocking:outside-warning-list"];
    const finding = (warning: string): HealthFinding => ({ warning, code: warning, check: "integrity", severity: failures.includes(warning) ? "gate_failing" : "advisory" });
    const retained = [finding(warnings[0]!), ...failures.map(finding), finding(failures[0]!)];
    const result: HealthResult = {
      ok: false,
      verdict: { authority: "ok", exit_code: 1 },
      checks: [], warnings, failed_because: failures,
      findings: [retained[0]!, finding(warnings[110]!), ...retained.slice(1), finding("unrelated")],
      generated_at: "2026-10-17T00:00:00.000Z",
    };
    const before = JSON.stringify(result);
    const modes: [RunHealthOptions, boolean][] = [[{}, false], [{ brief: true }, false], [{}, true], [{ full: true }, false]];
    for (const [options, summary] of modes) {
      const projected = projectHealthResult(result, options, summary);
      expect(projected.findings).toEqual(retained);
      expect(projected.failed_because).toEqual(failures);
      expect(projected.verdict).toEqual(result.verdict);
      expect(projected.warnings).toHaveLength(options.brief || summary ? 8 : 100);
    }
    expect(JSON.stringify(result)).toBe(before);
  });

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
        failed_because: [],
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
