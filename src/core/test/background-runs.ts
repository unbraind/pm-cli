/**
 * @module core/test/background-runs
 *
 * Runs and records linked-test orchestration for Background Runs.
 */
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { ensureDir, pathExists, readFileIfExists, writeFileAtomic } from "../fs/fs-utils.js";
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

const BACKGROUND_RUN_ACTIVE_STATUSES = new Set<BackgroundTestRunStatus>(["queued", "running"]);
const BACKGROUND_RUN_TERMINAL_STATUSES = new Set<BackgroundTestRunStatus>(["passed", "failed", "stopped", "canceled"]);
const DEFAULT_BACKGROUND_RUN_RESOURCE_SNAPSHOT_INTERVAL_MS = 3000;
const DEFAULT_BACKGROUND_RUN_FORCE_KILL_DELAY_MS = 3000;
const DEFAULT_BACKGROUND_RUN_HEARTBEAT_STALE_MS = 30000;
const DEFAULT_BACKGROUND_RUN_LOG_TAIL_LINES = 100;
const PROC_STAT_TICKS_PER_SECOND = 100;

/**
 * Restricts background test run kind values accepted by command, SDK, and storage contracts.
 */
export type BackgroundTestRunKind = "test" | "test-all";

/**
 * Restricts background test run status values accepted by command, SDK, and storage contracts.
 */
export type BackgroundTestRunStatus = "queued" | "running" | "passed" | "failed" | "stopped" | "canceled";

/**
 * Restricts background log stream values accepted by command, SDK, and storage contracts.
 */
export type BackgroundLogStream = "stdout" | "stderr" | "both";

/**
 * Documents the background run progress payload exchanged by command, SDK, and package integrations.
 */
export interface BackgroundRunProgress {
  phase: "queued" | "running" | "stopping" | "finished";
  message?: string;
  item_index?: number;
  item_total?: number;
  item_id?: string;
  linked_test_index?: number;
  linked_test_total?: number;
  current_command?: string;
  elapsed_ms?: number;
  heartbeat_at?: string;
}

/**
 * Documents the background run resource snapshot payload exchanged by command, SDK, and package integrations.
 */
export interface BackgroundRunResourceSnapshot {
  recorded_at: string;
  rss_bytes?: number;
  cpu_user_seconds?: number;
  cpu_system_seconds?: number;
  uptime_seconds?: number;
}

/**
 * Documents the background run summary payload exchanged by command, SDK, and package integrations.
 */
export interface BackgroundRunSummary {
  items?: number;
  linked_tests?: number;
  passed: number;
  failed: number;
  skipped: number;
  fail_on_skipped_triggered?: boolean;
}

/**
 * Documents the background test run record payload exchanged by command, SDK, and package integrations.
 */
export interface BackgroundTestRunRecord {
  id: string;
  kind: BackgroundTestRunKind;
  status: BackgroundTestRunStatus;
  created_at: string;
  started_at?: string;
  finished_at?: string;
  updated_at: string;
  requested_by: string;
  fingerprint: string;
  command_args: string[];
  command_label: string;
  pm_root: string;
  global_pm_root: string;
  target_id?: string;
  status_filter?: string;
  attempt: number;
  resumed_from?: string;
  resumed_by?: string;
  worker_pid?: number;
  child_pid?: number;
  exit_code?: number;
  signal?: string;
  stdout_path: string;
  stderr_path: string;
  result_path: string;
  progress?: BackgroundRunProgress;
  resource?: BackgroundRunResourceSnapshot;
  summary?: BackgroundRunSummary;
  stop_requested_at?: string;
  duplicate_of?: string;
  error?: string;
}

/**
 * Documents the start background test run options payload exchanged by command, SDK, and package integrations.
 */
export interface StartBackgroundTestRunOptions {
  pmRoot: string;
  globalPmRoot: string;
  kind: BackgroundTestRunKind;
  commandArgs: string[];
  requestedBy: string;
  targetId?: string;
  statusFilter?: string;
  resumedFrom?: string;
  resumedBy?: string;
  attempt?: number;
}

/**
 * Documents the start background test run result payload exchanged by command, SDK, and package integrations.
 */
