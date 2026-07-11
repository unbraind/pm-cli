/**
 * @module core/test/background-runs
 *
 * Runs and records linked-test orchestration for Background Runs.
 */
import fs from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import {
  ensureDir,
  pathExists,
  readFileIfExists,
  writeFileAtomic,
} from "../fs/fs-utils.js";
import { PmCliError } from "../shared/errors.js";
import { EXIT_CODE } from "../shared/constants.js";
import { nowIso } from "../shared/time.js";
import {
  getTestRunRecordPath,
  getTestRunResultPath,
  getTestRunStderrPath,
  getTestRunStdoutPath,
  getTestRunsPath,
  getTestRunsRecordsPath,
  getTestRunsResultsPath,
  getTestRunsStderrPath,
  getTestRunsStdoutPath,
} from "../store/paths.js";

const BACKGROUND_RUN_ACTIVE_STATUSES = new Set<BackgroundTestRunStatus>([
  "queued",
  "running",
]);
const BACKGROUND_RUN_TERMINAL_STATUSES = new Set<BackgroundTestRunStatus>([
  "passed",
  "failed",
  "stopped",
  "canceled",
]);
const DEFAULT_BACKGROUND_RUN_RESOURCE_SNAPSHOT_INTERVAL_MS = 3000;
const DEFAULT_BACKGROUND_RUN_FORCE_KILL_DELAY_MS = 3000;
const DEFAULT_BACKGROUND_RUN_HEARTBEAT_STALE_MS = 30000;
const DEFAULT_BACKGROUND_RUN_LOG_TAIL_LINES = 100;
const PROC_STAT_TICKS_PER_SECOND = 100;

/** Restricts background test run kind values accepted by command, SDK, and storage contracts. */
export type BackgroundTestRunKind = "test" | "test-all";

/** Restricts background test run status values accepted by command, SDK, and storage contracts. */
export type BackgroundTestRunStatus =
  | "queued"
  | "running"
  | "passed"
  | "failed"
  | "stopped"
  | "canceled";

/** Restricts background log stream values accepted by command, SDK, and storage contracts. */
export type BackgroundLogStream = "stdout" | "stderr" | "both";

/** Documents the background run progress payload exchanged by command, SDK, and package integrations. */
export interface BackgroundRunProgress {
  /** Value that configures or reports phase for this contract. */
  phase: "queued" | "running" | "stopping" | "finished";
  /** Human-readable explanation suitable for logs and agent-facing output. */
  message?: string;
  /** Value that configures or reports item index for this contract. */
  item_index?: number;
  /** Value that configures or reports item total for this contract. */
  item_total?: number;
  /** Value that configures or reports item id for this contract. */
  item_id?: string;
  /** Value that configures or reports linked test index for this contract. */
  linked_test_index?: number;
  /** Value that configures or reports linked test total for this contract. */
  linked_test_total?: number;
  /** Value that configures or reports current command for this contract. */
  current_command?: string;
  /** Elapsed time in milliseconds for elapsed. */
  elapsed_ms?: number;
  /** ISO 8601 timestamp recording when heartbeat occurred. */
  heartbeat_at?: string;
}

/** Documents the background run resource snapshot payload exchanged by command, SDK, and package integrations. */
export interface BackgroundRunResourceSnapshot {
  /** ISO 8601 timestamp recording when recorded occurred. */
  recorded_at: string;
  /** Value that configures or reports rss bytes for this contract. */
  rss_bytes?: number;
  /** Value that configures or reports cpu user seconds for this contract. */
  cpu_user_seconds?: number;
  /** Value that configures or reports cpu system seconds for this contract. */
  cpu_system_seconds?: number;
  /** Value that configures or reports uptime seconds for this contract. */
  uptime_seconds?: number;
}

/** Documents the background run summary payload exchanged by command, SDK, and package integrations. */
export interface BackgroundRunSummary {
  /** Value that configures or reports items for this contract. */
  items?: number;
  /** Value that configures or reports linked tests for this contract. */
  linked_tests?: number;
  /** Value that configures or reports passed for this contract. */
  passed: number;
  /** Value that configures or reports failed for this contract. */
  failed: number;
  /** Value that configures or reports skipped for this contract. */
  skipped: number;
  /** Value that configures or reports fail on skipped triggered for this contract. */
  fail_on_skipped_triggered?: boolean;
}

/** Documents the background test run record payload exchanged by command, SDK, and package integrations. */
export interface BackgroundTestRunRecord {
  /** Stable identifier used to reference this record across commands and storage. */
  id: string;
  /** Value that configures or reports kind for this contract. */
  kind: BackgroundTestRunKind;
  /** Lifecycle state reported for status. */
  status: BackgroundTestRunStatus;
  /** ISO 8601 timestamp recording when created occurred. */
  created_at: string;
  /** ISO 8601 timestamp recording when started occurred. */
  started_at?: string;
  /** ISO 8601 timestamp recording when finished occurred. */
  finished_at?: string;
  /** ISO 8601 timestamp recording when updated occurred. */
  updated_at: string;
  /** Value that configures or reports requested by for this contract. */
  requested_by: string;
  /** Value that configures or reports fingerprint for this contract. */
  fingerprint: string;
  /** Value that configures or reports command args for this contract. */
  command_args: string[];
  /** Value that configures or reports command label for this contract. */
  command_label: string;
  /** Value that configures or reports pm root for this contract. */
  pm_root: string;
  /** Value that configures or reports global pm root for this contract. */
  global_pm_root: string;
  /** Value that configures or reports target id for this contract. */
  target_id?: string;
  /** Value that configures or reports status filter for this contract. */
  status_filter?: string;
  /** Value that configures or reports attempt for this contract. */
  attempt: number;
  /** Value that configures or reports resumed from for this contract. */
  resumed_from?: string;
  /** Value that configures or reports resumed by for this contract. */
  resumed_by?: string;
  /** Value that configures or reports worker pid for this contract. */
  worker_pid?: number;
  /** Value that configures or reports child pid for this contract. */
  child_pid?: number;
  /** Value that configures or reports exit code for this contract. */
  exit_code?: number;
  /** Value that configures or reports signal for this contract. */
  signal?: string;
  /** Filesystem path used for stdout resolution. */
  stdout_path: string;
  /** Filesystem path used for stderr resolution. */
  stderr_path: string;
  /** Filesystem path used for result resolution. */
  result_path: string;
  /** Value that configures or reports progress for this contract. */
  progress?: BackgroundRunProgress;
  /** Value that configures or reports resource for this contract. */
  resource?: BackgroundRunResourceSnapshot;
  /** Value that configures or reports summary for this contract. */
  summary?: BackgroundRunSummary;
  /** ISO 8601 timestamp recording when stop requested occurred. */
  stop_requested_at?: string;
  /** Value that configures or reports duplicate of for this contract. */
  duplicate_of?: string;
  /** Value that configures or reports error for this contract. */
  error?: string;
}

