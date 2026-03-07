import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runClose } from "../../src/cli/commands/close.js";
import { EXIT_CODE } from "../../src/constants.js";
import { PmCliError } from "../../src/errors.js";
import { withTempPmPath, type TempPmContext } from "../helpers/withTempPmPath.js";

interface CreateTaskOptions {
  status?: "draft" | "open" | "in_progress" | "blocked" | "closed" | "canceled";
  assignee?: string;
}

function createTask(context: TempPmContext, title: string, options: CreateTaskOptions = {}): string {
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
      options.status ?? "open",
      "--priority",
      "1",
      "--tags",
      "close,unit",
      "--body",
      "",
      "--deadline",
      "none",
      "--estimate",
      "20",
      "--acceptance-criteria",
      `${title} acceptance`,
      "--author",
      "seed-author",
      "--message",
      `Create ${title}`,
      "--assignee",
      options.assignee ?? "none",
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

function latestCloseAuthor(context: TempPmContext, id: string): string | undefined {
  const history = context.runCli(["history", id, "--json"], { expectJson: true });
  expect(history.code).toBe(0);
  const entries = (history.json as { history: Array<{ op: string; author: string }> }).history;
  return [...entries].reverse().find((entry) => entry.op === "close")?.author;
}

describe("runClose", () => {
  it("fails when tracker is not initialized", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pm-close-not-init-"));
    try {
      await expect(runClose("pm-missing", "done", {}, { path: tempDir })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("closes assigned active items and clears assignment", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "close-assigned-item", {
        status: "in_progress",
        assignee: "explicit-author",
      });

      const result = await runClose(
        id,
        "Implementation finished",
        {
          author: " explicit-author ",
          message: "Close assigned item",
        },
        { path: context.pmPath },
      );

      expect(result.warnings).toEqual([]);
      expect(result.changed_fields).toEqual(expect.arrayContaining(["status", "close_reason", "assignee"]));
      const item = result.item as Record<string, unknown>;
      expect(item.status).toBe("closed");
      expect(item.close_reason).toBe("Implementation finished");
      expect(item.assignee).toBeUndefined();
      expect(latestCloseAuthor(context, id)).toBe("explicit-author");
    });
  });

  it("closes unassigned active items without assignee changed field", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "close-unassigned-item");
      const result = await runClose(
        id,
        "No assignee to clear",
        {
          message: "Close unassigned item",
        },
        { path: context.pmPath },
      );

      expect(result.changed_fields).toEqual(expect.arrayContaining(["status", "close_reason"]));
      expect(result.changed_fields).not.toContain("assignee");
      const item = result.item as Record<string, unknown>;
      expect(item.status).toBe("closed");
      expect(item.close_reason).toBe("No assignee to clear");
      expect(item.assignee).toBeUndefined();
    });
  });

  it("rejects blank close reason text", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "close-blank-reason");
      await expect(runClose(id, "   ", {}, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
    });
  });

  it("uses settings author fallback when option and PM_AUTHOR are unset", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "close-settings-author");
      const previousPmAuthor = process.env.PM_AUTHOR;
      delete process.env.PM_AUTHOR;

      try {
        const settingsPath = path.join(context.pmPath, "settings.json");
        const settings = JSON.parse(await readFile(settingsPath, "utf8")) as { author_default?: string };
        settings.author_default = "settings-author";
        await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

        const result = await runClose(
          id,
          "close using settings author fallback",
          {
            message: "Close with settings fallback author",
          },
          { path: context.pmPath },
        );

        const item = result.item as Record<string, unknown>;
        expect(item.status).toBe("closed");
        expect(item.close_reason).toBe("close using settings author fallback");
        expect(latestCloseAuthor(context, id)).toBe("settings-author");
      } finally {
        if (previousPmAuthor === undefined) {
          delete process.env.PM_AUTHOR;
        } else {
          process.env.PM_AUTHOR = previousPmAuthor;
        }
      }
    });
  });

  it("rejects terminal items unless forced and supports unknown author fallback", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "close-terminal-item", { status: "closed" });
      await expect(runClose(id, "already terminal", {}, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.CONFLICT,
      });

      const previousPmAuthor = process.env.PM_AUTHOR;
      delete process.env.PM_AUTHOR;

      try {
        const settingsPath = path.join(context.pmPath, "settings.json");
        const settings = JSON.parse(await readFile(settingsPath, "utf8")) as { author_default?: string };
        settings.author_default = "   ";
        await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

        const forced = await runClose(
          id,
          "forced terminal close",
          {
            author: "   ",
            message: "force close",
            force: true,
          },
          { path: context.pmPath },
        );

        const item = forced.item as Record<string, unknown>;
        expect(item.status).toBe("closed");
        expect(item.close_reason).toBe("forced terminal close");
        expect(latestCloseAuthor(context, id)).toBe("unknown");
      } finally {
        if (previousPmAuthor === undefined) {
          delete process.env.PM_AUTHOR;
        } else {
          process.env.PM_AUTHOR = previousPmAuthor;
        }
      }
    });
  });
});
