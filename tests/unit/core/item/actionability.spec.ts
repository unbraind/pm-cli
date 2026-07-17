import { describe, expect, it } from "vitest";
import {
  collectBlockedByIds,
  collectDependencyBlockedIds,
  computeActionabilityReport,
  resolveItemBlockers,
} from "../../../../src/core/item/actionability.js";
import { resolveRuntimeStatusRegistry } from "../../../../src/core/schema/runtime-schema.js";
import type { Dependency, ItemMetadata, ItemType } from "../../../../src/types/index.js";

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

function item(overrides: ItemOverrides): ItemMetadata {
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
  } as ItemMetadata;
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

  it("ignores the retired no-active-blocker sentinel in scalar and edge forms", () => {
    expect(
      collectBlockedByIds({
        blocked_by: " NO-ACTIVE-BLOCKER ",
        dependencies: [blockedByDep("no-active-blocker")],
      }),
    ).toEqual([]);
  });
});
describe("resolveItemBlockers", () => {
  it("keeps missing and non-terminal blockers unresolved while resolving terminal blockers", () => {
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
      { id: "pm-missing", title: null, status: null, resolved: false },
      { id: "pm-open", title: "Item pm-open", status: "open", resolved: false },
    ]);
  });
});

describe("collectDependencyBlockedIds", () => {
  it("unifies lifecycle and open-edge blocking while ignoring resolved and terminal work", () => {
    const openBlocker = item({ id: "pm-open-blocker", status: "open" });
    const closedBlocker = item({ id: "pm-closed-blocker", status: "closed" });
    const edgeBlocked = item({
      id: "PM-EDGE-BLOCKED",
      dependencies: [blockedByDep("PM-open-blocker")],
    });
    const resolved = item({
      id: "pm-resolved",
      dependencies: [blockedByDep("pm-closed-blocker")],
    });
    const lifecycleBlocked = item({ id: "pm-status-blocked", status: "blocked" });
    const terminal = item({
      id: "pm-terminal",
      status: "closed",
      dependencies: [blockedByDep("pm-open-blocker")],
    });
    expect(
      [...collectDependencyBlockedIds(
        [openBlocker, closedBlocker, edgeBlocked, resolved, lifecycleBlocked, terminal],
        registry,
      )].sort(),
    ).toEqual(["pm-edge-blocked", "pm-status-blocked"]);
  });

  it("does not classify an active item with only a retired blocker sentinel as blocked", () => {
    const sentinel = item({ id: "pm-sentinel", blocked_by: "no-active-blocker" });
    expect([...collectDependencyBlockedIds([sentinel], registry)]).toEqual([]);
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

  it("treats a parent whose descendants are terminal as ready but keeps a missing blocker blocked", () => {
    const parent = item({ id: "pm-parent", type: "Epic", status: "open" });
    const closedChild = item({ id: "pm-closed-child", parent: "pm-parent", status: "closed" });
    const resolvedBlockee = item({ id: "pm-resolved", status: "open", blocked_by: "pm-gone" });
    const corpus = [parent, closedChild, resolvedBlockee];

    const report = computeActionabilityReport(corpus, corpus, registry);
    expect(report.ready.map((entry) => entry.item.id)).toEqual(["pm-parent"]);
    expect(report.blocked.map((entry) => entry.item.id)).toEqual(["pm-resolved"]);
    expect(report.container_count).toBe(0);
  });

  it("resolves blockers, parent containment, and unblocks case-insensitively", () => {
    const epic = item({ id: "pm-EPIC", type: "Epic", status: "open" });
    const child = item({ id: "pm-CHILD", parent: "pm-epic", status: "open" });
    const blocker = item({ id: "pm-BLK", status: "open" });
    const blockee = item({ id: "pm-DEP", status: "open", dependencies: [blockedByDep("PM-blk")] });
    const corpus = [epic, child, blocker, blockee];

    const report = computeActionabilityReport(corpus, corpus, registry);
    // pm-EPIC is a container via its mixed-case child link; pm-CHILD and pm-BLK are ready.
    expect(report.ready.map((entry) => entry.item.id).sort()).toEqual(["pm-BLK", "pm-CHILD"]);
    // pm-DEP is blocked by pm-BLK even though it references it as "PM-blk".
    expect(report.blocked.map((entry) => entry.item.id)).toEqual(["pm-DEP"]);
    expect(report.blocked[0].open_blockers[0].id).toBe("PM-blk");
    expect(report.ready.find((entry) => entry.item.id === "pm-BLK")?.unblocks).toEqual(["pm-DEP"]);
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
