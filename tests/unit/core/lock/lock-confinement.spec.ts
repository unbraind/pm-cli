import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LOCK_PATH_UNSAFE_CODE,
  assertLockEntryNotSymlink,
  inspectConfinedLockDirectory,
  verifyConfinedLockCreation,
} from "../../../../src/core/lock/lock-confinement.js";
import { runLockGc } from "../../../../src/core/lock/lock-gc.js";
import { acquireLock, acquireLockLease } from "../../../../src/core/lock/lock.js";
import { EXIT_CODE } from "../../../../src/core/shared/constants.js";
import { PmCliError } from "../../../../src/core/shared/errors.js";
import { getLockPath } from "../../../../src/core/store/paths.js";
import { withTempDir } from "../../../helpers/temp.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const symlinkSupported = process.platform !== "win32";

async function makeTracker(tempDir: string): Promise<{ pmRoot: string; outside: string }> {
  const pmRoot = path.join(tempDir, "tracker");
  const outside = path.join(tempDir, "outside");
  await fs.mkdir(pmRoot, { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  return { pmRoot, outside };
}

async function captureRefusal(run: () => Promise<unknown>): Promise<PmCliError> {
  try {
    await run();
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(PmCliError);
    return error as PmCliError;
  }
  throw new Error("expected a lock_path_unsafe refusal");
}

// The regular-file case needs no symlink, so it runs on every platform.
describe("tracker lock directory type (pm-gh1647)", () => {
  it("refuses when the lock directory is a regular file instead of waiting or wrapping the error", async () => {
    await withTempDir("pm-lock-confine-", async (tempDir) => {
      const { pmRoot } = await makeTracker(tempDir);
      await fs.writeFile(path.join(pmRoot, "locks"), "not a directory");

      const error = await captureRefusal(() => acquireLock(pmRoot, "probe", 30, "repro", false, true, 0));

      expect(error.context).toMatchObject({ code: LOCK_PATH_UNSAFE_CODE, reason: "lock_directory_not_directory" });
    });
  });
});

describe.skipIf(!symlinkSupported)("tracker lock confinement (pm-gh1647)", () => {
  it.each([
    ["acquireLock", (pmRoot: string) => acquireLock(pmRoot, "probe", 30, "repro")],
    ["acquireLockLease", (pmRoot: string) => acquireLockLease(pmRoot, "probe", 30, "repro")],
  ])("%s refuses a pre-existing symlinked locks directory and writes nothing outside the tracker", async (_name, acquire) => {
    await withTempDir("pm-lock-confine-", async (tempDir) => {
      const { pmRoot, outside } = await makeTracker(tempDir);
      await fs.symlink(outside, path.join(pmRoot, "locks"), "dir");

      const error = await captureRefusal(() => acquire(pmRoot));

      expect(error.exitCode).toBe(EXIT_CODE.CONFLICT);
      expect(error.context).toMatchObject({
        code: LOCK_PATH_UNSAFE_CODE,
        item_id: "probe",
        reason: "lock_directory_symlink",
        lock_component: "locks",
      });
      expect(error.message).toContain("Refused to acquire lock probe");
      expect(await fs.readdir(outside)).toEqual([]);
    });
  });

  it("refuses a symlinked lock entry instead of treating it as a peer's lock", async () => {
    await withTempDir("pm-lock-confine-", async (tempDir) => {
      const { pmRoot, outside } = await makeTracker(tempDir);
      await fs.mkdir(path.join(pmRoot, "locks"));
      const target = path.join(outside, "foreign.lock");
      await fs.writeFile(target, "{}\n");
      await fs.symlink(target, getLockPath(pmRoot, "probe"));

      const error = await captureRefusal(() => acquireLockLease(pmRoot, "probe", 30, "repro", false, true, 0));

      expect(error.context).toMatchObject({
        code: LOCK_PATH_UNSAFE_CODE,
        reason: "lock_entry_symlink",
        lock_component: "locks/probe.lock",
        required: expect.stringContaining("Remove the symlinked lock entry locks/probe.lock") as unknown as string,
      });
      expect(await fs.readFile(target, "utf8")).toBe("{}\n");
    });
  });

  it("detects a locks directory swapped for a symlink during acquisition and never deletes outside the tracker", async () => {
    await withTempDir("pm-lock-confine-", async (tempDir) => {
      const { pmRoot, outside } = await makeTracker(tempDir);
      const locksDir = path.join(pmRoot, "locks");
      await fs.mkdir(locksDir);
      const lockPath = getLockPath(pmRoot, "probe");
      const realOpen = fs.open.bind(fs);
      vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        if (args[0] === lockPath) {
          await fs.rename(locksDir, path.join(pmRoot, "locks.orig"));
          await fs.symlink(outside, locksDir, "dir");
        }
        return realOpen(...args);
      });

      const error = await captureRefusal(() => acquireLock(pmRoot, "probe", 30, "repro"));

      expect(error.context).toMatchObject({
        code: LOCK_PATH_UNSAFE_CODE,
        reason: "lock_directory_replaced",
        lock_component: "locks",
        required: expect.stringContaining("pm never deletes outside the tracker") as unknown as string,
      });
      expect(error.context).not.toHaveProperty("stray_lock_removed");
      // The stray lock this acquisition created stays where the swap pointed.
      expect(await fs.readdir(outside)).toEqual(["probe.lock"]);
      // The swapped-away real directory holds no lock; only the acquisition's
      // own cleanup gate remains, and dead-owner recovery retires it.
      const confinedEntries = await fs.readdir(path.join(pmRoot, "locks.orig"));
      expect(confinedEntries.filter((entry) => entry.endsWith(".lock"))).toEqual([]);
    });
  });

  it(
    "never unlinks a peer's lock at the confined path when a swapped-back acquisition refuses",
    async () => {
      await withTempDir("pm-lock-confine-", async (tempDir) => {
        const { pmRoot, outside } = await makeTracker(tempDir);
        const locksDir = path.join(pmRoot, "locks");
        await fs.mkdir(locksDir);
        const lockPath = getLockPath(pmRoot, "probe");
        const peerLock = '{"owner":"peer"}\n';
        const realOpen = fs.open.bind(fs);
        vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
          if (args[0] !== lockPath) return realOpen(...args);
          await fs.rename(locksDir, path.join(pmRoot, "locks.orig"));
          await fs.symlink(outside, locksDir, "dir");
          const handle = await realOpen(...args);
          await fs.unlink(locksDir);
          await fs.rename(path.join(pmRoot, "locks.orig"), locksDir);
          await fs.writeFile(lockPath, peerLock, { flag: "wx" });
          return handle;
        });

        const error = await captureRefusal(() => acquireLock(pmRoot, "probe", 30, "repro"));

        expect(error.context).toMatchObject({ reason: "lock_directory_replaced" });
        expect(await fs.readFile(lockPath, "utf8")).toBe(peerLock);
        expect(await fs.readdir(outside)).toEqual(["probe.lock"]);
      });
    },
  );

  it("acquires and releases normally through a real locks directory under a symlinked tracker root", async () => {
    await withTempDir("pm-lock-confine-", async (tempDir) => {
      const { pmRoot } = await makeTracker(tempDir);
      const linkedRoot = path.join(tempDir, "tracker-link");
      await fs.symlink(pmRoot, linkedRoot, "dir");

      const lease = await acquireLockLease(linkedRoot, "probe", 30, "repro");
      expect(await fs.readdir(path.join(pmRoot, "locks"))).toContain("probe.lock");
      await expect(lease.fence(async () => "committed")).resolves.toBe("committed");
      await lease.release();
      expect(await fs.readdir(path.join(pmRoot, "locks"))).not.toContain("probe.lock");
    });
  });

  it("pm gc --scope locks refuses to sweep through a symlinked locks directory", async () => {
    await withTempDir("pm-lock-confine-", async (tempDir) => {
      const { pmRoot, outside } = await makeTracker(tempDir);
      await fs.writeFile(path.join(outside, "victim.lock"), "{ not json");
      await fs.symlink(outside, path.join(pmRoot, "locks"), "dir");

      const error = await captureRefusal(() => runLockGc(pmRoot, { dryRun: false }));

      expect(error.context).toMatchObject({ code: LOCK_PATH_UNSAFE_CODE, reason: "lock_directory_symlink" });
      expect(await fs.readdir(outside)).toEqual(["victim.lock"]);
    });
  });
});

