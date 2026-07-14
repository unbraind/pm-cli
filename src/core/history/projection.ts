/**
 * @module core/history/projection
 *
 * Reconstructs verified point-in-time item states from hash-chained history.
 * Restore, SDK reads, and future VCS-style integrations share this single
 * replay kernel so read and write paths cannot disagree about a version.
 */
import { EXIT_CODE } from "../shared/constants.js";
import { PmCliError } from "../shared/errors.js";
import type { HistoryEntry, HistoryPatchOp } from "../../types/index.js";
import {
  EMPTY_REPLAY_DOCUMENT,
  replayHash,
  tryApplyReplayPatch,
  type ReplayDocument,
} from "./replay.js";

/** Describes the normalized version or timestamp selected from a history stream. */
export interface ResolvedHistoryTarget {
  /** Target syntax selected by the caller. */
  kind: "version" | "timestamp";
  /** Original normalized target text. */
  raw: string;
  /** Zero-based history entry selected for reconstruction. */
  historyIndex: number;
}

/** Controls caller-specific target diagnostics and future timestamp policy. */
export interface ResolveHistoryTargetOptions {
  /** Command concept named in agent-facing validation errors. */
  errorSubject?: "history" | "restore";
  /** Allow a timestamp after the final entry to select that final entry. */
  allowFutureTimestamp?: boolean;
}

interface PatchFailureContext {
  patchIndex?: number;
  op?: string;
  path?: string;
  from?: string;
  reason?: string;
}

/** Find the final history entry recorded at or before a parsed timestamp. */
function findHistoryIndexAtTimestamp(
  history: readonly HistoryEntry[],
  parsedTarget: number,
): number {
  let historyIndex = -1;
  history.forEach((entry, index) => {
    const entryTimestamp = Date.parse(entry.ts);
    if (!Number.isFinite(entryTimestamp)) {
      throw new PmCliError(
        `History for this item contains invalid timestamp at entry ${index + 1}.`,
        EXIT_CODE.GENERIC_FAILURE,
      );
    }
    if (entryTimestamp <= parsedTarget) {
      historyIndex = index;
    }
  });
  return historyIndex;
}

/** Build structured target-range guidance once for every resolver error path. */
function buildHistoryTargetGuidance(history: readonly HistoryEntry[]) {
  const firstTimestamp = history[0]?.ts ?? null;
  const lastTimestamp = history.at(-1)?.ts ?? null;
  const guidance = {
    code: "history_target_out_of_range",
    required: "Choose a target within the available item history.",
    why: "Point-in-time reads and restores can only reconstruct recorded versions.",
    examples: [] as string[],
    nextSteps: [
      "Run pm history <id> to inspect available versions and timestamps.",
    ],
    valid_range: {
      first_version: null as number | null,
      last_version: null as number | null,
      first_timestamp: firstTimestamp,
      last_timestamp: lastTimestamp,
    },
  };
  if (lastTimestamp !== null) {
    guidance.examples = ["1", String(history.length), lastTimestamp];
    guidance.valid_range.first_version = 1;
    guidance.valid_range.last_version = history.length;
  }
  return { guidance, lastTimestamp };
}

/** Extract best-effort JSON Patch position details for replay diagnostics. */
export function extractPatchFailureContext(
  patch: HistoryPatchOp[],
  error: unknown,
): PatchFailureContext {
  const failure: PatchFailureContext = {};
  if (error instanceof Error && error.message.trim().length > 0) {
    failure.reason = error.message.trim();
  }
  if (typeof error !== "object" || error === null) {
    return failure;
  }
  const candidate = error as { index?: unknown; operation?: unknown };
  if (
    typeof candidate.index === "number" &&
    Number.isInteger(candidate.index) &&
    candidate.index >= 0
  ) {
    failure.patchIndex = candidate.index;
  }
  if (typeof candidate.operation === "object" && candidate.operation !== null) {
    const operation = candidate.operation as Record<string, unknown>;
    Object.assign(
      failure,
      Object.fromEntries(
        (["op", "path", "from"] as const).flatMap((field) => {
          const value = operation[field];
          return typeof value === "string" ? [[field, value]] : [];
        }),
      ),
    );
  }
  if (failure.patchIndex !== undefined) {
    const fallback = patch[failure.patchIndex];
    if (fallback) {
      failure.op ??= fallback.op;
      failure.path ??= fallback.path;
      failure.from ??= fallback.from;
    }
  }
  return failure;
}

/**
 * Resolve a one-based version or ISO timestamp into a concrete history entry.
 * Errors include structured valid-range metadata for agent and SDK callers.
 */
