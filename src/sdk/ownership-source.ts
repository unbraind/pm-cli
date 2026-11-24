/**
 * @module sdk/ownership-source
 *
 * Resolves whether an item's current assignee originated from an explicit
 * claim or a general metadata assignment using the append-only history stream.
 */
import { readHistoryEntries } from "../core/history/read.js";
import { normalizeReplayPatchPath } from "../core/history/replay.js";
import { getWorkspaceHistoryPath, WORKSPACE_HISTORY_ID } from "../core/history/workspace-history.js";
import type { PmCliErrorContext } from "../core/shared/errors.js";
import { redactIdentityCredentials } from "../core/shared/url-credentials.js";
import { getHistoryPath } from "../core/store/paths.js";
import {
  STALE_WORK_THRESHOLD_SETTING,
  isJudgeableHistoryRecord,
  isWellFormedHistoryRecord,
  latestHistoryTimestamp,
  normalizeStaleWorkThresholdHours,
  recordedBaselineActivity,
  resolveLastActivityAt,
  staleEligibleAt,
  unprovenClaimActivity,
  wholeHoursSince,
  type UnprovenActivityReason,
} from "./governance/stale-work.js";

/** Activity and stale-claim policy evidence behind a claim refusal or takeover (GH-1336). */
export type ClaimActivityEvidence = NonNullable<PmCliErrorContext["claim_activity"]>;

/** Inputs that let a claim conflict report the holder's activity under the stale-work policy. */
export interface ClaimActivityOptions {
  /** The item's stored `updated_at`, read under the same lock as the conflict. */
  updated_at: string | undefined;
  /** Configured `mutation_guard.stale_in_progress_hours`. */
  threshold_hours: number;
  /** Evaluation instant, injectable for deterministic tests. */
  now?: Date;
  /**
   * The item's history stream exists but could not be read (corrupt JSONL or
   * conflict markers). Idleness then cannot be established, so the claim is
   * never judged stale: recent activity may hide behind the unreadable lines.
   */
  history_unreadable?: boolean;
  /**
   * The readable stream cannot prove the holder's idleness: no original
   * record sets the holder, or records after it were discarded, rewritten or
   * replaced by a workspace restore; see `unprovenClaimActivity`. The claim is
   * then never judged stale.
   */
  unproven_activity?: UnprovenActivityReason;
}

/** Typed holder evidence behind an `already_claimed_by` refusal (GH-1610). */
export interface ItemOwnershipConflict {
  /** Prose used by the refusal message: `claimed by <holder>` or `assigned to <holder>`. */
  phrase: string;
  /** Principal that currently holds the item. */
  holder: string;
  /**
   * Whether the latest ownership mutation was an explicit claim or a metadata
   * assignment; `unknown` when history is unreadable, records no assignee
   * change, or its latest change set a different holder, so an unproven
   * origin is never reported as either.
   */
  source: "claim" | "assignment" | "unknown";
  /** Timestamp of the latest assignee change, or null when history is unavailable or silent. */
  since: string | null;
}

/** Holder evidence plus the holder's activity under the stale-work policy (GH-1336). */
export interface ItemOwnershipActivity extends ItemOwnershipConflict {
  /** Claim age, last activity and stale-claim eligibility. */
  activity: ClaimActivityEvidence;
}

/** A measured age in whole hours, or null when it could not be computed. */
function finiteHoursOrNull(hours: number): number | null {
  return Number.isFinite(hours) ? hours : null;
}

/** Evaluate claim age, last activity and stale-claim eligibility from one item's evidence. */
export function evaluateClaimActivity(
  claimedAt: string | null,
  latestHistoryAt: string | undefined,
  options: ClaimActivityOptions,
): ClaimActivityEvidence {
  const nowMs = (options.now ?? new Date()).getTime();
  const thresholdHours = normalizeStaleWorkThresholdHours(options.threshold_hours);
  const lastActivityAt = resolveLastActivityAt(options.updated_at, latestHistoryAt) ?? null;
  const validClaimedAt = claimedAt !== null && Number.isFinite(Date.parse(claimedAt)) ? claimedAt : null;
  // An evaluation clock that is not a finite time (`new Date(NaN)`) measures nothing, so ages are unknown.
  const idleHours = lastActivityAt === null ? null : finiteHoursOrNull(wholeHoursSince(lastActivityAt, nowMs));
  // Unknown or unprovable activity never qualifies: a takeover needs positive evidence of idleness.
  const judgeable =
    idleHours !== null && options.history_unreadable !== true && options.unproven_activity === undefined;
  const stale = judgeable && (idleHours as number) >= thresholdHours;
  return {
    last_activity_at: lastActivityAt,
    ...(options.history_unreadable === true ? { history_unreadable: true as const } : {}),
    ...(options.unproven_activity === undefined ? {} : { unproven_activity: options.unproven_activity }),
    // Unjudgeable activity is its own state, never reported as active (GH-1774).
    state: judgeable ? (stale ? "stale" : "active") : "unknown",
    claim_age_hours: validClaimedAt === null ? null : finiteHoursOrNull(wholeHoursSince(validClaimedAt, nowMs)),
    idle_hours: idleHours,
    stale_policy: {
      setting: STALE_WORK_THRESHOLD_SETTING,
      threshold_hours: thresholdHours,
      stale,
      // A threshold past the Date range (accepted by settings) yields a null eligibility, never a throw.
      // `judgeable` implies a measured idle time, so the activity time is a valid string.
      eligible_at: judgeable ? staleEligibleAt(lastActivityAt as string, thresholdHours) : null,
    },
  };
}


