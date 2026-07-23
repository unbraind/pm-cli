import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  queryItemMetadataIndex,
  rebuildItemMetadataQueryIndex,
  removeItemMetadataQueryIndex,
  updateItemMetadataQueryIndex,
} from "../../../../src/core/store/item-metadata-query-index.js";
import type { ItemMetadata } from "../../../../src/types.js";

const roots: string[] = [];

function metadata(
  id: string,
  overrides: Partial<ItemMetadata> = {},
): ItemMetadata {
  return {
    id,
    title: id,
    description: "",
    type: "Task",
    status: "open",
    priority: 2,
    tags: [],
    created_at: "2026-07-20T00:00:00.000Z",
    updated_at: "2026-07-20T00:00:00.000Z",
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

describe("item metadata SQLite query index", () => {
  it("queries bounded default-order windows and scalar index predicates", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pm-query-index-"));
    roots.push(root);
    await rebuildItemMetadataQueryIndex({
      pmRoot: root,
      contextFingerprint: "context-1",
      sourceCursor: "cursor-1",
      rows: [
        {
          relativePath: "tasks/pm-closed.toon",
          metadata: metadata("pm-closed", {
            status: "closed",
            priority: 0,
          }),
        },
        {
          relativePath: "tasks/pm-new.toon",
          metadata: metadata("pm-new", {
            priority: 1,
            updated_at: "2026-07-22T00:00:00.000Z",
            parent: "pm-parent",
            assignee: "agent-a",
            sprint: "sprint-1",
            release: "v1",
            customer: "Ada",
          }),
        },
        {
          relativePath: "features/pm-feature.toon",
          metadata: metadata("pm-feature", {
            type: "Feature",
            priority: 1,
            updated_at: "2026-07-21T00:00:00.000Z",
          }),
        },
        {
          relativePath: "tasks/pm-old.toon",
          metadata: metadata("pm-old", { priority: 3 }),
        },
      ],
    });

    expect(
      await queryItemMetadataIndex({
        pmRoot: root,
        expectedSourceCursor: "cursor-1",
        query: {
          terminalStatuses: ["closed", "canceled"],
          limit: 2,
          offset: 1,
        },
      }),
    ).toMatchObject({
      total: 4,
      items: [{ id: "pm-feature" }, { id: "pm-old" }],
    });
    expect(
      await queryItemMetadataIndex({
        pmRoot: root,
        expectedSourceCursor: "cursor-1",
        query: {
          statuses: ["open"],
          excludeStatuses: ["blocked"],
          types: ["Task"],
          ids: ["pm-new", "pm-old"],
          parent: "pm-parent",
          assignee: "agent-a",
          sprint: "sprint-1",
          release: "v1",
          priority: 1,
        },
      }),
    ).toMatchObject({ total: 1, items: [{ id: "pm-new" }] });
    expect(
      await queryItemMetadataIndex({
        pmRoot: root,
        expectedSourceCursor: "cursor-1",
        query: { metadataKeys: ["customer", "release"] },
      }),
    ).toMatchObject({ total: 1, items: [{ id: "pm-new" }] });
    expect(
      await queryItemMetadataIndex({
        pmRoot: root,
        expectedSourceCursor: "stale",
      }),
    ).toBeNull();
  });

  it("moves, updates, deletes, replaces, and removes cursor-bound projections", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pm-query-mutate-"));
    roots.push(root);
    await rebuildItemMetadataQueryIndex({
      pmRoot: root,
      contextFingerprint: "context-1",
      sourceCursor: "cursor-1",
      rows: [
        {
          relativePath: "tasks/pm-a.toon",
          metadata: metadata("pm-a"),
        },
      ],
    });
    expect(
      await updateItemMetadataQueryIndex({
        pmRoot: root,
        contextFingerprint: "context-1",
        expectedSourceCursor: "cursor-1",
        sourceCursor: "cursor-2",
        row: {
          relativePath: "features/pm-a.toon",
          metadata: metadata("pm-a", {
            type: "Feature",
            title: "Moved feature",
            customer: "Ada",
          }),
        },
        deletedRelativePaths: ["tasks/pm-a.toon"],
      }),
    ).toBe(true);
    expect(
      await queryItemMetadataIndex({
        pmRoot: root,
        expectedSourceCursor: "cursor-2",
      }),
    ).toMatchObject({
      total: 1,
      items: [{ type: "Feature", title: "Moved feature" }],
    });
    expect(
      await queryItemMetadataIndex({
        pmRoot: root,
        expectedSourceCursor: "cursor-2",
        query: { metadataKeys: ["customer"] },
      }),
    ).toMatchObject({ total: 1, items: [{ id: "pm-a" }] });
    expect(
      await updateItemMetadataQueryIndex({
        pmRoot: root,
        contextFingerprint: "context-1",
        expectedSourceCursor: "cursor-2",
        sourceCursor: "cursor-2a",
        row: null,
      }),
    ).toBe(true);
    expect(
      await updateItemMetadataQueryIndex({
        pmRoot: root,
        contextFingerprint: "wrong",
        expectedSourceCursor: "cursor-2a",
        sourceCursor: "cursor-3",
        row: null,
      }),
    ).toBe(false);
    expect(
      await updateItemMetadataQueryIndex({
        pmRoot: root,
        contextFingerprint: "context-1",
        expectedSourceCursor: "cursor-2a",
        sourceCursor: "cursor-3",
        row: null,
        deletedRelativePaths: ["features/pm-a.toon"],
      }),
    ).toBe(true);
    expect(
      await queryItemMetadataIndex({
        pmRoot: root,
        expectedSourceCursor: "cursor-3",
      }),
    ).toMatchObject({ total: 0, items: [] });
    const databaseAfterDelete = new DatabaseSync(
      path.join(root, "runtime", "metadata-query-index.sqlite"),
      { readOnly: true },
    );
    expect(
      databaseAfterDelete
        .prepare("SELECT COUNT(*) AS count FROM item_metadata_keys")
        .get(),
    ).toEqual({ count: 0 });
    databaseAfterDelete.close();

    await rebuildItemMetadataQueryIndex({
      pmRoot: root,
      contextFingerprint: "context-2",
      sourceCursor: "cursor-4",
      rows: [],
    });
    expect(
      await queryItemMetadataIndex({
        pmRoot: root,
        expectedSourceCursor: "cursor-4",
        query: { offset: 2 },
      }),
    ).toMatchObject({ total: 0, items: [] });
    await removeItemMetadataQueryIndex(root);
    expect(
      await queryItemMetadataIndex({
        pmRoot: root,
        expectedSourceCursor: "cursor-4",
      }),
    ).toBeNull();
    expect(
      await updateItemMetadataQueryIndex({
        pmRoot: root,
        contextFingerprint: "context-2",
        expectedSourceCursor: "cursor-4",
        sourceCursor: "cursor-5",
        row: null,
      }),
    ).toBe(false);
  });

  it("keeps the previous projection when an atomic rebuild fails", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pm-query-fail-"));
    roots.push(root);
    await rebuildItemMetadataQueryIndex({
      pmRoot: root,
      contextFingerprint: "context-1",
      sourceCursor: "cursor-1",
      rows: [
        {
          relativePath: "tasks/pm-a.toon",
          metadata: metadata("pm-a"),
        },
      ],
    });
    await expect(
      rebuildItemMetadataQueryIndex({
        pmRoot: root,
        contextFingerprint: "context-2",
        sourceCursor: "cursor-2",
        rows: [
          {
            relativePath: "tasks/duplicate.toon",
            metadata: metadata("pm-a"),
          },
          {
            relativePath: "tasks/duplicate.toon",
            metadata: metadata("pm-b"),
          },
        ],
      }),
    ).rejects.toThrow();
    expect(
      await queryItemMetadataIndex({
        pmRoot: root,
        expectedSourceCursor: "cursor-1",
      }),
    ).toMatchObject({ total: 1, items: [{ id: "pm-a" }] });

    const database = new DatabaseSync(
      path.join(root, "runtime", "metadata-query-index.sqlite"),
    );
    database
      .prepare("UPDATE items SET metadata_json = ? WHERE id = ?")
      .run("{}", "pm-a");
    database.close();
    expect(
      await queryItemMetadataIndex({
        pmRoot: root,
        expectedSourceCursor: "cursor-1",
      }),
    ).toBeNull();
  });
});
