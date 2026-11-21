/**
 * @module sdk/history/salvage
 * Recover an invalid JSONL suffix while preserving every verified prefix byte.
 */
import { isUtf8 } from "node:buffer";
import { resolveHistoryHashAlgorithm } from "../../core/history/digest.js";
import { readFile } from "node:fs/promises";
import {
  isFileMissingError,
  readFileIfExists,
} from "../../core/fs/fs-utils.js";
import { acquireLock } from "../../core/lock/lock.js";
import {
  createHistoryEntry,
  sealHistoryRecord,
  type HistoryItemHashVersion,
} from "../../core/history/history.js";
import {
  checkHistoryRewriteOwnership,
  writeHistoryRawWithRollback,
} from "../../core/history/history-rewrite.js";
import { replayHistoryToTarget } from "../../core/history/projection.js";
import {
  cloneEmptyReplayDocument,
  lenientApplyReplayPatch,
  replayToItemDocument,
  tryApplyReplayPatch,
  verifyHistoryChainWithVersion,
  type ReplayDocument,
} from "../../core/history/replay.js";
import { SUPPORTED_HISTORY_ITEM_HASH_VERSIONS } from "../../core/history/history.js";
import { findFirstMergeConflictMarker } from "../../core/shared/conflict-markers.js";
import {
  describeHistoryRecordDefect,
  isNonRecordScalar,
} from "../../core/history/read.js";
import { EMPTY_CANONICAL_DOCUMENT, EXIT_CODE } from "../../core/shared/constants.js";
import {
  advanceItemMutationPreconditions,
  assertItemMutationPreconditions,
  assertItemRevisionExpectationsOnUnreadable,
} from "../../core/store/item-mutation-precondition.js";
import { PmCliError } from "../../core/shared/errors.js";
import { sha256Hex } from "../../core/shared/serialization.js";
import { nowIso } from "../../core/shared/time.js";
import {
  runActiveOnReadHooks,
  runActiveOnWriteHooks,
} from "../../core/extensions/index.js";
import {
  locateItem,
  readLocatedItemSnapshot,
} from "../../core/store/item-store.js";
import type { ItemTypeRegistry } from "../../core/item/type-registry.js";
import type {
  HistoryEntry,
  ItemDocument,
  PmSettings,
} from "../../types/index.js";
import type { HistorySubject } from "../history-redact.js";
import type {
  HistoryRepairCommandOptions,
  HistoryRepairResult,
} from "../history-repair.js";

/** Evidence describing only the discarded bytes, without retaining their contents. */
export interface HistorySalvageReceipt {
  /** One-based physical line of the first discarded line: a non-record line or the start of the invalid suffix. */
  first_invalid_line: number;
  /** UTF-8 bytes removed, counting non-record lines and the invalid suffix. */
  discarded_bytes: number;
  /** SHA-256 of the removed bytes, concatenated in file order, for local backup comparison. */
  discarded_sha256: string;
  /** Number of complete verified records retained. */
  retained_entries: number;
  /** Lines removed before the invalid suffix because their JSON value (null, a boolean or a number) cannot hold a record; absent when none. */
  non_record_lines?: number;
}

/** One salvage decision for a physical line. */
type SalvageLine =
  | { kind: "record"; entry: HistoryEntry }
  | { kind: "invalid" }
  | { kind: "non_record" };

