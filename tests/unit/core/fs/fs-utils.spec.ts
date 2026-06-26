import * as fs from "node:fs/promises";
import path from "node:path";
import type * as FsPromises from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  appendLineAtomic,
  ensureDir,
  pathExists,
  readFileIfExists,
  removeFileIfExists,
  writeFileAtomic,
} from "../../../../src/core/fs/fs-utils.js";
import { withTempDir } from "../../../helpers/temp.js";

describe("core/fs/fs-utils", () => {
  it("creates directories and resolves path existence", async () => {
    await withTempDir("pm-cli-fs-utils-", async (tempDir) => {
      const nestedDir = path.join(tempDir, "a", "b", "c");
      const missingPath = path.join(tempDir, "missing.txt");

      await ensureDir(nestedDir);

      expect(await pathExists(nestedDir)).toBe(true);
      expect(await pathExists(missingPath)).toBe(false);
    });
  });

  it("returns nullable file reads and rethrows non-ENOENT read errors", async () => {
    await withTempDir("pm-cli-fs-utils-", async (tempDir) => {
      const filePath = path.join(tempDir, "item.txt");
      const missingPath = path.join(tempDir, "missing.txt");
      const directoryPath = path.join(tempDir, "dir");

      await fs.writeFile(filePath, "hello", "utf8");
      await ensureDir(directoryPath);

      expect(await readFileIfExists(filePath)).toBe("hello");
      expect(await readFileIfExists(missingPath)).toBeNull();

      try {
        await readFileIfExists(directoryPath);
        throw new Error("Expected readFileIfExists to throw for non-ENOENT errors.");
      } catch (error: unknown) {
        expect((error as NodeJS.ErrnoException).code).not.toBe("ENOENT");
      }
    });
  });

  it("writes files atomically and appends newline-terminated lines", async () => {
    await withTempDir("pm-cli-fs-utils-", async (tempDir) => {
      const filePath = path.join(tempDir, "nested", "history.log");

      await writeFileAtomic(filePath, "first\n");
      expect(await fs.readFile(filePath, "utf8")).toBe("first\n");

      await appendLineAtomic(filePath, "second");
      expect(await fs.readFile(filePath, "utf8")).toBe("first\nsecond\n");

      await writeFileAtomic(filePath, "rewritten");
      expect(await fs.readFile(filePath, "utf8")).toBe("rewritten");
    });
  });

  it("keeps atomic temp files beside the target using platform path semantics", async () => {
    await withTempDir("pm-cli-fs-utils-", async (tempDir) => {
      const filePath = path.join(tempDir, "nested folder", "pm-win-path.toon");
      const writeFilePaths: Array<Parameters<typeof fs.writeFile>[0]> = [];
      try {
        vi.resetModules();
        vi.doMock("node:fs/promises", async () => {
          const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
          return {
            ...actual,
            writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
              writeFilePaths.push(args[0]);
              return actual.writeFile(...args);
            },
          };
        });
        const reloadedModule = await import("../../../../src/core/fs/fs-utils.js");
        await reloadedModule.writeFileAtomic(filePath, "contents");

        const tempFilePath = writeFilePaths[0];
        expect(typeof tempFilePath).toBe("string");
        expect(path.dirname(tempFilePath as string)).toBe(path.dirname(filePath));
        expect(await fs.readFile(filePath, "utf8")).toBe("contents");
      } finally {
        vi.doUnmock("node:fs/promises");
        vi.resetModules();
      }
    });
  });

  it("falls back to copy/unlink when rename fails with EXDEV", async () => {
    await withTempDir("pm-cli-fs-utils-", async (tempDir) => {
      const filePath = path.join(tempDir, "cross-device.txt");
      await fs.writeFile(filePath, "before", "utf8");
      try {
        const copyFileMock = vi.fn(async (...args: [string, string]) => {
          const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
          return actual.copyFile(...args);
        });
        const unlinkMock = vi.fn(async (...args: [string]) => {
          const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
          return actual.unlink(...args);
        });
        vi.resetModules();
        vi.doMock("node:fs/promises", async () => {
          const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
          return {
            ...actual,
            rename: async () => {
              const crossDevice = new Error("cross-device") as NodeJS.ErrnoException;
              crossDevice.code = "EXDEV";
              throw crossDevice;
            },
            copyFile: copyFileMock,
            unlink: unlinkMock,
          };
        });
        const reloadedModule = await import("../../../../src/core/fs/fs-utils.js");
        await reloadedModule.writeFileAtomic(filePath, "after");
        expect(await fs.readFile(filePath, "utf8")).toBe("after");
        expect(copyFileMock).toHaveBeenCalledTimes(1);
        expect(unlinkMock).toHaveBeenCalledTimes(1);
      } finally {
        vi.doUnmock("node:fs/promises");
        vi.resetModules();
      }
    });
  });

  it("retries transient Windows rename failures during atomic replacement", async () => {
    await withTempDir("pm-cli-fs-utils-", async (tempDir) => {
      const filePath = path.join(tempDir, "windows-rename-retry.txt");
      await fs.writeFile(filePath, "before", "utf8");
      const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
      try {
        Object.defineProperty(process, "platform", { value: "win32" });
        const actual = await vi.importActual<typeof FsPromises>("node:fs/promises");
        const renameMock = vi
          .fn<typeof actual.rename>()
          .mockImplementationOnce(async () => {
            const transient = new Error("permission denied") as NodeJS.ErrnoException;
            transient.code = "EPERM";
            throw transient;
          })
          .mockImplementation(async (...args: Parameters<typeof actual.rename>) => actual.rename(...args));
        vi.resetModules();
        vi.doMock("node:fs/promises", async () => ({
          ...actual,
          rename: renameMock,
        }));
        const reloadedModule = await import("../../../../src/core/fs/fs-utils.js");
        await reloadedModule.writeFileAtomic(filePath, "after");

        expect(await fs.readFile(filePath, "utf8")).toBe("after");
        expect(renameMock).toHaveBeenCalledTimes(2);
      } finally {
        vi.doUnmock("node:fs/promises");
        vi.resetModules();
        if (descriptor) {
          Object.defineProperty(process, "platform", descriptor);
        }
      }
    });
  });

  it("throws the last Windows rename retry failure after cleanup", async () => {
    await withTempDir("pm-cli-fs-utils-", async (tempDir) => {
      const filePath = path.join(tempDir, "windows-rename-exhausted.txt");
      await fs.writeFile(filePath, "before", "utf8");
      const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
      try {
        Object.defineProperty(process, "platform", { value: "win32" });
        const actual = await vi.importActual<typeof FsPromises>("node:fs/promises");
        const transient = new Error("resource busy") as NodeJS.ErrnoException;
        transient.code = "EBUSY";
        const retryFailure = new Error("still busy") as NodeJS.ErrnoException;
        retryFailure.code = "EBUSY";
        const renameMock = vi
          .fn<typeof actual.rename>()
          .mockRejectedValueOnce(transient)
          .mockRejectedValue(retryFailure);
        const unlinkMock = vi.fn<typeof actual.unlink>().mockImplementation(async (...args) => actual.unlink(...args));
        vi.resetModules();
        vi.doMock("node:fs/promises", async () => ({
          ...actual,
          rename: renameMock,
          unlink: unlinkMock,
        }));
        const reloadedModule = await import("../../../../src/core/fs/fs-utils.js");
        await expect(reloadedModule.writeFileAtomic(filePath, "after")).rejects.toBe(retryFailure);

        expect(await fs.readFile(filePath, "utf8")).toBe("before");
        expect(renameMock).toHaveBeenCalledTimes(5);
        expect(unlinkMock).toHaveBeenCalledTimes(1);
      } finally {
        vi.doUnmock("node:fs/promises");
        vi.resetModules();
        if (descriptor) {
          Object.defineProperty(process, "platform", descriptor);
        }
      }
    });
  });

  it("stops Windows rename retries after a non-transient retry failure", async () => {
    await withTempDir("pm-cli-fs-utils-", async (tempDir) => {
      const filePath = path.join(tempDir, "windows-rename-non-transient.txt");
      await fs.writeFile(filePath, "before", "utf8");
      const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
      try {
        Object.defineProperty(process, "platform", { value: "win32" });
        const actual = await vi.importActual<typeof FsPromises>("node:fs/promises");
        const transient = new Error("permission denied") as NodeJS.ErrnoException;
        transient.code = "EPERM";
        const nonTransient = new Error("access denied") as NodeJS.ErrnoException;
        nonTransient.code = "EACCES";
        const cleanupFailure = new Error("cleanup denied");
        const renameMock = vi
          .fn<typeof actual.rename>()
          .mockRejectedValueOnce(transient)
          .mockRejectedValueOnce(nonTransient);
        const unlinkMock = vi.fn<typeof actual.unlink>().mockRejectedValueOnce(cleanupFailure);
        vi.resetModules();
        vi.doMock("node:fs/promises", async () => ({
          ...actual,
          rename: renameMock,
          unlink: unlinkMock,
        }));
        const reloadedModule = await import("../../../../src/core/fs/fs-utils.js");
        await expect(reloadedModule.writeFileAtomic(filePath, "after")).rejects.toBe(nonTransient);

        expect(await fs.readFile(filePath, "utf8")).toBe("before");
        expect(renameMock).toHaveBeenCalledTimes(2);
        expect(unlinkMock).toHaveBeenCalledTimes(1);
      } finally {
        vi.doUnmock("node:fs/promises");
        vi.resetModules();
        if (descriptor) {
          Object.defineProperty(process, "platform", descriptor);
        }
      }
    });
  });

  it("removes files safely while preserving non-ENOENT unlink errors", async () => {
    await withTempDir("pm-cli-fs-utils-", async (tempDir) => {
      const filePath = path.join(tempDir, "remove-me.txt");
      const missingPath = path.join(tempDir, "missing.txt");
      const directoryPath = path.join(tempDir, "dir");

      await fs.writeFile(filePath, "temp", "utf8");
      await removeFileIfExists(filePath);
      expect(await pathExists(filePath)).toBe(false);

      await removeFileIfExists(missingPath);
      await ensureDir(directoryPath);

      try {
        await removeFileIfExists(directoryPath);
        throw new Error("Expected removeFileIfExists to throw for non-ENOENT errors.");
      } catch (error: unknown) {
        expect((error as NodeJS.ErrnoException).code).not.toBe("ENOENT");
      }
    });
  });
});
