import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalDocument, normalizeFrontMatter, serializeItemDocument } from "../../../../src/core/item/item-format.js";
import { _testOnly as lockInternals, acquireLock } from "../../../../src/core/lock/lock.js";
import {
  clearActiveExtensionHooks,
  setActiveExtensionHooks,
  setActiveExtensionServices,
  type ExtensionHookRegistry,
} from "../../../../src/core/extensions/index.js";
import { EXIT_CODE } from "../../../../src/core/shared/constants.js";
import { getLockPath } from "../../../../src/core/store/paths.js";
import type { ItemFrontMatter } from "../../../../src/types/index.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";

const FIXED_TS = "2026-02-21T00:00:00.000Z";
const STALE_TS = "2000-01-01T00:00:00.000Z";

afterEach(() => {
  clearActiveExtensionHooks();
});

function baseFrontMatter(overrides: Partial<ItemFrontMatter> = {}): ItemFrontMatter {
  return {
    id: "pm-coverage",
    title: "Coverage",
    description: "Target branch coverage",
    type: "Task",
    status: "open",
    priority: 1,
    tags: ["coverage"],
    created_at: FIXED_TS,
    updated_at: FIXED_TS,
    ...overrides,
  };
}

describe("core/item/item-format additional branch coverage", () => {
  it("sorts dependency, log, test, and doc ties deterministically", () => {
    const normalized = normalizeFrontMatter(
      baseFrontMatter({
        dependencies: [
          { id: "PM-DEP", kind: "related", created_at: FIXED_TS, author: "  zed " },
          { id: "pm-dep", kind: "blocks", created_at: FIXED_TS, author: " " },
          { id: "pm-aaa", kind: "child", created_at: FIXED_TS, author: " owner " },
        ],
        comments: [
          { created_at: FIXED_TS, author: "zed", text: "beta" },
          { created_at: FIXED_TS, author: "beta", text: "alpha" },
          { created_at: FIXED_TS, author: "alpha", text: "beta" },
        ],
        files: [{ path: String.raw`src\cli\main.ts`, scope: "project", note: "  normalized  " }],
        tests: [
          { scope: "project", path: String.raw`tests\unit\lock.spec.ts`, command: "pnpm test", timeout_seconds: 20, note: "z" },
          { scope: "project", path: String.raw`tests\unit\lock.spec.ts`, command: "pnpm test", timeout_seconds: 10, note: "b" },
          { scope: "project", path: String.raw`tests\unit\lock.spec.ts`, command: "pnpm test", timeout_seconds: 10, note: "a" },
        ],
        docs: [
          { path: "docs/spec.md", scope: "project", note: "z" },
          { path: "docs/spec.md", scope: "project", note: "a" },
        ],
      }),
    );

    expect(normalized.dependencies?.map((value) => `${value.id}:${value.kind}`)).toEqual([
      "pm-aaa:child",
      "pm-dep:blocks",
      "pm-dep:related",
    ]);
    expect(normalized.comments?.map((value) => `${value.text}:${value.author}`)).toEqual([
      "alpha:beta",
      "beta:alpha",
      "beta:zed",
    ]);
    expect(normalized.files).toEqual([{ path: "src/cli/main.ts", scope: "project", note: "normalized" }]);
    expect(normalized.tests?.map((value) => `${value.timeout_seconds}:${value.note}`)).toEqual(["10:a", "10:b", "20:z"]);
    expect(normalized.docs?.map((value) => value.note)).toEqual(["a", "z"]);
  });

  it("uses note tie-break ordering for tests and docs with identical primary sort keys", () => {
    const normalized = normalizeFrontMatter(
      baseFrontMatter({
        tests: [
          { scope: "project", path: "tests/unit/same.spec.ts", command: "pnpm test", timeout_seconds: 42, note: "z" },
          { scope: "project", path: "tests/unit/same.spec.ts", command: "pnpm test", timeout_seconds: 42, note: "a" },
        ],
        docs: [
          { path: "docs/same.md", scope: "project", note: "z" },
          { path: "docs/same.md", scope: "project", note: "a" },
        ],
      }),
    );

    expect(normalized.tests?.map((value) => value.note)).toEqual(["a", "z"]);
    expect(normalized.docs?.map((value) => value.note)).toEqual(["a", "z"]);
  });

  it("covers dependency and linked-test comparator branch paths", () => {
    const dependencySorted = normalizeFrontMatter(
      baseFrontMatter({
        dependencies: [
          { id: "pm-newer", kind: "related", created_at: "2026-02-21T00:00:02.000Z", author: "steve" },
          { id: "pm-older", kind: "related", created_at: "2026-02-21T00:00:01.000Z", author: "steve" },
        ],
      }),
    );
    expect(dependencySorted.dependencies?.map((value) => value.id)).toEqual(["pm-older", "pm-newer"]);

    const scopeSorted = normalizeFrontMatter(
      baseFrontMatter({
        tests: [
          { scope: "project", path: "tests/unit/a.spec.ts", command: "pnpm test", timeout_seconds: 5, note: "a" },
          { scope: "global", path: "tests/unit/a.spec.ts", command: "pnpm test", timeout_seconds: 5, note: "a" },
        ],
      }),
    );
    expect(scopeSorted.tests?.map((value) => value.scope)).toEqual(["global", "project"]);

    const pathSorted = normalizeFrontMatter(
      baseFrontMatter({
        tests: [
          { scope: "project", path: "tests/unit/b.spec.ts", command: "pnpm test", timeout_seconds: 5, note: "a" },
          { scope: "project", path: "tests/unit/a.spec.ts", command: "pnpm test", timeout_seconds: 5, note: "a" },
        ],
      }),
    );
    expect(pathSorted.tests?.map((value) => value.path)).toEqual(["tests/unit/a.spec.ts", "tests/unit/b.spec.ts"]);

    const commandSorted = normalizeFrontMatter(
      baseFrontMatter({
        tests: [
          { scope: "project", path: "tests/unit/a.spec.ts", command: "z-run", timeout_seconds: 5, note: "a" },
          { scope: "project", path: "tests/unit/a.spec.ts", command: "a-run", timeout_seconds: 5, note: "a" },
        ],
      }),
    );
    expect(commandSorted.tests?.map((value) => value.command)).toEqual(["a-run", "z-run"]);

    const timeoutSorted = normalizeFrontMatter(
      baseFrontMatter({
        tests: [
          { scope: "project", path: "tests/unit/a.spec.ts", command: "pnpm test", timeout_seconds: 20, note: "a" },
          { scope: "project", path: "tests/unit/a.spec.ts", command: "pnpm test", timeout_seconds: 10, note: "a" },
        ],
      }),
    );
    expect(timeoutSorted.tests?.map((value) => value.timeout_seconds)).toEqual([10, 20]);
  });

  it("covers nullish fallback branches for optional test/doc sort keys", () => {
    const normalized = normalizeFrontMatter(
      baseFrontMatter({
        tests: [
          { scope: "project", path: "tests/unit/fallback.spec.ts" },
          { scope: "project", path: "tests/unit/fallback.spec.ts", command: " ", timeout_seconds: undefined, note: " " },
        ],
        docs: [
          { path: "docs/fallback.md", scope: "project" },
          { path: "docs/fallback.md", scope: "project", note: " " },
        ],
      }),
    );

    expect(normalized.tests).toEqual([
      { scope: "project", path: "tests/unit/fallback.spec.ts" },
      { scope: "project", path: "tests/unit/fallback.spec.ts" },
    ]);
    expect(normalized.docs).toEqual([
      { scope: "project", path: "docs/fallback.md" },
      { scope: "project", path: "docs/fallback.md" },
    ]);
  });

  it("covers optional-list empty paths and undefined body normalization", () => {
    const normalized = normalizeFrontMatter(baseFrontMatter());
    expect(normalized.dependencies).toBeUndefined();
    expect(normalized.comments).toBeUndefined();
    expect(normalized.notes).toBeUndefined();
    expect(normalized.learnings).toBeUndefined();
    expect(normalized.files).toBeUndefined();
    expect(normalized.tests).toBeUndefined();
    expect(normalized.docs).toBeUndefined();

    const serialized = serializeItemDocument({
      metadata: baseFrontMatter(),
      body: undefined as unknown as string,
    });
    expect(serialized.endsWith("\n")).toBe(true);
    const canonical = canonicalDocument({
      metadata: baseFrontMatter(),
      body: undefined as unknown as string,
    });
    expect(canonical.body).toBe("");
  });
});

