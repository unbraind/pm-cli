import { spawn, type ChildProcess } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getActiveExtensionRegistrations } from "../../core/extensions/index.js";
import { pathExists } from "../../core/fs/fs-utils.js";
import { resolveItemTypeRegistry } from "../../core/item/type-registry.js";
import { createStdinTokenResolver, parseCsvKv, parseOptionalNumber } from "../../core/item/parse.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { nowIso } from "../../core/shared/time.js";
import { locateItem, mutateItem, readLocatedItem } from "../../core/store/item-store.js";
import { getSettingsPath, ITEM_FILE_EXTENSIONS, resolveGlobalPmRoot, resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import { appendTrackedTestRunSummary } from "../../core/test/item-test-run-tracking.js";
import { runInit } from "./init.js";
import { SCOPE_VALUES } from "../../types/index.js";
import type { LinkedTest, LinkScope } from "../../types/index.js";

const TEST_OUTPUT_MAX_BUFFER_BYTES = 20 * 1024 * 1024;
const DEFAULT_LINKED_TEST_TIMEOUT_FORCE_KILL_DELAY_MS = 3000;
const DEFAULT_LINKED_TEST_HEARTBEAT_INTERVAL_MS = 10000;
const MAX_LINKED_TEST_COMMAND_LABEL_LENGTH = 120;
const LINKED_TEST_PROTECTED_ENV_KEYS = new Set(["PM_PATH", "PM_GLOBAL_PATH", "FORCE_COLOR"]);
const LINKED_TEST_ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PM_CONTEXT_MODE_VALUES = ["schema", "tracker", "auto"] as const;
type LinkedTestPmContextMode = (typeof PM_CONTEXT_MODE_VALUES)[number];
type ResolvedLinkedTestPmContextMode = Exclude<LinkedTestPmContextMode, "auto">;
const LINKED_TEST_TRACKER_DIRS_TO_SKIP = new Set(["locks", "extensions"]);
const LINKED_TEST_ITEM_COUNT_DIRS_TO_SKIP = new Set(["history", "index", "search", "extensions", "locks"]);
const LINKED_TEST_INFRA_COLLISION_PATTERNS = [
  /eaddrinuse/i,
  /address already in use/i,
  /port\s+\d+\s+is already in use/i,
  /web server[^.\n]*already running/i,
  /failed to listen on/i,
];
const PM_SUBCOMMANDS_WITH_ITEM_REFERENCE = new Set([
  "get",
  "history",
  "restore",
  "update",
  "close",
  "delete",
  "append",
  "claim",
  "release",
  "comments",
  "notes",
  "learnings",
  "files",
  "docs",
  "deps",
  "test",
]);
const PM_TRACKER_READ_SUBCOMMANDS = new Set([
  "activity",
  "calendar",
  "context",
  "ctx",
  "deps",
  "get",
  "health",
  "history",
  "list",
  "list-all",
  "list-blocked",
  "list-canceled",
  "list-closed",
  "list-draft",
  "list-in-progress",
  "list-open",
  "search",
  "stats",
  "test-all",
  "validate",
]);

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

type LinkedTestProgressMode = "auto" | "always" | "off";

interface LinkedTestSandboxSourceRoots {
  projectPmRoot: string;
  globalPmRoot: string;
}

interface LinkedTestRuntimeDirectives {
  env_set: Record<string, string>;
  env_clear: string[];
  shared_host_safe: boolean;
}

export interface TestCommandOptions {
  add?: string[];
  remove?: string[];
  run?: boolean;
  timeout?: string;
  progress?: boolean;
  envSet?: string[];
  envClear?: string[];
  sharedHostSafe?: boolean;
  pmContext?: string;
  overrideLinkedPmContext?: boolean;
  failOnContextMismatch?: boolean;
  failOnSkipped?: boolean;
  failOnEmptyTestRun?: boolean;
  requireAssertionsForPm?: boolean;
  author?: string;
  message?: string;
  force?: boolean;
}

export type LinkedTestFailureCategory =
  | "infra_collision"
  | "assertion_failure"
  | "empty_run"
  | "timeout"
  | "max_buffer"
  | "spawn_error"
  | "signal";

export interface TestRunResult {
  command?: string;
  path?: string;
  status: "passed" | "failed" | "skipped";
  exit_code?: number;
  failure_category?: LinkedTestFailureCategory;
  execution_context?: {
    pm_context_mode: LinkedTestPmContextMode;
    is_pm_command: boolean;
    is_pm_tracker_read_command: boolean;
    source_project_pm_path: string;
    sandbox_project_pm_path: string;
    source_global_pm_path: string;
    sandbox_global_pm_path: string;
    source_project_item_count: number;
    sandbox_project_item_count: number;
    source_global_item_count: number;
    sandbox_global_item_count: number;
    mismatch_detected: boolean;
    project_extensions_seeded: boolean;
    global_extensions_seeded: boolean;
  };
  stdout?: string;
  stderr?: string;
  error?: string;
}

export interface TestResult {
  id: string;
  tests: LinkedTest[];
  run_results: TestRunResult[];
  failure_categories: Record<LinkedTestFailureCategory, number>;
  fail_on_skipped_triggered?: boolean;
  warnings?: string[];
  changed: boolean;
  count: number;
}

function resolveAuthor(candidate: string | undefined, fallback: string): string {
  const resolved = candidate ?? process.env.PM_AUTHOR ?? fallback;
  const trimmed = resolved.trim();
  return trimmed || "unknown";
}

function resolveTrackedRunId(kind: "test" | "test-all"): string {
  const fromEnv = process.env.PM_BACKGROUND_TEST_RUN_ID?.trim();
  if (fromEnv && fromEnv.length > 0) {
    return fromEnv;
  }
  return `${kind}-local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function summarizeRunResultStatuses(results: TestRunResult[]): { passed: number; failed: number; skipped: number } {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const entry of results) {
    if (entry.status === "passed") {
      passed += 1;
      continue;
    }
    if (entry.status === "failed") {
      failed += 1;
      continue;
    }
    skipped += 1;
  }
  return { passed, failed, skipped };
}

function ensureScope(raw: string | undefined): LinkScope {
  const value = (raw ?? "project") as LinkScope;
  if (!SCOPE_VALUES.includes(value)) {
    throw new PmCliError(`Invalid scope "${raw}"`, EXIT_CODE.USAGE);
  }
  return value;
}

function parseLinkedTestBooleanValue(raw: string | undefined, optionName: string, fieldLabel: string): boolean | undefined {
  if (!raw || raw.trim().length === 0) {
    return undefined;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes") {
    return true;
  }
  if (normalized === "false" || normalized === "0" || normalized === "no") {
    return false;
  }
  throw new PmCliError(`${optionName} ${fieldLabel} must be one of true|false|1|0|yes|no`, EXIT_CODE.USAGE);
}

function parseLinkedTestEnvSetValue(raw: string | undefined, optionName: string): Record<string, string> | undefined {
  if (!raw || raw.trim().length === 0) {
    return undefined;
  }
  const assignments = raw
    .split(/[;\n]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (assignments.length === 0) {
    throw new PmCliError(`${optionName} env_set must include at least one KEY=VALUE assignment`, EXIT_CODE.USAGE);
  }
  const envSet: Record<string, string> = {};
  for (const assignment of assignments) {
    const separatorIndex = assignment.indexOf("=");
    if (separatorIndex <= 0) {
      throw new PmCliError(
        `${optionName} env_set entries must use KEY=VALUE and be separated by semicolons. Example: env_set=PORT=0;PLAYWRIGHT_BASE_URL=http://127.0.0.1:4173`,
        EXIT_CODE.USAGE,
      );
    }
    const key = assignment.slice(0, separatorIndex).trim();
    const value = assignment.slice(separatorIndex + 1);
    if (!LINKED_TEST_ENV_NAME_PATTERN.test(key)) {
      throw new PmCliError(`${optionName} env_set key "${key}" is invalid`, EXIT_CODE.USAGE);
    }
    if (LINKED_TEST_PROTECTED_ENV_KEYS.has(key.toUpperCase())) {
      throw new PmCliError(`${optionName} env_set key "${key}" is reserved for sandbox safety`, EXIT_CODE.USAGE);
    }
    envSet[key] = value;
  }
  return Object.keys(envSet).length > 0 ? envSet : undefined;
}

