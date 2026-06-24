import { describe, expect, it } from "vitest";
import {
  collectBlockedByIds,
  computeActionabilityReport,
  resolveItemBlockers,
} from "../../../../src/core/item/actionability.js";
import { resolveRuntimeStatusRegistry } from "../../../../src/core/schema/runtime-schema.js";
import type { Dependency, ItemFrontMatter, ItemType } from "../../../../src/types/index.js";

const registry = resolveRuntimeStatusRegistry(undefined);

interface ItemOverrides {
  id: string;
  status?: string;
  priority?: 0 | 1 | 2 | 3 | 4;
  type?: string;
  parent?: string;
  blocked_by?: unknown;
  dependencies?: Dependency[];
}

function item(overrides: ItemOverrides): ItemFrontMatter {
  return {
    id: overrides.id,
    title: `Item ${overrides.id}`,
    description: "",
    type: (overrides.type ?? "Task") as ItemType,
    status: overrides.status ?? "open",
    priority: overrides.priority ?? 2,
    tags: [],
    created_at: "2026-06-24T00:00:00.000Z",
    updated_at: "2026-06-24T00:00:00.000Z",
    ...(overrides.parent !== undefined ? { parent: overrides.parent } : {}),
    ...(overrides.blocked_by !== undefined ? { blocked_by: overrides.blocked_by as string } : {}),
    ...(overrides.dependencies !== undefined ? { dependencies: overrides.dependencies } : {}),
  } as ItemFrontMatter;
}

function blockedByDep(id: string): Dependency {
  return { id, kind: "blocked_by", created_at: "2026-06-24T00:00:00.000Z" };
}

describe("collectBlockedByIds", () => {
  it("merges the scalar blocked_by and blocked_by dependencies, skipping other kinds and blank ids", () => {
    const ids = collectBlockedByIds({
      blocked_by: " pm-b ",
      dependencies: [
        blockedByDep("pm-a"),
        { id: "pm-c", kind: "related", created_at: "2026-06-24T00:00:00.000Z" },
        { id: "   ", kind: "blocked_by", created_at: "2026-06-24T00:00:00.000Z" },
        { id: 5 as never, kind: "blocked_by", created_at: "2026-06-24T00:00:00.000Z" },
      ],
    });
    expect(ids).toEqual(["pm-a", "pm-b"]);
  });

  it("ignores a non-string scalar and absent dependencies", () => {
    expect(collectBlockedByIds({ blocked_by: 7 as never, dependencies: undefined })).toEqual([]);
  });
});

describe("resolveItemBlockers", () => {
  it("annotates each blocker as resolved (missing/terminal) or open (non-terminal)", () => {
    const corpus = [
      item({ id: "pm-open", status: "open" }),
      item({ id: "pm-closed", status: "closed" }),
    ];
    const byId = new Map(corpus.map((entry) => [entry.id, entry]));
    const blockers = resolveItemBlockers(
      { dependencies: [blockedByDep("pm-open"), blockedByDep("pm-closed"), blockedByDep("pm-missing")] },
      byId,
      registry,
    );
    expect(blockers).toEqual([
      { id: "pm-closed", title: "Item pm-closed", status: "closed", resolved: true },
      { id: "pm-missing", title: null, status: null, resolved: true },
      { id: "pm-open", title: "Item pm-open", status: "open", resolved: false },
    ]);
  });
});

describe("computeActionabilityReport", () => {
  it("classifies ready leaves, excludes containers, and surfaces blocked leaves with downstream unblocks", () => {
    const epic = item({ id: "pm-epic", type: "Epic", status: "open" });
    const openChild = item({ id: "pm-child", parent: "pm-epic", status: "open", priority: 1 });
    const wip = item({ id: "pm-wip", status: "in_progress" });
    const blocker = item({ id: "pm-blocker", status: "open", priority: 0 });
    const blockee = item({ id: "pm-blockee", status: "open", dependencies: [blockedByDep("pm-blocker")] });
    const closedDownstream = item({ id: "pm-done", status: "closed", dependencies: [blockedByDep("pm-blocker")] });
    const corpus = [epic, openChild, wip, blocker, blockee, closedDownstream];

    const report = computeActionabilityReport(corpus, corpus, registry);
    const readyIds = report.ready.map((entry) => entry.item.id).sort();
    expect(readyIds).toEqual(["pm-blocker", "pm-child", "pm-wip"]);
    expect(report.ready.some((entry) => entry.item.id === "pm-epic")).toBe(false);
    expect(report.container_count).toBe(1);
    expect(report.active_count).toBe(5);

    const blockerEntry = report.ready.find((entry) => entry.item.id === "pm-blocker");
    // The closed downstream dependent is filtered out of unblocks; only the open one remains.
    expect(blockerEntry?.unblocks).toEqual(["pm-blockee"]);

    expect(report.blocked).toHaveLength(1);
    expect(report.blocked[0].item.id).toBe("pm-blockee");
    expect(report.blocked[0].open_blockers.map((blocked) => blocked.id)).toEqual(["pm-blocker"]);
  });

  it("treats a parent whose descendants are all terminal as a ready leaf and skips a missing/terminal blocker", () => {
    const parent = item({ id: "pm-parent", type: "Epic", status: "open" });
    const closedChild = item({ id: "pm-closed-child", parent: "pm-parent", status: "closed" });
    const resolvedBlockee = item({ id: "pm-resolved", status: "open", blocked_by: "pm-gone" });
    const corpus = [parent, closedChild, resolvedBlockee];

    const report = computeActionabilityReport(corpus, corpus, registry);
    expect(report.ready.map((entry) => entry.item.id).sort()).toEqual(["pm-parent", "pm-resolved"]);
    expect(report.blocked).toHaveLength(0);
    expect(report.container_count).toBe(0);
  });

  it("returns the downstream unblocks list sorted when an item gates several dependents", () => {
    const blocker = item({ id: "pm-blocker", status: "open" });
    const second = item({ id: "pm-d2", status: "open", dependencies: [blockedByDep("pm-blocker")] });
    const first = item({ id: "pm-d1", status: "open", dependencies: [blockedByDep("pm-blocker")] });
    const corpus = [blocker, second, first];

    const report = computeActionabilityReport(corpus, corpus, registry);
    const blockerEntry = report.ready.find((entry) => entry.item.id === "pm-blocker");
    expect(blockerEntry?.unblocks).toEqual(["pm-d1", "pm-d2"]);
  });

  it("skips non-active candidates and tolerates parent cycles", () => {
    const a = item({ id: "pm-a", parent: "pm-b", status: "open" });
    const b = item({ id: "pm-b", parent: "pm-a", status: "open" });
    const closed = item({ id: "pm-closed", status: "closed" });
    const corpus = [a, b, closed];

    const report = computeActionabilityReport(corpus, corpus, registry);
    // a and b are each other's open descendant via the cycle, so both are containers.
    expect(report.ready).toHaveLength(0);
    expect(report.container_count).toBe(2);
    expect(report.active_count).toBe(2);
  });
});