/** Decode a whole record or identify a disposable line without hiding a valid record. */
function decodeSalvageLine(line: string): SalvageLine {
  // Judge the same trimmed text the shared reader parses (it drops a BOM and
  // surrounding whitespace); the caller keeps the original bytes and offsets.
  const text = line.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // A complete record followed by crash padding is not a disposable line.
    // Refuse instead of silently dropping that record along with the padding.
    if (text.startsWith("{") && text.includes("}")) {
      throw new PmCliError(
        "History salvage cannot discard a potentially complete record with trailing corruption.",
        EXIT_CODE.CONFLICT,
        { code: "history_salvage_refused" },
      );
    }
    return { kind: "invalid" };
  }
  // A JSON null, boolean or number cannot encode a record, so removing it
  // conceals nothing; a string, array or partial object might, so it refuses.
  if (isNonRecordScalar(parsed)) return { kind: "non_record" };
  if (describeHistoryRecordDefect(parsed) !== null) {
    throw new PmCliError(
      "History salvage would conceal interior corruption or a malformed record.",
      EXIT_CODE.CONFLICT,
      {
        code: "history_salvage_refused",
        required:
          "Recover the damaged record from version control or a backup; no bytes were changed.",
      },
    );
  }
  const entry = parsed as Partial<HistoryEntry>;
  if (
    !Array.isArray(entry.patch) ||
    ![
      entry.ts,
      entry.author,
      entry.op,
      entry.before_hash,
      entry.after_hash,
    ].every((field) => typeof field === "string")
  ) {
    throw new PmCliError(
      "History salvage requires complete history records before the invalid tail.",
      EXIT_CODE.CONFLICT,
      { code: "history_salvage_refused" },
    );
  }
  return { kind: "record", entry: entry as HistoryEntry };
}

/** The newest epoch a retained record declares, for a stream whose chain does not verify. */
function newestDeclaredEpoch(entries: readonly HistoryEntry[]): HistoryItemHashVersion | undefined {
  return [...entries].reverse().find((entry) =>
    (SUPPORTED_HISTORY_ITEM_HASH_VERSIONS as readonly unknown[]).includes(entry.item_hash_version),
  )?.item_hash_version as HistoryItemHashVersion | undefined;
}

/**
 * Select the records to keep. Discarding an invalid suffix requires a
 * hash-verified prefix, because truncation must not cut a chain whose damage
 * it cannot see. Removing only lines that cannot hold a record conceals
 * nothing, so it keeps a chain that does not verify and reports the verdict:
 * the chain fault is left to history-repair (pm-rpucvb). Any parseable JSON
 * after the first invalid line makes the corruption interior and therefore
 * unsalvageable by truncation.
 */
export function inspectHistoryTail(raw: string): {
  entries: HistoryEntry[];
  prefix: string;
  receipt: HistorySalvageReceipt | null;
  /** Epoch for the audit record; undefined keeps an implicit stream implicit. */
  itemHashVersion: HistoryItemHashVersion | undefined;
  /** Chain verdict for the retained records. */
  verification: { ok: boolean; errors: string[] };
} {
  if (findFirstMergeConflictMarker(raw)) {
    throw new PmCliError(
      "Resolve history merge conflicts before salvage.",
      EXIT_CODE.CONFLICT,
      { code: "history_salvage_refused" },
    );
  }
  const scan = scanSalvageLines(raw);
  const judged = judgeRetainedChain(scan);
  return {
    entries: scan.entries,
    ...judged,
    ...selectSalvagedBytes(raw, scan.nonRecord, scan.invalidOffset, scan.invalidLine, scan.entries.length),
  };
}

/** Line-level salvage decisions for one stream. */
interface SalvageScan {
  entries: HistoryEntry[];
  nonRecord: Array<{ start: number; end: number; line: number }>;
  invalidOffset: number | undefined;
  invalidLine: number;
}

/** Classify every physical line; a record after the first invalid line refuses. */
function scanSalvageLines(raw: string): SalvageScan {
  const scan: SalvageScan = { entries: [], nonRecord: [], invalidOffset: undefined, invalidLine: 0 };
  let offset = 0;
  for (const [index, line] of raw.split("\n").entries()) {
    const start = offset;
    offset += line.length + 1;
    if (!line.trim()) continue;
    const decoded = decodeSalvageLine(line);
    if (decoded.kind === "record") {
      if (scan.invalidOffset !== undefined) {
        throw new PmCliError(
          "History salvage would discard a record or conceal interior corruption.",
          EXIT_CODE.CONFLICT,
          {
            code: "history_salvage_refused",
            required:
              "Recover the damaged record from version control or a backup; no bytes were changed.",
          },
        );
      }
      scan.entries.push(decoded.entry);
    } else if (decoded.kind === "non_record" && scan.invalidOffset === undefined) {
      scan.nonRecord.push({ start, end: Math.min(offset, raw.length), line: index + 1 });
    } else if (scan.invalidOffset === undefined) {
      scan.invalidOffset = start;
      scan.invalidLine = index + 1;
    }
  }
  return scan;
}

