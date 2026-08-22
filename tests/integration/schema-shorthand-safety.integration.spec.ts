import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EXIT_CODE } from "../../src/sdk/runtime-primitives.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

describe("schema shorthand safety", () => {
  it("refuses a lowercase unknown action without changing the custom-type registry", async () => {
    await withTempPmPath(async (context) => {
      const typesPath = path.join(context.pmPath, "schema", "types.json");
      const before = await readFile(typesPath, "utf8");

      const result = context.runCli(["schema", "nonsense", "--json"]);

      expect(result.code).toBe(EXIT_CODE.USAGE);
      expect(JSON.parse(result.stderr)).toMatchObject({
        code: "unknown_subcommand",
        refusal: {
          surface: "schema",
          rejected_value: "nonsense",
          exit_code: EXIT_CODE.USAGE,
        },
        recovery: {
          allowed_values: expect.arrayContaining(["list", "add-type"]),
        },
      });
      expect(await readFile(typesPath, "utf8")).toBe(before);
    });
  });

  it("retains the PascalCase custom-type shorthand", async () => {
    await withTempPmPath(async (context) => {
      const result = context.runCli(["schema", "Experiment", "--json"], {
        expectJson: true,
      });

      expect(result.code).toBe(0);
      expect(result.json).toMatchObject({
        action: "add-type",
        type: { name: "Experiment" },
      });
    });
  });
});
