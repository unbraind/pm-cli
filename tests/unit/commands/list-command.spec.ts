import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { _testOnly as listInternals, runList } from "../../../src/cli/commands/list.js";
import { resolveRuntimeStatusRegistry } from "../../../src/core/schema/runtime-schema.js";
import { EXIT_CODE, SETTINGS_DEFAULTS } from "../../../src/core/shared/constants.js";
import { PmCliError } from "../../../src/core/shared/errors.js";
import { withTempPmPath, type TempPmContext } from "../../helpers/withTempPmPath.js";

function createItem(context: TempPmContext, params: {
  title: string;
  status: "open" | "triage" | "blocked" | "closed";
  priority: string;
  tags: string;
  deadline: string;
  assignee?: string;
  parent?: string;
  sprint?: string;
  release?: string;
  body?: string;
}): string {
  const args = [
    "create",
    "--json",
    "--title",
    params.title,
    "--description",
    `${params.title} description`,
    "--type",
    "Task",
    "--status",
    params.status,
    "--priority",
    params.priority,
    "--tags",
    params.tags,
    "--body",
    params.body ?? "",
    "--deadline",
    params.deadline,
    "--estimate",
    "15",
    "--acceptance-criteria",
    `${params.title} acceptance`,
    "--author",
    "test-author",
    "--message",
    `Create ${params.title}`,
    "--assignee",
    params.assignee ?? "seed-assignee",
    "--dep",
    "id=pm-seed-related,kind=related,author=seed-author,created_at=now",
    "--comment",
    "author=seed-author,created_at=now,text=seed comment",
    "--note",
    "author=seed-author,created_at=now,text=seed note",
    "--learning",
    "author=seed-author,created_at=now,text=seed learning",
    "--file",
    "path=README.md,scope=project,note=seed file",
    "--test",
    "command=node dist/cli.js --version,scope=project,note=seed test",
    "--doc",
    "path=README.md,scope=project,note=seed doc",
  ];
  if (params.sprint !== undefined) {
    args.push("--sprint", params.sprint);
  }
  if (params.parent !== undefined) {
    args.push("--parent", params.parent);
  }
  if (params.release !== undefined) {
    args.push("--release", params.release);
  }
  const result = context.runCli(args, { expectJson: true });
  expect(result.code).toBe(0);
  return (result.json as { item: { id: string } }).item.id;
}

