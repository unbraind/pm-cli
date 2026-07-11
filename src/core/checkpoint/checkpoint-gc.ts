/**
 * @module core/checkpoint/checkpoint-gc
 *
 * Age-based garbage collector for bulk-mutation rollback checkpoints written by
 * `update-many`/`close-many` under `checkpoints/<subdir>/<id>.json`.
 *
 * Safety-first policy (mirroring the stale-lock sweep in `lock/lock-gc.ts`): a
 * checkpoint whose JSON cannot be read or whose `created_at` cannot be parsed is
 * RETAINED rather than deleted. We only prune checkpoints whose age can be
 * conclusively determined from their own `created_at` field and that exceed the
 * configured `checkpoints.retention_days` policy.
 *
 * Staleness formula: (now_ms - Date.parse(created_at)) > retention_days * 86_400_000.
 * A zero/negative age (a future `created_at`) is always treated as active.
 */

import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

const MILLISECONDS_PER_DAY = 86_400_000;

/** Documents the checkpoint gc scan entry payload exchanged by command, SDK, and package integrations. */
export interface CheckpointGcEntry {
  /** Relative path like "checkpoints/update-many/update-many-20260619-abc123.json". */
  file: string;
  /** Parsed `created_at`, or null when missing/unparseable. */
  created_at: string | null;
  /** floor((now - created_at)/1000), null when unparseable. */
  age_seconds: number | null;
  /** True only when classified as expired (older than the retention window). */
  stale: boolean;
  /** Value that configures or reports reason for this contract. */
  reason: "expired" | "active" | "unparseable";
}

/** Documents the checkpoint gc hooks payload exchanged by command, SDK, and package integrations. */
export interface CheckpointGcHooks {
  /** Value that configures or reports on read for this contract. */
  onRead?: (checkpointPath: string) => Promise<string[]> | string[];
  /** Value that configures or reports on write for this contract. */
  onWrite?: (checkpointPath: string) => Promise<string[]> | string[];
}

/** Documents the checkpoint gc options payload exchanged by command, SDK, and package integrations. */
export interface CheckpointGcOptions {
  /** Value that configures or reports dry run for this contract. */
  dryRun: boolean;
  /** Prune checkpoints older than this many days. Negative values are clamped to zero (prune everything aged); a non-finite value (NaN/Infinity) disables pruning entirely so bad input never deletes recoverable checkpoints. */
  retentionDays: number;
  /** Epoch ms; defaults to Date.now() — injectable for deterministic tests. */
  now?: number;
  /** Value that configures or reports hooks for this contract. */
  hooks?: CheckpointGcHooks;
}

/** Documents the checkpoint gc result payload exchanged by command, SDK, and package integrations. */
export interface CheckpointGcResult {
  /** Number of *.json checkpoint files examined. */
  scanned: number;
  /** Relative paths removed (or would-remove under dryRun), sorted by file name asc. */
  removed: string[];
  /** Relative paths retained (active OR unparseable — never delete what we can't reason about). */
  retained: string[];
  /** Value that configures or reports warnings for this contract. */
  warnings: string[];
  /** One per scanned checkpoint file, sorted by file name asc. */
  entries: CheckpointGcEntry[];
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === code
  );
}

/** Extract a parseable `created_at` from a checkpoint's raw JSON, or null. */
function readCheckpointCreatedAt(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const createdAt = (parsed as Record<string, unknown>).created_at;
  return typeof createdAt === "string" ? createdAt : null;
}

