import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

import { _testOnly } from "../../src/cli/main.js";
import { setActiveCommandResult } from "../../src/core/extensions/index.js";
import { _testOnly as helpJsonTestOnly, maybeRenderBootstrapJsonHelp } from "../../src/cli/help-json-payload.js";
import {
  buildUnknownCommandGuidanceFromRuntime,
  collectRuntimeCommandPaths,
  formatCommanderUsageJson,
  formatCommanderUsageMessage,
  isKnownHelpCommandPath,
  resolveChildCommandByToken,
  resolveCommanderUsageContext,
  scoreCommandPathMatch,
} from "../../src/cli/commander-usage.js";
import {
  applyDynamicExtensionArguments,
  applyDynamicExtensionFlagOptions,
  buildDynamicExtensionCommandMetadataHelp,
  buildDynamicExtensionHelpOptionSummaries,
  collectDynamicExtensionFlagHelpByCommand,
  collectExtensionCommandHelpDescriptors,
  commandAliases,
  ensureCommandPath,
  findCommandByPath,
  findDirectChildCommand,
  mergeHelpOptionSummaries,
} from "../../src/cli/extension-command-help.js";
import { setActiveExtensionServices } from "../../src/core/extensions/index.js";
import {
  ROOT_HELP_BUNDLE,
  attachRichHelpText,
  normalizeHelpCommandPath,
  resolveHelpBundleForPath,
  resolveHelpDetailMode,
  resolveHelpNarrative,
} from "../../src/cli/help-content.js";
import { EXIT_CODE } from "../../src/core/shared/constants.js";
import { resolveItemTypeRegistry } from "../../src/core/item/type-registry.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

interface SourceCliRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function chunkToString(chunk: unknown, encoding?: BufferEncoding): string {
  if (typeof chunk === "string") {
    return chunk;
  }
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk).toString(encoding ?? "utf8");
  }
  if (chunk === undefined || chunk === null) {
    return "";
  }
  return String(chunk);
}

