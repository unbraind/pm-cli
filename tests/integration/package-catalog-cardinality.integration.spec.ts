import { describe, expect, it } from "vitest";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

describe("package catalog cardinality", () => {
  it("returns one row per package while preserving every resolvable alias", async () => {
    await withTempPmPath(async (context) => {
      const result = context.runCli(
        ["package", "list", "--project", "--json"],
        { expectJson: true },
      );
      expect(result.code).toBe(0);
      const packages = (result.json?.details?.packages ?? []) as Array<{
        aliases: string[];
        package_name: string;
      }>;
      expect(packages.length).toBeGreaterThan(0);
      expect(result.json?.details?.total).toBe(packages.length);
      expect(new Set(packages.map((entry) => entry.package_name)).size).toBe(
        packages.length,
      );
      expect(
        packages.find(
          (entry) => entry.package_name === "@unbrained/pm-governance-audit",
        )?.aliases,
      ).toEqual(["audit", "governance-audit"]);
      expect(
        packages.find(
          (entry) => entry.package_name === "@unbrained/pm-digital-twin",
        )?.aliases,
      ).toEqual(["digital-twin", "twin"]);
    });
  });
});
