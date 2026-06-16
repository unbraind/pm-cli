import * as fs from "node:fs/promises";
import path from "node:path";
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
