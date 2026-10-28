/**
 * @module sdk/workspace-transaction
 *
 * Coordinates crash-recoverable, compensating transactions across public SDK
 * mutation primitives without rewriting immutable item or relationship history.
 */
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { appendWorkspaceAuditEvent, getWorkspaceHistoryPath, WORKSPACE_HISTORY_ID } from "../core/history/workspace-history.js";
import { readHistoryEntries } from "./history-read.js";
import { acquireLock } from "../core/lock/lock.js";
import { isFileMissingError, writeFileAtomic } from "../core/fs/fs-utils.js";
import { nowIso } from "../core/shared/time.js";
import { EXIT_CODE } from "../core/shared/constants.js";
import { PmCliError } from "../core/shared/errors.js";

/** Durable state reported by a transaction step inspection. */
export type WorkspaceTransactionStepState =
  | "pending"
  | "applied"
  | "compensated";

/** JSON-compatible values retained in the durable transaction journal. */
export type WorkspaceTransactionJsonValue =
  | null
  | boolean
  | number
  | string
  | WorkspaceTransactionJsonValue[]
  | { [key: string]: WorkspaceTransactionJsonValue };

/** Result returned by a step inspection during replay or recovery. */
export interface WorkspaceTransactionStepInspection {
  /** Current durable state of the step's domain mutation. */
  state: WorkspaceTransactionStepState;
  /** Reconstructed result when the mutation is already applied. */
  result?: WorkspaceTransactionJsonValue;
}

/** One idempotent forward mutation with an append-only compensation. */
export interface WorkspaceTransactionStep {
  /** Stable identifier unique within the transaction plan. */
  id: string;
  /** Inspect durable domain state without mutating it. */
  inspect(): Promise<WorkspaceTransactionStepInspection>;
  /** Capture journal-safe pre-mutation data required by compensation. */
  prepareCompensation?(): Promise<WorkspaceTransactionJsonValue | undefined>;
  /** Opt in when compensation can reconcile partial apply effects still inspected as pending. */
  compensatePending?: boolean;
  /** Apply the forward mutation and return a journal-safe result, or store nothing. */
  apply(): Promise<WorkspaceTransactionJsonValue | undefined>;
  /** Idempotently reconcile this step's effects; opt-in adapters also handle pending partial apply failures. */
  compensate(data?: WorkspaceTransactionJsonValue): Promise<void>;
}

/** Observable transition points available to diagnostics and failure injection. */
export type WorkspaceTransactionTransition =
  | "prepared"
  | "step_applied"
  | "step_recorded"
  | "committing"
  | "committed"
  | "compensating"
  | "step_compensating"
  | "step_compensated"
  | "compensated";

/** Context emitted at each transaction transition. */
export interface WorkspaceTransactionTransitionContext {
  /** Stable transaction identifier. */
  transactionId: string;
  /** Current durable transaction attempt. */
  attempt: number;
  /** Transition reached; `step_applied` follows mutation and precedes journal recording. */
  transition: WorkspaceTransactionTransition;
  /** Step associated with a step-level transition. */
  stepId?: string;
}

/** Options accepted by the public workspace transaction coordinator. */
export interface CommitWorkspaceTransactionOptions {
  /** Tracker root that owns the journal and workspace-wide writer lock. */
  pmRoot: string;
  /** Stable idempotency key reused to recover an interrupted transaction. */
  transactionId: string;
  /** Attributable actor recorded in the durable journal. */
  author: string;
  /** Ordered idempotent mutations; compensations run in reverse order. */
  steps: readonly WorkspaceTransactionStep[];
  /** JSON plan retained for adapter-owned recovery; callers must not store secrets. */
  recoveryData?: WorkspaceTransactionJsonValue;
  /** Lock lifetime in seconds; size this above the longest expected attempt. */
  lockTtlSeconds?: number;
  /** Maximum time to wait for the workspace writer lock. */
  lockWaitMs?: number;
  /** Optional transition observer used by telemetry and deterministic crash tests. */
  onTransition?(
    context: WorkspaceTransactionTransitionContext,
  ): void | Promise<void>;
}