/** Documents the start background test run options payload exchanged by command, SDK, and package integrations. */
export interface StartBackgroundTestRunOptions {
  /** Value that configures or reports pm root for this contract. */
  pmRoot: string;
  /** Value that configures or reports global pm root for this contract. */
  globalPmRoot: string;
  /** Value that configures or reports kind for this contract. */
  kind: BackgroundTestRunKind;
  /** Value that configures or reports command args for this contract. */
  commandArgs: string[];
  /** Value that configures or reports requested by for this contract. */
  requestedBy: string;
  /** Value that configures or reports target id for this contract. */
  targetId?: string;
  /** Value that configures or reports status filter for this contract. */
  statusFilter?: string;
  /** Value that configures or reports resumed from for this contract. */
  resumedFrom?: string;
  /** Value that configures or reports resumed by for this contract. */
  resumedBy?: string;
  /** Value that configures or reports attempt for this contract. */
  attempt?: number;
}

/** Documents the start background test run result payload exchanged by command, SDK, and package integrations. */
export interface StartBackgroundTestRunResult {
  /** Value that configures or reports started for this contract. */
  started: boolean;
  /** Value that configures or reports run for this contract. */
  run: BackgroundTestRunRecord;
  /** Value that configures or reports duplicate of for this contract. */
  duplicate_of?: string;
}

/** Documents the spawn background test run worker options payload exchanged by command, SDK, and package integrations. */
export interface SpawnBackgroundTestRunWorkerOptions {
  /** Value that configures or reports pm root for this contract. */
  pmRoot: string;
  /** Executes the id operation through the package runtime. */
  runId: string;
  /** Value that configures or reports no extensions for this contract. */
  noExtensions?: boolean;
}

/** Documents the stop background test run result payload exchanged by command, SDK, and package integrations. */
export interface StopBackgroundTestRunResult {
  /** Value that configures or reports run for this contract. */
  run: BackgroundTestRunRecord;
  /** Value that configures or reports signal sent for this contract. */
  signal_sent: "SIGTERM" | "SIGKILL" | "none";
}

/** Documents the list background test run options payload exchanged by command, SDK, and package integrations. */
export interface ListBackgroundTestRunOptions {
  /** Lifecycle state reported for status. */
  status?: BackgroundTestRunStatus;
  /** Value that configures or reports limit for this contract. */
  limit?: number;
}

/** Documents the background run health payload exchanged by command, SDK, and package integrations. */
export interface BackgroundRunHealth {
  /** Value that configures or reports state for this contract. */
  state: "healthy" | "stale" | "inactive";
  /** ISO 8601 timestamp recording when last heartbeat occurred. */
  last_heartbeat_at?: string;
  /** Elapsed time in milliseconds for heartbeat lag. */
  heartbeat_lag_ms?: number;
  /** Value that configures or reports worker alive for this contract. */
  worker_alive: boolean;
  /** Value that configures or reports child alive for this contract. */
  child_alive: boolean;
}

/** Documents the background run status view payload exchanged by command, SDK, and package integrations. */
export interface BackgroundRunStatusView {
  /** Value that configures or reports run for this contract. */
  run: BackgroundTestRunRecord;
  /** Value that configures or reports health for this contract. */
  health: BackgroundRunHealth;
}

/** Documents the background run logs result payload exchanged by command, SDK, and package integrations. */
export interface BackgroundRunLogsResult {
  /** Value that configures or reports run for this contract. */
  run: BackgroundTestRunRecord;
  /** Value that configures or reports stream for this contract. */
  stream: BackgroundLogStream;
  /** Value that configures or reports tail for this contract. */
  tail: number;
  /** Value that configures or reports stdout for this contract. */
  stdout: string[];
  /** Value that configures or reports stderr for this contract. */
  stderr: string[];
}

interface WorkerEvaluationResult {
  summary: BackgroundRunSummary;
  parsedResult: unknown | null;
}

interface BackgroundWorkerStopState {
  stopRequested: boolean;
}

interface BackgroundRunRecordWriteScheduler {
  schedule: () => void;
  flush: () => Promise<void>;
}

function nowMs(): number {
  return Date.now();
}

