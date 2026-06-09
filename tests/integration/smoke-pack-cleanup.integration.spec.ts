import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cleanupTempRoot } from "../../scripts/smoke-cleanup.mjs";

describe("packed smoke cleanup helper", () => {
  it("removes nested smoke temp directories", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "pm-pack-cleanup-test-"));
    try {
      const nested = path.join(root, "project", ".agents", "pm");
      mkdirSync(nested, { recursive: true });
      writeFileSync(path.join(nested, "seed.txt"), "seed");
      cleanupTempRoot(root);
      expect(existsSync(root)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("is a no-op when the directory is already gone", () => {
    const root = path.join(os.tmpdir(), `pm-pack-cleanup-missing-${Date.now()}`);
    expect(() => cleanupTempRoot(root)).not.toThrow();
  });
});
