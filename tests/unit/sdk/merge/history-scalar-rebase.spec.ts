/** Rebase scalar intent without losing closure or concurrent branch events. */
import { describe, expect, it } from "vitest";
import { createHistoryEntry, sealHistoryRecord } from "../../../../src/core/history/history.js";
import { historyEntriesToRaw, reanchorHistoryEntries, verifyHistoryChain } from "../../../../src/core/history/replay.js";
import { mergeHistoryStreams } from "../../../../src/sdk/merge/three-way.js";
import type { HistoryEntry, ItemDocument } from "../../../../src/types/index.js";

/** Deterministic item with an existing claim before branches diverge. */
function seedDocument(): ItemDocument {
  return { metadata: { id: "pm-scalar", title: "Shared work", description: "", type: "Task", status: "open", priority: 2,
    tags: [], created_at: "2026-10-01T00:00:00.000Z", updated_at: "2026-10-01T00:00:00.000Z",
    assignee: "initial-owner", claim_principal: "initial-owner#one" }, body: "" };
}

/** Build real branch-local patches with distinct immutable event coordinates. */
function event(before: ItemDocument, after: ItemDocument, op: string, minute: number): HistoryEntry {
  return createHistoryEntry({ before, after, op, author: op, nowIso: `2026-10-01T00:0${minute}:00.000Z` });
}

describe("history scalar intent rebasing", () => {
  it.each([false, true])("retains closure, claim replacement, release and comments in either merge direction (%s)", (reverse) => {
    const base = seedDocument();
    const closed = structuredClone(base); closed.metadata.status = "closed";
    closed.metadata.resolution = "Delivered"; closed.metadata.close_reason = "Verified";
    closed.metadata.closed_at = "2026-10-01T00:01:00.000Z"; closed.metadata.completed_at = closed.metadata.closed_at;
    const released = structuredClone(closed); delete released.metadata.assignee; delete released.metadata.claim_principal;
    const claimed = structuredClone(base); claimed.metadata.assignee = "branch-owner"; claimed.metadata.claim_principal = "branch-owner#two";
    const commented = structuredClone(claimed); commented.metadata.comments = [{ author: "branch-owner", created_at: "2026-10-01T00:04:00.000Z", text: "Branch context" }];
    const branchReleased = structuredClone(commented); delete branchReleased.metadata.assignee; delete branchReleased.metadata.claim_principal;
    const seed = event({ metadata: {} as ItemDocument["metadata"], body: "" }, base, "create", 0);
    const main = [seed, event(base, closed, "close", 1), event(closed, released, "release", 2)];
    const branch = [seed, event(base, claimed, "claim", 3), event(claimed, commented, "comment_add", 4), event(commented, branchReleased, "release", 5)];
    const raw = historyEntriesToRaw;
    const result = mergeHistoryStreams(raw([seed]), raw(reverse ? main : branch), raw(reverse ? branch : main));
    const entries = result.merged.trim().split("\n").map((line) => JSON.parse(line) as HistoryEntry);
    expect(verifyHistoryChain(entries)).toEqual({ ok: true, errors: [] });
    expect(entries.map((entry) => [entry.ts, entry.op, entry.author])).toEqual([seed, ...main.slice(1), ...branch.slice(1)].map((entry) => [entry.ts, entry.op, entry.author]));
    expect(reanchorHistoryEntries(entries.slice(0, 4)).finalDocument.metadata).toMatchObject({ status: "closed", assignee: "branch-owner", claim_principal: "branch-owner#two" });
    const final = reanchorHistoryEntries(entries).finalDocument;
    expect(final.metadata).toMatchObject({ status: "closed", resolution: "Delivered", close_reason: "Verified", closed_at: closed.metadata.closed_at, completed_at: closed.metadata.completed_at, comments: commented.metadata.comments });
    expect(final.metadata).not.toHaveProperty("assignee"); expect(final.metadata).not.toHaveProperty("claim_principal");
  });

  it("retains two independently valid removals as audited events", () => {
    const base = seedDocument(); const released = structuredClone(base);
    delete released.metadata.assignee; delete released.metadata.claim_principal;
    const seed = event({ metadata: {} as ItemDocument["metadata"], body: "" }, base, "create", 0);
    const raw = historyEntriesToRaw;
    const result = mergeHistoryStreams(raw([seed]), raw([seed, event(base, released, "release", 1)]), raw([seed, event(base, released, "release", 2)]));
    const entries = result.merged.trim().split("\n").map((line) => JSON.parse(line) as HistoryEntry);
    expect(entries).toHaveLength(3); expect(verifyHistoryChain(entries).ok).toBe(true);
    expect(reanchorHistoryEntries(entries).finalDocument.metadata).not.toHaveProperty("claim_principal");
  });

  it.each(["/metadata/", "/front_matter/"])("decodes escaped whole-field pointers from %s", (root) => {
    const base = seedDocument();
    (base.metadata as unknown as Record<string, unknown>)["review/~state"] = "before";
    const removed = structuredClone(base); delete (removed.metadata as unknown as Record<string, unknown>)["review/~state"];
    const replaced = structuredClone(base); (replaced.metadata as unknown as Record<string, unknown>)["review/~state"] = "after";
    const seed = event({ metadata: {} as ItemDocument["metadata"], body: "" }, base, "create", 0);
    const replace = event(base, replaced, "update", 2);
    // Legacy aliases are normalized before scalar rebasing.
    replace.patch = replace.patch.map((operation) => ({ ...operation, path: operation.path.replace("/metadata/", root) }));
    const raw = historyEntriesToRaw;
    const result = mergeHistoryStreams(raw([seed]), raw([seed, event(base, removed, "update", 1)]), raw([seed, sealHistoryRecord(replace)]));
    const entries = result.merged.trim().split("\n").map((line) => JSON.parse(line) as HistoryEntry);
    expect(verifyHistoryChain(entries).ok).toBe(true);
    expect(reanchorHistoryEntries(entries).finalDocument.metadata["review/~state"]).toBe("after");
  });

  it("refuses a conditional assertion invalidated by a concurrent release", () => {
    const base = seedDocument(); const removed = structuredClone(base); delete removed.metadata.claim_principal;
    const replaced = structuredClone(base); replaced.metadata.claim_principal = "new-owner#two";
    const seed = event({ metadata: {} as ItemDocument["metadata"], body: "" }, base, "create", 0);
    const guarded = event(base, replaced, "claim", 2);
    guarded.patch.unshift({ op: "test", path: "/metadata/claim_principal", value: base.metadata.claim_principal });
    const raw = historyEntriesToRaw;
    expect(() => mergeHistoryStreams(raw([seed]), raw([seed, event(base, removed, "release", 1)]), raw([seed, sealHistoryRecord(guarded)]))).toThrow(
      expect.objectContaining({ context: expect.objectContaining({ code: "history_union_rebase_conflict", field: "/metadata/claim_principal" }) }),
    );
  });
});