/** Map the operation of the latest assignee change to the holder's origin. */
function classifyOwnershipSource(
  operation: string | undefined,
): ItemOwnershipConflict["source"] {
  if (operation === undefined) return "unknown";
  return operation === "claim" ? "claim" : "assignment";
}

const ASSIGNEE_PATH = "/metadata/assignee";
const CLAIM_PRINCIPAL_PATH = "/metadata/claim_principal";

/** Whether a record changed who holds the item: any assignee change, or a claim that moved only the claim principal. */
function changesOwnership(entry: { op: string; patch: ReadonlyArray<{ path: string }> }): boolean {
  return entry.patch.some(
    (operation) => operation.path === ASSIGNEE_PATH || (entry.op === "claim" && operation.path === CLAIM_PRINCIPAL_PATH),
  );
}

/** The holder name the newest assignee change at or before `index` set, or undefined when none sets a string. */
function holderNamedAt(history: ReadonlyArray<{ patch: ReadonlyArray<{ path: string; value?: unknown }> }>, index: number): string | undefined {
  for (let position = index; position >= 0; position -= 1) {
    const operation = history[position]!.patch.find((candidate) => candidate.path === ASSIGNEE_PATH);
    if (operation !== undefined) return typeof operation.value === "string" ? operation.value.trim() : undefined;
  }
  return undefined;
}

/** Read one stream and derive the holder evidence it proves, keeping the entries for activity reads. */
async function readOwnershipEvidence(
  pmRoot: string,
  itemId: string,
  assignee: string,
): Promise<{
  conflict: ItemOwnershipConflict;
  history: ReadonlyArray<{ ts: string }>;
  readable: boolean;
  unproven: UnprovenActivityReason | undefined;
}> {
  // A missing stream reads as empty; a stream that exists but cannot be parsed, or that
  // decodes to values which are not history records (a `null` line), is unreadable.
  let readable = true;
  const history = await Promise.resolve()
    .then(() => readHistoryEntries(getHistoryPath(pmRoot, itemId), itemId))
    .then((entries) => {
      // Every record must support the judgement (parseable time, valid compaction receipt): a skipped one could be the recent work.
      if (entries.every(isJudgeableHistoryRecord)) return entries;
      readable = false;
      return [];
    })
    .catch(() => {
      readable = false;
      return [];
    });
  let latestOwnershipIndex = history.length - 1;
  while (latestOwnershipIndex >= 0 && !changesOwnership(history[latestOwnershipIndex]!)) {
    latestOwnershipIndex -= 1;
  }
  const latestOwnershipEntry = history[latestOwnershipIndex];
  // The newest ownership change is evidence only when it left the current holder in place;
  // if item state and history diverge, its origin and time describe someone else.
  // A claim that changed only the claim principal kept the holder's name: another
  // session of the same principal took the item, and that record is its start.
  const evidence = holderNamedAt(history, latestOwnershipIndex) === assignee.trim() ? latestOwnershipEntry : undefined;
  const source = classifyOwnershipSource(evidence?.op);
  // A holder stored by an older version may carry URL userinfo; refusals never echo it (GH-1707).
  const holder = redactIdentityCredentials(assignee);
  return {
    conflict: {
      phrase: source === "claim" ? `claimed by ${holder}` : `assigned to ${holder}`,
      holder,
      source,
      since: evidence?.ts ?? null,
    },
    history,
    readable,
    // Only a readable stream is judged; an unreadable one already refuses as history_unreadable.
    unproven: readable ? unprovenClaimActivity(history, evidence === undefined ? -1 : latestOwnershipIndex) : undefined,
  };
}

/** Whether a time is unreadable or at or after the claim, so the event it dates may follow the claim. */
function atOrAfter(timestamp: string, claimedMs: number): boolean {
  const ms = Date.parse(timestamp);
  return !Number.isFinite(ms) || ms >= claimedMs;
}

