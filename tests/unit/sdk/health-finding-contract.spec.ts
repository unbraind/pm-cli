import { describe, expect, it } from "vitest";
import {
  _testOnlyHealthCommand,
  type HealthCheck,
  type HealthResult,
} from "../../../src/sdk/governance/health.js";

const CHECK_NAMES: HealthCheck["name"][] = [
  "settings",
  "directories",
  "settings_values",
  "telemetry",
  "extensions",
  "storage",
  "locks",
  "integrity",
  "history_drift",
  "vectorization",
];

function checks(): HealthCheck[] {
  return CHECK_NAMES.map((name) => ({
    name,
    status: "ok",
    ok: true,
    details:
      name === "storage"
        ? {
            remediation_map: {
              provenance_value_domain_invalid:
                "pm history-repair --all --normalize-provenance",
            },
          }
        : {},
  }));
}

function sources(
  values: Partial<Record<HealthCheck["name"], string[]>>,
): Record<HealthCheck["name"], string[]> {
  return Object.fromEntries(
    CHECK_NAMES.map((name) => [name, values[name] ?? []]),
  ) as Record<HealthCheck["name"], string[]>;
}

describe("self-indexing health findings", () => {
  it("indexes advisory repair and gate-failing safe refusal semantics", () => {
    const provenance =
      "provenance_value_domain_invalid:claude-code:role:single_digit:1";
    const skew =
      "extension_host_pm_cli_version_skew:2026.8.15:2026.8.14:demo";
    expect(
      _testOnlyHealthCommand.buildHealthFindings({
        warnings: [provenance, skew],
        checks: checks(),
        remediationSources: sources({
          storage: [provenance],
          extensions: [skew],
        }),
        requireMergeDrivers: false,
      }),
    ).toEqual([
      {
        warning: provenance,
        code: "provenance_value_domain_invalid",
        check: "storage",
        severity: "advisory",
        remediation: "pm history-repair --all --normalize-provenance",
      },
      {
        warning: skew,
        code: "extension_host_pm_cli_version_skew",
        check: "extensions",
        severity: "gate_failing",
        disposition: "no_safe_automatic_remediation",
      },
    ]);
  });

  it("preserves exact failure causes in compact projections", () => {
    const warning = "synthetic_gate_failure:1";
    const result: HealthResult = {
      ok: false,
      checks: checks(),
      warnings: [warning],
      findings: [
        {
          warning,
          code: "synthetic_gate_failure",
          check: "integrity",
          severity: "gate_failing",
          disposition: "no_safe_automatic_remediation",
        },
      ],
      failed_because: [warning],
      generated_at: "2026-08-15T00:00:00.000Z",
    };
    for (const options of [{ brief: true }, { summary: true }]) {
      const projected = _testOnlyHealthCommand.projectHealthResult(
        result,
        options,
        options.summary === true,
      );
      expect(projected.ok).toBe(false);
      expect(projected.failed_because).toEqual([warning]);
      expect(projected.findings).toEqual(result.findings);
    }
  });
});