/**
 * Judge the retained records. Discarding an invalid suffix needs a verified
 * chain; removing only non-record lines keeps whatever chain remains.
 */
function judgeRetainedChain(scan: SalvageScan): {
  itemHashVersion: HistoryItemHashVersion | undefined;
  verification: { ok: boolean; errors: string[] };
} {
  const verification = verifyHistoryChainWithVersion(scan.entries);
  const verified = verification.ok && verification.item_hash_version !== undefined;
  const removesOnlyNonRecordLines = scan.invalidOffset === undefined && scan.nonRecord.length > 0;
  if (!removesOnlyNonRecordLines && (scan.entries.length === 0 || !verified)) {
    const nothingToDiscard = scan.entries.length > 0 && scan.invalidOffset === undefined;
    throw new PmCliError(
      "History salvage requires a nonempty verified prefix.",
      EXIT_CODE.CONFLICT,
      {
        code: "history_salvage_refused",
        verification_errors: verification.errors,
        required:
          "Recover an intact history prefix from version control or a backup.",
        ...(nothingToDiscard
          ? { nextSteps: ["Run pm history-repair <id> --append-only --dry-run: salvage has nothing to discard, and the chain needs a repair."] }
          : {}),
      },
    );
  }
  return {
    itemHashVersion: verified ? verification.item_hash_version : newestDeclaredEpoch(scan.entries),
    verification: { ok: verification.ok, errors: verification.errors },
  };
}

/** The digest the salvage record anchors with; a digest this pm cannot compute refuses typed. */
function salvageHashAlgorithm(last: HistoryEntry): ReturnType<typeof resolveHistoryHashAlgorithm> {
  try {
    return resolveHistoryHashAlgorithm(last.hash_algorithm);
  } catch {
    // A well-formed unknown label may come from a newer pm; any other label is damage an upgrade cannot fix.
    const unknownLabel = typeof (last.hash_algorithm as unknown) === "string";
    throw new PmCliError(
      unknownLabel
        ? "History salvage cannot anchor its record: the last kept record uses a digest algorithm this pm version cannot compute."
        : "History salvage cannot anchor its record: the last kept record's digest label is malformed.",
      EXIT_CODE.CONFLICT,
      {
        code: "history_salvage_refused",
        required: unknownLabel
          ? "Upgrade pm to a version that reads the stream's digest algorithm; no bytes were changed."
          : "Recover the damaged record from version control or a backup; no bytes were changed.",
        nextSteps: [
          unknownLabel
            ? "Run npm install -g @unbrained/pm-cli@latest, then preview the salvage again."
            : "Run pm history <id> --verify --full to locate the record, then restore the stream from version control or a backup.",
        ],
      },
    );
  }
}

/**
 * The kept bytes plus a `history_salvage` record anchored on the last kept
 * record. A stream left without a record has nothing to anchor on, so it is
 * written as kept and the result names the rebuild (pm-3os5p6).
 */
function salvagedStream(
  selected: ReturnType<typeof inspectHistoryTail>,
  author: string,
  message: string | undefined,
): string {
  const last = selected.entries.at(-1);
  if (last === undefined) return selected.prefix;
  // The no-op record's patch is empty and its anchors are the last kept record's, so it is built
  // from the canonical empty document: unverified legacy metadata is never canonicalized here.
  // createHistoryEntry stamps the current epoch; the record keeps the stream's own, or none.
  const empty = EMPTY_CANONICAL_DOCUMENT as unknown as ItemDocument;
  const { item_hash_version: _stamped, ...entry } = createHistoryEntry({
    hashAlgorithm: salvageHashAlgorithm(last),
    nowIso: nowIso(),
    author,
    op: "history_salvage",
    before: empty,
    after: empty,
    message,
    context: { history_salvage: selected.receipt },
  });
  const audit = sealHistoryRecord({
    ...entry,
    before_hash: last.after_hash,
    after_hash: last.after_hash,
    ...(selected.itemHashVersion === undefined ? {} : { item_hash_version: selected.itemHashVersion }),
  });
  return `${selected.prefix}${JSON.stringify(audit)}\n`;
}