export function resolveHistoryTarget(
  target: string,
  history: readonly HistoryEntry[],
  options: ResolveHistoryTargetOptions = {},
): ResolvedHistoryTarget {
  const trimmed = target.trim();
  const errorSubject = options.errorSubject ?? "history";
  const errorSubjectTitle = errorSubject === "restore" ? "Restore" : "History";
  const { guidance, lastTimestamp } = buildHistoryTargetGuidance(history);
  if (!trimmed) {
    throw new PmCliError(
      `Missing ${errorSubject} target. Use a timestamp or version number.`,
      EXIT_CODE.USAGE,
      guidance,
    );
  }
  if (/^\d+$/.test(trimmed)) {
    const version = Number(trimmed);
    if (
      !Number.isSafeInteger(version) ||
      version < 1 ||
      version > history.length
    ) {
      throw new PmCliError(
        `${errorSubjectTitle} version must be between 1 and ${history.length} for this item.`,
        EXIT_CODE.USAGE,
        guidance,
      );
    }
    return { kind: "version", raw: trimmed, historyIndex: version - 1 };
  }
  const parsedTarget = Date.parse(trimmed);
  if (!Number.isFinite(parsedTarget)) {
    throw new PmCliError(
      `Invalid ${errorSubject} target "${target}". Use a positive version number or ISO timestamp.`,
      EXIT_CODE.USAGE,
      guidance,
    );
  }
  const historyIndex = findHistoryIndexAtTimestamp(history, parsedTarget);
  if (
    historyIndex < 0 ||
    (options.allowFutureTimestamp !== true &&
      parsedTarget > Date.parse(lastTimestamp as string))
  ) {
    throw new PmCliError(
      errorSubject === "restore"
        ? `No history entries exist at or before timestamp ${trimmed}.`
        : `No history entry exists at timestamp ${trimmed}.`,
      EXIT_CODE.USAGE,
      guidance,
    );
  }
  return { kind: "timestamp", raw: trimmed, historyIndex };
}

/** Apply one normalized JSON Patch entry and retain actionable failure context. */
export function applyHistoryPatch(
  current: ReplayDocument,
  patch: HistoryPatchOp[],
  entryNumber: number,
  entryOp: string,
): ReplayDocument {
  const applied = tryApplyReplayPatch(current, patch);
  if (applied.ok) {
    return applied.document;
  }
  const failure = extractPatchFailureContext(patch, applied.error);
  const tokens = [
    `history_op=${entryOp}`,
    failure.patchIndex === undefined
      ? null
      : `patch_index=${failure.patchIndex}`,
    failure.op ? `op=${failure.op}` : null,
    failure.path ? `path=${failure.path}` : null,
    failure.from ? `from=${failure.from}` : null,
  ].filter((token): token is string => token !== null);
  throw new PmCliError(
    `Failed to apply history patch at entry ${entryNumber} (${tokens.join(", ")}). ${failure.reason ?? String(applied.error)}`,
    EXIT_CODE.GENERIC_FAILURE,
  );
}

/** Replay and hash-verify a history stream through a zero-based target entry. */
export function replayHistoryToTarget(
  history: readonly HistoryEntry[],
  targetIndex: number,
): ReplayDocument {
  let document: ReplayDocument = structuredClone(EMPTY_REPLAY_DOCUMENT);
  for (let index = 0; index <= targetIndex; index += 1) {
    const entry = history[index];
    if (!entry) {
      throw new PmCliError(
        `History target entry ${index + 1} does not exist.`,
        EXIT_CODE.USAGE,
      );
    }
    if (replayHash(document) !== entry.before_hash) {
      throw new PmCliError(
        `History hash mismatch before replay at entry ${index + 1}.`,
        EXIT_CODE.GENERIC_FAILURE,
      );
    }
    document = applyHistoryPatch(document, entry.patch, index + 1, entry.op);
    if (replayHash(document) !== entry.after_hash) {
      throw new PmCliError(
        `History hash mismatch after replay at entry ${index + 1}.`,
        EXIT_CODE.GENERIC_FAILURE,
      );
    }
  }
  return document;
}

/** Reject a version whose reconstructed state represents a deleted item. */
export function ensureMaterializedHistoryTarget(
  replayDocument: ReplayDocument,
  target: ResolvedHistoryTarget,
): ReplayDocument {
  if (Object.keys(replayDocument.metadata).length > 0) {
    return replayDocument;
  }
  throw new PmCliError(
    `History target ${target.raw} resolves to a deleted state; choose a version or timestamp where the item exists.`,
    EXIT_CODE.USAGE,
  );
}
