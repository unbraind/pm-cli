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
  /** Scalar-conflict selection contract used by the item driver. */
  conflict_resolution: "preferred_side" | "stable_value_order";
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
  /** Whether decision values are recoverable locally or represented by hashes only. */
  value_availability?: "clone_local" | "hash_only";
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
  /** Scalar-conflict selection contract used by the item driver. */
  conflict_resolution: "preferred_side" | "stable_value_order";
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
      [
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        "pm-merge-receipts",
      ],
      { cwd, encoding: "utf8", windowsHide: true, timeout: 10_000 },
    );
    return stdout.trim();
  } catch {
    return null;
  }
}

async function resolveTrackerRootFromItemPath(
  cwd: string,
  itemPath: string,
): Promise<string | null> {
  let directory = path.dirname(path.resolve(cwd, itemPath));
  for (let depth = 0; depth < 12; depth += 1) {
    if (await pathExists(path.join(directory, "settings.json")))
      return directory;
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return null;
}

function durableReceiptDirectory(pmRoot: string): string {
  return path.join(pmRoot, "merge-receipts");
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
    conflict_resolution: receipt.conflict_resolution,
    decisions: receipt.decisions.map((decision) => ({
      field: decision.field,
      retained_hash:
        isPrehashedValue(decision.retained) ??
        sha256Hex(stableStringify(decision.retained)),
      discarded_hash:
        isPrehashedValue(decision.discarded) ??
        sha256Hex(stableStringify(decision.discarded)),
    })),
  };
}

function isPrehashedValue(value: unknown): string | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("pm_value_hash" in value)
  ) {
    return undefined;
  }
  const hash = value.pm_value_hash;
  return typeof hash === "string" && /^[a-f0-9]{64}$/u.test(hash)
    ? hash
    : undefined;
}

/** Persist one item-driver outcome in the clone-local Git directory. */
export async function writeMergeReceipt(params: {
  cwd: string;
  itemPath: string;
  preferred: MergePreferredSide;
  conflictResolution?: "preferred_side" | "stable_value_order";
  fieldsFromTheirs: string[];
  unionFields: string[];
  decisions: ItemMergeConflictDecision[];
}): Promise<MergeDecisionReceipt | null> {
  const directory = await resolveReceiptDirectory(params.cwd);
  if (directory === null) {
    return null;
  }
  const trimmedItemPath = params.itemPath.trim();
  const itemPath =
    trimmedItemPath.length >= 2 &&
    ((trimmedItemPath.startsWith("'") && trimmedItemPath.endsWith("'")) ||
      (trimmedItemPath.startsWith('"') && trimmedItemPath.endsWith('"')))
      ? trimmedItemPath.slice(1, -1)
      : trimmedItemPath;
  const itemId = path.basename(itemPath, path.extname(itemPath));
  const receipt: MergeDecisionReceipt = {
    version: 1,
    id: randomUUID(),
    item_path: itemPath.replaceAll("\\", "/"),
    item_id: itemId,
    preferred: params.preferred,
    conflict_resolution: params.conflictResolution ?? "preferred_side",
    fields_from_theirs: [...params.fieldsFromTheirs],
    union_fields: [...params.unionFields],
    decisions: structuredClone(params.decisions),
    state: "pending",
    created_at: nowIso(),
    value_availability: "clone_local",
  };
  await ensureDir(directory);
  await writeFileAtomic(
    path.join(directory, receiptFileName(receipt.id)),
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
  const trackerRoot = await resolveTrackerRootFromItemPath(
    params.cwd,
    receipt.item_path,
  );
  if (trackerRoot !== null) {
    const durableDirectory = durableReceiptDirectory(trackerRoot);
    const summary = summarizeMergeReceipt(receipt);
    const durableReceipt: MergeDecisionReceipt = {
      ...receipt,
      decisions: summary.decisions.map((decision) => ({
        field: decision.field,
        base: null,
        ours: null,
        theirs: null,
        retained: { pm_value_hash: decision.retained_hash },
        discarded: { pm_value_hash: decision.discarded_hash },
      })),
      value_availability: "hash_only",
    };
    await ensureDir(durableDirectory);
    await writeFileAtomic(
      path.join(durableDirectory, receiptFileName(receipt.id)),
      `${JSON.stringify(durableReceipt, null, 2)}\n`,
    );
  }
  return receipt;
}

async function readReceiptsFromDirectory(
  directory: string,
  options: { includeReconciled?: boolean; includeLossless?: boolean },
): Promise<MergeDecisionReceipt[]> {
  if (!(await pathExists(directory))) return [];
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return [];
  }
  const receipts: MergeDecisionReceipt[] = [];
  for (const name of names.sort((left, right) => left.localeCompare(right))) {
    if (!name.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(
        await readFile(path.join(directory, name), "utf8"),
      ) as MergeDecisionReceipt;
      const normalizedReceipt: MergeDecisionReceipt = {
        ...parsed,
        conflict_resolution: parsed.conflict_resolution ?? "preferred_side",
      };
      if (
        normalizedReceipt.version === 1 &&
        (options.includeReconciled || normalizedReceipt.state === "pending") &&
        (options.includeLossless !== false ||
          normalizedReceipt.decisions.length > 0)
      ) {
        receipts.push(normalizedReceipt);
      }
    } catch {
      // Malformed evidence remains an integrity concern for a future schema.
    }
  }
  return receipts;
}