function normalizeCommandArgs(args: string[]): string[] {
  return args.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

function summarizeCommandLabel(args: string[]): string {
  const joined = args.join(" ").replaceAll(/\s+/g, " ").trim();
  if (joined.length <= 180) {
    return joined;
  }
  return `${joined.slice(0, 177)}...`;
}

function buildRunId(): string {
  const timePart = Date.now().toString(36);
  const randomPart = randomBytes(3).toString("hex");
  return `tr-${timePart}-${randomPart}`;
}

/** Implements build background test run fingerprint for the public runtime surface of this module. */
export function buildBackgroundTestRunFingerprint(
  kind: BackgroundTestRunKind,
  commandArgs: string[],
  pmRoot: string,
): string {
  const payload = {
    kind,
    command: normalizeCommandArgs(commandArgs),
    pm_root: path.resolve(pmRoot),
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function isPidRunning(pid: number | undefined): boolean {
  if (!Number.isInteger(pid) || !pid || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? (error as { code?: string }).code
        : undefined;
    return code === "EPERM";
  }
}

async function ensureBackgroundRunStorage(pmRoot: string): Promise<void> {
  await ensureDir(getTestRunsPath(pmRoot));
  await ensureDir(getTestRunsRecordsPath(pmRoot));
  await ensureDir(getTestRunsStdoutPath(pmRoot));
  await ensureDir(getTestRunsStderrPath(pmRoot));
  await ensureDir(getTestRunsResultsPath(pmRoot));
}

async function parseBackgroundRunRecord(
  raw: string,
  recordPath: string,
): Promise<BackgroundTestRunRecord> {
  try {
    const parsed = JSON.parse(raw) as BackgroundTestRunRecord;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.id !== "string"
    ) {
      throw new Error("invalid run record payload");
    }
    return parsed;
  } catch (error: unknown) {
    throw new PmCliError(
      `Failed to parse background test run record at ${recordPath}: ${error instanceof Error ? error.message : String(error)}`,
      EXIT_CODE.GENERIC_FAILURE,
    );
  }
}

async function writeBackgroundRunRecord(
  pmRoot: string,
  record: BackgroundTestRunRecord,
): Promise<void> {
  const next: BackgroundTestRunRecord = {
    ...record,
    updated_at: nowIso(),
  };
  await writeFileAtomic(
    getTestRunRecordPath(pmRoot, record.id),
    `${JSON.stringify(next, null, 2)}\n`,
  );
}

/** Implements read background test run record for the public runtime surface of this module. */
export async function readBackgroundTestRunRecord(
  pmRoot: string,
  runId: string,
): Promise<BackgroundTestRunRecord | null> {
  const recordPath = getTestRunRecordPath(pmRoot, runId);
  const raw = await readFileIfExists(recordPath);
  if (!raw) {
    return null;
  }
  return parseBackgroundRunRecord(raw, recordPath);
}

async function listBackgroundRunRecordPaths(pmRoot: string): Promise<string[]> {
  const recordsRoot = getTestRunsRecordsPath(pmRoot);
  if (!(await pathExists(recordsRoot))) {
    return [];
  }
  const entries = await fs.readdir(recordsRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(recordsRoot, entry.name))
    .sort((left, right) => right.localeCompare(left));
}

function parseLinuxRssStatus(raw: string): number | undefined {
  const match = raw.match(/^VmRSS:\s+(\d+)\s+kB$/m);
  if (!match) {
    return undefined;
  }
  return Number.parseInt(match[1], 10) * 1024;
}

async function readLinuxRssBytes(pid: number): Promise<number | undefined> {
  if (process.platform !== "linux") {
    return undefined;
  }
  try {
    const raw = await fs.readFile(`/proc/${pid}/status`, "utf8");
    return parseLinuxRssStatus(raw);
  } catch {
    return undefined;
  }
}

function parseLinuxCpuStat(raw: string): {
  cpu_user_seconds?: number;
  cpu_system_seconds?: number;
} {
  const closeParenIndex = raw.lastIndexOf(")");
  if (closeParenIndex < 0) {
    return {};
  }
  const remainder = raw.slice(closeParenIndex + 2).trim();
  const parts = remainder.split(/\s+/);
  const utimeTicks = Number.parseInt(parts[11], 10);
  const stimeTicks = Number.parseInt(parts[12], 10);
  if (!Number.isFinite(utimeTicks) || !Number.isFinite(stimeTicks)) {
    return {};
  }
  return {
    cpu_user_seconds: utimeTicks / PROC_STAT_TICKS_PER_SECOND,
    cpu_system_seconds: stimeTicks / PROC_STAT_TICKS_PER_SECOND,
  };
}

async function readLinuxCpuSeconds(
  pid: number,
): Promise<{ cpu_user_seconds?: number; cpu_system_seconds?: number }> {
  if (process.platform !== "linux") {
    return {};
  }
  try {
    const raw = await fs.readFile(`/proc/${pid}/stat`, "utf8");
    return parseLinuxCpuStat(raw);
  } catch {
    /* c8 ignore next -- /proc entries can disappear between liveness and stat reads. */
    return {};
  }
}

async function buildResourceSnapshot(
  record: BackgroundTestRunRecord,
): Promise<BackgroundRunResourceSnapshot | undefined> {
  const pid = record.child_pid ?? record.worker_pid;
  if (!isPidRunning(pid)) {
    return undefined;
  }
  const rssBytes = await readLinuxRssBytes(pid as number);
  const cpu = await readLinuxCpuSeconds(pid as number);
  const startedAtMs = record.started_at
    ? Date.parse(record.started_at)
    : Number.NaN;
  const uptimeSeconds = Number.isFinite(startedAtMs)
    ? Math.max(0, (nowMs() - startedAtMs) / 1000)
    : undefined;
  return {
    recorded_at: nowIso(),
    rss_bytes: rssBytes,
    cpu_user_seconds: cpu.cpu_user_seconds,
    cpu_system_seconds: cpu.cpu_system_seconds,
    uptime_seconds: uptimeSeconds,
  };
}

function readCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function evaluateWorkerResult(
  kind: BackgroundTestRunKind,
  payload: unknown,
): WorkerEvaluationResult {
  if (!payload || typeof payload !== "object") {
    return {
      summary: {
        passed: 0,
        failed: 1,
        skipped: 0,
      },
      parsedResult: null,
    };
  }
  const record = payload as Record<string, unknown>;
  if (kind === "test-all") {
    const totals = (record.totals ?? {}) as Record<string, unknown>;
    return {
      summary: {
        items: typeof totals.items === "number" ? totals.items : undefined,
        linked_tests:
          typeof totals.linked_tests === "number"
            ? totals.linked_tests
            : undefined,
        passed: readCount(totals.passed),
        failed: readCount(totals.failed),
        skipped: readCount(totals.skipped),
        fail_on_skipped_triggered:
          record.fail_on_skipped_triggered === true ? true : undefined,
      },
      parsedResult: payload,
    };
  }
  const runResults = Array.isArray(record.run_results)
    ? record.run_results
    : [];
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const entry of runResults) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const status = (entry as { status?: unknown }).status;
    if (status === "passed") {
      passed += 1;
      continue;
    }
    if (status === "failed") {
      failed += 1;
      continue;
    }
    skipped += 1;
  }
  return {
    summary: {
      passed,
      failed,
      skipped,
      fail_on_skipped_triggered:
        record.fail_on_skipped_triggered === true ? true : undefined,
    },
    parsedResult: payload,
  };
}

