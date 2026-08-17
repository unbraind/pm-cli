import { describe, expect, it } from "vitest";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

describe("package catalog output contract", () => {
  it("accepts universal read controls without weakening mutation isolation", async () => {
    await withTempPmPath(async ({ runCli }) => {
      const catalog = runCli([
        "--no-extensions",
        "--output-budget",
        "unbounded",
        "package",
        "--catalog",
        "--json",
      ], { expectJson: true });
      expect(catalog.code).toBe(0);
      expect(catalog.json).toMatchObject({
        action: "catalog",
        details: { total: expect.any(Number) },
      });

      const mutation = runCli([
        "--no-extensions",
        "--output-budget",
        "unbounded",
        "package",
        "--catalog",
        "--install",
        "calendar",
        "--json",
      ]);
      expect(mutation.code).toBe(2);
      expect(mutation.stderr).toContain(
        "cannot be combined with a package-catalog mutation",
      );
    });
  });
});