async function runSourceCli(args: string[], env: NodeJS.ProcessEnv): Promise<SourceCliRunResult> {
  const changedEnvKeys = new Set<string>();
  for (const key of Object.keys(env)) {
    if (env[key] !== process.env[key]) {
      changedEnvKeys.add(key);
    }
  }
  const previousEnv = new Map<string, string | undefined>();
  for (const key of changedEnvKeys) {
    previousEnv.set(key, process.env[key]);
  }

  const previousArgv = process.argv;
  const previousExitCode = process.exitCode;
  const previousStdoutWrite = process.stdout.write;
  const previousStderrWrite = process.stderr.write;
  let stdout = "";
  let stderr = "";

  try {
    for (const key of changedEnvKeys) {
      const value = env[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }

    process.argv = [process.execPath, path.resolve("src/cli.ts"), ...args];
    process.exitCode = undefined;
    (process.stdout as unknown as { write: typeof process.stdout.write }).write = ((chunk, encoding, callback) => {
      stdout += chunkToString(chunk, typeof encoding === "string" ? encoding : undefined);
      if (typeof encoding === "function") {
        encoding();
      } else if (typeof callback === "function") {
        callback();
      }
      return true;
    }) as typeof process.stdout.write;
    (process.stderr as unknown as { write: typeof process.stderr.write }).write = ((chunk, encoding, callback) => {
      stderr += chunkToString(chunk, typeof encoding === "string" ? encoding : undefined);
      if (typeof encoding === "function") {
        encoding();
      } else if (typeof callback === "function") {
        callback();
      }
      return true;
    }) as typeof process.stderr.write;

    const mainUrl = pathToFileURL(path.resolve("src/cli/main.ts"));
    mainUrl.search = `?sourceCli=${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const loaded = (await import(mainUrl.href)) as { runPmCli: (argv: string[]) => Promise<void> };
    await loaded.runPmCli(args);
    return {
      code: process.exitCode ?? EXIT_CODE.SUCCESS,
      stdout,
      stderr,
    };
  } finally {
    (process.stdout as unknown as { write: typeof process.stdout.write }).write = previousStdoutWrite;
    (process.stderr as unknown as { write: typeof process.stderr.write }).write = previousStderrWrite;
    process.argv = previousArgv;
    process.exitCode = previousExitCode;
    for (const key of changedEnvKeys) {
      const value = previousEnv.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

afterEach(() => {
  setActiveExtensionServices(null);
  setActiveCommandResult(undefined);
});

function captureStderrSync(run: () => void): string {
  const previousStderrWrite = process.stderr.write;
  let stderr = "";
  try {
    (process.stderr as unknown as { write: typeof process.stderr.write }).write = ((chunk, encoding, callback) => {
      stderr += chunkToString(chunk, typeof encoding === "string" ? encoding : undefined);
      if (typeof encoding === "function") {
        encoding();
      } else if (typeof callback === "function") {
        callback();
      }
      return true;
    }) as typeof process.stderr.write;
    run();
    return stderr;
  } finally {
    (process.stderr as unknown as { write: typeof process.stderr.write }).write = previousStderrWrite;
  }
}

describe("CLI main error helpers", () => {
  it("only treats Commander-owned codes as Commander errors", () => {
    expect(_testOnly.isCommanderError({ code: "commander.unknownOption" })).toBe(true);
    expect(_testOnly.isCommanderError({ code: "ENOENT", exitCode: EXIT_CODE.NOT_FOUND })).toBe(false);
    expect(_testOnly.isCommanderError(new Error("plain"))).toBe(false);
  });

  it("reads finite numeric thrown exit codes only", () => {
    expect(_testOnly.readThrownExitCode({ exitCode: EXIT_CODE.CONFLICT })).toBe(EXIT_CODE.CONFLICT);
    expect(_testOnly.readThrownExitCode({ exitCode: 2.8 })).toBe(2.8);
    expect(_testOnly.readThrownExitCode({ exitCode: Number.NaN })).toBeUndefined();
    expect(_testOnly.readThrownExitCode({ exitCode: "2" })).toBeUndefined();
    expect(_testOnly.readThrownExitCode(null)).toBeUndefined();
  });

  it("normalizes invalid thrown exit codes to generic failure instead of success", () => {
    expect(_testOnly.normalizeThrownExitCode(EXIT_CODE.USAGE)).toBe(EXIT_CODE.USAGE);
    expect(_testOnly.normalizeThrownExitCode(2.9)).toBe(2);
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

  it("infers missing flags and retry commands from plain CLI errors", () => {
    const context = _testOnly.buildPmCliRecoveryContext(
      { code: "missing_required_option" },
      ["create", "--json", "--title", "Strict task"],
      "Missing required option --description and --type",
    );

    expect(context.recovery).toMatchObject({
      attempted_command: 'pm create --json --title "Strict task"',
      normalized_args: ["create", "--json", "--title", "Strict task"],
      provided_fields: ["--json", "--title"],
      missing: ["--description", "--type"],
      suggested_retry: 'pm create --json --title "Strict task" --description "<value>"',
    });
  });

  it("does not suggest retries for flags that were already provided", () => {
    const context = _testOnly.buildPmCliRecoveryContext(
      undefined,
      ["update", "pm-123", "--message", "done"],
      "Missing required option --message",
    );

    expect(context.recovery).toEqual({
      attempted_command: "pm update pm-123 --message done",
      normalized_args: ["update", "pm-123", "--message", "done"],
      provided_fields: ["--message"],
    });
  });

  it("keeps compact recovery payloads compact unless explain is requested", () => {
    const context = _testOnly.buildPmCliRecoveryContext(
      {
        code: "missing_required_option",
        recovery: {
          recovery_mode: "compact",
          missing: ["--message"],
          missing_required_fields: ["--message"],
          suggested_flags: ["--create-mode progressive", "--message"],
        },
      },
      ["create", "--json", "--title", "Strict task", "--description", "Needs message", "--type", "Task"],
      'Missing required option --message for type "Task"',
    );

    expect(context.recovery).toEqual({
      recovery_mode: "compact",
      missing: ["--message"],
      missing_required_fields: ["--message"],
      suggested_flags: ["--create-mode progressive", "--message"],
    });
  });

  it("expands compact recovery payloads when explain is requested", () => {
    const context = _testOnly.buildPmCliRecoveryContext(
      {
        code: "missing_required_option",
        recovery: {
          recovery_mode: "compact",
          missing: ["--message"],
          missing_required_fields: ["--message"],
          suggested_flags: ["--create-mode progressive", "--message"],
        },
      },
      ["create", "--json", "--explain", "--title", "Strict task", "--description", "Needs message", "--type", "Task"],
      'Missing required option --message for type "Task"',
    );

    expect(context.recovery).toMatchObject({
      recovery_mode: "compact",
      attempted_command: 'pm create --json --explain --title "Strict task" --description "Needs message" --type Task',
      normalized_args: ["create", "--json", "--explain", "--title", "Strict task", "--description", "Needs message", "--type", "Task"],
      provided_fields: ["--json", "--explain", "--title", "--description", "--type"],
      missing: ["--message"],
      missing_required_fields: ["--message"],
      suggested_flags: ["--create-mode progressive", "--message"],
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

  it("accepts true-like Sentry expected-error capture environment values", () => {
    const previous = process.env.PM_SENTRY_CAPTURE_EXPECTED_ERRORS;
    try {
      process.env.PM_SENTRY_CAPTURE_EXPECTED_ERRORS = " YES ";
      expect(_testOnly.shouldLogHandledErrorToSentry(EXIT_CODE.USAGE)).toBe(true);
      process.env.PM_SENTRY_CAPTURE_EXPECTED_ERRORS = "off";
      expect(_testOnly.shouldLogHandledErrorToSentry(EXIT_CODE.USAGE)).toBe(false);
    } finally {
      if (previous === undefined) {
        delete process.env.PM_SENTRY_CAPTURE_EXPECTED_ERRORS;
      } else {
        process.env.PM_SENTRY_CAPTURE_EXPECTED_ERRORS = previous;
      }
    }
  });

  it("normalizes primitive error and telemetry helper inputs defensively", () => {
    expect(_testOnly.describeUnknownError(new Error("boom"))).toBe("boom");
    expect(_testOnly.describeUnknownError("plain failure")).toBe("Unknown failure");
    expect(_testOnly.inferMissingFieldsFromErrorMessage("missing --title, --type and --title")).toEqual([
      "--title",
      "--type",
    ]);
    expect(_testOnly.inferMissingFieldsFromErrorMessage("missing title")).toBeUndefined();

    const record = {
      blank: "  ",
      name: "  Alice  ",
      disabled: false,
      count: 2.9,
      badCount: Number.NaN,
    };
    expect(_testOnly.readRecordString(record, "blank", "name")).toBe("Alice");
    expect(_testOnly.readRecordString(null, "name")).toBeUndefined();
    expect(_testOnly.readRecordBoolean(record, "disabled")).toBe(false);
    expect(_testOnly.readRecordBoolean(record, "missing")).toBeUndefined();
    expect(_testOnly.readRecordNumber(record, "count")).toBe(2);
    expect(_testOnly.readRecordNumber(record, "badCount")).toBeUndefined();

    expect(_testOnly.normalizeTelemetryCommandResolution(" Validation_Failed ")).toBe("validation_failed");
    expect(_testOnly.normalizeTelemetryCommandResolution("not-real")).toBeUndefined();
    expect(_testOnly.normalizeTelemetryResolutionStage("PARSE")).toBe("parse");
    expect(_testOnly.normalizeTelemetryResolutionStage("late")).toBeUndefined();
    expect(_testOnly.normalizeTelemetryErrorCategory(" Conflict ")).toBe("conflict");
    expect(_testOnly.normalizeTelemetryErrorCategory("other")).toBeUndefined();
  });

  it("reads true-like env flags case-insensitively", () => {
    const previous = process.env.PM_TEST_TRUE_LIKE;
    try {
      process.env.PM_TEST_TRUE_LIKE = " On ";
      expect(_testOnly.envFlagEnabled("PM_TEST_TRUE_LIKE")).toBe(true);
      process.env.PM_TEST_TRUE_LIKE = "0";
      expect(_testOnly.envFlagEnabled("PM_TEST_TRUE_LIKE")).toBe(false);
      delete process.env.PM_TEST_TRUE_LIKE;
      expect(_testOnly.envFlagEnabled("PM_TEST_TRUE_LIKE")).toBe(false);
    } finally {
      if (previous === undefined) {
        delete process.env.PM_TEST_TRUE_LIKE;
      } else {
        process.env.PM_TEST_TRUE_LIKE = previous;
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

describe("CLI bootstrap entrypoints", () => {
  it("covers the direct cli.ts fast-version entrypoint and exported startup helpers", async () => {
    const previousArgv = process.argv;
    const previousExitCode = process.exitCode;
    const previousDisableCompileCache = process.env.PM_CLI_DISABLE_COMPILE_CACHE;
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pm-cli-entry-"));
    const nested = path.join(tempRoot, "nested", "child.js");
    const cliUrl = pathToFileURL(path.resolve("src/cli.ts"));
    cliUrl.search = `?entryFastVersion=${Date.now()}`;
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      await writeFile(path.join(tempRoot, "package.json"), JSON.stringify({ version: "9.8.7" }), "utf8");
      await writeFile(nested, "", "utf8").catch(async () => {
        const { mkdir } = await import("node:fs/promises");
        await mkdir(path.dirname(nested), { recursive: true });
        await writeFile(nested, "", "utf8");
      });

      process.argv = ["node", "pm", "--no-extensions", "--version"];
      const cliModule = await import(cliUrl.href);

      expect(logSpy.mock.calls.map((call) => String(call[0])).join("").trim()).toMatch(/^\d{4}\.\d+\.\d+$/);
      expect(cliModule._testOnly.findPackageJson(nested)).toBe(path.join(tempRoot, "package.json"));
      expect(cliModule._testOnly.findPackageJson(path.parse(tempRoot).root)).toBeUndefined();

      logSpy.mockClear();
      process.argv = ["node", "pm", "--no-extensions", "-V"];
      expect(cliModule._testOnly.printFastVersionIfRequested()).toBe(true);
      expect(logSpy.mock.calls.map((call) => String(call[0])).join("").trim()).toMatch(/^\d{4}\.\d+\.\d+$/);

      process.argv = ["node", "pm", "--no-extensions", "--version", "--json"];
      expect(cliModule._testOnly.printFastVersionIfRequested()).toBe(false);

      process.env.PM_CLI_DISABLE_COMPILE_CACHE = "1";
      expect(cliModule._testOnly.enableNodeCompileCache()).toBeUndefined();
    } finally {
      logSpy.mockRestore();
      process.argv = previousArgv;
      process.exitCode = previousExitCode;
      if (previousDisableCompileCache === undefined) {
        delete process.env.PM_CLI_DISABLE_COMPILE_CACHE;
      } else {
        process.env.PM_CLI_DISABLE_COMPILE_CACHE = previousDisableCompileCache;
      }
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("uses the direct cli entrypoint fast path for --version with --no-extensions", async () => {
    await withTempPmPath(async (context) => {
      const result = context.runCli(["--no-extensions", "--version"]);
      expect(result.code).toBe(EXIT_CODE.SUCCESS);
      expect(result.stdout.trim()).toMatch(/^\d{4}\.\d+\.\d+$/);
      expect(result.stderr).toBe("");
    });
  });

  it("renders unknown help requests through runPmCli in-process bootstrap handling", async () => {
    await withTempPmPath(async (context) => {
      const result = await context.runCliInProcess(["--json", "definitely-missing", "--help"]);
      expect(result.code).toBe(EXIT_CODE.USAGE);
      expect(result.stdout).toBe("");
      const payload = JSON.parse(result.stderr);
      expect(payload).toMatchObject({
        code: "unknown_command",
        title: "Unknown command definitely-missing",
        recovery: expect.objectContaining({
          attempted_command: "pm --json definitely-missing --help",
        }),
      });
    });
  });

  it("refuses bootstrap flag typo corrections until the user retries explicitly", async () => {
    await withTempPmPath(async (context) => {
      const result = await context.runCliInProcess(["create", "--titel", "Needs explicit retry"]);
      expect(result.code).toBe(EXIT_CODE.USAGE);
      expect(result.stderr).toContain("Refusing to auto-correct mutating option --titel to --title");
      expect(result.stderr).toContain("pm create --title");
    });
  });

  it("drives source runPmCli success and parse-error rendering branches", async () => {
    await withTempPmPath(async (context) => {
      const version = await runSourceCli(["--no-extensions", "--version"], context.env);
      expect(version).toMatchObject({
        code: EXIT_CODE.SUCCESS,
        stderr: "",
      });
      expect(version.stdout.trim()).toMatch(/^\d{4}\.\d+\.\d+$/);

      const help = await runSourceCli(["--no-extensions", "list", "--help"], context.env);
      expect(help.code).toBe(EXIT_CODE.SUCCESS);
      expect(help.stdout).toContain("Usage: pm list");
      expect(help.stderr).toBe("");

      const typo = await runSourceCli(["--no-extensions", "--json", "create", "--titel", "Needs retry"], context.env);
      expect(typo.code).toBe(EXIT_CODE.USAGE);
      expect(typo.stdout).toBe("");
      const typoPayload = JSON.parse(typo.stderr);
      expect(typoPayload).toMatchObject({
        code: "mutating_flag_typo_requires_retry",
        recovery: {
          attempted_command: "pm --no-extensions --json create --title \"Needs retry\"",
          suggested_retry: "pm --no-extensions --json create --title \"Needs retry\"",
        },
      });

      const commander = await runSourceCli(["--no-extensions", "--json", "list", "--definitely-not-real"], context.env);
      expect(commander.code).toBe(EXIT_CODE.USAGE);
      expect(commander.stdout).toBe("");
      const commanderPayload = JSON.parse(commander.stderr);
      expect(commanderPayload).toMatchObject({
        code: "unknown_option",
        recovery: expect.objectContaining({
          attempted_command: "pm --no-extensions --json list --definitely-not-real",
          normalized_args: ["--no-extensions", "--json", "list", "--definitely-not-real"],
          provided_fields: ["--no-extensions", "--json", "--definitely-not-real"],
        }),
      });
    });
  });
});

describe("CLI main bootstrap helper coverage", () => {
  it("selects core command families and auxiliary registration gates from bootstrap argv", () => {
    expect(_testOnly.resolveCoreCommandRegistrationSelection(["--version"])).toEqual({
      setup: false,
      listQuery: false,
      mutation: false,
      operation: false,
    });
    expect(_testOnly.resolveCoreCommandRegistrationSelection([])).toMatchObject({
      setup: true,
      listQuery: true,
      mutation: true,
      operation: true,
    });
    expect(_testOnly.resolveCoreCommandRegistrationSelection(["--json", "ctx"])).toMatchObject({
      listQuery: true,
      targetCommandName: "ctx",
    });
    expect(_testOnly.resolveCoreCommandRegistrationSelection(["create"])).toMatchObject({
      mutation: true,
      targetCommandName: "create",
    });
    expect(_testOnly.resolveCoreCommandRegistrationSelection(["health"])).toMatchObject({
      operation: true,
      targetCommandName: "health",
    });
    expect(_testOnly.resolveCoreCommandRegistrationSelection(["unknown"])).toMatchObject({
      setup: true,
      listQuery: true,
      mutation: true,
      operation: true,
    });

    expect(_testOnly.shouldAttachRichHelpTextForInvocation([])).toBe(true);
    expect(_testOnly.shouldAttachRichHelpTextForInvocation(["create", "--help"])).toBe(true);
    expect(_testOnly.shouldAttachRichHelpTextForInvocation(["create"])).toBe(false);
    expect(_testOnly.shouldRegisterDynamicExtensionPaths(new Command(), ["--version"])).toBe(false);
    expect(_testOnly.shouldRegisterDynamicExtensionPaths(new Command(), ["create"])).toBe(true);
    expect(_testOnly.shouldRegisterDynamicExtensionPaths(new Command(), ["--help"])).toBe(true);
    expect(_testOnly.shouldRegisterDynamicExtensionPaths(new Command(), [])).toBe(false);
    expect(_testOnly.shouldRegisterRuntimeSchemaFlags(["create"])).toBe(true);
    expect(_testOnly.shouldRegisterRuntimeSchemaFlags(["templates", "save"])).toBe(true);
    expect(_testOnly.shouldRegisterRuntimeSchemaFlags(["health"])).toBe(false);
    expect(_testOnly.shouldRegisterRuntimeSchemaFlags(["-V"])).toBe(false);
  });

  it("builds activation probes and extension activation decisions", () => {
    expect(_testOnly.collectLeadingCommandArgs(["daily", "--json", "ignored"])).toEqual(["daily"]);
    expect(_testOnly.collectLeadingCommandArgs([" ", "sub command"])).toEqual(["sub command"]);
    expect(_testOnly.collectActivationCommandCandidates({ commandPath: "standup", commandArgs: ["daily", "--json"] })).toEqual([
      "standup",
      "standup daily",
    ]);
    expect(_testOnly.buildBootstrapActivationProbe(["--json", "standup", "daily"])).toEqual({
      commandPath: "standup",
      commandArgs: ["daily"],
      allowCommandPrefixMatch: false,
    });
    expect(_testOnly.buildBootstrapActivationProbe(["standup", "daily", "--help"])).toEqual({
      commandPath: "standup",
      commandArgs: ["daily"],
      allowCommandPrefixMatch: true,
    });
    expect(_testOnly.buildBootstrapActivationProbe(["--json"])).toEqual({});
    expect(_testOnly.commandPathNeedsSearchExtensions("search-advanced")).toBe(true);
    expect(_testOnly.commandPathNeedsSearchExtensions("list")).toBe(false);
    expect(_testOnly.commandPathNeedsTemplateExtensions({ commandPath: "create", commandArgs: ["--template=bug"] })).toBe(true);
    expect(_testOnly.commandPathNeedsTemplateExtensions({ commandPath: "create", commandArgs: ["--title", "bug"] })).toBe(false);

    const extension = (overrides: Record<string, unknown>) => ({
      layer: "project",
      name: "ext",
      root: "/tmp/ext",
      manifest_path: "/tmp/ext/pm-package.json",
      manifest: { name: "ext", version: "1.0.0" },
      commands: [],
      ...overrides,
    });
    expect(
      _testOnly.extensionNeedsActivationForProbe(
        extension({ activation: { commands: ["standup"] }, capabilities: [] }),
        { commandPath: "standup", commandArgs: ["daily"] },
      ),
    ).toBe(true);
    expect(
      _testOnly.extensionNeedsActivationForProbe(
        extension({ activation: { commands: ["templates"] }, capabilities: [] }),
        { commandPath: "create", commandArgs: ["--template"] },
      ),
    ).toBe(true);
    expect(
      _testOnly.extensionNeedsActivationForProbe(extension({ activation: { commands: ["standup"] }, capabilities: [] }), {
        commandPath: "list",
      }),
    ).toBe(false);
    expect(
      _testOnly.extensionNeedsActivationForProbe(extension({ capabilities: ["search"] }), { commandPath: "search" }),
    ).toBe(true);
    expect(
      _testOnly.extensionNeedsActivationForProbe(extension({ capabilities: ["importers"] }), {
        commandPath: "import",
        allowCommandPrefixMatch: true,
      }),
    ).toBe(true);
    expect(_testOnly.discoveryNeedsActivationForProbe({ effective: [], warnings: [] }, { commandPath: "search" })).toBe(false);
    expect(
      _testOnly.discoveryNeedsActivationForProbe(
        { effective: [extension({ capabilities: ["services"] })], warnings: [] },
        {},
      ),
    ).toBe(true);
    expect(_testOnly.collectActivationCommandCandidates({ commandPath: " " })).toEqual([]);
    expect(
      _testOnly.extensionNeedsActivationForProbe(extension({ activation: { commands: ["daily standup"] }, capabilities: [] }), {
        commandPath: "daily",
        commandArgs: [],
        allowCommandPrefixMatch: true,
      }),
    ).toBe(true);
    expect(
      _testOnly.extensionNeedsActivationForProbe(extension({ capabilities: ["hooks"] }), {
        commandPath: "unrelated",
      }),
    ).toBe(true);
    expect(
      _testOnly.extensionNeedsActivationForProbe(extension({ capabilities: ["commands"] }), {
        commandPath: "unrelated",
      }),
    ).toBe(true);
    expect(_testOnly.extensionNeedsActivationForProbe(extension({ capabilities: ["search"] }), {})).toBe(false);
    expect(_testOnly.extensionNeedsActivationForProbe(extension({ capabilities: [] }), { commandPath: "unrelated" })).toBe(false);
    expect(
      _testOnly.discoveryNeedsActivationForProbe(
        { effective: [extension({ capabilities: ["search"] })], warnings: [] },
        {},
      ),
    ).toBe(true);
  });

  it("selects extension flag definitions for exact and nested invocations", () => {
    const registrations = {
      flags: [
        {
          target_command: "tools",
          flags: [{ long: "--root-flag" }],
        },
        {
          target_command: "tools export",
          flags: [{ long: "--format" }],
        },
        {
          target_command: "other",
          flags: [{ long: "--ignored" }],
        },
      ],
    };

    expect(_testOnly.collectExtensionFlagDefinitionsForCommand(registrations, " tools ")).toEqual([{ long: "--root-flag" }]);
    expect(_testOnly.collectExtensionFlagDefinitionsForCommand(registrations, " ")).toEqual([]);
    expect(_testOnly.collectExtensionFlagDefinitionsForInvocation(registrations, "tools", ["export", "--format", "json"])).toEqual([
      { long: "--format" },
    ]);
    expect(_testOnly.collectExtensionFlagDefinitionsForInvocation(registrations, "tools", ["--root-flag"])).toEqual([
      { long: "--root-flag" },
    ]);
  });

  it("extracts command-scoped options without leaking global output controls", () => {
    const command = new Command("tools");
    command
      .option("--json", "JSON")
      .option("--quiet", "quiet")
      .option("--id-only", "id only")
      .option("--pm-path <dir>", "pm path")
      .option("--known <value>", "Known option");
    command.allowUnknownOption(true);
    command.parseOptions(["--json", "--quiet", "--id-only", "--pm-path", "/tmp/pm", "--known", "yes", "--loose", "value"]);
    command.args = ["--loose", "value"];

    const scoped = _testOnly.extractCommandScopedOptions(command, command.args);
    expect(scoped).toMatchObject({
      known: "yes",
      loose: "value",
    });
    expect(scoped).not.toHaveProperty("json");
    expect(scoped).not.toHaveProperty("quiet");
    expect(scoped).not.toHaveProperty("idOnly");
    expect(scoped).not.toHaveProperty("pmPath");

    const extensionScoped = _testOnly.extractCommandScopedOptions(command, ["--score", "42"], [
      { long: "--score", type: "number", value_type: "number" },
    ]);
    expect(extensionScoped.score).toBe(42);
  });

  it("registers runtime field options while avoiding duplicate short and long flags", () => {
    const command = new Command("create");
    command.option("--customer-segment <value>", "Existing runtime field");
    command.option("-s <value>", "Existing short field");

    expect(_testOnly.toLooseFieldDefinitionType("number")).toBe("number");
    expect(_testOnly.toLooseFieldDefinitionType("boolean")).toBe("boolean");
    expect(_testOnly.toLooseFieldDefinitionType("unknown")).toBe("string");

    _testOnly.addRuntimeFieldOption(command, " ", "Blank flag", false);
    _testOnly.addRuntimeFieldOption(command, "--customer-segment", "Duplicate long", true);
    _testOnly.addRuntimeFieldOption(command, "-s", "Duplicate short", true);
    _testOnly.addRuntimeFieldOption(command, "segment", "Segment", true);
    _testOnly.addRuntimeFieldOption(command, "-u", "", false);
    _testOnly.addRuntimeFieldOption(command, "--score", "Score", false);

    expect(command.options.map((option) => option.flags)).toEqual(
      expect.arrayContaining(["--customer-segment <value>", "-s <value>", "--segment <value>", "-u <value>", "--score <value>"]),
    );
    expect(command.options.filter((option) => option.long === "--customer-segment")).toHaveLength(1);
    expect(command.options.filter((option) => option.short === "-s")).toHaveLength(1);
    expect(command.options.find((option) => option.long === "--segment")?.description).toBe("Segment (repeatable)");
    expect(command.options.find((option) => option.short === "-u")?.description).toBe("Runtime schema field (-u)");
    expect(_testOnly.commandHasLongOption(command, "--score")).toBe(true);
    expect(_testOnly.commandHasShortOption(command, "-u")).toBe(true);
    expect(_testOnly.commandHasLongOption(command, "--missing")).toBe(false);
    expect(_testOnly.commandHasShortOption(command, "-x")).toBe(false);
  });

  it("covers activation predicate helpers and profile rendering fallbacks", () => {
    expect(_testOnly.buildRuntimeExtensionSnapshotCacheKey("/tmp/project/.agents/pm")).toBe("pm-root:/tmp/project/.agents/pm");
    expect(_testOnly.buildRuntimeExtensionDiscoverySnapshotCacheKey("/tmp/project/.agents/pm")).toBe(
      "pm-root:/tmp/project/.agents/pm",
    );
    expect(_testOnly.bootstrapProfileEnabled(["list", "--profile"])).toBe(true);
    expect(_testOnly.bootstrapProfileEnabled(["list"])).toBe(false);

    const rootForCreate = new Command("pm");
    const create = rootForCreate.command("create").option("--template <name>", "Template");
    create.setOptionValue("template", "bug");
    expect(_testOnly.collectParsedActivationCommandArgs(create)).toEqual(["--template"]);
    const list = new Command("list");
    list.args = ["open", "--json"];
    expect(_testOnly.collectParsedActivationCommandArgs(list)).toEqual(["open", "--json"]);

    const extension = {
      activation: { commands: ["standup"] },
      capabilities: [" Hooks ", "search", ""],
    };
    expect(_testOnly.extensionActivationCommands(extension as never)).toEqual(["standup"]);
    expect([..._testOnly.extensionCapabilities(extension as never)].sort()).toEqual(["", "hooks", "search"]);
    expect(_testOnly.hasAnyCapability(new Set(["hooks"]), new Set(["parser", "hooks"]))).toBe(true);
    expect(_testOnly.hasAnyCapability(new Set(["commands"]), new Set(["parser", "hooks"]))).toBe(false);
    expect(_testOnly.probeUsesAnyFlag({ commandArgs: ["--template=bug"] }, new Set(["--template"]))).toBe(true);
    expect(_testOnly.probeUsesAnyFlag({ commandArgs: ["--title", "bug"] }, new Set(["--template"]))).toBe(false);
    expect(_testOnly.extensionProvidesTemplatesRuntime(["templates save"])).toBe(true);
    expect(_testOnly.extensionProvidesTemplatesRuntime(["create"])).toBe(false);
    expect(_testOnly.activationCommandMatchesProbe("standup", { commandPath: "standup", commandArgs: ["daily"] })).toBe(true);
    expect(
      _testOnly.activationCommandMatchesProbe("standup daily", {
        commandPath: "standup",
        commandArgs: [],
        allowCommandPrefixMatch: true,
      }),
    ).toBe(true);
    expect(_testOnly.activationCommandMatchesProbe(" ", { commandPath: "standup" })).toBe(false);

    const profile = captureStderrSync(() =>
      _testOnly.emitExtensionProfile(
        { profile: true } as never,
        {
          loadedCount: 2,
          loadFailedCount: 1,
          loadWarnings: ["load"],
          activationFailedCount: 1,
          activationWarnings: ["activate"],
          hooks: { beforeCommand: [1], afterCommand: [2], onWrite: [], onRead: [3], onIndex: [] },
          commands: { overrides: [], handlers: [1] },
          parsers: { overrides: [1] },
          preflight: { overrides: [] },
          services: { overrides: [1, 2] },
          renderers: { overrides: [] },
        } as never,
      ),
    );
    expect(profile).toContain("profile:extensions loaded=2 failed=1");
    expect(profile).toContain("activation_warnings=activate");

    expect(captureStderrSync(() => _testOnly.emitExtensionProfile({ profile: false } as never, {} as never))).toBe("");
    const skipped = captureStderrSync(() =>
      _testOnly.emitExtensionSkippedProfile(
        true,
        {
          discovery: { effective: [{ name: "one" }, { name: "two" }], warnings: ["warn"] },
          discoveryMs: 7,
        } as never,
        {},
      ),
    );
    expect(skipped).toContain("activation=skipped command=<none> effective=2 warnings=1 discovery_ms=7");
    expect(captureStderrSync(() => _testOnly.emitExtensionSkippedProfile(false, {} as never, { commandPath: "list" }))).toBe("");
  });

  it("executes registered runtime migrations and records failed definitions", async () => {
    const migrations = [
      {
        layer: "project",
        name: "already",
        definition: { id: "done", status: "applied", reason: "old" },
      },
      {
        layer: "project",
        name: "missing-runner",
        definition: { id: "skip", status: "pending" },
      },
      {
        layer: "project",
        name: "success",
        definition: { id: "ok", status: "pending", reason: "queued", error: "old", message: "old" },
        runtime_definition: {
          run: vi.fn(),
        },
      },
      {
        layer: "global",
        name: "failure",
        definition: { id: "bad", status: "pending" },
        runtime_definition: {
          run: vi.fn(() => {
            throw new Error("cannot migrate");
          }),
        },
      },
      {
        layer: "project",
        name: "generated-id",
        definition: { status: "pending" },
        runtime_definition: {
          run: vi.fn(),
        },
      },
    ];

    const warnings = await _testOnly.executeRegisteredRuntimeMigrations(migrations as never, "/tmp/pm-root");

    expect(warnings).toEqual(["extension_migration_failed:global:failure:bad"]);
    expect(migrations[2].runtime_definition.run).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "ok",
        command: "migration",
        layer: "project",
        extension: "success",
        pm_root: "/tmp/pm-root",
      }),
    );
    expect(migrations[2].definition).toEqual({ id: "ok", status: "applied" });
    expect(migrations[3].definition).toMatchObject({
      id: "bad",
      status: "failed",
      reason: "cannot migrate",
    });
    expect(migrations[4].runtime_definition.run).toHaveBeenCalledWith(expect.objectContaining({ id: "migration-005" }));
  });

  it("infers post-action telemetry outcomes from command results and process exit codes", () => {
    const previousExitCode = process.exitCode;
    try {
      process.exitCode = undefined;
      setActiveCommandResult({
        exit_code: EXIT_CODE.DEPENDENCY_FAILED,
        warnings: [" linked test failed "],
      });
      expect(_testOnly.buildPostActionTelemetryOutcome()).toMatchObject({
        ok: false,
        exit_code: EXIT_CODE.DEPENDENCY_FAILED,
        error_code: "dependency_failed",
        error: "linked test failed",
        resolution_stage: "execute",
      });

      setActiveCommandResult({
        exitCode: EXIT_CODE.USAGE,
        errorCode: "custom_error",
        errorCategory: "validation",
        commandResolution: "validation_failed",
        resolutionStage: "preflight",
        message: "bad input",
      });
      expect(_testOnly.buildPostActionTelemetryOutcome()).toMatchObject({
        ok: false,
        error_code: "custom_error",
        error_category: "validation",
        command_resolution: "validation_failed",
        resolution_stage: "preflight",
        error: "bad input",
      });

      process.exitCode = EXIT_CODE.CONFLICT;
      setActiveCommandResult({ exit_code: EXIT_CODE.SUCCESS });
      expect(_testOnly.buildPostActionTelemetryOutcome()).toMatchObject({
        ok: false,
        exit_code: EXIT_CODE.CONFLICT,
        error_code: "lock_conflict",
      });

      expect(_testOnly.inferPostActionFailureMessage({ failOnSkippedTriggered: true })).toBe("linked_test_fail_on_skipped_triggered");
      expect(_testOnly.inferPostActionFailureMessage({ failed: 3 })).toBe("failed_runs:3");
      expect(_testOnly.inferPostActionFailureMessage({ run_results: [{ status: "failed" }, { status: "passed" }] })).toBe("failed_runs:1");
      expect(_testOnly.inferPostActionFailureMessage({})).toBeUndefined();
      expect(_testOnly.inferPostActionErrorCode(false, EXIT_CODE.NOT_FOUND)).toBe("item_not_found");
      expect(_testOnly.inferPostActionErrorCode(false, 99)).toBe("command_failed");
      expect(_testOnly.inferPostActionErrorCode(true, EXIT_CODE.SUCCESS)).toBeUndefined();
    } finally {
      process.exitCode = previousExitCode;
      setActiveCommandResult(undefined);
    }
  });

  it("builds default preflight decisions and rejects canonicalized flag typos explicitly", () => {
    expect(_testOnly.defaultPreflightDecision()).toEqual({
      enforce_item_format_gate: true,
      run_preflight_item_format_sync: true,
      run_extension_migrations: true,
      enforce_mandatory_migration_gate: true,
    });
    expect(() =>
      _testOnly.enforceExplicitRetryForFlagTypos({
        commandName: "list",
        argv: ["list", "--status", "open"],
        trace: [{ reason: "flag_typo", from: "--stats", to: "--status" }],
      }),
    ).toThrow("Refusing to auto-correct option --stats to --status");
    expect(() =>
      _testOnly.enforceExplicitRetryForFlagTypos({
        commandName: "create",
        argv: ["create", "--title", "bug"],
        trace: [{ reason: "flag_typo", from: "--titel", to: ["--title"] }],
      }),
    ).toThrow("Refusing to auto-correct mutating option --titel to --title");
    expect(
      _testOnly.enforceExplicitRetryForFlagTypos({
        commandName: undefined,
        argv: [],
        trace: [{ reason: "flag_typo", from: "--titel", to: ["--title"] }],
      }),
    ).toBeUndefined();
  });
});

describe("CLI Commander usage recovery helpers", () => {
  it("collects runtime command paths from Commander and extension descriptors while skipping internals", () => {
    const program = new Command().name("pm");
    program.command("list").alias("ls").description("List items");
    const packageCommand = program.command("package").description("Package commands");
    packageCommand.command("install").description("Install packages");
    program.command("_internal").command("debug").description("Hidden internal command");

    const descriptors = new Map([
      ["standup daily", { command: "standup daily", action: "standup", examples: [], failure_hints: [], arguments: [], flags: [] }],
      ["_hidden task", { command: "_hidden task", action: "hidden", examples: [], failure_hints: [], arguments: [], flags: [] }],
      ["   ", { command: "blank", action: "blank", examples: [], failure_hints: [], arguments: [], flags: [] }],
    ]);

    expect(collectRuntimeCommandPaths(program, descriptors)).toEqual([
      "list",
      "package",
      "package install",
      "standup daily",
    ]);
  });

  it("scores command path matches and builds alias, package, and optional-install suggestions", () => {
    const program = new Command().name("pm");
    program.command("get").description("Get item");
    program.command("list").description("List items");
    program.command("lst-long").description("List long-form report");
    program.command("calendar").description("Calendar package command");
    const standup = program.command("standup").description("Standup package command");
    standup.command("daily").description("Daily standup");

    const descriptors = new Map([
      [
        "standup daily",
        {
          command: "standup daily",
          action: "standup-daily",
          examples: [],
          failure_hints: [],
          arguments: [],
          flags: [],
          source: { layer: "project" as const, name: "standup", package: "@unbrained/pm-standup" },
        },
      ],
    ]);

    expect(scoreCommandPathMatch("standup daily", "")).toBe(Number.POSITIVE_INFINITY);
    expect(scoreCommandPathMatch("standup daily", "standup daily")).toBe(0);
    expect(scoreCommandPathMatch("standup daily", "daily")).toBe(1);
    expect(scoreCommandPathMatch("standup daily", "sta")).toBe(2);
    expect(scoreCommandPathMatch("standup daily", "up da")).toBe(3);
    expect(scoreCommandPathMatch("list", "lst")).toBeGreaterThanOrEqual(4);
    expect(scoreCommandPathMatch("list", "calendar")).toBe(Number.POSITIVE_INFINITY);

    const aliasGuidance = buildUnknownCommandGuidanceFromRuntime("unknown command 'show'", program, descriptors);
    expect(aliasGuidance?.unknownCommandNextSteps?.[0]).toContain("get");
    expect(aliasGuidance?.unknownCommandExamples).toContain("pm get --help");

    const packageGuidance = buildUnknownCommandGuidanceFromRuntime("unknown command 'pm-standup'", program, descriptors);
    expect(packageGuidance?.unknownCommandNextSteps?.[0]).toContain("standup daily");

    const noSourceGuidance = buildUnknownCommandGuidanceFromRuntime(
      "unknown command 'pm-unknown'",
      program,
      new Map([
        [
          "orphan",
          {
            command: "orphan",
            action: "orphan",
            examples: [],
            failure_hints: [],
            arguments: [],
            flags: [],
            source: { layer: "project" as const, name: "", package: " " },
          },
        ],
      ]),
    );
    expect(noSourceGuidance?.unknownCommandNextSteps?.[0]).not.toContain("orphan");

    const optionalGuidance = buildUnknownCommandGuidanceFromRuntime("unknown command 'cal'", program, descriptors);
    expect(optionalGuidance?.unknownCommandNextSteps).toContain(
      "If this command comes from an optional package, install it with: pm install calendar",
    );

    const tiedRankGuidance = buildUnknownCommandGuidanceFromRuntime(
      "unknown command 'sta subcommand'",
      program,
      new Map([
        ["standup alpha", { command: "standup alpha", action: "alpha", examples: [], failure_hints: [], arguments: [], flags: [] }],
        ["standup beta", { command: "standup beta", action: "beta", examples: [], failure_hints: [], arguments: [], flags: [] }],
      ]),
    );
    expect(tiedRankGuidance?.unknownCommandNextSteps?.[0]).toContain("standup alpha, standup beta");

    const rankedGuidance = buildUnknownCommandGuidanceFromRuntime("unknown command 'lst'", program, descriptors);
    expect(rankedGuidance?.unknownCommandNextSteps?.[0]).toContain("lst-long");

    expect(buildUnknownCommandGuidanceFromRuntime("plain error", program, descriptors)).toBeUndefined();
    expect(buildUnknownCommandGuidanceFromRuntime("unknown command '   '", program, descriptors)).toBeUndefined();
    expect(buildUnknownCommandGuidanceFromRuntime("unknown command 'missing'", new Command().name("pm"), new Map())).toBeUndefined();
  });

  it("resolves child commands and partial help paths through aliases", () => {
    const program = new Command().name("pm");
    program.command("context").alias("ctx").description("Context");
    const packageCommand = program.command("package").alias("pkg").description("Package");
    packageCommand.command("install").alias("add").description("Install");

    expect(resolveChildCommandByToken(program, "package")?.name()).toBe("package");
    expect(resolveChildCommandByToken(program, "CTX")?.name()).toBe("context");
    expect(resolveChildCommandByToken(program, "missing")).toBeUndefined();
    expect(isKnownHelpCommandPath(program, [])).toBe(true);
    expect(isKnownHelpCommandPath(program, ["pkg", "add"])).toBe(true);
    expect(isKnownHelpCommandPath(program, ["pkg", "missing"])).toBe(true);
    expect(isKnownHelpCommandPath(program, ["missing"])).toBe(false);
  });

  it("adds unknown-option suggestions, cross-command hints, and missing-required retry guidance", async () => {
    const program = new Command().name("pm");
    program.command("update").description("Update");
    const previousArgv = process.argv;
    try {
      process.argv = ["node", "pm", "comments", "pm-123", "--body=done"];
      const unknown = await resolveCommanderUsageContext(
        { message: "error: unknown option '--body'" },
        program,
        new Map(),
      );
      expect(unknown.commandName).toBe("comments");
      expect(unknown.unknownOptionSuggestions).toContain("--add");
      expect(unknown.suggestedRetryCommand).toContain("--add=done");

      process.argv = ["node", "pm", "test-all", "--type", "Task"];
      const otherCommand = await resolveCommanderUsageContext(
        { message: "error: unknown option '--type'" },
        program,
        new Map(),
      );
      expect(otherCommand.unknownOptionOtherCommands).toEqual(expect.arrayContaining(["create", "list"]));

      const shortUnknown = await resolveCommanderUsageContext(
        { message: "error: unknown option '-z'" },
        program,
        new Map(),
      );
      expect(shortUnknown.unknownOptionOtherCommands).toBeUndefined();

      const noOtherCommand = await resolveCommanderUsageContext(
        { message: "error: unknown option '--definitely-not-real'" },
        program,
        new Map(),
      );
      expect(noOtherCommand.unknownOptionOtherCommands).toBeUndefined();

      process.argv = ["node", "pm", "comments", "pm-123"];
      const missing = await resolveCommanderUsageContext(
        { message: "error: required option '--add <text>,;' not specified" },
        program,
        new Map(),
      );
      expect(missing.suggestedRetryCommand).toBe('pm comments pm-123 --add "<value>"');

      process.argv = ["node", "pm", "comments", "pm-123", "--add", "done"];
      const alreadyProvided = await resolveCommanderUsageContext(
        { message: "error: required option '--add <text>,' not specified" },
        program,
        new Map(),
      );
      expect(alreadyProvided.suggestedRetryCommand).toBeUndefined();

      process.argv = ["node", "pm", "comments", "pm-123"];
      const noRewrite = await resolveCommanderUsageContext(
        { message: "error: unknown option '--body'" },
        program,
        new Map(),
      );
      expect(noRewrite.unknownOptionSuggestions).toContain("--add");
      expect(noRewrite.suggestedRetryCommand).toBeUndefined();

      process.argv = ["node", "pm", "comments", "pm-123", "--json"];
      const mismatchRewrite = await resolveCommanderUsageContext(
        { message: "error: unknown option '--body'" },
        program,
        new Map(),
      );
      expect(mismatchRewrite.unknownOptionSuggestions).toContain("--add");
      expect(mismatchRewrite.suggestedRetryCommand).toBeUndefined();

      process.argv = ["node", "pm", "comments", "pm-123"];
      const compactMissing = await resolveCommanderUsageContext(
        { message: "error: required option '--add,;' not specified" },
        program,
        new Map(),
      );
      expect(compactMissing.suggestedRetryCommand).toBe('pm comments pm-123 --add "<value>"');

      process.argv = ["node", "pm", "comments", "pm-123", "--body=done"];
      const json = JSON.parse(await formatCommanderUsageJson({ message: "error: unknown option '--body'" }, program, new Map()));
      expect(json.recovery.suggested_retry).toContain("--add=done");

      const display = await formatCommanderUsageMessage({ message: "error: unknown option '--body'" }, program, new Map());
      expect(display).toContain("Unknown option --body");

      setActiveExtensionServices({
        overrides: [
          {
            layer: "project",
            name: "help-wrapper",
            service: "help_format",
            run: (context) => `wrapped:${(context.payload as { command?: string }).command}`,
          },
        ],
      });
      const wrapped = await formatCommanderUsageMessage({ message: "error: unknown option '--body'" }, program, new Map());
      expect(wrapped).toBe("wrapped:comments");
    } finally {
      setActiveExtensionServices(null);
      process.argv = previousArgv;
    }
  });
});

describe("CLI extension command help helpers", () => {
  it("formats extension descriptors, flags, metadata, hidden definitions, and invalid flag shapes", () => {
    const descriptors = collectExtensionCommandHelpDescriptors(
      ["tools export", "tools export", "tools sync"],
      [
        {
          layer: "project",
          name: "blank-ext",
          command: " ",
          action: "blank",
          examples: [],
          failure_hints: [],
          arguments: undefined,
        },
        {
          layer: "project",
          name: "minimal-ext",
          command: "minimal",
          action: " RUN ",
          examples: undefined as unknown as string[],
          failure_hints: [123, " ", "hint"] as unknown as string[],
          arguments: undefined,
        },
        {
          layer: "project",
          name: "tools-ext",
          source_package: "@unbrained/pm-tools",
          command: " Tools   Export ",
          action: " ",
          description: " Export assets ",
          intent: " Ship assets ",
          examples: ["pm tools export", "pm tools export", "", "pm tools export"],
          failure_hints: ["missing token", "missing token"],
          arguments: [
            { name: 123 },
            { name: " target ", required: true, variadic: true, description: " Target name " },
            { name: "plain", description: 123 },
            { name: " " },
          ],
        },
      ],
      [
        {
          target_command: "tools export",
          flags: [
            { long: "--plain" },
            {
              long: "--format",
              short: "-f",
              value_name: "kind",
              description: "Output format",
              required: true,
            },
            { long: "--hidden", visible: false },
            { long: "format", short: "--bad" },
            { long: "--disabled", description: "Disabled flag", enabled: false },
            { short: "-q", description: "Short only" },
          ],
        },
        { target_command: " ", flags: [{ long: "--ignored" }] },
      ],
    );

    const descriptor = descriptors.get("tools export");
    expect(descriptor).toMatchObject({
      command: "tools export",
      action: "tools-export",
      description: "Export assets",
      intent: "Ship assets",
      examples: ["pm tools export"],
      failure_hints: ["missing token"],
      arguments: expect.arrayContaining([{ name: "target", required: true, variadic: true, description: "Target name" }]),
      source: { layer: "project", name: "tools-ext", package: "@unbrained/pm-tools" },
    });
    expect(descriptors.get("tools sync")).toMatchObject({
      action: "tools-sync",
      examples: [],
      failure_hints: [],
      arguments: [],
    });
    expect(descriptors.has("")).toBe(false);
    expect(descriptors.get("minimal")).toMatchObject({
      action: "run",
      examples: [],
      failure_hints: ["hint"],
      arguments: [],
    });
    expect(descriptor?.arguments).toEqual(
      expect.arrayContaining([
        { name: "target", required: true, variadic: true, description: "Target name" },
        { name: "plain", required: false, variadic: false },
      ]),
    );

    const helpByCommand = collectDynamicExtensionFlagHelpByCommand([
      {
        target_command: " Tools Export ",
        flags: descriptor?.flags ?? [],
      },
    ]);
    expect(helpByCommand.get("tools export")).toContain("-f, --format <kind>  Output format [required]");
    expect(helpByCommand.get("tools export")).toContain("--plain  Extension-provided option.");
    expect(helpByCommand.get("tools export")).toContain("--disabled  Disabled flag [disabled]");
    expect(helpByCommand.get("tools export")).not.toContain("--hidden");
    expect(helpByCommand.get("tools export")).not.toContain("Short only");
    expect(collectDynamicExtensionFlagHelpByCommand([{ target_command: "", flags: [{ long: "--ignored" }] }]).size).toBe(0);
    expect(
      collectDynamicExtensionFlagHelpByCommand([{ target_command: "tools hidden", flags: [{ long: "--ignored", visible: false }] }]).size,
    ).toBe(0);

    const summaries = buildDynamicExtensionHelpOptionSummaries(descriptor);
    expect(summaries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          flags: "-f, --format <kind>",
          long: "--format",
          short: "-f",
          takes_value: true,
          value_required: true,
          required: true,
        }),
        expect.objectContaining({
          flags: "--disabled",
          description: "Disabled flag [disabled]",
          takes_value: false,
        }),
        expect.objectContaining({
          flags: "-q",
          long: null,
          short: "-q",
          description: "Short only",
        }),
      ]),
    );
    expect(buildDynamicExtensionHelpOptionSummaries(undefined)).toEqual([]);
    expect(mergeHelpOptionSummaries(summaries.slice(0, 1), summaries)).toHaveLength(summaries.length);

    const metadata = buildDynamicExtensionCommandMetadataHelp(descriptor!);
    expect(metadata).toContain("Intent: Ship assets");
    expect(metadata).toContain("Action contract: tools-export");
    expect(metadata).toContain("Examples:");
    expect(metadata).toContain("Common failure hints:");
    expect(buildDynamicExtensionCommandMetadataHelp({ command: "x", action: "", examples: [], failure_hints: [], arguments: [], flags: [] })).toBeNull();
  });

  it("applies dynamic extension arguments and parse options while compacting duplicates", () => {
    const descriptor = {
      command: "tools export",
      action: "tools-export",
      examples: [],
      failure_hints: [],
      arguments: [
        { name: "mode", required: false, variadic: false },
        { name: "target", required: true, variadic: true, description: "Target files" },
      ],
      flags: [
        { long: "--format", short: "-f", value_name: "kind", value_type: "string", description: "Output format" },
        { long: "--format", short: "-x", value_name: "kind", description: "Duplicate long" },
        { long: "--enabled", type: "boolean", description: "Boolean flag" },
        { short: "-q", description: "Short flag", required: true },
        { long: "--secret", visible: false },
        { long: "--bad", short: "--also-bad", visible: true },
        { long: " ", short: " " },
      ],
    };

    const command = new Command("export").exitOverride().configureOutput({ writeOut: () => {}, writeErr: () => {} });
    command.option("--existing", "Existing option");
    command.option("--format <kind>", "Already registered format");
    applyDynamicExtensionArguments(command, descriptor);
    applyDynamicExtensionFlagOptions(command, descriptor.flags);

    expect(command.registeredArguments.map((argument) => argument.required)).toEqual([false, true]);
    expect(command.registeredArguments.map((argument) => argument.variadic)).toEqual([false, true]);
    expect(command.options.map((option) => option.flags)).toEqual(
      expect.arrayContaining(["--existing", "--format <kind>", "--enabled", "-q <value>", "--bad"]),
    );
    expect(command.options.map((option) => option.flags)).not.toContain("--secret");
    expect(command.options.filter((option) => option.long === "--format")).toHaveLength(1);
    expect(command.options.find((option) => option.flags === "-q <value>")?.description).toBe("Short flag [required]");
  });

  it("finds, creates, and aliases extension command paths through normalized direct-child helpers", () => {
    const root = new Command().name("pm");
    const packageCommand = root.command("package").alias("pkg").description("Package");
    packageCommand.command("install").alias("add").description("Install");

    expect(commandAliases(packageCommand)).toEqual(["pkg"]);
    expect(findDirectChildCommand(root, "PKG")?.name()).toBe("package");
    expect(findDirectChildCommand(root, "missing")).toBeNull();
    expect(findCommandByPath(root, ["pkg", "add"])?.name()).toBe("install");
    expect(findCommandByPath(root, ["pkg", "missing"])).toBeNull();
    expect(ensureCommandPath(root, [])).toBeNull();
    expect(ensureCommandPath(root, ["package", "sync"])?.name()).toBe("sync");
    expect(ensureCommandPath(root, ["tools", "export"])?.description()).toBe("Extension-provided command path.");
    expect(findCommandByPath(root, ["tools"])?.description()).toBe("Extension-provided command group.");

    const fallbackAliasCommand = {
      aliases: undefined,
      alias: () => "Legacy",
    } as unknown as Command;
    expect(commandAliases(fallbackAliasCommand)).toEqual(["legacy"]);

    const privateAliasCommand = {
      aliases: undefined,
      alias: undefined,
      _aliases: [" Short ", ""],
    } as unknown as Command;
    expect(commandAliases(privateAliasCommand)).toEqual(["short"]);

    const noAliasCommand = {
      aliases: undefined,
      alias: () => " ",
      _aliases: undefined,
    } as unknown as Command;
    expect(commandAliases(noAliasCommand)).toEqual([]);
  });
});

describe("CLI rich help content", () => {
  it("renders bootstrap JSON help payloads for known commands", async () => {
    const program = new Command()
      .name("pm")
      .description("pm root")
      .exitOverride()
      .configureOutput({ writeOut: () => {}, writeErr: () => {} });
    program.option("--json", "JSON output");
    program.option("--quiet", "Suppress output");
    program
      .command("sample <id>")
      .alias("s")
      .description("Sample command")
      .option("--title <value>", "Title value")
      .option("--title-alias <value>", "Alias for --title")
      .option("--count [value]", "Optional count", "3");

    const originalExitCode = process.exitCode;
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const handled = await maybeRenderBootstrapJsonHelp(program, ["--json", "sample", "--help"], new Map());
      expect(handled).toBe(true);
      expect(process.exitCode).toBe(EXIT_CODE.SUCCESS);
      const payload = JSON.parse(writeSpy.mock.calls.map((call) => String(call[0])).join(""));
      expect(payload).toMatchObject({
        format: "pm_help_v1",
        root_command: "pm",
        requested_path: ["sample"],
        resolved_path: "sample",
        description: "Sample command",
        has_subcommands: false,
      });
      expect(payload.arguments).toEqual([
        {
          name: "id",
          required: true,
          variadic: false,
          description: null,
        },
      ]);
      expect(payload.options).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            long: "--title",
            aliases: ["--title-alias"],
            takes_value: true,
            value_required: true,
            value_name: "value",
          }),
          expect.objectContaining({
            long: "--count",
            takes_value: true,
            value_required: false,
            default_value: "3",
          }),
        ]),
      );
    } finally {
      writeSpy.mockRestore();
      process.exitCode = originalExitCode;
    }
  });

  it("returns usage JSON for unknown bootstrap JSON help requests", async () => {
    const program = new Command()
      .name("pm")
      .description("pm root")
      .exitOverride()
      .configureOutput({ writeOut: () => {}, writeErr: () => {} });
    program.option("--json", "JSON output");
    program.option("--quiet", "Suppress output");
    program.command("list").description("List items");

    const originalExitCode = process.exitCode;
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const handled = await maybeRenderBootstrapJsonHelp(program, ["--json", "lst", "--help"], new Map());
      expect(handled).toBe(true);
      expect(process.exitCode).toBe(EXIT_CODE.USAGE);
      const payload = JSON.parse(writeSpy.mock.calls.map((call) => String(call[0])).join(""));
      expect(payload).toMatchObject({
        code: "unknown_command",
        title: "Unknown command lst",
        recovery: expect.objectContaining({
          attempted_command: "pm --json lst --help",
        }),
      });
      expect(JSON.stringify(payload)).toContain("pm list");
    } finally {
      writeSpy.mockRestore();
      process.exitCode = originalExitCode;
    }
  });

  it("ignores non-json or non-help bootstrap invocations", async () => {
    const program = new Command().name("pm").option("--json", "JSON output");
    expect(await maybeRenderBootstrapJsonHelp(program, ["sample", "--help"], new Map())).toBe(false);
    expect(await maybeRenderBootstrapJsonHelp(program, ["--json", "sample"], new Map())).toBe(false);
  });

  it("renders type-aware create/update policy help text", () => {
    const registry = resolveItemTypeRegistry({
      item_types: {
        definitions: [
          {
            name: "Incident",
            aliases: ["inc"],
            folder: "incidents",
            required_create_fields: ["title", "type"],
            required_create_repeatables: ["comment"],
            options: [
              {
                key: "severity",
                values: ["low", "high"],
                required: true,
                aliases: ["sev"],
                description: "Incident severity",
              },
              {
                key: "customer",
                values: [],
              },
            ],
            command_option_policies: [
              { command: "create", option: "status", required: true },
              { command: "create", option: "body", enabled: false },
              { command: "create", option: "reviewer", visible: false },
              { command: "create", option: "not-a-real-option", required: true },
              { command: "update", option: "force", required: true },
            ],
          },
        ],
      },
    } as never);

    expect(helpJsonTestOnly.buildCreateUpdatePolicyHelpText("create", registry, ["create", "--help"])).toContain(
      "pass --type <value>",
    );
    expect(helpJsonTestOnly.buildCreateUpdatePolicyHelpText("create", registry, ["create", "--type", "Missing"])).toContain(
      'type "Missing" is not in the active registry',
    );

    const createText = helpJsonTestOnly.buildCreateUpdatePolicyHelpText("create", registry, [
      "create",
      "--type",
      "inc",
      "--help",
    ]);
    expect(createText).toContain("Type-aware option policies for Incident");
    expect(createText).toContain("required: --title, --description, --type, --comment, --status");
    expect(createText).toContain("disabled: --body");
    expect(createText).toContain("hidden: --reviewer");
    expect(createText).toContain("values: high|low");
    expect(createText).toContain("aliases: sev");
    expect(createText).toContain("description: Incident severity");
    expect(createText).toContain('Unsupported command_option_policies option "not-a-real-option"');
    expect(createText).toContain("values: any non-empty string");
    expect(createText).toContain("aliases: none");

    const updateText = helpJsonTestOnly.buildCreateUpdatePolicyHelpText("update", registry, ["update", "--type=Incident"]);
    expect(updateText).toContain("required: --force");

    const program = new Command().name("pm");
    program.command("create").description("Create item");
    helpJsonTestOnly.attachCreateUpdatePolicyHelpText(program, registry, ["list", "--help"]);
    helpJsonTestOnly.attachCreateUpdatePolicyHelpText(program, registry, ["update", "--type", "Incident"]);
    expect(() => helpJsonTestOnly.attachCreateUpdatePolicyHelpText(program, registry, ["create", "--type", "Incident"])).not.toThrow();
  });

  it("normalizes help command paths and resolves --explain detail mode", () => {
    expect(normalizeHelpCommandPath("  Package   INIT ")).toBe("package init");
    expect(normalizeHelpCommandPath("")).toBe("");
    expect(resolveHelpDetailMode(["list", "--explain"])).toBe("detailed");
    expect(resolveHelpDetailMode(["list", "--help"])).toBe("compact");
  });

  it("resolves command help bundles including aliases and the root fallback", () => {
    expect(resolveHelpBundleForPath(undefined)).toBe(ROOT_HELP_BUNDLE);
    expect(resolveHelpBundleForPath("   ")).toBe(ROOT_HELP_BUNDLE);
    expect(resolveHelpBundleForPath("no-such-command")).toBe(ROOT_HELP_BUNDLE);
    expect(resolveHelpBundleForPath("ctx")).toBe(resolveHelpBundleForPath("context"));
    expect(resolveHelpBundleForPath("list").why).toContain("Lists active items");
  });

  it("builds compact and detailed help narratives", () => {
    const compact = resolveHelpNarrative("create", "compact");
    expect(compact.examples).toHaveLength(1);
    expect(compact.tips).toEqual([]);
    expect(compact.detail_mode).toBe("compact");

    const detailed = resolveHelpNarrative("create", "detailed");
    expect(detailed.examples.length).toBeGreaterThan(1);
    expect(detailed.tips.length).toBeGreaterThan(0);
    expect(detailed.intent).toBe(compact.intent);

    // list-blocked has no tips; detailed narratives still resolve cleanly.
    expect(resolveHelpNarrative("list-blocked", "detailed").tips).toEqual([]);
  });

  it("attaches compact help text only to commands that exist on the program", () => {
    const capture = (helpArgv: string[], detailArgv: string[]): string => {
      let out = "";
      const program = new Command().name("pm");
      program.exitOverride().configureOutput({
        writeOut: (chunk) => {
          out += chunk;
        },
        writeErr: () => {},
      });
      program.command("list").description("List items");
      const packageCommand = program.command("package").description("Packages");
      packageCommand.command("init").description("Scaffold");
      attachRichHelpText(program, detailArgv);
      try {
        program.parse(helpArgv, { from: "user" });
      } catch {
        // commander.helpDisplayed via exitOverride
      }
      return out;
    };

    expect(capture(["--help"], ["--help"])).toContain(ROOT_HELP_BUNDLE.why);
    const listHelp = capture(["list", "--help"], ["--help"]);
    expect(listHelp).toContain("Intent:");
    expect(listHelp).toContain("Re-run with --explain.");
    expect(capture(["package", "init", "--help"], ["--help"])).toContain("Intent:");
  });

  it("renders detailed bundles with tips under --explain", () => {
    let out = "";
    const program = new Command().name("pm");
    program.exitOverride().configureOutput({
      writeOut: (chunk) => {
        out += chunk;
      },
      writeErr: () => {},
    });
    program.command("init").description("Initialize");
    attachRichHelpText(program, ["init", "--explain"]);
    try {
      program.parse(["init", "--help"], { from: "user" });
    } catch {
      // commander.helpDisplayed via exitOverride
    }

    expect(out).toContain("Why use this command:");
    expect(out).toContain("Tips:");
    expect(out).not.toContain("Re-run with --explain.");
  });
});
