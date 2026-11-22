/** The reseed baseline is appended to verified bytes or creates the stream exclusively (pm-3os5p6). */
import { link, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { appendRecordToVerifiedStream } from "../../../../src/sdk/history/append-only-repair.js";
import type { HistoryEntry } from "../../../../src/types/index.js";

const record = { op: "history_repair", ts: "2026-11-21T00:00:00.000Z" } as unknown as HistoryEntry;

async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pm-reseed-append-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("appendRecordToVerifiedStream", () => {
  it("creates an absent stream, including its directory", async () => {
    await withDir(async (dir) => {
      const file = path.join(dir, "history", "pm-a.jsonl");
      await appendRecordToVerifiedStream("pm-a", file, null, record);
      expect(await readFile(file, "utf8")).toBe(`${JSON.stringify(record)}\n`);
    });
  });

  it("never replaces a stream another writer created after the check", async () => {
    await withDir(async (dir) => {
      const file = path.join(dir, "pm-a.jsonl");
      await writeFile(file, "peer\n");
      await expect(appendRecordToVerifiedStream("pm-a", file, null, record)).rejects.toMatchObject({
        code: "history_append_only_repair_unavailable",
        context: expect.objectContaining({ reason: "stream_changed" }),
      });
      expect(await readFile(file, "utf8")).toBe("peer\n");
    });
  });

  it("passes other creation failures through", async () => {
    await withDir(async (dir) => {
      // The errno for an over-long name is the platform's (ENAMETOOLONG on POSIX, ENOENT on Windows), so the
      // expectation is what the same hard-link publish reports when made directly (pm-gh1767).
      const file = path.join(dir, `${"x".repeat(300)}.jsonl`);
      const source = path.join(dir, "source");
      await writeFile(source, "");
      const direct = await link(source, file).then(() => null, (error: NodeJS.ErrnoException) => error);
      expect(direct?.code).toEqual(expect.any(String));
      expect(direct?.code).not.toBe("EEXIST");
      const propagated = await appendRecordToVerifiedStream("pm-a", file, null, record).then(() => null, (error: unknown) => error);
      expect(propagated).toMatchObject({ code: direct?.code, syscall: "link" });
      expect(propagated).not.toHaveProperty("context.reason");
    });
  });

  it.skipIf(process.platform === "win32")("refuses a stream entry that links to another stream", async () => {
    await withDir(async (dir) => {
      const other = path.join(dir, "pm-b.jsonl");
      await writeFile(other, "");
      await symlink(other, path.join(dir, "pm-a.jsonl"));
      await expect(appendRecordToVerifiedStream("pm-a", path.join(dir, "pm-a.jsonl"), "", record)).rejects.toMatchObject({
        context: expect.objectContaining({ reason: "stream_not_regular_file" }),
      });
      expect(await readFile(other, "utf8")).toBe("");
      // A dangling link is never replaced by an exclusive create either.
      await symlink(path.join(dir, "absent.jsonl"), path.join(dir, "pm-c.jsonl"));
      await expect(appendRecordToVerifiedStream("pm-c", path.join(dir, "pm-c.jsonl"), null, record)).rejects.toMatchObject({
        context: expect.objectContaining({ reason: "stream_changed" }),
      });
    });
  });

  it("passes other open failures through", async () => {
    await withDir(async (dir) => {
      await expect(appendRecordToVerifiedStream("pm-a", dir, "", record)).rejects.toMatchObject({ code: "EISDIR" });
    });
  });

  it("appends after the verified whitespace of an existing stream", async () => {
    await withDir(async (dir) => {
      const file = path.join(dir, "pm-a.jsonl");
      await writeFile(file, " ");
      await appendRecordToVerifiedStream("pm-a", file, " ", record);
      expect(await readFile(file, "utf8")).toBe(` \n${JSON.stringify(record)}\n`);
    });
  });
});
