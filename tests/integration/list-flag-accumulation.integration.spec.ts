import { describe, expect, it } from "vitest";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

// Regression coverage for pm-cf1u: repeated comma-separated list flags
// (singular or plural form) must accumulate instead of silently keeping only
// the last value. Previously `--tag a --tag b --tag c` was rewritten to three
// scalar `--tags` occurrences and Commander kept only `gamma` (data loss).
describe("repeated list flag accumulation (pm-cf1u)", () => {
  it("accumulates repeated singular --tag occurrences into one tag set", async () => {
    await withTempPmPath(async (context) => {
      const createResult = context.runCli(
        ["create", "issue", "X", "--tag", "a", "--tag", "b", "--tag", "c", "--author", "integration-test", "--json"],
        { expectJson: true },
      );
      expect(createResult.code).toBe(0);
      const id = (createResult.json as { item: { id: string } }).item.id;

      const getResult = context.runCli(["get", id, "--json"], { expectJson: true });
      expect(getResult.code).toBe(0);
      // parseTags lowercases, dedupes, and sorts the merged value.
      expect((getResult.json as { item: { tags: string[] } }).item.tags).toEqual(["a", "b", "c"]);
    });
  });

  it("accumulates repeated plural --tags occurrences into one tag set", async () => {
    await withTempPmPath(async (context) => {
      const createResult = context.runCli(
        ["create", "issue", "Y", "--tags", "p", "--tags", "q", "--author", "integration-test", "--json"],
        { expectJson: true },
      );
      expect(createResult.code).toBe(0);
      const id = (createResult.json as { item: { id: string } }).item.id;

      const getResult = context.runCli(["get", id, "--json"], { expectJson: true });
      expect(getResult.code).toBe(0);
      expect((getResult.json as { item: { tags: string[] } }).item.tags).toEqual(["p", "q"]);
    });
  });
});
