/**
 * Codex review of the field-admission work (pm-8dbagz): a schema file path that
 * names a named pipe with no writer stalled every settings read, and so a
 * settings writer holding the workspace lock. Schema files are now read with a
 * non-blocking open that refuses anything but a regular file.
 */
import { execFileSync } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readOptionalRegularFile } from "../../../../src/core/fs/fs-utils.js";
import { withTempDir } from "../../../helpers/temp.js";

const posix = process.platform !== "win32";

describe("readOptionalRegularFile", () => {
  it("reads a regular file, reads an absent one as null, and refuses a directory", async () => {
    await withTempDir("pm-cli-optional-file-", async (tempDir) => {
      await writeFile(path.join(tempDir, "a.json"), "[1]");
      await mkdir(path.join(tempDir, "dir"));
      await expect(readOptionalRegularFile(path.join(tempDir, "a.json"))).resolves.toBe("[1]");
      await expect(readOptionalRegularFile(path.join(tempDir, "missing.json"))).resolves.toBeNull();
      await expect(readOptionalRegularFile(path.join(tempDir, "dir"))).rejects.toThrow();
    });
  });

  it.skipIf(!posix)("refuses a named pipe with no writer instead of waiting for one", async () => {
    await withTempDir("pm-cli-optional-file-", async (tempDir) => {
      const pipe = path.join(tempDir, "statuses.json");
      execFileSync("mkfifo", [pipe]);
      await expect(readOptionalRegularFile(pipe)).rejects.toThrow("Not a regular file");
    });
  });

  it.skipIf(!posix || process.getuid?.() === 0)("passes on an open failure other than absence", async () => {
    await withTempDir("pm-cli-optional-file-", async (tempDir) => {
      const locked = path.join(tempDir, "locked.json");
      await writeFile(locked, "[]");
      await chmod(locked, 0o000);
      await expect(readOptionalRegularFile(locked)).rejects.toMatchObject({ code: "EACCES" });
    });
  });
});
