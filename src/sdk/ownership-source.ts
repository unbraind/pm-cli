/**
 * @module sdk/ownership-source
 *
 * Resolves whether an item's current assignee originated from an explicit
 * claim or a general metadata assignment using the append-only history stream.
 */
import { readHistoryEntries } from "../core/history/read.js";
import { getWorkspaceHistoryPath, WORKSPACE_HISTORY_ID } from "../core/history/workspace-history.js";
import type { PmCliErrorContext } from "../core/shared/errors.js";
import { redactIdentityCredentials } from "../core/shared/url-credentials.js";
import { getHistoryPath } from "../core/store/paths.js";
import {
  STALE_WORK_THRESHOLD_SETTING,
  isJudgeableHistoryRecord,
  latestHistoryTimestamp,
  normalizeStaleWorkThresholdHours,
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
  const idleHours = lastActivityAt === null ? null : wholeHoursSince(lastActivityAt, nowMs);
  // Unknown or unprovable activity never qualifies: a takeover needs positive evidence of idleness.
  const judgeable =
    lastActivityAt !== null && options.history_unreadable !== true && options.unproven_activity === undefined;
  return {
    last_activity_at: lastActivityAt,
    ...(options.history_unreadable === true ? { history_unreadable: true as const } : {}),
    ...(options.unproven_activity === undefined ? {} : { unproven_activity: options.unproven_activity }),
    claim_age_hours: validClaimedAt === null ? null : wholeHoursSince(validClaimedAt, nowMs),
    idle_hours: idleHours,
    stale_policy: {
      setting: STALE_WORK_THRESHOLD_SETTING,
      threshold_hours: thresholdHours,
      stale: judgeable && (idleHours as number) >= thresholdHours,
      // A threshold past the Date range (accepted by settings) yields a null eligibility, never a throw.
      eligible_at: judgeable ? staleEligibleAt(lastActivityAt, thresholdHours) : null,
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
  while (
    latestOwnershipIndex >= 0 &&
    !history[latestOwnershipIndex]!.patch.some((operation) => operation.path === "/metadata/assignee")
  ) {
    latestOwnershipIndex -= 1;
  }
  const latestOwnershipEntry = history[latestOwnershipIndex];
  // The newest assignee change is evidence only when it set the current holder;
  // if item state and history diverge, its origin and time describe someone else.
  const assigneeOperation = latestOwnershipEntry?.patch.find(
    (operation) => operation.path === "/metadata/assignee",
  );
  const evidence =
    assigneeOperation !== undefined &&
    typeof assigneeOperation.value === "string" &&
    assigneeOperation.value.trim() === assignee.trim()
      ? latestOwnershipEntry
      : undefined;
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

/**
 * Whether a workspace snapshot restore at or after the claim record may have
 * replaced the holder's later work. The restore rewrites the item stream and
 * records itself only in the workspace stream, which shares no order with it
 * except wall-clock time. A workspace stream that cannot be read, or holds a
 * record whose operation or restore time cannot be read, cannot rule a
 * restore out.
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
    const record = (entry ?? {}) as { op?: unknown; ts?: unknown };
    if (typeof record.op !== "string") return true;
    if (record.op !== "workspace_snapshot_restore") return false;
    const restoredMs = typeof record.ts === "string" ? Date.parse(record.ts) : Number.NaN;
    return !Number.isFinite(restoredMs) || restoredMs >= claimedMs;
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
  const evidence = await readOwnershipEvidence(pmRoot, itemId, assignee);
  const { conflict, history, readable } = evidence;
  // `since` is the claim record's time whenever the stream proved one (unproven is then undefined).
  const unproven =
    evidence.unproven ??
    (readable && (await workspaceRestoredSince(pmRoot, conflict.since as string)) ? "workspace_restored" : undefined);
  return {
    ...conflict,
    activity: evaluateClaimActivity(conflict.since, latestHistoryTimestamp(history), {
      ...options,
      ...(readable ? {} : { history_unreadable: true }),
      ...(unproven === undefined ? {} : { unproven_activity: unproven }),
    }),
  };
}

/** Describe the current ownership source for an atomic claim conflict. */
export async function describeItemOwnershipConflict(
  pmRoot: string,
  itemId: string,
  assignee: string,
): Promise<string> {
  return (await resolveItemOwnershipConflict(pmRoot, itemId, assignee)).phrase;
}