function parseLinkedTestEnvClearValue(raw: string | undefined, optionName: string): string[] | undefined {
  if (!raw || raw.trim().length === 0) {
    return undefined;
  }
  const values = [...new Set(raw.split(/[;,\n]/).map((entry) => entry.trim()).filter((entry) => entry.length > 0))];
  if (values.length === 0) {
    throw new PmCliError(`${optionName} env_clear must include at least one environment variable name`, EXIT_CODE.USAGE);
  }
  for (const key of values) {
    if (!LINKED_TEST_ENV_NAME_PATTERN.test(key)) {
      throw new PmCliError(`${optionName} env_clear key "${key}" is invalid`, EXIT_CODE.USAGE);
    }
    if (LINKED_TEST_PROTECTED_ENV_KEYS.has(key.toUpperCase())) {
      throw new PmCliError(`${optionName} env_clear key "${key}" is reserved for sandbox safety`, EXIT_CODE.USAGE);
    }
  }
  return values;
}

function parseLinkedTestStringList(raw: string | undefined): string[] | undefined {
  if (!raw || raw.trim().length === 0) {
    return undefined;
  }
  const values = [...new Set(raw.split(/[;\n]/).map((entry) => entry.trim()).filter((entry) => entry.length > 0))];
  return values.length > 0 ? values : undefined;
}

function parseLinkedTestRegexList(raw: string | undefined, optionName: string, fieldLabel: string): string[] | undefined {
  const values = parseLinkedTestStringList(raw);
  if (!values || values.length === 0) {
    return undefined;
  }
  for (const pattern of values) {
    try {
      // Validate syntax when linked-test metadata is added.
      new RegExp(pattern, "m");
    } catch (error: unknown) {
      throw new PmCliError(
        `${optionName} ${fieldLabel} includes invalid regex "${pattern}": ${error instanceof Error ? error.message : String(error)}`,
        EXIT_CODE.USAGE,
      );
    }
  }
  return values;
}

function parseLinkedTestMinLines(raw: string | undefined, optionName: string): number | undefined {
  if (!raw || raw.trim().length === 0) {
    return undefined;
  }
  const parsed = parseOptionalNumber(raw, "assert_stdout_min_lines");
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new PmCliError(`${optionName} assert_stdout_min_lines must be an integer >= 0`, EXIT_CODE.USAGE);
  }
  return parsed;
}

