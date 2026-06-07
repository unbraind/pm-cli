import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { _testOnly } from "../../src/cli/main.js";
import { EXIT_CODE } from "../../src/core/shared/constants.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

describe("CLI main error helpers", () => {
  it("only treats Commander-owned codes as Commander errors", () => {
    expect(_testOnly.isCommanderError({ code: "commander.unknownOption" })).toBe(true);
    expect(_testOnly.isCommanderError({ code: "ENOENT", exitCode: EXIT_CODE.NOT_FOUND })).toBe(false);
    expect(_testOnly.isCommanderError(new Error("plain"))).toBe(false);
  });

  it("normalizes invalid thrown exit codes to generic failure instead of success", () => {
    expect(_testOnly.normalizeThrownExitCode(EXIT_CODE.USAGE)).toBe(EXIT_CODE.USAGE);
    expect(_testOnly.normalizeThrownExitCode(0)).toBe(EXIT_CODE.GENERIC_FAILURE);
    expect(_testOnly.normalizeThrownExitCode(-1)).toBe(EXIT_CODE.GENERIC_FAILURE);
  });

  it("preserves non-Error thrown exit codes for Sentry filtering", () => {
    const wrapped = _testOnly.wrapThrownErrorForSentry(
      { exitCode: EXIT_CODE.USAGE },
      "Calendar accepts at most one positional view",
    ) as Error & { exitCode?: number };

    expect(wrapped).toBeInstanceOf(Error);
    expect(wrapped.message).toBe("Calendar accepts at most one positional view");
    expect(wrapped.exitCode).toBe(EXIT_CODE.USAGE);
  });

  it("preserves command-specific fallback recovery while adding invocation context", () => {
    const context = _testOnly.buildPmCliRecoveryContext(
      {
        code: "npm_package_not_found",
        recovery: {
          attempted_command: "pm install --project npm:pm-brief",
          normalized_args: ["install", "--project", "npm:pm-brief"],
          fallback_candidates: [
            {
              source: "github.com/unbraind/pm-brief",
              command: "pm install --project github.com/unbraind/pm-brief",
              reason: "canonical first-party GitHub repository fallback",
            },
          ],
          next_best_command: "pm install --project github.com/unbraind/pm-brief",
        },
      },
      ["--json", "install", "npm:pm-brief", "--project"],
      "npm package \"pm-brief\" was not found in the registry.",
    );

    expect(context.recovery).toMatchObject({
      attempted_command: "pm install --project npm:pm-brief",
      normalized_args: ["install", "--project", "npm:pm-brief"],
      provided_fields: ["--json", "--project"],
      fallback_candidates: [
        {
          source: "github.com/unbraind/pm-brief",
          command: "pm install --project github.com/unbraind/pm-brief",
          reason: "canonical first-party GitHub repository fallback",
        },
      ],
      next_best_command: "pm install --project github.com/unbraind/pm-brief",
    });
  });

  it("keeps expected retry errors off the synchronous Sentry path by default", () => {
    const previous = process.env.PM_SENTRY_CAPTURE_EXPECTED_ERRORS;
    try {
      delete process.env.PM_SENTRY_CAPTURE_EXPECTED_ERRORS;
      expect(_testOnly.shouldLogHandledErrorToSentry(EXIT_CODE.USAGE)).toBe(false);
      expect(_testOnly.shouldLogHandledErrorToSentry(EXIT_CODE.NOT_FOUND)).toBe(false);
      expect(_testOnly.shouldLogHandledErrorToSentry(EXIT_CODE.CONFLICT)).toBe(false);
      expect(_testOnly.shouldLogHandledErrorToSentry(EXIT_CODE.GENERIC_FAILURE)).toBe(true);

      process.env.PM_SENTRY_CAPTURE_EXPECTED_ERRORS = "1";
      expect(_testOnly.shouldLogHandledErrorToSentry(EXIT_CODE.USAGE)).toBe(true);
    } finally {
      if (previous === undefined) {
        delete process.env.PM_SENTRY_CAPTURE_EXPECTED_ERRORS;
      } else {
        process.env.PM_SENTRY_CAPTURE_EXPECTED_ERRORS = previous;
      }
    }
  });
});

describe("CLI settings-read warning surfacing", () => {
  it("surfaces settings_read_invalid_schema on stderr while keeping stdout JSON clean", async () => {
    await withTempPmPath(async (context) => {
      const settingsPath = path.join(context.pmPath, "settings.json");
      await writeFile(
        settingsPath,
        `${JSON.stringify({ version: 1, id_prefix: 123, item_format: "toon" })}\n`,
        "utf8",
      );

      const result = context.runCli(["list", "--json"], { expectJson: true });
      expect(result.stderr).toContain("settings_read_invalid_schema");
      expect(result.stderr).toContain("run pm health for remediation");
      // stdout stays clean machine-readable JSON despite the stderr warning.
      expect(result.code).toBe(0);
      expect(result.stdout).not.toContain("settings_read_invalid_schema");
      expect(() => JSON.parse(result.stdout)).not.toThrow();
    });
  });

  it("surfaces settings_read_invalid_json on stderr when settings.json is not parseable", async () => {
    await withTempPmPath(async (context) => {
      const settingsPath = path.join(context.pmPath, "settings.json");
      await writeFile(settingsPath, '{ "version": 1, "id_prefix":', "utf8");

      const result = context.runCli(["list"]);
      expect(result.stderr).toContain("settings_read_invalid_json");
      expect(result.stderr).toContain("run pm health for remediation");
      expect(result.stdout).not.toContain("settings_read_invalid_json");
    });
  });

  it("surfaces the warning even with --no-extensions (the common safe mode)", async () => {
    await withTempPmPath(async (context) => {
      const settingsPath = path.join(context.pmPath, "settings.json");
      await writeFile(
        settingsPath,
        `${JSON.stringify({ version: 1, id_prefix: 123, item_format: "toon" })}\n`,
        "utf8",
      );

      const result = context.runCli(["--no-extensions", "list", "--json"], { expectJson: true });
      expect(result.stderr).toContain("settings_read_invalid_schema");
      expect(result.code).toBe(0);
      expect(() => JSON.parse(result.stdout)).not.toThrow();
    });
  });
});
