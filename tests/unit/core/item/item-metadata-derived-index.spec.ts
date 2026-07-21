import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { serializeItemDocument } from "../../../../src/core/item/item-format.js";
import {
  acquireItemMetadataDerivedIndexLock,
  clearItemMetadataEnvelopeMemo,
  listAllDocumentCandidatesCached,
  refreshItemMetadataDerivedIndex,
} from "../../../../src/core/store/item-metadata-cache.js";
import type { ItemMetadata } from "../../../../src/types.js";

const tempRoots: string[] = [];

async function withTempPmRoot(
  run: (pmRoot: string) => Promise<void>,
): Promise<void> {
  const pmRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pm-derived-index-"));
  tempRoots.push(pmRoot);
  await run(pmRoot);
}

function makeTaskMetadata(
  overrides: Partial<ItemMetadata> & Pick<ItemMetadata, "id">,
): ItemMetadata {
  return {
    id: overrides.id,
    title: overrides.title ?? overrides.id,
    description: "",
    type: "Task",
    status: "open",
    priority: 1,
    tags: [],
    created_at: "2026-07-21T00:00:00.000Z",
    updated_at: "2026-07-21T00:00:00.000Z",
    ...overrides,
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  clearItemMetadataEnvelopeMemo();
  await Promise.all(
    tempRoots
      .splice(0)
      .map((tempRoot) => fs.rm(tempRoot, { recursive: true, force: true })),
  );
});

