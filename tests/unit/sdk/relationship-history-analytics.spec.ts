import { describe, expect, it, vi } from "vitest";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  RelationshipEventLog,
  RelationshipEventStore,
  RelationshipGraph,
  RelationshipKindRegistry,
  analyzeGraphImpact,
  analyzeKnowledgeGraph,
  analyzeRelationshipExecution,
  buildRelationshipContext,
  compareRelationshipSnapshots,
  createQueryFingerprint,
  createRelationshipKindRegistry,
  encodeQueryCursor,
} from "../../../src/sdk/index.js";

const nodes = ["design", "build", "test", "ship", "note"];

describe("relationship event history", () => {
  it("persists, reopens, and serializes concurrent relationship appends", async () => {
    const pmRoot = await mkdtemp(
      path.join(os.tmpdir(), "pm-relationship-store-"),
    );
    try {
      const first = await RelationshipEventStore.open({ pmRoot, nodes });
      const second = await RelationshipEventStore.open({ pmRoot, nodes });
      const freshRootStore = await RelationshipEventStore.open({
        pmRoot: path.join(pmRoot, "fresh-root"),
        nodes,
      });
      expect(await freshRootStore.currentVersion()).toBe(0);
      await Promise.all([
        first.append({
          eventId: "evt-store-1",
          relationshipId: "rel-store-1",
          action: "add",
          edge: { source: "build", target: "design", kind: "blocked_by" },
          author: "agent-a",
          timestamp: "2026-07-14T08:00:00.000Z",
          reason: "durable prerequisite",
        }),
        second.append({
          eventId: "evt-store-2",
          relationshipId: "rel-store-2",
          action: "add",
          edge: { source: "test", target: "build", kind: "blocked_by" },
          author: "agent-b",
          timestamp: "2026-07-14T08:01:00.000Z",
        }),
      ]);

      await second.append({
        eventId: "evt-store-3",
        relationshipId: "rel-store-1",
        action: "remove",
        author: "agent-b",
        timestamp: "2026-07-14T08:02:00.000Z",
      });
      expect(await first.currentVersion()).toBe(3);
      expect((await first.snapshot()).version).toBe(3);
      expect((await first.page({ limit: 1 })).version).toBe(3);
      const reopened = await RelationshipEventStore.open({ pmRoot, nodes });
      expect(await reopened.currentVersion()).toBe(3);
      expect((await reopened.snapshot()).edges).toHaveLength(1);
      expect(await reopened.page({ limit: 1 })).toMatchObject({
        version: 3,
        hasMore: true,
      });
      const raw = await readFile(reopened.path, "utf8");
      expect(raw.trim().split("\n")).toHaveLength(3);

      await writeFile(reopened.path, `${raw}{bad-json}\n`, "utf8");
      await expect(
        RelationshipEventStore.open({ pmRoot, nodes }),
      ).rejects.toThrow("relationship event JSONL");
      await writeFile(
        reopened.path,
        `${raw.replace('"sequence":1', '"sequence":2')}`,
        "utf8",
      );
      await expect(
        RelationshipEventStore.open({ pmRoot, nodes }),
      ).rejects.toThrow("relationship event sequence");
      await mkdir(path.join(pmRoot, "unreadable"));
      await expect(
        RelationshipEventStore.open({
          pmRoot,
          nodes,
          relativePath: "unreadable",
        }),
      ).rejects.toThrow();
      await expect(
        RelationshipEventStore.open({ pmRoot, nodes, relativePath: "." }),
      ).rejects.toThrow("must name a file");
      await expect(
        RelationshipEventStore.open({ pmRoot, nodes, relativePath: ".." }),
      ).rejects.toThrow("must stay within");
      await expect(
        RelationshipEventStore.open({
          pmRoot,
          nodes,
          relativePath: "../escape.jsonl",
        }),
      ).rejects.toThrow("must stay within");
      await expect(
        RelationshipEventStore.open({
          pmRoot,
          nodes,
          relativePath: path.resolve(pmRoot, "../absolute.jsonl"),
        }),
      ).rejects.toThrow("must stay within");
      const symlinkTarget = path.join(pmRoot, "symlink-target.jsonl");
      await writeFile(symlinkTarget, "");
      await symlink(symlinkTarget, path.join(pmRoot, "symlink-events.jsonl"));
      await expect(
        RelationshipEventStore.open({
          pmRoot,
          nodes,
          relativePath: "symlink-events.jsonl",
        }),
      ).rejects.toThrow("must not contain symbolic links");
      const rootLink = path.join(pmRoot, "root-link");
      await symlink(pmRoot, rootLink, "dir");
      await expect(
        RelationshipEventStore.open({ pmRoot: rootLink, nodes }),
      ).rejects.toThrow("tracker root must not be a symbolic link");
    } finally {
      await rm(pmRoot, { recursive: true, force: true });
    }
  });
  it("continues a durable cursor against its original snapshot after another writer appends", async () => {
    const pmRoot = await mkdtemp(
      path.join(os.tmpdir(), "pm-relationship-cursor-"),
    );
    try {
      const reader = await RelationshipEventStore.open({ pmRoot, nodes });
      const writer = await RelationshipEventStore.open({ pmRoot, nodes });
      await reader.append({
        eventId: "evt-cursor-1",
        relationshipId: "rel-cursor-1",
        action: "add",
        edge: { source: "build", target: "design", kind: "blocked_by" },
        author: "agent-a",
        timestamp: "2026-07-14T08:00:00.000Z",
      });
      await reader.append({
        eventId: "evt-cursor-2",
        relationshipId: "rel-cursor-2",
        action: "add",
        edge: { source: "test", target: "build", kind: "blocked_by" },
        author: "agent-a",
        timestamp: "2026-07-14T08:01:00.000Z",
      });
      const first = await reader.page({ limit: 1 });

      await writer.append({
        eventId: "evt-cursor-3",
        relationshipId: "rel-cursor-3",
        action: "add",
        edge: { source: "ship", target: "test", kind: "blocked_by" },
        author: "agent-b",
        timestamp: "2026-07-14T08:02:00.000Z",
      });

      await expect(
        reader.page({ limit: 1, cursor: first.nextCursor }),
      ).resolves.toMatchObject({
        version: 2,
        events: [expect.objectContaining({ eventId: "evt-cursor-2" })],
        hasMore: false,
      });
      await expect(reader.page({ limit: 3 })).resolves.toMatchObject({
        version: 3,
        hasMore: false,
      });
    } finally {
      await rm(pmRoot, { recursive: true, force: true });
    }
  });
  it("rejects a durable event path replaced by a symlink after open", async () => {
    const pmRoot = await mkdtemp(
      path.join(os.tmpdir(), "pm-relationship-swap-"),
    );
    const outsideRoot = await mkdtemp(
      path.join(os.tmpdir(), "pm-relationship-outside-"),
    );
    try {
      const store = await RelationshipEventStore.open({ pmRoot, nodes });
      await store.append({
        eventId: "evt-before-swap",
        relationshipId: "rel-before-swap",
        action: "add",
        edge: { source: "build", target: "design", kind: "blocked_by" },
        author: "agent-a",
        timestamp: "2026-07-14T08:00:00.000Z",
      });
      const outsideFile = path.join(outsideRoot, "outside.jsonl");
      await writeFile(outsideFile, "sentinel", "utf8");
      await rm(store.path);
      await symlink(outsideFile, store.path);

      await expect(store.currentVersion()).rejects.toThrow(
        "must not contain symbolic links",
      );
      await expect(store.snapshot()).rejects.toThrow(
        "must not contain symbolic links",
      );
      await expect(store.page({ limit: 1 })).rejects.toThrow(
        "must not contain symbolic links",
      );
      await expect(
        store.append({
          eventId: "evt-after-swap",
          relationshipId: "rel-after-swap",
          action: "add",
          edge: { source: "test", target: "build", kind: "blocked_by" },
          author: "agent-b",
          timestamp: "2026-07-14T08:01:00.000Z",
        }),
      ).rejects.toThrow("must not contain symbolic links");
      await expect(readFile(outsideFile, "utf8")).resolves.toBe("sentinel");
    } finally {
      await rm(pmRoot, { recursive: true, force: true });
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });
  it("appends attributable events and replays immutable snapshots", () => {
    const log = new RelationshipEventLog(nodes);
    const design = log.append({
      eventId: "evt-1",
      relationshipId: "rel-build-design",
      action: "add",
      edge: { source: "build", target: "design", kind: "blocked_by" },
      author: "planner",
      timestamp: "2026-07-14T08:00:00.000Z",
      expectedVersion: 0,
    });
    const test = log.append({
      eventId: "evt-2",
      relationshipId: "rel-test-build",
      action: "add",
      edge: { source: "test", target: "build", kind: "blocked_by" },
      author: "builder",
      timestamp: "2026-07-14T09:00:00.000Z",
      expectedVersion: 1,
    });
    log.append({
      eventId: "evt-3",
      relationshipId: "rel-test-build",
      action: "supersede",
      edge: { source: "ship", target: "test", kind: "blocked_by" },
      author: "release-agent",
      timestamp: "2026-07-14T10:00:00.000Z",
      expectedVersion: 2,
      reason: "replace the delivery edge",
    });
    log.append({
      eventId: "evt-4",
      relationshipId: "rel-build-design",
      action: "remove",
      author: "planner",
      timestamp: "2026-07-14T11:00:00.000Z",
      expectedVersion: 3,
    });

    expect(design).toMatchObject({ sequence: 1, action: "add" });
    expect(Object.isFrozen(design.edge)).toBe(true);
    expect(test.sequence).toBe(2);
    expect(log.version).toBe(4);
    expect(log.snapshot({ atVersion: 2 }).edges).toEqual([
      expect.objectContaining({ source: "build", target: "design" }),
      expect.objectContaining({ source: "test", target: "build" }),
    ]);
    expect(
      log.snapshot({ atTimestamp: "2026-07-14T10:30:00.000Z" }).edges,
    ).toEqual([
      expect.objectContaining({ source: "build", target: "design" }),
      expect.objectContaining({ source: "ship", target: "test" }),
    ]);
    expect(log.snapshot().edges).toEqual([
      expect.objectContaining({ source: "ship", target: "test" }),
    ]);
    expect(log.events()).toHaveLength(4);
  });

  it("paginates a stable event stream and rejects unsafe mutations", () => {
    const log = new RelationshipEventLog(nodes);
    log.append({
      eventId: "evt-a",
      relationshipId: "rel-a",
      action: "add",
      edge: { source: "build", target: "design", kind: "blocked_by" },
      author: "agent",
      timestamp: "2026-07-14T08:00:00.000Z",
    });
    log.append({
      eventId: "evt-b",
      relationshipId: "rel-b",
      action: "add",
      edge: { source: "test", target: "build", kind: "blocked_by" },
      author: "agent",
      timestamp: "2026-07-14T09:00:00.000Z",
    });
    const first = log.page({ limit: 1 });
    expect(first).toMatchObject({ version: 2, hasMore: true });
    expect(first.events.map(({ eventId }) => eventId)).toEqual(["evt-a"]);
    expect(
      log
        .page({ limit: 1, cursor: first.nextCursor })
        .events.map(({ eventId }) => eventId),
    ).toEqual(["evt-b"]);
    expect(() =>
      log.page({
        limit: 1,
        cursor: encodeQueryCursor(
          createQueryFingerprint("relationship-events", {
            order: "append-sequence",
          }),
          "evt-a",
          0,
          "99",
        ),
      }),
    ).toThrow("snapshot version is invalid");

    expect(() =>
      log.append({
        eventId: "evt-c",
        relationshipId: "rel-c",
        action: "add",
        edge: { source: "ship", target: "test", kind: "blocked_by" },
        author: "agent",
        timestamp: "bad timestamp",
        expectedVersion: 1,
      }),
    ).toThrow("version conflict");
    expect(() =>
      log.append({
        eventId: "evt-a",
        relationshipId: "rel-c",
        action: "add",
        edge: { source: "ship", target: "test", kind: "blocked_by" },
        author: "agent",
        timestamp: "bad timestamp",
      }),
    ).toThrow("event already exists");
    expect(() =>
      log.append({
        eventId: "evt-c",
        relationshipId: "missing",
        action: "remove",
        author: "agent",
        timestamp: "2026-07-14T10:00:00.000Z",
      }),
    ).toThrow("not active");
  });

  it("uses contiguous sequence prefixes for non-monotonic timestamp snapshots", () => {
    const log = new RelationshipEventLog(["a", "b", "c"]);
    log.append({
      eventId: "late-add",
      relationshipId: "relationship",
      action: "add",
      edge: { source: "a", target: "b", kind: "related" },
      author: "agent",
      timestamp: "2026-07-14T10:00:00.000Z",
    });
    log.append({
      eventId: "early-supersede",
      relationshipId: "relationship",
      action: "supersede",
      edge: { source: "a", target: "c", kind: "related" },
      author: "agent",
      timestamp: "2026-07-14T08:00:00.000Z",
    });
    expect(
      log.snapshot({ atTimestamp: "2026-07-14T09:00:00.000Z" }),
    ).toMatchObject({
      version: 2,
      edges: [{ source: "a", target: "c", kind: "related" }],
    });
    expect(
      log.snapshot({ atTimestamp: "2026-07-14T07:00:00.000Z" }),
    ).toMatchObject({ version: 0, edges: [] });
  });

  it("keeps append validation independent of active relationship count", () => {
    const registry = createRelationshipKindRegistry();
    const fanout = 100;
    const log = new RelationshipEventLog(
      [
        "root",
        ...Array.from({ length: fanout + 1 }, (_, index) => `n-${index}`),
      ],
      { registry },
    );
    for (let index = 0; index < fanout; index += 1)
      log.append({
        eventId: `event-${index}`,
        relationshipId: `relationship-${index}`,
        action: "add",
        edge: { source: "root", target: `n-${index}`, kind: "related" },
        author: "agent",
        timestamp: "2026-07-14T08:00:00.000Z",
      });
    const requireKind = vi.spyOn(registry, "require");
    log.append({
      eventId: "event-final",
      relationshipId: "relationship-final",
      action: "add",
      edge: { source: "root", target: `n-${fanout}`, kind: "related" },
      author: "agent",
      timestamp: "2026-07-14T08:00:00.000Z",
    });
    expect(requireKind.mock.calls.length).toBeLessThan(15);
    requireKind.mockRestore();
  });

  it("enforces registered cardinality and custom payload semantics", () => {
    const registry = new RelationshipKindRegistry([])
      .register({
        kind: "owns",
        inverse: "owned_by",
        direction: "directed",
        ordering: false,
        hierarchy: true,
        outgoing: "many",
        incoming: "one",
        lifecycle: "supersedable",
        compatibilityVersion: 1,
        allowSelf: false,
        payloadSchema: { type: "object" },
      })
      .register({
        kind: "leases",
        direction: "directed",
        ordering: false,
        hierarchy: false,
        outgoing: "many",
        incoming: "many",
        lifecycle: "persistent",
        compatibilityVersion: 1,
        allowSelf: false,
      });
    const log = new RelationshipEventLog(["company", "asset", "other"], {
      registry,
    });
    log.append({
      eventId: "lease-1",
      relationshipId: "lease-1",
      action: "add",
      edge: { source: "company", target: "other", kind: "leases" },
      author: "legal",
      timestamp: "2026-07-14T07:30:00.000Z",
    });
    log.append({
      eventId: "own-1",
      relationshipId: "ownership-1",
      action: "add",
      edge: {
        source: "company",
        target: "asset",
        kind: "owns",
        payload: { votingShare: 0.8 },
      },
      author: "legal",
      timestamp: "2026-07-14T08:00:00.000Z",
    });
    expect(
      log.append({
        eventId: "own-revise",
        relationshipId: "ownership-1",
        action: "supersede",
        edge: {
          source: "company",
          target: "asset",
          kind: "owns",
          payload: { votingShare: 0.9 },
        },
        author: "legal",
        timestamp: "2026-07-14T08:30:00.000Z",
      }).edge?.payload,
    ).toEqual({ votingShare: 0.9 });
    expect(() =>
      log.append({
        eventId: "own-2",
        relationshipId: "ownership-2",
        action: "add",
        edge: { source: "other", target: "asset", kind: "owns" },
        author: "legal",
        timestamp: "2026-07-14T09:00:00.000Z",
      }),
    ).toThrow("incoming cardinality");
  });

  it("rejects malformed event, snapshot, paging, duplicate, and cardinality inputs", () => {
    const log = new RelationshipEventLog(["a", "b", "c"]);
    const valid = {
      eventId: "event-1",
      relationshipId: "relationship-1",
      action: "add" as const,
      edge: { source: "a", target: "b", kind: "blocked_by" },
      author: "agent",
      timestamp: "2026-07-14T08:00:00.000Z",
    };
    expect(() => log.append({ ...valid, eventId: " " })).toThrow("eventId");
    expect(() => log.append({ ...valid, author: "" })).toThrow("author");
    expect(() => log.append({ ...valid, timestamp: "invalid" })).toThrow(
      "timestamp",
    );
    expect(() => log.append({ ...valid, action: "rewrite" as never })).toThrow(
      "Unknown relationship event action",
    );
    expect(() => log.append({ ...valid, edge: undefined })).toThrow(
      "requires an edge",
    );
    expect(() =>
      log.append({
        ...valid,
        edge: { source: 1 as never, target: "b", kind: "blocked_by" },
      }),
    ).toThrow("endpoint not found");
    expect(() =>
      log.append({
        ...valid,
        edge: { source: "a", target: false as never, kind: "blocked_by" },
      }),
    ).toThrow("endpoint not found");
    log.append(valid);
    expect(() => log.append({ ...valid, eventId: "event-2" })).toThrow(
      "already active",
    );
    expect(() =>
      log.append({
        ...valid,
        eventId: "event-2",
        relationshipId: "relationship-2",
      }),
    ).toThrow("edge already active");
    expect(() =>
      log.snapshot({ atVersion: 0, atTimestamp: valid.timestamp }),
    ).toThrow("one target");
    expect(() => log.snapshot({ atTimestamp: "invalid" })).toThrow("timestamp");
    expect(() => log.snapshot({ atVersion: 2 })).toThrow("out of range");
    expect(() => log.page({ limit: 0 })).toThrow("limit must be positive");
    expect(new RelationshipEventLog([]).snapshot()).not.toHaveProperty("asOf");

    const hierarchy = new RelationshipEventLog(["a", "b", "c"]);
    hierarchy.append({
      ...valid,
      edge: { source: "a", target: "b", kind: "parent" },
    });
    expect(() =>
      hierarchy.append({
        ...valid,
        eventId: "event-2",
        relationshipId: "relationship-2",
        edge: { source: "a", target: "c", kind: "parent" },
      }),
    ).toThrow("outgoing cardinality");
    hierarchy.append({
      ...valid,
      eventId: "event-3",
      action: "remove",
      edge: undefined,
    });
    expect(
      hierarchy.append({
        ...valid,
        eventId: "event-4",
        relationshipId: "relationship-2",
        edge: { source: "a", target: "c", kind: "parent" },
      }).edge,
    ).toMatchObject({ source: "a", target: "c", kind: "parent" });

    const undirected = new RelationshipEventLog(["a", "b"]);
    undirected.append({
      ...valid,
      edge: { source: "a", target: "b", kind: "related" },
    });
    expect(() =>
      undirected.append({
        ...valid,
        eventId: "event-2",
        relationshipId: "relationship-2",
        edge: { source: "b", target: "a", kind: "related" },
      }),
    ).toThrow("edge already active");
  });
});

describe("relationship graph analytics", () => {
  const graph = new RelationshipGraph(nodes, [
    { source: "build", target: "design", kind: "blocked_by" },
    { source: "test", target: "build", kind: "blocked_by" },
    { source: "ship", target: "test", kind: "blocked_by" },
    { source: "note", target: "build", kind: "related" },
  ]);

  it("derives exact execution layers, critical path, frontier, and depth", () => {
    expect(analyzeRelationshipExecution(graph)).toMatchObject({
      exact: true,
      acyclic: true,
      order: ["design", "note", "build", "test", "ship"],
      layers: [["design", "note"], ["build"], ["test"], ["ship"]],
      frontier: ["design", "note"],
      criticalPath: ["design", "build", "test", "ship"],
      criticalPathLength: 3,
      depth: { build: 1, design: 0, note: 0, ship: 3, test: 2 },
      cycles: [],
    });
  });

  it("reports ordering cycles separately from associative components", () => {
    const cyclic = new RelationshipGraph(
      ["a", "b", "c", "isolated"],
      [
        { source: "a", target: "b", kind: "blocked_by" },
        { source: "b", target: "a", kind: "blocked_by" },
        { source: "b", target: "c", kind: "related" },
      ],
    );
    expect(analyzeRelationshipExecution(cyclic)).toMatchObject({
      acyclic: false,
      cycles: [["a", "b"]],
    });
    expect(analyzeKnowledgeGraph(cyclic)).toMatchObject({
      components: [["a", "b", "c"], ["isolated"]],
      orphans: ["isolated"],
      hubs: [{ id: "b", degree: 2 }],
    });
  });

  it("keeps acyclic execution results valid when they lead into a cycle", () => {
    const cyclic = new RelationshipGraph(
      ["start", "a", "b"],
      [
        { source: "start", target: "a", kind: "blocks" },
        { source: "a", target: "b", kind: "blocks" },
        { source: "b", target: "a", kind: "blocks" },
      ],
    );
    expect(analyzeRelationshipExecution(cyclic)).toMatchObject({
      acyclic: false,
      order: ["start"],
      depth: { start: 0 },
      criticalPath: ["start"],
      cycles: [["a", "b"]],
    });
  });

  it("returns bounded impact with explainable paths", () => {
    const shortestPath = vi.spyOn(graph, "shortestPath");
    const impact = analyzeGraphImpact(graph, "design", {
      direction: "incoming",
      kinds: ["blocked_by"],
      limit: 2,
    });
    expect(impact).toMatchObject({
      root: "design",
      affected: [
        { id: "build", distance: 1, path: ["design", "build"] },
        { id: "test", distance: 2, path: ["design", "build", "test"] },
      ],
      exact: true,
      truncated: true,
    });
    expect(shortestPath).not.toHaveBeenCalled();
    shortestPath.mockRestore();
    expect(
      analyzeGraphImpact(graph, "design", {
        direction: "incoming",
        kinds: ["blocked_by"],
        maxDepth: 1,
      }),
    ).toMatchObject({
      affected: [{ id: "build", distance: 1 }],
      truncated: true,
    });
    const cycle = new RelationshipGraph(
      ["a", "b"],
      [
        { source: "a", target: "b", kind: "blocks" },
        { source: "b", target: "a", kind: "blocks" },
      ],
    );
    expect(analyzeGraphImpact(cycle, "a")).toMatchObject({
      affected: [{ id: "b", distance: 1, path: ["a", "b"] }],
      truncated: false,
    });
    expect(analyzeGraphImpact(cycle, "a", { maxDepth: 1 })).toMatchObject({
      affected: [{ id: "b" }],
      truncated: false,
    });
  });

  it("compares temporal snapshots without mutating either view", () => {
    const log = new RelationshipEventLog(nodes);
    log.append({
      eventId: "evt-1",
      relationshipId: "rel-1",
      action: "add",
      edge: { source: "build", target: "design", kind: "blocked_by" },
      author: "agent",
      timestamp: "2026-07-14T08:00:00.000Z",
    });
    const before = log.snapshot();
    log.append({
      eventId: "evt-2",
      relationshipId: "rel-2",
      action: "add",
      edge: { source: "test", target: "build", kind: "blocked_by" },
      author: "agent",
      timestamp: "2026-07-14T09:00:00.000Z",
    });
    expect(compareRelationshipSnapshots(before, log.snapshot())).toMatchObject({
      fromVersion: 1,
      toVersion: 2,
      added: [expect.objectContaining({ source: "test", target: "build" })],
      removed: [],
      unchangedCount: 1,
    });
    expect(before.edges).toHaveLength(1);
    log.append({
      eventId: "evt-3",
      relationshipId: "rel-1",
      action: "remove",
      author: "agent",
      timestamp: "2026-07-14T10:00:00.000Z",
    });
    expect(
      compareRelationshipSnapshots(
        log.snapshot({ atVersion: 2 }),
        log.snapshot(),
      ),
    ).toMatchObject({
      removed: [expect.objectContaining({ source: "build" })],
    });
    const payloadGraph = new RelationshipGraph(["a", "b"], []);
    expect(
      compareRelationshipSnapshots(
        {
          version: 1,
          graph: payloadGraph,
          edges: [
            {
              source: "a",
              target: "b",
              kind: "related",
              payload: {
                z: [null, { beta: 2, alpha: 1 }],
                a: true,
                when: new Date("2026-07-14T08:00:00.000Z"),
              },
            },
          ],
        },
        {
          version: 2,
          graph: payloadGraph,
          edges: [
            {
              kind: "related",
              target: "b",
              source: "a",
              payload: {
                when: "2026-07-14T08:00:00.000Z",
                a: true,
                z: [null, { alpha: 1, beta: 2 }],
              },
            },
          ],
        },
      ),
    ).toMatchObject({ added: [], removed: [], unchangedCount: 1 });
  });

  it("covers empty graphs and deterministic equal-depth execution ties", () => {
    expect(analyzeRelationshipExecution(new RelationshipGraph([], []))).toEqual(
      {
        exact: true,
        acyclic: true,
        order: [],
        layers: [],
        frontier: [],
        depth: {},
        criticalPath: [],
        criticalPathLength: 0,
        cycles: [],
        provenance: { algorithm: "kahn-longest-path", edgeFamily: "ordering" },
      },
    );
    const registry = createRelationshipKindRegistry().register({
      kind: "precedes_default",
      direction: "directed",
      ordering: true,
      hierarchy: false,
      outgoing: "many",
      incoming: "many",
      lifecycle: "persistent",
      compatibilityVersion: 1,
      allowSelf: false,
    });
    const diamond = new RelationshipGraph(
      ["a", "b", "c", "d"],
      [
        { source: "a", target: "b", kind: "precedes_default" },
        { source: "a", target: "c", kind: "precedes_default" },
        { source: "b", target: "d", kind: "precedes_default" },
        { source: "c", target: "d", kind: "precedes_default" },
      ],
      registry,
    );
    expect(analyzeRelationshipExecution(diamond, { registry })).toMatchObject({
      criticalPath: ["a", "b", "d"],
      depth: { a: 0, b: 1, c: 1, d: 2 },
    });
    expect(analyzeKnowledgeGraph(diamond).components).toEqual([
      ["a", "b", "c", "d"],
    ]);
    expect(
      analyzeKnowledgeGraph(
        new RelationshipGraph(
          ["a", "b", "c"],
          [
            { source: "a", target: "b", kind: "discovered_from" },
            { source: "a", target: "c", kind: "discovered_from" },
            { source: "b", target: "c", kind: "discovered_from" },
          ],
        ),
      ).stronglyConnected,
    ).toEqual([["a"], ["b"], ["c"]]);
  });
});

describe("bounded relationship context", () => {
  const graph = new RelationshipGraph(nodes, [
    { source: "build", target: "design", kind: "blocked_by" },
    { source: "test", target: "build", kind: "blocked_by" },
    { source: "ship", target: "test", kind: "blocked_by" },
    { source: "note", target: "build", kind: "discovered_from" },
  ]);
  const details = nodes.map((id) => ({
    id,
    title: id.toUpperCase(),
    status: id === "design" ? "closed" : "open",
    evidence: id === "build" ? ["src/build.ts", "test:build"] : [],
  }));

  it("joins lineage, impact, reasons, evidence, and bounded cost in one call", () => {
    const result = buildRelationshipContext(graph, "build", details, {
      direction: "both",
      maxDepth: 2,
      nodeLimit: 3,
      edgeLimit: 4,
      tokenBudget: 220,
    });
    expect(result.root).toMatchObject({ id: "build", title: "BUILD" });
    expect(result.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "design",
          distance: 1,
          reasons: expect.arrayContaining(["prerequisite"]),
        }),
        expect.objectContaining({
          id: "test",
          distance: 1,
          reasons: expect.arrayContaining(["dependent"]),
        }),
      ]),
    );
    expect(result.evidence).toEqual(["src/build.ts", "test:build"]);
    expect(result.meta).toMatchObject({
      exact: true,
      nodeLimit: 3,
      edgeLimit: 4,
      tokenBudget: 220,
    });
    expect(result.meta.usedTokens).toBeLessThanOrEqual(220);
    expect(result.summary).toMatchObject({
      rootId: "build",
      rootStatus: "open",
      directEdges: {
        prerequisite: 1,
        dependent: 1,
        ancestor: 0,
        descendant: 0,
        provenance: 1,
        related: 0,
      },
      directTotal: 3,
      evidenceCount: 2,
    });
    expect(result.summary.returnedNodes).toBe(result.nodes.length);
    expect(result.summary.returnedEdges).toBe(result.edges.length);
    expect(result.summary.hasMore).toBe("nextCursor" in result.meta);
  });

  it("ranks multi-family nodes by deterministic role priority and reports completeness", () => {
    const multi = new RelationshipGraph(
      ["root", "peer"],
      [
        { source: "root", target: "peer", kind: "blocked_by" },
        { source: "root", target: "peer", kind: "related" },
      ],
    );
    const complete = buildRelationshipContext(multi, "root", []);
    expect(complete.nodes).toEqual([
      expect.objectContaining({
        id: "peer",
        role: "prerequisite",
        via: "root",
        reasons: ["prerequisite", "related"],
      }),
    ]);
    expect(complete.meta.completeness).toBe("complete");
    expect(complete.summary).toMatchObject({
      directEdges: expect.objectContaining({ prerequisite: 1, related: 1 }),
      directTotal: 2,
      discoveredNodes: 1,
      hasMore: false,
    });
    const filtered = buildRelationshipContext(multi, "root", [], {
      kinds: ["blocked_by"],
    });
    expect(filtered.nodes[0]?.reasons).toEqual(["prerequisite"]);
    expect(filtered.edges).toEqual([
      { source: "root", target: "peer", kind: "blocked_by" },
    ]);
    expect(filtered.summary).toMatchObject({
      returnedEdges: 1,
      omittedEdges: 0,
    });
    expect(
      buildRelationshipContext(multi, "root", [], {
        kinds: ["blocks"],
      }).edges,
    ).toEqual([{ source: "root", target: "peer", kind: "blocked_by" }]);
    const truncated = buildRelationshipContext(graph, "build", details, {
      direction: "both",
      maxDepth: 3,
      nodeLimit: 1,
      tokenBudget: 500,
    });
    expect(truncated.meta.completeness).toBe("truncated");
    expect(truncated.summary.hasMore).toBe(true);
    expect(truncated.summary.omittedNodes).toBeGreaterThan(0);
  });

  it("stops inspecting boundary nodes after depth truncation is established", () => {
    const boundary = new RelationshipGraph(
      ["root", "a", "b", "deep-a", "deep-b"],
      [
        { source: "root", target: "a", kind: "blocks" },
        { source: "root", target: "b", kind: "blocks" },
        { source: "a", target: "deep-a", kind: "blocks" },
        { source: "b", target: "deep-b", kind: "blocks" },
      ],
    );
    const neighborEdges = vi.spyOn(boundary, "neighborEdges");
    const result = buildRelationshipContext(boundary, "root", [], {
      direction: "outgoing",
      maxDepth: 1,
      nodeLimit: 10,
      edgeLimit: 10,
      tokenBudget: 1000,
    });
    expect(result.meta).toMatchObject({
      truncated: true,
      completeness: "truncated",
      visitedNodes: 3,
      inspectedEdges: 3,
    });
    // One traversal call for the root plus one boundary probe: after the first
    // depth-limit node establishes truncation, remaining boundary nodes skip.
    expect(neighborEdges.mock.calls.filter(([id]) => id !== "root").length).toBe(1);
    neighborEdges.mockRestore();
  });

  it("continues deterministically and rejects a cursor from another query", () => {
    const first = buildRelationshipContext(graph, "build", details, {
      direction: "both",
      maxDepth: 3,
      nodeLimit: 1,
      tokenBudget: 500,
    });
    expect(first.meta.truncated).toBe(true);
    expect(first.meta.nextCursor).toBeTypeOf("string");
    const second = buildRelationshipContext(graph, "build", details, {
      direction: "both",
      maxDepth: 3,
      nodeLimit: 1,
      tokenBudget: 500,
      cursor: first.meta.nextCursor,
    });
    expect(second.nodes[0]?.id).not.toBe(first.nodes[0]?.id);
    expect(() =>
      buildRelationshipContext(graph, "ship", details, {
        cursor: first.meta.nextCursor,
      }),
    ).toThrow("does not match");
  });

  it("honors custom precedence instead of inferring semantics from labels", () => {
    const registry = createRelationshipKindRegistry().register({
      kind: "precedes",
      direction: "directed",
      ordering: true,
      hierarchy: false,
      outgoing: "many",
      incoming: "many",
      lifecycle: "persistent",
      compatibilityVersion: 1,
      allowSelf: false,
    });
    const custom = new RelationshipGraph(
      ["draft", "review", "publish"],
      [
        { source: "draft", target: "review", kind: "precedes" },
        { source: "review", target: "publish", kind: "precedes" },
      ],
      registry,
    );
    expect(analyzeRelationshipExecution(custom, { registry }).order).toEqual([
      "draft",
      "review",
      "publish",
    ]);
    expect(
      buildRelationshipContext(custom, "draft", [], { registry }).nodes[0],
    ).toMatchObject({ id: "review", reasons: ["dependent"] });
  });

  it("explains custom hierarchy direction independently from kind labels", () => {
    const registry = createRelationshipKindRegistry().register({
      kind: "owns",
      direction: "directed",
      ordering: false,
      hierarchy: true,
      outgoing: "many",
      incoming: "one",
      lifecycle: "persistent",
      compatibilityVersion: 1,
      allowSelf: false,
    });
    const ownership = new RelationshipGraph(
      ["company", "asset"],
      [{ source: "company", target: "asset", kind: "owns" }],
      registry,
    );
    expect(
      buildRelationshipContext(ownership, "company", [], { registry }).nodes[0],
    ).toMatchObject({ id: "asset", reasons: ["descendant"] });
    expect(
      buildRelationshipContext(ownership, "asset", [], { registry }).nodes[0],
    ).toMatchObject({ id: "company", reasons: ["ancestor"] });
  });

  it("explains hierarchy, provenance, association, and deeper reachability", () => {
    const semantic = new RelationshipGraph(
      ["root", "parent", "child", "origin", "incident", "peer", "deep"],
      [
        { source: "root", target: "parent", kind: "parent" },
        { source: "child", target: "root", kind: "parent" },
        { source: "root", target: "origin", kind: "discovered_from" },
        { source: "root", target: "incident", kind: "incident_from" },
        { source: "root", target: "peer", kind: "related" },
        { source: "peer", target: "deep", kind: "related" },
      ],
    );
    const result = buildRelationshipContext(semantic, "root", [], {
      maxDepth: 2,
      nodeLimit: 10,
      edgeLimit: 10,
      tokenBudget: 1000,
    });
    expect(result.root).toEqual({ id: "root" });
    expect(result.evidence).toEqual([]);
    expect(result.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "parent", reasons: ["ancestor"] }),
        expect.objectContaining({ id: "child", reasons: ["descendant"] }),
        expect.objectContaining({ id: "origin", reasons: ["provenance"] }),
        expect.objectContaining({ id: "incident", reasons: ["provenance"] }),
        expect.objectContaining({ id: "peer", reasons: ["related"] }),
        expect.objectContaining({
          id: "deep",
          role: "related",
          via: "peer",
          reasons: ["related via peer (depth 2)"],
        }),
      ]),
    );
    expect(result.meta.truncated).toBe(false);
    expect(result.meta).not.toHaveProperty("nextCursor");
  });

  it("validates bounds, cancellation, missing roots, and truncation causes", () => {
    const chain = new RelationshipGraph(
      ["a", "b", "c"],
      [
        { source: "a", target: "b", kind: "related" },
        { source: "b", target: "c", kind: "related" },
      ],
    );
    expect(() => buildRelationshipContext(chain, "missing", [])).toThrow(
      "node not found",
    );
    expect(() =>
      buildRelationshipContext(chain, "a", [], { nodeLimit: 0 }),
    ).toThrow("nodeLimit must be positive");
    expect(() =>
      buildRelationshipContext(chain, "a", [], { maxDepth: -1 }),
    ).toThrow("maxDepth must be non-negative");
    expect(
      buildRelationshipContext(chain, "a", [], {
        maxDepth: 0,
        tokenBudget: 100,
      }).meta.truncated,
    ).toBe(true);
    expect(() =>
      buildRelationshipContext(chain, "a", [], { tokenBudget: 10 }),
    ).toThrow("cannot fit one node");
    expect(() =>
      buildRelationshipContext(
        chain,
        "a",
        [{ id: "a", evidence: ["x".repeat(100)] }],
        { tokenBudget: 10 },
      ),
    ).toThrow("cannot fit root and evidence");
    expect(
      buildRelationshipContext(chain, "b", [], {
        edgeLimit: 1,
        tokenBudget: 1000,
      }).meta.omittedEdges,
    ).toBeGreaterThan(0);
    expect(
      buildRelationshipContext(
        new RelationshipGraph(
          ["a", "b"],
          [{ source: "a", target: "b", kind: "related" }],
        ),
        "a",
        [],
        { tokenBudget: 25 },
      ).meta.omittedEdges,
    ).toBe(1);
    const controller = new AbortController();
    controller.abort();
    expect(() =>
      buildRelationshipContext(chain, "a", [], { signal: controller.signal }),
    ).toThrow();
    expect(
      buildRelationshipContext(new RelationshipGraph(["solo"], []), "solo", [])
        .meta.truncated,
    ).toBe(false);
    const evidenceRoot = { id: "solo", evidence: ["proof"] };
    const evidenceResult = buildRelationshipContext(
      new RelationshipGraph(["solo"], []),
      "solo",
      [evidenceRoot],
    );
    expect(evidenceResult.root).toEqual({ id: "solo" });
    expect(evidenceResult.evidence).toEqual(["proof"]);
    expect(evidenceResult.meta.usedTokens).toBe(
      Math.max(
        1,
        Math.ceil(
          new TextEncoder().encode(JSON.stringify({ id: "solo" })).byteLength /
            4,
        ),
      ) +
        Math.max(
          1,
          Math.ceil(
            new TextEncoder().encode(JSON.stringify(["proof"])).byteLength / 4,
          ),
        ),
    );
  });
});