/** Refuse a stream whose replay names another item at any state, before a later delete could erase it. */
function assertSalvageIdentity(id: string, replay: ReplayDocument): void {
  if (typeof replay.metadata.id === "string" && replay.metadata.id !== id) {
    throw new PmCliError(
      "History belongs to another item; salvage refused.",
      EXIT_CODE.CONFLICT,
      { code: "history_salvage_refused" },
    );
  }
}

/**
 * Replay the retained records and check the item identity at every state.
 * A chain that verifies uses strict replay for the final document; one that
 * does not replays leniently.
 */
function replayRetainedRecords(
  id: string,
  selected: ReturnType<typeof inspectHistoryTail>,
): { final: ReplayDocument; lastItem: ReplayDocument } {
  const strict = selected.verification.ok;
  let replay = cloneEmptyReplayDocument();
  // A deleted item replays to the empty document; its ownership is the last state that held the item.
  let lastItem = replay;
  for (const entry of selected.entries) {
    // A verified chain is judged on the states its readers replay; only a broken one replays leniently.
    const applied = strict ? tryApplyReplayPatch(replay, entry.patch) : undefined;
    replay = applied?.ok === true ? applied.document : lenientApplyReplayPatch(replay, entry.patch, entry.op).document;
    assertSalvageIdentity(id, replay);
    if (Object.keys(replay.metadata).length > 0) lastItem = replay;
  }
  if (strict && selected.entries.length > 0) {
    return { final: replayHistoryToTarget(selected.entries, selected.entries.length - 1), lastItem };
  }
  return { final: replay, lastItem };
}

/** Bytes kept and the receipt for those removed: non-record lines plus the invalid suffix. */
function selectSalvagedBytes(
  raw: string,
  nonRecord: ReadonlyArray<{ start: number; end: number; line: number }>,
  invalidOffset: number | undefined,
  invalidLine: number,
  retainedEntries: number,
): { prefix: string; receipt: HistorySalvageReceipt | null } {
  const retainedEnd = invalidOffset ?? raw.length;
  const discarded = [
    ...nonRecord.map(({ start, end }) => raw.slice(start, end)),
    raw.slice(retainedEnd),
  ].join("");
  let prefix = "";
  let cursor = 0;
  for (const { start, end } of nonRecord) {
    prefix += raw.slice(cursor, start);
    cursor = end;
  }
  prefix += raw.slice(cursor, retainedEnd);
  // A removed final line can leave the last kept record without its newline.
  if (prefix !== "" && !prefix.endsWith("\n")) prefix += "\n";
  if (discarded === "") return { prefix, receipt: null };
  return {
    prefix,
    receipt: {
      first_invalid_line: nonRecord[0]?.line ?? invalidLine,
      discarded_bytes: Buffer.byteLength(discarded),
      discarded_sha256: sha256Hex(discarded),
      retained_entries: retainedEntries,
      ...(nonRecord.length > 0 ? { non_record_lines: nonRecord.length } : {}),
    },
  };
}

/**
 * A leniently replayed owner can hold any JSON value. A non-string owner
 * cannot be compared, and treating it as unassigned would skip the ownership
 * check, so it refuses typed unless --force overrides ownership.
 */
function assertJudgeableSalvageOwner(id: string, document: ItemDocument, force: boolean): void {
  const assignee: unknown = document.metadata?.assignee;
  if (force || assignee === undefined || assignee === null || typeof assignee === "string") return;
  throw new PmCliError(
    `The recorded owner of ${id} is not a name, so salvage cannot check ownership.`,
    EXIT_CODE.CONFLICT,
    {
      code: "history_salvage_refused",
      item_id: id,
      reason: "owner_malformed",
      required: "Recover the damaged record from version control or a backup, or override ownership deliberately; no bytes were changed.",
      nextSteps: [
        `Run pm history ${id} --verify --full to locate the record, then restore the stream, or rerun the salvage with --force to override ownership.`,
      ],
    },
  );
}

