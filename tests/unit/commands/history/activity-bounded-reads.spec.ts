/**
 * GH-1664: bounded recent-activity reads. Derived stream bounds may only
 * decide which streams a read parses; every row, total, cursor and error must
 * equal the complete read on the same corpus, including streams rewritten by
 * redaction, compaction, repair and restore.
 */
import { appendFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readRecentActivity,
  runActivity,
  _testOnly as activityInternals,
  type ActivityCommandOptions,
  type ActivityResult,
} from "../../../../src/sdk/query/activity.js";
import { runContext } from "../../../../src/sdk/query/context.js";
import * as historyReadModule from "../../../../src/core/history/read.js";
import * as streamSummaryModule from "../../../../src/core/history/stream-summary.js";
import {
  HISTORY_STREAM_SUMMARY_RELATIVE_PATH,
  _testOnly as summaryInternals,
  openHistoryStreamSummary,
} from "../../../../src/core/history/stream-summary.js";
import {
  clearActiveExtensionHooks,
  setActiveExtensionHooks,
} from "../../../../src/core/extensions/index.js";
import { createTaskFixture } from "../../../helpers/createTaskFixture.js";
import {
  withTempPmPath,
  type TempPmContext,
} from "../../../helpers/withTempPmPath.js";

const REAL_NOW = Date.now();
// One hour ahead keeps every item written during the spec inside the
// default 24-hour digest window while the clock stays fixed between reads.
const FIXED_NOW = REAL_NOW + 60 * 60 * 1000;
const NEVER = Number.MAX_SAFE_INTEGER;

const QUERIES: ReadonlyArray<ActivityCommandOptions> = [
  {},
  { limit: "2" },
  { raw: true, limit: "3", from: "-400d" },
  { raw: true, limit: "4" },
  { raw: true, unbounded: true },
  { compact: false, raw: true, limit: "2", from: "2025-01-01T00:00:00.000Z" },
  { provenance: true, from: "2025-06-01T00:00:00.000Z", limit: "5" },
  { from: "2025-01-01T00:00:00.000Z", to: "2025-07-01T00:00:00.000Z" },
  { raw: true, op: "comment_add", from: "-30d", limit: "50" },
  { raw: true, author: "spec-old", from: "2024-01-01T00:00:00.000Z", unbounded: true },
];

function oldEntry(ts: unknown, op = "update", author = "spec-old") {
  return { ts, author, op, patch: [], before_hash: "x", after_hash: "y", message: `${op} at ${String(ts)}` };
}

async function writeStream(pmPath: string, id: string, entries: unknown[]): Promise<void> {
  await writeFile(
    path.join(pmPath, "history", `${id}.jsonl`),
    entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""),
  );
}

function withoutReceipt(result: ActivityResult): Omit<ActivityResult, "history_read"> {
  const { history_read: _receipt, ...rest } = result;
  return rest;
}

/** Run every query once with the summary disabled and once engaged and warm. */
async function assertParity(pmPath: string): Promise<void> {
  const global = { path: pmPath };
  const restore = summaryInternals.setMinimumStreams(NEVER);
  const complete: unknown[] = [];
  try {
    for (const query of QUERIES) complete.push(withoutReceipt(await runActivity({ ...query }, global)));
    complete.push((await readRecentActivity({ limit: 50 }, global)).rows);
    complete.push((await readRecentActivity({ limit: 3 }, global)).rows);
  } finally {
    restore();
  }
  const bounded: unknown[] = [];
  for (const query of QUERIES) bounded.push(withoutReceipt(await runActivity({ ...query }, global)));
  // A limit above the matching rows reads every reachable stream once.
  bounded.push((await readRecentActivity({ limit: 50 }, global)).rows);
  bounded.push((await readRecentActivity({ limit: 3 }, global)).rows);
  expect(bounded).toEqual(complete);
  expect((complete.at(-1) as unknown[]).length).toBeGreaterThan(0);
}

