import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  RelationshipEventLog,
  RelationshipEventStore,
  createRelationshipKindRegistry,
  type RelationshipEvent,
} from "../../../src/sdk/index.js";

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

/** Append one deterministic VCS relationship event for projection tests. */
function appendCommit(
  log: RelationshipEventLog,
  sequence: number,
  source: string,
  target: string,
): RelationshipEvent {
  return log.append({
    eventId: `event-${sequence}`,
    relationshipId: `commit-${sequence}`,
    action: "add",
    edge: { source, target, kind: "commits_to" },
    author: "projection-test",
    timestamp: `2026-07-18T00:00:0${sequence}.000Z`,
    expectedVersion: sequence - 1,
  });
}

describe("relationship event streaming and projection", () => {
  it("streams immutable bounded batches and folds an exact prefix", () => {
    const log = new RelationshipEventLog(["change-a", "change-b", "main"], {
      registry,
    });
    appendCommit(log, 1, "change-a", "main");
    appendCommit(log, 2, "change-b", "main");

    const batches = [...log.stream({ batchSize: 1 })];
    expect(batches.map((batch) => batch.map((event) => event.eventId))).toEqual([
      ["event-1"],
      ["event-2"],
    ]);
    expect(Object.isFrozen(batches[0])).toBe(true);

    const projection = log.project(
      [] as string[],
      (state, event) => [...state, event.edge?.source ?? "removed"],
      { toVersion: 1 },
    );
    expect(projection).toEqual({
      state: ["change-a"],
      version: 1,
      processed: 1,
      asOf: "2026-07-18T00:00:01.000Z",
    });
    expect(Object.isFrozen(projection)).toBe(true);
  });

  it("supports empty ranges and rejects invalid bounds and reducers", () => {
    expect(
      new RelationshipEventLog(["change-a", "main"], { registry }).project(
        "initial",
        (state) => state,
      ),
    ).toEqual({ state: "initial", version: 0, processed: 0 });
    const log = new RelationshipEventLog(["change-a", "main"], { registry });
    appendCommit(log, 1, "change-a", "main");

    expect(log.project({ count: 0 }, (state) => state, { fromVersion: 2 })).toEqual({
      state: { count: 0 },
      version: 1,
      processed: 0,
    });
    expect(() => [...log.stream({ fromVersion: 0 })]).toThrow(/fromVersion/);
    expect(() => [...log.stream({ toVersion: 2 })]).toThrow(/toVersion/);
    expect(() => [...log.stream({ batchSize: 0 })]).toThrow(/batchSize/);
    expect(() => [...log.stream({ fromVersion: 3 })]).toThrow(/selected prefix/);
    expect(() => log.project({}, null as never)).toThrow(/requires a reducer/);
  });

  it("streams and projects one coherent durable snapshot", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "pm-relationship-projection-"));
    const pmRoot = path.join(workspace, ".agents", "pm");
    const store = await RelationshipEventStore.open({
      pmRoot,
      nodes: ["change-a", "change-b", "main"],
      registry,
      relativePath: "relationships/vcs.jsonl",
    });
    await store.append({
      eventId: "event-1",
      relationshipId: "commit-1",
      action: "add",
      edge: { source: "change-a", target: "main", kind: "commits_to" },
      author: "projection-test",
      timestamp: "2026-07-18T00:00:01.000Z",
      expectedVersion: 0,
    });
    await store.append({
      eventId: "event-2",
      relationshipId: "commit-2",
      action: "add",
      edge: { source: "change-b", target: "main", kind: "commits_to" },
      author: "projection-test",
      timestamp: "2026-07-18T00:00:02.000Z",
      expectedVersion: 1,
    });

    const streamed: string[] = [];
    for await (const batch of store.stream({ batchSize: 1 })) {
      streamed.push(...batch.map((event) => event.relationshipId));
    }
    expect(streamed).toEqual(["commit-1", "commit-2"]);

    const projected = await store.project(0, (count) => count + 1);
    expect(projected).toMatchObject({ state: 2, version: 2, processed: 2 });
    expect(await readFile(store.path, "utf8")).toContain('"relationshipId":"commit-2"');
  });
});
