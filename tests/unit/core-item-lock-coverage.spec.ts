import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalDocument, normalizeFrontMatter, serializeItemDocument } from "../../src/core/item/item-format.js";
import { _testOnly as lockInternals, acquireLock } from "../../src/core/lock/lock.js";
import {
  clearActiveExtensionHooks,
  setActiveExtensionHooks,
  setActiveExtensionServices,
  type ExtensionHookRegistry,
} from "../../src/core/extensions/index.js";
import { EXIT_CODE } from "../../src/core/shared/constants.js";
import { getLockPath } from "../../src/core/store/paths.js";
import type { ItemFrontMatter } from "../../src/types/index.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

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

  it("surfaces deterministic warning tokens when lock metadata cannot be read", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const id = "pm-lock-read-failed";
      const lockPath = getLockPath(pmPath, id);
      await fs.writeFile(lockPath, `${JSON.stringify({ id, pid: 1, owner: "other-owner", created_at: STALE_TS, ttl_seconds: 60 })}\n`);
      const readSpy = vi.spyOn(fs, "readFile").mockRejectedValueOnce(Object.assign(new Error("permission denied"), { code: "EACCES" }));
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
          message: expect.stringContaining(`Failed to acquire lock for ${id}`),
        });
      } finally {
        unlinkSpy.mockRestore();
      }
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
              // Object without a `release` function → neither release shape matches,
              // so acquireLock proceeds to write a real lock file.
              run: () => ({ note: "handled but no release" }),
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
  });
});
