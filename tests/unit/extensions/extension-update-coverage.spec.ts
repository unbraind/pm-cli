import { describe, expect, it } from "vitest";
import { buildExtensionTriageSummary } from "../../../src/sdk/extension/doctor.js";
import type { ManagedExtensionSummary } from "../../../src/sdk/extension.js";

const installed: ManagedExtensionSummary = {
  name: "pm-example", directory: "pm-example", version: "1.0.0",
  entry: "index.ts", scope: "project", active: true, enabled: true,
  runtime_active: true, activation_status: "ok", managed: true,
  update_check_status: "checked", update_check_reason: "checked",
  update_available: false,
};

describe("package update evidence coverage", () => {
  it.each(["skipped_non_github", "failed", "not_checked"] as const)(
    "reports %s as incomplete without changing activation evidence",
    (status) => {
      const row = { ...installed, update_check_status: status };
      const result = buildExtensionTriageSummary("project", [], [row]);
      expect(result).toMatchObject({
        status: "warn", update_health_coverage: "partial",
        update_health_partial: true, update_available_total: 0,
        active_total: 1, update_check_status_totals: { checked: 0, [status]: 1 },
      });
      expect(result.warnings).toContain(`extension_update_health_partial_coverage:${status}:1`);
      expect(result.remediation.join(" ")).not.toContain("unmanaged extensions need adoption");
      expect(result.remediation.join(" ")).not.toContain("No immediate action required");
      expect(row.runtime_active).toBe(true);
    },
  );

  it("does not let one checked package hide skipped packages or stale availability", () => {
    const result = buildExtensionTriageSummary("project", [], [
      { ...installed, update_available: true },
      { ...installed, name: "pm-stale", update_check_status: "skipped_non_github", update_available: true },
    ]);
    expect(result.update_health_coverage).toBe("partial");
    expect(result.update_available_total).toBe(1);
    expect(result.update_check_status_totals).toMatchObject({ checked: 1, skipped_non_github: 1 });
  });

  it("keeps successful checks, empty scopes, and expected unmanaged builtins complete", () => {
    const builtin: ManagedExtensionSummary = { ...installed, update_check_status: "skipped_non_github", source: { kind: "builtin", input: "beads", location: "beads", name: "beads", package: "@unbrained/pm-beads" } };
    for (const rows of [[], [installed], [builtin], [{ ...installed, name: "builtin-example", managed: false, update_check_status: "skipped_unmanaged" as const }]]) {
      const result = buildExtensionTriageSummary("project", [], rows);
      expect(result).toMatchObject({
        status: "ok", update_health_coverage: "full", update_health_partial: false,
      });
      expect(result.remediation.join(" ")).not.toContain("--fix-managed-state");
    }
  });
});
