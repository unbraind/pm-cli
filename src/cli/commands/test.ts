import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getActiveExtensionRegistrations } from "../../core/extensions/index.js";
import { pathExists } from "../../core/fs/fs-utils.js";
import { resolveItemTypeRegistry } from "../../core/item/type-registry.js";
import { createStdinTokenResolver, parseCsvKv, parseOptionalNumber } from "../../core/item/parse.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { locateItem, mutateItem, readLocatedItem } from "../../core/store/item-store.js";
import { getSettingsPath, resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import { runInit } from "./init.js";
import { SCOPE_VALUES } from "../../types/index.js";
import type { LinkedTest, LinkScope } from "../../types/index.js";

const TEST_OUTPUT_MAX_BUFFER_BYTES = 20 * 1024 * 1024;
const DEFAULT_LINKED_TEST_TIMEOUT_FORCE_KILL_DELAY_MS = 3000;
const DEFAULT_LINKED_TEST_HEARTBEAT_INTERVAL_MS = 10000;
const MAX_LINKED_TEST_COMMAND_LABEL_LENGTH = 120;

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function linkedTestTimeoutForceKillDelayMs(): number {
  return readPositiveIntegerEnv("PM_LINKED_TEST_TIMEOUT_FORCE_KILL_DELAY_MS", DEFAULT_LINKED_TEST_TIMEOUT_FORCE_KILL_DELAY_MS);
}

function linkedTestHeartbeatIntervalMs(): number {
  return readPositiveIntegerEnv("PM_LINKED_TEST_HEARTBEAT_INTERVAL_MS", DEFAULT_LINKED_TEST_HEARTBEAT_INTERVAL_MS);
}

interface LinkedTestExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal?: NodeJS.Signals | null;
  timedOut: boolean;
  maxBufferExceeded: boolean;
  spawnError?: string;
}

