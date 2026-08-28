import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type * as NodeFsPromises from "node:fs/promises";
import type * as ItemParseModule from "../../../src/core/item/parse.js";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runLearnings } from "../../../src/cli/commands/learnings.js";
import { runNotes } from "../../../src/cli/commands/notes.js";
import { EXIT_CODE } from "../../../src/core/shared/constants.js";
import { PmCliError } from "../../../src/core/shared/errors.js";
import {
  isErrnoError,
  resolveAnnotationInput,
} from "../../../src/sdk/annotations.js";
import { createTestItemId } from "../../helpers/itemFactory.js";
import {
  withTempPmPath,
  type TempPmContext,
} from "../../helpers/withTempPmPath.js";

afterEach(() => {
  vi.restoreAllMocks();
});

type LogCommandTarget = {
  name: "notes" | "learnings";
  run: typeof runNotes | typeof runLearnings;
};

const TARGETS: LogCommandTarget[] = [
  {
    name: "notes",
    run: runNotes,
  },
  {
    name: "learnings",
    run: runLearnings,
  },
];

describe("annotation source resolution", () => {
  it("validates edit and delete indices before reading replacement sources", async () => {
    for (const index of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(
        resolveAnnotationInput({ edit: index, add: "replacement" }, "note"),
      ).rejects.toThrow("--edit must be a positive integer");
      await expect(
        resolveAnnotationInput({ delete: index }, "note"),
      ).rejects.toThrow("--delete must be a positive integer");
    }
  });

  it("rejects mutually exclusive operations and text sources without consuming stdin", async () => {
    await expect(
      resolveAnnotationInput({ edit: 1, delete: 1 }, "note"),
    ).rejects.toThrow("Specify only one of --edit or --delete");
    await expect(
      resolveAnnotationInput({ delete: 1, stdin: true }, "note"),
    ).rejects.toThrow("--delete cannot be combined with replacement text");
    await expect(
      resolveAnnotationInput({ add: "inline", file: "entry.md" }, "note"),
    ).rejects.toThrow("using only one input source");
  });

  it("classifies errno-shaped failures without assuming every object is an errno", () => {
    expect(isErrnoError({ code: "ENOENT" })).toBe(true);
    expect(isErrnoError(new Error("plain failure"))).toBe(false);
    expect(isErrnoError(null)).toBe(false);
  });

  it("reports blank, missing, and unreadable annotation file sources", async () => {
    const tempDir = await mkdtemp(
      path.join(os.tmpdir(), "pm-annotation-source-"),
    );
    try {
      await expect(
        resolveAnnotationInput({ file: "   " }, "note"),
      ).rejects.toThrow("--file path cannot be empty");
      await expect(
        resolveAnnotationInput(
          { file: path.join(tempDir, "missing.md") },
          "note",
        ),
      ).rejects.toThrow("--file path not found");
      await expect(
        resolveAnnotationInput({ file: tempDir }, "note"),
      ).rejects.toThrow("Failed to read --file path");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("stringifies non-Error annotation file read failures", async () => {
    await vi.resetModules();
    vi.doMock("node:fs/promises", async (importOriginal) => ({
      ...(await importOriginal<typeof NodeFsPromises>()),
      readFile: vi.fn(async () => {
        throw "annotation-read-failure";
      }),
    }));
    const { resolveAnnotationInput: resolveMockedAnnotationInput } =
      await import("../../../src/sdk/annotations.js");
    await expect(
      resolveMockedAnnotationInput({ file: "entry.md" }, "note"),
    ).rejects.toThrow(
      'Failed to read --file path "entry.md": annotation-read-failure',
    );
    vi.doUnmock("node:fs/promises");
    await vi.resetModules();
  });

  it("normalizes nullish annotation stdin resolver values", async () => {
    await vi.resetModules();
    vi.doMock("../../../src/core/item/parse.js", async (importOriginal) => ({
      ...(await importOriginal<typeof ItemParseModule>()),
      createStdinTokenResolver: () => ({
        resolveValue: vi.fn(async () => undefined),
      }),
    }));
    const { resolveAnnotationInput: resolveMockedAnnotationInput } =
      await import("../../../src/sdk/annotations.js");
    await expect(
      resolveMockedAnnotationInput({ add: "-" }, "note"),
    ).resolves.toMatchObject({
      mode: "add",
      value: "",
    });
    await expect(
      resolveMockedAnnotationInput({ stdin: true }, "note"),
    ).resolves.toMatchObject({
      mode: "add",
      value: "",
    });
    await expect(
      resolveMockedAnnotationInput({ file: "-" }, "note"),
    ).resolves.toMatchObject({
      mode: "add",
      value: "",
    });
    vi.doUnmock("../../../src/core/item/parse.js");
    await vi.resetModules();
  });
});

function createTask(context: TempPmContext, title: string): string {
  return createTestItemId(context, {
    title,
    tags: "notes-learnings,unit",
    estimate: "10",
  });
}

function setGovernancePreset(
  context: TempPmContext,
  preset: "minimal" | "default" | "strict",
): void {
  const result = context.runCli(
    [
      "config",
      "project",
      "set",
      "governance-preset",
      "--policy",
      preset,
      "--json",
    ],
    {
      expectJson: true,
    },
  );
  expect(result.code).toBe(0);
}

function extractEntries(
  target: LogCommandTarget,
  result: unknown,
): Array<{ text: string; author: string }> {
  const record = result as Record<string, unknown>;
  const entries = record[target.name] as Array<{
    text: string;
    author: string;
  }>;
  return entries;
}

describe.each(TARGETS)("run%s", (target) => {
  it("fails when tracker is not initialized", async () => {
    const tempDir = await mkdtemp(
      path.join(os.tmpdir(), `pm-${target.name}-not-init-`),
    );
    try {
      await expect(
        target.run("pm-missing", {}, { path: tempDir }),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
      await expect(
        target.run("pm-missing", { add: "entry text" }, { path: tempDir }),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("lists entries, enforces limit semantics, and validates limit inputs", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, `${target.name}-limit`);

      const empty = await target.run(id, {}, { path: context.pmPath });
      expect(empty.count).toBe(0);
      expect(extractEntries(target, empty)).toEqual([]);

      await expect(
        target.run("pm-does-not-exist", {}, { path: context.pmPath }),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.NOT_FOUND,
      });

      await target.run(
        id,
        { add: "first entry", author: "first-author" },
        { path: context.pmPath },
      );
      await target.run(id, { add: "second entry" }, { path: context.pmPath });
      await target.run(id, { add: "third entry" }, { path: context.pmPath });

      const all = await target.run(id, {}, { path: context.pmPath });
      expect(all.count).toBe(3);
      expect(extractEntries(target, all).map((entry) => entry.text)).toEqual([
        "first entry",
        "second entry",
        "third entry",
      ]);

      const limited = await target.run(
        id,
        { limit: "2" },
        { path: context.pmPath },
      );
      expect(limited.count).toBe(2);
      expect(
        extractEntries(target, limited).map((entry) => entry.text),
      ).toEqual(["second entry", "third entry"]);

      const floored = await target.run(
        id,
        { limit: "1.9" },
        { path: context.pmPath },
      );
      expect(floored.count).toBe(1);
      expect(extractEntries(target, floored)[0]?.text).toBe("third entry");

      const zero = await target.run(
        id,
        { limit: "0" },
        { path: context.pmPath },
      );
      expect(zero.count).toBe(0);
      expect(extractEntries(target, zero)).toEqual([]);

      await expect(
        target.run(id, { limit: "-1" }, { path: context.pmPath }),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(
        target.run(id, { limit: "not-a-number" }, { path: context.pmPath }),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
    });
  });

  it("rejects empty entry text", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, `${target.name}-empty`);
      await expect(
        target.run(id, { add: "   " }, { path: context.pmPath }),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
    });
  });

  it("makes exact append retries idempotent without suppressing intentional duplicates", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, `${target.name}-if-absent`);
      const historyPath = path.join(context.pmPath, "history", `${id}.jsonl`);
      const added = await target.run(
        id,
        { add: " retry-safe context ", author: " agent-a ", ifAbsent: true },
        { path: context.pmPath },
      );
      expect(added).toMatchObject({
        changed: true,
        total_count: 1,
        mutation_receipt: { entry_index: 1, changed_count: 1 },
      });
      const historyAfterAdd = await readFile(historyPath, "utf8");

      const retried = await target.run(
        id,
        { add: "text=retry-safe context", author: "agent-a", ifAbsent: true },
        { path: context.pmPath },
      );
      expect(retried).toMatchObject({
        changed: false,
        total_count: 1,
        mutation_receipt: { entry_index: 1, changed_count: 0 },
      });
      expect(await readFile(historyPath, "utf8")).toBe(historyAfterAdd);

      const intentionalDuplicate = await target.run(
        id,
        { add: "retry-safe context", author: "agent-a" },
        { path: context.pmPath },
      );
      expect(intentionalDuplicate).toMatchObject({ total_count: 2 });
      expect(intentionalDuplicate).not.toHaveProperty("changed");
    });
  });

  it("serializes concurrent exact append retries under the item writer lock", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, `${target.name}-if-absent-concurrent`);
      const historyPath = path.join(context.pmPath, "history", `${id}.jsonl`);
      let releaseBarrier: (() => void) | undefined;
      const barrier = new Promise<void>((resolve) => {
        releaseBarrier = resolve;
      });
      const attempts = Array.from({ length: 2 }, async () => {
        await barrier;
        return target.run(
          id,
          {
            add: " one concurrent retry-safe entry ",
            author: " parallel-agent ",
            ifAbsent: true,
          },
          { path: context.pmPath },
        );
      });

      expect(releaseBarrier).toBeTypeOf("function");
      releaseBarrier?.();
      const results = await Promise.all(attempts);

      expect(results.filter((result) => result.changed === true)).toHaveLength(
        1,
      );
      expect(
        results.filter((result) => result.changed === false),
      ).toHaveLength(1);
      expect(
        extractEntries(
          target,
          await target.run(id, { fullHistory: true }, { path: context.pmPath }),
        ),
      ).toHaveLength(1);
      const historyEvents = (await readFile(historyPath, "utf8"))
        .trim()
        .split("\n")
        .map(
          (line) => JSON.parse(line) as unknown as { op?: unknown },
        );
      expect(
        historyEvents.filter(
          ({ op }) =>
            op === (target.name === "notes" ? "note_add" : "learning_add"),
        ),
      ).toHaveLength(1);
    });
  });

  it("exposes retry-safe appends through the CLI transport", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, `${target.name}-cli-if-absent`);
      const args = [
        target.name,
        id,
        "retry-safe CLI context",
        "--author",
        "cli-agent",
        "--if-absent",
        "--json",
      ];
      expect(context.runCli(args, { expectJson: true }).json).toMatchObject({
        changed: true,
        mutation_receipt: { changed_count: 1 },
      });
      expect(context.runCli(args, { expectJson: true }).json).toMatchObject({
        changed: false,
        mutation_receipt: { changed_count: 0 },
      });
    });
  });

  it("resolves author from explicit input, env fallback, settings fallback, and unknown fallback", async () => {
    await withTempPmPath(async (context) => {
      const explicitId = createTask(context, `${target.name}-explicit-author`);
      const explicit = await target.run(
        explicitId,
        {
          add: "explicit author entry",
          author: " explicit-author ",
          message: "add explicit author entry",
        },
        { path: context.pmPath },
      );
      expect(extractEntries(target, explicit).at(-1)?.author).toBe(
        "explicit-author",
      );

      const envId = createTask(context, `${target.name}-env-author`);
      const envResult = await target.run(
        envId,
        { add: "env author entry" },
        { path: context.pmPath },
      );
      expect(extractEntries(target, envResult).at(-1)?.author).toBe(
        "test-author",
      );

      const previousPmAuthor = process.env.PM_AUTHOR;
      delete process.env.PM_AUTHOR;
      try {
        const settingsPath = path.join(context.pmPath, "settings.json");
        const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
          author_default?: string;
        };
        settings.author_default = "settings-author";
        await writeFile(
          settingsPath,
          `${JSON.stringify(settings, null, 2)}\n`,
          "utf8",
        );

        const settingsId = createTask(
          context,
          `${target.name}-settings-author`,
        );
        const settingsResult = await target.run(
          settingsId,
          { add: "settings author entry" },
          { path: context.pmPath },
        );
        expect(extractEntries(target, settingsResult).at(-1)?.author).toBe(
          "settings-author",
        );

        const unknownId = createTask(context, `${target.name}-unknown-author`);
        const unknownResult = await target.run(
          unknownId,
          {
            add: "unknown author entry",
            author: "   ",
          },
          { path: context.pmPath },
        );
        expect(extractEntries(target, unknownResult).at(-1)?.author).toBe(
          "unknown",
        );
      } finally {
        if (previousPmAuthor === undefined) {
          delete process.env.PM_AUTHOR;
        } else {
          process.env.PM_AUTHOR = previousPmAuthor;
        }
      }
    });
  });

  it("accepts text= and markdown payload forms", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, `${target.name}-structured-input`);
      const structured = await target.run(
        id,
        { add: "text: markdown entry body" },
        { path: context.pmPath },
      );
      expect(extractEntries(target, structured).at(-1)?.text).toBe(
        "markdown entry body",
      );

      const ambiguousCsvLike = "text=hello,scope:project";
      const ambiguousResult = await target.run(
        id,
        { add: ambiguousCsvLike },
        { path: context.pmPath },
      );
      expect(extractEntries(target, ambiguousResult).at(-1)?.text).toBe(
        ambiguousCsvLike,
      );

      const fenced = ["```", "text: fenced body", "```"].join("\n");
      const fencedResult = await target.run(
        id,
        { add: fenced },
        { path: context.pmPath },
      );
      expect(extractEntries(target, fencedResult).at(-1)?.text).toBe(
        "fenced body",
      );

      const malformed = ["```", "not structured", "```"].join("\n");
      const malformedResult = await target.run(
        id,
        { add: malformed },
        { path: context.pmPath },
      );
      expect(extractEntries(target, malformedResult).at(-1)?.text).toBe(
        malformed,
      );
    });
  });

  it("supports append-only audit bypass on assignee conflicts", async () => {
    await withTempPmPath(async (context) => {
      setGovernancePreset(context, "strict");
      const id = createTask(context, `${target.name}-assignee-conflict`);
      const claim = context.runCli(
        [
          "claim",
          id,
          "--author",
          "owner-a",
          "--message",
          "claim for ownership test",
          "--json",
        ],
        {
          expectJson: true,
        },
      );
      expect(claim.code).toBe(0);

      await expect(
        target.run(
          id,
          {
            add: "blocked append",
            author: "owner-b",
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.CONFLICT,
      });

      const bypassed = await target.run(
        id,
        {
          add: "audit append",
          author: "owner-b",
          ownershipAppendBypass: true,
        },
        { path: context.pmPath },
      );
      expect(extractEntries(target, bypassed).at(-1)?.text).toBe(
        "audit append",
      );
      expect(extractEntries(target, bypassed).at(-1)?.author).toBe("owner-b");
    });
  });

  it("accepts stdin token for add payload", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, `${target.name}-stdin-token`);
      const stdin = new PassThrough();
      stdin.end("text: from stdin\n");
      Object.defineProperty(stdin, "isTTY", {
        value: false,
        configurable: true,
      });
      vi.spyOn(process, "stdin", "get").mockReturnValue(
        stdin as unknown as NodeJS.ReadStream,
      );

      const result = await target.run(
        id,
        { add: "-" },
        { path: context.pmPath },
      );
      expect(extractEntries(target, result).at(-1)?.text).toBe("from stdin");

      const flagShapedStdin = new PassThrough();
      flagShapedStdin.end("--some-option\n");
      Object.defineProperty(flagShapedStdin, "isTTY", {
        value: false,
        configurable: true,
      });
      vi.spyOn(process, "stdin", "get").mockReturnValue(
        flagShapedStdin as unknown as NodeJS.ReadStream,
      );

      const flagShapedResult = await target.run(
        id,
        { add: "-" },
        { path: context.pmPath },
      );
      expect(extractEntries(target, flagShapedResult).at(-1)?.text).toBe(
        "--some-option",
      );
    });
  });

  it("adds from explicit stdin and files, then edits and deletes with history-safe indices", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, `${target.name}-repair-parity`);
      const stdin = new PassThrough();
      stdin.end("entry from explicit stdin\n");
      Object.defineProperty(stdin, "isTTY", {
        value: false,
        configurable: true,
      });
      vi.spyOn(process, "stdin", "get").mockReturnValue(
        stdin as unknown as NodeJS.ReadStream,
      );
      await target.run(id, { stdin: true }, { path: context.pmPath });

      const filePath = path.join(context.pmPath, `${target.name}.md`);
      await writeFile(filePath, "entry from file\n", "utf8");
      await target.run(id, { file: filePath }, { path: context.pmPath });
      const edited = await target.run(
        id,
        { edit: 1, add: "corrected entry", message: "repair annotation" },
        { path: context.pmPath },
      );
      expect(extractEntries(target, edited)[0]).toMatchObject({
        text: "corrected entry",
      });
      expect(extractEntries(target, edited)[0]).toHaveProperty("edited_at");

      const deleted = await target.run(
        id,
        { delete: 2, fullHistory: true },
        { path: context.pmPath },
      );
      expect(
        extractEntries(target, deleted).map((entry) => entry.text),
      ).toEqual(["corrected entry"]);

      await expect(
        target.run(id, { edit: 1 }, { path: context.pmPath }),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining("--edit requires replacement text"),
      });
      await expect(
        target.run(id, { delete: 1, add: "invalid" }, { path: context.pmPath }),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining("--delete cannot be combined"),
      });
    });
  });

  it("rejects flag-like --add values before they become stored annotation text", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, `${target.name}-flag-like-add`);
      const badToken = target.name === "notes" ? "--stdin" : "--file";

      await expect(
        target.run(id, { add: badToken }, { path: context.pmPath }),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining(
          `--add value "${badToken}" looks like an option`,
        ),
        context: expect.objectContaining({
          code: "annotation_flag_like_value",
          required: expect.stringContaining("--add -"),
        }),
      });

      const literal = await target.run(
        id,
        { add: `text=${badToken}` },
        { path: context.pmPath },
      );
      expect(extractEntries(target, literal).at(-1)?.text).toBe(badToken);
    });
  });
});

