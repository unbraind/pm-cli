import { chmod, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import jsonPatch from "fast-json-patch";
import { afterEach, describe, expect, it } from "vitest";
import { runRestore } from "../../src/cli/commands/restore.js";
import { clearActiveExtensionHooks, setActiveExtensionHooks } from "../../src/core/extensions/index.js";
import type { ExtensionHookRegistry } from "../../src/core/extensions/loader.js";
import { createHistoryEntry } from "../../src/history.js";
import { stableStringify, sha256Hex } from "../../src/serialization.js";
import { EXIT_CODE } from "../../src/constants.js";
import { PmCliError } from "../../src/errors.js";
import type { HistoryEntry, ItemFrontMatter } from "../../src/types.js";
import { readJsonFixture } from "../helpers/fixtures.js";
import { withTempPmPath, type TempPmContext } from "../helpers/withTempPmPath.js";

interface RestoreCreateSeedFixture {
  status: string;
  priority: string;
  tags: string;
  body: string;
  deadline: string;
  estimate: string;
  acceptance_criteria: string;
  author: string;
  message: string;
  assignee: string;
  dep: string;
  comment: string;
  note: string;
  learning: string;
  file: string;
  test: string;
  doc: string;
}

const restoreCreateSeedFixture = readJsonFixture<RestoreCreateSeedFixture>("restore", "create-seed.json");

function createRestoreFixture(context: TempPmContext, title: string): string {
  const created = context.runCli(
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
      restoreCreateSeedFixture.status,
      "--priority",
      restoreCreateSeedFixture.priority,
      "--tags",
      restoreCreateSeedFixture.tags,
      "--body",
      restoreCreateSeedFixture.body,
      "--deadline",
      restoreCreateSeedFixture.deadline,
      "--estimate",
      restoreCreateSeedFixture.estimate,
      "--acceptance-criteria",
      restoreCreateSeedFixture.acceptance_criteria,
      "--author",
      restoreCreateSeedFixture.author,
      "--message",
      restoreCreateSeedFixture.message,
      "--assignee",
      restoreCreateSeedFixture.assignee,
      "--dep",
      restoreCreateSeedFixture.dep,
      "--comment",
      restoreCreateSeedFixture.comment,
      "--note",
      restoreCreateSeedFixture.note,
      "--learning",
      restoreCreateSeedFixture.learning,
      "--file",
      restoreCreateSeedFixture.file,
      "--test",
      restoreCreateSeedFixture.test,
      "--doc",
      restoreCreateSeedFixture.doc,
    ],
    { expectJson: true },
  );
  expect(created.code).toBe(0);
  const id = (created.json as { item: { id: string } }).item.id;

  const update = context.runCli(
    [
      "update",
      id,
      "--json",
      "--status",
      "in_progress",
      "--description",
      `${title} updated`,
      "--author",
      restoreCreateSeedFixture.author,
      "--message",
      "update restore fixture",
    ],
    { expectJson: true },
  );
  expect(update.code).toBe(0);

  const append = context.runCli(
    [
      "append",
      id,
      "--json",
      "--body",
      "second body section",
      "--author",
      restoreCreateSeedFixture.author,
      "--message",
      "append fixture body",
    ],
    { expectJson: true },
  );
  expect(append.code).toBe(0);

  return id;
}

