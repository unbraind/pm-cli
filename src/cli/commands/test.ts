import { exec as execCb } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathExists } from "../../core/fs/fs-utils.js";
import { parseCsvKv, parseOptionalNumber } from "../../core/item/parse.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { locateItem, mutateItem, readLocatedItem } from "../../core/store/item-store.js";
import { getSettingsPath, resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import { runInit } from "./init.js";
import { SCOPE_VALUES } from "../../types/index.js";
import type { LinkedTest, LinkScope } from "../../types/index.js";

const exec = promisify(execCb);
const TEST_OUTPUT_MAX_BUFFER_BYTES = 20 * 1024 * 1024;

export interface TestCommandOptions {
  add?: string[];
  remove?: string[];
  run?: boolean;
  timeout?: string;
  author?: string;
  message?: string;
  force?: boolean;
}

export interface TestRunResult {
  command?: string;
  path?: string;
  status: "passed" | "failed" | "skipped";
  exit_code?: number;
  stdout?: string;
  stderr?: string;
  error?: string;
}

export interface TestResult {
  id: string;
  tests: LinkedTest[];
  run_results: TestRunResult[];
  changed: boolean;
  count: number;
}

function resolveAuthor(candidate: string | undefined, fallback: string): string {
  const resolved = candidate ?? process.env.PM_AUTHOR ?? fallback;
  const trimmed = resolved.trim();
  return trimmed || "unknown";
}

function ensureScope(raw: string | undefined): LinkScope {
  const value = (raw ?? "project") as LinkScope;
  if (!SCOPE_VALUES.includes(value)) {
    throw new PmCliError(`Invalid scope "${raw}"`, EXIT_CODE.USAGE);
  }
  return value;
}

const PM_GLOBAL_FLAGS_WITH_VALUE = new Set(["--path"]);
const NPX_FLAGS_WITH_VALUE = new Set(["-p", "--package", "-c", "--call"]);
const PNPM_GLOBAL_FLAGS_WITH_VALUE = new Set([
  "-c",
  "-C",
  "--config",
  "--dir",
  "--filter",
  "--workspace-dir",
]);
const NPM_GLOBAL_FLAGS_WITH_VALUE = new Set(["-C", "--prefix", "--userconfig", "--cache"]);
const YARN_GLOBAL_FLAGS_WITH_VALUE = new Set(["--cwd"]);
const BUN_GLOBAL_FLAGS_WITH_VALUE = new Set(["--cwd"]);
const NPM_EXEC_SUBCOMMANDS = new Set(["exec", "x"]);
const SCRIPT_RUN_SUBCOMMANDS = new Set(["run", "run-script"]);
const SCRIPT_RUN_FLAGS_WITH_VALUE = new Set(["-C", "--dir", "--cwd", "-w", "--workspace", "--filter"]);

function splitNormalizedCommandSegments(normalizedCommand: string): string[] {
  return normalizedCommand
    .split(/&&|\|\||\||;/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

function stripLeadingEnvAssignments(tokens: string[]): string[] {
  let start = 0;
  if (tokens[start] === "env") {
    start += 1;
  }
  while (start < tokens.length) {
    const token = tokens[start];
    if (/^(?:[a-z_][a-z0-9_]*|\$env:[a-z_][a-z0-9_]*)=.*/.test(token)) {
      start += 1;
      continue;
    }
    break;
  }
  return tokens.slice(start);
}

function firstPmSubcommand(args: string[]): string | undefined {
  let index = 0;
  while (index < args.length) {
    const token = args[index];
    if (token === "--") {
      index += 1;
      continue;
    }
    if (token.startsWith("-")) {
      if (PM_GLOBAL_FLAGS_WITH_VALUE.has(token)) {
        index += 2;
        continue;
      }
      index += 1;
      continue;
    }
    return token;
  }
  return undefined;
}

function isPmExecutableToken(token: string): boolean {
  return token === "pm" || token.endsWith("/pm") || token.endsWith("/pm.cmd") || token.endsWith("/pm.exe");
}

function normalizePackageSpecifier(token: string): string {
  const trimmed = token.trim();
  if (!trimmed.startsWith("@")) {
    const versionSeparator = trimmed.indexOf("@");
    return versionSeparator === -1 ? trimmed : trimmed.slice(0, versionSeparator);
  }
  const scopeSeparator = trimmed.indexOf("/");
  if (scopeSeparator === -1) {
    return trimmed;
  }
  const versionSeparator = trimmed.indexOf("@", scopeSeparator + 1);
  return versionSeparator === -1 ? trimmed : trimmed.slice(0, versionSeparator);
}

function isPmCliPackageToken(token: string): boolean {
  const normalizedSpecifier = normalizePackageSpecifier(token);
  return (
    normalizedSpecifier === "pm-cli" ||
    normalizedSpecifier.endsWith("/pm-cli") ||
    token === "pm-cli" ||
    token.endsWith("/pm-cli")
  );
}

function isPmCliScriptToken(token: string): boolean {
  return token === "dist/cli.js" || token === "./dist/cli.js" || token.endsWith("/dist/cli.js");
}

function parseNpxCommand(tokens: string[]): { command: string; args: string[] } | null {
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token === "--") {
      index += 1;
      break;
    }
    if (!token.startsWith("-")) {
      break;
    }
    if (token.includes("=")) {
      index += 1;
      continue;
    }
    if (NPX_FLAGS_WITH_VALUE.has(token)) {
      index += 2;
      continue;
    }
    index += 1;
  }
  const command = tokens[index];
  if (!command) {
    return null;
  }
  return {
    command,
    args: tokens.slice(index + 1),
  };
}

function parseLauncherSubcommand(
  tokens: string[],
  flagsWithValue: Set<string>,
): { subcommand: string; args: string[] } | null {
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token === "--") {
      index += 1;
      continue;
    }
    if (token.startsWith("-")) {
      if (token.includes("=")) {
        index += 1;
        continue;
      }
      if (flagsWithValue.has(token)) {
        index += 2;
        continue;
      }
      index += 1;
      continue;
    }
    return {
      subcommand: token,
      args: tokens.slice(index + 1),
    };
  }
  return null;
}