function parseProgressLine(
  stderrLine: string,
): Partial<BackgroundRunProgress> | null {
  const line = stderrLine.trim();
  if (line.length === 0) {
    return null;
  }
  const testAllMatch = line.match(
    /\[pm test-all\]\s+item\s+(\d+)\/(\d+)\s+(start|end)\s+id=([^\s]+)/i,
  );
  if (testAllMatch) {
    const itemIndex = Number.parseInt(testAllMatch[1], 10);
    const itemTotal = Number.parseInt(testAllMatch[2], 10);
    return {
      item_index: itemIndex,
      item_total: itemTotal,
      item_id: testAllMatch[4],
      linked_test_index: undefined,
      linked_test_total: undefined,
      current_command: undefined,
      elapsed_ms: undefined,
      heartbeat_at: nowIso(),
      phase: testAllMatch[3]?.toLowerCase() === "end" ? "finished" : "running",
    };
  }
  const linkedTestMatch = line.match(
    /\[pm test\]\s+linked-test\s+(\d+)\/(\d+)\s+(start|running|end)(?:.*elapsed_ms=(\d+))?/i,
  );
  if (!linkedTestMatch) {
    return null;
  }
  const index = Number.parseInt(linkedTestMatch[1], 10);
  const total = Number.parseInt(linkedTestMatch[2], 10);
  const elapsed = linkedTestMatch[4]
    ? Number.parseInt(linkedTestMatch[4], 10)
    : undefined;
  const commandMatch = line.match(/\scommand="((?:\\.|[^"\\])*)"/);
  const currentCommand = commandMatch
    ? commandMatch[1].replaceAll('\\"', '"').replaceAll("\\\\", "\\")
    : undefined;
  return {
    linked_test_index: index,
    linked_test_total: total,
    current_command: currentCommand,
    elapsed_ms: Number.isFinite(elapsed) ? elapsed : undefined,
    heartbeat_at: nowIso(),
    phase: linkedTestMatch[3]?.toLowerCase() === "end" ? "finished" : "running",
  };
}

function splitLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((entry) => entry.trimEnd())
    .filter((entry) => entry.length > 0);
}

function tailLines(value: string, limit: number): string[] {
  if (limit <= 0) {
    return [];
  }
  const lines = splitLines(value);
  if (lines.length <= limit) {
    return lines;
  }
  return lines.slice(lines.length - limit);
}

async function resolveBackgroundCliEntry(cwd: string): Promise<string> {
  const configured = process.env.PM_BACKGROUND_CLI_ENTRY?.trim();
  if (configured && configured.length > 0) {
    const resolvedConfigured = path.resolve(cwd, configured);
    if (await pathExists(resolvedConfigured)) {
      return resolvedConfigured;
    }
  }
  const distEntry = path.resolve(cwd, "dist", "cli.js");
  if (await pathExists(distEntry)) {
    return distEntry;
  }
  const argvEntry = process.argv[1]?.trim();
  if (argvEntry && argvEntry.length > 0) {
    const resolvedArgvEntry = path.resolve(cwd, argvEntry);
    if (await pathExists(resolvedArgvEntry)) {
      return resolvedArgvEntry;
    }
  }
  throw new PmCliError(
    "Unable to resolve a CLI entrypoint for background test runs. Build the project or set PM_BACKGROUND_CLI_ENTRY.",
    EXIT_CODE.GENERIC_FAILURE,
  );
}

async function refreshRunIfStale(
  pmRoot: string,
  record: BackgroundTestRunRecord,
): Promise<BackgroundTestRunRecord> {
  if (!BACKGROUND_RUN_ACTIVE_STATUSES.has(record.status)) {
    return record;
  }
  const workerAlive = isPidRunning(record.worker_pid);
  if (workerAlive) {
    return record;
  }
  if (record.finished_at) {
    return record;
  }
  const next: BackgroundTestRunRecord = {
    ...record,
    status: "failed",
    finished_at: nowIso(),
    error:
      record.error ??
      "Background test run worker exited before writing terminal status.",
  };
  await writeBackgroundRunRecord(pmRoot, next);
  return next;
}