describe("command-specific audit aliases", () => {
  it("allows note append audits with ownershipAppendBypass", async () => {
    await withTempPmPath(async (context) => {
      setGovernancePreset(context, "strict");
      const id = createTask(context, "notes-audit-alias");
      const claim = context.runCli(
        [
          "claim",
          id,
          "--author",
          "owner-a",
          "--message",
          "claim for audit alias",
          "--json",
        ],
        {
          expectJson: true,
        },
      );
      expect(claim.code).toBe(0);

      await expect(
        runNotes(
          id,
          { add: "blocked note", author: "owner-b" },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.CONFLICT,
      });

      const allowed = await runNotes(
        id,
        {
          add: "allowed note",
          author: "owner-b",
          ownershipAppendBypass: true,
        },
        { path: context.pmPath },
      );
      expect(allowed.notes.at(-1)).toMatchObject({
        text: "allowed note",
        author: "owner-b",
      });
    });
  });

  it("allows learning append audits with ownershipAppendBypass", async () => {
    await withTempPmPath(async (context) => {
      setGovernancePreset(context, "strict");
      const id = createTask(context, "learnings-audit-alias");
      const claim = context.runCli(
        [
          "claim",
          id,
          "--author",
          "owner-a",
          "--message",
          "claim for audit alias",
          "--json",
        ],
        {
          expectJson: true,
        },
      );
      expect(claim.code).toBe(0);

      await expect(
        runLearnings(
          id,
          { add: "blocked learning", author: "owner-b" },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.CONFLICT,
      });

      const allowed = await runLearnings(
        id,
        {
          add: "allowed learning",
          author: "owner-b",
          ownershipAppendBypass: true,
        },
        { path: context.pmPath },
      );
      expect(allowed.learnings.at(-1)).toMatchObject({
        text: "allowed learning",
        author: "owner-b",
      });
    });
  });
});

