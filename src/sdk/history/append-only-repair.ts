/**
 * @module sdk/history/append-only-repair
 *
 * Append-only history repair (GH-1715, pm-gh1715). Instead of re-anchoring
 * every recorded entry after a chain break, the repair appends one sealed
 * `history_repair` bridge that names each break and reconciles replay with the
 * on-disk item. Every earlier line stays byte-identical, so append-only
 * consumers, other clones and later merges keep the bytes they already hold.
 */
import { isUtf8 } from "node:buffer";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, stat, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { invalidateHistoryDriftCacheForPath } from "../../core/history/drift-cache.js";
import { isFileAbsentError } from "../../core/fs/fs-utils.js";
import jsonPatch from "fast-json-patch";
import {
  describeHistoryBreak,
  digestBridgedSegment,
} from "../../core/history/bridge.js";
import {
  resolveHistoryHashAlgorithm,
  type HistoryHashAlgorithm,
} from "../../core/history/digest.js";
import { classifyHistoryEvent } from "../../core/history/event-classification.js";
import {
  SUPPORTED_HISTORY_ITEM_HASH_VERSIONS,
  sealHistoryRecord,
  type HistoryItemHashVersion,
} from "../../core/history/history.js";
import {
  cloneEmptyReplayDocument,
  replayHashVerificationCandidates,
  toReplayDocument,
  tryApplyReplayPatch,
  verifyHistoryChainWithVersion,
  type ReplayDocument,
} from "../../core/history/replay.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import { PmCliError } from "../../core/shared/errors.js";
import { nowIso } from "../../core/shared/time.js";
import type {
  HistoryBridge,
  HistoryEntry,
  HistoryPatchOp,
} from "../../types/index.js";
import type { HistorySubject } from "../history-redact.js";
import type {
  HistoryRepairCommandOptions,
  HistoryRepairReconciliationReport,
  HistoryRepairResult,
} from "../history-repair.js";
import type {
  HistoryMaintenancePlan,
  HistoryMaintenanceSnapshot,
} from "./maintenance.js";

/** Receipt for the bridge an append-only repair planned or wrote. */
export interface HistoryRepairBridgeReceipt extends HistoryBridge {
  /** One-based entry where the first named break begins. */
  first_break_entry: number;
}

const BEFORE_HASH_MISMATCH = /^verify_failed:before_hash_mismatch:entry_(\d+)$/u;
const PATCH_APPLY_FAILED = /^verify_failed:patch_apply_failed:entry_(\d+)$/u;

/** Refuse an append-only repair with the reason and the rewriting fallback. */
function refuseAppendOnly(
  id: string,
  reason: string,
  message: string,
  verificationErrors: string[] = [],
): never {
  throw new PmCliError(message, EXIT_CODE.CONFLICT, {
    code: "history_append_only_repair_unavailable",
    item_id: id,
    reason,
    ...(verificationErrors.length > 0
      ? { verification_errors: verificationErrors }
      : {}),
    required:
      "An append-only repair can only bridge chain breaks whose recorded links and patches still replay.",
    nextSteps: [
      `Run pm history-repair ${id} --dry-run to preview the rewriting repair, which re-anchors the recorded entries instead.`,
    ],
  });
}

/** Locate the first break the current verdict reports, or refuse a failure that is not one. */
function locateFirstBreak(
  id: string,
  verification: ReturnType<typeof verifyHistoryChainWithVersion>,
): number | null {
  if (verification.ok) return null;
  const only = verification.errors.length === 1 ? verification.errors[0]! : "";
  const unreplayable = PATCH_APPLY_FAILED.exec(only);
  if (unreplayable !== null) {
    refuseAppendOnly(
      id,
      "patch_does_not_replay",
      `History entry ${unreplayable[1]} of ${id} does not apply without the unrecorded change, so only a rewriting repair can keep its effect.`,
      verification.errors,
    );
  }
  const match = BEFORE_HASH_MISMATCH.exec(only);
  const index = match === null ? 0 : Number(match[1]) - 1;
  if (index < 1) {
    refuseAppendOnly(
      id,
      "chain_failure_not_a_break",
      `History for ${id} fails verification for a reason an append-only bridge cannot name (${verification.errors.join(", ")}).`,
      verification.errors,
    );
  }
  return index;
}

