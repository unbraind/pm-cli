/**
 * @module sdk/test/runs
 *
 * Implements the pm test runs command surface and its agent-facing runtime behavior.
 */
import os from "node:os";
import { pathExists } from "../../core/fs/fs-utils.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import {
  type BackgroundLogStream,
  type BackgroundRunHealth,
  type BackgroundTestRunKind,
  type BackgroundTestRunRecord,
  type BackgroundTestRunStatus,
  getBackgroundTestRunStatus,
  listBackgroundTestRuns,
  readBackgroundTestRunLogs,
  resumeBackgroundTestRun,
  runBackgroundTestRunWorker,
  spawnBackgroundTestRunWorker,
  startBackgroundTestRun,
  stopBackgroundTestRun,
} from "../../core/test/background-runs.js";
import {
  getSettingsPath,
  resolveGlobalPmRoot,
  resolvePmRoot,
} from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import { parseLimit } from "../../core/shared/numeric-parsers.js";

const BACKGROUND_STATUS_VALUES: readonly BackgroundTestRunStatus[] = [
  "queued",
  "running",
  "passed",
  "failed",
  "stopped",
  "canceled",
];
const BACKGROUND_STREAM_VALUES: readonly BackgroundLogStream[] = [
  "stdout",
  "stderr",
  "both",
];

function normalizeStatus(
  value: string | undefined,
): BackgroundTestRunStatus | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if ((BACKGROUND_STATUS_VALUES as readonly string[]).includes(normalized)) {
    return normalized as BackgroundTestRunStatus;
  }
  throw new PmCliError(`Invalid --status value "${value}"`, EXIT_CODE.USAGE);
}

function normalizeStream(value: string | undefined): BackgroundLogStream {
  if (value === undefined || value.trim().length === 0) {
    return "stderr";
  }
  const normalized = value.trim().toLowerCase();
  if ((BACKGROUND_STREAM_VALUES as readonly string[]).includes(normalized)) {
    return normalized as BackgroundLogStream;
  }
  throw new PmCliError(`Invalid --stream value "${value}"`, EXIT_CODE.USAGE);
}

function resolveWhoamiFallback(): string | undefined {
  try {
    const username = os.userInfo().username.trim();
    if (username.length > 0) {
      return username;
    }
  } catch {
    // Fall back to environment-derived attribution.
  }
  return undefined;
}

function resolveRequestedBy(
  author: string | undefined,
  globalAuthor: string | undefined,
  fallback: string,
): string {
  const candidates = [
    author,
    globalAuthor,
    process.env.PM_AUTHOR,
    fallback,
    process.env.USER,
    process.env.LOGNAME,
    process.env.USERNAME,
    resolveWhoamiFallback(),
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") {
      continue;
    }
    const trimmed = candidate.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return "unknown";
}

async function ensureInitialized(pmRoot: string): Promise<void> {
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(
      `Tracker is not initialized at ${pmRoot}. Run pm init first.`,
      EXIT_CODE.NOT_FOUND,
    );
  }
}

/** Documents the start background run command options payload exchanged by command, SDK, and package integrations. */
export interface StartBackgroundRunCommandOptions {
  /** Value that configures or reports kind for this contract. */
  kind: BackgroundTestRunKind;
  /** Value that configures or reports command args for this contract. */
  commandArgs: string[];
  /** Value that configures or reports target id for this contract. */
  targetId?: string;
  /** Value that configures or reports status filter for this contract. */
  statusFilter?: string;
  /** Value that configures or reports author for this contract. */
  author?: string;
  /** Value that configures or reports no extensions for this contract. */
  noExtensions?: boolean;
}

/** Documents the start background run result payload exchanged by command, SDK, and package integrations. */
export interface StartBackgroundRunResult {
  /** Value that configures or reports started for this contract. */
  started: boolean;
  /** Value that configures or reports duplicate of for this contract. */
  duplicate_of?: string;
  /** Value that configures or reports run for this contract. */
  run: BackgroundTestRunRecord;
}