describe("core/lock/lock additional branch coverage", () => {
  it("covers lock metadata helper branches directly", async () => {
    expect(lockInternals.parseLockInfo("null")).toEqual({ info: null, warnings: ["lock_info_invalid_shape"] });
    expect(lockInternals.parseLockInfo("[]")).toEqual({ info: null, warnings: ["lock_info_invalid_shape"] });
    expect(
      lockInternals.parseLockInfo(
        JSON.stringify({ id: "pm-lock", pid: Number.NaN, owner: "owner", created_at: FIXED_TS, ttl_seconds: 60 }),
      ),
    ).toEqual({
      info: null,
      warnings: ["lock_info_invalid_shape"],
    });
    expect(
      lockInternals.parseLockInfo(JSON.stringify({ id: "pm-lock", pid: 1, owner: "owner", created_at: FIXED_TS, ttl_seconds: 60 })),
    ).toMatchObject({
      info: { id: "pm-lock", owner: "owner", ttl_seconds: 60 },
      warnings: [],
    });
    expect(lockInternals.isErrno({ code: "ENOENT" }, "ENOENT")).toBe(true);
    expect(lockInternals.isErrno(null, "ENOENT")).toBe(false);
    expect(lockInternals.lockOwnerSuffix({ id: "pm-lock", pid: 1, owner: "owner", created_at: FIXED_TS, ttl_seconds: 60 })).toBe(
      " (owner owner)",
    );
    expect(lockInternals.lockOwnerSuffix(null)).toBe("");
    expect(lockInternals.isStaleLock(null, 60)).toBe(true);
    expect(lockInternals.buildLockPayload("pm-lock", "owner", 60)).toMatchObject({
      id: "pm-lock",
      pid: process.pid,
      owner: "owner",
      ttl_seconds: 60,
    });

    const tempDir = await fs.mkdtemp(path.join(process.cwd(), ".tmp-lock-read-"));
    try {
      await expect(lockInternals.readLockInfo(path.join(tempDir, "missing.lock"))).resolves.toEqual({ info: null, warnings: [] });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("resolves lock wait budgets from environment and caller fallbacks", () => {
    const previousWaitOverride = process.env.PM_LOCK_WAIT_MS;
    try {
      process.env.PM_LOCK_WAIT_MS = "75";
      expect(lockInternals.resolveLockWaitMs(10)).toBe(75);

      process.env.PM_LOCK_WAIT_MS = "invalid";
      expect(lockInternals.resolveLockWaitMs(10.9)).toBe(10);

      process.env.PM_LOCK_WAIT_MS = "75ms";
      expect(lockInternals.resolveLockWaitMs(10)).toBe(10);

      process.env.PM_LOCK_WAIT_MS = "75.5";
      expect(lockInternals.resolveLockWaitMs(10)).toBe(10);

      process.env.PM_LOCK_WAIT_MS = "999999999999999999999";
      expect(lockInternals.resolveLockWaitMs(10)).toBe(10);

      process.env.PM_LOCK_WAIT_MS = " ";
      expect(lockInternals.resolveLockWaitMs(3.8)).toBe(3);

      delete process.env.PM_LOCK_WAIT_MS;
      expect(lockInternals.resolveLockWaitMs(undefined)).toBe(0);
      expect(lockInternals.resolveLockWaitMs(-1)).toBe(0);
      expect(lockInternals.resolveLockWaitMs(Number.POSITIVE_INFINITY)).toBe(0);
    } finally {
      if (previousWaitOverride === undefined) {
        delete process.env.PM_LOCK_WAIT_MS;
      } else {
        process.env.PM_LOCK_WAIT_MS = previousWaitOverride;
      }
    }
  });

  it("dispatches extension lock lifecycle hooks for read create and release", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const id = "pm-lock-hook-lifecycle";
      const lockPath = getLockPath(pmPath, id);
      const trace: string[] = [];
      const hooks: ExtensionHookRegistry = {
        beforeCommand: [],
        afterCommand: [],
        onWrite: [
          {
            layer: "project",
            name: "lock-write-hook",
            run: (context) => {
              trace.push(`write:${context.op}:${context.path}`);
            },
          },
        ],
        onRead: [
          {
            layer: "project",
            name: "lock-read-hook",
            run: (context) => {
              trace.push(`read:${context.path}`);
            },
          },
        ],
        onIndex: [],
      };
      setActiveExtensionHooks(hooks);

      const release = await acquireLock(pmPath, id, 60, "owner-a", false);
      await expect(acquireLock(pmPath, id, 60, "owner-b", false)).rejects.toMatchObject({
        exitCode: EXIT_CODE.CONFLICT,
      });
      await release();

      expect(trace).toEqual([
        `write:lock:create:${lockPath}`,
        `read:${lockPath}`,
        `write:lock:release:${lockPath}`,
      ]);
    });
  });

  it("dispatches stale lock unlink hook when forced stale removal succeeds", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const id = "pm-lock-stale-hook";
      const lockPath = getLockPath(pmPath, id);
      const writeOps: string[] = [];
      const hooks: ExtensionHookRegistry = {
        beforeCommand: [],
        afterCommand: [],
        onWrite: [
          {
            layer: "project",
            name: "lock-write-hook",
            run: (context) => {
              writeOps.push(context.op);
            },
          },
        ],
        onRead: [],
        onIndex: [],
      };
      setActiveExtensionHooks(hooks);
      await fs.writeFile(
        lockPath,
        `${JSON.stringify({ id, pid: 1, owner: "other-owner", created_at: STALE_TS, ttl_seconds: 60 }, null, 2)}\n`,
        "utf8",
      );

      const release = await acquireLock(pmPath, id, 60, "owner-force", true);
      await release();

      expect(writeOps).toEqual(["lock:stale_remove", "lock:create", "lock:release"]);
    });
  });

  it("treats malformed lock metadata as stale and requires force", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const id = "pm-lock-malformed";
      const lockPath = getLockPath(pmPath, id);
      await fs.writeFile(lockPath, "{not-valid-json", "utf8");

      await expect(acquireLock(pmPath, id, 60, "owner-a", false)).rejects.toMatchObject({
        exitCode: EXIT_CODE.CONFLICT,
        message: expect.stringContaining("lock is stale"),
      });
      await expect(acquireLock(pmPath, id, 60, "owner-a", false)).rejects.toMatchObject({
        message: expect.stringContaining("lock_info_invalid_json"),
      });
    });
  });

  it("requires force for valid stale locks without warning suffixes", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const id = "pm-lock-valid-stale-requires-force";
      const lockPath = getLockPath(pmPath, id);
      await fs.writeFile(
        lockPath,
        `${JSON.stringify({ id, pid: 1, owner: "other-owner", created_at: STALE_TS, ttl_seconds: 60 }, null, 2)}\n`,
        "utf8",
      );

      await expect(acquireLock(pmPath, id, 60, "owner-a", false)).rejects.toMatchObject({
        exitCode: EXIT_CODE.CONFLICT,
        message: `Item ${id} lock is stale; rerun with --force when supported for this command`,
      });
    });
  });

  it("surfaces deterministic warning tokens when lock metadata cannot be read", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const id = "pm-lock-read-failed";
      const lockPath = getLockPath(pmPath, id);
      await fs.writeFile(lockPath, `${JSON.stringify({ id, pid: 1, owner: "other-owner", created_at: STALE_TS, ttl_seconds: 60 })}\n`);
      const readSpy = vi.spyOn(fs, "readFile").mockRejectedValue(Object.assign(new Error("permission denied"), { code: "EACCES" }));
      try {
        await expect(acquireLock(pmPath, id, 60, "owner-a", false)).rejects.toMatchObject({
          exitCode: EXIT_CODE.CONFLICT,
          message: expect.stringContaining("lock_info_read_failed"),
        });
      } finally {
        readSpy.mockRestore();
      }
    });
  });

  it("steals stale locks when forced and writes a replacement lock", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const id = "pm-lock-force";
      const lockPath = getLockPath(pmPath, id);
      await fs.writeFile(
        lockPath,
        `${JSON.stringify({ id, pid: 1, owner: "other-owner", created_at: STALE_TS, ttl_seconds: 60 }, null, 2)}\n`,
        "utf8",
      );

      const release = await acquireLock(pmPath, id, 60, "owner-force", true);
      const lockInfo = JSON.parse(await fs.readFile(lockPath, "utf8")) as { owner: string };
      expect(lockInfo.owner).toBe("owner-force");
      await release();
      await expect(fs.access(lockPath)).rejects.toBeInstanceOf(Error);
    });
  });

  it("auto-removes stale locks without force when policy allows it", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const id = "pm-lock-auto-stale";
      const lockPath = getLockPath(pmPath, id);
      await fs.writeFile(
        lockPath,
        `${JSON.stringify({ id, pid: 1, owner: "other-owner", created_at: STALE_TS, ttl_seconds: 60 }, null, 2)}\n`,
        "utf8",
      );

      const release = await acquireLock(pmPath, id, 60, "owner-auto", false, false);
      const lockInfo = JSON.parse(await fs.readFile(lockPath, "utf8")) as { owner: string };
      expect(lockInfo.owner).toBe("owner-auto");
      await release();
      await expect(fs.access(lockPath)).rejects.toBeInstanceOf(Error);
    });
  });

  it("reports active lock conflicts with owning actor details", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const id = "pm-lock-active";
      const lockPath = getLockPath(pmPath, id);
      const activeTs = new Date().toISOString();
      await fs.writeFile(
        lockPath,
        `${JSON.stringify({ id, pid: 1, owner: "other-owner", created_at: activeTs, ttl_seconds: 60 }, null, 2)}\n`,
        "utf8",
      );

      await expect(acquireLock(pmPath, id, 60, "owner-a", false)).rejects.toMatchObject({
        exitCode: EXIT_CODE.CONFLICT,
        message: expect.stringContaining("owner other-owner"),
      });
    });
  });

  it("reports active lock conflicts without owner suffix when owner metadata is empty", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const id = "pm-lock-active-no-owner";
      const lockPath = getLockPath(pmPath, id);
      const activeTs = new Date().toISOString();
      await fs.writeFile(
        lockPath,
        `${JSON.stringify({ id, pid: 1, owner: "", created_at: activeTs, ttl_seconds: 60 }, null, 2)}\n`,
        "utf8",
      );

      await expect(acquireLock(pmPath, id, 60, "owner-a", false)).rejects.toMatchObject({
        exitCode: EXIT_CODE.CONFLICT,
        message: "Item pm-lock-active-no-owner is locked",
      });
    });
  });

  it("waits with bounded jitter before reporting an active lock conflict", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const id = "pm-lock-active-wait";
      const lockPath = getLockPath(pmPath, id);
      const activeTs = new Date().toISOString();
      await fs.writeFile(
        lockPath,
        `${JSON.stringify({ id, pid: 1, owner: "other-owner", created_at: activeTs, ttl_seconds: 60 }, null, 2)}\n`,
        "utf8",
      );
      const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.5);
      try {
        await expect(acquireLock(pmPath, id, 60, "owner-a", false, true, 2)).rejects.toMatchObject({
          exitCode: EXIT_CODE.CONFLICT,
          context: {
            code: "lock_conflict",
            recovery: {
              retry_after_ms: 250,
            },
          },
          message: expect.stringMatching(/after waiting \d+ms/),
        });
      } finally {
        randomSpy.mockRestore();
      }
    });
  });

  it("allows release callbacks to ignore missing lock files", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const id = "pm-lock-release-missing";
      const lockPath = getLockPath(pmPath, id);
      const release = await acquireLock(pmPath, id, 60, "owner-a", false);

      await fs.unlink(lockPath);
      await expect(release()).resolves.toBeUndefined();
    });
  });

  it("creates missing lock directories before acquiring locks", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const missingRoot = path.join(pmPath, "..", "missing-lock-root");
      const id = "pm-lock-missing";
      const release = await acquireLock(missingRoot, id, 60, "owner-a", false);
      await expect(fs.access(getLockPath(missingRoot, id))).resolves.toBeUndefined();
      await release();
    });
  });

  it("falls back to stringified error text when acquire lock failure lacks a message", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const openSpy = vi.spyOn(fs, "open").mockRejectedValueOnce(new Error("   "));
      try {
        await expect(acquireLock(pmPath, "pm-lock-empty-error", 60, "owner-a", false)).rejects.toMatchObject({
          exitCode: EXIT_CODE.GENERIC_FAILURE,
          message: expect.stringContaining("Failed to acquire lock for pm-lock-empty-error: Error"),
        });
      } finally {
        openSpy.mockRestore();
      }
    });
  });

  it("fails after bounded retries when forced stale lock removal cannot unlink file", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const id = "pm-lock-force-retry-fail";
      const lockPath = getLockPath(pmPath, id);
      await fs.writeFile(
        lockPath,
        `${JSON.stringify({ id, pid: 1, owner: "other-owner", created_at: STALE_TS, ttl_seconds: 60 }, null, 2)}\n`,
        "utf8",
      );

      const unlinkSpy = vi.spyOn(fs, "unlink").mockImplementation(async (targetPath) => {
        if (String(targetPath) === lockPath) {
          throw Object.assign(new Error("unlink denied"), { code: "EPERM" });
        }
      });

      try {
        await expect(acquireLock(pmPath, id, 60, "owner-force", true)).rejects.toMatchObject({
          exitCode: EXIT_CODE.CONFLICT,
          context: {
            code: "lock_conflict",
            recovery: {
              retry_after_ms: 250,
            },
          },
          message: expect.stringContaining(`Item ${id} is locked`),
        });
      } finally {
        unlinkSpy.mockRestore();
      }
    });
  });

  it("keeps the observed stale lock when another process owns cleanup", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const id = "pm-lock-stale-cleanup-busy";
      const lockPath = getLockPath(pmPath, id);
      const fallbackLockInfo = {
        info: { id, pid: 1, owner: "fallback-owner", created_at: STALE_TS, ttl_seconds: 60 },
        warnings: [],
      };
      await fs.mkdir(`${lockPath}.stale-cleanup`);

      try {
        await expect(
          lockInternals.removeConfirmedStaleLock({
            lockPath,
            id,
            ttlSeconds: 60,
            force: true,
            forceRequiredForStaleLock: false,
            staleRemovals: 0,
            waitBudgetMs: 10,
            startedAtMs: Date.now(),
            fallbackLockInfo,
          }),
        ).resolves.toEqual({
          lockInfo: fallbackLockInfo,
          shouldRetryCreate: false,
          staleRemovalCounted: false,
        });
      } finally {
        await fs.rm(`${lockPath}.stale-cleanup`, { recursive: true, force: true });
      }
    });
  });

  it("does not count a stale removal when acquire sees a busy cleanup gate", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const id = "pm-lock-stale-cleanup-busy-acquire";
      const lockPath = getLockPath(pmPath, id);
      await fs.writeFile(
        lockPath,
        `${JSON.stringify({ id, pid: 1, owner: "other-owner", created_at: STALE_TS, ttl_seconds: 60 }, null, 2)}\n`,
        "utf8",
      );
      await fs.mkdir(`${lockPath}.stale-cleanup`);

      try {
        await expect(acquireLock(pmPath, id, 60, "owner-force", true, false, 0)).rejects.toMatchObject({
          exitCode: EXIT_CODE.CONFLICT,
          message: expect.stringContaining("owner other-owner"),
        });
      } finally {
        await fs.rm(`${lockPath}.stale-cleanup`, { recursive: true, force: true });
      }
    });
  });

  it("recovers an expired stale cleanup gate before removing an abandoned lock", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const id = "pm-lock-stale-cleanup-orphan";
      const lockPath = getLockPath(pmPath, id);
      const gatePath = `${lockPath}.stale-cleanup`;
      await fs.writeFile(
        lockPath,
        `${JSON.stringify({ id, pid: 1, owner: "other-owner", created_at: STALE_TS, ttl_seconds: 60 }, null, 2)}\n`,
        "utf8",
      );
      await fs.mkdir(gatePath);
      const orphanedAt = new Date(Date.now() - 20_000);
      await fs.utimes(gatePath, orphanedAt, orphanedAt);

      const release = await acquireLock(pmPath, id, 60, "owner-force", true, false, 0);

      const lockInfo = JSON.parse(await fs.readFile(lockPath, "utf8")) as { owner: string };
      expect(lockInfo.owner).toBe("owner-force");
      await expect(fs.access(gatePath)).rejects.toMatchObject({ code: "ENOENT" });
      await release();
    });
  });

  it("does not steal an expired stale cleanup gate owned by a live process", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const id = "pm-lock-stale-cleanup-live-owner";
      const lockPath = getLockPath(pmPath, id);
      const gatePath = `${lockPath}.stale-cleanup`;
      await fs.mkdir(gatePath);
      await fs.writeFile(`${gatePath}/owner.json`, `${JSON.stringify({ pid: process.pid, token: "active-owner" })}\n`, "utf8");
      const orphanedAt = new Date(Date.now() - 20_000);
      await fs.utimes(gatePath, orphanedAt, orphanedAt);

      await expect(lockInternals.acquireStaleCleanupGate(lockPath, id)).resolves.toBeNull();
      await expect(fs.access(gatePath)).resolves.toBeUndefined();
    });
  });

  it("recovers a max-aged stale cleanup gate even when the recorded pid is live", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const id = "pm-lock-stale-cleanup-live-owner-too-old";
      const lockPath = getLockPath(pmPath, id);
      const gatePath = `${lockPath}.stale-cleanup`;
      await fs.mkdir(gatePath);
      await fs.writeFile(`${gatePath}/owner.json`, `${JSON.stringify({ pid: process.pid, token: "reused-pid-owner" })}\n`, "utf8");
      const orphanedAt = new Date(Date.now() - 10 * 60_000);
      await fs.utimes(gatePath, orphanedAt, orphanedAt);

      const release = await lockInternals.acquireStaleCleanupGate(lockPath, id);
      if (release === null) {
        throw new Error("expected stale cleanup gate release");
      }
      await release();
      await expect(fs.access(gatePath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("treats permission-denied process probes as live stale cleanup owners", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const id = "pm-lock-stale-cleanup-eperm-owner";
      const lockPath = getLockPath(pmPath, id);
      const gatePath = `${lockPath}.stale-cleanup`;
      await fs.mkdir(gatePath);
      await fs.writeFile(`${gatePath}/owner.json`, `${JSON.stringify({ pid: 1234, token: "protected-owner" })}\n`, "utf8");
      const orphanedAt = new Date(Date.now() - 20_000);
      await fs.utimes(gatePath, orphanedAt, orphanedAt);
      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
        throw Object.assign(new Error("permission denied"), { code: "EPERM" });
      });

      try {
        await expect(lockInternals.acquireStaleCleanupGate(lockPath, id)).resolves.toBeNull();
        await expect(fs.access(gatePath)).resolves.toBeUndefined();
      } finally {
        killSpy.mockRestore();
      }
    });
  });

  it("recovers an expired stale cleanup gate owned by a dead process", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const id = "pm-lock-stale-cleanup-dead-owner";
      const lockPath = getLockPath(pmPath, id);
      const gatePath = `${lockPath}.stale-cleanup`;
      await fs.mkdir(gatePath);
      await fs.writeFile(`${gatePath}/owner.json`, `${JSON.stringify({ pid: 1234, token: "dead-owner" })}\n`, "utf8");
      const orphanedAt = new Date(Date.now() - 20_000);
      await fs.utimes(gatePath, orphanedAt, orphanedAt);
      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
        throw Object.assign(new Error("missing process"), { code: "ESRCH" });
      });

      try {
        const release = await lockInternals.acquireStaleCleanupGate(lockPath, id);
        if (release === null) {
          throw new Error("expected stale cleanup gate release");
        }
        await release();
        await expect(fs.access(gatePath)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        killSpy.mockRestore();
      }
    });
  });

  it("ignores invalid owner metadata when recovering an expired stale cleanup gate", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const id = "pm-lock-stale-cleanup-invalid-owner";
      const lockPath = getLockPath(pmPath, id);
      const gatePath = `${lockPath}.stale-cleanup`;
      await fs.mkdir(gatePath);
      await fs.writeFile(`${gatePath}/owner.json`, "not json\n", "utf8");
      const orphanedAt = new Date(Date.now() - 20_000);
      await fs.utimes(gatePath, orphanedAt, orphanedAt);

      const release = await lockInternals.acquireStaleCleanupGate(lockPath, id);
      if (release === null) {
        throw new Error("expected stale cleanup gate release");
      }
      await release();
      await expect(fs.access(gatePath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("ignores malformed owner shapes when recovering expired stale cleanup gates", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const shapeCases = [
        { id: "pm-lock-stale-cleanup-owner-array", rawOwner: "[]\n" },
        { id: "pm-lock-stale-cleanup-owner-fields", rawOwner: "{\"pid\":0,\"token\":\"\"}\n" },
      ];
      for (const { id, rawOwner } of shapeCases) {
        const lockPath = getLockPath(pmPath, id);
        const gatePath = `${lockPath}.stale-cleanup`;
        await fs.mkdir(gatePath);
        await fs.writeFile(`${gatePath}/owner.json`, rawOwner, "utf8");
        const orphanedAt = new Date(Date.now() - 20_000);
        await fs.utimes(gatePath, orphanedAt, orphanedAt);

        const release = await lockInternals.acquireStaleCleanupGate(lockPath, id);
        if (release === null) {
          throw new Error("expected stale cleanup gate release");
        }
        await release();
        await expect(fs.access(gatePath)).rejects.toMatchObject({ code: "ENOENT" });
      }
    });
  });

  it("does not release a stale cleanup gate recreated by another owner", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const id = "pm-lock-stale-cleanup-release-token";
      const lockPath = getLockPath(pmPath, id);
      const gatePath = `${lockPath}.stale-cleanup`;
      const release = await lockInternals.acquireStaleCleanupGate(lockPath, id);
      if (release === null) {
        throw new Error("expected stale cleanup gate release");
      }
      await fs.rm(gatePath, { recursive: true, force: true });
      await fs.mkdir(gatePath);
      await fs.writeFile(`${gatePath}/owner.json`, `${JSON.stringify({ pid: process.pid, token: "new-owner" })}\n`, "utf8");

      await release();

      await expect(fs.access(gatePath)).resolves.toBeUndefined();
      await fs.rm(gatePath, { recursive: true, force: true });
    });
  });

  it("does not release a stale cleanup gate when owner metadata cannot be read", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const id = "pm-lock-stale-cleanup-release-missing-owner";
      const lockPath = getLockPath(pmPath, id);
      const gatePath = `${lockPath}.stale-cleanup`;
      const release = await lockInternals.acquireStaleCleanupGate(lockPath, id);
      if (release === null) {
        throw new Error("expected stale cleanup gate release");
      }
      await fs.rm(`${gatePath}/owner.json`, { force: true });

      await release();

      await expect(fs.access(gatePath)).resolves.toBeUndefined();
      await fs.rm(gatePath, { recursive: true, force: true });
    });
  });

  it("does not let an old release remove a replacement gate before owner metadata is written", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const id = "pm-lock-stale-cleanup-release-replacement-window";
      const lockPath = getLockPath(pmPath, id);
      const gatePath = `${lockPath}.stale-cleanup`;
      const release = await lockInternals.acquireStaleCleanupGate(lockPath, id);
      if (release === null) {
        throw new Error("expected stale cleanup gate release");
      }
      await fs.rm(gatePath, { recursive: true, force: true });
      await fs.mkdir(gatePath);

      await release();

      await expect(fs.access(gatePath)).resolves.toBeUndefined();
      await fs.rm(gatePath, { recursive: true, force: true });
    });
  });

  it("treats stale cleanup gate release failures as best-effort cleanup", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const id = "pm-lock-stale-cleanup-release-fail";
      const lockPath = getLockPath(pmPath, id);
      const gatePath = `${lockPath}.stale-cleanup`;
      const release = await lockInternals.acquireStaleCleanupGate(lockPath, id);
      if (release === null) {
        throw new Error("expected stale cleanup gate release");
      }
      const realRm = fs.rm;
      const rmSpy = vi.spyOn(fs, "rm").mockImplementation(async (targetPath, options) => {
        if (String(targetPath) === gatePath) {
          throw Object.assign(new Error("release denied"), { code: "EACCES" });
        }
        await realRm(targetPath, options);
      });

      try {
        await expect(release()).resolves.toBeUndefined();
      } finally {
        rmSpy.mockRestore();
        await fs.rm(gatePath, { recursive: true, force: true });
      }
    });
  });

  it("keeps stale cleanup busy and cleans up when stale cleanup owner write fails", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const id = "pm-lock-stale-cleanup-owner-write-fail";
      const lockPath = getLockPath(pmPath, id);
      const gatePath = `${lockPath}.stale-cleanup`;
      const realWriteFile = fs.writeFile;
      const writeFileSpy = vi.spyOn(fs, "writeFile").mockImplementation(async (targetPath, data, options) => {
        if (String(targetPath) === `${gatePath}/owner.json`) {
          throw Object.assign(new Error("owner denied"), { code: "EACCES" });
        }
        await realWriteFile(targetPath, data, options);
      });

      try {
        await expect(lockInternals.acquireStaleCleanupGate(lockPath, id)).resolves.toBeNull();
        await expect(fs.access(gatePath)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        writeFileSpy.mockRestore();
      }
    });
  });

  it("acquires stale cleanup when a raced gate disappears before stat", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const id = "pm-lock-stale-cleanup-disappeared";
      const lockPath = getLockPath(pmPath, id);
      const gatePath = `${lockPath}.stale-cleanup`;
      const realMkdir = fs.mkdir;
      let gateMkdirAttempts = 0;
      const mkdirSpy = vi.spyOn(fs, "mkdir").mockImplementation(async (targetPath, options) => {
        if (String(targetPath) === gatePath) {
          gateMkdirAttempts += 1;
          if (gateMkdirAttempts === 1) {
            throw Object.assign(new Error("cleanup raced"), { code: "EEXIST" });
          }
        }
        await realMkdir(targetPath, options);
      });
      const statSpy = vi.spyOn(fs, "stat").mockRejectedValueOnce(Object.assign(new Error("cleanup gone"), { code: "ENOENT" }));

      try {
        const release = await lockInternals.acquireStaleCleanupGate(lockPath, id);
        expect(gateMkdirAttempts).toBe(2);
        if (release === null) {
          throw new Error("expected stale cleanup gate release");
        }
        await release();
      } finally {
        mkdirSpy.mockRestore();
        statSpy.mockRestore();
      }
    });
  });

  it("keeps stale cleanup busy when gate stat fails unexpectedly", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const id = "pm-lock-stale-cleanup-stat-fail";
      const lockPath = getLockPath(pmPath, id);
      const gatePath = `${lockPath}.stale-cleanup`;
      const realMkdir = fs.mkdir;
      const mkdirSpy = vi.spyOn(fs, "mkdir").mockImplementation(async (targetPath, options) => {
        if (String(targetPath) === gatePath) {
          throw Object.assign(new Error("cleanup busy"), { code: "EEXIST" });
        }
        await realMkdir(targetPath, options);
      });
      const statSpy = vi.spyOn(fs, "stat").mockRejectedValueOnce(Object.assign(new Error("stat denied"), { code: "EACCES" }));

      try {
        await expect(lockInternals.acquireStaleCleanupGate(lockPath, id)).resolves.toBeNull();
      } finally {
        mkdirSpy.mockRestore();
        statSpy.mockRestore();
      }
    });
  });

  it("keeps stale cleanup busy when an expired gate cannot be removed", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const id = "pm-lock-stale-cleanup-remove-fail";
      const lockPath = getLockPath(pmPath, id);
      const gatePath = `${lockPath}.stale-cleanup`;
      await fs.mkdir(gatePath);
      const orphanedAt = new Date(Date.now() - 20_000);
      await fs.utimes(gatePath, orphanedAt, orphanedAt);
      const realRm = fs.rm;
      const rmSpy = vi.spyOn(fs, "rm").mockImplementation(async (targetPath, options) => {
        if (String(targetPath) === gatePath) {
          throw Object.assign(new Error("remove denied"), { code: "EPERM" });
        }
        await realRm(targetPath, options);
      });

      try {
        await expect(lockInternals.acquireStaleCleanupGate(lockPath, id)).resolves.toBeNull();
      } finally {
        rmSpy.mockRestore();
        await fs.rm(gatePath, { recursive: true, force: true });
      }
    });
  });

  it("keeps stale cleanup busy when another process recreates an expired gate first", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const id = "pm-lock-stale-cleanup-recreated";
      const lockPath = getLockPath(pmPath, id);
      const gatePath = `${lockPath}.stale-cleanup`;
      await fs.mkdir(gatePath);
      const orphanedAt = new Date(Date.now() - 20_000);
      await fs.utimes(gatePath, orphanedAt, orphanedAt);
      let gateMkdirAttempts = 0;
      const realMkdir = fs.mkdir;
      const mkdirSpy = vi.spyOn(fs, "mkdir").mockImplementation(async (targetPath, options) => {
        if (String(targetPath) === gatePath) {
          gateMkdirAttempts += 1;
          throw Object.assign(new Error("cleanup busy"), { code: "EEXIST" });
        }
        await realMkdir(targetPath, options);
      });

      try {
        await expect(lockInternals.acquireStaleCleanupGate(lockPath, id)).resolves.toBeNull();
        expect(gateMkdirAttempts).toBe(2);
        await expect(fs.access(gatePath)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        mkdirSpy.mockRestore();
      }
    });
  });

  it("keeps stale cleanup busy when gate creation fails unexpectedly", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const id = "pm-lock-stale-cleanup-gate-failure";
      const lockPath = getLockPath(pmPath, id);
      const fallbackLockInfo = {
        info: { id, pid: 1, owner: "fallback-owner", created_at: STALE_TS, ttl_seconds: 60 },
        warnings: [],
      };
      const realMkdir = fs.mkdir;
      const mkdirSpy = vi.spyOn(fs, "mkdir").mockImplementation(async (targetPath, options) => {
        if (String(targetPath) === `${lockPath}.stale-cleanup`) {
          throw Object.assign(new Error("permission denied"), { code: "EACCES" });
        }
        await realMkdir(targetPath, options);
      });

      try {
        await expect(
          lockInternals.removeConfirmedStaleLock({
            lockPath,
            id,
            ttlSeconds: 60,
            force: true,
            forceRequiredForStaleLock: false,
            staleRemovals: 0,
            waitBudgetMs: 10,
            startedAtMs: Date.now(),
            fallbackLockInfo,
          }),
        ).resolves.toEqual({
          lockInfo: fallbackLockInfo,
          shouldRetryCreate: false,
          staleRemovalCounted: false,
        });
      } finally {
        mkdirSpy.mockRestore();
      }
    });
  });

  it("retries create when stale cleanup finds the lock already gone", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const id = "pm-lock-stale-cleanup-gone";
      const lockPath = getLockPath(pmPath, id);
      const fallbackLockInfo = {
        info: { id, pid: 1, owner: "fallback-owner", created_at: STALE_TS, ttl_seconds: 60 },
        warnings: [],
      };

      await expect(
        lockInternals.removeConfirmedStaleLock({
          lockPath,
          id,
          ttlSeconds: 60,
          force: true,
          forceRequiredForStaleLock: false,
          staleRemovals: 0,
          waitBudgetMs: 10,
          startedAtMs: Date.now(),
          fallbackLockInfo,
        }),
      ).resolves.toEqual({
        lockInfo: { info: null, warnings: [] },
        shouldRetryCreate: true,
        staleRemovalCounted: false,
      });
    });
  });

  it("keeps a refreshed lock discovered during stale cleanup", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const id = "pm-lock-stale-cleanup-refresh";
      const lockPath = getLockPath(pmPath, id);
      const freshLockInfo = { id, pid: process.pid, owner: "fresh-owner", created_at: new Date().toISOString(), ttl_seconds: 60 };
      await fs.writeFile(lockPath, `${JSON.stringify(freshLockInfo, null, 2)}\n`, "utf8");

      const result = await lockInternals.removeConfirmedStaleLock({
        lockPath,
        id,
        ttlSeconds: 60,
        force: true,
        forceRequiredForStaleLock: false,
        staleRemovals: 0,
        waitBudgetMs: 10,
        startedAtMs: Date.now(),
        fallbackLockInfo: {
          info: { id, pid: 1, owner: "fallback-owner", created_at: STALE_TS, ttl_seconds: 60 },
          warnings: [],
        },
      });

      expect(result).toEqual({
        lockInfo: { info: freshLockInfo, warnings: [] },
        shouldRetryCreate: false,
        staleRemovalCounted: false,
      });
    });
  });

  it("reports a conflict after exhausting stale cleanup retries", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const id = "pm-lock-stale-cleanup-exhausted";
      const lockPath = getLockPath(pmPath, id);
      const fallbackLockInfo = {
        info: { id, pid: 1, owner: "fallback-owner", created_at: STALE_TS, ttl_seconds: 60 },
        warnings: [],
      };
      await fs.writeFile(lockPath, `${JSON.stringify(fallbackLockInfo.info, null, 2)}\n`, "utf8");

      await expect(
        lockInternals.removeConfirmedStaleLock({
          lockPath,
          id,
          ttlSeconds: 60,
          force: true,
          forceRequiredForStaleLock: false,
          staleRemovals: 3,
          waitBudgetMs: 10,
          startedAtMs: Date.now() - 25,
          fallbackLockInfo,
        }),
      ).rejects.toMatchObject({
        exitCode: EXIT_CODE.CONFLICT,
        context: {
          code: "lock_conflict",
          recovery: {
            retry_after_ms: 250,
          },
        },
      });
    });
  });

  it("serializes stale cleanup so contenders cannot delete a fresh replacement lock", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const id = "pm-lock-stale-cleanup-race";
      const lockPath = getLockPath(pmPath, id);
      await fs.writeFile(
        lockPath,
        `${JSON.stringify({ id, pid: 1, owner: "stale-owner", created_at: STALE_TS, ttl_seconds: 60 }, null, 2)}\n`,
        "utf8",
      );

      const realUnlink = fs.unlink;
      let releaseFirstUnlink = (): void => {};
      const firstUnlinkStarted = new Promise<void>((resolve) => {
        const allowFirstUnlink = new Promise<void>((allow) => {
          releaseFirstUnlink = allow;
        });
        const unlinkSpy = vi.spyOn(fs, "unlink").mockImplementation(async (targetPath) => {
          if (String(targetPath) === lockPath) {
            unlinkSpy.mockRestore();
            resolve();
            await allowFirstUnlink;
          }
          await realUnlink(targetPath);
        });
      });

      const firstAcquire = acquireLock(pmPath, id, 60, "owner-a", true, false, 100);
      await firstUnlinkStarted;
      const secondAcquire = acquireLock(pmPath, id, 60, "owner-b", true, false, 5);
      releaseFirstUnlink();

      const outcomes = await Promise.allSettled([firstAcquire, secondAcquire]);
      const fulfilled = outcomes.filter((outcome): outcome is PromiseFulfilledResult<() => Promise<void>> => outcome.status === "fulfilled");
      const rejected = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
      const fulfilledIndex = outcomes.findIndex((outcome) => outcome.status === "fulfilled");
      const expectedOwner = fulfilledIndex === 0 ? "owner-a" : "owner-b";
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]?.reason).toMatchObject({ exitCode: EXIT_CODE.CONFLICT });

      const lockInfo = JSON.parse(await fs.readFile(lockPath, "utf8")) as { owner: string };
      expect(lockInfo.owner).toBe(expectedOwner);
      await fulfilled[0]?.value();
    });
  });

  describe("lock_acquire service override", () => {
    it("uses an override that returns a release function and never writes a lock file", async () => {
      await withTempPmPath(async ({ pmPath }) => {
        const id = "pm-lock-override-fn";
        let released = false;
        const lockReleaseCalls: unknown[] = [];
        setActiveExtensionServices({
          overrides: [
            {
              layer: "project",
              name: "lock-acquire-fn",
              service: "lock_acquire",
              run: () => () => {
                released = true;
              },
            },
            {
              layer: "project",
              name: "lock-release-observer",
              service: "lock_release",
              run: (context) => {
                lockReleaseCalls.push(context.payload);
                return { ok: true };
              },
            },
          ],
        });

        const release = await acquireLock(pmPath, id, 60, "owner-override", false);
        // The override fully handled acquisition — no lock file should exist.
        await expect(fs.access(getLockPath(pmPath, id))).rejects.toMatchObject({ code: "ENOENT" });

        await release();
        expect(released).toBe(true);
        expect(lockReleaseCalls).toHaveLength(1);
      });
    });

    it("uses an override that returns an object exposing a release method", async () => {
      await withTempPmPath(async ({ pmPath }) => {
        const id = "pm-lock-override-obj";
        let released = false;
        setActiveExtensionServices({
          overrides: [
            {
              layer: "project",
              name: "lock-acquire-obj",
              service: "lock_acquire",
              run: () => ({
                release: async () => {
                  released = true;
                },
              }),
            },
          ],
        });

        const release = await acquireLock(pmPath, id, 60, "owner-override", false);
        await expect(fs.access(getLockPath(pmPath, id))).rejects.toMatchObject({ code: "ENOENT" });
        await release();
        expect(released).toBe(true);
      });
    });

    it("falls back to file-based locking when the override is handled but exposes no release", async () => {
      await withTempPmPath(async ({ pmPath }) => {
        const id = "pm-lock-override-no-release";
        setActiveExtensionServices({
          overrides: [
            {
              layer: "project",
              name: "lock-acquire-noop",
              service: "lock_acquire",
              // Object without a callable `release` function → neither release shape matches,
              // so acquireLock proceeds to write a real lock file.
              run: () => ({ release: "not-callable" }),
            },
          ],
        });

        const release = await acquireLock(pmPath, id, 60, "owner-override", false);
        // The real file-based lock path ran, so the lock file exists.
        await expect(fs.access(getLockPath(pmPath, id))).resolves.toBeUndefined();
        await release();
        await expect(fs.access(getLockPath(pmPath, id))).rejects.toMatchObject({ code: "ENOENT" });
      });
    });

    it("falls back to file-based locking when a handled override returns null", async () => {
      await withTempPmPath(async ({ pmPath }) => {
        const id = "pm-lock-override-null";
        setActiveExtensionServices({
          overrides: [
            {
              layer: "project",
              name: "lock-acquire-null",
              service: "lock_acquire",
              run: () => null,
            },
          ],
        });

        const release = await acquireLock(pmPath, id, 60, "owner-override", false);
        await expect(fs.access(getLockPath(pmPath, id))).resolves.toBeUndefined();
        await release();
        await expect(fs.access(getLockPath(pmPath, id))).rejects.toMatchObject({ code: "ENOENT" });
      });
    });
  });
});
