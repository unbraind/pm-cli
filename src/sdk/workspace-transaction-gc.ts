/**
 * @module sdk/workspace-transaction-gc
 *
 * Age-based garbage collector for the durable SDK workspace-transaction
 * journals written by `commitWorkspaceTransaction` under
 * `transactions/sdk/<transactionId>.json`. Only terminal journals (status
 * `committed` or `compensated`) older than the configured retention are
 * pruned; in-flight journals (`applying`/`compensating`) are crash-recovery
 * state and are always retained, as are journals whose status or timestamp
 * cannot be read (safety-first, mirroring the checkpoint and stale-lock
 * sweeps). Transaction steps are contract-idempotent, so pruning a terminal
 * receipt only costs the ability to short-circuit an identical replay — it
 * never breaks correctness.
 */
import fs from "node:fs/promises";
import path from "node:path";

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
const TERMINAL_JOURNAL_STATUSES = new Set(["committed", "compensated"]);

/** Documents one journal-sweep decision row surfaced by the transaction GC. */
export interface WorkspaceTransactionGcEntry {
  /** Relative path like "transactions/sdk/<transactionId>.json". */
  file: string;
  /** Journal status read from the receipt, or null when unreadable. */
  status: string | null;
  /** Age in seconds derived from the journal's updatedAt, or null when unparseable. */
  age_seconds: number | null;
  /** Whether the journal was (or would be) pruned. */
  stale: boolean;
  /** Why the journal was retained, when it was. */
  reason?: "active" | "fresh" | "unparseable";
}

/** Extension hooks mirroring the checkpoint GC so reads/writes stay observable. */
export interface WorkspaceTransactionGcHooks {
  /** Invoked before reading each journal file. */
  onRead?: (absolutePath: string) => Promise<string[]>;
  /** Invoked after removing each journal file. */
  onWrite?: (absolutePath: string) => Promise<string[]>;
}

/** Documents the transaction GC options payload exchanged by command, SDK, and package integrations. */
export interface WorkspaceTransactionGcOptions {
  /** Preview prune decisions without deleting any journal. */
  dryRun: boolean;
  /** Prune terminal journals older than this many days. Negative values are clamped to zero; a non-finite value disables pruning entirely so bad input never deletes recovery receipts. */
  retentionDays: number;
  /** Clock override for deterministic tests (milliseconds since epoch). */
  now?: number;
  /** Extension observability hooks. */
  hooks?: WorkspaceTransactionGcHooks;
}

/** Documents the transaction GC result payload exchanged by command, SDK, and package integrations. */
export interface WorkspaceTransactionGcResult {
  /** Number of journal files scanned. */
  scanned: number;
  /** Relative paths of pruned journals. */
  removed: string[];
  /** Relative paths of retained journals. */
  retained: string[];
  /** Non-fatal sweep warnings. */
  warnings: string[];
  /** One decision row per scanned journal. */
  entries: WorkspaceTransactionGcEntry[];
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === code
  );
}

function readJournalStatusAndTimestamp(raw: string): {
  status: string | null;
  updatedAt: string | null;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { status: null, updatedAt: null };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { status: null, updatedAt: null };
  }
  const record = parsed as Record<string, unknown>;
  return {
    status: typeof record.status === "string" ? record.status : null,
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : null,
  };
}

interface WorkspaceTransactionGcDecision {
  /** Auditable decision row emitted for the journal. */
  entry: WorkspaceTransactionGcEntry;
  /** Whether the journal is old and terminal enough to remove. */
  remove: boolean;
}

interface WorkspaceTransactionGcFileResult {
  /** Decision for the scanned journal. */
  decision: WorkspaceTransactionGcDecision;
  /** Extension and parse warnings accumulated while processing the file. */
  warnings: string[];
}

