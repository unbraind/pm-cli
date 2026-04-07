import os from "node:os";
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runStartBackgroundRun } from "../../src/cli/commands/test-runs.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

async function setSettingsAuthorDefault(pmPath: string, authorDefault: string): Promise<void> {
  const settingsPath = path.join(pmPath, "settings.json");
  const settings = JSON.parse(await readFile(settingsPath, "utf8")) as { author_default?: string };
  settings.author_default = authorDefault;
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

describe("test-runs command attribution fallback", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("falls back to USER when PM_AUTHOR and settings author_default are blank", async () => {
    await withTempPmPath(async (context) => {
      await setSettingsAuthorDefault(context.pmPath, "   ");
      const previousPmAuthor = process.env.PM_AUTHOR;
      const previousUser = process.env.USER;
      try {
        process.env.PM_AUTHOR = "   ";
        process.env.USER = "fallback-user";
        const started = await runStartBackgroundRun(
          {
            kind: "test",
            commandArgs: ["test-runs", "list", "--json"],
            noExtensions: true,
          },
          {
            path: context.pmPath,
            noExtensions: true,
          },
        );
        expect((started.run as { requested_by?: string }).requested_by).toBe("fallback-user");
      } finally {
        if (previousPmAuthor === undefined) {
          delete process.env.PM_AUTHOR;
        } else {
          process.env.PM_AUTHOR = previousPmAuthor;
        }
        if (previousUser === undefined) {
          delete process.env.USER;
        } else {
          process.env.USER = previousUser;
        }
      }
    });
  });

  it("falls back to os.userInfo username when env candidates are blank", async () => {
    await withTempPmPath(async (context) => {
      await setSettingsAuthorDefault(context.pmPath, " ");
      const userInfoSpy = vi.spyOn(os, "userInfo").mockReturnValue({
        uid: 1000,
        gid: 1000,
        username: "whoami-fallback",
        homedir: "/tmp",
        shell: "/bin/bash",
      });
      const previousPmAuthor = process.env.PM_AUTHOR;
      const previousUser = process.env.USER;
      const previousLogname = process.env.LOGNAME;
      const previousUsername = process.env.USERNAME;
      try {
        process.env.PM_AUTHOR = " ";
        process.env.USER = "";
        process.env.LOGNAME = "";
        process.env.USERNAME = "";
        const started = await runStartBackgroundRun(
          {
            kind: "test-all",
            commandArgs: ["test-runs", "list", "--json"],
            noExtensions: true,
          },
          {
            path: context.pmPath,
            noExtensions: true,
          },
        );
        expect((started.run as { requested_by?: string }).requested_by).toBe("whoami-fallback");
      } finally {
        userInfoSpy.mockRestore();
        if (previousPmAuthor === undefined) {
          delete process.env.PM_AUTHOR;
        } else {
          process.env.PM_AUTHOR = previousPmAuthor;
        }
        if (previousUser === undefined) {
          delete process.env.USER;
        } else {
          process.env.USER = previousUser;
        }
        if (previousLogname === undefined) {
          delete process.env.LOGNAME;
        } else {
          process.env.LOGNAME = previousLogname;
        }
        if (previousUsername === undefined) {
          delete process.env.USERNAME;
        } else {
          process.env.USERNAME = previousUsername;
        }
      }
    });
  });
});