/** Collect relative `checkpoints/<subdir>/<file>.json` (and top-level `<file>.json`) paths under the checkpoints root. Subdirectory reads are resilient to concurrent races: a subdir that vanishes between the parent `readdir` and its own `readdir` (ENOENT) is skipped quietly, and any other read failure (e.g. a permission error) is surfaced as a `checkpoint_subdir_unreadable:<name>` warning rather than aborting the whole sweep. */
async function collectCheckpointFiles(
  checkpointsDir: string,
  warnings: string[],
): Promise<string[]> {
  let dirEntries: Dirent[];
  try {
    dirEntries = await fs.readdir(checkpointsDir, { withFileTypes: true });
  } catch (error: unknown) {
    if (isErrno(error, "ENOENT")) {
      return [];
    }
    throw error;
  }
  const files: string[] = [];
  for (const entry of dirEntries) {
    if (entry.isDirectory()) {
      const subdir = path.join(checkpointsDir, entry.name);
      let nested: string[];
      try {
        nested = await fs.readdir(subdir);
      } catch (error: unknown) {
        if (!isErrno(error, "ENOENT")) {
          warnings.push(`checkpoint_subdir_unreadable:${entry.name}`);
        }
        continue;
      }
      for (const file of nested) {
        if (file.endsWith(".json")) {
          files.push(`${entry.name}/${file}`);
        }
      }
    } else if (entry.name.endsWith(".json")) {
      files.push(entry.name);
    }
  }
  return files.sort();
}

/** Implements run checkpoint gc for the public runtime surface of this module. */
export async function runCheckpointGc(
  pmRoot: string,
  options: CheckpointGcOptions,
): Promise<CheckpointGcResult> {
  const { dryRun, hooks } = options;
  const nowMs = options.now ?? Date.now();
  const retentionMs = Math.max(0, options.retentionDays) * MILLISECONDS_PER_DAY;
  const checkpointsDir = path.join(pmRoot, "checkpoints");
  // A non-finite retentionMs (NaN/Infinity from a non-finite retentionDays)
  // makes every `ageMs > retentionMs` comparison false, so nothing is pruned —
  // pruning is disabled rather than risking deletion under bad input.

  const result: CheckpointGcResult = {
    scanned: 0,
    removed: [],
    retained: [],
    warnings: [],
    entries: [],
  };

  const files = await collectCheckpointFiles(checkpointsDir, result.warnings);
  for (const relName of files) {
    const absPath = path.join(checkpointsDir, relName);
    const relPath = `checkpoints/${relName}`;
    result.scanned += 1;

    if (hooks?.onRead) {
      result.warnings.push(...(await hooks.onRead(absPath)));
    }

    let raw: string;
    try {
      raw = await fs.readFile(absPath, "utf8");
    } catch (readError: unknown) {
      if (isErrno(readError, "ENOENT")) {
        // Disappeared between readdir and readFile — treat as a ghost; skip quietly.
        result.scanned -= 1;
        continue;
      }
      result.warnings.push(`checkpoint_unreadable:${relName}`);
      result.retained.push(relPath);
      result.entries.push({
        file: relPath,
        created_at: null,
        age_seconds: null,
        stale: false,
        reason: "unparseable",
      });
      continue;
    }

    const createdAt = readCheckpointCreatedAt(raw);
    const createdAtMs = createdAt === null ? Number.NaN : Date.parse(createdAt);
    if (!Number.isFinite(createdAtMs)) {
      result.warnings.push(`checkpoint_unparseable:${relName}`);
      result.retained.push(relPath);
      result.entries.push({
        file: relPath,
        created_at: createdAt,
        age_seconds: null,
        stale: false,
        reason: "unparseable",
      });
      continue;
    }

    const ageMs = nowMs - createdAtMs;
    const entry: CheckpointGcEntry = {
      file: relPath,
      created_at: createdAt,
      age_seconds: Math.floor(ageMs / 1000),
      stale: ageMs > retentionMs,
      reason: ageMs > retentionMs ? "expired" : "active",
    };
    if (!entry.stale) {
      result.retained.push(relPath);
      result.entries.push(entry);
      continue;
    }

    if (!dryRun) {
      try {
        await fs.unlink(absPath);
      } catch (unlinkError: unknown) {
        if (!isErrno(unlinkError, "ENOENT")) {
          result.warnings.push(`checkpoint_remove_failed:${relName}`);
          result.retained.push(relPath);
          result.entries.push(entry);
          continue;
        }
        // ENOENT on unlink = already gone (race); treat as removed.
      }
      if (hooks?.onWrite) {
        result.warnings.push(...(await hooks.onWrite(absPath)));
      }
    }
    result.removed.push(relPath);
    result.entries.push(entry);
  }

  return result;
}