describe("structured note context events", () => {
  it("appends canonical JSON while preserving typed data and bounded metadata", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "structured-note-events");
      await runNotes(id, { add: "ordinary note" }, { path: context.pmPath });
      await runNotes(
        id,
        { addJson: '{"type":"step.completed","step":2,"ok":true}' },
        { path: context.pmPath },
      );
      await runNotes(
        id,
        { addJson: '{"type":"step.completed","step":1}' },
        { path: context.pmPath },
      );
      await runNotes(
        id,
        { addJson: '{"type":42,"source":"untyped-event"}' },
        { path: context.pmPath },
      );

      const filtered = await runNotes(
        id,
        { eventType: " step.completed ", limit: "1", includeMeta: true },
        { path: context.pmPath },
      );
      expect(filtered).toMatchObject({
        count: 1,
        total_count: 2,
        returned_count: 1,
        has_more: true,
        limit: 1,
        structured_event_count: 1,
      });
      expect(filtered.notes[0]).toMatchObject({
        text: '{"step":1,"type":"step.completed"}',
        format: "json",
        data: { step: 1, type: "step.completed" },
        event_type: "step.completed",
      });

      const ordinaryProjection = await runNotes(
        id,
        { limit: "1", includeMeta: true },
        { path: context.pmPath },
      );
      expect(ordinaryProjection).toMatchObject({
        count: 1,
        total_count: 4,
        returned_count: 1,
        has_more: true,
        structured_event_count: 1,
      });
    });
  });

  it("filters structured events by timestamp and validates selectors", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "structured-note-time-filter");
      const appended = await runNotes(
        id,
        { addJson: '["context",1]' },
        { path: context.pmPath },
      );
      const createdAt = appended.notes[0]?.created_at ?? "";
      expect(
        await runNotes(id, { since: createdAt }, { path: context.pmPath }),
      ).toMatchObject({ count: 1, structured_event_count: 1 });
      expect(
        await runNotes(
          id,
          { since: "2999-01-01T00:00:00.000Z" },
          { path: context.pmPath },
        ),
      ).toMatchObject({ count: 0, total_count: 0 });
      await expect(
        runNotes(id, { since: "not-a-date" }, { path: context.pmPath }),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });
      await expect(
        runNotes(
          id,
          { add: "must not persist", since: "not-a-date" },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        context: { code: "structured_event_since_invalid" },
      });
      await expect(
        runNotes(
          id,
          {
            add: "must also not persist",
            eventType: "step.completed",
            limit: "not-a-number",
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });
      expect(await runNotes(id, {}, { path: context.pmPath })).toMatchObject({
        count: 1,
      });
      await expect(
        runNotes(id, { addJson: "not-json" }, { path: context.pmPath }),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });
      await expect(
        runNotes(id, { addJson: "   " }, { path: context.pmPath }),
      ).rejects.toMatchObject<PmCliError>({
        context: { code: "structured_event_json_empty" },
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(
        runNotes(
          id,
          { addJson: "null", add: "conflict" },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });
    });
  });

  it("rejects edits and deletes of append-only structured events", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "immutable-structured-note-event");
      await runNotes(
        id,
        { addJson: '{"type":"decision.recorded","value":1}' },
        { path: context.pmPath },
      );

      for (const mutation of [{ edit: 1, add: "replacement" }, { delete: 1 }]) {
        await expect(
          runNotes(id, mutation, { path: context.pmPath }),
        ).rejects.toMatchObject<PmCliError>({
          context: { code: "structured_event_immutable" },
          exitCode: EXIT_CODE.USAGE,
        });
      }

      expect(await runNotes(id, {}, { path: context.pmPath })).toMatchObject({
        count: 1,
        notes: [
          {
            data: { type: "decision.recorded", value: 1 },
            format: "json",
            text: '{"type":"decision.recorded","value":1}',
          },
        ],
      });
    });
  });
});
