import { appendFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  HISTORY_STREAM_SUMMARY_MINIMUM_STREAMS,
  HISTORY_STREAM_SUMMARY_RELATIVE_PATH,
  _testOnly,
  isCanonicalHistoryTimestamp,
  openHistoryStreamSummary,
  summarizeHistoryStreamBounds,
} from "../../../../src/core/history/stream-summary.js";
import {
  clearActiveExtensionHooks,
  setActiveExtensionHooks,
} from "../../../../src/core/extensions/index.js";
import type { BigIntStats } from "node:fs";
import type { HistoryEntry } from "../../../../src/types/index.js";

const SETTLED_MS = 60_000;

function entry(ts: unknown): HistoryEntry {
  return {
    ts,
    author: "spec",
    op: "update",
    patch: [],
    before_hash: "a",
    after_hash: "b",
  } as unknown as HistoryEntry;
}

describe("history stream summary (GH-1664)", () => {
  let pmRoot: string;
  let historyDir: string;
  let restoreMinimum: () => void;
  let restoreClock: () => void;

  beforeEach(async () => {
    pmRoot = await mkdtemp(path.join(os.tmpdir(), "pm-stream-summary-"));
    historyDir = path.join(pmRoot, "history");
    await mkdir(historyDir, { recursive: true });
    restoreMinimum = _testOnly.setMinimumStreams(1);
    // Every stream written by a spec is "settled" relative to this clock.
    restoreClock = _testOnly.setWallClock(() => Date.now() + SETTLED_MS);
  });

  afterEach(async () => {
    restoreClock();
    restoreMinimum();
    clearActiveExtensionHooks();
    await rm(pmRoot, { recursive: true, force: true });
  });

  async function writeStream(file: string, timestamps: unknown[]): Promise<void> {
    await writeFile(
      path.join(historyDir, file),
      timestamps.map((ts) => `${JSON.stringify(entry(ts))}\n`).join(""),
    );
  }

  async function open(files: string[]) {
    return openHistoryStreamSummary({ pmRoot, historyDir, files });
  }

  async function sizeOf(file: string): Promise<number> {
    return (await stat(path.join(historyDir, file))).size;
  }

  /** The handle stat a complete read of `file` reports. */
  async function sourceOf(file: string) {
    return stat(path.join(historyDir, file), { bigint: true });
  }

  /** A snapshot shaped like readIdentifiedHistorySnapshot's: `bytes` long, from `source`. */
  function snapshotOf(entries: HistoryEntry[], source: BigIntStats | null, bytes: number | null) {
    return { entries, source, raw_bytes: bytes === null ? null : new Uint8Array(bytes) };
  }

  async function recordAll(files: string[], timestamps: Record<string, unknown[]>) {
    const session = await open(files);
    for (const file of files) session.record(file, snapshotOf((timestamps[file] ?? []).map(entry), await sourceOf(file), await sizeOf(file)));
    await session.commit();
    return session;
  }

  it("accepts only canonical millisecond UTC timestamps that round-trip", () => {
    expect(isCanonicalHistoryTimestamp("2026-11-20T09:00:00.000Z")).toBe(true);
    expect(isCanonicalHistoryTimestamp("2026-02-30T00:00:00.000Z")).toBe(false);
    expect(isCanonicalHistoryTimestamp("2026-11-20T09:00:00Z")).toBe(false);
    expect(isCanonicalHistoryTimestamp("2026-11-20T09:00:00.000+00:00")).toBe(false);
    expect(isCanonicalHistoryTimestamp("2026-99-99T99:99:99.999Z")).toBe(false);
    expect(isCanonicalHistoryTimestamp(1_700_000_000_000)).toBe(false);
  });

  it("summarizes the oldest and newest canonical timestamps and flags irregular ones", () => {
    expect(summarizeHistoryStreamBounds([])).toEqual({ count: 0, oldest: null, newest: null, irregular: false });
    expect(
      summarizeHistoryStreamBounds([
        entry("2026-11-02T00:00:00.000Z"),
        entry("2026-11-01T00:00:00.000Z"),
        entry("2026-11-03T00:00:00.000Z"),
      ]),
    ).toEqual({ count: 3, oldest: "2026-11-01T00:00:00.000Z", newest: "2026-11-03T00:00:00.000Z", irregular: false });
    expect(summarizeHistoryStreamBounds([entry(""), entry(42)])).toEqual({ count: 2, oldest: null, newest: null, irregular: true });
    expect(
      summarizeHistoryStreamBounds([entry("2026-11-02T00:00:00.000Z"), entry("2026-11-02 00:00")]),
    ).toEqual({ count: 2, oldest: "2026-11-02T00:00:00.000Z", newest: "2026-11-02T00:00:00.000Z", irregular: true });
  });

  it("stays disabled below the minimum stream count and writes nothing", async () => {
    restoreMinimum();
    restoreMinimum = _testOnly.setMinimumStreams(HISTORY_STREAM_SUMMARY_MINIMUM_STREAMS);
    await writeStream("pm-a.jsonl", ["2026-11-01T00:00:00.000Z"]);
    const session = await open(["pm-a.jsonl"]);
    expect(session.enabled).toBe(false);
    expect(session.fallback).toBeUndefined();
    session.record("pm-a.jsonl", snapshotOf([entry("2026-11-01T00:00:00.000Z")], await sourceOf("pm-a.jsonl"), await sizeOf("pm-a.jsonl")));
    await session.commit();
    expect(session.trusted("pm-a.jsonl")).toBeUndefined();
    await expect(stat(path.join(pmRoot, HISTORY_STREAM_SUMMARY_RELATIVE_PATH))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("bypasses the summary while extension read hooks observe every stream", async () => {
    setActiveExtensionHooks({ beforeCommand: [], afterCommand: [], onWrite: [], onRead: [{ layer: "project", name: "spy", run: () => undefined }], onIndex: [] });
    await writeStream("pm-a.jsonl", ["2026-11-01T00:00:00.000Z"]);
    const session = await open(["pm-a.jsonl"]);
    expect(session.enabled).toBe(false);
    expect(session.fallback).toBe("read_hooks_active");
  });

  it("rebuilds a missing summary, then trusts bounds while the stream is unchanged", async () => {
    await writeStream("pm-a.jsonl", ["2026-11-01T00:00:00.000Z", "2026-11-05T00:00:00.000Z"]);
    await writeStream("pm-b.jsonl", ["2026-10-01T00:00:00.000Z"]);
    const first = await recordAll(["pm-a.jsonl", "pm-b.jsonl"], {
      "pm-a.jsonl": ["2026-11-01T00:00:00.000Z", "2026-11-05T00:00:00.000Z"],
      "pm-b.jsonl": ["2026-10-01T00:00:00.000Z"],
    });
    expect(first.enabled).toBe(true);
    expect(first.fallback).toBe("summary_missing");
    const persisted = JSON.parse(await readFile(path.join(pmRoot, HISTORY_STREAM_SUMMARY_RELATIVE_PATH), "utf8"));
    expect(Object.keys(persisted.streams)).toEqual(["pm-a.jsonl", "pm-b.jsonl"]);

    const second = await open(["pm-a.jsonl", "pm-b.jsonl"]);
    expect(second.fallback).toBeUndefined();
    expect(second.trusted("pm-a.jsonl")).toEqual({
      count: 2,
      oldest: "2026-11-01T00:00:00.000Z",
      newest: "2026-11-05T00:00:00.000Z",
      irregular: false,
    });
    // Re-recording an unchanged stream is not a change worth a rewrite.
    second.record("pm-a.jsonl", snapshotOf([entry("2026-11-01T00:00:00.000Z")], await sourceOf("pm-a.jsonl"), await sizeOf("pm-a.jsonl")));
    await rm(path.join(pmRoot, HISTORY_STREAM_SUMMARY_RELATIVE_PATH));
    await second.commit();
    await expect(stat(path.join(pmRoot, HISTORY_STREAM_SUMMARY_RELATIVE_PATH))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never persists bounds read inside the racy window of the stream's last change", async () => {
    // The default wall clock: a stream written just now is inside the window.
    restoreClock();
    restoreClock = () => undefined;
    await writeStream("pm-a.jsonl", ["2026-11-01T00:00:00.000Z"]);
    const session = await recordAll(["pm-a.jsonl"], { "pm-a.jsonl": ["2026-11-01T00:00:00.000Z"] });
    expect(session.fallback).toBe("summary_missing");
    await expect(stat(path.join(pmRoot, HISTORY_STREAM_SUMMARY_RELATIVE_PATH))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("invalidates an entry on append and on same-size replacement, and reports a summary matching no stream as stale", async () => {
    await writeStream("pm-a.jsonl", ["2026-11-01T00:00:00.000Z"]);
    await writeStream("pm-b.jsonl", ["2026-11-02T00:00:00.000Z"]);
    await recordAll(["pm-a.jsonl", "pm-b.jsonl"], {
      "pm-a.jsonl": ["2026-11-01T00:00:00.000Z"],
      "pm-b.jsonl": ["2026-11-02T00:00:00.000Z"],
    });
    await appendFile(path.join(historyDir, "pm-a.jsonl"), `${JSON.stringify(entry("2026-11-09T00:00:00.000Z"))}\n`);
    const appended = await open(["pm-a.jsonl", "pm-b.jsonl"]);
    expect(appended.trusted("pm-a.jsonl")).toBeUndefined();
    expect(appended.trusted("pm-b.jsonl")).toBeDefined();
    expect(appended.fallback).toBeUndefined();

    // Same bytes, new inode: a rewrite through rename is a different stream.
    const replacement = path.join(historyDir, "pm-b.tmp");
    await writeFile(replacement, await readFile(path.join(historyDir, "pm-b.jsonl")));
    await rename(replacement, path.join(historyDir, "pm-b.jsonl"));
    const replaced = await open(["pm-a.jsonl", "pm-b.jsonl"]);
    expect(replaced.trusted("pm-b.jsonl")).toBeUndefined();
    expect(replaced.fallback).toBe("summary_stale");
  });

  it("treats unreadable, malformed and foreign summaries as invalid", async () => {
    await writeStream("pm-a.jsonl", ["2026-11-01T00:00:00.000Z"]);
    const summaryFile = path.join(pmRoot, HISTORY_STREAM_SUMMARY_RELATIVE_PATH);
    await mkdir(path.dirname(summaryFile), { recursive: true });
    const valid = ["0:1:2:3:4:5", 1, "2026-11-01T00:00:00.000Z", "2026-11-01T00:00:00.000Z", false];
    // Every shape case carries a valid checksum, so it reaches shape validation.
    const sealed = (streams: unknown, version = 1) =>
      JSON.stringify({ version, checksum: _testOnly.checksumOf(streams), streams });
    const cases: unknown[] = [
      "not json",
      sealed({}, 2),
      sealed(null),
      sealed([]),
      JSON.stringify({ version: 1 }),
      JSON.stringify({ version: 1, streams: { "pm-a.jsonl": valid } }),
      JSON.stringify({ version: 1, checksum: "0".repeat(64), streams: { "pm-a.jsonl": valid } }),
      sealed({ "pm-a.jsonl": "x" }),
      sealed({ "pm-a.jsonl": valid.slice(0, 4) }),
      sealed({ "pm-a.jsonl": [7, ...valid.slice(1)] }),
      sealed({ "pm-a.jsonl": [valid[0], -1, ...valid.slice(2)] }),
      sealed({ "pm-a.jsonl": [valid[0], 1.5, ...valid.slice(2)] }),
      sealed({ "pm-a.jsonl": [valid[0], 1, "yesterday", valid[3], false] }),
      sealed({ "pm-a.jsonl": [valid[0], 1, valid[2], 5, false] }),
      sealed({ "pm-a.jsonl": [...valid.slice(0, 4), "no"] }),
      sealed({ "pm-a.jsonl": [valid[0], 1, null, valid[3], false] }),
      // Damaged records whose fields disagree could hide a non-empty stream.
      sealed({ "pm-a.jsonl": [valid[0], 0, valid[2], valid[3], false] }),
      sealed({ "pm-a.jsonl": [valid[0], 0, null, null, true] }),
      sealed({ "pm-a.jsonl": [valid[0], 2, null, null, false] }),
      sealed({ "pm-a.jsonl": [valid[0], 2, "2026-11-02T00:00:00.000Z", "2026-11-01T00:00:00.000Z", false] }),
    ];
    for (const raw of cases) {
      await writeFile(summaryFile, raw as string);
      const session = await open(["pm-a.jsonl"]);
      expect(session.fallback, String(raw)).toBe("summary_invalid");
      expect(session.trusted("pm-a.jsonl")).toBeUndefined();
    }
    await rm(summaryFile);
    await mkdir(summaryFile);
    expect((await open(["pm-a.jsonl"])).fallback).toBe("summary_invalid");
  });

  it("accepts exactly the bounds a complete read can produce", () => {
    const ts = "2026-11-01T00:00:00.000Z";
    expect(_testOnly.areConsistentBounds({ count: 0, oldest: null, newest: null, irregular: false })).toBe(true);
    expect(_testOnly.areConsistentBounds({ count: 3, oldest: null, newest: null, irregular: true })).toBe(true);
    expect(_testOnly.areConsistentBounds({ count: 3, oldest: ts, newest: ts, irregular: true })).toBe(true);
    expect(_testOnly.areConsistentBounds({ count: 3, oldest: ts, newest: "2026-11-02T00:00:00.000Z", irregular: false })).toBe(true);
    expect(_testOnly.areConsistentBounds({ count: 3, oldest: null, newest: ts, irregular: true })).toBe(false);
    expect(_testOnly.areConsistentBounds({ count: 0, oldest: ts, newest: ts, irregular: false })).toBe(false);
  });

  it("reports a summary as stale once most streams lack current bounds", async () => {
    const files = ["pm-a.jsonl", "pm-b.jsonl", "pm-c.jsonl"];
    for (const file of files) await writeStream(file, ["2026-11-01T00:00:00.000Z"]);
    await recordAll(files, Object.fromEntries(files.map((file) => [file, ["2026-11-01T00:00:00.000Z"]])));
    await appendFile(path.join(historyDir, "pm-a.jsonl"), `${JSON.stringify(entry("2026-11-02T00:00:00.000Z"))}\n`);
    expect((await open(files)).fallback).toBeUndefined();
    await appendFile(path.join(historyDir, "pm-b.jsonl"), `${JSON.stringify(entry("2026-11-02T00:00:00.000Z"))}\n`);
    const mostlyStale = await open(files);
    expect(mostlyStale.fallback).toBe("summary_stale");
    expect(mostlyStale.trusted("pm-c.jsonl")).toBeDefined();
  });

  it("round-trips a stored stream and accepts an empty stream's null bounds", () => {
    const encoded = JSON.parse(
      _testOnly.serializeSummary(
        new Map([
          ["pm-b.jsonl", { signature: "s2", bounds: { count: 0, oldest: null, newest: null, irregular: false } }],
          ["pm-a.jsonl", { signature: "s1", bounds: { count: 1, oldest: "2026-11-01T00:00:00.000Z", newest: "2026-11-01T00:00:00.000Z", irregular: true } }],
        ]),
      ),
    );
    expect(encoded.version).toBe(_testOnly.SUMMARY_VERSION);
    expect(Object.keys(encoded.streams)).toEqual(["pm-a.jsonl", "pm-b.jsonl"]);
    expect(_testOnly.parseStoredStream(encoded.streams["pm-b.jsonl"])).toEqual({
      signature: "s2",
      bounds: { count: 0, oldest: null, newest: null, irregular: false },
    });
  });

  it("refuses trust without a stable file identity or a regular file", () => {
    const base = {
      dev: 1n, ino: 7n, size: 10n, mtimeNs: 5n, ctimeNs: 9n,
      isFile: () => true,
    };
    const reader = _testOnly.readerIdentityOf(process, os.userInfo);
    expect(reader).toMatch(/^(uid:\d+:gid:\d+:groups:|user:)/u);
    expect(_testOnly.signatureOf(base as never, reader)).toEqual({ size: 10n, signature: `1:7:10:5:9:${reader}`, changedAtNs: 9n });
    expect(_testOnly.signatureOf({ ...base, mtimeNs: 11n } as never, reader)?.changedAtNs).toBe(11n);
    expect(_testOnly.signatureOf({ ...base, ino: 0n } as never, reader)).toBeUndefined();
    expect(_testOnly.signatureOf({ ...base, isFile: () => false } as never, reader)).toBeUndefined();
    expect(_testOnly.signatureOf(base as never, undefined)).toBeUndefined();
  });

  it("identifies the reader by user id, by account name without one, and refuses trust without either", async () => {
    // Effective ids decide file access, so a host that dropped privileges differs.
    const posix = { geteuid: () => 1001, getegid: () => 100, getgroups: () => [27, 100, 4, 27] };
    expect(_testOnly.readerIdentityOf(posix, () => ({ username: "dev" }))).toBe("uid:1001:gid:100:groups:4,27,100");
    // Sessions of one user that differ in supplementary groups differ in identity.
    expect(_testOnly.readerIdentityOf({ ...posix, getgroups: () => [100] }, () => ({ username: "dev" }))).toBe("uid:1001:gid:100:groups:100");
    expect(_testOnly.readerIdentityOf({ ...posix, geteuid: () => 0 }, () => ({ username: "dev" }))).toBe("uid:0:gid:100:groups:4,27,100");
    expect(_testOnly.readerIdentityOf({ geteuid: () => 1001 }, () => ({ username: "dev" }))).toBe("user:dev");
    expect(_testOnly.readerIdentityOf({}, () => ({ username: "" }))).toBeUndefined();
    expect(_testOnly.readerIdentityOf({}, () => { throw new Error("no account"); })).toBeUndefined();
    await writeStream("pm-a.jsonl", ["2026-11-01T00:00:00.000Z"]);
    await recordAll(["pm-a.jsonl"], { "pm-a.jsonl": ["2026-11-01T00:00:00.000Z"] });
    const restoreReader = _testOnly.setReaderIdentity(() => undefined);
    try {
      const anonymous = await open(["pm-a.jsonl"]);
      expect(anonymous.trusted("pm-a.jsonl")).toBeUndefined();
      anonymous.record("pm-a.jsonl", snapshotOf([entry("2026-11-01T00:00:00.000Z")], await sourceOf("pm-a.jsonl"), await sizeOf("pm-a.jsonl")));
      expect(anonymous.trusted("pm-a.jsonl")).toBeUndefined();
    } finally {
      restoreReader();
    }
  });

  it("records bounds only for the whole of the file that supplied the bytes", async () => {
    await writeStream("pm-a.jsonl", ["2026-11-01T00:00:00.000Z"]);
    const session = await open(["pm-a.jsonl"]);
    const source = await sourceOf("pm-a.jsonl");
    // The stream was absent, or the bytes were not the whole file.
    session.record("pm-a.jsonl", snapshotOf([], null, 0));
    session.record("pm-a.jsonl", snapshotOf([], source, null));
    session.record("pm-a.jsonl", snapshotOf([], source, 0));
    session.record("pm-a.jsonl", snapshotOf([], source, (await sizeOf("pm-a.jsonl")) + 1));
    expect(session.trusted("pm-a.jsonl")).toBeUndefined();
    session.record("pm-a.jsonl", snapshotOf([entry("2026-11-01T00:00:00.000Z")], source, await sizeOf("pm-a.jsonl")));
    expect(session.trusted("pm-a.jsonl")).toMatchObject({ count: 1 });
  });

  it("binds bounds to the file revision read, not to whatever the path names later", async () => {
    await writeStream("pm-a.jsonl", ["2026-11-01T00:00:00.000Z"]);
    await writeStream("pm-swap.jsonl", ["2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z"]);
    const session = await open(["pm-a.jsonl"]);
    // A restore swapped another file in while pm-a was read; its bytes came from that file.
    session.record("pm-a.jsonl", snapshotOf([entry("2026-01-01T00:00:00.000Z"), entry("2026-01-02T00:00:00.000Z")], await sourceOf("pm-swap.jsonl"), await sizeOf("pm-swap.jsonl")));
    await session.commit();
    const reopened = await open(["pm-a.jsonl"]);
    expect(reopened.trusted("pm-a.jsonl")).toBeUndefined();
  });

  it("counts stale and irregular streams together and names the larger cause", async () => {
    const files = ["pm-a.jsonl", "pm-b.jsonl", "pm-c.jsonl", "pm-d.jsonl"];
    for (const file of files) await writeStream(file, ["2026-11-01T00:00:00.000Z"]);
    await recordAll(files, { "pm-a.jsonl": ["2026-11-01"], "pm-b.jsonl": ["2026-11-01"], "pm-c.jsonl": ["2026-11-01T00:00:00.000Z"], "pm-d.jsonl": ["2026-11-01T00:00:00.000Z"] });
    // Two irregular of four is exactly half: still served.
    expect((await open(files)).fallback).toBeUndefined();
    await appendFile(path.join(historyDir, "pm-c.jsonl"), `${JSON.stringify(entry("2026-11-02T00:00:00.000Z"))}\n`);
    expect((await open(files)).fallback).toBe("irregular_timestamps");
    await appendFile(path.join(historyDir, "pm-d.jsonl"), `${JSON.stringify(entry("2026-11-02T00:00:00.000Z"))}\n`);
    expect((await open(files)).fallback).toBe("summary_stale");
  });

  it("rejects a well-formed summary whose values changed after it was written", async () => {
    await writeStream("pm-a.jsonl", ["2026-11-01T00:00:00.000Z", "2026-11-05T00:00:00.000Z"]);
    await recordAll(["pm-a.jsonl"], { "pm-a.jsonl": ["2026-11-01T00:00:00.000Z", "2026-11-05T00:00:00.000Z"] });
    const summaryFile = path.join(pmRoot, HISTORY_STREAM_SUMMARY_RELATIVE_PATH);
    const stored = JSON.parse(await readFile(summaryFile, "utf8")) as { streams: Record<string, unknown[]> };
    // Moving the newest timestamp earlier keeps every field valid and in order.
    stored.streams["pm-a.jsonl"]![3] = "2026-11-02T00:00:00.000Z";
    await writeFile(summaryFile, JSON.stringify(stored));
    const session = await open(["pm-a.jsonl"]);
    expect(session.fallback).toBe("summary_invalid");
    expect(session.trusted("pm-a.jsonl")).toBeUndefined();
  });

  it("never trusts bounds another reader recorded on a shared tracker", async () => {
    await writeStream("pm-a.jsonl", ["2026-11-01T00:00:00.000Z"]);
    await recordAll(["pm-a.jsonl"], { "pm-a.jsonl": ["2026-11-01T00:00:00.000Z"] });
    expect((await open(["pm-a.jsonl"])).trusted("pm-a.jsonl")).toBeDefined();
    const restoreReader = _testOnly.setReaderIdentity(() => "another-user");
    try {
      const other = await open(["pm-a.jsonl"]);
      expect(other.trusted("pm-a.jsonl")).toBeUndefined();
      expect(other.fallback).toBe("summary_stale");
    } finally {
      restoreReader();
    }
  });

  it("discloses a summary whose current bounds are mostly irregular", async () => {
    const files = ["pm-a.jsonl", "pm-b.jsonl", "pm-c.jsonl"];
    for (const file of files) await writeStream(file, ["2026-11-01"]);
    await recordAll(files, { "pm-a.jsonl": ["2026-11-01"], "pm-b.jsonl": ["2026-11-01"], "pm-c.jsonl": ["2026-11-01T00:00:00.000Z"] });
    const session = await open(files);
    expect(session.fallback).toBe("irregular_timestamps");
    expect(session.trusted("pm-a.jsonl")).toMatchObject({ irregular: true });
  });

  it("leaves streams that vanished before their stat untrusted and unrecorded", async () => {
    await writeStream("pm-a.jsonl", ["2026-11-01T00:00:00.000Z"]);
    const session = await open(["pm-a.jsonl", "pm-gone.jsonl"]);
    session.record("pm-gone.jsonl", snapshotOf([entry("2026-11-01T00:00:00.000Z")], null, 0));
    session.record("pm-a.jsonl", snapshotOf([entry("2026-11-01T00:00:00.000Z")], await sourceOf("pm-a.jsonl"), await sizeOf("pm-a.jsonl")));
    await session.commit();
    const reopened = await open(["pm-a.jsonl", "pm-gone.jsonl"]);
    expect(reopened.trusted("pm-gone.jsonl")).toBeUndefined();
    expect(reopened.trusted("pm-a.jsonl")).toBeDefined();
  });

  it("never recreates a tracker that was removed before the summary was saved", async () => {
    await writeStream("pm-a.jsonl", ["2026-11-01T00:00:00.000Z"]);
    const session = await open(["pm-a.jsonl"]);
    session.record("pm-a.jsonl", snapshotOf([entry("2026-11-01T00:00:00.000Z")], await sourceOf("pm-a.jsonl"), await sizeOf("pm-a.jsonl")));
    await rm(pmRoot, { recursive: true, force: true });
    await session.commit();
    await expect(stat(pmRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps the read successful when the summary cannot be persisted", async () => {
    await writeStream("pm-a.jsonl", ["2026-11-01T00:00:00.000Z"]);
    // A regular file where the runtime directory belongs blocks the write.
    await writeFile(path.join(pmRoot, "runtime"), "not a directory");
    const session = await recordAll(["pm-a.jsonl"], { "pm-a.jsonl": ["2026-11-01T00:00:00.000Z"] });
    expect(session.fallback).toBe("summary_invalid");
    await session.commit();
  });
});
