import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { withTempPmPath } from "../../../helpers/withTempPmPath.js";

// Controllable spies hoisted so the module-level vi.mock factories can close
// over them. Each defaults to a passthrough that delegates to the real impl,
// so unrelated in-process code (lock/settings/fs-utils) is never disturbed.
const { spawnImpl, mkdirSyncImpl, lockReleaseSideEffect } = vi.hoisted(() => ({
  spawnImpl: { current: null as null | ((...args: unknown[]) => unknown) },
  mkdirSyncImpl: { current: null as null | ((...args: unknown[]) => unknown) },
  // When set, runs just before the real lock release resolves, letting a test
  // simulate a sibling enqueueing ids in the worker's final release window.
  lockReleaseSideEffect: { current: null as null | (() => Promise<void> | void) },
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (...args: unknown[]) =>
      spawnImpl.current
        ? spawnImpl.current(...args)
        : (actual.spawn as unknown as (...a: unknown[]) => unknown)(...args),
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    mkdirSync: (...args: unknown[]) =>
      mkdirSyncImpl.current
        ? mkdirSyncImpl.current(...args)
        : (actual.mkdirSync as unknown as (...a: unknown[]) => unknown)(...args),
  };
});

vi.mock("../../../../src/core/lock/lock.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../src/core/lock/lock.js")>();
  return {
    ...actual,
    acquireLock: async (...args: Parameters<typeof actual.acquireLock>) => {
      const release = await actual.acquireLock(...args);
      return async () => {
        if (lockReleaseSideEffect.current) {
          await lockReleaseSideEffect.current();
        }
        await release();
      };
    },
  };
});

// Imported AFTER the mocks are declared so the source binds the mocked symbols.
const {
  REINDEX_LOCK_ID,
  SEARCH_REFRESH_RETRY_DELAY_MS,
  shouldRunSearchRefreshInForeground,
  enqueuePendingRefreshIds,
  drainPendingRefreshIds,
  scheduleBackgroundSemanticRefresh,
  runSemanticRefreshWorker,
} = await import("../../../../src/core/search/background-refresh.js");

beforeEach(() => {
  spawnImpl.current = null;
  mkdirSyncImpl.current = null;
  lockReleaseSideEffect.current = null;
});

afterEach(() => {
  spawnImpl.current = null;
  mkdirSyncImpl.current = null;
  lockReleaseSideEffect.current = null;
  vi.restoreAllMocks();
});

