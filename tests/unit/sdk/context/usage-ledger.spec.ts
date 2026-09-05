import { link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendEvents, readEvents } from "../../../../src/sdk/context/usage-ledger.js";
import { readContextUsageAffinity, recordContextUsageDelivery, recordContextUsageServing, recordContextUsageTouch, type ContextUsageEvent } from "../../../../src/sdk/query.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

/** Create disposable ledger storage with a fixed clock and register cleanup. */
async function fixture() {
  const pmRoot = await mkdtemp(path.join(os.tmpdir(), "pm-byte-ledger-"));
  roots.push(pmRoot);
  await mkdir(path.join(pmRoot, "runtime"));
  return { pmRoot, target: path.join(pmRoot, "runtime", "context-usage.jsonl"), now: "2026-09-01T00:00:00.000Z" };
}

describe("bounded feedback persistence", () => {
  it("reads only the tail of an oversized legacy ledger and discards partial, malformed and expired rows", async () => {
    const options = await fixture();
    const event: ContextUsageEvent = { kind: "touch", at: options.now, author: "agent", item_id: "pm-tail", intent: "get" };
    await writeFile(options.target, `${"x".repeat(300_000)}\nnull\ninvalid\n${JSON.stringify({ ...event, at: "2000-01-01" })}\n${JSON.stringify(event)}\n`);
    expect(await readEvents(options)).toEqual([event]);
    const write = await appendEvents(options, [event]);
    expect(write).toMatchObject({ compacted: true, ledger_bytes: write.written_bytes });
    expect((await stat(options.target)).size).toBe(write.ledger_bytes);
    const append = await appendEvents(options, [event]);
    expect(append.compacted).toBe(false);
    expect(append.ledger_bytes).toBe(write.ledger_bytes + append.written_bytes);
    await writeFile(options.target, "x".repeat(300_000));
    expect(await readEvents(options)).toEqual([]);
  });

  it("enforces byte and retention controls before writing and releases the lock after real filesystem failures", async () => {
    const options = await fixture();
    for (const controls of [{ maxBytes: 1 }, { maxBytes: 300_000 }, { maxBytes: 1024.5 }, { maxEvents: 0 }, { retentionDays: 0 }]) {
      await expect(readEvents({ ...options, ...controls })).rejects.toThrow("retention");
    }
    const event: ContextUsageEvent = { kind: "touch", at: options.now, author: "agent", item_id: "pm-a", intent: "get" };
    await expect(appendEvents(options, [{ ...event, intent: "x".repeat(40_000) }])).rejects.toThrow("byte ceiling");
    await mkdir(options.target);
    expect(await readEvents(options)).toEqual([]);
    await expect(appendEvents({ ...options, maxEvents: 2 }, [event])).rejects.toThrow();
    await rm(options.target, { recursive: true });
    await symlink(options.target, options.target);
    await expect(appendEvents(options, [event])).rejects.toThrow();
    await rm(options.target);
    await expect(appendEvents(options, [event])).resolves.toMatchObject({ compacted: false });
    await appendEvents({ ...options, maxEvents: 1 }, [{ ...event, at: "2000-01-01" }]);
    expect(await readEvents(options)).toEqual([event]);
    const many = Array.from({ length: 10 }, (_, index) => ({ ...event, item_id: `pm-${index}` }));
    await appendEvents({ ...options, maxBytes: 1024 }, many);
    expect((await stat(options.target)).size).toBeLessThanOrEqual(1024);
    expect((await readEvents(options)).at(-1)?.kind).toBe("touch");
  });

  it("refuses redirected and non-regular ledger storage without changing external data", async () => {
    const options = await fixture();
    const sentinel = path.join(options.pmRoot, "sentinel.jsonl");
    const event: ContextUsageEvent = { kind: "touch", at: options.now, author: "agent", item_id: "pm-sentinel", intent: "get" };
    const original = `${JSON.stringify(event)}\n`;
    await writeFile(sentinel, original);
    await symlink(sentinel, options.target);
    expect(await readEvents(options)).toEqual([]);
    for (const controls of [{}, { maxEvents: 1 }]) {
      await expect(appendEvents({ ...options, ...controls }, [event])).rejects.toThrow();
      expect(await readFile(sentinel, "utf8")).toBe(original);
    }
    await rm(options.target);
    await link(sentinel, options.target);
    await expect(appendEvents(options, [event])).rejects.toThrow();
    expect(await readEvents(options)).toEqual([]);
    expect(await readFile(sentinel, "utf8")).toBe(original);
    await rm(options.target);
    await rm(path.dirname(options.target), { recursive: true });
    const outside = await mkdtemp(path.join(os.tmpdir(), "pm-external-ledger-"));
    roots.push(outside);
    const outsideTarget = path.join(outside, "context-usage.jsonl");
    await writeFile(outsideTarget, original);
    await symlink(outside, path.dirname(options.target), "junction");
    await expect(appendEvents(options, [event])).rejects.toThrow();
    expect(await readEvents(options)).toEqual([]);
    expect(await readFile(outsideTarget, "utf8")).toBe(original);
  });

  it("discloses sample omissions and learns only from sampled final deliveries", async () => {
    const options = await fixture();
    const receipt = await recordContextUsageServing({ ...options, author: "agent", surface: "context", profile: "orient", rows: Array.from({ length: 300 }, (_, rank) => ({ id: `pm-${rank}`, rank: rank + 1, included: true, undeclared: "private-annotation" })) });
    expect(await readFile(options.target, "utf8")).not.toContain("private-annotation");
    expect(receipt?.storage).toMatchObject({ compacted: false, lock_wait_ms: expect.any(Number) });
    await recordContextUsageDelivery({ ...options, receipt, deliveredItemIds: ["pm-0", "pm-299"], resultOmitted: false });
    for (const itemId of ["pm-0", "pm-299"]) await recordContextUsageTouch({ ...options, now: "2026-09-01T00:01:00.000Z", author: "agent", itemId, intent: "get" });
    expect(await readContextUsageAffinity({ ...options, now: "2026-09-01T01:00:00.000Z", author: "agent" })).toMatchObject({ affinity: { "pm-0": 1 }, positive_judgments: 1 });
    expect((await readEvents(options))[0]).toMatchObject({ candidate_count: 300, omitted_row_count: 44 });
    if (!receipt) throw new Error("Missing serving receipt");
    const { recorded_item_ids: _sample, storage: _storage, ...legacy } = receipt;
    await recordContextUsageDelivery({ ...options, receipt: { ...legacy, serve_id: "legacy" }, deliveredItemIds: ["pm-299"], resultOmitted: false });
    expect(await readFile(options.target, "utf8")).toContain('"serve_id":"legacy"');
  });
});
