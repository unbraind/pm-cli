/**
 * @module sdk/output-contracts
 *
 * Defines portable result-envelope contracts and safe mutation receipt parsing
 * for CLI, SDK, MCP, and package consumers.
 */
import { PM_CORE_COMMAND_NAMES } from "./cli-contracts/enum-contracts.js";
import {
  isPmSuccessfulExitCode,
  resolvePmCommandExitContract,
} from "./cli-contracts/command-exit-contracts.js";

/** Stable machine-readable result families used across pm transports. */
export const PM_OUTPUT_ENVELOPE_KINDS = [
  "mutation_receipt",
  "entity",
  "collection",
  "diagnostic",
  "stream",
] as const;

/** Restricts portable result-envelope families. */
export type PmOutputEnvelopeKind = (typeof PM_OUTPUT_ENVELOPE_KINDS)[number];

/** Stable schema version for replayable agent-task transcript corpora. */
export const PM_AGENT_TASK_TRANSCRIPT_VERSION = 1 as const;

/** Output family expected from one replayed agent-task step. */
export type PmAgentTaskStepOutputKind = PmOutputEnvelopeKind | "refusal";

/** Declares one real CLI invocation within a replayable agent task. */
export interface PmAgentTaskTranscriptStep {
  /** Stable step identifier unique within its task. */
  id: string;
  /** Shell-free CLI arguments, excluding the pm executable. */
  args: readonly string[];
  /** Process status required for the step to satisfy the transcript. */
  expected_exit_code: number;
  /** Semantic output family required from the transport. */
  expected_output_kind: PmAgentTaskStepOutputKind;
  /** Dot-separated own-property paths proving required context was consumed. */
  required_fields: readonly string[];
  /** Stable diagnostic code required from a refusal step. */
  expected_error_code?: string;
  /** Exact command or flag required in a refusal identity. */
  expected_refusal_surface?: string;
  /** Earlier refusal step whose recovery this successful step executes. */
  recovery_for?: string;
}

/** Versioned multi-step agent workflow suitable for deterministic replay. */
export interface PmAgentTaskTranscript {
  /** Stable task identifier used by baselines and reports. */
  id: string;
  /** Human-readable task outcome represented by the transcript. */
  description: string;
  /** Ordered invocations whose shared workspace state completes the task. */
  steps: readonly PmAgentTaskTranscriptStep[];
}

/** Published collection of replayable agent workflows. */
export interface PmAgentTaskTranscriptCorpus {
  /** Schema version governing every transcript in the corpus. */
  version: typeof PM_AGENT_TASK_TRANSCRIPT_VERSION;
  /** Complete ordered task set evaluated by the release gate. */
  tasks: readonly PmAgentTaskTranscript[];
}

/** Describes how one command exposes its default machine-readable result. */
export interface PmCommandOutputEnvelopeContract {
  /** Canonical command path. */
  command: string;
  /** Semantic result family. */
  kind: PmOutputEnvelopeKind;
  /** Root key carrying the primary value, or null for a flat receipt/stream. */
  wrapper_key: string | null;
  /** Whether the output can carry multiple primary rows. */
  cardinality: "one" | "many" | "none";
  /** Stable format-flag spelling accepted by every command. */
  format_flag: "--json";
}

/** Normalized SDK representation of the flat CLI mutation receipt. */
export interface PmMutationReceipt {
  /** Mutated item or plan identifier. */
  id: string;
  /** Resulting lifecycle status or deletion outcome. */
  status: string;
  /** Number of fields changed by the mutation. */
  changedFieldCount: number;
  /** Persisted close reason when the command closed work. */
  closeReason?: string;
  /** Whether a destructive mutation removed its target. */
  deleted?: boolean;
  /** Status before the mutation when the command reports it. */
  previousStatus?: string;
  /** Non-fatal mutation warnings retained by the transport. */
  warnings?: readonly unknown[];
}

/** Wire representation emitted by CLI mutation commands in JSON mode. */
export interface PmCliMutationReceipt {
  /** Mutated item or plan identifier. */
  id: string;
  /** Resulting lifecycle status or deletion outcome. */
  status: string;
  /** Number of fields changed by the mutation. */
  changed_field_count: number;
  /** Persisted close reason when the command closed work. */
  close_reason?: string;
  /** Whether a destructive mutation removed its target. */
  deleted?: boolean;
  /** Status before the mutation when the command reports it. */
  previous_status?: string;
  /** Non-fatal mutation warnings retained by the transport. */
  warnings?: readonly unknown[];
}

