import { describe, expect, it } from "vitest";
import { withTempPmPath, type TempPmContext } from "../helpers/withTempPmPath.js";

function createItem(
  context: TempPmContext,
  params: {
    title: string;
    type?: "Feature" | "Task" | "Issue";
    status?: "open" | "closed";
    parent?: string;
  },
): string {
  const args = [
    "create",
    "--json",
    "--title",
    params.title,
    "--description",
    `${params.title} description`,
    "--type",
    params.type ?? "Task",
    "--status",
    params.status ?? "open",
    "--priority",
    "1",
    "--tags",
    "integration,aggregate,dedupe",
    "--body",
    "",
    "--deadline",
    "none",
    "--estimate",
    "10",
    "--acceptance-criteria",
    `${params.title} acceptance`,
    "--author",
    "integration-author",
    "--message",
    `Create ${params.title}`,
    "--assignee",
    "none",
    "--dep",
    "none",
    "--comment",
    "none",
    "--note",
    "none",
    "--learning",
    "none",
    "--file",
    "none",
    "--test",
    "none",
    "--doc",
    "none",
  ];
  if (params.parent) {
    args.push("--parent", params.parent);
  }
  const created = context.runCli(args, { expectJson: true });
  expect(created.code).toBe(0);
  return (created.json as { item: { id: string } }).item.id;
}

describe("aggregate and dedupe-audit CLI integration", () => {
  it("runs aggregate grouped counts from CLI", async () => {
    await withTempPmPath(async (context) => {
      const parentId = createItem(context, { title: "Aggregate Parent", type: "Feature" });
      createItem(context, { title: "Aggregate Child Task", type: "Task", parent: parentId });
      createItem(context, { title: "Aggregate Child Issue", type: "Issue", parent: parentId });

      const aggregate = context.runCli(["aggregate", "--json", "--group-by", "parent,type", "--count"], { expectJson: true });
      expect(aggregate.code).toBe(0);
      const payload = aggregate.json as {
        count: number;
        groups: Array<{ group: { parent: string | null; type: string }; count: number }>;
        filters: { group_by: string[]; count: boolean };
      };
      expect(payload.filters.group_by).toEqual(["parent", "type"]);
      expect(payload.filters.count).toBe(true);
      expect(payload.count).toBe(2);
      expect(payload.groups).toEqual([
        {
          group: {
            parent: parentId,
            type: "Issue",
          },
          count: 1,
        },
        {
          group: {
            parent: parentId,
            type: "Task",
          },
          count: 1,
        },
      ]);
    });
  });

  it("runs dedupe-audit exact mode from CLI", async () => {
    await withTempPmPath(async (context) => {
      createItem(context, { title: "Deduplicate this title", type: "Task" });
      createItem(context, { title: "deduplicate this title", type: "Task" });
      createItem(context, { title: "Different title", type: "Task" });

      const dedupe = context.runCli(["dedupe-audit", "--json", "--mode", "title_exact"], { expectJson: true });
      expect(dedupe.code).toBe(0);
      const payload = dedupe.json as {
        mode: string;
        count: number;
        clusters: Array<{ cluster_size: number; merge_suggestions: Array<{ suggested_command: string }> }>;
      };
      expect(payload.mode).toBe("title_exact");
      expect(payload.count).toBe(1);
      expect(payload.clusters[0]?.cluster_size).toBe(2);
      expect(payload.clusters[0]?.merge_suggestions[0]?.suggested_command).toContain("pm close");
    });
  });
});
