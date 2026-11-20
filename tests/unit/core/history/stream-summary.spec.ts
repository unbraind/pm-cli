import fsPromises, { appendFile, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  it("judges canonical timestamps exactly like the Date round trip, on calendar edges and random fields", () => {
    const oracle = (value: unknown): boolean => {
      if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false;
      const parsed = Date.parse(value);
      return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
    };
    const pad = (value: number, width: number) => String(value).padStart(width, "0");
    const cases: string[] = [];
    for (const year of [0, 4, 100, 400, 1900, 1999, 2000, 2023, 2024, 2100, 9999]) {
      for (const month of [0, 1, 2, 4, 6, 9, 11, 12, 13]) {
        for (const day of [0, 1, 28, 29, 30, 31, 32]) {
          cases.push(`${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}T12:30:45.678Z`);
        }
      }
    }
    for (const time of ["00:00:00.000", "23:59:59.999", "24:00:00.000", "23:60:00.000", "23:59:60.000", "99:99:99.999"]) {
      cases.push(`2024-02-29T${time}Z`);
    }
    // Seeded random fields, including out-of-range values.
    let seed = 1664;
    const next = (bound: number) => {
      seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;
      return seed % bound;
    };
    for (let index = 0; index < 5_000; index += 1) {
      cases.push(`${pad(next(10_000), 4)}-${pad(next(14), 2)}-${pad(next(33), 2)}T${pad(next(26), 2)}:${pad(next(62), 2)}:${pad(next(62), 2)}.${pad(next(1000), 3)}Z`);
    }
    for (const value of cases) expect(isCanonicalHistoryTimestamp(value), value).toBe(oracle(value));
  });

  it("counts non-object entries as irregular instead of throwing", () => {
    // JSON lines such as null, 7 or "text" decode as entries without a timestamp.
    const entries = [null, 7, "text", [], entry("2026-11-01T00:00:00.000Z")] as unknown as HistoryEntry[];
    expect(summarizeHistoryStreamBounds(entries)).toEqual({ count: 5, oldest: "2026-11-01T00:00:00.000Z", newest: "2026-11-01T00:00:00.000Z", irregular: true });
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
    // The default wall clock, and a source whose last change is later than the
    // read began, so the stream is inside the racy window however the runner
    // schedules this test.
    restoreClock();
    restoreClock = () => undefined;
    await writeStream("pm-a.jsonl", ["2026-11-01T00:00:00.000Z"]);
    const session = await open(["pm-a.jsonl"]);
    const real = await sourceOf("pm-a.jsonl");
    const changedLater = BigInt(Date.now() + 60_000) * 1_000_000n;
    const source = Object.assign(Object.create(Object.getPrototypeOf(real) as object) as typeof real, real, { mtimeNs: changedLater, ctimeNs: changedLater });
    session.record("pm-a.jsonl", snapshotOf([entry("2026-11-01T00:00:00.000Z")], source, await sizeOf("pm-a.jsonl")));
    await session.commit();
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

  it("keeps every record small with a fixed-length reader digest", () => {
    const many = `uid:1000:gid:1000:groups:${Array.from({ length: 125 }, (_, index) => 1_000_000_000 + index).join(",")}`;
    expect(_testOnly.readerDigest(many)).toMatch(/^[0-9a-f]{16}$/u);
    expect(_testOnly.readerDigest(many)).toBe(_testOnly.readerDigest(many));
    expect(_testOnly.readerDigest(`${many},7`)).not.toBe(_testOnly.readerDigest(many));
    expect(_testOnly.readerDigest(undefined)).toBeUndefined();
  });

  it("reads the summary only up to its size cap, even if it grew after the stat", async () => {
    const file = path.join(pmRoot, "capped.json");
    await writeFile(file, "x".repeat(10));
    const handle = await fsPromises.open(file, "r");
    try {
      expect(await _testOnly.readAtMost(handle, 10)).toBe("x".repeat(10));
      await expect(_testOnly.readAtMost(handle, 9)).rejects.toThrow("grew past its size cap");
    } finally {
      await handle.close();
    }
  });

  it.runIf(process.platform !== "win32")("never follows a summary file that is a symbolic link", async () => {
    await writeStream("pm-a.jsonl", ["2026-11-01T00:00:00.000Z"]);
    await recordAll(["pm-a.jsonl"], { "pm-a.jsonl": ["2026-11-01T00:00:00.000Z"] });
    const summaryFile = path.join(pmRoot, HISTORY_STREAM_SUMMARY_RELATIVE_PATH);
    await rename(summaryFile, path.join(pmRoot, "elsewhere.json"));
    await symlink(path.join(pmRoot, "elsewhere.json"), summaryFile);
    const session = await open(["pm-a.jsonl"]);
    expect(session).toMatchObject({ enabled: false, fallback: "summary_invalid" });
    await session.commit();
    // The link is neither followed nor replaced.
    expect((await fsPromises.lstat(summaryFile)).isSymbolicLink()).toBe(true);
  });

  it.runIf(process.platform !== "win32")("never replaces an entry that stopped being a regular file during the read", async () => {
    await writeStream("pm-a.jsonl", ["2026-11-01T00:00:00.000Z"]);
    await recordAll(["pm-a.jsonl"], { "pm-a.jsonl": ["2026-11-01T00:00:00.000Z"] });
    await writeStream("pm-b.jsonl", ["2026-11-02T00:00:00.000Z"]);
    const summaryFile = path.join(pmRoot, HISTORY_STREAM_SUMMARY_RELATIVE_PATH);
    const session = await open(["pm-a.jsonl", "pm-b.jsonl"]);
    expect(session.enabled).toBe(true);
    // New bounds for pm-b make the session worth committing.
    session.record("pm-b.jsonl", snapshotOf([entry("2026-11-02T00:00:00.000Z")], await sourceOf("pm-b.jsonl"), await sizeOf("pm-b.jsonl")));
    // Another process replaces the summary with a link before the commit.
    await rename(summaryFile, path.join(pmRoot, "elsewhere.json"));
    await symlink(path.join(pmRoot, "elsewhere.json"), summaryFile);
    await session.commit();
    expect((await fsPromises.lstat(summaryFile)).isSymbolicLink()).toBe(true);
  });

  it("still refuses a summary entry that becomes a link after the writability check", async () => {
    await writeStream("pm-a.jsonl", ["2026-11-01T00:00:00.000Z"]);
    await recordAll(["pm-a.jsonl"], { "pm-a.jsonl": ["2026-11-01T00:00:00.000Z"] });
    const summaryFile = path.join(pmRoot, HISTORY_STREAM_SUMMARY_RELATIVE_PATH);
    const actual = fsPromises.lstat.bind(fsPromises);
    let entryChecks = 0;
    // Windows has no O_NOFOLLOW, so the read checks the entry itself as well.
    const lstat = vi.spyOn(fsPromises, "lstat").mockImplementation(async (target, ...rest) => {
      if (target === summaryFile && ++entryChecks === 2) return { isFile: () => false, isSymbolicLink: () => true } as never;
      return actual(target, ...(rest as []));
    });
    try {
      expect(await open(["pm-a.jsonl"])).toMatchObject({ enabled: true, fallback: "summary_invalid" });
      expect(entryChecks).toBe(2);
    } finally {
      lstat.mockRestore();
    }
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

  it("revalidates skipped streams before a read finishes and stops trusting the changed ones", async () => {
    await writeStream("pm-a.jsonl", ["2026-11-01T00:00:00.000Z"]);
    await writeStream("pm-b.jsonl", ["2026-11-01T00:00:00.000Z"]);
    await recordAll(["pm-a.jsonl", "pm-b.jsonl"], { "pm-a.jsonl": ["2026-11-01T00:00:00.000Z"], "pm-b.jsonl": ["2026-11-01T00:00:00.000Z"] });
    const session = await open(["pm-a.jsonl", "pm-b.jsonl"]);
    await appendFile(path.join(historyDir, "pm-b.jsonl"), `${JSON.stringify(entry("2026-11-02T00:00:00.000Z"))}\n`);
    // An appended stream changed; one never trusted was not skipped on bounds.
    expect(await session.revalidate(["pm-a.jsonl", "pm-b.jsonl", "pm-gone.jsonl"])).toEqual(["pm-b.jsonl"]);
    expect(session.trusted("pm-b.jsonl")).toBeUndefined();
    expect(session.trusted("pm-a.jsonl")).toBeDefined();
    // A trusted stream deleted while the read ran also changed.
    await rm(path.join(historyDir, "pm-a.jsonl"));
    expect(await session.revalidate(["pm-a.jsonl"])).toEqual(["pm-a.jsonl"]);
    restoreMinimum();
    restoreMinimum = _testOnly.setMinimumStreams(HISTORY_STREAM_SUMMARY_MINIMUM_STREAMS);
    expect(await (await open(["pm-a.jsonl"])).revalidate(["pm-a.jsonl"])).toEqual([]);
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

  it.runIf(process.platform !== "win32")("distrusts a regular summary file that is hard-linked elsewhere", async () => {
    await writeStream("pm-a.jsonl", ["2026-11-01T00:00:00.000Z"]);
    await recordAll(["pm-a.jsonl"], { "pm-a.jsonl": ["2026-11-01T00:00:00.000Z"] });
    const summaryFile = path.join(pmRoot, HISTORY_STREAM_SUMMARY_RELATIVE_PATH);
    // A second name for the file means another writer may rewrite it unseen.
    await fsPromises.link(summaryFile, path.join(pmRoot, "summary-alias.json"));
    const session = await open(["pm-a.jsonl"]);
    expect(session).toMatchObject({ enabled: true, fallback: "summary_invalid" });
    expect(session.trusted("pm-a.jsonl")).toBeUndefined();
  });

  it.runIf(process.platform !== "win32")("treats a FIFO at the summary path as invalid instead of waiting for a writer", async () => {
    await writeStream("pm-a.jsonl", ["2026-11-01T00:00:00.000Z"]);
    const summaryFile = path.join(pmRoot, HISTORY_STREAM_SUMMARY_RELATIVE_PATH);
    await mkdir(path.dirname(summaryFile), { recursive: true });
    execFileSync("mkfifo", [summaryFile]);
    const session = await open(["pm-a.jsonl"]);
    expect(session).toMatchObject({ enabled: false, fallback: "summary_invalid" });
    await session.commit();
    expect((await fsPromises.lstat(summaryFile)).isFIFO()).toBe(true);
  });

  it.runIf(process.platform !== "win32")("writes the summary owner-only, since it describes streams others may not read", async () => {
    await writeStream("pm-a.jsonl", ["2026-11-01T00:00:00.000Z"]);
    await recordAll(["pm-a.jsonl"], { "pm-a.jsonl": ["2026-11-01T00:00:00.000Z"] });
    expect((await stat(path.join(pmRoot, HISTORY_STREAM_SUMMARY_RELATIVE_PATH))).mode & 0o777).toBe(0o600);
  });

  it("trusts only an unshared, plausibly sized summary the reader owns and no one else can write", () => {
    const owned = { isFile: () => true, nlink: 1, size: 100, uid: 1000, mode: 0o100600 };
    expect(_testOnly.summaryByteCap(2)).toBe(4096 + 2 * 1024);
    expect(_testOnly.isTrustedSummaryFile(owned as never, 2, 1000)).toBe(true);
    expect(_testOnly.isTrustedSummaryFile({ ...owned, uid: 1001 } as never, 2, 1000)).toBe(false);
    expect(_testOnly.isTrustedSummaryFile({ ...owned, mode: 0o100620 } as never, 2, 1000)).toBe(false);
    expect(_testOnly.isTrustedSummaryFile({ ...owned, mode: 0o100602 } as never, 2, 1000)).toBe(false);
    expect(_testOnly.isTrustedSummaryFile({ ...owned, nlink: 2 } as never, 2, 1000)).toBe(false);
    expect(_testOnly.isTrustedSummaryFile({ ...owned, size: 1_000_000 } as never, 2, 1000)).toBe(false);
    expect(_testOnly.isTrustedSummaryFile({ ...owned, isFile: () => false } as never, 2, 1000)).toBe(false);
    // Without an effective user id (Windows) ownership cannot be judged.
    expect(_testOnly.isTrustedSummaryFile({ ...owned, uid: 0, mode: 0o100666 } as never, 2, undefined)).toBe(true);
  });

  it.runIf(process.platform !== "win32")("never reads or writes the summary through a redirected runtime directory", async () => {
    await writeStream("pm-a.jsonl", ["2026-11-01T00:00:00.000Z"]);
    await recordAll(["pm-a.jsonl"], { "pm-a.jsonl": ["2026-11-01T00:00:00.000Z"] });
    const elsewhere = await mkdtemp(path.join(os.tmpdir(), "pm-stream-summary-elsewhere-"));
    try {
      await rename(path.join(pmRoot, "runtime"), path.join(elsewhere, "runtime"));
      await symlink(path.join(elsewhere, "runtime"), path.join(pmRoot, "runtime"));
      const session = await open(["pm-a.jsonl"]);
      expect(session.fallback).toBe("summary_invalid");
      // Nothing could be persisted, so no bounds are computed or trusted.
      expect(session.enabled).toBe(false);
      session.record("pm-a.jsonl", snapshotOf([entry("2026-11-01T00:00:00.000Z")], await sourceOf("pm-a.jsonl"), await sizeOf("pm-a.jsonl")));
      const before = await stat(path.join(elsewhere, "runtime", "history-stream-summary.json"));
      await session.commit();
      expect((await stat(path.join(elsewhere, "runtime", "history-stream-summary.json"))).mtimeMs).toBe(before.mtimeMs);
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  });

  it("computes no bounds when a directory occupies the summary path, since no write could replace it", async () => {
    await writeStream("pm-a.jsonl", ["2026-11-01T00:00:00.000Z"]);
    const summaryFile = path.join(pmRoot, HISTORY_STREAM_SUMMARY_RELATIVE_PATH);
    await mkdir(summaryFile, { recursive: true });
    const session = await open(["pm-a.jsonl"]);
    expect(session).toMatchObject({ enabled: false, fallback: "summary_invalid", staleAtOpen: 0 });
    expect(session.trusted("pm-a.jsonl")).toBeUndefined();
    session.record("pm-a.jsonl", snapshotOf([entry("2026-11-01T00:00:00.000Z")], await sourceOf("pm-a.jsonl"), await sizeOf("pm-a.jsonl")));
    expect(await session.revalidate(["pm-a.jsonl"])).toEqual([]);
    await session.commit();
    expect((await stat(summaryFile)).isDirectory()).toBe(true);
  });

  it("still refuses a runtime directory that is redirected after the writability check", async () => {
    await writeStream("pm-a.jsonl", ["2026-11-01T00:00:00.000Z"]);
    await recordAll(["pm-a.jsonl"], { "pm-a.jsonl": ["2026-11-01T00:00:00.000Z"] });
    const summaryFile = path.join(pmRoot, HISTORY_STREAM_SUMMARY_RELATIVE_PATH);
    const before = await stat(summaryFile);
    const runtimeDir = path.join(pmRoot, "runtime");
    const actual = fsPromises.lstat.bind(fsPromises);
    let runtimeChecks = 0;
    // runtime/ is replaced by a link right after the first check: both the
    // read and the commit must re-check it themselves.
    const lstat = vi.spyOn(fsPromises, "lstat").mockImplementation(async (target, ...rest) => {
      if (target === runtimeDir && ++runtimeChecks > 1) return { isDirectory: () => false, isSymbolicLink: () => true } as never;
      return actual(target, ...(rest as []));
    });
    try {
      const session = await open(["pm-a.jsonl"]);
      expect(session).toMatchObject({ enabled: true, fallback: "summary_invalid" });
      session.record("pm-a.jsonl", snapshotOf([entry("2026-11-02T00:00:00.000Z")], await sourceOf("pm-a.jsonl"), await sizeOf("pm-a.jsonl")));
      await session.commit();
      expect(runtimeChecks).toBe(3);
    } finally {
      lstat.mockRestore();
    }
    expect((await stat(summaryFile)).mtimeMs).toBe(before.mtimeMs);
  });

  it("keeps the read successful when the summary cannot be persisted", async () => {
    await writeStream("pm-a.jsonl", ["2026-11-01T00:00:00.000Z"]);
    // A regular file where the runtime directory belongs blocks the write.
    await writeFile(path.join(pmRoot, "runtime"), "not a directory");
    const session = await recordAll(["pm-a.jsonl"], { "pm-a.jsonl": ["2026-11-01T00:00:00.000Z"] });
    expect(session).toMatchObject({ enabled: false, fallback: "summary_invalid" });
    await session.commit();
  });
});
