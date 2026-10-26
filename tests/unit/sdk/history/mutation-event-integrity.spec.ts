/** Prove event cache freshness and authoritative proof across processes and optional SQLite. */
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { listMutationEvents, subscribeMutationEventBatches } from "../../../../src/sdk/mutation-events.js";
import { _testOnly, queryHistoryEventIndex } from "../../../../src/core/history/event-index.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";
import { createTestItemId } from "../../../helpers/itemFactory.js";
import * as historyRead from "../../../../src/core/history/read.js";
import { sealHistoryRecord } from "../../../../src/core/history/history.js";
import { verifyHistoryEntries } from "../../../../src/sdk/history-read.js";
import type { HistoryEntry } from "../../../../src/types/index.js";

describe("authoritative mutation event integrity", () => {
  it.each([true, false])("detects earlier same-length rewrites with SQLite=%s, warm and restarted readers", async (sqlite) => {
    const restore = sqlite ? () => {} : _testOnly.setDatabaseSync(null);
    try {
      await withTempPmPath(async (context) => {
        const id = createTestItemId(context, { title: "Event integrity", createMode: "progressive" });
        context.runCli(["comments", id, "Second record"]);
        const historyPath = path.join(context.pmPath, "history", `${id}.jsonl`);
        const raw = await fs.readFile(historyPath, "utf8");
        const lines = raw.trimEnd().split("\n");
        const first = JSON.parse(lines[0]) as HistoryEntry;
        expect(first.record_hash).toBeDefined();
        const prime = await listMutationEvents({ pmRoot: context.pmPath, item: id, full: true });
        const oldHash = first.record_hash!;
        const changedHash = `${oldHash[0] === "a" ? "b" : "a"}${oldHash.slice(1)}`;
        const modified = raw.replace(oldHash, changedHash);
        expect(Buffer.byteLength(modified)).toBe(Buffer.byteLength(raw));
        expect(modified.trimEnd().split("\n").at(-1)).toBe(lines.at(-1));
        const stats = await fs.stat(historyPath);
        await fs.writeFile(historyPath, modified);
        await fs.utimes(historyPath, stats.atime, stats.mtime);
        expect((await listMutationEvents({ pmRoot: context.pmPath, item: id, full: true })).events[0].entry!.record_hash).toBe(changedHash);
        expect(prime.integrity).toBe("unverified");
        await expect(listMutationEvents({ pmRoot: context.pmPath, item: id, verify: true, type: "absent", limit: 0 })).rejects.toMatchObject({ context: { code: "event_history_integrity_failed" } });
        const restarted = context.runCli(["events", "--item", id, "--full", "--json"], { expectJson: true });
        expect(restarted.code).toBe(0);
        expect(restarted.json).toMatchObject({ integrity: "unverified" });
        expect((restarted.json as { events: { entry: HistoryEntry }[] }).events[0].entry.record_hash).toBe(changedHash);
        const strict = context.runCli(["events", "--item", id, "--verify", "--json"], { expectJson: true });
        expect(strict.code).not.toBe(0);
        expect(`${strict.stdout}\n${strict.stderr}`).toContain("event_history_integrity_failed");
        expect(await fs.readFile(historyPath, "utf8")).toBe(modified);
      });
    } finally { restore(); }
  });

  it("retains exact sealed timestamps and isolates returned entries from the authoritative cache", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "Recorded timestamp", createMode: "progressive" });
      const historyPath = path.join(context.pmPath, "history", `${id}.jsonl`);
      const entry = JSON.parse((await fs.readFile(historyPath, "utf8")).trim()) as HistoryEntry;
      entry.ts = entry.ts.replace("Z", "+00:00");
      const sealed = sealHistoryRecord(entry);
      await fs.writeFile(historyPath, `${JSON.stringify(sealed)}\n`);
      const page = await listMutationEvents({ pmRoot: context.pmPath, item: id, verify: true, full: true });
      expect(page.events[0].entry).toEqual(sealed);
      expect(verifyHistoryEntries(page.events.map((row) => row.entry!)).ok).toBe(true);
      page.events[0].entry!.author = "consumer changed its own copy";
      const restore = _testOnly.setDatabaseSync(null);
      try {
        expect((await listMutationEvents({ pmRoot: context.pmPath, item: id, full: true })).events[0].entry!.author).toBe(sealed.author);
      } finally { restore(); }
      expect(await listMutationEvents({ pmRoot: context.pmPath, item: "pm-no-stream", verify: true })).toMatchObject({ count: 0, verified_streams: 0, integrity: "verified" });
    });
  });

  it("keeps unverified full entries stable before and after a strict read of the shared cache", async () => {
    const restore = _testOnly.setDatabaseSync(null);
    try {
      await withTempPmPath(async (context) => {
        const id = createTestItemId(context, { title: "Stable default timestamps", createMode: "progressive" });
        const historyPath = path.join(context.pmPath, "history", `${id}.jsonl`);
        const entry = JSON.parse((await fs.readFile(historyPath, "utf8")).trim()) as HistoryEntry;
        entry.ts = entry.ts.replace("Z", "+00:00");
        const sealed = sealHistoryRecord(entry);
        await fs.writeFile(historyPath, `${JSON.stringify(sealed)}\n`);
        const before = await listMutationEvents({ pmRoot: context.pmPath, item: id, full: true });
        const strict = await listMutationEvents({ pmRoot: context.pmPath, item: id, full: true, verify: true });
        const after = await listMutationEvents({ pmRoot: context.pmPath, item: id, full: true });
        expect(strict.events[0].entry).toEqual(sealed);
        expect(before.events[0].entry!.ts).toBe(new Date(sealed.ts).toISOString());
        expect(after.events).toEqual(before.events);
        expect(after.integrity).toBe("unverified");
      });
    } finally { restore(); }
  });

  it.each([true, false])("reuses receipts for original bytes containing a decoded replacement character with SQLite=%s", async (sqlite) => {
    const restore = sqlite ? () => {} : _testOnly.setDatabaseSync(null);
    try {
      await withTempPmPath(async (context) => {
        const id = createTestItemId(context, { title: "Original byte receipt", createMode: "progressive" });
        const historyPath = path.join(context.pmPath, "history", `${id}.jsonl`);
        const entry = JSON.parse((await fs.readFile(historyPath, "utf8")).trim()) as HistoryEntry;
        entry.message = "Replacement: \uFFFD";
        const sealed = sealHistoryRecord(entry);
        const encoded = Buffer.from(`${JSON.stringify(sealed)}\n`);
        const offset = encoded.indexOf(Buffer.from("\uFFFD"));
        const bytes = Buffer.concat([encoded.subarray(0, offset), Buffer.from([0xff]), encoded.subarray(offset + 3)]);
        await fs.writeFile(historyPath, bytes);
        const snapshot = await historyRead.readHistorySnapshot(historyPath, id);
        expect(snapshot.raw).toBe(encoded.toString("utf8"));
        expect(verifyHistoryEntries(snapshot.entries).ok).toBe(true);
        const prime = await listMutationEvents({ pmRoot: context.pmPath, item: id, full: true });
        const reading = vi.spyOn(historyRead, "readHistorySnapshot");
        try {
          expect((await listMutationEvents({ pmRoot: context.pmPath, item: id, full: true })).events).toEqual(prime.events);
          expect(reading).not.toHaveBeenCalled();
        } finally { reading.mockRestore(); }
        expect(snapshot.raw_bytes).toEqual(bytes);
      });
    } finally { restore(); }
  });

  it("keeps fallback cache coherent after a failed multi-stream read", async () => {
    const restore = _testOnly.setDatabaseSync(null);
    try {
      await withTempPmPath(async (context) => {
        const ids = [
          createTestItemId(context, { title: "First stream", createMode: "progressive" }),
          createTestItemId(context, { title: "Second stream", createMode: "progressive" }),
        ].sort((left, right) => left.localeCompare(right));
        const [good, bad] = ids;
        await listMutationEvents({ pmRoot: context.pmPath, full: true });
        context.runCli(["comments", good, "Appended after the warm read"]);
        const goodPath = path.join(context.pmPath, "history", `${good}.jsonl`);
        const goodHistory = await historyRead.readHistorySnapshot(goodPath, good);
        const badPath = path.join(context.pmPath, "history", `${bad}.jsonl`);
        const badEntry = JSON.parse((await fs.readFile(badPath, "utf8")).trim()) as HistoryEntry;
        badEntry.message = "Changed without resealing";
        await fs.writeFile(badPath, `${JSON.stringify(badEntry)}\n`);
        await expect(listMutationEvents({ pmRoot: context.pmPath, verify: true })).rejects.toMatchObject({ context: { code: "event_history_integrity_failed" } });
        const selected = await listMutationEvents({ pmRoot: context.pmPath, item: good, full: true });
        expect(selected.events.map((event) => event.entry)).toEqual(goodHistory.entries);
        expect(selected.integrity).toBe("unverified");
      });
    } finally { restore(); }
  });

  it("publishes coherent cache snapshots across interleaved readers", async () => {
    const restore = _testOnly.setDatabaseSync(null);
    try {
      await withTempPmPath(async (context) => {
        const changing = createTestItemId(context, { title: "Changing stream", createMode: "progressive" });
        const suspended = createTestItemId(context, { title: "Suspended stream", createMode: "progressive" });
        const changingPath = path.join(context.pmPath, "history", `${changing}.jsonl`);
        const suspendedPath = path.join(context.pmPath, "history", `${suspended}.jsonl`);
        await listMutationEvents({ pmRoot: context.pmPath, full: true });
        const heldSnapshot = Promise.withResolvers<void>();
        const resumeSnapshot = Promise.withResolvers<void>();
        const heldValidation = Promise.withResolvers<void>();
        const resumeValidation = Promise.withResolvers<void>();
        const originalSnapshot = historyRead.readHistorySnapshot;
        const snapshotSpy = vi.spyOn(historyRead, "readHistorySnapshot").mockImplementation(async (...args) => {
          const snapshot = await originalSnapshot(...args);
          if (String(args[0]) === suspendedPath) {
            heldSnapshot.resolve();
            await resumeSnapshot.promise;
          }
          return snapshot;
        });
        let statSpy: { mockRestore(): void } | undefined;
        const olderRead = listMutationEvents({ pmRoot: context.pmPath, item: suspended, verify: true });
        let unchangedRead: ReturnType<typeof listMutationEvents> | undefined;
        try {
          await heldSnapshot.promise;
          context.runCli(["comments", changing, "Append between reader snapshots"]);
          await listMutationEvents({ pmRoot: context.pmPath, item: changing, verify: true });
          const expected = (await historyRead.readHistorySnapshot(changingPath, changing)).entries;
          const originalStat = fs.stat.bind(fs);
          statSpy = vi.spyOn(fs, "stat").mockImplementation(async (...args) => {
            const stats = await originalStat(...args);
            if (String(args[0]) === changingPath) {
              heldValidation.resolve();
              await resumeValidation.promise;
            }
            return stats;
          });
          unchangedRead = listMutationEvents({ pmRoot: context.pmPath, item: changing, full: true });
          await heldValidation.promise;
          resumeSnapshot.resolve();
          await olderRead;
          resumeValidation.resolve();
          expect((await unchangedRead).events.map((event) => event.entry)).toEqual(expected);
          expect((await listMutationEvents({ pmRoot: context.pmPath, item: changing, full: true })).events.map((event) => event.entry)).toEqual(expected);
        } finally {
          resumeSnapshot.resolve();
          resumeValidation.resolve();
          await Promise.allSettled([olderRead, ...(unchangedRead ? [unchangedRead] : [])]);
          statSpy?.mockRestore();
          snapshotSpy.mockRestore();
        }
      });
    } finally { restore(); }
  });

  it("returns no actions when a selected stream disappears at its authoritative read boundary", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "Disappearing stream", createMode: "progressive" });
      const historyPath = path.join(context.pmPath, "history", `${id}.jsonl`);
      const original = historyRead.readHistorySnapshot;
      const reading = vi.spyOn(historyRead, "readHistorySnapshot").mockImplementation(async (...args) => {
        if (String(args[0]) === historyPath) await fs.rm(historyPath, { force: true });
        return original(...args);
      });
      try {
        expect(await listMutationEvents({ pmRoot: context.pmPath, item: id, verify: true })).toMatchObject({ count: 0, integrity: "verified" });
      } finally { reading.mockRestore(); }
    });
  });

  it("verifies selected complete streams and carries proof on subscription batches and MCP", async () => {
    await withTempPmPath(async (context) => {
      const good = createTestItemId(context, { title: "Valid selected stream", createMode: "progressive" });
      await fs.writeFile(path.join(context.pmPath, "history", "pm-unrelated.jsonl"), "invalid unrelated JSON\n");
      const page = await listMutationEvents({ pmRoot: context.pmPath, item: good, verify: true });
      expect(page).toMatchObject({ integrity: "verified", verified_streams: 1, count: 1 });
      expect(await queryHistoryEventIndex(context.pmPath, { verify: true, stream_ids: [good], limit: 1 })).toMatchObject({ verified_streams: 1 });
      const signal = new AbortController();
      for await (const batch of subscribeMutationEventBatches({ pmRoot: context.pmPath, item: good, verify: true, signal: signal.signal })) {
        expect(batch.integrity).toBe("verified");
        signal.abort();
      }
      const cli = context.runCli(["events", "--item", good, "--verify"], { expectJson: false });
      expect(cli.code).toBe(0);
      expect(cli.stdout).toContain('"integrity":"verified"');
      const { handleRequest } = await import("../../../../src/mcp/server.js");
      expect(await handleRequest({ id: 1, method: "tools/call", params: { name: "pm_events", arguments: { path: context.pmPath, item: good, verify: true } } })).toMatchObject({ structuredContent: { result: { integrity: "verified", verified_streams: 1 } } });
      const { runRuntimeEventsAction } = await import("../../../../src/sdk/runtime-extended-actions.js");
      expect(await runRuntimeEventsAction({ action: "events", args: { path: context.pmPath, item: good, verify: true }, options: {}, global: { path: context.pmPath } })).toMatchObject({ integrity: "verified", verified_streams: 1 });
    });
  });
});