function parsePnpmDlxCommand(tokens: string[]): { command: string; args: string[] } | null {
  const parsed = parseLauncherSubcommand(tokens, PNPM_GLOBAL_FLAGS_WITH_VALUE);
  if (parsed?.subcommand !== "dlx") {
    return null;
  }
  return parseNpxCommand(parsed.args);
}

function parseNpmExecCommand(tokens: string[]): { command: string; args: string[] } | null {
  const parsed = parseLauncherSubcommand(tokens, NPM_GLOBAL_FLAGS_WITH_VALUE);
  if (!parsed || !NPM_EXEC_SUBCOMMANDS.has(parsed.subcommand)) {
    return null;
  }
  return parseNpxCommand(parsed.args);
}

function resolveDirectRunnerSubcommand(parsed: { subcommand: string; args: string[] } | null): string | undefined {
  if (!parsed) {
    return undefined;
  }
  if (!SCRIPT_RUN_SUBCOMMANDS.has(parsed.subcommand)) {
    return parsed.subcommand;
  }
  return parseLauncherSubcommand(parsed.args, SCRIPT_RUN_FLAGS_WITH_VALUE)?.subcommand;
}

function firstDirectTestRunnerSubcommand(executable: string, args: string[]): string | undefined {
  if (executable === "npx") {
    return parseNpxCommand(args)?.command;
  }
  if (executable === "pnpm") {
    return resolveDirectRunnerSubcommand(parseLauncherSubcommand(args, PNPM_GLOBAL_FLAGS_WITH_VALUE));
  }
  if (executable === "npm") {
    return resolveDirectRunnerSubcommand(parseLauncherSubcommand(args, NPM_GLOBAL_FLAGS_WITH_VALUE));
  }
  if (executable === "yarn") {
    return resolveDirectRunnerSubcommand(parseLauncherSubcommand(args, YARN_GLOBAL_FLAGS_WITH_VALUE));
  }
  if (executable === "bun") {
    return resolveDirectRunnerSubcommand(parseLauncherSubcommand(args, BUN_GLOBAL_FLAGS_WITH_VALUE));
  }
  return undefined;
}

