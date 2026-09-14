import fs from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { acquireLock } from "../../../../src/core/lock/lock.js";
import { getLockPath } from "../../../../src/core/store/paths.js";
import { withTempDir } from "../../../helpers/temp.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it("does not reclaim a live lock while its first owner write is paused", async () => {
  await withTempDir("pm-lock-initialization-", async (root) => {
    vi.stubEnv("PM_LOCK_WAIT_MS", "0");
    const lockPath = getLockPath(root, "shared");
    const originalOpen = fs.open.bind(fs);
    let resumeWrite: () => void = () => { throw new Error("Owner write was not paused"); };
    let announcePause: () => void = () => { throw new Error("Pause signal was not initialized"); };
    const resumed = new Promise<void>((resolve) => { resumeWrite = resolve; });
    const paused = new Promise<void>((resolve) => { announcePause = resolve; });
    let intercept = true;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      if (args[0] === lockPath && args[1] === "wx" && intercept) {
        intercept = false;
        const originalWrite = handle.writeFile.bind(handle);
        vi.spyOn(handle, "writeFile").mockImplementation(async (...writeArgs) => {
          announcePause();
          await resumed;
          return originalWrite(...writeArgs);
        });
      }
      return handle;
    });
    const first = acquireLock(root, "shared", 60, "first", false, false);
    await paused;
    let secondRelease: (() => Promise<void>) | undefined;
    try {
      const result = await acquireLock(root, "shared", 60, "second", false, false)
        .then((release) => { secondRelease = release; return "overlapping_owner"; }, (error: unknown) => error);
      expect(result).toMatchObject({ code: "lock_conflict" });
    } finally {
      resumeWrite();
      const firstRelease = await first;
      await firstRelease();
      await secondRelease?.();
    }
  });
});

it("removes its own failed initialization and permits an ordinary retry", async () => {
  await withTempDir("pm-lock-failed-initialization-", async (root) => {
    const lockPath = getLockPath(root, "shared");
    const originalOpen = fs.open.bind(fs);
    const openSpy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      if (args[0] === lockPath && args[1] === "wx") {
        vi.spyOn(handle, "writeFile").mockRejectedValueOnce(new Error("Owner write failed"));
      }
      return handle;
    });
    await expect(acquireLock(root, "shared", 60, "first")).rejects.toThrow("Owner write failed");
    await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    openSpy.mockRestore();
    const release = await acquireLock(root, "shared", 60, "retry");
    await release();
    await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
