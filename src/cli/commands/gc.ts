/**
 * @module cli/commands/gc
 *
 * Implements the pm gc command surface and its agent-facing runtime behavior.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { runCheckpointGc } from "../../core/checkpoint/checkpoint-gc.js";
import {
  runActiveOnIndexHooks,
  runActiveOnReadHooks,
  runActiveOnWriteHooks,
} from "../../core/extensions/index.js";
import { pathExists } from "../../core/fs/fs-utils.js";
import { runLockGc } from "../../core/lock/lock-gc.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { nowIso } from "../../core/shared/time.js";
import { getSettingsPath, resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";

const GC_SCOPE_VALUES = [
  "index",
  "embeddings",
  "runtime",
  "locks",
  "checkpoints",
] as const;
type GcScope = (typeof GC_SCOPE_VALUES)[number];

interface GcTarget {
  scope: GcScope;
  relativePath: string;
  kind: "file" | "directory";
}

const GC_TARGETS: readonly GcTarget[] = [
  {
    scope: "index",
    relativePath: "index/manifest.json",
    kind: "file",
  },
  {
    scope: "embeddings",
    relativePath: "search/embeddings.jsonl",
    kind: "file",
  },
  {
    scope: "embeddings",
    relativePath: "search/vectorization-status.json",
    kind: "file",
  },
  {
    scope: "embeddings",
    relativePath: "search/lancedb",
    kind: "directory",
  },
  {
    // Removing embeddings invalidates the whole semantic index, so the queued
    // background-refresh work is also meaningless: a worker draining a stale
    // queue against an empty ledger would rebuild a partial, inconsistent index
    // (only the queued items vectorized). Clear the queue and its gate so the
    // next mutation re-seeds from a clean slate. See core/search/background-refresh.ts.
    scope: "embeddings",
    relativePath: "search/pending-refresh.json",
    kind: "file",
  },
  {
    scope: "embeddings",
    relativePath: "search/pending-refresh.gate.lock",
    kind: "directory",
  },
  {
    scope: "runtime",
    relativePath: "runtime/test-runs",
    kind: "directory",
  },
  {
    scope: "runtime",
    relativePath: "runtime/history-drift-cache.json",
    kind: "file",
  },
] as const;

/** Documents the gc command options payload exchanged by command, SDK, and package integrations. */
export interface GcCommandOptions {
  /** Value that configures or reports dry run for this contract. */
  dryRun?: boolean;
  /** Value that configures or reports scope for this contract. */
  scope?: string[];
}

/** Documents the gc locks summary payload exchanged by command, SDK, and package integrations. */
export interface GcLocksSummary {
  /** Value that configures or reports scanned for this contract. */
  scanned: number;
  /** Value that configures or reports removed for this contract. */
  removed: number;
  /** Value that configures or reports retained for this contract. */
  retained: number;
}

/** Documents the gc checkpoints summary payload exchanged by command, SDK, and package integrations. */
export interface GcCheckpointsSummary {
  /** Value that configures or reports scanned for this contract. */
  scanned: number;
  /** Value that configures or reports removed for this contract. */
  removed: number;
  /** Value that configures or reports retained for this contract. */
  retained: number;
  /** Value that configures or reports retention days for this contract. */
  retention_days: number;
}

/** Documents the gc result payload exchanged by command, SDK, and package integrations. */
export interface GcResult {
  /** Whether the operation completed without a blocking failure. */
  ok: boolean;
  /** Value that configures or reports dry run for this contract. */
  dry_run: boolean;
  /** Value that configures or reports scope for this contract. */
  scope: GcScope[];
  /** Value that configures or reports removed for this contract. */
  removed: string[];
  /** Value that configures or reports retained for this contract. */
  retained: string[];
  /** Value that configures or reports warnings for this contract. */
  warnings: string[];
  /** Value that configures or reports guidance for this contract. */
  guidance: string[];
  /** Present only when the locks scope was selected. Summarizes the stale-lock sweep. */
  locks?: GcLocksSummary;
  /** Present only when the checkpoints scope was selected. Summarizes the rollback-checkpoint sweep. */
  checkpoints?: GcCheckpointsSummary;
  /** ISO 8601 timestamp recording when generated occurred. */
  generated_at: string;
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === code
  );
}