const MUTATION_COMMANDS = new Set([
  "append",
  "claim",
  "close",
  "close-task",
  "copy",
  "create",
  "delete",
  "focus",
  "pause-task",
  "release",
  "restore",
  "start-task",
  "update",
]);

const COLLECTION_MUTATION_COMMANDS = new Set(["close-many", "update-many"]);

const COLLECTION_COMMANDS = new Set([
  "activity",
  "comments",
  "contracts",
  "events",
  "history",
  "learnings",
  "list",
  "notes",
  "search",
]);

const DIAGNOSTIC_COMMANDS = new Set([
  "aggregate",
  "deps",
  "graph",
  "health",
  "stats",
  "validate",
]);

/** Validate and preserve one package-authored output-envelope declaration. */
export function definePmCommandOutputEnvelope<
  TContract extends PmCommandOutputEnvelopeContract,
>(contract: TContract): TContract {
  if (contract.command.trim().length === 0) {
    throw new TypeError("command must be a non-empty command path");
  }
  if (!PM_OUTPUT_ENVELOPE_KINDS.includes(contract.kind)) {
    throw new TypeError(`Unsupported output envelope kind: ${contract.kind}`);
  }
  return contract;
}

function createOutputEnvelopeContract(
  command: string,
): PmCommandOutputEnvelopeContract {
  const normalizedCommand = command.trim().replace(/\s+/gu, " ");
  const [rootCommand = normalizedCommand] = normalizedCommand.split(" ");
  if (COLLECTION_MUTATION_COMMANDS.has(rootCommand)) {
    return definePmCommandOutputEnvelope({
      command: normalizedCommand,
      kind: "collection",
      wrapper_key: "rows",
      cardinality: "many",
      format_flag: "--json",
    });
  }
  if (MUTATION_COMMANDS.has(rootCommand)) {
    return definePmCommandOutputEnvelope({
      command: normalizedCommand,
      kind: "mutation_receipt",
      wrapper_key: null,
      cardinality: "one",
      format_flag: "--json",
    });
  }
  if (COLLECTION_COMMANDS.has(rootCommand)) {
    return definePmCommandOutputEnvelope({
      command: normalizedCommand,
      kind: "collection",
      wrapper_key: rootCommand === "contracts" ? null : "items",
      cardinality: "many",
      format_flag: "--json",
    });
  }
  if (DIAGNOSTIC_COMMANDS.has(rootCommand)) {
    return definePmCommandOutputEnvelope({
      command: normalizedCommand,
      kind: "diagnostic",
      wrapper_key: null,
      cardinality: "none",
      format_flag: "--json",
    });
  }
  return definePmCommandOutputEnvelope({
    command: normalizedCommand,
    kind: rootCommand === "get" ? "entity" : "diagnostic",
    wrapper_key: rootCommand === "get" ? "item" : null,
    cardinality: rootCommand === "get" ? "one" : "none",
    format_flag: "--json",
  });
}

/** Default envelope declaration for every built-in command. */
export const PM_COMMAND_OUTPUT_ENVELOPE_CONTRACTS = PM_CORE_COMMAND_NAMES.map(
  (command) => createOutputEnvelopeContract(command),
);

const OUTPUT_ENVELOPE_BY_COMMAND = new Map(
  PM_COMMAND_OUTPUT_ENVELOPE_CONTRACTS.map(
    (contract) => [contract.command, contract] as const,
  ),
);

/** Resolve a built-in envelope or generate a conservative package fallback. */
export function resolvePmCommandOutputEnvelope(
  command: string,
): PmCommandOutputEnvelopeContract {
  const normalized = command.trim().replace(/\s+/gu, " ");
  if (normalized.length === 0) {
    throw new TypeError("command must be a non-empty command path");
  }
  const [rootCommand = normalized] = normalized.split(" ");
  const declared = OUTPUT_ENVELOPE_BY_COMMAND.get(rootCommand);
  return declared
    ? { ...declared, command: normalized }
    : createOutputEnvelopeContract(normalized);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readTranscriptString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function readTranscriptStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`${field} must be a non-empty string array`);
  }
  return value.map((entry, index) =>
    readTranscriptString(entry, `${field}[${String(index)}]`),
  );
}

function readOptionalTranscriptString(
  value: unknown,
  field: string,
): string | undefined {
  return value === undefined ? undefined : readTranscriptString(value, field);
}