/** Read clone-local receipts with explicit reconciled/lossless classification controls. */
export async function listMergeReceipts(
  cwd: string,
  options: {
    includeReconciled?: boolean;
    includeLossless?: boolean;
    pmRoot?: string;
  } = {},
): Promise<MergeDecisionReceipt[]> {
  const directory = await resolveReceiptDirectory(cwd);
  const local =
    directory === null
      ? []
      : await readReceiptsFromDirectory(directory, options);
  const trackerRoot = options.pmRoot ?? path.join(cwd, ".agents", "pm");
  const durable = await readReceiptsFromDirectory(
    durableReceiptDirectory(trackerRoot),
    options,
  );
  const receipts = new Map(durable.map((receipt) => [receipt.id, receipt]));
  for (const receipt of local) receipts.set(receipt.id, receipt);
  return [...receipts.values()].sort((left, right) =>
    left.created_at.localeCompare(right.created_at),
  );
}

/** Split merge provenance into receipts with discarded values and receipts whose composition was lossless. */
export function partitionMergeReceipts(receipts: MergeDecisionReceipt[]): {
  /** Receipts that require an explicit decision because at least one competing scalar value was discarded. */
  pendingDecisions: MergeDecisionReceipt[];
  /** Receipts that record provenance without a discarded competing scalar value. */
  lossless: MergeDecisionReceipt[];
} {
  const pendingDecisions: MergeDecisionReceipt[] = [];
  const lossless: MergeDecisionReceipt[] = [];
  for (const receipt of receipts) {
    (Array.isArray(receipt.decisions) && receipt.decisions.length > 0
      ? pendingDecisions
      : lossless
    ).push(receipt);
  }
  return { pendingDecisions, lossless };
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
  const trackerRoot = await resolveTrackerRootFromItemPath(
    cwd,
    receipt.item_path,
  );
  if (trackerRoot !== null) {
    const durablePath = path.join(
      durableReceiptDirectory(trackerRoot),
      receiptFileName(receipt.id),
    );
    if (await pathExists(durablePath)) {
      const durable = JSON.parse(
        await readFile(durablePath, "utf8"),
      ) as MergeDecisionReceipt;
      await writeFileAtomic(
        durablePath,
        `${JSON.stringify({ ...durable, state: "reconciled", reconciled_at: nowIso() }, null, 2)}\n`,
      );
    }
  }
}

/** Report pending or historical clone-local merge decisions. */
export async function runMergeReceiptReport(options: {
  /** Include receipts already represented by merge history events. */
  includeReconciled?: boolean;
  /** Repository directory to inspect; defaults to the process working directory. */
  cwd?: string;
}): Promise<MergeReceiptReport> {
  const receipts = await listMergeReceipts(options.cwd ?? process.cwd(), {
    ...options,
    includeLossless: true,
  });
  return {
    ok: true,
    count: receipts.length,
    receipts,
    generated_at: nowIso(),
  };
}
