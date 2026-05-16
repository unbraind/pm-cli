import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { serializeItemDocument } from "../../src/core/item/item-format.js";
import { listAllDocumentCandidatesCached } from "../../src/core/store/front-matter-cache.js";
import type { ItemMetadata } from "../../src/types.js";

const tempRoots: string[] = [];

async function withTempPmRoot(run: (pmRoot: string) => Promise<void>): Promise<void> {
  const pmRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pm-front-matter-cache-"));
  tempRoots.push(pmRoot);
  await run(pmRoot);
}

function makeTaskMetadata(overrides: Partial<ItemMetadata> & Pick<ItemMetadata, "id">): ItemMetadata {
  return {
    id: overrides.id,
    title: overrides.title ?? overrides.id,
    description: overrides.description ?? "",
    type: overrides.type ?? "Task",
    status: overrides.status ?? "open",
    priority: overrides.priority ?? 1,
    tags: overrides.tags ?? [],
    created_at: overrides.created_at ?? "2026-05-16T00:00:00.000Z",
    updated_at: overrides.updated_at ?? "2026-05-16T00:00:00.000Z",
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempRoots.splice(0).map((tempRoot) => fs.rm(tempRoot, { recursive: true, force: true })));
});

describe("front matter cache", () => {
  it("serves cached item bodies for unchanged files and refreshes them after mutation", async () => {
    await withTempPmRoot(async (pmRoot) => {
      const tasksDir = path.join(pmRoot, "tasks");
      await fs.mkdir(tasksDir, { recursive: true });
      const itemPath = path.join(tasksDir, "pm-cache.toon");
      const metadata = makeTaskMetadata({ id: "pm-cache", title: "Cached body task" });
      await fs.writeFile(
        itemPath,
        serializeItemDocument({ metadata, body: "first cached body token" }, { format: "toon" }),
        "utf8",
      );

      const typeToFolder = { Task: "tasks" };
      const first = await listAllDocumentCandidatesCached(pmRoot, "toon", typeToFolder, [], undefined);
      expect(first).toHaveLength(1);
      expect(first[0]?.body).toBe("first cached body token");

      const readSpy = vi.spyOn(fs, "readFile");
      const second = await listAllDocumentCandidatesCached(pmRoot, "toon", typeToFolder, [], undefined);
      expect(second[0]?.body).toBe("first cached body token");
      expect(readSpy).not.toHaveBeenCalledWith(itemPath, "utf8");

      readSpy.mockRestore();
      await fs.writeFile(
        itemPath,
        serializeItemDocument({ metadata, body: "updated cached body token" }, { format: "toon" }),
        "utf8",
      );

      const third = await listAllDocumentCandidatesCached(pmRoot, "toon", typeToFolder, [], undefined);
      expect(third[0]?.body).toBe("updated cached body token");
    });
  });
});
