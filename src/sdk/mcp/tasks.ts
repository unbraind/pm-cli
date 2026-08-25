/**
 * @module sdk/mcp/tasks
 *
 * Provides a filesystem-backed, transport-neutral implementation of the
 * official `io.modelcontextprotocol/tasks` extension lifecycle.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  acquireLock,
  isFileMissingError,
  writeFileAtomic,
} from "../runtime-primitives.js";
import {
  PM_MCP_ERROR_CODES,
  PmMcpProtocolError,
  isMcpRecord,
  type PmMcpRequestContext,
} from "./protocol.js";
import {
  parseMcpInputRequests,
  parseMcpInputResponses,
  type PmMcpInputRequests,
  type PmMcpInputResponses,
} from "./interactions.js";

/** Standard identifier used to negotiate the official MCP tasks extension. */
export const PM_MCP_TASKS_EXTENSION = "io.modelcontextprotocol/tasks" as const;

/** Lifecycle states defined by the official MCP tasks extension. */
export const PM_MCP_TASK_STATUSES = [
  "working",
  "input_required",
  "completed",
  "failed",
  "cancelled",
] as const;

/** Current state of a durable MCP task. */
export type PmMcpTaskStatus = (typeof PM_MCP_TASK_STATUSES)[number];

/** JSON-RPC error retained by a failed task. */
export interface PmMcpTaskError {
  /** JSON-RPC or MCP error code. */
  code: number;
  /** Bounded human-readable failure summary. */
  message: string;
  /** Optional structured diagnostics. */
  data?: Record<string, unknown>;
}

/** Common public fields returned for every task state. */
export interface PmMcpTask {
  /** Stable server-minted task identifier. */
  taskId: string;
  /** Current extension lifecycle state. */
  status: PmMcpTaskStatus;
  /** Optional bounded human-readable state summary. */
  statusMessage?: string;
  /** ISO 8601 creation timestamp. */
  createdAt: string;
  /** ISO 8601 last mutation timestamp. */
  lastUpdatedAt: string;
  /** Milliseconds from creation before server retention may end. */
  ttlMs: number | null;
  /** Suggested client polling interval. */
  pollIntervalMs?: number;
  /** Additional forward-compatible extension fields. */
  [key: string]: unknown;
}

/** Detailed public task state returned by `tasks/get`. */
export type PmMcpDetailedTask =
  | (PmMcpTask & { status: "working" })
  | (PmMcpTask & {
      status: "input_required";
      inputRequests: PmMcpInputRequests;
    })
  | (PmMcpTask & { status: "completed"; result: Record<string, unknown> })
  | (PmMcpTask & { status: "failed"; error: PmMcpTaskError })
  | (PmMcpTask & { status: "cancelled" });

/** Task handle returned instead of a synchronous tool result. */
export type PmMcpCreateTaskResult = PmMcpTask & {
  /** Official extension result discriminator. */
  resultType: "task";
};

/** Construction options for one filesystem-backed task provider. */
export interface PmMcpTaskStoreOptions {
  /** Tracker root whose ignored runtime area owns task records. */
  pmRoot: string;
  /** Lock owner retained in diagnostics. */
  owner?: string;
  /** Deterministic clock seam used by conformance tests. */
  now?: () => Date;
  /** Deterministic task-id seam used by conformance tests. */
  taskIdFactory?: () => string;
  /** Process identifier used for restart recovery. */
  workerPid?: number;
}

interface StoredPmMcpTask extends PmMcpTask {
  version: 1;
  principal: string;
  workerPid: number;
  inputRequests?: PmMcpInputRequests;
  inputResponses?: PmMcpInputResponses;
  consumedInputKeys: string[];
  result?: Record<string, unknown>;
  error?: PmMcpTaskError;
}

const TASK_ID_PATTERN =
  /^mcp-task-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DEFAULT_TASK_TTL_MS = 60 * 60 * 1000;
const DEFAULT_TASK_POLL_INTERVAL_MS = 1000;
const MAX_STATUS_MESSAGE_LENGTH = 1024;
const TASK_LOCK_TTL_SECONDS = 30;
const TASK_LOCK_WAIT_MS = 2000;