describe("background-refresh", () => {
  it("exports the shared reindex lock id", () => {
    expect(REINDEX_LOCK_ID).toBe("reindex");
  });

  describe("shouldRunSearchRefreshInForeground", () => {
    const ENV_KEYS = [
      "PM_SEARCH_REFRESH_INLINE",
      "PM_SEARCH_REFRESH_CHILD",
      "VITEST",
      "VITEST_WORKER_ID",
      "NODE_ENV",
    ] as const;

    function withCleanEnv<T>(fn: () => T): T {
      const saved = new Map<string, string | undefined>();
      for (const key of ENV_KEYS) {
        saved.set(key, process.env[key]);
        delete process.env[key];
      }
      try {
        return fn();
      } finally {
        for (const key of ENV_KEYS) {
          const value = saved.get(key);
          if (value === undefined) {
            delete process.env[key];
          } else {
            process.env[key] = value;
          }
        }
      }
    }

    it("is true under the active vitest runner", () => {
      // VITEST is set by the runner itself.
      expect(shouldRunSearchRefreshInForeground()).toBe(true);
    });

    it("honours the explicit inline env override truthy variants", () => {
      withCleanEnv(() => {
        expect(shouldRunSearchRefreshInForeground()).toBe(false);
        for (const truthy of ["1", "true", "yes", "on", " TRUE "]) {
          process.env.PM_SEARCH_REFRESH_INLINE = truthy;
          expect(shouldRunSearchRefreshInForeground()).toBe(true);
        }
        process.env.PM_SEARCH_REFRESH_INLINE = "off";
        expect(shouldRunSearchRefreshInForeground()).toBe(false);
      });
    });

    it("honours the child env override", () => {
      withCleanEnv(() => {
        process.env.PM_SEARCH_REFRESH_CHILD = "1";
        expect(shouldRunSearchRefreshInForeground()).toBe(true);
      });
    });

    it("falls back to NODE_ENV=test and runner ids", () => {
      withCleanEnv(() => {
        process.env.NODE_ENV = "test";
        expect(shouldRunSearchRefreshInForeground()).toBe(true);
      });
      withCleanEnv(() => {
        process.env.VITEST_WORKER_ID = "7";
        expect(shouldRunSearchRefreshInForeground()).toBe(true);
      });
      withCleanEnv(() => {
        process.env.NODE_ENV = "production";
        expect(shouldRunSearchRefreshInForeground()).toBe(false);
      });
    });

    it("ignores a non-string env value", () => {
      withCleanEnv(() => {
        // parseBooleanTrueLike returns false for undefined (non-string).
        expect(shouldRunSearchRefreshInForeground()).toBe(false);
      });
    });
  });

  describe("queue enqueue/drain", () => {
    it("merges, dedupes and sorts pending ids then drains them", async () => {
      await withTempPmPath(async ({ pmPath }) => {
        await enqueuePendingRefreshIds(pmPath, ["pm-b", "pm-a"]);
        await enqueuePendingRefreshIds(pmPath, ["pm-a", "pm-c"]);
        expect(await drainPendingRefreshIds(pmPath)).toEqual(["pm-a", "pm-b", "pm-c"]);
        expect(await drainPendingRefreshIds(pmPath)).toEqual([]);
      });
    });

    it("ignores empty/blank ids and a no-op enqueue", async () => {
      await withTempPmPath(async ({ pmPath }) => {
        await enqueuePendingRefreshIds(pmPath, []);
        await enqueuePendingRefreshIds(pmPath, ["", "   "]);
        expect(await drainPendingRefreshIds(pmPath)).toEqual([]);
      });
    });

    it("returns [] for malformed queue json and a non-array ids field", async () => {
      await withTempPmPath(async ({ pmPath }) => {
        const queuePath = path.join(pmPath, "search", "pending-refresh.json");
        await fs.mkdir(path.dirname(queuePath), { recursive: true });

        await fs.writeFile(queuePath, "{not json", "utf8");
        expect(await drainPendingRefreshIds(pmPath)).toEqual([]);

        await fs.writeFile(queuePath, `${JSON.stringify({ ids: "nope" })}\n`, "utf8");
        expect(await drainPendingRefreshIds(pmPath)).toEqual([]);

        await fs.writeFile(queuePath, "   ", "utf8");
        expect(await drainPendingRefreshIds(pmPath)).toEqual([]);
      });
    });

    it("removes a stale queue gate before merging", async () => {
      await withTempPmPath(async ({ pmPath }) => {
        const gatePath = path.join(pmPath, "search", "pending-refresh.gate.lock");
        await fs.mkdir(gatePath, { recursive: true });
        const stale = new Date(Date.now() - 60_000);
        await fs.utimes(gatePath, stale, stale);

        await enqueuePendingRefreshIds(pmPath, ["pm-stale"]);
        expect(await drainPendingRefreshIds(pmPath)).toEqual(["pm-stale"]);
      });
    });

    it("falls back to an unguarded merge when gate acquisition keeps failing (mkdirSync throws -> line 84)", async () => {
      await withTempPmPath(async ({ pmPath }) => {
        const realFs = await vi.importActual<typeof import("node:fs")>("node:fs");
        const gatePath = path.join(pmPath, "search", "pending-refresh.gate.lock");

        // Force acquireQueueGate's create-step to fail: dirname mkdir succeeds
        // (recursive), but the gate mkdir (no recursive) throws -> return false.
        mkdirSyncImpl.current = ((target: string, options?: { recursive?: boolean }) => {
          if (target === gatePath && !options?.recursive) {
            throw new Error("EEXIST simulated");
          }
          return (realFs.mkdirSync as unknown as (...a: unknown[]) => unknown)(target, options);
        }) as never;

        // withQueueGate spins 50x@20ms (~1s) then falls back to the unguarded
        // merge, so the id is still persisted despite never holding the gate.
        await enqueuePendingRefreshIds(pmPath, ["pm-ungated"]);
        mkdirSyncImpl.current = null;
        expect(await drainPendingRefreshIds(pmPath)).toEqual(["pm-ungated"]);
      });
    });

    it("skips while a fresh gate is held by another writer", async () => {
      await withTempPmPath(async ({ pmPath }) => {
        const gatePath = path.join(pmPath, "search", "pending-refresh.gate.lock");
        await fs.mkdir(gatePath, { recursive: true });
        // Fresh gate (just created) -> acquireQueueGate returns false at the
        // stale check, drain falls back to [] within the retry budget.
        const drainPromise = drainPendingRefreshIds(pmPath);
        // Release the gate so the in-flight retries eventually acquire it.
        await fs.rm(gatePath, { recursive: true, force: true });
        expect(await drainPromise).toEqual([]);
      });
    });

    it("keeps awaited queue-gate backoff timers referenced so CLI top-level await can settle", async () => {
      await withTempPmPath(async ({ pmPath }) => {
        const gatePath = path.join(pmPath, "search", "pending-refresh.gate.lock");
        await fs.mkdir(gatePath, { recursive: true });
        const realSetTimeout = globalThis.setTimeout;
        const unrefCalls: number[] = [];
        const timeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
          const timer = realSetTimeout(handler, timeout, ...args);
          const originalUnref = timer.unref?.bind(timer);
          timer.unref = (() => {
            unrefCalls.push(timeout ?? 0);
            return originalUnref ? originalUnref() : timer;
          }) as typeof timer.unref;
          return timer;
        }) as typeof setTimeout);
        try {
          await drainPendingRefreshIds(pmPath);
          expect(unrefCalls).toEqual([]);
        } finally {
          timeoutSpy.mockRestore();
        }
      });
    });
  });

  describe("dispatchRefreshChild (via scheduleBackgroundSemanticRefresh)", () => {
    it("spawns a detached child and registers a swallowing error handler (line 212)", async () => {
      await withTempPmPath(async ({ pmPath }) => {
        const fakeChild = new EventEmitter() as EventEmitter & { unref: () => void };
        fakeChild.unref = vi.fn();
        const onSpy = vi.spyOn(fakeChild, "on");
        spawnImpl.current = (() => fakeChild) as never;

        await scheduleBackgroundSemanticRefresh(pmPath, ["pm-dispatch"]);

        expect(onSpy).toHaveBeenCalledWith("error", expect.any(Function));
        expect(fakeChild.unref).toHaveBeenCalledTimes(1);

        // Execute the registered error-handler body and confirm it swallows.
        expect(() => fakeChild.emit("error", new Error("spawn EAGAIN"))).not.toThrow();

        // The id was enqueued before dispatch.
        expect(await drainPendingRefreshIds(pmPath)).toEqual(["pm-dispatch"]);
      });
    });

    it("swallows a throwing spawn so the mutation never fails", async () => {
      await withTempPmPath(async ({ pmPath }) => {
        spawnImpl.current = (() => {
          throw new Error("spawn ENOENT");
        }) as never;
        await expect(scheduleBackgroundSemanticRefresh(pmPath, ["pm-spawn-throw"])).resolves.toBeUndefined();
        expect(await drainPendingRefreshIds(pmPath)).toEqual(["pm-spawn-throw"]);
      });
    });
  });

  describe("runSemanticRefreshWorker", () => {
    it("returns early when the pm root does not exist", async () => {
      const result = await runSemanticRefreshWorker(
        path.join("/nonexistent-pm-root", "missing"),
        async () => {
          throw new Error("should not run");
        },
      );
      expect(result).toEqual({ processed: [], rounds: 0, warnings: [] });
    });

    it("returns a deterministic warning when settings cannot be read", async () => {
      await withTempPmPath(async ({ pmPath }) => {
        const fakeChild = new EventEmitter() as EventEmitter & { unref: () => void };
        fakeChild.unref = vi.fn();
        const spawnSpy = vi.fn(() => fakeChild);
        spawnImpl.current = spawnSpy as never;
        await enqueuePendingRefreshIds(pmPath, ["pm-settings"]);
        await fs.rm(path.join(pmPath, "settings.json"), { recursive: true, force: true });
        await fs.mkdir(path.join(pmPath, "settings.json"), { recursive: true });

        vi.useFakeTimers();
        try {
          const result = await runSemanticRefreshWorker(pmPath, async () => {
            throw new Error("refresh must not run");
          });
          expect(result.rounds).toBe(0);
          expect(result.warnings[0]).toMatch(/^search_background_refresh_settings_read_failed:/);
          expect(spawnSpy).not.toHaveBeenCalled();
          await vi.advanceTimersByTimeAsync(SEARCH_REFRESH_RETRY_DELAY_MS);
          expect(spawnSpy).toHaveBeenCalledTimes(1);
        } finally {
          vi.useRealTimers();
        }
      });
    });

    it("re-enqueues drained ids when settings fail inside the refresh callback", async () => {
      await withTempPmPath(async ({ pmPath }) => {
        const scheduleRetry = vi.fn();
        await enqueuePendingRefreshIds(pmPath, ["pm-settings-race"]);

        const result = await runSemanticRefreshWorker(
          pmPath,
          async () => ({
            refreshed: [],
            skipped: ["pm-settings-race"],
            warnings: [
              "search_semantic_refresh_skipped:settings_read_failed:settings_read_fs_error",
            ],
          }),
          scheduleRetry,
        );

        expect(result).toEqual({
          processed: [],
          rounds: 1,
          warnings: [
            "search_semantic_refresh_skipped:settings_read_failed:settings_read_fs_error",
          ],
        });
        expect(scheduleRetry).toHaveBeenCalledWith(pmPath);
        expect(await drainPendingRefreshIds(pmPath)).toEqual(["pm-settings-race"]);
      });
    });

    it("drains and refreshes ids under the lock (PM_AUTHOR set)", async () => {
      await withTempPmPath(async ({ pmPath }) => {
        // withTempPmPath sets PM_AUTHOR, exercising the left side of `??`.
        expect(process.env.PM_AUTHOR).toBeDefined();
        await enqueuePendingRefreshIds(pmPath, ["pm-1", "pm-2"]);
        const calls: string[][] = [];
        const result = await runSemanticRefreshWorker(pmPath, async (_root, ids) => {
          calls.push(ids);
          return { refreshed: ids, skipped: [], warnings: ["w1"] };
        });
        expect(calls).toEqual([["pm-1", "pm-2"]]);
        expect(result.processed).toEqual(["pm-1", "pm-2"]);
        expect(result.rounds).toBe(1);
        expect(result.warnings).toEqual(["w1"]);
        expect(await drainPendingRefreshIds(pmPath)).toEqual([]);
      });
    });

    it("returns immediately when the queue is empty", async () => {
      await withTempPmPath(async ({ pmPath }) => {
        const result = await runSemanticRefreshWorker(pmPath, async () => {
          throw new Error("refresh should not run for an empty queue");
        });
        expect(result.rounds).toBe(0);
        expect(result.processed).toEqual([]);
      });
    });

    it("processes ids enqueued mid-refresh in a follow-up round", async () => {
      await withTempPmPath(async ({ pmPath }) => {
        await enqueuePendingRefreshIds(pmPath, ["pm-1"]);
        let enqueuedFollowUp = false;
        const result = await runSemanticRefreshWorker(pmPath, async (root, ids) => {
          if (!enqueuedFollowUp) {
            enqueuedFollowUp = true;
            await enqueuePendingRefreshIds(root, ["pm-2"]);
          }
          return { refreshed: ids, skipped: [], warnings: [] };
        });

        expect(result.rounds).toBe(2);
        expect(result.processed).toEqual(["pm-1", "pm-2"]);
      });
    });

    it("uses the default author when PM_AUTHOR is unset (line 277 binary#1)", async () => {
      await withTempPmPath(async ({ pmPath }) => {
        const savedAuthor = process.env.PM_AUTHOR;
        delete process.env.PM_AUTHOR;
        try {
          await enqueuePendingRefreshIds(pmPath, ["pm-default-author"]);
          const result = await runSemanticRefreshWorker(pmPath, async (_root, ids) => ({
            refreshed: ids,
            skipped: [],
            warnings: [],
          }));
          expect(result.processed).toEqual(["pm-default-author"]);
          expect(result.rounds).toBe(1);
        } finally {
          if (savedAuthor === undefined) {
            delete process.env.PM_AUTHOR;
          } else {
            process.env.PM_AUTHOR = savedAuthor;
          }
        }
      });
    });

    it("re-enqueues and warns when refresh throws", async () => {
      await withTempPmPath(async ({ pmPath }) => {
        await enqueuePendingRefreshIds(pmPath, ["pm-err"]);
        const result = await runSemanticRefreshWorker(pmPath, async () => {
          throw new Error("embed boom");
        });
        expect(result.warnings.some((w) => w.startsWith("search_background_refresh_failed:"))).toBe(true);
        expect(await drainPendingRefreshIds(pmPath)).toEqual(["pm-err"]);
      });
    });

    it("returns without draining when the reindex lock is held", async () => {
      await withTempPmPath(async ({ pmPath }) => {
        const { acquireLock } = await import("../../../../src/core/lock/lock.js");
        await enqueuePendingRefreshIds(pmPath, ["pm-locked"]);
        const release = await acquireLock(pmPath, REINDEX_LOCK_ID, 60, "unit-lock-owner", false);
        try {
          const result = await runSemanticRefreshWorker(pmPath, async () => {
            throw new Error("must not run when locked");
          });
          expect(result).toEqual({ processed: [], rounds: 0, warnings: [] });
          expect(await drainPendingRefreshIds(pmPath)).toEqual(["pm-locked"]);
        } finally {
          await release();
        }
      });
    });

    it("re-dispatches a child when a sibling enqueues ids in the final release window (lines 322-323)", async () => {
      await withTempPmPath(async ({ pmPath }) => {
        const fakeChild = new EventEmitter() as EventEmitter & { unref: () => void };
        fakeChild.unref = vi.fn();
        const spawnSpy = vi.fn(() => fakeChild);
        spawnImpl.current = spawnSpy as never;

        await enqueuePendingRefreshIds(pmPath, ["pm-seed"]);

        // The lock-release side effect runs inside the worker's `finally`
        // (after the drain loop has emptied the queue, before the final
        // readPendingQueueIds), simulating a sibling that enqueued ids during
        // the worker's final window. readPendingQueueIds then sees the id and
        // re-dispatches a child.
        lockReleaseSideEffect.current = async () => {
          await enqueuePendingRefreshIds(pmPath, ["pm-final-window"]);
        };

        const result = await runSemanticRefreshWorker(pmPath, async (_root, ids) => ({
          refreshed: ids,
          skipped: [],
          warnings: [],
        }));

        expect(result.rounds).toBe(1);
        expect(result.processed).toEqual(["pm-seed"]);
        // The re-dispatch fired exactly once because a remaining id was found.
        expect(spawnSpy).toHaveBeenCalledTimes(1);
        expect(fakeChild.unref).toHaveBeenCalledTimes(1);
        // The remaining id is still queued for the re-dispatched child.
        expect(await drainPendingRefreshIds(pmPath)).toEqual(["pm-final-window"]);
      });
    });

    it("does not re-dispatch after a refresh failure even if ids remain (line 321 failed=true)", async () => {
      await withTempPmPath(async ({ pmPath }) => {
        const spawnSpy = vi.fn(() => {
          const child = new EventEmitter() as EventEmitter & { unref: () => void };
          child.unref = vi.fn();
          return child;
        });
        spawnImpl.current = spawnSpy as never;

        await enqueuePendingRefreshIds(pmPath, ["pm-fail"]);
        const result = await runSemanticRefreshWorker(pmPath, async () => {
          throw new Error("boom");
        });

        expect(result.warnings.some((w) => w.startsWith("search_background_refresh_failed:"))).toBe(true);
        // failed=true short-circuits remaining to [] -> no re-dispatch.
        expect(spawnSpy).not.toHaveBeenCalled();
        // The failed ids were re-enqueued for a later mutation's dispatch.
        expect(await drainPendingRefreshIds(pmPath)).toEqual(["pm-fail"]);
      });
    });
  });
});