/** Successful durable transaction result. */
export interface WorkspaceTransactionCommitResult {
  /** Stable transaction identifier. */
  transactionId: string;
  /** Final durable state. */
  status: "committed";
  /** Whether an interrupted journal was resumed. */
  recovered: boolean;
  /** One result per ordered transaction step. */
  results: Record<string, WorkspaceTransactionJsonValue>;
}

/**
 * Deliberate process-boundary interruption used by deterministic crash tests.
 * Throwing this from `onTransition` leaves the journal resumable and skips the
 * normal in-process compensation path.
 */
export class WorkspaceTransactionInterruptedError extends Error {
  /** Create one explicit crash-boundary interruption. */
  public constructor(message = "Workspace transaction interrupted") {
    super(message);
    this.name = "WorkspaceTransactionInterruptedError";
  }
}

/** Durable coordinator lifecycle, including explicitly retired identities. */
export type WorkspaceTransactionJournalStatus =
  | "applying"
  | "compensating"
  | "compensated"
  | "committed"
  | "abandoned";

/** Durable coordinator receipt; step lists describe journaled progress, not a fresh domain inspection. */
export interface WorkspaceTransactionJournal {
  /** Version 2 fences older coordinators once explicit retirement begins. */
  schemaVersion: 1 | 2;
  /** Stable transaction identity. */
  transactionId: string;
  /** Actor who prepared the attempt. */
  author: string;
  /** Last durable lifecycle state. */
  status: WorkspaceTransactionJournalStatus;
  /** One-based attempt number. */
  attempt: number;
  /** Initial preparation timestamp. */
  createdAt: string;
  /** Latest journal write timestamp. */
  updatedAt: string;
  /** Ordered payload-bound step identifiers. */
  stepIds: string[];
  /** Steps durably admitted before forward execution. */
  startedStepIds: string[];
  /** Steps recorded as applied. */
  completedStepIds: string[];
  /** Recorded results for completed steps. */
  results: Record<string, WorkspaceTransactionJsonValue>;
  /** Captured pre-write recovery receipts. */
  compensationData: Record<string, WorkspaceTransactionJsonValue>;
  /** Adapter-owned original plan, absent in legacy journals. */
  recoveryData?: WorkspaceTransactionJsonValue;
  /** Explicit retirement rationale and optional replacement identity. */
  abandonment?: { reason: string; author: string; supersededBy?: string };
}

const WORKSPACE_TRANSACTION_LOCK_ID = "sdk-workspace-transaction";
const TRANSACTION_ID_PATTERN = /^[a-zA-Z0-9._-]+$/;
const DEFAULT_LOCK_TTL_SECONDS = 30;
const DEFAULT_LOCK_WAIT_MS = 3_000;

function requiredIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string")
    throw new TypeError(`${label} must be a string`);
  const normalized = value.trim();
  if (!normalized || !TRANSACTION_ID_PATTERN.test(normalized))
    throw new TypeError(`${label} must match [a-zA-Z0-9._-]+`);
  return normalized;
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string")
    throw new TypeError(`${label} must be a string`);
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${label} must be non-empty`);
  return normalized;
}

/** Validate transaction identity before preview staging or acquiring any writer lock. */
export function validateWorkspaceTransactionIdentity(options: Pick<CommitWorkspaceTransactionOptions, "pmRoot" | "transactionId" | "author">): Pick<CommitWorkspaceTransactionOptions, "pmRoot" | "transactionId" | "author"> {
  return {
    pmRoot: requiredText(options.pmRoot, "Transaction pmRoot"),
    transactionId: requiredIdentifier(options.transactionId, "Transaction id"),
    author: requiredText(options.author, "Transaction author"),
  };
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  label: string,
) {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved <= 0)
    throw new TypeError(`${label} must be a positive integer`);
  return resolved;
}

function journalPath(pmRoot: string, transactionId: string): string {
  return path.join(pmRoot, "transactions", "sdk", `${transactionId}.json`);
}

async function writeJournal(
  pmRoot: string,
  journal: WorkspaceTransactionJournal,
): Promise<void> {
  journal.updatedAt = nowIso();
  const target = journalPath(pmRoot, journal.transactionId);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFileAtomic(target, `${JSON.stringify(journal, null, 2)}\n`);
}

/** Require attributable attempt metadata and a retirement receipt consistent with its schema version. */
function hasValidJournalMetadata(
  journal: Partial<WorkspaceTransactionJournal>,
): boolean {
  return (
    Number.isInteger(journal.attempt) &&
    typeof journal.author === "string" &&
    typeof journal.createdAt === "string" &&
    typeof journal.updatedAt === "string" &&
    hasValidAbandonment(journal)
  );
}

/** Retirement requests remain valid through interrupted compensation and fence forward replay. */
function hasValidAbandonment(journal: Partial<WorkspaceTransactionJournal>): boolean {
  const retirement = journal.abandonment;
  if (retirement === undefined) return journal.schemaVersion === 1 && journal.status !== "abandoned";
  if (journal.schemaVersion !== 2 || retirement === null || typeof retirement !== "object" || journal.status === "committed") return false;
  return typeof retirement.reason === "string" && retirement.reason.trim().length > 0 &&
    typeof retirement.author === "string" && retirement.author.trim().length > 0 &&
    (retirement.supersededBy === undefined || (typeof retirement.supersededBy === "string" && TRANSACTION_ID_PATTERN.test(retirement.supersededBy) && retirement.supersededBy !== journal.transactionId));
}

function createResultMap(
  source?: Record<string, WorkspaceTransactionJsonValue>,
): Record<string, WorkspaceTransactionJsonValue> {
  return Object.assign(
    Object.create(null) as Record<string, WorkspaceTransactionJsonValue>,
    source,
  );
}

function cloneJournalValue(
  value: unknown,
  label: string,
): WorkspaceTransactionJsonValue {
  try {
    const serialized = JSON.stringify(value, (_key, nestedValue: unknown) => {
      if (typeof nestedValue === "number" && !Number.isFinite(nestedValue))
        throw new TypeError(`${label} contains a non-finite number`);
      if (
        nestedValue === undefined ||
        typeof nestedValue === "function" ||
        typeof nestedValue === "symbol"
      )
        throw new TypeError(`${label} contains a non-JSON value`);
      return nestedValue;
    }) as string;
    return JSON.parse(serialized) as WorkspaceTransactionJsonValue;
  } catch (error) {
    throw new TypeError(`${label} must be JSON serializable`, { cause: error });
  }
}

function cloneOptionalJournalValue(
  value: unknown,
  label: string,
): WorkspaceTransactionJsonValue | undefined {
  return value === undefined ? undefined : cloneJournalValue(value, label);
}

function setJournalEntry(
  target: Record<string, WorkspaceTransactionJsonValue>,
  stepId: string,
  value: unknown,
  label: string,
): void {
  const cloned = cloneOptionalJournalValue(value, label);
  if (cloned === undefined) delete target[stepId];
  else target[stepId] = cloned;
}

function isJournalMap(
  value: unknown,
): value is Record<string, WorkspaceTransactionJsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasUniqueKnownStepIds(
  value: unknown,
  stepIds: readonly string[],
): value is string[] {
  return (
    Array.isArray(value) &&
    new Set(value).size === value.length &&
    value.every(
      (stepId) => typeof stepId === "string" && stepIds.includes(stepId),
    )
  );
}

/** Reject progress receipts whose ownership sets disagree or whose terminal state retains active steps. */
function hasValidJournalLifecycle(
  journal: Partial<WorkspaceTransactionJournal>,
  stepIds: readonly string[],
): boolean {
  if (
    !hasUniqueKnownStepIds(journal.startedStepIds, stepIds) ||
    !hasUniqueKnownStepIds(journal.completedStepIds, stepIds) ||
    !isJournalMap(journal.results) ||
    !isJournalMap(journal.compensationData)
  )
    return false;
  const startedStepIds = journal.startedStepIds;
  const started = new Set(startedStepIds);
  const completedStepIds = journal.completedStepIds;
  const completed = new Set(completedStepIds);
  if (
    Object.keys(journal.compensationData).some(
      (stepId) => !started.has(stepId),
    ) ||
    Object.keys(journal.results).some((stepId) => !completed.has(stepId))
  )
    return false;
  if (journal.status === "committed")
    return stepIds.every((stepId) => completed.has(stepId));
  return (
    !["compensated", "abandoned"].includes(journal.status ?? "") ||
    (completed.size === 0 && started.size === 0)
  );
}

/** Refuse unreadable durable state without suggesting a new id that could duplicate work. */
function invalidJournal(transactionId: string, detail: string): PmCliError {
  return new PmCliError(
    `Workspace transaction ${transactionId} journal is invalid (${detail})`,
    EXIT_CODE.CONFLICT,
    {
      code: "transaction_journal_invalid",
      required: "A valid durable journal is required before transaction recovery can continue.",
      why: "Corrupt journal data cannot establish which steps applied or still require compensation.",
      nextSteps: [
        "Preserve the journal and inspect its integrity or restore a verified backup before retrying.",
        "Do not switch to a new transaction id to bypass an unreadable journal; previously applied work may remain.",
      ],
    },
  );
}

/** Refuse a different step plan while retaining the valid original journal. */
function journalPlanMismatch(transactionId: string): PmCliError {
  return new PmCliError(
    `Workspace transaction ${transactionId} journal does not match the supplied plan`,
    EXIT_CODE.CONFLICT,
    {
      code: "transaction_plan_mismatch",
      required: "Replay the original plan or safely abandon the interrupted transaction before replacing it.",
      why: "A journal records the plan it is resuming; applying a different plan under the same id could skip or duplicate steps.",
      nextSteps: [
        "Re-run with the original document to resume or replay it.",
        "For item batches use client.itemTransactions.status(transactionId), then client.itemTransactions.abandon(transactionId, { reason }) before committing a changed plan with a new transactionId.",
        "Run pm ops gc --scope transactions --dry-run to inspect retention; active and explicitly abandoned journals remain protected.",
      ],
    },
  );
}

/** Status reads omit a requested plan; fully compensated attempts can be replanned. */
function matchesJournalSteps(status: string, recorded: readonly string[], requested: readonly string[] | undefined): boolean {
  return requested === undefined || status === "compensated" ||
    (recorded.length === requested.length && recorded.every((id, index) => id === requested[index]));
}

/** Validate stored integrity independently of the caller's requested replay plan. */
function parseJournal(
  raw: string,
  transactionId: string,
  stepIds?: readonly string[],
): WorkspaceTransactionJournal {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw invalidJournal(transactionId, "invalid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw invalidJournal(transactionId, "expected an object");
  const journal = parsed as Partial<WorkspaceTransactionJournal>;
  const identityMatches =
    (journal.schemaVersion === 1 || journal.schemaVersion === 2) && journal.transactionId === transactionId;
  if (!identityMatches) throw invalidJournal(transactionId, "schema version or transaction id does not match the journal file");
  const recordedStepIds = journal.stepIds;
  if (
    !Array.isArray(recordedStepIds) ||
    !hasUniqueKnownStepIds(recordedStepIds, recordedStepIds) ||
    !hasValidJournalLifecycle(journal, recordedStepIds) ||
    !hasValidJournalMetadata(journal) ||
    typeof journal.status !== "string" ||
    !["applying", "compensating", "compensated", "committed", "abandoned"].includes(journal.status)
  ) throw invalidJournal(transactionId, "invalid lifecycle, metadata, status or step ids");
  // A compensated attempt was rolled back step by step and holds nothing to
  // resume, so a re-planned document may start a fresh attempt under the same
  // id; every other status must replay the exact plan it recorded.
  const stepsMatch = matchesJournalSteps(journal.status, recordedStepIds, stepIds);
  if (!stepsMatch) throw journalPlanMismatch(transactionId);
  return {
    ...(journal as WorkspaceTransactionJournal),
    results: createResultMap(journal.results),
    compensationData: createResultMap(journal.compensationData),
  };
}

/** Resume matching progress or start a fresh compensated attempt with a copied recovery plan. */
async function prepareJournalForApply(
  options: CommitWorkspaceTransactionOptions,
  transactionId: string,
  author: string,
  stepIds: string[],
  existing: WorkspaceTransactionJournal | undefined,
): Promise<{
  journal: WorkspaceTransactionJournal;
  recovered: boolean;
}> {
  let journal = existing;
  const recovered = journal !== undefined;
  if (journal?.status === "compensating")
    await compensateAppliedSteps(options, journal);
  if (journal === undefined || journal.status === "compensated") {
    const timestamp = nowIso();
    journal = {
      schemaVersion: 1,
      transactionId,
      author,
      status: "applying",
      attempt: (journal?.attempt ?? 0) + 1,
      createdAt: journal?.createdAt ?? timestamp,
      updatedAt: timestamp,
      stepIds,
      startedStepIds: [],
      completedStepIds: [],
      results: createResultMap(),
      compensationData: createResultMap(),
      ...(options.recoveryData === undefined ? {} : { recoveryData: cloneJournalValue(options.recoveryData, "Transaction recovery data") }),
    };
    await writeJournal(options.pmRoot, journal);
    await emitTransition(options, journal, "prepared");
  }
  return { journal, recovered };
}

async function applyPreparedTransaction(
  options: CommitWorkspaceTransactionOptions,
  journal: WorkspaceTransactionJournal,
  recovered: boolean,
): Promise<WorkspaceTransactionCommitResult> {
  try {
    await discoverAppliedSteps(journal, options.steps);
    await writeJournal(options.pmRoot, journal);
    const completed = new Set(journal.completedStepIds);
    const started = new Set(journal.startedStepIds);
    for (const step of options.steps) {
      if (completed.has(step.id)) continue;
      const inspection = await step.inspect();
      let result = cloneOptionalJournalValue(
        inspection.result,
        `Step ${step.id} result`,
      );
      if (inspection.state !== "applied") {
        const compensationData = await step.prepareCompensation?.();
        setJournalEntry(
          journal.compensationData,
          step.id,
          compensationData,
          `Step ${step.id} compensation data`,
        );
        started.add(step.id);
        journal.startedStepIds = options.steps
          .map((candidate) => candidate.id)
          .filter((stepId) => started.has(stepId));
        await writeJournal(options.pmRoot, journal);
        const appliedResult = await step.apply();
        result = cloneOptionalJournalValue(
          appliedResult,
          `Step ${step.id} result`,
        );
      }
      await emitTransition(options, journal, "step_applied", step.id);
      completed.add(step.id);
      journal.completedStepIds = options.steps
        .map((candidate) => candidate.id)
        .filter((stepId) => completed.has(stepId));
      setJournalEntry(
        journal.results,
        step.id,
        result,
        `Step ${step.id} result`,
      );
      await writeJournal(options.pmRoot, journal);
      await emitTransition(options, journal, "step_recorded", step.id);
    }
    await emitTransition(options, journal, "committing");
    journal.status = "committed";
    await writeJournal(options.pmRoot, journal);
    await emitTransition(options, journal, "committed");
    return {
      transactionId: journal.transactionId,
      status: "committed",
      recovered,
      results: createResultMap(journal.results),
    };
  } catch (error) {
    if (
      error instanceof WorkspaceTransactionInterruptedError ||
      journal.status === "committed"
    )
      throw error;
    try {
      await compensateAppliedSteps(options, journal);
    } catch (compensationError) {
      throw new AggregateError(
        [error, compensationError],
        `Workspace transaction failed and compensation failed: ${String(compensationError)}`,
        { cause: compensationError },
      );
    }
    throw error;
  }
}

async function loadJournal(
  pmRoot: string,
  transactionId: string,
  stepIds?: readonly string[],
): Promise<WorkspaceTransactionJournal | undefined> {
  try {
    return parseJournal(
      await readFile(journalPath(pmRoot, transactionId), "utf8"),
      transactionId,
      stepIds,
    );
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      isFileMissingError(error)
    )
      return undefined;
    throw error;
  }
}

async function emitTransition(
  options: CommitWorkspaceTransactionOptions,
  journal: WorkspaceTransactionJournal,
  transition: WorkspaceTransactionTransition,
  stepId?: string,
): Promise<void> {
  await options.onTransition?.({
    transactionId: journal.transactionId,
    attempt: journal.attempt,
    transition,
    ...(stepId === undefined ? {} : { stepId }),
  });
}

async function discoverAppliedSteps(
  journal: WorkspaceTransactionJournal,
  steps: readonly WorkspaceTransactionStep[],
): Promise<void> {
  const completed = new Set<string>();
  const results = createResultMap();
  for (const step of steps) {
    const inspection = await step.inspect();
    if (inspection.state === "applied") {
      completed.add(step.id);
      setJournalEntry(
        results,
        step.id,
        inspection.result,
        `Step ${step.id} result`,
      );
    }
  }
  journal.results = results;
  journal.completedStepIds = steps
    .map((step) => step.id)
    .filter((stepId) => completed.has(stepId));
}

async function compensateAppliedSteps(
  options: CommitWorkspaceTransactionOptions,
  journal: WorkspaceTransactionJournal,
): Promise<void> {
  journal.status = "compensating";
  await writeJournal(options.pmRoot, journal);
  await emitTransition(options, journal, "compensating");
  const completed = new Set(journal.completedStepIds);
  const started = new Set(journal.startedStepIds);
  for (const step of [...options.steps].reverse()) {
    if (!started.has(step.id) && !completed.has(step.id)) continue;
    let shouldCompensate: boolean;
    try {
      const state = (await step.inspect()).state;
      shouldCompensate = started.has(step.id) && (state === "applied" || (state === "pending" && step.compensatePending === true));
    } catch {
      shouldCompensate = started.has(step.id);
    }
    if (shouldCompensate) {
      await emitTransition(options, journal, "step_compensating", step.id);
      await step.compensate(journal.compensationData[step.id]);
    }
    completed.delete(step.id);
    started.delete(step.id);
    journal.completedStepIds = options.steps
      .map((candidate) => candidate.id)
      .filter((stepId) => completed.has(stepId));
    journal.startedStepIds = options.steps
      .map((candidate) => candidate.id)
      .filter((stepId) => started.has(stepId));
    delete journal.results[step.id];
    delete journal.compensationData[step.id];
    await writeJournal(options.pmRoot, journal);
    await emitTransition(options, journal, "step_compensated", step.id);
  }
  journal.status = "compensated";
  await writeJournal(options.pmRoot, journal);
  await emitTransition(options, journal, "compensated");
}

/**
 * Commit an ordered set of idempotent SDK mutations under one workspace writer
 * lock. The durable journal resumes interrupted forward work, while ordinary
 * failures append reverse-order compensations. This provides atomic logical
 * replay without deleting or rewriting immutable domain histories.
 */
export async function commitWorkspaceTransaction(
  options: CommitWorkspaceTransactionOptions,
): Promise<WorkspaceTransactionCommitResult> {
  const { pmRoot, transactionId, author } = validateWorkspaceTransactionIdentity(options);
  const lockTtlSeconds = positiveInteger(
    options.lockTtlSeconds,
    DEFAULT_LOCK_TTL_SECONDS,
    "Transaction lock TTL",
  );
  const lockWaitMs = positiveInteger(
    options.lockWaitMs,
    DEFAULT_LOCK_WAIT_MS,
    "Transaction lock wait",
  );
  const steps = [...options.steps];
  if (steps.length === 0)
    throw new TypeError("Workspace transaction requires at least one step");
  const stepIds = steps.map((step) => {
    const stepId = requiredIdentifier(step.id, "Transaction step id");
    if (stepId !== step.id)
      throw new TypeError(
        "Transaction step id must not contain surrounding whitespace",
      );
    return stepId;
  });
  if (new Set(stepIds).size !== stepIds.length)
    throw new TypeError("Workspace transaction step ids must be unique");
  const stableOptions: CommitWorkspaceTransactionOptions = {
    ...options,
    pmRoot,
    transactionId,
    author,
    steps,
    lockTtlSeconds,
    lockWaitMs,
  };

  const release = await acquireLock(
    pmRoot,
    WORKSPACE_TRANSACTION_LOCK_ID,
    lockTtlSeconds,
    author,
    false,
    false,
    lockWaitMs,
  );
  try {
    const existing = await loadJournal(pmRoot, transactionId, stepIds);
    if (existing?.status === "abandoned" || existing?.abandonment !== undefined) throw retiredTransaction(transactionId);
    const recovered = existing !== undefined;
    if (existing?.status === "committed")
      return {
        transactionId,
        status: "committed",
        recovered: true,
        results: createResultMap(existing.results),
      };
    const prepared = await prepareJournalForApply(
      stableOptions,
      transactionId,
      author,
      stepIds,
      existing,
    );
    return await applyPreparedTransaction(
      stableOptions,
      prepared.journal,
      recovered || prepared.recovered,
    );
  } finally {
    await release();
  }
}

/** Reject replay of a retired id without applying a new plan under that identity. */
function retiredTransaction(transactionId: string): PmCliError {
  return new PmCliError(`Transaction ${transactionId} has been abandoned`, EXIT_CODE.CONFLICT, {
    code: "transaction_abandoned", required: "Use a new transactionId for the replacement plan.",
    why: "An explicitly retired transaction identity cannot be resumed.",
  });
}

/** Read an atomically published journal without changing tracker state; undefined means no retained receipt. */
export async function readWorkspaceTransaction(pmRoot: string, transactionId: string): Promise<WorkspaceTransactionJournal | undefined> {
  const identity = validateWorkspaceTransactionIdentity({ pmRoot, transactionId, author: "reader" });
  return loadJournal(identity.pmRoot, identity.transactionId);
}

/** SHA-256 identity of the ordered, payload-bound step identifiers. */
export function workspaceTransactionPlanDigest(journal: Pick<WorkspaceTransactionJournal, "stepIds">): string {
  return createHash("sha256").update(JSON.stringify(journal.stepIds)).digest("hex");
}

/** Explicit recovery request; the adapter reconstructs compensation from the retained original plan under the coordinator lock. */
export interface AbandonWorkspaceTransactionOptions extends Omit<CommitWorkspaceTransactionOptions, "steps" | "recoveryData"> {
  /** Required human-readable recovery rationale. */
  reason: string;
  /** Optional fresh identity chosen by the caller for its replacement plan; this does not reserve it. */
  supersededBy?: string;
  /** Rebuild original steps without applying forward mutations. */
  resolveSteps(journal: WorkspaceTransactionJournal): readonly WorkspaceTransactionStep[];
}

/** Compensate interrupted owned effects and permanently retire the id; committed work is never undone. */
export async function abandonWorkspaceTransaction(options: AbandonWorkspaceTransactionOptions): Promise<WorkspaceTransactionJournal> {
  const identity = validateWorkspaceTransactionIdentity(options);
  const reason = requiredText(options.reason, "Abandonment reason");
  const supersededBy = options.supersededBy === undefined ? undefined : requiredIdentifier(options.supersededBy, "Replacement transaction id");
  if (supersededBy === identity.transactionId) throw new TypeError("Replacement transaction id must differ from the abandoned id");
  const lockTtlSeconds = positiveInteger(options.lockTtlSeconds, DEFAULT_LOCK_TTL_SECONDS, "Transaction lock TTL");
  const lockWaitMs = positiveInteger(options.lockWaitMs, DEFAULT_LOCK_WAIT_MS, "Transaction lock wait");
  const release = await acquireLock(identity.pmRoot, WORKSPACE_TRANSACTION_LOCK_ID, lockTtlSeconds, identity.author, false, false, lockWaitMs);
  try {
    const journal = await loadJournal(identity.pmRoot, identity.transactionId);
    if (journal === undefined) throw new PmCliError(`Transaction ${identity.transactionId} was not found`, EXIT_CODE.NOT_FOUND);
    if (journal.status === "committed") throw new PmCliError(`Transaction ${identity.transactionId} is committed and cannot be abandoned`, EXIT_CODE.CONFLICT, { code: "transaction_committed", required: "Plan a separate explicit corrective mutation.", why: "Recovery cannot silently undo committed work." });
    if (journal.abandonment !== undefined && journal.abandonment.supersededBy !== supersededBy) throw retiredTransaction(identity.transactionId);
    if (journal.status === "abandoned") return journal;
    const steps = options.resolveSteps(structuredClone(journal));
    if (JSON.stringify(steps.map(step => step.id)) !== JSON.stringify(journal.stepIds)) throw journalPlanMismatch(identity.transactionId);
    if (journal.abandonment === undefined) {
      if (supersededBy !== undefined && await loadJournal(identity.pmRoot, supersededBy) !== undefined) throw new PmCliError(`Replacement transaction ${supersededBy} already exists`, EXIT_CODE.CONFLICT);
      journal.schemaVersion = 2;
      journal.abandonment = { reason, author: identity.author, ...(supersededBy === undefined ? {} : { supersededBy }) };
      await writeJournal(identity.pmRoot, journal);
    }
    if (journal.status !== "compensated") await compensateAppliedSteps({ ...options, ...identity, steps }, journal);
    await auditTransactionAbandonment(journal, identity.pmRoot, lockTtlSeconds, lockWaitMs);
    journal.status = "abandoned";
    await writeJournal(identity.pmRoot, journal);
    return journal;
  } finally {
    await release();
  }
}

/** Record one retirement per attempt even if the final journal write was interrupted after the audit append. */
async function auditTransactionAbandonment(journal: WorkspaceTransactionJournal, pmRoot: string, lockTtlSeconds: number, lockWaitMs: number): Promise<void> {
  const planDigest = workspaceTransactionPlanDigest(journal);
  const history = await readHistoryEntries(getWorkspaceHistoryPath(pmRoot), WORKSPACE_HISTORY_ID);
  if (history.some(entry => entry.op === "transaction_abandon" && entry.context?.transaction_id === journal.transactionId && entry.context?.attempt === journal.attempt && entry.context?.plan_digest === planDigest)) return;
  const abandonment = journal.abandonment!;
  await appendWorkspaceAuditEvent({ pmRoot, author: abandonment.author, lockTtlSeconds, lockWaitMs, op: "transaction_abandon", message: abandonment.reason, context: { transaction_id: journal.transactionId, attempt: journal.attempt, plan_digest: planDigest, ...(abandonment.supersededBy === undefined ? {} : { superseded_by: abandonment.supersededBy }) } });
}