/** Workspace-stream operations that discard or rewrite records, so a restore record may be gone or changed. */
const WORKSPACE_EVIDENCE_REWRITES: ReadonlySet<string> = new Set([
  "history_salvage",
  "history_repair",
  "history_redact",
  "merge_reconcile",
]);

/**
 * Whether a workspace snapshot restore at or after the claim record may have
 * replaced the holder's later work. The restore rewrites the item stream and
 * records itself only in the workspace stream, which shares no order with it
 * except wall-clock time: precedence assumes pm's own appends follow wall-clock
 * order and the restoring host's clock does not run behind the holder's. Under
 * that assumption a record dated before the claim, and everything it discarded
 * or rewrote, predates the claim.
 *
 * The check fails closed (it cannot rule a restore out) on any of these:
 * - a restore record, or a salvage, repair, redaction or merge reconcile of
 *   the workspace stream, dated at or after the claim;
 * - a compaction baseline whose own time (its last pruned record) or recorded
 *   `last_activity_at` is at or after the claim, or that proves no bound;
 * - a workspace stream, record, operation or time that cannot be read.
 */
async function workspaceRestoredSince(pmRoot: string, claimedAt: string): Promise<boolean> {
  let entries: unknown[];
  try {
    entries = await readHistoryEntries(getWorkspaceHistoryPath(pmRoot), WORKSPACE_HISTORY_ID);
  } catch {
    return true;
  }
  const claimedMs = Date.parse(claimedAt);
  return entries.some((entry) => {
    if (!isWellFormedHistoryRecord(entry)) return true;
    if (entry.op === "workspace_snapshot_restore" || WORKSPACE_EVIDENCE_REWRITES.has(entry.op)) {
      return atOrAfter(entry.ts, claimedMs);
    }
    if (entry.op !== "history_compact_baseline") return false;
    const bound = recordedBaselineActivity(entry);
    return bound === undefined || atOrAfter(entry.ts, claimedMs) || (bound !== null && atOrAfter(bound, claimedMs));
  });
}

/** Resolve the current holder, its source and its start time for an atomic claim conflict. */
export async function resolveItemOwnershipConflict(
  pmRoot: string,
  itemId: string,
  assignee: string,
): Promise<ItemOwnershipConflict> {
  return (await readOwnershipEvidence(pmRoot, itemId, assignee)).conflict;
}

/** Resolve the holder evidence and judge the holder's activity under the stale-work policy, from one stream read. */
export async function resolveItemOwnershipActivity(
  pmRoot: string,
  itemId: string,
  assignee: string,
  options: ClaimActivityOptions,
): Promise<ItemOwnershipActivity> {
  const { conflict, history, readable, unproven } = await readOwnershipEvidence(pmRoot, itemId, assignee);
  const judge = (reason: UnprovenActivityReason | undefined) =>
    evaluateClaimActivity(conflict.since, latestHistoryTimestamp(history), {
      ...options,
      ...(readable ? {} : { history_unreadable: true }),
      ...(reason === undefined ? {} : { unproven_activity: reason }),
    });
  const activity = judge(unproven);
  // A restore can only withhold eligibility, so the workspace stream (often megabytes) is read only for a
  // claim that is otherwise stale; `since` is then the anchor's time, because a proven anchor sets it.
  if (!activity.stale_policy.stale || !(await workspaceRestoredSince(pmRoot, conflict.since as string))) {
    return { ...conflict, activity };
  }
  return { ...conflict, activity: judge("workspace_restored") };
}

/** Describe the current ownership source for an atomic claim conflict. */
export async function describeItemOwnershipConflict(
  pmRoot: string,
  itemId: string,
  assignee: string,
): Promise<string> {
  return (await resolveItemOwnershipConflict(pmRoot, itemId, assignee)).phrase;
}

/** History operations whose ownership change ends the holder's claim at closure. */
const CLAIM_ENDING_CLOSE_OPERATIONS: ReadonlySet<string> = new Set(["close"]);

/** Holder fields a history record can set or remove, as the ownership guard reads them. */
interface HolderFields {
  assignee?: string;
  claim_principal?: string;
}

/** Holder fields keyed by their normalized metadata path. */
const HOLDER_FIELD_PATHS: ReadonlyMap<string, keyof HolderFields> = new Map([
  [ASSIGNEE_PATH, "assignee"],
  [CLAIM_PRINCIPAL_PATH, "claim_principal"],
]);

/** Set or clear one holder field from a written value; a value that is not a string clears it. */
function writeHolderField(fields: HolderFields, key: keyof HolderFields, value: unknown): void {
  if (typeof value === "string") fields[key] = value;
  else delete fields[key];
}

/** One JSON-patch operation as a decoded history record stores it. */
type HolderPatchOperation = { op?: unknown; path: string; from?: unknown; value?: unknown };

/** Whether an operation writes its value (`add` or `replace`). */
function writesValue(operation: HolderPatchOperation): boolean {
  return operation.op === "add" || operation.op === "replace";
}

