import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runLearnings } from "../../src/cli/commands/learnings.js";
import { runNotes } from "../../src/cli/commands/notes.js";
import { EXIT_CODE } from "../../src/constants.js";
import { PmCliError } from "../../src/errors.js";
import { withTempPmPath, type TempPmContext } from "../helpers/withTempPmPath.js";

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

function createTask(context: TempPmContext, title: string): string {
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
      "open",
      "--priority",
      "1",
      "--tags",
      "notes-learnings,unit",
      "--body",
      "",
      "--deadline",
      "none",
      "--estimate",
      "10",
      "--acceptance-criteria",
      `${title} acceptance`,
      "--author",
      "seed-author",
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
  expect(created.code).toBe(0);
  return (created.json as { item: { id: string } }).item.id;
}

function extractEntries(target: LogCommandTarget, result: unknown): Array<{ text: string; author: string }> {
  const record = result as Record<string, unknown>;
  const entries = record[target.name] as Array<{ text: string; author: string }>;
  return entries;
}

describe.each(TARGETS)("run%s", (target) => {
  it("fails when tracker is not initialized", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), `pm-${target.name}-not-init-`));
    try {
      await expect(target.run("pm-missing", {}, { path: tempDir })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
      await expect(target.run("pm-missing", { add: "entry text" }, { path: tempDir })).rejects.toMatchObject<PmCliError>({
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

      await expect(target.run("pm-does-not-exist", {}, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.NOT_FOUND,
      });

      await target.run(id, { add: "first entry", author: "first-author" }, { path: context.pmPath });
      await target.run(id, { add: "second entry" }, { path: context.pmPath });
      await target.run(id, { add: "third entry" }, { path: context.pmPath });

      const all = await target.run(id, {}, { path: context.pmPath });
      expect(all.count).toBe(3);
      expect(extractEntries(target, all).map((entry) => entry.text)).toEqual(["first entry", "second entry", "third entry"]);

      const limited = await target.run(id, { limit: "2" }, { path: context.pmPath });
      expect(limited.count).toBe(2);
      expect(extractEntries(target, limited).map((entry) => entry.text)).toEqual(["second entry", "third entry"]);

      const floored = await target.run(id, { limit: "1.9" }, { path: context.pmPath });
      expect(floored.count).toBe(1);
      expect(extractEntries(target, floored)[0]?.text).toBe("third entry");

      const zero = await target.run(id, { limit: "0" }, { path: context.pmPath });
      expect(zero.count).toBe(0);
      expect(extractEntries(target, zero)).toEqual([]);

      await expect(target.run(id, { limit: "-1" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(target.run(id, { limit: "not-a-number" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
    });
  });

  it("rejects empty entry text", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, `${target.name}-empty`);
      await expect(target.run(id, { add: "   " }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
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
      expect(extractEntries(target, explicit).at(-1)?.author).toBe("explicit-author");

      const envId = createTask(context, `${target.name}-env-author`);
      const envResult = await target.run(envId, { add: "env author entry" }, { path: context.pmPath });
      expect(extractEntries(target, envResult).at(-1)?.author).toBe("test-author");

      const previousPmAuthor = process.env.PM_AUTHOR;
      delete process.env.PM_AUTHOR;
      try {
        const settingsPath = path.join(context.pmPath, "settings.json");
        const settings = JSON.parse(await readFile(settingsPath, "utf8")) as { author_default?: string };
        settings.author_default = "settings-author";
        await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

        const settingsId = createTask(context, `${target.name}-settings-author`);
        const settingsResult = await target.run(settingsId, { add: "settings author entry" }, { path: context.pmPath });
        expect(extractEntries(target, settingsResult).at(-1)?.author).toBe("settings-author");

        const unknownId = createTask(context, `${target.name}-unknown-author`);
        const unknownResult = await target.run(
          unknownId,
          {
            add: "unknown author entry",
            author: "   ",
          },
          { path: context.pmPath },
        );
        expect(extractEntries(target, unknownResult).at(-1)?.author).toBe("unknown");
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
      const structured = await target.run(id, { add: "text: markdown entry body" }, { path: context.pmPath });
      expect(extractEntries(target, structured).at(-1)?.text).toBe("markdown entry body");

      const fenced = ["```", "text: fenced body", "```"].join("\n");
      const fencedResult = await target.run(id, { add: fenced }, { path: context.pmPath });
      expect(extractEntries(target, fencedResult).at(-1)?.text).toBe("fenced body");

      const malformed = ["```", "not structured", "```"].join("\n");
      const malformedResult = await target.run(id, { add: malformed }, { path: context.pmPath });
      expect(extractEntries(target, malformedResult).at(-1)?.text).toBe(malformed);
    });
  });

  it("accepts stdin token for add payload", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, `${target.name}-stdin-token`);
      const stdin = new PassThrough();
      stdin.end("text: from stdin\n");
      Object.defineProperty(stdin, "isTTY", { value: false, configurable: true });
      vi.spyOn(process, "stdin", "get").mockReturnValue(stdin as unknown as NodeJS.ReadStream);

      const result = await target.run(id, { add: "-" }, { path: context.pmPath });
      expect(extractEntries(target, result).at(-1)?.text).toBe("from stdin");
    });
  });
});
