import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runAppend } from "../../../src/cli/commands/append.js";
import { _testOnlyGetCommand, runGet } from "../../../src/cli/commands/get.js";
import { runHistoryCompact } from "../../../src/cli/commands/history-compact.js";
import { EXIT_CODE } from "../../../src/core/shared/constants.js";
import { PmCliError } from "../../../src/core/shared/errors.js";
import { locateItem } from "../../../src/core/store/item-store.js";
import * as itemStoreModule from "../../../src/core/store/item-store.js";
import { readSettings, writeSettings } from "../../../src/core/store/settings.js";
import { withTempPmPath, type TempPmContext } from "../../helpers/withTempPmPath.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function createTask(
  context: TempPmContext,
  params: {
    title: string;
    body: string;
    includeLinks?: boolean;
    type?: string;
    deadline?: string;
    event?: string;
    reminder?: string;
  },
): string {
  const linkArgs = params.includeLinks
    ? [
        "--file",
        "path=src/cli/commands/get.ts,scope=project,note=get-link",
        "--test",
        "command=node --version,scope=project,timeout_seconds=15,note=test-link",
        "--doc",
        "path=README.md,scope=project,note=doc-link",
      ]
    : ["--file", "none", "--test", "none", "--doc", "none"];

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
    "open",
    "--priority",
    "1",
    "--tags",
    "unit,get-append",
    "--body",
    params.body,
    "--deadline",
    params.deadline ?? "none",
    "--estimate",
    "10",
    "--acceptance-criteria",
    `${params.title} acceptance`,
    "--author",
    "test-author",
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
    ...linkArgs,
    ...(params.event === undefined ? [] : ["--event", params.event]),
    ...(params.reminder === undefined
      ? []
      : ["--reminder", params.reminder]),
  ];

  const created = context.runCli(args, { expectJson: true });
  expect(created.code).toBe(0);
  const payload = created.json as { item?: { id?: string } };
  expect(typeof payload.item?.id).toBe("string");
  return payload.item?.id ?? "";
}

