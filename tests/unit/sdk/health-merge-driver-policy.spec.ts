import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { runHealth } from "../../../src/sdk/governance/health.js";
import { runMergeInstall } from "../../../src/sdk/merge/install.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

describe("health merge-driver policy", () => {
  it("keeps never-installed drivers advisory by default and enforceable on demand", async () => {
    await withTempPmPath(async (context) => {
      execFileSync("git", ["init", "-q"], { cwd: context.tempRoot });

      const advisory = await runHealth(
        { path: context.pmPath },
        {
          noRefresh: true,
          skipDrift: true,
          skipVectors: true,
        },
      );
      expect(advisory.ok).toBe(true);
      expect(advisory.warnings).toContain(
        "merge_driver_configuration_missing:5",
      );
      expect(
        advisory.checks.find((check) => check.name === "integrity"),
      ).toMatchObject({
        status: "warn",
        details: {
          merge_driver_configuration: {
            status: "missing",
            required: false,
          },
        },
      });

      const required = await runHealth(
        { path: context.pmPath },
        {
          noRefresh: true,
          skipDrift: true,
          skipVectors: true,
          requireMergeDrivers: true,
        },
      );
      expect(required.ok).toBe(false);
      expect(
        required.checks.find((check) => check.name === "integrity"),
      ).toMatchObject({
        details: {
          merge_driver_configuration: {
            status: "missing",
            required: true,
          },
        },
      });
    });
  });

  it("keeps installed-but-drifted drivers blocking", async () => {
    await withTempPmPath(async (context) => {
      execFileSync("git", ["init", "-q"], { cwd: context.tempRoot });
      await runMergeInstall({}, { path: context.pmPath });
      execFileSync(
        "git",
        [
          "config",
          "--local",
          "merge.pm-history.driver",
          "node stale-driver.js",
        ],
        { cwd: context.tempRoot },
      );

      const result = await runHealth(
        { path: context.pmPath },
        {
          noRefresh: true,
          skipDrift: true,
          skipVectors: true,
        },
      );
      expect(result.ok).toBe(false);
      expect(result.warnings).toContain("merge_driver_configuration_drift:1");
    });
  });
});
