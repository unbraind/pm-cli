/**
 * @module sdk/agent-task-transcript-contracts
 *
 * Defines and validates replayable agent-task transcripts without adding the
 * SDK-only parser to ordinary CLI command bundles.
 */
import {
  isPmSuccessfulExitCode,
  resolvePmCommandExitContract,
} from "../cli-contracts/command-exit-contracts.js";
import { parseBootstrapCommandName } from "../cli-contracts/bootstrap-command-scanner.js";
import {
  PM_OUTPUT_ENVELOPE_KINDS,
  resolvePmCommandOutputEnvelope,
  type PmOutputEnvelopeKind,
} from "../output-contracts.js";

/** Stable schema version for replayable agent-task transcript corpora. */
export const PM_AGENT_TASK_TRANSCRIPT_VERSION = 2 as const;

/** Supported strategies for measuring one transcript step's output cost. */
export const PM_AGENT_TASK_ACCOUNTING_MODES = [
  "self_reported",
  "independent_transport",
] as const;

/** Token-accounting strategy a replayed transcript step must preserve. */
export type PmAgentTaskAccountingMode =
  (typeof PM_AGENT_TASK_ACCOUNTING_MODES)[number];

/** Scalar value that a replayed transcript must observe at one output path. */
export type PmAgentTaskExpectedFieldValue = string | number | boolean | null;

/** Output family expected from one replayed agent-task step. */
export type PmAgentTaskStepOutputKind = PmOutputEnvelopeKind | "refusal";

/** Declares one real CLI invocation within a replayable agent task. */
export interface PmAgentTaskTranscriptStep {
  /** Stable step identifier unique within its task. */
  id: string;
  /** Shell-free CLI arguments, excluding the pm executable, preserved exactly. */
  args: readonly string[];
  /** Process status required for the step to satisfy the transcript. */
  expected_exit_code: number;
  /** Semantic output family required from the transport. */
  expected_output_kind: PmAgentTaskStepOutputKind;
  /** Accounting strategy required from the measured transport. */
  expected_accounting_mode: PmAgentTaskAccountingMode;
  /** Dot-separated own-property paths proving required context was consumed. */
  required_fields: readonly string[];
  /** Exact terminal scalar values required at selected output paths. */
  expected_field_values?: Readonly<
    Record<string, PmAgentTaskExpectedFieldValue>
  >;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readTranscriptString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function readTranscriptStringArray(
  value: unknown,
  field: string,
  preserveWhitespace = false,
): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`${field} must be a non-empty string array`);
  }
  return value.map((entry, index) => {
    const normalized = readTranscriptString(
      entry,
      `${field}[${String(index)}]`,
    );
    return preserveWhitespace ? (entry as string) : normalized;
  });
}

function readOptionalTranscriptString(
  value: unknown,
  field: string,
): string | undefined {
  return value === undefined ? undefined : readTranscriptString(value, field);
}

function readExpectedFieldValues(
  value: unknown,
  field: string,
): Record<string, PmAgentTaskExpectedFieldValue> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || Object.keys(value).length === 0) {
    throw new TypeError(`${field} must be a non-empty object`);
  }
  const entries = Object.entries(value).map(([path, expectedValue]) => {
    if (
      path.length === 0 ||
      path.split(".").some((segment) => segment.length === 0)
    ) {
      throw new TypeError(`${field} must use dot-separated own-property paths`);
    }
    if (
      expectedValue !== null &&
      typeof expectedValue !== "string" &&
      typeof expectedValue !== "boolean" &&
      (typeof expectedValue !== "number" || !Number.isFinite(expectedValue))
    ) {
      throw new TypeError(`${field} values must be JSON primitives`);
    }
    return [path, expectedValue] as const;
  });
  return Object.fromEntries(entries);
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
  const command = parseBootstrapCommandName(args);
  if (command === undefined) {
    throw new TypeError(
      `${field}.args must identify a command after global flags`,
    );
  }
  const exitContract = resolvePmCommandExitContract(command);
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
  const declaredKind = resolvePmCommandOutputEnvelope(command).kind;
  if (outputKind !== declaredKind) {
    throw new TypeError(
      `${field} expected ${outputKind}, but ${command} declares ${declaredKind}`,
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
  const args = readTranscriptStringArray(value.args, `${field}.args`, true);
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
  const rawAccountingMode = value.expected_accounting_mode;
  if (
    !PM_AGENT_TASK_ACCOUNTING_MODES.includes(
      rawAccountingMode as PmAgentTaskAccountingMode,
    )
  ) {
    throw new TypeError(`${field}.expected_accounting_mode is unsupported`);
  }
  const expectedAccountingMode = rawAccountingMode as PmAgentTaskAccountingMode;
  if (
    expectedAccountingMode === "independent_transport" &&
    expectedOutputKind !== "refusal"
  ) {
    throw new TypeError(
      `${field} independent_transport accounting is supported only for refusal steps`,
    );
  }
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
  const expectedFieldValues = readExpectedFieldValues(
    value.expected_field_values,
    `${field}.expected_field_values`,
  );
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
    expected_accounting_mode: expectedAccountingMode,
    required_fields: requiredFields,
    ...(expectedFieldValues
      ? { expected_field_values: expectedFieldValues }
      : {}),
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
  for (const step of steps) {
    if (
      step.expected_output_kind === "refusal" &&
      !steps.some((candidate) => candidate.recovery_for === step.id)
    ) {
      throw new TypeError(
        `tasks.${id}.${step.id} refusal must have a later successful recovery_for step`,
      );
    }
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
