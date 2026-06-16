import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  limitAnnotationEntries,
  parseAnnotationTextInput,
  readAnnotationEntries,
  resolveAnnotationIndex,
  runAnnotationCommand,
  wrapOwnershipConflict,
} from "../../../src/cli/commands/annotation-command.js";
import { runComments } from "../../../src/cli/commands/comments.js";
import { runCommentsAudit } from "../../../src/cli/commands/comments-audit.js";
import { EXIT_CODE } from "../../../src/core/shared/constants.js";
import { PmCliError } from "../../../src/core/shared/errors.js";
import { createTestItemId } from "../../helpers/itemFactory.js";
import { withTempPmPath, type TempPmContext } from "../../helpers/withTempPmPath.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function createTask(context: TempPmContext, title: string): string {
  return createTestItemId(context, {
    title,
    tags: "comments,unit",
    estimate: "10",
  });
}

function setGovernancePreset(context: TempPmContext, preset: "minimal" | "default" | "strict"): void {
  const result = context.runCli(["config", "project", "set", "governance-preset", "--policy", preset, "--json"], {
    expectJson: true,
  });
  expect(result.code).toBe(0);
}

describe("runComments", () => {
  it("covers shared annotation helper edge branches", async () => {
    expect(limitAnnotationEntries(["a", "b"], undefined)).toEqual(["a", "b"]);
    expect(limitAnnotationEntries(["a", "b"], 0)).toEqual([]);
    expect(parseAnnotationTextInput("   ")).toBe("");
    expect(parseAnnotationTextInput("plain text")).toBe("plain text");
    expect(parseAnnotationTextInput("text:")).toBe("text:");
    expect(parseAnnotationTextInput("text=hello,scope:project")).toBe("text=hello,scope:project");
    expect(parseAnnotationTextInput("text:", { stripPlainTextPrefix: true })).toBe("text:");
    expect(readAnnotationEntries({ comments: "not-array" }, "comments")).toEqual([]);
    expect(readAnnotationEntries({ comments: [{ text: "ok" }] }, "comments")).toEqual([{ text: "ok" }]);

    const nonConflict = new Error("not an ownership conflict");
    expect(() =>
      wrapOwnershipConflict(nonConflict, {
        required: "required",
        examples: [],
        nextSteps: [],
      }),
    ).toThrow(nonConflict);

    await withTempPmPath(async (context) => {
      const id = createTask(context, "comments-shared-helper-edges");
      const metaWithoutLimit = await runComments(id, { includeMeta: true }, { path: context.pmPath });
      expect(metaWithoutLimit).toMatchObject({
        count: 0,
        total_count: 0,
        returned_count: 0,
        has_more: false,
      });
      expect(metaWithoutLimit).not.toHaveProperty("limit");

      await expect(
        runAnnotationCommand<"comments", { created_at: string; author: string; text: string }>(
          id,
          {},
          { path: context.pmPath },
          {
            input: { mode: "add" },
            collectionKey: "comments",
            op: "comment_add",
            parseText: (raw) => raw,
            allowAuditBypass: false,
            conflictGuidance: {
              required: "required",
              examples: [],
              nextSteps: [],
            },
          },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: "--add text cannot be empty",
      });
    });
  });

  it("fails when tracker is not initialized", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pm-comments-not-init-"));
    try {
      await expect(runComments("pm-missing", {}, { path: tempDir })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
      await expect(runComments("pm-missing", { add: "comment text" }, { path: tempDir })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("lists comments, enforces limit semantics, and validates limit inputs", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "comments-limit");

      const empty = await runComments(id, {}, { path: context.pmPath });
      expect(empty.count).toBe(0);
      expect(empty.comments).toEqual([]);

      await expect(runComments("pm-does-not-exist", {}, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.NOT_FOUND,
      });

      await runComments(id, { add: "first comment", author: "first-author" }, { path: context.pmPath });
      await runComments(id, { add: "second comment" }, { path: context.pmPath });
      await runComments(id, { add: "third comment" }, { path: context.pmPath });

      const all = await runComments(id, {}, { path: context.pmPath });
      expect(all.count).toBe(3);
      expect(all.comments.map((entry) => entry.text)).toEqual(["first comment", "second comment", "third comment"]);

      const limited = await runComments(id, { limit: "2" }, { path: context.pmPath });
      expect(limited.count).toBe(2);
      expect(limited.comments.map((entry) => entry.text)).toEqual(["second comment", "third comment"]);

      const floored = await runComments(id, { limit: "1.9" }, { path: context.pmPath });
      expect(floored.count).toBe(1);
      expect(floored.comments[0].text).toBe("third comment");

      const zero = await runComments(id, { limit: "0" }, { path: context.pmPath });
      expect(zero.count).toBe(0);
      expect(zero.comments).toEqual([]);

      await expect(runComments(id, { limit: "-1" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(runComments(id, { limit: "not-a-number" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
    });
  });

  it("rejects empty comment text", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "comments-empty");
      await expect(runComments(id, { add: "   " }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
    });
  });

  it("rejects conflicting comment input sources", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "comments-conflicting-input-sources");
      await expect(runComments(id, { add: "flag text", stdin: true }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(
        runComments(id, { stdin: true, file: path.join(context.pmPath, "comment.md") }, { path: context.pmPath }),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
    });
  });

  it("resolves author from explicit input, env fallback, settings fallback, and unknown fallback", async () => {
    await withTempPmPath(async (context) => {
      const explicitId = createTask(context, "comments-explicit-author");
      const explicit = await runComments(
        explicitId,
        {
          add: "explicit author comment",
          author: " explicit-author ",
          message: "add explicit author comment",
        },
        { path: context.pmPath },
      );
      expect(explicit.comments.at(-1)?.author).toBe("explicit-author");

      const envId = createTask(context, "comments-env-author");
      const envResult = await runComments(envId, { add: "env author comment" }, { path: context.pmPath });
      expect(envResult.comments.at(-1)?.author).toBe("test-author");

      const previousPmAuthor = process.env.PM_AUTHOR;
      delete process.env.PM_AUTHOR;
      try {
        const settingsPath = path.join(context.pmPath, "settings.json");
        const settings = JSON.parse(await readFile(settingsPath, "utf8")) as { author_default?: string };
        settings.author_default = "settings-author";
        await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

        const settingsId = createTask(context, "comments-settings-author");
        const settingsResult = await runComments(settingsId, { add: "settings author comment" }, { path: context.pmPath });
        expect(settingsResult.comments.at(-1)?.author).toBe("settings-author");

        const unknownId = createTask(context, "comments-unknown-author");
        const unknownResult = await runComments(
          unknownId,
          {
            add: "unknown author comment",
            author: "   ",
          },
          { path: context.pmPath },
        );
        expect(unknownResult.comments.at(-1)?.author).toBe("unknown");
      } finally {
        if (previousPmAuthor === undefined) {
          delete process.env.PM_AUTHOR;
        } else {
          process.env.PM_AUTHOR = previousPmAuthor;
        }
      }
    });
  });

  it("accepts text= and markdown comment payload forms", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "comments-structured-input");
      const structured = await runComments(id, { add: "text: markdown comment body" }, { path: context.pmPath });
      expect(structured.comments.at(-1)?.text).toBe("markdown comment body");

      const ambiguousCsvLike = "text=hello,scope:project";
      const ambiguousResult = await runComments(id, { add: ambiguousCsvLike }, { path: context.pmPath });
      expect(ambiguousResult.comments.at(-1)?.text).toBe("hello,scope:project");

      const fenced = ["```", "text: fenced body", "```"].join("\n");
      const fencedResult = await runComments(id, { add: fenced }, { path: context.pmPath });
      expect(fencedResult.comments.at(-1)?.text).toBe("fenced body");

      const malformed = ["```", "not structured", "```"].join("\n");
      const malformedResult = await runComments(id, { add: malformed }, { path: context.pmPath });
      expect(malformedResult.comments.at(-1)?.text).toBe(malformed);
    });
  });

  it("can include paging metadata for limited comment snapshots", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "comments-limit-metadata");
      await runComments(id, { add: "first comment" }, { path: context.pmPath });
      await runComments(id, { add: "second comment" }, { path: context.pmPath });
      await runComments(id, { add: "third comment" }, { path: context.pmPath });

      const limited = await runComments(id, { limit: "2", includeMeta: true }, { path: context.pmPath });
      expect(limited).toMatchObject({
        id,
        count: 2,
        total_count: 3,
        returned_count: 2,
        has_more: true,
        limit: 2,
      });
      expect(limited.comments.map((entry) => entry.text)).toEqual(["second comment", "third comment"]);
    });
  });

  it("allows audit comment appends without force while preserving non-comment ownership checks", async () => {
    await withTempPmPath(async (context) => {
      setGovernancePreset(context, "strict");
      const id = createTask(context, "comments-audit-append-policy");
      const assigned = context.runCli(
        ["update", id, "--assignee", "owner-a", "--author", "owner-a", "--message", "assign owner for audit test", "--json"],
        { expectJson: true },
      );
      expect(assigned.code).toBe(0);

      await expect(runComments(id, { add: "blocked audit comment", author: "owner-b" }, { path: context.pmPath })).rejects.toMatchObject<
        PmCliError
      >({
        exitCode: EXIT_CODE.CONFLICT,
        context: expect.objectContaining({
          code: "ownership_conflict",
          required: expect.stringContaining("--allow-audit-comment"),
          nextSteps: expect.arrayContaining([expect.stringContaining("--allow-audit-comment")]),
        }),
      });

      const allowed = await runComments(
        id,
        {
          add: "allowed audit comment",
          author: "owner-b",
          allowAuditComment: true,
        },
        { path: context.pmPath },
      );
      expect(allowed.comments.at(-1)?.text).toBe("allowed audit comment");
      expect(allowed.comments.at(-1)?.author).toBe("owner-b");

      const blockedUpdate = context.runCli(["update", id, "--status", "in_progress", "--author", "owner-b", "--json"]);
      expect(blockedUpdate.code).toBe(EXIT_CODE.CONFLICT);
    });
  });

  it("accepts stdin token for comment add payload", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "comments-stdin-token");
      const stdin = new PassThrough();
      stdin.end("text: from stdin\n");
      Object.defineProperty(stdin, "isTTY", { value: false, configurable: true });
      vi.spyOn(process, "stdin", "get").mockReturnValue(stdin as unknown as NodeJS.ReadStream);

      const result = await runComments(id, { add: "-" }, { path: context.pmPath });
      expect(result.comments.at(-1)?.text).toBe("from stdin");
    });
  });

  it("accepts --stdin payload for multiline markdown comment text", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "comments-stdin-markdown");
      const markdown = "# Investigation\n\n- verify branch state\n- add evidence\n";
      const stdin = new PassThrough();
      stdin.end(markdown);
      Object.defineProperty(stdin, "isTTY", { value: false, configurable: true });
      vi.spyOn(process, "stdin", "get").mockReturnValue(stdin as unknown as NodeJS.ReadStream);

      const result = await runComments(id, { stdin: true }, { path: context.pmPath });
      expect(result.comments.at(-1)?.text).toBe(markdown);
    });
  });

  it("accepts --file payload for multiline markdown comment text", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "comments-file-markdown");
      const filePath = path.join(context.pmPath, "comment-markdown.md");
      const markdown = "## Detailed Note\n\nThis is a multiline markdown payload.\n- bullet one\n- bullet two\n";
      await writeFile(filePath, markdown, "utf8");

      const result = await runComments(id, { file: filePath }, { path: context.pmPath });
      expect(result.comments.at(-1)?.text).toBe(markdown);
    });
  });

  it("rejects missing --file path input", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "comments-file-missing");
      await expect(
        runComments(id, { file: path.join(context.pmPath, "missing-comment.md") }, { path: context.pmPath }),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
    });
  });

  it("rejects a whitespace-only --file path", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "comments-file-blank");
      await expect(runComments(id, { file: "   " }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: "--file path cannot be empty",
      });
    });
  });

  it("wraps non-ENOENT --file read failures (directory path)", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "comments-file-directory");
      // Pointing --file at a directory triggers a non-ENOENT errno (EISDIR),
      // exercising the generic read-failure wrap branch.
      await expect(runComments(id, { file: context.pmPath }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining(`Failed to read --file path "${context.pmPath}"`),
      });
    });
  });

  it("handles nullish stdin resolver values for --add and --stdin", async () => {
    await vi.resetModules();
    const parseInputMock = vi.fn((raw: string) => `parsed:${raw}`);
    const runAnnotationMock = vi.fn(
      async (_id: string, _options: unknown, _global: unknown, context: { input: { value?: string } }) => context.input,
    );

    vi.doMock("../../../src/core/item/parse.js", () => ({
      createStdinTokenResolver: () => ({
        resolveValue: vi.fn(async () => undefined),
      }),
    }));
    vi.doMock("../../../src/cli/commands/annotation-command.js", () => ({
      parseAnnotationTextInput: parseInputMock,
      runAnnotationCommand: runAnnotationMock,
    }));

    const { runComments: mockedRunComments } = await import("../../../src/cli/commands/comments.js");
    const addInput = await mockedRunComments("pm-stdin-add", { add: "-" }, {} as never);
    expect((addInput as unknown as { value?: string }).value).toBe("parsed:");
    expect(parseInputMock).toHaveBeenCalledWith("", { stripPlainTextPrefix: true });

    const stdinInput = await mockedRunComments("pm-stdin-flag", { stdin: true }, {} as never);
    expect((stdinInput as unknown as { value?: string }).value).toBe("");

    vi.doUnmock("../../../src/core/item/parse.js");
    vi.doUnmock("../../../src/cli/commands/annotation-command.js");
    await vi.resetModules();
  });

  it("wraps non-Error --file read failures using String(error)", async () => {
    await vi.resetModules();
    vi.doMock("node:fs/promises", () => ({
      readFile: vi.fn(async () => {
        throw "boom-string-error";
      }),
    }));
    vi.doMock("../../../src/core/item/parse.js", () => ({
      createStdinTokenResolver: () => ({
        resolveValue: vi.fn(async (value: string | undefined) => value),
      }),
    }));
    vi.doMock("../../../src/cli/commands/annotation-command.js", () => ({
      parseAnnotationTextInput: vi.fn((raw: string) => raw),
      runAnnotationCommand: vi.fn(),
    }));

    const { runComments: mockedRunComments } = await import("../../../src/cli/commands/comments.js");
    await expect(mockedRunComments("pm-file-wrap", { file: "  ./missing.md  " }, {} as never)).rejects.toMatchObject({
      message: expect.stringContaining('Failed to read --file path "./missing.md": boom-string-error'),
    });

    vi.doUnmock("node:fs/promises");
    vi.doUnmock("../../../src/core/item/parse.js");
    vi.doUnmock("../../../src/cli/commands/annotation-command.js");
    await vi.resetModules();
  });

  it("returns filtered latest comment snapshots across items", async () => {
    await withTempPmPath(async (context) => {
      const openId = createTask(context, "comments-audit-open");
      const closedId = createTask(context, "comments-audit-closed");

      const closed = context.runCli(
        ["close", closedId, "close item for audit test", "--author", "owner-a", "--message", "close item for audit test", "--json"],
        {
          expectJson: true,
        },
      );
      expect(closed.code).toBe(0);

      await runComments(openId, { add: "open-first", author: "audit-a" }, { path: context.pmPath });
      await runComments(openId, { add: "open-second", author: "audit-b" }, { path: context.pmPath });
      await runComments(closedId, { add: "closed-only", author: "audit-c" }, { path: context.pmPath });

      const auditOpen = await runCommentsAudit({ status: "open", latest: "1" }, { path: context.pmPath });
      expect(auditOpen.filters).toMatchObject({
        status: "open",
        latest: 1,
        full_history: false,
      });
      expect(auditOpen.export).toMatchObject({
        mode: "latest",
        row_count: 1,
      });
      expect(auditOpen.summary).toMatchObject({
        totals: {
          items_scanned: 1,
          items_with_comments: 1,
          zero_comment_items: 0,
          comments_total: 2,
          comments_exported: 1,
        },
        coverage: {
          items_with_comments_ratio: 1,
          items_with_comments_percent: 100,
        },
      });
      expect(auditOpen.summary.by_type).toEqual([
        expect.objectContaining({
          type: "Task",
          items_scanned: 1,
          items_with_comments: 1,
          zero_comment_items: 0,
          comments_total: 2,
          comments_exported: 1,
          items_with_comments_ratio: 1,
          items_with_comments_percent: 100,
        }),
      ]);
      expect(auditOpen.items.some((entry) => entry.id === closedId)).toBe(false);
      expect(auditOpen.items.find((entry) => entry.id === openId)?.comments.map((entry) => entry.text)).toEqual(["open-second"]);

      const auditClosed = await runCommentsAudit({ status: "closed", latest: "3", limit: "1" }, { path: context.pmPath });
      expect(auditClosed.count).toBe(1);
      expect(auditClosed.items[0]?.id).toBe(closedId);
      expect(auditClosed.items[0]?.comments.map((entry) => entry.text)).toEqual(["closed-only"]);
      expect(auditClosed.items[0]?.comment_count).toBe(1);
      expect(auditClosed.filters.limit_items).toBe(1);
      expect(auditClosed.summary.totals).toMatchObject({
        items_scanned: 1,
        items_with_comments: 1,
        zero_comment_items: 0,
        comments_total: 1,
        comments_exported: 1,
      });
    });
  });

  it("tolerates missing comment arrays and missing list now values in comments-audit", async () => {
    await vi.resetModules();
    vi.doMock("../../../src/core/fs/fs-utils.js", () => ({
      pathExists: vi.fn(async () => true),
    }));
    vi.doMock("../../../src/core/store/paths.js", () => ({
      resolvePmRoot: vi.fn(() => "/tmp/comments-audit-branch"),
      getSettingsPath: vi.fn(() => "/tmp/comments-audit-branch/settings.json"),
    }));
    vi.doMock("../../../src/core/store/settings.js", () => ({
      readSettings: vi.fn(async () => ({ schema: {} })),
    }));
    vi.doMock("../../../src/core/schema/runtime-schema.js", () => ({
      resolveRuntimeStatusRegistry: vi.fn(() => ({
        definitions: [{ id: "open" }, { id: "closed" }],
      })),
    }));
    vi.doMock("../../../src/cli/commands/list.js", () => ({
      runList: vi.fn(async () => ({
        items: [
          {
            id: "pm-1",
            title: "No comments yet",
            type: "Task",
            status: "open",
            assignee: undefined,
            updated_at: "2026-06-01T00:00:00.000Z",
            comments: undefined,
          },
        ],
        filters: { status: null },
        warnings: ["audit_warning:mocked"],
      })),
    }));

    const { runCommentsAudit: mockedRunCommentsAudit } = await import("../../../src/cli/commands/comments-audit.js");
    const result = await mockedRunCommentsAudit({ fullHistory: true }, { path: "/tmp/comments-audit-branch" });
    expect(result.items[0]?.comments).toEqual([]);
    expect(result.export.row_count).toBe(0);
    expect(typeof result.now).toBe("string");
    expect(result.warnings).toEqual(["audit_warning:mocked"]);

    vi.doUnmock("../../../src/core/fs/fs-utils.js");
    vi.doUnmock("../../../src/core/store/paths.js");
    vi.doUnmock("../../../src/core/store/settings.js");
    vi.doUnmock("../../../src/core/schema/runtime-schema.js");
    vi.doUnmock("../../../src/cli/commands/list.js");
    await vi.resetModules();
  });

  it("exports full comment history rows when --full-history is enabled", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "comments-audit-full-history");
      await runComments(id, { add: "history-first", author: "audit-a" }, { path: context.pmPath });
      await runComments(id, { add: "history-second", author: "audit-b" }, { path: context.pmPath });

      const fullHistory = await runCommentsAudit(
        {
          status: "open",
          limitItems: "1",
          fullHistory: true,
        },
        { path: context.pmPath },
      );

      expect(fullHistory.filters).toMatchObject({
        status: "open",
        limit_items: 1,
        latest: null,
        full_history: true,
      });
      expect(fullHistory.export).toMatchObject({
        mode: "full_history",
        row_count: 2,
      });
      expect(fullHistory.items[0]?.comments.map((entry) => entry.text)).toEqual(["history-first", "history-second"]);
      expect(fullHistory.rows?.map((row) => row.text)).toEqual(["history-first", "history-second"]);
      expect(fullHistory.rows?.map((row) => row.comment_index)).toEqual([0, 1]);
      expect(fullHistory.rows?.every((row) => row.item_id === id)).toBe(true);
      expect(fullHistory.summary).toMatchObject({
        totals: {
          items_scanned: 1,
          items_with_comments: 1,
          zero_comment_items: 0,
          comments_total: 2,
          comments_exported: 2,
        },
        coverage: {
          items_with_comments_ratio: 1,
          items_with_comments_percent: 100,
        },
      });
    });
  });

  it("supports --latest 0 summary-only comments-audit snapshots", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "comments-audit-latest-zero");
      await runComments(id, { add: "summary-first", author: "audit-a" }, { path: context.pmPath });
      await runComments(id, { add: "summary-second", author: "audit-b" }, { path: context.pmPath });

      const summaryOnly = await runCommentsAudit(
        {
          status: "open",
          latest: "0",
          limitItems: "1",
        },
        { path: context.pmPath },
      );

      expect(summaryOnly.filters).toMatchObject({
        status: "open",
        latest: 0,
        full_history: false,
      });
      expect(summaryOnly.export).toMatchObject({
        mode: "latest",
        row_count: 0,
      });
      expect(summaryOnly.items[0]?.id).toBe(id);
      expect(summaryOnly.items[0]?.comment_count).toBe(2);
      expect(summaryOnly.items[0]?.comments).toEqual([]);
      expect(summaryOnly.rows).toBeUndefined();
      expect(summaryOnly.summary).toMatchObject({
        totals: {
          items_scanned: 1,
          items_with_comments: 1,
          zero_comment_items: 0,
          comments_total: 2,
          comments_exported: 0,
        },
      });
    });
  });

  it("supports parent/tag/sprint/release/priority filters for comments-audit", async () => {
    await withTempPmPath(async (context) => {
      const parentId = createTask(context, "comments-audit-parent");
      const updateParent = context.runCli(
        [
          "update",
          parentId,
          "--json",
          "--sprint",
          "sprint-parent",
          "--release",
          "v-parent",
          "--message",
          "set parent metadata",
          "--author",
          "seed-author",
        ],
        { expectJson: true },
      );
      expect(updateParent.code).toBe(0);

      const childId = createTask(context, "comments-audit-child");
      const updateChild = context.runCli(
        [
          "update",
          childId,
          "--json",
          "--parent",
          parentId,
          "--tags",
          "comments,unit,child-scope",
          "--priority",
          "0",
          "--sprint",
          "sprint-a",
          "--release",
          "v1",
          "--message",
          "set child metadata",
          "--author",
          "seed-author",
        ],
        { expectJson: true },
      );
      expect(updateChild.code).toBe(0);

      await runComments(childId, { add: "scoped comment", author: "audit-a" }, { path: context.pmPath });

      const filtered = await runCommentsAudit(
        {
          parent: parentId,
          tag: "child-scope",
          sprint: "sprint-a",
          release: "v1",
          priority: "0",
        },
        { path: context.pmPath },
      );

      expect(filtered.count).toBe(1);
      expect(filtered.items[0]?.id).toBe(childId);
      expect(filtered.filters).toMatchObject({
        parent: parentId,
        tag: "child-scope",
        sprint: "sprint-a",
        release: "v1",
        priority: 0,
      });
    });
  });

  it("reports zero-coverage summary when no items match the audit scope", async () => {
    await withTempPmPath(async (context) => {
      createTask(context, "comments-audit-empty-scope");
      // A tag that matches nothing yields an empty item set, exercising the
      // ratioPercent denominator<=0 branch for the overall coverage summary.
      const empty = await runCommentsAudit({ tag: "no-such-tag-zzz" }, { path: context.pmPath });
      expect(empty.count).toBe(0);
      expect(empty.summary.totals).toMatchObject({
        items_scanned: 0,
        items_with_comments: 0,
        comments_total: 0,
        comments_exported: 0,
      });
      expect(empty.summary.coverage).toEqual({
        items_with_comments_ratio: 0,
        items_with_comments_percent: 0,
      });
      expect(empty.summary.by_type).toEqual([]);
    });
  });

  it("sorts the by_type summary across multiple item types", async () => {
    await withTempPmPath(async (context) => {
      const taskId = createTask(context, "comments-audit-type-task");
      const epicId = createTestItemId(context, {
        title: "comments-audit-type-epic",
        type: "Epic",
        tags: "comments,unit",
        estimate: "10",
      });
      await runComments(taskId, { add: "task comment", author: "audit-a" }, { path: context.pmPath });
      await runComments(epicId, { add: "epic comment", author: "audit-b" }, { path: context.pmPath });

      const audited = await runCommentsAudit({ status: "open" }, { path: context.pmPath });
      const types = audited.summary.by_type.map((entry) => entry.type);
      expect(types).toEqual(["Epic", "Task"]);
      expect(audited.summary.by_type.every((entry) => entry.items_with_comments === 1)).toBe(true);
    });
  });

  it("validates comments-audit filter values", async () => {
    await withTempPmPath(async (context) => {
      await expect(runCommentsAudit({ status: "not-a-status" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(runCommentsAudit({ latest: "-1" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(runCommentsAudit({ limitItems: "1.5" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(runCommentsAudit({ limit: "1.5" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(
        runCommentsAudit({ limitItems: "3", limit: "1" }, { path: context.pmPath }),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: "--limit and --limit-items must match when both are provided",
      });
      await expect(runCommentsAudit({ fullHistory: true, latest: "1" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: "--full-history cannot be combined with --latest",
      });
    });
  });
});

describe("resolveAnnotationIndex", () => {
  it("converts a valid 1-based index to a 0-based array index", () => {
    expect(resolveAnnotationIndex(1, 3, "comments")).toBe(0);
    expect(resolveAnnotationIndex(3, 3, "comments")).toBe(2);
  });

  it("rejects out-of-range, missing, and non-integer indexes with a clear message", () => {
    expect(() => resolveAnnotationIndex(0, 3, "comments")).toThrow("Comment index 0 out of range (item has 3 comments)");
    expect(() => resolveAnnotationIndex(4, 3, "comments")).toThrow("Comment index 4 out of range (item has 3 comments)");
    expect(() => resolveAnnotationIndex(2.5, 3, "comments")).toThrow("Comment index 2.5 out of range (item has 3 comments)");
    expect(() => resolveAnnotationIndex(undefined, 3, "comments")).toThrow("Comment index (missing) out of range (item has 3 comments)");
  });

  it("uses a singular noun and a capitalized singular label when the collection has one entry", () => {
    expect(() => resolveAnnotationIndex(5, 1, "comments")).toThrow("Comment index 5 out of range (item has 1 comment)");
    expect(() => resolveAnnotationIndex(5, 0, "notes")).toThrow("Note index 5 out of range (item has 0 notes)");
  });
});

describe("runComments edit/delete (GH-243)", () => {
  it("edits a comment in place, preserving created_at/author and stamping edited_at", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "comments-edit-inplace");
      await runComments(id, { add: "first", author: "ann" }, { path: context.pmPath });
      await runComments(id, { add: "second to fix", author: "bob" }, { path: context.pmPath });

      const original = await runComments(id, {}, { path: context.pmPath });
      const secondCreatedAt = original.comments[1].created_at;

      const edited = await runComments(id, { edit: 2, add: "second fixed", author: "carol" }, { path: context.pmPath });
      expect(edited.comments).toHaveLength(2);
      expect(edited.comments[1].text).toBe("second fixed");
      // created_at + original author are preserved; edited_at is stamped.
      expect(edited.comments[1].created_at).toBe(secondCreatedAt);
      expect(edited.comments[1].author).toBe("bob");
      expect(typeof (edited.comments[1] as { edited_at?: string }).edited_at).toBe("string");
      // the untouched comment is unchanged.
      expect(edited.comments[0].text).toBe("first");
    });
  });

  it("deletes a comment at a 1-based index", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "comments-delete-index");
      await runComments(id, { add: "keep-me" }, { path: context.pmPath });
      await runComments(id, { add: "remove-me" }, { path: context.pmPath });
      await runComments(id, { add: "keep-me-too" }, { path: context.pmPath });

      const afterDelete = await runComments(id, { delete: 2 }, { path: context.pmPath });
      expect(afterDelete.comments.map((entry) => entry.text)).toEqual(["keep-me", "keep-me-too"]);
    });
  });

  it("rejects an edit with empty replacement text", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "comments-edit-empty");
      await runComments(id, { add: "original" }, { path: context.pmPath });
      await expect(runComments(id, { edit: 1, add: "   " }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
    });
  });

  it("rejects an out-of-range edit or delete index", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "comments-index-range");
      await runComments(id, { add: "only one" }, { path: context.pmPath });
      await expect(runComments(id, { delete: 5 }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: "Comment index 5 out of range (item has 1 comment)",
      });
      await expect(runComments(id, { edit: 9, add: "x" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: "Comment index 9 out of range (item has 1 comment)",
      });
    });
  });

  it("rejects conflicting --edit and --delete, text on delete, and missing text on edit", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "comments-edit-delete-guards");
      await runComments(id, { add: "seed" }, { path: context.pmPath });

      await expect(runComments(id, { edit: 1, delete: 1, add: "x" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: "Specify only one of --edit or --delete",
      });
      await expect(runComments(id, { delete: 1, add: "text" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: "--delete does not take comment text",
      });
      await expect(runComments(id, { edit: 1 }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: "--edit requires replacement text via positional [text], --add, --stdin, or --file",
      });
    });
  });

  it("resolves edit replacement text from --stdin and --file sources", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "comments-edit-sources");
      await runComments(id, { add: "seed" }, { path: context.pmPath });

      const stdin = new PassThrough();
      stdin.end("edited via stdin\n");
      Object.defineProperty(stdin, "isTTY", { value: false, configurable: true });
      vi.spyOn(process, "stdin", "get").mockReturnValue(stdin as unknown as NodeJS.ReadStream);
      const viaStdin = await runComments(id, { edit: 1, stdin: true }, { path: context.pmPath });
      expect(viaStdin.comments[0].text).toBe("edited via stdin");

      const filePath = path.join(context.pmPath, "edit.md");
      await writeFile(filePath, "edited via file", "utf8");
      const viaFile = await runComments(id, { edit: 1, file: filePath }, { path: context.pmPath });
      expect(viaFile.comments[0].text).toBe("edited via file");
    });
  });

  it("validates edit text-source errors (multiple sources, missing file, blank file)", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "comments-edit-source-errors");
      await runComments(id, { add: "seed" }, { path: context.pmPath });

      await expect(runComments(id, { edit: 1, add: "a", stdin: true }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: "Specify comment text using only one input source: --add, --stdin, or --file",
      });
      await expect(
        runComments(id, { edit: 1, file: path.join(context.pmPath, "nope.md") }, { path: context.pmPath }),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining("--file path not found"),
      });
      await expect(runComments(id, { edit: 1, file: "   " }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: "--file path cannot be empty",
      });
      await expect(runComments(id, { edit: 1, file: context.pmPath }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining("Failed to read --file path"),
      });
    });
  });

  it("honors ownership rules for edit/delete: blocked without bypass, allowed with --allow-audit-comment", async () => {
    await withTempPmPath(async (context) => {
      setGovernancePreset(context, "strict");
      const id = createTask(context, "comments-edit-ownership");
      await runComments(id, { add: "owner comment", author: "owner-a" }, { path: context.pmPath });
      const assigned = context.runCli(
        ["update", id, "--assignee", "owner-a", "--author", "owner-a", "--message", "assign owner", "--json"],
        { expectJson: true },
      );
      expect(assigned.code).toBe(0);

      await expect(runComments(id, { edit: 1, add: "hijack", author: "owner-b" }, { path: context.pmPath })).rejects.toMatchObject<
        PmCliError
      >({
        exitCode: EXIT_CODE.CONFLICT,
        context: expect.objectContaining({ code: "ownership_conflict" }),
      });

      const edited = await runComments(
        id,
        { edit: 1, add: "audited fix", author: "owner-b", allowAuditComment: true },
        { path: context.pmPath },
      );
      expect(edited.comments[0].text).toBe("audited fix");

      const deleted = await runComments(
        id,
        { delete: 1, author: "owner-b", allowAuditComment: true },
        { path: context.pmPath },
      );
      expect(deleted.comments).toHaveLength(0);
    });
  });

  it("falls back to the base op when editOp/deleteOp are not configured", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "comments-op-fallback");
      await runComments(id, { add: "original" }, { path: context.pmPath });

      type CommentEntry = { created_at: string; author: string; text: string };
      const baseConfig = {
        collectionKey: "comments" as const,
        op: "comment_add" as const,
        parseText: (raw: string) => raw,
        allowAuditBypass: false,
        conflictGuidance: { required: "required", examples: [], nextSteps: [] },
      };

      const edited = await runAnnotationCommand<"comments", CommentEntry>(
        id,
        {},
        { path: context.pmPath },
        { ...baseConfig, input: { mode: "edit", index: 1, value: "edited via base op" } },
      );
      expect(edited.comments[0].text).toBe("edited via base op");

      const deleted = await runAnnotationCommand<"comments", CommentEntry>(
        id,
        {},
        { path: context.pmPath },
        { ...baseConfig, input: { mode: "delete", index: 1 } },
      );
      expect(deleted.comments).toHaveLength(0);
    });
  });

  it("exposes --edit/--delete through the comments command registration", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "comments-cli-edit-delete");
      context.runCli(["comments", id, "first", "--json"], { expectJson: true });
      context.runCli(["comments", id, "second", "--json"], { expectJson: true });

      const edited = context.runCli(["comments", id, "--edit", "2", "second-fixed", "--json"], { expectJson: true });
      expect(edited.code).toBe(0);
      expect((edited.json as { comments: Array<{ text: string }> }).comments[1].text).toBe("second-fixed");

      const deleted = context.runCli(["comments", id, "--delete", "1", "--json"], { expectJson: true });
      expect(deleted.code).toBe(0);
      expect((deleted.json as { comments: Array<{ text: string }> }).comments.map((entry) => entry.text)).toEqual(["second-fixed"]);

      const badIndex = context.runCli(["comments", id, "--delete", "0"]);
      expect(badIndex.code).toBe(EXIT_CODE.USAGE);
    });
  });
});
