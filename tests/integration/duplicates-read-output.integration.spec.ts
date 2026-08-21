import { describe, expect, it } from "vitest";
import { PM_READ_OUTPUT_SURFACE_CONTRACTS } from "../../src/sdk/core.js";
import { PmClient } from "../../src/sdk/runtime.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

describe("duplicates universal read output", () => {
  it("returns matching JSON and SDK receipts while preserving bounded TOON defaults", async () => {
    await withTempPmPath(async (context) => {
      const json = context.runCli(
        [
          "duplicates",
          "--output-format",
          "json",
          "--output-budget",
          "unbounded",
        ],
        { expectJson: true },
      ).json as Record<string, unknown>;
      expect(json).toMatchObject({
        count: 0,
        source: "metadata_scan",
        read_output: {
          contract_version: 1,
          command: "duplicates",
          within_budget: true,
        },
      });

      const sdk = await new PmClient({
        pmRoot: context.pmPath,
        noExtensions: true,
      }).duplicates({ outputBudget: "unbounded", outputFormat: "json" });
      expect(sdk).toMatchObject({
        count: 0,
        read_output: { command: "duplicates", within_budget: true },
      });
      expect(
        PM_READ_OUTPUT_SURFACE_CONTRACTS.find(
          (contract) => contract.command === "duplicates",
        )?.dimensions,
      ).toMatchObject({
        include: { applicable: true },
        amount: { applicable: true },
        cost: { applicable: true },
        encoding: { applicable: true },
      });
      expect(
        PM_READ_OUTPUT_SURFACE_CONTRACTS.find(
          (contract) => contract.command === "duplicates",
        )?.dimensions.amount.legacy_aliases.map((alias) => alias.flag),
      ).toEqual(["--limit"]);

      const toon = context.runCli(["duplicates"]);
      expect(toon.stdout).toContain("count: 0");
      expect(toon.stdout).not.toContain("read_output:");
    });
  });
});