function classifyWorkspaceTransactionJournal(
  file: string,
  status: string | null,
  updatedAt: string | null,
  nowMs: number,
  retentionMs: number,
): WorkspaceTransactionGcDecision {
  const updatedAtMs = updatedAt === null ? Number.NaN : Date.parse(updatedAt);
  if (status === null || !Number.isFinite(updatedAtMs)) {
    return {
      entry: {
        file,
        status,
        age_seconds: null,
        stale: false,
        reason: "unparseable",
      },
      remove: false,
    };
  }
  const ageMs = nowMs - updatedAtMs;
  if (!TERMINAL_JOURNAL_STATUSES.has(status)) {
    return {
      entry: {
        file,
        status,
        age_seconds: Math.floor(ageMs / 1000),
        stale: false,
        reason: "active",
      },
      remove: false,
    };
  }
  // A non-finite retentionMs makes this comparison false, disabling pruning
  // rather than risking deletion under bad input.
  if (!(ageMs > retentionMs)) {
    return {
      entry: {
        file,
        status,
        age_seconds: Math.floor(ageMs / 1000),
        stale: false,
        reason: "fresh",
      },
      remove: false,
    };
  }
  return {
    entry: {
      file,
      status,
      age_seconds: Math.floor(ageMs / 1000),
      stale: true,
    },
    remove: true,
  };
}

async function processWorkspaceTransactionJournal(
  absolutePath: string,
  relativePath: string,
  fileName: string,
  options: {
    dryRun: boolean;
    hooks: WorkspaceTransactionGcHooks | undefined;
    nowMs: number;
    retentionMs: number;
  },
): Promise<WorkspaceTransactionGcFileResult> {
  const warnings = options.hooks?.onRead
    ? await options.hooks.onRead(absolutePath)
    : [];
  const journal = readJournalStatusAndTimestamp(
    await fs.readFile(absolutePath, "utf8"),
  );
  const decision = classifyWorkspaceTransactionJournal(
    relativePath,
    journal.status,
    journal.updatedAt,
    options.nowMs,
    options.retentionMs,
  );
  if (decision.entry.reason === "unparseable") {
    warnings.push(`transaction_journal_unparseable:${fileName}`);
  }
  if (decision.remove && !options.dryRun) {
    await fs.rm(absolutePath, { force: true });
    if (options.hooks?.onWrite) {
      warnings.push(...(await options.hooks.onWrite(absolutePath)));
    }
  }
  return { decision, warnings };
}

/** Sweep `transactions/sdk/` and prune terminal workspace-transaction journals older than the retention window. One decision row is reported per journal so `pm gc` output stays auditable. */
export async function runWorkspaceTransactionGc(
  pmRoot: string,
  options: WorkspaceTransactionGcOptions,
): Promise<WorkspaceTransactionGcResult> {
  const { dryRun, hooks } = options;
  const nowMs = options.now ?? Date.now();
  const retentionMs = Math.max(0, options.retentionDays) * MILLISECONDS_PER_DAY;
  const journalsDir = path.join(pmRoot, "transactions", "sdk");
  const result: WorkspaceTransactionGcResult = {
    scanned: 0,
    removed: [],
    retained: [],
    warnings: [],
    entries: [],
  };

  let files: string[];
  try {
    files = (await fs.readdir(journalsDir))
      .filter((file) => file.endsWith(".json"))
      .sort((left, right) => left.localeCompare(right));
  } catch (error: unknown) {
    if (isErrno(error, "ENOENT")) {
      return result;
    }
    throw error;
  }

  for (const file of files) {
    const absPath = path.join(journalsDir, file);
    const relPath = `transactions/sdk/${file}`;
    const fileResult = await processWorkspaceTransactionJournal(
      absPath,
      relPath,
      file,
      { dryRun, hooks, nowMs, retentionMs },
    );
    result.warnings.push(...fileResult.warnings);
    result.scanned += 1;
    const { decision } = fileResult;
    if (!decision.remove) {
      result.retained.push(relPath);
      result.entries.push(decision.entry);
      continue;
    }
    result.removed.push(relPath);
    result.entries.push(decision.entry);
  }
  return result;
}
