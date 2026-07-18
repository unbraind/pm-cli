/**
 * @module sdk/workspace-transaction
 *
 * Coordinates crash-recoverable, compensating transactions across public SDK
 * mutation primitives without rewriting immutable item or relationship history.
 */
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { acquireLock } from "../core/lock/lock.js";
import { writeFileAtomic } from "../core/fs/fs-utils.js";
import { nowIso } from "../core/shared/time.js";

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
  /** Apply the forward mutation and return a journal-safe result, or store nothing. */
  apply(): Promise<WorkspaceTransactionJsonValue | undefined>;
  /** Append the inverse or reconciliation mutation. */
  compensate(): Promise<void>;
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
  /** Transition that has just become durable, or is about to run for `step_applied`. */
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

type WorkspaceTransactionJournalStatus =
  | "applying"
  | "compensating"
  | "compensated"
  | "committed";

interface WorkspaceTransactionJournal {
  schemaVersion: 1;
  transactionId: string;
  author: string;
  status: WorkspaceTransactionJournalStatus;
  attempt: number;
  createdAt: string;
  updatedAt: string;
  stepIds: string[];
  completedStepIds: string[];
  results: Record<string, WorkspaceTransactionJsonValue>;
}

const WORKSPACE_TRANSACTION_LOCK_ID = "sdk-workspace-transaction";
const TRANSACTION_ID_PATTERN = /^[a-zA-Z0-9._-]+$/;
const DEFAULT_LOCK_TTL_SECONDS = 30;
const DEFAULT_LOCK_WAIT_MS = 3_000;

function requiredIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || !TRANSACTION_ID_PATTERN.test(normalized))
    throw new TypeError(`${label} must match [a-zA-Z0-9._-]+`);
  return normalized;
}

function requiredText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${label} must be non-empty`);
  return normalized;
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

function hasValidJournalMetadata(
  journal: Partial<WorkspaceTransactionJournal>,
): boolean {
  return (
    Number.isInteger(journal.attempt) &&
    typeof journal.author === "string" &&
    typeof journal.createdAt === "string" &&
    typeof journal.updatedAt === "string"
  );
}

function parseJournal(
  raw: string,
  transactionId: string,
  stepIds: readonly string[],
): WorkspaceTransactionJournal {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new TypeError(
      `Workspace transaction ${transactionId} journal is invalid JSON`,
    );
  }
  if (!parsed || typeof parsed !== "object")
    throw new TypeError(
      `Workspace transaction ${transactionId} journal is invalid`,
    );
  const journal = parsed as Partial<WorkspaceTransactionJournal>;
  const identityMatches =
    journal.schemaVersion === 1 && journal.transactionId === transactionId;
  const stepsMatch =
    Array.isArray(journal.stepIds) &&
    journal.stepIds.length === stepIds.length &&
    journal.stepIds.every((stepId, index) => stepId === stepIds[index]);
  const collectionsMatch =
    Array.isArray(journal.completedStepIds) &&
    journal.results !== null &&
    typeof journal.results === "object";
  const metadataMatches = hasValidJournalMetadata(journal);
  const statusMatches = [
    "applying",
    "compensating",
    "compensated",
    "committed",
  ].includes(String(journal.status));
  if (
    !identityMatches ||
    !stepsMatch ||
    !collectionsMatch ||
    !metadataMatches ||
    !statusMatches
  )
    throw new TypeError(
      `Workspace transaction ${transactionId} journal does not match the supplied plan`,
    );
  return journal as WorkspaceTransactionJournal;
}

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
      completedStepIds: [],
      results: {},
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
    for (const step of options.steps) {
      if (completed.has(step.id)) continue;
      const inspection = await step.inspect();
      const result =
        inspection.state === "applied" ? inspection.result : await step.apply();
      await emitTransition(options, journal, "step_applied", step.id);
      completed.add(step.id);
      journal.completedStepIds = options.steps
        .map((candidate) => candidate.id)
        .filter((stepId) => completed.has(stepId));
      if (result !== undefined) journal.results[step.id] = result;
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
      results: { ...journal.results },
    };
  } catch (error) {
    if (
      error instanceof WorkspaceTransactionInterruptedError ||
      journal.status === "committed"
    )
      throw error;
    await compensateAppliedSteps(options, journal);
    throw error;
  }
}

async function loadJournal(
  pmRoot: string,
  transactionId: string,
  stepIds: readonly string[],
): Promise<WorkspaceTransactionJournal | undefined> {
  try {
    return parseJournal(
      await readFile(journalPath(pmRoot, transactionId), "utf8"),
      transactionId,
      stepIds,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
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
  const completed = new Set(journal.completedStepIds);
  for (const step of steps) {
    const inspection = await step.inspect();
    if (inspection.state !== "applied") continue;
    completed.add(step.id);
    if (inspection.result !== undefined)
      journal.results[step.id] = inspection.result;
  }
  journal.completedStepIds = steps
    .map((step) => step.id)
    .filter((stepId) => completed.has(stepId));
}

async function compensateAppliedSteps(
  options: CommitWorkspaceTransactionOptions,
  journal: WorkspaceTransactionJournal,
): Promise<void> {
  await discoverAppliedSteps(journal, options.steps);
  journal.status = "compensating";
  await writeJournal(options.pmRoot, journal);
  await emitTransition(options, journal, "compensating");
  const completed = new Set(journal.completedStepIds);
  for (const step of [...options.steps].reverse()) {
    if (!completed.has(step.id)) continue;
    const inspection = await step.inspect();
    if (inspection.state === "applied") {
      await emitTransition(options, journal, "step_compensating", step.id);
      await step.compensate();
    }
    completed.delete(step.id);
    journal.completedStepIds = options.steps
      .map((candidate) => candidate.id)
      .filter((stepId) => completed.has(stepId));
    delete journal.results[step.id];
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
  const transactionId = requiredIdentifier(
    options.transactionId,
    "Transaction id",
  );
  const author = requiredText(options.author, "Transaction author");
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
  if (options.steps.length === 0)
    throw new TypeError("Workspace transaction requires at least one step");
  const stepIds = options.steps.map((step) =>
    requiredIdentifier(step.id, "Transaction step id"),
  );
  if (new Set(stepIds).size !== stepIds.length)
    throw new TypeError("Workspace transaction step ids must be unique");

  const release = await acquireLock(
    options.pmRoot,
    WORKSPACE_TRANSACTION_LOCK_ID,
    lockTtlSeconds,
    author,
    false,
    false,
    lockWaitMs,
  );
  try {
    const existing = await loadJournal(options.pmRoot, transactionId, stepIds);
    const recovered = existing !== undefined;
    if (existing?.status === "committed")
      return {
        transactionId,
        status: "committed",
        recovered: true,
        results: { ...existing.results },
      };
    const prepared = await prepareJournalForApply(
      options,
      transactionId,
      author,
      stepIds,
      existing,
    );
    return await applyPreparedTransaction(
      options,
      prepared.journal,
      recovered || prepared.recovered,
    );
  } finally {
    await release();
  }
}
