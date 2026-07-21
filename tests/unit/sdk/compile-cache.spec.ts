import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  pruneCompileCacheGenerations,
  resolveCompileCacheGeneration,
} from "../../../src/sdk/compile-cache.js";

describe("compile-cache lifecycle", () => {
  it("derives safe package-version and development generation keys", () => {
    expect(resolveCompileCacheGeneration("2026.7.21+build/one")).toBe(
      "2026.7.21_build_one",
    );
    expect(resolveCompileCacheGeneration(undefined)).toBe("development");
  });

  it("retains only the current pm generation in deterministic order", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pm-compile-cache-"));
    try {
      await mkdir(path.join(root, "2026.7.21"));
      await mkdir(path.join(root, "2026.7.20", "node-cache"), {
        recursive: true,
      });
      await writeFile(path.join(root, "legacy-cache-entry"), "stale", "utf8");

      expect(pruneCompileCacheGenerations(root, "2026.7.21")).toEqual({
        retained: "2026.7.21",
        removed: ["2026.7.20", "legacy-cache-entry"],
      });
      expect(
        pruneCompileCacheGenerations(root, "2026.7.21"),
      ).toEqual({ retained: "2026.7.21", removed: [] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects empty or path-traversing generation keys before deletion", () => {
    for (const generation of ["", "../other-cache", "nested/cache"]) {
      expect(() =>
        pruneCompileCacheGenerations("/tmp/pm-cache-not-touched", generation),
      ).toThrow(TypeError);
    }
  });
});
