import { describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import fc from "fast-check";
import { collectDuplicateCandidatePairs } from "../../../../src/sdk/query/duplicate-candidates.js";
import { prepareSimilarityText, scorePreparedItemSimilarity } from "../../../../src/sdk/similarity-scoring.js";
import { analyzeDuplicateItems } from "../../../../src/sdk/query.js";
import { PmClient } from "../../../../src/sdk/runtime.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";
import { registerOperationCommands } from "../../../../src/cli/register-operations.js";

describe("lossless duplicate prefix join", () => {
  it("shares exact clustering across caller-owned metadata, SDK dispatch and CLI", async () => {
    const input = ["b", "a", "c"].map((id) => ({ id, title: id === "c" ? "unrelated" : "Shared project outcome", type: "Task", status: "open" }));
    const fast = analyzeDuplicateItems(input);
    const exhaustive = analyzeDuplicateItems(input, { exhaustive: true });
    expect(fast.clusters).toEqual(exhaustive.clusters);
    expect(fast.cost).toMatchObject({ algorithm: "prefix_exact", possible_pairs: 3, scored_pairs: 1, recall_guarantee: "exact" });
    expect(exhaustive.cost.scored_pairs).toBe(3);
    expect(input.map(({ id }) => id)).toEqual(["b", "a", "c"]);
    expect(() => analyzeDuplicateItems([input[0], input[0]])).toThrow("unique non-empty");
    expect(() => analyzeDuplicateItems([{ ...input[0], id: " " }])).toThrow("unique non-empty");
    await withTempPmPath(async (context) => {
      for (const title of ["First requirement", "Second requirement"]) context.runCli(["create", "--title", title, "--type", "Task"]);
      const sdk = await new PmClient({ pmRoot: context.pmPath, noExtensions: true }).duplicates({ exhaustive: true });
      const cli = context.runCli(["duplicates", "--exhaustive", "--json"], { expectJson: true }).json;
      expect(cli).toMatchObject({ cost: sdk.cost, clusters: sdk.clusters });
      expect(sdk.cost).toMatchObject({ algorithm: "exhaustive", possible_pairs: 1, scored_pairs: 1 });
      const program = new Command().option("--pm-path <path>").option("--json");
      registerOperationCommands(program);
      const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        await program.parseAsync(["--pm-path", context.pmPath, "--json", "duplicates", "--exhaustive"], { from: "user" });
        expect(JSON.parse(output.mock.calls.map(([chunk]) => String(chunk)).join(""))).toMatchObject({ cost: sdk.cost, clusters: sdk.clusters });
      } finally { output.mockRestore(); }
    });
  });
  it("matches an exhaustive oracle across thresholds, Unicode, empty tokens and issue codes", () => {
    fc.assert(fc.property(
      fc.array(fc.array(fc.constantFrom("alpha", "beta", "gamma", "delta", "écho", "東京", "GH-12", "!", "?"), { maxLength: 12 }).map((words) => words.join(" ")), { maxLength: 35 }),
      fc.constantFrom(0, 0.1, 0.5, 0.8, 0.99, 1),
      (titles, threshold) => {
        const items = titles.map((title) => ({ prepared: prepareSimilarityText(title) }));
        const prefix = collectDuplicateCandidatePairs(items, 10_000, threshold);
        const oracle = collectDuplicateCandidatePairs(items, 10_000, threshold, true);
        for (const pair of oracle) {
          const [left, right] = pair.split(":").map(Number);
          if (scorePreparedItemSimilarity(items[left].prepared, items[right].prepared).score >= threshold) expect(prefix.has(pair)).toBe(true);
        }
      },
    ), { seed: 20260905, numRuns: 150 });
  });

  it("avoids common-token all-pairs expansion without concealing dense-output limits", () => {
    const items = Array.from({ length: 10_000 }, (_, index) => ({
      prepared: prepareSimilarityText(`project context unique${index} owner${index} requirement${index}`),
    }));
    expect(collectDuplicateCandidatePairs(items).size).toBe(0);
    expect(() => collectDuplicateCandidatePairs(items.slice(0, 10), 2, 0.8, true)).toThrow("candidate pairs");
    expect(() => collectDuplicateCandidatePairs(Array.from({ length: 4 }, () => ({ prepared: prepareSimilarityText("same") })), 2)).toThrow("candidate pairs");
  });
});
