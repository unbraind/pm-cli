import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  _testOnlyMutationEvents,
  listMutationEvents,
  subscribeMutationEvents,
} from "../../../src/sdk/index.js";
import { _testOnly as eventIndexTestOnly } from "../../../src/core/history/event-index.js";
import { appendHistoryEntry } from "../../../src/core/history/history.js";
import { handleRequest } from "../../../src/mcp/server.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

describe("SDK mutation event stream", () => {
  it("pages, filters, and resumes through stable event cursors", async () => {
    await withTempPmPath(async (context) => {
      const first = context.runCli(
        [
          "create",
          "--title",
          "Mutation event first",
          "--type",
          "Task",
          "--status",
          "open",
          "--author",
          "event-agent-a",
          "--json",
        ],
        { expectJson: true },
      );
      const second = context.runCli(
        [
          "create",
          "--title",
          "Mutation event second",
          "--type",
          "Task",
          "--status",
          "open",
          "--author",
          "event-agent-b",
          "--json",
        ],
        { expectJson: true },
      );
      const firstId = (first.json as { item: { id: string } }).item.id;
      const secondId = (second.json as { item: { id: string } }).item.id;
      await appendHistoryEntry(
        path.join(context.pmPath, "history", "pm-manual.jsonl"),
        {
          ts: "2026-07-24T08:00:00.000Z",
          author: "manual-agent",
          op: "update",
          patch: [],
          before_hash: "before",
          after_hash: "after",
        },
      );
      await expect(
        listMutationEvents({
          pmRoot: context.pmPath,
          since: "2026-07-24T08:00:00.000Z",
          item: "pm-manual",
          limit: 1,
        }),
      ).resolves.toMatchObject({
        events: [{ item_id: "pm-manual", patch_count: 0 }],
      });

      const page = await listMutationEvents({
        pmRoot: context.pmPath,
        type: "create",
        limit: 1,
      });
      expect(page).toMatchObject({
        count: 1,
        has_more: true,
        source: "derived_index",
        events: [{ item_id: firstId, type: "create", version: 1 }],
      });
      expect(page.next_cursor).toEqual(expect.any(String));

      const resumed = await listMutationEvents({
        pmRoot: context.pmPath,
        type: ["create"],
        since: page.next_cursor,
        limit: 10,
        full: true,
      });
      expect(resumed).toMatchObject({
        count: 1,
        has_more: false,
        events: [
          {
            item_id: secondId,
            author: "event-agent-b",
            entry: { op: "create" },
          },
        ],
      });
      expect(
        await listMutationEvents({
          pmRoot: context.pmPath,
          author: "event-agent-a",
          item: firstId,
        }),
      ).toMatchObject({ count: 1, events: [{ item_id: firstId }] });
      const cliPage = context.runCli([
        "events",
        "--type",
        "create",
        "--author",
        "event-agent-a",
        "--item",
        firstId,
        "--limit",
        "1",
      ]);
      expect(
        cliPage.stdout
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as Record<string, unknown>),
      ).toMatchObject([
        {
          item_id: firstId,
          author: "event-agent-a",
          type: "create",
          cursor: expect.any(String),
        },
      ]);
      await expect(
        handleRequest({
          id: 1,
          method: "tools/call",
          params: {
            name: "pm_events",
            arguments: {
              path: context.pmPath,
              type: ["create"],
              item: firstId,
              limit: 1,
            },
          },
        }),
      ).resolves.toMatchObject({
        structuredContent: {
          result: {
            count: 1,
            events: [{ item_id: firstId, type: "create" }],
          },
        },
      });
      await expect(
        handleRequest({
          id: 2,
          method: "tools/call",
          params: {
            name: "pm_events",
            arguments: {
              cwd: context.pmPath,
              path: 1,
              since: 1,
              type: 1,
              author: 1,
              item: 1,
              limit: "1",
              full: false,
            },
          },
        }),
      ).resolves.toMatchObject({
        structuredContent: {
          result: { count: 1 },
        },
      });
      await expect(
        handleRequest({
          id: 3,
          method: "tools/call",
          params: {
            name: "pm_events",
            arguments: {
              path: context.pmPath,
              since: "2026-07-24T00:00:00.000Z",
              type: "create",
              author: "event-agent-a",
              item: firstId,
            },
          },
        }),
      ).resolves.toMatchObject({
        structuredContent: {
          result: { count: 1 },
        },
      });
      await expect(
        listMutationEvents({
          pmRoot: context.pmPath,
          author: "different-query",
          since: page.next_cursor,
        }),
      ).rejects.toThrow(/does not match this query/);
    });
  });

  it("tails newly appended events and stops through AbortSignal", async () => {
    await withTempPmPath(async (context) => {
      const initial = await listMutationEvents({
        pmRoot: context.pmPath,
        limit: 100,
      });
      const controller = new AbortController();
      const subscription = subscribeMutationEvents({
        pmRoot: context.pmPath,
        since: initial.next_cursor,
        intervalMs: 10,
        signal: controller.signal,
      });
      const nextEvent = subscription.next();
      context.runCli([
        "create",
        "--title",
        "Mutation event followed",
        "--type",
        "Task",
        "--status",
        "open",
        "--author",
        "event-follower",
        "--json",
      ]);
      await expect(nextEvent).resolves.toMatchObject({
        done: false,
        value: { author: "event-follower", type: "create" },
      });
      controller.abort();
      await expect(subscription.next()).resolves.toEqual({
        done: true,
        value: undefined,
      });
    });
  });

  it("validates event bounds and tracker availability", async () => {
    await expect(
      listMutationEvents({ pmRoot: "/tmp/pm-mutation-events-missing" }),
    ).rejects.toThrow(/Tracker is not initialized/);
    await withTempPmPath(async (context) => {
      await expect(
        listMutationEvents({ pmRoot: context.pmPath, limit: 1_001 }),
      ).rejects.toThrow(/0 to 1000/);
      await expect(
        listMutationEvents({ pmRoot: context.pmPath, limit: 1.5 }),
      ).rejects.toThrow(/integer/);
      await expect(
        listMutationEvents({ pmRoot: context.pmPath, limit: -1 }),
      ).rejects.toThrow(/0 to 1000/);
      await expect(
        listMutationEvents({
          pmRoot: context.pmPath,
          since: "not a cursor or timestamp!",
        }),
      ).rejects.toThrow(/cursor or ISO timestamp/);
      await expect(
        subscribeMutationEvents({
          pmRoot: context.pmPath,
          intervalMs: 1,
        }).next(),
      ).rejects.toThrow(/at least 10ms/);
      await expect(
        subscribeMutationEvents({
          pmRoot: context.pmPath,
          intervalMs: 10.5,
        }).next(),
      ).rejects.toThrow(/integer/);
    });
  });

  it("defines strict cursor, filter, timestamp, and default-limit contracts", () => {
    const fingerprint = _testOnlyMutationEvents.eventQueryFingerprint({
      type: [" update,create ", "create"],
      author: " agent ",
      item: ["", "pm-b,pm-a"],
    });
    expect(fingerprint).toBe(
      _testOnlyMutationEvents.eventQueryFingerprint({
        type: ["create", "update"],
        author: ["agent"],
        item: ["pm-a", "pm-b"],
      }),
    );
    expect(
      _testOnlyMutationEvents.eventQueryFingerprint({
        type: " , ",
        author: undefined,
      }),
    ).toEqual(expect.any(String));
    expect(_testOnlyMutationEvents.parseMutationEventLimit(undefined)).toBe(
      100,
    );
    expect(_testOnlyMutationEvents.parseMutationEventLimit(0)).toBe(0);
    expect(
      _testOnlyMutationEvents.resolveMutationEventStart(undefined, fingerprint),
    ).toEqual({});
    expect(
      _testOnlyMutationEvents.resolveMutationEventStart("  ", fingerprint),
    ).toEqual({});
    expect(
      _testOnlyMutationEvents.resolveMutationEventStart(
        "2026-07-24T10:00:00+02:00",
        fingerprint,
      ),
    ).toEqual({ sinceTimestamp: "2026-07-24T08:00:00.000Z" });

    const event = {
      stream_id: "pm-a",
      stream_offset: 0,
      entry: {
        ts: "2026-07-24T08:00:00.000Z",
        author: "agent",
        op: "create",
        patch: [],
        before_hash: "before",
        after_hash: "after",
      },
    };
    const cursor = _testOnlyMutationEvents.encodeMutationEventCursor(
      event,
      fingerprint,
    );
    expect(
      _testOnlyMutationEvents.resolveMutationEventStart(cursor, fingerprint),
    ).toMatchObject({
      cursor: { stream_id: "pm-a", stream_offset: 0 },
    });
    for (const invalid of ["", "!", "a".repeat(4_097), "bm90LWpzb24"]) {
      expect(() =>
        _testOnlyMutationEvents.decodeMutationEventCursor(invalid, fingerprint),
      ).toThrow(/Invalid mutation event cursor/);
    }
    expect(
      _testOnlyMutationEvents.isMutationEventCursorEnvelope(null, fingerprint),
    ).toBe(false);
    expect(
      _testOnlyMutationEvents.isMutationEventCursorEnvelope(
        "cursor",
        fingerprint,
      ),
    ).toBe(false);
    expect(_testOnlyMutationEvents.isAbortError("AbortError")).toBe(false);
    expect(
      _testOnlyMutationEvents.isAbortError(
        Object.assign(new Error("aborted"), { name: "AbortError" }),
      ),
    ).toBe(true);
    const validEnvelope = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    for (const [key, value] of [
      ["version", 2],
      ["fingerprint", "other"],
      ["ts", 1],
      ["stream_id", 1],
      ["stream_offset", "0"],
      ["stream_offset", 1.5],
      ["stream_offset", -1],
    ] as const) {
      expect(
        _testOnlyMutationEvents.isMutationEventCursorEnvelope(
          { ...validEnvelope, [key]: value },
          fingerprint,
        ),
      ).toBe(false);
    }
  });

  it("reports unavailable and repeatedly unreadable derived event indexes", async () => {
    await withTempPmPath(async (context) => {
      let restore = eventIndexTestOnly.setDatabaseSync(null);
      await expect(
        listMutationEvents({ pmRoot: context.pmPath }),
      ).rejects.toThrow(/node:sqlite DatabaseSync/);
      restore();

      let constructions = 0;
      const IntermittentDatabase = function (
        this: unknown,
        filename: string,
        options?: { readOnly?: boolean },
      ): DatabaseSync {
        constructions += 1;
        if (options?.readOnly === true) {
          throw new Error("unreadable projection");
        }
        return new DatabaseSync(filename);
      };
      restore = eventIndexTestOnly.setDatabaseSync(
        IntermittentDatabase as unknown as typeof DatabaseSync,
      );
      try {
        await expect(
          listMutationEvents({ pmRoot: context.pmPath }),
        ).rejects.toThrow(/could not be opened after rebuild/);
        expect(constructions).toBe(3);
      } finally {
        restore();
      }
    });
  });

  it("stops pre-aborted subscriptions and propagates non-abort timer errors", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      subscribeMutationEvents({ signal: controller.signal }).next(),
    ).resolves.toEqual({ done: true, value: undefined });
    await withTempPmPath(async (context) => {
      const waitingController = new AbortController();
      const waiting = subscribeMutationEvents({
        pmRoot: context.pmPath,
        intervalMs: 10,
        signal: waitingController.signal,
      });
      const pending = waiting.next();
      waitingController.abort();
      await expect(pending).resolves.toEqual({
        done: true,
        value: undefined,
      });
      await expect(
        subscribeMutationEvents({
          pmRoot: context.pmPath,
          intervalMs: 10,
          signal: {} as AbortSignal,
        }).next(),
      ).rejects.toThrow();
    });
  });
});
