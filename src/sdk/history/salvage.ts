/**
 * @module sdk/history/salvage
 * Recover an invalid JSONL suffix while preserving every verified prefix byte.
 */
import { isUtf8 } from "node:buffer";
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
  replayToItemDocument,
  verifyHistoryChainWithVersion,
} from "../../core/history/replay.js";
import { findFirstMergeConflictMarker } from "../../core/shared/conflict-markers.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
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

/** Evidence describing only the discarded suffix, without retaining its contents. */
export interface HistorySalvageReceipt {
  /** One-based physical line where invalid trailing bytes begin. */
  first_invalid_line: number;
  /** UTF-8 bytes removed from the suffix. */
  discarded_bytes: number;
  /** SHA-256 of the removed bytes for local backup comparison. */
  discarded_sha256: string;
  /** Number of complete verified records retained. */
  retained_entries: number;
}

/** Decode a whole record or identify an invalid suffix without hiding a valid record. */
function decodeSalvageLine(line: string): HistoryEntry | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    // A complete record followed by crash padding is not a disposable line.
    // Refuse instead of silently dropping that record along with the padding.
    if (line.trimStart().startsWith("{") && line.includes("}")) {
      throw new PmCliError(
        "History salvage cannot discard a potentially complete record with trailing corruption.",
        EXIT_CODE.CONFLICT,
        { code: "history_salvage_refused" },
      );
    }
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new PmCliError(
      "History salvage would conceal interior corruption or a malformed record.",
      EXIT_CODE.CONFLICT,
      { code: "history_salvage_refused" },
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
  return entry as HistoryEntry;
}

/**
 * Select a hash-verified prefix. Any parseable JSON after the first invalid
 * line makes the corruption interior and therefore unsalvageable by truncation.
 */
export function inspectHistoryTail(raw: string): {
  entries: HistoryEntry[];
  prefix: string;
  receipt: HistorySalvageReceipt | null;
  itemHashVersion: HistoryItemHashVersion;
} {
  if (findFirstMergeConflictMarker(raw)) {
    throw new PmCliError(
      "Resolve history merge conflicts before salvage.",
      EXIT_CODE.CONFLICT,
      { code: "history_salvage_refused" },
    );
  }
  const entries: HistoryEntry[] = [];
  let offset = 0;
  let invalidOffset: number | undefined;
  let invalidLine = 0;
  for (const [index, line] of raw.split("\n").entries()) {
    if (!line.trim()) {
      offset += line.length + 1;
      continue;
    }
    const parsed = decodeSalvageLine(line);
    if (parsed === null) {
      if (invalidOffset === undefined) {
        invalidOffset = offset;
        invalidLine = index + 1;
      }
      offset += line.length + 1;
      continue;
    }
    if (invalidOffset !== undefined) {
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
    entries.push(parsed);
    offset += line.length + 1;
  }
  const verification = verifyHistoryChainWithVersion(entries);
  if (!verification.ok || verification.item_hash_version === undefined) {
    throw new PmCliError(
      "History salvage requires a nonempty verified prefix.",
      EXIT_CODE.CONFLICT,
      {
        code: "history_salvage_refused",
        verification_errors: verification.errors,
        required:
          "Recover an intact history prefix from version control or a backup.",
      },
    );
  }
  return {
    entries,
    itemHashVersion: verification.item_hash_version,
    prefix: invalidOffset === undefined ? raw : raw.slice(0, invalidOffset),
    receipt:
      invalidOffset === undefined
        ? null
        : {
            first_invalid_line: invalidLine,
            discarded_bytes: Buffer.byteLength(raw.slice(invalidOffset)),
            discarded_sha256: sha256Hex(raw.slice(invalidOffset)),
            retained_entries: entries.length,
          },
  };
}

/** Prefer the live item's owner; history supplies ownership only when its file is unreadable. */
async function readSalvageOwnership(
  subject: HistorySubject,
  settings: PmSettings,
  fallback: ItemDocument,
) {
  if (!subject.located) return { itemRaw: null, document: fallback };
  const snapshot = await readLocatedItemSnapshot(subject.located, {
    schema: settings.schema,
  });
  return { itemRaw: snapshot.raw, document: snapshot.document ?? fallback };
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
  const replay = replayHistoryToTarget(
    selected.entries,
    selected.entries.length - 1,
  );
  const document = replayToItemDocument(replay);
  if (
    typeof replay.metadata.id === "string" &&
    replay.metadata.id !== subject.id
  ) {
    throw new PmCliError(
      "History belongs to another item; salvage refused.",
      EXIT_CODE.CONFLICT,
      { code: "history_salvage_refused" },
    );
  }
  const ownership = await readSalvageOwnership(subject, settings, document);
  const warnings = checkHistoryRewriteOwnership({
    itemDocument: ownership.document,
    subjectId: subject.id,
    author,
    force: options.force,
    settings,
  });
  const version = selected.itemHashVersion;
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
        throw new PmCliError(
          "History or item changed while waiting for salvage lock; retry.",
          EXIT_CODE.CONFLICT,
        );
      }
      const audit = sealHistoryRecord({
        ...createHistoryEntry({
          nowIso: nowIso(),
          author,
          op: "history_salvage",
          before: document,
          after: document,
          message: options.message,
          context: { history_salvage: selected.receipt },
        }),
        before_hash: selected.entries.at(-1)!.after_hash,
        after_hash: selected.entries.at(-1)!.after_hash,
        item_hash_version: version,
      });
      await writeHistoryRawWithRollback({
        historyPath: subject.historyPath,
        historyRawUnderLock: raw,
        nextHistoryRaw: `${selected.prefix}${JSON.stringify(audit)}\n`,
      });
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
  return {
    id: subject.id,
    dry_run: dryRun,
    changed,
    history: {
      path: subject.historyPath,
      entries_scanned: selected.entries.length,
      chain_drift_before: false,
      entries_rehashed: 0,
      entries_patch_repaired: 0,
      converted_replace_to_add: 0,
      skipped_ops: 0,
      reconciled_with_item: false,
      audit_entry_added: changed && !dryRun,
      verify_ok: true,
      verify_errors: [],
      item_hash_version_before: version,
      item_hash_version_after: version,
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
    warnings,
    generated_at: nowIso(),
  };
}
