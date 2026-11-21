/** A filesystem that cannot hard-link refuses an absent-stream reseed typed, without writing (pm-3os5p6). */
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HistoryEntry } from "../../../../src/types/index.js";

const createFileAtomic = vi.hoisted(() => vi.fn());
vi.mock("../../../../src/core/fs/atomic-create.js", async (original) => ({
  ...(await original<typeof import("../../../../src/core/fs/atomic-create.js")>()),
  createFileAtomic,
}));
const { AtomicLinkUnsupportedError } = await import("../../../../src/core/fs/atomic-create.js");
const { appendRecordToVerifiedStream } = await import("../../../../src/sdk/history/append-only-repair.js");

const record = { op: "history_repair" } as unknown as HistoryEntry;

describe("reseed publication without hard links", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "pm-reseed-link-"));
    createFileAtomic.mockReset();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("refuses typed and writes nothing when the filesystem cannot hard-link", async () => {
    createFileAtomic.mockRejectedValue(new AtomicLinkUnsupportedError("EPERM", new Error("EPERM")));
    const file = path.join(dir, "pm-a.jsonl");
    await expect(appendRecordToVerifiedStream("pm-a", file, null, record)).rejects.toMatchObject({
      code: "history_append_only_repair_unavailable",
      context: expect.objectContaining({ reason: "stream_publish_unsupported" }),
    });
    expect(createFileAtomic).toHaveBeenCalledWith(file, `${JSON.stringify(record)}\n`, { sync: true });
    expect(await readdir(dir)).toEqual([]);
  });

  it("passes other publication failures through", async () => {
    const failure = Object.assign(new Error("EACCES"), { code: "EACCES" });
    createFileAtomic.mockRejectedValue(failure);
    await expect(appendRecordToVerifiedStream("pm-a", path.join(dir, "pm-a.jsonl"), null, record)).rejects.toBe(failure);
  });
});