function taskProtocolError(message: string): PmMcpProtocolError {
  return new PmMcpProtocolError(message, PM_MCP_ERROR_CODES.invalidParams, {
    code: "mcp_task_not_found_or_not_authorized",
  });
}

function validateTaskId(taskId: string): string {
  const normalized = taskId.trim();
  if (!TASK_ID_PATTERN.test(normalized)) {
    throw taskProtocolError("Unknown MCP task");
  }
  return normalized;
}

function parseTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new PmMcpProtocolError(
      "Corrupt MCP task record",
      PM_MCP_ERROR_CODES.invalidParams,
      { field },
    );
  }
  return value;
}

function parseTaskError(value: unknown): PmMcpTaskError {
  if (
    !isMcpRecord(value) ||
    typeof value.code !== "number" ||
    !Number.isFinite(value.code) ||
    typeof value.message !== "string"
  ) {
    throw new PmMcpProtocolError(
      "Corrupt MCP task error",
      PM_MCP_ERROR_CODES.invalidParams,
    );
  }
  return {
    code: value.code,
    message: value.message.slice(0, MAX_STATUS_MESSAGE_LENGTH),
    ...(isMcpRecord(value.data) ? { data: structuredClone(value.data) } : {}),
  };
}

function parseTaskStatus(value: unknown): PmMcpTaskStatus {
  if (!PM_MCP_TASK_STATUSES.includes(value as PmMcpTaskStatus)) {
    throw new PmMcpProtocolError(
      "Corrupt MCP task record",
      PM_MCP_ERROR_CODES.invalidParams,
    );
  }
  return value as PmMcpTaskStatus;
}

function parseTaskPrincipal(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new PmMcpProtocolError(
      "Corrupt MCP task record",
      PM_MCP_ERROR_CODES.invalidParams,
    );
  }
  return value;
}

function parseTaskWorkerPid(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new PmMcpProtocolError(
      "Corrupt MCP task record",
      PM_MCP_ERROR_CODES.invalidParams,
    );
  }
  return value;
}

function parseTaskTtl(value: unknown): number | null {
  if (
    value !== null &&
    (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
  ) {
    throw new PmMcpProtocolError(
      "Corrupt MCP task record",
      PM_MCP_ERROR_CODES.invalidParams,
    );
  }
  return value as number | null;
}

function parseTaskPollInterval(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new PmMcpProtocolError(
      "Corrupt MCP task record",
      PM_MCP_ERROR_CODES.invalidParams,
    );
  }
  return value;
}

function parseConsumedInputKeys(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string")
  ) {
    throw new PmMcpProtocolError(
      "Corrupt MCP task record",
      PM_MCP_ERROR_CODES.invalidParams,
    );
  }
  return [...value] as string[];
}

function parseStoredTask(value: unknown): StoredPmMcpTask {
  if (!isMcpRecord(value) || value.version !== 1) {
    throw new PmMcpProtocolError(
      "Corrupt MCP task record",
      PM_MCP_ERROR_CODES.invalidParams,
    );
  }
  const taskId =
    typeof value.taskId === "string" ? validateTaskId(value.taskId) : "";
  const status = parseTaskStatus(value.status);
  const principal = parseTaskPrincipal(value.principal);
  const workerPid = parseTaskWorkerPid(value.workerPid);
  const ttlMs = parseTaskTtl(value.ttlMs);
  const pollIntervalMs = parseTaskPollInterval(value.pollIntervalMs);
  const parsed: StoredPmMcpTask = {
    version: 1,
    taskId,
    status,
    principal,
    workerPid,
    createdAt: parseTimestamp(value.createdAt, "createdAt"),
    lastUpdatedAt: parseTimestamp(value.lastUpdatedAt, "lastUpdatedAt"),
    ttlMs,
    consumedInputKeys: parseConsumedInputKeys(value.consumedInputKeys),
    ...(typeof value.statusMessage === "string"
      ? {
          statusMessage: value.statusMessage.slice(
            0,
            MAX_STATUS_MESSAGE_LENGTH,
          ),
        }
      : {}),
    ...(typeof pollIntervalMs === "number" ? { pollIntervalMs } : {}),
  };
  if (isMcpRecord(value.inputRequests)) {
    parsed.inputRequests = structuredClone(
      value.inputRequests,
    ) as PmMcpInputRequests;
  }
  if (isMcpRecord(value.inputResponses)) {
    parsed.inputResponses = structuredClone(
      value.inputResponses,
    ) as PmMcpInputResponses;
  }
  if (isMcpRecord(value.result)) parsed.result = structuredClone(value.result);
  if (value.error !== undefined) parsed.error = parseTaskError(value.error);
  if (
    (parsed.status === "input_required" && !parsed.inputRequests) ||
    (parsed.status === "completed" && !parsed.result) ||
    (parsed.status === "failed" && !parsed.error)
  ) {
    throw new PmMcpProtocolError(
      "Corrupt MCP task status payload",
      PM_MCP_ERROR_CODES.invalidParams,
      { status: parsed.status },
    );
  }
  return parsed;
}