function isDirectTestRunnerSubcommand(token: string | undefined): boolean {
  if (!token) {
    return false;
  }
  return token === "vitest" || token === "test" || token.startsWith("test:");
}

function parsedLauncherInvokesRecursiveTestAll(parsed: { command: string; args: string[] } | null): boolean {
  if (!parsed) {
    return false;
  }
  if (!isPmExecutableToken(parsed.command) && !isPmCliPackageToken(parsed.command)) {
    return false;
  }
  return firstPmSubcommand(parsed.args) === "test-all";
}

function segmentInvokesRecursiveTestAll(segment: string): boolean {
  const rawTokens = segment.split(" ").filter((token) => token.length > 0);
  const tokens = stripLeadingEnvAssignments(rawTokens);
  if (tokens.length === 0) {
    return false;
  }

  const [executable, ...args] = tokens;
  if (isPmExecutableToken(executable) || isPmCliScriptToken(executable)) {
    return firstPmSubcommand(args) === "test-all";
  }

  if (executable === "node" && args.length > 0 && isPmCliScriptToken(args[0])) {
    return firstPmSubcommand(args.slice(1)) === "test-all";
  }

  if (executable === "npx") {
    return parsedLauncherInvokesRecursiveTestAll(parseNpxCommand(args));
  }

  if (executable === "pnpm") {
    return parsedLauncherInvokesRecursiveTestAll(parsePnpmDlxCommand(args));
  }

  if (executable === "npm") {
    return parsedLauncherInvokesRecursiveTestAll(parseNpmExecCommand(args));
  }

  return false;
}

function invokesRecursiveTestAllCommand(command: string): boolean {
  const normalized = normalizeCommandForValidation(command);
  return splitNormalizedCommandSegments(normalized).some((segment) => segmentInvokesRecursiveTestAll(segment));
}

function assertNoRecursiveTestAllCommand(command: string): void {
  if (!invokesRecursiveTestAllCommand(command)) return;
  throw new PmCliError(
    'Linked test commands must not invoke "pm test-all"; this creates recursive orchestration.',
    EXIT_CODE.USAGE,
  );
}

function normalizeCommandForValidation(command: string): string {
  return command
    .trim()
    .replaceAll("\\", "/")
    .replaceAll('"', "")
    .replaceAll("'", "")
    .replaceAll(/\s+/g, " ")
    .toLowerCase();
}

function commandUsesSandboxRunner(normalizedCommand: string): boolean {
  return (
    normalizedCommand.includes("node scripts/run-tests.mjs ") ||
    normalizedCommand.endsWith("node scripts/run-tests.mjs") ||
    normalizedCommand.includes("node ./scripts/run-tests.mjs ") ||
    normalizedCommand.endsWith("node ./scripts/run-tests.mjs")
  );
}

function segmentHasExplicitSandboxEnv(normalizedSegment: string): boolean {
  const hasExplicitPmPath = /\bpm_path\s*=/.test(normalizedSegment) || /\$env:pm_path\s*=/.test(normalizedSegment);
  const hasExplicitPmGlobalPath =
    /\bpm_global_path\s*=/.test(normalizedSegment) || /\$env:pm_global_path\s*=/.test(normalizedSegment);
  return hasExplicitPmPath && hasExplicitPmGlobalPath;
}

function commandInvokesDirectTestRunner(normalizedCommand: string): boolean {
  const rawTokens = normalizedCommand.split(" ").filter((token) => token.length > 0);
  const tokens = stripLeadingEnvAssignments(rawTokens);
  if (tokens.length === 0) {
    return false;
  }
  const [executable, ...args] = tokens;
  if (executable === "vitest" || executable.endsWith("/vitest") || executable.endsWith("/vitest.mjs")) {
    return true;
  }
  if (executable === "node") {
    return args[0] === "--test" || Boolean(args[0]?.endsWith("/vitest") || args[0]?.endsWith("/vitest.mjs"));
  }
  const subcommand = firstDirectTestRunnerSubcommand(executable, args);
  return isDirectTestRunnerSubcommand(subcommand);
}