/** Implements start background test run for the public runtime surface of this module. */
export async function startBackgroundTestRun(
  options: StartBackgroundTestRunOptions,
): Promise<StartBackgroundTestRunResult> {
  await ensureBackgroundRunStorage(options.pmRoot);
  const normalizedArgs = normalizeCommandArgs(options.commandArgs);
  if (normalizedArgs.length === 0) {
    throw new PmCliError(
      "Background test run requires command arguments.",
      EXIT_CODE.USAGE,
    );
  }
  const fingerprint = buildBackgroundTestRunFingerprint(
    options.kind,
    normalizedArgs,
    options.pmRoot,
  );
  const existingRuns = await listBackgroundTestRuns(options.pmRoot, {});
  for (const existing of existingRuns) {
    const refreshed = await refreshRunIfStale(options.pmRoot, existing);
    if (refreshed.fingerprint !== fingerprint) {
      continue;
    }
    if (
      !BACKGROUND_RUN_ACTIVE_STATUSES.has(refreshed.status) ||
      !isPidRunning(refreshed.worker_pid)
    ) {
      continue;
    }
    return {
      started: false,
      run: {
        ...refreshed,
        duplicate_of: refreshed.id,
      },
      duplicate_of: refreshed.id,
    };
  }

  const runId = buildRunId();
  const createdAt = nowIso();
  const stdoutPath = getTestRunStdoutPath(options.pmRoot, runId);
  const stderrPath = getTestRunStderrPath(options.pmRoot, runId);
  const resultPath = getTestRunResultPath(options.pmRoot, runId);
  await fs.writeFile(stdoutPath, "", "utf8");
  await fs.writeFile(stderrPath, "", "utf8");
  const record: BackgroundTestRunRecord = {
    id: runId,
    kind: options.kind,
    status: "queued",
    created_at: createdAt,
    updated_at: createdAt,
    requested_by: options.requestedBy,
    fingerprint,
    command_args: normalizedArgs,
    command_label: summarizeCommandLabel(normalizedArgs),
    pm_root: options.pmRoot,
    global_pm_root: options.globalPmRoot,
    target_id: options.targetId,
    status_filter: options.statusFilter,
    attempt:
      typeof options.attempt === "number" &&
      Number.isFinite(options.attempt) &&
      options.attempt >= 1
        ? Math.floor(options.attempt)
        : 1,
    resumed_from: options.resumedFrom,
    resumed_by: options.resumedBy,
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    result_path: resultPath,
    progress: {
      phase: "queued",
      message: "Queued for background execution.",
      heartbeat_at: createdAt,
    },
  };
  await writeBackgroundRunRecord(options.pmRoot, record);
  return {
    started: true,
    run: record,
  };
}

/** Implements spawn background test run worker for the public runtime surface of this module. */
export async function spawnBackgroundTestRunWorker(
  options: SpawnBackgroundTestRunWorkerOptions,
): Promise<BackgroundTestRunRecord> {
  const record = await readBackgroundTestRunRecord(
    options.pmRoot,
    options.runId,
  );
  if (!record) {
    throw new PmCliError(
      `Background test run ${options.runId} not found`,
      EXIT_CODE.NOT_FOUND,
    );
  }
  if (BACKGROUND_RUN_TERMINAL_STATUSES.has(record.status)) {
    throw new PmCliError(
      `Background test run ${record.id} is already terminal (${record.status}).`,
      EXIT_CODE.CONFLICT,
    );
  }
  const cliEntry = await resolveBackgroundCliEntry(process.cwd());
  const args: string[] = [];
  if (options.noExtensions === true) {
    args.push("--no-extensions");
  }
  args.push("--path", record.pm_root, "test-runs-worker", record.id);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PM_PATH: record.pm_root,
    PM_GLOBAL_PATH: record.global_pm_root,
    PM_BACKGROUND_TEST_RUN_ID: record.id,
    PM_BACKGROUND_TEST_RUN_ATTEMPT: String(record.attempt),
    PM_BACKGROUND_TEST_RUN_RESUMED_FROM: record.resumed_from ?? "",
    FORCE_COLOR: "0",
  };
  const child = spawn(process.execPath, [cliEntry, ...args], {
    cwd: process.cwd(),
    env,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  const next: BackgroundTestRunRecord = {
    ...record,
    status: "queued",
    worker_pid: child.pid as number | undefined,
    progress: {
      phase: "queued",
      message: "Worker process started.",
      heartbeat_at: nowIso(),
    },
  };
  await writeBackgroundRunRecord(options.pmRoot, next);
  return next;
}

async function appendFileOrdered(
  queue: Promise<void>,
  filePath: string,
  text: string,
): Promise<void> {
  await queue;
  await fs.appendFile(filePath, text, "utf8");
}

function resolvePositiveEnvInteger(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function buildBackgroundWorkerEnv(
  record: BackgroundTestRunRecord,
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PM_PATH: record.pm_root,
    PM_GLOBAL_PATH: record.global_pm_root,
    FORCE_COLOR: "0",
  };
}

function buildBackgroundWorkerChildArgs(
  record: BackgroundTestRunRecord,
  noExtensions: boolean,
): string[] {
  return noExtensions
    ? ["--no-extensions", ...record.command_args]
    : [...record.command_args];
}

function createBackgroundRunRecordWriteScheduler(
  pmRoot: string,
  record: BackgroundTestRunRecord,
): BackgroundRunRecordWriteScheduler {
  let writeQueue: Promise<void> = Promise.resolve();
  return {
    schedule(): void {
      writeQueue = writeQueue.then(async () => {
        try {
          await writeBackgroundRunRecord(pmRoot, record);
        } catch {
          // Keep worker alive even if a single metadata write fails.
        }
      });
    },
    async flush(): Promise<void> {
      await writeQueue;
    },
  };
}

function requestChildSignal(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    child.kill(signal);
  } catch {
    // Child may already be gone.
  }
}

async function requestBackgroundWorkerStop(
  record: BackgroundTestRunRecord,
  child: ChildProcess,
  state: BackgroundWorkerStopState,
  scheduleRecordWrite: () => void,
): Promise<void> {
  if (state.stopRequested) {
    return;
  }
  state.stopRequested = true;
  record.stop_requested_at = nowIso();
  record.progress = {
    ...record.progress,
    phase: "stopping",
    message: "Stop requested for background run.",
    heartbeat_at: nowIso(),
  };
  scheduleRecordWrite();
  requestChildSignal(child, "SIGTERM");
  const forceTimer = setTimeout(
    () => requestChildSignal(child, "SIGKILL"),
    resolvePositiveEnvInteger(
      "PM_BACKGROUND_RUN_FORCE_KILL_DELAY_MS",
      DEFAULT_BACKGROUND_RUN_FORCE_KILL_DELAY_MS,
    ),
  );
  forceTimer.unref?.();
}

function buildItemBackgroundProgress(
  line: string,
  progressPatch: Partial<BackgroundRunProgress>,
  phase: "running" | "stopping",
): BackgroundRunProgress {
  return {
    phase,
    message: line,
    heartbeat_at: nowIso(),
    item_index: progressPatch.item_index,
    item_total: progressPatch.item_total,
    item_id: progressPatch.item_id,
    linked_test_index: undefined,
    linked_test_total: undefined,
    current_command: undefined,
    elapsed_ms: undefined,
  };
}

