import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFileAtomic } from "../../../../src/core/fs/atomic-create.js";

describe("atomic seed publication", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "pm-seed-test-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("publishes complete bytes once and preserves an existing document", async () => {
    const target = path.join(root, "schema.json");
    const results = await Promise.all([createFileAtomic(target, "first"), createFileAtomic(target, "second")]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await readFile(target, "utf8")).toBe(results[0] ? "first" : "second");
    await writeFile(target, "custom definition");
    expect(await createFileAtomic(target, "seed")).toBe(false);
    expect(await readFile(target, "utf8")).toBe("custom definition");
    expect(await readdir(root)).toEqual(["schema.json"]);
  });

  it("cleans staging bytes when the filesystem refuses the destination", async () => {
    await expect(createFileAtomic(path.join(root, "x".repeat(300)), "seed")).rejects.toThrow();
    expect(await readdir(root)).toEqual([]);
  });
});