/** Set both holder fields from a written metadata object. */
function writeHolderObject(fields: HolderFields, metadata: Record<string, unknown>): void {
  for (const key of HOLDER_FIELD_PATHS.values()) writeHolderField(fields, key, metadata[key]);
}

/** The metadata object a whole-document write carries, in either era's key. */
function documentMetadata(value: unknown): unknown {
  if (!isObjectValue(value)) return undefined;
  return value.metadata ?? value.front_matter;
}

/** Whether a normalized path replaces a holder field: the field, the metadata object or the whole document. */
function reachesHolder(path: string): boolean {
  return path === "" || path === "/metadata" || HOLDER_FIELD_PATHS.has(path);
}

/** Whether a value is a JSON object, the only shape replay accepts for the document and its metadata. */
function isObjectValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Write `value` at a path that reaches the holder fields; `undefined` clears a
 * holder field. The document or its metadata must stay an object, as strict
 * replay requires: removing either or writing another shape returns false,
 * so a stream replay would reject never counts as ownership evidence.
 */
function writeHolderAt(fields: HolderFields, path: string, value: unknown): boolean {
  if (path === "" || path === "/metadata") {
    const metadata = path === "" ? documentMetadata(value) : value;
    if (!isObjectValue(metadata)) return false;
    writeHolderObject(fields, metadata);
    return true;
  }
  writeHolderField(fields, HOLDER_FIELD_PATHS.get(path)!, value);
  return true;
}

/**
 * Apply one operation to the tracked holder fields with history replay's path
 * semantics: legacy `/front_matter/...` paths normalize, and a whole-document
 * or whole-metadata write replaces both fields. A `move` or `copy` onto a
 * holder path carries a value this fold does not track, so it returns false
 * and the stream proves nothing; a `move` away from one clears it.
 */
function applyHolderOperation(fields: HolderFields, operation: HolderPatchOperation): boolean {
  const path = normalizeReplayPatchPath(operation.path);
  if (operation.op === "move" || operation.op === "copy") {
    if (reachesHolder(path)) return false;
    const from = typeof operation.from === "string" ? normalizeReplayPatchPath(operation.from) : undefined;
    // Moving the document or its metadata away leaves a shape replay rejects.
    if (operation.op === "move" && from !== undefined && reachesHolder(from)) return writeHolderAt(fields, from, undefined);
    return true;
  }
  if (!reachesHolder(path)) return true;
  if (writesValue(operation)) return writeHolderAt(fields, path, operation.value);
  if (operation.op === "remove") return writeHolderAt(fields, path, undefined);
  return true;
}

/** Apply one record's operations to the tracked holder fields; false when a record makes the holder unprovable. */
function applyHolderPatch(fields: HolderFields, patch: ReadonlyArray<{ path: string; value?: unknown }>): boolean {
  return (patch as ReadonlyArray<HolderPatchOperation>).every((operation) => applyHolderOperation(fields, operation));
}

/**
 * The principal the ownership guard compares: the claim principal, else the
 * assignee. As in the guard, an item without a non-empty assignee has no
 * holder, even when a claim principal was left behind.
 */
function holderPrincipal(fields: HolderFields): string | undefined {
  const assignee = fields.assignee?.trim();
  if (!assignee) return undefined;
  return fields.claim_principal?.trim() || assignee;
}

/**
 * Whether `callerPrincipal`'s most recent claim on the item was ended by a
 * close (GH-1774). Folding the readable history forward, a record that moves
 * the holder away from the caller ends the caller's claim, and one that makes
 * the caller the holder again starts a new one; the caller's claim counts as
 * ended by a close only when the record that last ended it is a close. A
 * release by that caller then acts only on its own ended claim, so a holder
 * who claimed the item after the close keeps it. A stream that cannot be read
 * or replayed proves nothing and returns false, leaving the ownership policy
 * in force.
 */
export async function callerClaimEndedByClose(
  pmRoot: string,
  storageId: string,
  callerPrincipal: string,
): Promise<boolean> {
  let entries: unknown[];
  try {
    entries = await readHistoryEntries(getHistoryPath(pmRoot, storageId), storageId);
  } catch {
    return false;
  }
  const fields: HolderFields = {};
  let endedByClose = false;
  for (const entry of entries) {
    if (!isWellFormedHistoryRecord(entry)) return false;
    const before = holderPrincipal(fields);
    if (!applyHolderPatch(fields, entry.patch)) return false;
    const after = holderPrincipal(fields);
    if (before === callerPrincipal && after !== callerPrincipal) endedByClose = CLAIM_ENDING_CLOSE_OPERATIONS.has(entry.op);
    else if (after === callerPrincipal && before !== callerPrincipal) endedByClose = false;
  }
  return endedByClose;
}