function buildLinkedTestBackgroundProgress(
  line: string,
  record: BackgroundTestRunRecord,
  progressPatch: Partial<BackgroundRunProgress>,
  phase: "running" | "stopping",
): BackgroundRunProgress {
  return {
    phase,
    message: line,
    heartbeat_at: nowIso(),
    item_index: progressPatch.item_index ?? record.progress?.item_index,
    item_total: progressPatch.item_total ?? record.progress?.item_total,
    item_id: progressPatch.item_id ?? record.progress?.item_id,
    linked_test_index: progressPatch.linked_test_index,
    linked_test_total: progressPatch.linked_test_total,
    current_command: progressPatch.current_command,
    elapsed_ms: progressPatch.elapsed_ms,
  };
}

function applyBackgroundWorkerProgressLine(
  record: BackgroundTestRunRecord,
  line: string,
  stopRequested: boolean,
): boolean {
  const progressPatch = parseProgressLine(line);
  if (!progressPatch) {
    return false;
  }
  const phase = record.progress?.phase === "stopping" ? "stopping" : "running";
  record.progress = progressPatch.item_id
    ? buildItemBackgroundProgress(line, progressPatch, phase)
    : buildLinkedTestBackgroundProgress(line, record, progressPatch, phase);
  if (progressPatch.phase === "finished" && !stopRequested) {
    record.progress.phase = "running";
  }
  return true;
}

function parseBackgroundWorkerStdout(stdoutBuffer: string): unknown | null {
  if (stdoutBuffer.trim().length === 0) {
    return null;
  }
  try {
    return JSON.parse(stdoutBuffer) as unknown;
  } catch {
    return null;
  }
}

function resolveBackgroundWorkerFinalStatus(
  record: BackgroundTestRunRecord,
  stopRequested: boolean,
): BackgroundTestRunStatus {
  if (stopRequested) {
    return "stopped";
  }
  const passed =
    record.exit_code === 0 &&
    (record.summary?.failed ?? 0) === 0 &&
    record.summary?.fail_on_skipped_triggered !== true;
  return passed ? "passed" : "failed";
}

function buildFinishedBackgroundProgress(
  record: BackgroundTestRunRecord,
  stopRequested: boolean,
): BackgroundRunProgress {
  return {
    phase: "finished",
    message: stopRequested
      ? "Background run stopped."
      : `Background run finished with status=${record.status}.`,
    heartbeat_at: nowIso(),
    item_index: record.progress?.item_index,
    item_total: record.progress?.item_total,
    item_id: record.progress?.item_id,
    linked_test_index: record.progress?.linked_test_index,
    linked_test_total: record.progress?.linked_test_total,
    current_command: record.progress?.current_command,
    elapsed_ms: record.progress?.elapsed_ms,
  };
}

async function writeBackgroundWorkerResult(
  record: BackgroundTestRunRecord,
  parsedResult: unknown | null,
  stdoutBuffer: string,
): Promise<void> {
  if (parsedResult !== null) {
    await writeFileAtomic(
      record.result_path,
      `${JSON.stringify(parsedResult, null, 2)}\n`,
    );
    return;
  }
  await writeFileAtomic(
    record.result_path,
    `${JSON.stringify(
      {
        parse_error: "Background run output was not valid JSON.",
        stdout_excerpt: tailLines(
          stdoutBuffer,
          DEFAULT_BACKGROUND_RUN_LOG_TAIL_LINES,
        ),
      },
      null,
      2,
    )}\n`,
  );
}

/** Implements run background test run worker for the public runtime surface of this module. */
export async function runBackgroundTestRunWorker(
  pmRoot: string,
  runId: string,
  noExtensions = false,
): Promise<BackgroundTestRunRecord> {
  const loaded = await readBackgroundTestRunRecord(pmRoot, runId);
  if (!loaded) {
    throw new PmCliError(
      `Background test run ${runId} not found`,
      EXIT_CODE.NOT_FOUND,
    );
  }
  const record: BackgroundTestRunRecord = {
    ...loaded,
    status: "running",
    started_at: loaded.started_at ?? nowIso(),
    worker_pid: process.pid,
    progress: {
      phase: "running",
      message: "Worker started.",
      heartbeat_at: nowIso(),
    },
  };
  const cliEntry = await resolveBackgroundCliEntry(process.cwd());
  const env = buildBackgroundWorkerEnv(record);
  await writeBackgroundRunRecord(pmRoot, record);

  const childArgs = buildBackgroundWorkerChildArgs(record, noExtensions);
  const child = spawn(process.execPath, [cliEntry, ...childArgs], {
    cwd: process.cwd(),
    env,
    detached: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  record.child_pid = child.pid as number | undefined;

  const recordWriteScheduler = createBackgroundRunRecordWriteScheduler(
    pmRoot,
    record,
  );
  const scheduleRecordWrite = recordWriteScheduler.schedule;

  let stdoutWriteQueue: Promise<void> = Promise.resolve();
  let stderrWriteQueue: Promise<void> = Promise.resolve();
  let stdoutBuffer = "";
  let stderrBuffer = "";
  const stopState: BackgroundWorkerStopState = { stopRequested: false };

  const onSignal = (): void => {
    void requestBackgroundWorkerStop(
      record,
      child,
      stopState,
      scheduleRecordWrite,
    );
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  const resourceTimer = setInterval(
    () => {
      void (async () => {
        record.resource = await buildResourceSnapshot(record);
        (record.progress as BackgroundRunProgress).heartbeat_at = nowIso();
        scheduleRecordWrite();
      })();
    },
    resolvePositiveEnvInteger(
      "PM_BACKGROUND_RUN_RESOURCE_INTERVAL_MS",
      DEFAULT_BACKGROUND_RUN_RESOURCE_SNAPSHOT_INTERVAL_MS,
    ),
  );
  resourceTimer.unref?.();

  child.stdout?.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    stdoutBuffer += text;
    stdoutWriteQueue = appendFileOrdered(
      stdoutWriteQueue,
      record.stdout_path,
      text,
    );
  });

  child.stderr?.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    stderrWriteQueue = appendFileOrdered(
      stderrWriteQueue,
      record.stderr_path,
      text,
    );
    stderrBuffer += text;
    const parts = stderrBuffer.split(/\r?\n/);
    stderrBuffer = parts.pop()!;
    let progressChanged = false;
    for (const part of parts) {
      const line = part.trimEnd();
      if (
        line.length > 0 &&
        applyBackgroundWorkerProgressLine(record, line, stopState.stopRequested)
      ) {
        progressChanged = true;
      }
    }
    if (progressChanged) {
      scheduleRecordWrite();
    }
  });

  let exitCode: number | null = null;
  let signal: NodeJS.Signals | null = null;
  try {
    ({ code: exitCode, signal } = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve) => {
      child.on("close", (code, closeSignal) => {
        resolve({ code, signal: closeSignal });
      });
    }));
  } finally {
    clearInterval(resourceTimer);
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
  }

  await stdoutWriteQueue;
  await stderrWriteQueue;
  const trailingStderrLine = stderrBuffer.trimEnd();
  if (
    trailingStderrLine.length > 0 &&
    applyBackgroundWorkerProgressLine(
      record,
      trailingStderrLine,
      stopState.stopRequested,
    )
  ) {
    scheduleRecordWrite();
  }
  stderrBuffer = "";

  const parsedResult = parseBackgroundWorkerStdout(stdoutBuffer);
  const evaluated = evaluateWorkerResult(record.kind, parsedResult);
  record.summary = evaluated.summary;
  record.exit_code = typeof exitCode === "number" ? exitCode : undefined;
  record.signal = signal ?? undefined;
  record.finished_at = nowIso();
  record.status = resolveBackgroundWorkerFinalStatus(
    record,
    stopState.stopRequested,
  );
  record.progress = buildFinishedBackgroundProgress(
    record,
    stopState.stopRequested,
  );
  record.resource = await buildResourceSnapshot(record);
  await writeBackgroundWorkerResult(record, parsedResult, stdoutBuffer);
  await writeBackgroundRunRecord(pmRoot, record);
  await recordWriteScheduler.flush();
  return record;
}

