import { DatabaseSync } from "node:sqlite";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _testOnly,
  queryHistoryEventIndex,
  rebuildHistoryEventIndex,
  removeHistoryEventIndexForHistoryPath,
  updateHistoryEventIndexAfterAppend,
} from "../../../../src/core/history/event-index.js";
import type { HistoryEntry } from "../../../../src/types/index.js";
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
          historyEntry("2026-07-24T09:00:00.000Z", "alpha", "create", "created"),
          historyEntry("2026-07-24T10:00:00.000Z", "alpha", "claim"),
        ].map((entry) => JSON.stringify(entry)).join("\n"),
      );
      await fs.writeFile(path.join(historyRoot, "ignored.txt"), "ignored\n");
      await fs.mkdir(path.join(historyRoot, "ignored.jsonl"));

      await expect(rebuildHistoryEventIndex(context.pmPath)).resolves.toBe(true);
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
        events: [{ stream_id: "pm-a", stream_offset: 1, entry: { op: "claim" } }],
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
      const historyPath = path.join(context.pmPath, "history", "pm-update.jsonl");
      const first = historyEntry("2026-07-24T09:00:00.000Z", "agent", "create");
      const second = historyEntry("2026-07-24T10:00:00.000Z", "agent", "update");
      await fs.writeFile(historyPath, `${JSON.stringify(first)}\n`);

      await updateHistoryEventIndexAfterAppend(historyPath, first);
      await rebuildHistoryEventIndex(context.pmPath);
      await updateHistoryEventIndexAfterAppend(historyPath, second);
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

  it("supports an empty tracker and reports unavailable SQLite runtimes", async () => {
    await withTempPmPath(async (context) => {
      await fs.rm(path.join(context.pmPath, "history"), {
        recursive: true,
        force: true,
      });
      await expect(rebuildHistoryEventIndex(context.pmPath)).resolves.toBe(true);
      await expect(
        queryHistoryEventIndex(context.pmPath, { limit: 10 }),
      ).resolves.toEqual({ events: [], has_more: false });

      restoreDatabaseSync?.();
      restoreDatabaseSync = _testOnly.setDatabaseSync(null);
      await expect(rebuildHistoryEventIndex(context.pmPath)).resolves.toBe(false);
      await expect(
        queryHistoryEventIndex(context.pmPath, { limit: 10 }),
      ).resolves.toBeNull();
      await expect(
        updateHistoryEventIndexAfterAppend(
          path.join(context.pmPath, "history", "pm-a.jsonl"),
          historyEntry("2026-07-24T10:00:00.000Z", "agent", "update"),
        ),
      ).resolves.toBeUndefined();
    });
  });

  it("invalidates corrupt and incompatible projections instead of serving stale rows", async () => {
    await withTempPmPath(async (context) => {
      const historyPath = path.join(context.pmPath, "history", "pm-invalid.jsonl");
      const indexPath = path.join(context.pmPath, "runtime", INDEX_FILENAME);
      const entry = historyEntry("2026-07-24T10:00:00.000Z", "agent", "update");
      await fs.writeFile(historyPath, `${JSON.stringify(entry)}\n`);
      await rebuildHistoryEventIndex(context.pmPath);

      const database = new DatabaseSync(indexPath);
      database.prepare("UPDATE metadata SET value = 'old' WHERE key = 'version'").run();
      database.close();
      await expect(
        queryHistoryEventIndex(context.pmPath, { limit: 10 }),
      ).resolves.toBeNull();
      await updateHistoryEventIndexAfterAppend(historyPath, entry);
      await expect(fs.access(indexPath)).rejects.toThrow();

      await fs.writeFile(indexPath, "not sqlite");
      await expect(
        queryHistoryEventIndex(context.pmPath, { limit: 10 }),
      ).resolves.toBeNull();
      await updateHistoryEventIndexAfterAppend(historyPath, entry);
      await expect(fs.access(indexPath)).rejects.toThrow();
    });
  });

  it("cleans temporary projections when rebuild input or database creation fails", async () => {
    await withTempPmPath(async (context) => {
      const historyRoot = path.join(context.pmPath, "history");
      await fs.writeFile(path.join(historyRoot, "pm-bad.jsonl"), "{bad json}\n");
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
