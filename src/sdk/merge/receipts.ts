/**
 * @module sdk/merge/receipts
 *
 * Stores recoverable merge decisions below the clone-local Git directory.
 * Raw losing values deliberately never enter the public tracker history; the
 * history entry records hashes and provenance while this receipt preserves the
 * value for the coordinator that performed the merge.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  ensureDir,
  pathExists,
  writeFileAtomic,
} from "../../core/fs/fs-utils.js";
import { sha256Hex, stableStringify } from "../../core/shared/serialization.js";
import { nowIso } from "../../core/shared/time.js";
import type {
  ItemMergeConflictDecision,
  MergePreferredSide,
} from "./three-way.js";

const execFileAsync = promisify(execFile);

/** One clone-local merge receipt with recoverable branch values. */
export interface MergeDecisionReceipt {
  /** Receipt schema version. */
  version: 1;
  /** Opaque receipt identity referenced from public history. */
  id: string;
  /** Repository-relative item path supplied by Git as `%P`. */
  item_path: string;
  /** Item id derived from the merged document path. */
  item_id: string;
  /** Preferred side used for scalar conflicts. */
  preferred: MergePreferredSide;
  /** Fields selected cleanly from the other branch. */
  fields_from_theirs: string[];
  /** Collections combined from both branches. */
  union_fields: string[];
  /** Full recoverable scalar decisions, retained only in the clone. */
  decisions: ItemMergeConflictDecision[];
  /** Whether a merge reconciliation history event consumed this receipt. */
  state: "pending" | "reconciled";
  /** Receipt creation timestamp. */
  created_at: string;
  /** Reconciliation timestamp, when consumed. */
  reconciled_at?: string;
}

/** Privacy-safe receipt summary suitable for committed history context. */
export interface MergeDecisionReceiptSummary {
  /** Opaque clone-local receipt identity. */
  receipt_id: string;
  /** Item whose merge produced the receipt. */
  item_id: string;
  /** Repository-relative item path. */
  item_path: string;
  /** Scalar fields that required a preferred-side decision. */
  conflict_fields: string[];
  /** Fields selected cleanly from the other branch. */
  fields_from_theirs: string[];
  /** Collections combined from both branches. */
  union_fields: string[];
  /** Preferred side used for scalar conflicts. */
  preferred: MergePreferredSide;
  /** Hashes proving the retained and discarded values without publishing them. */
  decisions: Array<{
    field: string;
    retained_hash: string;
    discarded_hash: string;
  }>;
}

/** Structured result for the explicit clone-local merge report command. */
export interface MergeReceiptReport {
  /** Whether the report was read successfully. */
  ok: true;
  /** Number of receipts returned. */
  count: number;
  /** Receipts including recoverable values from the local clone only. */
  receipts: MergeDecisionReceipt[];
  /** ISO timestamp for the report. */
  generated_at: string;
}

async function resolveReceiptDirectory(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-path", "pm-merge-receipts"],
      { cwd, encoding: "utf8", windowsHide: true, timeout: 10_000 },
    );
    return stdout.trim();
  } catch {
    return null;
  }
}

function receiptFileName(id: string): string {
  return `${id}.json`;
}

/** Convert a raw receipt into privacy-safe history context. */
export function summarizeMergeReceipt(
  receipt: MergeDecisionReceipt,
): MergeDecisionReceiptSummary {
  return {
    receipt_id: receipt.id,
    item_id: receipt.item_id,
    item_path: receipt.item_path,
    conflict_fields: receipt.decisions.map((decision) => decision.field),
    fields_from_theirs: receipt.fields_from_theirs,
    union_fields: receipt.union_fields,
    preferred: receipt.preferred,
    decisions: receipt.decisions.map((decision) => ({
      field: decision.field,
      retained_hash: sha256Hex(stableStringify(decision.retained)),
      discarded_hash: sha256Hex(stableStringify(decision.discarded)),
    })),
  };
}

/** Persist one item-driver outcome in the clone-local Git directory. */
export async function writeMergeReceipt(params: {
  cwd: string;
  itemPath: string;
  preferred: MergePreferredSide;
  fieldsFromTheirs: string[];
  unionFields: string[];
  decisions: ItemMergeConflictDecision[];
}): Promise<MergeDecisionReceipt | null> {
  const directory = await resolveReceiptDirectory(params.cwd);
  if (directory === null) {
    return null;
  }
  const itemId = path.basename(params.itemPath, path.extname(params.itemPath));
  const receipt: MergeDecisionReceipt = {
    version: 1,
    id: randomUUID(),
    item_path: params.itemPath.replaceAll("\\", "/"),
    item_id: itemId,
    preferred: params.preferred,
    fields_from_theirs: [...params.fieldsFromTheirs],
    union_fields: [...params.unionFields],
    decisions: structuredClone(params.decisions),
    state: "pending",
    created_at: nowIso(),
  };
  await ensureDir(directory);
  await writeFileAtomic(
    path.join(directory, receiptFileName(receipt.id)),
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
  return receipt;
}

/** Read all clone-local receipts, optionally including reconciled history. */
export async function listMergeReceipts(
  cwd: string,
  options: { includeReconciled?: boolean } = {},
): Promise<MergeDecisionReceipt[]> {
  const directory = await resolveReceiptDirectory(cwd);
  if (directory === null || !(await pathExists(directory))) {
    return [];
  }
  const receipts: MergeDecisionReceipt[] = [];
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return [];
  }
  for (const name of names.sort((left, right) => left.localeCompare(right))) {
    if (!name.endsWith(".json")) {
      continue;
    }
    try {
      const parsed = JSON.parse(
        await readFile(path.join(directory, name), "utf8"),
      ) as MergeDecisionReceipt;
      if (
        parsed.version === 1 &&
        (options.includeReconciled || parsed.state === "pending")
      ) {
        receipts.push(parsed);
      }
    } catch {
      // A damaged clone-local receipt is reported by merge report through the
      // omitted count once a future schema version adds richer diagnostics.
    }
  }
  return receipts.sort((left, right) =>
    left.created_at.localeCompare(right.created_at),
  );
}

/** Mark a receipt as represented by a committed merge history event. */
export async function markMergeReceiptReconciled(
  cwd: string,
  receipt: MergeDecisionReceipt,
): Promise<void> {
  const directory = await resolveReceiptDirectory(cwd);
  if (directory === null) {
    return;
  }
  await writeFileAtomic(
    path.join(directory, receiptFileName(receipt.id)),
    `${JSON.stringify(
      { ...receipt, state: "reconciled", reconciled_at: nowIso() },
      null,
      2,
    )}\n`,
  );
}

/** Report pending or historical clone-local merge decisions. */
export async function runMergeReceiptReport(options: {
  /** Include receipts already represented by merge history events. */
  includeReconciled?: boolean;
  /** Repository directory to inspect; defaults to the process working directory. */
  cwd?: string;
}): Promise<MergeReceiptReport> {
  const receipts = await listMergeReceipts(options.cwd ?? process.cwd(), options);
  return {
    ok: true,
    count: receipts.length,
    receipts,
    generated_at: nowIso(),
  };
}
