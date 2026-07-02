import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { _testOnly as activityInternals, runActivity } from "../../../src/cli/commands/activity.js";
import { readHistoryEntries, runHistory } from "../../../src/cli/commands/history.js";
import { _testOnly as historyRedactInternals, runHistoryRedact } from "../../../src/cli/commands/history-redact.js";
import { _testOnlyRestoreCommand, runRestore } from "../../../src/cli/commands/restore.js";
import { clearActiveExtensionHooks, setActiveExtensionHooks, type ExtensionHookRegistry } from "../../../src/core/extensions/index.js";
import { createHistoryEntry } from "../../../src/core/history/history.js";
import { EMPTY_REPLAY_DOCUMENT, replayHash } from "../../../src/core/history/replay.js";
import * as fsUtilsModule from "../../../src/core/fs/fs-utils.js";
import * as historyRewriteModule from "../../../src/core/history/history-rewrite.js";
import * as lockModule from "../../../src/core/lock/lock.js";
import { EXIT_CODE } from "../../../src/core/shared/constants.js";
import { PmCliError } from "../../../src/core/shared/errors.js";
import { withTempPmPath, type TempPmContext } from "../../helpers/withTempPmPath.js";

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

  it("covers history-redact pure helper branches", () => {
    expect(historyRedactInternals.normalizeStringArrayInput(" one ")).toEqual([" one "]);
    expect(historyRedactInternals.normalizeStringArrayInput(["a", "b"])).toEqual(["a", "b"]);
    expect(historyRedactInternals.normalizeStringArrayInput(undefined)).toEqual([]);
    expect(historyRedactInternals.normalizeRegexFlags("igi")).toBe("ig");
    expect(historyRedactInternals.parseRegexRule("plain").label).toBe("/plain/g");
    expect(historyRedactInternals.parseRegexRule("/plain/i").label).toBe("/plain/ig");
    expect(() => historyRedactInternals.parseRegexRule(" ")).toThrow(PmCliError);
    expect(() => historyRedactInternals.parseRegexRule("//")).toThrow(PmCliError);

    const rules = historyRedactInternals.buildRedactionRules([" secret ", "secret"], "/token-[0-9]+/");
    expect(rules.map((rule) => rule.label)).toEqual(["secret", "/token-[0-9]+/g"]);
    expect(() => historyRedactInternals.buildRedactionRules(" ", [])).toThrow(PmCliError);
    expect(historyRedactInternals.applyLiteralRule("aaaa", "aa", "b")).toEqual({ value: "bb", replacements: 2 });
    expect(historyRedactInternals.applyLiteralRule("aaaa", "", "b")).toEqual({ value: "aaaa", replacements: 0 });
    expect(historyRedactInternals.applyRegexRule("token-1 token-x", historyRedactInternals.parseRegexRule("/token-[0-9]+/"), "x")).toEqual({
      value: "x token-x",
      replacements: 1,
    });
    expect(historyRedactInternals.redactStringValue("secret token-1", rules, "x")).toEqual({ value: "x x", replacements: 2 });
    expect(
      historyRedactInternals.redactUnknownValue({ nested: ["secret", 3, { token: "token-2" }] }, rules, "x"),
    ).toEqual({
      value: { nested: ["x", 3, { token: "x" }] },
      replacements: 2,
    });
    expect(historyRedactInternals.hasItemMetadata({ metadata: { id: "pm-a" }, body: "", events: [] } as never)).toBe(true);
    expect(historyRedactInternals.hasItemMetadata({ metadata: {}, body: "", events: [] } as never)).toBe(false);
  });

  it("covers restore target and replay helper branches", () => {
    const initialDocument = {
      metadata: { id: "pm-a", title: "A", type: "Task", status: "open", priority: 1, tags: [] },
      body: "body",
    };
    const created = {
      ts: "2026-01-01T00:00:00.000Z",
      author: "tester",
      op: "create",
      before_hash: replayHash(EMPTY_REPLAY_DOCUMENT),
      after_hash: replayHash(initialDocument),
      patch: [
        { op: "replace", path: "/metadata", value: initialDocument.metadata },
        { op: "replace", path: "/body", value: initialDocument.body },
      ],
      message: "create",
    };
    const updated = createHistoryEntry({
      nowIso: "2026-01-02T00:00:00.000Z",
      author: "tester",
      op: "update",
      before: initialDocument,
      after: {
        metadata: { id: "pm-a", title: "A2", type: "Task", status: "open", priority: 2, tags: [] },
        body: "body 2",
      },
      message: "update",
    });
    const history = [created, updated];

    expect(_testOnlyRestoreCommand.ensureReplayTarget("1", history)).toMatchObject({ kind: "version", historyIndex: 0 });
    expect(_testOnlyRestoreCommand.ensureReplayTarget("2026-01-01T12:00:00.000Z", history)).toMatchObject({
      kind: "timestamp",
      historyIndex: 0,
    });
    expect(() => _testOnlyRestoreCommand.ensureReplayTarget(" ", history)).toThrow(PmCliError);
    expect(() => _testOnlyRestoreCommand.ensureReplayTarget("3", history)).toThrow(PmCliError);
    expect(() => _testOnlyRestoreCommand.ensureReplayTarget("not-a-date", history)).toThrow(PmCliError);
    expect(() => _testOnlyRestoreCommand.ensureReplayTarget("2025-12-31T00:00:00.000Z", history)).toThrow(PmCliError);

    expect(_testOnlyRestoreCommand.replayToTarget(history, 1).metadata).toMatchObject({ title: "A2", priority: 2 });
    expect(_testOnlyRestoreCommand.replayCurrentDocument(history).metadata).toMatchObject({ title: "A2" });
    expect(
      _testOnlyRestoreCommand.changedFields(
        { metadata: { id: "pm-a", title: "A", type: "Task", status: "open", priority: 1, tags: [] }, body: "body" },
        { metadata: { id: "pm-a", title: "A2", type: "Task", status: "open", priority: 1, tags: [] }, body: "body 2" },
      ),
    ).toEqual(["body", "title"]);
    expect(
      _testOnlyRestoreCommand.extractPatchFailureContext(
        [{ op: "replace", path: "/metadata/title", value: "A2" }],
        { index: 0, operation: { op: "replace", path: "/metadata/title", from: "/old" } },
      ),
    ).toEqual({ patchIndex: 0, op: "replace", path: "/metadata/title", from: "/old" });
    expect(() =>
      _testOnlyRestoreCommand.ensureMaterializedRestoreTarget(EMPTY_REPLAY_DOCUMENT, {
        kind: "version",
        raw: "1",
        historyIndex: 0,
      }),
    ).toThrow(PmCliError);
    expect(() =>
      _testOnlyRestoreCommand.applyHistoryPatch(
        { metadata: {}, body: "" },
        [{ op: "remove", path: "/metadata/missing" }],
        1,
        "broken",
      ),
    ).toThrow(PmCliError);
  });

  it("restores an item to an earlier history version", async () => {
    await withTempPmPath(async (context) => {
      const id = createItem(context, "Restore Version");
      context.runCli(["update", id, "--json", "--priority", "5", "--author", "test-author", "--message", "Raise priority"], {
        expectJson: true,
      });

      const result = await runRestore(id, "1", { author: "test-author", message: "restore initial" }, { path: context.pmPath });

      expect(result.restored_from).toMatchObject({ kind: "version", target: "1", history_index: 1, entry_op: "create" });
      expect(result.item.priority).toBe(1);
      const restored = context.runCli(["get", id, "--json"], { expectJson: true });
      expect((restored.json as { item: { priority: number } }).item.priority).toBe(1);
    });
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

      const compact = await runHistory(id, { compact: true }, { path: context.pmPath });
      expect(compact.compact).toBe(true);
      expect(compact.history).toEqual([]);
      expect(compact.compact_history).toHaveLength(compact.count);
      expect(compact.compact_history?.some((entry) => entry.changed_fields.includes("body"))).toBe(true);

      const cliDefault = context.runCli(["history", id, "--json"], { expectJson: true });
      expect(cliDefault.code).toBe(0);
      expect(cliDefault.json).toMatchObject({ compact: true, history: [] });
      expect((cliDefault.json as { compact_history?: unknown[] }).compact_history?.length).toBeGreaterThan(0);

      // --diff is independent of the compact/full projection: it always replays the
      // chain to surface field-level value diffs even when the entry list is compacted.
      const compactDiff = context.runCli(["history", id, "--json", "--diff"], { expectJson: true });
      expect(compactDiff.code).toBe(0);
      expect(compactDiff.json).toMatchObject({ compact: true, history: [] });
      const compactDiffEntries = (compactDiff.json as {
        diff?: Array<{ changed_fields: string[]; changes: unknown[] }>;
      }).diff;
      expect(compactDiffEntries?.length).toBeGreaterThan(0);
      expect(compactDiffEntries?.some((entry) => entry.changed_fields.includes("body"))).toBe(true);

      const cliFull = context.runCli(["history", id, "--json", "--full"], { expectJson: true });
      expect(cliFull.code).toBe(0);
      expect(cliFull.json).toMatchObject({ compact: false });
      expect((cliFull.json as { history?: unknown[] }).history?.length).toBeGreaterThan(0);

      const conflictingProjection = context.runCli(["history", id, "--compact", "--full"]);
      expect(conflictingProjection.code).toBe(EXIT_CODE.USAGE);
      expect(conflictingProjection.stderr).toContain("History projection options are mutually exclusive");

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

  it("renders compact history when legacy entries have missing patch arrays", async () => {
    await withTempPmPath(async (context) => {
      const id = createItem(context, "Legacy Missing Patch");
      const historyPath = path.join(context.pmPath, "history", `${id}.jsonl`);
      await appendFile(
        historyPath,
        `${JSON.stringify({
          ts: "2026-01-01T00:00:00.000Z",
          author: "legacy-importer",
          op: "legacy-import",
          before_hash: "0".repeat(64),
          after_hash: "0".repeat(64),
        })}\n`,
        "utf8",
      );

      const compact = await runHistory(id, { compact: true }, { path: context.pmPath });
      const legacyEntry = compact.compact_history?.find((entry) => entry.op === "legacy-import");
      expect(legacyEntry).toMatchObject({
        author: "legacy-importer",
        patch_ops: 0,
        changed_fields: [],
      });
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

  it("verifies orphaned history streams when no item file exists", async () => {
    await withTempPmPath(async (context) => {
      const orphanId = "pm-orphan";
      const orphanHistoryPath = path.join(context.pmPath, "history", `${orphanId}.jsonl`);
      await writeFile(orphanHistoryPath, "", "utf8");

      const result = await runHistory(orphanId, { verify: true }, { path: context.pmPath });

      expect(result.id).toBe(orphanId);
      expect(result.count).toBe(0);
      expect(result.verification).toMatchObject({
        ok: true,
        entries: 0,
        errors: [],
        latest_after_hash: undefined,
        current_item_hash: undefined,
        current_matches_latest: undefined,
      });
    });
  });

  it("flags current item hash mismatch when latest history after_hash is tampered", async () => {
    await withTempPmPath(async (context) => {
      const id = createItem(context, "History Verify Latest Hash Mismatch");
      context.runCli(
        ["update", id, "--json", "--status", "in_progress", "--author", "test-author", "--message", "Update for mismatch"],
        { expectJson: true },
      );

      const historyPath = path.join(context.pmPath, "history", `${id}.jsonl`);
      const rawLines = (await readFile(historyPath, "utf8"))
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      const lastEntry = JSON.parse(rawLines[rawLines.length - 1] ?? "{}") as Record<string, unknown>;
      lastEntry.after_hash = "latest-after-hash-mismatch";
      rawLines[rawLines.length - 1] = JSON.stringify(lastEntry);
      await writeFile(historyPath, `${rawLines.join("\n")}\n`, "utf8");

      const verified = await runHistory(id, { verify: true }, { path: context.pmPath });
      expect(verified.verification?.ok).toBe(false);
      expect(verified.verification?.errors).toContain("verify_failed:current_item_hash_mismatch");
    });
  });

  it("returns structured verification errors when history replay cannot apply a patch", async () => {
    await withTempPmPath(async (context) => {
      const id = createItem(context, "History Verify Apply Failure");
      const historyPath = path.join(context.pmPath, "history", `${id}.jsonl`);
      const rawLines = (await readFile(historyPath, "utf8"))
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      const firstEntry = JSON.parse(rawLines[0]) as { patch: Array<{ op: string; path: string; value?: unknown }> };
      firstEntry.patch = [{ op: "replace", path: "/metadata/does_not_exist", value: true }];
      rawLines[0] = JSON.stringify(firstEntry);
      await writeFile(historyPath, `${rawLines.join("\n")}\n`, "utf8");

      const tampered = await runHistory(id, { verify: true }, { path: context.pmPath });
      expect(tampered.verification?.ok).toBe(false);
      expect(tampered.verification?.errors).toEqual(["verify_failed:patch_apply_failed:entry_1"]);
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

  it("supports regex redaction syntax and reports no-match rewrites without mutating", async () => {
    await withTempPmPath(async (context) => {
      const id = createItem(context, "History Redact Regex");
      context.runCli(
        ["append", id, "--json", "--body", "ticket secret-123 and secret-456", "--author", "test-author", "--message", "append regex tokens"],
        { expectJson: true },
      );

      const redacted = await runHistoryRedact(
        id,
        {
          regex: ["/secret-[0-9]+/i", "secret-456"],
          replacement: "[secret]",
          author: "test-author",
        },
        { path: context.pmPath },
      );
      expect(redacted.changed).toBe(true);
      expect(redacted.patterns.regex).toEqual(["/secret-[0-9]+/ig", "/secret-456/g"]);
      expect(redacted.history.replacements).toBeGreaterThanOrEqual(2);

      const noMatchHistoryBefore = await readFile(path.join(context.pmPath, "history", `${id}.jsonl`), "utf8");
      const noMatch = await runHistoryRedact(
        id,
        {
          literal: "definitely-not-present",
          replacement: "[none]",
          author: "test-author",
        },
        { path: context.pmPath },
      );
      expect(noMatch.changed).toBe(false);
      expect(noMatch.history.audit_entry_added).toBe(false);
      expect(noMatch.warnings).toContain("history_redact_no_matches");
      expect(await readFile(path.join(context.pmPath, "history", `${id}.jsonl`), "utf8")).toBe(noMatchHistoryBefore);
    });
  });

  it("moves item files when redaction changes the resolved type path", async () => {
    await withTempPmPath(async (context) => {
      const id = createItem(context, "History Redact Type Move");
      expect(context.runCli(["schema", "add-type", "Spike", "--folder", "spikes"]).code).toBe(0);
      const writePaths: string[] = [];
      setActiveExtensionHooks({
        beforeCommand: [],
        afterCommand: [],
        onRead: [],
        onIndex: [],
        onWrite: [
          {
            layer: "project",
            name: "history-redact-write-hook",
            run: (hookContext) => {
              writePaths.push(hookContext.path);
            },
          },
        ],
      });

      const beforePath = path.join(context.pmPath, "tasks", `${id}.toon`);
      const afterPath = path.join(context.pmPath, "spikes", `${id}.toon`);
      const result = await runHistoryRedact(
        id,
        {
          literal: "Task",
          replacement: "Spike",
          author: "test-author",
        },
        { path: context.pmPath },
      );
      expect(result.changed).toBe(true);
      expect(result.item.path_before).toBe(beforePath);
      expect(result.item.path_after).toBe(afterPath);
      expect(result.item.changed).toBe(true);
      expect(await readFile(afterPath, "utf8")).toContain("type: Spike");
      await expect(readFile(beforePath, "utf8")).rejects.toThrow();
      expect(writePaths).toEqual(expect.arrayContaining([
        afterPath,
        beforePath,
        path.join(context.pmPath, "history", `${id}.jsonl`),
      ]));
    });
  });

  it("rejects invalid redaction patterns and item-id rewrites", async () => {
    await withTempPmPath(async (context) => {
      const id = createItem(context, "History Redact Invalid Pattern");
      await expect(runHistoryRedact(id, { regex: "/[/" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining("Invalid --regex value"),
      });

      await expect(
        runHistoryRedact(
          id,
          {
            literal: id,
            replacement: "pm-different",
            author: "test-author",
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining("would change item id"),
      });
    });
  });

  it("rolls back item and history writes when history redaction persistence fails", async () => {
    await withTempPmPath(async (context) => {
      const id = createItem(context, "History Redact Rollback");
      const leakedToken = "rollback-token-123";
      context.runCli(
        ["append", id, "--json", "--body", `secret ${leakedToken}`, "--author", "test-author", "--message", "append rollback token"],
        { expectJson: true },
      );

      const historyFile = path.join(context.pmPath, "history", `${id}.jsonl`);
      const itemFile = path.join(context.pmPath, "tasks", `${id}.toon`);
      const historyBefore = await readFile(historyFile, "utf8");
      const itemBefore = await readFile(itemFile, "utf8");
      const originalWriteFileAtomic = fsUtilsModule.writeFileAtomic;
      let failedHistoryWrite = false;
      const driftSpy = vi.spyOn(historyRewriteModule, "verifyHistoryRewriteNoDrift").mockResolvedValue({
        historyRawUnderLock: historyBefore,
      } as Awaited<ReturnType<typeof historyRewriteModule.verifyHistoryRewriteNoDrift>>);
      const writeSpy = vi.spyOn(fsUtilsModule, "writeFileAtomic").mockImplementation(async (target, content) => {
        if (target === historyFile && !failedHistoryWrite) {
          failedHistoryWrite = true;
          throw new Error("synthetic history write failure");
        }
        return originalWriteFileAtomic(target, content);
      });

      try {
        await expect(
          runHistoryRedact(
            id,
            {
              literal: leakedToken,
              replacement: "[redacted_token]",
              author: "test-author",
            },
            { path: context.pmPath },
          ),
        ).rejects.toThrow("synthetic history write failure");
        expect(await readFile(historyFile, "utf8")).toBe(historyBefore);
        expect(await readFile(itemFile, "utf8")).toBe(itemBefore);
      } finally {
        driftSpy.mockRestore();
        writeSpy.mockRestore();
      }
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

  it("fails history-redact for uninitialized, missing-item, missing-history, and empty-history paths", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pm-history-redact-not-init-"));
    try {
      await expect(runHistoryRedact("pm-missing", { literal: "x" }, { path: tempDir })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }

    await withTempPmPath(async (context) => {
      await expect(runHistoryRedact("pm-does-not-exist", { literal: "x" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.NOT_FOUND,
      });

      const id = createItem(context, "History Redact Missing History");
      const historyPath = path.join(context.pmPath, "history", `${id}.jsonl`);
      await rm(historyPath, { force: true });
      await expect(runHistoryRedact(id, { literal: "x" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.NOT_FOUND,
      });

      await writeFile(historyPath, "", "utf8");
      await expect(runHistoryRedact(id, { literal: "x" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
    });
  });

  it("redacts via the history-stream fallback when the item file is absent (prefixed and bare ids)", async () => {
    await withTempPmPath(async (context) => {
      const leakedToken = "fallback-token-789";

      // Prefixed-id path: normalizeItemId === normalizeRawItemId -> single candidate.
      const prefixedId = createItem(context, "History Redact Fallback Prefixed");
      context.runCli(
        ["append", prefixedId, "--json", "--body", `secret ${leakedToken}`, "--author", "test-author", "--message", "append fallback token"],
        { expectJson: true },
      );
      await rm(path.join(context.pmPath, "tasks", `${prefixedId}.toon`), { force: true });

      const prefixedResult = await runHistoryRedact(
        prefixedId,
        {
          literal: leakedToken,
          replacement: "[redacted_token]",
          author: "test-author",
        },
        { path: context.pmPath },
      );
      expect(prefixedResult.changed).toBe(true);
      expect(prefixedResult.item.existed_before).toBe(false);
      expect(prefixedResult.item.path_before).toBeNull();
      const prefixedHistory = await readFile(path.join(context.pmPath, "history", `${prefixedId}.jsonl`), "utf8");
      expect(prefixedHistory).not.toContain(leakedToken);
      expect(prefixedHistory).toContain("[redacted_token]");

      // Bare-id path: normalizeItemId !== normalizeRawItemId -> two candidates probed.
      const bareSourceId = createItem(context, "History Redact Fallback Bare");
      context.runCli(
        ["append", bareSourceId, "--json", "--body", `secret ${leakedToken}`, "--author", "test-author", "--message", "append fallback token"],
        { expectJson: true },
      );
      await rm(path.join(context.pmPath, "tasks", `${bareSourceId}.toon`), { force: true });
      const bareId = bareSourceId.replace(/^pm-/, "");
      expect(bareId).not.toBe(bareSourceId);

      const bareResult = await runHistoryRedact(
        bareId,
        {
          literal: leakedToken,
          replacement: "[redacted_token]",
          author: "test-author",
        },
        { path: context.pmPath },
      );
      expect(bareResult.id).toBe(bareSourceId);
      expect(bareResult.changed).toBe(true);
      expect(bareResult.item.existed_before).toBe(false);
    });
  });

  it("redacts patch values for history entries that carry no message field", async () => {
    await withTempPmPath(async (context) => {
      const id = createItem(context, "History Redact No Message Entry");
      const leakedToken = "no-message-token-321";
      context.runCli(
        ["append", id, "--json", "--body", `secret ${leakedToken}`, "--author", "test-author", "--message", `append ${leakedToken}`],
        { expectJson: true },
      );

      const historyPath = path.join(context.pmPath, "history", `${id}.jsonl`);
      const lines = (await readFile(historyPath, "utf8"))
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      // Strip the `message` field from every entry so the message-redaction branch is skipped
      // and only the patch-value redaction path runs.
      const stripped = lines.map((line) => {
        const entry = JSON.parse(line) as Record<string, unknown>;
        delete entry.message;
        return JSON.stringify(entry);
      });
      await writeFile(historyPath, `${stripped.join("\n")}\n`, "utf8");

      const result = await runHistoryRedact(
        id,
        {
          literal: leakedToken,
          replacement: "[redacted_token]",
          author: "test-author",
        },
        { path: context.pmPath },
      );

      expect(result.changed).toBe(true);
      const historyRaw = await readFile(historyPath, "utf8");
      expect(historyRaw).not.toContain(leakedToken);
      expect(historyRaw).toContain("[redacted_token]");
    });
  });

  it("redacts a deleted item's history when the replayed document has no metadata", async () => {
    await withTempPmPath(async (context) => {
      const id = createItem(context, "History Redact Deleted Item");
      const leakedToken = "deleted-item-token-456";
      context.runCli(
        ["append", id, "--json", "--body", `secret ${leakedToken}`, "--author", "test-author", "--message", `append ${leakedToken}`],
        { expectJson: true },
      );
      const deleted = context.runCli(
        ["delete", id, "--json", "--author", "test-author", "--message", "delete for redaction fixture"],
        { expectJson: true },
      );
      expect(deleted.code).toBe(0);

      // The item file is gone; the history stream (incl. the leaked append) remains.
      const itemPath = path.join(context.pmPath, "tasks", `${id}.toon`);
      await expect(readFile(itemPath, "utf8")).rejects.toThrow();

      const result = await runHistoryRedact(
        id,
        {
          literal: leakedToken,
          replacement: "[redacted_token]",
          author: "test-author",
        },
        { path: context.pmPath },
      );

      expect(result.changed).toBe(true);
      expect(result.history.audit_entry_added).toBe(true);
      // Replayed final document is a tombstone -> no item is recreated.
      expect(result.item.path_after).toBeNull();
      expect(result.item.exists_after).toBe(false);
      await expect(readFile(itemPath, "utf8")).rejects.toThrow();

      const historyRaw = await readFile(path.join(context.pmPath, "history", `${id}.jsonl`), "utf8");
      expect(historyRaw).not.toContain(leakedToken);
      expect(historyRaw).toContain("[redacted_token]");
    });
  });

  it("reports preexisting hash mismatches before successful redaction", async () => {
    await withTempPmPath(async (context) => {
      const id = createItem(context, "History Redact Preexisting Hash Mismatch");
      const historyPath = path.join(context.pmPath, "history", `${id}.jsonl`);
      const lines = (await readFile(historyPath, "utf8"))
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      const first = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
      first.before_hash = "0".repeat(64);
      lines[0] = JSON.stringify(first);
      await writeFile(historyPath, `${lines.join("\n")}\n`, "utf8");

      const redacted = await runHistoryRedact(
        id,
        {
          literal: "description",
          replacement: "[redacted_description]",
          author: "test-author",
        },
        { path: context.pmPath },
      );
      expect(redacted.warnings.some((warning) => warning.startsWith("history_redact_preexisting_hash_mismatches:"))).toBe(true);
    });
  });

  it("rejects history-redact when the history stream changes before lock acquisition", async () => {
    await withTempPmPath(async (context) => {
      const id = createItem(context, "History Redact Lock Window");
      const leakedToken = "token-lock-window";
      context.runCli(
        ["append", id, "--json", "--body", `secret ${leakedToken}`, "--author", "test-author", "--message", "append token"],
        { expectJson: true },
      );

      const historyFile = path.join(context.pmPath, "history", `${id}.jsonl`);
      const originalAcquireLock = lockModule.acquireLock;
      let mutated = false;
      const lockSpy = vi.spyOn(lockModule, "acquireLock").mockImplementation(async (...args) => {
        if (!mutated) {
          mutated = true;
          const raw = await readFile(historyFile, "utf8");
          await writeFile(historyFile, `${raw}\n`, "utf8");
        }
        return originalAcquireLock(...(args as Parameters<typeof lockModule.acquireLock>));
      });

      try {
        await expect(
          runHistoryRedact(
            id,
            {
              literal: leakedToken,
              replacement: "[redacted_token]",
              author: "test-author",
            },
            { path: context.pmPath },
          ),
        ).rejects.toMatchObject<PmCliError>({
          exitCode: EXIT_CODE.CONFLICT,
          message: expect.stringContaining(`History for ${id} changed while waiting for lock; retry history-redact.`),
        });
        const historyRaw = await readFile(historyFile, "utf8");
        expect(historyRaw).toContain(leakedToken);
        expect(historyRaw).not.toContain("[redacted_token]");
      } finally {
        lockSpy.mockRestore();
      }
    });
  });

  it("rejects history-redact when the item changes before lock acquisition", async () => {
    await withTempPmPath(async (context) => {
      const id = createItem(context, "History Redact Item Lock Window");
      const leakedToken = "token-lock-window-item";
      context.runCli(
        ["append", id, "--json", "--body", `secret ${leakedToken}`, "--author", "test-author", "--message", "append token"],
        { expectJson: true },
      );

      const historyFile = path.join(context.pmPath, "history", `${id}.jsonl`);
      const itemFile = path.join(context.pmPath, "tasks", `${id}.toon`);
      const originalAcquireLock = lockModule.acquireLock;
      let mutated = false;
      const lockSpy = vi.spyOn(lockModule, "acquireLock").mockImplementation(async (...args) => {
        if (!mutated) {
          mutated = true;
          const raw = await readFile(itemFile, "utf8");
          await writeFile(itemFile, raw.replace(`secret ${leakedToken}`, `secret ${leakedToken}-changed`), "utf8");
        }
        return originalAcquireLock(...(args as Parameters<typeof lockModule.acquireLock>));
      });

      try {
        await expect(
          runHistoryRedact(
            id,
            {
              literal: leakedToken,
              replacement: "[redacted_token]",
              author: "test-author",
            },
            { path: context.pmPath },
          ),
        ).rejects.toMatchObject<PmCliError>({
          exitCode: EXIT_CODE.CONFLICT,
          message: expect.stringContaining(`Item ${id} changed while waiting for lock; retry history-redact.`),
        });
        const historyRaw = await readFile(historyFile, "utf8");
        expect(historyRaw).toContain(leakedToken);
        expect(historyRaw).not.toContain("[redacted_token]");
      } finally {
        lockSpy.mockRestore();
      }
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

  it("returns an empty history array when the stream file is missing", async () => {
    await withTempPmPath(async (context) => {
      const id = createItem(context, "Missing History Reader");
      const historyPath = path.join(context.pmPath, "history", `${id}.jsonl`);
      await rm(historyPath, { force: true });
      await expect(readHistoryEntries(historyPath, id)).resolves.toEqual([]);
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

      const cliDefault = context.runCli(["activity", "--json", "--limit", "5"], { expectJson: true });
      expect(cliDefault.code).toBe(0);
      expect(cliDefault.json).toMatchObject({ compact: true, activity: [] });
      expect((cliDefault.json as { compact_activity?: unknown[] }).compact_activity?.length).toBeGreaterThan(0);

      const cliFull = context.runCli(["activity", "--json", "--full", "--limit", "5"], { expectJson: true });
      expect(cliFull.code).toBe(0);
      expect(cliFull.json).toMatchObject({ compact: false });
      expect((cliFull.json as { activity?: unknown[] }).activity?.length).toBeGreaterThan(0);

      const conflictingProjection = context.runCli(["activity", "--compact", "--full"]);
      expect(conflictingProjection.code).toBe(EXIT_CODE.USAGE);
      expect(conflictingProjection.stderr).toContain("Activity projection options are mutually exclusive");
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

  it("covers activity pure helper edge cases", async () => {
    const now = "2026-01-02T12:00:00.000Z";
    expect(activityInternals.parseNonEmptyFilter("  update  ", "--op")).toBe("update");
    expect(activityInternals.parseNonEmptyFilter(undefined, "--op")).toBeUndefined();
    expect(() => activityInternals.parseNonEmptyFilter("  ", "--op")).toThrow("--op must not be empty");
    expect(() => activityInternals.parseRangeBound("  ", now, "--from")).toThrow("Activity time bounds must not be empty");
    expect(activityInternals.parseRangeBound("2026-01-01T00:00:00.000Z", now, "--from")).toBe("2026-01-01T00:00:00.000Z");
    expect(activityInternals.parseRangeBound(undefined, now, "--from")).toBeUndefined();

    const baseEntry = { id: "pm-1", op: "x", author: "a", patch: [], before_hash: "", after_hash: "" };
    expect(activityInternals.includeByTimeWindow({ ...baseEntry, ts: "" }, "2026-01-01T00:00:00.000Z", undefined)).toBe(false);
    // Empty ts with only an upper bound (from undefined, to truthy) still excludes via the time window.
    expect(activityInternals.includeByTimeWindow({ ...baseEntry, ts: "" }, undefined, "2026-01-01T00:00:00.000Z")).toBe(false);
    expect(activityInternals.includeByTimeWindow({ ...baseEntry, ts: "2026-01-01T00:00:00.000Z" }, "2026-01-02T00:00:00.000Z", undefined)).toBe(false);
    expect(activityInternals.includeByTimeWindow({ ...baseEntry, ts: "2026-01-03T00:00:00.000Z" }, undefined, "2026-01-03T00:00:00.000Z")).toBe(false);
    expect(activityInternals.limitEntries([1, 2, 3], undefined)).toEqual([1, 2, 3]);
    expect(activityInternals.limitEntries([1, 2, 3], 2)).toEqual([1, 2]);
    expect(activityInternals.readActivityString(42, "fallback")).toBe("fallback");
    expect(activityInternals.normalizeActivityEntry("pm-x", { op: 1, ts: 2, author: 3, patch: "bad" } as never)).toMatchObject({
      id: "pm-x",
      op: "unknown",
      ts: "",
      author: "unknown",
      patch: [],
      before_hash: "",
      after_hash: "",
    });

    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pm-activity-files-"));
    try {
      expect(await activityInternals.listHistoryFiles(path.join(tempDir, "missing"))).toEqual([]);
      await writeFile(path.join(tempDir, "not-a-directory"), "not a directory", "utf8");
      await expect(activityInternals.listHistoryFiles(path.join(tempDir, "not-a-directory"))).rejects.toMatchObject({
        code: "ENOTDIR",
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
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

  it("computes per-field before/after value diffs with --diff", async () => {
    await withTempPmPath(async (context) => {
      const id = createItem(context, "History Diff Values");
      const update = context.runCli(
        ["update", id, "--json", "--priority", "3", "--author", "test-author", "--message", "Raise priority"],
        { expectJson: true },
      );
      expect(update.code).toBe(0);

      const result = await runHistory(id, { diff: true }, { path: context.pmPath });
      expect(result.diff).toBeDefined();
      const diff = result.diff ?? [];
      // create sets priority (absent -> 1); update replaces 1 -> 3.
      const updateEntry = diff.find((entry) =>
        entry.changes.some((change) => change.field === "priority" && change.before === 1),
      );
      expect(updateEntry).toBeDefined();
      expect(updateEntry?.changes.find((change) => change.field === "priority")).toMatchObject({
        field: "priority",
        before: 1,
        after: 3,
      });
    });
  });

  it("includes move-from field paths in compact history changed_fields", async () => {
    await withTempPmPath(async (context) => {
      const id = createItem(context, "History Move Patch Diff Fields");
      const historyPath = path.join(context.pmPath, "history", `${id}.jsonl`);
      await appendFile(
        historyPath,
        `${JSON.stringify({
          ts: "2026-02-01T00:00:00.000Z",
          author: "history-move",
          op: "legacy-move",
          before_hash: "0".repeat(64),
          after_hash: "1".repeat(64),
          patch: [{ op: "move", from: "/metadata/goal", path: "/metadata/value" }],
        })}\n`,
        "utf8",
      );

      const compact = await runHistory(id, { compact: true, limit: "1" }, { path: context.pmPath });
      expect(compact.compact_history).toHaveLength(1);
      expect(compact.compact_history?.[0]?.changed_fields).toEqual(expect.arrayContaining(["goal", "value"]));
    });
  });

  it("restricts the diff to one field's transitions with --field (implying --diff)", async () => {
    await withTempPmPath(async (context) => {
      const id = createItem(context, "History Diff Field Filter");
      const update = context.runCli(
        ["update", id, "--json", "--priority", "4", "--author", "test-author", "--message", "Raise priority again"],
        { expectJson: true },
      );
      expect(update.code).toBe(0);

      // --field alone implies --diff at the command layer.
      const result = await runHistory(id, { field: "priority" }, { path: context.pmPath });
      expect(result.diff).toBeDefined();
      const diff = result.diff ?? [];
      for (const entry of diff) {
        expect(entry.changed_fields).toEqual(["priority"]);
        expect(entry.changes.every((change) => change.field === "priority")).toBe(true);
      }
      expect(
        diff.some((entry) => entry.changes.some((change) => change.before === 1 && change.after === 4)),
      ).toBe(true);
    });
  });

  it("omits the diff when neither --diff nor --field is requested", async () => {
    await withTempPmPath(async (context) => {
      const id = createItem(context, "History No Diff");
      const result = await runHistory(id, {}, { path: context.pmPath });
      expect(result.diff).toBeUndefined();
    });
  });
});