describe("runGet and runAppend", () => {
  it("fails when tracker is not initialized", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pm-get-append-not-init-"));
    try {
      await expect(runGet("pm-missing", { path: tempDir })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
      await expect(runAppend("pm-missing", { body: "append text" }, { path: tempDir })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("returns linked entries when present and defaults to empty arrays when absent", async () => {
    await withTempPmPath(async (context) => {
      const linkedId = createTask(context, {
        title: "get-with-links",
        body: "linked body",
        includeLinks: true,
      });
      const linkedResult = await runGet(linkedId, { path: context.pmPath });
      expect(linkedResult.item.id).toBe(linkedId);
      expect(linkedResult.item.body).toBe("linked body");
      expect(linkedResult.linked.files).toEqual([
        { path: "src/cli/commands/get.ts", scope: "project", note: "get-link" },
      ]);
      expect(linkedResult.linked.docs).toEqual([{ path: "README.md", scope: "project", note: "doc-link" }]);
      expect(linkedResult.linked.tests).toEqual([
        {
          command: "node --version",
          scope: "project",
          timeout_seconds: 15,
          note: "test-link",
        },
      ]);

      const plainId = createTask(context, {
        title: "get-without-links",
        body: "plain body",
      });
      const plainResult = await runGet(plainId, { path: context.pmPath });
      expect(plainResult.linked.files).toEqual([]);
      expect(plainResult.linked.tests).toEqual([]);
      expect(plainResult.linked.docs).toEqual([]);
    });
  });

  it("supports lower-token get depth projections while keeping standard as the default", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, {
        title: "get-depth-projection",
        body: "depth body",
        includeLinks: true,
      });

      context.runCli(["comments", id, "depth comment", "--json", "--author", "owner-a"], { expectJson: true });
      context.runCli(["notes", id, "--add", "depth note", "--json", "--author", "owner-a"], { expectJson: true });

      const defaultRead = await runGet(id, { path: context.pmPath });
      expect(defaultRead.item.comments).toBeUndefined();
      expect(defaultRead.item.notes).toBeUndefined();
      expect(defaultRead.linked.files).toHaveLength(1);
      expect(defaultRead.item.body).toBe("depth body");

      const explicitFull = await runGet(id, { path: context.pmPath }, { full: true });
      expect(explicitFull.item.comments).toBeDefined();
      expect(explicitFull.item.notes).toBeDefined();
      expect(explicitFull.linked.files).toHaveLength(1);
      expect(explicitFull.item.body).toBe("depth body");

      const depthFullAlias = await runGet(id, { path: context.pmPath }, { depth: "full" });
      expect(depthFullAlias.item.comments).toBeDefined();
      expect(depthFullAlias.item.notes).toBeDefined();
      expect(depthFullAlias.linked.files).toHaveLength(1);
      expect(depthFullAlias.item.body).toBe("depth body");

      const standard = await runGet(id, { path: context.pmPath }, { depth: "standard" });
      expect(standard.item.id).toBe(id);
      expect(standard.item.comments).toBeUndefined();
      expect(standard.item.notes).toBeUndefined();
      expect(standard.item.files).toBeUndefined();
      expect(standard.linked.files).toHaveLength(1);
      expect(standard.item.body).toBe("depth body");

      const brief = await runGet(id, { path: context.pmPath }, { depth: "brief" });
      expect(brief.item.id).toBe(id);
      expect(brief.item.comments).toBeUndefined();
      expect(brief.linked).toBeUndefined();
      expect(brief.item.body).toBeUndefined();
      expect(brief.claim_state).toBeUndefined();

      await expect(runGet(id, { path: context.pmPath }, { depth: "verbose" })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(runGet(id, { path: context.pmPath }, { full: true, fields: "id,title" })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(runGet(id, { path: context.pmPath }, { full: true, depth: "brief" })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
    });
  });

  it("supports custom get field projections for narrow agent reads", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, {
        title: "get-fields-projection",
        body: "fields body",
        includeLinks: true,
      });

      const focused = await runGet(id, { path: context.pmPath }, { fields: "id,title,status,parent,type" });
      expect(focused.item).toEqual({
        id,
        title: "get-fields-projection",
        status: "open",
        parent: undefined,
        type: "Task",
      });
      expect(focused.item.body).toBeUndefined();
      expect(focused.linked).toBeUndefined();
      expect(focused.claim_state).toBeUndefined();

      const withBodyAndFiles = await runGet(id, { path: context.pmPath }, { fields: "item.id,body,linked.files" });
      expect(withBodyAndFiles.item).toEqual({ id, body: "fields body" });
      expect(withBodyAndFiles.item.body).toBe("fields body");
      expect(withBodyAndFiles.linked.files).toHaveLength(1);
      expect(withBodyAndFiles.linked.tests).toEqual([]);

      const withOnlyTests = await runGet(id, { path: context.pmPath }, { fields: "id,linked.tests" });
      expect(withOnlyTests.item).toEqual({ id });
      expect(withOnlyTests.linked).toBeDefined();
      if (withOnlyTests.linked === undefined) {
        throw new TypeError("linked projection was not returned");
      }
      expect(withOnlyTests.linked.files).toEqual([]);
      expect(withOnlyTests.linked.tests).toHaveLength(1);
      expect(withOnlyTests.linked.docs).toEqual([]);

      const withClaimState = await runGet(id, { path: context.pmPath }, { fields: "id,claim_state" });
      expect(withClaimState.item).toEqual({ id });
      expect(withClaimState.claim_state).toEqual({
        claimed: false,
        assignee: null,
        last_claim: null,
        last_release: null,
      });

      const withDottedClaimState = await runGet(id, { path: context.pmPath }, { fields: "id,claim_state.claimed" });
      expect(withDottedClaimState.item).toEqual({ id });
      expect(withDottedClaimState.claim_state).toBeDefined();
      if (withDottedClaimState.claim_state === undefined) {
        throw new TypeError("claim_state projection was not returned");
      }
      expect(withDottedClaimState.claim_state.claimed).toBe(false);

      const withChildren = await runGet(id, { path: context.pmPath }, { fields: "id,children" });
      expect(withChildren.item).toEqual({ id });
      expect(withChildren.children).toMatchObject({
        count: 0,
        active: 0,
        by_status: {},
        sample: [],
        truncated: false,
        next_offset: null,
        continuation: null,
      });

      const withItemPrefixedClaimState = await runGet(
        id,
        { path: context.pmPath },
        { fields: "item.id,item.claim_state.claimed" },
      );
      expect(withItemPrefixedClaimState.item).toEqual({ id });
      expect(withItemPrefixedClaimState.claim_state?.claimed).toBe(false);

      await expect(runGet(id, { path: context.pmPath }, { fields: " , " })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(runGet(id, { path: context.pmPath }, { fields: "id,bogus" })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining("Unknown get --fields value(s): bogus"),
      });
    });
  });

  it("validates tree-depth usage and returns descendant subtree payloads", async () => {
    await withTempPmPath(async (context) => {
      const rootId = createTask(context, {
        title: "get-tree-root",
        body: "root body",
      });
      const childId = createTask(context, {
        title: "get-tree-child",
        body: "child body",
      });
      const grandchildId = createTask(context, {
        title: "get-tree-grandchild",
        body: "grandchild body",
      });

      const childLink = context.runCli(
        ["update", "--json", childId, "--parent", rootId, "--author", "test-author", "--message", "link child to root"],
        { expectJson: true },
      );
      expect(childLink.code).toBe(0);
      const grandchildLink = context.runCli(
        [
          "update",
          "--json",
          grandchildId,
          "--parent",
          childId,
          "--author",
          "test-author",
          "--message",
          "link grandchild to child",
        ],
        { expectJson: true },
      );
      expect(grandchildLink.code).toBe(0);

      await expect(runGet(rootId, { path: context.pmPath }, { treeDepth: "1" })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });

      const treeResult = await runGet(rootId, { path: context.pmPath }, { tree: true, treeDepth: "1" });
      expect(treeResult.tree).toBeDefined();
      if (treeResult.tree === undefined) {
        throw new TypeError("tree result was not returned");
      }
      expect(treeResult.tree.root_id).toBe(rootId);
      expect(treeResult.tree.depth_limit).toBe(1);
      expect(treeResult.tree.count).toBe(2);
      const treeItems = treeResult.tree.items;
      const ids = treeItems.map((entry) => String(entry.id));
      expect(ids).toEqual([childId, grandchildId]);
      expect(treeItems).toHaveLength(2);
      const [childTreeItem, grandchildTreeItem] = treeItems as Array<{ tree_depth?: number }>;
      expect(childTreeItem).toBeDefined();
      expect(grandchildTreeItem).toBeDefined();
      if (childTreeItem === undefined || grandchildTreeItem === undefined) {
        throw new TypeError("tree result did not include expected child entries");
      }
      expect(childTreeItem.tree_depth).toBe(0);
      expect(grandchildTreeItem.tree_depth).toBe(1);

      const unboundedTree = await runGet(rootId, { path: context.pmPath }, { tree: true });
      expect(unboundedTree.tree).toBeDefined();
      if (unboundedTree.tree === undefined) {
        throw new TypeError("unbounded tree result was not returned");
      }
      expect(unboundedTree.tree.depth_limit).toBeNull();
      expect(unboundedTree.tree.count).toBe(2);
    });
  });

  it("adds a deterministic child status rollup for every parent-capable item type", async () => {
    await withTempPmPath(async (context) => {
      const epicId = createTask(context, {
        title: "get-children-rollup-epic",
        body: "epic body",
        type: "Epic",
      });
      const openChildId = createTask(context, {
        title: "get-children-rollup-open",
        body: "open child",
      });
      const secondOpenChildId = createTask(context, {
        title: "get-children-rollup-open-2",
        body: "second open child",
      });
      const closedChildId = createTask(context, {
        title: "get-children-rollup-closed",
        body: "closed child",
      });

      for (const childId of [openChildId, secondOpenChildId, closedChildId]) {
        const link = context.runCli(
          ["update", childId, "--parent", epicId, "--json", "--author", "test-author", "--message", "Link child to epic"],
          { expectJson: true },
        );
        expect(link.code).toBe(0);
      }
      const close = context.runCli(["close", closedChildId, "Child complete", "--json", "--author", "test-author"], {
        expectJson: true,
      });
      expect(close.code).toBe(0);
      const openChildPath = path.join(context.pmPath, "tasks", `${openChildId}.toon`);
      const openChildSource = await readFile(openChildPath, "utf8");
      await writeFile(
        openChildPath,
        openChildSource.replace(`parent: ${epicId}`, `parent: "${epicId.toUpperCase()}"`).replace("status: open", 'status: " Open "'),
        "utf8",
      );
      const secondOpenChildPath = path.join(context.pmPath, "tasks", `${secondOpenChildId}.toon`);
      const secondOpenChildSource = await readFile(secondOpenChildPath, "utf8");
      await writeFile(secondOpenChildPath, secondOpenChildSource.replace("status: open", 'status: ""'), "utf8");

      const standard = await runGet(epicId, { path: context.pmPath });
      expect(standard.children).toMatchObject({
        count: 2,
        active: 1,
        by_status: {
          open: 1,
          closed: 1,
        },
        truncated: false,
        next_offset: null,
      });
      expect(standard.children?.sample.map((child) => child.id)).toEqual(
        [closedChildId, openChildId].sort((left, right) =>
          left.localeCompare(right),
        ),
      );

      const brief = await runGet(epicId, { path: context.pmPath }, { depth: "brief" });
      expect(brief.children).toBeUndefined();

      const emptyPlanId = createTask(context, {
        title: "get-children-rollup-empty-plan",
        body: "empty plan body",
        type: "Plan",
      });
      const emptyPlan = await runGet(emptyPlanId, { path: context.pmPath });
      expect(emptyPlan.children).toBeUndefined();

      const listAllSpy = vi.spyOn(itemStoreModule, "listAllItemMetadataLight");
      const leaf = await runGet(openChildId, { path: context.pmPath });
      expect(leaf.children).toBeUndefined();
      expect(listAllSpy).not.toHaveBeenCalled();

      const projectedLeaf = await runGet(openChildId, { path: context.pmPath }, { fields: "id,children" });
      expect(projectedLeaf.item).toEqual({ id: openChildId });
      expect(projectedLeaf.children).toMatchObject({
        count: 0,
        active: 0,
        by_status: {},
        sample: [],
      });
      expect(listAllSpy).toHaveBeenCalledOnce();

      const itemPrefixedProjection = await runGet(
        epicId,
        { path: context.pmPath },
        { fields: "item.id,item.children" },
      );
      expect(itemPrefixedProjection.item).toEqual({ id: epicId });
      expect(itemPrefixedProjection.children).toMatchObject({
        count: 2,
        active: 1,
      });
      expect(_testOnlyGetCommand.shouldAutoIncludeGetChildren("Plan")).toBe(true);
      expect(_testOnlyGetCommand.shouldAutoIncludeGetChildren("Task")).toBe(false);
      expect(_testOnlyGetCommand.shouldAutoIncludeGetChildren("CustomContainer")).toBe(true);
      expect(_testOnlyGetCommand.shouldAutoIncludeGetChildren(" ")).toBe(false);
    });
  });

  it("projects schedule context at standard depth and through narrow fields", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, {
        title: "get-scheduled-meeting",
        body: "meeting context",
        type: "Meeting",
        deadline: "2026-07-20T12:00:00.000Z",
        event:
          "start=2026-07-20T09:00:00.000Z,end=2026-07-20T10:00:00.000Z,title=SDK sync,location=Room 7",
        reminder: "at=2026-07-20T08:45:00.000Z,text=Join SDK sync",
      });

      const standard = await runGet(id, { path: context.pmPath });
      expect(standard.schedule).toMatchObject({
        deadline: "2026-07-20T12:00:00.000Z",
        start_at: "2026-07-20T09:00:00.000Z",
        end_at: "2026-07-20T10:00:00.000Z",
        location: "Room 7",
      });
      expect(standard.schedule?.events).toHaveLength(1);
      expect(standard.schedule?.reminders).toHaveLength(1);

      const projected = await runGet(
        id,
        { path: context.pmPath },
        { fields: "id,schedule.start_at,schedule.location" },
      );
      expect(projected.item).toEqual({ id });
      expect(projected.schedule).toEqual({
        start_at: "2026-07-20T09:00:00.000Z",
        location: "Room 7",
      });
      const itemPrefixedProjection = await runGet(
        id,
        { path: context.pmPath },
        { fields: "item.id,item.schedule.start_at" },
      );
      expect(itemPrefixedProjection.item).toEqual({ id });
      expect(itemPrefixedProjection.schedule).toEqual({
        start_at: "2026-07-20T09:00:00.000Z",
      });
      const brief = await runGet(id, { path: context.pmPath }, { depth: "brief" });
      expect(brief.schedule).toBeUndefined();
    });
  });

  it("reconstructs verified historical reads without mutating current state or history", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, {
        title: "get-time-travel-v1",
        body: "historical body",
      });
      const historyPath = path.join(context.pmPath, "history", `${id}.jsonl`);
      const initialHistory = await readFile(historyPath, "utf8");
      const update = context.runCli(
        [
          "update",
          id,
          "--title",
          "get-time-travel-v2",
          "--json",
          "--author",
          "test-author",
          "--message",
          "Advance historical fixture",
        ],
        { expectJson: true },
      );
      expect(update.code).toBe(0);
      const beforeReadHistory = await readFile(historyPath, "utf8");
      expect(beforeReadHistory.length).toBeGreaterThan(initialHistory.length);
      const usagePath = path.join(context.pmPath, "runtime", "context-usage.jsonl");
      const beforeReadUsage = await readFile(usagePath, "utf8");

      const historical = await runGet(
        id,
        { path: context.pmPath },
        { at: "1", fields: "id,title,body,claim_state" },
      );
      expect(historical).toMatchObject({
        reconstructed: true,
        as_of_version: 1,
        item: { id, title: "get-time-travel-v1", body: "historical body" },
      });
      expect(historical.as_of_timestamp).toEqual(expect.any(String));
      expect(historical.children).toBeUndefined();
      expect(await readFile(historyPath, "utf8")).toBe(beforeReadHistory);
      expect(await readFile(usagePath, "utf8")).toBe(beforeReadUsage);
      expect((await runGet(id, { path: context.pmPath })).item.title).toBe(
        "get-time-travel-v2",
      );
      expect((await readFile(usagePath, "utf8")).length).toBeGreaterThan(
        beforeReadUsage.length,
      );

      await expect(
        runGet(id, { path: context.pmPath }, { at: "999" }),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        context: {
          code: "history_target_out_of_range",
          valid_range: { first_version: 1, last_version: 2 },
        },
      });
      await expect(
        runGet(id, { path: context.pmPath }, { at: "2100-01-01T00:00:00.000Z" }),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });
      await expect(
        runGet(id, { path: context.pmPath }, { at: "1", tree: true }),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      await runHistoryCompact(id, { author: "test-author" }, { path: context.pmPath });
      const checkpoint = await runGet(id, { path: context.pmPath }, { at: "1" });
      expect(checkpoint).toMatchObject({
        reconstructed: true,
        as_of_version: 1,
        item: { id, title: "get-time-travel-v2" },
      });
    });
  });

  it("rejects item reads when the container type value is empty", async () => {
    await withTempPmPath(async (context) => {
      const epicId = createTask(context, {
        title: "get-children-rollup-empty-type",
        body: "epic body",
        type: "Epic",
      });
      const childId = createTask(context, {
        title: "get-children-rollup-empty-type-child",
        body: "child body",
      });
      const linked = context.runCli(
        ["update", childId, "--parent", epicId, "--json", "--author", "test-author", "--message", "Link child to epic"],
        { expectJson: true },
      );
      expect(linked.code).toBe(0);

      const locatedEpic = await locateItem(context.pmPath, epicId);
      expect(locatedEpic).not.toBeNull();
      if (!locatedEpic) {
        throw new Error(`Unable to locate epic item: ${epicId}`);
      }
      const epicPath = locatedEpic.itemPath;
      const epicSource = await readFile(epicPath, "utf8");
      await writeFile(epicPath, epicSource.replace("type: Epic", 'type: ""'), "utf8");

      await expect(runGet(epicId, { path: context.pmPath }, { fields: "id,children" })).rejects.toMatchObject<PmCliError>({
        message: expect.stringContaining("type must be a non-empty string"),
      });
    });
  });

  it("allows configured runtime metadata fields in get projections", async () => {
    await withTempPmPath(async (context) => {
      const settings = await readSettings(context.pmPath);
      settings.schema.fields = [
        ...(settings.schema.fields ?? []),
        {
          key: "customer_segment",
          type: "string",
          commands: ["create", "update", "list", "search"],
          cli_aliases: ["segment"],
        },
      ];
      await writeSettings(context.pmPath, settings, "settings:write");
      const created = context.runCli([
        "create",
        "--json",
        "--title",
        "Runtime field get",
        "--description",
        "Runtime field get description",
        "--type",
        "Task",
        "--status",
        "open",
        "--priority",
        "1",
        "--customer-segment",
        "enterprise",
      ], { expectJson: true });
      const id = (created.json as { item: { id: string } }).item.id;

      const projected = await runGet(id, { path: context.pmPath }, { fields: "id,customer_segment" });
      expect(projected.item).toEqual({ id, customer_segment: "enterprise" });
    });
  });

  it("surfaces claim state metadata with latest claim/release context", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, {
        title: "get-claim-state",
        body: "claim metadata body",
      });

      const initial = await runGet(id, { path: context.pmPath });
      expect(initial.claim_state).toEqual({
        claimed: false,
        assignee: null,
        last_claim: null,
        last_release: null,
      });

      const claim = context.runCli(["claim", id, "--json", "--author", "owner-a", "--message", "claim metadata context"], {
        expectJson: true,
      });
      expect(claim.code).toBe(0);

      const afterClaim = await runGet(id, { path: context.pmPath });
      expect(afterClaim.claim_state.claimed).toBe(true);
      expect(afterClaim.claim_state.assignee).toBe("owner-a");
      expect(afterClaim.claim_state.last_claim?.author).toBe("owner-a");
      expect(afterClaim.claim_state.last_release).toBeNull();

      const release = context.runCli(
        ["release", id, "--json", "--author", "audit-reviewer", "--force", "--message", "release metadata context"],
        { expectJson: true },
      );
      expect(release.code).toBe(0);

      const afterRelease = await runGet(id, { path: context.pmPath });
      expect(afterRelease.claim_state.claimed).toBe(false);
      expect(afterRelease.claim_state.assignee).toBeNull();
      expect(afterRelease.claim_state.last_claim?.author).toBe("owner-a");
      expect(afterRelease.claim_state.last_release?.author).toBe("audit-reviewer");
    });
  });

  it("surfaces corrupt claim history when claim state is requested", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, {
        title: "get-history-decode-fallback",
        body: "claim metadata fallback body",
      });

      const historyPath = path.join(context.pmPath, "history", `${id}.jsonl`);
      await writeFile(historyPath, "{not valid jsonl}\n", "utf8");

      await expect(runGet(id, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        message: expect.stringContaining("contains invalid JSON"),
      });

      const projected = await runGet(id, { path: context.pmPath }, { fields: "id,title" });
      expect(projected.item).toEqual({ id, title: "get-history-decode-fallback" });
      expect(projected.claim_state).toBeUndefined();
    });
  });

  it("normalizes missing claim/release history messages to null", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, {
        title: "get-claim-state-message-null",
        body: "claim metadata null message body",
      });

      const claim = context.runCli(["claim", id, "--json", "--author", "owner-a"], {
        expectJson: true,
      });
      expect(claim.code).toBe(0);

      const release = context.runCli(["release", id, "--json", "--author", "owner-a"], {
        expectJson: true,
      });
      expect(release.code).toBe(0);

      const result = await runGet(id, { path: context.pmPath });
      expect(result.claim_state.last_claim?.message).toBeNull();
      expect(result.claim_state.last_release?.message).toBeNull();
    });
  });

  it("returns not found for unknown ids", async () => {
    await withTempPmPath(async (context) => {
      await expect(runGet("pm-does-not-exist", { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
    });
  });

  it("requires body for append operations", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, {
        title: "append-missing-body",
        body: "seed body",
      });
      await expect(
        runAppend(id, {} as unknown as { body: string; author?: string; message?: string; force?: boolean }, { path: context.pmPath }),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
    });
  });

  it("accepts append text as positional shorthand or --text alias and rejects conflicting/missing sources", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, { title: "append-text-forms", body: "seed body" });

      const positional = context.runCli(["append", id, "appended via positional", "--json", "--author", "owner-a"], {
        expectJson: true,
      });
      expect(positional.code).toBe(0);
      expect((positional.json as { appended?: string }).appended).toBe("appended via positional");

      const aliased = context.runCli(["append", id, "--text", "appended via text alias", "--json", "--author", "owner-a"], {
        expectJson: true,
      });
      expect(aliased.code).toBe(0);
      expect((aliased.json as { appended?: string }).appended).toBe("appended via text alias");

      const stdinText = context.runCli(["append", id, "--text", "-", "--json", "--author", "owner-a"], {
        expectJson: true,
        input: "appended from stdin",
      });
      expect(stdinText.code).toBe(0);
      expect((stdinText.json as { appended?: string }).appended).toBe("appended from stdin");

      const conflictCases = [
        ["append", id, "positional", "--text", "alias", "--author", "owner-a"],
        ["append", id, "--body", "from-body", "--text", "from-text", "--author", "owner-a"],
        ["append", id, "from-positional", "--body", "from-body", "--author", "owner-a"],
      ];
      for (const args of conflictCases) {
        const conflicting = context.runCli(args);
        expect(conflicting.code).toBe(EXIT_CODE.USAGE);
        expect(conflicting.stderr).toContain("exactly one source");
      }

      const missing = context.runCli(["append", id, "--author", "owner-a"]);
      expect(missing.code).toBe(EXIT_CODE.USAGE);
      expect(missing.stderr).toContain("Missing append text");
    });
  });

  it("returns empty append output when incoming body is blank", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, {
        title: "append-blank",
        body: "seed body",
      });
      const appendResult = await runAppend(
        id,
        {
          body: "   ",
          author: "append-author",
          message: "Blank append should be ignored",
        },
        { path: context.pmPath },
      );

      expect(appendResult.appended).toBe("");
      expect(appendResult.changed_fields).toEqual([]);

      const getResult = await runGet(id, { path: context.pmPath });
      expect(getResult.item.body).toBe("seed body");
    });
  });

  it("appends with and without spacer and falls back to unknown author", async () => {
    await withTempPmPath(async (context) => {
      const emptyBodyId = createTask(context, {
        title: "append-empty-body",
        body: "",
      });
      const firstAppend = await runAppend(
        emptyBodyId,
        {
          body: "first entry",
          message: "append empty body",
        },
        { path: context.pmPath },
      );
      expect(firstAppend.appended).toBe("first entry");
      expect(firstAppend.changed_fields).toContain("body");
      const afterFirstAppend = await runGet(emptyBodyId, { path: context.pmPath });
      expect(afterFirstAppend.item.body).toBe("first entry");
      const firstHistory = context.runCli(["history", emptyBodyId, "--json", "--full"], { expectJson: true });
      expect(firstHistory.code).toBe(0);
      const firstHistoryJson = firstHistory.json as { history: Array<{ op: string; author: string }> };
      const firstAppendAuthor = [...firstHistoryJson.history]
        .reverse()
        .find((entry) => entry.op === "append")?.author;
      expect(firstAppendAuthor).toBe("test-author");

      const spacedBodyId = createTask(context, {
        title: "append-existing-body",
        body: "existing body   \n",
      });
      const settingsAuthorId = createTask(context, {
        title: "append-settings-author",
        body: "",
      });
      const previousAuthor = process.env.PM_AUTHOR;
      delete process.env.PM_AUTHOR;
      try {
        const secondAppend = await runAppend(
          spacedBodyId,
          {
            body: "second entry",
            author: "   ",
            message: "append with unknown author fallback",
          },
          { path: context.pmPath },
        );
        expect(secondAppend.appended).toBe("second entry");
        expect(secondAppend.changed_fields).toContain("body");

        const afterSecondAppend = await runGet(spacedBodyId, { path: context.pmPath });
        expect(afterSecondAppend.item.body).toBe("existing body\n\nsecond entry");

        const history = context.runCli(["history", spacedBodyId, "--json", "--full"], { expectJson: true });
        expect(history.code).toBe(0);
        const historyJson = history.json as { history: Array<{ op: string; author: string }> };
        const appendAuthor = [...historyJson.history]
          .reverse()
          .find((entry) => entry.op === "append")?.author;
        expect(appendAuthor).toBe("unknown");

        const settingsPath = path.join(context.pmPath, "settings.json");
        const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
          author_default?: string;
        };
        settings.author_default = "settings-author";
        await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

        const settingsAppend = await runAppend(
          settingsAuthorId,
          {
            body: "from settings fallback",
            message: "append with settings author fallback",
          },
          { path: context.pmPath },
        );
        expect(settingsAppend.changed_fields).toContain("body");
        const settingsHistory = context.runCli(["history", settingsAuthorId, "--json", "--full"], { expectJson: true });
        expect(settingsHistory.code).toBe(0);
        const settingsHistoryJson = settingsHistory.json as {
          history: Array<{ op: string; author: string }>;
        };
        const settingsAppendAuthor = [...settingsHistoryJson.history]
          .reverse()
          .find((entry) => entry.op === "append")?.author;
        expect(settingsAppendAuthor).toBe("settings-author");
      } finally {
        if (previousAuthor === undefined) {
          delete process.env.PM_AUTHOR;
        } else {
          process.env.PM_AUTHOR = previousAuthor;
        }
      }
    });
  });

  it("accepts stdin token payload for append body", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, {
        title: "append-stdin-token",
        body: "existing body",
      });
      const stdin = new PassThrough();
      stdin.end("markdown from stdin");
      Object.defineProperty(stdin, "isTTY", { value: false, configurable: true });
      vi.spyOn(process, "stdin", "get").mockReturnValue(stdin as unknown as NodeJS.ReadStream);

      const appendResult = await runAppend(id, { body: "-", message: "append stdin payload" }, { path: context.pmPath });
      expect(appendResult.changed_fields).toContain("body");
      const getResult = await runGet(id, { path: context.pmPath });
      expect(getResult.item.body).toBe("existing body\n\nmarkdown from stdin");
    });
  });

});