async function removeCacheFile(
  pmRoot: string,
  target: GcTarget,
  dryRun: boolean,
): Promise<{ removed: boolean; warnings: string[] }> {
  const relativePath = target.relativePath;
  const absolutePath = path.join(pmRoot, relativePath);
  const warnings = await runActiveOnReadHooks({
    path: absolutePath,
    scope: "project",
  });
  try {
    const stats = await fs.stat(absolutePath);
    if (target.kind === "file" && !stats.isFile()) {
      return {
        removed: false,
        warnings: [...warnings, `not_a_file:${relativePath}`],
      };
    }
    if (target.kind === "directory" && !stats.isDirectory()) {
      return {
        removed: false,
        warnings: [...warnings, `not_a_directory:${relativePath}`],
      };
    }
    if (dryRun) {
      return {
        removed: true,
        warnings,
      };
    }
    if (target.kind === "file") {
      await fs.unlink(absolutePath);
    } else {
      await fs.rm(absolutePath, { recursive: true, force: true });
    }
    const writeWarnings = await runActiveOnWriteHooks({
      path: absolutePath,
      scope: "project",
      op: "gc:remove",
    });
    return {
      removed: true,
      warnings: [...warnings, ...writeWarnings],
    };
  } catch (error: unknown) {
    if (isErrno(error, "ENOENT")) {
      return {
        removed: false,
        warnings,
      };
    }
    throw error;
  }
}

function parseScopes(raw: string[] | undefined): GcScope[] {
  if (!raw || raw.length === 0) {
    return [...GC_SCOPE_VALUES];
  }
  const tokens = raw
    .flatMap((entry) => entry.split(","))
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  if (tokens.length === 0) {
    throw new PmCliError(
      `--scope requires at least one value (${GC_SCOPE_VALUES.join(",")})`,
      EXIT_CODE.USAGE,
    );
  }
  const resolved = new Set<GcScope>();
  for (const token of tokens) {
    if (!(GC_SCOPE_VALUES as readonly string[]).includes(token)) {
      throw new PmCliError(
        `Invalid --scope value "${token}". Expected one or more of: ${GC_SCOPE_VALUES.join(", ")}`,
        EXIT_CODE.USAGE,
      );
    }
    resolved.add(token as GcScope);
  }
  return GC_SCOPE_VALUES.filter((scope) => resolved.has(scope));
}

function buildGcGuidance(params: {
  dryRun: boolean;
  scopes: GcScope[];
  removed: string[];
}): string[] {
  const guidance: string[] = [];
  if (params.dryRun) {
    guidance.push("Dry-run preview only: no cache artifacts were deleted.");
  }
  const searchScopeSelected =
    params.scopes.includes("index") || params.scopes.includes("embeddings");
  const searchArtifactsAffected = params.removed.some(
    (entry) =>
      entry === "index/manifest.json" ||
      entry === "search/embeddings.jsonl" ||
      entry === "search/vectorization-status.json" ||
      entry === "search/lancedb" ||
      entry === "search/pending-refresh.json" ||
      entry === "search/pending-refresh.gate.lock",
  );
  if (searchScopeSelected && searchArtifactsAffected) {
    guidance.push(
      'Search artifacts were removed; the semantic index (including any queued background refresh) is invalidated. Run "pm install search-advanced --project" if reindex is unavailable, then "pm reindex --mode keyword" (and "--mode semantic" when semantic search is enabled) before search-heavy workflows.',
    );
  }
  if (params.removed.includes("runtime/history-drift-cache.json")) {
    guidance.push(
      'History drift cache was removed; the next "pm health" run performs a full history-drift re-scan.',
    );
  }
  if (
    !params.dryRun &&
    params.removed.some((entry) => entry.startsWith("checkpoints/"))
  ) {
    guidance.push(
      'Aged rollback checkpoints were removed; their "pm update-many"/"pm close-many --rollback" windows are no longer recoverable.',
    );
  }
  return guidance;
}