/** Implements run start background run for the public runtime surface of this module. */
export async function runStartBackgroundRun(
  options: StartBackgroundRunCommandOptions,
  global: GlobalOptions,
): Promise<StartBackgroundRunResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  const globalPmRoot = resolveGlobalPmRoot(process.cwd());
  await ensureInitialized(pmRoot);
  const settings = await readSettings(pmRoot);
  const requestedBy = resolveRequestedBy(
    options.author,
    global.author,
    settings.author_default,
  );
  const started = await startBackgroundTestRun({
    pmRoot,
    globalPmRoot,
    kind: options.kind,
    commandArgs: options.commandArgs,
    requestedBy,
    targetId: options.targetId,
    statusFilter: options.statusFilter,
  });
  if (!started.started) {
    return {
      started: false,
      duplicate_of: started.duplicate_of,
      run: started.run,
    };
  }
  const spawned = await spawnBackgroundTestRunWorker({
    pmRoot,
    runId: started.run.id,
    noExtensions:
      options.noExtensions === true || global.noExtensions === true,
  });
  return {
    started: true,
    run: spawned,
  };
}

/** Documents the test runs list command options payload exchanged by command, SDK, and package integrations. */
export interface TestRunsListCommandOptions {
  /** Lifecycle state reported for status. */
  status?: string;
  /** Value that configures or reports limit for this contract. */
  limit?: string;
}

/** Implements run test runs list for the public runtime surface of this module. */
export async function runTestRunsList(
  options: TestRunsListCommandOptions,
  global: GlobalOptions,
): Promise<{
  runs: BackgroundTestRunRecord[];
  count: number;
  filters: {
    status?: BackgroundTestRunStatus;
    limit?: number;
  };
}> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  await ensureInitialized(pmRoot);
  const status = normalizeStatus(options.status);
  const limit = parseLimit(options.limit, "limit");
  const runs = await listBackgroundTestRuns(pmRoot, { status, limit });
  return {
    runs,
    count: runs.length,
    filters: {
      status,
      limit,
    },
  };
}

/** Implements run test runs status for the public runtime surface of this module. */
export async function runTestRunsStatus(
  runId: string,
  global: GlobalOptions,
): Promise<{
  run: BackgroundTestRunRecord;
  health: BackgroundRunHealth;
}> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  await ensureInitialized(pmRoot);
  const status = await getBackgroundTestRunStatus(pmRoot, runId);
  return {
    run: status.run,
    health: status.health,
  };
}

/** Documents the test runs logs command options payload exchanged by command, SDK, and package integrations. */
export interface TestRunsLogsCommandOptions {
  /** Value that configures or reports stream for this contract. */
  stream?: string;
  /** Value that configures or reports tail for this contract. */
  tail?: string;
}

/** Implements run test runs logs for the public runtime surface of this module. */
export async function runTestRunsLogs(
  runId: string,
  options: TestRunsLogsCommandOptions,
  global: GlobalOptions,
): Promise<{
  run: BackgroundTestRunRecord;
  stream: BackgroundLogStream;
  tail: number;
  stdout: string[];
  stderr: string[];
}> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  await ensureInitialized(pmRoot);
  const stream = normalizeStream(options.stream);
  const tail = parseLimit(options.tail, "tail");
  const logs = await readBackgroundTestRunLogs(pmRoot, runId, stream, tail);
  return {
    run: logs.run,
    stream: logs.stream,
    tail: logs.tail,
    stdout: logs.stdout,
    stderr: logs.stderr,
  };
}

/** Documents the test runs stop command options payload exchanged by command, SDK, and package integrations. */
export interface TestRunsStopCommandOptions {
  /** Value that configures or reports force for this contract. */
  force?: boolean;
}

/** Implements run test runs stop for the public runtime surface of this module. */
export async function runTestRunsStop(
  runId: string,
  options: TestRunsStopCommandOptions,
  global: GlobalOptions,
): Promise<{
  run: BackgroundTestRunRecord;
  signal_sent: "SIGTERM" | "SIGKILL" | "none";
}> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  await ensureInitialized(pmRoot);
  const stopped = await stopBackgroundTestRun(
    pmRoot,
    runId,
    options.force === true,
  );
  return {
    run: stopped.run,
    signal_sent: stopped.signal_sent,
  };
}

