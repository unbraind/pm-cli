import fs from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

import { _testOnly } from "../../src/cli/main.js";
import {
  clearActiveExtensionHooks,
  getActiveCommandResult,
  setActiveCommandResult,
  setActiveExtensionCommands,
  setActiveExtensionParsers,
  setActiveExtensionRegistrations,
  setActiveExtensionServices,
} from "../../src/core/extensions/index.js";
import { createEmptyExtensionRegistrationRegistry } from "../../src/core/extensions/loader.js";
import { _testOnly as helpJsonTestOnly, maybeRenderBootstrapJsonHelp } from "../../src/cli/help-json-payload.js";
import {
  applyBootstrapPagerPolicy,
  coalesceRepeatedListFlags,
  listAliasPluralKeys,
  mergeLinkedTestTwoTokenEntries,
  normalizeBootstrapInvocation,
  normalizeLegacyExtensionActionSyntax,
  parseBootstrapGlobalOptions,
  parseBootstrapCommandName,
  parseBootstrapHelpRequest,
  parseBootstrapTypeValue,
  stripGlobalBootstrapTokens,
} from "../../src/cli/bootstrap-args.js";
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
import {
  ROOT_HELP_BUNDLE,
  attachRichHelpText,
  normalizeHelpCommandPath,
  resolveHelpBundleForPath,
  resolveHelpDetailMode,
  resolveHelpNarrative,
} from "../../src/cli/help-content.js";
import {
  buildLinkedTestQuotedRetryCommand,
  classifyCommanderError,
  classifyPmCliError,
  classifyUnknownError,
  formatCommanderErrorForDisplay,
  formatCommanderErrorForJson,
  formatPmCliErrorForDisplay,
  formatPmCliErrorForJson,
  formatUnknownErrorForJson,
  renderGuidanceMessage,
} from "../../src/cli/error-guidance.js";
import {
  listGuideTopicIds,
  listGuideTopics,
  resolveGuideTopic,
} from "../../src/cli/guide-topics.js";
import {
  collectMandatoryMigrationBlockers,
  decideWriteGate,
  enforceItemFormatWriteGateAndPreflightMigration,
  enforceMandatoryMigrationWriteGate,
  resolveMigrationId,
  resolveNormalizedMigrationStatus,
} from "../../src/cli/migration-gates.js";
import { EXIT_CODE } from "../../src/core/shared/constants.js";
import { resolveItemTypeRegistry } from "../../src/core/item/type-registry.js";
import { writeTestExtension } from "../helpers/extensions.js";
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
  _testOnly.setActiveExtensionHookContextForTest(null);
  clearActiveExtensionHooks();
  setActiveExtensionCommands(null);
  setActiveExtensionRegistrations(null);
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

