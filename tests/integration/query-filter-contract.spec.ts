import { describe, expect, it } from "vitest";
import { runAggregate } from "../../src/sdk/query/aggregate.js";
import { runList } from "../../src/sdk/query/list.js";
import { runUpdateMany } from "../../src/sdk/lifecycle/update-many.js";
import {
  withTempPmPath,
  type TempPmContext,
} from "../helpers/withTempPmPath.js";

function createFilterFixture(
  context: TempPmContext,
  params: {
    title: string;
    type: "Task" | "Issue";
    status: "open" | "closed";
    priority: number;
    tags: string;
    assignee: string;
    sprint: string;
    release: string;
  },
): string {
  const result = context.runCli(
    [
      "create",
      "--title",
      params.title,
      "--description",
      `${params.title} description`,
      "--type",
      params.type,
      "--status",
      params.status,
      "--priority",
      String(params.priority),
      "--tags",
      params.tags,
      "--body",
      "",
      "--deadline",
      "none",
      "--estimate",
      "15",
      "--acceptance-criteria",
      `${params.title} acceptance`,
      "--assignee",
      params.assignee,
      "--sprint",
      params.sprint,
      "--release",
      params.release,
      "--author",
      "query-contract-test",
      "--message",
      `Create ${params.title}`,
      "--json",
    ],
    { expectJson: true },
  );
  expect(result.code).toBe(0);
  return (result.json as { item: { id: string } }).item.id;
}

describe("universal query-filter scripting contract", () => {
  it("keeps all-status scope truthful and OR filters uniform across read and bulk surfaces", async () => {
    await withTempPmPath(async (context) => {
      const openId = createFilterFixture(context, {
        title: "Universal Filter Open",
        type: "Task",
        status: "open",
        priority: 0,
        tags: "alpha",
        assignee: "alice",
        sprint: "sprint-a",
        release: "release-a",
      });
      const closedId = createFilterFixture(context, {
        title: "Universal Filter Closed",
        type: "Issue",
        status: "closed",
        priority: 4,
        tags: '["customer,success"]',
        assignee: "bob",
        sprint: "sprint-b",
        release: "release-b",
      });

      const plainList = context.runCli(["list", "--brief", "--json"], {
        expectJson: true,
      });
      expect(plainList.code).toBe(0);
      expect(plainList.json).toMatchObject({
        total: 2,
        count: 2,
        has_more: false,
        filters: { status: "all" },
      });

      const listed = await runList(
        undefined,
        {
          status: "open,closed",
          type: "Task,Issue",
          priority: "0,4",
          assignee: "alice,bob",
          sprint: "sprint-a,sprint-b",
          release: "release-a,release-b",
          full: true,
        },
        { path: context.pmPath },
      );
      expect(listed.items.map((item) => item.id).sort()).toEqual(
        [openId, closedId].sort(),
      );

      const repeatedCliFilters = context.runCli(
        [
          "list",
          "--type",
          "Task",
          "--type",
          "Issue",
          "--priority",
          "0",
          "--priority",
          "4",
          "--brief",
          "--json",
        ],
        { expectJson: true },
      );
      expect(repeatedCliFilters.code).toBe(0);
      expect(
        (repeatedCliFilters.json as { items: Array<{ id: string }> }).items
          .map((item) => item.id)
          .sort(),
      ).toEqual([openId, closedId].sort());

      const escapedTag = await runList(
        undefined,
        { tag: String.raw`customer\,success`, full: true },
        { path: context.pmPath },
      );
      expect(escapedTag.items.map((item) => item.id)).toEqual([closedId]);

      const aggregate = await runAggregate(
        {
          groupBy: "status",
          status: "open,closed",
          type: "Task,Issue",
          priority: "0,4",
        },
        { path: context.pmPath },
      );
      expect(aggregate.filters).toMatchObject({
        status: "open",
        status_values: ["open", "closed"],
      });
      expect(aggregate.totals.items_considered).toBe(2);

      const updatePreview = await runUpdateMany(
        {
          status: "open,closed",
          list: { type: "Task,Issue" },
          update: { priority: "2" },
          dryRun: true,
        },
        { path: context.pmPath },
      );
      expect(updatePreview.matched_count).toBe(2);
      expect(updatePreview.ids).toEqual([]);

      const repeatedBulkFilters = context.runCli(
        [
          "update-many",
          "--filter-status",
          "open",
          "--filter-status",
          "closed",
          "--filter-type",
          "Task",
          "--filter-type",
          "Issue",
          "--priority",
          "2",
          "--dry-run",
          "--json",
        ],
        { expectJson: true },
      );
      expect(repeatedBulkFilters.code).toBe(0);
      expect(repeatedBulkFilters.json).toMatchObject({
        matched_count: 2,
        dry_run: true,
        ids: [],
      });
    });
  });
});