describe("runRestore", () => {
  afterEach(() => {
    clearActiveExtensionHooks();
  });

  it("fails when tracker is not initialized", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pm-restore-not-init-"));
    try {
      await expect(runRestore("pm-missing", "1", {}, { path: tempDir })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("restores by version and appends a restore history event", async () => {
    await withTempPmPath(async (context) => {
      const id = createRestoreFixture(context, "Version Restore Item");

      const restored = await runRestore(
        id,
        "1",
        {
          author: "test-author",
          message: "restore to version 1",
        },
        { path: context.pmPath },
      );

      expect(restored.item.id).toBe(id);
      expect(restored.item.status).toBe("open");
      expect(restored.item.description).toContain("description");
      expect(restored.restored_from.kind).toBe("version");
      expect(restored.restored_from.history_index).toBe(1);
      expect(restored.changed_fields.length).toBeGreaterThan(0);

      const get = context.runCli(["get", id, "--json"], { expectJson: true });
      expect(get.code).toBe(0);
      const getJson = get.json as { item: { status: string }; body: string };
      expect(getJson.item.status).toBe(restoreCreateSeedFixture.status);
      expect(getJson.body).toBe(restoreCreateSeedFixture.body);

      const history = context.runCli(["history", id, "--json"], { expectJson: true });
      expect(history.code).toBe(0);
      const historyJson = history.json as { history: Array<{ op: string }> };
      expect(historyJson.history.at(-1)?.op).toBe("restore");
    });
  });

  it("dispatches onWrite hooks for restore item and history writes", async () => {
    await withTempPmPath(async (context) => {
      const id = createRestoreFixture(context, "Restore Hook Item");
      const events: string[] = [];
      const hooks: ExtensionHookRegistry = {
        beforeCommand: [],
        afterCommand: [],
        onRead: [],
        onWrite: [
          {
            layer: "project",
            name: "restore-write-hook",
            run: (hookContext) => {
              events.push(`${hookContext.op}:${path.basename(hookContext.path)}`);
              if (hookContext.op === "restore:history") {
                throw new Error("restore history hook failure");
              }
            },
          },
        ],
        onIndex: [],
      };
      setActiveExtensionHooks(hooks);

      const restored = await runRestore(
        id,
        "1",
        {
          author: "test-author",
          message: "restore hook coverage",
        },
        { path: context.pmPath },
      );

      expect(restored.item.id).toBe(id);
      expect(events).toEqual([
        `lock:create:${id}.lock`,
        `restore:${id}.md`,
        `restore:history:${id}.jsonl`,
        `lock:release:${id}.lock`,
      ]);
      expect(restored.warnings).toEqual(["extension_hook_failed:project:restore-write-hook:onWrite"]);
    });
  });

  it("restores by timestamp to the latest matching entry", async () => {
    await withTempPmPath(async (context) => {
      const id = createRestoreFixture(context, "Timestamp Restore Item");
      const history = context.runCli(["history", id, "--json"], { expectJson: true });
      expect(history.code).toBe(0);
      const historyJson = history.json as { history: Array<{ ts: string }> };
      const targetTimestamp = historyJson.history[1]?.ts;
      expect(typeof targetTimestamp).toBe("string");

      const restored = await runRestore(id, targetTimestamp ?? "", { author: "test-author" }, { path: context.pmPath });
      expect(restored.restored_from.kind).toBe("timestamp");
      expect(restored.restored_from.target).toBe(targetTimestamp);
      expect(restored.restored_from.history_index).toBe(2);

      const get = context.runCli(["get", id, "--json"], { expectJson: true });
      expect(get.code).toBe(0);
      const getJson = get.json as { item: { status: string }; body: string };
      expect(getJson.item.status).toBe("in_progress");
      expect(getJson.body).toBe(restoreCreateSeedFixture.body);
    });
  });

  it("validates restore targets", async () => {
    await withTempPmPath(async (context) => {
      const id = createRestoreFixture(context, "Invalid Restore Target Item");
      const history = context.runCli(["history", id, "--json"], { expectJson: true });
      expect(history.code).toBe(0);
      const firstTs = (history.json as { history: Array<{ ts: string }> }).history[0].ts;
      const beforeCreate = new Date(new Date(firstTs).getTime() - 10_000).toISOString();

      await expect(runRestore(id, "not-a-target", {}, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });

      await expect(runRestore(id, "999", {}, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });

      await expect(runRestore(id, beforeCreate, {}, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
    });
  });

  it("fails replay when history hashes are corrupted", async () => {
    await withTempPmPath(async (context) => {
      const id = createRestoreFixture(context, "Corrupt History Item");
      const historyPath = path.join(context.pmPath, "history", `${id}.jsonl`);
      const raw = await readFile(historyPath, "utf8");
      const lines = raw.trim().split(/\r?\n/);
      const first = JSON.parse(lines[0]) as { before_hash: string };
      first.before_hash = "corrupted-hash";
      lines[0] = JSON.stringify(first);
      await writeFile(historyPath, `${lines.join("\n")}\n`, "utf8");

      await expect(runRestore(id, "1", {}, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.GENERIC_FAILURE,
      });
    });
  });

  it("fails when no history file exists for an item", async () => {
    await withTempPmPath(async (context) => {
      const id = createRestoreFixture(context, "Missing History Item");
      const historyPath = path.join(context.pmPath, "history", `${id}.jsonl`);
      await unlink(historyPath);

      await expect(runRestore(id, "1", {}, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
    });
  });

  it("fails when replay resolves to a different item id", async () => {
    await withTempPmPath(async (context) => {
      const id = createRestoreFixture(context, "Mismatched ID Item");
      const get = context.runCli(["get", id, "--json"], { expectJson: true });
      expect(get.code).toBe(0);
      const getJson = get.json as { item: ItemFrontMatter; body: string };
      const mismatchedDocument = {
        front_matter: {
          ...getJson.item,
          id: "pm-different",
        },
        body: getJson.body,
      };
      const entry = createHistoryEntry({
        nowIso: new Date().toISOString(),
        author: "test-author",
        op: "create",
        before: {
          front_matter: {} as ItemFrontMatter,
          body: "",
        },
        after: mismatchedDocument,
        message: "seed mismatched replay id",
      });

      const historyPath = path.join(context.pmPath, "history", `${id}.jsonl`);
      await writeFile(historyPath, `${JSON.stringify(entry)}\n`, "utf8");

      await expect(runRestore(id, "1", {}, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.GENERIC_FAILURE,
      });
    });
  });

  it("enforces assignee conflicts unless forced", async () => {
    await withTempPmPath(async (context) => {
      const id = createRestoreFixture(context, "Assigned Author Item");
      const assign = context.runCli(
        ["update", id, "--json", "--assignee", "other-author", "--author", "test-author", "--message", "assign other"],
        { expectJson: true },
      );
      expect(assign.code).toBe(0);

      await expect(runRestore(id, "1", {}, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.CONFLICT,
      });
    });
  });

  it("rolls back item contents when restore history append fails", async () => {
    await withTempPmPath(async (context) => {
      const id = createRestoreFixture(context, "Rollback Restore Item");
      const before = context.runCli(["get", id, "--json"], { expectJson: true });
      expect(before.code).toBe(0);
      const beforeJson = before.json as { item: { status: string }; body: string };

      const historyPath = path.join(context.pmPath, "history", `${id}.jsonl`);
      await chmod(historyPath, 0o444);

      await expect(runRestore(id, "1", {}, { path: context.pmPath })).rejects.toBeTruthy();

      const after = context.runCli(["get", id, "--json"], { expectJson: true });
      expect(after.code).toBe(0);
      const afterJson = after.json as { item: { status: string }; body: string };
      expect(afterJson.item.status).toBe(beforeJson.item.status);
      expect(afterJson.body).toBe(beforeJson.body);
    });
  });

  it("rejects malformed history timestamps when restoring by timestamp", async () => {
    await withTempPmPath(async (context) => {
      const id = createRestoreFixture(context, "Bad Timestamp Item");
      const historyPath = path.join(context.pmPath, "history", `${id}.jsonl`);
      const raw = await readFile(historyPath, "utf8");
      const lines = raw.trim().split(/\r?\n/);
      const first = JSON.parse(lines[0]) as HistoryEntry;
      first.ts = "not-a-timestamp";
      lines[0] = JSON.stringify(first);
      await writeFile(historyPath, `${lines.join("\n")}\n`, "utf8");

      await expect(
        runRestore(id, new Date(Date.now() + 60_000).toISOString(), {}, { path: context.pmPath }),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.GENERIC_FAILURE,
      });
    });
  });

  it("handles invalid replay patch payloads and after-hash mismatches", async () => {
    await withTempPmPath(async (context) => {
      const id = createRestoreFixture(context, "Patch Failure Item");
      const historyPath = path.join(context.pmPath, "history", `${id}.jsonl`);

      const invalidShapeEntry: HistoryEntry = {
        ts: new Date().toISOString(),
        author: "test-author",
        op: "create",
        patch: [
          {
            op: "replace",
            path: "/body",
            value: 7,
          },
        ],
        before_hash: sha256Hex(stableStringify({ front_matter: {}, body: "" })),
        after_hash: "unused-after-hash",
      };
      await writeFile(historyPath, `${JSON.stringify(invalidShapeEntry)}\n`, "utf8");
      await expect(runRestore(id, "1", {}, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.GENERIC_FAILURE,
      });

      const invalidPatchEntry: HistoryEntry = {
        ts: new Date().toISOString(),
        author: "test-author",
        op: "create",
        patch: [
          {
            op: "replace",
            path: "/front_matter/missing",
            value: "x",
          },
        ],
        before_hash: sha256Hex(stableStringify({ front_matter: {}, body: "" })),
        after_hash: "unused-after-hash",
      };
      await writeFile(historyPath, `${JSON.stringify(invalidPatchEntry)}\n`, "utf8");
      await expect(runRestore(id, "1", {}, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.GENERIC_FAILURE,
      });

      const validTarget = {
        front_matter: {
          id,
          title: "Hash mismatch item",
          description: "hash mismatch",
          type: "Task",
          status: "open",
          priority: 1,
          tags: ["restore"],
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        body: "",
      };
      const validPatch = jsonPatch.compare({ front_matter: {}, body: "" }, validTarget);
      const afterHashMismatchEntry: HistoryEntry = {
        ts: new Date().toISOString(),
        author: "test-author",
        op: "create",
        patch: validPatch as HistoryEntry["patch"],
        before_hash: sha256Hex(stableStringify({ front_matter: {}, body: "" })),
        after_hash: "wrong-after-hash",
      };
      await writeFile(historyPath, `${JSON.stringify(afterHashMismatchEntry)}\n`, "utf8");
      await expect(runRestore(id, "1", {}, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.GENERIC_FAILURE,
      });
    });
  });

  it("supports force restore and unknown-author fallback", async () => {
    await withTempPmPath(async (context) => {
      const id = createRestoreFixture(context, "Force Restore Item");
      const assign = context.runCli(
        ["update", id, "--json", "--assignee", "other-author", "--author", "test-author", "--message", "assign other"],
        { expectJson: true },
      );
      expect(assign.code).toBe(0);

      const restored = await runRestore(
        id,
        "1",
        {
          author: "   ",
          force: true,
        },
        { path: context.pmPath },
      );
      expect(restored.item.id).toBe(id);

      const history = context.runCli(["history", id, "--json"], { expectJson: true });
      expect(history.code).toBe(0);
      const historyJson = history.json as { history: Array<{ op: string; author: string }> };
      const restoreEntries = historyJson.history.filter((entry) => entry.op === "restore");
      expect(restoreEntries.length).toBeGreaterThan(0);
      expect(restoreEntries.at(-1)?.author).toBe("unknown");
    });
  });

  it("validates blank targets and missing items", async () => {
    await withTempPmPath(async (context) => {
      const id = createRestoreFixture(context, "Validation Restore Item");

      await expect(runRestore(id, "   ", {}, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(runRestore("pm-does-not-exist", "1", {}, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
    });
  });

  it("falls back to settings author when PM_AUTHOR is unset", async () => {
    await withTempPmPath(async (context) => {
      const id = createRestoreFixture(context, "Env Author Fallback Item");
      const previous = process.env.PM_AUTHOR;
      delete process.env.PM_AUTHOR;
      try {
        const restored = await runRestore(id, "1", {}, { path: context.pmPath });
        expect(restored.item.id).toBe(id);
      } finally {
        if (previous === undefined) {
          delete process.env.PM_AUTHOR;
        } else {
          process.env.PM_AUTHOR = previous;
        }
      }
    });
  });
});