/** Implements list background test runs for the public runtime surface of this module. */
export async function listBackgroundTestRuns(
  pmRoot: string,
  options: ListBackgroundTestRunOptions,
): Promise<BackgroundTestRunRecord[]> {
  const recordPaths = await listBackgroundRunRecordPaths(pmRoot);
  const runs: BackgroundTestRunRecord[] = [];
  for (const recordPath of recordPaths) {
    const raw = await readFileIfExists(recordPath);
    if (!raw) {
      continue;
    }
    const parsed = await parseBackgroundRunRecord(raw, recordPath);
    runs.push(parsed);
  }
  const refreshed: BackgroundTestRunRecord[] = [];
  for (const run of runs) {
    refreshed.push(await refreshRunIfStale(pmRoot, run));
  }
  const filtered = options.status
    ? refreshed.filter((entry) => entry.status === options.status)
    : refreshed;
  const sorted = filtered.sort((left, right) => {
    const byUpdated =
      Date.parse(right.updated_at) - Date.parse(left.updated_at);
    if (Number.isFinite(byUpdated) && byUpdated !== 0) {
      return byUpdated;
    }
    return right.id.localeCompare(left.id);
  });
  const limit =
    typeof options.limit === "number" && options.limit >= 0
      ? options.limit
      : undefined;
  return limit === undefined ? sorted : sorted.slice(0, limit);
}

/** Implements get background test run status for the public runtime surface of this module. */
export async function getBackgroundTestRunStatus(
  pmRoot: string,
  runId: string,
): Promise<BackgroundRunStatusView> {
  const loaded = await readBackgroundTestRunRecord(pmRoot, runId);
  if (!loaded) {
    throw new PmCliError(
      `Background test run ${runId} not found`,
      EXIT_CODE.NOT_FOUND,
    );
  }
  const refreshed = await refreshRunIfStale(pmRoot, loaded);
  const workerAlive = isPidRunning(refreshed.worker_pid);
  const childAlive = isPidRunning(refreshed.child_pid);
  if (
    refreshed.status === "running" &&
    !childAlive &&
    !refreshed.finished_at &&
    !workerAlive
  ) {
    refreshed.status = "failed";
    refreshed.finished_at = nowIso();
    refreshed.error =
      refreshed.error ?? "Background run process exited unexpectedly.";
    await writeBackgroundRunRecord(pmRoot, refreshed);
  }
  if (refreshed.status === "running") {
    refreshed.resource = await buildResourceSnapshot(refreshed);
    await writeBackgroundRunRecord(pmRoot, refreshed);
  }
  const heartbeatAt = refreshed.progress?.heartbeat_at;
  const heartbeatAtMs = heartbeatAt ? Date.parse(heartbeatAt) : Number.NaN;
  const lagMs = Number.isFinite(heartbeatAtMs)
    ? Math.max(0, nowMs() - heartbeatAtMs)
    : undefined;
  const staleMs = Number.parseInt(
    process.env.PM_BACKGROUND_RUN_HEARTBEAT_STALE_MS ?? "",
    10,
  );
  const staleThresholdMs =
    Number.isFinite(staleMs) && staleMs > 0
      ? staleMs
      : DEFAULT_BACKGROUND_RUN_HEARTBEAT_STALE_MS;
  const healthState =
    refreshed.status === "running"
      ? lagMs !== undefined && lagMs > staleThresholdMs
        ? "stale"
        : "healthy"
      : "inactive";
  return {
    run: refreshed,
    health: {
      state: healthState,
      last_heartbeat_at: heartbeatAt,
      heartbeat_lag_ms: lagMs,
      worker_alive: workerAlive,
      child_alive: childAlive,
    },
  };
}