describe("item metadata derived-index transactions", () => {
  it("keeps every tier warm across serialized item writes and deletes", async () => {
    await withTempPmRoot(async (pmRoot) => {
      const tasksDir = path.join(pmRoot, "tasks");
      await fs.mkdir(tasksDir, { recursive: true });
      const itemPath = path.join(tasksDir, "pm-index-transaction.toon");
      const original: ItemMetadata = {
        ...makeTaskMetadata({
          id: "pm-index-transaction",
          title: "Original indexed title",
        }),
        comments: [
          {
            created_at: "2026-07-21T00:00:00.000Z",
            author: "cache-test",
            text: "original collection",
          },
        ],
      };
      await fs.writeFile(
        itemPath,
        serializeItemDocument(
          { metadata: original, body: "original indexed body" },
          { format: "toon" },
        ),
        "utf8",
      );
      const typeToFolder = { Task: "tasks" };
      await listAllDocumentCandidatesCached(
        pmRoot,
        "toon",
        typeToFolder,
        [],
        undefined,
        { derivedIndexMinimumItems: 1 },
      );

      const updated: ItemMetadata = {
        ...original,
        title: "Updated indexed title",
        comments: [
          {
            created_at: "2026-07-21T00:01:00.000Z",
            author: "cache-test",
            text: "updated collection",
          },
        ],
      };
      const release = await acquireItemMetadataDerivedIndexLock(
        pmRoot,
        "cache-test",
      );
      try {
        await fs.writeFile(
          itemPath,
          serializeItemDocument(
            { metadata: updated, body: "updated indexed body" },
            { format: "toon" },
          ),
          "utf8",
        );
        expect(
          await refreshItemMetadataDerivedIndex({
            pmRoot,
            preferredFormat: "toon",
            typeToFolder,
            schema: undefined,
            itemPath,
            document: { metadata: updated, body: "updated indexed body" },
          }),
        ).toEqual([]);
      } finally {
        await release();
      }

      const readdirSpy = vi.spyOn(fs, "readdir");
      const indexed = await listAllDocumentCandidatesCached(
        pmRoot,
        "toon",
        typeToFolder,
        [],
        undefined,
        { derivedIndexMinimumItems: 1 },
      );
      expect(readdirSpy).not.toHaveBeenCalled();
      expect(indexed).toMatchObject([
        {
          body: "updated indexed body",
          metadata: {
            title: "Updated indexed title",
            comments: [{ text: "updated collection" }],
          },
        },
      ]);
      readdirSpy.mockRestore();

      await fs.writeFile(
        path.join(pmRoot, "runtime", "metadata-cache-delta.json"),
        "{}",
        "utf8",
      );
      clearItemMetadataEnvelopeMemo();
      expect(
        await listAllDocumentCandidatesCached(
          pmRoot,
          "toon",
          typeToFolder,
          [],
          undefined,
          { derivedIndexMinimumItems: 1 },
        ),
      ).toMatchObject([{ metadata: { title: "Updated indexed title" } }]);

      await fs.rm(itemPath);
      expect(
        await refreshItemMetadataDerivedIndex({
          pmRoot,
          preferredFormat: "toon",
          typeToFolder,
          schema: undefined,
          itemPath,
          document: null,
        }),
      ).toEqual([]);
      expect(
        await listAllDocumentCandidatesCached(
          pmRoot,
          "toon",
          typeToFolder,
          [],
          undefined,
          { derivedIndexMinimumItems: 1 },
        ),
      ).toEqual([]);
    });
  });

  it("serializes writers once the default scale threshold is active", async () => {
    await withTempPmRoot(async (pmRoot) => {
      const tasksDir = path.join(pmRoot, "tasks");
      await fs.mkdir(tasksDir, { recursive: true });
      await Promise.all(
        Array.from({ length: 500 }, async (_, index) => {
          const id = `pm-lock-${String(index).padStart(3, "0")}`;
          await fs.writeFile(
            path.join(tasksDir, `${id}.toon`),
            serializeItemDocument(
              { metadata: makeTaskMetadata({ id }), body: "" },
              { format: "toon" },
            ),
            "utf8",
          );
        }),
      );
      await listAllDocumentCandidatesCached(
        pmRoot,
        "toon",
        { Task: "tasks" },
        [],
        undefined,
        { includeBody: false, includeCollections: false },
      );

      const release = await acquireItemMetadataDerivedIndexLock(
        pmRoot,
        "cache-test",
      );
      await expect(
        fs.stat(path.join(pmRoot, "locks", "metadata-derived-index.lock")),
      ).resolves.toBeDefined();
      await release();

      await fs.writeFile(
        path.join(pmRoot, "runtime", "metadata-cache-manifest.json"),
        "{}",
        "utf8",
      );
      clearItemMetadataEnvelopeMemo();
      const releaseWithoutManifest = await acquireItemMetadataDerivedIndexLock(
        pmRoot,
        "cache-test",
      );
      await expect(
        fs.stat(path.join(pmRoot, "locks", "metadata-derived-index.lock")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await releaseWithoutManifest();
    });
  });

  it("invalidates unsafe or failed projections for source-scan recovery", async () => {
    await withTempPmRoot(async (pmRoot) => {
      const tasksDir = path.join(pmRoot, "tasks");
      await fs.mkdir(tasksDir, { recursive: true });
      const itemPath = path.join(tasksDir, "pm-index-recovery.toon");
      const document = {
        metadata: makeTaskMetadata({ id: "pm-index-recovery" }),
        body: "recovery body",
      };
      await fs.writeFile(
        itemPath,
        serializeItemDocument(document, { format: "toon" }),
        "utf8",
      );
      const typeToFolder = { Task: "tasks" };
      const buildIndex = async (): Promise<void> => {
        await listAllDocumentCandidatesCached(
          pmRoot,
          "toon",
          typeToFolder,
          [],
          undefined,
          { derivedIndexMinimumItems: 1 },
        );
      };
      await buildIndex();

      await fs.writeFile(
        path.join(pmRoot, "runtime", "metadata-cache-delta.json"),
        "{}",
        "utf8",
      );
      clearItemMetadataEnvelopeMemo();
      expect(
        await refreshItemMetadataDerivedIndex({
          pmRoot,
          preferredFormat: "toon",
          typeToFolder,
          schema: undefined,
          itemPath,
          document,
        }),
      ).toEqual(["metadata_derived_index_refresh_failed"]);
      await buildIndex();

      expect(
        await refreshItemMetadataDerivedIndex({
          pmRoot,
          preferredFormat: "toon",
          typeToFolder,
          schema: undefined,
          itemPath: path.join(pmRoot, "..", "outside.toon"),
          document,
        }),
      ).toEqual(["metadata_derived_index_path_invalidated"]);

      await buildIndex();
      expect(
        await refreshItemMetadataDerivedIndex({
          pmRoot,
          preferredFormat: "toon",
          typeToFolder,
          schema: undefined,
          itemPath: path.join(tasksDir, "missing.toon"),
          document,
        }),
      ).toEqual(["metadata_derived_index_refresh_failed"]);
      await expect(
        fs.stat(path.join(pmRoot, ".cache", "item-metadata.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });

      await buildIndex();
      const rmSpy = vi
        .spyOn(fs, "rm")
        .mockRejectedValueOnce(new Error("simulated cache removal failure"));
      expect(
        await refreshItemMetadataDerivedIndex({
          pmRoot,
          preferredFormat: "toon",
          typeToFolder,
          schema: undefined,
          itemPath: path.join(tasksDir, "still-missing.toon"),
          document,
        }),
      ).toEqual(["metadata_derived_index_refresh_failed"]);
      rmSpy.mockRestore();
    });
  });
});
