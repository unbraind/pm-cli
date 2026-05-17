import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runActivity } from "../../src/cli/commands/activity.js";
import { readHistoryEntries, runHistory } from "../../src/cli/commands/history.js";
import { runHistoryRedact } from "../../src/cli/commands/history-redact.js";
import { clearActiveExtensionHooks, setActiveExtensionHooks, type ExtensionHookRegistry } from "../../src/core/extensions/index.js";
import { EXIT_CODE } from "../../src/core/shared/constants.js";
import { PmCliError } from "../../src/core/shared/errors.js";
import { withTempPmPath, type TempPmContext } from "../helpers/withTempPmPath.js";

function createItem(context: TempPmContext, title: string): string {
  const result = context.runCli(
    [
      "create",
      "--json",
      "--title",
      title,
      "--description",
      `${title} description`,
      "--type",
      "Task",
      "--status",
      "open",
      "--priority",
      "1",
      "--tags",
      "history,test",
      "--body",
      "",
      "--deadline",
      "none",
      "--estimate",
      "10",
      "--acceptance-criteria",
      `${title} acceptance`,
      "--author",
      "test-author",
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
  expect(result.code).toBe(0);
  return (result.json as { item: { id: string } }).item.id;
}

describe("runHistory and runActivity", () => {
  afterEach(() => {
    clearActiveExtensionHooks();
  });

  it("fails when tracker is not initialized", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pm-history-not-init-"));
    try {
      await expect(runHistory("pm-missing", {}, { path: tempDir })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
      await expect(runActivity({}, { path: tempDir })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("validates --limit values", async () => {
    await withTempPmPath(async (context) => {
      const id = createItem(context, "Limit Validation");
      await expect(runHistory(id, { limit: "-1" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(runActivity({ limit: "not-a-number" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(
        runActivity(
          {
            from: "2026-04-10T10:00:00.000Z",
            to: "2026-04-10T10:00:00.000Z",
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
    });
  });

  it("returns item history with optional limiting and handles empty/missing history files", async () => {
    await withTempPmPath(async (context) => {
      const id = createItem(context, "History Retrieval");
      context.runCli(
        ["append", id, "--json", "--body", "extra body", "--author", "test-author", "--message", "Append for history"],
        { expectJson: true },
      );

      const allHistory = await runHistory(id, {}, { path: context.pmPath });
      expect(allHistory.id).toBe(id);
      expect(allHistory.count).toBeGreaterThanOrEqual(2);
      expect(allHistory.limit).toBeNull();

      const limited = await runHistory(id, { limit: "1" }, { path: context.pmPath });
      expect(limited.count).toBe(1);
      expect(limited.limit).toBe(1);

      const historyPath = path.join(context.pmPath, "history", `${id}.jsonl`);
      await writeFile(historyPath, "   \n", "utf8");
      const emptyHistory = await runHistory(id, {}, { path: context.pmPath });
      expect(emptyHistory.count).toBe(0);

      await rm(historyPath, { force: true });
      const missingHistory = await runHistory(id, {}, { path: context.pmPath });
      expect(missingHistory.count).toBe(0);
    });
  });

  it("supports additive diff output for history entries", async () => {
    await withTempPmPath(async (context) => {
      const id = createItem(context, "History Diff");
      context.runCli(["append", id, "--json", "--body", "diff body", "--author", "test-author", "--message", "Append for diff"], {
        expectJson: true,
      });

      const all = await runHistory(id, { diff: true }, { path: context.pmPath });
      expect(all.diff).toBeDefined();
      expect(all.diff?.length).toBe(all.count);
      expect(all.diff?.some((entry) => entry.changed_fields.includes("body"))).toBe(true);

      const limited = await runHistory(id, { limit: "1", diff: true }, { path: context.pmPath });
      expect(limited.diff).toHaveLength(1);
      expect(limited.diff?.[0].index).toBe(all.count);
    });
  });

  it("supports additive verification output for history hash chains", async () => {
    await withTempPmPath(async (context) => {
      const id = createItem(context, "History Verify");
      context.runCli(
        ["update", id, "--json", "--status", "in_progress", "--author", "test-author", "--message", "Update for verify"],
        { expectJson: true },
      );

      const verified = await runHistory(id, { verify: true }, { path: context.pmPath });
      expect(verified.verification).toBeDefined();
      expect(verified.verification?.ok).toBe(true);
      expect(verified.verification?.errors).toEqual([]);
      expect(verified.verification?.current_matches_latest).toBe(true);

      const historyPath = path.join(context.pmPath, "history", `${id}.jsonl`);
      const rawLines = (await readFile(historyPath, "utf8"))
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      const firstEntry = JSON.parse(rawLines[0]) as Record<string, unknown>;
      firstEntry.after_hash = "tampered-after-hash";
      rawLines[0] = JSON.stringify(firstEntry);
      await writeFile(historyPath, `${rawLines.join("\n")}\n`, "utf8");

      const tampered = await runHistory(id, { verify: true }, { path: context.pmPath });
      expect(tampered.verification?.ok).toBe(false);
      expect((tampered.verification?.errors ?? []).length).toBeGreaterThan(0);
    });
  });

  it("redacts history/item payloads, recomputes hashes, and appends an audit marker", async () => {
    await withTempPmPath(async (context) => {
      const id = createItem(context, "History Redact");
      const leakedPath = "/home/steve/private/path";
      context.runCli(
        ["append", id, "--json", "--body", `contains ${leakedPath}`, "--author", "test-author", "--message", `append ${leakedPath}`],
        { expectJson: true },
      );

      const redacted = await runHistoryRedact(
        id,
        {
          literal: [leakedPath],
          replacement: "[redacted_path]",
          author: "test-author",
        },
        { path: context.pmPath },
      );
      expect(redacted.changed).toBe(true);
      expect(redacted.history.entries_changed).toBeGreaterThan(0);
      expect(redacted.history.audit_entry_added).toBe(true);
      expect(redacted.history.verify_ok).toBe(true);

      const historyPath = path.join(context.pmPath, "history", `${id}.jsonl`);
      const historyRaw = await readFile(historyPath, "utf8");
      expect(historyRaw).not.toContain(leakedPath);
      expect(historyRaw).toContain("[redacted_path]");
      expect(historyRaw).toContain('"op":"history_redact"');

      const itemPath = path.join(context.pmPath, "tasks", `${id}.toon`);
      const itemRaw = await readFile(itemPath, "utf8");
      expect(itemRaw).toContain("[redacted_path]");
      expect(itemRaw).not.toContain(leakedPath);

      const verified = await runHistory(id, { verify: true }, { path: context.pmPath });
      expect(verified.verification?.ok).toBe(true);
    });
  });

  it("supports dry-run previews for history redaction", async () => {
    await withTempPmPath(async (context) => {
      const id = createItem(context, "History Redact Dry Run");
      const leakedToken = "token-abc-123";
      context.runCli(
        ["append", id, "--json", "--body", `secret ${leakedToken}`, "--author", "test-author", "--message", "append token"],
        { expectJson: true },
      );

      const dryRunResult = await runHistoryRedact(
        id,
        {
          literal: leakedToken,
          replacement: "[redacted_token]",
          dryRun: true,
        },
        { path: context.pmPath },
      );
      expect(dryRunResult.changed).toBe(true);
      expect(dryRunResult.dry_run).toBe(true);
      expect(dryRunResult.history.audit_entry_added).toBe(false);

      const historyPath = path.join(context.pmPath, "history", `${id}.jsonl`);
      const historyRaw = await readFile(historyPath, "utf8");
      expect(historyRaw).toContain(leakedToken);
      expect(historyRaw).not.toContain("[redacted_token]");
    });
  });

  it("requires at least one matcher for history-redact", async () => {
    await withTempPmPath(async (context) => {
      const id = createItem(context, "History Redact Missing Matcher");
      await expect(runHistoryRedact(id, {}, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
    });
  });

  it("fails when history target item does not exist", async () => {
    await withTempPmPath(async (context) => {
      await expect(runHistory("pm-does-not-exist", {}, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
    });
  });

  it("fails history and activity in strict mode when required streams are missing", async () => {
    await withTempPmPath(async (context) => {
      const historyId = createItem(context, "Strict History Missing Stream");
      const activityId = createItem(context, "Strict Activity Missing Stream");
      const strictSet = context.runCli(
        ["config", "project", "set", "history-missing-stream-policy", "--policy", "strict_error", "--json"],
        { expectJson: true },
      );
      expect(strictSet.code).toBe(0);

      await rm(path.join(context.pmPath, "history", `${historyId}.jsonl`), { force: true });
      await rm(path.join(context.pmPath, "history", `${activityId}.jsonl`), { force: true });

      await expect(runHistory(historyId, {}, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
      await expect(runActivity({}, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
    });
  });

  it("rejects malformed history lines", async () => {
    await withTempPmPath(async (context) => {
      const id = createItem(context, "Malformed History");
      const historyPath = path.join(context.pmPath, "history", `${id}.jsonl`);
      await appendFile(historyPath, "not-json\n", "utf8");
      await expect(readHistoryEntries(historyPath, id)).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.GENERIC_FAILURE,
      });
    });
  });

  it("rejects history streams containing merge conflict markers", async () => {
    await withTempPmPath(async (context) => {
      const id = createItem(context, "Conflicted History");
      const historyPath = path.join(context.pmPath, "history", `${id}.jsonl`);
      await writeFile(
        historyPath,
        ["<<<<<<< HEAD", "{}", "=======", "{}", ">>>>>>> branch", ""].join("\n"),
        "utf8",
      );
      await expect(readHistoryEntries(historyPath, id)).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.GENERIC_FAILURE,
      });
      await expect(readHistoryEntries(historyPath, id)).rejects.toThrow(
        `History for ${id} contains merge conflict markers at line 1`,
      );
    });
  });

  it("aggregates activity across item history files deterministically", async () => {
    await withTempPmPath(async (context) => {
      const firstId = createItem(context, "Activity One");
      context.runCli(
        ["update", firstId, "--json", "--status", "in_progress", "--author", "test-author", "--message", "Progress first"],
        { expectJson: true },
      );

      const secondId = createItem(context, "Activity Two");
      const historyDir = path.join(context.pmPath, "history");
      await writeFile(path.join(historyDir, "ignore-me.txt"), "noop", "utf8");

      const allActivity = await runActivity({}, { path: context.pmPath });
      expect(allActivity.count).toBeGreaterThanOrEqual(3);
      expect(allActivity.activity.some((entry) => entry.id === firstId)).toBe(true);
      expect(allActivity.activity.some((entry) => entry.id === secondId)).toBe(true);
      expect(allActivity.limit).toBeNull();

      for (let index = 1; index < allActivity.activity.length; index += 1) {
        const previous = allActivity.activity[index - 1];
        const current = allActivity.activity[index];
        expect(previous.ts.localeCompare(current.ts) >= 0).toBe(true);
      }

      const limited = await runActivity({ limit: "1" }, { path: context.pmPath });
      expect(limited.count).toBe(1);
      expect(limited.limit).toBe(1);
    });
  });

  it("returns empty activity when history directory is missing", async () => {
    await withTempPmPath(async (context) => {
      createItem(context, "Activity Missing History Directory");
      await rm(path.join(context.pmPath, "history"), { recursive: true, force: true });

      const activity = await runActivity({}, { path: context.pmPath });
      expect(activity).toEqual({
        activity: [],
        compact: false,
        count: 0,
        limit: null,
      });
    });
  });

  it("propagates non-missing history directory shape errors", async () => {
    await withTempPmPath(async (context) => {
      createItem(context, "Activity Invalid History Directory");
      const historyDir = path.join(context.pmPath, "history");
      await rm(historyDir, { recursive: true, force: true });
      await writeFile(historyDir, "not-a-directory", "utf8");

      await expect(runActivity({}, { path: context.pmPath })).rejects.toMatchObject({
        code: "EEXIST",
      });
    });
  });

  it("dispatches onRead hooks for activity history directory scans", async () => {
    await withTempPmPath(async (context) => {
      const id = createItem(context, "Activity Hook Directory");
      const events: string[] = [];
      const hooks: ExtensionHookRegistry = {
        beforeCommand: [],
        afterCommand: [],
        onWrite: [],
        onRead: [
          {
            layer: "project",
            name: "activity-read-hook",
            run: (hookContext) => {
              events.push(path.basename(hookContext.path));
            },
          },
        ],
        onIndex: [],
      };
      setActiveExtensionHooks(hooks);

      const activity = await runActivity({}, { path: context.pmPath });
      expect(activity.count).toBeGreaterThanOrEqual(1);
      expect(events).toContain("history");
      expect(events).toContain(`${id}.jsonl`);
    });
  });

  it("sorts same-timestamp activity by id and operation", async () => {
    await withTempPmPath(async (context) => {
      const firstId = createItem(context, "Tie Break One");
      const secondId = createItem(context, "Tie Break Two");
      const tieTs = "2026-01-01T00:00:00.000Z";
      const historyDir = path.join(context.pmPath, "history");

      await writeFile(
        path.join(historyDir, `${firstId}.jsonl`),
        `${JSON.stringify({
          ts: tieTs,
          author: "test-author",
          op: "z-op",
          patch: [],
          before_hash: "before-1",
          after_hash: "after-1",
        })}\n${JSON.stringify({
          ts: tieTs,
          author: "test-author",
          op: "a-op",
          patch: [],
          before_hash: "before-2",
          after_hash: "after-2",
        })}\n`,
        "utf8",
      );

      await writeFile(
        path.join(historyDir, `${secondId}.jsonl`),
        `${JSON.stringify({
          ts: tieTs,
          author: "test-author",
          op: "m-op",
          patch: [],
          before_hash: "before-3",
          after_hash: "after-3",
        })}\n`,
        "utf8",
      );

      const activity = await runActivity({}, { path: context.pmPath });
      expect(activity.count).toBe(3);

      const expectedOrder =
        firstId.localeCompare(secondId) < 0
          ? [
              { id: firstId, op: "a-op" },
              { id: firstId, op: "z-op" },
              { id: secondId, op: "m-op" },
            ]
          : [
              { id: secondId, op: "m-op" },
              { id: firstId, op: "a-op" },
              { id: firstId, op: "z-op" },
            ];

      expect(activity.activity.map((entry) => ({ id: entry.id, op: entry.op }))).toEqual(expectedOrder);
    });
  });

  it("supports id/op/author/time-window filters for activity queries", async () => {
    await withTempPmPath(async (context) => {
      const firstId = createItem(context, "Activity Filter One");
      const secondId = createItem(context, "Activity Filter Two");
      const historyDir = path.join(context.pmPath, "history");

      await writeFile(
        path.join(historyDir, `${firstId}.jsonl`),
        `${JSON.stringify({
          ts: "2026-01-01T00:00:00.000Z",
          author: "author-a",
          op: "create",
          patch: [],
          before_hash: "before-1",
          after_hash: "after-1",
        })}\n${JSON.stringify({
          ts: "2026-01-02T00:00:00.000Z",
          author: "author-b",
          op: "update",
          patch: [],
          before_hash: "before-2",
          after_hash: "after-2",
        })}\n`,
        "utf8",
      );
      await writeFile(
        path.join(historyDir, `${secondId}.jsonl`),
        `${JSON.stringify({
          ts: "2026-01-03T00:00:00.000Z",
          author: "author-c",
          op: "close",
          patch: [],
          before_hash: "before-3",
          after_hash: "after-3",
        })}\n`,
        "utf8",
      );

      const byId = await runActivity({ id: firstId }, { path: context.pmPath });
      expect(byId.count).toBe(2);
      expect(byId.activity.every((entry) => entry.id === firstId)).toBe(true);

      const byOp = await runActivity({ op: "update" }, { path: context.pmPath });
      expect(byOp.activity.map((entry) => entry.op)).toEqual(["update"]);

      const byAuthor = await runActivity({ author: "author-c" }, { path: context.pmPath });
      expect(byAuthor.activity.map((entry) => entry.author)).toEqual(["author-c"]);

      const byWindow = await runActivity(
        {
          from: "2026-01-02T00:00:00.000Z",
          to: "2026-01-03T00:00:00.000Z",
        },
        { path: context.pmPath },
      );
      expect(byWindow.activity.map((entry) => entry.ts)).toEqual(["2026-01-02T00:00:00.000Z"]);
    });
  });

  it("accepts relative and preset time bounds for activity queries", async () => {
    await withTempPmPath(async (context) => {
      const id = createItem(context, "Relative Activity Window");
      context.runCli(["append", id, "--json", "--body", "relative window", "--author", "test-author", "--message", "Append"], {
        expectJson: true,
      });

      const relativeWindow = await runActivity(
        {
          from: "-1d",
          to: "now",
        },
        { path: context.pmPath },
      );
      expect(relativeWindow.count).toBeGreaterThanOrEqual(1);
    });
  });
});
