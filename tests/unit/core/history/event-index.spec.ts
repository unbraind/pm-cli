import { DatabaseSync } from "node:sqlite";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _testOnly,
  appendHistoryEntryWithEventIndex,
  queryHistoryEventIndex,
  queryHistoryEventStreams,
  readLatestSubstantiveHistoryEvents,
  rebuildHistoryEventIndex,
  removeHistoryEventIndexForHistoryPath,
} from "../../../../src/core/history/event-index.js";
import type { HistoryEntry } from "../../../../src/types/index.js";
import { appendHistoryEntry } from "../../../../src/core/history/history.js";
import { acquireLock } from "../../../../src/core/lock/lock.js";
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

async function withZeroLockWait<T>(run: () => Promise<T>): Promise<T> {
  const previousWait = process.env.PM_LOCK_WAIT_MS;
  process.env.PM_LOCK_WAIT_MS = "0";
  try {
    return await run();
  } finally {
    if (previousWait === undefined) delete process.env.PM_LOCK_WAIT_MS;
    else process.env.PM_LOCK_WAIT_MS = previousWait;
  }
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

  it("selects the latest substantive event per stream regardless of input order", () => {
    const events = [
      {
        stream_id: "pm-linear",
        stream_offset: 2,
        entry: historyEntry("2026-07-24T11:00:00.000Z", "agent", "comment_add"),
      },
      {
        stream_id: "pm-linear",
        stream_offset: 3,
        entry: historyEntry("2026-07-24T12:00:00.000Z", "agent", "release"),
      },
      {
        stream_id: "pm-linear",
        stream_offset: 1,
        entry: historyEntry("2026-07-24T10:00:00.000Z", "agent", "create"),
      },
    ];
    const sortSpy = vi.spyOn(events, "sort");
    const selected = _testOnly.collectLatestSubstantiveEvents(
      events,
      new Set(["pm-linear"]),
    );

    expect(sortSpy).not.toHaveBeenCalled();
    expect(selected["pm-linear"]?.stream_offset).toBe(2);
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

  it("uses one generated timestamp for blank authoritative and indexed entries", async () => {
    await withTempPmPath(async (context) => {
      const historyPath = path.join(
        context.pmPath,
        "history",
        "pm-blank-timestamp.jsonl",
      );
      const first = historyEntry("2026-07-24T09:00:00.000Z", "agent", "create");
      await fs.writeFile(historyPath, `${JSON.stringify(first)}\n`);
      await rebuildHistoryEventIndex(context.pmPath);
      await appendHistoryEntry(historyPath, {
        ...historyEntry("2026-07-24T10:00:00.000Z", "agent", "update"),
        ts: " ",
      });

      const persisted = JSON.parse(
        (await fs.readFile(historyPath, "utf8")).trim().split("\n").at(-1) ??
          "null",
      ) as HistoryEntry;
      const indexed = await queryHistoryEventIndex(context.pmPath, {
        ops: ["update"],
        limit: 1,
      });
      expect(persisted.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
      expect(indexed?.events[0]?.entry.ts).toBe(persisted.ts);
      expect(persisted.event_class).toBe("substantive");
      expect(indexed?.events[0]?.entry.event_class).toBe("substantive");
    });
  });

  it("rejects corrupt authoritative timestamps and refuses malformed indexed rows", async () => {
    await withTempPmPath(async (context) => {
      const historyRoot = path.join(context.pmPath, "history");
      const historyPath = path.join(historyRoot, "pm-invalid-ts.jsonl");
      const valid = historyEntry("2026-07-24T09:00:00.000Z", "agent", "create");
      await fs.writeFile(historyPath, `${JSON.stringify(valid)}\n`);
      await rebuildHistoryEventIndex(context.pmPath);
      const database = new DatabaseSync(
        path.join(context.pmPath, "runtime", INDEX_FILENAME),
      );
      database
        .prepare("UPDATE events SET entry_json = ?, ts = ?")
        .run(
          JSON.stringify({ ...valid, ts: "2026-07-24T09:00:00.0001Z" }),
          "2026-07-24T09:00:00.0001Z",
        );
      database.close();
      await expect(
        queryHistoryEventIndex(context.pmPath, { limit: 10 }),
      ).resolves.toBeNull();
      await expect(
        readLatestSubstantiveHistoryEvents(context.pmPath, ["pm-invalid-ts"]),
      ).resolves.toMatchObject({
        "pm-invalid-ts": { entry: { op: "create" } },
      });

      await removeHistoryEventIndexForHistoryPath(historyPath);
      await fs.writeFile(
        historyPath,
        `${JSON.stringify({ ...valid, ts: "not-a-date" })}\n`,
      );
      const latest = await readLatestSubstantiveHistoryEvents(context.pmPath, [
        "pm-invalid-ts",
      ]);
      expect(Object.keys(latest)).toEqual([]);
    });
  });

  it("accepts fractional timestamps whose extra digits are only trailing zeros", async () => {
    await withTempPmPath(async (context) => {
      const historyPath = path.join(
        context.pmPath,
        "history",
        "pm-lossless-fraction.jsonl",
      );
      await fs.writeFile(
        historyPath,
        `${JSON.stringify(
          historyEntry("2026-07-24T09:00:00.1230Z", "agent", "comment_add"),
        )}\n`,
      );

      await expect(rebuildHistoryEventIndex(context.pmPath)).resolves.toBe(
        true,
      );
      await expect(
        queryHistoryEventIndex(context.pmPath, { limit: 10 }),
      ).resolves.toMatchObject({
        events: [{ entry: { ts: "2026-07-24T09:00:00.123Z" } }],
      });
    });
  });

  it("canonicalizes equivalent RFC3339 offsets for index ordering and filters", async () => {
    await withTempPmPath(async (context) => {
      const historyPath = path.join(
        context.pmPath,
        "history",
        "pm-offset-order.jsonl",
      );
      await fs.writeFile(
        historyPath,
        [
          historyEntry("2026-07-24T10:30:00.000+02:00", "agent", "comment_add"),
          historyEntry("2026-07-24T09:00:00.000Z", "agent", "close"),
        ]
          .map((entry) => JSON.stringify(entry))
          .join("\n"),
      );

      await expect(rebuildHistoryEventIndex(context.pmPath)).resolves.toBe(
        true,
      );
      await expect(
        queryHistoryEventIndex(context.pmPath, {
          since_ts: "2026-07-24T10:45:00.000+02:00",
          limit: 10,
        }),
      ).resolves.toMatchObject({
        events: [{ entry: { ts: "2026-07-24T09:00:00.000Z", op: "close" } }],
      });
      await expect(
        queryHistoryEventIndex(context.pmPath, {
          since_ts: "not-a-date",
          limit: 10,
        }),
      ).resolves.toMatchObject({ events: [] });
      await expect(
        queryHistoryEventStreams(context.pmPath, { limit: 10 }),
      ).resolves.toMatchObject({
        events: [
          { entry: { ts: "2026-07-24T08:30:00.000Z" } },
          { entry: { ts: "2026-07-24T09:00:00.000Z" } },
        ],
      });
      await expect(
        readLatestSubstantiveHistoryEvents(context.pmPath, ["pm-offset-order"]),
      ).resolves.toMatchObject({
        "pm-offset-order": { entry: { ts: "2026-07-24T09:00:00.000Z" } },
      });
      expect(await fs.readFile(historyPath, "utf8")).toContain(
        "2026-07-24T10:30:00.000+02:00",
      );
    });
  });

  it("recovers abandoned pending invalidations while refusing an active invalidator", async () => {
    await withTempPmPath(async (context) => {
      const invalidationRoot = path.join(
        context.pmPath,
        "runtime",
        "history-event-index-invalidations",
      );
      await fs.mkdir(invalidationRoot, { recursive: true });
      const initialPending = path.join(invalidationRoot, "initial.pending");
      await fs.writeFile(initialPending, "pending\n");
      await expect(rebuildHistoryEventIndex(context.pmPath)).resolves.toBe(
        true,
      );
      await expect(fs.access(initialPending)).rejects.toThrow();

      const releaseInvalidation = await acquireLock(
        context.pmPath,
        "history-event-index-invalidation",
        300,
        "active-invalidator",
        false,
        false,
        0,
      );
      try {
        await withZeroLockWait(async () => {
          await expect(rebuildHistoryEventIndex(context.pmPath)).resolves.toBe(
            false,
          );
        });
      } finally {
        await releaseInvalidation();
      }

      const originalReaddir = fs.readdir.bind(fs);
      let committedReads = 0;
      const racedCommitted = path.join(invalidationRoot, "raced.committed");
      const committedReaddirSpy = vi
        .spyOn(fs, "readdir")
        .mockImplementation(async (...args) => {
          if (String(args[0]) === invalidationRoot) {
            committedReads += 1;
            if (committedReads === 2) {
              await fs.writeFile(racedCommitted, "committed\n");
            }
          }
          return originalReaddir(...args);
        });
      try {
        await expect(rebuildHistoryEventIndex(context.pmPath)).resolves.toBe(
          false,
        );
      } finally {
        committedReaddirSpy.mockRestore();
      }
      await expect(
        fs.readdir(path.join(context.pmPath, "runtime")),
      ).resolves.not.toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^history-event-index\.sqlite\..+\.tmp$/),
        ]),
      );
      await fs.rm(racedCommitted);

      let invalidationReads = 0;
      const racedPending = path.join(invalidationRoot, "raced.pending");
      const readdirSpy = vi
        .spyOn(fs, "readdir")
        .mockImplementation(async (...args) => {
          if (String(args[0]) === invalidationRoot) {
            invalidationReads += 1;
            if (invalidationReads === 2) {
              await fs.writeFile(racedPending, "pending\n");
            }
          }
          return originalReaddir(...args);
        });
      try {
        await expect(rebuildHistoryEventIndex(context.pmPath)).resolves.toBe(
          true,
        );
      } finally {
        readdirSpy.mockRestore();
      }
      await expect(fs.access(racedPending)).rejects.toThrow();
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
        queryHistoryEventIndex(context.pmPath, {
          stream_ids: ["../unsafe"],
          limit: 10,
        }),
      ).resolves.toBeNull();
      const renameSpy = vi.spyOn(fs, "rename");
      let latest: Awaited<
        ReturnType<typeof readLatestSubstantiveHistoryEvents>
      >;
      try {
        latest = await readLatestSubstantiveHistoryEvents(context.pmPath, [
          "pm-recency",
          "pm-missing",
          "../unsafe",
          "",
        ]);
        expect(renameSpy).not.toHaveBeenCalled();
      } finally {
        renameSpy.mockRestore();
      }
      expect(latest).toMatchObject({
        "pm-recency": {
          stream_offset: 0,
          entry: { op: "create", event_class: "substantive" },
        },
      });
      expect(Object.keys(latest)).toEqual(["pm-recency"]);

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

  it("falls back to authoritative recency after one contended index attempt", async () => {
    await withTempPmPath(async (context) => {
      const historyPath = path.join(
        context.pmPath,
        "history",
        "pm-read-contention.jsonl",
      );
      const entry = historyEntry("2026-07-24T09:00:00.000Z", "agent", "create");
      await fs.writeFile(historyPath, `${JSON.stringify(entry)}\n`);
      await rebuildHistoryEventIndex(context.pmPath);
      const release = await acquireLock(
        context.pmPath,
        "history-event-index",
        300,
        "contending-index-reader",
        false,
        false,
        0,
      );
      const lockPath = path.join(
        context.pmPath,
        "locks",
        "history-event-index.lock",
      );
      const originalOpen = fs.open.bind(fs);
      let lockAttempts = 0;
      const openSpy = vi.spyOn(fs, "open").mockImplementation((...args) => {
        if (String(args[0]) === lockPath && args[1] === "wx") lockAttempts += 1;
        return originalOpen(...args);
      });
      try {
        await withZeroLockWait(async () => {
          await expect(
            readLatestSubstantiveHistoryEvents(context.pmPath, [
              "pm-read-contention",
            ]),
          ).resolves.toMatchObject({
            "pm-read-contention": {
              stream_offset: 0,
              entry: { op: "create" },
            },
          });
          expect(lockAttempts).toBe(1);
        });
      } finally {
        openSpy.mockRestore();
        await release();
      }
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

      await expect(
        queryHistoryEventIndex(context.pmPath, {
          stream_ids: ["pm-stale"],
          limit: 10,
        }),
      ).resolves.toBeNull();
      await expect(
        queryHistoryEventIndex(context.pmPath, { limit: 10 }),
      ).resolves.toBeNull();
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

  it("serializes rebuild replacement with concurrent compliant appends", async () => {
    await withTempPmPath(async (context) => {
      const historyPath = path.join(
        context.pmPath,
        "history",
        "pm-rebuild-concurrent.jsonl",
      );
      const first = historyEntry("2026-07-24T09:00:00.000Z", "agent", "create");
      const second = historyEntry(
        "2026-07-24T10:00:00.000Z",
        "agent",
        "update",
      );
      await fs.writeFile(historyPath, `${JSON.stringify(first)}\n`);
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
            concurrentAppend = appendHistoryEntry(historyPath, second);
          }
          return stats;
        });
      try {
        await rebuildHistoryEventIndex(context.pmPath);
        await concurrentAppend;
      } finally {
        statSpy.mockRestore();
      }

      await expect(
        queryHistoryEventIndex(context.pmPath, {
          stream_ids: ["pm-rebuild-concurrent"],
          limit: 10,
        }),
      ).resolves.toMatchObject({
        events: [
          { stream_offset: 0, entry: { op: "create" } },
          { stream_offset: 1, entry: { op: "update" } },
        ],
      });
    });
  });

  it("serializes indexed validation and reads before concurrent compliant appends", async () => {
    await withTempPmPath(async (context) => {
      const historyPath = path.join(
        context.pmPath,
        "history",
        "pm-read-concurrent.jsonl",
      );
      const first = historyEntry("2026-07-24T09:00:00.000Z", "agent", "create");
      const second = historyEntry(
        "2026-07-24T10:00:00.000Z",
        "agent",
        "update",
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
            concurrentAppend = appendHistoryEntry(historyPath, second);
          }
          return stats;
        });
      let beforeAppend;
      try {
        beforeAppend = await queryHistoryEventIndex(context.pmPath, {
          stream_ids: ["pm-read-concurrent"],
          limit: 10,
        });
        await concurrentAppend;
      } finally {
        statSpy.mockRestore();
      }

      expect(beforeAppend).toMatchObject({
        events: [{ stream_offset: 0, entry: { op: "create" } }],
      });
      await expect(
        queryHistoryEventIndex(context.pmPath, {
          stream_ids: ["pm-read-concurrent"],
          limit: 10,
        }),
      ).resolves.toMatchObject({
        events: [
          { stream_offset: 0, entry: { op: "create" } },
          { stream_offset: 1, entry: { op: "update" } },
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
      const historyRoot = path.join(context.pmPath, "history");
      await rebuildHistoryEventIndex(context.pmPath);
      await fs.symlink(
        "pm-loop.jsonl",
        path.join(historyRoot, "pm-loop.jsonl"),
      );
      await expect(
        readLatestSubstantiveHistoryEvents(context.pmPath, ["pm-loop"]),
      ).rejects.toMatchObject({ code: "ELOOP" });

      await fs.rm(historyRoot, { recursive: true, force: true });
      await fs.symlink("history", historyRoot);
      await expect(
        queryHistoryEventIndex(context.pmPath, { limit: 10 }),
      ).resolves.toBeNull();
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

  it("does not duplicate a durable append when index invalidation is contended", async () => {
    await withTempPmPath(async (context) => {
      const historyPath = path.join(
        context.pmPath,
        "history",
        "pm-invalidation-contention.jsonl",
      );
      const first = historyEntry("2026-07-24T09:00:00.000Z", "agent", "create");
      const second = historyEntry(
        "2026-07-24T10:00:00.000Z",
        "agent",
        "update",
      );
      await fs.writeFile(historyPath, `${JSON.stringify(first)}\n`);
      await rebuildHistoryEventIndex(context.pmPath);
      const release = await acquireLock(
        context.pmPath,
        "history-event-index-invalidation",
        300,
        "contending-invalidation",
        false,
        false,
        0,
      );
      const originalStat = fs.stat.bind(fs);
      const statSpy = vi
        .spyOn(fs, "stat")
        .mockImplementation(async (...args) => {
          if (String(args[0]) === historyPath) throw new Error("stat failed");
          return originalStat(...args);
        });
      try {
        await withZeroLockWait(async () => {
          await expect(
            appendHistoryEntry(historyPath, second),
          ).resolves.toBeUndefined();
        });
      } finally {
        statSpy.mockRestore();
        await release();
      }
      expect(
        (await fs.readFile(historyPath, "utf8")).trim().split("\n"),
      ).toHaveLength(2);
      await expect(
        fs.access(path.join(context.pmPath, "runtime", INDEX_FILENAME)),
      ).rejects.toThrow();
    });
  });

  it("preserves a durable append when stale projection removal fails", async () => {
    await withTempPmPath(async (context) => {
      const historyPath = path.join(
        context.pmPath,
        "history",
        "pm-invalidation-fail.jsonl",
      );
      const indexPath = path.join(context.pmPath, "runtime", INDEX_FILENAME);
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
      const originalRm = fs.rm.bind(fs);
      const rmSpy = vi.spyOn(fs, "rm").mockImplementation(async (...args) => {
        if (String(args[0]) === indexPath) {
          throw Object.assign(new Error("remove denied"), { code: "EACCES" });
        }
        return originalRm(...args);
      });
      try {
        await expect(
          appendHistoryEntry(historyPath, second),
        ).resolves.toBeUndefined();
        expect(rmSpy).toHaveBeenCalledWith(indexPath, { force: true });
      } finally {
        statSpy.mockRestore();
        rmSpy.mockRestore();
      }
      expect(
        (await fs.readFile(historyPath, "utf8")).trim().split("\n"),
      ).toHaveLength(2);
      await expect(fs.access(indexPath)).resolves.toBeUndefined();
      await expect(
        queryHistoryEventIndex(context.pmPath, { limit: 10 }),
      ).resolves.toBeNull();
      await expect(
        readLatestSubstantiveHistoryEvents(context.pmPath, [
          "pm-invalidation-fail",
        ]),
      ).resolves.toMatchObject({
        "pm-invalidation-fail": { entry: { op: "update" } },
      });
      await expect(rebuildHistoryEventIndex(context.pmPath)).resolves.toBe(
        true,
      );
      await expect(
        queryHistoryEventIndex(context.pmPath, { limit: 10 }),
      ).resolves.toMatchObject({
        events: [
          { stream_offset: 0, entry: { op: "create" } },
          { stream_offset: 1, entry: { op: "update" } },
        ],
      });
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

  it("preserves authoritative history and invalidates the index when its lock is contended", async () => {
    await withTempPmPath(async (context) => {
      const historyPath = path.join(
        context.pmPath,
        "history",
        "pm-lock-contention.jsonl",
      );
      const first = historyEntry("2026-07-24T09:00:00.000Z", "agent", "create");
      const second = historyEntry(
        "2026-07-24T10:00:00.000Z",
        "agent",
        "update",
      );
      await fs.writeFile(historyPath, `${JSON.stringify(first)}\n`);
      await rebuildHistoryEventIndex(context.pmPath);
      const release = await acquireLock(
        context.pmPath,
        "history-event-index",
        300,
        "contending-index-operation",
        false,
        false,
        0,
      );
      try {
        await withZeroLockWait(async () => {
          await expect(
            appendHistoryEntry(historyPath, second),
          ).resolves.toBeUndefined();
          await expect(
            fs.access(path.join(context.pmPath, "runtime", INDEX_FILENAME)),
          ).rejects.toThrow();
        });
      } finally {
        await release();
      }
      expect(
        (await fs.readFile(historyPath, "utf8")).trim().split("\n"),
      ).toHaveLength(2);
      await expect(
        queryHistoryEventIndex(context.pmPath, { limit: 10 }),
      ).resolves.toBeNull();
    });
  });

  it("removes its pending marker when an unlocked fallback append fails", async () => {
    await withTempPmPath(async (context) => {
      const historyPath = path.join(
        context.pmPath,
        "history",
        "pm-lock-contention-failure.jsonl",
      );
      const release = await acquireLock(
        context.pmPath,
        "history-event-index",
        300,
        "contending-index-operation",
        false,
        false,
        0,
      );
      try {
        await withZeroLockWait(async () => {
          await expect(
            appendHistoryEntryWithEventIndex(
              historyPath,
              historyEntry("2026-07-24T10:00:00.000Z", "agent", "update"),
              async () => {
                throw new Error("append failed");
              },
            ),
          ).rejects.toThrow("append failed");
        });
      } finally {
        await release();
      }
      const invalidationRoot = path.join(
        context.pmPath,
        "runtime",
        "history-event-index-invalidations",
      );
      await expect(fs.readdir(invalidationRoot)).resolves.toEqual([]);
    });
  });

  it("cannot publish a size-certified incomplete index after an unlocked fallback append", async () => {
    await withTempPmPath(async (context) => {
      const historyPath = path.join(
        context.pmPath,
        "history",
        "pm-lock-race.jsonl",
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
      let signalFirstAppend!: () => void;
      let allowFirstProjection!: () => void;
      const firstAppended = new Promise<void>((resolve) => {
        signalFirstAppend = resolve;
      });
      const projectionMayContinue = new Promise<void>((resolve) => {
        allowFirstProjection = resolve;
      });
      const indexedAppend = appendHistoryEntryWithEventIndex(
        historyPath,
        second,
        async () => {
          await fs.appendFile(historyPath, `${JSON.stringify(second)}\n`);
          signalFirstAppend();
          await projectionMayContinue;
        },
      );
      await firstAppended;
      await withZeroLockWait(async () => {
        await appendHistoryEntryWithEventIndex(historyPath, third, async () => {
          await fs.appendFile(historyPath, `${JSON.stringify(third)}\n`);
        });
      });
      allowFirstProjection();
      await indexedAppend;

      expect(
        (await fs.readFile(historyPath, "utf8")).trim().split("\n"),
      ).toHaveLength(3);
      await expect(
        fs.access(path.join(context.pmPath, "runtime", INDEX_FILENAME)),
      ).rejects.toThrow();
      await expect(
        queryHistoryEventStreams(context.pmPath, { limit: 10 }),
      ).resolves.toMatchObject({
        events: [
          { stream_offset: 0, entry: { op: "create" } },
          { stream_offset: 1, entry: { op: "update" } },
          { stream_offset: 2, entry: { op: "comment_add" } },
        ],
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