export interface StartBackgroundTestRunResult {
  started: boolean;
  run: BackgroundTestRunRecord;
  duplicate_of?: string;
}

/**
 * Documents the spawn background test run worker options payload exchanged by command, SDK, and package integrations.
 */
export interface SpawnBackgroundTestRunWorkerOptions {
  pmRoot: string;
  runId: string;
  noExtensions?: boolean;
}

/**
 * Documents the stop background test run result payload exchanged by command, SDK, and package integrations.
 */
export interface StopBackgroundTestRunResult {
  run: BackgroundTestRunRecord;
  signal_sent: "SIGTERM" | "SIGKILL" | "none";
}

/**
 * Documents the list background test run options payload exchanged by command, SDK, and package integrations.
 */
export interface ListBackgroundTestRunOptions {
  status?: BackgroundTestRunStatus;
  limit?: number;
}

/**
 * Documents the background run health payload exchanged by command, SDK, and package integrations.
 */
export interface BackgroundRunHealth {
  state: "healthy" | "stale" | "inactive";
  last_heartbeat_at?: string;
  heartbeat_lag_ms?: number;
  worker_alive: boolean;
  child_alive: boolean;
}

/**
 * Documents the background run status view payload exchanged by command, SDK, and package integrations.
 */
export interface BackgroundRunStatusView {
  run: BackgroundTestRunRecord;
  health: BackgroundRunHealth;
}

/**
 * Documents the background run logs result payload exchanged by command, SDK, and package integrations.
 */
export interface BackgroundRunLogsResult {
  run: BackgroundTestRunRecord;
  stream: BackgroundLogStream;
  tail: number;
  stdout: string[];
  stderr: string[];
}

interface WorkerEvaluationResult {
  summary: BackgroundRunSummary;
  parsedResult: unknown | null;
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

/**
 * Implements build background test run fingerprint for the public runtime surface of this module.
 */
export function buildBackgroundTestRunFingerprint(kind: BackgroundTestRunKind, commandArgs: string[], pmRoot: string): string {
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
    const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: string }).code : undefined;
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

async function parseBackgroundRunRecord(raw: string, recordPath: string): Promise<BackgroundTestRunRecord> {
  try {
    const parsed = JSON.parse(raw) as BackgroundTestRunRecord;
    if (!parsed || typeof parsed !== "object" || typeof parsed.id !== "string") {
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

async function writeBackgroundRunRecord(pmRoot: string, record: BackgroundTestRunRecord): Promise<void> {
  const next: BackgroundTestRunRecord = {
    ...record,
    updated_at: nowIso(),
  };
  await writeFileAtomic(getTestRunRecordPath(pmRoot, record.id), `${JSON.stringify(next, null, 2)}\n`);
}

/**
 * Implements read background test run record for the public runtime surface of this module.
 */
export async function readBackgroundTestRunRecord(pmRoot: string, runId: string): Promise<BackgroundTestRunRecord | null> {
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

function parseLinuxCpuStat(raw: string): { cpu_user_seconds?: number; cpu_system_seconds?: number } {
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
    return {};
  }
}

async function buildResourceSnapshot(record: BackgroundTestRunRecord): Promise<BackgroundRunResourceSnapshot | undefined> {
  const pid = record.child_pid ?? record.worker_pid;
  if (!isPidRunning(pid)) {
    return undefined;
  }
  const rssBytes = await readLinuxRssBytes(pid as number);
  const cpu = await readLinuxCpuSeconds(pid as number);
  const startedAtMs = record.started_at ? Date.parse(record.started_at) : Number.NaN;
  const uptimeSeconds = Number.isFinite(startedAtMs) ? Math.max(0, (nowMs() - startedAtMs) / 1000) : undefined;
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

function evaluateWorkerResult(kind: BackgroundTestRunKind, payload: unknown): WorkerEvaluationResult {
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
        linked_tests: typeof totals.linked_tests === "number" ? totals.linked_tests : undefined,
        passed: readCount(totals.passed),
        failed: readCount(totals.failed),
        skipped: readCount(totals.skipped),
        fail_on_skipped_triggered: record.fail_on_skipped_triggered === true ? true : undefined,
      },
      parsedResult: payload,
    };
  }
  const runResults = Array.isArray(record.run_results) ? record.run_results : [];
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
      fail_on_skipped_triggered: record.fail_on_skipped_triggered === true ? true : undefined,
    },
    parsedResult: payload,
  };
}

