import { afterEach, describe, expect, it } from "vitest";
import { assembleWorkspaceRelationshipGraph } from "../../../../src/sdk/graph/assembly.js";
import {
  WorkspaceGraphCache,
  computeWorkspaceGraphFingerprint,
  resetWorkspaceGraphCache,
  workspaceGraphCache,
} from "../../../../src/sdk/graph/cache.js";
import { createRelationshipKindRegistry } from "../../../../src/sdk/relationships.js";

/** Minimal open item row accepted by fingerprinting and assembly. */
function item(
  id: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return { id, title: `Title ${id}`, status: "open", ...overrides };
}

describe("computeWorkspaceGraphFingerprint", () => {
  it("is order-independent and sensitive to every relationship-relevant field", () => {
    const base = [
      item("pm-a", {
        parent: "pm-b",
        blocked_by: "pm-c",
        dependencies: [{ id: "pm-b", kind: "related" }],
      }),
      item("pm-b"),
      item("pm-c"),
    ] as never;
    const reordered = [...(base as unknown[])].reverse() as never;
    expect(computeWorkspaceGraphFingerprint(base)).toBe(
      computeWorkspaceGraphFingerprint(reordered),
    );
    expect(
      computeWorkspaceGraphFingerprint([
        item("pm-a", {
          parent: "pm-b",
          blocked_by: "pm-c",
          dependencies: [
            { id: "pm-c", kind: "blocked_by" },
            { id: "pm-b", kind: "related" },
          ],
        }),
        item("pm-b"),
        item("pm-c"),
      ] as never),
    ).toBe(
      computeWorkspaceGraphFingerprint([
        item("pm-a", {
          parent: "pm-b",
          blocked_by: "pm-c",
          dependencies: [
            { id: "pm-b", kind: "related" },
            { id: "pm-c", kind: "blocked_by" },
          ],
        }),
        item("pm-b"),
        item("pm-c"),
      ] as never),
    );
    const variants = [
      [item("pm-a", { title: "Renamed" }), item("pm-b"), item("pm-c")],
      [item("pm-a", { status: "closed" }), item("pm-b"), item("pm-c")],
      [item("pm-a", { parent: "pm-c" }), item("pm-b"), item("pm-c")],
      [item("pm-a", { blocked_by: "pm-b" }), item("pm-b"), item("pm-c")],
      [
        item("pm-a", { dependencies: [{ id: "pm-c", kind: "blocked_by" }] }),
        item("pm-b"),
        item("pm-c"),
      ],
    ] as never[];
    const fingerprints = new Set(
      variants.map((variant) => computeWorkspaceGraphFingerprint(variant)),
    );
    fingerprints.add(computeWorkspaceGraphFingerprint(base));
    expect(fingerprints.size).toBe(variants.length + 1);
  });

  it("folds terminal classification in and ignores malformed rows and payloads", () => {
    const items = [
      item("pm-a", { status: "done" }),
      item("pm-b", {
        dependencies: [
          null,
          { id: 42, kind: 7 },
          { id: "pm-a", kind: "related" },
        ],
      }),
      { id: "   ", title: "Blank", status: "open" },
      { id: 9, title: "Numeric", status: "open" },
    ] as never;
    const defaultTerminal = computeWorkspaceGraphFingerprint(items);
    const customTerminal = computeWorkspaceGraphFingerprint(
      items,
      (status) => status === "done",
    );
    expect(defaultTerminal).not.toBe(customTerminal);
    // Malformed rows are excluded entirely, matching assembly's filter.
    expect(defaultTerminal).toBe(
      computeWorkspaceGraphFingerprint([
        item("pm-a", { status: "done" }),
        item("pm-b", {
          dependencies: [
            null,
            { id: 42, kind: 7 },
            { id: "pm-a", kind: "related" },
          ],
        }),
      ] as never),
    );
  });

  it("invalidates fingerprints when relationship-kind semantics change", () => {
    const items = [
      item("commit-a", {
        dependencies: [{ id: "commit-b", kind: "commits_to" }],
      }),
      item("commit-b"),
    ] as never;
    const sourceFirst = createRelationshipKindRegistry().register({
      kind: "commits_to",
      direction: "directed",
      ordering: true,
      precedence: "source_before_target",
      hierarchy: false,
      outgoing: "many",
      incoming: "many",
      lifecycle: "persistent",
      compatibilityVersion: 1,
      allowSelf: false,
    });
    const targetFirst = createRelationshipKindRegistry().register({
      ...sourceFirst.require("commits_to"),
      precedence: "target_before_source",
    });
    expect(
      computeWorkspaceGraphFingerprint(items, undefined, sourceFirst),
    ).not.toBe(computeWorkspaceGraphFingerprint(items, undefined, targetFirst));
  });
});

