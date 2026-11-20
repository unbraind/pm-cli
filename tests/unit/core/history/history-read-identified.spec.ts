import fsPromises, { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readHistorySnapshot,
  readIdentifiedHistorySnapshot,
} from "../../../../src/core/history/read.js";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function historyDir(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "pm-identified-read-"));
  roots.push(root);
  return root;
}

describe("readIdentifiedHistorySnapshot (GH-1664)", () => {
  it("returns the snapshot of a path read plus the stat of the handle that supplied the bytes", async () => {
    const dir = await historyDir();
    const file = path.join(dir, "pm-a.jsonl");
    await writeFile(file, `${JSON.stringify({ ts: "2026-11-01T00:00:00.000Z", op: "create" })}\n`);
    const identified = await readIdentifiedHistorySnapshot(file, "pm-a");
    const { source, ...snapshot } = identified;
    expect(snapshot).toEqual(await readHistorySnapshot(file, "pm-a"));
    const onDisk = await stat(file, { bigint: true });
    expect(source).toMatchObject({ ino: onDisk.ino, size: onDisk.size, mtimeNs: onDisk.mtimeNs });
    expect(Number(source!.size)).toBe(identified.raw_bytes!.length);
  });

  it("reports an absent stream with no source, like the path read", async () => {
    const dir = await historyDir();
    const file = path.join(dir, "pm-missing.jsonl");
    expect(await readIdentifiedHistorySnapshot(file, "pm-missing")).toEqual({ ...(await readHistorySnapshot(file, "pm-missing")), source: null });
  });

  it("raises the path read's errors for unreadable and invalid streams", async () => {
    const dir = await historyDir();
    const directory = path.join(dir, "pm-dir.jsonl");
    await mkdir(directory);
    const pathError = await readHistorySnapshot(directory, "pm-dir").catch((error: unknown) => error);
    await expect(readIdentifiedHistorySnapshot(directory, "pm-dir")).rejects.toMatchObject({ code: (pathError as { code: string }).code });
    // An open that fails for any reason but absence is the read's error.
    vi.spyOn(fsPromises, "open").mockRejectedValueOnce(Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }));
    await expect(readIdentifiedHistorySnapshot(directory, "pm-dir")).rejects.toMatchObject({ code: "EACCES" });
    const invalid = path.join(dir, "pm-bad.jsonl");
    await writeFile(invalid, "{ not json\n");
    await expect(readIdentifiedHistorySnapshot(invalid, "pm-bad")).rejects.toMatchObject({ code: "history_json_invalid" });
  });
});
