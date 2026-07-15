/**
 * @module cli/commands/test
 *
 * Implements the pm test command surface and its agent-facing runtime behavior.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getActiveExtensionRegistrations } from "../../core/extensions/index.js";
import { pathExists } from "../../core/fs/fs-utils.js";
import { resolveItemTypeRegistry } from "../../core/item/type-registry.js";
import {
  createStdinTokenResolver,
  parseCsvKv,
  parseOptionalNumber,
} from "../../core/item/parse.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { stableValueEquals } from "../../core/shared/serialization.js";
import { nowIso } from "../../core/shared/time.js";
import {
  locateItem,
  mutateItem,
  readLocatedItem,
} from "../../core/store/item-store.js";
import {
  getSettingsPath,
  ITEM_FILE_EXTENSIONS,
  resolveGlobalPmRoot,
  resolvePmRoot,
} from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import { appendTrackedTestRunSummary } from "../../core/test/item-test-run-tracking.js";
import { runInit } from "./init.js";
import {
  looksLikeStructuredLinkedTestEntry,
  normalizeStructuredLinkedTestEntry,
} from "./linked-test-entry.js";
import {
  LINKED_TEST_PM_CONTEXT_MODE_VALUES as PM_CONTEXT_MODE_VALUES,
  LINKED_TEST_PROTECTED_ENV_KEYS,
  parseLinkedTestAssertionEqualsMap,
  parseLinkedTestAssertionGteMap,
  parseLinkedTestBoolean as parseLinkedTestBooleanValue,
  parseLinkedTestContextMode as parseLinkedTestContextModeValue,
  parseLinkedTestEnvClear as parseLinkedTestEnvClearValue,
  parseLinkedTestEnvSet as parseLinkedTestEnvSetValue,
  parseLinkedTestJsonEntries,
  parseLinkedTestMinLines,
  parseLinkedTestRegexList,
  parseLinkedTestStringList,
  type LinkedTestPmContextMode,
} from "./linked-test-parsers.js";
import {
  parseOnlyIndexValue,
  resolveLinkedTestRunSelection,
  type LinkedTestRunSelection,
} from "../../core/test/run-selectors.js";
import { SCOPE_VALUES } from "../../types/index.js";
import type { LinkedTest, LinkScope } from "../../types/index.js";

const TEST_OUTPUT_MAX_BUFFER_BYTES = 20 * 1024 * 1024;
const DEFAULT_LINKED_TEST_TIMEOUT_FORCE_KILL_DELAY_MS = 3000;
const DEFAULT_LINKED_TEST_HEARTBEAT_INTERVAL_MS = 10000;
const DEFAULT_LINKED_TEST_PIPE_CLOSE_GRACE_MS = 5000;
const MAX_LINKED_TEST_COMMAND_LABEL_LENGTH = 120;
type ResolvedLinkedTestPmContextMode = Exclude<LinkedTestPmContextMode, "auto">;
const LINKED_TEST_TRACKER_DIRS_TO_SKIP = new Set([
  "locks",
  "extensions",
  "runtime",
]);
const LINKED_TEST_ITEM_COUNT_DIRS_TO_SKIP = new Set([
  "history",
  "index",
  "search",
  "extensions",
  "locks",
  "runtime",
]);
const LINKED_TEST_INFRA_COLLISION_PATTERNS = [
  /eaddrinuse/i,
  /address already in use/i,
  /port\s+\d+\s+is already in use/i,
  /web server[^.\n]*already running/i,
  /failed to listen on/i,
];
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
  return readPositiveIntegerEnv(
    "PM_LINKED_TEST_TIMEOUT_FORCE_KILL_DELAY_MS",
    DEFAULT_LINKED_TEST_TIMEOUT_FORCE_KILL_DELAY_MS,
  );
}

function linkedTestHeartbeatIntervalMs(): number {
  return readPositiveIntegerEnv(
    "PM_LINKED_TEST_HEARTBEAT_INTERVAL_MS",
    DEFAULT_LINKED_TEST_HEARTBEAT_INTERVAL_MS,
  );
}

function linkedTestPipeCloseGraceMs(): number {
  return readPositiveIntegerEnv(
    "PM_LINKED_TEST_PIPE_CLOSE_GRACE_MS",
    DEFAULT_LINKED_TEST_PIPE_CLOSE_GRACE_MS,
  );
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

/** Documents the test command options payload exchanged by command, SDK, and package integrations. */
export interface TestCommandOptions {
  /** Value that configures or reports add for this contract. */
  add?: string[];
  /** Value that configures or reports add json for this contract. */
  addJson?: string[];
  /** Value that configures or reports remove for this contract. */
  remove?: string[];
  /** Value that configures or reports list for this contract. */
  list?: boolean;
  /** Value that configures or reports run for this contract. */
  run?: boolean;
  /** Value that configures or reports match for this contract. */
  match?: string;
  /** Value that configures or reports only index for this contract. */
  onlyIndex?: string | number;
  /** Value that configures or reports only last for this contract. */
  onlyLast?: boolean;
  /** Value that configures or reports timeout for this contract. */
  timeout?: string;
  /** Value that configures or reports progress for this contract. */
  progress?: boolean;
  /** Value that configures or reports env set for this contract. */
  envSet?: string[];
  /** Value that configures or reports env clear for this contract. */
  envClear?: string[];
  /** Value that configures or reports shared host safe for this contract. */
  sharedHostSafe?: boolean;
  /** Value that configures or reports pm context for this contract. */
  pmContext?: string;
  /** Value that configures or reports override linked pm context for this contract. */
  overrideLinkedPmContext?: boolean;
  /** Value that configures or reports fail on context mismatch for this contract. */
  failOnContextMismatch?: boolean;
  /** Value that configures or reports fail on skipped for this contract. */
  failOnSkipped?: boolean;
  /** Value that configures or reports fail on empty test run for this contract. */
  failOnEmptyTestRun?: boolean;
  /** Value that configures or reports require assertions for pm for this contract. */
  requireAssertionsForPm?: boolean;
  /** Value that configures or reports check context for this contract. */
  checkContext?: boolean;
  /** Value that configures or reports auto pm context for this contract. */
  autoPmContext?: boolean;
  /** Value that configures or reports author for this contract. */
  author?: string;
  /** Human-readable explanation suitable for logs and agent-facing output. */
  message?: string;
  /** Value that configures or reports force for this contract. */
  force?: boolean;
}

/** Restricts linked test failure category values accepted by command, SDK, and storage contracts. */
export type LinkedTestFailureCategory =
  | "infra_collision"
  | "assertion_failure"
  | "empty_run"
  | "timeout"
  | "max_buffer"
  | "spawn_error"
  | "signal";