/** Prefer the live item's owner; history supplies ownership only when its file is unreadable. */
async function readSalvageOwnership(
  located: HistorySubject["located"],
  settings: PmSettings,
  fallback: ItemDocument,
) {
  if (!located) return { itemRaw: null, document: fallback, live: null };
  const snapshot = await readLocatedItemSnapshot(located, {
    schema: settings.schema,
  });
  return { itemRaw: snapshot.raw, document: snapshot.document ?? fallback, live: snapshot.document };
}

/**
 * Judge declared revisions against the live item (pm-gh1576): an unreadable live
 * file matches none, and with no live file the tombstone is the revision reads report.
 */
function assertSalvageRevision(pmRoot: string, id: string, ownership: Awaited<ReturnType<typeof readSalvageOwnership>>): ItemDocument {
  if (ownership.itemRaw !== null && ownership.live === null) assertItemRevisionExpectationsOnUnreadable(pmRoot, id, ownership.itemRaw);
  const live = ownership.live ?? (EMPTY_CANONICAL_DOCUMENT as unknown as ItemDocument);
  assertItemMutationPreconditions(pmRoot, live, id);
  return live;
}

/** Refuse lossy decoding so suffix receipts and rollback always describe original bytes. */
async function readSalvageStream(historyPath: string): Promise<string | null> {
  let bytes: Buffer;
  try {
    bytes = await readFile(historyPath);
  } catch (error) {
    if (isFileMissingError(error)) return null;
    throw error;
  }
  if (!isUtf8(bytes)) {
    throw new PmCliError(
      "History salvage requires UTF-8 input; recover binary corruption from a byte-preserving backup.",
      EXIT_CODE.CONFLICT,
      { code: "history_salvage_refused" },
    );
  }
  return bytes.toString("utf8");
}

/** Salvage one explicitly selected stream under its normal ownership and lock policy. */
export async function salvageHistoryTail(params: {
  pmRoot: string;
  subject: HistorySubject;
  settings: PmSettings;
  typeRegistry: ItemTypeRegistry;
  options: HistoryRepairCommandOptions;
  author: string;
}): Promise<HistoryRepairResult> {
  const { subject, settings, options, author } = params;
  if (
    [
      options.normalizeProvenance,
      options.auditOperation,
      options.auditContext,
      options.auditContextById,
      options.forceAuditEntry,
      options.mergeReceiptProof,
      options.mergeReceiptProofById,
    ].some(Boolean)
  ) {
    throw new PmCliError(
      "Tail salvage cannot be combined with other repair modes.",
      EXIT_CODE.USAGE,
    );
  }
  const raw = await readSalvageStream(subject.historyPath);
  if (raw === null)
    throw new PmCliError(
      `No history stream exists for ${subject.id}.`,
      EXIT_CODE.NOT_FOUND,
    );
  await runActiveOnReadHooks({ path: subject.historyPath, scope: "project" });
  const selected = inspectHistoryTail(raw);
  const replayed = replayRetainedRecords(subject.id, selected);
  const document = replayToItemDocument(replayed.final);
  // Plan the salvaged stream now, so a preview refuses exactly where the write would; nothing to remove plans nothing.
  const nextHistoryRaw = selected.receipt === null ? raw : salvagedStream(selected, author, options.message);
  const ownership = await readSalvageOwnership(subject.located, settings, replayToItemDocument(replayed.lastItem));
  assertJudgeableSalvageOwner(subject.id, ownership.document, options.force === true);
  const warnings = checkHistoryRewriteOwnership({
    itemDocument: ownership.document,
    subjectId: subject.id,
    author,
    force: options.force,
    settings,
  });
  const dryRun = options.dryRun === true;
  const changed = selected.receipt !== null;
  if (changed && !dryRun) {
    const release = await acquireLock(
      params.pmRoot,
      subject.id,
      settings.locks.ttl_seconds,
      author,
      Boolean(options.force),
      settings.governance.force_required_for_stale_lock,
      settings.locks.wait_ms,
    );
    try {
      const currentRaw = await readSalvageStream(subject.historyPath);
      const located = await locateItem(
        params.pmRoot,
        subject.id,
        settings.id_prefix,
        settings.item_format,
        params.typeRegistry.type_to_folder,
      );
      const currentItem = located
        ? await readFileIfExists(located.itemPath)
        : null;
      if (currentRaw !== raw || currentItem !== ownership.itemRaw) {
        // A peer moved the item while this salvage waited: a stale declared revision refuses typed first.
        // Read the item where it is now: a peer may have moved, deleted or restored it during the wait.
        assertSalvageRevision(params.pmRoot, subject.id, await readSalvageOwnership(located, settings, document));
        throw new PmCliError(
          "History or item changed while waiting for salvage lock; retry.",
          EXIT_CODE.CONFLICT,
        );
      }
      const live = assertSalvageRevision(params.pmRoot, subject.id, ownership);
      await writeHistoryRawWithRollback({
        historyPath: subject.historyPath,
        historyRawUnderLock: raw,
        nextHistoryRaw,
      });
      // The item document is unchanged; advancing records this scope's committed write.
      advanceItemMutationPreconditions(params.pmRoot, live, subject.id);
      warnings.push(
        ...(await runActiveOnWriteHooks({
          path: subject.historyPath,
          scope: "project",
          op: "history_salvage:history",
        })),
      );
    } finally {
      await release();
    }
  }
  return reportSalvage(subject, selected, { changed, dryRun, warnings });
}