async function captureStderrAsync(run: () => Promise<void>): Promise<string> {
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
    await run();
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

  it("logs handled expected errors to Sentry when explicitly opted in", async () => {
    const previous = process.env.PM_SENTRY_CAPTURE_EXPECTED_ERRORS;
    try {
      process.env.PM_SENTRY_CAPTURE_EXPECTED_ERRORS = "true";
      await expect(
        _testOnly.maybeLogHandledCliErrorToSentry({
          command: "list",
          error_code: "invalid_command_usage",
          error_category: "usage",
          exit_code: EXIT_CODE.USAGE,
          error_message: "expected usage error",
          command_resolution: "invalid_usage",
          resolution_stage: "parse",
        }),
      ).resolves.toBe(true);
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

  it("covers linked-test retry and guidance helper empty inputs", () => {
    expect(buildLinkedTestQuotedRetryCommand(undefined)).toBeUndefined();
    expect(buildLinkedTestQuotedRetryCommand(["pm", "list", "--add", "command", "npm", "test"])).toBeUndefined();
    expect(buildLinkedTestQuotedRetryCommand(["pm", "test", "--add", "command", "npm", "test"])).toBeUndefined();
    expect(
      renderGuidanceMessage({
        title: "Needs input",
        happened: "A required value is missing.",
        required: "Provide the value.",
      }),
    ).toContain("Error: Needs input");
  });
});

describe("CLI bootstrap and usage helper tails", () => {
  it("covers bootstrap normalization tie and value-consuming branches", () => {
    expect(listAliasPluralKeys("story")).toEqual(["storys", "stories"]);

    const repeated = coalesceRepeatedListFlags(["--title", "--literal-flag"], new Set(["--tag"]), new Set(["--title"]));
    expect(repeated.argv).toEqual(["--title", "--literal-flag"]);

    const normalized = normalizeBootstrapInvocation(["create", "--titel", "x"], {
      knownFlags: ["--title", "--tile"],
      listFlags: [],
      valueConsumingFlags: [],
    });
    expect(normalized.trace.some((event) => event.reason === "flag_typo")).toBe(true);

    expect(stripGlobalBootstrapTokens(["create", "--title", "x"], new Set(["--json"]))).toEqual(["create", "--title", "x"]);
  });

  it("covers command usage ranking and package hint empty branches", async () => {
    const command = new Command("pm");
    command.exitOverride();
    command.command("alpha").option("--beta <value>").option("--bet <value>");
    command.command("beta").option("--alpha <value>");

    const previousArgv = process.argv;
    process.argv = ["node", "pm", "alpha", "--bta"];
    try {
      const emptyContext = await resolveCommanderUsageContext(
        new Error("error: unknown option '--bta'"),
        command,
        new Map(),
      );
      expect(emptyContext.commandName).toBe("alpha");
      expect(emptyContext.attemptedCommand).toBe("pm alpha --bta");
      expect(emptyContext.normalizedInvocationArgs).toEqual(["alpha", "--bta"]);
    } finally {
      process.argv = previousArgv;
    }

    process.argv = ["node", "pm", "alpha", "--bta"];
    const ranked = await formatCommanderUsageJson(new Error("error: unknown option '--bta'"), command, new Map());
    process.argv = previousArgv;
    expect(ranked).toContain("Unknown option --bta");

    process.argv = ["node", "pm", "unknown", "--help"];
    const message = await formatCommanderUsageMessage(new Error("error: unknown command 'unknown'"), command, new Map());
    process.argv = previousArgv;
    expect(message).toContain("Unknown command");
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
      expect(cliModule._testOnly.readPackageVersionForPath(nested)).toBe("9.8.7");

      const missingVersionRoot = await mkdtemp(path.join(os.tmpdir(), "pm-cli-version-missing-"));
      const invalidJsonRoot = await mkdtemp(path.join(os.tmpdir(), "pm-cli-version-invalid-"));
      await mkdir(path.join(missingVersionRoot, "nested"), { recursive: true });
      await mkdir(path.join(invalidJsonRoot, "nested"), { recursive: true });
      await writeFile(path.join(missingVersionRoot, "package.json"), JSON.stringify({ name: "no-version" }), "utf8");
      await writeFile(path.join(invalidJsonRoot, "package.json"), "{", "utf8");
      try {
        expect(cliModule._testOnly.readPackageVersionForPath(path.join(missingVersionRoot, "nested", "cli.js"))).toBeUndefined();
        expect(cliModule._testOnly.readPackageVersionForPath(path.join(invalidJsonRoot, "nested", "cli.js"))).toBeUndefined();
      } finally {
        await rm(missingVersionRoot, { recursive: true, force: true });
        await rm(invalidJsonRoot, { recursive: true, force: true });
      }

      logSpy.mockClear();
      process.argv = ["node", "pm", "--no-extensions", "-V"];
      expect(cliModule._testOnly.printFastVersionIfRequested()).toBe(true);
      expect(logSpy.mock.calls.map((call) => String(call[0])).join("").trim()).toMatch(/^\d{4}\.\d+\.\d+$/);

      process.argv = ["node", "pm", "--no-extensions", "--version", "--json"];
      expect(cliModule._testOnly.printFastVersionIfRequested()).toBe(false);
      expect(cliModule._testOnly.readPackageVersionForPath(path.parse(tempRoot).root)).toBeUndefined();

      const existsSpy = vi.spyOn(fs, "existsSync").mockReturnValue(false);
      try {
        process.argv = ["node", "pm", "--version"];
        expect(cliModule._testOnly.printFastVersionIfRequested()).toBe(false);
      } finally {
        existsSpy.mockRestore();
      }

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

  it("falls through the direct cli.ts entrypoint when fast-version arguments do not match", async () => {
    await withTempPmPath(async (context) => {
      const previousArgv = process.argv;
      const previousExitCode = process.exitCode;
      const changedEnvKeys = Object.keys(context.env).filter((key) => context.env[key] !== process.env[key]);
      const previousEnv = new Map(changedEnvKeys.map((key) => [key, process.env[key]]));
      const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        for (const key of changedEnvKeys) {
          const value = context.env[key];
          if (value === undefined) {
            delete process.env[key];
          } else {
            process.env[key] = value;
          }
        }
        process.argv = ["node", path.resolve("src/cli.ts"), "--no-extensions", "--json", "--version"];
        process.exitCode = undefined;
        const cliUrl = pathToFileURL(path.resolve("src/cli.ts"));
        cliUrl.search = `?entryFallthrough=${Date.now()}-${Math.random().toString(16).slice(2)}`;
        await import(cliUrl.href);

        expect(process.exitCode ?? EXIT_CODE.SUCCESS).toBe(EXIT_CODE.SUCCESS);
        expect(stdoutSpy.mock.calls.map((call) => String(call[0])).join("").trim()).toMatch(/^\d{4}\.\d+\.\d+$/);
        expect(stderrSpy).not.toHaveBeenCalled();
      } finally {
        stdoutSpy.mockRestore();
        stderrSpy.mockRestore();
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

      const bareHelp = await runSourceCli([], context.env);
      expect(bareHelp.code).toBe(EXIT_CODE.SUCCESS);
      expect(bareHelp.stdout).toContain("Usage: pm");
      expect(bareHelp.stderr).toBe("");

      const jsonHelp = await runSourceCli(["--json", "--help"], context.env);
      expect(jsonHelp.code).toBe(EXIT_CODE.SUCCESS);
      expect(jsonHelp.stdout).toContain('"format": "pm_help_v1"');
      expect(jsonHelp.stderr).toBe("");

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

      const nonJsonCommander = await runSourceCli(["--no-extensions", "list", "--definitely-not-real"], {
        ...context.env,
        PM_SENTRY_CAPTURE_EXPECTED_ERRORS: "true",
      });
      expect(nonJsonCommander.code).toBe(EXIT_CODE.USAGE);
      expect(nonJsonCommander.stdout).toBe("");
      expect(nonJsonCommander.stderr).toContain("Unknown option");
      expect(nonJsonCommander.stderr).toContain("attempted_command: pm --no-extensions list --definitely-not-real");

      const commanderWithRecoveryDiscovery = await runSourceCli(["--json", "list", "--definitely-not-real"], context.env);
      expect(commanderWithRecoveryDiscovery.code).toBe(EXIT_CODE.USAGE);
      expect(commanderWithRecoveryDiscovery.stdout).toBe("");
      expect(JSON.parse(commanderWithRecoveryDiscovery.stderr)).toMatchObject({
        code: "unknown_option",
      });

      const unknownHelp = await runSourceCli(["--no-extensions", "definitely-missing", "--help"], context.env);
      expect(unknownHelp.code).toBe(EXIT_CODE.USAGE);
      expect(unknownHelp.stdout).toContain("Usage: pm");
      expect(unknownHelp.stderr).toContain("Unknown command definitely-missing");

      const missingItem = await runSourceCli(["--no-extensions", "get", "pm-does-not-exist"], {
        ...context.env,
        PM_SENTRY_CAPTURE_EXPECTED_ERRORS: "true",
      });
      expect(missingItem.code).toBe(EXIT_CODE.NOT_FOUND);
      expect(missingItem.stdout).toBe("");
      expect(missingItem.stderr).toContain("Error: Item ID not found");
      expect(missingItem.stderr).toContain("attempted_command: pm --no-extensions get pm-does-not-exist");
    });
  });

  it("renders generic runPmCli failures through JSON and display handlers", async () => {
    const previousExitCode = process.exitCode;
    const emitTelemetryCommandError = vi.fn(async () => ({
      errorCategory: "runtime" as const,
      commandResolution: "runtime_failed" as const,
    }));
    try {
      const jsonStderr = await captureStderrAsync(async () => {
        await _testOnly.handleGenericRunPmCliError({
          error: new Error("generic extension failure"),
          attemptedCommand: "boom",
          bootstrapGlobal: { json: true } as never,
          emitTelemetryCommandError,
        });
      });
      expect(process.exitCode).toBe(EXIT_CODE.GENERIC_FAILURE);
      expect(emitTelemetryCommandError).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "boom",
          errorCode: "unknown_error",
          errorMessage: "generic extension failure",
          exitCode: EXIT_CODE.GENERIC_FAILURE,
          resolutionStage: "execute",
        }),
      );
      expect(JSON.parse(jsonStderr)).toMatchObject({
        code: "unknown_error",
        title: "Unhandled error",
        exit_code: EXIT_CODE.GENERIC_FAILURE,
      });

      const displayStderr = await captureStderrAsync(async () => {
        await _testOnly.handleGenericRunPmCliError({
          error: "string failure",
          attemptedCommand: "boom",
          bootstrapGlobal: { json: false } as never,
          emitTelemetryCommandError,
        });
      });
      expect(displayStderr.trim()).toBe("Unknown failure");

      const reportingFailureStderr = await captureStderrAsync(async () => {
        await _testOnly.handleGenericRunPmCliError({
          error: new Error("visible before telemetry"),
          attemptedCommand: "boom",
          bootstrapGlobal: { json: false } as never,
          emitTelemetryCommandError: vi.fn(async () => {
            throw new Error("telemetry stalled");
          }),
        });
      });
      expect(reportingFailureStderr).toContain("visible before telemetry");
      expect(reportingFailureStderr).toContain("Failed to report error: telemetry stalled");
      expect(reportingFailureStderr.indexOf("visible before telemetry")).toBeLessThan(
        reportingFailureStderr.indexOf("Failed to report error: telemetry stalled"),
      );
    } finally {
      process.exitCode = previousExitCode;
    }
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
    expect(_testOnly.resolveCoreCommandRegistrationSelection(["config"])).toEqual({
      setup: true,
      listQuery: false,
      mutation: false,
      operation: false,
      targetCommandName: "config",
    });
    expect(_testOnly.resolveCoreCommandRegistrationSelection(["create"])).toMatchObject({
      mutation: true,
      targetCommandName: "create",
    });
    expect(_testOnly.resolveCoreCommandRegistrationSelection(["health"])).toMatchObject({
      operation: true,
      targetCommandName: "health",
    });
    expect(_testOnly.resolveCoreCommandRegistrationSelection(["--json"])).toMatchObject({
      setup: true,
      listQuery: true,
      mutation: true,
      operation: true,
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
    expect(_testOnly.shouldRegisterRuntimeSchemaFlags(["--json"])).toBe(false);
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
    expect(_testOnly.commandPathNeedsTemplateExtensions({ commandPath: "create", commandArgs: ["--template", "bug"] })).toBe(true);
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
    _testOnly.addRuntimeFieldOption(command, "-r", "Reviewer", true);
    _testOnly.addRuntimeFieldOption(command, "--score", "Score", false);

    expect(command.options.map((option) => option.flags)).toEqual(
      expect.arrayContaining([
        "--customer-segment <value>",
        "-s <value>",
        "--segment <value>",
        "-u <value>",
        "-r <value>",
        "--score <value>",
      ]),
    );
    expect(command.options.filter((option) => option.long === "--customer-segment")).toHaveLength(1);
    expect(command.options.filter((option) => option.short === "-s")).toHaveLength(1);
    expect(command.options.find((option) => option.long === "--segment")?.description).toBe("Segment (repeatable)");
    expect(command.options.find((option) => option.short === "-u")?.description).toBe("Runtime schema field (-u)");
    expect(command.options.find((option) => option.short === "-r")?.description).toBe("Reviewer (repeatable)");
    expect(_testOnly.commandHasLongOption(command, "--score")).toBe(true);
    expect(_testOnly.commandHasShortOption(command, "-u")).toBe(true);
    expect(_testOnly.commandHasLongOption(command, "--missing")).toBe(false);
    expect(_testOnly.commandHasShortOption(command, "-x")).toBe(false);
  });

  it("loads runtime schema loose flag definitions and registers command options from settings", async () => {
    const missingSettingsRoot = await mkdtemp(path.join(os.tmpdir(), "pm-runtime-flags-missing-"));
    try {
      expect(await _testOnly.collectRuntimeFieldLooseFlagDefinitionsForCommand("health", missingSettingsRoot)).toEqual([]);
      expect(await _testOnly.collectRuntimeFieldLooseFlagDefinitionsForCommand("create", missingSettingsRoot)).toEqual([]);
      expect(await _testOnly.collectRuntimeFieldLooseFlagDefinitionsForCommand("create", missingSettingsRoot)).toEqual([]);
    } finally {
      await rm(missingSettingsRoot, { recursive: true, force: true });
    }

    const schemaRoot = await mkdtemp(path.join(os.tmpdir(), "pm-runtime-flags-schema-"));
    try {
      const pmRoot = path.join(schemaRoot, ".agents", "pm");
      const settingsPath = path.join(pmRoot, "settings.json");
      await mkdir(path.dirname(settingsPath), { recursive: true });
      await writeFile(
        settingsPath,
        `${JSON.stringify({
          version: 1,
          id_prefix: "pm-",
          author_default: "test-author",
          locks: { ttl_seconds: 1800 },
          output: { default_format: "toon" },
          extensions: { enabled: [], disabled: [] },
          search: {
            score_threshold: 0,
            hybrid_semantic_weight: 0.7,
            max_results: 50,
            embedding_model: "",
            embedding_batch_size: 32,
            scanner_max_batch_retries: 3,
          },
          providers: {
            openai: { base_url: "", api_key: "", model: "" },
            ollama: { base_url: "", model: "" },
          },
          vector_store: {
            qdrant: { url: "", api_key: "" },
            lancedb: { path: "" },
          },
          schema: {
            fields: [
              {
                key: "customer_segment",
                type: "string",
                cli_flag: "segment",
                cli_aliases: ["cust-seg"],
                commands: ["create"],
                description: "Customer segment",
              },
              {
                key: "risk_score",
                type: "number",
                cli_flag: "risk-score",
                commands: ["create"],
              },
            ],
          },
        })}\n`,
        "utf8",
      );

      await expect(_testOnly.collectRuntimeFieldLooseFlagDefinitionsForCommand("create", pmRoot)).resolves.toEqual([
        { long: "--segment", type: "string", value_type: "string" },
        { long: "--cust-seg", type: "string", value_type: "string" },
        { long: "--risk-score", type: "number", value_type: "number" },
      ]);

      const root = new Command().name("pm");
      root.command("create").option("--segment <value>", "Existing field");
      root.command("list");
      await _testOnly.registerRuntimeSchemaFieldFlags(root, ["--pm-path", pmRoot, "create"]);

      const create = root.commands.find((command) => command.name() === "create");
      expect(create?.options.map((option) => option.flags)).toEqual(
        expect.arrayContaining(["--segment <value>", "--cust-seg <value>", "--risk-score <value>"]),
      );
      expect(create?.options.filter((option) => option.long === "--segment")).toHaveLength(1);
    } finally {
      await rm(schemaRoot, { recursive: true, force: true });
    }
  });

  it("returns no runtime schema flags when a tracker has no settings file", async () => {
    const missingSettingsRoot = await mkdtemp(path.join(os.tmpdir(), "pm-runtime-register-missing-"));
    try {
      const root = new Command().name("pm");
      root.command("create");
      await expect(
        _testOnly.registerRuntimeSchemaFieldFlags(root, ["--pm-path", missingSettingsRoot, "create"]),
      ).resolves.toBeUndefined();
      expect(root.commands.find((command) => command.name() === "create")?.options).toHaveLength(0);
    } finally {
      await rm(missingSettingsRoot, { recursive: true, force: true });
    }
  });

  it("covers bootstrap warning and policy-help helper fallbacks", async () => {
    expect(_testOnly.invocationRequestsVersion(["--json", "-V"])).toBe(true);
    expect(_testOnly.invocationRequestsVersion(["--json", "list"])).toBe(false);
    expect(_testOnly.wrapThrownErrorForSentry(new Error("already wrapped"), "fallback").message).toBe("already wrapped");
    expect(_testOnly.readRecordBoolean(null, "enabled")).toBeUndefined();
    expect(_testOnly.readRecordNumber(null, "count")).toBeUndefined();
    expect(_testOnly.inferPostActionErrorCode(false, EXIT_CODE.USAGE)).toBe("invalid_command_usage");

    const settingsWarning = captureStderrSync(() =>
      _testOnly.emitSettingsReadWarnings(["schema_bootstrap_created", "settings_read_invalid_json"]),
    );
    expect(settingsWarning).toContain("settings_read_invalid_json");
    expect(settingsWarning).not.toContain("schema_bootstrap_created");

    await expect(
      _testOnly.maybeLogHandledCliErrorToSentry({
        command: "list",
        error_code: "invalid_command_usage",
        error_category: "usage",
        exit_code: EXIT_CODE.USAGE,
        error_message: "expected usage error",
      }),
    ).resolves.toBe(false);

    const program = new Command().name("pm");
    program.command("create").description("Create item");
    await expect(
      _testOnly.maybeAttachCreateUpdatePolicyHelpText(
        program,
        "/path/that/does/not/exist",
        ["list", "--help"],
        { item_types: [] } as never,
      ),
    ).resolves.toBeUndefined();
    await expect(
      _testOnly.maybeAttachCreateUpdatePolicyHelpText(
        program,
        "/path/that/does/not/exist",
        ["create", "--help"],
        { item_types: [] } as never,
      ),
    ).resolves.toBeUndefined();
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
    expect(_testOnly.probeUsesAnyFlag({ commandArgs: ["--template", "bug"] }, new Set(["--template"]))).toBe(true);
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

  it("loads extension discovery and activation snapshots with command descriptors", async () => {
    await withTempPmPath(async (context) => {
      await writeTestExtension({
        root: path.join(context.pmPath, "extensions"),
        directory: "snapshot-tools",
        manifest: {
          name: "snapshot-tools",
          capabilities: ["commands", "schema"],
          entry: "./index.mjs",
        },
        entryFilename: "index.mjs",
        entrySource: `
export default {
  activate(api) {
    api.registerCommand({
      name: "tools export",
      action: "tools-export",
      description: "Export tool state",
      intent: "Export state from a runtime extension",
      examples: ["pm tools export --format json"],
      failure_hints: ["Choose a supported format"],
      arguments: [{ name: "target", required: false, description: "Target name" }],
      flags: [{ long: "--format", value_name: "kind", description: "Output format", required: true }],
      run(context) {
        return { ok: true, command: context.command, args: context.args, format: context.options.format };
      }
    });
  }
};
`,
      });

      const discovery = await _testOnly.loadRuntimeExtensionDiscoverySnapshot(context.pmPath);
      expect(discovery?.discovery.effective.map((extension) => extension.name)).toContain("snapshot-tools");
      expect(await _testOnly.loadRuntimeExtensionDiscoverySnapshot(context.pmPath)).toBe(discovery);

      const snapshot = await _testOnly.loadRuntimeExtensionSnapshot(context.pmPath);
      expect(snapshot?.commandHandlers).toEqual(["tools export"]);
      expect(snapshot?.commandDescriptors.get("tools export")).toMatchObject({
        action: "tools-export",
        description: "Export tool state",
        intent: "Export state from a runtime extension",
      });
      expect(snapshot?.commandFlagHelp.get("tools export")).toContain("--format");
      expect(snapshot?.loadedCount).toBe(1);
      expect(await _testOnly.loadRuntimeExtensionSnapshot(context.pmPath)).toBe(snapshot);

      const recoveryDescriptors = await _testOnly.loadRuntimeExtensionCommandDescriptorsForRecovery(context.pmPath);
      expect(recoveryDescriptors.get("tools export")?.failure_hints).toEqual(["Choose a supported format"]);
    });
  });

  it("caches extension snapshots with settings-read warnings", async () => {
    const brokenRoot = await mkdtemp(path.join(os.tmpdir(), "pm-runtime-broken-"));
    try {
      await mkdir(path.join(brokenRoot, "config"), { recursive: true });
      await writeFile(path.join(brokenRoot, "settings.json"), "{", "utf8");

      const discovery = await _testOnly.loadRuntimeExtensionDiscoverySnapshot(brokenRoot);
      expect(discovery?.settingsReadWarnings).toContain("settings_read_invalid_json");
      expect(await _testOnly.loadRuntimeExtensionDiscoverySnapshot(brokenRoot)).toBe(discovery);
      const snapshot = await _testOnly.loadRuntimeExtensionSnapshot(brokenRoot);
      expect(snapshot?.settings).toStrictEqual(discovery?.settings);
      expect(snapshot?.loadWarnings).toEqual([]);
      expect(await _testOnly.loadRuntimeExtensionSnapshot(brokenRoot)).toBe(snapshot);
      await expect(_testOnly.loadRuntimeExtensionCommandDescriptorsForRecovery(brokenRoot)).resolves.toBeInstanceOf(Map);
    } finally {
      await rm(brokenRoot, { recursive: true, force: true });
    }
  });

  it("caches null extension snapshots when the tracker root cannot be traversed", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pm-runtime-file-root-"));
    const fileRoot = path.join(tempRoot, "not-a-directory");
    try {
      await writeFile(fileRoot, "not a tracker directory", "utf8");

      await expect(_testOnly.loadRuntimeExtensionDiscoverySnapshot(fileRoot)).resolves.toBeNull();
      await expect(_testOnly.loadRuntimeExtensionDiscoverySnapshot(fileRoot)).resolves.toBeNull();
      await expect(_testOnly.loadRuntimeExtensionSnapshot(fileRoot)).resolves.toBeNull();
      await expect(_testOnly.loadRuntimeExtensionSnapshot(fileRoot)).resolves.toBeNull();
      await expect(_testOnly.loadRuntimeExtensionCommandDescriptorsForRecovery(fileRoot)).resolves.toBeInstanceOf(Map);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("skips runtime extension activation for no-extension and no-op discovery paths", async () => {
    const missingRoot = await mkdtemp(path.join(os.tmpdir(), "pm-runtime-noext-"));
    try {
      const noExtensions = new Command("list");
      noExtensions.option("--no-extensions", "Disable extensions");
      noExtensions.option("--pm-path <dir>", "PM path");
      noExtensions.setOptionValue("extensions", false);
      noExtensions.setOptionValue("pmPath", missingRoot);

      await expect(_testOnly.maybeLoadRuntimeExtensions(noExtensions)).resolves.toBeNull();
    } finally {
      await rm(missingRoot, { recursive: true, force: true });
    }

    await withTempPmPath(async (context) => {
      const root = new Command().name("pm");
      root.option("--pm-path <dir>", "PM path");
      root.option("--profile", "Profile");
      const list = root.command("list");
      list.option("--pm-path <dir>", "PM path");
      list.option("--profile", "Profile");
      list.setOptionValue("pmPath", context.pmPath);
      list.setOptionValue("profile", true);

      const stderr = await captureStderrAsync(async () => {
        await expect(_testOnly.maybeLoadRuntimeExtensions(list)).resolves.toBeNull();
      });
      expect(stderr).toContain("profile:extensions activation=skipped command=list");
    });
  });

  it("returns null when runtime extension activation snapshot loading fails after discovery", async () => {
    await withTempPmPath(async (context) => {
      await writeTestExtension({
        root: path.join(context.pmPath, "extensions"),
        directory: "late-broken",
        manifest: {
          name: "late-broken",
          capabilities: ["commands"],
          activation: { commands: ["late"] },
          entry: "./missing.mjs",
        },
      });

      const root = new Command().name("pm");
      root.option("--pm-path <dir>", "PM path").option("--profile", "Profile");
      const late = root.command("late");
      late.setOptionValue("pmPath", context.pmPath);
      late.setOptionValue("profile", true);

      const stderr = await captureStderrAsync(async () => {
        await expect(_testOnly.maybeLoadRuntimeExtensions(late)).resolves.toBeNull();
      });
      expect(stderr).toContain("profile:extensions");
    });
  });

  it("loads runtime extension registries for an activated command", async () => {
    await withTempPmPath(async (context) => {
      await writeTestExtension({
        root: path.join(context.pmPath, "extensions"),
        directory: "activated-tools",
        manifest: {
          name: "activated-tools",
          capabilities: ["commands", "hooks", "parser", "preflight", "schema"],
          activation: { commands: ["tools"] },
          entry: "./index.mjs",
        },
        entryFilename: "index.mjs",
        entrySource: `
export default {
  activate(api) {
    api.registerParser("tools", (context) => context);
    api.registerPreflight((context) => context);
    api.hooks.beforeCommand(() => undefined);
    api.hooks.afterCommand(() => undefined);
    api.registerMigration({ id: "activated-tools-migration", status: "applied", mandatory: true });
    api.registerCommand({
      name: "tools",
      description: "Activated tools",
      run: () => ({ ok: true })
    });
  }
};
`,
      });

      const root = new Command().name("pm");
      root.option("--pm-path <dir>", "PM path").option("--profile", "Profile");
      const tools = root.command("tools");
      tools.setOptionValue("pmPath", context.pmPath);
      tools.setOptionValue("profile", true);

      const stderr = await captureStderrAsync(async () => {
        const runtime = await _testOnly.maybeLoadRuntimeExtensions(tools);
        expect(runtime).not.toBeNull();
        expect(runtime?.pmRoot).toBe(context.pmPath);
        expect(runtime?.hooks.beforeCommand).toHaveLength(1);
        expect(runtime?.hooks.afterCommand).toHaveLength(1);
        expect(runtime?.commands.handlers.map((handler) => handler.command)).toContain("tools");
        expect(runtime?.parsers.overrides.map((parser) => parser.command)).toContain("tools");
        expect(runtime?.preflight.overrides).toHaveLength(1);
        expect(runtime?.registrations.migrations.map((migration) => migration.definition.id)).toContain("activated-tools-migration");
      });
      expect(stderr).toContain("profile:extensions loaded=1");
    });
  });

  it("runs the global preAction and postAction extension lifecycle for activated core commands", async () => {
    await withTempPmPath(async (context) => {
      await writeTestExtension({
        root: path.join(context.pmPath, "extensions"),
        directory: "lifecycle-tools",
        manifest: {
          name: "lifecycle-tools",
          capabilities: ["hooks", "parser", "preflight", "schema"],
          activation: { commands: ["list"] },
          entry: "./index.mjs",
        },
        entryFilename: "index.mjs",
        entrySource: `
export default {
  activate(api) {
    api.registerParser("list", () => {
      throw new Error("parser warning");
    });
    api.registerPreflight(() => {
      throw new Error("preflight warning");
    });
    api.registerMigration({ id: "lifecycle-applied", status: "applied", mandatory: true });
    api.registerMigration({
      id: "lifecycle-fails",
      status: "pending",
      run: () => {
        throw new Error("migration warning");
      }
    });
    api.hooks.beforeCommand(() => {
      throw new Error("before warning");
    });
    api.hooks.afterCommand(() => {
      throw new Error("after warning");
    });
  }
};
`,
      });

      const result = await runSourceCli(["--pm-path", context.pmPath, "--profile", "list"], context.env);

      expect(result.code).toBe(EXIT_CODE.SUCCESS);
      expect(result.stdout).toContain("count: 0");
      expect(result.stderr).toContain("profile:extensions loaded=1");
      expect(result.stderr).toContain("profile:extensions parser_warnings=extension_parser_override_failed");
      expect(result.stderr).toContain("profile:extensions preflight_warnings=extension_preflight_override_failed");
      expect(result.stderr).toContain("profile:extensions migration_warnings=extension_migration_failed");
      expect(result.stderr).toContain("profile:extensions hook_warnings=extension_hook_failed");
      expect(result.stderr).toContain("[pm] warning: afterCommand hook_warnings=extension_hook_failed");
    });
  });

  it("uses activated extension services during parse-error recovery", async () => {
    await withTempPmPath(async (context) => {
      await writeTestExtension({
        root: path.join(context.pmPath, "extensions"),
        directory: "parse-recovery-tools",
        manifest: {
          name: "parse-recovery-tools",
          capabilities: ["commands", "services"],
          activation: { commands: ["list"] },
          entry: "./index.mjs",
        },
        entryFilename: "index.mjs",
        entrySource: `
export default {
  activate(api) {
    api.registerCommand({ name: "list", run: () => ({ ok: true }) });
    api.registerService("output", (context) => ({ handled: false, result: context.payload, warnings: [] }));
  }
};
`,
      });

      const result = await runSourceCli(["--pm-path", context.pmPath, "--json", "list", "--definitely-not-real"], context.env);

      expect(result.code).toBe(EXIT_CODE.USAGE);
      expect(result.stdout).toBe("");
      expect(JSON.parse(result.stderr)).toMatchObject({
        code: "unknown_option",
      });
    });
  });

  it("registers and runs dynamic extension command paths", async () => {
    await withTempPmPath(async (context) => {
      await writeTestExtension({
        root: path.join(context.pmPath, "extensions"),
        directory: "dynamic-tools",
        manifest: {
          name: "dynamic-tools",
          capabilities: ["commands", "schema"],
          entry: "./index.mjs",
        },
        entryFilename: "index.mjs",
        entrySource: `
export default {
  activate(api) {
    api.registerCommand({
      name: "tools export",
      action: "tools-export",
      description: "Export dynamic tools",
      arguments: [{ name: "target", required: false }],
      flags: [{ long: "--format", value_name: "kind", description: "Output format" }],
      run(context) {
        return {
          command: context.command,
          args: context.args,
          format: context.options.format,
          path: context.global.path
        };
      }
    });
  }
};
`,
      });

      const root = new Command()
        .name("pm")
        .exitOverride()
        .configureOutput({ writeOut: () => {}, writeErr: () => {} });
      root.option("--json", "Output JSON").option("--quiet", "Quiet").option("--pm-path <dir>", "PM path").option("--profile", "Profile");

      await _testOnly.registerDynamicExtensionCommandPaths(root, [
        "--pm-path",
        context.pmPath,
        "--json",
        "tools",
        "export",
      ]);
      const snapshot = await _testOnly.loadRuntimeExtensionSnapshot(context.pmPath);
      setActiveExtensionRegistrations(snapshot?.registrations ?? null);
      setActiveExtensionCommands(snapshot?.commands ?? null);

      expect(findCommandByPath(root, ["tools", "export"])?.description()).toBe("Export dynamic tools");

      const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        await root.parseAsync([
          "node",
          "pm",
          "--pm-path",
          context.pmPath,
          "--json",
          "tools",
          "export",
          "backup",
          "--format",
          "json",
        ]);
        const payload = JSON.parse(stdoutSpy.mock.calls.map((call) => String(call[0])).join(""));
        expect(payload).toMatchObject({
          command: "tools export",
          args: ["backup"],
          format: "json",
          path: context.pmPath,
        });

        stdoutSpy.mockClear();
        stderrSpy.mockClear();
        await root.parseAsync([
          "node",
          "pm",
          "--pm-path",
          context.pmPath,
          "--json",
          "--profile",
          "tools",
          "export",
          "archive",
          "--format",
          "toon",
        ]);
        const profilePayload = JSON.parse(stdoutSpy.mock.calls.map((call) => String(call[0])).join(""));
        expect(profilePayload).toMatchObject({
          command: "tools export",
          args: ["archive"],
          format: "toon",
          path: context.pmPath,
        });
        expect(stderrSpy.mock.calls.map((call) => String(call[0])).join("")).toContain("profile:command=tools export took_ms=");
      } finally {
        stdoutSpy.mockRestore();
        stderrSpy.mockRestore();
      }
    });
  });

  it("sorts multiple dynamic extension command paths before registration", async () => {
    await withTempPmPath(async (context) => {
      await writeTestExtension({
        root: path.join(context.pmPath, "extensions"),
        directory: "sorted-tools",
        manifest: {
          name: "sorted-tools",
          capabilities: ["commands"],
          entry: "./index.mjs",
        },
        entryFilename: "index.mjs",
        entrySource: `
export default {
  activate(api) {
    api.registerCommand({ name: "tools zebra", run: () => ({ ok: true }) });
    api.registerCommand({ name: "tools alpha", run: () => ({ ok: true }) });
  }
};
`,
      });

      const root = new Command().name("pm");
      root.option("--pm-path <dir>", "PM path");
      await _testOnly.registerDynamicExtensionCommandPaths(root, ["--pm-path", context.pmPath, "tools", "--help"]);

      expect(root.commands.map((command) => command.name())).toEqual(["tools"]);
      expect(findCommandByPath(root, ["tools"])?.commands.map((command) => command.name())).toEqual(["alpha", "zebra"]);
    });
  });

  it("enhances existing dynamic command paths with extension flags and metadata", async () => {
    await withTempPmPath(async (context) => {
      await writeTestExtension({
        root: path.join(context.pmPath, "extensions"),
        directory: "create-enhancer",
        manifest: {
          name: "create-enhancer",
          capabilities: ["commands", "schema"],
          activation: { commands: ["create"] },
          entry: "./index.mjs",
        },
        entryFilename: "index.mjs",
        entrySource: `
export default {
  activate(api) {
    api.registerCommand({
      name: "create",
      action: "create-enhancer",
      description: "Enhance create",
      intent: "Create with extension metadata",
      examples: ["pm create --title Demo --type Task --template bug"],
      failure_hints: ["Pick a valid template"],
      flags: [{ long: "--template", value_name: "name", description: "Template name" }],
      run: () => ({ ok: true })
    });
  }
};
`,
      });

      const root = new Command()
        .name("pm")
        .exitOverride()
        .configureOutput({ writeOut: () => {}, writeErr: () => {} });
      root.option("--pm-path <dir>", "PM path");
      const create = root.command("create").description("Create item");

      await _testOnly.registerDynamicExtensionCommandPaths(root, ["--pm-path", context.pmPath, "create", "--help"]);

      expect(findCommandByPath(root, ["create"])).toBe(create);
      expect(create.options.some((option) => option.long === "--template")).toBe(true);
      const helpText = create.helpInformation();
      expect(helpText).toContain("Template name");
    });
  });

  it("enhances existing commands and no-extension dynamic bootstrap paths", async () => {
    await withTempPmPath(async (context) => {
      const noExtRoot = new Command().name("pm");
      noExtRoot.option("--no-extensions", "Disable extensions").option("--pm-path <dir>", "PM path");
      noExtRoot.command("create").description("Create item");
      await expect(
        _testOnly.registerDynamicExtensionCommandPaths(noExtRoot, [
          "--no-extensions",
          "--pm-path",
          context.pmPath,
          "create",
          "--help",
        ]),
      ).resolves.toBeUndefined();

      expect(findCommandByPath(noExtRoot, ["create"])?.description()).toBe("Create item");
    });
  });

  it("keeps dynamic registration empty when discovery or activation snapshots fail", async () => {
    const brokenRoot = await mkdtemp(path.join(os.tmpdir(), "pm-dynamic-broken-"));
    try {
      await writeFile(path.join(brokenRoot, "settings.json"), "{", "utf8");
      const root = new Command().name("pm");
      root.option("--pm-path <dir>", "PM path");
      await expect(_testOnly.registerDynamicExtensionCommandPaths(root, ["--pm-path", brokenRoot, "missing"])).resolves.toBeUndefined();
      expect(findCommandByPath(root, ["missing"])).toBeNull();
    } finally {
      await rm(brokenRoot, { recursive: true, force: true });
    }

    const fileRoot = await mkdtemp(path.join(os.tmpdir(), "pm-dynamic-file-parent-"));
    const filePmRoot = path.join(fileRoot, "not-a-directory");
    try {
      await writeFile(filePmRoot, "not a tracker directory", "utf8");
      const root = new Command().name("pm");
      root.option("--pm-path <dir>", "PM path");
      await expect(_testOnly.registerDynamicExtensionCommandPaths(root, ["--pm-path", filePmRoot, "missing"])).resolves.toBeUndefined();
      expect(findCommandByPath(root, ["missing"])).toBeNull();
    } finally {
      await rm(fileRoot, { recursive: true, force: true });
    }

    await withTempPmPath(async (context) => {
      await writeTestExtension({
        root: path.join(context.pmPath, "extensions"),
        directory: "broken-activation",
        manifest: {
          name: "broken-activation",
          capabilities: ["commands"],
          activation: { commands: ["broken"] },
          entry: "./missing.mjs",
        },
      });
      const root = new Command().name("pm");
      root.option("--pm-path <dir>", "PM path");
      root.command("create").description("Create item");
      await expect(
        _testOnly.registerDynamicExtensionCommandPaths(root, ["--pm-path", context.pmPath, "create", "--help"]),
      ).resolves.toBeUndefined();
      expect(findCommandByPath(root, ["broken"])).toBeNull();
    });
  });

  it("skips dynamic command registration when discovery has nothing to activate", async () => {
    await withTempPmPath(async (context) => {
      const root = new Command()
        .name("pm")
        .exitOverride()
        .configureOutput({ writeOut: () => {}, writeErr: () => {} });
      root.option("--pm-path <dir>", "PM path").option("--profile", "Profile");
      root.command("list").description("List items");

      const stderr = await captureStderrAsync(async () => {
        await _testOnly.registerDynamicExtensionCommandPaths(root, ["--pm-path", context.pmPath, "--profile", "list"]);
      });
      expect(stderr).toContain("profile:extensions activation=skipped command=list");
      expect(findCommandByPath(root, ["list"])?.description()).toBe("List items");
      expect(findCommandByPath(root, ["blank"])).toBeNull();
    });
  });

  it("reports extension command handler misses and failures", async () => {
    await withTempPmPath(async (context) => {
      const root = new Command().name("pm");
      root.option("--pm-path <dir>", "PM path");
      const command = root.command("tools");
      command.setOptionValue("pmPath", context.pmPath);

      setActiveExtensionCommands({ overrides: [], handlers: [] });
      await expect(
        _testOnly.runRequiredExtensionCommand(command, {}, { path: context.pmPath } as never),
      ).rejects.toThrow("Command \"tools\" is provided by extensions and is not currently available.");

      setActiveExtensionCommands({
        overrides: [],
        handlers: [
          {
            layer: "project",
            name: "broken-tools",
            command: "tools",
            run: () => {
              throw new Error("handler exploded");
            },
          },
        ],
      });
      await expect(
        _testOnly.runRequiredExtensionCommand(command, {}, { path: context.pmPath } as never),
      ).rejects.toThrow(
        'Command "tools" failed in extension handler (extension_command_handler_failed:project:broken-tools:tools). handler exploded',
      );

      setActiveExtensionParsers({
        overrides: [
          {
            layer: "project",
            name: "parser-tools",
            command: "tools",
            run: (runtimeContext) => ({
              args: ["rewritten", ...runtimeContext.args],
              options: { ...runtimeContext.options, parsed: true },
              global: { ...runtimeContext.global, profile: true },
              pm_root: runtimeContext.pm_root,
            }),
          },
        ],
      });
      setActiveExtensionCommands({
        overrides: [],
        handlers: [
          {
            layer: "project",
            name: "ok-tools",
            command: "tools",
            run: (runtimeContext) => ({
              args: runtimeContext.args,
              parsed: runtimeContext.options.parsed,
              profile: runtimeContext.global.profile,
            }),
          },
        ],
      });

      const stderr = await captureStderrAsync(async () => {
        await expect(
          _testOnly.runRequiredExtensionCommand(command, {}, { path: context.pmPath, profile: true } as never),
        ).resolves.toEqual({
          args: ["rewritten"],
          parsed: true,
          profile: true,
        });
      });
      expect(stderr).toBe("");
    });
  });

  it("prints profile warnings from parser and command handler overrides", async () => {
    await withTempPmPath(async (context) => {
      const root = new Command().name("pm");
      root.option("--pm-path <dir>", "PM path").option("--profile", "Profile");
      const command = root.command("tools");
      command.setOptionValue("pmPath", context.pmPath);
      command.setOptionValue("profile", true);

      setActiveExtensionParsers({
        overrides: [
          {
            layer: "project",
            name: "parser-warning",
            command: "tools",
            run: () => {
              throw new Error("parser rejected args");
            },
          },
        ],
      });
      setActiveExtensionCommands({
        overrides: [],
        handlers: [
          {
            layer: "project",
            name: "handler-warning",
            command: "tools",
            run: () => {
              throw new Error("handler used fallback");
            },
          },
        ],
      });

      const stderr = await captureStderrAsync(async () => {
        await expect(
          _testOnly.runRequiredExtensionCommand(command, {}, { path: context.pmPath, profile: true } as never),
        ).rejects.toThrow("handler used fallback");
      });

      expect(stderr).toContain("profile:extensions parser_warnings=extension_parser_override_failed");
      expect(stderr).toContain("profile:extensions command_handler_warnings=extension_command_handler_failed");
    });
  });

  it("wraps core action handlers so extension handlers can intercept execution", async () => {
    await withTempPmPath(async (context) => {
      const root = new Command()
        .name("pm")
        .exitOverride()
        .configureOutput({ writeOut: () => {}, writeErr: () => {} });
      root.option("--json", "Output JSON").option("--quiet", "Quiet").option("--pm-path <dir>", "PM path").option("--profile", "Profile");
      let originalCalled = false;
      root
        .command("demo [value]")
        .option("--level <value>", "Level")
        .action(() => {
          originalCalled = true;
          return { source: "core" };
        });

      setActiveExtensionRegistrations(createEmptyExtensionRegistrationRegistry());
      setActiveExtensionCommands({
        overrides: [],
        handlers: [
          {
            layer: "project",
            name: "demo-extension",
            command: "demo",
            run: (runtimeContext) => ({
              source: "extension",
              args: runtimeContext.args,
              level: runtimeContext.options.level,
              pmRoot: runtimeContext.pm_root,
            }),
          },
        ],
      });

      _testOnly.wrapProgramActionsForExtensionHandlers(root);

      const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        await root.parseAsync([
          "node",
          "pm",
          "--pm-path",
          context.pmPath,
          "--json",
          "demo",
          "alpha",
          "--level",
          "7",
        ]);
        expect(originalCalled).toBe(false);
        expect(getActiveCommandResult()).toMatchObject({
          source: "extension",
          args: ["alpha"],
          level: "7",
          pmRoot: context.pmPath,
        });
        const payload = JSON.parse(stdoutSpy.mock.calls.map((call) => String(call[0])).join(""));
        expect(payload.source).toBe("extension");
      } finally {
        stdoutSpy.mockRestore();
      }
    });
  });

  it("reports wrapped action profile warnings and falls back to the core action when handlers decline", async () => {
    await withTempPmPath(async (context) => {
      const root = new Command()
        .name("pm")
        .exitOverride()
        .configureOutput({ writeOut: () => {}, writeErr: () => {} });
      root.option("--json", "Output JSON").option("--pm-path <dir>", "PM path").option("--profile", "Profile");
      let originalCalls = 0;
      root
        .command("demo [value]")
        .option("--level <value>", "Level")
        .action(() => {
          originalCalls += 1;
          return { source: "core" };
        });

      setActiveExtensionRegistrations(createEmptyExtensionRegistrationRegistry());
      setActiveExtensionParsers({
        overrides: [
          {
            layer: "project",
            name: "demo-parser",
            command: "demo",
            run: () => {
              throw new Error("parser declined");
            },
          },
        ],
      });
      setActiveExtensionCommands({
        overrides: [],
        handlers: [
          {
            layer: "project",
            name: "demo-handler",
            command: "demo",
            run: () => {
              throw new Error("handler declined");
            },
          },
        ],
      });

      _testOnly.wrapProgramActionsForExtensionHandlers(root);

      const stderr = await captureStderrAsync(async () => {
        await root.parseAsync([
          "node",
          "pm",
          "--pm-path",
          context.pmPath,
          "--profile",
          "demo",
          "alpha",
          "--level",
          "7",
        ]);
      });

      expect(originalCalls).toBe(1);
      expect(stderr).toContain("profile:extensions parser_warnings=extension_parser_override_failed");
      expect(stderr).toContain("profile:extensions command_handler_warnings=extension_command_handler_failed");

      setActiveExtensionParsers(null);
      setActiveExtensionCommands({
        overrides: [],
        handlers: [
          {
            layer: "project",
            name: "demo-handler",
            command: "demo",
            run: () => ({ source: "extension" }),
          },
        ],
      });
      originalCalls = 0;

      const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const successStderr = await captureStderrAsync(async () => {
        await root.parseAsync(["node", "pm", "--pm-path", context.pmPath, "--json", "--profile", "demo", "beta"]);
      });
      try {
        expect(originalCalls).toBe(0);
        expect(JSON.parse(stdoutSpy.mock.calls.map((call) => String(call[0])).join(""))).toMatchObject({
          source: "extension",
        });
      } finally {
        stdoutSpy.mockRestore();
      }
      expect(successStderr).toContain("profile:command=demo took_ms=");
    });
  });

  it("falls back to wrapped core actions when extension handlers do not handle the command", async () => {
    await withTempPmPath(async (context) => {
      const root = new Command()
        .name("pm")
        .exitOverride()
        .configureOutput({ writeOut: () => {}, writeErr: () => {} });
      root.option("--pm-path <dir>", "PM path");
      let originalValue = "";
      root.command("demo [value]").action((value: string | undefined) => {
        originalValue = value ?? "";
      });

      setActiveExtensionRegistrations(createEmptyExtensionRegistrationRegistry());
      setActiveExtensionCommands({ overrides: [], handlers: [] });

      _testOnly.wrapProgramActionsForExtensionHandlers(root);
      await root.parseAsync(["node", "pm", "--pm-path", context.pmPath, "demo", "alpha"]);

      expect(originalValue).toBe("alpha");
      expect(getActiveCommandResult()).toBeUndefined();
    });
  });

  it("reprocesses wrapped variadic action arguments after parser overrides", async () => {
    await withTempPmPath(async (context) => {
      const root = new Command()
        .name("pm")
        .exitOverride()
        .configureOutput({ writeOut: () => {}, writeErr: () => {} });
      root.option("--pm-path <dir>", "PM path");
      let observedValues: string[] = [];
      root.command("collect [values...]").action((values: string[]) => {
        observedValues = values;
      });

      setActiveExtensionRegistrations(createEmptyExtensionRegistrationRegistry());
      setActiveExtensionParsers({
        overrides: [
          {
            layer: "project",
            name: "collect-parser",
            command: "collect",
            run: (runtimeContext) => ({
              args: ["rewritten", ...runtimeContext.args],
              options: runtimeContext.options,
              global: runtimeContext.global,
              pm_root: runtimeContext.pm_root,
            }),
          },
        ],
      });
      setActiveExtensionCommands({ overrides: [], handlers: [] });

      _testOnly.wrapProgramActionsForExtensionHandlers(root);
      await root.parseAsync(["node", "pm", "--pm-path", context.pmPath, "collect", "original"]);

      expect(observedValues).toEqual(["rewritten", "original"]);
    });
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

      process.exitCode = undefined;
      setActiveCommandResult({
        exitCode: Number.NaN,
        warnings: [42, "  retry needed  "],
        run_results: [{ status: "passed" }],
      });
      expect(_testOnly.buildPostActionTelemetryOutcome()).toMatchObject({
        ok: true,
        exit_code: EXIT_CODE.SUCCESS,
        error: undefined,
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

  it("runs after-command hooks and surfaces warnings outside JSON mode", async () => {
    setActiveCommandResult({ changed: true });
    _testOnly.setActiveExtensionHookContextForTest({
      hooks: {
        beforeCommand: [],
        afterCommand: [
          {
            layer: "project",
            name: "after-warn",
            run: () => {
              throw new Error("after hook failed");
            },
          },
        ],
        onWrite: [],
        onRead: [],
        onIndex: [],
      },
      commandName: "update",
      commandArgs: ["pm-123"],
      commandOptions: { title: "Done" },
      globalOptions: { profile: true } as never,
      pmRoot: "/tmp/pm-root",
      profileEnabled: true,
      migrationBlockers: [],
    });

    const stderr = await captureStderrAsync(async () => {
      await _testOnly.runAndClearAfterCommandHooks({
        ok: false,
        error: "failed",
        exit_code: EXIT_CODE.GENERIC_FAILURE,
        error_code: "command_failed",
        error_category: "runtime",
        command_resolution: "runtime_failed",
        resolution_stage: "execute",
      });
    });

    expect(stderr).toContain("[pm] warning: afterCommand hook_warnings=");
    expect(stderr).toContain("extension_hook_failed:project:after-warn:afterCommand");
    expect(stderr).toContain("profile:extensions hook_warnings=");
  });

  it("falls back to raw after-command exception messages", async () => {
    _testOnly.setActiveExtensionHookContextForTest({
      hooks: {
        beforeCommand: [],
        afterCommand: [] as never,
        onWrite: [],
        onRead: [],
        onIndex: [],
      },
      commandName: "update",
      commandArgs: ["pm-123"],
      commandOptions: {},
      globalOptions: { profile: true } as never,
      pmRoot: "/tmp/pm-root",
      profileEnabled: true,
      migrationBlockers: [],
    });

    const extensions = await import("../../src/core/extensions/index.js");
    const spy = vi.spyOn(extensions, "runAfterCommandHooks").mockRejectedValueOnce("plain after failure");
    try {
      const stderr = await captureStderrAsync(async () => {
        await _testOnly.runAndClearAfterCommandHooks({
          ok: false,
          error: "failed",
          exit_code: EXIT_CODE.GENERIC_FAILURE,
          error_code: "command_failed",
          error_category: "runtime",
          command_resolution: "runtime_failed",
          resolution_stage: "execute",
        });
      });
      expect(stderr).toContain("afterCommand hooks failed: plain after failure");
    } finally {
      spy.mockRestore();
    }
  });

  it("clears after-command hooks without stderr when no runtime or JSON output suppresses warnings", async () => {
    const noRuntimeStderr = await captureStderrAsync(async () => {
      await _testOnly.runAndClearAfterCommandHooks({
        ok: true,
        exit_code: EXIT_CODE.SUCCESS,
        command_resolution: "success",
        resolution_stage: "execute",
      });
    });
    expect(noRuntimeStderr).toBe("");

    _testOnly.setActiveExtensionHookContextForTest({
      hooks: {
        beforeCommand: [],
        afterCommand: [
          {
            layer: "project",
            name: "after-json",
            run: () => {
              throw new Error("suppressed");
            },
          },
        ],
        onWrite: [],
        onRead: [],
        onIndex: [],
      },
      commandName: "list",
      commandArgs: [],
      commandOptions: {},
      globalOptions: { json: true, profile: false } as never,
      pmRoot: "/tmp/pm-root",
      profileEnabled: false,
      migrationBlockers: [],
    });

    const jsonSuppressedStderr = await captureStderrAsync(async () => {
      await _testOnly.runAndClearAfterCommandHooks({
        ok: false,
        error: "failed",
        exit_code: EXIT_CODE.GENERIC_FAILURE,
        error_code: "command_failed",
        error_category: "runtime",
        command_resolution: "runtime_failed",
        resolution_stage: "execute",
      });
    });
    expect(jsonSuppressedStderr).toBe("");
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

describe("CLI migration gate helpers", () => {
  it("collects mandatory migration blockers with normalized statuses and stable fallback ids", () => {
    expect(resolveMigrationId({ id: " explicit " }, 0)).toBe("explicit");
    expect(resolveMigrationId({ id: " " }, 4)).toBe("migration-005");
    expect(resolveNormalizedMigrationStatus({ status: " FAILED " })).toBe("failed");
    expect(resolveNormalizedMigrationStatus({ status: " " })).toBe("pending");

    expect(
      collectMandatoryMigrationBlockers([
        {
          layer: "project",
          name: "beta",
          definition: { mandatory: true, id: "project-beta", status: "PENDING" },
        },
        {
          layer: "project",
          name: "alpha",
          definition: { mandatory: true, status: "failed" },
        },
        {
          layer: "project",
          name: "alpha",
          definition: { mandatory: true, id: "migration-001", status: "pending" },
        },
        {
          layer: "global",
          name: "zeta",
          definition: { mandatory: true, id: "done", status: "applied" },
        },
        {
          layer: "global",
          name: "alpha",
          definition: { mandatory: true, id: "global-alpha", status: "blocked" },
        },
        {
          layer: "project",
          name: "ignored",
          definition: { mandatory: false, id: "not-mandatory", status: "pending" },
        },
      ]),
    ).toEqual([
      {
        layer: "global",
        name: "alpha",
        id: "global-alpha",
        status: "blocked",
      },
      {
        layer: "project",
        name: "alpha",
        id: "migration-001",
        status: "pending",
      },
      {
        layer: "project",
        name: "alpha",
        id: "migration-002",
        status: "failed",
      },
      {
        layer: "project",
        name: "beta",
        id: "project-beta",
        status: "pending",
      },
    ]);
  });

  it("classifies write-gate mutation commands and force bypass support", () => {
    expect(decideWriteGate("create", { force: true })).toEqual({
      isMutation: true,
      forceCapable: false,
      forceRequested: false,
    });
    expect(decideWriteGate("update", { force: true })).toEqual({
      isMutation: true,
      forceCapable: true,
      forceRequested: true,
    });
    expect(decideWriteGate("comments", { add: "note" })).toMatchObject({
      isMutation: true,
      forceCapable: true,
    });
    expect(decideWriteGate("notes", { add: ["not-mutating-for-notes"] })).toMatchObject({
      isMutation: false,
      forceCapable: true,
    });
    expect(decideWriteGate("files", { add: [], remove: ["src/cli/main.ts"] })).toMatchObject({
      isMutation: true,
      forceCapable: true,
    });
    expect(decideWriteGate("docs", { add: [], remove: [] })).toMatchObject({
      isMutation: false,
      forceCapable: true,
    });
    expect(decideWriteGate("list", { force: true })).toEqual({
      isMutation: false,
      forceCapable: false,
      forceRequested: false,
    });
  });

  it("blocks unresolved mandatory migrations only for mutating writes without an allowed force bypass", () => {
    const blockers = [
      {
        layer: "project" as const,
        name: "schema-pack",
        id: "schema-v2",
        status: "pending",
      },
    ];

    expect(() => enforceMandatoryMigrationWriteGate("create", {}, [])).not.toThrow();
    expect(() => enforceMandatoryMigrationWriteGate("list", {}, blockers)).not.toThrow();
    expect(() => enforceMandatoryMigrationWriteGate("update", { force: true }, blockers)).not.toThrow();

    expect(() => enforceMandatoryMigrationWriteGate("update", {}, blockers)).toThrow(
      /extension_migration_blocking:project:schema-pack:schema-v2:pending.*Re-run this command with --force to bypass/,
    );
    expect(() => enforceMandatoryMigrationWriteGate("create", { force: true }, blockers)).toThrow(
      /This command path does not support --force bypass/,
    );
  });

  it("short-circuits item-format preflight gates for reads, disabled decisions, and missing settings", async () => {
    const missingSettingsRoot = await mkdtemp(path.join(os.tmpdir(), "pm-migration-gate-"));
    try {
      await enforceItemFormatWriteGateAndPreflightMigration(
        "create",
        {},
        missingSettingsRoot,
        {
          enforce_item_format_gate: true,
          run_preflight_item_format_sync: true,
          run_extension_migrations: true,
          enforce_mandatory_migration_gate: true,
        },
      );
    } finally {
      await rm(missingSettingsRoot, { recursive: true, force: true });
    }

    await withTempPmPath(async (context) => {
      await enforceItemFormatWriteGateAndPreflightMigration(
        "list",
        {},
        context.pmPath,
        {
          enforce_item_format_gate: true,
          run_preflight_item_format_sync: true,
          run_extension_migrations: true,
          enforce_mandatory_migration_gate: true,
        },
      );
      await enforceItemFormatWriteGateAndPreflightMigration(
        "create",
        {},
        context.pmPath,
        {
          enforce_item_format_gate: false,
          run_preflight_item_format_sync: false,
          run_extension_migrations: true,
          enforce_mandatory_migration_gate: true,
        },
      );
      await enforceItemFormatWriteGateAndPreflightMigration(
        "create",
        {},
        context.pmPath,
        {
          enforce_item_format_gate: true,
          run_preflight_item_format_sync: true,
          run_extension_migrations: true,
          enforce_mandatory_migration_gate: true,
        },
      );

      const settingsPath = path.join(context.pmPath, "settings.json");
      await writeFile(settingsPath, `${JSON.stringify({ version: 1 })}\n`, "utf8");
      const fallbackStderr = await captureStderrAsync(async () => {
        await enforceItemFormatWriteGateAndPreflightMigration(
          "create",
          {},
          context.pmPath,
          {
            enforce_item_format_gate: true,
            run_preflight_item_format_sync: false,
            run_extension_migrations: true,
            enforce_mandatory_migration_gate: true,
          },
        );
      });
      expect(fallbackStderr).toContain("warning:settings_read_invalid_schema");
      expect(await readFile(settingsPath, "utf8")).toContain('"item_format": "toon"');
    });
  });
});

describe("CLI bootstrap argument helpers", () => {
  it("parses global bootstrap flags with pm-path precedence and help command paths", () => {
    expect(
      parseBootstrapGlobalOptions([
        "--path",
        "legacy",
        "--pm-path=preferred",
        "--no-extensions",
        "--no-pager",
        "--json",
        "--quiet",
        "list",
      ]),
    ).toEqual({
      path: "preferred",
      noExtensions: true,
      noPager: true,
      json: true,
      quiet: true,
    });

    expect(parseBootstrapHelpRequest(["--json", "help", "extension", "doctor", "--explain"])).toEqual({
      requested: true,
      commandPathTokens: ["extension", "doctor"],
    });
    expect(parseBootstrapHelpRequest(["help", "extension", "-x", "doctor"])).toEqual({
      requested: true,
      commandPathTokens: ["extension"],
    });
    expect(parseBootstrapHelpRequest(["--json", "create", "--type", "Task", "--help"])).toEqual({
      requested: true,
      commandPathTokens: ["create"],
    });
    expect(parseBootstrapTypeValue(["create", "--type=", "--type", " Task "])).toBe("Task");
  });

  it("covers pager, path, command-token, and help parsing edge cases", () => {
    expect(parseBootstrapGlobalOptions(["--path=", "--pm-path", "", "--", "--json"])).toEqual({
      path: undefined,
      noExtensions: false,
      noPager: false,
      json: false,
      quiet: false,
    });
    expect(stripGlobalBootstrapTokens(["--json", "--pm-path", "tracker", "--profile", "list", "--", "--quiet"])).toEqual([
      "list",
    ]);
    expect(stripGlobalBootstrapTokens(["--path=tracker", "--pm-path=preferred", "list"])).toEqual(["list"]);
    expect(parseBootstrapCommandName(["--path", "tracker", "--unknown", "list"])).toBe("list");
    expect(parseBootstrapCommandName(["--", "list"])).toBeUndefined();
    expect(parseBootstrapHelpRequest(["help", "--json", "ignored"])).toEqual({
      requested: true,
      commandPathTokens: ["ignored"],
    });
    expect(parseBootstrapHelpRequest(["--", "list", "--help"])).toEqual({
      requested: false,
      commandPathTokens: [],
    });

    const previousPager = process.env.PAGER;
    const previousManpager = process.env.MANPAGER;
    const previousGitPager = process.env.GIT_PAGER;
    const previousLess = process.env.LESS;
    const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    try {
      Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
      process.env.PAGER = "less";
      process.env.MANPAGER = "less";
      process.env.GIT_PAGER = "less";
      process.env.LESS = " ";
      applyBootstrapPagerPolicy(["list", "--help"]);
      expect(process.env.PAGER).toBe("less");

      Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });
      applyBootstrapPagerPolicy(["list", "--help"]);
      expect(process.env.PAGER).toBe("cat");
      expect(process.env.MANPAGER).toBe("cat");
      expect(process.env.GIT_PAGER).toBe("cat");
      expect(process.env.LESS).toBe("FRX");

      process.env.LESS = "R";
      applyBootstrapPagerPolicy(["--no-pager", "list"]);
      expect(process.env.LESS).toBe("R");
    } finally {
      if (stdoutDescriptor) {
        Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
      }
      if (previousPager === undefined) delete process.env.PAGER;
      else process.env.PAGER = previousPager;
      if (previousManpager === undefined) delete process.env.MANPAGER;
      else process.env.MANPAGER = previousManpager;
      if (previousGitPager === undefined) delete process.env.GIT_PAGER;
      else process.env.GIT_PAGER = previousGitPager;
      if (previousLess === undefined) delete process.env.LESS;
      else process.env.LESS = previousLess;
    }
  });

  it("normalizes extension action syntax, aliases, bare fields, linked tests, and list flags", () => {
    expect(normalizeLegacyExtensionActionSyntax(["list"])).toEqual(["list"]);
    expect(normalizeLegacyExtensionActionSyntax(["extension"])).toEqual(["extension"]);
    expect(normalizeLegacyExtensionActionSyntax(["extension", "--doctor"])).toEqual(["extension", "--doctor"]);
    expect(normalizeLegacyExtensionActionSyntax(["extension", "unknown"])).toEqual(["extension", "unknown"]);
    expect(normalizeLegacyExtensionActionSyntax(["extension", "doctor", "--doctor"])).toEqual([
      "extension",
      "doctor",
      "--doctor",
    ]);
    expect(normalizeLegacyExtensionActionSyntax(["extension", "doctor", "pkg"])).toEqual([
      "extension",
      "--doctor",
      "pkg",
    ]);
    expect(normalizeLegacyExtensionActionSyntax(["extension", "doctor", "--help"])).toEqual([
      "extension",
      "doctor",
      "--help",
    ]);

    expect(listAliasPluralKeys("priority")).toEqual(["prioritys", "priorities"]);
    expect(listAliasPluralKeys("status")).toEqual(["statuss"]);

    const trace: Parameters<typeof mergeLinkedTestTwoTokenEntries>[2] = [];
    expect(mergeLinkedTestTwoTokenEntries(["comments", "pm-1", "--add", "body", "done"], "comments", [])).toEqual([
      "comments",
      "pm-1",
      "--add",
      "body",
      "done",
    ]);
    expect(mergeLinkedTestTwoTokenEntries(["test", "pm-1", "--add", "command", "pnpm test -- unit"], "test", trace)).toEqual([
      "test",
      "pm-1",
      "--add",
      "command=pnpm test -- unit",
    ]);
    expect(trace).toEqual([
      {
        from: "--add command pnpm test -- unit",
        to: ["--add", "command=pnpm test -- unit"],
        reason: "bare_key_value",
        confidence: "high",
      },
    ]);
    expect(mergeLinkedTestTwoTokenEntries(["test", "pm-1", "--add", "command", "pnpm", "test"], "test", [])).toEqual([
      "test",
      "pm-1",
      "--add",
      "command",
      "pnpm",
      "test",
    ]);

    const coalesced = coalesceRepeatedListFlags(
      ["--pm-path", "--tags", "create", "--tags", "alpha", "--tags=beta", "--tags"],
      new Set(["--tags"]),
      new Set(["--pm-path"]),
    );
    expect(coalesced.argv).toEqual(["--pm-path", "--tags", "create", "--tags=alpha,beta", "--tags"]);
    expect(coalesced.events).toEqual([
      {
        from: "--tags (x2)",
        to: ["--tags=alpha,beta"],
        reason: "list_merge",
        confidence: "high",
      },
    ]);
    expect(coalesceRepeatedListFlags(["--tags", "alpha", "--"], new Set(["--tags"])).argv).toEqual(["--tags", "alpha", "--"]);
    expect(coalesceRepeatedListFlags(["--tags", "alpha"], new Set(["--tags"])).argv).toEqual(["--tags", "alpha"]);
    expect(coalesceRepeatedListFlags(["--tags"], new Set(["--tags"])).argv).toEqual(["--tags"]);
    expect(coalesceRepeatedListFlags(["--pm-path", "--tags", "--tags", "alpha"], new Set(["--tags"]), new Set(["--pm-path"])).argv).toEqual([
      "--pm-path",
      "--tags",
      "--tags",
      "alpha",
    ]);
    expect(coalesceRepeatedListFlags(["--tags", "alpha", "--labels", "beta"], new Set(["--tags", "--labels"])).argv).toEqual([
      "--tags",
      "alpha",
      "--labels",
      "beta",
    ]);

    const normalized = normalizeBootstrapInvocation([
      "show",
      "pm-1",
      "title:Fixed",
      "--add-tag",
      "coverage",
      "--add_tag=cli",
    ]);
    expect(normalized.commandName).toBe("get");
    expect(normalized.argv[0]).toBe("get");
    expect(normalized.trace.map((entry) => entry.reason)).toEqual(expect.arrayContaining(["command_alias"]));

    const createNormalized = normalizeBootstrapInvocation(["create", "add_tag=coverage", "tilte=Bug", "--tags", "one", "--tags=two"]);
    expect(createNormalized.argv).toEqual(expect.arrayContaining(["--add-tags", "coverage", "--title", "Bug", "--tags=one,two"]));
    expect(createNormalized.trace.map((entry) => entry.reason)).toEqual(
      expect.arrayContaining(["bare_key_value", "list_merge"]),
    );

    expect(normalizeBootstrapInvocation(["test", "pm-1", "--add", "command", "PM_PATH=/tmp/x"])).toMatchObject({
      argv: ["test", "pm-1", "--add", "command=PM_PATH=/tmp/x"],
    });
    expect(normalizeBootstrapInvocation(["extension", "install", "guide-shell"]).trace).toEqual([
      {
        from: "extension install guide-shell",
        to: ["extension", "--install", "guide-shell"],
        reason: "legacy_extension_action",
        confidence: "high",
      },
    ]);
    expect(normalizeBootstrapInvocation(["package", "install", "--package-source", "builtin"]).commandName).toBe("package");
    expect(parseBootstrapTypeValue(["create", "--type="])).toBeUndefined();
    expect(parseBootstrapTypeValue(["create", "--type", " "])).toBeUndefined();
  });
});

describe("CLI guide topic helpers", () => {
  it("resolves aliases and returns defensive topic copies", () => {
    expect(listGuideTopicIds()).toEqual(
      expect.arrayContaining(["quickstart", "commands", "workflows", "sdk", "extensions", "skills", "harnesses", "release"]),
    );
    expect(resolveGuideTopic("agent_skills")?.id).toBe("skills");
    expect(resolveGuideTopic("  ")).toBeNull();
    expect(resolveGuideTopic(undefined)).toBeNull();

    const topics = listGuideTopics();
    const quickstart = topics.find((topic) => topic.id === "quickstart");
    expect(quickstart).toBeDefined();
    quickstart?.aliases.push("mutated");
    quickstart?.workflows[0]?.commands.push("pm mutated");
    quickstart?.docs[0] && (quickstart.docs[0].path = "mutated.md");

    const freshQuickstart = listGuideTopics().find((topic) => topic.id === "quickstart");
    expect(freshQuickstart?.aliases).not.toContain("mutated");
    expect(freshQuickstart?.workflows[0]?.commands).not.toContain("pm mutated");
    expect(freshQuickstart?.docs[0]?.path).toBe("README.md");
  });
});

describe("CLI error guidance helpers", () => {
  it("normalizes PmCliError context and derives invalid-value recovery", () => {
    const json = formatPmCliErrorForJson("Invalid status must be one of: open, closed", EXIT_CODE.USAGE, {
      code: " ",
      examples: [" ", "pm update pm-1 --status open"],
      nextSteps: [" ", "Use an active status"],
      recovery: {
        normalized_args: ["update", "pm-1", "--status", "done"],
        provided_fields: ["--status"],
      },
    });

    expect(json).toMatchObject({
      code: "invalid_argument_value",
      title: "Invalid argument value",
      recovery: {
        normalized_args: ["update", "pm-1", "--status", "done"],
        provided_fields: ["--status"],
      },
    });
    expect(json.examples).toEqual(["pm update pm-1 --status open"]);
    expect(classifyPmCliError("Custom failure", { code: "custom_code" }).title).toBe("Custom failure");
    expect(formatPmCliErrorForDisplay("Item undefined not found")).toContain("placeholder");
  });

  it("formats Commander recovery variants and linked-test quoting retries", () => {
    expect(buildLinkedTestQuotedRetryCommand(undefined)).toBeUndefined();
    expect(buildLinkedTestQuotedRetryCommand(["test", "--add", "command", "pnpm", "test"])).toBeUndefined();
    expect(buildLinkedTestQuotedRetryCommand(["test", "pm-1", "--add", "command", "pnpm", "test", "--", "unit"])).toBe(
      'pm test pm-1 --add "command=pnpm test -- unit"',
    );

    const missingArgument = classifyCommanderError("missing required argument 'id'", "get", "Task");
    expect(missingArgument).toMatchObject({
      code: "missing_required_argument",
      recovery: { missing: ["id"] },
    });

    const updateFile = formatCommanderErrorForJson("unknown option '--file'", "update", "Task", EXIT_CODE.USAGE, {
      normalizedInvocationArgs: ["update", "pm-1", "--file", "src/a.ts"],
      providedOptionFlags: ["--file"],
      unknownOptionSuggestions: ["--files", " "],
    });
    expect(updateFile).toMatchObject({
      code: "unsupported_update_option",
      recovery: {
        missing: ["--files"],
        provided_fields: ["--file"],
      },
    });

    const linked = formatCommanderErrorForDisplay("too many arguments", "test", "Task", {
      normalizedInvocationArgs: ["test", "pm-1", "--add", "command", "pnpm", "test", "--", "unit"],
    });
    expect(linked).toContain("Linked-test --add value must be one argument");
    expect(linked).toContain('pm test pm-1 --add "command=pnpm test -- unit"');
  });

  it("formats unknown module errors and generic guidance bundles", () => {
    expect(formatUnknownErrorForJson("Cannot find module './missing.js'", EXIT_CODE.GENERIC_FAILURE)).toMatchObject({
      code: "module_import_failed",
      title: "Module import failed",
    });
    expect(classifyUnknownError("Something else exploded")).toMatchObject({
      code: "unknown_error",
      title: "Unhandled error",
    });
    expect(
      renderGuidanceMessage({
        code: "demo",
        type: "urn:pm-cli:error:demo",
        title: "Demo",
        happened: "It happened",
        required: "Do something",
        recovery: {
          attempted_command: "pm demo",
          normalized_args: ["demo"],
          provided_fields: ["--demo"],
          missing: ["id"],
          missing_required_fields: ["type"],
          suggested_flags: ["--type"],
          suggested_retry: "pm demo --type Task",
          next_best_command: "pm help",
          fallback_candidates: [{ source: "package", command: "pm guide", reason: "optional package" }],
        },
      }),
    ).toContain("fallback_candidates:");
  });

  it("formats specific pm errors, commander package hints, and fallback titles", () => {
    expect(formatPmCliErrorForDisplay("Tracker is not initialized at /tmp/demo. Run pm init first.")).toContain(
      "Tracker is not initialized",
    );
    expect(formatPmCliErrorForDisplay("pm-1 is assigned to alice. Use --force to override")).toContain("Ownership conflict");
    expect(formatPmCliErrorForJson("pm-1 is locked by another command", EXIT_CODE.CONFLICT)).toMatchObject({
      code: "lock_conflict",
    });
    expect(formatPmCliErrorForJson("Missing required options --title, --type", EXIT_CODE.USAGE)).toMatchObject({
      code: "missing_required_option",
      title: "Missing required options",
    });
    expect(formatPmCliErrorForJson("No update flags provided", EXIT_CODE.USAGE)).toMatchObject({
      code: "no_update_fields",
    });
    expect(
      classifyPmCliError("A".repeat(140), {
        code: "custom_failed",
      }),
    ).toMatchObject({
      code: "custom_failed",
      title: `${"A".repeat(117)}...`,
    });

    const requiredType = formatCommanderErrorForJson(
      "error: required option '--type <type>' not specified",
      "create",
      "Task|Bug",
      EXIT_CODE.USAGE,
      {
        providedOptionFlags: ["--title"],
        suggestedRetryCommand: 'pm create --title "Bug" --type Task',
      },
    );
    expect(requiredType).toMatchObject({
      code: "missing_required_option",
      recovery: {
        missing: ["--type"],
      },
    });
    expect(requiredType.next_steps?.join("\n")).toContain("Already provided options: --title");

    expect(formatCommanderErrorForJson("unknown command 'guide'", "guide", "Task", EXIT_CODE.USAGE)).toMatchObject({
      code: "unknown_command",
      examples: expect.arrayContaining(["pm install guide-shell"]),
    });
    expect(formatCommanderErrorForDisplay("too many arguments", "list")).toContain("Invalid command usage");
  });

  it("normalizes linked-test retry and recovery edge cases", () => {
    expect(buildLinkedTestQuotedRetryCommand(["list", "pm-1", "--add", "command", "pnpm", "test"])).toBeUndefined();
    expect(buildLinkedTestQuotedRetryCommand(["test", "--add", "command", "pnpm", "test"])).toBeUndefined();
    expect(buildLinkedTestQuotedRetryCommand(["test", "pm-1", "--add", "scope", "unit", "extra"])).toBeUndefined();
    expect(buildLinkedTestQuotedRetryCommand(["test", "pm-1", "--remove", "path", "tests/a.ts", "--json"])).toBeUndefined();
    expect(buildLinkedTestQuotedRetryCommand(["test", "pm-1", "--json"])).toBeUndefined();
    expect(buildLinkedTestQuotedRetryCommand(["test", "pm-1", "--remove", "path", "tests/a.ts", "--", "unit"])).toBe(
      'pm test pm-1 --remove "path=tests/a.ts -- unit"',
    );
  });

  it("normalizes empty recovery bundles and optional guidance fields defensively", () => {
    const display = renderGuidanceMessage({
      code: "demo",
      type: "urn:pm-cli:error:demo",
      title: "Demo",
      happened: "It happened",
      required: "Do something",
      examples: [],
      nextSteps: [],
      recovery: {
        attempted_command: " ",
        normalized_args: [" ", "demo"],
        provided_fields: [" "],
        missing: [" "],
        missing_required_fields: [42 as never, " "],
        suggested_flags: [null as never, " "],
        suggested_retry: " ",
        next_best_command: " ",
        fallback_candidates: [{ source: " ", command: "pm demo", reason: " " }],
      },
    });

    expect(display).toContain("Recovery bundle:");
    expect(display).toContain("normalized_args: demo");
    expect(display).not.toContain("Examples:");
    expect(display).not.toContain("Next steps:");

    const json = formatCommanderErrorForJson("unknown command 'demo'", undefined, undefined, EXIT_CODE.USAGE, {
      unknownCommandExamples: [],
      unknownCommandNextSteps: [],
      providedOptionFlags: [],
      unknownOptionSuggestions: [],
      unknownOptionOtherCommands: [],
    });
    expect(json.examples).toEqual(["pm --help"]);
    expect(json.next_steps).toEqual(["Verify spelling and active extensions, then rerun."]);
    expect(json.recovery).toBeUndefined();
  });

  it("covers package command hints, empty context lists, and generic retry fallbacks", () => {
    expect(formatCommanderErrorForJson("unknown command 'templates'", "templates", "Task", EXIT_CODE.USAGE).examples).toEqual(
      expect.arrayContaining(["pm install templates"]),
    );
    expect(formatCommanderErrorForJson("unknown command 'calendar'", "calendar", "Task", EXIT_CODE.USAGE).next_steps).toEqual(
      expect.arrayContaining([
        '"calendar" is provided by the @unbrained/pm-calendar package. Install it with: pm install calendar',
      ]),
    );
    expect(formatCommanderErrorForJson("unknown command 'cal'", "cal", "Task", EXIT_CODE.USAGE).examples).toEqual(
      expect.arrayContaining(["pm install calendar"]),
    );

    const invalidWithoutRecovery = formatPmCliErrorForJson("Invalid status must be one of: open|closed", EXIT_CODE.USAGE);
    expect(invalidWithoutRecovery.examples).toEqual(["pm <command> --help", "pm contracts --command <command> --flags-only --json"]);

    const emptyTitle = classifyPmCliError("\n\n", { code: "blank_failed" });
    expect(emptyTitle).toMatchObject({
      code: "blank_failed",
      title: "Command failed",
    });

    const rendered = renderGuidanceMessage({
      code: "demo",
      type: "urn:pm-cli:error:demo",
      title: "Demo",
      happened: "It happened",
      required: "Do something",
      recovery: {
        normalized_args: [],
        provided_fields: undefined,
        missing: undefined,
        missing_required_fields: undefined,
        suggested_flags: undefined,
      },
    });
    expect(rendered).not.toContain("Recovery bundle:");
  });

  it("covers display fallback and linked-test retry non-rewrite branches", () => {
    expect(formatCommanderErrorForJson("unknown command 'guide'", "  ", "Task", EXIT_CODE.USAGE)).toMatchObject({
      code: "unknown_command",
      examples: expect.arrayContaining(["pm install guide-shell"]),
    });

    const noFieldReplacement = formatPmCliErrorForJson("Invalid value must be one of: Task, Issue", EXIT_CODE.USAGE, {
      recovery: {
        normalized_args: ["create", "--title", "Bug"],
        provided_fields: ["--type"],
      },
    });
    expect(noFieldReplacement.recovery?.suggested_retry).toBeUndefined();

    expect(formatPmCliErrorForJson("Invalid value must be one of: Bad value!", EXIT_CODE.USAGE).examples).toEqual([
      "pm <command> --help",
      "pm contracts --command <command> --flags-only --json",
    ]);

    expect(buildLinkedTestQuotedRetryCommand(["test", "pm-1", "--add", "command", "pnpm"])).toBeUndefined();
    expect(buildLinkedTestQuotedRetryCommand(["test", "pm-1", "--remove", "path", "tests/a.ts"])).toBeUndefined();
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
    expect(collectRuntimeCommandPaths(new Command().name("pm"), new Map([["_internal", {} as never]]))).toEqual([]);

    const queueHole = new Command().name("pm");
    (queueHole.commands as unknown[]).push(undefined);
    expect(collectRuntimeCommandPaths(queueHole, new Map())).toEqual([]);
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

      process.argv = ["node", "pm", "create", "--"];
      const emptyLong = await resolveCommanderUsageContext(
        { message: "error: unknown option '--'" },
        program,
        new Map(),
      );
      expect(emptyLong.unknownOptionSuggestions).toEqual([]);

      process.argv = ["node", "pm", "create", "--title"];
      const exactComparable = await resolveCommanderUsageContext(
        { message: "error: unknown option '--title'" },
        program,
        new Map(),
      );
      expect(exactComparable.unknownOptionSuggestions).not.toContain("--title");

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

  it("ranks nearest long-option suggestions by prefix, distance, and flag name", async () => {
    const program = new Command().name("pm");
    program.command("create").description("Create");

    const previousArgv = process.argv;
    try {
      process.argv = ["node", "pm", "create", "--desc"];
      const prefix = await resolveCommanderUsageContext(
        { message: "error: unknown option '--desc'" },
        program,
        new Map(),
      );
      expect(prefix.unknownOptionSuggestions).toContain("--description");

      process.argv = ["node", "pm", "create", "--tilte"];
      const editDistance = await resolveCommanderUsageContext(
        { message: "error: unknown option '--tilte'" },
        program,
        new Map(),
      );
      expect(editDistance.unknownOptionSuggestions).toContain("--title");

      process.argv = ["node", "pm", "create", "--create"];
      const noRewrite = await resolveCommanderUsageContext(
        { message: "error: unknown option '--create'" },
        program,
        new Map(),
      );
      expect(noRewrite.suggestedRetryCommand).toBe("pm create --create-mode");

      process.argv = ["node", "pm", "create", "--creat"];
      const distanceThenName = await resolveCommanderUsageContext(
        { message: "error: unknown option '--creat'" },
        program,
        new Map(),
      );
      expect(distanceThenName.unknownOptionSuggestions).toContain("--create-mode");

      process.argv = ["node", "pm", "update", "--statuz"];
      const updateTypo = await resolveCommanderUsageContext(
        { message: "error: unknown option '--statuz'" },
        program,
        new Map(),
      );
      expect(updateTypo.unknownOptionSuggestions?.[0]).toBe("--status");
    } finally {
      process.argv = previousArgv;
    }
  });

  it("normalizes list flags, linked-test entries, and bare key-value aliases without corrupting values", () => {
    expect(
      coalesceRepeatedListFlags(
        ["--pm-path", "--tags", "list", "--tags", "agent", "--tags=coverage", "--", "--tags", "literal"],
        new Set(["--tags"]),
        new Set(["--pm-path"]),
      ),
    ).toEqual({
      argv: ["--pm-path", "--tags", "list", "--tags=agent,coverage", "--", "--tags", "literal"],
      events: [
        {
          from: "--tags (x2)",
          to: ["--tags=agent,coverage"],
          reason: "list_merge",
          confidence: "high",
        },
      ],
    });
    expect(coalesceRepeatedListFlags(["--tags", "--other", "--tags", "one"], new Set(["--tags"]))).toEqual({
      argv: ["--tags", "--other", "--tags", "one"],
      events: [],
    });

    const linkedTrace: Parameters<typeof mergeLinkedTestTwoTokenEntries>[2] = [];
    expect(mergeLinkedTestTwoTokenEntries(["pm-1", "--add", "cmd", "pnpm test", "--remove", "path", "a.spec.ts"], "test", linkedTrace)).toEqual([
      "pm-1",
      "--add",
      "cmd=pnpm test",
      "--remove",
      "path=a.spec.ts",
    ]);
    expect(linkedTrace).toHaveLength(2);
    expect(mergeLinkedTestTwoTokenEntries(["--add", "command", "pnpm", "test"], "test", [])).toEqual([
      "--add",
      "command",
      "pnpm",
      "test",
    ]);

    const normalized = normalizeBootstrapInvocation([
      "create",
      "priority=2",
      "deadline:2026-06-13",
      "https://example.test/a=b",
      "--titel=Bug",
    ]);
    expect(normalized.argv).toContain("--priority");
    expect(normalized.argv).toContain("2");
    expect(normalized.argv).toContain("--deadline");
    expect(normalized.argv).toContain("2026-06-13");
    expect(normalized.argv).toContain("https://example.test/a=b");
    expect(normalized.trace.map((entry) => entry.reason)).toEqual(
      expect.arrayContaining(["bare_key_value", "flag_typo"]),
    );

    expect(normalizeBootstrapInvocation(["extension", "doctor", "target=project"]).commandName).toBe("extension");
    expect(normalizeBootstrapInvocation(["test", "pm-1", "--add", "command", "PM_PATH=/tmp/pm pnpm test"]).argv).toContain(
      "command=PM_PATH=/tmp/pm pnpm test",
    );
    expect(parseBootstrapTypeValue(["create", "--type=Task"])).toBe("Task");
    expect(parseBootstrapTypeValue(["create", "--type", ""])).toBeUndefined();
  });

  it("covers ambiguous bootstrap aliases and terminator edge cases", () => {
    expect(
      normalizeBootstrapInvocation(["create", "foo=", "x=1", "tags:agent", "--createmode", "progressive", "--label", "ui"]).trace,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: "tags:agent", to: ["--tags", "agent"], reason: "bare_key_value" }),
        expect.objectContaining({ from: "--createmode", to: ["--create-mode"], reason: "flag_alias" }),
      ]),
    );

    const ambiguousTypo = normalizeBootstrapInvocation(["create", "--stat", "open"]);
    expect(ambiguousTypo.argv).toEqual(["create", "--stat", "open"]);
    expect(ambiguousTypo.trace).toEqual([]);

    expect(coalesceRepeatedListFlags(["--tags", "one", "--tags", "--"], new Set(["--tags"]))).toEqual({
      argv: ["--tags", "one", "--tags", "--"],
      events: [],
    });

    const terminatorTrace: Parameters<typeof mergeLinkedTestTwoTokenEntries>[2] = [];
    expect(mergeLinkedTestTwoTokenEntries(["--add", "command", "pnpm test", "--", "--literal"], "test", terminatorTrace)).toEqual([
      "--add",
      "command=pnpm test",
      "--",
      "--literal",
    ]);
    expect(terminatorTrace).toEqual([
      {
        from: "--add command pnpm test",
        to: ["--add", "command=pnpm test"],
        reason: "bare_key_value",
        confidence: "high",
      },
    ]);
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
    const sample = program.commands.find((command) => command.name() === "sample");
    const titleAlias = sample?.options.find((option) => option.long === "--title-alias");
    if (titleAlias) {
      (titleAlias as unknown as { attributeName: string }).attributeName = "title";
    }
    sample?.option("--orphan-alias <value>", "Alias for --missing");

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

  it("renders root and subcommand JSON help summaries with fallback argument metadata", async () => {
    const program = new Command()
      .name("pm")
      .description("pm root")
      .exitOverride()
      .configureOutput({ writeOut: () => {}, writeErr: () => {} });
    program.option("--json", "JSON output").option("--quiet", "Suppress output");
    program.command("alpha").description("Alpha command");
    program.command("beta").alias("b").description("Beta command");
    program.command("legacy <target...>").description("Legacy args");

    const originalExitCode = process.exitCode;
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await expect(maybeRenderBootstrapJsonHelp(program, ["--json", "help"], new Map())).resolves.toBe(true);
      const rootPayload = JSON.parse(writeSpy.mock.calls.map((call) => String(call[0])).join(""));
      expect(rootPayload.resolved_path).toBe("pm");
      expect(rootPayload.has_subcommands).toBe(true);
      expect(rootPayload.subcommands).toEqual([
        { name: "alpha", aliases: [], description: "Alpha command" },
        { name: "beta", aliases: ["b"], description: "Beta command" },
        { name: "legacy", aliases: [], description: "Legacy args" },
      ]);

      writeSpy.mockClear();
      await expect(maybeRenderBootstrapJsonHelp(program, ["--json", "legacy", "--help"], new Map())).resolves.toBe(true);
      const legacyPayload = JSON.parse(writeSpy.mock.calls.map((call) => String(call[0])).join(""));
      expect(legacyPayload.arguments).toEqual([
        {
          name: "target",
          required: true,
          variadic: true,
          description: null,
        },
      ]);

      writeSpy.mockClear();
      await expect(maybeRenderBootstrapJsonHelp(program, ["alpha"], new Map())).resolves.toBe(false);
      await expect(maybeRenderBootstrapJsonHelp(program, ["--json", "alpha"], new Map())).resolves.toBe(false);
      expect(writeSpy).not.toHaveBeenCalled();
    } finally {
      writeSpy.mockRestore();
      process.exitCode = originalExitCode;
    }
  });

  it("merges extension JSON help metadata and quiets bootstrap help output", async () => {
    const program = new Command()
      .name("pm")
      .description("pm root")
      .exitOverride()
      .configureOutput({ writeOut: () => {}, writeErr: () => {} });
    program.option("--json", "JSON output");
    program.option("--quiet", "Suppress output");
    const tools = program.command("tools").description("Tool commands");
    tools
      .command("export [target]")
      .description("Export tools")
      .option("--format <kind>", "Format")
      .option("--format_alias <kind>", "Alias for --format");

    const descriptors = new Map([
      [
        "tools export",
        {
          command: "tools export",
          description: "Export from an extension",
          intent: "Export extension data",
          examples: ["pm tools export --format json", "pm tools export backup --format toon"],
          failure_hints: ["Choose a configured format"],
          flags: [
            {
              flag: "--dry-run",
              long: "--dry-run",
              description: "Preview export",
              type: "boolean",
            },
          ],
        },
      ],
    ]);

    const originalExitCode = process.exitCode;
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const handled = await maybeRenderBootstrapJsonHelp(
        program,
        ["--json", "tools", "export", "--help", "--explain"],
        descriptors,
      );
      expect(handled).toBe(true);
      const payload = JSON.parse(stdoutSpy.mock.calls.map((call) => String(call[0])).join(""));
      expect(payload).toMatchObject({
        detail_mode: "detailed",
        resolved_path: "tools export",
        intent: "Export extension data",
        examples: ["pm tools export --format json", "pm tools export backup --format toon"],
        tips: ["Choose a configured format"],
        has_subcommands: false,
      });
      expect(payload.arguments).toEqual([
        {
          name: "target",
          required: false,
          variadic: false,
          description: null,
        },
      ]);
      expect(payload.options).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ long: "--format", aliases: ["--format_alias"] }),
          expect.objectContaining({ long: "--dry-run", description: "Preview export" }),
        ]),
      );

      stdoutSpy.mockClear();
      stderrSpy.mockClear();
      await expect(maybeRenderBootstrapJsonHelp(program, ["--json", "--quiet", "missing", "--help"], descriptors)).resolves.toBe(
        true,
      );
      expect(process.exitCode).toBe(EXIT_CODE.USAGE);
      expect(stdoutSpy).not.toHaveBeenCalled();
      expect(stderrSpy).not.toHaveBeenCalled();
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
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
          {
            name: "Reminder",
            folder: "reminders",
            required_create_fields: [],
            required_create_repeatables: [],
            options: [],
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

    const reminderText = helpJsonTestOnly.buildCreateUpdatePolicyHelpText("create", registry, ["create", "--type", "Reminder"]);
    expect(reminderText).toContain("schedule preset: --schedule-preset lightweight");
    expect(reminderText).toContain("strict parity remains available via --create-mode strict.");
    expect(reminderText).toContain("type options: none");

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
