import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { splitFrontMatter } from "../../src/core/item/item-format.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

function distCliPath(): string {
  return path.resolve(process.cwd(), "dist/cli.js");
}

describe("CLI integration (sandboxed PM_PATH)", () => {
  it("accepts --ac as create alias for acceptance criteria", async () => {
    await withTempPmPath(async (context) => {
      const createResult = context.runCli(
        [
          "create",
          "--json",
          "--title",
          "Alias contract item",
          "--description",
          "Validate create acceptance criteria alias",
          "--type",
          "Task",
          "--status",
          "open",
          "--priority",
          "1",
          "--tags",
          "integration,contract",
          "--body",
          "",
          "--deadline",
          "none",
          "--estimate",
          "15",
          "--ac",
          "Alias flag is accepted",
          "--author",
          "integration-test",
          "--message",
          "Create with ac alias",
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
        ],
        { expectJson: true },
      );

      expect(createResult.code).toBe(0);
      expect((createResult.json as { item: { acceptance_criteria: string } }).item.acceptance_criteria).toBe(
        "Alias flag is accepted",
      );
    });
  });

  it("accepts --ac as update alias for acceptance criteria", async () => {
    await withTempPmPath(async (context) => {
      const createResult = context.runCli(
        [
          "create",
          "--json",
          "--title",
          "Update alias contract item",
          "--description",
          "Validate update acceptance criteria alias seed",
          "--type",
          "Task",
          "--status",
          "open",
          "--priority",
          "1",
          "--tags",
          "integration,contract",
          "--body",
          "",
          "--deadline",
          "none",
          "--estimate",
          "15",
          "--ac",
          "Seed flag",
          "--author",
          "integration-test",
          "--message",
          "Create seed",
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
        ],
        { expectJson: true },
      );
      expect(createResult.code).toBe(0);
      const id = (createResult.json as { item: { id: string } }).item.id;

      const updateResult = context.runCli(
        [
          "update",
          id,
          "--json",
          "--ac",
          "Alias flag is updated via ac",
          "--author",
          "integration-test",
          "--message",
          "Update with ac alias",
        ],
        { expectJson: true },
      );
      expect(updateResult.code).toBe(0);
      expect((updateResult.json as { item: { acceptance_criteria: string } }).item.acceptance_criteria).toBe(
        "Alias flag is updated via ac",
      );
    });
  });

  it("accepts snake_case create aliases for estimate and acceptance criteria", async () => {
    await withTempPmPath(async (context) => {
      const createResult = context.runCli(
        [
          "create",
          "--json",
          "--title",
          "Snake case create alias item",
          "--description",
          "Validate create snake_case aliases",
          "--type",
          "Task",
          "--status",
          "open",
          "--priority",
          "1",
          "--tags",
          "integration,contract",
          "--body",
          "",
          "--deadline",
          "none",
          "--estimated_minutes",
          "27",
          "--acceptance_criteria",
          "Snake case aliases are accepted for create",
          "--author",
          "integration-test",
          "--message",
          "Create with snake_case aliases",
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
        ],
        { expectJson: true },
      );

      expect(createResult.code).toBe(0);
      const item = (createResult.json as { item: { estimated_minutes: number; acceptance_criteria: string } }).item;
      expect(item.estimated_minutes).toBe(27);
      expect(item.acceptance_criteria).toBe("Snake case aliases are accepted for create");
    });
  });

  it("accepts snake_case update aliases for estimate and acceptance criteria", async () => {
    await withTempPmPath(async (context) => {
      const createResult = context.runCli(
        [
          "create",
          "--json",
          "--title",
          "Snake case update alias item",
          "--description",
          "Validate update snake_case aliases seed",
          "--type",
          "Task",
          "--status",
          "open",
          "--priority",
          "1",
          "--tags",
          "integration,contract",
          "--body",
          "",
          "--deadline",
          "none",
          "--estimate",
          "15",
          "--acceptance-criteria",
          "Seed flag",
          "--author",
          "integration-test",
          "--message",
          "Create seed for snake_case update aliases",
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
        ],
        { expectJson: true },
      );
      expect(createResult.code).toBe(0);
      const id = (createResult.json as { item: { id: string } }).item.id;

      const updateResult = context.runCli(
        [
          "update",
          id,
          "--json",
          "--estimated_minutes",
          "41",
          "--acceptance_criteria",
          "Snake case aliases are accepted for update",
          "--author",
          "integration-test",
          "--message",
          "Update with snake_case aliases",
        ],
        { expectJson: true },
      );
      expect(updateResult.code).toBe(0);
      const item = (updateResult.json as { item: { estimated_minutes: number; acceptance_criteria: string } }).item;
      expect(item.estimated_minutes).toBe(41);
      expect(item.acceptance_criteria).toBe("Snake case aliases are accepted for update");
    });
  });

  it("requires explicit repeatable seed flags for create contract parity", async () => {
    await withTempPmPath(async (context) => {
      const createWithoutRepeatables = context.runCli([
        "create",
        "--json",
        "--title",
        "Missing repeatable options",
        "--description",
        "Validate required create repeatable flag parity.",
        "--type",
        "Task",
        "--status",
        "open",
        "--priority",
        "1",
        "--tags",
        "integration,contract",
        "--body",
        "",
        "--deadline",
        "none",
        "--estimate",
        "15",
        "--acceptance-criteria",
        "Create rejects missing repeatable options",
        "--author",
        "integration-test",
        "--message",
        "Create missing repeatable option",
        "--assignee",
        "none",
      ]);

      expect(createWithoutRepeatables.code).toBe(2);
      expect(createWithoutRepeatables.stderr).toContain("--dep");
    });
  });

  it("requires explicit --assignee for create contract parity", async () => {
    await withTempPmPath(async (context) => {
      const createWithoutAssignee = context.runCli([
        "create",
        "--json",
        "--title",
        "Missing assignee option",
        "--description",
        "Validate required create flag parity.",
        "--type",
        "Task",
        "--status",
        "open",
        "--priority",
        "1",
        "--tags",
        "integration,contract",
        "--body",
        "",
        "--deadline",
        "none",
        "--estimate",
        "15",
        "--acceptance-criteria",
        "Create rejects missing assigned option",
        "--author",
        "integration-test",
        "--message",
        "Create missing assigned option",
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
      ]);

      expect(createWithoutAssignee.code).toBe(2);
      expect(createWithoutAssignee.stderr).toContain("--assignee");
    });
  });

  it("runs the core lifecycle without touching repo .agents/pm", async () => {
    await withTempPmPath(async (context) => {
      const initAgain = context.runCli(["init", "--json"], { expectJson: true });
      expect(initAgain.code).toBe(0);

      const createResult = context.runCli(
        [
          "create",
          "--json",
          "--title",
          "Integration Flow Item",
          "--description",
          "End-to-end test item",
          "--type",
          "Task",
          "--status",
          "open",
          "--priority",
          "1",
          "--tags",
          "integration,smoke",
          "--body",
          "",
          "--deadline",
          "none",
          "--estimate",
          "25",
          "--acceptance-criteria",
          "Lifecycle succeeds in sandbox",
          "--author",
          "integration-test",
          "--message",
          "Create integration item",
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
        ],
        { expectJson: true },
      );
      expect(createResult.code).toBe(0);
      const createJson = createResult.json as { item: { id: string } };
      const id = createJson.item.id;

      const historyAfterCreate = context.runCli(["history", id, "--json"], { expectJson: true });
      expect(historyAfterCreate.code).toBe(0);
      const historyAfterCreateJson = historyAfterCreate.json as { count: number; history: Array<{ op: string }> };
      expect(historyAfterCreateJson.count).toBeGreaterThanOrEqual(1);
      expect(historyAfterCreateJson.history.some((entry) => entry.op === "create")).toBe(true);

      const listOpen = context.runCli(["list-open", "--type", "Task", "--limit", "5", "--json"], { expectJson: true });
      expect(listOpen.code).toBe(0);

      const getResult = context.runCli(["get", id, "--json"], { expectJson: true });
      expect(getResult.code).toBe(0);

      const searchResult = context.runCli(["search", "integration", "--json", "--limit", "5"], { expectJson: true });
      expect(searchResult.code).toBe(0);
      const searchJson = searchResult.json as { mode: string; items: Array<{ item: { id: string } }> };
      expect(searchJson.mode).toBe("keyword");
      expect(searchJson.items.some((entry) => entry.item.id === id)).toBe(true);

      const reindexResult = context.runCli(["reindex", "--json"], { expectJson: true });
      expect(reindexResult.code).toBe(0);
      const reindexJson = reindexResult.json as {
        ok: boolean;
        mode: string;
        total_items: number;
        artifacts: { manifest: string; embeddings: string };
      };
      expect(reindexJson.ok).toBe(true);
      expect(reindexJson.mode).toBe("keyword");
      expect(reindexJson.total_items).toBeGreaterThanOrEqual(1);
      expect(reindexJson.artifacts).toEqual({
        manifest: "index/manifest.json",
        embeddings: "search/embeddings.jsonl",
      });
      const manifestPath = path.join(context.pmPath, "index", "manifest.json");
      const embeddingsPath = path.join(context.pmPath, "search", "embeddings.jsonl");
      const manifestContents = await readFile(manifestPath, "utf8");
      expect(manifestContents).toContain('"mode": "keyword"');
      expect(await readFile(embeddingsPath, "utf8")).toContain(id);

      const claimResult = context.runCli(["claim", id, "--json", "--author", "integration-test"], { expectJson: true });
      expect(claimResult.code).toBe(0);
      await expect(readFile(manifestPath, "utf8")).rejects.toBeDefined();
      await expect(readFile(embeddingsPath, "utf8")).rejects.toBeDefined();

      const updateResult = context.runCli(
        [
          "update",
          id,
          "--json",
          "--status",
          "in_progress",
          "--priority",
          "0",
          "--type",
          "Task",
          "--tags",
          "integration,smoke,updated",
          "--description",
          "Updated description",
          "--deadline",
          "none",
          "--estimate",
          "30",
          "--acceptance-criteria",
          "Still deterministic",
          "--author",
          "integration-test",
          "--message",
          "Move to in_progress",
        ],
        { expectJson: true },
      );
      expect(updateResult.code).toBe(0);

      const appendResult = context.runCli(
        ["append", id, "--json", "--body", "Appended integration notes", "--author", "integration-test", "--message", "Append body"],
        { expectJson: true },
      );
      expect(appendResult.code).toBe(0);

      const addComment = context.runCli(
        ["comments", id, "--json", "--add", "Integration comment", "--author", "integration-test", "--message", "Add comment"],
        { expectJson: true },
      );
      expect(addComment.code).toBe(0);
      const listComments = context.runCli(["comments", id, "--json", "--limit", "1"], { expectJson: true });
      expect(listComments.code).toBe(0);

      const addFile = context.runCli(
        ["files", id, "--json", "--add", "path=src/cli/main.ts,scope=project,note=integration", "--author", "integration-test", "--message", "Add file link"],
        { expectJson: true },
      );
      expect(addFile.code).toBe(0);
      const removeFile = context.runCli(
        ["files", id, "--json", "--remove", "src/cli/main.ts", "--author", "integration-test", "--message", "Remove file link"],
        { expectJson: true },
      );
      expect(removeFile.code).toBe(0);
      const listFiles = context.runCli(["files", id, "--json"], { expectJson: true });
      expect(listFiles.code).toBe(0);

      const addDoc = context.runCli(
        ["docs", id, "--json", "--add", "path=README.md,scope=project,note=integration", "--author", "integration-test", "--message", "Add doc link"],
        { expectJson: true },
      );
      expect(addDoc.code).toBe(0);
      const removeDoc = context.runCli(
        ["docs", id, "--json", "--remove", "README.md", "--author", "integration-test", "--message", "Remove doc link"],
        { expectJson: true },
      );
      expect(removeDoc.code).toBe(0);
      const listDocs = context.runCli(["docs", id, "--json"], { expectJson: true });
      expect(listDocs.code).toBe(0);

      const addTests = context.runCli(
        [
          "test",
          id,
          "--json",
          "--add",
          "command=node --version,scope=project,timeout=30,note=pass",
          "--add",
          "path=tests/example.spec.ts,scope=project,note=skip",
          "--author",
          "integration-test",
          "--message",
          "Add linked tests",
        ],
        { expectJson: true },
      );
      expect(addTests.code).toBe(0);
      const addTestsJson = addTests.json as { tests: Array<{ command?: string; timeout_seconds?: number }> };
      expect(addTestsJson.tests.some((entry) => entry.command === "node --version" && entry.timeout_seconds === 30)).toBe(
        true,
      );

      const runTests = context.runCli(["test", id, "--json", "--run", "--timeout", "30"], { expectJson: true });
      expect(runTests.code).toBe(0);
      const runTestsJson = runTests.json as { run_results: Array<{ status: string }> };
      expect(runTestsJson.run_results.some((entry) => entry.status === "passed")).toBe(true);

      const historyLatest = context.runCli(["history", id, "--json", "--limit", "1"], { expectJson: true });
      expect(historyLatest.code).toBe(0);
      const historyLatestJson = historyLatest.json as { count: number };
      expect(historyLatestJson.count).toBe(1);

      const activity = context.runCli(["activity", "--json", "--limit", "10"], { expectJson: true });
      expect(activity.code).toBe(0);
      const activityJson = activity.json as { activity: Array<{ id: string }> };
      expect(activityJson.activity.some((entry) => entry.id === id)).toBe(true);

      const stats = context.runCli(["stats", "--json"], { expectJson: true });
      expect(stats.code).toBe(0);
      const statsJson = stats.json as {
        totals: { items: number; history_streams: number; history_entries: number };
        by_type: { Task: number };
      };
      expect(statsJson.totals.items).toBeGreaterThanOrEqual(1);
      expect(statsJson.totals.history_streams).toBeGreaterThanOrEqual(1);
      expect(statsJson.totals.history_entries).toBeGreaterThanOrEqual(1);
      expect(statsJson.by_type.Task).toBeGreaterThanOrEqual(1);

      const health = context.runCli(["health", "--json"], { expectJson: true });
      expect(health.code).toBe(0);
      const healthJson = health.json as {
        ok: boolean;
        checks: Array<{ name: string }>;
        warnings: string[];
      };
      expect(healthJson.ok).toBe(true);
      expect(healthJson.warnings).toEqual([]);
      expect(healthJson.checks.map((check) => check.name)).toEqual([
        "settings",
        "directories",
        "settings_values",
        "extensions",
        "storage",
      ]);

      await writeFile(path.join(context.pmPath, "index", "manifest.json"), '{"seed":true}\n', "utf8");
      await writeFile(path.join(context.pmPath, "search", "embeddings.jsonl"), '{"id":"seed"}\n', "utf8");
      const gc = context.runCli(["gc", "--json"], { expectJson: true });
      expect(gc.code).toBe(0);
      const gcJson = gc.json as {
        ok: boolean;
        removed: string[];
        retained: string[];
        warnings: string[];
      };
      expect(gcJson.ok).toBe(true);
      expect(gcJson.removed).toEqual(["index/manifest.json", "search/embeddings.jsonl"]);
      expect(gcJson.retained).toEqual([]);
      expect(gcJson.warnings).toEqual([]);

      const testAll = context.runCli(["test-all", "--json", "--status", "in_progress"], { expectJson: true });
      expect(testAll.code).toBe(0);

      const closeResult = context.runCli(
        ["close", id, "Integration flow complete", "--json", "--author", "integration-test", "--message", "Close integration item"],
        { expectJson: true },
      );
      expect(closeResult.code).toBe(0);
      const closeJson = closeResult.json as { item: { status: string; close_reason: string; assignee?: string }; changed_fields: string[] };
      expect(closeJson.item.status).toBe("closed");
      expect(closeJson.item.close_reason).toBe("Integration flow complete");
      expect(closeJson.item.assignee).toBeUndefined();
      expect(closeJson.changed_fields).toEqual(expect.arrayContaining(["status", "close_reason"]));

      const releaseResult = context.runCli(["release", id, "--json"], { expectJson: true });
      expect(releaseResult.code).toBe(0);
    });
  }, 60_000);

  it("deletes an item through CLI and keeps history retrievable", async () => {
    await withTempPmPath(async (context) => {
      const createResult = context.runCli(
        [
          "create",
          "--json",
          "--title",
          "Delete Integration Item",
          "--description",
          "Validate delete command behavior in CLI flow",
          "--type",
          "Task",
          "--status",
          "open",
          "--priority",
          "1",
          "--tags",
          "integration,delete",
          "--body",
          "",
          "--deadline",
          "none",
          "--estimate",
          "20",
          "--acceptance-criteria",
          "Delete removes active item while preserving history",
          "--author",
          "integration-test",
          "--message",
          "Create delete integration item",
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
        ],
        { expectJson: true },
      );
      expect(createResult.code).toBe(0);
      const id = (createResult.json as { item: { id: string } }).item.id;

      const deleteResult = context.runCli(
        ["delete", id, "--json", "--author", "integration-test", "--message", "Delete integration item"],
        { expectJson: true },
      );
      expect(deleteResult.code).toBe(0);
      const deleteJson = deleteResult.json as {
        item: { id: string };
        changed_fields: string[];
      };
      expect(deleteJson.item.id).toBe(id);
      expect(deleteJson.changed_fields).toEqual(["deleted"]);

      const getDeleted = context.runCli(["get", id, "--json"], { expectJson: true });
      expect(getDeleted.code).toBe(3);

      const listAll = context.runCli(["list-all", "--json"], { expectJson: true });
      expect(listAll.code).toBe(0);
      const listAllJson = listAll.json as { items: Array<{ id: string }> };
      expect(listAllJson.items.some((item) => item.id === id)).toBe(false);

      const history = context.runCli(["history", id, "--json"], { expectJson: true });
      expect(history.code).toBe(0);
      const historyJson = history.json as { history: Array<{ op: string }> };
      expect(historyJson.history.at(-1)?.op).toBe("delete");
    });
  });

  it("filters list/list-* status commands across lifecycle states", async () => {
    await withTempPmPath(async (context) => {
      const createItem = (title: string, status: string, priority: string) =>
        context.runCli(
          [
            "create",
            "--json",
            "--title",
            title,
            "--description",
            `Seed ${title}`,
            "--type",
            "Task",
            "--status",
            status,
            "--priority",
            priority,
            "--tags",
            "integration,list-status",
            "--body",
            "",
            "--deadline",
            "none",
            "--estimate",
            "10",
            "--acceptance-criteria",
            `List command coverage for ${status}`,
            "--author",
            "integration-test",
            "--message",
            `Create ${title}`,
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
          ],
          { expectJson: true },
        );

      expect(createItem("List Open Priority One", "open", "1").code).toBe(0);
      expect(createItem("List Open Priority Zero", "open", "0").code).toBe(0);
      expect(createItem("List Draft", "draft", "4").code).toBe(0);
      expect(createItem("List In Progress", "in_progress", "2").code).toBe(0);
      expect(createItem("List Blocked", "blocked", "3").code).toBe(0);
      expect(createItem("List Closed", "closed", "1").code).toBe(0);
      expect(createItem("List Canceled", "canceled", "2").code).toBe(0);

      const listDraft = context.runCli(["list-draft", "--json", "--type", "Task"], { expectJson: true });
      expect(listDraft.code).toBe(0);
      const listDraftJson = listDraft.json as { count: number; items: Array<{ status: string }> };
      expect(listDraftJson.count).toBe(1);
      expect(listDraftJson.items.map((item) => item.status)).toEqual(["draft"]);

      const listOpen = context.runCli(["list-open", "--json", "--type", "Task"], { expectJson: true });
      expect(listOpen.code).toBe(0);
      const listOpenJson = listOpen.json as {
        count: number;
        items: Array<{ status: string; priority: number }>;
        filters: { status: string | null };
      };
      expect(listOpenJson.filters.status).toBe("open");
      expect(listOpenJson.count).toBe(2);
      expect(listOpenJson.items.map((item) => item.status)).toEqual(["open", "open"]);
      expect(listOpenJson.items.map((item) => item.priority)).toEqual([0, 1]);

      const listInProgress = context.runCli(["list-in-progress", "--json", "--type", "Task"], { expectJson: true });
      expect(listInProgress.code).toBe(0);
      const listInProgressJson = listInProgress.json as { count: number; items: Array<{ status: string }> };
      expect(listInProgressJson.count).toBe(1);
      expect(listInProgressJson.items.map((item) => item.status)).toEqual(["in_progress"]);

      const listBlocked = context.runCli(["list-blocked", "--json", "--type", "Task"], { expectJson: true });
      expect(listBlocked.code).toBe(0);
      const listBlockedJson = listBlocked.json as { count: number; items: Array<{ status: string }> };
      expect(listBlockedJson.count).toBe(1);
      expect(listBlockedJson.items.map((item) => item.status)).toEqual(["blocked"]);

      const listClosed = context.runCli(["list-closed", "--json", "--type", "Task"], { expectJson: true });
      expect(listClosed.code).toBe(0);
      const listClosedJson = listClosed.json as { count: number; items: Array<{ status: string }> };
      expect(listClosedJson.count).toBe(1);
      expect(listClosedJson.items.map((item) => item.status)).toEqual(["closed"]);

      const listCanceled = context.runCli(["list-canceled", "--json", "--type", "Task"], { expectJson: true });
      expect(listCanceled.code).toBe(0);
      const listCanceledJson = listCanceled.json as { count: number; items: Array<{ status: string }> };
      expect(listCanceledJson.count).toBe(1);
      expect(listCanceledJson.items.map((item) => item.status)).toEqual(["canceled"]);

      const listAll = context.runCli(["list-all", "--json", "--type", "Task"], { expectJson: true });
      expect(listAll.code).toBe(0);
      const listAllJson = listAll.json as { count: number; items: Array<{ status: string }> };
      expect(listAllJson.count).toBe(7);
      const allStatuses = listAllJson.items.map((item) => item.status);
      const firstTerminalIndex = allStatuses.findIndex((status) => status === "closed" || status === "canceled");
      expect(firstTerminalIndex).toBeGreaterThan(0);
      expect(allStatuses.slice(0, firstTerminalIndex).every((status) => status !== "closed" && status !== "canceled")).toBe(
        true,
      );
      expect(allStatuses.slice(firstTerminalIndex).every((status) => status === "closed" || status === "canceled")).toBe(
        true,
      );
    });
  });

  it("runs extension before/after command hooks with failure containment", async () => {
    await withTempPmPath(async (context) => {
      const extensionDir = path.join(context.pmPath, "extensions", "hook-ext");
      const hookLogPath = path.join(context.tempRoot, "hook-events.log");
      await mkdir(extensionDir, { recursive: true });

      await writeFile(
        path.join(extensionDir, "manifest.json"),
        `${JSON.stringify(
          {
            name: "hook-ext",
            version: "1.0.0",
            entry: "./index.mjs",
            capabilities: ["hooks"],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      await writeFile(
        path.join(extensionDir, "index.mjs"),
        [
          "import fs from 'node:fs';",
          "export default {",
          "  activate(api) {",
          "    api.hooks.beforeCommand(() => {",
          "      throw new Error('before-hook-boom');",
          "    });",
          String.raw`    api.hooks.beforeCommand((event) => { fs.appendFileSync(${JSON.stringify(hookLogPath)}, 'before:' + event.command + '\n', 'utf8'); });`,
          String.raw`    api.hooks.afterCommand((event) => { fs.appendFileSync(${JSON.stringify(hookLogPath)}, 'after:' + event.command + '\n', 'utf8'); });`,
          "  }",
          "};",
          "",
        ].join("\n"),
        "utf8",
      );

      const listOpen = context.runCli(["--profile", "list-open", "--json", "--limit", "1"], { expectJson: true });
      expect(listOpen.code).toBe(0);
      expect(listOpen.stderr).toContain("extension_hook_failed:project:hook-ext:beforeCommand");

      const hookLog = await readFile(hookLogPath, "utf8");
      expect(hookLog.trim().split("\n")).toEqual(["before:list-open", "after:list-open"]);
    });
  });

  it("runs extension afterCommand hooks for failed commands", async () => {
    await withTempPmPath(async (context) => {
      const extensionDir = path.join(context.pmPath, "extensions", "hook-failure-ext");
      const hookLogPath = path.join(context.tempRoot, "hook-failure-events.log");
      await mkdir(extensionDir, { recursive: true });

      await writeFile(
        path.join(extensionDir, "manifest.json"),
        `${JSON.stringify(
          {
            name: "hook-failure-ext",
            version: "1.0.0",
            entry: "./index.mjs",
            capabilities: ["hooks"],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      await writeFile(
        path.join(extensionDir, "index.mjs"),
        [
          "import fs from 'node:fs';",
          "export default {",
          "  activate(api) {",
          String.raw`    api.hooks.afterCommand((event) => { fs.appendFileSync(${JSON.stringify(hookLogPath)}, 'after:' + event.command + ':ok=' + String(event.ok) + ':error=' + String(event.error ?? '') + '\n', 'utf8'); });`,
          "  }",
          "};",
          "",
        ].join("\n"),
        "utf8",
      );

      const missingGet = context.runCli(["get", "pm-missing", "--json"]);
      expect(missingGet.code).toBe(3);
      expect(missingGet.stderr).toContain("Item pm-missing not found");

      const hookLog = await readFile(hookLogPath, "utf8");
      expect(hookLog.trim()).toContain("after:get:ok=false:error=Item pm-missing not found");
    });
  });

  it("blocks mutating commands for unresolved mandatory migrations and supports force bypass where available", async () => {
    await withTempPmPath(async (context) => {
      const extensionDir = path.join(context.pmPath, "extensions", "migration-gate-ext");
      await mkdir(extensionDir, { recursive: true });

      await writeFile(
        path.join(extensionDir, "manifest.json"),
        `${JSON.stringify(
          {
            name: "migration-gate-ext",
            version: "1.0.0",
            entry: "./index.mjs",
            capabilities: ["schema"],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      await writeFile(
        path.join(extensionDir, "index.mjs"),
        [
          "export default {",
          "  activate(api) {",
          "    api.registerMigration({ id: 'required-schema', mandatory: true, status: 'pending' });",
          "  }",
          "};",
          "",
        ].join("\n"),
        "utf8",
      );

      const blockedCreate = context.runCli([
        "create",
        "--json",
        "--title",
        "Blocked by migration gate",
        "--description",
        "create should be blocked",
        "--type",
        "Task",
        "--status",
        "open",
        "--priority",
        "1",
        "--tags",
        "integration,migration-gate",
        "--body",
        "",
        "--deadline",
        "none",
        "--estimate",
        "20",
        "--acceptance-criteria",
        "Create is blocked",
        "--author",
        "integration-test",
        "--message",
        "Attempt blocked create",
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
      ]);
      expect(blockedCreate.code).toBe(4);
      expect(blockedCreate.stderr).toContain('Write command "create" blocked by unresolved mandatory extension migrations');
      expect(blockedCreate.stderr).toContain(
        "extension_migration_blocking:project:migration-gate-ext:required-schema:pending",
      );
      expect(blockedCreate.stderr).toContain("does not support --force bypass");

      const seedCreate = context.runCli(
        [
          "--no-extensions",
          "create",
          "--json",
          "--title",
          "Seed item for update gate",
          "--description",
          "Created without extensions to seed update test",
          "--type",
          "Task",
          "--status",
          "open",
          "--priority",
          "1",
          "--tags",
          "integration,migration-gate",
          "--body",
          "",
          "--deadline",
          "none",
          "--estimate",
          "20",
          "--acceptance-criteria",
          "Seed item exists",
          "--author",
          "integration-test",
          "--message",
          "Seed create without extensions",
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
        ],
        { expectJson: true },
      );
      expect(seedCreate.code).toBe(0);
      const seededId = (seedCreate.json as { item: { id: string } }).item.id;

      const blockedUpdate = context.runCli([
        "update",
        seededId,
        "--json",
        "--status",
        "in_progress",
        "--author",
        "integration-test",
        "--message",
        "Attempt blocked update",
      ]);
      expect(blockedUpdate.code).toBe(4);
      expect(blockedUpdate.stderr).toContain('Write command "update" blocked by unresolved mandatory extension migrations');
      expect(blockedUpdate.stderr).toContain("Re-run this command with --force to bypass");

      const forcedUpdate = context.runCli(
        [
          "update",
          seededId,
          "--json",
          "--status",
          "in_progress",
          "--author",
          "integration-test",
          "--message",
          "Force update with unresolved mandatory migration",
          "--force",
        ],
        { expectJson: true },
      );
      expect(forcedUpdate.code).toBe(0);

      const getUpdated = context.runCli(["get", seededId, "--json"], { expectJson: true });
      expect(getUpdated.code).toBe(0);
      const getUpdatedJson = getUpdated.json as { item: { status: string } };
      expect(getUpdatedJson.item.status).toBe("in_progress");
    });
  });

  it("treats case-insensitive applied mandatory migration status as resolved", async () => {
    await withTempPmPath(async (context) => {
      const extensionDir = path.join(context.pmPath, "extensions", "migration-applied-ext");
      await mkdir(extensionDir, { recursive: true });

      await writeFile(
        path.join(extensionDir, "manifest.json"),
        `${JSON.stringify(
          {
            name: "migration-applied-ext",
            version: "1.0.0",
            entry: "./index.mjs",
            capabilities: ["schema"],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      await writeFile(
        path.join(extensionDir, "index.mjs"),
        [
          "export default {",
          "  activate(api) {",
          "    api.registerMigration({ id: 'already-applied', mandatory: true, status: 'ApPlIeD' });",
          "  }",
          "};",
          "",
        ].join("\n"),
        "utf8",
      );

      const createResult = context.runCli(
        [
          "create",
          "--json",
          "--title",
          "Applied migration does not block",
          "--description",
          "Create should succeed when mandatory migration status is applied",
          "--type",
          "Task",
          "--status",
          "open",
          "--priority",
          "1",
          "--tags",
          "integration,migration-gate",
          "--body",
          "",
          "--deadline",
          "none",
          "--estimate",
          "20",
          "--acceptance-criteria",
          "Create succeeds",
          "--author",
          "integration-test",
          "--message",
          "Create with resolved mandatory migration",
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
        ],
        { expectJson: true },
      );
      expect(createResult.code).toBe(0);
    });
  });

  it("runs extension read/write/index hooks for item-store, history/activity, and reindex flows", async () => {
    await withTempPmPath(async (context) => {
      const extensionDir = path.join(context.pmPath, "extensions", "rw-index-hook-ext");
      const hookLogPath = path.join(context.tempRoot, "rw-index-events.log");
      await mkdir(extensionDir, { recursive: true });

      await writeFile(
        path.join(extensionDir, "manifest.json"),
        `${JSON.stringify(
          {
            name: "rw-index-hook-ext",
            version: "1.0.0",
            entry: "./index.mjs",
            capabilities: ["hooks"],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      await writeFile(
        path.join(extensionDir, "index.mjs"),
        [
          "import fs from 'node:fs';",
          String.raw`const basename = (value) => value.split(/[\/\\]/).at(-1) ?? value;`,
          "export default {",
          "  activate(api) {",
          String.raw`    api.hooks.onRead((event) => { fs.appendFileSync(${JSON.stringify(hookLogPath)}, 'read:' + basename(event.path) + '\n', 'utf8'); });`,
          String.raw`    api.hooks.onWrite((event) => { fs.appendFileSync(${JSON.stringify(hookLogPath)}, 'write:' + event.op + ':' + basename(event.path) + '\n', 'utf8'); });`,
          String.raw`    api.hooks.onIndex((event) => { fs.appendFileSync(${JSON.stringify(hookLogPath)}, 'index:' + event.mode + ':' + String(event.total_items ?? '') + '\n', 'utf8'); });`,
          "  }",
          "};",
          "",
        ].join("\n"),
        "utf8",
      );

      const createResult = context.runCli(
        [
          "create",
          "--json",
          "--title",
          "Hook IO Item",
          "--description",
          "Validate read/write/index hook call sites",
          "--type",
          "Task",
          "--status",
          "open",
          "--priority",
          "1",
          "--tags",
          "integration,hooks",
          "--body",
          "",
          "--deadline",
          "none",
          "--estimate",
          "10",
          "--acceptance-criteria",
          "Read/write/index hooks are dispatched",
          "--author",
          "integration-test",
          "--message",
          "Create hook IO item",
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
        ],
        { expectJson: true },
      );
      expect(createResult.code).toBe(0);
      const id = (createResult.json as { item: { id: string } }).item.id;

      const updateResult = context.runCli(
        ["update", id, "--json", "--status", "in_progress", "--author", "integration-test", "--message", "Trigger write hook"],
        { expectJson: true },
      );
      expect(updateResult.code).toBe(0);

      const getResult = context.runCli(["get", id, "--json"], { expectJson: true });
      expect(getResult.code).toBe(0);

      const historyResult = context.runCli(["history", id, "--json"], { expectJson: true });
      expect(historyResult.code).toBe(0);

      const activityResult = context.runCli(["activity", "--json"], { expectJson: true });
      expect(activityResult.code).toBe(0);

      const reindexResult = context.runCli(["reindex", "--json"], { expectJson: true });
      expect(reindexResult.code).toBe(0);

      const initRewriteResult = context.runCli(["init", "zz-", "--json"], { expectJson: true });
      expect(initRewriteResult.code).toBe(0);

      const hookLog = await readFile(hookLogPath, "utf8");
      const lines = hookLog
        .trim()
        .split("\n")
        .filter((entry) => entry.length > 0);
      expect(lines.some((line) => line.startsWith("write:update:") && line.endsWith(".md"))).toBe(true);
      expect(lines.includes(`read:${id}.md`)).toBe(true);
      expect(lines.filter((line) => line === `read:${id}.jsonl`).length).toBeGreaterThanOrEqual(2);
      expect(lines).toContain("read:settings.json");
      expect(lines).toContain("write:settings:write:settings.json");
      expect(lines).toContain("write:reindex:manifest:manifest.json");
      expect(lines).toContain("write:reindex:embeddings:embeddings.jsonl");
      expect(lines.some((line) => /^index:keyword:\d+$/.test(line))).toBe(true);
    });
  });

  it("runs extension command-result and renderer overrides with safe fallback", async () => {
    await withTempPmPath(async (context) => {
      const extensionDir = path.join(context.pmPath, "extensions", "command-renderer-ext");
      await mkdir(extensionDir, { recursive: true });

      await writeFile(
        path.join(extensionDir, "manifest.json"),
        `${JSON.stringify(
          {
            name: "command-renderer-ext",
            version: "1.0.0",
            entry: "./index.mjs",
            capabilities: ["commands", "renderers"],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      await writeFile(
        path.join(extensionDir, "index.mjs"),
        [
          "export default {",
          "  activate(api) {",
          "    api.registerCommand('list-open', (context) => ({ ...context.result, override_marker: true }));",
          "    api.registerCommand('list-all', () => { throw new Error('command-override-boom'); });",
          "    api.registerRenderer('json', (context) => JSON.stringify({ rendered_by: 'command-renderer-ext', payload: context.result }));",
          "  }",
          "};",
          "",
        ].join("\n"),
        "utf8",
      );

      const listOpen = context.runCli(["list-open", "--json", "--limit", "1"], { expectJson: true });
      expect(listOpen.code).toBe(0);
      const openJson = listOpen.json as {
        rendered_by: string;
        payload: {
          items: unknown[];
          count: number;
          override_marker?: boolean;
        };
      };
      expect(openJson.rendered_by).toBe("command-renderer-ext");
      expect(openJson.payload.override_marker).toBe(true);

      const listAll = context.runCli(["list-all", "--json", "--limit", "1"], { expectJson: true });
      expect(listAll.code).toBe(0);
      const allJson = listAll.json as {
        rendered_by: string;
        payload: {
          items: unknown[];
          count: number;
          override_marker?: boolean;
        };
      };
      expect(allJson.rendered_by).toBe("command-renderer-ext");
      expect(Array.isArray(allJson.payload.items)).toBe(true);
      expect(typeof allJson.payload.count).toBe("number");
      expect(allJson.payload.override_marker).toBeUndefined();
    });
  });

  it("dispatches declared command paths through extension command handlers", async () => {
    await withTempPmPath(async (context) => {
      const extensionDir = path.join(context.pmPath, "extensions", "beads-command-handler-ext");
      await mkdir(extensionDir, { recursive: true });

      await writeFile(
        path.join(extensionDir, "manifest.json"),
        `${JSON.stringify(
          {
            name: "beads-command-handler-ext",
            version: "1.0.0",
            entry: "./index.mjs",
            capabilities: ["commands"],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      await writeFile(
        path.join(extensionDir, "index.mjs"),
        [
          "export default {",
          "  activate(api) {",
          "    api.registerCommand({",
          "      name: 'beads import',",
          "      run: () => ({ ok: true, source: 'beads-command-handler-ext', imported: 0, skipped: 0, ids: [], warnings: [] })",
          "    });",
          "  }",
          "};",
          "",
        ].join("\n"),
        "utf8",
      );

      const imported = context.runCli(["beads", "import", "--json", "--file", path.join(context.tempRoot, "missing.jsonl")], {
        expectJson: true,
      });
      expect(imported.code).toBe(0);
      const importedJson = imported.json as {
        ok: boolean;
        source: string;
        imported: number;
        skipped: number;
        ids: string[];
        warnings: string[];
      };
      expect(importedJson).toEqual({
        ok: true,
        source: "beads-command-handler-ext",
        imported: 0,
        skipped: 0,
        ids: [],
        warnings: [],
      });
    });
  });

  it("dispatches extension-defined non-core command paths through dynamically surfaced handlers", async () => {
    await withTempPmPath(async (context) => {
      const extensionDir = path.join(context.pmPath, "extensions", "acme-sync-handler-ext");
      await mkdir(extensionDir, { recursive: true });

      await writeFile(
        path.join(extensionDir, "manifest.json"),
        `${JSON.stringify(
          {
            name: "acme-sync-handler-ext",
            version: "1.0.0",
            entry: "./index.mjs",
            capabilities: ["commands"],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      await writeFile(
        path.join(extensionDir, "index.mjs"),
        [
          "export default {",
          "  activate(api) {",
          "    api.registerCommand({",
          "      name: 'acme sync',",
          "      run: (context) => ({",
          "        ok: true,",
          "        source: 'acme-sync-handler-ext',",
          "        command: context.command,",
          "        args: context.args,",
          "        options: context.options,",
          "      })",
          "    });",
          "  }",
          "};",
          "",
        ].join("\n"),
        "utf8",
      );

      const dispatched = context.runCli(
        ["acme", "sync", "--json", "--dry-run", "--limit", "2", "--tag", "alpha", "--tag", "beta", "artifact-A"],
        { expectJson: true },
      );
      expect(dispatched.code).toBe(0);

      const dispatchedJson = dispatched.json as {
        ok: boolean;
        source: string;
        command: string;
        args: string[];
        options: {
          dryRun: boolean;
          limit: string;
          tag: string[];
        };
      };

      expect(dispatchedJson.ok).toBe(true);
      expect(dispatchedJson.source).toBe("acme-sync-handler-ext");
      expect(dispatchedJson.command).toBe("acme sync");
      expect(dispatchedJson.args).toEqual(["--dry-run", "--limit", "2", "--tag", "alpha", "--tag", "beta", "artifact-A"]);
      expect(dispatchedJson.options).toEqual({
        dryRun: true,
        limit: "2",
        tag: ["alpha", "beta"],
      });
    });
  });

  it("surfaces registerFlags metadata in dynamic command help without changing loose option parsing", async () => {
    await withTempPmPath(async (context) => {
      const extensionDir = path.join(context.pmPath, "extensions", "acme-sync-flag-help-ext");
      await mkdir(extensionDir, { recursive: true });

      await writeFile(
        path.join(extensionDir, "manifest.json"),
        `${JSON.stringify(
          {
            name: "acme-sync-flag-help-ext",
            version: "1.0.0",
            entry: "./index.mjs",
            capabilities: ["commands", "schema"],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      await writeFile(
        path.join(extensionDir, "index.mjs"),
        [
          "export default {",
          "  activate(api) {",
          "    api.registerFlags(' acme   sync ', [",
          "      { long: '--dry-run', short: '-d', description: 'Run without side effects' },",
          "      { long: '--limit', value_name: 'count' },",
          "      { long: 'invalid-long', description: 'Ignored invalid long flag' }",
          "    ]);",
          "    api.registerCommand({",
          "      name: 'acme sync',",
          "      run: (context) => ({",
          "        ok: true,",
          "        source: 'acme-sync-flag-help-ext',",
          "        args: context.args,",
          "        options: context.options,",
          "      })",
          "    });",
          "  }",
          "};",
          "",
        ].join("\n"),
        "utf8",
      );

      const helpResult = context.runCli(["acme", "sync", "--help"]);
      expect(helpResult.code).toBe(0);
      expect(helpResult.stdout).toContain("Extension-provided flags:");
      expect(helpResult.stdout).toContain("-d, --dry-run  Run without side effects");
      expect(helpResult.stdout).toContain("--limit <count>  Extension-provided option.");
      expect(helpResult.stdout).not.toContain("Ignored invalid long flag");

      const dispatched = context.runCli(["acme", "sync", "--json", "--dry-run", "--limit", "2", "artifact-Z"], {
        expectJson: true,
      });
      expect(dispatched.code).toBe(0);
      const dispatchedJson = dispatched.json as {
        ok: boolean;
        source: string;
        args: string[];
        options: {
          dryRun: boolean;
          limit: string;
        };
      };
      expect(dispatchedJson.ok).toBe(true);
      expect(dispatchedJson.source).toBe("acme-sync-flag-help-ext");
      expect(dispatchedJson.args).toEqual(["--dry-run", "--limit", "2", "artifact-Z"]);
      expect(dispatchedJson.options).toEqual({
        dryRun: true,
        limit: "2",
      });
    });
  });

  it("returns generic failure when a matched extension command handler throws", async () => {
    await withTempPmPath(async (context) => {
      const extensionDir = path.join(context.pmPath, "extensions", "beads-command-handler-fail-ext");
      await mkdir(extensionDir, { recursive: true });

      await writeFile(
        path.join(extensionDir, "manifest.json"),
        `${JSON.stringify(
          {
            name: "beads-command-handler-fail-ext",
            version: "1.0.0",
            entry: "./index.mjs",
            capabilities: ["commands"],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      await writeFile(
        path.join(extensionDir, "index.mjs"),
        [
          "export default {",
          "  activate(api) {",
          "    api.registerCommand({",
          "      name: 'beads import',",
          "      run: () => { throw new Error('handler-boom'); }",
          "    });",
          "  }",
          "};",
          "",
        ].join("\n"),
        "utf8",
      );

      const imported = context.runCli(["beads", "import", "--json", "--file", path.join(context.tempRoot, "missing.jsonl")]);
      expect(imported.code).toBe(1);
      expect(imported.stderr).toContain('Command "beads import" failed in extension handler');
      expect(imported.stderr).toContain("extension_command_handler_failed:project:beads-command-handler-fail-ext:beads import");
    });
  });

  it("treats beads import as extension-only when extensions are disabled", async () => {
    await withTempPmPath(async (context) => {
      const sourcePath = path.join(context.tempRoot, "beads-extension-only.jsonl");
      await writeFile(
        sourcePath,
        `${JSON.stringify({
          id: "beads-extension-only",
          title: "Beads Extension Only",
          issue_type: "task",
          status: "open",
          priority: 2,
        })}\n`,
        "utf8",
      );

      const disabled = context.runCli(["--no-extensions", "beads", "import", "--json", "--file", sourcePath]);
      expect(disabled.code).toBe(3);
      expect(disabled.stderr).toContain('Command "beads import" is provided by extensions');
    });
  });

  it("treats todos import/export as extension-only when extensions are disabled", async () => {
    await withTempPmPath(async (context) => {
      const todosFolder = path.join(context.tempRoot, "todos-extension-only");
      await mkdir(todosFolder, { recursive: true });

      const importDisabled = context.runCli(["--no-extensions", "todos", "import", "--json", "--folder", todosFolder]);
      expect(importDisabled.code).toBe(3);
      expect(importDisabled.stderr).toContain('Command "todos import" is provided by extensions');

      const exportDisabled = context.runCli(["--no-extensions", "todos", "export", "--json", "--folder", todosFolder]);
      expect(exportDisabled.code).toBe(3);
      expect(exportDisabled.stderr).toContain('Command "todos export" is provided by extensions');
    });
  });

  it("imports and exports todos markdown through built-in extension commands", async () => {
    await withTempPmPath(async (context) => {
      const sourceFolder = path.join(context.tempRoot, "todos-cli-source");
      await mkdir(sourceFolder, { recursive: true });

      await writeFile(
        path.join(sourceFolder, "todo-cli-one.md"),
        `${JSON.stringify(
          {
            id: "todo-cli-one",
            title: "Todos CLI One",
            status: "open",
            tags: ["todos", "cli"],
            created_at: "2026-02-02T00:00:00.000Z",
          },
          null,
          2,
        )}\n\nTodos CLI body.\n`,
        "utf8",
      );
      await writeFile(
        path.join(sourceFolder, "todo-cli-missing-title.md"),
        `${JSON.stringify({ id: "todo-cli-missing-title", status: "open", tags: ["todos"] }, null, 2)}\n\nskip\n`,
        "utf8",
      );

      const imported = context.runCli(
        [
          "todos",
          "import",
          "--json",
          "--folder",
          sourceFolder,
          "--author",
          "integration-test",
          "--message",
          "Integration todos import",
        ],
        { expectJson: true },
      );
      expect(imported.code).toBe(0);
      const importedJson = imported.json as {
        ok: boolean;
        folder: string;
        imported: number;
        skipped: number;
        ids: string[];
        warnings: string[];
      };
      expect(importedJson.ok).toBe(true);
      expect(importedJson.folder).toBe(sourceFolder);
      expect(importedJson.imported).toBe(1);
      expect(importedJson.skipped).toBe(1);
      expect(importedJson.ids).toEqual(["pm-todo-cli-one"]);
      expect(importedJson.warnings).toContain("todos_import_missing_title:todo-cli-missing-title.md");

      const importedItem = context.runCli(["get", "pm-todo-cli-one", "--json"], { expectJson: true });
      expect(importedItem.code).toBe(0);
      const importedItemJson = importedItem.json as {
        item: { type: string; status: string; priority: number; description: string };
        body: string;
      };
      expect(importedItemJson.item.type).toBe("Task");
      expect(importedItemJson.item.status).toBe("open");
      expect(importedItemJson.item.priority).toBe(2);
      expect(importedItemJson.item.description).toBe("");
      expect(importedItemJson.body).toBe("Todos CLI body.");

      const destinationFolder = path.join(context.tempRoot, "todos-cli-export");
      const exported = context.runCli(["todos", "export", "--json", "--folder", destinationFolder], { expectJson: true });
      expect(exported.code).toBe(0);
      const exportedJson = exported.json as {
        ok: boolean;
        folder: string;
        exported: number;
        ids: string[];
        warnings: string[];
      };
      expect(exportedJson.ok).toBe(true);
      expect(exportedJson.folder).toBe(destinationFolder);
      expect(exportedJson.exported).toBeGreaterThanOrEqual(1);
      expect(exportedJson.ids).toContain("pm-todo-cli-one");
      expect(exportedJson.warnings).toEqual([]);

      const exportedRaw = await readFile(path.join(destinationFolder, "pm-todo-cli-one.md"), "utf8");
      const exportedDoc = splitFrontMatter(exportedRaw);
      const exportedFrontMatter = JSON.parse(exportedDoc.frontMatter) as Record<string, unknown>;
      expect(exportedFrontMatter).toMatchObject({
        id: "pm-todo-cli-one",
        title: "Todos CLI One",
        status: "open",
      });
      expect(exportedFrontMatter.tags).toEqual(["cli", "todos"]);
      expect(typeof exportedFrontMatter.created_at).toBe("string");
      expect(exportedDoc.body.trim()).toBe("Todos CLI body.");
    });
  });

  it("enforces ownership conflicts across assignees", async () => {
    await withTempPmPath(async (context) => {
      const createResult = context.runCli(
        [
          "create",
          "--json",
          "--title",
          "Ownership Conflict Item",
          "--description",
          "Conflict flow",
          "--type",
          "Task",
          "--status",
          "open",
          "--priority",
          "1",
          "--tags",
          "integration,conflict",
          "--body",
          "",
          "--deadline",
          "none",
          "--estimate",
          "20",
          "--acceptance-criteria",
          "Conflict is enforced",
          "--author",
          "integration-test",
          "--message",
          "Create conflict item",
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
        ],
        { expectJson: true },
      );
      expect(createResult.code).toBe(0);
      const id = (createResult.json as { item: { id: string } }).item.id;

      const claim = context.runCli(["claim", id, "--json"], { expectJson: true });
      expect(claim.code).toBe(0);

      const otherAssignee = spawnSync(
        process.execPath,
        [distCliPath(), "update", id, "--json", "--status", "blocked", "--author", "other", "--message", "Try update"],
        {
          cwd: process.cwd(),
          env: context.env,
          encoding: "utf8",
        },
      );
      expect(otherAssignee.status).toBe(4);
      expect(otherAssignee.stderr).toContain("assigned to");
    });
  });

  it("imports Beads JSONL records through the beads import CLI command", async () => {
    await withTempPmPath(async (context) => {
      const sourcePath = path.join(context.tempRoot, "beads-integration.jsonl");
      const lines = [
        JSON.stringify({
          id: "beads-integration-1",
          title: "Beads Integration One",
          issue_type: "task",
          status: "open",
          priority: 1,
          tags: ["beads", "integration"],
          description: "Imported from integration fixture",
          body: "integration-body-1",
          comments: [{ text: "seed-comment", author: "integration-test", created_at: "2026-02-01T00:00:00.000Z" }],
        }),
        JSON.stringify({
          id: "beads-integration-2",
          title: "Beads Integration Two",
          issue_type: "feature",
          status: "blocked",
          priority: 0,
          tags: "beads,imported",
          body: "integration-body-2",
        }),
      ];
      await writeFile(sourcePath, `${lines.join("\n")}\n`, "utf8");

      const imported = context.runCli(
        ["beads", "import", "--json", "--file", sourcePath, "--author", "integration-test", "--message", "Integration beads import"],
        { expectJson: true },
      );
      expect(imported.code).toBe(0);
      const importedJson = imported.json as {
        ok: boolean;
        source: string;
        imported: number;
        skipped: number;
        ids: string[];
        warnings: string[];
      };
      expect(importedJson.ok).toBe(true);
      expect(importedJson.source).toBe(sourcePath);
      expect(importedJson.imported).toBe(2);
      expect(importedJson.skipped).toBe(0);
      expect(importedJson.ids).toEqual(["pm-beads-integration-1", "pm-beads-integration-2"]);
      expect(importedJson.warnings).toEqual([]);

      const first = context.runCli(["get", "pm-beads-integration-1", "--json"], { expectJson: true });
      expect(first.code).toBe(0);
      const firstJson = first.json as { item: { type: string; status: string }; body: string };
      expect(firstJson.item.type).toBe("Task");
      expect(firstJson.item.status).toBe("open");
      expect(firstJson.body).toBe("integration-body-1");

      const second = context.runCli(["get", "pm-beads-integration-2", "--json"], { expectJson: true });
      expect(second.code).toBe(0);
      const secondJson = second.json as { item: { type: string; status: string; priority: number } };
      expect(secondJson.item.type).toBe("Feature");
      expect(secondJson.item.status).toBe("blocked");
      expect(secondJson.item.priority).toBe(0);

      const history = context.runCli(["history", "pm-beads-integration-1", "--json"], { expectJson: true });
      expect(history.code).toBe(0);
      const historyJson = history.json as { history: Array<{ op: string }> };
      expect(historyJson.history.some((entry) => entry.op === "import")).toBe(true);
    });
  });

  it("returns dependency-failed exit code when any linked test fails", async () => {
    await withTempPmPath(async (context) => {
      const createFailing = context.runCli(
        [
          "create",
          "--json",
          "--title",
          "Failing test-all item",
          "--description",
          "Used to validate dependency-failed exit code",
          "--type",
          "Task",
          "--status",
          "in_progress",
          "--priority",
          "1",
          "--tags",
          "integration,test-all",
          "--body",
          "",
          "--deadline",
          "none",
          "--estimate",
          "10",
          "--acceptance-criteria",
          "test-all exits with dependency failed when this test fails",
          "--author",
          "integration-test",
          "--message",
          "Create failing item for test-all",
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
          "command=node --this-flag-does-not-exist,scope=project,timeout=30",
          "--doc",
          "none",
        ],
        { expectJson: true },
      );
      expect(createFailing.code).toBe(0);
      const createFailingJson = createFailing.json as { item: { tests?: Array<{ timeout_seconds?: number }> } };
      expect(createFailingJson.item.tests?.[0]?.timeout_seconds).toBe(30);

      const createPassing = context.runCli(
        [
          "create",
          "--json",
          "--title",
          "Passing test-all item",
          "--description",
          "Companion item to ensure mixed pass/fail aggregation",
          "--type",
          "Task",
          "--status",
          "in_progress",
          "--priority",
          "1",
          "--tags",
          "integration,test-all",
          "--body",
          "",
          "--deadline",
          "none",
          "--estimate",
          "10",
          "--acceptance-criteria",
          "One linked test passes",
          "--author",
          "integration-test",
          "--message",
          "Create passing item for test-all",
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
          "command=node --version,scope=project",
          "--doc",
          "none",
        ],
        { expectJson: true },
      );
      expect(createPassing.code).toBe(0);

      const testAll = context.runCli(["test-all", "--json", "--status", "in_progress", "--timeout", "30"], {
        expectJson: true,
      });
      expect(testAll.code).toBe(5);

      const testAllJson = testAll.json as {
        failed: number;
        totals: { items: number; linked_tests: number; failed: number };
        results: Array<{ failed: number; run_results: Array<{ status: string }> }>;
      };

      expect(testAllJson.totals.items).toBe(2);
      expect(testAllJson.totals.linked_tests).toBe(2);
      expect(testAllJson.failed).toBeGreaterThanOrEqual(1);
      expect(testAllJson.totals.failed).toBeGreaterThanOrEqual(1);
      expect(testAllJson.results.some((entry) => entry.failed > 0)).toBe(true);
      expect(testAllJson.results.some((entry) => entry.run_results.some((result) => result.status === "failed"))).toBe(true);
    });
  });

  it("returns generic-failure exit code for unexpected init filesystem errors", async () => {
    await withTempPmPath(async (context) => {
      const blockedRoot = path.join(context.tempRoot, "blocked-pm-root");
      await writeFile(blockedRoot, "not-a-directory", "utf8");

      const init = context.runCli(["init", "--path", blockedRoot, "--json"]);
      expect(init.code).toBe(1);
      expect(init.stderr.trim().length).toBeGreaterThan(0);
    });
  });

  it("rejects linked test entries that invoke test-all recursively", async () => {
    await withTempPmPath(async (context) => {
      const create = context.runCli(
        [
          "create",
          "--json",
          "--title",
          "Reject Recursive test-all Link",
          "--description",
          "Ensure test command blocks recursive test-all links",
          "--type",
          "Task",
          "--status",
          "open",
          "--priority",
          "1",
          "--tags",
          "integration,test-all",
          "--body",
          "",
          "--deadline",
          "none",
          "--estimate",
          "10",
          "--acceptance-criteria",
          "test command rejects recursive test-all links",
          "--author",
          "integration-test",
          "--message",
          "Create item for recursion guard",
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
        ],
        { expectJson: true },
      );
      expect(create.code).toBe(0);
      const id = (create.json as { item: { id: string } }).item.id;

      const addRecursiveLink = context.runCli(
        ["test", id, "--json", "--add", "command=node dist/cli.js test-all --json,scope=project"],
        { expectJson: true },
      );
      expect(addRecursiveLink.code).toBe(2);
      expect(addRecursiveLink.stderr).toContain("must not invoke");
    });
  });

it("restores an item by version through CLI", async () => {
    await withTempPmPath(async (context) => {
      const create = context.runCli(
        [
          "create",
          "--json",
          "--title",
          "Restore CLI Item",
          "--description",
          "Verify restore command",
          "--type",
          "Task",
          "--status",
          "open",
          "--priority",
          "1",
          "--tags",
          "integration,restore",
          "--body",
          "body-v1",
          "--deadline",
          "none",
          "--estimate",
          "10",
          "--acceptance-criteria",
          "Restore command works",
          "--author",
          "integration-test",
          "--message",
          "Create restore fixture",
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
        ],
        { expectJson: true },
      );
      expect(create.code).toBe(0);
      const id = (create.json as { item: { id: string } }).item.id;

      const update = context.runCli(
        [
          "update",
          id,
          "--json",
          "--status",
          "in_progress",
          "--description",
          "changed",
          "--author",
          "integration-test",
          "--message",
          "Mutate before restore",
        ],
        { expectJson: true },
      );
      expect(update.code).toBe(0);

      const append = context.runCli(
        ["append", id, "--json", "--body", "body-v2", "--author", "integration-test", "--message", "Append before restore"],
        { expectJson: true },
      );
      expect(append.code).toBe(0);

      const restore = context.runCli(
        ["restore", id, "1", "--json", "--author", "integration-test", "--message", "Restore to v1"],
        { expectJson: true },
      );
      expect(restore.code).toBe(0);
      const restoreJson = restore.json as {
        item: { status: string };
        restored_from: { kind: string; history_index: number };
      };
      expect(restoreJson.item.status).toBe("open");
      expect(restoreJson.restored_from.kind).toBe("version");
      expect(restoreJson.restored_from.history_index).toBe(1);

      const get = context.runCli(["get", id, "--json"], { expectJson: true });
      expect(get.code).toBe(0);
      const getJson = get.json as { item: { status: string }; body: string };
      expect(getJson.item.status).toBe("open");
      expect(getJson.body).toBe("body-v1");

      const history = context.runCli(["history", id, "--json"], { expectJson: true });
      expect(history.code).toBe(0);
      const historyJson = history.json as { history: Array<{ op: string }> };
      expect(historyJson.history.at(-1)?.op).toBe("restore");
    });
  }, 120_000);
});
