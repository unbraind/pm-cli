import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildContextSignalSnapshot,
  ContextSignalStore,
  JsonFileContextSignalStoreAdapter,
  parseContextSignalSnapshot,
  resolveRuntimeStatusRegistry,
  type ContextSignalSnapshot,
  type ContextSignalStoreAdapter,
} from "../../../src/sdk/index.js";
import { SETTINGS_DEFAULTS } from "../../../src/core/shared/constants.js";
import type { ItemMetadata } from "../../../src/types/index.js";

const tempRoots: string[] = [];
const statusRegistry = resolveRuntimeStatusRegistry(SETTINGS_DEFAULTS.schema);
const now = "2026-07-21T12:00:00.000Z";

function item(id: string, overrides: Partial<ItemMetadata> = {}): ItemMetadata {
  return {
    id,
    title: id,
    description: `${id} description`,
    type: "Task",
    status: "open",
    priority: 2,
    tags: [],
    created_at: "2026-07-20T00:00:00.000Z",
    updated_at: "2026-07-20T00:00:00.000Z",
    ...overrides,
  };
}

class MemoryAdapter implements ContextSignalStoreAdapter {
  value: unknown | null = null;
  writes = 0;
  throwOnRead = false;
  throwOnWrite = false;

  async read(): Promise<unknown | null> {
    if (this.throwOnRead) {
      throw new SyntaxError("corrupt snapshot");
    }
    return this.value;
  }

