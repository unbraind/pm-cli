import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildContextSignalSnapshot,
  ContextSignalStore,
  JsonFileContextSignalStoreAdapter,
  parseContextSignalSnapshot,
  readWorkspaceContextSignals,
  resolveRuntimeStatusRegistry,
  type ContextSignalSnapshot,
  type ContextSignalStoreAdapter,
} from "../../../src/sdk/index.js";
import { SETTINGS_DEFAULTS } from "../../../src/core/shared/constants.js";
import type { ItemMetadata } from "../../../src/types/index.js";
import { serializeItemDocument } from "../../../src/core/item/item-format.js";
import { listAllDocumentCandidatesCached } from "../../../src/core/store/item-metadata-cache.js";

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
      knowledge_density: 0.4,
    });
    expect(snapshot.items[0]?.signals).not.toHaveProperty("claim_focus");
    expect(snapshot.items[0]?.signals).not.toHaveProperty("author_affinity");
    expect(snapshot.items[0]?.signals).not.toHaveProperty("usage_affinity");
    expect(snapshot.items[0]?.signals).not.toHaveProperty("semantic_similarity");
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
    expect(() => buildContextSignalSnapshot([], {
      statusRegistry,
      now,
      source: "invalid" as never,
      sourceCursor: "cursor",
    })).toThrow("source must be derived_index or scan_fallback");
    expect(buildContextSignalSnapshot([
      item("pm-invalid-dependency", { dependencies: [{ id: " " }] as never }),
    ], {
      statusRegistry,
      now,
      source: "scan_fallback",
      sourceCursor: "cursor",
    }).items[0]?.signals.graph_proximity).toBe(0);
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

  it("reuses cursor-bound workspace signals while refreshing caller-dependent overlays", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pm-context-workspace-signals-"));
    tempRoots.push(root);
    const items = [
      item("pm-parent", { comments: [{ text: "context" }] as never }),
      item("pm-child", { parent: "pm-parent", assignee: "agent-a" }),
    ];
    const first = await readWorkspaceContextSignals(items, {
      pmRoot: root,
      statusRegistry,
      now,
      author: "agent-a",
      sourceCursor: "cursor-1",
      source: "derived_index",
    });
    const second = await readWorkspaceContextSignals(items, {
      pmRoot: root,
      statusRegistry,
      now: "2026-07-22T12:00:00.000Z",
      author: "agent-b",
      sourceCursor: "cursor-1",
      source: "derived_index",
    });

    expect(first.cache_status).toBe("rebuilt");
    expect(second.cache_status).toBe("fresh");
    expect(first.candidates.find(({ id }) => id === "pm-child")?.signals).toMatchObject({
      graph_proximity: 1,
      author_affinity: 1,
    });
    expect(second.candidates.find(({ id }) => id === "pm-child")?.signals?.author_affinity).toBe(0);
    expect(second.snapshot.items.find(({ id }) => id === "pm-child")?.signals).not.toHaveProperty("author_affinity");
  });

  it("selects automatic derived-index provenance and deterministic scan fallback", async () => {
    const indexedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pm-context-indexed-signals-"));
    const fallbackRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pm-context-fallback-signals-"));
    tempRoots.push(indexedRoot, fallbackRoot);
    const indexedItem = item("pm-indexed");
    await fs.mkdir(path.join(indexedRoot, "tasks"), { recursive: true });
    await fs.writeFile(
      path.join(indexedRoot, "tasks", "pm-indexed.toon"),
      serializeItemDocument({ metadata: indexedItem, body: "" }, { format: "toon" }),
      "utf8",
    );
    await listAllDocumentCandidatesCached(
      indexedRoot,
      "toon",
      { Task: "tasks" },
      [],
      undefined,
      { derivedIndexMinimumItems: 1 },
    );

    const indexed = await readWorkspaceContextSignals([indexedItem], {
      pmRoot: indexedRoot,
      storeKey: "indexed",
      statusRegistry,
      now,
    });
    const fallbackItems = [
      item("pm-fallback-z", {
        priority: undefined as never,
        dependencies: [{ id: "pm-fallback-a" }] as never,
      }),
      item("pm-fallback-a"),
    ];
    const fallback = await readWorkspaceContextSignals(fallbackItems, {
      pmRoot: fallbackRoot,
      storeKey: "fallback",
      statusRegistry,
      now,
    });

    expect(indexed.snapshot.source).toBe("derived_index");
    expect(fallback.snapshot).toMatchObject({ source: "scan_fallback" });
    expect(fallback.snapshot.source_cursor).toMatch(/^scan:[a-f0-9]{64}$/u);
    await expect(
      fs.stat(path.join(fallbackRoot, "runtime", "context-signals-fallback.json")),
    ).resolves.toBeDefined();
    await expect(readWorkspaceContextSignals([], {
      pmRoot: fallbackRoot,
      statusRegistry,
      now,
      sourceCursor: "cursor-without-source",
    })).rejects.toThrow("must be provided together");
    await expect(readWorkspaceContextSignals([], {
      pmRoot: fallbackRoot,
      statusRegistry,
      now,
      storeKey: "../outside",
    })).rejects.toThrow("filesystem-safe identifier");
  });
});
