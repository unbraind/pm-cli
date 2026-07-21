import fs from "node:fs";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  pruneCompileCacheGenerations,
  resolveCompileCacheGeneration,
} from "../../../src/sdk/compile-cache.js";

describe("compile-cache lifecycle", () => {
  it("derives safe package-version and development generation keys", () => {
    expect(resolveCompileCacheGeneration("2026.7.21+build/one")).toBe(
      "2026.7.21_build_one",
    );
    expect(resolveCompileCacheGeneration("@org/package")).toBe("_org_package");
    expect(resolveCompileCacheGeneration(".candidate")).toBe("_candidate");
    expect(resolveCompileCacheGeneration("..")).toBe("_.");
    expect(resolveCompileCacheGeneration("")).toBe("development");
    expect(resolveCompileCacheGeneration(undefined)).toBe("development");
  });

  it("protects fresh concurrent generations and prunes stale entries beyond the bound", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pm-compile-cache-"));
    try {
      await mkdir(path.join(root, "fresh-concurrent"));
      await mkdir(path.join(root, "stale-new", "node-cache"), {
        recursive: true,
      });
      await mkdir(path.join(root, "stale-middle"));
      await writeFile(path.join(root, "stale-old"), "stale", "utf8");
      const now = Date.now();
      await utimes(
        path.join(root, "stale-new"),
        new Date(now - 600_000),
        new Date(now - 600_000),
      );
      await utimes(
        path.join(root, "stale-middle"),
        new Date(now - 800_000),
        new Date(now - 800_000),
      );
      await utimes(
        path.join(root, "stale-old"),
        new Date(now - 800_000),
        new Date(now - 800_000),
      );

      const scopedPackageGeneration = resolveCompileCacheGeneration("@org/package");
      expect(pruneCompileCacheGenerations(root, scopedPackageGeneration)).toEqual({
        retained: "_org_package",
        removed: ["stale-middle", "stale-old"],
      });
      expect(
        pruneCompileCacheGenerations(root, scopedPackageGeneration),
      ).toEqual({ retained: "_org_package", removed: [] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects empty or path-traversing generation keys before deletion", () => {
    for (const generation of [
      "",
      ".",
      "..",
      "../other-cache",
      "nested/cache",
      "bad:name",
    ]) {
      expect(() =>
        pruneCompileCacheGenerations("/tmp/pm-cache-not-touched", generation),
      ).toThrow(TypeError);
    }
  });

  it("ignores candidates removed by a concurrent prune and rethrows other stat failures", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pm-compile-cache-race-"));
    try {
      const candidate = path.join(root, "concurrent-candidate");
      await mkdir(candidate);
      const originalStatSync = fs.statSync;
      vi.spyOn(fs, "statSync").mockImplementationOnce((target) => {
        fs.rmSync(candidate, { recursive: true, force: true });
        return originalStatSync(target);
      });
      expect(pruneCompileCacheGenerations(root, "current")).toEqual({
        retained: "current",
        removed: [],
      });

      for (const failure of [
        "non-error failure",
        new Error("missing error code"),
        Object.assign(new Error("permission denied"), { code: "EACCES" }),
      ]) {
        await mkdir(candidate, { recursive: true });
        vi.spyOn(fs, "statSync").mockImplementationOnce(() => {
          throw failure;
        });
        expect(() =>
          pruneCompileCacheGenerations(root, "current"),
        ).toThrow();
      }
    } finally {
      vi.restoreAllMocks();
      await rm(root, { recursive: true, force: true });
    }
  });
});