function assertSandboxSafeTestRunnerCommand(command: string): void {
  const normalized = normalizeCommandForValidation(command);
  const segments = splitNormalizedCommandSegments(normalized);
  const hasUnsafeDirectRunnerSegment = segments.some(
    (segment) =>
      !commandUsesSandboxRunner(segment) &&
      commandInvokesDirectTestRunner(segment) &&
      !segmentHasExplicitSandboxEnv(segment),
  );

  if (!hasUnsafeDirectRunnerSegment) {
    return;
  }

  throw new PmCliError(
    'Linked test runner commands must be sandbox-safe: use "node scripts/run-tests.mjs <test|coverage>" or explicitly set both PM_PATH and PM_GLOBAL_PATH.',
    EXIT_CODE.USAGE,
  );
}

function getRuntimeSafetySkipReason(command: string): string | undefined {
  if (!invokesRecursiveTestAllCommand(command)) return undefined;
  return 'Linked test command skipped: Linked test commands must not invoke "pm test-all"; this creates recursive orchestration.';
}

function parseAddEntries(raw: string[] | undefined): LinkedTest[] {
  if (!raw) return [];
  return raw.map((entry) => {
    const kv = parseCsvKv(entry, "--add");
    const command = kv.command?.trim() || undefined;
    const filePath = kv.path?.trim() || undefined;
    if (!command && !filePath) {
      throw new PmCliError("--add requires command=<value> and/or path=<value>", EXIT_CODE.USAGE);
    }
    if (command) {
      assertNoRecursiveTestAllCommand(command);
      assertSandboxSafeTestRunnerCommand(command);
    }
    const timeoutSecondsRaw = kv.timeout_seconds?.trim();
    const timeoutAliasRaw = kv.timeout?.trim();
    if (timeoutSecondsRaw && timeoutAliasRaw && timeoutSecondsRaw !== timeoutAliasRaw) {
      throw new PmCliError("--add timeout and timeout_seconds must match when both are provided", EXIT_CODE.USAGE);
    }
    const timeoutRaw = timeoutSecondsRaw ?? timeoutAliasRaw;
    const timeoutSeconds =
      timeoutRaw === undefined ? undefined : Math.floor(parseOptionalNumber(timeoutRaw, "timeout_seconds"));
    return {
      command,
      path: filePath,
      scope: ensureScope(kv.scope),
      timeout_seconds: timeoutSeconds,
      note: kv.note?.trim() || undefined,
    };
  });
}

function parseRemoveEntries(raw: string[] | undefined): string[] {
  if (!raw) return [];
  return raw.map((entry) => {
    const trimmed = entry.trim();
    if (!trimmed) {
      throw new PmCliError("--remove requires command or path value", EXIT_CODE.USAGE);
    }
    if (trimmed.includes("=")) {
      const kv = parseCsvKv(trimmed, "--remove");
      const value = kv.path ?? kv.command;
      if (!value?.trim()) {
        throw new PmCliError("--remove requires command=<value> and/or path=<value>", EXIT_CODE.USAGE);
      }
      return value.trim();
    }
    return trimmed;
  });
}