function publicTask(record: StoredPmMcpTask): PmMcpDetailedTask {
  const base: PmMcpTask = {
    taskId: record.taskId,
    status: record.status,
    createdAt: record.createdAt,
    lastUpdatedAt: record.lastUpdatedAt,
    ttlMs: record.ttlMs,
    ...(record.statusMessage ? { statusMessage: record.statusMessage } : {}),
    ...(record.pollIntervalMs === undefined
      ? {}
      : { pollIntervalMs: record.pollIntervalMs }),
  };
  if (record.status === "input_required") {
    return {
      ...base,
      status: "input_required",
      inputRequests: structuredClone(record.inputRequests!),
    };
  }
  if (record.status === "completed") {
    return {
      ...base,
      status: "completed",
      result: structuredClone(record.result!),
    };
  }
  if (record.status === "failed") {
    return {
      ...base,
      status: "failed",
      error: structuredClone(record.error!),
    };
  }
  return record.status === "cancelled"
    ? { ...base, status: "cancelled" }
    : { ...base, status: "working" };
}

function isTerminalTask(status: PmMcpTaskStatus): boolean {
  return (
    status === "completed" || status === "failed" || status === "cancelled"
  );
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return !(
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ESRCH"
    );
  }
}

/** Filesystem-backed provider for official MCP task methods and state changes. */
export class PmMcpTaskStore {
  readonly #pmRoot: string;
  readonly #owner: string;
  readonly #now: () => Date;
  readonly #taskIdFactory: () => string;
  readonly #workerPid: number;

  /** Create one task store scoped to a tracker runtime directory. */
  constructor(options: PmMcpTaskStoreOptions) {
    this.#pmRoot = path.resolve(options.pmRoot);
    this.#owner = options.owner?.trim() || "pm-mcp";
    this.#now = options.now ?? (() => new Date());
    this.#taskIdFactory =
      options.taskIdFactory ?? (() => `mcp-task-${randomUUID()}`);
    this.#workerPid = options.workerPid ?? process.pid;
  }

