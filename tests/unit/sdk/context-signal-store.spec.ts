import { createHash } from "node:crypto";
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

function withRecomputedFingerprint(
  snapshot: ContextSignalSnapshot,
  items: readonly unknown[],
): unknown {
  const hash = createHash("sha256");
  const ordered = [...items].sort((left, right) =>
    String((left as { id?: unknown })?.id).localeCompare(
      String((right as { id?: unknown })?.id),
    ),
  );
  for (const value of ordered) {
    const row = value as {
      id?: unknown;
      signal_provenance?: { recency?: Record<string, unknown> };
    };
    const recency = row.signal_provenance?.recency;
    hash.update(
      JSON.stringify([
        row.id,
        recency?.source,
        recency?.coordinate,
        recency?.history_op ?? null,
        recency?.event_class ?? null,
      ]),
    );
  }
  return {
    ...snapshot,
    items,
    recency_evidence_fingerprint: `sha256:${hash.digest("hex")}`,
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
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
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
    expect(snapshot.items[0]?.signals).not.toHaveProperty(
      "semantic_similarity",
    );
    expect(Object.isFrozen(snapshot)).toBe(true);
    for (const invalidItems of [
      [item(" ")],
      [item("pm-duplicate"), item("pm-duplicate")],
    ]) {
      expect(() =>
        buildContextSignalSnapshot(invalidItems, {
          statusRegistry,
          now,
          source: "scan_fallback",
          sourceCursor: "cursor",
        }),
      ).toThrow("item IDs must be unique and non-empty");
    }
    expect(() =>
      buildContextSignalSnapshot([], {
        statusRegistry,
        now,
        source: "scan_fallback",
        sourceCursor: " ",
      }),
    ).toThrow("source cursor");
    expect(() =>
      buildContextSignalSnapshot([], {
        statusRegistry,
        now,
        source: "scan_fallback",
        sourceCursor: null as unknown as string,
      }),
    ).toThrow("source cursor");
    expect(() =>
      buildContextSignalSnapshot([], {
        statusRegistry,
        now: "invalid",
        source: "scan_fallback",
        sourceCursor: "cursor",
      }),
    ).toThrow("valid timestamp");
    expect(() =>
      buildContextSignalSnapshot([item("pm-a")], {
        statusRegistry,
        now,
        source: "derived_index",
        sourceCursor: "cursor",
        activityDensity: { "pm-a": 2 },
      }),
    ).toThrow("finite number from 0 to 1");
    expect(() =>
      buildContextSignalSnapshot([], {
        statusRegistry,
        now,
        source: "invalid" as never,
        sourceCursor: "cursor",
      }),
    ).toThrow("source must be derived_index or scan_fallback");
    expect(
      buildContextSignalSnapshot(
        [
          item("pm-invalid-dependency", {
            dependencies: [{ id: " " }] as never,
          }),
        ],
        {
          statusRegistry,
          now,
          source: "scan_fallback",
          sourceCursor: "cursor",
        },
      ).items[0]?.signals.graph_proximity,
    ).toBe(0);
  });

  it("strictly validates serialized versions, rows, identities, timestamps, sources, and signals", () => {
    const valid = buildContextSignalSnapshot([item("pm-a")], {
      statusRegistry,
      now,
      source: "scan_fallback",
      sourceCursor: "cursor",
    });
    const sortable = buildContextSignalSnapshot([item("pm-a"), item("pm-b")], {
      statusRegistry,
      now,
      source: "scan_fallback",
      sourceCursor: "cursor",
    });
    expect(
      parseContextSignalSnapshot({
        ...structuredClone(sortable),
        items: structuredClone(sortable.items).reverse(),
      })?.items.map(({ id }) => id),
    ).toEqual(["pm-a", "pm-b"]);
    const substantive = buildContextSignalSnapshot([item("pm-a")], {
      statusRegistry,
      now,
      source: "scan_fallback",
      sourceCursor: "cursor",
      recencyEvidence: {
        "pm-a": {
          source: "substantive_history",
          coordinate: now,
          history_op: "comment_add",
          event_class: "substantive",
        },
      },
    });
    expect(
      parseContextSignalSnapshot(structuredClone(substantive)),
    ).not.toBeNull();
    const offsetCoordinate = buildContextSignalSnapshot([item("pm-a")], {
      statusRegistry,
      now,
      source: "scan_fallback",
      sourceCursor: "cursor",
      recencyEvidence: {
        "pm-a": {
          source: "substantive_history",
          coordinate: "2026-07-21T14:00:00.000+02:00",
        },
      },
    });
    expect(
      offsetCoordinate.items[0]?.signal_provenance.recency.coordinate,
    ).toBe(now);
    expect(() =>
      buildContextSignalSnapshot([item("pm-a")], {
        statusRegistry,
        now,
        source: "scan_fallback",
        sourceCursor: "cursor",
        recencyEvidence: {
          "pm-a": {
            source: "substantive_history",
            coordinate: "not-a-date",
          },
        },
      }),
    ).toThrow("valid absolute timestamp with millisecond precision");
    expect(() =>
      buildContextSignalSnapshot([item("pm-a")], {
        statusRegistry,
        now,
        source: "scan_fallback",
        sourceCursor: "cursor",
        recencyEvidence: {
          "pm-a": {
            source: "unsupported" as never,
            coordinate: now,
          },
        },
      }),
    ).toThrow("provenance must match its source");
    const legacyDateCoordinate = buildContextSignalSnapshot([item("pm-a")], {
      statusRegistry,
      now,
      source: "scan_fallback",
      sourceCursor: "cursor",
      recencyEvidence: {
        "pm-a": {
          source: "created_at",
          coordinate: "2026-07-21",
        },
      },
    });
    expect(
      legacyDateCoordinate.items[0]?.signal_provenance.recency.coordinate,
    ).toBe("2026-07-21T00:00:00.000Z");
    expect(
      buildContextSignalSnapshot(
        [
          item("pm-compact", { created_at: "20260720" }),
          item("pm-invalid", { created_at: "invalid" }),
        ],
        {
          statusRegistry,
          now,
          source: "scan_fallback",
          sourceCursor: "cursor",
        },
      ).items.map(
        ({ signal_provenance }) => signal_provenance.recency.coordinate,
      ),
    ).toEqual(["1970-01-01T00:00:00.000Z", "1970-01-01T00:00:00.000Z"]);
    expect(() =>
      buildContextSignalSnapshot([item("pm-a")], {
        statusRegistry,
        now,
        source: "scan_fallback",
        sourceCursor: "cursor",
        recencyEvidence: {
          "pm-a": {
            source: "created_at",
            coordinate: "2026-07-21T12:00:00.0001Z",
          },
        },
      }),
    ).toThrow("millisecond precision");
    for (const recency of [
      {
        source: "created_at" as const,
        coordinate: now,
        history_op: "comment_add",
      },
      {
        source: "substantive_history" as const,
        coordinate: now,
        event_class: "maintenance" as const,
      },
    ]) {
      expect(() =>
        buildContextSignalSnapshot([item("pm-a")], {
          statusRegistry,
          now,
          source: "scan_fallback",
          sourceCursor: "cursor",
          recencyEvidence: { "pm-a": recency },
        }),
      ).toThrow("provenance must match its source");
    }
    expect(() =>
      buildContextSignalSnapshot([item("pm-a")], {
        statusRegistry,
        now,
        source: "scan_fallback",
        sourceCursor: "cursor",
        recencyEvidence: {
          "pm-a": {
            source: "created_at",
            coordinate: "2026-02-30",
          },
        },
      }),
    ).toThrow("valid absolute timestamp");
    const legacySubstantive = buildContextSignalSnapshot([item("pm-a")], {
      statusRegistry,
      now,
      source: "scan_fallback",
      sourceCursor: "cursor",
      recencyEvidence: {
        "pm-a": {
          source: "substantive_history",
          coordinate: now,
          history_op: "comment_add",
        },
      },
    });
    expect(
      parseContextSignalSnapshot(structuredClone(legacySubstantive)),
    ).not.toBeNull();
    const sparseItems = new Array<unknown>(1);
    expect(
      parseContextSignalSnapshot({
        ...structuredClone(valid),
        items: sparseItems,
      }),
    ).toBeNull();
    const invalidCoordinate = structuredClone(valid);
    const invalidCoordinateItem = invalidCoordinate.items[0]!;
    invalidCoordinateItem.signal_provenance.recency.coordinate = "not-a-date";
    invalidCoordinate.recency_evidence_fingerprint = `sha256:${createHash(
      "sha256",
    )
      .update(
        JSON.stringify([
          invalidCoordinateItem.id,
          invalidCoordinateItem.signal_provenance.recency.source,
          invalidCoordinateItem.signal_provenance.recency.coordinate,
          invalidCoordinateItem.signal_provenance.recency.history_op ?? null,
          invalidCoordinateItem.signal_provenance.recency.event_class ?? null,
        ]),
      )
      .digest("hex")}`;
    expect(parseContextSignalSnapshot(invalidCoordinate)).toBeNull();
    const invalidValues: unknown[] = [
      null,
      { ...valid, format_version: 99 },
      { ...valid, signal_set_version: 99 },
      { ...valid, source_cursor: "" },
      { ...valid, source_cursor: " " },
      { ...valid, recency_evidence_fingerprint: "" },
      { ...valid, recency_evidence_fingerprint: "sha256:not-a-digest" },
      { ...valid, generated_at: "invalid" },
      { ...valid, source: "unknown" },
      { ...valid, items: {} },
      { ...valid, items: [null] },
    ];
    const invalidItemSets: unknown[][] = [
      [{ ...structuredClone(valid.items[0]), id: "" }],
      [{ ...structuredClone(valid.items[0]), id: " " }],
      [
        {
          ...structuredClone(valid.items[0]),
          signal_provenance: {
            recency: { source: "created_at", coordinate: 42 },
          },
        },
      ],
      [{ id: "pm-a", signals: [] }],
      [{ id: "pm-a", signals: { recency: 2 } }],
      [{ id: "pm-a", signals: { unknown: 0.5 } }],
      [
        {
          ...structuredClone(valid.items[0]),
          signals: { unknown: 0.5 },
        },
      ],
      [
        {
          ...structuredClone(valid.items[0]),
          signal_provenance: { recency: null },
        },
      ],
      ...[
        {
          source: "substantive_history",
          coordinate: now,
          event_class: "maintenance",
        },
        { source: "release_cohort", coordinate: now, history_op: "close" },
        { source: "created_at", coordinate: now, event_class: "substantive" },
        {
          source: "substantive_history",
          coordinate: now,
          event_class: "unknown",
        },
        { source: "unknown", coordinate: now },
        { source: ["created_at"], coordinate: now },
      ].map((recency) => [
        {
          ...structuredClone(valid.items[0]),
          signal_provenance: { recency },
        },
      ]),
      [
        { id: "pm-a", signals: {} },
        { id: "pm-a", signals: {} },
      ],
    ];
    expect(
      (withRecomputedFingerprint(valid, valid.items) as ContextSignalSnapshot)
        .recency_evidence_fingerprint,
    ).toBe(valid.recency_evidence_fingerprint);
    invalidValues.push(
      ...invalidItemSets.map((items) =>
        withRecomputedFingerprint(valid, items),
      ),
    );
    for (const value of invalidValues) {
      expect(parseContextSignalSnapshot(value)).toBeNull();
    }
  });

  it("fingerprints recency evidence with and without optional history fields", () => {
    const withoutHistoryFields = buildContextSignalSnapshot([item("pm-a")], {
      statusRegistry,
      now,
      source: "scan_fallback",
      sourceCursor: "cursor",
      recencyEvidence: {
        "pm-a": { source: "substantive_history", coordinate: now },
      },
    });
    const withHistoryFields = buildContextSignalSnapshot([item("pm-a")], {
      statusRegistry,
      now,
      source: "scan_fallback",
      sourceCursor: "cursor",
      recencyEvidence: {
        "pm-a": {
          source: "substantive_history",
          coordinate: now,
          history_op: "create",
          event_class: "substantive",
        },
      },
    });
    expect(withoutHistoryFields.recency_evidence_fingerprint).not.toBe(
      withHistoryFields.recency_evidence_fingerprint,
    );
  });

  it("invalidates a stable cursor when fallback recency provenance changes", async () => {
    const adapter = new MemoryAdapter();
    const store = new ContextSignalStore(adapter);
    const options = {
      statusRegistry,
      now,
      source: "scan_fallback" as const,
      sourceCursor: "stable-cursor",
    };

    await expect(
      store.readOrRebuild([item("pm-a")], options),
    ).resolves.toMatchObject({ cache_status: "rebuilt" });
    await expect(
      store.readOrRebuild([item("pm-a", { release: "v2026.7.21" })], options),
    ).resolves.toMatchObject({
      cache_status: "rebuilt",
      warnings: ["context_signal_store_stale"],
      snapshot: {
        items: [
          {
            signal_provenance: {
              recency: {
                source: "release_cohort",
                coordinate: "2026-07-21T00:00:00.000Z",
              },
            },
          },
        ],
      },
    });
  });

  it("rebuilds when persisted rows do not match their recency fingerprint", async () => {
    const adapter = new MemoryAdapter();
    const store = new ContextSignalStore(adapter);
    const options = {
      statusRegistry,
      now,
      source: "scan_fallback" as const,
      sourceCursor: "stable-cursor",
    };
    const initial = await store.readOrRebuild([item("pm-a")], options);
    const persisted = structuredClone(initial.snapshot);
    const first = persisted.items[0];
    if (first === undefined) throw new Error("expected persisted row");
    first.signal_provenance.recency.coordinate = "2026-07-01T00:00:00.000Z";
    adapter.value = persisted;

    await expect(
      store.readOrRebuild([item("pm-a")], options),
    ).resolves.toMatchObject({
      cache_status: "rebuilt",
      warnings: ["context_signal_store_invalid"],
      snapshot: {
        items: [
          {
            signal_provenance: {
              recency: { coordinate: "2026-07-20T00:00:00.000Z" },
            },
          },
        ],
      },
    });
  });

  it("reuses fresh rows and rebuilds absent, stale, changed-corpus, and unreadable snapshots", async () => {
    const adapter = new MemoryAdapter();
    const store = new ContextSignalStore(adapter);
    const options = {
      statusRegistry,
      now,
      source: "derived_index" as const,
      sourceCursor: "cursor-1",
    };
    const first = await store.readOrRebuild([item("pm-a")], options);
    expect(first).toMatchObject({ cache_status: "rebuilt", warnings: [] });
    expect(adapter.writes).toBe(1);
    const fresh = await store.readOrRebuild(
      [item("pm-a", { title: "authoritative object" })],
      options,
    );
    expect(fresh.cache_status).toBe("fresh");
    expect(fresh.candidates[0]?.item.title).toBe("authoritative object");
    expect(adapter.writes).toBe(1);
    const stale = await store.readOrRebuild([item("pm-a")], {
      ...options,
      sourceCursor: "cursor-2",
    });
    expect(stale).toMatchObject({
      cache_status: "rebuilt",
      warnings: ["context_signal_store_stale"],
    });
    expect(stale.warning_details).toEqual([
      {
        code: "context_signal_store_stale",
        meaning:
          "The persisted context-signal snapshot did not match the authoritative cursor or item corpus and was rebuilt.",
        recovery_command: "pm context",
        recovery_effect:
          "Re-read context and confirm the rebuilt snapshot is now fresh.",
      },
    ]);
    expect(
      await store.readOrRebuild([item("pm-a")], {
        ...options,
        sourceCursor: "cursor-2",
      }),
    ).toMatchObject({
      cache_status: "fresh",
      warnings: [],
      warning_details: [],
    });
    expect(adapter.writes).toBe(2);
    const changedEvidence = await store.readOrRebuild([item("pm-a")], {
      ...options,
      sourceCursor: "cursor-2",
      recencyEvidence: {
        "pm-a": {
          source: "substantive_history",
          coordinate: "2026-07-02T00:00:00.000Z",
          history_op: "comment_add",
          event_class: "substantive",
        },
      },
    });
    expect(changedEvidence.warnings).toEqual(["context_signal_store_stale"]);
    expect(changedEvidence.snapshot.recency_evidence_fingerprint).toMatch(
      /^sha256:[a-f0-9]{64}$/u,
    );
    const changed = await store.readOrRebuild([item("pm-a"), item("pm-b")], {
      ...options,
      sourceCursor: "cursor-2",
    });
    expect(changed.warnings).toEqual(["context_signal_store_stale"]);
    const changedSource = await store.readOrRebuild(
      [item("pm-a"), item("pm-b")],
      {
        ...options,
        source: "scan_fallback",
        sourceCursor: "cursor-2",
      },
    );
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
    expect(writeDegraded.warnings).toEqual([
      "context_signal_store_write_failed",
    ]);
  });

  it("persists snapshots atomically through the JSON file adapter and reports corrupt JSON", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "pm-context-signals-"),
    );
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
    expect(parseContextSignalSnapshot(await adapter.read())).toMatchObject({
      source_cursor: "cursor",
    });
    expect(
      (await fs.readdir(path.dirname(filePath))).filter((name) =>
        name.endsWith(".tmp"),
      ),
    ).toEqual([]);
    await fs.writeFile(filePath, "{broken", "utf8");
    await expect(adapter.read()).rejects.toBeInstanceOf(SyntaxError);
    expect(() => new JsonFileContextSignalStoreAdapter(" ")).toThrow(
      "path must be non-empty",
    );
    expect(
      () => new JsonFileContextSignalStoreAdapter(null as unknown as string),
    ).toThrow("path must be non-empty");
  });

  it("reuses cursor-bound workspace signals while refreshing caller-dependent overlays", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "pm-context-workspace-signals-"),
    );
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
    expect(
      first.candidates.find(({ id }) => id === "pm-child")?.signals,
    ).toMatchObject({
      graph_proximity: 1,
      author_affinity: 1,
    });
    expect(
      second.candidates.find(({ id }) => id === "pm-child")?.signals
        ?.author_affinity,
    ).toBe(0);
    expect(
      second.snapshot.items.find(({ id }) => id === "pm-child")?.signals,
    ).not.toHaveProperty("author_affinity");
  });

  it("persists the latest substantive history event instead of later maintenance", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "pm-context-history-signals-"),
    );
    tempRoots.push(root);
    await fs.mkdir(path.join(root, "history"), { recursive: true });
    await fs.writeFile(
      path.join(root, "history", "pm-history.jsonl"),
      [
        {
          ts: "2026-07-20T00:00:00.000Z",
          author: "agent",
          op: "comment_add",
          event_class: "substantive",
          patch: [],
          before_hash: "before",
          after_hash: "after",
        },
        {
          ts: "2026-07-21T00:00:00.000Z",
          author: "agent",
          op: "release",
          event_class: "maintenance",
          patch: [],
          before_hash: "before",
          after_hash: "after",
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
      "utf8",
    );

    const result = await readWorkspaceContextSignals([item("pm-history")], {
      pmRoot: root,
      statusRegistry,
      now,
      sourceCursor: "history-cursor",
      source: "scan_fallback",
    });

    expect(result.snapshot.items[0]?.signal_provenance?.recency).toEqual({
      source: "substantive_history",
      coordinate: "2026-07-20T00:00:00.000Z",
      history_op: "comment_add",
      event_class: "substantive",
    });
    expect(result.candidates[0]?.signal_provenance.recency).toEqual(
      result.snapshot.items[0]?.signal_provenance?.recency,
    );
  });

  it("selects automatic derived-index provenance and deterministic scan fallback", async () => {
    const indexedRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "pm-context-indexed-signals-"),
    );
    const fallbackRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "pm-context-fallback-signals-"),
    );
    tempRoots.push(indexedRoot, fallbackRoot);
    const indexedItem = item("pm-indexed");
    await fs.mkdir(path.join(indexedRoot, "tasks"), { recursive: true });
    await fs.writeFile(
      path.join(indexedRoot, "tasks", "pm-indexed.toon"),
      serializeItemDocument(
        { metadata: indexedItem, body: "" },
        { format: "toon" },
      ),
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
      fs.stat(
        path.join(fallbackRoot, "runtime", "context-signals-fallback.json"),
      ),
    ).resolves.toBeDefined();
    await expect(
      readWorkspaceContextSignals([], {
        pmRoot: fallbackRoot,
        statusRegistry,
        now,
        sourceCursor: "cursor-without-source",
      }),
    ).rejects.toThrow("must be provided together");
    await expect(
      readWorkspaceContextSignals([], {
        pmRoot: fallbackRoot,
        statusRegistry,
        now,
        storeKey: "../outside",
      }),
    ).rejects.toThrow("filesystem-safe identifier");
  });
});