/** Replay every entry strictly; a bridged segment must replay without the unrecorded change. */
function replayStrictly(id: string, entries: HistoryEntry[]): ReplayDocument {
  let replay = cloneEmptyReplayDocument();
  for (const [index, entry] of entries.entries()) {
    const applied = tryApplyReplayPatch(replay, entry.patch);
    if (!applied.ok) {
      refuseAppendOnly(
        id,
        "patch_does_not_replay",
        `History entry ${index + 1} of ${id} does not apply without the unrecorded change, so only a rewriting repair can keep its effect.`,
      );
    }
    replay = applied.document;
  }
  return replay;
}

/** The hash epoch and algorithm the appended record must anchor with. */
interface AppendedRecordSurface {
  itemHashVersion: HistoryItemHashVersion;
  explicitVersion: boolean;
  algorithm: HistoryHashAlgorithm;
}

/**
 * Anchor on the hash surface the stream already uses. A declared epoch wins:
 * the newest one a record declares. An implicit stream keeps the epoch its
 * verified part proves (the whole stream, or the prefix before the first
 * break) when the tail's own anchor agrees. When the tail proves only other
 * epochs it takes the newest of them, and when nothing proves the tail's
 * epoch the surface is ambiguous and the repair refuses instead of guessing.
 */
function resolveAppendedRecordSurface(
  id: string,
  entries: HistoryEntry[],
  firstBreak: number | null,
  finalReplay: ReplayDocument,
  itemReplay: ReplayDocument | null,
): AppendedRecordSurface {
  let algorithm: HistoryHashAlgorithm;
  try {
    algorithm = resolveHistoryHashAlgorithm(entries.at(-1)!.hash_algorithm);
  } catch {
    refuseAppendOnly(
      id,
      "chain_failure_not_a_break",
      `History for ${id} ends with record ${entries.length}, whose digest algorithm this build cannot anchor on.`,
    );
  }
  const declared = [...entries].reverse().find((entry) =>
    (SUPPORTED_HISTORY_ITEM_HASH_VERSIONS as readonly unknown[]).includes(entry.item_hash_version),
  )?.item_hash_version as HistoryItemHashVersion | undefined;
  if (declared !== undefined) {
    return { itemHashVersion: declared, explicitVersion: true, algorithm };
  }
  const verified = firstBreak === null ? entries : entries.slice(0, firstBreak);
  // A verified nonempty chain always proves its epoch; every other verdict was refused earlier.
  const prefixVersion = verifyHistoryChainWithVersion(verified).item_hash_version!;
  const tail = entries.at(-1)!.after_hash;
  const proven = SUPPORTED_HISTORY_ITEM_HASH_VERSIONS.filter((version) =>
    [finalReplay, itemReplay].some(
      (document) =>
        document !== null &&
        replayHashVerificationCandidates(document, version, algorithm).includes(tail),
    ),
  );
  let itemHashVersion: HistoryItemHashVersion = prefixVersion;
  if (!proven.includes(prefixVersion)) {
    if (proven.length === 0) {
      refuseAppendOnly(
        id,
        "hash_surface_ambiguous",
        `History for ${id} declares no hash epoch, and neither replay nor the on-disk item proves its last record's epoch.`,
      );
    }
    // Epochs that hash this tail identically: keep the newest, which covers the most fields.
    itemHashVersion = proven.at(-1)!;
  }
  return { itemHashVersion, explicitVersion: itemHashVersion !== 1, algorithm };
}

/**
 * Epoch 2 has two semantic variants; the appended record must reuse the
 * tail's. Replay proves it on a verified stream and the on-disk item proves
 * it after a bridged break; when neither does and the variants differ, the
 * surface is ambiguous and the repair refuses instead of guessing.
 */