export async function runLinkedTests(
  tests: LinkedTest[],
  defaultTimeoutSeconds: number | undefined,
): Promise<TestRunResult[]> {
  const results: TestRunResult[] = [];
  const sandboxRoot = await mkdtemp(path.join(tmpdir(), "pm-linked-test-"));
  const sandboxPmPath = path.join(sandboxRoot, "project", ".agents", "pm");
  const sandboxGlobalPath = path.join(sandboxRoot, "global");

  try {
    await runInit(undefined, { path: sandboxPmPath });
    for (const linkedTest of tests) {
      if (!linkedTest.command) {
        results.push({
          command: linkedTest.command,
          path: linkedTest.path,
          status: "skipped",
          error: "No command configured for this linked test.",
        });
        continue;
      }
      const runtimeSafetySkipReason = getRuntimeSafetySkipReason(linkedTest.command);
      if (runtimeSafetySkipReason) {
        results.push({
          command: linkedTest.command,
          path: linkedTest.path,
          status: "skipped",
          error: runtimeSafetySkipReason,
        });
        continue;
      }
      const timeoutMs = ((linkedTest.timeout_seconds ?? defaultTimeoutSeconds ?? 120) * 1000);
      try {
        const executed = await exec(linkedTest.command, {
          timeout: timeoutMs,
          cwd: process.cwd(),
          maxBuffer: TEST_OUTPUT_MAX_BUFFER_BYTES,
          env: {
            ...process.env,
            PM_PATH: sandboxPmPath,
            PM_GLOBAL_PATH: sandboxGlobalPath,
          },
        });
        results.push({
          command: linkedTest.command,
          path: linkedTest.path,
          status: "passed",
          exit_code: 0,
          stdout: executed.stdout,
          stderr: executed.stderr,
        });
      } catch (error: unknown) {
        const err = error as { code?: number; stdout?: string; stderr?: string; message?: string };
        results.push({
          command: linkedTest.command,
          path: linkedTest.path,
          status: "failed",
          exit_code: typeof err.code === "number" ? err.code : 1,
          stdout: err.stdout,
          stderr: err.stderr,
          error: err.message,
        });
      }
    }
  } finally {
    await rm(sandboxRoot, { recursive: true, force: true });
  }
  return results;
}

export async function runTest(id: string, options: TestCommandOptions, global: GlobalOptions): Promise<TestResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(`Tracker is not initialized at ${pmRoot}. Run pm init first.`, EXIT_CODE.NOT_FOUND);
  }
  const settings = await readSettings(pmRoot);
  const adds = parseAddEntries(options.add);
  const removes = parseRemoveEntries(options.remove);
  const shouldMutate = adds.length > 0 || removes.length > 0;

  let tests: LinkedTest[] = [];
  let itemId: string;

  if (shouldMutate) {
    const author = resolveAuthor(options.author, settings.author_default);
    const result = await mutateItem({
      pmRoot,
      settings,
      id,
      op: "tests_add",
      author,
      message: options.message,
      force: options.force,
      mutate(document) {
        const next = [...(document.front_matter.tests ?? [])];
        for (const add of adds) {
          const exists = next.some(
            (entry) => entry.command === add.command && entry.path === add.path && entry.scope === add.scope,
          );
          if (!exists) {
            next.push(add);
          }
        }
        if (removes.length > 0) {
          for (let i = next.length - 1; i >= 0; i -= 1) {
            const entry = next[i];
            if (removes.includes(entry.path ?? "") || removes.includes(entry.command ?? "")) {
              next.splice(i, 1);
            }
          }
        }
        document.front_matter.tests = next;
        return { changedFields: ["tests"] };
      },
    });
    tests = result.item.tests ?? [];
    itemId = result.item.id;
  } else {
    const located = await locateItem(pmRoot, id, settings.id_prefix);
    if (!located) {
      throw new PmCliError(`Item ${id} not found`, EXIT_CODE.NOT_FOUND);
    }
    itemId = located.id;
    const loaded = await readLocatedItem(located);
    tests = loaded.document.front_matter.tests ?? [];
  }

  let defaultTimeoutSeconds: number | undefined;
  if (options.timeout !== undefined) {
    defaultTimeoutSeconds = parseOptionalNumber(options.timeout, "timeout");
  }

  const runResults = options.run === true ? await runLinkedTests(tests, defaultTimeoutSeconds) : [];

  return {
    id: itemId,
    tests,
    run_results: runResults,
    changed: shouldMutate,
    count: tests.length,
  };
}
