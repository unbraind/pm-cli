import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  parseItemDocument,
  serializeItemDocument,
} from "../../../src/core/item/item-format.js";
import { describe, expect, it } from "vitest";
import { runAggregate } from "../../../src/sdk/query/aggregate.js";
import { normalizeAggregateOptions } from "../../../src/sdk/cli-contracts/registration-helpers.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

describe("set-valued aggregation", () => {
  it("counts distinct members, retains untagged items, and composes numeric and scalar dimensions", async () => {
    await withTempPmPath(async (context) => {
      for (const [title, tags] of [
        ["Shared", "alpha,beta"],
        ["Single", "alpha"],
        ["Empty", "none"],
      ]) {
        const created = context.runCli(
          [
            "create",
            "Task",
            title,
            "--create-mode",
            "progressive",
            "--tags",
            tags,
            "--estimate",
            "15",
            "--json",
          ],
          { expectJson: true },
        );
        expect(created.code).toBe(0);
      }
      const result = await runAggregate(
        { groupBy: "tags,type", sum: "estimated_minutes" },
        { path: context.pmPath },
      );
      expect(
        result.groups.map((row) => [
          row.group.tags,
          row.group.type,
          row.count,
          row.sum,
        ]),
      ).toEqual([
        ["alpha", "Task", 2, 30],
        ["beta", "Task", 1, 15],
        [null, "Task", 1, 15],
      ]);
      expect(result.totals.items_grouped).toBe(3);
      expect(result.totals.group_memberships).toBe(4);
      expect(result.groups.at(-1)?.group_label).toContain("(untagged)");
      const first = await runAggregate(
        { groupBy: "tags", limit: 1 },
        { path: context.pmPath },
      );
      expect(first).toMatchObject({
        count: 3,
        returned_count: 1,
        truncated: true,
      });
      const second = await runAggregate(
        { groupBy: "tags", limit: 1, after: first.next_after! },
        { path: context.pmPath },
      );
      expect(second.groups[0]?.group.tags).toBe("beta");
      const last = await runAggregate(
        { groupBy: "tags", after: second.next_after! },
        { path: context.pmPath },
      );
      expect(last).toMatchObject({
        returned_count: 1,
        truncated: false,
        next_after: null,
      });
      await expect(
        runAggregate({ after: "stale-group" }, { path: context.pmPath }),
      ).rejects.toThrow("cursor");
      await expect(
        runAggregate({ limit: 0 }, { path: context.pmPath }),
      ).rejects.toThrow("limit");
      const cliTuple = context.runCli(
        [
          "aggregate",
          "--group-by",
          "tags",
          "--set-mode",
          "tuple",
          "--limit",
          "1",
          "--json",
        ],
        { expectJson: true },
      );
      expect(cliTuple.code).toBe(0);
      expect(cliTuple.json).toMatchObject({
        count: 3,
        returned_count: 1,
        filters: { set_mode: "tuple" },
      });
      const tuples = await runAggregate(
        normalizeAggregateOptions({ groupBy: "tags", setMode: "tuple" }),
        { path: context.pmPath },
      );
      expect(tuples.groups.map((row) => row.group.tags)).toEqual([
        "alpha",
        "alpha,beta",
        null,
      ]);
      await expect(
        runAggregate({ setMode: "invalid" }, { path: context.pmPath }),
      ).rejects.toThrow("set-mode");
    });
  });
  it("aggregates the full ten-thousand-item input before applying the default group page", async () => {
    await withTempPmPath(async (context) => {
      const created = context.runCli(
        ["create", "Task", "Seed", "--create-mode", "progressive", "--json"],
        { expectJson: true },
      );
      expect(created.code).toBe(0);
      const id = (created.json as { item: { id: string } }).item.id;
      const file = path.join(context.pmPath, "tasks", `${id}.toon`);
      const seed = parseItemDocument(await readFile(file, "utf8"), {
        format: "toon",
      });
      const writes: Promise<void>[] = [];
      for (let index = 1; index < 10_000; index += 1) {
        const nextId = `pm-scale${String(index).padStart(5, "0")}`;
        const item = {
          ...seed,
          metadata: {
            ...seed.metadata,
            id: nextId,
            tags: [`tag-${index % 60}`],
          },
        };
        writes.push(
          writeFile(
            path.join(context.pmPath, "tasks", `${nextId}.toon`),
            serializeItemDocument(item, { format: "toon" }),
          ),
        );
        if (writes.length === 100) {
          await Promise.all(writes);
          writes.length = 0;
        }
      }
      await Promise.all(writes);
      const result = await runAggregate(
        { groupBy: "tags" },
        { path: context.pmPath },
      );
      expect(result.totals.items_considered).toBe(10_000);
      expect(result.totals.items_grouped).toBe(10_000);
      expect(result).toMatchObject({
        count: 61,
        returned_count: 50,
        truncated: true,
      });
      const remaining = await runAggregate(
        { groupBy: "tags", after: result.next_after! },
        { path: context.pmPath },
      );
      expect(remaining).toMatchObject({ returned_count: 11, truncated: false });
      expect(
        [...result.groups, ...remaining.groups].reduce(
          (sum, row) => sum + row.count,
          0,
        ),
      ).toBe(10_000);
    });
  });
});
