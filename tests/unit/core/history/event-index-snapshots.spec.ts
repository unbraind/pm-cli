/** Ensures optional index readers cannot hold authoritative writers behind filesystem validation. */
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _testOnly,
  queryHistoryEventIndex,
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
let restore: () => void;
beforeEach(() => {
  restore = _testOnly.setDatabaseSync(DatabaseSync);
});
afterEach(() => {
  restore();
  vi.restoreAllMocks();
});

describe("history index read snapshots", () => {
  it.each(["reader", "writer", "exclusive writer"] as const)(
    "preserves authoritative append without waiting for a native SQLite %s",
    async (mode) => {
      await withTempPmPath(async ({ pmPath }) => {
        const historyPath = path.join(pmPath, "history", "pm-snapshot.jsonl");
        await appendHistoryEntry(historyPath, first);
        await rebuildHistoryEventIndex(pmPath);
        const contender = new DatabaseSync(
          path.join(pmPath, "runtime", "history-event-index.sqlite"),
        );
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