function parseLinkedTestAssertionEqualsMap(raw: string | undefined, optionName: string): Record<string, string> | undefined {
  if (!raw || raw.trim().length === 0) {
    return undefined;
  }
  const assignments = raw
    .split(/[;\n]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (assignments.length === 0) {
    throw new PmCliError(`${optionName} assert_json_field_equals must include at least one path=value assignment`, EXIT_CODE.USAGE);
  }
  const values: Record<string, string> = {};
  for (const assignment of assignments) {
    const separatorIndex = assignment.indexOf("=");
    if (separatorIndex <= 0) {
      throw new PmCliError(
        `${optionName} assert_json_field_equals entries must use path=value and be separated by semicolons`,
        EXIT_CODE.USAGE,
      );
    }
    const key = assignment.slice(0, separatorIndex).trim();
    const value = assignment.slice(separatorIndex + 1).trim();
    if (key.length === 0 || value.length === 0) {
      throw new PmCliError(`${optionName} assert_json_field_equals entries must include non-empty path and value`, EXIT_CODE.USAGE);
    }
    values[key] = value;
  }
  return Object.keys(values).length > 0 ? values : undefined;
}

function parseLinkedTestAssertionGteMap(raw: string | undefined, optionName: string): Record<string, number> | undefined {
  if (!raw || raw.trim().length === 0) {
    return undefined;
  }
  const assignments = raw
    .split(/[;\n]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (assignments.length === 0) {
    throw new PmCliError(`${optionName} assert_json_field_gte must include at least one path=value assignment`, EXIT_CODE.USAGE);
  }
  const values: Record<string, number> = {};
  for (const assignment of assignments) {
    const separatorIndex = assignment.indexOf("=");
    if (separatorIndex <= 0) {
      throw new PmCliError(
        `${optionName} assert_json_field_gte entries must use path=value and be separated by semicolons`,
        EXIT_CODE.USAGE,
      );
    }
    const key = assignment.slice(0, separatorIndex).trim();
    const valueRaw = assignment.slice(separatorIndex + 1).trim();
    if (key.length === 0 || valueRaw.length === 0) {
      throw new PmCliError(`${optionName} assert_json_field_gte entries must include non-empty path and value`, EXIT_CODE.USAGE);
    }
    const value = Number.parseFloat(valueRaw);
    if (!Number.isFinite(value)) {
      throw new PmCliError(`${optionName} assert_json_field_gte value for "${key}" must be numeric`, EXIT_CODE.USAGE);
    }
    values[key] = value;
  }
  return Object.keys(values).length > 0 ? values : undefined;
}

function parseLinkedTestContextModeValue(
  raw: string | undefined,
  optionName: string,
): LinkedTest["pm_context_mode"] | undefined {
  if (!raw || raw.trim().length === 0) {
    return undefined;
  }
  const normalized = raw.trim().toLowerCase();
  if ((PM_CONTEXT_MODE_VALUES as readonly string[]).includes(normalized)) {
    return normalized as LinkedTest["pm_context_mode"];
  }
  throw new PmCliError(
    `${optionName} pm_context_mode must be one of: ${PM_CONTEXT_MODE_VALUES.join(", ")}`,
    EXIT_CODE.USAGE,
  );
}

function parsePmContextMode(raw: string | undefined): LinkedTestPmContextMode {
  if (!raw) {
    return "schema";
  }
  const normalized = raw.trim().toLowerCase();
  if ((PM_CONTEXT_MODE_VALUES as readonly string[]).includes(normalized)) {
    return normalized as LinkedTestPmContextMode;
  }
  throw new PmCliError(
    `Invalid --pm-context value "${raw}". Expected one of: ${PM_CONTEXT_MODE_VALUES.join(", ")}`,
    EXIT_CODE.USAGE,
  );
}

function resolveLinkedTestRequestedContextMode(
  linkedTest: LinkedTest,
  runLevelMode: LinkedTestPmContextMode,
  overrideLinkedPmContext: boolean,
): LinkedTestPmContextMode {
  if (overrideLinkedPmContext) {
    return runLevelMode;
  }
  if (typeof linkedTest.pm_context_mode !== "string" || linkedTest.pm_context_mode.trim().length === 0) {
    return runLevelMode;
  }
  return parsePmContextMode(linkedTest.pm_context_mode);
}

function resolveLinkedTestEffectiveContextMode(
  requestedMode: LinkedTestPmContextMode,
  isPmTrackerReadCommand: boolean,
): ResolvedLinkedTestPmContextMode {
  if (requestedMode === "auto") {
    return isPmTrackerReadCommand ? "tracker" : "schema";
  }
  return requestedMode;
}

function hasLinkedTestAssertions(linkedTest: LinkedTest): boolean {
  return (
    (linkedTest.assert_stdout_contains?.length ?? 0) > 0 ||
    (linkedTest.assert_stdout_regex?.length ?? 0) > 0 ||
    (linkedTest.assert_stderr_contains?.length ?? 0) > 0 ||
    (linkedTest.assert_stderr_regex?.length ?? 0) > 0 ||
    typeof linkedTest.assert_stdout_min_lines === "number" ||
    Object.keys(linkedTest.assert_json_field_equals ?? {}).length > 0 ||
    Object.keys(linkedTest.assert_json_field_gte ?? {}).length > 0
  );
}

function buildPmContextMismatchHint(params: {
  executionContext: NonNullable<TestRunResult["execution_context"]>;
  runLevelPmContextMode: LinkedTestPmContextMode;
  linkedOverridePmContextMode: LinkedTestPmContextMode | undefined;
}): string {
  const { executionContext, runLevelPmContextMode, linkedOverridePmContextMode } = params;
  if (!executionContext.is_pm_tracker_read_command || !executionContext.mismatch_detected) {
    return "";
  }
  if (runLevelPmContextMode === "tracker" && linkedOverridePmContextMode === "schema") {
    return (
      " Linked test metadata pm_context_mode=schema overrides run-level --pm-context tracker." +
      " Set pm_context_mode=tracker (or auto) on the linked test, or remove the override, to run against seeded tracker data."
    );
  }
  if (executionContext.pm_context_mode === "schema") {
    return " Use --pm-context tracker to run PM tracker-read commands against seeded tracker data.";
  }
  return "";
}

function mergeEnvSetDirectives(entries: string[] | undefined, optionName: string): Record<string, string> {
  const merged: Record<string, string> = {};
  if (!entries) {
    return merged;
  }
  for (const entry of entries) {
    const parsed = parseLinkedTestEnvSetValue(entry, optionName);
    if (!parsed) {
      continue;
    }
    for (const [key, value] of Object.entries(parsed)) {
      merged[key] = value;
    }
  }
  return merged;
}

function mergeEnvClearDirectives(entries: string[] | undefined, optionName: string): string[] {
  if (!entries) {
    return [];
  }
  const values: string[] = [];
  for (const entry of entries) {
    const parsed = parseLinkedTestEnvClearValue(entry, optionName);
    if (parsed) {
      values.push(...parsed);
    }
  }
  return [...new Set(values)];
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

function resolvePmSubcommandContext(args: string[]): { subcommand: string; remaining: string[] } | null {
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
    return {
      subcommand: token,
      remaining: args.slice(index + 1),
    };
  }
  return null;
}

function firstPositionalToken(tokens: string[]): string | undefined {
  for (const token of tokens) {
    if (!token.startsWith("-")) {
      return token;
    }
  }
  return undefined;
}

function looksLikePrefixedItemId(token: string, idPrefix: string): boolean {
  const normalizedPrefix = idPrefix.trim().toLowerCase().replace(/-+$/, "");
  if (normalizedPrefix.length === 0) {
    return false;
  }
  const normalized = token.trim().toLowerCase();
  if (!normalized.startsWith(`${normalizedPrefix}-`)) {
    return false;
  }
  return normalized.length > normalizedPrefix.length + 1;
}

function extractPmInvocationArgsFromSegment(segment: string): string[] | null {
  const rawTokens = segment.split(" ").filter((token) => token.length > 0);
  const tokens = stripLeadingEnvAssignments(rawTokens);
  if (tokens.length === 0) {
    return null;
  }
  const [executable, ...args] = tokens;
  if (isPmExecutableToken(executable) || isPmCliScriptToken(executable)) {
    return args;
  }
  if (executable === "node" && args.length > 0 && isPmCliScriptToken(args[0])) {
    return args.slice(1);
  }
  if (executable === "npx") {
    const parsed = parseNpxCommand(args);
    if (parsed && (isPmExecutableToken(parsed.command) || isPmCliPackageToken(parsed.command))) {
      return parsed.args;
    }
  }
  if (executable === "pnpm") {
    const parsed = parsePnpmDlxCommand(args);
    if (parsed && (isPmExecutableToken(parsed.command) || isPmCliPackageToken(parsed.command))) {
      return parsed.args;
    }
  }
  if (executable === "npm") {
    const parsed = parseNpmExecCommand(args);
    if (parsed && (isPmExecutableToken(parsed.command) || isPmCliPackageToken(parsed.command))) {
      return parsed.args;
    }
  }
  return null;
}

function commandInvokesPmCli(command: string): boolean {
  const normalizedCommand = normalizeCommandForValidation(command);
  return splitNormalizedCommandSegments(normalizedCommand).some((segment) => extractPmInvocationArgsFromSegment(segment) !== null);
}

function commandInvokesPmTrackerReadCommand(command: string): boolean {
  const normalizedCommand = normalizeCommandForValidation(command);
  return splitNormalizedCommandSegments(normalizedCommand).some((segment) => {
    const invocationArgs = extractPmInvocationArgsFromSegment(segment);
    if (!invocationArgs) {
      return false;
    }
    const context = resolvePmSubcommandContext(invocationArgs);
    if (!context) {
      return false;
    }
    return PM_TRACKER_READ_SUBCOMMANDS.has(context.subcommand);
  });
}

export function extractReferencedPmItemIdsFromCommand(command: string, idPrefix = "pm"): string[] {
  const normalizedCommand = normalizeCommandForValidation(command);
  const ids = new Set<string>();
  for (const segment of splitNormalizedCommandSegments(normalizedCommand)) {
    const invocationArgs = extractPmInvocationArgsFromSegment(segment);
    if (!invocationArgs) {
      continue;
    }
    const context = resolvePmSubcommandContext(invocationArgs);
    if (!context) {
      continue;
    }
    if (!PM_SUBCOMMANDS_WITH_ITEM_REFERENCE.has(context.subcommand)) {
      continue;
    }
    const candidate = firstPositionalToken(context.remaining);
    if (!candidate) {
      continue;
    }
    if (looksLikePrefixedItemId(candidate, idPrefix)) {
      ids.add(candidate);
    }
  }
  return [...ids].sort((left, right) => left.localeCompare(right));
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
    if (!command) {
      throw new PmCliError("--add requires command=<value> (path=<value> is optional metadata)", EXIT_CODE.USAGE);
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
    const envSet = parseLinkedTestEnvSetValue(kv.env_set?.trim(), "--add");
    const envClear = parseLinkedTestEnvClearValue(kv.env_clear?.trim(), "--add");
    const pmContextMode = parseLinkedTestContextModeValue(kv.pm_context_mode?.trim(), "--add");
    const sharedHostSafe = parseLinkedTestBooleanValue(kv.shared_host_safe?.trim(), "--add", "shared_host_safe");
    return {
      command,
      path: filePath,
      scope: ensureScope(kv.scope),
      timeout_seconds: timeoutSeconds,
      pm_context_mode: pmContextMode,
      env_set: envSet,
      env_clear: envClear,
      shared_host_safe: sharedHostSafe,
      assert_stdout_contains: parseLinkedTestStringList(kv.assert_stdout_contains?.trim()),
      assert_stdout_regex: parseLinkedTestRegexList(kv.assert_stdout_regex?.trim(), "--add", "assert_stdout_regex"),
      assert_stderr_contains: parseLinkedTestStringList(kv.assert_stderr_contains?.trim()),
      assert_stderr_regex: parseLinkedTestRegexList(kv.assert_stderr_regex?.trim(), "--add", "assert_stderr_regex"),
      assert_stdout_min_lines: parseLinkedTestMinLines(kv.assert_stdout_min_lines?.trim(), "--add"),
      assert_json_field_equals: parseLinkedTestAssertionEqualsMap(kv.assert_json_field_equals?.trim(), "--add"),
      assert_json_field_gte: parseLinkedTestAssertionGteMap(kv.assert_json_field_gte?.trim(), "--add"),
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

function shouldEmitLinkedTestProgress(mode: LinkedTestProgressMode): boolean {
  /* c8 ignore start -- reserved for future explicit "off" mode wiring. */
  if (mode === "off") {
    return false;
  }
  /* c8 ignore stop */
  if (mode === "always") {
    return true;
  }
  return process.stderr.isTTY === true;
}

function emitLinkedTestProgress(message: string): void {
  try {
    process.stderr.write(`${message}\n`);
  } catch {
    // Ignore transient stderr write failures.
  }
}

function beginLinkedTestProgress(context: LinkedTestProgressContext, mode: LinkedTestProgressMode): NodeJS.Timeout | null {
  if (!shouldEmitLinkedTestProgress(mode)) {
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
  mode: LinkedTestProgressMode,
): void {
  if (!shouldEmitLinkedTestProgress(mode)) {
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

/* c8 ignore start -- process-tree teardown paths are highly platform-dependent. */
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
/* c8 ignore stop */

async function runLinkedTestCommand(
  command: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
  progressContext: LinkedTestProgressContext,
  progressMode: LinkedTestProgressMode,
): Promise<LinkedTestExecutionResult> {
  const startedAt = Date.now();
  const heartbeat = beginLinkedTestProgress(progressContext, progressMode);
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

  /* c8 ignore start -- timeout termination branches depend on scheduler/process-group timing. */
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
      /* c8 ignore next 4 -- platform-specific process-group fallback path. */
      try {
        child.kill("SIGTERM");
      } catch {
        // Child can already be closed.
      }
    }
    /* c8 ignore next 3 -- exercised only when timeout escalation triggers force-kill fallback. */
    forceKillTimer = setTimeout(() => {
      void killProcessTree(pid);
    }, linkedTestTimeoutForceKillDelayMs());
    forceKillTimer.unref?.();
  };
  /* c8 ignore stop */

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
  /* c8 ignore next 5 -- shell spawn error callbacks are non-deterministic across platforms. */
  child.on("error", (error) => {
    spawnError = error.message;
  });

  /* c8 ignore next 4 -- callback scheduling timing is non-deterministic under coverage instrumentation. */
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
  endLinkedTestProgress(progressContext, executionResult, startedAt, progressMode);
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

function hasInfraCollisionSignal(result: Pick<LinkedTestExecutionResult, "stdout" | "stderr" | "spawnError">): boolean {
  const combined = [result.spawnError ?? "", result.stderr, result.stdout].join("\n");
  return LINKED_TEST_INFRA_COLLISION_PATTERNS.some((pattern) => pattern.test(combined));
}

export function classifyLinkedTestFailure(
  result: Pick<LinkedTestExecutionResult, "stdout" | "stderr" | "spawnError" | "signal" | "timedOut" | "maxBufferExceeded">,
): LinkedTestFailureCategory {
  if (hasInfraCollisionSignal(result)) {
    return "infra_collision";
  }
  if (result.timedOut) {
    return "timeout";
  }
  if (result.maxBufferExceeded) {
    return "max_buffer";
  }
  if (result.spawnError) {
    return "spawn_error";
  }
  if (result.signal) {
    return "signal";
  }
  return "assertion_failure";
}

function createEmptyFailureCategoryCounts(): Record<LinkedTestFailureCategory, number> {
  return {
    infra_collision: 0,
    assertion_failure: 0,
    empty_run: 0,
    timeout: 0,
    max_buffer: 0,
    spawn_error: 0,
    signal: 0,
  };
}

export function countFailureCategories(runResults: TestRunResult[]): Record<LinkedTestFailureCategory, number> {
  const counts = createEmptyFailureCategoryCounts();
  for (const result of runResults) {
    if (result.status !== "failed" || !result.failure_category) {
      continue;
    }
    counts[result.failure_category] += 1;
  }
  return counts;
}

function applyEnvDirectiveStage(env: NodeJS.ProcessEnv, directives: Pick<LinkedTestRuntimeDirectives, "env_set" | "env_clear">): void {
  for (const [key, value] of Object.entries(directives.env_set)) {
    if (LINKED_TEST_PROTECTED_ENV_KEYS.has(key.toUpperCase())) {
      continue;
    }
    env[key] = value;
  }
  for (const key of directives.env_clear) {
    if (LINKED_TEST_PROTECTED_ENV_KEYS.has(key.toUpperCase())) {
      continue;
    }
    delete env[key];
  }
}

function applySharedHostSafeDefaults(env: NodeJS.ProcessEnv): void {
  if (env.PORT === undefined) {
    env.PORT = "0";
  }
  if (env.HOST === undefined) {
    env.HOST = "127.0.0.1";
  }
  if (env.PM_SHARED_HOST_SAFE === undefined) {
    env.PM_SHARED_HOST_SAFE = "1";
  }
  if (env.PLAYWRIGHT_HTML_OPEN === undefined) {
    env.PLAYWRIGHT_HTML_OPEN = "never";
  }
  if (env.PW_TEST_HTML_REPORT_OPEN === undefined) {
    env.PW_TEST_HTML_REPORT_OPEN = "never";
  }
}

function resolveEffectiveLinkedTestDirectives(
  runtimeDirectives: LinkedTestRuntimeDirectives,
  linkedTest: LinkedTest,
): LinkedTestRuntimeDirectives {
  const envSet = { ...runtimeDirectives.env_set, ...(linkedTest.env_set ?? {}) };
  const envClear = [...new Set([...runtimeDirectives.env_clear, ...(linkedTest.env_clear ?? [])])];
  const sharedHostSafe = linkedTest.shared_host_safe ?? runtimeDirectives.shared_host_safe;
  return {
    env_set: envSet,
    env_clear: envClear,
    shared_host_safe: sharedHostSafe,
  };
}

function resolveRuntimeDirectives(
  envSetEntries: string[] | undefined,
  envClearEntries: string[] | undefined,
  sharedHostSafe: boolean | undefined,
): LinkedTestRuntimeDirectives {
  return {
    env_set: mergeEnvSetDirectives(envSetEntries, "--env-set"),
    env_clear: mergeEnvClearDirectives(envClearEntries, "--env-clear"),
    shared_host_safe: sharedHostSafe === true,
  };
}

async function copyIntoSandboxIfPresent(sourcePath: string, targetPath: string, recursive = false): Promise<void> {
  if (!(await pathExists(sourcePath))) {
    return;
  }
  await mkdir(path.dirname(targetPath), { recursive: true });
  if (recursive) {
    await cp(sourcePath, targetPath, { recursive: true, force: true });
    return;
  }
  await cp(sourcePath, targetPath, { force: true });
}

async function seedLinkedTestSandbox(
  sandboxPmPath: string,
  sandboxGlobalPath: string,
  sourceRoots: LinkedTestSandboxSourceRoots,
): Promise<void> {
  await copyIntoSandboxIfPresent(getSettingsPath(sourceRoots.projectPmRoot), getSettingsPath(sandboxPmPath));
  await copyIntoSandboxIfPresent(
    path.join(sourceRoots.projectPmRoot, "extensions"),
    path.join(sandboxPmPath, "extensions"),
    true,
  );
  await copyIntoSandboxIfPresent(getSettingsPath(sourceRoots.globalPmRoot), getSettingsPath(sandboxGlobalPath));
  await copyIntoSandboxIfPresent(
    path.join(sourceRoots.globalPmRoot, "extensions"),
    path.join(sandboxGlobalPath, "extensions"),
    true,
  );
}

async function seedLinkedTestTrackerData(sourceRoot: string, sandboxRoot: string): Promise<void> {
  if (!(await pathExists(sourceRoot))) {
    return;
  }
  const entries = await readdir(sourceRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (LINKED_TEST_TRACKER_DIRS_TO_SKIP.has(entry.name)) {
      continue;
    }
    const sourcePath = path.join(sourceRoot, entry.name);
    const targetPath = path.join(sandboxRoot, entry.name);
    if (entry.isDirectory()) {
      await copyIntoSandboxIfPresent(sourcePath, targetPath, true);
      continue;
    }
    if (entry.isFile()) {
      await copyIntoSandboxIfPresent(sourcePath, targetPath);
    }
  }
}

async function countLinkedTestItemFiles(pmRoot: string): Promise<number> {
  if (!(await pathExists(pmRoot))) {
    return 0;
  }
  let total = 0;
  const entries = await readdir(pmRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || LINKED_TEST_ITEM_COUNT_DIRS_TO_SKIP.has(entry.name)) {
      continue;
    }
    const folderPath = path.join(pmRoot, entry.name);
    let files;
    try {
      files = await readdir(folderPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.isFile()) {
        continue;
      }
      if (ITEM_FILE_EXTENSIONS.some((extension) => file.name.toLowerCase().endsWith(extension))) {
        total += 1;
      }
    }
  }
  return total;
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

function splitJsonPathSegments(fieldPath: string): Array<string | number> {
  const segments: Array<string | number> = [];
  const tokens = fieldPath.match(/[^.[\]]+|\[\d+\]/g) ?? [];
  for (const token of tokens) {
    if (token.startsWith("[") && token.endsWith("]")) {
      const parsedIndex = Number.parseInt(token.slice(1, -1), 10);
      if (!Number.isInteger(parsedIndex) || parsedIndex < 0) {
        return [];
      }
      segments.push(parsedIndex);
      continue;
    }
    segments.push(token);
  }
  return segments;
}

function readJsonPathValue(root: unknown, fieldPath: string): { found: boolean; value: unknown } {
  const normalizedPath = fieldPath.trim();
  if (normalizedPath.length === 0) {
    return { found: false, value: undefined };
  }
  const segments = splitJsonPathSegments(normalizedPath);
  if (segments.length === 0) {
    return { found: false, value: undefined };
  }
  let current: unknown = root;
  for (const segment of segments) {
    if (typeof segment === "number") {
      if (!Array.isArray(current) || segment >= current.length) {
        return { found: false, value: undefined };
      }
      current = current[segment];
      continue;
    }
    if (typeof current !== "object" || current === null || !(segment in current)) {
      return { found: false, value: undefined };
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return { found: true, value: current };
}

function parseAssertionLiteral(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === "true") {
    return true;
  }
  if (trimmed === "false") {
    return false;
  }
  if (trimmed === "null") {
    return null;
  }
  const numeric = Number(trimmed);
  if (trimmed.length > 0 && Number.isFinite(numeric)) {
    return numeric;
  }
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      // Fall back to string comparison for malformed JSON literals.
    }
  }
  return trimmed;
}

function compareAssertionValues(actual: unknown, expected: unknown): boolean {
  if (
    typeof actual === "object" &&
    actual !== null &&
    typeof expected === "object" &&
    expected !== null
  ) {
    return JSON.stringify(actual) === JSON.stringify(expected);
  }
  return Object.is(actual, expected);
}

function evaluateLinkedTestAssertions(linkedTest: LinkedTest, stdout: string, stderr: string): string[] {
  const failures: string[] = [];
  for (const expected of linkedTest.assert_stdout_contains ?? []) {
    if (!stdout.includes(expected)) {
      failures.push(`stdout missing required text: "${expected}"`);
    }
  }
  for (const pattern of linkedTest.assert_stdout_regex ?? []) {
    try {
      const regex = new RegExp(pattern, "m");
      if (!regex.test(stdout)) {
        failures.push(`stdout failed regex assertion: /${pattern}/m`);
      }
    } catch (error: unknown) {
      failures.push(`stdout regex assertion is invalid: /${pattern}/ (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  for (const expected of linkedTest.assert_stderr_contains ?? []) {
    if (!stderr.includes(expected)) {
      failures.push(`stderr missing required text: "${expected}"`);
    }
  }
  for (const pattern of linkedTest.assert_stderr_regex ?? []) {
    try {
      const regex = new RegExp(pattern, "m");
      if (!regex.test(stderr)) {
        failures.push(`stderr failed regex assertion: /${pattern}/m`);
      }
    } catch (error: unknown) {
      failures.push(`stderr regex assertion is invalid: /${pattern}/ (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  if (typeof linkedTest.assert_stdout_min_lines === "number") {
    const lineCount = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0).length;
    if (lineCount < linkedTest.assert_stdout_min_lines) {
      failures.push(`stdout line count ${lineCount} is below required minimum ${linkedTest.assert_stdout_min_lines}`);
    }
  }

  const jsonEqualsAssertions = linkedTest.assert_json_field_equals ?? {};
  const jsonGteAssertions = linkedTest.assert_json_field_gte ?? {};
  const needsJsonAssertions = Object.keys(jsonEqualsAssertions).length > 0 || Object.keys(jsonGteAssertions).length > 0;
  if (!needsJsonAssertions) {
    return failures;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(stdout);
  } catch (error: unknown) {
    failures.push(
      `stdout is not valid JSON for assert_json_field_* checks: ${error instanceof Error ? error.message : String(error)}`,
    );
    return failures;
  }

  for (const [fieldPath, expectedRaw] of Object.entries(jsonEqualsAssertions)) {
    const resolved = readJsonPathValue(parsedJson, fieldPath);
    if (!resolved.found) {
      failures.push(`assert_json_field_equals missing path "${fieldPath}"`);
      continue;
    }
    const expected = parseAssertionLiteral(expectedRaw);
    if (!compareAssertionValues(resolved.value, expected)) {
      failures.push(
        `assert_json_field_equals mismatch at "${fieldPath}" (expected=${JSON.stringify(expected)} actual=${JSON.stringify(resolved.value)})`,
      );
    }
  }

  for (const [fieldPath, expectedMinimum] of Object.entries(jsonGteAssertions)) {
    const resolved = readJsonPathValue(parsedJson, fieldPath);
    if (!resolved.found) {
      failures.push(`assert_json_field_gte missing path "${fieldPath}"`);
      continue;
    }
    if (typeof resolved.value !== "number" || !Number.isFinite(resolved.value)) {
      failures.push(`assert_json_field_gte path "${fieldPath}" resolved to non-numeric value`);
      continue;
    }
    if (resolved.value < expectedMinimum) {
      failures.push(`assert_json_field_gte failed at "${fieldPath}" (expected >= ${expectedMinimum}, actual ${resolved.value})`);
    }
  }

  return failures;
}

const EMPTY_LINKED_TEST_RUN_PATTERNS: Array<{ code: string; regex: RegExp }> = [
  { code: "no_projects_matched_filters", regex: /\bNo projects matched the filters\b/i },
  { code: "no_test_files_found", regex: /\bNo test files found\b/i },
  { code: "no_tests_found", regex: /\bNo tests found\b/i },
  { code: "no_matching_tests", regex: /\bNo matching tests?\b/i },
  { code: "collected_zero_items", regex: /\bcollected 0 items?\b/i },
];

function detectEmptyLinkedTestRun(stdout: string, stderr: string): string | null {
  const combined = `${stdout}\n${stderr}`;
  for (const pattern of EMPTY_LINKED_TEST_RUN_PATTERNS) {
    if (pattern.regex.test(combined)) {
      return pattern.code;
    }
  }
  return null;
}

export async function runLinkedTests(
  tests: LinkedTest[],
  defaultTimeoutSeconds: number | undefined,
  options?: {
    progress?: boolean;
    sourceRoots?: LinkedTestSandboxSourceRoots;
    envSet?: string[];
    envClear?: string[];
    sharedHostSafe?: boolean;
    pmContext?: string;
    overrideLinkedPmContext?: boolean;
    failOnContextMismatch?: boolean;
    failOnEmptyTestRun?: boolean;
    requireAssertionsForPm?: boolean;
  },
): Promise<TestRunResult[]> {
  const results: TestRunResult[] = [];
  const sandboxRoot = await mkdtemp(path.join(tmpdir(), "pm-linked-test-"));
  const schemaSandboxPmPath = path.join(sandboxRoot, "schema", "project", ".agents", "pm");
  const schemaSandboxGlobalPath = path.join(sandboxRoot, "schema", "global");
  const trackerSandboxPmPath = path.join(sandboxRoot, "tracker", "project", ".agents", "pm");
  const trackerSandboxGlobalPath = path.join(sandboxRoot, "tracker", "global");
  const runLevelPmContextMode = parsePmContextMode(options?.pmContext);
  const progressMode: LinkedTestProgressMode = options?.progress === true ? "always" : "auto";
  const runtimeDirectives = resolveRuntimeDirectives(options?.envSet, options?.envClear, options?.sharedHostSafe);
  let sourceProjectItemCount = 0;
  let sourceGlobalItemCount = 0;
  let schemaSandboxProjectItemCount = 0;
  let schemaSandboxGlobalItemCount = 0;
  let trackerSandboxProjectItemCount = 0;
  let trackerSandboxGlobalItemCount = 0;
  const sourceRoots = options?.sourceRoots;
  const projectExtensionsSeeded = Boolean(sourceRoots);
  const globalExtensionsSeeded = Boolean(sourceRoots);

  try {
    await runInit(undefined, { path: schemaSandboxPmPath });
    await runInit(undefined, { path: schemaSandboxGlobalPath });
    await runInit(undefined, { path: trackerSandboxPmPath });
    await runInit(undefined, { path: trackerSandboxGlobalPath });
    if (sourceRoots) {
      await seedLinkedTestSandbox(schemaSandboxPmPath, schemaSandboxGlobalPath, sourceRoots);
      await seedLinkedTestSandbox(trackerSandboxPmPath, trackerSandboxGlobalPath, sourceRoots);
      await seedLinkedTestTrackerData(sourceRoots.projectPmRoot, trackerSandboxPmPath);
      await seedLinkedTestTrackerData(sourceRoots.globalPmRoot, trackerSandboxGlobalPath);
      sourceProjectItemCount = await countLinkedTestItemFiles(sourceRoots.projectPmRoot);
      sourceGlobalItemCount = await countLinkedTestItemFiles(sourceRoots.globalPmRoot);
    }
    schemaSandboxProjectItemCount = await countLinkedTestItemFiles(schemaSandboxPmPath);
    schemaSandboxGlobalItemCount = await countLinkedTestItemFiles(schemaSandboxGlobalPath);
    trackerSandboxProjectItemCount = await countLinkedTestItemFiles(trackerSandboxPmPath);
    trackerSandboxGlobalItemCount = await countLinkedTestItemFiles(trackerSandboxGlobalPath);

    const buildExecutionContext = (
      isPmCommand: boolean,
      isPmTrackerReadCommand: boolean,
      effectivePmContextMode: ResolvedLinkedTestPmContextMode,
    ): NonNullable<TestRunResult["execution_context"]> => {
      const selectedSandboxProjectPmPath = effectivePmContextMode === "tracker" ? trackerSandboxPmPath : schemaSandboxPmPath;
      const selectedSandboxGlobalPmPath =
        effectivePmContextMode === "tracker" ? trackerSandboxGlobalPath : schemaSandboxGlobalPath;
      const selectedSandboxProjectItemCount =
        effectivePmContextMode === "tracker" ? trackerSandboxProjectItemCount : schemaSandboxProjectItemCount;
      const selectedSandboxGlobalItemCount =
        effectivePmContextMode === "tracker" ? trackerSandboxGlobalItemCount : schemaSandboxGlobalItemCount;
      const mismatchDetected = isPmCommand && sourceProjectItemCount !== selectedSandboxProjectItemCount;
      return {
        pm_context_mode: effectivePmContextMode,
        is_pm_command: isPmCommand,
        is_pm_tracker_read_command: isPmTrackerReadCommand,
        source_project_pm_path: sourceRoots?.projectPmRoot ?? "",
        sandbox_project_pm_path: selectedSandboxProjectPmPath,
        source_global_pm_path: sourceRoots?.globalPmRoot ?? "",
        sandbox_global_pm_path: selectedSandboxGlobalPmPath,
        source_project_item_count: sourceProjectItemCount,
        sandbox_project_item_count: selectedSandboxProjectItemCount,
        source_global_item_count: sourceGlobalItemCount,
        sandbox_global_item_count: selectedSandboxGlobalItemCount,
        mismatch_detected: mismatchDetected,
        project_extensions_seeded: projectExtensionsSeeded,
        global_extensions_seeded: globalExtensionsSeeded,
      };
    };

    for (let index = 0; index < tests.length; index += 1) {
      const linkedTest = tests[index];
      const linkedOverridePmContextMode =
        typeof linkedTest.pm_context_mode === "string" && linkedTest.pm_context_mode.trim().length > 0
          ? parsePmContextMode(linkedTest.pm_context_mode)
          : undefined;
      const isPmCommand =
        typeof linkedTest.command === "string" && linkedTest.command.length > 0
          ? commandInvokesPmCli(linkedTest.command)
          : false;
      const isPmTrackerReadCommand =
        isPmCommand && typeof linkedTest.command === "string" && linkedTest.command.length > 0
          ? commandInvokesPmTrackerReadCommand(linkedTest.command)
          : false;
      const requestedPmContextMode = resolveLinkedTestRequestedContextMode(
        linkedTest,
        runLevelPmContextMode,
        options?.overrideLinkedPmContext === true,
      );
      const effectivePmContextMode = resolveLinkedTestEffectiveContextMode(requestedPmContextMode, isPmTrackerReadCommand);
      const executionContext = buildExecutionContext(isPmCommand, isPmTrackerReadCommand, effectivePmContextMode);
      if (!linkedTest.command) {
        results.push({
          command: linkedTest.command,
          path: linkedTest.path,
          status: "skipped",
          execution_context: executionContext,
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
          execution_context: executionContext,
          error: runtimeSafetySkipReason,
        });
        continue;
      }
      const failOnMismatchByDefault =
        executionContext.pm_context_mode === "schema" &&
        executionContext.is_pm_tracker_read_command &&
        executionContext.mismatch_detected;
      const failOnMismatchByFlag =
        options?.failOnContextMismatch === true && executionContext.is_pm_command && executionContext.mismatch_detected;
      if (failOnMismatchByDefault || failOnMismatchByFlag) {
        const mismatchHint = buildPmContextMismatchHint({
          executionContext,
          runLevelPmContextMode,
          linkedOverridePmContextMode,
        });
        results.push({
          command: linkedTest.command,
          path: linkedTest.path,
          status: "failed",
          exit_code: 1,
          failure_category: "assertion_failure",
          execution_context: executionContext,
          error:
            `Linked test PM context mismatch detected (source_project_items=${executionContext.source_project_item_count}, ` +
            `sandbox_project_items=${executionContext.sandbox_project_item_count}).${mismatchHint}`,
        });
        continue;
      }
      if (options?.requireAssertionsForPm === true && executionContext.is_pm_command && !hasLinkedTestAssertions(linkedTest)) {
        results.push({
          command: linkedTest.command,
          path: linkedTest.path,
          status: "failed",
          exit_code: 1,
          failure_category: "assertion_failure",
          execution_context: executionContext,
          error: "Linked PM command requires assertions when --require-assertions-for-pm is enabled.",
        });
        continue;
      }
      const timeoutMs = ((linkedTest.timeout_seconds ?? defaultTimeoutSeconds ?? 120) * 1000);
      const effectiveDirectives = resolveEffectiveLinkedTestDirectives(runtimeDirectives, linkedTest);
      const executionEnv: NodeJS.ProcessEnv = { ...process.env };
      applyEnvDirectiveStage(executionEnv, runtimeDirectives);
      applyEnvDirectiveStage(executionEnv, {
        env_set: linkedTest.env_set ?? {},
        env_clear: linkedTest.env_clear ?? [],
      });
      if (effectiveDirectives.shared_host_safe) {
        applySharedHostSafeDefaults(executionEnv);
      }
      executionEnv.FORCE_COLOR = "0";
      executionEnv.PM_PATH = executionContext.sandbox_project_pm_path;
      executionEnv.PM_GLOBAL_PATH = executionContext.sandbox_global_pm_path;
      const execution = await runLinkedTestCommand(
        linkedTest.command,
        timeoutMs,
        executionEnv,
        {
          index: index + 1,
          total: tests.length,
          timeoutMs,
          command: linkedTest.command,
        },
        progressMode,
      );
      const passed = execution.exitCode === 0 && !execution.timedOut && !execution.maxBufferExceeded;
      if (passed) {
        if (options?.failOnEmptyTestRun === true) {
          const emptyRunSignal = detectEmptyLinkedTestRun(execution.stdout, execution.stderr);
          if (emptyRunSignal) {
            results.push({
              command: linkedTest.command,
              path: linkedTest.path,
              status: "failed",
              exit_code: 1,
              failure_category: "empty_run",
              execution_context: executionContext,
              stdout: execution.stdout,
              stderr: execution.stderr,
              error:
                `Linked test reported an empty test run (${emptyRunSignal}) while --fail-on-empty-test-run is enabled. ` +
                "Update test selection or disable --fail-on-empty-test-run for this run.",
            });
            continue;
          }
        }
        const assertionFailures = evaluateLinkedTestAssertions(linkedTest, execution.stdout, execution.stderr);
        if (assertionFailures.length > 0) {
          results.push({
            command: linkedTest.command,
            path: linkedTest.path,
            status: "failed",
            exit_code: 1,
            failure_category: "assertion_failure",
            execution_context: executionContext,
            stdout: execution.stdout,
            stderr: execution.stderr,
            error: `Linked test assertion(s) failed: ${assertionFailures.join("; ")}`,
          });
          continue;
        }
        results.push({
          command: linkedTest.command,
          path: linkedTest.path,
          status: "passed",
          exit_code: 0,
          execution_context: executionContext,
          stdout: execution.stdout,
          stderr: execution.stderr,
        });
        continue;
      }
      const failureCategory = classifyLinkedTestFailure(execution);
      results.push({
        command: linkedTest.command,
        path: linkedTest.path,
        status: "failed",
        exit_code: resolveLinkedTestFailureExitCode(execution),
        failure_category: failureCategory,
        execution_context: executionContext,
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
            (entry) =>
              entry.command === add.command &&
              entry.path === add.path &&
              entry.scope === add.scope &&
              entry.pm_context_mode === add.pm_context_mode,
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
  const pmContextMode = parsePmContextMode(options.pmContext);
  const hasRuntimeDirectiveFlags =
    (options.envSet?.length ?? 0) > 0 ||
    (options.envClear?.length ?? 0) > 0 ||
    options.sharedHostSafe === true ||
    options.pmContext !== undefined ||
    options.overrideLinkedPmContext === true ||
    options.failOnContextMismatch === true ||
    options.failOnSkipped === true ||
    options.failOnEmptyTestRun === true ||
    options.requireAssertionsForPm === true;
  if (hasRuntimeDirectiveFlags && options.run !== true) {
    throw new PmCliError(
      "--env-set, --env-clear, --shared-host-safe, --pm-context, --override-linked-pm-context, --fail-on-context-mismatch, --fail-on-skipped, --fail-on-empty-test-run, and --require-assertions-for-pm require --run",
      EXIT_CODE.USAGE,
    );
  }

  const runStartedAt = options.run === true ? nowIso() : undefined;
  const runResults = options.run === true
    ? await runLinkedTests(tests, defaultTimeoutSeconds, {
        progress: options.progress,
        envSet: options.envSet,
        envClear: options.envClear,
        sharedHostSafe: options.sharedHostSafe,
        pmContext: pmContextMode,
        overrideLinkedPmContext: options.overrideLinkedPmContext,
        failOnContextMismatch: options.failOnContextMismatch,
        failOnEmptyTestRun: options.failOnEmptyTestRun,
        requireAssertionsForPm: options.requireAssertionsForPm,
        sourceRoots: {
          projectPmRoot: pmRoot,
          globalPmRoot: resolveGlobalPmRoot(process.cwd()),
        },
      })
    : [];
  const failureCategories = countFailureCategories(runResults);
  const failOnSkippedTriggered =
    options.run === true && options.failOnSkipped === true && runResults.some((entry) => entry.status === "skipped");
  const warnings: string[] = [];

  if (options.run === true && runStartedAt && settings.testing.record_results_to_items === true) {
    const summary = summarizeRunResultStatuses(runResults);
    const trackedRunId = resolveTrackedRunId("test");
    const attemptRaw = process.env.PM_BACKGROUND_TEST_RUN_ATTEMPT?.trim();
    const parsedAttempt = attemptRaw ? Number.parseInt(attemptRaw, 10) : Number.NaN;
    const resumedFrom = process.env.PM_BACKGROUND_TEST_RUN_RESUMED_FROM?.trim();
    try {
      await appendTrackedTestRunSummary({
        pmRoot,
        settings,
        itemId,
        author: resolveAuthor(options.author, settings.author_default),
        message: `Track test run summary (${trackedRunId})`,
        entry: {
          run_id: trackedRunId,
          kind: "test",
          status: summary.failed > 0 || failOnSkippedTriggered === true ? "failed" : "passed",
          started_at: runStartedAt,
          finished_at: nowIso(),
          recorded_at: nowIso(),
          attempt: Number.isFinite(parsedAttempt) && parsedAttempt >= 1 ? parsedAttempt : undefined,
          resumed_from: resumedFrom && resumedFrom.length > 0 ? resumedFrom : undefined,
          passed: summary.passed,
          failed: summary.failed,
          skipped: summary.skipped,
          fail_on_skipped_triggered: failOnSkippedTriggered ? true : undefined,
        },
      });
    } catch (error: unknown) {
      warnings.push(`test_result_tracking_failed:${itemId}:${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    id: itemId,
    tests,
    run_results: runResults,
    failure_categories: failureCategories,
    fail_on_skipped_triggered: failOnSkippedTriggered ? true : undefined,
    warnings: warnings.length > 0 ? warnings : undefined,
    changed: shouldMutate,
    count: tests.length,
  };
}
