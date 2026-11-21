/** Where the filesystem cannot hard-link, the reseed creates the stream with an exclusive open (pm-3os5p6). */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HistoryEntry } from "../../../../src/types/index.js";

const createFileAtomic = vi.hoisted(() => vi.fn());
vi.mock("../../../../src/core/fs/atomic-create.js", () => ({ createFileAtomic }));
const { appendRecordToVerifiedStream } = await import("../../../../src/sdk/history/append-only-repair.js");

const record = { op: "history_repair" } as unknown as HistoryEntry;
const failure = (code: string) => Object.assign(new Error(code), { code });

describe("reseed publication without hard links", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "pm-reseed-link-"));
    createFileAtomic.mockReset();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("falls back to an exclusive open when linking is unsupported", async () => {
    createFileAtomic.mockRejectedValue(failure("EPERM"));
    const file = path.join(dir, "pm-a.jsonl");
    await appendRecordToVerifiedStream("pm-a", file, null, record);
    expect(await readFile(file, "utf8")).toBe(`${JSON.stringify(record)}\n`);
    expect(createFileAtomic).toHaveBeenCalledWith(file, `${JSON.stringify(record)}\n`, { sync: true });
  });

  it("never replaces a stream created before the fallback opens it", async () => {
    createFileAtomic.mockRejectedValue(failure("ENOTSUP"));
    const file = path.join(dir, "pm-a.jsonl");
    await writeFile(file, "peer\n");
    await expect(appendRecordToVerifiedStream("pm-a", file, null, record)).rejects.toMatchObject({
      context: expect.objectContaining({ reason: "stream_changed" }),
    });
    expect(await readFile(file, "utf8")).toBe("peer\n");
  });

  it("passes other failures through", async () => {
    createFileAtomic.mockRejectedValue(failure("EACCES"));
    await expect(appendRecordToVerifiedStream("pm-a", path.join(dir, "pm-a.jsonl"), null, record)).rejects.toMatchObject({ code: "EACCES" });
    createFileAtomic.mockRejectedValue(Object.assign(new Error("no code"), {}));
    await expect(appendRecordToVerifiedStream("pm-a", path.join(dir, "pm-b.jsonl"), null, record)).rejects.toThrow("no code");
    createFileAtomic.mockRejectedValue(failure("ENOSYS"));
    await expect(appendRecordToVerifiedStream("pm-a", path.join(dir, "missing", "pm-c.jsonl"), null, record)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
