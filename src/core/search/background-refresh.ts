import { spawn } from "node:child_process";
import { mkdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";

import { pathExists, readFileIfExists, writeFileAtomic } from "../fs/fs-utils.js";
import { acquireLock } from "../lock/lock.js";
import { resolvePmPackageRootFromModule } from "../packages/root.js";
import { readSettings } from "../store/settings.js";
import { toErrorMessage } from "../shared/primitives.js";
import { resolveSettingsWithSemanticRuntimeDefaults } from "./semantic-defaults.js";

/**
 * Shared lock id for any process that rewrites the local vector store. Reindex
 * and the background mutation-refresh worker both acquire this so they never
 * write concurrently and corrupt the store. Exported so `pm reindex` reuses the
 * same id rather than duplicating the literal.
 */
export const REINDEX_LOCK_ID = "reindex";

const PENDING_QUEUE_REL_PATH = "search/pending-refresh.json";
const PENDING_QUEUE_GATE_REL_PATH = "search/pending-refresh.gate.lock";
const PENDING_QUEUE_GATE_STALE_MS = 30_000;

// Bounded reindex-lock retry for the background worker (~3.2s worst case).
const LOCK_ACQUIRE_ATTEMPTS = 8;
const LOCK_ACQUIRE_BACKOFF_MS = 400;

const SEARCH_REFRESH_INLINE_ENV = "PM_SEARCH_REFRESH_INLINE";
const SEARCH_REFRESH_CHILD_ENV = "PM_SEARCH_REFRESH_CHILD";

function parseBooleanTrueLike(value: string | undefined): boolean {
  if (typeof value !== "string") {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

/**
 * Mutation search refresh runs inline (blocking) under test runners, inside the
 * background worker child itself, or when explicitly requested. Otherwise the
 * semantic refresh is dispatched to a detached child so mutations return without
 * waiting on embeddings. Mirrors the telemetry-flush inline gate so the full test
 * suite stays deterministic.
 */
export function shouldRunSearchRefreshInForeground(): boolean {
  if (parseBooleanTrueLike(process.env[SEARCH_REFRESH_INLINE_ENV])) {
    return true;
  }
  if (parseBooleanTrueLike(process.env[SEARCH_REFRESH_CHILD_ENV])) {
    return true;
  }
  const nodeEnv = (process.env.NODE_ENV ?? "").trim().toLowerCase();
  return (
    typeof process.env.VITEST === "string" ||
    typeof process.env.VITEST_WORKER_ID === "string" ||
    nodeEnv === "test"
  );
}

function pendingQueuePath(pmRoot: string): string {
  return path.join(pmRoot, PENDING_QUEUE_REL_PATH);
}

function pendingQueueGatePath(pmRoot: string): string {
  return path.join(pmRoot, PENDING_QUEUE_GATE_REL_PATH);
}

function acquireQueueGate(pmRoot: string): boolean {
  const gatePath = pendingQueueGatePath(pmRoot);
  try {
    if (Date.now() - statSync(gatePath).mtimeMs < PENDING_QUEUE_GATE_STALE_MS) {
      return false;
    }
    rmSync(gatePath, { recursive: true, force: true });
  } catch {
    // Missing gate is the common case; fall through to create it.
  }
  try {
    mkdirSync(path.dirname(gatePath), { recursive: true });
    mkdirSync(gatePath);
    return true;
  } catch {
    return false;
  }
}

function releaseQueueGate(pmRoot: string): void {
  try {
    rmSync(pendingQueueGatePath(pmRoot), { recursive: true, force: true });
  } catch {
    // Best effort; a stale gate self-heals after PENDING_QUEUE_GATE_STALE_MS.
  }
}

async function withQueueGate<T>(pmRoot: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  // Briefly serialize read-modify-write access to the pending queue across the
  // mutation process and the worker child. Acquisition is best effort; if a
  // healthy gate is held we skip rather than risk a torn queue.
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (acquireQueueGate(pmRoot)) {
      try {
        return await fn();
      } finally {
        releaseQueueGate(pmRoot);
      }
    }
    await delay(20);
  }
  return fallback;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });
}

async function readPendingQueueIds(pmRoot: string): Promise<string[]> {
  const raw = await readFileIfExists(pendingQueuePath(pmRoot));
  if (!raw || raw.trim().length === 0) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as { ids?: unknown };
    if (!Array.isArray(parsed.ids)) {
      return [];
    }
    return parsed.ids.filter((id): id is string => typeof id === "string" && id.length > 0);
  } catch {
    return [];
  }
}

async function writePendingQueueIds(pmRoot: string, ids: string[]): Promise<void> {
  await writeFileAtomic(pendingQueuePath(pmRoot), `${JSON.stringify({ ids })}\n`);
}

/** Merge mutated item ids into the persistent pending-refresh queue. */
export async function enqueuePendingRefreshIds(pmRoot: string, itemIds: string[]): Promise<void> {
  const incoming = itemIds.filter((id) => typeof id === "string" && id.trim().length > 0);
  if (incoming.length === 0) {
    return;
  }
  const mergeIncoming = async (): Promise<void> => {
    const existing = await readPendingQueueIds(pmRoot);
    const merged = [...new Set([...existing, ...incoming])].sort((left, right) => left.localeCompare(right));
    await writePendingQueueIds(pmRoot, merged);
  };
  const gated = await withQueueGate(
    pmRoot,
    async () => {
      await mergeIncoming();
      return true;
    },
    false,
  );
  if (!gated) {
    // The gate stayed contended past the retry budget. Never silently drop a
    // mutation's refresh work: fall back to a best-effort unguarded merge.
    // writeFileAtomic keeps the file valid; the only risk is losing a concurrent
    // writer's delta, which its own next dispatch and the vector_index_stale
    // warning both recover.
    await mergeIncoming();
  }
}