  #taskPath(taskId: string): string {
    return path.join(
      this.#pmRoot,
      "runtime",
      "mcp-tasks",
      "records",
      `${validateTaskId(taskId)}.json`,
    );
  }

  async #read(taskId: string): Promise<StoredPmMcpTask> {
    try {
      return parseStoredTask(
        JSON.parse(await readFile(this.#taskPath(taskId), "utf8")) as unknown,
      );
    } catch (error: unknown) {
      if (isFileMissingError(error) || error instanceof SyntaxError) {
        throw taskProtocolError("Unknown MCP task");
      }
      throw error;
    }
  }

  async #write(record: StoredPmMcpTask): Promise<void> {
    await writeFileAtomic(
      this.#taskPath(record.taskId),
      `${JSON.stringify(record, null, 2)}\n`,
    );
  }

  async #mutate(
    taskId: string,
    principal: string,
    mutation: (record: StoredPmMcpTask) => StoredPmMcpTask,
  ): Promise<StoredPmMcpTask> {
    const normalizedId = validateTaskId(taskId);
    const release = await acquireLock(
      this.#pmRoot,
      normalizedId,
      TASK_LOCK_TTL_SECONDS,
      this.#owner,
      false,
      false,
      TASK_LOCK_WAIT_MS,
    );
    try {
      const current = await this.#read(normalizedId);
      if (current.principal !== principal)
        throw taskProtocolError("Unknown MCP task");
      const next = mutation(current);
      await this.#write(next);
      return next;
    } finally {
      await release();
    }
  }

  /** Durably create a working task before returning its public handle. */
  async create(input: {
    principal: string;
    ttlMs?: number | null;
    pollIntervalMs?: number;
    statusMessage?: string;
  }): Promise<PmMcpCreateTaskResult> {
    const taskId = validateTaskId(this.#taskIdFactory());
    const principal = input.principal.trim();
    const ttlMs = input.ttlMs === undefined ? DEFAULT_TASK_TTL_MS : input.ttlMs;
    const pollIntervalMs =
      input.pollIntervalMs ?? DEFAULT_TASK_POLL_INTERVAL_MS;
    if (
      principal.length === 0 ||
      (ttlMs !== null && (!Number.isSafeInteger(ttlMs) || ttlMs < 0)) ||
      !Number.isSafeInteger(pollIntervalMs) ||
      pollIntervalMs < 0
    ) {
      throw new PmMcpProtocolError(
        "Invalid MCP task creation options",
        PM_MCP_ERROR_CODES.invalidParams,
      );
    }
    const timestamp = this.#now().toISOString();
    const record: StoredPmMcpTask = {
      version: 1,
      taskId,
      status: "working",
      createdAt: timestamp,
      lastUpdatedAt: timestamp,
      ttlMs,
      pollIntervalMs,
      principal,
      workerPid: this.#workerPid,
      consumedInputKeys: [],
      ...(input.statusMessage?.trim()
        ? {
            statusMessage: input.statusMessage
              .trim()
              .slice(0, MAX_STATUS_MESSAGE_LENGTH),
          }
        : {}),
    };
    await this.#write(record);
    return { ...publicTask(record), resultType: "task" };
  }

  /** Return authoritative task state, applying expiry and restart recovery. */
  async get(taskId: string, principal: string): Promise<PmMcpDetailedTask> {
    return publicTask(
      await this.#mutate(taskId, principal, (record) => {
        if (isTerminalTask(record.status)) return record;
        const nowMs = this.#now().getTime();
        const expired =
          record.ttlMs !== null &&
          Date.parse(record.createdAt) + record.ttlMs <= nowMs;
        const unavailableWorker =
          record.workerPid !== this.#workerPid &&
          !isProcessAlive(record.workerPid);
        if (!expired && !unavailableWorker) return record;
        return {
          ...record,
          status: "failed",
          statusMessage: expired
            ? "Task retention expired before completion."
            : "Task worker ended before recording a terminal result.",
          lastUpdatedAt: this.#now().toISOString(),
          error: {
            code: -32603,
            message: expired
              ? "MCP task expired"
              : "MCP task worker unavailable after restart",
            data: {
              recoverable: false,
              createNewTask: true,
            },
          },
          inputRequests: undefined,
        };
      }),
    );
  }

  /** Transition a nonterminal task to an MRTR input-required state. */
  async requireInput(input: {
    taskId: string;
    principal: string;
    requestContext: PmMcpRequestContext;
    inputRequests: unknown;
    statusMessage?: string;
  }): Promise<PmMcpDetailedTask> {
    const requests = parseMcpInputRequests(
      input.inputRequests,
      input.requestContext,
    );
    return publicTask(
      await this.#mutate(input.taskId, input.principal, (record) => {
        if (isTerminalTask(record.status)) return record;
        const reused = Object.keys(requests).filter((key) =>
          record.consumedInputKeys.includes(key),
        );
        if (reused.length > 0) {
          throw new PmMcpProtocolError(
            "MCP task input request keys must be unique for the task lifetime",
            PM_MCP_ERROR_CODES.invalidParams,
            { reused },
          );
        }
        return {
          ...record,
          status: "input_required",
          statusMessage: input.statusMessage
            ?.trim()
            .slice(0, MAX_STATUS_MESSAGE_LENGTH),
          lastUpdatedAt: this.#now().toISOString(),
          inputRequests: requests,
        };
      }),
    );
  }

  /** Accept outstanding task inputs, ignoring unknown and duplicate response keys. */
  async update(
    taskId: string,
    principal: string,
    inputResponses: unknown,
  ): Promise<{ acceptedKeys: string[]; remainingKeys: string[] }> {
    const responses = parseMcpInputResponses(inputResponses);
    const acceptedKeys: string[] = [];
    let remainingKeys: string[] = [];
    await this.#mutate(taskId, principal, (record) => {
      if (record.status !== "input_required" || !record.inputRequests) {
        return record;
      }
      const outstanding = { ...record.inputRequests };
      const accepted = record.inputResponses
        ? { ...record.inputResponses }
        : {};
      for (const [key, response] of Object.entries(responses)) {
        if (!Object.prototype.hasOwnProperty.call(outstanding, key)) continue;
        accepted[key] = response;
        delete outstanding[key];
        acceptedKeys.push(key);
      }
      remainingKeys = Object.keys(outstanding).sort();
      if (acceptedKeys.length === 0) return record;
      return {
        ...record,
        status: remainingKeys.length === 0 ? "working" : "input_required",
        lastUpdatedAt: this.#now().toISOString(),
        inputRequests: remainingKeys.length === 0 ? undefined : outstanding,
        inputResponses: accepted,
        consumedInputKeys: [
          ...new Set([...record.consumedInputKeys, ...acceptedKeys]),
        ].sort(),
      };
    });
    return { acceptedKeys: acceptedKeys.sort(), remainingKeys };
  }

  /** Retrieve and clear accepted task inputs for a resumed worker. */
  async takeInputResponses(
    taskId: string,
    principal: string,
  ): Promise<PmMcpInputResponses> {
    let responses: PmMcpInputResponses = {};
    await this.#mutate(taskId, principal, (record) => {
      responses = structuredClone(record.inputResponses ?? {});
      if (Object.keys(responses).length === 0) return record;
      return { ...record, inputResponses: undefined };
    });
    return responses;
  }

  /** Record one immutable successful terminal result. */
  async complete(
    taskId: string,
    principal: string,
    result: Record<string, unknown>,
  ): Promise<PmMcpDetailedTask> {
    return publicTask(
      await this.#mutate(taskId, principal, (record) =>
        isTerminalTask(record.status)
          ? record
          : {
              ...record,
              status: "completed",
              statusMessage: "Task completed.",
              lastUpdatedAt: this.#now().toISOString(),
              result: structuredClone(result),
              inputRequests: undefined,
              error: undefined,
            },
      ),
    );
  }

  /** Record one immutable JSON-RPC terminal failure. */
  async fail(
    taskId: string,
    principal: string,
    error: PmMcpTaskError,
  ): Promise<PmMcpDetailedTask> {
    const boundedError = parseTaskError(error);
    return publicTask(
      await this.#mutate(taskId, principal, (record) =>
        isTerminalTask(record.status)
          ? record
          : {
              ...record,
              status: "failed",
              statusMessage: boundedError.message,
              lastUpdatedAt: this.#now().toISOString(),
              error: boundedError,
              inputRequests: undefined,
              result: undefined,
            },
      ),
    );
  }

  /** Cooperatively cancel a nonterminal task and acknowledge terminal tasks idempotently. */
  async cancel(taskId: string, principal: string): Promise<PmMcpDetailedTask> {
    return publicTask(
      await this.#mutate(taskId, principal, (record) =>
        isTerminalTask(record.status)
          ? record
          : {
              ...record,
              status: "cancelled",
              statusMessage: "Task cancelled by the client.",
              lastUpdatedAt: this.#now().toISOString(),
              inputRequests: undefined,
              result: undefined,
              error: undefined,
            },
      ),
    );
  }
}

/** Build a filesystem-backed task provider for a tracker runtime root. */
export function createMcpTaskStore(
  options: PmMcpTaskStoreOptions,
): PmMcpTaskStore {
  return new PmMcpTaskStore(options);
}
