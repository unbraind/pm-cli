import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathExists, writeFileAtomic } from "../fs/fs-utils.js";
import { EXIT_CODE } from "../shared/constants.js";
import { PmCliError } from "../shared/errors.js";
import { toErrorMessage } from "../shared/primitives.js";
import { nowIso } from "../shared/time.js";

// Shared checkpoint + rollback machinery for bulk-mutation commands
// (`update-many`, `close-many`). Each command owns its own checkpoint payload
// shape (the extra fields it records) but reuses the common id/path/validation
// helpers and the restore loop so the durable rollback contract — capture each
// matched item's pre-mutation updated_at, then restore-to-timestamp on
// rollback — stays identical across commands and is not duplicated.

export interface MutationCheckpointItem {
  id: string;
  target_updated_at: string;
}

export interface LoadedMutationCheckpoint {
  /** The full on-disk record so callers can read their command-specific fields. */
  record: Record<string, unknown>;
  /** Validated item list (id + target_updated_at). */
  items: MutationCheckpointItem[];
  /** Absolute path the checkpoint was read from. */
  path: string;
  id: string;
  created_at: string;
  author: string;
}

export interface CheckpointRollbackRow {
  id: string;
  status: "restored" | "failed";
  changed_fields?: string[];
  warnings?: string[];
  error?: string;
}

export interface CheckpointRollbackResult {
  rows: CheckpointRollbackRow[];
  restored_ids: string[];
  failed_count: number;
}

/** Restore a single item to its captured pre-mutation timestamp. */
export type CheckpointRestoreFn = (
  id: string,
  targetUpdatedAt: string,
) => Promise<{ changed_fields?: string[]; warnings?: string[] }>;

export function normalizeCheckpointId(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new PmCliError("--rollback requires a non-empty checkpoint ID", EXIT_CODE.USAGE);
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(trimmed)) {
    throw new PmCliError("--rollback checkpoint ID must match [a-zA-Z0-9._-]+", EXIT_CODE.USAGE);
  }
  return trimmed;
}

export function createCheckpointId(prefix: string, nowValue: string): string {
  const compactTimestamp = nowValue.replace(/[-:.TZ]/g, "").slice(0, 14);
  const randomSuffix = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${compactTimestamp}-${randomSuffix}`;
}

export function checkpointDirectoryPath(pmRoot: string, subdir: string): string {
  return path.join(pmRoot, "checkpoints", subdir);
}

export function checkpointFilePath(pmRoot: string, subdir: string, checkpointId: string): string {
  return path.join(checkpointDirectoryPath(pmRoot, subdir), `${checkpointId}.json`);
}

export async function writeMutationCheckpoint(
  pmRoot: string,
  subdir: string,
  checkpointId: string,
  payload: unknown,
): Promise<string> {
  const checkpointDir = checkpointDirectoryPath(pmRoot, subdir);
  await mkdir(checkpointDir, { recursive: true });
  const filePath = checkpointFilePath(pmRoot, subdir, checkpointId);
  await writeFileAtomic(filePath, `${JSON.stringify(payload, null, 2)}\n`);
  return filePath;
}

function parseCheckpointItems(record: Record<string, unknown>, checkpointId: string): MutationCheckpointItem[] {
  if (!Array.isArray(record.items)) {
    throw new PmCliError(`Checkpoint ${checkpointId} is missing items`, EXIT_CODE.GENERIC_FAILURE);
  }
  return record.items.map((entry) => {
    if (!entry || typeof entry !== "object") {
      throw new PmCliError(`Checkpoint ${checkpointId} contains an invalid item entry`, EXIT_CODE.GENERIC_FAILURE);
    }
    const row = entry as Record<string, unknown>;
    if (typeof row.id !== "string" || row.id.trim().length === 0) {
      throw new PmCliError(`Checkpoint ${checkpointId} contains an item entry without ID`, EXIT_CODE.GENERIC_FAILURE);
    }
    if (typeof row.target_updated_at !== "string" || row.target_updated_at.trim().length === 0) {
      throw new PmCliError(
        `Checkpoint ${checkpointId} contains an item entry without target_updated_at`,
        EXIT_CODE.GENERIC_FAILURE,
      );
    }
    return { id: row.id.trim(), target_updated_at: row.target_updated_at.trim() };
  });
}

export async function loadMutationCheckpoint(
  pmRoot: string,
  subdir: string,
  rawCheckpointId: string,
  schemaVersion: number,
): Promise<LoadedMutationCheckpoint> {
  const normalizedId = normalizeCheckpointId(rawCheckpointId);
  const filePath = checkpointFilePath(pmRoot, subdir, normalizedId);
  if (!(await pathExists(filePath))) {
    throw new PmCliError(`Checkpoint ${normalizedId} not found`, EXIT_CODE.NOT_FOUND);
  }
  const raw = await readFile(filePath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error: unknown) {
    throw new PmCliError(
      `Checkpoint ${normalizedId} contains invalid JSON: ${toErrorMessage(error)}`,
      EXIT_CODE.GENERIC_FAILURE,
    );
  }
  if (!parsed || typeof parsed !== "object") {
    throw new PmCliError(`Checkpoint ${normalizedId} is invalid`, EXIT_CODE.GENERIC_FAILURE);
  }
  const record = parsed as Record<string, unknown>;
  if (record.schema_version !== schemaVersion) {
    throw new PmCliError(`Checkpoint ${normalizedId} has unsupported schema version`, EXIT_CODE.GENERIC_FAILURE);
  }
  const items = parseCheckpointItems(record, normalizedId);
  return {
    record,
    items,
    path: filePath,
    id: typeof record.id === "string" ? record.id : normalizedId,
    // Defensive recovery for malformed checkpoint metadata; normal writes
    // always include these fields, so fallbacks keep rollback inspectable.
    created_at: typeof record.created_at === "string" ? record.created_at : nowIso(),
    author: typeof record.author === "string" ? record.author : "unknown",
  };
}

/**
 * Restore every checkpointed item to its captured pre-mutation timestamp,
 * collecting per-item rows. A single item's failure is recorded and does not
 * abort the remaining restores.
 */
export async function restoreCheckpointItems(
  items: MutationCheckpointItem[],
  restore: CheckpointRestoreFn,
): Promise<CheckpointRollbackResult> {
  const rows: CheckpointRollbackRow[] = [];
  const restoredIds: string[] = [];
  for (const entry of items) {
    try {
      const restored = await restore(entry.id, entry.target_updated_at);
      rows.push({
        id: entry.id,
        status: "restored",
        changed_fields: restored.changed_fields,
        warnings: restored.warnings,
      });
      restoredIds.push(entry.id);
    } catch (error: unknown) {
      rows.push({ id: entry.id, status: "failed", error: toErrorMessage(error) });
    }
  }
  return {
    rows,
    restored_ids: restoredIds,
    failed_count: rows.filter((row) => row.status === "failed").length,
  };
}
