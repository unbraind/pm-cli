import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import * as fsUtils from "../../../src/core/fs/fs-utils.js";
import {
  RelationshipEventStore,
  createRelationshipKindRegistry,
  planRelationshipEventBackfill,
} from "../../../src/sdk/index.js";

const migrationTimestamp = "2026-07-21T20:45:00.000Z";

describe("relationship event migration", () => {
  it("plans deterministic legacy and custom-kind events with governance evidence", () => {
    const registry = createRelationshipKindRegistry().register({
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
    const items = [
      {
        id: "roadmap",
        title: "Roadmap",
        type: "Plan",
        status: "open" as const,
      },
      {
        id: "change",
        title: "Change",
        type: "Task",
        status: "open" as const,
        parent: "roadmap",
        blocked_by: "missing-review",
        dependencies: [
          { id: "roadmap", kind: "commits_to" },
          { id: "roadmap", kind: "commits_to" },
          {
            id: "upstream/repository#42",
            kind: "related",
            source_kind: "global",
          },
        ],
      },
    ];
    const options = {
      author: "migration-agent",
      migrationId: "legacy-v1",
      registry,
      timestamp: migrationTimestamp,
    };

    const first = planRelationshipEventBackfill(items, options);
    const second = planRelationshipEventBackfill([...items].reverse(), options);

    expect(first).toEqual(second);
    expect(first.nodes).toEqual([
      "change",
      "missing-review",
      "roadmap",
      "upstream/repository#42",
    ]);
    expect(first.events.map((event) => event.edge?.kind)).toEqual([
      "blocked_by",
      "commits_to",
      "parent",
      "related",
    ]);
    expect(new Set(first.events.map((event) => event.eventId)).size).toBe(4);
    expect(first).toMatchObject({
      migration_id: "legacy-v1",
      edge_count: 4,
      skipped_existing_count: 0,
      duplicate_dependency_rows: 1,
      dangling_reference_count: 1,
    });
    expect(first.fingerprint).toMatch(/^[a-f\d]{64}$/);

    const resumed = planRelationshipEventBackfill(items, {
      ...options,
      existingEventIds: first.events.slice(0, 2).map((event) => event.eventId),
    });
    expect(resumed.events).toEqual(first.events.slice(2));
    expect(resumed.skipped_existing_count).toBe(2);
    expect(() =>
      planRelationshipEventBackfill(items, { ...options, migrationId: " " }),
    ).toThrow(/migrationId/);
    expect(() =>
      planRelationshipEventBackfill(items, { ...options, timestamp: "invalid" }),
    ).toThrow(/timestamp/);
  });

  it("commits a validated batch atomically and leaves the stream untouched on failure", async () => {
    const pmRoot = await mkdtemp(path.join(os.tmpdir(), "pm-relationship-batch-"));
    onTestFinished(() => rm(pmRoot, { recursive: true, force: true }));
    const store = await RelationshipEventStore.open({
      pmRoot,
      nodes: ["a", "b", "c"],
    });
    const first = await store.appendBatch([
      {
        eventId: "event-1",
        relationshipId: "relationship-1",
        action: "add",
        edge: { source: "a", target: "b", kind: "related" },
        author: "migration-agent",
        timestamp: migrationTimestamp,
        expectedVersion: 0,
      },
      {
        eventId: "event-2",
        relationshipId: "relationship-2",
        action: "add",
        edge: { source: "b", target: "c", kind: "related" },
        author: "migration-agent",
        timestamp: migrationTimestamp,
        expectedVersion: 1,
      },
    ]);
    expect(first).toMatchObject({
      version_before: 0,
      version_after: 2,
      skipped_event_ids: [],
    });
    expect(first.appended).toHaveLength(2);
    const beforeFailure = await readFile(store.path, "utf8");

    await expect(
      store.appendBatch([
        {
          eventId: "event-3",
          relationshipId: "relationship-3",
          action: "add",
          edge: { source: "c", target: "a", kind: "related" },
          author: "migration-agent",
          timestamp: migrationTimestamp,
        },
        {
          eventId: "event-4",
          relationshipId: "relationship-4",
          action: "add",
          edge: { source: "missing", target: "a", kind: "related" },
          author: "migration-agent",
          timestamp: migrationTimestamp,
        },
      ]),
    ).rejects.toThrow(/endpoint not found/);
    expect(await readFile(store.path, "utf8")).toBe(beforeFailure);
    expect(await store.currentVersion()).toBe(2);

    const write = vi
      .spyOn(fsUtils, "writeFileAtomic")
      .mockRejectedValueOnce(new Error("simulated atomic write failure"));
    await expect(
      store.appendBatch([
        {
          eventId: "event-5",
          relationshipId: "relationship-5",
          action: "add",
          edge: { source: "c", target: "a", kind: "related" },
          author: "migration-agent",
          timestamp: migrationTimestamp,
        },
      ]),
    ).rejects.toThrow(/simulated atomic write failure/);
    write.mockRestore();
    expect(await readFile(store.path, "utf8")).toBe(beforeFailure);
    expect(await store.currentVersion()).toBe(2);

    await expect(
      store.appendBatch([
        {
          eventId: "event-1",
          relationshipId: "relationship-1",
          action: "add",
          edge: { source: "a", target: "b", kind: "related" },
          author: "migration-agent",
          timestamp: migrationTimestamp,
        },
      ]),
    ).rejects.toThrow(/event already exists/);

    await writeFile(store.path, beforeFailure.trimEnd(), "utf8");
    await store.appendBatch([
      {
        eventId: "event-6",
        relationshipId: "relationship-6",
        action: "add",
        edge: { source: "c", target: "a", kind: "related" },
        author: "migration-agent",
        timestamp: migrationTimestamp,
      },
    ]);
    expect((await readFile(store.path, "utf8")).trim().split("\n")).toHaveLength(3);
  });

  it("resumes concurrent deterministic backfills but rejects event-id collisions", async () => {
    const pmRoot = await mkdtemp(path.join(os.tmpdir(), "pm-relationship-resume-"));
    onTestFinished(() => rm(pmRoot, { recursive: true, force: true }));
    const items = [
      { id: "a", title: "A", status: "open" as const },
      {
        id: "b",
        title: "B",
        status: "open" as const,
        dependencies: [{ id: "a", kind: "related" }],
      },
    ];
    const plan = planRelationshipEventBackfill(items, {
      author: "migration-agent",
      migrationId: "resume-v1",
      timestamp: migrationTimestamp,
    });
    const first = await RelationshipEventStore.open({
      pmRoot,
      nodes: plan.nodes,
    });
    const second = await RelationshipEventStore.open({
      pmRoot,
      nodes: plan.nodes,
    });

    await first.appendBatch(plan.events);
    const originalEdge = plan.events[0]!.edge!;
    const resumed = await second.appendBatch(
      [
        {
          ...plan.events[0]!,
          edge: {
            kind: originalEdge.kind,
            target: originalEdge.target,
            source: originalEdge.source,
          },
        },
      ],
      { existingEventPolicy: "skip_identical" },
    );
    expect(resumed).toMatchObject({
      version_before: 1,
      version_after: 1,
      appended: [],
      skipped_event_ids: [plan.events[0]!.eventId],
    });
    const removal = {
      eventId: "resume-removal",
      relationshipId: plan.events[0]!.relationshipId,
      action: "remove" as const,
      author: "migration-agent",
      timestamp: migrationTimestamp,
    };
    await first.appendBatch([removal]);
    const resumedRemoval = await second.appendBatch([removal], {
      existingEventPolicy: "skip_identical",
    });
    expect(resumedRemoval.skipped_event_ids).toEqual([removal.eventId]);
    await expect(
      second.appendBatch(
        [{ ...plan.events[0]!, author: "different-agent" }],
        { existingEventPolicy: "skip_identical" },
      ),
    ).rejects.toThrow(/event id collision/);
  });

  it("migrates ten thousand edges with one durable batch publication", async () => {
    const pmRoot = await mkdtemp(path.join(os.tmpdir(), "pm-relationship-scale-"));
    onTestFinished(() => rm(pmRoot, { recursive: true, force: true }));
    const items = Array.from({ length: 10_001 }, (_, index) => ({
      id: `item-${index.toString().padStart(5, "0")}`,
      title: `Item ${index}`,
      status: "open" as const,
      ...(index === 0
        ? {}
        : {
            dependencies: [
              {
                id: `item-${(index - 1).toString().padStart(5, "0")}`,
                kind: "blocked_by",
              },
            ],
          }),
    }));
    const plan = planRelationshipEventBackfill(items, {
      author: "scale-agent",
      migrationId: "scale-10k",
      timestamp: migrationTimestamp,
    });
    expect(plan.edge_count).toBe(10_000);
    const store = await RelationshipEventStore.open({
      pmRoot,
      nodes: plan.nodes,
    });
    const result = await store.appendBatch(plan.events);
    expect(result.version_after).toBe(10_000);
    expect((await store.snapshot()).edges).toHaveLength(10_000);
  }, 30_000);
});