function assertTranscriptStepOutputContract(
  field: string,
  args: readonly string[],
  exitCode: number,
  outputKind: PmAgentTaskStepOutputKind,
  errorCode: string | undefined,
  refusalSurface: string | undefined,
): void {
  if (outputKind === "refusal") {
    if (
      isPmSuccessfulExitCode(exitCode) ||
      errorCode === undefined ||
      refusalSurface === undefined
    ) {
      throw new TypeError(
        `${field} refusal steps require a non-success exit, error code, and refusal surface`,
      );
    }
    return;
  }
  if (errorCode !== undefined || refusalSurface !== undefined) {
    throw new TypeError(
      `${field} only refusal steps may declare expected_error_code or expected_refusal_surface`,
    );
  }
  const exitContract = resolvePmCommandExitContract(args[0]);
  if (
    !isPmSuccessfulExitCode(exitCode) ||
    (exitCode !== 0 &&
      !exitContract?.exit_codes.some(
        (declaredExitCode) => declaredExitCode === exitCode,
      ))
  ) {
    throw new TypeError(
      `${field} successful output must use exit code 0 or a command-declared successful effect exit`,
    );
  }
  const declaredKind = resolvePmCommandOutputEnvelope(args[0]).kind;
  if (outputKind !== declaredKind) {
    throw new TypeError(
      `${field} expected ${outputKind}, but ${args[0]} declares ${declaredKind}`,
    );
  }
}

function parseAgentTaskTranscriptStep(
  value: unknown,
  taskId: string,
  index: number,
): PmAgentTaskTranscriptStep {
  if (!isRecord(value)) {
    throw new TypeError(
      `tasks.${taskId}.steps[${String(index)}] must be an object`,
    );
  }
  const field = `tasks.${taskId}.steps[${String(index)}]`;
  const id = readTranscriptString(value.id, `${field}.id`);
  const args = readTranscriptStringArray(value.args, `${field}.args`);
  const expectedExitCode = value.expected_exit_code;
  if (
    typeof expectedExitCode !== "number" ||
    !Number.isSafeInteger(expectedExitCode)
  ) {
    throw new TypeError(`${field}.expected_exit_code must be a safe integer`);
  }
  const rawOutputKind = value.expected_output_kind;
  if (
    rawOutputKind !== "refusal" &&
    !PM_OUTPUT_ENVELOPE_KINDS.includes(rawOutputKind as PmOutputEnvelopeKind)
  ) {
    throw new TypeError(`${field}.expected_output_kind is unsupported`);
  }
  const expectedOutputKind = rawOutputKind as PmAgentTaskStepOutputKind;
  const requiredFields = readTranscriptStringArray(
    value.required_fields,
    `${field}.required_fields`,
  );
  if (
    requiredFields.some((requiredField) =>
      requiredField.split(".").some((segment) => segment.length === 0),
    )
  ) {
    throw new TypeError(
      `${field}.required_fields must contain dot-separated own-property paths`,
    );
  }
  const expectedErrorCode = readOptionalTranscriptString(
    value.expected_error_code,
    `${field}.expected_error_code`,
  );
  const expectedRefusalSurface = readOptionalTranscriptString(
    value.expected_refusal_surface,
    `${field}.expected_refusal_surface`,
  );
  const recoveryFor = readOptionalTranscriptString(
    value.recovery_for,
    `${field}.recovery_for`,
  );
  assertTranscriptStepOutputContract(
    field,
    args,
    expectedExitCode,
    expectedOutputKind,
    expectedErrorCode,
    expectedRefusalSurface,
  );
  return {
    id,
    args,
    expected_exit_code: expectedExitCode,
    expected_output_kind: expectedOutputKind,
    required_fields: requiredFields,
    ...(expectedErrorCode ? { expected_error_code: expectedErrorCode } : {}),
    ...(expectedRefusalSurface
      ? { expected_refusal_surface: expectedRefusalSurface }
      : {}),
    ...(recoveryFor ? { recovery_for: recoveryFor } : {}),
  };
}