describe("bounded activity reads (GH-1664)", () => {
  let restoreMinimum: () => void;
  let restoreClock: () => void;

  beforeEach(() => {
    restoreMinimum = summaryInternals.setMinimumStreams(2);
    restoreClock = summaryInternals.setWallClock(() => FIXED_NOW + 60_000);
    vi.useFakeTimers({ toFake: ["Date"], now: FIXED_NOW });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    restoreClock();
    restoreMinimum();
    clearActiveExtensionHooks();
  });

  async function seedCorpus(context: TempPmContext): Promise<string[]> {
    const ids = ["pm-live1", "pm-live2", "pm-live3"];
    for (const id of ids) createTaskFixture(context, id, `${id} bounded activity corpus`);
    expect(context.runCli(["comments", "pm-live1", "--add", "a comment that says private-token-123"]).code).toBe(0);
    expect(context.runCli(["update", "pm-live2", "--priority", "1"]).code).toBe(0);
    expect(context.runCli(["update", "pm-live2", "--priority", "2"]).code).toBe(0);
    expect(context.runCli(["update", "pm-live2", "--priority", "3"]).code).toBe(0);
    // Real rewrites: a redacted and a compacted stream.
    expect(context.runCli(["history-redact", "pm-live1", "--literal", "private-token-123", "--replacement", "[redacted]"]).code).toBe(0);
    expect(context.runCli(["history-compact", "pm-live2", "--before", "3"]).code).toBe(0);
    const historyDir = path.join(context.pmPath, "history");
    await mkdir(historyDir, { recursive: true });
    // Old streams that a default digest must never need to parse.
    await writeStream(context.pmPath, "pm-old1", [oldEntry("2025-02-01T00:00:00.000Z", "create"), oldEntry("2025-03-01T00:00:00.000Z")]);
    await writeStream(context.pmPath, "pm-old2", [oldEntry("2025-05-01T00:00:00.000Z", "create"), oldEntry("2025-08-01T00:00:00.000Z", "comment_add")]);
    // Ties: equal newest timestamps decided by item id, then operation.
    await writeStream(context.pmPath, "pm-tie-b", [oldEntry("2025-09-01T00:00:00.000Z", "update")]);
    await writeStream(context.pmPath, "pm-tie-a", [oldEntry("2025-09-01T00:00:00.000Z", "update"), oldEntry("2025-09-01T00:00:00.000Z", "close")]);
    // Irregular timestamps must always be read.
    await writeStream(context.pmPath, "pm-odd", [oldEntry(""), oldEntry("2025-04-01 10:00"), oldEntry(17)]);
    // An empty stream contributes nothing.
    await writeFile(path.join(historyDir, "pm-empty.jsonl"), "");
    return ids;
  }

  it("returns exactly the complete read's rows, totals and cursors, with redacted and compacted streams", async () => {
    await withTempPmPath(async (context) => {
      await seedCorpus(context);
      // First engaged read rebuilds the summary and discloses it.
      const first = await runActivity({}, { path: context.pmPath });
      expect(first.history_read).toEqual({
        reason: "summary_missing",
        streams_read: expect.any(Number),
        streams_total: expect.any(Number),
      });
      expect(first.history_read!.streams_read).toBe(first.history_read!.streams_total);
      await assertParity(context.pmPath);
    });
  });

  it("parses only the streams a default digest window can reach once bounds are trusted", async () => {
    await withTempPmPath(async (context) => {
      await seedCorpus(context);
      const global = { path: context.pmPath };
      await runActivity({}, global);
      const reads = vi.spyOn(historyReadModule, "readIdentifiedHistorySnapshot");
      const digest = await runActivity({}, global);
      expect(digest.history_read).toBeUndefined();
      const parsed = new Set(reads.mock.calls.map(([file]) => path.basename(String(file))));
      expect([...parsed].filter((file) => file.startsWith("pm-old") || file.startsWith("pm-tie") || file === "pm-empty.jsonl")).toEqual([]);
      expect(parsed.has("pm-odd.jsonl")).toBe(true);
      expect(parsed.has("pm-live1.jsonl")).toBe(true);

      reads.mockClear();
      const recent = await readRecentActivity({ limit: 2 }, global);
      expect(recent.rows).toHaveLength(2);
      expect(recent.history_read).toBeUndefined();
      const recentFiles = reads.mock.calls.map(([file]) => path.basename(String(file)));
      expect(recentFiles.some((file) => file.startsWith("pm-old") || file.startsWith("pm-tie"))).toBe(false);
    });
  });

  it("re-reads a stream after every write path and still matches the complete read", async () => {
    await withTempPmPath(async (context) => {
      const [live1, live2, live3] = await seedCorpus(context);
      const global = { path: context.pmPath };
      await runActivity({}, global);
      const mutations: Array<[string, string, () => Promise<void> | void]> = [
        ["append", live3!, () => { expect(context.runCli(["comments", live3!, "--add", "second pass"]).code).toBe(0); }],
        ["redaction", live3!, () => { expect(context.runCli(["history-redact", live3!, "--literal", "second pass", "--replacement", "[gone]"]).code).toBe(0); }],
        ["compaction", live1!, () => { expect(context.runCli(["history-compact", live1!, "--before", "2"]).code).toBe(0); }],
        ["restore", live3!, () => { const restored = context.runCli(["restore", live3!, "1"]); expect(restored.code, restored.stderr).toBe(0); }],
        ["update", live2!, () => { expect(context.runCli(["update", live2!, "--priority", "0"]).code).toBe(0); }],
        ["repair", live3!, async () => {
          await appendFile(path.join(context.pmPath, "history", `${live3!}.jsonl`), "{ torn tail\n");
          const repaired = context.runCli(["history-repair", live3!, "--salvage-tail", "--message", "salvage torn tail"]);
          expect(repaired.code, repaired.stderr).toBe(0);
        }],
        ["raw append", "pm-old1", () => appendFile(path.join(context.pmPath, "history", "pm-old1.jsonl"), `${JSON.stringify(oldEntry(new Date(FIXED_NOW - 1000).toISOString(), "comment_add"))}\n`)],
      ];
      const historyDir = path.join(context.pmPath, "history");
      for (const [label, id, mutate] of mutations) {
        await mutate();
        // The write path invalidated the stream's bounds without cooperation...
        const files = (await readdir(historyDir)).filter((file) => file.endsWith(".jsonl"));
        const session = await openHistoryStreamSummary({ pmRoot: context.pmPath, historyDir, files });
        expect(session.trusted(`${id}.jsonl`), label).toBeUndefined();
        // ...so the next digest re-reads exactly that stream.
        const reads = vi.spyOn(historyReadModule, "readIdentifiedHistorySnapshot");
        await runActivity({}, global);
        expect(reads.mock.calls.map(([file]) => path.basename(String(file))), label).toContain(`${id}.jsonl`);
        reads.mockRestore();
        await assertParity(context.pmPath);
      }
      // The raw append moved an old stream into the digest window.
      const digest = await runActivity({}, global);
      expect(digest.activity_digest!.map((row) => row.id)).toContain("pm-old1");
    });
  });

  it("names the fallback when the summary is unreadable, matches no stream, or read hooks are active", async () => {
    await withTempPmPath(async (context) => {
      await seedCorpus(context);
      const global = { path: context.pmPath };
      await runActivity({}, global);
      expect((await runActivity({}, global)).history_read).toBeUndefined();
      expect((await runActivity({ raw: true, limit: "1" }, global)).history_read).toMatchObject({ reason: "unwindowed_query" });
      // An upper bound before most of the archive keeps the read bounded.
      expect((await runActivity({ raw: true, limit: "1", to: "2025-01-01T00:00:00.000Z" }, global)).history_read).toBeUndefined();
      // Current bounds, but a window that reaches most streams, is disclosed too.
      expect((await runActivity({ from: "2020-01-01T00:00:00.000Z" }, global)).history_read).toMatchObject({ reason: "window_reaches_most_streams" });
      // A clock pinned between most streams' oldest and newest entries defeats
      // the newest-first cut: every straddling stream can still outrank it.
      for (let index = 0; index < 12; index += 1) {
        await writeStream(context.pmPath, `pm-straddle-${String(index).padStart(2, "0")}`, [oldEntry("2024-01-01T00:00:00.000Z", "create"), oldEntry("2026-01-01T00:00:00.000Z")]);
      }
      await runActivity({}, global);
      vi.setSystemTime(Date.parse("2025-01-01T00:00:00.000Z"));
      expect((await readRecentActivity({ limit: 1 }, global)).history_read).toMatchObject({ reason: "window_reaches_most_streams" });
      vi.setSystemTime(FIXED_NOW);

      const summaryFile = path.join(context.pmPath, HISTORY_STREAM_SUMMARY_RELATIVE_PATH);
      await writeFile(summaryFile, "{ torn");
      expect((await runActivity({}, global)).history_read).toMatchObject({ reason: "summary_invalid" });
      expect((await runActivity({}, global)).history_read).toBeUndefined();

      // A copied tracker keeps the file but no stream identity.
      const stored = JSON.parse(await readFile(summaryFile, "utf8")) as { version: number; streams: Record<string, unknown[]> };
      for (const value of Object.values(stored.streams)) value[0] = `other-device:${String(value[0])}`;
      await writeFile(summaryFile, JSON.stringify({ ...stored, checksum: summaryInternals.checksumOf(stored.streams) }));
      expect((await runActivity({}, global)).history_read).toMatchObject({ reason: "summary_stale" });

      setActiveExtensionHooks({ beforeCommand: [], afterCommand: [], onWrite: [], onIndex: [], onRead: [{ layer: "project", name: "observer", run: () => undefined }] });
      const hooked = await runActivity({}, global);
      expect(hooked.history_read).toMatchObject({ reason: "read_hooks_active" });
      expect(hooked.history_read!.streams_read).toBe(hooked.history_read!.streams_total);
      expect((await readRecentActivity({ limit: 1 }, global)).history_read).toMatchObject({ reason: "read_hooks_active" });
    });
  });

  it("raises the complete read's error for a stream corrupted after its bounds were trusted", async () => {
    await withTempPmPath(async (context) => {
      await seedCorpus(context);
      const global = { path: context.pmPath };
      await runActivity({}, global);
      await appendFile(path.join(context.pmPath, "history", "pm-old2.jsonl"), "{ not json\n");
      const bounded = await runActivity({}, global).catch((error: unknown) => error);
      const restore = summaryInternals.setMinimumStreams(NEVER);
      const complete = await runActivity({}, global).catch((error: unknown) => error).finally(restore);
      expect(bounded).toMatchObject({ code: "history_json_invalid" });
      expect(complete).toMatchObject({ code: "history_json_invalid", message: (bounded as Error).message });
      await expect(readRecentActivity({ limit: 1 }, global)).rejects.toMatchObject({ code: "history_json_invalid" });
    });
  });

  it("ends pruning when read hooks become active while the read runs, in both read paths", async () => {
    await withTempPmPath(async (context) => {
      await seedCorpus(context);
      const global = { path: context.pmPath };
      const streams = (await readdir(path.join(context.pmPath, "history"))).filter((file) => file.endsWith(".jsonl"));
      const actual = historyReadModule.readIdentifiedHistorySnapshot;
      const reads: Array<() => Promise<{ history_read?: { reason: string; streams_read: number; streams_total: number } }>> = [
        () => runActivity({}, global),
        () => readRecentActivity({ limit: 1 }, global),
      ];
      for (const read of reads) {
        await runActivity({}, global);
        const observed = new Set<string>();
        let registered = false;
        const spy = vi.spyOn(historyReadModule, "readIdentifiedHistorySnapshot").mockImplementation(async (historyPath, itemId) => {
          // An SDK host registers an observer after the summary session opened.
          if (!registered) {
            registered = true;
            setActiveExtensionHooks({ beforeCommand: [], afterCommand: [], onWrite: [], onIndex: [], onRead: [{ layer: "project", name: "late-observer", run: (hook) => { observed.add(path.basename(hook.path)); } }] });
          }
          return actual(historyPath, itemId);
        });
        try {
          const result = await read();
          expect(result.history_read).toMatchObject({ reason: "read_hooks_active", streams_read: streams.length, streams_total: streams.length });
          // The hook observed every stream, each exactly once per read.
          expect([...observed].sort()).toEqual([...streams].sort());
        } finally {
          spy.mockRestore();
          clearActiveExtensionHooks();
        }
      }
      await assertParity(context.pmPath);
    });
  });

  it("reads every skipped stream when a read hook is registered while skipped streams are revalidated", async () => {
    await withTempPmPath(async (context) => {
      await seedCorpus(context);
      const global = { path: context.pmPath };
      const streams = (await readdir(path.join(context.pmPath, "history"))).filter((file) => file.endsWith(".jsonl"));
      const actualOpen = streamSummaryModule.openHistoryStreamSummary;
      const reads: Array<() => Promise<{ history_read?: { reason: string; streams_read: number; streams_total: number } }>> = [
        () => runActivity({}, global),
        () => readRecentActivity({ limit: 1 }, global),
      ];
      for (const read of reads) {
        await runActivity({}, global);
        const observed: string[] = [];
        const spy = vi.spyOn(streamSummaryModule, "openHistoryStreamSummary").mockImplementation(async (params) => {
          const session = await actualOpen(params);
          return {
            ...session,
            // The observer arrives while the skipped streams' stats are in flight.
            revalidate: async (files) => {
              const changed = await session.revalidate(files);
              setActiveExtensionHooks({ beforeCommand: [], afterCommand: [], onWrite: [], onIndex: [], onRead: [{ layer: "project", name: "late-observer", run: (hook) => { observed.push(path.basename(hook.path)); } }] });
              return changed;
            },
          };
        });
        try {
          const result = await read();
          expect(result.history_read).toMatchObject({ reason: "read_hooks_active", streams_read: streams.length, streams_total: streams.length });
          // Only streams not read before the hook existed are observed, once each.
          expect(observed.length).toBeGreaterThan(0);
          expect(new Set(observed).size).toBe(observed.length);
        } finally {
          spy.mockRestore();
          clearActiveExtensionHooks();
        }
      }
    });
  });

  it("ends pruning when a read hook arrives while a stale skipped stream is re-read", async () => {
    await withTempPmPath(async (context) => {
      await seedCorpus(context);
      const global = { path: context.pmPath };
      const streams = (await readdir(path.join(context.pmPath, "history"))).filter((file) => file.endsWith(".jsonl"));
      const actualOpen = streamSummaryModule.openHistoryStreamSummary;
      const actualRead = historyReadModule.readIdentifiedHistorySnapshot;
      const reads: Array<() => Promise<{ history_read?: { reason: string; streams_read: number; streams_total: number } }>> = [
        () => runActivity({}, global),
        () => readRecentActivity({ limit: 1 }, global),
      ];
      for (const read of reads) {
        await runActivity({}, global);
        const observed: string[] = [];
        let revalidated = false;
        let registered = false;
        const openSpy = vi.spyOn(streamSummaryModule, "openHistoryStreamSummary").mockImplementation(async (params) => {
          const session = await actualOpen(params);
          return {
            ...session,
            // One skipped stream went stale, so it is re-read before the read finishes.
            revalidate: async (files) => {
              await session.revalidate(files);
              revalidated = true;
              return files.slice(0, 1);
            },
          };
        });
        const readSpy = vi.spyOn(historyReadModule, "readIdentifiedHistorySnapshot").mockImplementation(async (historyPath, itemId) => {
          // The observer arrives while that stale stream is being re-read.
          if (revalidated && !registered) {
            registered = true;
            setActiveExtensionHooks({ beforeCommand: [], afterCommand: [], onWrite: [], onIndex: [], onRead: [{ layer: "project", name: "late-observer", run: (hook) => { observed.push(path.basename(hook.path)); } }] });
          }
          return actualRead(historyPath, itemId);
        });
        try {
          const result = await read();
          expect(registered).toBe(true);
          expect(result.history_read).toMatchObject({ reason: "read_hooks_active", streams_read: streams.length, streams_total: streams.length });
          expect(observed.length).toBeGreaterThan(1);
          expect(new Set(observed).size).toBe(observed.length);
        } finally {
          openSpy.mockRestore();
          readSpy.mockRestore();
          clearActiveExtensionHooks();
        }
      }
    });
  });

  it("ends pruning when a read hook arrives while the summary is written, in both read paths", async () => {
    await withTempPmPath(async (context) => {
      await seedCorpus(context);
      const global = { path: context.pmPath };
      const streams = (await readdir(path.join(context.pmPath, "history"))).filter((file) => file.endsWith(".jsonl"));
      const actualOpen = streamSummaryModule.openHistoryStreamSummary;
      const reads: Array<() => Promise<{ history_read?: { reason: string; streams_read: number; streams_total: number } }>> = [
        () => runActivity({}, global),
        () => readRecentActivity({ limit: 1 }, global),
      ];
      for (const read of reads) {
        await runActivity({}, global);
        const observed: string[] = [];
        const spy = vi.spyOn(streamSummaryModule, "openHistoryStreamSummary").mockImplementation(async (params) => {
          const session = await actualOpen(params);
          return {
            ...session,
            // The observer arrives during the summary write, the read's last await.
            commit: async () => {
              await session.commit();
              setActiveExtensionHooks({ beforeCommand: [], afterCommand: [], onWrite: [], onIndex: [], onRead: [{ layer: "project", name: "late-observer", run: (hook) => { observed.push(path.basename(hook.path)); } }] });
            },
          };
        });
        try {
          const result = await read();
          expect(result.history_read).toMatchObject({ reason: "read_hooks_active", streams_read: streams.length, streams_total: streams.length });
          expect(observed.length).toBeGreaterThan(0);
          expect(new Set(observed).size).toBe(observed.length);
        } finally {
          spy.mockRestore();
          clearActiveExtensionHooks();
        }
      }
    });
  });

  it("names the read hooks, not stale bounds, when a late hook ended pruning", async () => {
    await withTempPmPath(async (context) => {
      await seedCorpus(context);
      const global = { path: context.pmPath };
      await runActivity({}, global);
      // Most recorded signatures no longer match (a copied tracker), but two
      // archive streams keep trusted bounds and are skipped.
      const summaryFile = path.join(context.pmPath, HISTORY_STREAM_SUMMARY_RELATIVE_PATH);
      const stored = JSON.parse(await readFile(summaryFile, "utf8")) as { version: number; streams: Record<string, unknown[]> };
      for (const [file, value] of Object.entries(stored.streams)) {
        if (file !== "pm-old1.jsonl" && file !== "pm-old2.jsonl") value[0] = `other-device:${String(value[0])}`;
      }
      await writeFile(summaryFile, JSON.stringify({ ...stored, checksum: summaryInternals.checksumOf(stored.streams) }));
      const actualOpen = streamSummaryModule.openHistoryStreamSummary;
      const spy = vi.spyOn(streamSummaryModule, "openHistoryStreamSummary").mockImplementation(async (params) => {
        const session = await actualOpen(params);
        expect(session.fallback).toBe("summary_stale");
        return {
          ...session,
          revalidate: async (files) => {
            const changed = await session.revalidate(files);
            setActiveExtensionHooks({ beforeCommand: [], afterCommand: [], onWrite: [], onIndex: [], onRead: [{ layer: "project", name: "late", run: () => undefined }] });
            return changed;
          },
        };
      });
      try {
        expect((await runActivity({}, global)).history_read).toMatchObject({ reason: "read_hooks_active" });
      } finally {
        spy.mockRestore();
        clearActiveExtensionHooks();
      }
    });
  });

  it("adds no receipt to reads below the summary threshold, even with read hooks active", async () => {
    await withTempPmPath(async (context) => {
      await seedCorpus(context);
      const global = { path: context.pmPath };
      const restore = summaryInternals.setMinimumStreams(NEVER);
      setActiveExtensionHooks({ beforeCommand: [], afterCommand: [], onWrite: [], onIndex: [], onRead: [{ layer: "project", name: "observer", run: () => undefined }] });
      try {
        expect((await runActivity({}, global)).history_read).toBeUndefined();
        expect((await readRecentActivity({ limit: 1 }, global)).history_read).toBeUndefined();
      } finally {
        restore();
        clearActiveExtensionHooks();
      }
    });
  });

  it("does not count a stream removed after the listing as parsed", async () => {
    await withTempPmPath(async (context) => {
      await seedCorpus(context);
      const global = { path: context.pmPath };
      const streams = (await readdir(path.join(context.pmPath, "history"))).filter((file) => file.endsWith(".jsonl"));
      const actual = historyReadModule.readIdentifiedHistorySnapshot;
      const spy = vi.spyOn(historyReadModule, "readIdentifiedHistorySnapshot").mockImplementation(async (historyPath, itemId) => {
        // A checkout removes one stream between the listing and its read.
        if (path.basename(String(historyPath)) === "pm-old1.jsonl") await rm(historyPath, { force: true });
        return actual(historyPath, itemId);
      });
      try {
        const cold = await runActivity({}, global);
        expect(cold.history_read).toEqual({ reason: "summary_missing", streams_read: streams.length - 1, streams_total: streams.length });
      } finally {
        spy.mockRestore();
      }
    });
  });

  it("re-reads a skipped stream that changed while the read ran, in both read paths", async () => {
    await withTempPmPath(async (context) => {
      await seedCorpus(context);
      const global = { path: context.pmPath };
      await runActivity({}, global);
      const fresh = new Date(FIXED_NOW - 200).toISOString();
      const actual = historyReadModule.readIdentifiedHistorySnapshot;
      const appendDuringRead = (stream: string) => {
        let appended = false;
        return vi.spyOn(historyReadModule, "readIdentifiedHistorySnapshot").mockImplementation(async (historyPath, itemId) => {
          // Another writer appends to a stream the read already skipped on its bounds.
          if (!appended) {
            appended = true;
            await appendFile(path.join(context.pmPath, "history", `${stream}.jsonl`), `${JSON.stringify(oldEntry(fresh, "comment_add", "spec-concurrent"))}\n`);
          }
          return actual(historyPath, itemId);
        });
      };
      // Window path: pm-old2 is outside the digest window until the append lands.
      const windowSpy = appendDuringRead("pm-old2");
      const digest = await runActivity({ raw: true, from: "-1h", limit: "50" }, global);
      windowSpy.mockRestore();
      expect(digest.compact_activity!.some((row) => row.id === "pm-old2" && row.author === "spec-concurrent")).toBe(true);
      // Recent path: pm-old1's stale newest bound could not outrank the cutoff.
      await runActivity({}, global);
      const recentSpy = appendDuringRead("pm-old1");
      const recent = await readRecentActivity({ limit: 1 }, global);
      recentSpy.mockRestore();
      expect(recent.rows).toEqual([expect.objectContaining({ id: "pm-old1", author: "spec-concurrent" })]);
      await assertParity(context.pmPath);

      // A bulk rewrite of most skipped streams during the read is stale bounds,
      // not a wide window.
      const archive = Array.from({ length: 16 }, (_, index) => `pm-archive-${String(index).padStart(2, "0")}`);
      for (const id of archive) await writeStream(context.pmPath, id, [oldEntry("2024-01-01T00:00:00.000Z", "create")]);
      await runActivity({}, global);
      let rewritten = false;
      const bulkSpy = vi.spyOn(historyReadModule, "readIdentifiedHistorySnapshot").mockImplementation(async (historyPath, itemId) => {
        if (!rewritten) {
          rewritten = true;
          for (const id of archive) await appendFile(path.join(context.pmPath, "history", `${id}.jsonl`), `${JSON.stringify(oldEntry("2024-01-02T00:00:00.000Z"))}\n`);
        }
        return actual(historyPath, itemId);
      });
      const bulk = await runActivity({}, global);
      bulkSpy.mockRestore();
      expect(bulk.history_read).toMatchObject({ reason: "summary_stale" });

      // Streams stale at open and streams that go stale mid-read count together.
      await runActivity({}, global);
      const files = (await readdir(path.join(context.pmPath, "history"))).filter((file) => file.endsWith(".jsonl"));
      const atOpen = archive.slice(0, 8);
      const midRead = archive.slice(8);
      expect((atOpen.length + midRead.length) * 2).toBeGreaterThan(files.length);
      expect(atOpen.length * 2).toBeLessThan(files.length);
      for (const id of atOpen) await appendFile(path.join(context.pmPath, "history", `${id}.jsonl`), `${JSON.stringify(oldEntry("2024-01-03T00:00:00.000Z"))}\n`);
      let staled = false;
      const mixedSpy = vi.spyOn(historyReadModule, "readIdentifiedHistorySnapshot").mockImplementation(async (historyPath, itemId) => {
        if (!staled) {
          staled = true;
          for (const id of midRead) await appendFile(path.join(context.pmPath, "history", `${id}.jsonl`), `${JSON.stringify(oldEntry("2024-01-04T00:00:00.000Z"))}\n`);
        }
        return actual(historyPath, itemId);
      });
      const mixed = await runActivity({}, global);
      mixedSpy.mockRestore();
      expect(mixed.history_read).toMatchObject({ reason: "summary_stale" });
    });
  });

  it("names irregular timestamps when they caused most of the parsed streams", async () => {
    await withTempPmPath(async (context) => {
      await seedCorpus(context);
      const global = { path: context.pmPath };
      for (let index = 0; index < 12; index += 1) await writeStream(context.pmPath, `pm-irregular-${String(index).padStart(2, "0")}`, [oldEntry("2024-01-01")]);
      for (let index = 0; index < 8; index += 1) await writeStream(context.pmPath, `pm-regular-${String(index).padStart(2, "0")}`, [oldEntry("2024-01-01T00:00:00.000Z")]);
      await runActivity({}, global);
      const files = (await readdir(path.join(context.pmPath, "history"))).filter((file) => file.endsWith(".jsonl"));
      const session = await openHistoryStreamSummary({ pmRoot: context.pmPath, historyDir: path.join(context.pmPath, "history"), files });
      const irregular = files.filter((file) => session.trusted(file)?.irregular === true).length;
      // Fewer than half of all streams are irregular, so the summary itself is served...
      expect(session.fallback).toBeUndefined();
      expect(irregular * 2).toBeLessThan(files.length);
      // ...but irregular streams are most of what the digest parses.
      const digest = await runActivity({}, global);
      expect(digest.history_read).toMatchObject({ reason: "irregular_timestamps" });
      expect(irregular * 2).toBeGreaterThan(digest.history_read!.streams_read);
    });
  });

  it("returns no rows for a zero limit, reads no trusted stream, and still raises a damaged stream's error", async () => {
    await withTempPmPath(async (context) => {
      await seedCorpus(context);
      const global = { path: context.pmPath };
      await readRecentActivity({ limit: 3 }, global);
      const reads = vi.spyOn(historyReadModule, "readIdentifiedHistorySnapshot");
      expect(await readRecentActivity({ limit: 0 }, global)).toEqual({ rows: [] });
      // Only the stream with irregular timestamps is read; no trusted regular one.
      expect(reads.mock.calls.map(([file]) => path.basename(String(file)))).toEqual(["pm-odd.jsonl"]);
      await appendFile(path.join(context.pmPath, "history", "pm-old1.jsonl"), "{ not json\n");
      await expect(readRecentActivity({ limit: 0 }, global)).rejects.toMatchObject({ code: "history_json_invalid" });
    });
  });

  it("breaks timestamp ties at the row cutoff by item id, as the complete read does", async () => {
    await withTempPmPath(async (context) => {
      await seedCorpus(context);
      const global = { path: context.pmPath };
      const tie = new Date(FIXED_NOW - 1_000).toISOString();
      for (const id of ["pm-cut-c", "pm-cut-a", "pm-cut-b", "pm-cut-z"]) {
        // Two entries with equal sort keys keep their stream order.
        await writeStream(context.pmPath, id, [oldEntry("2025-01-01T00:00:00.000Z", "create"), oldEntry(tie, "update", "spec-cut"), oldEntry(tie, "update", "spec-cut-2")]);
      }
      await readRecentActivity({ limit: 2 }, global);
      const reads = vi.spyOn(historyReadModule, "readIdentifiedHistorySnapshot");
      const pair = await readRecentActivity({ limit: 2 }, global);
      expect(pair.rows.map((row) => [row.id, row.author])).toEqual([["pm-cut-a", "spec-cut"], ["pm-cut-a", "spec-cut-2"]]);
      const read = reads.mock.calls.map(([file]) => path.basename(String(file)));
      expect(read).toContain("pm-cut-a.jsonl");
      expect(read).not.toContain("pm-cut-c.jsonl");
      // An untrusted stream fills the selection first; a tied stream with a
      // smaller id must still be read to displace it.
      await appendFile(path.join(context.pmPath, "history", "pm-cut-z.jsonl"), `${JSON.stringify(oldEntry("2025-01-02T00:00:00.000Z"))}\n`);
      reads.mockClear();
      const single = await readRecentActivity({ limit: 1 }, global);
      expect(single.rows.map((row) => row.id)).toEqual(["pm-cut-a"]);
      expect(reads.mock.calls.map(([file]) => path.basename(String(file)))).toEqual(expect.arrayContaining(["pm-cut-z.jsonl", "pm-cut-a.jsonl"]));
      const fractional = await readRecentActivity({ limit: 2.5 }, global);
      expect(fractional.rows).toHaveLength(2);
      await assertParity(context.pmPath);
      const restore = summaryInternals.setMinimumStreams(NEVER);
      try {
        expect((await readRecentActivity({ limit: 1 }, global)).rows).toEqual(single.rows);
      } finally {
        restore();
      }
    });
  });

  it("carries the fallback receipt into pm context and omits it once bounds are trusted", async () => {
    await withTempPmPath(async (context) => {
      await seedCorpus(context);
      const global = { path: context.pmPath };
      const first = await runContext({ section: ["activity"], activityLimit: "2" } as never, global);
      expect(first.activity).toHaveLength(2);
      expect(first.activity_history_read).toMatchObject({ reason: "summary_missing" });
      const second = await runContext({ section: ["activity"], activityLimit: "2" } as never, global);
      expect(second.activity).toEqual(first.activity);
      expect(second.activity_history_read).toBeUndefined();
    });
  });

  it("returns a row with a non-string recorded harness instead of crashing either read", async () => {
    await withTempPmPath(async (context) => {
      await seedCorpus(context);
      const global = { path: context.pmPath };
      await writeStream(context.pmPath, "pm-harness", [{ ...oldEntry(new Date(FIXED_NOW - 500).toISOString(), "update", "spec-harness"), agent_harness: 42 }]);
      const raw = await runActivity({ raw: true, limit: "1" }, global);
      expect(raw.compact_activity).toEqual([expect.objectContaining({ id: "pm-harness", author: "spec-harness" })]);
      expect((await readRecentActivity({ limit: 1 }, global)).rows).toEqual(raw.compact_activity);
      const provenance = await runActivity({ provenance: true, from: "-1d", limit: "1" }, global);
      expect(provenance.provenance_activity![0]).toMatchObject({ item_id: "pm-harness", harness_source: "unresolved" });
      await assertParity(context.pmPath);
    });
  });

  it("orders unread streams by their best possible row and stops only when none can outrank the cutoff", () => {
    const { streamCanOutrank, compareDeferredStreams } = activityInternals;
    const last = { id: "pm-b", ts: "2026-11-02T00:00:00.000Z" } as never;
    expect(streamCanOutrank("2026-11-03T00:00:00.000Z", "pm-z", last)).toBe(true);
    expect(streamCanOutrank("2026-11-01T00:00:00.000Z", "pm-a", last)).toBe(false);
    expect(streamCanOutrank("2026-11-02T00:00:00.000Z", "pm-a", last)).toBe(true);
    expect(streamCanOutrank("2026-11-02T00:00:00.000Z", "pm-b", last)).toBe(true);
    expect(streamCanOutrank("2026-11-02T00:00:00.000Z", "pm-c", last)).toBe(false);
    // Distinct file names that collate equally (NFC and NFD) keep file order.
    const streams = [
      { file: "pm-e\u0301.jsonl", position: 3, id: "pm-e\u0301", newest: "2026-11-02T00:00:00.000Z" },
      { file: "pm-\u00e9.jsonl", position: 2, id: "pm-\u00e9", newest: "2026-11-02T00:00:00.000Z" },
      { file: "pm-a.jsonl", position: 1, id: "pm-a", newest: "2026-11-02T00:00:00.000Z" },
      { file: "pm-z.jsonl", position: 0, id: "pm-z", newest: "2026-11-03T00:00:00.000Z" },
    ];
    expect([...streams].sort(compareDeferredStreams).map((stream) => stream.position)).toEqual([0, 1, 2, 3]);
  });

  it("excludes streams outside the window only when their bounds prove it", () => {
    const { streamMayMatchWindow } = activityInternals;
    const bounds = { count: 2, oldest: "2025-01-01T00:00:00.000Z", newest: "2025-02-01T00:00:00.000Z", irregular: false };
    expect(streamMayMatchWindow({ ...bounds, count: 0 }, {})).toBe(false);
    expect(streamMayMatchWindow({ ...bounds, irregular: true }, { from: "2026-01-01T00:00:00.000Z" })).toBe(true);
    expect(streamMayMatchWindow(bounds, { from: "2025-02-01T00:00:00.001Z" })).toBe(false);
    expect(streamMayMatchWindow(bounds, { from: "2025-02-01T00:00:00.000Z" })).toBe(true);
    expect(streamMayMatchWindow(bounds, { to: "2025-01-01T00:00:00.000Z" })).toBe(false);
    expect(streamMayMatchWindow(bounds, { to: "2025-01-01T00:00:00.001Z" })).toBe(true);
    expect(streamMayMatchWindow(bounds, {})).toBe(true);
  });
});