/** Documents the test run result payload exchanged by command, SDK, and package integrations. */
export interface TestRunResult {
  /** Value that configures or reports command for this contract. */
  command?: string;
  /** Filesystem path used for path resolution. */
  path?: string;
  /** Lifecycle state reported for status. */
  status: "passed" | "failed" | "skipped";
  /** Value that configures or reports exit code for this contract. */
  exit_code?: number;
  /** Value that configures or reports failure category for this contract. */
  failure_category?: LinkedTestFailureCategory;
  /** Value that configures or reports execution context for this contract. */
  execution_context?: {
    requested_pm_context_mode: LinkedTestPmContextMode;
    pm_context_mode: LinkedTestPmContextMode;
    auto_pm_context_applied: boolean;
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
  /** Value that configures or reports stdout for this contract. */
  stdout?: string;
  /** Value that configures or reports stderr for this contract. */
  stderr?: string;
  /** Value that configures or reports error for this contract. */
  error?: string;
}

/** Documents the test result payload exchanged by command, SDK, and package integrations. */
export interface TestResult {
  /** Whether the operation completed without a blocking failure. */
  ok: boolean;
  /** Stable identifier used to reference this record across commands and storage. */
  id: string;
  /** Value that configures or reports tests for this contract. */
  tests: LinkedTest[];
  /** Executes the results operation through the package runtime. */
  run_results: TestRunResult[];
  /** Value that configures or reports failure categories for this contract. */
  failure_categories: Record<LinkedTestFailureCategory, number>;
  /** Value that configures or reports selection for this contract. */
  selection?: Omit<LinkedTestRunSelection, "selected">;
  /** Value that configures or reports fail on skipped triggered for this contract. */
  fail_on_skipped_triggered?: boolean;
  /** Value that configures or reports warnings for this contract. */
  warnings?: string[];
  /** Value that configures or reports changed for this contract. */
  changed: boolean;
  /** Value that configures or reports count for this contract. */
  count: number;
}

function resolveAuthor(
  candidate: string | undefined,
  fallback: string,
): string {
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

function summarizeRunResultStatuses(results: TestRunResult[]): {
  passed: number;
  failed: number;
  skipped: number;
} {
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

/** Implements summarize context preflight for the public runtime surface of this module. */
export function summarizeContextPreflight(runResults: TestRunResult[]): {
  checked_pm_commands: number;
  tracker_read_commands: number;
  mismatches: number;
  auto_remediated: number;
} {
  let checkedPmCommands = 0;
  let trackerReadCommands = 0;
  let mismatches = 0;
  let autoRemediated = 0;
  for (const result of runResults) {
    const context = result.execution_context;
    if (!context || context.is_pm_command !== true) {
      continue;
    }
    checkedPmCommands += 1;
    if (context.is_pm_tracker_read_command === true) {
      trackerReadCommands += 1;
    }
    if (context.mismatch_detected === true) {
      mismatches += 1;
    }
    if (context.auto_pm_context_applied === true) {
      autoRemediated += 1;
    }
  }
  return {
    checked_pm_commands: checkedPmCommands,
    tracker_read_commands: trackerReadCommands,
    mismatches,
    auto_remediated: autoRemediated,
  };
}

function ensureScope(raw: string | undefined): LinkScope {
  const value = (raw ?? "project") as LinkScope;
  if (!SCOPE_VALUES.includes(value)) {
    throw new PmCliError(`Invalid scope "${raw}"`, EXIT_CODE.USAGE);
  }
  return value;
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
  if (
    typeof linkedTest.pm_context_mode !== "string" ||
    linkedTest.pm_context_mode.trim().length === 0
  ) {
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

/* c8 ignore start -- assertion-shape truthiness combinations are covered by linked-test integration suites */
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
/* c8 ignore stop */

/* c8 ignore start -- pm-context mismatch hint combinations are validated by tracker/schema integration runs */
function buildPmContextMismatchHint(params: {
  executionContext: NonNullable<TestRunResult["execution_context"]>;
  runLevelPmContextMode: LinkedTestPmContextMode;
  linkedOverridePmContextMode: LinkedTestPmContextMode | undefined;
}): string {
  const {
    executionContext,
    runLevelPmContextMode,
    linkedOverridePmContextMode,
  } = params;
  if (
    !executionContext.is_pm_tracker_read_command ||
    !executionContext.mismatch_detected
  ) {
    return "";
  }
  if (
    runLevelPmContextMode === "tracker" &&
    linkedOverridePmContextMode === "schema"
  ) {
    return (
      " Linked test metadata pm_context_mode=schema overrides run-level --pm-context tracker." +
      " Set pm_context_mode=tracker (or auto) on the linked test, or remove the override, to run against seeded tracker data."
    );
  }
  if (executionContext.pm_context_mode === "schema") {
    return (
      " Use --auto-pm-context to route PM tracker-read linked commands through seeded tracker data automatically." +
      " Alternatively, use --pm-context tracker for the whole run."
    );
  }
  return "";
}
/* c8 ignore stop */

function mergeEnvSetDirectives(
  entries: string[] | undefined,
  optionName: string,
): Record<string, string> {
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

function mergeEnvClearDirectives(
  entries: string[] | undefined,
  optionName: string,
): string[] {
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

// Linked-test command detection helpers + constants live in a sibling leaf
// module to keep this command file under the per-file LOC budget. Re-exported
// here so no consumer outside this file changes.
import {
  BUN_GLOBAL_FLAGS_WITH_VALUE,
  NPM_GLOBAL_FLAGS_WITH_VALUE,
  PNPM_GLOBAL_FLAGS_WITH_VALUE,
  SCRIPT_RUN_FLAGS_WITH_VALUE,
  SCRIPT_RUN_SUBCOMMANDS,
  YARN_GLOBAL_FLAGS_WITH_VALUE,
  firstPmSubcommand,
  extractReferencedPmItemIdsFromCommand,
  extractPmInvocationArgsFromSegment,
  isPmCliPackageToken,
  isPmCliScriptToken,
  isPmExecutableToken,
  parseLauncherSubcommand,
  parseNpmExecCommand,
  parseNpxCommand,
  parsePnpmDlxCommand,
  resolvePmSubcommandContext,
  splitNormalizedCommandSegments,
  stripLeadingEnvAssignments,
} from "../../sdk/test/linked-command-detection.js";

export { extractReferencedPmItemIdsFromCommand } from "../../sdk/test/linked-command-detection.js";

function commandInvokesPmCli(command: string): boolean {
  const normalizedCommand = normalizeCommandForValidation(command);
  return splitNormalizedCommandSegments(normalizedCommand).some(
    (segment) => extractPmInvocationArgsFromSegment(segment) !== null,
  );
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

function resolveDirectRunnerSubcommand(
  parsed: { subcommand: string; args: string[] } | null,
): string | undefined {
  if (!parsed) {
    return undefined;
  }
  if (!SCRIPT_RUN_SUBCOMMANDS.has(parsed.subcommand)) {
    return parsed.subcommand;
  }
  return parseLauncherSubcommand(parsed.args, SCRIPT_RUN_FLAGS_WITH_VALUE)
    ?.subcommand;
}

function firstDirectTestRunnerSubcommand(
  executable: string,
  args: string[],
): string | undefined {
  if (executable === "npx" || executable === "bunx") {
    return parseNpxCommand(args)?.command;
  }
  if (executable === "pnpm") {
    return resolveDirectRunnerSubcommand(
      parseLauncherSubcommand(args, PNPM_GLOBAL_FLAGS_WITH_VALUE),
    );
  }
  if (executable === "npm") {
    return resolveDirectRunnerSubcommand(
      parseLauncherSubcommand(args, NPM_GLOBAL_FLAGS_WITH_VALUE),
    );
  }
  if (executable === "yarn") {
    return resolveDirectRunnerSubcommand(
      parseLauncherSubcommand(args, YARN_GLOBAL_FLAGS_WITH_VALUE),
    );
  }
  if (executable === "bun") {
    return resolveDirectRunnerSubcommand(
      parseLauncherSubcommand(args, BUN_GLOBAL_FLAGS_WITH_VALUE),
    );
  }
  return undefined;
}

function isDirectTestRunnerSubcommand(token: string | undefined): boolean {
  if (!token) {
    return false;
  }
  return token === "vitest" || token === "test" || token.startsWith("test:");
}

function parsedLauncherInvokesRecursiveTestAll(
  parsed: { command: string; args: string[] } | null,
): boolean {
  if (!parsed) {
    return false;
  }
  if (
    !isPmExecutableToken(parsed.command) &&
    !isPmCliPackageToken(parsed.command)
  ) {
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

  if (executable === "npx" || executable === "bunx") {
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
  return splitNormalizedCommandSegments(normalized).some((segment) =>
    segmentInvokesRecursiveTestAll(segment),
  );
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
  const hasExplicitPmPath =
    /\bpm_path\s*=/.test(normalizedSegment) ||
    /\$env:pm_path\s*=/.test(normalizedSegment);
  const hasExplicitPmGlobalPath =
    /\bpm_global_path\s*=/.test(normalizedSegment) ||
    /\$env:pm_global_path\s*=/.test(normalizedSegment);
  return hasExplicitPmPath && hasExplicitPmGlobalPath;
}

function segmentInvokesUnsafeDirectTestRunner(
  normalizedSegment: string,
): boolean {
  const rawTokens = normalizedSegment
    .split(" ")
    .filter((token) => token.length > 0);
  const tokens = stripLeadingEnvAssignments(rawTokens);
  if (tokens.length === 0) {
    return false;
  }
  const [executable, ...args] = tokens;
  if (
    executable === "vitest" ||
    executable.endsWith("/vitest") ||
    executable.endsWith("/vitest.mjs")
  ) {
    return true;
  }
  if (executable === "node") {
    return nodeArgsInvokeUnsafeDirectTestRunner(args);
  }
  return packageManagerInvokesUnsafeDirectTestRunner(executable, args);
}

function nodeArgsInvokeUnsafeDirectTestRunner(args: string[]): boolean {
  return (
    args.includes("--test") ||
    args.some(
      (arg) =>
        arg === "vitest" ||
        arg === "vitest.mjs" ||
        arg.endsWith("/vitest") ||
        arg.endsWith("/vitest.mjs"),
    )
  );
}

function packageManagerInvokesUnsafeDirectTestRunner(
  executable: string,
  args: string[],
): boolean {
  if (executable === "npx" || executable === "bunx") {
    return isDirectTestRunnerSubcommand(parseNpxCommand(args)?.command);
  }
  if (executable === "pnpm" || executable === "npm") {
    return (
      isDirectTestRunnerSubcommand(
        (executable === "pnpm"
          ? parsePnpmDlxCommand(args)
          : parseNpmExecCommand(args)
        )?.command,
      ) || firstDirectTestRunnerSubcommand(executable, args) === "vitest"
    );
  }
  return (
    (executable === "yarn" || executable === "bun") &&
    firstDirectTestRunnerSubcommand(executable, args) === "vitest"
  );
}

function assertSandboxSafeTestRunnerCommand(command: string): void {
  const normalized = normalizeCommandForValidation(command);
  const segments = splitNormalizedCommandSegments(normalized);
  const hasUnsafeDirectRunnerSegment = segments.some(
    (segment) =>
      !commandUsesSandboxRunner(segment) &&
      segmentInvokesUnsafeDirectTestRunner(segment) &&
      !segmentHasExplicitSandboxEnv(segment),
  );

  if (!hasUnsafeDirectRunnerSegment) {
    return;
  }

  throw new PmCliError(
    'Linked test runner commands must be sandbox-safe: use "node scripts/run-tests.mjs <test|coverage>", use a package-manager script such as "pnpm test", or include PM_PATH=... PM_GLOBAL_PATH=... INLINE in the command string (exporting them in your shell environment is not checked). Example: "PM_PATH=/tmp/pm-x PM_GLOBAL_PATH=/tmp/pm-x-g vitest run".',
    EXIT_CODE.USAGE,
  );
}

function getRuntimeSafetySkipReason(command: string): string | undefined {
  if (!invokesRecursiveTestAllCommand(command)) return undefined;
  return 'Linked test command skipped: Linked test commands must not invoke "pm test-all"; this creates recursive orchestration.';
}

function parseAddEntries(raw: string[] | undefined): LinkedTest[] {
  if (!raw) return [];
  return raw.map(parseAddEntry);
}

function parseAddEntry(entry: string): LinkedTest {
  const trimmed = entry.trim();
  const kv = looksLikeStructuredLinkedTestEntry(trimmed)
    ? normalizeStructuredLinkedTestEntry(parseCsvKv(entry, "--add"), "--add")
    : { command: trimmed };
  const command = trimLinkedTestEntryField(kv.command);
  if (!command) {
    throw new PmCliError(
      "--add requires command=<value> or a bare command (path=<value> is optional metadata)",
      EXIT_CODE.USAGE,
    );
  }
  assertNoRecursiveTestAllCommand(command);
  assertSandboxSafeTestRunnerCommand(command);
  return {
    command,
    path: trimLinkedTestEntryField(kv.path),
    scope: ensureScope(kv.scope),
    timeout_seconds: parseLinkedTestTimeoutSeconds(
      trimLinkedTestEntryField(kv.timeout_seconds),
      trimLinkedTestEntryField(kv.timeout),
    ),
    pm_context_mode: parseLinkedTestContextModeValue(
      trimLinkedTestEntryField(kv.pm_context_mode),
      "--add",
    ),
    env_set: parseLinkedTestEnvSetValue(
      trimLinkedTestEntryField(kv.env_set),
      "--add",
    ),
    env_clear: parseLinkedTestEnvClearValue(
      trimLinkedTestEntryField(kv.env_clear),
      "--add",
    ),
    shared_host_safe: parseLinkedTestBooleanValue(
      trimLinkedTestEntryField(kv.shared_host_safe),
      "--add",
      "shared_host_safe",
    ),
    assert_stdout_contains: parseLinkedTestStringList(
      trimLinkedTestEntryField(kv.assert_stdout_contains),
    ),
    assert_stdout_regex: parseLinkedTestRegexList(
      trimLinkedTestEntryField(kv.assert_stdout_regex),
      "--add",
      "assert_stdout_regex",
    ),
    assert_stderr_contains: parseLinkedTestStringList(
      trimLinkedTestEntryField(kv.assert_stderr_contains),
    ),
    assert_stderr_regex: parseLinkedTestRegexList(
      trimLinkedTestEntryField(kv.assert_stderr_regex),
      "--add",
      "assert_stderr_regex",
    ),
    assert_stdout_min_lines: parseLinkedTestMinLines(
      trimLinkedTestEntryField(kv.assert_stdout_min_lines),
      "--add",
    ),
    assert_json_field_equals: parseLinkedTestAssertionEqualsMap(
      trimLinkedTestEntryField(kv.assert_json_field_equals),
      "--add",
    ),
    assert_json_field_gte: parseLinkedTestAssertionGteMap(
      trimLinkedTestEntryField(kv.assert_json_field_gte),
      "--add",
    ),
    note: trimLinkedTestEntryField(kv.note),
  };
}

function trimLinkedTestEntryField(
  value: string | undefined,
): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function parseLinkedTestTimeoutSeconds(
  timeoutSecondsRaw: string | undefined,
  timeoutAliasRaw: string | undefined,
): number | undefined {
  if (
    timeoutSecondsRaw &&
    timeoutAliasRaw &&
    timeoutSecondsRaw !== timeoutAliasRaw
  ) {
    throw new PmCliError(
      "--add timeout and timeout_seconds must match when both are provided",
      EXIT_CODE.USAGE,
    );
  }
  const timeoutRaw = timeoutSecondsRaw ?? timeoutAliasRaw;
  return timeoutRaw === undefined
    ? undefined
    : Math.floor(parseOptionalNumber(timeoutRaw, "timeout_seconds"));
}

/* c8 ignore start -- add-json validation matrix is covered by linked-test parser integration suites */
function parseAddJsonEntries(raw: string[] | undefined): LinkedTest[] {
  if (!raw) return [];
  return raw.flatMap((entry) => {
    const parsed = parseLinkedTestJsonEntries(entry, "--add-json");
    for (const linkedTest of parsed) {
      const command = linkedTest.command;
      if (!command) {
        throw new PmCliError(
          "--add-json requires a non-empty command string",
          EXIT_CODE.USAGE,
        );
      }
      assertNoRecursiveTestAllCommand(command);
      assertSandboxSafeTestRunnerCommand(command);
    }
    return parsed;
  });
}
/* c8 ignore stop */

function parseRemoveEntries(raw: string[] | undefined): string[] {
  if (!raw) return [];
  return raw.map((entry) => {
    const trimmed = entry.trim();
    if (!trimmed) {
      throw new PmCliError(
        "--remove requires command or path value",
        EXIT_CODE.USAGE,
      );
    }
    if (
      trimmed.includes("=") ||
      /^(?:[-*+]\s+)?(?:path|command)\s*[:=]/i.test(trimmed) ||
      trimmed.startsWith("```")
    ) {
      const kv = parseCsvKv(trimmed, "--remove");
      const value = kv.path ?? kv.command;
      if (!value?.trim()) {
        throw new PmCliError(
          "--remove requires command=<value> and/or path=<value>",
          EXIT_CODE.USAGE,
        );
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

function beginLinkedTestProgress(
  context: LinkedTestProgressContext,
  mode: LinkedTestProgressMode,
): NodeJS.Timeout | null {
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
  executionResult: Pick<
    LinkedTestExecutionResult,
    "timedOut" | "maxBufferExceeded" | "exitCode" | "signal"
  >,
  startedAt: number,
  mode: LinkedTestProgressMode,
): void {
  if (!shouldEmitLinkedTestProgress(mode)) {
    return;
  }
  const commandLabel = summarizeLinkedTestCommand(context.command);
  const elapsedMs = Date.now() - startedAt;
  const failed =
    executionResult.timedOut ||
    executionResult.maxBufferExceeded ||
    executionResult.exitCode !== 0;
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
  const exitLabel =
    executionResult.exitCode === null
      ? "null"
      : String(executionResult.exitCode);
  const reasonSuffix =
    reasonTokens.length > 0 ? ` ${reasonTokens.join(" ")}` : "";
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

/* c8 ignore start -- process lifecycle timing/error race branches are covered by cross-platform integration runners */
interface LinkedTestTimerState {
  heartbeat: NodeJS.Timeout | null;
  forceKillTimer: NodeJS.Timeout | null;
  timedOutTimer: NodeJS.Timeout | null;
}

interface LinkedTestOutputBufferState {
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  maxBufferExceeded: boolean;
}

function clearLinkedTestTimers(timers: LinkedTestTimerState): void {
  if (timers.heartbeat) {
    clearInterval(timers.heartbeat);
  }
  if (timers.timedOutTimer) {
    clearTimeout(timers.timedOutTimer);
    timers.timedOutTimer = null;
  }
  if (timers.forceKillTimer) {
    clearTimeout(timers.forceKillTimer);
    timers.forceKillTimer = null;
  }
}

function createLinkedTestTerminationRequester(
  child: ReturnType<typeof spawn>,
  timers: LinkedTestTimerState,
): () => Promise<void> {
  let terminationRequested = false;
  return async (): Promise<void> => {
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
    timers.forceKillTimer = setTimeout(() => {
      void killProcessTree(pid);
    }, linkedTestTimeoutForceKillDelayMs());
    timers.forceKillTimer.unref?.();
  };
}

function readLinkedTestOutputChunkText(
  chunk: Buffer | string,
  bytes: number,
  remainingBytes: number,
): string {
  if (remainingBytes <= 0) {
    return "";
  }
  if (bytes <= remainingBytes) {
    return typeof chunk === "string" ? chunk : chunk.toString("utf8");
  }
  const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
  return buffer.subarray(0, remainingBytes).toString("utf8");
}

function appendLinkedTestOutputChunk(
  state: LinkedTestOutputBufferState,
  chunk: Buffer | string,
  target: "stdout" | "stderr",
): boolean {
  if (state.maxBufferExceeded) {
    return false;
  }
  const bytes =
    typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength;
  if (target === "stdout") {
    const remainingBytes = TEST_OUTPUT_MAX_BUFFER_BYTES - state.stdoutBytes;
    state.stdout += readLinkedTestOutputChunkText(chunk, bytes, remainingBytes);
    state.stdoutBytes += bytes;
  } else {
    const remainingBytes = TEST_OUTPUT_MAX_BUFFER_BYTES - state.stderrBytes;
    state.stderr += readLinkedTestOutputChunkText(chunk, bytes, remainingBytes);
    state.stderrBytes += bytes;
  }
  const bufferExceeded =
    state.stdoutBytes > TEST_OUTPUT_MAX_BUFFER_BYTES ||
    state.stderrBytes > TEST_OUTPUT_MAX_BUFFER_BYTES;
  if (!state.maxBufferExceeded && bufferExceeded) {
    state.maxBufferExceeded = true;
    return true;
  }
  return false;
}

function waitForLinkedTestChildClose(
  child: ReturnType<typeof spawn>,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    let settled = false;
    let pipeCloseGraceTimer: NodeJS.Timeout | null = null;
    const settle = (
      value: { code: number | null; signal: NodeJS.Signals | null },
      destroyPipes = false,
    ): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (pipeCloseGraceTimer) {
        clearTimeout(pipeCloseGraceTimer);
        pipeCloseGraceTimer = null;
      }
      if (destroyPipes) {
        child.stdin?.destroy();
        child.stdout?.destroy();
        child.stderr?.destroy();
      }
      resolve(value);
    };
    child.on("exit", (exitCode, exitSignal) => {
      if (settled) {
        return;
      }
      pipeCloseGraceTimer = setTimeout(() => {
        settle(
          {
            code: exitCode,
            signal: exitSignal,
          },
          true,
        );
      }, linkedTestPipeCloseGraceMs());
      pipeCloseGraceTimer.unref?.();
    });
    child.on("close", (closeCode, closeSignal) => {
      settle({
        code: closeCode,
        signal: closeSignal,
      });
    });
  });
}

function createLinkedTestChild(
  command: string,
  env: NodeJS.ProcessEnv,
): ReturnType<typeof spawn> {
  return spawn(command, {
    cwd: process.cwd(),
    env,
    shell: true,
    windowsHide: true,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  });
}

async function runLinkedTestCommand(
  command: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
  progressContext: LinkedTestProgressContext,
  progressMode: LinkedTestProgressMode,
): Promise<LinkedTestExecutionResult> {
  const startedAt = Date.now();
  const child = createLinkedTestChild(command, env);
  closeLinkedTestStdin(child);
  const timers: LinkedTestTimerState = {
    heartbeat: beginLinkedTestProgress(progressContext, progressMode),
    forceKillTimer: null,
    timedOutTimer: null,
  };
  const output: LinkedTestOutputBufferState = {
    stdout: "",
    stderr: "",
    stdoutBytes: 0,
    stderrBytes: 0,
    maxBufferExceeded: false,
  };
  const requestTermination = createLinkedTestTerminationRequester(
    child,
    timers,
  );
  let timedOut = false;
  let spawnError: string | undefined;

  const appendChunk = (
    chunk: Buffer | string,
    target: "stdout" | "stderr",
  ): void => {
    if (appendLinkedTestOutputChunk(output, chunk, target)) {
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
  timers.timedOutTimer = setTimeout(() => {
    timedOut = true;
    void requestTermination();
  }, timeoutMs);
  timers.timedOutTimer.unref?.();

  const { code, signal } = await waitForLinkedTestChildClose(child);
  clearLinkedTestTimers(timers);
  const executionResult: LinkedTestExecutionResult = {
    stdout: output.stdout,
    stderr: output.stderr,
    exitCode: code,
    signal,
    timedOut,
    maxBufferExceeded: output.maxBufferExceeded,
    spawnError,
  };
  endLinkedTestProgress(
    progressContext,
    executionResult,
    startedAt,
    progressMode,
  );
  return executionResult;
}
/* c8 ignore stop */

function formatLinkedTestExecutionError(
  result: LinkedTestExecutionResult,
  timeoutMs: number,
): string {
  const details: string[] = [];
  if (result.maxBufferExceeded) {
    details.push(
      `Linked test output exceeded maxBuffer=${TEST_OUTPUT_MAX_BUFFER_BYTES} bytes. Reduce output volume or split the command.`,
    );
  }
  if (result.timedOut && timeoutMs > 0) {
    details.push(`Linked test timed out after ${timeoutMs}ms.`);
  }
  const signalMessage = result.signal
    ? `Linked test command terminated by signal ${result.signal}.`
    : undefined;
  const baseMessage =
    result.spawnError?.trim() || signalMessage || "Linked test command failed.";
  if (details.length === 0) {
    return baseMessage;
  }
  return `${baseMessage} ${details.join(" ")}`;
}

function hasInfraCollisionSignal(
  result: Pick<LinkedTestExecutionResult, "stdout" | "stderr" | "spawnError">,
): boolean {
  const combined = [result.spawnError ?? "", result.stderr, result.stdout].join(
    "\n",
  );
  return LINKED_TEST_INFRA_COLLISION_PATTERNS.some((pattern) =>
    pattern.test(combined),
  );
}

/** Implements classify linked test failure for the public runtime surface of this module. */
export function classifyLinkedTestFailure(
  result: Pick<
    LinkedTestExecutionResult,
    | "stdout"
    | "stderr"
    | "spawnError"
    | "signal"
    | "timedOut"
    | "maxBufferExceeded"
  >,
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

function createEmptyFailureCategoryCounts(): Record<
  LinkedTestFailureCategory,
  number
> {
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

/** Implements count failure categories for the public runtime surface of this module. */
export function countFailureCategories(
  runResults: TestRunResult[],
): Record<LinkedTestFailureCategory, number> {
  const counts = createEmptyFailureCategoryCounts();
  for (const result of runResults) {
    if (result.status !== "failed" || !result.failure_category) {
      continue;
    }
    counts[result.failure_category] += 1;
  }
  return counts;
}

function applyEnvDirectiveStage(
  env: NodeJS.ProcessEnv,
  directives: Pick<LinkedTestRuntimeDirectives, "env_set" | "env_clear">,
): void {
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
  const envSet = { ...runtimeDirectives.env_set, ...linkedTest.env_set };
  const envClear = [
    ...new Set([
      ...runtimeDirectives.env_clear,
      ...(linkedTest.env_clear ?? []),
    ]),
  ];
  const sharedHostSafe =
    linkedTest.shared_host_safe ?? runtimeDirectives.shared_host_safe;
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

/* c8 ignore start -- sandbox copy race/path permutations are covered by filesystem integration suites */
async function copyIntoSandboxIfPresent(
  sourcePath: string,
  targetPath: string,
  recursive = false,
): Promise<void> {
  if (!(await pathExists(sourcePath))) {
    return;
  }
  await mkdir(path.dirname(targetPath), { recursive: true });
  try {
    if (recursive) {
      await cp(sourcePath, targetPath, { recursive: true, force: true });
      return;
    }
    await cp(sourcePath, targetPath, { force: true });
  } catch (error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT"
    ) {
      return;
    }
    throw error;
  }
}
/* c8 ignore stop */

async function seedLinkedTestSandbox(
  sandboxPmPath: string,
  sandboxGlobalPath: string,
  sourceRoots: LinkedTestSandboxSourceRoots,
): Promise<void> {
  await copyIntoSandboxIfPresent(
    getSettingsPath(sourceRoots.projectPmRoot),
    getSettingsPath(sandboxPmPath),
  );
  await copyIntoSandboxIfPresent(
    path.join(sourceRoots.projectPmRoot, "extensions"),
    path.join(sandboxPmPath, "extensions"),
    true,
  );
  await copyIntoSandboxIfPresent(
    getSettingsPath(sourceRoots.globalPmRoot),
    getSettingsPath(sandboxGlobalPath),
  );
  await copyIntoSandboxIfPresent(
    path.join(sourceRoots.globalPmRoot, "extensions"),
    path.join(sandboxGlobalPath, "extensions"),
    true,
  );
}

async function seedLinkedTestTrackerData(
  sourceRoot: string,
  sandboxRoot: string,
): Promise<void> {
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
    if (
      !entry.isDirectory() ||
      LINKED_TEST_ITEM_COUNT_DIRS_TO_SKIP.has(entry.name)
    ) {
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
      if (
        ITEM_FILE_EXTENSIONS.some((extension) =>
          file.name.toLowerCase().endsWith(extension),
        )
      ) {
        total += 1;
      }
    }
  }
  return total;
}

/** Implements resolve linked test failure exit code for the public runtime surface of this module. */
export function resolveLinkedTestFailureExitCode(
  execution: Pick<
    LinkedTestExecutionResult,
    "exitCode" | "timedOut" | "maxBufferExceeded"
  >,
): number {
  const rawExitCode =
    typeof execution.exitCode === "number" ? execution.exitCode : 1;
  if (
    (execution.timedOut || execution.maxBufferExceeded) &&
    rawExitCode === 0
  ) {
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

function readJsonPathValue(
  root: unknown,
  fieldPath: string,
): { found: boolean; value: unknown } {
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
    if (
      typeof current !== "object" ||
      current === null ||
      !(segment in current)
    ) {
      return { found: false, value: undefined };
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return { found: true, value: current };
}

/* c8 ignore start -- assertion-literal parsing edge cases are validated by assertion integration suites */
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
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      // Fall back to string comparison for malformed JSON literals.
    }
  }
  return trimmed;
}
/* c8 ignore stop */

function compareAssertionValues(actual: unknown, expected: unknown): boolean {
  if (
    typeof actual === "object" &&
    actual !== null &&
    typeof expected === "object" &&
    expected !== null
  ) {
    return stableValueEquals(actual, expected);
  }
  return Object.is(actual, expected);
}

/* c8 ignore start -- assertion failure-path permutations are covered by linked-test integration fixtures */
function evaluateLinkedTestAssertions(
  linkedTest: LinkedTest,
  stdout: string,
  stderr: string,
): string[] {
  const failures: string[] = [];
  failures.push(
    ...evaluateContainsAssertions(
      "stdout",
      stdout,
      linkedTest.assert_stdout_contains,
    ),
  );
  failures.push(
    ...evaluateRegexAssertions(
      "stdout",
      stdout,
      linkedTest.assert_stdout_regex,
    ),
  );
  failures.push(
    ...evaluateContainsAssertions(
      "stderr",
      stderr,
      linkedTest.assert_stderr_contains,
    ),
  );
  failures.push(
    ...evaluateRegexAssertions(
      "stderr",
      stderr,
      linkedTest.assert_stderr_regex,
    ),
  );
  failures.push(
    ...evaluateStdoutLineCountAssertion(
      stdout,
      linkedTest.assert_stdout_min_lines,
    ),
  );

  const jsonEqualsAssertions = linkedTest.assert_json_field_equals ?? {};
  const jsonGteAssertions = linkedTest.assert_json_field_gte ?? {};
  const needsJsonAssertions =
    Object.keys(jsonEqualsAssertions).length > 0 ||
    Object.keys(jsonGteAssertions).length > 0;
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

  for (const [fieldPath, expectedMinimum] of Object.entries(
    jsonGteAssertions,
  )) {
    const resolved = readJsonPathValue(parsedJson, fieldPath);
    if (!resolved.found) {
      failures.push(`assert_json_field_gte missing path "${fieldPath}"`);
      continue;
    }
    if (
      typeof resolved.value !== "number" ||
      !Number.isFinite(resolved.value)
    ) {
      failures.push(
        `assert_json_field_gte path "${fieldPath}" resolved to non-numeric value`,
      );
      continue;
    }
    if (resolved.value < expectedMinimum) {
      failures.push(
        `assert_json_field_gte failed at "${fieldPath}" (expected >= ${expectedMinimum}, actual ${resolved.value})`,
      );
    }
  }

  return failures;
}
/* c8 ignore stop */

function evaluateContainsAssertions(
  streamName: "stdout" | "stderr",
  output: string,
  expectedValues: string[] | undefined,
): string[] {
  const failures: string[] = [];
  for (const expected of expectedValues ?? []) {
    if (!output.includes(expected)) {
      failures.push(`${streamName} missing required text: "${expected}"`);
    }
  }
  return failures;
}

function evaluateRegexAssertions(
  streamName: "stdout" | "stderr",
  output: string,
  patterns: string[] | undefined,
): string[] {
  const failures: string[] = [];
  for (const pattern of patterns ?? []) {
    try {
      const regex = new RegExp(pattern, "m");
      if (!regex.test(output)) {
        failures.push(`${streamName} failed regex assertion: /${pattern}/m`);
      }
    } catch (error: unknown) {
      failures.push(
        `${streamName} regex assertion is invalid: /${pattern}/ (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }
  return failures;
}

function evaluateStdoutLineCountAssertion(
  stdout: string,
  minimum: number | undefined,
): string[] {
  if (typeof minimum !== "number") {
    return [];
  }
  const lineCount = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0).length;
  return lineCount < minimum
    ? [`stdout line count ${lineCount} is below required minimum ${minimum}`]
    : [];
}

const EMPTY_LINKED_TEST_RUN_PATTERNS: Array<{ code: string; regex: RegExp }> = [
  {
    code: "no_projects_matched_filters",
    regex: /\bNo projects matched the filters\b/i,
  },
  { code: "no_test_files_found", regex: /\bNo test files found\b/i },
  { code: "no_tests_found", regex: /\bNo tests found\b/i },
  { code: "no_matching_tests", regex: /\bNo matching tests?\b/i },
  { code: "collected_zero_items", regex: /\bcollected 0 items?\b/i },
];

function detectEmptyLinkedTestRun(
  stdout: string,
  stderr: string,
): string | null {
  const combined = `${stdout}\n${stderr}`;
  for (const pattern of EMPTY_LINKED_TEST_RUN_PATTERNS) {
    if (pattern.regex.test(combined)) {
      return pattern.code;
    }
  }
  return null;
}

/* c8 ignore start -- linked-test orchestration branch matrix is covered by end-to-end command integration runs */
interface RunLinkedTestsOptions {
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
  checkContext?: boolean;
  autoPmContext?: boolean;
}

interface LinkedTestSandboxLayout {
  root: string;
  schemaProjectPmPath: string;
  schemaGlobalPmPath: string;
  trackerProjectPmPath: string;
  trackerGlobalPmPath: string;
}

interface LinkedTestSandboxCounts {
  sourceProjectItemCount: number;
  sourceGlobalItemCount: number;
  schemaProjectItemCount: number;
  schemaGlobalItemCount: number;
  trackerProjectItemCount: number;
  trackerGlobalItemCount: number;
}

interface LinkedTestCommandContext {
  linkedOverridePmContextMode: LinkedTestPmContextMode | undefined;
  executionContext: NonNullable<TestRunResult["execution_context"]>;
}

function createLinkedTestSandboxLayout(
  sandboxRoot: string,
): LinkedTestSandboxLayout {
  return {
    root: sandboxRoot,
    schemaProjectPmPath: path.join(
      sandboxRoot,
      "schema",
      "project",
      ".agents",
      "pm",
    ),
    schemaGlobalPmPath: path.join(sandboxRoot, "schema", "global"),
    trackerProjectPmPath: path.join(
      sandboxRoot,
      "tracker",
      "project",
      ".agents",
      "pm",
    ),
    trackerGlobalPmPath: path.join(sandboxRoot, "tracker", "global"),
  };
}

async function initializeLinkedTestSandboxes(
  layout: LinkedTestSandboxLayout,
): Promise<void> {
  await runInit(undefined, { path: layout.schemaProjectPmPath });
  await runInit(undefined, { path: layout.schemaGlobalPmPath });
  await runInit(undefined, { path: layout.trackerProjectPmPath });
  await runInit(undefined, { path: layout.trackerGlobalPmPath });
}

async function seedLinkedTestSandboxesFromSource(
  layout: LinkedTestSandboxLayout,
  sourceRoots: LinkedTestSandboxSourceRoots | undefined,
): Promise<void> {
  if (!sourceRoots) {
    return;
  }
  await seedLinkedTestSandbox(
    layout.schemaProjectPmPath,
    layout.schemaGlobalPmPath,
    sourceRoots,
  );
  await seedLinkedTestSandbox(
    layout.trackerProjectPmPath,
    layout.trackerGlobalPmPath,
    sourceRoots,
  );
  await seedLinkedTestTrackerData(
    sourceRoots.projectPmRoot,
    layout.trackerProjectPmPath,
  );
  await seedLinkedTestTrackerData(
    sourceRoots.globalPmRoot,
    layout.trackerGlobalPmPath,
  );
}

async function countLinkedTestSandboxItems(
  layout: LinkedTestSandboxLayout,
  sourceRoots: LinkedTestSandboxSourceRoots | undefined,
): Promise<LinkedTestSandboxCounts> {
  return {
    sourceProjectItemCount: sourceRoots
      ? await countLinkedTestItemFiles(sourceRoots.projectPmRoot)
      : 0,
    sourceGlobalItemCount: sourceRoots
      ? await countLinkedTestItemFiles(sourceRoots.globalPmRoot)
      : 0,
    schemaProjectItemCount: await countLinkedTestItemFiles(
      layout.schemaProjectPmPath,
    ),
    schemaGlobalItemCount: await countLinkedTestItemFiles(
      layout.schemaGlobalPmPath,
    ),
    trackerProjectItemCount: await countLinkedTestItemFiles(
      layout.trackerProjectPmPath,
    ),
    trackerGlobalItemCount: await countLinkedTestItemFiles(
      layout.trackerGlobalPmPath,
    ),
  };
}

function buildLinkedTestExecutionContext(params: {
  layout: LinkedTestSandboxLayout;
  counts: LinkedTestSandboxCounts;
  sourceRoots: LinkedTestSandboxSourceRoots | undefined;
  isPmCommand: boolean;
  isPmTrackerReadCommand: boolean;
  requestedPmContextMode: LinkedTestPmContextMode;
  effectivePmContextMode: ResolvedLinkedTestPmContextMode;
  autoPmContextApplied: boolean;
}): NonNullable<TestRunResult["execution_context"]> {
  const trackerMode = params.effectivePmContextMode === "tracker";
  const selectedSandboxProjectPmPath = trackerMode
    ? params.layout.trackerProjectPmPath
    : params.layout.schemaProjectPmPath;
  const selectedSandboxGlobalPmPath = trackerMode
    ? params.layout.trackerGlobalPmPath
    : params.layout.schemaGlobalPmPath;
  const selectedSandboxProjectItemCount = trackerMode
    ? params.counts.trackerProjectItemCount
    : params.counts.schemaProjectItemCount;
  const selectedSandboxGlobalItemCount = trackerMode
    ? params.counts.trackerGlobalItemCount
    : params.counts.schemaGlobalItemCount;
  return {
    requested_pm_context_mode: params.requestedPmContextMode,
    pm_context_mode: params.effectivePmContextMode,
    auto_pm_context_applied: params.autoPmContextApplied,
    is_pm_command: params.isPmCommand,
    is_pm_tracker_read_command: params.isPmTrackerReadCommand,
    source_project_pm_path: params.sourceRoots?.projectPmRoot ?? "",
    sandbox_project_pm_path: selectedSandboxProjectPmPath,
    source_global_pm_path: params.sourceRoots?.globalPmRoot ?? "",
    sandbox_global_pm_path: selectedSandboxGlobalPmPath,
    source_project_item_count: params.counts.sourceProjectItemCount,
    sandbox_project_item_count: selectedSandboxProjectItemCount,
    source_global_item_count: params.counts.sourceGlobalItemCount,
    sandbox_global_item_count: selectedSandboxGlobalItemCount,
    mismatch_detected:
      params.isPmCommand &&
      params.counts.sourceProjectItemCount !== selectedSandboxProjectItemCount,
    project_extensions_seeded: Boolean(params.sourceRoots),
    global_extensions_seeded: Boolean(params.sourceRoots),
  };
}

function resolveLinkedTestCommandContext(params: {
  linkedTest: LinkedTest;
  layout: LinkedTestSandboxLayout;
  counts: LinkedTestSandboxCounts;
  sourceRoots: LinkedTestSandboxSourceRoots | undefined;
  runLevelPmContextMode: LinkedTestPmContextMode;
  options: RunLinkedTestsOptions | undefined;
}): LinkedTestCommandContext {
  const linkedOverridePmContextMode =
    typeof params.linkedTest.pm_context_mode === "string" &&
    params.linkedTest.pm_context_mode.trim().length > 0
      ? parsePmContextMode(params.linkedTest.pm_context_mode)
      : undefined;
  const command =
    typeof params.linkedTest.command === "string" &&
    params.linkedTest.command.length > 0
      ? params.linkedTest.command
      : undefined;
  const isPmCommand = command ? commandInvokesPmCli(command) : false;
  const isPmTrackerReadCommand =
    isPmCommand && command
      ? commandInvokesPmTrackerReadCommand(command)
      : false;
  const autoPmContextApplied =
    params.options?.autoPmContext === true && isPmTrackerReadCommand;
  const requestedPmContextMode = autoPmContextApplied
    ? "auto"
    : resolveLinkedTestRequestedContextMode(
        params.linkedTest,
        params.runLevelPmContextMode,
        params.options?.overrideLinkedPmContext === true,
      );
  const effectivePmContextMode = resolveLinkedTestEffectiveContextMode(
    requestedPmContextMode,
    isPmTrackerReadCommand,
  );
  return {
    linkedOverridePmContextMode,
    executionContext: buildLinkedTestExecutionContext({
      layout: params.layout,
      counts: params.counts,
      sourceRoots: params.sourceRoots,
      isPmCommand,
      isPmTrackerReadCommand,
      requestedPmContextMode,
      effectivePmContextMode,
      autoPmContextApplied,
    }),
  };
}

function buildLinkedTestSkippedResult(
  linkedTest: LinkedTest,
  executionContext: NonNullable<TestRunResult["execution_context"]>,
  error: string,
): TestRunResult {
  return {
    command: linkedTest.command,
    path: linkedTest.path,
    status: "skipped",
    execution_context: executionContext,
    error,
  };
}

function buildLinkedTestAssertionFailureResult(
  linkedTest: LinkedTest,
  executionContext: NonNullable<TestRunResult["execution_context"]>,
  error: string,
  output?: Pick<LinkedTestExecutionResult, "stdout" | "stderr">,
): TestRunResult {
  return {
    command: linkedTest.command,
    path: linkedTest.path,
    status: "failed",
    exit_code: 1,
    failure_category: "assertion_failure",
    execution_context: executionContext,
    ...(output ? { stdout: output.stdout, stderr: output.stderr } : {}),
    error,
  };
}

function resolveLinkedTestPreflightResult(params: {
  linkedTest: LinkedTest;
  executionContext: NonNullable<TestRunResult["execution_context"]>;
  runLevelPmContextMode: LinkedTestPmContextMode;
  linkedOverridePmContextMode: LinkedTestPmContextMode | undefined;
  options: RunLinkedTestsOptions | undefined;
}): TestRunResult | null {
  if (!params.linkedTest.command) {
    return buildLinkedTestSkippedResult(
      params.linkedTest,
      params.executionContext,
      "No command configured for this linked test.",
    );
  }
  const runtimeSafetySkipReason = getRuntimeSafetySkipReason(
    params.linkedTest.command,
  );
  if (runtimeSafetySkipReason) {
    return buildLinkedTestSkippedResult(
      params.linkedTest,
      params.executionContext,
      runtimeSafetySkipReason,
    );
  }
  const failOnMismatchByDefault =
    params.executionContext.pm_context_mode === "schema" &&
    params.executionContext.is_pm_tracker_read_command &&
    params.executionContext.mismatch_detected;
  const failOnMismatchByFlag =
    params.options?.failOnContextMismatch === true &&
    params.executionContext.is_pm_command &&
    params.executionContext.mismatch_detected;
  if (failOnMismatchByDefault || failOnMismatchByFlag) {
    const mismatchHint = buildPmContextMismatchHint({
      executionContext: params.executionContext,
      runLevelPmContextMode: params.runLevelPmContextMode,
      linkedOverridePmContextMode: params.linkedOverridePmContextMode,
    });
    const mismatchPrefix =
      params.options?.checkContext === true
        ? "Linked test preflight PM context mismatch detected"
        : "Linked test PM context mismatch detected";
    return buildLinkedTestAssertionFailureResult(
      params.linkedTest,
      params.executionContext,
      `${mismatchPrefix} (source_project_items=${params.executionContext.source_project_item_count}, ` +
        `sandbox_project_items=${params.executionContext.sandbox_project_item_count}).${mismatchHint}`,
    );
  }
  if (
    params.options?.requireAssertionsForPm === true &&
    params.executionContext.is_pm_command &&
    !hasLinkedTestAssertions(params.linkedTest)
  ) {
    return buildLinkedTestAssertionFailureResult(
      params.linkedTest,
      params.executionContext,
      "Linked PM command requires assertions when --require-assertions-for-pm is enabled.",
    );
  }
  return null;
}

function buildLinkedTestExecutionEnv(params: {
  runtimeDirectives: LinkedTestRuntimeDirectives;
  linkedTest: LinkedTest;
  executionContext: NonNullable<TestRunResult["execution_context"]>;
}): NodeJS.ProcessEnv {
  const effectiveDirectives = resolveEffectiveLinkedTestDirectives(
    params.runtimeDirectives,
    params.linkedTest,
  );
  const executionEnv: NodeJS.ProcessEnv = { ...process.env };
  applyEnvDirectiveStage(executionEnv, params.runtimeDirectives);
  applyEnvDirectiveStage(executionEnv, {
    env_set: params.linkedTest.env_set ?? {},
    env_clear: params.linkedTest.env_clear ?? [],
  });
  if (effectiveDirectives.shared_host_safe) {
    applySharedHostSafeDefaults(executionEnv);
  }
  executionEnv.FORCE_COLOR = "0";
  executionEnv.PM_PATH = params.executionContext.sandbox_project_pm_path;
  executionEnv.PM_GLOBAL_PATH = params.executionContext.sandbox_global_pm_path;
  return executionEnv;
}

function buildLinkedTestPassedResult(
  linkedTest: LinkedTest,
  executionContext: NonNullable<TestRunResult["execution_context"]>,
  execution: LinkedTestExecutionResult,
): TestRunResult {
  return {
    command: linkedTest.command,
    path: linkedTest.path,
    status: "passed",
    exit_code: 0,
    execution_context: executionContext,
    stdout: execution.stdout,
    stderr: execution.stderr,
  };
}

function buildLinkedTestEmptyRunResult(params: {
  linkedTest: LinkedTest;
  executionContext: NonNullable<TestRunResult["execution_context"]>;
  execution: LinkedTestExecutionResult;
  emptyRunSignal: string;
}): TestRunResult {
  return {
    command: params.linkedTest.command,
    path: params.linkedTest.path,
    status: "failed",
    exit_code: 1,
    failure_category: "empty_run",
    execution_context: params.executionContext,
    stdout: params.execution.stdout,
    stderr: params.execution.stderr,
    error:
      `Linked test reported an empty test run (${params.emptyRunSignal}) while --fail-on-empty-test-run is enabled. ` +
      "Update test selection or disable --fail-on-empty-test-run for this run.",
  };
}

function buildLinkedTestCommandFailureResult(params: {
  linkedTest: LinkedTest;
  executionContext: NonNullable<TestRunResult["execution_context"]>;
  execution: LinkedTestExecutionResult;
  timeoutMs: number;
}): TestRunResult {
  return {
    command: params.linkedTest.command,
    path: params.linkedTest.path,
    status: "failed",
    exit_code: resolveLinkedTestFailureExitCode(params.execution),
    failure_category: classifyLinkedTestFailure(params.execution),
    execution_context: params.executionContext,
    stdout: params.execution.stdout,
    stderr: params.execution.stderr,
    error: formatLinkedTestExecutionError(params.execution, params.timeoutMs),
  };
}

function buildLinkedTestPassedExecutionResult(params: {
  linkedTest: LinkedTest;
  executionContext: NonNullable<TestRunResult["execution_context"]>;
  execution: LinkedTestExecutionResult;
  options: RunLinkedTestsOptions | undefined;
}): TestRunResult {
  if (params.options?.failOnEmptyTestRun === true) {
    const emptyRunSignal = detectEmptyLinkedTestRun(
      params.execution.stdout,
      params.execution.stderr,
    );
    if (emptyRunSignal) {
      return buildLinkedTestEmptyRunResult({ ...params, emptyRunSignal });
    }
  }
  const assertionFailures = evaluateLinkedTestAssertions(
    params.linkedTest,
    params.execution.stdout,
    params.execution.stderr,
  );
  if (assertionFailures.length > 0) {
    return buildLinkedTestAssertionFailureResult(
      params.linkedTest,
      params.executionContext,
      `Linked test assertion(s) failed: ${assertionFailures.join("; ")}`,
      params.execution,
    );
  }
  return buildLinkedTestPassedResult(
    params.linkedTest,
    params.executionContext,
    params.execution,
  );
}

async function runSingleLinkedTest(params: {
  linkedTest: LinkedTest;
  index: number;
  total: number;
  defaultTimeoutSeconds: number | undefined;
  runtimeDirectives: LinkedTestRuntimeDirectives;
  progressMode: LinkedTestProgressMode;
  executionContext: NonNullable<TestRunResult["execution_context"]>;
  options: RunLinkedTestsOptions | undefined;
}): Promise<TestRunResult> {
  const command = params.linkedTest.command ?? "";
  const timeoutMs =
    (params.linkedTest.timeout_seconds ?? params.defaultTimeoutSeconds ?? 120) *
    1000;
  const execution = await runLinkedTestCommand(
    command,
    timeoutMs,
    buildLinkedTestExecutionEnv(params),
    {
      index: params.index + 1,
      total: params.total,
      timeoutMs,
      command,
    },
    params.progressMode,
  );
  const passed =
    execution.exitCode === 0 &&
    !execution.timedOut &&
    !execution.maxBufferExceeded;
  return passed
    ? buildLinkedTestPassedExecutionResult({ ...params, execution })
    : buildLinkedTestCommandFailureResult({ ...params, execution, timeoutMs });
}

/** Implements run linked tests for the public runtime surface of this module. */
export async function runLinkedTests(
  tests: LinkedTest[],
  defaultTimeoutSeconds: number | undefined,
  options?: RunLinkedTestsOptions,
): Promise<TestRunResult[]> {
  const results: TestRunResult[] = [];
  const sandboxRoot = await mkdtemp(path.join(tmpdir(), "pm-linked-test-"));
  const layout = createLinkedTestSandboxLayout(sandboxRoot);
  const runLevelPmContextMode = parsePmContextMode(options?.pmContext);
  const progressMode: LinkedTestProgressMode =
    options?.progress === true ? "always" : "auto";
  const runtimeDirectives = resolveRuntimeDirectives(
    options?.envSet,
    options?.envClear,
    options?.sharedHostSafe,
  );
  const sourceRoots = options?.sourceRoots;

  try {
    await initializeLinkedTestSandboxes(layout);
    await seedLinkedTestSandboxesFromSource(layout, sourceRoots);
    const counts = await countLinkedTestSandboxItems(layout, sourceRoots);

    for (let index = 0; index < tests.length; index += 1) {
      const linkedTest = tests[index];
      const commandContext = resolveLinkedTestCommandContext({
        linkedTest,
        layout,
        counts,
        sourceRoots,
        runLevelPmContextMode,
        options,
      });
      const preflightResult = resolveLinkedTestPreflightResult({
        linkedTest,
        executionContext: commandContext.executionContext,
        runLevelPmContextMode,
        linkedOverridePmContextMode: commandContext.linkedOverridePmContextMode,
        options,
      });
      if (preflightResult) {
        results.push(preflightResult);
        continue;
      }
      results.push(
        await runSingleLinkedTest({
          linkedTest,
          index,
          total: tests.length,
          defaultTimeoutSeconds,
          runtimeDirectives,
          progressMode,
          executionContext: commandContext.executionContext,
          options,
        }),
      );
    }
  } finally {
    await rm(layout.root, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    });
  }
  return results;
}

interface ResolvedTestItem {
  itemId: string;
  tests: LinkedTest[];
  changed: boolean;
}

interface ResolvedTestRunOptions {
  defaultTimeoutSeconds: number | undefined;
  pmContextMode: LinkedTestPmContextMode;
  runSelection: LinkedTestRunSelection | undefined;
  testsToRun: LinkedTest[];
}

async function readLinkedTestItem(params: {
  id: string;
  pmRoot: string;
  settings: Awaited<ReturnType<typeof readSettings>>;
  typeToFolder: Record<string, string>;
}): Promise<ResolvedTestItem> {
  const { id, pmRoot, settings, typeToFolder } = params;
  const located = await locateItem(
    pmRoot,
    id,
    settings.id_prefix,
    settings.item_format,
    typeToFolder,
  );
  if (!located) {
    throw new PmCliError(`Item ${id} not found`, EXIT_CODE.NOT_FOUND);
  }
  const loaded = await readLocatedItem(located, { schema: settings.schema });
  return {
    itemId: located.id,
    tests: loaded.document.metadata.tests ?? [],
    changed: false,
  };
}

function linkedTestsHaveSameIdentity(
  left: LinkedTest,
  right: LinkedTest,
): boolean {
  return (
    left.command === right.command &&
    left.path === right.path &&
    left.scope === right.scope &&
    left.pm_context_mode === right.pm_context_mode
  );
}

function appendMissingLinkedTests(
  current: LinkedTest[],
  additions: LinkedTest[],
): LinkedTest[] {
  const next = [...current];
  for (const addition of additions) {
    if (!next.some((entry) => linkedTestsHaveSameIdentity(entry, addition))) {
      next.push(addition);
    }
  }
  return next;
}

function removeLinkedTestsBySelector(
  current: LinkedTest[],
  removals: string[],
): LinkedTest[] {
  if (removals.length === 0) {
    return current;
  }
  return current.filter(
    (entry) =>
      !removals.includes(entry.path ?? "") &&
      !removals.includes(entry.command ?? ""),
  );
}

function applyLinkedTestMutations(
  previous: LinkedTest[],
  adds: LinkedTest[],
  removes: string[],
): LinkedTest[] {
  return removeLinkedTestsBySelector(
    appendMissingLinkedTests(previous, adds),
    removes,
  );
}

function hasTestRuntimeDirectiveFlags(options: TestCommandOptions): boolean {
  return (
    (options.envSet?.length ?? 0) > 0 ||
    (options.envClear?.length ?? 0) > 0 ||
    options.sharedHostSafe === true ||
    options.pmContext !== undefined ||
    options.overrideLinkedPmContext === true ||
    options.failOnContextMismatch === true ||
    options.failOnSkipped === true ||
    options.failOnEmptyTestRun === true ||
    options.requireAssertionsForPm === true ||
    options.checkContext === true ||
    options.autoPmContext === true
  );
}

function assertTestRunFlagUsage(options: TestCommandOptions): void {
  if (hasTestRuntimeDirectiveFlags(options) && options.run !== true) {
    throw new PmCliError(
      "--env-set, --env-clear, --shared-host-safe, --pm-context, --override-linked-pm-context, --fail-on-context-mismatch, --fail-on-skipped, --fail-on-empty-test-run, --require-assertions-for-pm, --check-context, and --auto-pm-context require --run",
      EXIT_CODE.USAGE,
    );
  }
  const hasSelectorFlags =
    options.match !== undefined ||
    options.onlyIndex !== undefined ||
    options.onlyLast === true;
  if (hasSelectorFlags && options.run !== true) {
    throw new PmCliError(
      "--match, --only-index, and --only-last require --run",
      EXIT_CODE.USAGE,
    );
  }
}

async function resolveLinkedTestItem(params: {
  id: string;
  options: TestCommandOptions;
  pmRoot: string;
  settings: Awaited<ReturnType<typeof readSettings>>;
  typeToFolder: Record<string, string>;
  adds: LinkedTest[];
  removes: string[];
}): Promise<ResolvedTestItem> {
  const { id, options, pmRoot, settings, typeToFolder, adds, removes } = params;
  if (adds.length === 0 && removes.length === 0) {
    return readLinkedTestItem({ id, pmRoot, settings, typeToFolder });
  }
  const result = await mutateItem({
    pmRoot,
    settings,
    id,
    op: "tests_add",
    author: resolveAuthor(options.author, settings.author_default),
    message: options.message,
    force: options.force,
    skipNoop: true,
    mutate(document) {
      const previous = document.metadata.tests ?? [];
      const next = applyLinkedTestMutations(previous, adds, removes);
      document.metadata.tests = next;
      return {
        changedFields: stableValueEquals(previous, next) ? [] : ["tests"],
      };
    },
  });
  return {
    itemId: result.item.id,
    tests: result.item.tests ?? [],
    changed: result.changedFields.length > 0,
  };
}

function resolveTestRunOptions(
  options: TestCommandOptions,
  tests: LinkedTest[],
): ResolvedTestRunOptions {
  assertTestRunFlagUsage(options);
  const selectorInput = {
    match: options.match,
    onlyIndex:
      options.onlyIndex === undefined
        ? undefined
        : parseOnlyIndexValue(options.onlyIndex),
    onlyLast: options.onlyLast,
  };
  const runSelection =
    options.run === true
      ? resolveLinkedTestRunSelection(tests, selectorInput)
      : undefined;
  return {
    defaultTimeoutSeconds:
      options.timeout === undefined
        ? undefined
        : parseOptionalNumber(options.timeout, "timeout"),
    pmContextMode: parsePmContextMode(options.pmContext),
    runSelection,
    testsToRun: runSelection?.selected ?? tests,
  };
}

async function executeSelectedLinkedTests(params: {
  options: TestCommandOptions;
  runOptions: ResolvedTestRunOptions;
  pmRoot: string;
}): Promise<TestRunResult[]> {
  const { options, runOptions, pmRoot } = params;
  if (options.run !== true) {
    return [];
  }
  return await runLinkedTests(
    runOptions.testsToRun,
    runOptions.defaultTimeoutSeconds,
    {
      progress: options.progress,
      envSet: options.envSet,
      envClear: options.envClear,
      sharedHostSafe: options.sharedHostSafe,
      pmContext: runOptions.pmContextMode,
      overrideLinkedPmContext: options.overrideLinkedPmContext,
      failOnContextMismatch: options.failOnContextMismatch,
      failOnEmptyTestRun: options.failOnEmptyTestRun,
      requireAssertionsForPm: options.requireAssertionsForPm,
      checkContext: options.checkContext,
      autoPmContext: options.autoPmContext,
      sourceRoots: {
        projectPmRoot: pmRoot,
        globalPmRoot: resolveGlobalPmRoot(process.cwd()),
      },
    },
  );
}

function buildTestWarnings(
  options: TestCommandOptions,
  runSelection: LinkedTestRunSelection | undefined,
  runResults: TestRunResult[],
): string[] {
  const warnings: string[] = [];
  if (runSelection && runSelection.selector !== null) {
    warnings.push(
      `linked_test_selection:${runSelection.selector}=${runSelection.requested};selected=${runSelection.selected_count};skipped=${runSelection.skipped_count};indexes=${runSelection.selected_indexes.join(",")}`,
    );
  }
  if (options.run === true && options.checkContext === true) {
    const preflight = summarizeContextPreflight(runResults);
    warnings.push(
      `context_preflight:checked_pm_commands=${preflight.checked_pm_commands};` +
        `tracker_read_commands=${preflight.tracker_read_commands};` +
        `mismatches=${preflight.mismatches};` +
        `auto_remediated=${preflight.auto_remediated}`,
    );
  }
  return warnings;
}

async function recordTestRunSummary(params: {
  options: TestCommandOptions;
  pmRoot: string;
  settings: Awaited<ReturnType<typeof readSettings>>;
  itemId: string;
  runStartedAt: string | undefined;
  runResults: TestRunResult[];
  failOnSkippedTriggered: boolean;
  warnings: string[];
}): Promise<void> {
  const {
    options,
    pmRoot,
    settings,
    itemId,
    runStartedAt,
    runResults,
    failOnSkippedTriggered,
    warnings,
  } = params;
  if (
    options.run !== true ||
    !runStartedAt ||
    settings.testing.record_results_to_items !== true
  ) {
    return;
  }
  const summary = summarizeRunResultStatuses(runResults);
  const trackedRunId = resolveTrackedRunId("test");
  const attemptRaw = process.env.PM_BACKGROUND_TEST_RUN_ATTEMPT?.trim();
  const parsedAttempt = attemptRaw
    ? Number.parseInt(attemptRaw, 10)
    : Number.NaN;
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
        status:
          summary.failed > 0 || failOnSkippedTriggered === true
            ? "failed"
            : "passed",
        started_at: runStartedAt,
        finished_at: nowIso(),
        recorded_at: nowIso(),
        attempt:
          Number.isFinite(parsedAttempt) && parsedAttempt >= 1
            ? parsedAttempt
            : undefined,
        resumed_from:
          resumedFrom && resumedFrom.length > 0 ? resumedFrom : undefined,
        passed: summary.passed,
        failed: summary.failed,
        skipped: summary.skipped,
        fail_on_skipped_triggered: failOnSkippedTriggered ? true : undefined,
      },
    });
  } catch (error: unknown) {
    warnings.push(
      `test_result_tracking_failed:${itemId}:${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Implements run test for the public runtime surface of this module. */
export async function runTest(
  id: string,
  options: TestCommandOptions,
  global: GlobalOptions,
): Promise<TestResult> {
  const stdinResolver = createStdinTokenResolver();
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(
      `Tracker is not initialized at ${pmRoot}. Run pm init first.`,
      EXIT_CODE.NOT_FOUND,
    );
  }
  const settings = await readSettings(pmRoot);
  const typeRegistry = resolveItemTypeRegistry(
    settings,
    getActiveExtensionRegistrations(),
  );
  const resolvedAdds = await stdinResolver.resolveList(options.add, "--add");
  const resolvedAddJsons = await stdinResolver.resolveList(
    options.addJson,
    "--add-json",
  );
  const resolvedRemoves = await stdinResolver.resolveList(
    options.remove,
    "--remove",
  );
  const adds = [
    ...parseAddEntries(resolvedAdds),
    ...parseAddJsonEntries(resolvedAddJsons),
  ];
  const removes = parseRemoveEntries(resolvedRemoves);
  const item = await resolveLinkedTestItem({
    id,
    options,
    pmRoot,
    settings,
    typeToFolder: typeRegistry.type_to_folder,
    adds,
    removes,
  });
  const runOptions = resolveTestRunOptions(options, item.tests);
  const runStartedAt = options.run === true ? nowIso() : undefined;
  const runResults = await executeSelectedLinkedTests({
    options,
    runOptions,
    pmRoot,
  });
  const failureCategories = countFailureCategories(runResults);
  const failOnSkippedTriggered =
    options.run === true &&
    options.failOnSkipped === true &&
    runResults.some((entry) => entry.status === "skipped");
  const warnings = buildTestWarnings(
    options,
    runOptions.runSelection,
    runResults,
  );
  await recordTestRunSummary({
    options,
    pmRoot,
    settings,
    itemId: item.itemId,
    runStartedAt,
    runResults,
    failOnSkippedTriggered,
    warnings,
  });

  return {
    ok:
      runResults.every((entry) => entry.status !== "failed") &&
      failOnSkippedTriggered !== true,
    id: item.itemId,
    tests: item.tests,
    run_results: runResults,
    failure_categories: failureCategories,
    selection: runOptions.runSelection
      ? {
          selector: runOptions.runSelection.selector,
          requested: runOptions.runSelection.requested,
          selected_indexes: runOptions.runSelection.selected_indexes,
          selected_count: runOptions.runSelection.selected_count,
          skipped_count: runOptions.runSelection.skipped_count,
        }
      : undefined,
    fail_on_skipped_triggered: failOnSkippedTriggered ? true : undefined,
    warnings: warnings.length > 0 ? warnings : undefined,
    changed: item.changed,
    count: item.tests.length,
  };
}
/* c8 ignore stop */

/** Public contract for test only test command, shared by SDK and presentation-layer consumers. */
export const _testOnlyTestCommand = {
  buildPmContextMismatchHint,
  commandInvokesPmCli,
  commandInvokesPmTrackerReadCommand,
  copyIntoSandboxIfPresent,
  countLinkedTestItemFiles,
  ensureScope,
  evaluateLinkedTestAssertions,
  extractPmInvocationArgsFromSegment,
  firstDirectTestRunnerSubcommand,
  hasLinkedTestAssertions,
  parseAddJsonEntries,
  parsePmContextMode,
  readJsonPathValue,
  resolveAuthor,
  resolveDirectRunnerSubcommand,
  resolveLinkedTestEffectiveContextMode,
  resolveLinkedTestFailureExitCode,
  resolveLinkedTestRequestedContextMode,
  resolveTrackedRunId,
  runLinkedTestCommand,
  appendLinkedTestOutputChunk,
  seedLinkedTestSandbox,
  seedLinkedTestTrackerData,
  splitJsonPathSegments,
  summarizeRunResultStatuses,
};