function parseAgentTaskTranscript(
  value: unknown,
  index: number,
): PmAgentTaskTranscript {
  if (!isRecord(value)) {
    throw new TypeError(`tasks[${String(index)}] must be an object`);
  }
  const id = readTranscriptString(value.id, `tasks[${String(index)}].id`);
  const description = readTranscriptString(
    value.description,
    `tasks.${id}.description`,
  );
  if (!Array.isArray(value.steps) || value.steps.length === 0) {
    throw new TypeError(`tasks.${id}.steps must be a non-empty array`);
  }
  const steps = value.steps.map((step, stepIndex) =>
    parseAgentTaskTranscriptStep(step, id, stepIndex),
  );
  const priorSteps = new Map<string, PmAgentTaskTranscriptStep>();
  for (const step of steps) {
    if (priorSteps.has(step.id)) {
      throw new TypeError(`tasks.${id} contains duplicate step id ${step.id}`);
    }
    if (step.recovery_for !== undefined) {
      const refusal = priorSteps.get(step.recovery_for);
      if (
        refusal?.expected_output_kind !== "refusal" ||
        step.expected_output_kind === "refusal"
      ) {
        throw new TypeError(
          `tasks.${id}.${step.id} recovery_for must reference an earlier refusal and declare successful output`,
        );
      }
    }
    priorSteps.set(step.id, step);
  }
  if (steps.at(-1)?.expected_output_kind === "refusal") {
    throw new TypeError(
      `tasks.${id} completed task must terminate with successful output`,
    );
  }
  return { id, description, steps };
}

/** Parse and fail closed on malformed or internally inconsistent transcripts. */
export function parsePmAgentTaskTranscriptCorpus(
  value: unknown,
): PmAgentTaskTranscriptCorpus {
  if (!isRecord(value)) {
    throw new TypeError("agent-task transcript corpus must be an object");
  }
  if (value.version !== PM_AGENT_TASK_TRANSCRIPT_VERSION) {
    throw new TypeError(
      `agent-task transcript corpus version must be ${String(PM_AGENT_TASK_TRANSCRIPT_VERSION)}`,
    );
  }
  if (!Array.isArray(value.tasks) || value.tasks.length === 0) {
    throw new TypeError("agent-task transcript corpus tasks must be non-empty");
  }
  const tasks = value.tasks.map((task, index) =>
    parseAgentTaskTranscript(task, index),
  );
  const taskIds = new Set<string>();
  for (const task of tasks) {
    if (taskIds.has(task.id)) {
      throw new TypeError(`duplicate agent-task transcript id ${task.id}`);
    }
    taskIds.add(task.id);
  }
  return { version: PM_AGENT_TASK_TRANSCRIPT_VERSION, tasks };
}

/** Return whether an unknown value is the flat CLI mutation receipt shape. */
export function isPmMutationReceipt(
  value: unknown,
): value is PmCliMutationReceipt {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.status === "string" &&
    value.status.length > 0 &&
    Number.isSafeInteger(value.changed_field_count) &&
    Number(value.changed_field_count) >= 0 &&
    (value.close_reason === undefined ||
      typeof value.close_reason === "string") &&
    (value.deleted === undefined || typeof value.deleted === "boolean") &&
    (value.previous_status === undefined ||
      typeof value.previous_status === "string") &&
    (value.warnings === undefined || Array.isArray(value.warnings))
  );
}

/**
 * Parse and normalize the flat JSON receipt emitted by mutation commands.
 * Wrapped read envelopes are rejected so a wrong consumer assumption fails at
 * the integration boundary instead of silently returning an undefined id.
 */
export function parseMutationReceipt(json: string): PmMutationReceipt;
/** Parse and normalize an already decoded mutation receipt value. */
export function parseMutationReceipt(value: unknown): PmMutationReceipt;
/** Implement string parsing and decoded-value validation at one boundary. */
export function parseMutationReceipt(input: unknown): PmMutationReceipt {
  let value: unknown = input;
  if (typeof input === "string") {
    try {
      value = JSON.parse(input);
    } catch (error) {
      throw new TypeError(
        `Mutation receipt must be valid JSON: ${String(error)}`,
        { cause: error },
      );
    }
  }
  if (!isPmMutationReceipt(value)) {
    throw new TypeError(
      "Mutation receipt must be a flat object with top-level id, status, and changed_field_count fields",
    );
  }
  return {
    id: value.id,
    status: value.status,
    changedFieldCount: value.changed_field_count,
    ...(typeof value.close_reason === "string"
      ? { closeReason: value.close_reason }
      : {}),
    ...(typeof value.deleted === "boolean" ? { deleted: value.deleted } : {}),
    ...(typeof value.previous_status === "string"
      ? { previousStatus: value.previous_status }
      : {}),
    ...(Array.isArray(value.warnings) ? { warnings: value.warnings } : {}),
  };
}