describe("WorkspaceGraphCache", () => {
  afterEach(() => {
    resetWorkspaceGraphCache();
  });

  it("reuses assemblies per fingerprint and memoizes cloned query results", () => {
    const cache = new WorkspaceGraphCache();
    const items = [item("pm-a"), item("pm-b")] as never;
    const fingerprint = computeWorkspaceGraphFingerprint(items);
    let builds = 0;
    const build = (): ReturnType<typeof assembleWorkspaceRelationshipGraph> => {
      builds += 1;
      return assembleWorkspaceRelationshipGraph(items);
    };
    const first = cache.lookup("/repo", fingerprint, build);
    expect(first.assemblyReused).toBe(false);
    expect(first.fingerprint).toBe(fingerprint);
    const second = cache.lookup("/repo", fingerprint, build);
    expect(second.assemblyReused).toBe(true);
    expect(second.assembly).toBe(first.assembly);
    expect(builds).toBe(1);

    let computes = 0;
    const compute = (): { rows: string[] } => {
      computes += 1;
      return { rows: ["pm-a"] };
    };
    const miss = second.memoize("query", compute);
    expect(miss.reused).toBe(false);
    miss.value.rows.push("mutated");
    const hit = second.memoize("query", compute);
    expect(hit.reused).toBe(true);
    // Stored state is isolated from both producer and consumer mutation.
    expect(hit.value).toEqual({ rows: ["pm-a"] });
    expect(computes).toBe(1);

    // A changed fingerprint atomically replaces the entry and its memo.
    const changed = cache.lookup("/repo", "other-fingerprint", build);
    expect(changed.assemblyReused).toBe(false);
    expect(changed.memoize("query", compute).reused).toBe(false);
    expect(builds).toBe(2);
  });

  it("evicts the least recently used memoized result at the per-workspace bound", () => {
    const cache = new WorkspaceGraphCache({ maxResultsPerWorkspace: 2 });
    const items = [item("pm-a")] as never;
    const lookup = cache.lookup(
      "/repo",
      computeWorkspaceGraphFingerprint(items),
      () => assembleWorkspaceRelationshipGraph(items),
    );
    expect(lookup.memoize("first", () => 1).reused).toBe(false);
    expect(lookup.memoize("second", () => 2).reused).toBe(false);
    // Touching "first" refreshes its recency, so inserting a third result
    // evicts "second" — genuine LRU, not first-inserted.
    expect(lookup.memoize("first", () => 0).reused).toBe(true);
    expect(lookup.memoize("third", () => 3).reused).toBe(false);
    expect(lookup.memoize("first", () => 0).reused).toBe(true);
    expect(lookup.memoize("second", () => 9)).toEqual({
      value: 9,
      reused: false,
    });
  });

  it("bounds retained workspaces with least-recently-used eviction", () => {
    const cache = new WorkspaceGraphCache({ maxWorkspaces: 2 });
    const items = [item("pm-a")] as never;
    const fingerprint = computeWorkspaceGraphFingerprint(items);
    const builds: string[] = [];
    const lookupFor = (key: string): boolean =>
      cache.lookup(key, fingerprint, () => {
        builds.push(key);
        return assembleWorkspaceRelationshipGraph(items);
      }).assemblyReused;
    expect(lookupFor("/alpha")).toBe(false);
    expect(lookupFor("/beta")).toBe(false);
    // Touching /alpha refreshes its recency, so a third workspace evicts
    // /beta while /alpha survives.
    expect(lookupFor("/alpha")).toBe(true);
    expect(lookupFor("/gamma")).toBe(false);
    expect(lookupFor("/alpha")).toBe(true);
    expect(lookupFor("/beta")).toBe(false);
    expect(builds).toEqual(["/alpha", "/beta", "/gamma", "/beta"]);
  });

  it("rejects invalid result bounds and clears through the shared instance", () => {
    expect(
      () => new WorkspaceGraphCache({ maxResultsPerWorkspace: 0 }),
    ).toThrow(/Invalid maxResultsPerWorkspace bound/);
    expect(() => new WorkspaceGraphCache({ maxWorkspaces: 1.5 })).toThrow(
      /Invalid maxWorkspaces bound/,
    );
    const items = [item("pm-a")] as never;
    const fingerprint = computeWorkspaceGraphFingerprint(items);
    const shared = workspaceGraphCache();
    shared.lookup("/repo", fingerprint, () =>
      assembleWorkspaceRelationshipGraph(items),
    );
    expect(
      shared.lookup("/repo", fingerprint, () => {
        throw new Error("must not rebuild");
      }).assemblyReused,
    ).toBe(true);
    resetWorkspaceGraphCache();
    expect(
      workspaceGraphCache().lookup("/repo", fingerprint, () =>
        assembleWorkspaceRelationshipGraph(items),
      ).assemblyReused,
    ).toBe(false);
  });
});