/** Name the repair a salvaged stream still needs: a chain repair, or a rebuild of a stream left without a record. */
function salvageFollowUp(subject: HistorySubject, selected: ReturnType<typeof inspectHistoryTail>): string[] {
  if (selected.entries.length === 0) {
    return subject.located === null ? [] : [`history_stream_empty:${subject.id}:run pm history-repair ${subject.id}`];
  }
  // Health previews both repairs to choose; the append-only refusal itself names the rewriting preview.
  return selected.verification.ok
    ? []
    : [`history_chain_unverified:${subject.id}:run pm history-repair ${subject.id} --append-only --dry-run, or pm history-repair ${subject.id} --dry-run when a bridge refuses`];
}

/** Render the public repair result for a salvage preview or application. */
function reportSalvage(
  subject: HistorySubject,
  selected: ReturnType<typeof inspectHistoryTail>,
  outcome: { changed: boolean; dryRun: boolean; warnings: string[] },
): HistoryRepairResult {
  const version = selected.itemHashVersion;
  const { ok, errors } = selected.verification;
  return {
    id: subject.id,
    dry_run: outcome.dryRun,
    changed: outcome.changed,
    history: {
      path: subject.historyPath,
      entries_scanned: selected.entries.length,
      chain_drift_before: !ok,
      entries_rehashed: 0,
      entries_patch_repaired: 0,
      converted_replace_to_add: 0,
      skipped_ops: 0,
      reconciled_with_item: false,
      audit_entry_added: outcome.changed && !outcome.dryRun && selected.entries.length > 0,
      verify_ok: ok,
      verify_errors: errors,
      item_hash_version_before: version ?? null,
      // A stream that declares no epoch stays on the legacy epoch 1.
      item_hash_version_after: version ?? 1,
      version_disposition: "preserved",
    },
    item: {
      exists: subject.located !== null,
      path: subject.located?.itemPath ?? null,
      matched_chain_before: null,
    },
    provenance_normalization: {
      requested: false,
      changed: false,
      events_changed: 0,
      observations_removed: 0,
      invalid_values: [],
    },
    ...(selected.receipt ? { salvage: selected.receipt } : {}),
    // The fault salvage leaves is named with the repair that fixes it (pm-rpucvb, pm-3os5p6).
    warnings: [...outcome.warnings, ...salvageFollowUp(subject, selected)],
    generated_at: nowIso(),
  };
}