describe("lock confinement primitives", () => {
  it("refuses a lock path that resolves outside the tracker root", async () => {
    await withTempDir("pm-lock-confine-", async (tempDir) => {
      const { pmRoot } = await makeTracker(tempDir);
      const error = await captureRefusal(() =>
        inspectConfinedLockDirectory(pmRoot, path.join(tempDir, "elsewhere", "x.lock"), "x"),
      );
      expect(error.context).toMatchObject({
        code: LOCK_PATH_UNSAFE_CODE,
        reason: "lock_path_outside_tracker",
        lock_component: "../elsewhere",
      });
    });
  });

  it("returns the tracker root identity for a lock placed directly in the root", async () => {
    await withTempDir("pm-lock-confine-", async (tempDir) => {
      const { pmRoot } = await makeTracker(tempDir);
      const rootStats = await fs.stat(pmRoot);
      await expect(inspectConfinedLockDirectory(pmRoot, path.join(pmRoot, "x.lock"), "x")).resolves.toEqual({
        dev: rootStats.dev,
        ino: rootStats.ino,
      });
    });
  });

  it("returns null for a missing directory only when absence is allowed", async () => {
    await withTempDir("pm-lock-confine-", async (tempDir) => {
      const { pmRoot } = await makeTracker(tempDir);
      const lockPath = getLockPath(pmRoot, "x");
      await expect(inspectConfinedLockDirectory(pmRoot, lockPath, "x")).resolves.toBeNull();
      await expect(inspectConfinedLockDirectory(pmRoot, lockPath, "x", false)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("rethrows a non-absence inspection failure unchanged", async () => {
    await withTempDir("pm-lock-confine-", async (tempDir) => {
      const { pmRoot } = await makeTracker(tempDir);
      const denied = Object.assign(new Error("denied"), { code: "EACCES" });
      vi.spyOn(fs, "lstat").mockRejectedValueOnce(denied);
      await expect(inspectConfinedLockDirectory(pmRoot, getLockPath(pmRoot, "x"), "x")).rejects.toBe(denied);
    });
  });

  it("treats a missing or regular lock entry as nothing to refuse", async () => {
    await withTempDir("pm-lock-confine-", async (tempDir) => {
      const { pmRoot } = await makeTracker(tempDir);
      const lockPath = getLockPath(pmRoot, "x");
      await expect(assertLockEntryNotSymlink(pmRoot, lockPath, "x")).resolves.toBeUndefined();
      await fs.mkdir(path.dirname(lockPath));
      await fs.writeFile(lockPath, "{}\n");
      await expect(assertLockEntryNotSymlink(pmRoot, lockPath, "x")).resolves.toBeUndefined();
    });
  });

  it("refuses a creation whose directory identity no longer matches and leaves the created entry in place", async () => {
    await withTempDir("pm-lock-confine-", async (tempDir) => {
      const { pmRoot } = await makeTracker(tempDir);
      await fs.mkdir(path.join(pmRoot, "locks"));
      const lockPath = getLockPath(pmRoot, "x");
      const handle = await fs.open(lockPath, "wx");
      try {
        const error = await captureRefusal(() =>
          verifyConfinedLockCreation({
            pmRoot,
            lockPath,
            id: "x",
            handle,
            directory: { dev: -1, ino: -1 },
          }),
        );
        expect(error.context).toMatchObject({ reason: "lock_directory_replaced", lock_component: "locks" });
      } finally {
        await handle.close();
      }
      expect(await fs.readdir(path.join(pmRoot, "locks"))).toEqual(["x.lock"]);
    });
  });

  it("refuses when the confined directory can no longer be inspected after creation", async () => {
    await withTempDir("pm-lock-confine-", async (tempDir) => {
      const { pmRoot } = await makeTracker(tempDir);
      const locksDir = path.join(pmRoot, "locks");
      await fs.mkdir(locksDir);
      const lockPath = getLockPath(pmRoot, "x");
      const directory = await inspectConfinedLockDirectory(pmRoot, lockPath, "x", false);
      const handle = await fs.open(lockPath, "wx");
      try {
        vi.spyOn(fs, "lstat").mockRejectedValueOnce(Object.assign(new Error("gone"), { code: "ENOENT" }));
        const error = await captureRefusal(() =>
          verifyConfinedLockCreation({ pmRoot, lockPath, id: "x", handle, directory }),
        );
        expect(error.context).toMatchObject({ reason: "lock_directory_replaced" });
      } finally {
        await handle.close();
      }
    });
  });
});
