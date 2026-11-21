/** The reseed baseline is appended to verified bytes or creates the stream exclusively (pm-3os5p6). */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
      const file = path.join(dir, `${"x".repeat(300)}.jsonl`);
      await expect(appendRecordToVerifiedStream("pm-a", file, null, record)).rejects.toMatchObject({ code: "ENAMETOOLONG" });
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