function parseProgressLine(stderrLine: string): Partial<BackgroundRunProgress> | null {
  const line = stderrLine.trim();
  if (line.length === 0) {
    return null;
  }
  const testAllMatch = line.match(/\[pm test-all\]\s+item\s+(\d+)\/(\d+)\s+(start|end)\s+id=([^\s]+)/i);
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
  const linkedTestMatch = line.match(/\[pm test\]\s+linked-test\s+(\d+)\/(\d+)\s+(start|running|end)(?:.*elapsed_ms=(\d+))?/i);
  if (!linkedTestMatch) {
    return null;
  }
  const index = Number.parseInt(linkedTestMatch[1], 10);
  const total = Number.parseInt(linkedTestMatch[2], 10);
  const elapsed = linkedTestMatch[4] ? Number.parseInt(linkedTestMatch[4], 10) : undefined;
  const commandMatch = line.match(/\scommand="((?:\\.|[^"\\])*)"/);
  const currentCommand = commandMatch?.[1].replaceAll('\\"', '"').replaceAll("\\\\", "\\");
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

async function refreshRunIfStale(pmRoot: string, record: BackgroundTestRunRecord): Promise<BackgroundTestRunRecord> {
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
    error: record.error ?? "Background test run worker exited before writing terminal status.",
  };
  await writeBackgroundRunRecord(pmRoot, next);
  return next;
}

/**
 * Implements start background test run for the public runtime surface of this module.
 */
