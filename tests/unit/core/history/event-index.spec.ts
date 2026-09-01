import { DatabaseSync } from "node:sqlite";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _testOnly,
  queryHistoryEventIndex,
  queryHistoryEventStreams,
  readLatestSubstantiveHistoryEvents,
  rebuildHistoryEventIndex,
  removeHistoryEventIndexForHistoryPath,
} from "../../../../src/core/history/event-index.js";
import type { HistoryEntry } from "../../../../src/types/index.js";
import { appendHistoryEntry } from "../../../../src/core/history/history.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";

const INDEX_FILENAME = "history-event-index.sqlite";
let restoreDatabaseSync: (() => void) | undefined;

function historyEntry(
  ts: string,
  author: string,
  op: string,
  message?: string,
): HistoryEntry {
  return {
    ts,
    author,
    op,
    patch: [],
    before_hash: "before",
    after_hash: "after",
    ...(message === undefined ? {} : { message }),
  };
}

beforeEach(() => {
  restoreDatabaseSync = _testOnly.setDatabaseSync(DatabaseSync);
});

afterEach(() => {
  restoreDatabaseSync?.();
  restoreDatabaseSync = undefined;
});

describe("history mutation event index", () => {
  it("loads optional SQLite constructors without leaking loader failures", () => {
    expect(_testOnly.loadDatabaseSync(() => ({ DatabaseSync }))).toBe(
      DatabaseSync,
    );
    expect(_testOnly.loadDatabaseSync(() => ({}))).toBeNull();
    expect(
      _testOnly.loadDatabaseSync(() => {
        throw new Error("unsupported");
      }),
    ).toBeNull();
    expect(
      _testOnly.loadStableDatabaseSync("22.0.0", () => ({ DatabaseSync })),
    ).toBe(DatabaseSync);
    expect(
      _testOnly.loadStableDatabaseSync("21.7.3", () => ({ DatabaseSync })),
    ).toBeNull();
    expect(
      _testOnly.loadStableDatabaseSync("invalid", () => ({ DatabaseSync })),
    ).toBeNull();
    expect(
      _testOnly.loadStableDatabaseSync("26.5.0", () => ({ DatabaseSync })),
    ).toBe(DatabaseSync);
  });

  it("rebuilds deterministically and applies ordering, cursors, and set filters", async () => {
    await withTempPmPath(async (context) => {
      const historyRoot = path.join(context.pmPath, "history");
      await fs.writeFile(
        path.join(historyRoot, "pm-b.jsonl"),
        `${JSON.stringify(historyEntry("2026-07-24T10:00:00.000Z", "beta", "update"))}\n`,
      );
      await fs.writeFile(
        path.join(historyRoot, "pm-a.jsonl"),
        [
          historyEntry(
            "2026-07-24T09:00:00.000Z",
            "alpha",
            "create",
            "created",
          ),
          historyEntry("2026-07-24T10:00:00.000Z", "alpha", "claim"),
        ]
          .map((entry) => JSON.stringify(entry))
          .join("\n"),
      );
      await fs.writeFile(path.join(historyRoot, "ignored.txt"), "ignored\n");
      await fs.mkdir(path.join(historyRoot, "ignored.jsonl"));

      await expect(rebuildHistoryEventIndex(context.pmPath)).resolves.toBe(
        true,
      );
      await expect(
        queryHistoryEventIndex(context.pmPath, { limit: 1 }),
      ).resolves.toMatchObject({
        has_more: true,
        events: [
          {
            stream_id: "pm-a",
            stream_offset: 0,
            entry: { op: "create", message: "created" },
          },
        ],
      });
      await expect(
        queryHistoryEventIndex(context.pmPath, {
          after_ts: "2026-07-24T09:00:00.000Z",
          after_stream_id: "pm-a",
          after_stream_offset: 0,
          ops: ["claim", "update"],
          authors: ["alpha"],
          stream_ids: ["pm-a"],
          limit: 5,
        }),
      ).resolves.toMatchObject({
        has_more: false,
        events: [
          { stream_id: "pm-a", stream_offset: 1, entry: { op: "claim" } },
        ],
      });
      await expect(
        queryHistoryEventIndex(context.pmPath, {
          since_ts: "2026-07-24T10:00:00.000Z",
          ops: [],
          authors: [],
          stream_ids: [],
          limit: 1.9,
        }),
      ).resolves.toMatchObject({
        has_more: true,
        events: [{ stream_id: "pm-a", entry: { op: "claim" } }],
      });
      await expect(
        queryHistoryEventIndex(context.pmPath, { limit: -1 }),
      ).resolves.toEqual({ events: [], has_more: true });
    });
  });

  it("updates existing projections, ignores absent ones, and removes rewritten projections", async () => {
    await withTempPmPath(async (context) => {
      const historyPath = path.join(
        context.pmPath,
        "history",
        "pm-update.jsonl",
      );
      const first = historyEntry("2026-07-24T09:00:00.000Z", "agent", "create");
      const second = historyEntry(
        "2026-07-24T10:00:00.000Z",
        "agent",
        "update",
      );
      await fs.writeFile(historyPath, `${JSON.stringify(first)}\n`);

      await rebuildHistoryEventIndex(context.pmPath);
      await appendHistoryEntry(historyPath, second);
      await expect(
        queryHistoryEventIndex(context.pmPath, { limit: 10 }),
      ).resolves.toMatchObject({
        events: [
          { stream_offset: 0, entry: { op: "create" } },
          { stream_offset: 1, entry: { op: "update" } },
        ],
      });

      await removeHistoryEventIndexForHistoryPath(historyPath);
      await expect(
        queryHistoryEventIndex(context.pmPath, { limit: 10 }),
      ).resolves.toBeNull();
    });
  });

  it("selects latest substantive events from indexed and authoritative history", async () => {
    await withTempPmPath(async (context) => {
      const historyRoot = path.join(context.pmPath, "history");
      await fs.writeFile(
        path.join(historyRoot, "pm-recency.jsonl"),
        [
          {
            ...historyEntry("2026-07-24T09:00:00.000Z", "agent", "create"),
            event_class: "substantive",
          },
          {
            ...historyEntry("2026-07-24T10:00:00.000Z", "agent", "release"),
            event_class: "maintenance",
          },
        ]
          .map((entry) => JSON.stringify(entry))
          .join("\n") + "\n",
      );
      await rebuildHistoryEventIndex(context.pmPath);
      await expect(
        readLatestSubstantiveHistoryEvents(context.pmPath, [
          "pm-recency",
          "pm-missing",
          "../unsafe",
          "",
        ]),
      ).resolves.toMatchObject({
        "pm-recency": {
          stream_offset: 0,
          entry: { op: "create", event_class: "substantive" },
        },
      });

      await removeHistoryEventIndexForHistoryPath(
        path.join(historyRoot, "pm-recency.jsonl"),
      );
      await expect(
        readLatestSubstantiveHistoryEvents(context.pmPath, ["pm-recency"]),
      ).resolves.toMatchObject({
        "pm-recency": { stream_offset: 0, entry: { op: "create" } },
      });

      restoreDatabaseSync?.();
      restoreDatabaseSync = _testOnly.setDatabaseSync(null);
      await expect(
        readLatestSubstantiveHistoryEvents(context.pmPath, [
          "pm-recency",
          "pm-missing",
          "../unsafe",
        ]),
      ).resolves.toMatchObject({
        "pm-recency": { stream_offset: 0, entry: { op: "create" } },
      });
    });
  });

  it("rejects stale valid indexes and preserves prototype-shaped stream ids", async () => {
    await withTempPmPath(async (context) => {
      const historyRoot = path.join(context.pmPath, "history");
      const stalePath = path.join(historyRoot, "pm-stale.jsonl");
      await fs.writeFile(
        stalePath,
        `${JSON.stringify(historyEntry("2026-07-24T09:00:00.000Z", "agent", "create"))}\n`,
      );
      for (const streamId of ["constructor", "toString"]) {
        await fs.writeFile(
          path.join(historyRoot, `${streamId}.jsonl`),
          `${JSON.stringify(historyEntry("2026-07-24T08:00:00.000Z", "agent", "create"))}\n`,
        );
      }
      await rebuildHistoryEventIndex(context.pmPath);
      await fs.appendFile(
        stalePath,
        `${JSON.stringify(historyEntry("2026-07-24T10:00:00.000Z", "agent", "comment_add"))}\n`,
      );

      const latest = await readLatestSubstantiveHistoryEvents(context.pmPath, [
        "pm-stale",
        "constructor",
        "toString",
      ]);
      expect(latest["pm-stale"]).toMatchObject({
        stream_offset: 1,
        entry: { op: "comment_add" },
      });
      expect(Object.keys(latest).sort()).toEqual([
        "constructor",
        "pm-stale",
        "toString",
      ]);
      expect(Object.getPrototypeOf(latest)).toBeNull();
    });
  });

  it("binds rebuilt stream sizes to the same pre-read authoritative snapshot", async () => {
    await withTempPmPath(async (context) => {
      const historyPath = path.join(
        context.pmPath,
        "history",
        "pm-concurrent.jsonl",
      );
      const first = historyEntry("2026-07-24T09:00:00.000Z", "agent", "create");
      const second = historyEntry(
        "2026-07-24T10:00:00.000Z",
        "agent",
        "comment_add",
      );
      const firstLine = `${JSON.stringify(first)}\n`;
      await fs.writeFile(historyPath, firstLine);
      const originalStat = fs.stat.bind(fs);
      let appended = false;
      const statSpy = vi
        .spyOn(fs, "stat")
        .mockImplementation(async (...args) => {
          const stats = await originalStat(...args);
          if (!appended && String(args[0]) === historyPath) {
            appended = true;
            await fs.appendFile(historyPath, `${JSON.stringify(second)}\n`);
          }
          return stats;
        });
      try {
        await rebuildHistoryEventIndex(context.pmPath);
      } finally {
        statSpy.mockRestore();
      }

      const database = new DatabaseSync(
        path.join(context.pmPath, "runtime", INDEX_FILENAME),
      );
      const indexedStream = database
        .prepare("SELECT byte_size FROM streams WHERE stream_id = ?")
        .get("pm-concurrent") as { byte_size: number };
      database.close();
      expect(indexedStream.byte_size).toBe(Buffer.byteLength(firstLine));
      expect((await fs.stat(historyPath)).size).toBeGreaterThan(
        indexedStream.byte_size,
      );
      await expect(
        readLatestSubstantiveHistoryEvents(context.pmPath, ["pm-concurrent"]),
      ).resolves.toMatchObject({
        "pm-concurrent": {
          stream_offset: 1,
          entry: { op: "comment_add" },
        },
      });
    });
  });

  it("serializes appends through incremental size capture", async () => {
    await withTempPmPath(async (context) => {
      const historyPath = path.join(
        context.pmPath,
        "history",
        "pm-incremental-concurrent.jsonl",
      );
      const first = historyEntry("2026-07-24T09:00:00.000Z", "agent", "create");
      const second = historyEntry(
        "2026-07-24T10:00:00.000Z",
        "agent",
        "update",
      );
      const third = historyEntry(
        "2026-07-24T11:00:00.000Z",
        "agent",
        "comment_add",
      );
      await fs.writeFile(historyPath, `${JSON.stringify(first)}\n`);
      await rebuildHistoryEventIndex(context.pmPath);
      const originalStat = fs.stat.bind(fs);
      let concurrentAppend: Promise<void> | undefined;
      const statSpy = vi
        .spyOn(fs, "stat")
        .mockImplementation(async (...args) => {
          const stats = await originalStat(...args);
          if (
            concurrentAppend === undefined &&
            String(args[0]) === historyPath
          ) {
            concurrentAppend = appendHistoryEntry(historyPath, third);
          }
          return stats;
        });
      try {
        await appendHistoryEntry(historyPath, second);
        await concurrentAppend;
      } finally {
        statSpy.mockRestore();
      }

      const database = new DatabaseSync(
        path.join(context.pmPath, "runtime", INDEX_FILENAME),
      );
      const indexedStream = database
        .prepare("SELECT byte_size FROM streams WHERE stream_id = ?")
        .get("pm-incremental-concurrent") as { byte_size: number };
      database.close();
      expect(indexedStream.byte_size).toBe((await fs.stat(historyPath)).size);
      await expect(
        queryHistoryEventIndex(context.pmPath, { limit: 10 }),
      ).resolves.toMatchObject({
        events: [
          { stream_offset: 0, entry: { op: "create" } },
          { stream_offset: 1, entry: { op: "update" } },
          { stream_offset: 2, entry: { op: "comment_add" } },
        ],
      });
    });
  });

  it("rebuilds incompatible recency indexes and preserves authoritative read errors", async () => {
    await withTempPmPath(async (context) => {
      const historyRoot = path.join(context.pmPath, "history");
      const historyPath = path.join(historyRoot, "pm-recency.jsonl");
      await fs.writeFile(
        historyPath,
        `${JSON.stringify(historyEntry("2026-07-24T09:00:00.000Z", "agent", "create"))}\n`,
      );
      await rebuildHistoryEventIndex(context.pmPath);
      const database = new DatabaseSync(
        path.join(context.pmPath, "runtime", INDEX_FILENAME),
      );
      database
        .prepare("UPDATE metadata SET value = 'old' WHERE key = 'version'")
        .run();
      database.close();
      await expect(
        readLatestSubstantiveHistoryEvents(context.pmPath, ["pm-recency"]),
      ).resolves.toMatchObject({
        "pm-recency": { stream_offset: 0, entry: { op: "create" } },
      });

      restoreDatabaseSync?.();
      restoreDatabaseSync = _testOnly.setDatabaseSync(null);
      await fs.mkdir(path.join(historyRoot, "pm-directory.jsonl"));
      await expect(
        readLatestSubstantiveHistoryEvents(context.pmPath, ["pm-directory"]),
      ).rejects.toThrow();
    });
  });

  it("preserves non-missing stream stat failures during indexed recency reads", async () => {
    await withTempPmPath(async (context) => {
      await rebuildHistoryEventIndex(context.pmPath);
      await fs.symlink(
        "pm-loop.jsonl",
        path.join(context.pmPath, "history", "pm-loop.jsonl"),
      );
      await expect(
        readLatestSubstantiveHistoryEvents(context.pmPath, ["pm-loop"]),
      ).rejects.toMatchObject({ code: "ELOOP" });
    });
  });

  it("falls back when a rebuilt projection cannot be reopened", async () => {
    await withTempPmPath(async (context) => {
      const historyPath = path.join(
        context.pmPath,
        "history",
        "pm-fallback.jsonl",
      );
      await fs.writeFile(
        historyPath,
        `${JSON.stringify(historyEntry("2026-07-24T09:00:00.000Z", "agent", "create"))}\n`,
      );
      let opens = 0;
      class ReopenFailureDatabase {
        constructor(...args: ConstructorParameters<typeof DatabaseSync>) {
          opens += 1;
          if (opens === 3) throw new Error("reopen failed");
          return new DatabaseSync(...args);
        }
      }
      restoreDatabaseSync?.();
      restoreDatabaseSync = _testOnly.setDatabaseSync(
        ReopenFailureDatabase as never,
      );
      await expect(
        readLatestSubstantiveHistoryEvents(context.pmPath, ["pm-fallback"]),
      ).resolves.toMatchObject({
        "pm-fallback": { stream_offset: 0, entry: { op: "create" } },
      });
    });
  });

  it("supports an empty tracker and reports unavailable SQLite runtimes", async () => {
    await withTempPmPath(async (context) => {
      await fs.rm(path.join(context.pmPath, "history"), {
        recursive: true,
        force: true,
      });
      await expect(rebuildHistoryEventIndex(context.pmPath)).resolves.toBe(
        true,
      );
      await expect(
        queryHistoryEventIndex(context.pmPath, { limit: 10 }),
      ).resolves.toEqual({ events: [], has_more: false });

      restoreDatabaseSync?.();
      restoreDatabaseSync = _testOnly.setDatabaseSync(null);
      await expect(rebuildHistoryEventIndex(context.pmPath)).resolves.toBe(
        false,
      );
      await expect(
        queryHistoryEventIndex(context.pmPath, { limit: 10 }),
      ).resolves.toBeNull();
      await expect(
        queryHistoryEventStreams(context.pmPath, { limit: 10 }),
      ).resolves.toEqual({ events: [], has_more: false });
      await expect(
        appendHistoryEntry(
          path.join(context.pmPath, "history", "pm-a.jsonl"),
          historyEntry("2026-07-24T10:00:00.000Z", "agent", "update"),
        ),
      ).resolves.toBeUndefined();
    });
  });

  it("queries authoritative streams with index-equivalent ordering and filters", async () => {
    await withTempPmPath(async (context) => {
      const historyRoot = path.join(context.pmPath, "history");
      await fs.writeFile(
        path.join(historyRoot, "pm-b.jsonl"),
        `${JSON.stringify({
          ...historyEntry("2026-07-24T10:00:00.000Z", "beta", "update"),
          agent_harness: "codex",
          agent_instance: "instance-b",
          agent_provenance: {
            model: { value: "gpt-5.6-sol", source: "probe" },
          },
        })}\n`,
      );
      await fs.writeFile(
        path.join(historyRoot, "pm-a.jsonl"),
        [
          historyEntry("2026-07-24T09:00:00.000Z", "alpha", "create"),
          historyEntry("2026-07-24T10:00:00.000Z", "legacy-codex", "update"),
        ]
          .map((entry) => JSON.stringify(entry))
          .join("\n"),
      );

      await expect(
        queryHistoryEventStreams(context.pmPath, {
          since_ts: "2026-07-24T10:00:00.000Z",
          ops: ["update"],
          harnesses: ["codex"],
          harness_alias_authors: ["legacy-codex"],
          limit: 1,
        }),
      ).resolves.toMatchObject({
        has_more: true,
        events: [{ stream_id: "pm-a", stream_offset: 1 }],
      });
      await expect(
        queryHistoryEventStreams(context.pmPath, {
          after_ts: "2026-07-24T10:00:00.000Z",
          after_stream_id: "pm-a",
          after_stream_offset: 1,
          agent_instances: ["instance-b"],
          provenance: [{ dimension: "model", values: ["gpt-5.6-sol"] }],
          stream_ids: ["pm-b"],
          limit: 10,
        }),
      ).resolves.toMatchObject({
        has_more: false,
        events: [{ stream_id: "pm-b", stream_offset: 0 }],
      });
      await expect(
        queryHistoryEventStreams(context.pmPath, {
          authors: ["nobody"],
          limit: 10,
        }),
      ).resolves.toEqual({ events: [], has_more: false });
      await expect(
        queryHistoryEventStreams(context.pmPath, {
          harnesses: ["codex"],
          stream_ids: ["pm-a"],
          limit: 10,
        }),
      ).resolves.toEqual({ events: [], has_more: false });
    });
  });

  it("reuses unchanged authoritative streams and refreshes only changed files", async () => {
    await withTempPmPath(async (context) => {
      const historyRoot = path.join(context.pmPath, "history");
      const firstA = historyEntry(
        "2026-07-24T09:00:00.000Z",
        "alpha",
        "create",
      );
      const firstB = historyEntry("2026-07-24T10:00:00.000Z", "beta", "update");
      await fs.writeFile(
        path.join(historyRoot, "pm-a.jsonl"),
        `${JSON.stringify(firstA)}\n`,
      );
      await fs.writeFile(
        path.join(historyRoot, "pm-b.jsonl"),
        `${JSON.stringify(firstB)}\n`,
      );

      const first = await queryHistoryEventStreams(context.pmPath, {
        limit: 10,
      });
      const second = await queryHistoryEventStreams(context.pmPath, {
        limit: 10,
      });
      expect(second.events.map((event) => event.entry)).toEqual(
        first.events.map((event) => event.entry),
      );
      expect(second.events[0]?.entry).toBe(first.events[0]?.entry);
      expect(second.events[1]?.entry).toBe(first.events[1]?.entry);

      const secondA = historyEntry(
        "2026-07-24T11:00:00.000Z",
        "alpha",
        "close",
      );
      await fs.appendFile(
        path.join(historyRoot, "pm-a.jsonl"),
        `${JSON.stringify(secondA)}\n`,
      );
      const refreshed = await queryHistoryEventStreams(context.pmPath, {
        limit: 10,
      });
      expect(refreshed.events).toHaveLength(3);
      expect(refreshed.events[1]?.entry).toBe(first.events[1]?.entry);
      expect(refreshed.events[2]).toMatchObject({
        stream_id: "pm-a",
        stream_offset: 1,
        entry: { op: "close" },
      });

      await fs.rm(path.join(historyRoot, "pm-b.jsonl"));
      await expect(
        queryHistoryEventStreams(context.pmPath, { limit: 10 }),
      ).resolves.toMatchObject({
        has_more: false,
        events: [
          { stream_id: "pm-a", stream_offset: 0 },
          { stream_id: "pm-a", stream_offset: 1 },
        ],
      });
    });
  });

  it("bounds authoritative stream caches across tracker roots", async () => {
    await withTempPmPath(async (context) => {
      let firstRoot = "";
      let firstEntry: HistoryEntry | undefined;
      for (let index = 0; index <= 8; index += 1) {
        const pmRoot = path.join(context.tempRoot, `cache-root-${index}`);
        const historyRoot = path.join(pmRoot, "history");
        await fs.mkdir(historyRoot, { recursive: true });
        await fs.writeFile(
          path.join(historyRoot, "pm-cache.jsonl"),
          `${JSON.stringify(
            historyEntry(
              `2026-07-24T${String(index).padStart(2, "0")}:00:00.000Z`,
              "agent",
              "update",
            ),
          )}\n`,
        );
        const page = await queryHistoryEventStreams(pmRoot, { limit: 10 });
        if (index === 0) {
          firstRoot = pmRoot;
          firstEntry = page.events[0]?.entry;
        }
      }

      const reread = await queryHistoryEventStreams(firstRoot, { limit: 10 });
      expect(reread.events[0]?.entry).not.toBe(firstEntry);
    });
  });

  it("invalidates corrupt and incompatible projections instead of serving stale rows", async () => {
    await withTempPmPath(async (context) => {
      const historyPath = path.join(
        context.pmPath,
        "history",
        "pm-invalid.jsonl",
      );
      const indexPath = path.join(context.pmPath, "runtime", INDEX_FILENAME);
      const entry = historyEntry("2026-07-24T10:00:00.000Z", "agent", "update");
      await fs.writeFile(historyPath, `${JSON.stringify(entry)}\n`);
      await rebuildHistoryEventIndex(context.pmPath);

      const database = new DatabaseSync(indexPath);
      database
        .prepare("UPDATE metadata SET value = 'old' WHERE key = 'version'")
        .run();
      database.close();
      await expect(
        queryHistoryEventIndex(context.pmPath, { limit: 10 }),
      ).resolves.toBeNull();
      await appendHistoryEntry(historyPath, entry);
      await expect(fs.access(indexPath)).rejects.toThrow();

      await fs.writeFile(indexPath, "not sqlite");
      await expect(
        queryHistoryEventIndex(context.pmPath, { limit: 10 }),
      ).resolves.toBeNull();
      await appendHistoryEntry(historyPath, entry);
      await expect(fs.access(indexPath)).rejects.toThrow();
    });
  });

  it("preserves append failures and invalidates projections after post-append failures", async () => {
    await withTempPmPath(async (context) => {
      const historyRoot = path.join(context.pmPath, "history");
      const indexPath = path.join(context.pmPath, "runtime", INDEX_FILENAME);
      await rebuildHistoryEventIndex(context.pmPath);
      const failedAppendPath = path.join(historyRoot, "pm-append-fail.jsonl");
      await fs.mkdir(failedAppendPath);
      await expect(
        appendHistoryEntry(
          failedAppendPath,
          historyEntry("2026-07-24T10:00:00.000Z", "agent", "update"),
        ),
      ).rejects.toThrow();
      await expect(fs.access(indexPath)).resolves.toBeUndefined();

      await fs.rm(failedAppendPath, { recursive: true });
      const historyPath = path.join(historyRoot, "pm-index-fail.jsonl");
      const first = historyEntry("2026-07-24T09:00:00.000Z", "agent", "create");
      const second = historyEntry(
        "2026-07-24T10:00:00.000Z",
        "agent",
        "update",
      );
      await fs.writeFile(historyPath, `${JSON.stringify(first)}\n`);
      await rebuildHistoryEventIndex(context.pmPath);
      const originalStat = fs.stat.bind(fs);
      const statSpy = vi
        .spyOn(fs, "stat")
        .mockImplementation(async (...args) => {
          if (String(args[0]) === historyPath) throw new Error("stat failed");
          return originalStat(...args);
        });
      try {
        await expect(
          appendHistoryEntry(historyPath, second),
        ).resolves.toBeUndefined();
      } finally {
        statSpy.mockRestore();
      }
      expect(
        (await fs.readFile(historyPath, "utf8")).trim().split("\n"),
      ).toHaveLength(2);
      await expect(fs.access(indexPath)).rejects.toThrow();
    });
  });

  it("refuses an append when the index write lock cannot be acquired", async () => {
    await withTempPmPath(async (context) => {
      const historyPath = path.join(
        context.pmPath,
        "history",
        "pm-lock-fail.jsonl",
      );
      const first = historyEntry("2026-07-24T09:00:00.000Z", "agent", "create");
      const second = historyEntry(
        "2026-07-24T10:00:00.000Z",
        "agent",
        "update",
      );
      const firstLine = `${JSON.stringify(first)}\n`;
      await fs.writeFile(historyPath, firstLine);
      await rebuildHistoryEventIndex(context.pmPath);
      class BeginFailureDatabase {
        readonly database: DatabaseSync;

        constructor(...args: ConstructorParameters<typeof DatabaseSync>) {
          this.database = new DatabaseSync(...args);
        }

        prepare(...args: Parameters<DatabaseSync["prepare"]>) {
          return this.database.prepare(...args);
        }

        exec(sql: string) {
          if (sql === "BEGIN IMMEDIATE") throw new Error("database is locked");
          return this.database.exec(sql);
        }

        close() {
          return this.database.close();
        }
      }
      restoreDatabaseSync?.();
      restoreDatabaseSync = _testOnly.setDatabaseSync(
        BeginFailureDatabase as never,
      );

      await expect(appendHistoryEntry(historyPath, second)).rejects.toThrow(
        "database is locked",
      );
      expect(await fs.readFile(historyPath, "utf8")).toBe(firstLine);
      await expect(
        queryHistoryEventIndex(context.pmPath, { limit: 10 }),
      ).resolves.toMatchObject({
        events: [{ stream_offset: 0, entry: { op: "create" } }],
      });
    });
  });

  it("cleans temporary projections when rebuild input or database creation fails", async () => {
    await withTempPmPath(async (context) => {
      const historyRoot = path.join(context.pmPath, "history");
      await fs.writeFile(
        path.join(historyRoot, "pm-bad.jsonl"),
        "{bad json}\n",
      );
      await expect(rebuildHistoryEventIndex(context.pmPath)).rejects.toThrow(
        /invalid JSON/,
      );
      expect(
        (await fs.readdir(path.join(context.pmPath, "runtime"))).some((name) =>
          name.endsWith(".tmp"),
        ),
      ).toBe(false);

      await fs.rm(historyRoot, { recursive: true, force: true });
      await fs.writeFile(historyRoot, "not a directory");
      await expect(rebuildHistoryEventIndex(context.pmPath)).rejects.toThrow();
    });
  });
});