  async write(snapshot: ContextSignalSnapshot): Promise<void> {
    if (this.throwOnWrite) {
      throw new Error("read-only adapter");
    }
    this.writes += 1;
    this.value = structuredClone(snapshot);
  }
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("context signal feature store", () => {
  it("builds deterministic sorted snapshots with every index-provided signal family", () => {
    const snapshot = buildContextSignalSnapshot(
      [item("pm-b"), item("pm-a", { assignee: "agent" })],
      {
        statusRegistry,
        now,
        author: "agent",
        source: "derived_index",
        sourceCursor: "history:abc",
        activityDensity: { "pm-a": 0.1 },
        graphProximity: { "pm-a": 0.2 },
        claimFocus: { "pm-a": 0.3 },
        knowledgeDensity: { "pm-a": 0.4 },
        authorAffinity: { "pm-a": 0.5 },
        usageAffinity: { "pm-a": 0.6 },
        semanticSimilarity: { "pm-a": 0.7 },
      },
    );
    expect(snapshot.items.map(({ id }) => id)).toEqual(["pm-a", "pm-b"]);
    expect(snapshot.items[0]?.signals).toMatchObject({
      activity_density: 0.1,
      graph_proximity: 0.2,
      claim_focus: 0.3,
      knowledge_density: 0.4,
      author_affinity: 0.5,
      usage_affinity: 0.6,
      semantic_similarity: 0.7,
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(() => buildContextSignalSnapshot([], {
      statusRegistry,
      now,
      source: "scan_fallback",
      sourceCursor: " ",
    })).toThrow("source cursor");
    expect(() => buildContextSignalSnapshot([], {
      statusRegistry,
      now,
      source: "scan_fallback",
      sourceCursor: null as unknown as string,
    })).toThrow("source cursor");
    expect(() => buildContextSignalSnapshot([], {
      statusRegistry,
      now: "invalid",
      source: "scan_fallback",
      sourceCursor: "cursor",
    })).toThrow("valid timestamp");
    expect(() => buildContextSignalSnapshot([item("pm-a")], {
      statusRegistry,
      now,
      source: "derived_index",
      sourceCursor: "cursor",
      activityDensity: { "pm-a": 2 },
    })).toThrow("finite number from 0 to 1");
  });

  it("strictly validates serialized versions, rows, identities, timestamps, sources, and signals", () => {
    const valid = buildContextSignalSnapshot([item("pm-a")], {
      statusRegistry,
      now,
      source: "scan_fallback",
      sourceCursor: "cursor",
    });
    expect(parseContextSignalSnapshot({
      ...structuredClone(valid),
      items: [
        { id: "pm-b", signals: {} },
        { id: "pm-a", signals: {} },
      ],
    })?.items.map(({ id }) => id)).toEqual(["pm-a", "pm-b"]);
    const invalidValues: unknown[] = [
      null,
      { ...valid, format_version: 99 },
      { ...valid, signal_set_version: 99 },
      { ...valid, source_cursor: "" },
      { ...valid, source_cursor: " " },
      { ...valid, generated_at: "invalid" },
      { ...valid, source: "unknown" },
      { ...valid, items: {} },
      { ...valid, items: [{ id: "", signals: {} }] },
      { ...valid, items: [{ id: " ", signals: {} }] },
      { ...valid, items: [{ id: "pm-a", signals: [] }] },
      { ...valid, items: [{ id: "pm-a", signals: { recency: 2 } }] },
      { ...valid, items: [{ id: "pm-a", signals: { unknown: 0.5 } }] },
      { ...valid, items: [{ id: "pm-a", signals: {} }, { id: "pm-a", signals: {} }] },
    ];
    for (const value of invalidValues) {
      expect(parseContextSignalSnapshot(value)).toBeNull();
    }
  });

  it("reuses fresh rows and rebuilds absent, stale, changed-corpus, and unreadable snapshots", async () => {
    const adapter = new MemoryAdapter();
    const store = new ContextSignalStore(adapter);
    const options = { statusRegistry, now, source: "derived_index" as const, sourceCursor: "cursor-1" };
    const first = await store.readOrRebuild([item("pm-a")], options);
    expect(first).toMatchObject({ cache_status: "rebuilt", warnings: [] });
    expect(adapter.writes).toBe(1);
    const fresh = await store.readOrRebuild([item("pm-a", { title: "authoritative object" })], options);
    expect(fresh.cache_status).toBe("fresh");
    expect(fresh.candidates[0]?.item.title).toBe("authoritative object");
    expect(adapter.writes).toBe(1);
    const stale = await store.readOrRebuild([item("pm-a")], { ...options, sourceCursor: "cursor-2" });
    expect(stale).toMatchObject({ cache_status: "rebuilt", warnings: ["context_signal_store_stale"] });
    const changed = await store.readOrRebuild([item("pm-a"), item("pm-b")], { ...options, sourceCursor: "cursor-2" });
    expect(changed.warnings).toEqual(["context_signal_store_stale"]);
    const changedSource = await store.readOrRebuild([item("pm-a"), item("pm-b")], {
      ...options,
      source: "scan_fallback",
      sourceCursor: "cursor-2",
    });
    expect(changedSource.warnings).toEqual(["context_signal_store_stale"]);
    adapter.value = { corrupt: true };
    const malformed = await store.readOrRebuild([item("pm-a")], options);
    expect(malformed.warnings).toEqual(["context_signal_store_invalid"]);
    adapter.throwOnRead = true;
    const recovered = await store.readOrRebuild([item("pm-a")], options);
    expect(recovered.warnings).toEqual(["context_signal_store_invalid"]);
    adapter.throwOnRead = false;
    adapter.throwOnWrite = true;
    adapter.value = null;
    const writeDegraded = await store.readOrRebuild([item("pm-a")], options);
    expect(writeDegraded.cache_status).toBe("rebuilt");
    expect(writeDegraded.candidates[0]?.id).toBe("pm-a");
    expect(writeDegraded.warnings).toEqual(["context_signal_store_write_failed"]);
  });

  it("persists snapshots atomically through the JSON file adapter and reports corrupt JSON", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pm-context-signals-"));
    tempRoots.push(root);
    const filePath = path.join(root, "runtime", "context-signals.json");
    const adapter = new JsonFileContextSignalStoreAdapter(filePath);
    expect(await adapter.read()).toBeNull();
    const snapshot = buildContextSignalSnapshot([item("pm-a")], {
      statusRegistry,
      now,
      source: "derived_index",
      sourceCursor: "cursor",
    });
    await adapter.write(snapshot);
    expect(parseContextSignalSnapshot(await adapter.read())).toMatchObject({ source_cursor: "cursor" });
    expect((await fs.readdir(path.dirname(filePath))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    await fs.writeFile(filePath, "{broken", "utf8");
    await expect(adapter.read()).rejects.toBeInstanceOf(SyntaxError);
    expect(() => new JsonFileContextSignalStoreAdapter(" ")).toThrow("path must be non-empty");
    expect(() => new JsonFileContextSignalStoreAdapter(null as unknown as string)).toThrow("path must be non-empty");
  });
});