/** Documents the test runs resume command options payload exchanged by command, SDK, and package integrations. */
export interface TestRunsResumeCommandOptions {
  /** Value that configures or reports author for this contract. */
  author?: string;
  /** Value that configures or reports no extensions for this contract. */
  noExtensions?: boolean;
}

/** Typed option union accepted by the public background-run lifecycle dispatcher. */
export type TestRunsActionOptions =
  | StartBackgroundRunCommandOptions
  | TestRunsListCommandOptions
  | TestRunsLogsCommandOptions
  | TestRunsStopCommandOptions
  | TestRunsResumeCommandOptions;

const TEST_RUN_ACTION_OPTION_KEYS = [
  "kind",
  "commandArgs",
  "targetId",
  "statusFilter",
  "noExtensions",
  "status",
  "limit",
  "runId",
  "stream",
  "tail",
  "force",
] as const;

/** Hoist action-scoped tool parameters while preserving explicit nested options. */
export function hoistTestRunsActionOptions(
  action: string,
  args: Record<string, unknown>,
  options: Record<string, unknown>,
): Record<string, unknown> {
  if (!action.startsWith("test-runs-")) {
    return options;
  }
  const result = { ...options };
  for (const key of TEST_RUN_ACTION_OPTION_KEYS) {
    if (result[key] === undefined && args[key] !== undefined) {
      result[key] = args[key];
    }
  }
  return result;
}

/** Implements run test runs resume for the public runtime surface of this module. */
export async function runTestRunsResume(
  runId: string,
  options: TestRunsResumeCommandOptions,
  global: GlobalOptions,
): Promise<{
  resumed_from: string;
  run: BackgroundTestRunRecord;
}> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  await ensureInitialized(pmRoot);
  const settings = await readSettings(pmRoot);
  const requestedBy = resolveRequestedBy(
    options.author,
    global.author,
    settings.author_default,
  );
  const resumed = await resumeBackgroundTestRun(
    pmRoot,
    runId,
    requestedBy,
    options.noExtensions === true || global.noExtensions === true,
  );
  return {
    resumed_from: runId,
    run: resumed,
  };
}

/** Dispatch one public background-run lifecycle operation for SDK runtimes. */
export function runTestRunsAction(
  subcommand: string,
  runId: string | undefined,
  options: TestRunsActionOptions,
  global: GlobalOptions,
): Promise<unknown> {
  const normalized = subcommand.trim().toLowerCase();
  if (normalized === "start") {
    return runStartBackgroundRun(
      options as StartBackgroundRunCommandOptions,
      global,
    );
  }
  if (normalized === "list") {
    return runTestRunsList(options as TestRunsListCommandOptions, global);
  }
  if (!runId) {
    throw new PmCliError(
      `test-runs ${normalized} requires runId`,
      EXIT_CODE.USAGE,
    );
  }
  if (normalized === "status") {
    return runTestRunsStatus(runId, global);
  }
  if (normalized === "logs") {
    return runTestRunsLogs(
      runId,
      options as TestRunsLogsCommandOptions,
      global,
    );
  }
  if (normalized === "stop") {
    return runTestRunsStop(
      runId,
      options as TestRunsStopCommandOptions,
      global,
    );
  }
  if (normalized === "resume") {
    return runTestRunsResume(
      runId,
      options as TestRunsResumeCommandOptions,
      global,
    );
  }
  throw new PmCliError(
    `Unknown pm test-runs subcommand "${subcommand}". Allowed: start, list, status, logs, stop, resume`,
    EXIT_CODE.USAGE,
  );
}

/** Implements run test runs worker for the public runtime surface of this module. */
export async function runTestRunsWorker(
  runId: string,
  global: GlobalOptions,
): Promise<{
  id: string;
  status: BackgroundTestRunStatus;
  exit_code?: number;
}> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  await ensureInitialized(pmRoot);
  const finished = await runBackgroundTestRunWorker(
    pmRoot,
    runId,
    global.noExtensions === true,
  );
  return {
    id: finished.id,
    status: finished.status,
    exit_code: finished.exit_code,
  };
}
