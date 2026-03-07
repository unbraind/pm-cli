import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendLineAtomic,
  ensureDir,
  pathExists,
  readFileIfExists,
  removeFileIfExists,
  writeFileAtomic,
} from "../../src/core/fs/fs-utils.js";

async function withTempDir(run: (tempDir: string) => Promise<void>): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pm-cli-fs-utils-"));
  try {
    await run(tempDir);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

describe("core/fs/fs-utils", () => {
  it("creates directories and resolves path existence", async () => {
    await withTempDir(async (tempDir) => {
      const nestedDir = path.join(tempDir, "a", "b", "c");
      const missingPath = path.join(tempDir, "missing.txt");

      await ensureDir(nestedDir);

      expect(await pathExists(nestedDir)).toBe(true);
      expect(await pathExists(missingPath)).toBe(false);
    });
  });

  it("returns nullable file reads and rethrows non-ENOENT read errors", async () => {
    await withTempDir(async (tempDir) => {
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
    await withTempDir(async (tempDir) => {
      const filePath = path.join(tempDir, "nested", "history.log");

      await writeFileAtomic(filePath, "first\n");
      expect(await fs.readFile(filePath, "utf8")).toBe("first\n");

      await appendLineAtomic(filePath, "second");
      expect(await fs.readFile(filePath, "utf8")).toBe("first\nsecond\n");

      await writeFileAtomic(filePath, "rewritten");
      expect(await fs.readFile(filePath, "utf8")).toBe("rewritten");
    });
  });

  it("removes files safely while preserving non-ENOENT unlink errors", async () => {
    await withTempDir(async (tempDir) => {
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