function resolveTailVariant(
  id: string,
  surface: AppendedRecordSurface,
  previousAfterHash: string,
  finalReplay: ReplayDocument,
  itemReplay: ReplayDocument,
): number {
  const candidates = (document: ReplayDocument) =>
    replayHashVerificationCandidates(document, surface.itemHashVersion, surface.algorithm);
  const itemCandidates = candidates(itemReplay);
  if (new Set(itemCandidates).size === 1) return 0;
  const proven = [candidates(finalReplay), itemCandidates]
    .map((hashes) => hashes.indexOf(previousAfterHash))
    .find((index) => index >= 0);
  if (proven === undefined) {
    refuseAppendOnly(
      id,
      "hash_surface_ambiguous",
      `History for ${id} records an epoch-2 hash variant that neither replay nor the on-disk item proves, so an appended record cannot anchor on it.`,
    );
  }
  return proven;
}

/** Build the sealed bridge or reconciliation record appended after the last entry. */
function buildAppendedRepairRecord(params: {
  id: string;
  entries: HistoryEntry[];
  surface: AppendedRecordSurface;
  finalReplay: ReplayDocument;
  itemReplay: ReplayDocument;
  author: string;
  message: string;
  breaks: HistoryBridge["breaks"];
  segmentStart: number;
}): HistoryEntry {
  const { entries, surface, finalReplay, itemReplay } = params;
  const previousAfterHash = entries.at(-1)!.after_hash;
  const variant = resolveTailVariant(params.id, surface, previousAfterHash, finalReplay, itemReplay);
  const record: HistoryEntry = {
    hash_algorithm: surface.algorithm,
    ts: nowIso(),
    author: params.author,
    op: "history_repair",
    patch: jsonPatch.compare(finalReplay, itemReplay) as HistoryPatchOp[],
    before_hash: previousAfterHash,
    after_hash: replayHashVerificationCandidates(
      itemReplay,
      surface.itemHashVersion,
      surface.algorithm,
    )[variant]!,
    message: params.message,
    ...(surface.explicitVersion
      ? { item_hash_version: surface.itemHashVersion }
      : {}),
    ...(params.breaks.length === 0
      ? {}
      : {
          bridge: {
            version: 1,
            breaks: params.breaks,
            segment_digest: digestBridgedSegment(
              entries.slice(params.segmentStart),
              { hash_algorithm: surface.algorithm },
            ),
          },
        }),
  };
  return sealHistoryRecord({
    ...record,
    event_class: classifyHistoryEvent(record),
  });
}

/** Describe the repair in the record and the report. */
function describeAppendOnlyRepair(
  message: string | undefined,
  breaks: number,
  reconciled: boolean,
): string {
  if (message !== undefined) return message;
  const parts = [
    ...(breaks > 0
      ? [`history-repair bridged ${breaks} chain break${breaks === 1 ? "" : "s"} without rewriting recorded entries`]
      : []),
    ...(reconciled ? ["reconciled replay with the on-disk item"] : []),
  ];
  return `${parts.join("; ")}.`;
}

/** Name the first replay mismatch and every later recorded link the stream breaks. */
function collectBreaks(
  entries: HistoryEntry[],
  firstBreak: number | null,
): HistoryBridge["breaks"] {
  if (firstBreak === null) return [];
  const breaks = [describeHistoryBreak(entries[firstBreak - 1]!, entries[firstBreak]!)];
  for (let index = firstBreak + 1; index < entries.length; index += 1) {
    if (entries[index]!.before_hash !== entries[index - 1]!.after_hash) {
      breaks.push(describeHistoryBreak(entries[index - 1]!, entries[index]!));
    }
  }
  return breaks;
}

/** Reconciliation-loss analysis and warnings shared with the rewriting repair. */
export interface AppendOnlyRepairHelpers {
  /** Name the recorded effects the reconciliation patch overwrites. */
  analyzeDiscard: (
    entries: HistoryEntry[],
    finalReplay: ReplayDocument,
    itemReplay: ReplayDocument,
  ) => HistoryRepairReconciliationReport | undefined;
  /** Derive the repair warnings from the change and its losses. */
  collectWarnings: (
    changed: boolean,
    skippedOps: number,
    reconciliation: HistoryRepairReconciliationReport | undefined,
  ) => string[];
}