/* v8 ignore start -- stop-signal branches depend on live process state; command tests cover observable stop behavior */
function sendBackgroundRunStopSignal(
  record: BackgroundTestRunRecord,
  force: boolean,
): "SIGTERM" | "SIGKILL" | "none" {
  const signal: NodeJS.Signals = force ? "SIGKILL" : "SIGTERM";
  if (!isPidRunning(record.worker_pid) || !record.worker_pid) {
    return "none";
  }
  try {
    process.kill(record.worker_pid, signal);
    return signal;
  } catch {
    return "none";
  }
}
/* v8 ignore stop */

function buildStoppingBackgroundProgress(
  record: BackgroundTestRunRecord,
  signalSent: "SIGTERM" | "SIGKILL" | "none",
): BackgroundRunProgress {
  return {
    phase: "stopping",
    message:
      signalSent === "none"
        ? "Run marked stopped."
        : `Stop requested via ${signalSent}.`,
    heartbeat_at: nowIso(),
    item_index: record.progress?.item_index,
    item_total: record.progress?.item_total,
    item_id: record.progress?.item_id,
    linked_test_index: record.progress?.linked_test_index,
    linked_test_total: record.progress?.linked_test_total,
    current_command: record.progress?.current_command,
    elapsed_ms: record.progress?.elapsed_ms,
  };
}

/** Implements stop background test run for the public runtime surface of this module. */
export async function stopBackgroundTestRun(
  pmRoot: string,
  runId: string,
  force = false,
): Promise<StopBackgroundTestRunResult> {
  const loaded = await readBackgroundTestRunRecord(pmRoot, runId);
  if (!loaded) {
    throw new PmCliError(
      `Background test run ${runId} not found`,
      EXIT_CODE.NOT_FOUND,
    );
  }
  const refreshed = await refreshRunIfStale(pmRoot, loaded);
  if (BACKGROUND_RUN_TERMINAL_STATUSES.has(refreshed.status)) {
    return {
      run: refreshed,
      signal_sent: "none",
    };
  }
  const signalSent = sendBackgroundRunStopSignal(refreshed, force);
  if (signalSent === "none") {
    refreshed.status = "stopped";
    refreshed.finished_at = refreshed.finished_at ?? nowIso();
  }
  refreshed.stop_requested_at = nowIso();
  refreshed.progress = buildStoppingBackgroundProgress(refreshed, signalSent);
  await writeBackgroundRunRecord(pmRoot, refreshed);
  return {
    run: refreshed,
    signal_sent: signalSent,
  };
}

/** Implements resume background test run for the public runtime surface of this module. */
export async function resumeBackgroundTestRun(
  pmRoot: string,
  runId: string,
  requestedBy: string,
  noExtensions = false,
): Promise<BackgroundTestRunRecord> {
  const loaded = await readBackgroundTestRunRecord(pmRoot, runId);
  if (!loaded) {
    throw new PmCliError(
      `Background test run ${runId} not found`,
      EXIT_CODE.NOT_FOUND,
    );
  }
  const refreshed = await refreshRunIfStale(pmRoot, loaded);
  if (!BACKGROUND_RUN_TERMINAL_STATUSES.has(refreshed.status)) {
    throw new PmCliError(
      `Background test run ${runId} is not terminal and cannot be resumed.`,
      EXIT_CODE.CONFLICT,
    );
  }
  const started = await startBackgroundTestRun({
    pmRoot: refreshed.pm_root,
    globalPmRoot: refreshed.global_pm_root,
    kind: refreshed.kind,
    commandArgs: refreshed.command_args,
    requestedBy,
    targetId: refreshed.target_id,
    statusFilter: refreshed.status_filter,
    resumedFrom: refreshed.id,
    resumedBy: requestedBy,
    attempt: refreshed.attempt + 1,
  });
  if (!started.started) {
    return started.run;
  }
  const spawned = await spawnBackgroundTestRunWorker({
    pmRoot,
    runId: started.run.id,
    noExtensions,
  });
  const prior: BackgroundTestRunRecord = {
    ...refreshed,
    resumed_by: spawned.id,
  };
  await writeBackgroundRunRecord(pmRoot, prior);
  return spawned;
}

/** Implements read background test run logs for the public runtime surface of this module. */
export async function readBackgroundTestRunLogs(
  pmRoot: string,
  runId: string,
  stream: BackgroundLogStream,
  tail: number | undefined,
): Promise<BackgroundRunLogsResult> {
  const loaded = await readBackgroundTestRunRecord(pmRoot, runId);
  if (!loaded) {
    throw new PmCliError(
      `Background test run ${runId} not found`,
      EXIT_CODE.NOT_FOUND,
    );
  }
  const resolvedTail =
    typeof tail === "number" && Number.isFinite(tail) && tail >= 0
      ? Math.floor(tail)
      : DEFAULT_BACKGROUND_RUN_LOG_TAIL_LINES;
  const stdoutRaw =
    stream === "stdout" || stream === "both"
      ? ((await readFileIfExists(loaded.stdout_path)) ?? "")
      : "";
  const stderrRaw =
    stream === "stderr" || stream === "both"
      ? ((await readFileIfExists(loaded.stderr_path)) ?? "")
      : "";
  return {
    run: loaded,
    stream,
    tail: resolvedTail,
    stdout:
      stream === "stdout" || stream === "both"
        ? tailLines(stdoutRaw, resolvedTail)
        : [],
    stderr:
      stream === "stderr" || stream === "both"
        ? tailLines(stderrRaw, resolvedTail)
        : [],
  };
}

/** Public contract for test only, shared by SDK and presentation-layer consumers. */
export const _testOnly = {
  buildResourceSnapshot,
  evaluateWorkerResult,
  isPidRunning,
  parseLinuxCpuStat,
  parseLinuxRssStatus,
  parseProgressLine,
  readLinuxCpuSeconds,
  readLinuxRssBytes,
  refreshRunIfStale,
  splitLines,
  tailLines,
};