describe("runList", () => {
  it("covers list helper branches for projection, filters, sorting, and tree metadata", () => {
    const statusRegistry = resolveRuntimeStatusRegistry(SETTINGS_DEFAULTS.schema);
    const openItem = {
      id: "pm-open",
      title: "Open",
      status: "open",
      type: "Task",
      priority: 1,
      tags: [],
      parent: "",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-02T00:00:00.000Z",
      deadline: null,
    };
    const closedItem = {
      ...openItem,
      id: "pm-closed",
      title: "Closed",
      status: "closed",
      priority: 0,
      updated_at: "2026-01-03T00:00:00.000Z",
    };

    expect(listInternals.parseIdsFilter(" pm-a, ,pm-b ")).toEqual(new Set(["pm-a", "pm-b"]));
    expect(() => listInternals.parseIdsFilter(" , ")).toThrow(PmCliError);
    expect(listInternals.parseOffset("2")).toBe(2);
    expect(() => listInternals.parseOffset("-1")).toThrow(PmCliError);
    expect(listInternals.resolveListPageLimit({}, 9_999)).toBeUndefined();
    expect(listInternals.resolveListPageLimit({}, 10_000)).toBe(20);
    expect(listInternals.resolveListPageLimit({ limit: "7" }, 10_000)).toBe(7);
    expect(listInternals.parseFieldSelectors("id,item.title,id")).toEqual(["id", "item.title"]);
    expect(() => listInternals.parseFieldSelectors(" , ")).toThrow(PmCliError);
    expect(listInternals.runtimeMetadataKeysForProjection([{ metadata_key: "severity" }, { metadata_key: "owner" }])).toEqual([
      "severity",
      "owner",
    ]);
    expect(listInternals.parseProjectionConfig({ brief: true })).toEqual({ mode: "compact", fields: ["id", "status", "type", "title"] });
    expect(() => listInternals.parseProjectionConfig({ brief: true, full: true })).toThrow(PmCliError);
    expect(listInternals.normalizeProjectionField("item.title")).toBe("title");
    expect(listInternals.parseSortField("updated")).toBe("updated_at");
    expect(() => listInternals.parseSortField("bad")).toThrow(PmCliError);
    expect(listInternals.parseSortOrder("DESC")).toBe("desc");
    expect(() => listInternals.parseSortOrder("sideways")).toThrow(PmCliError);
    expect(listInternals.parseAssigneeFilter("assigned")).toBe("assigned");
    expect(() => listInternals.parseAssigneeFilter("   ")).toThrow(PmCliError);
    expect(() => listInternals.parseAssigneeFilter("nobody")).toThrow(PmCliError);

    expect(listInternals.compareNullableString(null, "a")).toBe(1);
    expect(listInternals.compareNullableString("a", null)).toBe(-1);
    expect(listInternals.compareNullableString("same", "same")).toBe(0);
    expect(listInternals.compareNullableString("b", "a")).toBeGreaterThan(0);
    expect(listInternals.compareNullableTimestamp(null, "2026-01-01T00:00:00.000Z")).toBe(1);
    expect(listInternals.compareNullableTimestamp("2026-01-01T00:00:00.000Z", null)).toBe(-1);
    expect(listInternals.compareNullableTimestamp("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z")).toBe(0);
    expect(listInternals.trimNonEmpty(undefined)).toBeUndefined();
    expect(
      listInternals.compareBySortField(
        { ...openItem, deadline: null } as never,
        { ...closedItem, deadline: "2026-01-01T00:00:00.000Z" } as never,
        "deadline",
      ),
    ).toBe(1);
    expect(listInternals.compareBySortField(openItem as never, closedItem as never, "updated_at")).toBeLessThan(0);
    expect(listInternals.compareBySortField(openItem as never, closedItem as never, "created_at")).toBe(0);
    expect(listInternals.compareBySortField(openItem as never, closedItem as never, "title")).toBeGreaterThan(0);
    expect(
      listInternals.compareBySortField(
        { ...openItem, id: "pm-title-a", title: undefined } as never,
        { ...openItem, id: "pm-title-b", title: undefined } as never,
        "title",
      ),
    ).toBe(0);
    expect(listInternals.compareBySortField(openItem as never, closedItem as never, "parent")).toBe(0);
    expect(listInternals.compareBySortField(openItem as never, closedItem as never, "unknown" as never)).toBe(0);
    expect(listInternals.compareDefaultSort(closedItem as never, openItem as never, statusRegistry)).toBe(1);
    expect(
      listInternals.compareDefaultSort(
        { ...openItem, id: undefined } as never,
        { ...openItem, id: undefined } as never,
        statusRegistry,
      ),
    ).toBe(0);
    expect(listInternals.sortItems([closedItem, openItem] as never, undefined, "asc", statusRegistry).map((item) => item.id)).toEqual([
      "pm-open",
      "pm-closed",
    ]);
    expect(
      listInternals.sortItems(
        [
          { ...openItem, id: "pm-b", title: "Same", priority: 1, deadline: "2026-01-01T00:00:00.000Z" },
          { ...openItem, id: "pm-a", title: "Same", priority: 1, deadline: "2026-01-01T00:00:00.000Z" },
        ] as never,
        "deadline",
        "desc",
        statusRegistry,
      ).map((item) => item.id),
    ).toEqual(["pm-b", "pm-a"]);
    expect(listInternals.withTreeMetadata({ ...openItem, parent: "  " } as never, 2, 0)).toMatchObject({
      tree_depth: 2,
      tree_parent: null,
      tree_title: "    Open",
    });
    expect(listInternals.withTreeMetadata({ ...openItem, parent: 42 } as never, 1, 0)).toMatchObject({
      tree_depth: 1,
      tree_parent: null,
    });
    expect(listInternals.withTreeMetadata({ ...openItem, title: 42 } as never, 0, 0)).toMatchObject({
      tree_title: "",
    });
    expect(listInternals.readListFieldValue({ ...openItem, tree_title: "Tree" } as never, "item.title", true)).toBe("Tree");
    expect(listInternals.readListFieldValue(openItem as never, "   ")).toBeNull();
    expect(
      listInternals.readListFieldValue(
        { ...openItem, id: "pm-custom", custom_field: undefined } as never,
        "custom_field",
      ),
    ).toBeNull();
    expect(listInternals.projectListItems([openItem] as never, { mode: "full", fields: [] })).toEqual([openItem]);
    expect(listInternals.projectListItems([openItem] as never, { mode: "fields", fields: ["id", "missing"] })).toEqual([
      { id: "pm-open", missing: null },
    ]);
    expect(
      listInternals.orderItemsAsTree(
        [
          { ...openItem, id: "pm-root", title: "Root", parent: "" },
          { ...openItem, id: "pm-child", title: "Child", parent: "pm-root" },
          { ...openItem, id: "pm-grandchild", title: "Grandchild", parent: "pm-child" },
        ] as never,
        undefined,
        1,
      ).map((item) => [item.id, item.tree_depth, item.tree_children]),
    ).toEqual([
      ["pm-root", 0, 1],
      ["pm-child", 1, 1],
    ]);
    expect(
      listInternals.orderItemsAsTree(
        [
          { ...openItem, id: "pm-root", title: "Root", parent: "" },
          { ...openItem, id: "pm-child", title: "Child", parent: "pm-root" },
        ] as never,
        "pm-root",
        undefined,
      ).map((item) => item.id),
    ).toEqual(["pm-child"]);
    expect(
      listInternals.orderItemsAsTree(
        [
          { ...openItem, id: "pm-a", title: "A", parent: "pm-b" },
          { ...openItem, id: "pm-b", title: "B", parent: "pm-a" },
          { ...openItem, id: "pm-orphan", title: "Orphan", parent: "pm-missing" },
        ] as never,
        "pm-a",
        undefined,
      ).map((item) => item.id),
    ).toEqual(["pm-b", "pm-a"]);
    expect(
      listInternals.buildCompactListFilterSummary({
        filtersStatus: ["open", "blocked"],
        options: {
          type: "Task",
          tag: "unit",
          priority: "2",
          deadlineBefore: "2026-02-01T00:00:00.000Z",
          deadlineAfter: "2026-01-01T00:00:00.000Z",
          updatedAfter: "2026-01-02T00:00:00.000Z",
          updatedBefore: "2026-01-03T00:00:00.000Z",
          createdAfter: "2026-01-04T00:00:00.000Z",
          createdBefore: "2026-01-05T00:00:00.000Z",
          ids: "pm-a,pm-b",
          assignee: "alice",
          assigneeFilter: "assigned",
          parent: "pm-parent",
          sprint: "sprint-1",
          release: "v1",
          filterAcMissing: true,
          filterEstimatesMissing: true,
          filterResolutionMissing: true,
          filterMetadataMissing: true,
          limit: "5",
          offset: "10",
          includeBody: true,
          fields: "id,title",
        },
        treeEnabled: true,
        treeDepth: undefined,
        sortField: "updated_at",
        sortOrder: "desc",
        runtimeFieldFilters: { severity: "high" },
      }),
    ).toMatchObject({
      status: ["open", "blocked"],
      type: "Task",
      tag: "unit",
      priority: "2",
      deadline_before: "2026-02-01T00:00:00.000Z",
      deadline_after: "2026-01-01T00:00:00.000Z",
      updated_after: "2026-01-02T00:00:00.000Z",
      updated_before: "2026-01-03T00:00:00.000Z",
      created_after: "2026-01-04T00:00:00.000Z",
      created_before: "2026-01-05T00:00:00.000Z",
      ids: "pm-a,pm-b",
      assignee: "alice",
      assignee_filter: "assigned",
      parent: "pm-parent",
      sprint: "sprint-1",
      release: "v1",
      filter_ac_missing: true,
      filter_estimates_missing: true,
      filter_resolution_missing: true,
      filter_metadata_missing: true,
      limit: "5",
      offset: "10",
      include_body: true,
      fields: "id,title",
      tree: true,
      sort: "updated_at",
      order: "desc",
      runtime_filters: { severity: "high" },
    });

    const permissiveTypeRegistry = { type_to_folder: new Map<string, string>() };
    expect(
      listInternals.applyFilters(
        [{ ...openItem }],
        undefined,
        { updatedAfter: "2026-02-01T00:00:00.000Z" },
        permissiveTypeRegistry as never,
        statusRegistry,
        {},
      ),
    ).toEqual([]);
    expect(
      listInternals.applyFilters(
        [{ ...openItem, tags: undefined }],
        undefined,
        { tag: "missing-legacy-tag" },
        permissiveTypeRegistry as never,
        statusRegistry,
        {},
      ),
    ).toEqual([]);
    expect(
      listInternals.applyFilters(
        [{ ...openItem }],
        undefined,
        { updatedBefore: "2026-01-01T00:00:00.000Z" },
        permissiveTypeRegistry as never,
        statusRegistry,
        {},
      ),
    ).toEqual([]);
    expect(
      listInternals.applyFilters(
        [{ ...openItem }],
        undefined,
        { createdAfter: "2026-02-01T00:00:00.000Z" },
        permissiveTypeRegistry as never,
        statusRegistry,
        {},
      ),
    ).toEqual([]);
    expect(
      listInternals.applyFilters(
        [{ ...openItem }],
        undefined,
        { createdBefore: "2025-12-31T00:00:00.000Z" },
        permissiveTypeRegistry as never,
        statusRegistry,
        {},
      ),
    ).toEqual([]);
    expect(
      listInternals.applyFilters(
        [{ ...openItem }],
        undefined,
        { assigneeFilter: "assigned" },
        permissiveTypeRegistry as never,
        statusRegistry,
        {},
      ),
    ).toEqual([]);
    expect(
      listInternals.applyFilters(
        [
          {
            ...openItem,
            acceptance_criteria: "ready",
            estimated_minutes: 15,
            author: "agent",
          } as never,
        ],
        undefined,
        { filterAcMissing: true },
        permissiveTypeRegistry as never,
        statusRegistry,
        {},
      ),
    ).toEqual([]);
    expect(
      listInternals.applyFilters(
        [{ ...openItem }],
        undefined,
        {},
        permissiveTypeRegistry as never,
        statusRegistry,
        { severity: "high" },
      ),
    ).toEqual([]);
    expect(
      listInternals.orderItemsAsTree(
        [
          { ...openItem, id: "pm-root-2", parent: "" },
          { ...openItem, id: "pm-child-a", parent: "pm-root-2" },
          { ...openItem, id: "pm-child-b", parent: "pm-root-2" },
        ] as never,
        undefined,
        undefined,
      ).map((item) => item.id),
    ).toEqual(["pm-root-2", "pm-child-a", "pm-child-b"]);
    expect(
      listInternals.orderItemsAsTree(
        [
          { ...openItem, id: "pm-tree-root", parent: "" },
          { ...openItem, id: "pm-tree-child", parent: "pm-tree-root" },
        ] as never,
        "pm-missing",
        undefined,
      ),
    ).toEqual([]);
    expect(
      listInternals.sortItems(
        [
          { ...openItem, id: "pm-fallback-2", title: "Same", updated_at: "2026-01-03T00:00:00.000Z" },
          { ...openItem, id: "pm-fallback-1", title: "Same", updated_at: "2026-01-02T00:00:00.000Z" },
        ] as never,
        "title",
        "desc",
        statusRegistry,
      ).map((item) => item.id),
    ).toEqual(["pm-fallback-1", "pm-fallback-2"]);
    expect(
      listInternals.sortItems(
        [
          { ...openItem, id: "pm-fallback-2", title: "Same", updated_at: "2026-01-03T00:00:00.000Z" },
          { ...openItem, id: "pm-fallback-1", title: "Same", updated_at: "2026-01-02T00:00:00.000Z" },
        ] as never,
        "title",
        "asc",
        statusRegistry,
      ).map((item) => item.id),
    ).toEqual(["pm-fallback-2", "pm-fallback-1"]);
  });

  it("covers tree-depth and warning projection branches in runList output", async () => {
    await withTempPmPath(async (context) => {
      const rootId = createItem(context, {
        title: "Tree Root",
        status: "open",
        priority: "1",
        tags: "tree-branches",
        deadline: "2026-06-10T10:00:00.000Z",
      });
      createItem(context, {
        title: "Tree Child",
        status: "open",
        priority: "2",
        tags: "tree-branches",
        deadline: "2026-06-11T10:00:00.000Z",
        parent: rootId,
      });

      const tasksDir = path.join(context.pmPath, "tasks");
      await writeFile(path.join(tasksDir, "invalid-a.toon"), "id: invalid-a\nstatus: open\n", "utf8");
      await writeFile(path.join(tasksDir, "invalid-b.toon"), "this is not toon front matter\n", "utf8");

      const fullResult = await runList(
        undefined,
        {
          tree: true,
          treeDepth: "2",
          filterAcMissing: true,
          filterEstimatesMissing: true,
          filterResolutionMissing: true,
          filterMetadataMissing: true,
        },
        { path: context.pmPath },
      );
      expect(fullResult.filters).toMatchObject({
        tree: true,
        tree_depth: 2,
        filter_ac_missing: true,
        filter_estimates_missing: true,
        filter_resolution_missing: true,
        filter_metadata_missing: true,
      });
      expect(fullResult.warnings?.length ?? 0).toBeGreaterThanOrEqual(2);
      expect(fullResult.warnings).toEqual([...(fullResult.warnings ?? [])].sort((left, right) => left.localeCompare(right)));

      const compactResult = await runList(
        undefined,
        {
          compact: true,
          tree: true,
          treeDepth: "1",
        },
        { path: context.pmPath },
      );
      expect(compactResult.filters).toMatchObject({
        tree: true,
        tree_depth: 1,
      });
      expect(compactResult.warnings?.length ?? 0).toBeGreaterThanOrEqual(2);
      expect(compactResult.warnings).toEqual([...(compactResult.warnings ?? [])].sort((left, right) => left.localeCompare(right)));

      const fullTreeWithoutDepth = await runList(
        undefined,
        {
          tree: true,
        },
        { path: context.pmPath },
      );
      expect(fullTreeWithoutDepth.filters).toMatchObject({
        tree: true,
        tree_depth: null,
      });
    });
  });

  it("treats null programmatic date and id filters as omitted", async () => {
    await withTempPmPath(async (context) => {
      createItem(context, {
        title: "Null Programmatic Filters",
        status: "open",
        priority: "2",
        tags: "null-programmatic",
        deadline: "2026-06-10T10:00:00.000Z",
      });

      const result = await runList(
        undefined,
        {
          updatedAfter: null as unknown as string,
          updatedBefore: null as unknown as string,
          createdAfter: null as unknown as string,
          createdBefore: null as unknown as string,
          ids: null as unknown as string,
          tag: "null-programmatic",
        },
        { path: context.pmPath },
      );

      expect(result.count).toBe(1);
    });
  });

  it("treats empty programmatic date filters as omitted", async () => {
    await withTempPmPath(async (context) => {
      createItem(context, {
        title: "Empty Programmatic Filters",
        status: "open",
        priority: "2",
        tags: "empty-programmatic",
        deadline: "2026-06-10T10:00:00.000Z",
      });

      const result = await runList(
        undefined,
        {
          updatedAfter: "",
          updatedBefore: "   ",
          createdAfter: "",
          createdBefore: "   ",
          tag: "empty-programmatic",
        },
        { path: context.pmPath },
      );

      expect(result.count).toBe(1);
    });
  });

  it("rejects explicit blank id filters", async () => {
    await withTempPmPath(async (context) => {
      createItem(context, {
        title: "Blank Id Filter",
        status: "open",
        priority: "2",
        tags: "blank-ids",
        deadline: "2026-06-10T10:00:00.000Z",
      });

      await expect(
        runList(
          undefined,
          {
            ids: "   ",
            tag: "blank-ids",
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: "--ids requires at least one non-empty item ID",
      });
    });
  });

  it("filters list results by explicit --ids from the CLI", async () => {
    await withTempPmPath(async (context) => {
      const firstId = createItem(context, {
        title: "IDs Alpha",
        status: "open",
        priority: "1",
        tags: "ids,list",
        deadline: "+1d",
      });
      const secondId = createItem(context, {
        title: "IDs Beta",
        status: "open",
        priority: "1",
        tags: "ids,list",
        deadline: "+1d",
      });
      createItem(context, {
        title: "IDs Gamma",
        status: "open",
        priority: "1",
        tags: "ids,list",
        deadline: "+1d",
      });

      const ids = `${firstId},${secondId}`;
      const result = context.runCli(["list", "--ids", ids, "--json"], { expectJson: true });
      expect(result.code).toBe(0);
      const payload = result.json as { count: number; filters: Record<string, unknown>; items: Array<{ id: string }> };
      expect(payload.count).toBe(2);
      expect(payload.items.map((item) => item.id).sort()).toEqual([firstId, secondId].sort());
      expect(payload.filters.ids).toBe(ids);

      const miss = context.runCli(["list", "--ids", "pm-missing", "--json"], { expectJson: true });
      expect(miss.code).toBe(0);
      expect((miss.json as { count: number }).count).toBe(0);

      const noIds = context.runCli(["list", "--json"], { expectJson: true });
      expect(noIds.code).toBe(0);
      expect((noIds.json as { filters: Record<string, unknown> }).filters.ids).toBeNull();
    });
  });

  it("filters list-open status by explicit ids before projection", async () => {
    await withTempPmPath(async (context) => {
      const firstId = createItem(context, {
        title: "Repeated IDs Alpha",
        status: "open",
        priority: "1",
        tags: "ids,repeat",
        deadline: "+1d",
      });
      const secondId = createItem(context, {
        title: "Repeated IDs Beta",
        status: "open",
        priority: "1",
        tags: "ids,repeat",
        deadline: "+1d",
      });
      createItem(context, {
        title: "Repeated IDs Gamma",
        status: "open",
        priority: "1",
        tags: "ids,repeat",
        deadline: "+1d",
      });

      const ids = `${firstId},${secondId}`;
      const result = await runList("open", { ids, brief: true }, { path: context.pmPath });

      expect(result.count).toBe(2);
      expect(result.items.map((item) => item.id).sort()).toEqual([firstId, secondId].sort());
      expect(result.filters.ids).toBe(ids);
      expect(result.filters.status).toBe("open");
      expect(result.projection).toEqual({ mode: "compact", fields: ["id", "status", "type", "title"] });
    });
  });

  it("fails when tracker is not initialized", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pm-list-not-init-"));
    try {
      await expect(runList(undefined, {}, { path: tempDir })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("applies status/field filters and limit", async () => {
    await withTempPmPath(async (context) => {
      createItem(context, {
        title: "Open Alpha",
        status: "open",
        priority: "0",
        tags: "alpha,core",
        deadline: "+1d",
      });
      createItem(context, {
        title: "Blocked Beta",
        status: "blocked",
        priority: "2",
        tags: "beta",
        deadline: "+2d",
      });
      createItem(context, {
        title: "Closed Gamma",
        status: "closed",
        priority: "1",
        tags: "gamma",
        deadline: "+3d",
      });

      const openResult = await runList(
        "open",
        { type: "Task", tag: "alpha", priority: "0", limit: "1" },
        { path: context.pmPath },
      );
      expect(openResult.count).toBe(1);
      expect(openResult.items[0].status).toBe("open");
      expect(openResult.items[0].tags).toContain("alpha");
      expect(openResult.filters.limit).toBe("1");

      const blockedResult = await runList("blocked", {}, { path: context.pmPath });
      expect(blockedResult.count).toBe(1);
      expect(blockedResult.items[0].status).toBe("blocked");

      const offsetResult = await runList(undefined, { offset: "1", limit: "1" }, { path: context.pmPath });
      expect(offsetResult.count).toBe(1);
      expect(offsetResult.items[0].title).toBe("Blocked Beta");
      expect(offsetResult.filters.offset).toBe("1");
      expect(offsetResult.filters.limit).toBe("1");

      const deadlineFiltered = await runList(
        undefined,
        { deadlineBefore: "+2d", deadlineAfter: "+1d" },
        { path: context.pmPath },
      );
      expect(deadlineFiltered.count).toBeGreaterThanOrEqual(1);

      const flexibleDateString = await runList(
        undefined,
        { deadlineBefore: "2030-01-01T00-00Z" },
        { path: context.pmPath },
      );
      expect(flexibleDateString.count).toBe(3);

      const monthRelativeFilter = await runList(undefined, { deadlineAfter: "+1m" }, { path: context.pmPath });
      expect(monthRelativeFilter.count).toBe(0);
    });
  });

  it("maps list-open filters to workflow open_status", async () => {
    await withTempPmPath(async (context) => {
      const statusesPath = path.join(context.pmPath, "schema", "statuses.json");
      const workflowsPath = path.join(context.pmPath, "schema", "workflows.json");
      await writeFile(
        statusesPath,
        `${JSON.stringify(
          {
            statuses: [
              { id: "draft", roles: ["draft"] },
              { id: "triage", roles: ["active", "default_open"] },
              { id: "open", roles: ["active"] },
              { id: "in_progress", roles: ["active"] },
              { id: "blocked", roles: ["blocked"] },
              { id: "closed", roles: ["terminal", "terminal_done", "default_close"] },
              { id: "canceled", roles: ["terminal", "terminal_canceled", "default_cancel"] },
            ],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await writeFile(
        workflowsPath,
        `${JSON.stringify(
          {
            workflow: {
              draft_status: "draft",
              open_status: "triage",
              in_progress_status: "in_progress",
              blocked_status: "blocked",
              close_status: "closed",
              canceled_status: "canceled",
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      createItem(context, {
        title: "Workflow Triage Item",
        status: "triage",
        priority: "1",
        tags: "workflow,triage",
        deadline: "+1d",
      });
      createItem(context, {
        title: "Workflow Open Item",
        status: "open",
        priority: "1",
        tags: "workflow,open",
        deadline: "+1d",
      });

      const openResult = await runList("open", {}, { path: context.pmPath });
      expect(openResult.count).toBe(1);
      expect(openResult.items[0].status).toBe("triage");
      expect(openResult.items[0].title).toBe("Workflow Triage Item");
      expect(openResult.filters.status).toBe("triage");
    });
  });

  it("includes item body only when includeBody is enabled", async () => {
    await withTempPmPath(async (context) => {
      createItem(context, {
        title: "Body Projection",
        status: "open",
        priority: "1",
        tags: "body,test",
        deadline: "+1d",
        body: "Projected list body",
      });

      const withoutBody = await runList("open", {}, { path: context.pmPath });
      expect(withoutBody.count).toBe(1);
      expect(withoutBody.filters.include_body).toBeNull();
      expect(withoutBody.items[0]).not.toHaveProperty("body");

      const withBody = await runList("open", { includeBody: true }, { path: context.pmPath });
      expect(withBody.count).toBe(1);
      expect(withBody.filters.include_body).toBe(true);
      expect(withBody.items[0]).toHaveProperty("body", "Projected list body");
    });
  });

  it("applies an active content filter in-process, keeping matches and excluding non-matches", async () => {
    await withTempPmPath(async (context) => {
      // createItem always seeds notes; differentiate on body so hasBody/emptyBody
      // split the two items. WithBody matches --has-body (kept); EmptyBody does not (excluded).
      createItem(context, {
        title: "WithBody",
        status: "open",
        priority: "1",
        tags: "content",
        deadline: "+1d",
        body: "real body content",
      });
      createItem(context, {
        title: "EmptyBody",
        status: "open",
        priority: "1",
        tags: "content",
        deadline: "+1d",
        // body omitted -> empty string
      });

      // Active content filter + item matches (kept) AND item does not match (excluded).
      const hasBody = await runList(undefined, { hasBody: true }, { path: context.pmPath });
      expect(hasBody.items.map((item) => item.title).sort()).toEqual(["WithBody"]);

      // Opposite content predicate flips which item is kept vs excluded.
      const emptyBody = await runList(undefined, { emptyBody: true }, { path: context.pmPath });
      expect(emptyBody.items.map((item) => item.title).sort()).toEqual(["EmptyBody"]);
    });
  });

  it("excludes terminal statuses when excludeTerminal is true", async () => {
    await withTempPmPath(async (context) => {
      createItem(context, {
        title: "Open Item",
        status: "open",
        priority: "1",
        tags: "test",
        deadline: "+1d",
      });
      createItem(context, {
        title: "Blocked Item",
        status: "blocked",
        priority: "2",
        tags: "test",
        deadline: "+2d",
      });
      createItem(context, {
        title: "Closed Item",
        status: "closed",
        priority: "0",
        tags: "test",
        deadline: "+3d",
      });

      // excludeTerminal=true: should exclude closed and blocked is still shown
      const activeOnly = await runList(undefined, { excludeTerminal: true }, { path: context.pmPath });
      expect(activeOnly.count).toBe(2);
      expect(activeOnly.items.every((item) => item.status !== "closed" && item.status !== "canceled")).toBe(true);

      // excludeTerminal=false (or undefined): should include all items
      const allItems = await runList(undefined, {}, { path: context.pmPath });
      expect(allItems.count).toBe(3);

      // status filter takes precedence over excludeTerminal (status filter is exact match)
      const closedExplicit = await runList("closed", { excludeTerminal: true }, { path: context.pmPath });
      expect(closedExplicit.count).toBe(0);

      // explicit --status on bare list should override active-only default filtering
      const closedViaStatusOption = await runList(undefined, { status: "closed", excludeTerminal: true }, { path: context.pmPath });
      expect(closedViaStatusOption.count).toBe(1);
      expect(closedViaStatusOption.items[0].status).toBe("closed");

      // --status all is also explicit: keep every lifecycle bucket while echoing
      // the caller intent instead of falling back to the active-only default.
      const allViaStatusOption = await runList(undefined, { status: "all", excludeTerminal: true }, { path: context.pmPath });
      expect(allViaStatusOption.count).toBe(3);
      expect(allViaStatusOption.filters.status).toBe("all");
    });
  });

  it("validates filter values", async () => {
    await withTempPmPath(async (context) => {
      await expect(runList(undefined, { priority: "8" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(
        runList(undefined, { priority: "1.5" }, { path: context.pmPath }),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(
        runList(undefined, { deadlineBefore: "bad-deadline" }, { path: context.pmPath }),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(
        runList(undefined, { type: "NotAType" }, { path: context.pmPath }),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(runList(undefined, { limit: "-1" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(
        runList(undefined, { limit: "1.25" }, { path: context.pmPath }),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(runList(undefined, { offset: "-1" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(
        runList(undefined, { offset: "1.5" }, { path: context.pmPath }),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
    });
  });

  it("applies non-matching type/tag/priority filters", async () => {
    await withTempPmPath(async (context) => {
      createItem(context, {
        title: "Filter Target",
        status: "open",
        priority: "1",
        tags: "alpha,core",
        deadline: "+1d",
      });

      const wrongType = await runList(undefined, { type: "Issue" }, { path: context.pmPath });
      expect(wrongType.count).toBe(0);

      const normalizedType = await runList(undefined, { type: "task" }, { path: context.pmPath });
      expect(normalizedType.count).toBe(1);

      const wrongTag = await runList(undefined, { tag: "missing-tag" }, { path: context.pmPath });
      expect(wrongTag.count).toBe(0);

      const wrongPriority = await runList(undefined, { priority: "4" }, { path: context.pmPath });
      expect(wrongPriority.count).toBe(0);
    });
  });

  it("applies assignee and assignee-filter semantics for assignment state", async () => {
    await withTempPmPath(async (context) => {
      createItem(context, {
        title: "Assigned Item",
        status: "open",
        priority: "1",
        tags: "test",
        deadline: "+1d",
        assignee: "agent-a",
      });
      const unassignedId = createItem(context, {
        title: "Unassigned Item",
        status: "open",
        priority: "2",
        tags: "test",
        deadline: "+1d",
      });
      const unsetResult = context.runCli(
        ["update", unassignedId, "--json", "--unset", "assignee", "--author", "seed-assignee"],
        { expectJson: true },
      );
      expect(unsetResult.code).toBe(0);

      const byAssignee = await runList(undefined, { assignee: "agent-a" }, { path: context.pmPath });
      expect(byAssignee.count).toBe(1);
      expect(byAssignee.items[0].assignee).toBe("agent-a");
      expect(byAssignee.filters.assignee).toBe("agent-a");

      const unassigned = await runList(undefined, { assigneeFilter: "unassigned" }, { path: context.pmPath });
      expect(unassigned.count).toBe(1);
      expect(unassigned.items[0].title).toBe("Unassigned Item");
      expect(unassigned.filters.assignee_filter).toBe("unassigned");

      await expect(runList(undefined, { assignee: "none" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });

      const noMatch = await runList(undefined, { assignee: "agent-z" }, { path: context.pmPath });
      expect(noMatch.count).toBe(0);
    });
  });

  it("applies sprint and release filters", async () => {
    await withTempPmPath(async (context) => {
      createItem(context, {
        title: "Sprint Item",
        status: "open",
        priority: "1",
        tags: "test",
        deadline: "+1d",
        sprint: "sprint-1",
        release: "v1.0",
      });
      createItem(context, {
        title: "Other Sprint Item",
        status: "open",
        priority: "2",
        tags: "test",
        deadline: "+1d",
        sprint: "sprint-2",
        release: "v2.0",
      });

      const bySprint = await runList(undefined, { sprint: "sprint-1" }, { path: context.pmPath });
      expect(bySprint.count).toBe(1);
      expect(bySprint.items[0].title).toBe("Sprint Item");
      expect(bySprint.filters.sprint).toBe("sprint-1");

      const byRelease = await runList(undefined, { release: "v2.0" }, { path: context.pmPath });
      expect(byRelease.count).toBe(1);
      expect(byRelease.items[0].title).toBe("Other Sprint Item");
      expect(byRelease.filters.release).toBe("v2.0");

      const noSprintMatch = await runList(undefined, { sprint: "sprint-99" }, { path: context.pmPath });
      expect(noSprintMatch.count).toBe(0);

      const noReleaseMatch = await runList(undefined, { release: "v99.0" }, { path: context.pmPath });
      expect(noReleaseMatch.count).toBe(0);
    });
  });

  it("applies parent filters for hierarchical list views", async () => {
    await withTempPmPath(async (context) => {
      const parentA = createItem(context, {
        title: "Parent A",
        status: "open",
        priority: "1",
        tags: "hierarchy,parent",
        deadline: "+1d",
      });
      const parentB = createItem(context, {
        title: "Parent B",
        status: "open",
        priority: "1",
        tags: "hierarchy,parent",
        deadline: "+1d",
      });
      createItem(context, {
        title: "Child A1",
        status: "open",
        priority: "2",
        tags: "hierarchy,child",
        deadline: "+1d",
        parent: parentA,
      });
      createItem(context, {
        title: "Child B1",
        status: "open",
        priority: "2",
        tags: "hierarchy,child",
        deadline: "+1d",
        parent: parentB,
      });
      createItem(context, {
        title: "Unparented Child",
        status: "open",
        priority: "2",
        tags: "hierarchy,child",
        deadline: "+1d",
      });

      const parentFiltered = await runList(undefined, { parent: parentA }, { path: context.pmPath });
      expect(parentFiltered.count).toBe(1);
      expect(parentFiltered.items[0].title).toBe("Child A1");
      expect(parentFiltered.items[0].parent).toBe(parentA);
      expect(parentFiltered.filters.parent).toBe(parentA);

      const parentMiss = await runList(undefined, { parent: "pm-missing-parent" }, { path: context.pmPath });
      expect(parentMiss.count).toBe(0);
      expect(parentMiss.filters.parent).toBe("pm-missing-parent");
    });
  });

  it("supports compact and custom field projections", async () => {
    await withTempPmPath(async (context) => {
      const id = createItem(context, {
        title: "Projection Target",
        status: "open",
        priority: "1",
        tags: "projection,list",
        deadline: "+1d",
      });

      const compact = await runList(undefined, { compact: true }, { path: context.pmPath });
      expect((compact as Record<string, unknown>).projection).toBeUndefined();
      expect((compact as Record<string, unknown>).sorting).toBeUndefined();
      expect((compact as Record<string, unknown>).now).toBeUndefined();
      const compactItem = compact.items[0] as unknown as Record<string, unknown>;
      expect(Object.keys(compactItem)).toEqual(["id", "title", "status", "type", "priority", "parent", "updated_at"]);
      expect(compactItem.id).toBe(id);

      const fields = await runList(undefined, { fields: "id,title,parent" }, { path: context.pmPath });
      expect(fields.projection).toEqual({
        mode: "fields",
        fields: ["id", "title", "parent"],
      });
      const fieldItem = fields.items[0] as unknown as Record<string, unknown>;
      expect(Object.keys(fieldItem)).toEqual(["id", "title", "parent"]);
      expect(fieldItem.id).toBe(id);
      expect(fieldItem.title).toBe("Projection Target");

      const full = await runList(undefined, { full: true }, { path: context.pmPath });
      expect(full.projection).toEqual({
        mode: "full",
        fields: null,
      });
      expect(full.items[0]).toHaveProperty("priority");
    });
  });

  it("supports CSV status filters for multi-status agent queries", async () => {
    await withTempPmPath(async (context) => {
      const openId = createItem(context, {
        title: "Open CSV Target",
        status: "open",
        priority: "1",
        tags: "status,csv",
        deadline: "+1d",
      });
      const blockedId = createItem(context, {
        title: "Blocked CSV Target",
        status: "blocked",
        priority: "1",
        tags: "status,csv",
        deadline: "+1d",
      });
      createItem(context, {
        title: "Closed CSV Miss",
        status: "closed",
        priority: "1",
        tags: "status,csv",
        deadline: "+1d",
      });

      const result = await runList(undefined, { status: "open,blocked", tag: "status" }, { path: context.pmPath });

      expect(result.filters.status).toEqual(["open", "blocked"]);
      expect(result.items.map((item) => item.id).sort()).toEqual([blockedId, openId].sort());
    });
  });

  it("supports configurable list sorting and ordering", async () => {
    await withTempPmPath(async (context) => {
      createItem(context, {
        title: "Bravo",
        status: "open",
        priority: "2",
        tags: "sort,list",
        deadline: "+2d",
      });
      createItem(context, {
        title: "Alpha",
        status: "open",
        priority: "0",
        tags: "sort,list",
        deadline: "none",
      });
      createItem(context, {
        title: "Charlie",
        status: "open",
        priority: "1",
        tags: "sort,list",
        deadline: "+1d",
      });

      const byTitleAsc = await runList(undefined, { sort: "title", order: "asc" }, { path: context.pmPath });
      expect(byTitleAsc.sorting).toEqual({
        sort: "title",
        order: "asc",
      });
      expect(byTitleAsc.items.map((item) => item.title)).toEqual(["Alpha", "Bravo", "Charlie"]);

      const byPriorityDesc = await runList(undefined, { sort: "priority", order: "desc" }, { path: context.pmPath });
      expect(byPriorityDesc.sorting).toEqual({
        sort: "priority",
        order: "desc",
      });
      expect(byPriorityDesc.items.map((item) => item.priority)).toEqual([2, 1, 0]);

      const byDeadlineAsc = await runList(undefined, { sort: "deadline", order: "asc" }, { path: context.pmPath });
      expect(byDeadlineAsc.items.map((item) => item.title)).toEqual(["Charlie", "Bravo", "Alpha"]);
    });
  });

  it("accepts updated/created sort field aliases and rejects unknown sort fields with the alias hint", async () => {
    await withTempPmPath(async (context) => {
      createItem(context, { title: "Alpha", status: "open", priority: "0", tags: "sort,alias", deadline: "+1d" });

      const byUpdated = await runList(undefined, { sort: "updated", order: "desc" }, { path: context.pmPath });
      expect(byUpdated.sorting).toEqual({ sort: "updated_at", order: "desc" });

      const byCreated = await runList(undefined, { sort: "created", order: "asc" }, { path: context.pmPath });
      expect(byCreated.sorting).toEqual({ sort: "created_at", order: "asc" });

      await expect(runList(undefined, { sort: "bogus" }, { path: context.pmPath })).rejects.toThrow(
        /Sort field must be one of .*aliases: updated->updated_at/,
      );

      // Prototype-chain keys must not resolve to a truthy alias (no prototype pollution).
      for (const polluted of ["__proto__", "constructor", "toString"]) {
        await expect(runList(undefined, { sort: polluted }, { path: context.pmPath })).rejects.toThrow(
          /Sort field must be one of/,
        );
      }
    });
  });

  it("applies updated/created date-window filters and echoes the raw input", async () => {
    await withTempPmPath(async (context) => {
      createItem(context, {
        title: "Window Alpha",
        status: "open",
        priority: "1",
        tags: "window,date",
        deadline: "+1d",
      });
      createItem(context, {
        title: "Window Beta",
        status: "open",
        priority: "1",
        tags: "window,date",
        deadline: "+1d",
      });

      // updated-after: relative past offset keeps all just-created items.
      const updatedAfterRecent = context.runCli(["list", "--updated-after=-1h", "--json"], { expectJson: true });
      expect(updatedAfterRecent.code).toBe(0);
      const recentPayload = updatedAfterRecent.json as { count: number; filters: Record<string, unknown> };
      expect(recentPayload.count).toBeGreaterThan(0);
      // The result echoes the RAW input string, not the resolved ISO timestamp.
      expect(recentPayload.filters.updated_after).toBe("-1h");

      const todayResult = context.runCli(["list", "--today", "--json"], { expectJson: true });
      expect(todayResult.code).toBe(0);
      const todayPayload = todayResult.json as { count: number; filters: Record<string, unknown> };
      expect(todayPayload.count).toBeGreaterThan(0);
      expect(todayPayload.filters.today).toBe(true);
      expect(todayPayload.filters.updated_after).toBeNull();

      const recentResult = context.runCli(["list", "--recent", "--json"], { expectJson: true });
      expect(recentResult.code).toBe(0);
      const recentWindowPayload = recentResult.json as { count: number; filters: Record<string, unknown> };
      expect(recentWindowPayload.count).toBeGreaterThan(0);
      expect(recentWindowPayload.filters.recent).toBe(true);
      expect(recentWindowPayload.filters.updated_after).toBeNull();

      const programmaticToday = await runList(undefined, { today: true }, { path: context.pmPath });
      expect(programmaticToday.count).toBeGreaterThan(0);
      expect(programmaticToday.filters.today).toBe(true);

      const programmaticRecent = await runList(undefined, { recent: true }, { path: context.pmPath });
      expect(programmaticRecent.count).toBeGreaterThan(0);
      expect(programmaticRecent.filters.recent).toBe(true);

      expect(() =>
        listInternals.resolveListUpdatedAfter({ today: true, updatedAfter: "-1h" }),
      ).toThrow("Choose only one updated_at window");
      expect(listInternals.resolveListUpdatedAfter({ today: true, updatedAfter: null as unknown as string })).toMatch(
        /^\d{4}-\d{2}-\d{2}T/,
      );
      expect(listInternals.resolveListUpdatedAfter({ today: true, updatedAfter: "   " })).toMatch(
        /^\d{4}-\d{2}-\d{2}T/,
      );

      const conflictingWindows = context.runCli(["list", "--today", "--updated-after=-1h", "--json"]);
      expect(conflictingWindows.code).not.toBe(0);
      expect(`${conflictingWindows.stderr}${conflictingWindows.stdout}`).toContain("Choose only one updated_at window");

      // updated-after: a future ISO threshold filters everything out.
      const updatedAfterFuture = context.runCli(["list", "--updated-after", "2030-01-01", "--json"], {
        expectJson: true,
      });
      expect(updatedAfterFuture.code).toBe(0);
      const futurePayload = updatedAfterFuture.json as { count: number; filters: Record<string, unknown> };
      expect(futurePayload.count).toBe(0);
      expect(futurePayload.filters.updated_after).toBe("2030-01-01");

      // created-before: a far-future ISO threshold keeps all items.
      const createdBeforeFuture = context.runCli(["list", "--created-before", "2030-01-01", "--json"], {
        expectJson: true,
      });
      expect(createdBeforeFuture.code).toBe(0);
      const createdFuturePayload = createdBeforeFuture.json as {
        count: number;
        filters: Record<string, unknown>;
      };
      expect(createdFuturePayload.count).toBeGreaterThan(0);
      expect(createdFuturePayload.filters.created_before).toBe("2030-01-01");

      // created-before: a relative past offset filters everything out.
      const createdBeforePast = context.runCli(["list", "--created-before=-1h", "--json"], { expectJson: true });
      expect(createdBeforePast.code).toBe(0);
      const createdPastPayload = createdBeforePast.json as { count: number; filters: Record<string, unknown> };
      expect(createdPastPayload.count).toBe(0);
      expect(createdPastPayload.filters.created_before).toBe("-1h");

      // Date-window filters default to null when absent.
      const noFilters = context.runCli(["list", "--json"], { expectJson: true });
      expect(noFilters.code).toBe(0);
      const noFiltersPayload = noFilters.json as { filters: Record<string, unknown> };
      expect(noFiltersPayload.filters.updated_after).toBeNull();
      expect(noFiltersPayload.filters.updated_before).toBeNull();
      expect(noFiltersPayload.filters.created_after).toBeNull();
      expect(noFiltersPayload.filters.created_before).toBeNull();

      // An unparseable date-window value is a USAGE error (non-zero exit + "Invalid").
      const invalid = context.runCli(["list", "--updated-after", "totally-not-a-date", "--json"]);
      expect(invalid.code).not.toBe(0);
      expect(`${invalid.stderr}${invalid.stdout}`).toContain("Invalid");
    });
  });

  it("validates projection and sort option combinations", async () => {
    await withTempPmPath(async (context) => {
      createItem(context, {
        title: "Validation target",
        status: "open",
        priority: "1",
        tags: "validation,list",
        deadline: "+1d",
      });

      await expect(runList(undefined, { compact: true, fields: "id" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(runList(undefined, { full: true, fields: "id" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(runList(undefined, { fields: "   " }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(runList(undefined, { fields: "id,bogus" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining("Unknown list --fields value(s): bogus"),
      });
      await expect(runList(undefined, { order: "asc" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(runList(undefined, { treeDepth: "1" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(
        runList(undefined, { assignee: "seed-assignee", assigneeFilter: "unassigned" }, { path: context.pmPath }),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: "Cannot combine --assignee with --assignee-filter unassigned",
      });
      await expect(runList(undefined, { sort: "unknown" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(runList(undefined, { sort: "title", order: "sideways" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
    });
  });

  it("--no-truncate overrides --limit and surfaces the pre-pagination total (GH-154)", async () => {
    await withTempPmPath(async (context) => {
      for (let index = 0; index < 4; index += 1) {
        createItem(context, { title: `Bulk ${index}`, status: "open", priority: "1", tags: "bulk", deadline: "+1d" });
      }

      // A truncating --limit reports how many rows were omitted via total.
      const limited = await runList(undefined, { limit: "1" }, { path: context.pmPath });
      expect(limited.count).toBe(1);
      expect(limited.total).toBe(4);
      expect(limited.next_cursor).toBeTypeOf("string");

      const zero = await runList(undefined, { limit: "0" }, { path: context.pmPath });
      expect(zero.count).toBe(0);
      expect(zero.has_more).toBeUndefined();
      expect(zero.next_cursor).toBeUndefined();

      const continued = await runList(
        undefined,
        { limit: "1", after: limited.next_cursor },
        { path: context.pmPath },
      );
      expect(continued.items[0]?.id).not.toBe(limited.items[0]?.id);
      await expect(
        runList(
          undefined,
          { after: limited.next_cursor, offset: "1" },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      // --no-truncate returns everything and omits total (nothing was dropped).
      const full = await runList(undefined, { noTruncate: true }, { path: context.pmPath });
      expect(full.count).toBe(4);
      expect(full.total).toBeUndefined();

      // --no-truncate wins even when --limit is also supplied, and echoes the flag.
      const override = await runList(undefined, { noTruncate: true, limit: "1" }, { path: context.pmPath });
      expect(override.count).toBe(4);
      expect((override.filters as { no_truncate?: boolean }).no_truncate).toBe(true);

      // Offset-only pagination also surfaces the total of matched rows.
      const offset = await runList(undefined, { offset: "1" }, { path: context.pmPath });
      expect(offset.count).toBe(3);
      expect(offset.total).toBe(4);

      // Compact summary path carries the same total when truncated.
      const compact = await runList(undefined, { limit: "1", compact: true }, { path: context.pmPath });
      expect(compact.count).toBe(1);
      expect(compact.total).toBe(4);
    });
  });
});
