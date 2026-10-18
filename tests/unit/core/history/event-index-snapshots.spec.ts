/** Ensures optional index readers cannot hold authoritative writers behind filesystem validation. */
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
} from "../../../../src/core/history/event-index.js";
import { appendHistoryEntry } from "../../../../src/core/history/history.js";
import { acquireLock } from "../../../../src/core/lock/lock.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";

const first = {
  ts: "2026-10-17T09:00:00.000Z",
  author: "reader",
  op: "create",
  patch: [],
  before_hash: "before",
  after_hash: "after",
};
const second = { ...first, ts: "2026-10-17T10:00:00.000Z", op: "comment_add" };
const third = { ...first, ts: "2026-10-17T11:00:00.000Z", op: "update" };
let restore: () => void;
beforeEach(() => {
  restore = _testOnly.setDatabaseSync(DatabaseSync);
});
afterEach(() => {
  restore();
  vi.restoreAllMocks();
});

describe("history index read snapshots", () => {
  it("indexes a first append when its authoritative stream does not exist yet", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const historyPath = path.join(pmPath, "history", "pm-first.jsonl");
      await rebuildHistoryEventIndex(pmPath);
      await appendHistoryEntryWithEventIndex(historyPath, first, () =>
        fs.appendFile(historyPath, `${JSON.stringify(first)}\n`),
      );
      expect(await queryHistoryEventIndex(pmPath, { limit: 10 })).toMatchObject(
        {
          events: [{ stream_id: "pm-first", stream_offset: 0, entry: first }],
        },
      );
    });
  });

  it("rolls back projection work and preserves an authoritative callback failure", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const historyPath = path.join(pmPath, "history", "pm-snapshot.jsonl");
      await appendHistoryEntry(historyPath, first);
      await rebuildHistoryEventIndex(pmPath);
      const before = await fs.readFile(historyPath, "utf8");
      const denied = Object.assign(new Error("append denied"), {
        code: "EACCES",
      });
      await expect(
        appendHistoryEntryWithEventIndex(historyPath, second, async () => {
          throw denied;
        }),
      ).rejects.toBe(denied);
      expect(await fs.readFile(historyPath, "utf8")).toBe(before);
      expect(await queryHistoryEventIndex(pmPath, { limit: 10 })).toMatchObject(
        {
          events: [{ entry: first }],
        },
      );
    });
  });

  it("preserves authority when optional incremental-base stat verification fails", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const historyPath = path.join(pmPath, "history", "pm-snapshot.jsonl");
      await appendHistoryEntry(historyPath, first);
      await rebuildHistoryEventIndex(pmPath);
      const originalStat = fs.stat.bind(fs);
      let denied = false;
      const statSpy = vi
        .spyOn(fs, "stat")
        .mockImplementation(async (...args) => {
          if (String(args[0]) === historyPath && !denied) {
            denied = true;
            throw Object.assign(new Error("cache base stat denied"), {
              code: "EACCES",
            });
          }
          return originalStat(...args);
        });
      try {
        await expect(
          appendHistoryEntry(historyPath, second),
        ).resolves.toBeUndefined();
      } finally {
        statSpy.mockRestore();
      }
      expect(denied).toBe(true);
      expect(await queryHistoryEventIndex(pmPath, { limit: 10 })).toBeNull();
      expect(
        await queryHistoryEventStreams(pmPath, { limit: 10 }),
      ).toMatchObject({
        events: [{ entry: first }, { entry: second }],
      });
    });
  });

  it.each(["invalid timestamp", "future timestamp"])(
    "does not let a %s suppress repair of a missing projection",
    async (receipt) => {
      const { readHistoryEventIndexPage } =
        await import("../../../../src/core/history/event-index.js");
      await withTempPmPath(async ({ pmPath }) => {
        const runtime = path.join(pmPath, "runtime");
        await fs.mkdir(runtime, { recursive: true });
        await fs.writeFile(
          path.join(runtime, "history-event-index-repair-deferred"),
          receipt === "invalid timestamp"
            ? "unfinished"
            : `${Date.now() + 60_000}`,
        );
        expect(await readHistoryEventIndexPage(pmPath, { limit: 10 })).toEqual({
          result: null,
          repair_needed: true,
        });
      });
    },
  );

  it("rebuilds a multi-stream workspace with complete facts and size receipts", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const ids = Array.from(
        { length: 501 },
        (_, index) => `pm-stream-${index}`,
      );
      await Promise.all(
        ids.map((id) =>
          fs.writeFile(
            path.join(pmPath, "history", `${id}.jsonl`),
            `${JSON.stringify(first)}\n`,
          ),
        ),
      );
      expect(await rebuildHistoryEventIndex(pmPath)).toBe(true);
      const page = await queryHistoryEventIndex(pmPath, { limit: 1000 });
      expect(page?.has_more).toBe(false);
      expect(page?.events).toHaveLength(ids.length);
      expect(new Set(page?.events.map((event) => event.stream_id))).toEqual(
        new Set(ids),
      );
      expect(page?.events.every((event) => event.stream_offset === 0)).toBe(
        true,
      );
    });
  });

  it("refuses replacement if native contention returns during a recovery scan", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const historyPath = path.join(pmPath, "history", "pm-snapshot.jsonl");
      const indexPath = path.join(
        pmPath,
        "runtime",
        "history-event-index.sqlite",
      );
      await appendHistoryEntry(historyPath, first);
      await rebuildHistoryEventIndex(pmPath);
      const initialReader = new DatabaseSync(indexPath);
      initialReader.exec("BEGIN");
      initialReader.prepare("SELECT COUNT(*) FROM events").get();
      try {
        await appendHistoryEntry(historyPath, second);
      } finally {
        initialReader.close();
      }
      let returningContender: DatabaseSync | undefined;
      const originalStat = fs.stat.bind(fs);
      const statSpy = vi
        .spyOn(fs, "stat")
        .mockImplementation(async (...args) => {
          const stats = await originalStat(...args);
          if (String(args[0]) === historyPath && !returningContender) {
            returningContender = new DatabaseSync(indexPath);
            returningContender.exec("BEGIN EXCLUSIVE");
          }
          return stats;
        });
      try {
        expect(await rebuildHistoryEventIndex(pmPath)).toBe(false);
        expect(returningContender).toBeDefined();
      } finally {
        statSpy.mockRestore();
        returningContender?.close();
      }
      expect(await rebuildHistoryEventIndex(pmPath)).toBe(true);
      expect(await queryHistoryEventIndex(pmPath, { limit: 10 })).toMatchObject(
        {
          events: [{ entry: first }, { entry: second }],
        },
      );
    });
  });

  it.each(["before", "after"])(
    "classifies an indexed append paused %s its file write as active",
    async (phase) => {
      const { readHistoryEventIndexPage } =
        await import("../../../../src/core/history/event-index.js");
      await withTempPmPath(async ({ pmPath }) => {
        const historyPath = path.join(pmPath, "history", "pm-snapshot.jsonl");
        await appendHistoryEntry(historyPath, first);
        await rebuildHistoryEventIndex(pmPath);
        const entered = Promise.withResolvers<void>();
        const resume = Promise.withResolvers<void>();
        const originalStat = fs.stat.bind(fs);
        const initialSize = (await originalStat(historyPath)).size;
        let paused = false;
        vi.spyOn(fs, "stat").mockImplementation(async (...args) => {
          const result = await originalStat(...args);
          if (
            String(args[0]) === historyPath &&
            !paused &&
            (phase === "before"
              ? result.size === initialSize
              : result.size > initialSize)
          ) {
            paused = true;
            entered.resolve();
            await resume.promise;
          }
          return result;
        });
        const writing = appendHistoryEntry(historyPath, second);
        await entered.promise;
        try {
          expect(
            (await queryHistoryEventStreams(pmPath, { limit: 10 })).events,
          ).toHaveLength(phase === "before" ? 1 : 2);
          expect(
            await readHistoryEventIndexPage(pmPath, { limit: 10 }),
          ).toEqual({
            result: null,
            repair_needed: false,
          });
        } finally {
          resume.resolve();
          await writing;
        }
        expect(
          await queryHistoryEventIndex(pmPath, { limit: 10 }),
        ).toMatchObject({ events: [{ entry: first }, { entry: second }] });
      });
    },
  );

  it("allows authoritative progress while a full repair scan is suspended", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const historyPath = path.join(pmPath, "history", "pm-snapshot.jsonl");
      const newPath = path.join(pmPath, "history", "pm-new.jsonl");
      await appendHistoryEntry(historyPath, first);
      await rebuildHistoryEventIndex(pmPath);
      await fs.rm(path.join(pmPath, "runtime", "history-event-index.sqlite"));
      await appendHistoryEntry(newPath, second);
      const entered = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      const originalStat = fs.stat.bind(fs);
      let paused = false;
      vi.spyOn(fs, "stat").mockImplementation(async (...args) => {
        const result = await originalStat(...args);
        if (String(args[0]) === newPath && !paused) {
          paused = true;
          entered.resolve();
          await resume.promise;
        }
        return result;
      });
      const previousWait = process.env.PM_LOCK_WAIT_MS;
      process.env.PM_LOCK_WAIT_MS = "30000";
      const rebuilding = rebuildHistoryEventIndex(pmPath);
      let writing: Promise<void> | undefined;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          entered.promise,
          rebuilding.then(() => {
            throw new Error(
              "repair completed without reaching the paused scan",
            );
          }),
        ]);
        writing = appendHistoryEntry(historyPath, third);
        await Promise.race([
          writing,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error("repair blocked authoritative append")),
              1500,
            );
          }),
        ]);
      } finally {
        clearTimeout(timeout);
        resume.resolve();
        await Promise.allSettled([rebuilding, ...(writing ? [writing] : [])]);
        if (previousWait === undefined) delete process.env.PM_LOCK_WAIT_MS;
        else process.env.PM_LOCK_WAIT_MS = previousWait;
      }
      expect(await rebuilding).toBe(false);
      const { readHistoryEventIndexPage } =
        await import("../../../../src/core/history/event-index.js");
      expect(await readHistoryEventIndexPage(pmPath, { limit: 10 })).toEqual({
        result: null,
        repair_needed: false,
      });
      expect(
        await readLatestSubstantiveHistoryEvents(pmPath, ["pm-snapshot"]),
      ).toMatchObject({ "pm-snapshot": { entry: third } });
      expect(await queryHistoryEventIndex(pmPath, { limit: 10 })).toBeNull();
      const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 6000);
      try {
        expect(await readHistoryEventIndexPage(pmPath, { limit: 10 })).toEqual({
          result: null,
          repair_needed: true,
        });
        await readLatestSubstantiveHistoryEvents(pmPath, ["pm-snapshot"]);
      } finally {
        clock.mockRestore();
      }
      expect(await queryHistoryEventIndex(pmPath, { limit: 10 })).toMatchObject(
        { events: [{ entry: first }, { entry: second }, { entry: third }] },
      );
    });
  });

  it("recovers a size-certified incomplete legacy projection on upgrade", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const historyPath = path.join(pmPath, "history", "pm-snapshot.jsonl");
      await appendHistoryEntry(historyPath, first);
      await appendHistoryEntry(historyPath, second);
      await appendHistoryEntry(historyPath, third);
      await rebuildHistoryEventIndex(pmPath);
      const legacy = new DatabaseSync(
        path.join(pmPath, "runtime", "history-event-index.sqlite"),
      );
      legacy.exec("UPDATE metadata SET value = '5' WHERE key = 'version'");
      legacy.exec(
        "DELETE FROM events WHERE stream_id = 'pm-snapshot' AND stream_offset = 1",
      );
      legacy.close();
      expect(await queryHistoryEventIndex(pmPath, { limit: 10 })).toBeNull();
      await readLatestSubstantiveHistoryEvents(pmPath, ["pm-snapshot"]);
      expect(await queryHistoryEventIndex(pmPath, { limit: 10 })).toMatchObject(
        {
          events: [{ entry: first }, { entry: second }, { entry: third }],
        },
      );
    });
  });

  it.each(["SQLite-less writer", "merged stream"])(
    "never certifies an omitted append from a %s",
    async (producer) => {
      await withTempPmPath(async ({ pmPath }) => {
        const historyPath = path.join(pmPath, "history", "pm-snapshot.jsonl");
        await appendHistoryEntry(historyPath, first);
        await rebuildHistoryEventIndex(pmPath);
        if (producer === "merged stream") {
          await fs.appendFile(historyPath, `${JSON.stringify(second)}\n`);
        } else {
          const restoreNoSqlite = _testOnly.setDatabaseSync(null);
          try {
            await appendHistoryEntry(historyPath, second);
          } finally {
            restoreNoSqlite();
          }
        }
        await appendHistoryEntry(historyPath, third);
        const projection = await queryHistoryEventIndex(pmPath, { limit: 10 });
        const authority = await queryHistoryEventStreams(pmPath, { limit: 10 });
        expect(projection?.events ?? authority.events).toMatchObject([
          { entry: first },
          { entry: second },
          { entry: third },
        ]);
        expect(await rebuildHistoryEventIndex(pmPath)).toBe(true);
        expect(
          await queryHistoryEventIndex(pmPath, { limit: 10 }),
        ).toMatchObject({
          events: [{ entry: first }, { entry: second }, { entry: third }],
        });
      });
    },
  );

  it.each([
    ["reader", "current"],
    ["writer", "current"],
    ["exclusive writer", "current"],
    ["reader", "legacy"],
    ["writer", "legacy"],
    ["exclusive writer", "legacy"],
  ] as const)(
    "preserves authoritative append with a native SQLite %s on a %s projection",
    async (mode, generation) => {
      const { readHistoryEventIndexPage } =
        await import("../../../../src/core/history/event-index.js");
      await withTempPmPath(async ({ pmPath }) => {
        const historyPath = path.join(pmPath, "history", "pm-snapshot.jsonl");
        await appendHistoryEntry(historyPath, first);
        await rebuildHistoryEventIndex(pmPath);
        const indexPath = path.join(
          pmPath,
          "runtime",
          "history-event-index.sqlite",
        );
        if (generation === "legacy") {
          const legacy = new DatabaseSync(indexPath);
          try {
            legacy.exec(
              "UPDATE metadata SET value = '5' WHERE key = 'version'",
            );
          } finally {
            legacy.close();
          }
        }
        const contender = new DatabaseSync(indexPath);
        contender.exec(
          {
            reader: "BEGIN",
            writer: "BEGIN IMMEDIATE",
            "exclusive writer": "BEGIN EXCLUSIVE",
          }[mode],
        );
        contender.prepare("SELECT COUNT(*) FROM events").get();
        try {
          const started = Date.now();
          await appendHistoryEntry(historyPath, second);
          expect(Date.now() - started).toBeLessThan(1500);
          expect(
            (await fs.readFile(historyPath, "utf8"))
              .trim()
              .split("\n")
              .map((line) => JSON.parse(line)),
          ).toMatchObject([first, second]);
          expect(
            await queryHistoryEventIndex(pmPath, { limit: 10 }),
          ).toBeNull();
          expect(
            await readHistoryEventIndexPage(pmPath, { limit: 10 }),
          ).toEqual({ result: null, repair_needed: false });
          expect(
            await rebuildHistoryEventIndex(pmPath, { lockWaitMs: 0 }),
          ).toBe(false);
        } finally {
          contender.close();
        }
        expect(await rebuildHistoryEventIndex(pmPath)).toBe(true);
        expect(
          await queryHistoryEventIndex(pmPath, { limit: 10 }),
        ).toMatchObject({
          events: [{ entry: first }, { entry: second }],
        });
      });
    },
  );

  it("classifies a native SQLite write transaction as transient instead of rebuilding", async () => {
    const { readHistoryEventIndexPage } =
      await import("../../../../src/core/history/event-index.js");
    await withTempPmPath(async ({ pmPath }) => {
      await appendHistoryEntry(
        path.join(pmPath, "history", "pm-snapshot.jsonl"),
        first,
      );
      await rebuildHistoryEventIndex(pmPath);
      const writer = new DatabaseSync(
        path.join(pmPath, "runtime", "history-event-index.sqlite"),
      );
      writer.exec("BEGIN EXCLUSIVE");
      try {
        expect(await readHistoryEventIndexPage(pmPath, { limit: 10 })).toEqual({
          result: null,
          repair_needed: false,
        });
      } finally {
        writer.close();
      }
      expect(await queryHistoryEventIndex(pmPath, { limit: 10 })).toMatchObject(
        { events: [{ entry: first }] },
      );
    });
  });

  it("returns empty recency for an empty or entirely unsafe requested set", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      expect(await readLatestSubstantiveHistoryEvents(pmPath, [])).toEqual({});
      expect(
        await readLatestSubstantiveHistoryEvents(pmPath, ["", "../unsafe"]),
      ).toEqual({});
    });
  });

  it("requests repair for a settled committed invalidation without removing evidence on read", async () => {
    const { readHistoryEventIndexPage } =
      await import("../../../../src/core/history/event-index.js");
    await withTempPmPath(async ({ pmPath }) => {
      await appendHistoryEntry(
        path.join(pmPath, "history", "pm-snapshot.jsonl"),
        first,
      );
      await rebuildHistoryEventIndex(pmPath);
      const markers = path.join(
        pmPath,
        "runtime",
        "history-event-index-invalidations",
      );
      await fs.mkdir(markers, { recursive: true });
      const marker = path.join(markers, "settled.committed");
      await fs.writeFile(marker, "retain\n");
      expect(await readHistoryEventIndexPage(pmPath, { limit: 10 })).toEqual({
        result: null,
        repair_needed: true,
      });
      expect(await fs.readFile(marker, "utf8")).toBe("retain\n");
      expect(await rebuildHistoryEventIndex(pmPath)).toBe(true);
      expect(await fs.readdir(markers)).toEqual([]);
      expect(await queryHistoryEventIndex(pmPath, { limit: 10 })).toMatchObject(
        { events: [{ entry: first }] },
      );
    });
  });

  it("preserves permission failures from explicit repair and refuses the optional projection", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const historyPath = path.join(pmPath, "history", "pm-snapshot.jsonl");
      await appendHistoryEntry(historyPath, first);
      await rebuildHistoryEventIndex(pmPath);
      const before = await fs.readFile(historyPath, "utf8");
      const originalReaddir = fs.readdir.bind(fs);
      const denied = Object.assign(new Error("invalidation directory denied"), {
        code: "EACCES",
      });
      vi.spyOn(fs, "readdir").mockImplementation(async (...args) => {
        if (
          String(args[0]) ===
          path.join(pmPath, "runtime", "history-event-index-invalidations")
        )
          throw denied;
        return originalReaddir(...args);
      });
      expect(await queryHistoryEventIndex(pmPath, { limit: 10 })).toBeNull();
      await expect(rebuildHistoryEventIndex(pmPath)).rejects.toBe(denied);
      expect(await fs.readFile(historyPath, "utf8")).toBe(before);
    });
  });
  it("reads a settled snapshot without competing for the writer lock", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      await appendHistoryEntry(
        path.join(pmPath, "history", "pm-snapshot.jsonl"),
        first,
      );
      await rebuildHistoryEventIndex(pmPath);
      const release = await acquireLock(
        pmPath,
        "history-event-index",
        300,
        "writer",
        false,
        false,
        0,
      );
      const previous = process.env.PM_LOCK_WAIT_MS;
      process.env.PM_LOCK_WAIT_MS = "0";
      try {
        expect(
          await queryHistoryEventIndex(pmPath, { limit: 10 }),
        ).toMatchObject({ events: [{ entry: first }] });
        expect(
          await readLatestSubstantiveHistoryEvents(pmPath, ["pm-snapshot"]),
        ).toMatchObject({ "pm-snapshot": { entry: first } });
      } finally {
        if (previous === undefined) delete process.env.PM_LOCK_WAIT_MS;
        else process.env.PM_LOCK_WAIT_MS = previous;
        await release();
      }
    });
  });

  it("does not mistake an expired append lease for ongoing projection work", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      await appendHistoryEntry(
        path.join(pmPath, "history", "pm-snapshot.jsonl"),
        first,
      );
      await rebuildHistoryEventIndex(pmPath);
      const release = await acquireLock(
        pmPath,
        "history-event-index",
        300,
        `history-event-index:append:${process.pid}`,
        false,
        false,
        0,
      );
      const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 301_000);
      try {
        expect(
          await queryHistoryEventIndex(pmPath, { limit: 10 }),
        ).toMatchObject({
          events: [{ entry: first }],
        });
      } finally {
        now.mockRestore();
        await release();
      }
    });
  });

  it("allows an append while a reader's filesystem validation is suspended", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const historyPath = path.join(pmPath, "history", "pm-snapshot.jsonl");
      await appendHistoryEntry(historyPath, first);
      await rebuildHistoryEventIndex(pmPath);
      const entered = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      const originalStat = fs.stat.bind(fs);
      let paused = false;
      vi.spyOn(fs, "stat").mockImplementation(async (...args) => {
        const stats = await originalStat(...args);
        if (String(args[0]) === historyPath && !paused) {
          paused = true;
          entered.resolve();
          await resume.promise;
        }
        return stats;
      });
      const reading = queryHistoryEventIndex(pmPath, { limit: 10 });
      await entered.promise;
      const writing = appendHistoryEntry(historyPath, second);
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          writing,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error("reader blocked authoritative append")),
              1500,
            );
          }),
        ]);
      } finally {
        clearTimeout(timeout);
        resume.resolve();
        await writing;
        await reading;
      }
      expect(await reading).toBeNull();
      expect(await queryHistoryEventIndex(pmPath, { limit: 10 })).toMatchObject(
        {
          events: [
            { stream_offset: 0, entry: first },
            { stream_offset: 1, entry: second },
          ],
        },
      );
    });
  });

  it.each(["pending", "committed"])(
    "refuses a %s invalidation published during validation without modifying it",
    async (suffix) => {
      await withTempPmPath(async ({ pmPath }) => {
        const historyPath = path.join(pmPath, "history", "pm-snapshot.jsonl");
        await appendHistoryEntry(historyPath, first);
        await rebuildHistoryEventIndex(pmPath);
        const markers = path.join(
          pmPath,
          "runtime",
          "history-event-index-invalidations",
        );
        await fs.mkdir(markers, { recursive: true });
        const marker = path.join(markers, `active.${suffix}`);
        const originalStat = fs.stat.bind(fs);
        vi.spyOn(fs, "stat").mockImplementation(async (...args) => {
          const stats = await originalStat(...args);
          if (String(args[0]) === historyPath)
            await fs.writeFile(marker, "retain\n");
          return stats;
        });
        expect(await queryHistoryEventIndex(pmPath, { limit: 10 })).toBeNull();
        expect(await fs.readFile(marker, "utf8")).toBe("retain\n");
      });
    },
  );

  it("refuses an unindexed stream discovered after taking a global snapshot", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      await appendHistoryEntry(
        path.join(pmPath, "history", "pm-snapshot.jsonl"),
        first,
      );
      await rebuildHistoryEventIndex(pmPath);
      const historyRoot = path.join(pmPath, "history");
      const originalReaddir = fs.readdir.bind(fs);
      vi.spyOn(fs, "readdir").mockImplementation(async (...args) => {
        if (String(args[0]) === historyRoot) {
          await fs.writeFile(
            path.join(historyRoot, "pm-late.jsonl"),
            `${JSON.stringify(second)}\n`,
          );
        }
        return originalReaddir(...args);
      });
      expect(await queryHistoryEventIndex(pmPath, { limit: 10 })).toBeNull();
    });
  });
});