/** Append the planned record to the exact bytes the shared under-lock check verified. */
/** Refuse when the history path no longer names the file the open handle wrote. */
async function assertSameStream(
  id: string,
  handle: FileHandle,
  historyPath: string,
  statPath: (file: string) => Promise<{ ino: number; dev: number }>,
): Promise<void> {
  const [written, current] = [await handle.stat(), await statPath(historyPath).catch(() => null)];
  if (current === null || current.ino !== written.ino || current.dev !== written.dev) {
    refuseAppendOnly(
      id,
      "stream_changed",
      `History for ${id} was replaced while the repair appended; the bridge was not recorded, retry.`,
    );
  }
}

/** Read from position zero until EOF or `limit` bytes; a short read never ends it early. */
async function readStreamPrefix(handle: FileHandle, limit: number): Promise<Buffer> {
  const buffer = Buffer.alloc(limit);
  let filled = 0;
  while (filled < limit) {
    const { bytesRead } = await handle.read({ buffer, offset: filled, length: limit - filled, position: filled });
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return buffer.subarray(0, filled);
}

/**
 * Open the stream to append to. An existing stream is opened as it is; an
 * absent one is created exclusively (O_EXCL), so a stream, or link, another
 * writer created meanwhile is never replaced. O_NOFOLLOW: a stream entry that
 * is a link must never carry the record into another stream (Windows defines
 * none, and an undefined flag ORs as 0).
 */
async function openStreamForAppend(id: string, historyPath: string, create: boolean): Promise<FileHandle> {
  if (create) await mkdir(path.dirname(historyPath), { recursive: true });
  const flags =
    constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW | (create ? constants.O_CREAT | constants.O_EXCL : 0);
  return open(historyPath, flags).catch((error: unknown) => {
    const code = (error as NodeJS.ErrnoException).code;
    if (create && code === "EEXIST") {
      refuseAppendOnly(id, "stream_changed", `History for ${id} was created after the repair verified it; retry.`);
    }
    if (!create && isFileAbsentError(error)) {
      refuseAppendOnly(id, "stream_changed", `History for ${id} was removed after the repair verified it; retry.`);
    }
    if (code === "ELOOP") refuseLinkedStream(id);
    throw error;
  });
}

/**
 * A stream this repair created and only partly wrote is removed again, so a
 * retry finds it absent instead of holding a truncated record. Bytes anyone
 * else added keep it in place.
 */
async function removeOwnPartialStream(handle: FileHandle, historyPath: string, appended: string): Promise<void> {
  const intended = Buffer.from(appended);
  const written = await readStreamPrefix(handle, intended.length + 1);
  if (!written.equals(intended.subarray(0, written.length))) return;
  const [own, [current]] = [await handle.stat(), await Promise.allSettled([stat(historyPath)])];
  if (current.status === "fulfilled" && current.value.ino === own.ino && current.value.dev === own.dev) {
    await unlink(historyPath);
  }
}

/**
 * Append one record through O_APPEND on the very handle whose bytes were
 * checked: the write can never replace bytes another writer added, and
 * nothing rolls the stream back from a stale snapshot. The path is created
 * only when the verified snapshot was absent, and then exclusively.
 */
async function appendRepairRecord(
  id: string,
  historyPath: string,
  verifiedRaw: string | null,
  record: HistoryEntry,
  statPath: (file: string) => Promise<{ ino: number; dev: number }> = stat,
): Promise<void> {
  const create = verifiedRaw === null;
  const handle = await openStreamForAppend(id, historyPath, create);
  try {
    const bytes = await handle.readFile();
    if (!isUtf8(bytes)) {
      refuseAppendOnly(
        id,
        "stream_not_utf8",
        `History for ${id} is not valid UTF-8, so its bytes cannot be kept exactly.`,
      );
    }
    const raw = bytes.toString("utf8");
    if (raw !== (verifiedRaw ?? "")) {
      refuseAppendOnly(
        id,
        "stream_changed",
        `History for ${id} changed after the repair verified it; retry.`,
      );
    }
    const separator = raw === "" || raw.endsWith("\n") ? "" : "\n";
    const appended = `${separator}${JSON.stringify(record)}\n`;
    try {
      await handle.appendFile(appended);
      await handle.sync();
    } catch (error: unknown) {
      // Cleanup never masks the write failure that the caller must see.
      if (create) await Promise.allSettled([removeOwnPartialStream(handle, historyPath, appended)]);
      throw error;
    }
    await assertSameStream(id, handle, historyPath, statPath);
    // A writer that ignores pm's lock can still append between the check and
    // this write; O_APPEND keeps its bytes, so report the stale bridge instead
    // of rolling anything back. Writers that share the lock cannot race here.
    const expected = Buffer.concat([bytes, Buffer.from(appended)]);
    if (!(await readStreamPrefix(handle, expected.length + 1)).equals(expected)) {
      refuseAppendOnly(
        id,
        "stream_changed",
        `History for ${id} received another write while the repair appended; run pm health to re-verify the stream.`,
      );
    }
    // Checked again after the readback, while the handle is open: a path
    // replaced during the readback leaves the bridge only in the detached file.
    await assertSameStream(id, handle, historyPath, statPath);
  } finally {
    await handle.close();
  }
}

/**
 * Append one record to the exact bytes the shared under-lock check verified,
 * through O_APPEND so bytes another writer added are never replaced; an
 * absent stream is created exclusively (pm-3os5p6).
 */
export async function appendRecordToVerifiedStream(
  id: string,
  historyPath: string,
  verifiedRaw: string | null,
  record: HistoryEntry,
): Promise<void> {
  await appendRepairRecord(id, historyPath, verifiedRaw, record);
  await invalidateHistoryDriftCacheForPath(historyPath);
}

/** A stream entry that is a link could carry an appended record into another stream. */
function refuseLinkedStream(id: string): never {
  throw new PmCliError(
    `History for ${id} is a symbolic link, so an appended record could land in another stream.`,
    EXIT_CODE.CONFLICT,
    {
      code: "history_append_only_repair_unavailable",
      item_id: id,
      reason: "stream_not_regular_file",
      required: "A history stream must be a regular file at its own path; no bytes were changed.",
      nextSteps: [
        `Restore ${id}'s own history stream as a regular file from version control or a backup. When none exists and the item is live, move the link aside and preview the rebuild with pm history-repair ${id} --dry-run.`,
      ],
    },
  );
}

/** Refuse a linked stream entry before planning, so a preview never offers an append the write must refuse. */
export async function assertRegularStreamEntry(id: string, historyPath: string): Promise<void> {
  const entry = await lstat(historyPath).catch(() => null);
  if (entry?.isSymbolicLink() === true) refuseLinkedStream(id);
}

/** Refuse a stream whose bytes are not UTF-8 before planning, so a preview never offers a repair the write must refuse. */
export async function assertAppendOnlyStreamEncoding(
  id: string,
  historyPath: string,
): Promise<void> {
  await assertRegularStreamEntry(id, historyPath);
  const bytes = await readFile(historyPath).catch(() => null);
  if (bytes !== null && !isUtf8(bytes)) {
    refuseAppendOnly(
      id,
      "stream_not_utf8",
      `History for ${id} is not valid UTF-8, so its bytes cannot be kept exactly.`,
    );
  }
}

/**
 * Plan an append-only repair: name every recorded break after the first
 * replay mismatch, append one record that reconciles replay with the on-disk
 * item, and require the extended stream to verify before anything is written.
 */
export function buildAppendOnlyRepairPlan(
  subject: HistorySubject,
  options: HistoryRepairCommandOptions,
  snapshot: HistoryMaintenanceSnapshot,
  helpers: AppendOnlyRepairHelpers,
): HistoryMaintenancePlan<HistoryRepairResult> {
  const { entries } = snapshot;
  const id = subject.id;
  const before = verifyHistoryChainWithVersion(entries);
  const firstBreak = locateFirstBreak(id, before);
  const breaks = collectBreaks(entries, firstBreak);
  if (breaks.length > 0 && snapshot.loadedItem === null) {
    refuseAppendOnly(
      id,
      "item_missing",
      `History for ${id} has a chain break, but no on-disk item exists to anchor an append-only bridge.`,
    );
  }
  const finalReplay = replayStrictly(id, entries);
  const itemReplay =
    snapshot.loadedItem === null
      ? null
      : toReplayDocument(snapshot.loadedItem.document);
  const reconciliation =
    itemReplay === null
      ? undefined
      : helpers.analyzeDiscard(entries, finalReplay, itemReplay);
  const reconcile = reconciliation !== undefined;
  const changed = breaks.length > 0 || reconcile;
  const surface = resolveAppendedRecordSurface(id, entries, firstBreak, finalReplay, itemReplay);
  const appended = changed
    ? buildAppendedRepairRecord({
        id,
        entries,
        surface,
        finalReplay,
        itemReplay: itemReplay!,
        author: snapshot.author,
        message: describeAppendOnlyRepair(options.message, breaks.length, reconcile),
        breaks,
        segmentStart: firstBreak ?? entries.length,
      })
    : null;
  const rewrittenEntries = appended === null ? entries : [...entries, appended];
  const after = verifyHistoryChainWithVersion(rewrittenEntries);
  if (!after.ok) {
    refuseAppendOnly(
      id,
      "bridge_does_not_verify",
      `An append-only bridge for ${id} would not verify (${after.errors.join(", ")}).`,
      after.errors,
    );
  }
  const receipt: HistoryRepairBridgeReceipt | undefined =
    appended?.bridge === undefined
      ? undefined
      : { ...appended.bridge, first_break_entry: firstBreak! + 1 };
  const planWarnings = helpers.collectWarnings(changed, 0, reconciliation);
  return {
    changed,
    rewrittenEntries,
    /** Append the record to the exact bytes read under the lock. */
    applyRewrite: async (verified) =>
      appendRepairRecord(id, subject.historyPath, verified.historyRawUnderLock, appended!),
    report: ({ verification, warnings }) =>
      reportAppendOnlyRepair({
        subject,
        options,
        entries,
        before,
        surface,
        changed,
        itemReplay,
        reconciliation,
        receipt,
        verification,
        warnings: [...planWarnings, ...warnings],
      }),
  };
}

/** Render the public repair result for an append-only plan. */
function reportAppendOnlyRepair(params: {
  subject: HistorySubject;
  options: HistoryRepairCommandOptions;
  entries: HistoryEntry[];
  before: ReturnType<typeof verifyHistoryChainWithVersion>;
  surface: AppendedRecordSurface;
  changed: boolean;
  itemReplay: ReplayDocument | null;
  reconciliation: HistoryRepairReconciliationReport | undefined;
  receipt: HistoryRepairBridgeReceipt | undefined;
  verification: { ok: boolean; errors: string[] };
  warnings: string[];
}): HistoryRepairResult {
  const { subject, entries, surface, itemReplay } = params;
  return {
    id: subject.id,
    dry_run: params.options.dryRun === true,
    changed: params.changed,
    history: {
      path: subject.historyPath,
      entries_scanned: entries.length,
      chain_drift_before: !params.before.ok,
      entries_rehashed: 0,
      entries_patch_repaired: 0,
      converted_replace_to_add: 0,
      skipped_ops: 0,
      reconciled_with_item: params.reconciliation !== undefined,
      audit_entry_added: params.changed && params.options.dryRun !== true,
      verify_ok: params.verification.ok,
      verify_errors: params.verification.errors,
      item_hash_version_before: params.before.item_hash_version ?? null,
      item_hash_version_after: surface.itemHashVersion,
      version_disposition: "preserved",
    },
    item: {
      exists: subject.located !== null,
      path: subject.located?.itemPath ?? null,
      matched_chain_before:
        itemReplay === null
          ? null
          : replayHashVerificationCandidates(
              itemReplay,
              surface.itemHashVersion,
              surface.algorithm,
            ).includes(entries.at(-1)!.after_hash),
    },
    provenance_normalization: {
      requested: false,
      changed: false,
      events_changed: 0,
      observations_removed: 0,
      invalid_values: [],
    },
    ...(params.receipt === undefined ? {} : { bridge: params.receipt }),
    ...(params.reconciliation === undefined
      ? {}
      : { reconciliation: params.reconciliation }),
    warnings: [...new Set(params.warnings)].sort((left, right) =>
      left.localeCompare(right),
    ),
    generated_at: nowIso(),
  };
}

/** Internal helpers exported only for focused tests. */
export const _testOnly = { appendRepairRecord };
