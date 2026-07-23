import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildWorkspaceMemorySnapshot,
  readWorkspaceMemory,
  resolveRuntimeStatusRegistry,
  searchWorkspaceMemory,
  selectWorkspaceMemoryRollups,
} from "../../../src/sdk/index.js";
import { SETTINGS_DEFAULTS } from "../../../src/core/shared/constants.js";
import type { ItemMetadata } from "../../../src/types/index.js";

const roots: string[] = [];
const statusRegistry = resolveRuntimeStatusRegistry(SETTINGS_DEFAULTS.schema);
const now = "2026-07-23T08:00:00.000Z";

function item(id: string, overrides: Partial<ItemMetadata> = {}): ItemMetadata {
  return {
    id,
    title: id,
    description: `${id} description`,
    type: "Task",
    status: "closed",
    priority: 2,
    tags: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-04-02T00:00:00.000Z",
    closed_at: "2026-04-02T00:00:00.000Z",
    close_reason: "Delivered reusable SDK primitives",
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("workspace memory", () => {
  it("builds deterministic epoch and nearest-epic historical rollups", () => {
    const items = [
      item("pm-epic", {
        type: "Epic",
        title: "Universal SDK",
        status: "open",
        closed_at: undefined,
      }),
      item("pm-feature", {
        type: "Feature",
        parent: "pm-epic",
        status: "open",
        closed_at: undefined,
      }),
      item("pm-a", {
        parent: "pm-feature",
        resolution: "Published cursor contracts",
        notes: [{ text: "private note" }] as never,
        learnings: [{ text: "durable learning" }] as never,
      }),
      item("pm-b", {
        parent: "pm-feature",
        updated_at: "2026-01-03T00:00:00.000Z",
        closed_at: "2026-01-03T00:00:00.000Z",
      }),
      item("pm-canceled", { status: "canceled" }),
    ];
    const snapshot = buildWorkspaceMemorySnapshot(items, {
      statusRegistry,
      sourceCursor: "cursor-1",
      now,
    });

    expect(snapshot).toMatchObject({
      format_version: 1,
      source_cursor: "cursor-1",
      source_item_count: 5,
    });
    expect(snapshot.rollups.map(({ kind, key }) => `${kind}:${key}`)).toEqual([
      "epic:pm-epic",
      "epoch:2026-Q2",
      "epoch:2026-Q1",
    ]);
    expect(snapshot.rollups[0]).toMatchObject({
      label: "Universal SDK",
      item_count: 2,
      knowledge_entries: 2,
    });
    expect(snapshot.rollups[0]?.outcomes).toEqual([
      "Delivered reusable SDK primitives",
      "Published cursor contracts",
    ]);
    expect(searchWorkspaceMemory(snapshot, "SDK primitives")).toHaveLength(2);
    expect(() =>
      buildWorkspaceMemorySnapshot([], {
        statusRegistry,
        sourceCursor: " ",
        now,
      }),
    ).toThrow("source cursor");
    expect(() =>
      buildWorkspaceMemorySnapshot([], {
        statusRegistry,
        sourceCursor: "cursor",
        now: "invalid",
      }),
    ).toThrow("valid timestamp");
  });

  it("bounds rollups by tokens and searches labels, outcomes, ids, and titles", () => {
    const snapshot = buildWorkspaceMemorySnapshot(
      [
        item("pm-a", {
          title: "Cursor contracts",
          resolution: "SDK pagination shipped",
        }),
        item("pm-b", {
          updated_at: "2026-01-03T00:00:00.000Z",
          closed_at: "2026-01-03T00:00:00.000Z",
        }),
      ],
      { statusRegistry, sourceCursor: "cursor", now },
    );
    expect(selectWorkspaceMemoryRollups(snapshot, 0)).toEqual([]);
    expect(selectWorkspaceMemoryRollups(snapshot, 10_000, 1)).toHaveLength(1);
    expect(searchWorkspaceMemory(snapshot, "pagination")).toHaveLength(1);
    expect(searchWorkspaceMemory(snapshot, "PM-A")).toHaveLength(1);
    expect(searchWorkspaceMemory(snapshot, "cursor contracts")).toHaveLength(1);
    expect(searchWorkspaceMemory(snapshot, "missing")).toEqual([]);
    expect(searchWorkspaceMemory(snapshot, "   ")).toEqual([]);
    expect(searchWorkspaceMemory(snapshot, "cursor", 0)).toEqual([]);
  });

  it("handles orphan ancestry, empty outcomes, and deterministic sort ties", () => {
    const snapshot = buildWorkspaceMemorySnapshot(
      [
        item("pm-epic-a", {
          type: "Epic",
          title: "Epic A",
          status: "open",
          closed_at: undefined,
        }),
        item("pm-epic-b", {
          type: "Epic",
          title: "Epic B",
          status: "open",
          closed_at: undefined,
        }),
        item("pm-a", {
          parent: "pm-epic-a",
          close_reason: undefined,
          resolution: undefined,
        }),
        item("pm-b", {
          parent: "pm-epic-b",
          close_reason: " ",
          resolution: undefined,
        }),
        item("pm-orphan", { parent: "pm-missing", closed_at: undefined }),
      ],
      { statusRegistry, sourceCursor: "cursor-ties", now },
    );
    expect(snapshot.rollups.map(({ key }) => key)).toEqual([
      "pm-epic-a",
      "pm-epic-b",
      "2026-Q2",
    ]);
    expect(snapshot.rollups[0]?.outcomes).toEqual([]);
    expect(
      searchWorkspaceMemory(snapshot, "pm", 10).map(({ key }) => key),
    ).toEqual(["2026-Q2", "pm-epic-a", "pm-epic-b"]);
  });

  it("rejects every malformed persisted snapshot field", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pm-memory-invalid-"));
    roots.push(root);
    const valid = buildWorkspaceMemorySnapshot([item("pm-valid")], {
      statusRegistry,
      sourceCursor: "cursor",
      now,
    });
    const validRollup = valid.rollups[0]!;
    const invalidValues: unknown[] = [
      [],
      { ...valid, source_cursor: 1 },
      { ...valid, source_cursor: " " },
      { ...valid, source_item_count: 1.5 },
      { ...valid, source_item_count: -1 },
      { ...valid, generated_at: 1 },
      { ...valid, generated_at: "invalid" },
      { ...valid, rollups: "invalid" },
      { ...valid, rollups: [null] },
      { ...valid, rollups: [{ ...validRollup, kind: "invalid" }] },
      { ...valid, rollups: [{ ...validRollup, key: 1 }] },
      { ...valid, rollups: [{ ...validRollup, key: "" }] },
      { ...valid, rollups: [{ ...validRollup, label: 1 }] },
      { ...valid, rollups: [{ ...validRollup, label: "" }] },
      { ...valid, rollups: [{ ...validRollup, item_count: 1.5 }] },
      { ...valid, rollups: [{ ...validRollup, item_count: 0 }] },
      { ...valid, rollups: [{ ...validRollup, first_closed_at: 1 }] },
      { ...valid, rollups: [{ ...validRollup, first_closed_at: "invalid" }] },
      { ...valid, rollups: [{ ...validRollup, last_closed_at: 1 }] },
      { ...valid, rollups: [{ ...validRollup, last_closed_at: "invalid" }] },
      { ...valid, rollups: [{ ...validRollup, representative_items: 1 }] },
      {
        ...valid,
        rollups: [{ ...validRollup, representative_items: [null] }],
      },
      {
        ...valid,
        rollups: [
          {
            ...validRollup,
            representative_items: [{ id: 1, title: "title" }],
          },
        ],
      },
      {
        ...valid,
        rollups: [
          {
            ...validRollup,
            representative_items: [{ id: "", title: "title" }],
          },
        ],
      },
      {
        ...valid,
        rollups: [
          {
            ...validRollup,
            representative_items: [{ id: "pm-valid", title: 1 }],
          },
        ],
      },
      { ...valid, rollups: [{ ...validRollup, outcomes: 1 }] },
      { ...valid, rollups: [{ ...validRollup, outcomes: [1] }] },
      { ...valid, rollups: [{ ...validRollup, knowledge_entries: 1.5 }] },
      { ...valid, rollups: [{ ...validRollup, knowledge_entries: -1 }] },
    ];
    await fs.mkdir(path.join(root, "runtime"), { recursive: true });
    for (const invalid of invalidValues) {
      await fs.writeFile(
        path.join(root, "runtime", "workspace-memory.json"),
        JSON.stringify(invalid),
        "utf8",
      );
      await expect(
        readWorkspaceMemory([item("pm-valid")], {
          pmRoot: root,
          statusRegistry,
          now,
          minimumItems: 1,
          sourceCursor: "cursor",
        }),
      ).resolves.toMatchObject({
        cache_status: "rebuilt",
        warnings: ["workspace_memory_invalid"],
      });
    }
  });

  it("skips small workspaces and reuses or rebuilds persisted cursor state", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pm-memory-"));
    roots.push(root);
    const items = [item("pm-a")];
    expect(
      await readWorkspaceMemory(items, {
        pmRoot: root,
        statusRegistry,
        now,
      }),
    ).toEqual({ snapshot: null, cache_status: "skipped", warnings: [] });

    const first = await readWorkspaceMemory(items, {
      pmRoot: root,
      statusRegistry,
      now,
      minimumItems: 1,
      sourceCursor: "cursor-1",
    });
    expect(first).toMatchObject({ cache_status: "rebuilt", warnings: [] });
    const fresh = await readWorkspaceMemory(items, {
      pmRoot: root,
      statusRegistry,
      now: "2026-07-24T08:00:00.000Z",
      minimumItems: 1,
      sourceCursor: "cursor-1",
    });
    expect(fresh).toMatchObject({
      cache_status: "fresh",
      snapshot: { generated_at: now },
    });
    const stale = await readWorkspaceMemory(items, {
      pmRoot: root,
      statusRegistry,
      now,
      minimumItems: 1,
      sourceCursor: "cursor-2",
    });
    expect(stale).toMatchObject({
      cache_status: "rebuilt",
      warnings: ["workspace_memory_stale"],
    });

    await fs.writeFile(
      path.join(root, "runtime", "workspace-memory.json"),
      "{broken",
      "utf8",
    );
    const recovered = await readWorkspaceMemory(items, {
      pmRoot: root,
      statusRegistry,
      now,
      minimumItems: 1,
      sourceCursor: "cursor-3",
    });
    expect(recovered).toMatchObject({
      cache_status: "rebuilt",
      warnings: ["workspace_memory_invalid"],
    });
    await fs.writeFile(
      path.join(root, "runtime", "workspace-memory.json"),
      "null",
      "utf8",
    );
    expect(
      await readWorkspaceMemory(items, {
        pmRoot: root,
        statusRegistry,
        now,
        minimumItems: 1,
        sourceCursor: "cursor-4",
      }),
    ).toMatchObject({ warnings: ["workspace_memory_invalid"] });
    await fs.writeFile(
      path.join(root, "runtime", "workspace-memory.json"),
      JSON.stringify({ format_version: 99 }),
      "utf8",
    );
    expect(
      await readWorkspaceMemory(items, {
        pmRoot: root,
        statusRegistry,
        now,
        minimumItems: 1,
        sourceCursor: "cursor-5",
      }),
    ).toMatchObject({ warnings: ["workspace_memory_invalid"] });
  });

  it("uses a stable scan cursor when no derived index exists", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pm-memory-scan-"));
    roots.push(root);
    const first = await readWorkspaceMemory([item("pm-z"), item("pm-a")], {
      pmRoot: root,
      statusRegistry,
      now,
      minimumItems: 1,
    });
    expect(first.snapshot?.source_cursor).toMatch(/^scan:[a-f0-9]{64}$/u);
    const second = await readWorkspaceMemory([item("pm-a"), item("pm-z")], {
      pmRoot: root,
      statusRegistry,
      now,
      minimumItems: 1,
    });
    expect(second.cache_status).toBe("fresh");
  });

  it("serves rebuilt memory when derived persistence is unwritable", async () => {
    const rootFile = path.join(
      os.tmpdir(),
      `pm-memory-file-${process.pid}-${Date.now()}`,
    );
    roots.push(rootFile);
    await fs.writeFile(rootFile, "not a directory", "utf8");
    const result = await readWorkspaceMemory([item("pm-a")], {
      pmRoot: rootFile,
      statusRegistry,
      now,
      minimumItems: 1,
      sourceCursor: "cursor",
    });
    expect(result).toMatchObject({
      cache_status: "rebuilt",
      snapshot: { source_cursor: "cursor" },
      warnings: ["workspace_memory_invalid", "workspace_memory_write_failed"],
    });
  });
});