/** Implements run gc for the public runtime surface of this module. */
export async function runGc(
  global: GlobalOptions,
  options: GcCommandOptions = {},
): Promise<GcResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(
      `Tracker is not initialized at ${pmRoot}. Run pm init first.`,
      EXIT_CODE.NOT_FOUND,
    );
  }

  const settings = await readSettings(pmRoot);
  const dryRun = options.dryRun === true;
  const scopes = parseScopes(options.scope);
  const selectedTargets = GC_TARGETS.filter((target) =>
    scopes.includes(target.scope),
  );

  const removed: string[] = [];
  const retained: string[] = [];
  const warnings: string[] = [];

  for (const target of selectedTargets) {
    const result = await removeCacheFile(pmRoot, target, dryRun);
    if (result.removed) {
      removed.push(target.relativePath);
    } else {
      retained.push(target.relativePath);
    }
    warnings.push(...result.warnings);
  }

  // The locks scope is not a path-based GC_TARGET: it sweeps the locks/ directory
  // and removes only locks whose own embedded ttl has expired (crashed-process
  // debris), retaining active and unparseable locks. See core/lock/lock-gc.ts.
  let locksSummary: GcLocksSummary | undefined;
  if (scopes.includes("locks")) {
    const lockResult = await runLockGc(pmRoot, {
      dryRun,
      hooks: {
        onRead: (lockPath) =>
          runActiveOnReadHooks({ path: lockPath, scope: "project" }),
        onWrite: (lockPath) =>
          runActiveOnWriteHooks({
            path: lockPath,
            scope: "project",
            op: "gc:lock_remove",
          }),
      },
    });
    removed.push(...lockResult.removed);
    retained.push(...lockResult.retained);
    warnings.push(...lockResult.warnings);
    locksSummary = {
      scanned: lockResult.scanned,
      removed: lockResult.removed.length,
      retained: lockResult.retained.length,
    };
  }

  // The checkpoints scope is also not a path-based GC_TARGET: it sweeps
  // checkpoints/ and removes only rollback checkpoints older than the configured
  // checkpoints.retention_days, retaining active and unparseable files. See
  // core/checkpoint/checkpoint-gc.ts.
  let checkpointsSummary: GcCheckpointsSummary | undefined;
  if (scopes.includes("checkpoints")) {
    const retentionDays = settings.checkpoints.retention_days;
    const checkpointResult = await runCheckpointGc(pmRoot, {
      dryRun,
      retentionDays,
      hooks: {
        onRead: (checkpointPath) =>
          runActiveOnReadHooks({ path: checkpointPath, scope: "project" }),
        onWrite: (checkpointPath) =>
          runActiveOnWriteHooks({
            path: checkpointPath,
            scope: "project",
            op: "gc:checkpoint_remove",
          }),
      },
    });
    removed.push(...checkpointResult.removed);
    retained.push(...checkpointResult.retained);
    warnings.push(...checkpointResult.warnings);
    checkpointsSummary = {
      scanned: checkpointResult.scanned,
      removed: checkpointResult.removed.length,
      retained: checkpointResult.retained.length,
      retention_days: retentionDays,
    };
  }

  warnings.push(
    ...(await runActiveOnIndexHooks({
      mode: dryRun ? "gc:dry-run" : "gc",
      total_items: selectedTargets.length,
    })),
  );
  const guidance = buildGcGuidance({
    dryRun,
    scopes,
    removed,
  });

  return {
    ok: warnings.length === 0,
    dry_run: dryRun,
    scope: scopes,
    removed,
    retained,
    warnings,
    ...(locksSummary ? { locks: locksSummary } : {}),
    ...(checkpointsSummary ? { checkpoints: checkpointsSummary } : {}),
    guidance,
    generated_at: nowIso(),
  };
}