export async function startBackgroundTestRun(options: StartBackgroundTestRunOptions): Promise<StartBackgroundTestRunResult> {
  await ensureBackgroundRunStorage(options.pmRoot);
  const normalizedArgs = normalizeCommandArgs(options.commandArgs);
  if (normalizedArgs.length === 0) {
    throw new PmCliError("Background test run requires command arguments.", EXIT_CODE.USAGE);
  }
  const fingerprint = buildBackgroundTestRunFingerprint(options.kind, normalizedArgs, options.pmRoot);
  const existingRuns = await listBackgroundTestRuns(options.pmRoot, {});
  for (const existing of existingRuns) {
    const refreshed = await refreshRunIfStale(options.pmRoot, existing);
    if (refreshed.fingerprint !== fingerprint) {
      continue;
    }
    if (!BACKGROUND_RUN_ACTIVE_STATUSES.has(refreshed.status) || !isPidRunning(refreshed.worker_pid)) {
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
    attempt: typeof options.attempt === "number" && Number.isFinite(options.attempt) && options.attempt >= 1
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

/**
 * Implements spawn background test run worker for the public runtime surface of this module.
 */
export async function spawnBackgroundTestRunWorker(options: SpawnBackgroundTestRunWorkerOptions): Promise<BackgroundTestRunRecord> {
  const record = await readBackgroundTestRunRecord(options.pmRoot, options.runId);
  if (!record) {
    throw new PmCliError(`Background test run ${options.runId} not found`, EXIT_CODE.NOT_FOUND);
  }
  if (BACKGROUND_RUN_TERMINAL_STATUSES.has(record.status)) {
    throw new PmCliError(`Background test run ${record.id} is already terminal (${record.status}).`, EXIT_CODE.CONFLICT);
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

async function appendFileOrdered(queue: Promise<void>, filePath: string, text: string): Promise<void> {
  await queue;
  await fs.appendFile(filePath, text, "utf8");
}

/**
 * Implements run background test run worker for the public runtime surface of this module.
 */
export async function runBackgroundTestRunWorker(pmRoot: string, runId: string, noExtensions = false): Promise<BackgroundTestRunRecord> {
  const loaded = await readBackgroundTestRunRecord(pmRoot, runId);
  if (!loaded) {
    throw new PmCliError(`Background test run ${runId} not found`, EXIT_CODE.NOT_FOUND);
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
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PM_PATH: record.pm_root,
    PM_GLOBAL_PATH: record.global_pm_root,
    FORCE_COLOR: "0",
  };
  await writeBackgroundRunRecord(pmRoot, record);

  const childArgs = noExtensions ? ["--no-extensions", ...record.command_args] : [...record.command_args];
  const child = spawn(process.execPath, [cliEntry, ...childArgs], {
    cwd: process.cwd(),
    env,
    detached: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  record.child_pid = child.pid as number | undefined;

  let writeQueue: Promise<void> = Promise.resolve();
  const scheduleRecordWrite = (): void => {
    writeQueue = writeQueue.then(async () => {
      try {
        await writeBackgroundRunRecord(pmRoot, record);
      } catch {
        // Keep worker alive even if a single metadata write fails.
      }
    });
  };

  let stdoutWriteQueue: Promise<void> = Promise.resolve();
  let stderrWriteQueue: Promise<void> = Promise.resolve();
  let stdoutBuffer = "";
  let stderrBuffer = "";
  let stopRequested = false;

  const requestStop = async (): Promise<void> => {
    if (stopRequested) {
      return;
    }
    stopRequested = true;
    record.stop_requested_at = nowIso();
    record.progress = {
      ...record.progress,
      phase: "stopping",
      message: "Stop requested for background run.",
      heartbeat_at: nowIso(),
    };
    scheduleRecordWrite();
    try {
      child.kill("SIGTERM");
    } catch {
      // Child may already be gone.
    }
    const forceKillDelayMs = Number.parseInt(process.env.PM_BACKGROUND_RUN_FORCE_KILL_DELAY_MS ?? "", 10);
    const delay = Number.isFinite(forceKillDelayMs) && forceKillDelayMs > 0
      ? forceKillDelayMs
      : DEFAULT_BACKGROUND_RUN_FORCE_KILL_DELAY_MS;
    const forceTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Child may already be gone.
      }
    }, delay);
    forceTimer.unref?.();
  };

  const onSignal = (): void => {
    void requestStop();
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  const resourceIntervalMs = Number.parseInt(process.env.PM_BACKGROUND_RUN_RESOURCE_INTERVAL_MS ?? "", 10);
  const resourceInterval = Number.isFinite(resourceIntervalMs) && resourceIntervalMs > 0
    ? resourceIntervalMs
    : DEFAULT_BACKGROUND_RUN_RESOURCE_SNAPSHOT_INTERVAL_MS;
  const resourceTimer = setInterval(() => {
    void (async () => {
      record.resource = await buildResourceSnapshot(record);
      (record.progress as BackgroundRunProgress).heartbeat_at = nowIso();
      scheduleRecordWrite();
    })();
  }, resourceInterval);
  resourceTimer.unref?.();

  child.stdout?.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    stdoutBuffer += text;
    stdoutWriteQueue = appendFileOrdered(stdoutWriteQueue, record.stdout_path, text);
  });

  const applyProgressLine = (line: string): boolean => {
    const progressPatch = parseProgressLine(line);
    if (!progressPatch) {
      return false;
    }
    if (progressPatch.item_id) {
      record.progress = {
        phase: (record.progress as BackgroundRunProgress).phase === "stopping" ? "stopping" : "running",
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
      return true;
    }
    record.progress = {
      phase: (record.progress as BackgroundRunProgress).phase === "stopping" ? "stopping" : "running",
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
    if (progressPatch.phase === "finished" && !stopRequested) {
      record.progress.phase = "running";
    }
    return true;
  };

  child.stderr?.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    stderrWriteQueue = appendFileOrdered(stderrWriteQueue, record.stderr_path, text);
    stderrBuffer += text;
    const parts = stderrBuffer.split(/\r?\n/);
    stderrBuffer = parts.pop()!;
    let progressChanged = false;
    for (const part of parts) {
      const line = part.trimEnd();
      if (line.length > 0 && applyProgressLine(line)) {
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
    ({ code: exitCode, signal } = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
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
  if (trailingStderrLine.length > 0 && applyProgressLine(trailingStderrLine)) {
    scheduleRecordWrite();
  }
  stderrBuffer = "";

  let parsedResult: unknown | null = null;
  if (stdoutBuffer.trim().length > 0) {
    try {
      parsedResult = JSON.parse(stdoutBuffer);
    } catch {
      parsedResult = null;
    }
  }
  const evaluated = evaluateWorkerResult(record.kind, parsedResult);
  record.summary = evaluated.summary;
  record.exit_code = typeof exitCode === "number" ? exitCode : undefined;
  record.signal = signal ?? undefined;
  record.finished_at = nowIso();
  record.status = stopRequested
    ? "stopped"
    : (record.exit_code === 0 &&
          (record.summary.failed ?? 0) === 0 &&
          record.summary.fail_on_skipped_triggered !== true)
      ? "passed"
      : "failed";
  record.progress = {
    phase: "finished",
    message: stopRequested ? "Background run stopped." : `Background run finished with status=${record.status}.`,
    heartbeat_at: nowIso(),
    item_index: record.progress?.item_index,
    item_total: record.progress?.item_total,
    item_id: record.progress?.item_id,
    linked_test_index: record.progress?.linked_test_index,
    linked_test_total: record.progress?.linked_test_total,
    current_command: record.progress?.current_command,
    elapsed_ms: record.progress?.elapsed_ms,
  };
  record.resource = await buildResourceSnapshot(record);
  if (parsedResult !== null) {
    await writeFileAtomic(record.result_path, `${JSON.stringify(parsedResult, null, 2)}\n`);
  } else {
    await writeFileAtomic(
      record.result_path,
      `${JSON.stringify(
        {
          parse_error: "Background run output was not valid JSON.",
          stdout_excerpt: tailLines(stdoutBuffer, DEFAULT_BACKGROUND_RUN_LOG_TAIL_LINES),
        },
        null,
        2,
      )}\n`,
    );
  }
  await writeBackgroundRunRecord(pmRoot, record);
  await writeQueue;
  return record;
}

/**
 * Implements list background test runs for the public runtime surface of this module.
 */
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
  const filtered = options.status ? refreshed.filter((entry) => entry.status === options.status) : refreshed;
  const sorted = filtered.sort((left, right) => {
    const byUpdated = Date.parse(right.updated_at) - Date.parse(left.updated_at);
    if (Number.isFinite(byUpdated) && byUpdated !== 0) {
      return byUpdated;
    }
    return right.id.localeCompare(left.id);
  });
  const limit = typeof options.limit === "number" && options.limit >= 0 ? options.limit : undefined;
  return limit === undefined ? sorted : sorted.slice(0, limit);
}

/**
 * Implements get background test run status for the public runtime surface of this module.
 */
export async function getBackgroundTestRunStatus(pmRoot: string, runId: string): Promise<BackgroundRunStatusView> {
  const loaded = await readBackgroundTestRunRecord(pmRoot, runId);
  if (!loaded) {
    throw new PmCliError(`Background test run ${runId} not found`, EXIT_CODE.NOT_FOUND);
  }
  const refreshed = await refreshRunIfStale(pmRoot, loaded);
  const workerAlive = isPidRunning(refreshed.worker_pid);
  const childAlive = isPidRunning(refreshed.child_pid);
  if (refreshed.status === "running" && !childAlive && !refreshed.finished_at && !workerAlive) {
    refreshed.status = "failed";
    refreshed.finished_at = nowIso();
    refreshed.error = refreshed.error ?? "Background run process exited unexpectedly.";
    await writeBackgroundRunRecord(pmRoot, refreshed);
  }
  if (refreshed.status === "running") {
    refreshed.resource = await buildResourceSnapshot(refreshed);
    await writeBackgroundRunRecord(pmRoot, refreshed);
  }
  const heartbeatAt = refreshed.progress?.heartbeat_at;
  const heartbeatAtMs = heartbeatAt ? Date.parse(heartbeatAt) : Number.NaN;
  const lagMs = Number.isFinite(heartbeatAtMs) ? Math.max(0, nowMs() - heartbeatAtMs) : undefined;
  const staleMs = Number.parseInt(process.env.PM_BACKGROUND_RUN_HEARTBEAT_STALE_MS ?? "", 10);
  const staleThresholdMs = Number.isFinite(staleMs) && staleMs > 0 ? staleMs : DEFAULT_BACKGROUND_RUN_HEARTBEAT_STALE_MS;
  const healthState = refreshed.status === "running"
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

/**
 * Implements stop background test run for the public runtime surface of this module.
 */
export async function stopBackgroundTestRun(pmRoot: string, runId: string, force = false): Promise<StopBackgroundTestRunResult> {
  const loaded = await readBackgroundTestRunRecord(pmRoot, runId);
  if (!loaded) {
    throw new PmCliError(`Background test run ${runId} not found`, EXIT_CODE.NOT_FOUND);
  }
  const refreshed = await refreshRunIfStale(pmRoot, loaded);
  if (BACKGROUND_RUN_TERMINAL_STATUSES.has(refreshed.status)) {
    return {
      run: refreshed,
      signal_sent: "none",
    };
  }
  let signalSent: "SIGTERM" | "SIGKILL" | "none" = "none";
  const signal: NodeJS.Signals = force ? "SIGKILL" : "SIGTERM";
  if (isPidRunning(refreshed.worker_pid) && refreshed.worker_pid) {
    try {
      process.kill(refreshed.worker_pid, signal);
      signalSent = signal;
    } catch {
      signalSent = "none";
    }
  }
  if (signalSent === "none") {
    refreshed.status = "stopped";
    refreshed.finished_at = refreshed.finished_at ?? nowIso();
  }
  refreshed.stop_requested_at = nowIso();
  refreshed.progress = {
    phase: "stopping",
    message: signalSent === "none" ? "Run marked stopped." : `Stop requested via ${signalSent}.`,
    heartbeat_at: nowIso(),
    item_index: refreshed.progress?.item_index,
    item_total: refreshed.progress?.item_total,
    item_id: refreshed.progress?.item_id,
    linked_test_index: refreshed.progress?.linked_test_index,
    linked_test_total: refreshed.progress?.linked_test_total,
    current_command: refreshed.progress?.current_command,
    elapsed_ms: refreshed.progress?.elapsed_ms,
  };
  await writeBackgroundRunRecord(pmRoot, refreshed);
  return {
    run: refreshed,
    signal_sent: signalSent,
  };
}

/**
 * Implements resume background test run for the public runtime surface of this module.
 */
export async function resumeBackgroundTestRun(
  pmRoot: string,
  runId: string,
  requestedBy: string,
  noExtensions = false,
): Promise<BackgroundTestRunRecord> {
  const loaded = await readBackgroundTestRunRecord(pmRoot, runId);
  if (!loaded) {
    throw new PmCliError(`Background test run ${runId} not found`, EXIT_CODE.NOT_FOUND);
  }
  const refreshed = await refreshRunIfStale(pmRoot, loaded);
  if (!BACKGROUND_RUN_TERMINAL_STATUSES.has(refreshed.status)) {
    throw new PmCliError(`Background test run ${runId} is not terminal and cannot be resumed.`, EXIT_CODE.CONFLICT);
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

/**
 * Implements read background test run logs for the public runtime surface of this module.
 */
export async function readBackgroundTestRunLogs(
  pmRoot: string,
  runId: string,
  stream: BackgroundLogStream,
  tail: number | undefined,
): Promise<BackgroundRunLogsResult> {
  const loaded = await readBackgroundTestRunRecord(pmRoot, runId);
  if (!loaded) {
    throw new PmCliError(`Background test run ${runId} not found`, EXIT_CODE.NOT_FOUND);
  }
  const resolvedTail = typeof tail === "number" && Number.isFinite(tail) && tail >= 0 ? Math.floor(tail) : DEFAULT_BACKGROUND_RUN_LOG_TAIL_LINES;
  const stdoutRaw = stream === "stdout" || stream === "both" ? (await readFileIfExists(loaded.stdout_path)) ?? "" : "";
  const stderrRaw = stream === "stderr" || stream === "both" ? (await readFileIfExists(loaded.stderr_path)) ?? "" : "";
  return {
    run: loaded,
    stream,
    tail: resolvedTail,
    stdout: stream === "stdout" || stream === "both" ? tailLines(stdoutRaw, resolvedTail) : [],
    stderr: stream === "stderr" || stream === "both" ? tailLines(stderrRaw, resolvedTail) : [],
  };
}

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