interface LinkedTestProgressContext {
  index: number;
  total: number;
  timeoutMs: number;
  command: string;
}

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
    if (
      trimmed.includes("=") ||
      /^(?:[-*+]\s+)?(?:path|command)\s*[:=]/i.test(trimmed) ||
      trimmed.startsWith("```")
    ) {
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

function closeLinkedTestStdin(child: ChildProcess): void {
  // Force EOF on child stdin so non-interactive runs do not wait on input.
  try {
    child.stdin?.end();
  } catch {
    // Child stdin can already be closed depending on command startup timing.
  }
}

function summarizeLinkedTestCommand(command: string): string {
  const normalized = command.trim().replaceAll(/\s+/g, " ");
  if (normalized.length <= MAX_LINKED_TEST_COMMAND_LABEL_LENGTH) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_LINKED_TEST_COMMAND_LABEL_LENGTH - 3)}...`;
}

function shouldEmitLinkedTestProgress(): boolean {
  return process.stderr.isTTY === true;
}

function emitLinkedTestProgress(message: string): void {
  try {
    process.stderr.write(`${message}\n`);
  } catch {
    // Ignore transient stderr write failures.
  }
}

function beginLinkedTestProgress(context: LinkedTestProgressContext): NodeJS.Timeout | null {
  if (!shouldEmitLinkedTestProgress()) {
    return null;
  }
  const commandLabel = summarizeLinkedTestCommand(context.command);
  const startAt = Date.now();
  emitLinkedTestProgress(
    `[pm test] linked-test ${context.index}/${context.total} start timeout_ms=${context.timeoutMs} command="${commandLabel}"`,
  );
  const heartbeat = setInterval(() => {
    const elapsedMs = Date.now() - startAt;
    emitLinkedTestProgress(
      `[pm test] linked-test ${context.index}/${context.total} running elapsed_ms=${elapsedMs} command="${commandLabel}"`,
    );
  }, linkedTestHeartbeatIntervalMs());
  heartbeat.unref?.();
  return heartbeat;
}

function endLinkedTestProgress(
  context: LinkedTestProgressContext,
  executionResult: Pick<LinkedTestExecutionResult, "timedOut" | "maxBufferExceeded" | "exitCode" | "signal">,
  startedAt: number,
): void {
  if (!shouldEmitLinkedTestProgress()) {
    return;
  }
  const commandLabel = summarizeLinkedTestCommand(context.command);
  const elapsedMs = Date.now() - startedAt;
  const failed = executionResult.timedOut || executionResult.maxBufferExceeded || executionResult.exitCode !== 0;
  const statusLabel = failed ? "failed" : "passed";
  const reasonTokens: string[] = [];
  if (executionResult.timedOut) {
    reasonTokens.push("reason=timeout");
  }
  if (executionResult.maxBufferExceeded) {
    reasonTokens.push("reason=max_buffer");
  }
  if (executionResult.signal) {
    reasonTokens.push(`signal=${executionResult.signal}`);
  }
  const exitLabel = executionResult.exitCode === null ? "null" : String(executionResult.exitCode);
  const reasonSuffix = reasonTokens.length > 0 ? ` ${reasonTokens.join(" ")}` : "";
  emitLinkedTestProgress(
    `[pm test] linked-test ${context.index}/${context.total} end status=${statusLabel} exit_code=${exitLabel} elapsed_ms=${elapsedMs}${reasonSuffix} command="${commandLabel}"`,
  );
}

async function killProcessTree(pid: number): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) {
    return;
  }
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.on("error", () => resolve());
      killer.on("close", () => resolve());
    });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
    return;
  } catch {
    // Fall back to direct child kill when no process group is available.
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // The process can already be gone.
  }
}

async function runLinkedTestCommand(
  command: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
  progressContext: LinkedTestProgressContext,
): Promise<LinkedTestExecutionResult> {
  const startedAt = Date.now();
  const heartbeat = beginLinkedTestProgress(progressContext);
  const child = spawn(command, {
    cwd: process.cwd(),
    env,
    shell: true,
    windowsHide: true,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  });
  closeLinkedTestStdin(child);

  let stdout = "";
  let stderr = "";
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let timedOut = false;
  let maxBufferExceeded = false;
  let spawnError: string | undefined;
  let forceKillTimer: NodeJS.Timeout | null = null;
  let timedOutTimer: NodeJS.Timeout | null = null;
  let terminationRequested = false;

  const clearTimers = (): void => {
    if (heartbeat) {
      clearInterval(heartbeat);
    }
    if (timedOutTimer) {
      clearTimeout(timedOutTimer);
      timedOutTimer = null;
    }
    if (forceKillTimer) {
      clearTimeout(forceKillTimer);
      forceKillTimer = null;
    }
  };

  const requestTermination = async (): Promise<void> => {
    if (terminationRequested) {
      return;
    }
    terminationRequested = true;
    const pid = child.pid;
    if (!pid || pid <= 0) {
      try {
        child.kill("SIGTERM");
      } catch {
        // Child can already be closed.
      }
      return;
    }
    if (process.platform === "win32") {
      await killProcessTree(pid);
      return;
    }
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        child.kill("SIGTERM");
      } catch {
        // Child can already be closed.
      }
    }
    forceKillTimer = setTimeout(() => {
      void killProcessTree(pid);
    }, linkedTestTimeoutForceKillDelayMs());
    forceKillTimer.unref?.();
  };

  const appendChunk = (chunk: Buffer | string, target: "stdout" | "stderr"): void => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const bytes = Buffer.byteLength(text);
    if (target === "stdout") {
      stdoutBytes += bytes;
      if (stdoutBytes <= TEST_OUTPUT_MAX_BUFFER_BYTES) {
        stdout += text;
      }
    } else {
      stderrBytes += bytes;
      if (stderrBytes <= TEST_OUTPUT_MAX_BUFFER_BYTES) {
        stderr += text;
      }
    }
    if (!maxBufferExceeded && (stdoutBytes > TEST_OUTPUT_MAX_BUFFER_BYTES || stderrBytes > TEST_OUTPUT_MAX_BUFFER_BYTES)) {
      maxBufferExceeded = true;
      void requestTermination();
    }
  };

  child.stdout?.on("data", (chunk) => appendChunk(chunk, "stdout"));
  child.stderr?.on("data", (chunk) => appendChunk(chunk, "stderr"));
  child.on("error", (error) => {
    spawnError = error.message;
  });

  timedOutTimer = setTimeout(() => {
    timedOut = true;
    void requestTermination();
  }, timeoutMs);
  timedOutTimer.unref?.();

  const { code, signal } = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on("close", (closeCode, closeSignal) => {
      resolve({
        code: closeCode,
        signal: closeSignal,
      });
    });
  });
  clearTimers();
  const executionResult: LinkedTestExecutionResult = {
    stdout,
    stderr,
    exitCode: code,
    signal,
    timedOut,
    maxBufferExceeded,
    spawnError,
  };
  endLinkedTestProgress(progressContext, executionResult, startedAt);
  return executionResult;
}

function formatLinkedTestExecutionError(result: LinkedTestExecutionResult, timeoutMs: number): string {
  const details: string[] = [];
  if (result.maxBufferExceeded) {
    details.push(
      `Linked test output exceeded maxBuffer=${TEST_OUTPUT_MAX_BUFFER_BYTES} bytes. Reduce output volume or split the command.`,
    );
  }
  if (result.timedOut && timeoutMs > 0) {
    details.push(`Linked test timed out after ${timeoutMs}ms.`);
  }
  const signalMessage = result.signal ? `Linked test command terminated by signal ${result.signal}.` : undefined;
  const baseMessage = result.spawnError?.trim() || signalMessage || "Linked test command failed.";
  if (details.length === 0) {
    return baseMessage;
  }
  return `${baseMessage} ${details.join(" ")}`;
}

export function resolveLinkedTestFailureExitCode(
  execution: Pick<LinkedTestExecutionResult, "exitCode" | "timedOut" | "maxBufferExceeded">,
): number {
  const rawExitCode = typeof execution.exitCode === "number" ? execution.exitCode : 1;
  if ((execution.timedOut || execution.maxBufferExceeded) && rawExitCode === 0) {
    return 1;
  }
  return rawExitCode;
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
    for (let index = 0; index < tests.length; index += 1) {
      const linkedTest = tests[index];
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
      const execution = await runLinkedTestCommand(
        linkedTest.command,
        timeoutMs,
        {
          ...process.env,
          FORCE_COLOR: "0",
          PM_PATH: sandboxPmPath,
          PM_GLOBAL_PATH: sandboxGlobalPath,
        },
        {
          index: index + 1,
          total: tests.length,
          timeoutMs,
          command: linkedTest.command,
        },
      );
      const passed = execution.exitCode === 0 && !execution.timedOut && !execution.maxBufferExceeded;
      if (passed) {
        results.push({
          command: linkedTest.command,
          path: linkedTest.path,
          status: "passed",
          exit_code: 0,
          stdout: execution.stdout,
          stderr: execution.stderr,
        });
        continue;
      }
      results.push({
        command: linkedTest.command,
        path: linkedTest.path,
        status: "failed",
        exit_code: resolveLinkedTestFailureExitCode(execution),
        stdout: execution.stdout,
        stderr: execution.stderr,
        error: formatLinkedTestExecutionError(execution, timeoutMs),
      });
    }
  } finally {
    await rm(sandboxRoot, { recursive: true, force: true });
  }
  return results;
}

export async function runTest(id: string, options: TestCommandOptions, global: GlobalOptions): Promise<TestResult> {
  const stdinResolver = createStdinTokenResolver();
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(`Tracker is not initialized at ${pmRoot}. Run pm init first.`, EXIT_CODE.NOT_FOUND);
  }
  const settings = await readSettings(pmRoot);
  const typeRegistry = resolveItemTypeRegistry(settings, getActiveExtensionRegistrations());
  const resolvedAdds = await stdinResolver.resolveList(options.add, "--add");
  const resolvedRemoves = await stdinResolver.resolveList(options.remove, "--remove");
  const adds = parseAddEntries(resolvedAdds);
  const removes = parseRemoveEntries(resolvedRemoves);
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
    const located = await locateItem(pmRoot, id, settings.id_prefix, settings.item_format, typeRegistry.type_to_folder);
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