/** Atomically read and clear the pending-refresh queue, returning drained ids. */
export async function drainPendingRefreshIds(pmRoot: string): Promise<string[]> {
  return withQueueGate(
    pmRoot,
    async () => {
      const ids = await readPendingQueueIds(pmRoot);
      if (ids.length > 0) {
        await writePendingQueueIds(pmRoot, []);
      }
      return ids;
    },
    [],
  );
}

function searchRefreshRunnerPath(): string {
  return path.join(
    resolvePmPackageRootFromModule(import.meta.url, ["../../.."]),
    "dist",
    "cli",
    "search-refresh.js",
  );
}

/**
 * Spawn the detached refresh worker child for this pm root. Best effort: a
 * failed dispatch must never keep the CLI alive or fail a mutation; the next
 * mutation re-dispatches and `vector_index_stale` warns about the catch-up
 * window in the meantime.
 */
function dispatchRefreshChild(pmRoot: string): void {
  try {
    const child = spawn(process.execPath, [searchRefreshRunnerPath()], {
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        PM_PATH: pmRoot,
        [SEARCH_REFRESH_CHILD_ENV]: "1",
      },
    });
    // A detached child can emit an async 'error' event (e.g. spawn EAGAIN/ENOENT,
    // resource limits). Swallow it so it never becomes an unhandled error that
    // crashes the parent CLI; dispatch is best effort.
    child.on("error", () => {});
    child.unref();
  } catch {
    // Best effort — see doc comment above.
  }
}

/**
 * Enqueue mutated ids and dispatch a detached worker child to refresh semantic
 * embeddings without blocking the mutation. The reindex lock the worker acquires
 * serializes concurrent refreshes, so the spawn itself stays unconditional and
 * cheap; a worker that loses the lock exits and its ids are drained by the holder.
 */
export async function scheduleBackgroundSemanticRefresh(pmRoot: string, itemIds: string[]): Promise<void> {
  await enqueuePendingRefreshIds(pmRoot, itemIds);
  dispatchRefreshChild(pmRoot);
}

export interface SemanticRefreshWorkerResult {
  processed: string[];
  rounds: number;
  warnings: string[];
}

type SemanticRefreshFn = (
  pmRoot: string,
  itemIds: string[],
) => Promise<{ refreshed: string[]; skipped: string[]; warnings: string[] }>;

/**
 * Drain the pending queue and refresh semantic vectors under the reindex lock so
 * the local vector store is never rewritten concurrently. If the lock is held by
 * another worker we exit immediately — that holder drains our enqueued ids. After
 * releasing we re-check the queue once and re-dispatch if a sibling enqueued ids
 * during our final window, guaranteeing eventual processing.
 */
export async function runSemanticRefreshWorker(
  pmRoot: string,
  refresh: SemanticRefreshFn,
): Promise<SemanticRefreshWorkerResult> {
  const warnings: string[] = [];
  const processed: string[] = [];
  if (!(await pathExists(pmRoot))) {
    return { processed, rounds: 0, warnings };
  }

  let settings: Awaited<ReturnType<typeof readSettings>>;
  try {
    settings = resolveSettingsWithSemanticRuntimeDefaults(await readSettings(pmRoot)).settings;
  } catch (error: unknown) {
    return { processed, rounds: 0, warnings: [`search_background_refresh_settings_read_failed:${toErrorMessage(error)}`] };
  }

  // Retry the reindex lock with backoff rather than exiting on the first
  // conflict: a sibling refresh worker holds it only briefly (~one embed), so a
  // few retries pick up the queued ids in this run instead of stranding them
  // until the next mutation. If a long `pm reindex` keeps it, we give up — that
  // full pass re-embeds everything anyway and the next dispatch retries.
  let release: (() => Promise<void>) | null = null;
  for (let attempt = 0; attempt < LOCK_ACQUIRE_ATTEMPTS && !release; attempt += 1) {
    try {
      release = await acquireLock(
        pmRoot,
        REINDEX_LOCK_ID,
        settings.locks.ttl_seconds,
        process.env.PM_AUTHOR ?? "pm-search-refresh",
        false,
        settings.governance.force_required_for_stale_lock,
      );
    } catch {
      if (attempt < LOCK_ACQUIRE_ATTEMPTS - 1) {
        await delay(LOCK_ACQUIRE_BACKOFF_MS);
      }
    }
  }
  if (!release) {
    return { processed, rounds: 0, warnings };
  }

  let rounds = 0;
  let failed = false;
  try {
    for (;;) {
      const ids = await drainPendingRefreshIds(pmRoot);
      if (ids.length === 0) {
        break;
      }
      rounds += 1;
      try {
        const result = await refresh(pmRoot, ids);
        processed.push(...result.refreshed);
        warnings.push(...result.warnings);
      } catch (error: unknown) {
        warnings.push(`search_background_refresh_failed:${toErrorMessage(error)}`);
        // Re-enqueue so the work is retried by a later dispatch rather than lost.
        await enqueuePendingRefreshIds(pmRoot, ids);
        failed = true;
        break;
      }
    }
  } finally {
    await release?.();
  }

  // Close the race where a sibling enqueued ids between our last empty drain and
  // releasing the lock: re-dispatch so those ids are eventually processed. Skip
  // this after a refresh failure — the failed ids were re-enqueued and an
  // immediate respawn would just fail again, spinning indefinitely. They wait
  // for the next mutation's dispatch instead.
  const remaining = failed ? [] : await readPendingQueueIds(pmRoot);
  if (remaining.length > 0) {
    dispatchRefreshChild(pmRoot);
  }

  return { processed: [...new Set(processed)].sort((a, b) => a.localeCompare(b)), rounds, warnings };
}
