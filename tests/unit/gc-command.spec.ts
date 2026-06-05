import fs, { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runGc } from "../../src/cli/commands/gc.js";
import { clearActiveExtensionHooks, setActiveExtensionHooks } from "../../src/core/extensions/index.js";
import { EXIT_CODE } from "../../src/core/shared/constants.js";
import { PmCliError } from "../../src/core/shared/errors.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

describe("runGc", () => {
  afterEach(() => {
    clearActiveExtensionHooks();
  });

  it("fails when tracker is not initialized", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pm-gc-not-init-"));
    try {
      await expect(runGc({ path: tempDir })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("removes known cache files deterministically", async () => {
    await withTempPmPath(async (context) => {
      await mkdir(path.join(context.pmPath, "index"), { recursive: true });
      await writeFile(path.join(context.pmPath, "index", "manifest.json"), '{"seed":true}\n', "utf8");
      await writeFile(path.join(context.pmPath, "search", "embeddings.jsonl"), '{"id":"seed"}\n', "utf8");
      await writeFile(path.join(context.pmPath, "search", "vectorization-status.json"), '{"version":1,"items":[]}\n', "utf8");
      await mkdir(path.join(context.pmPath, "search", "lancedb"), { recursive: true });
      await writeFile(path.join(context.pmPath, "search", "lancedb", "vectors.jsonl"), '{"id":"seed"}\n', "utf8");

      const gc = await runGc({ path: context.pmPath });
      expect(gc.ok).toBe(true);
      expect(gc.dry_run).toBe(false);
      expect(gc.scope).toEqual(["index", "embeddings", "runtime", "locks"]);
      expect(gc.removed).toEqual([
        "index/manifest.json",
        "search/embeddings.jsonl",
        "search/vectorization-status.json",
        "search/lancedb",
      ]);
      expect(gc.retained).toEqual(["runtime/test-runs"]);
      expect(gc.warnings).toEqual([]);
      expect(gc.guidance).toEqual([
        'Search artifacts were removed; run "pm install search-advanced --project" if reindex is unavailable, then "pm reindex --mode keyword" (and "--mode semantic" when semantic search is enabled) before search-heavy workflows.',
      ]);
      expect(gc.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      const gcSecondRun = await runGc({ path: context.pmPath });
      expect(gcSecondRun.ok).toBe(true);
      expect(gcSecondRun.removed).toEqual([]);
      expect(gcSecondRun.retained).toEqual([
        "index/manifest.json",
        "search/embeddings.jsonl",
        "search/vectorization-status.json",
        "search/lancedb",
        "runtime/test-runs",
      ]);
      expect(gcSecondRun.warnings).toEqual([]);
      expect(gcSecondRun.guidance).toEqual([]);
    });
  });

  it("reports warning when cache target is not a file", async () => {
    await withTempPmPath(async (context) => {
      await mkdir(path.join(context.pmPath, "index", "manifest.json"), { recursive: true });
      await writeFile(path.join(context.pmPath, "search", "embeddings.jsonl"), '{"id":"seed"}\n', "utf8");

      const gc = await runGc({ path: context.pmPath });
      expect(gc.ok).toBe(false);
      expect(gc.removed).toEqual(["search/embeddings.jsonl"]);
      expect(gc.retained).toEqual([
        "index/manifest.json",
        "search/vectorization-status.json",
        "search/lancedb",
        "runtime/test-runs",
      ]);
      expect(gc.warnings).toEqual(["not_a_file:index/manifest.json"]);
    });
  });

  it("reports warning when runtime scope target is not a directory", async () => {
    await withTempPmPath(async (context) => {
      await mkdir(path.join(context.pmPath, "runtime"), { recursive: true });
      await writeFile(path.join(context.pmPath, "runtime", "test-runs"), "seed\n", "utf8");

      const gc = await runGc({ path: context.pmPath }, { scope: ["runtime"] });
      expect(gc.ok).toBe(false);
      expect(gc.removed).toEqual([]);
      expect(gc.retained).toEqual(["runtime/test-runs"]);
      expect(gc.warnings).toEqual(["not_a_directory:runtime/test-runs"]);
    });
  });

  it("supports dry-run previews without mutating files", async () => {
    await withTempPmPath(async (context) => {
      await mkdir(path.join(context.pmPath, "index"), { recursive: true });
      await writeFile(path.join(context.pmPath, "index", "manifest.json"), '{"seed":true}\n', "utf8");
      await writeFile(path.join(context.pmPath, "search", "embeddings.jsonl"), '{"id":"seed"}\n', "utf8");
      await writeFile(path.join(context.pmPath, "search", "vectorization-status.json"), '{"version":1,"items":[]}\n', "utf8");
      await mkdir(path.join(context.pmPath, "search", "lancedb"), { recursive: true });
      await mkdir(path.join(context.pmPath, "runtime", "test-runs"), { recursive: true });
      await writeFile(path.join(context.pmPath, "runtime", "test-runs", "seed.log"), "seed\n", "utf8");

      const gc = await runGc(
        { path: context.pmPath },
        {
          dryRun: true,
        },
      );
      expect(gc.ok).toBe(true);
      expect(gc.dry_run).toBe(true);
      expect(gc.scope).toEqual(["index", "embeddings", "runtime", "locks"]);
      expect(gc.removed).toEqual([
        "index/manifest.json",
        "search/embeddings.jsonl",
        "search/vectorization-status.json",
        "search/lancedb",
        "runtime/test-runs",
      ]);
      expect(gc.retained).toEqual([]);
      expect(gc.guidance).toEqual([
        "Dry-run preview only: no cache artifacts were deleted.",
        'Search artifacts were removed; run "pm install search-advanced --project" if reindex is unavailable, then "pm reindex --mode keyword" (and "--mode semantic" when semantic search is enabled) before search-heavy workflows.',
      ]);

      await expect(fs.stat(path.join(context.pmPath, "index", "manifest.json"))).resolves.toBeTruthy();
      await expect(fs.stat(path.join(context.pmPath, "search", "embeddings.jsonl"))).resolves.toBeTruthy();
      await expect(fs.stat(path.join(context.pmPath, "search", "vectorization-status.json"))).resolves.toBeTruthy();
      await expect(fs.stat(path.join(context.pmPath, "search", "lancedb"))).resolves.toBeTruthy();
      await expect(fs.stat(path.join(context.pmPath, "runtime", "test-runs", "seed.log"))).resolves.toBeTruthy();
    });
  });

  it("supports scoped cleanup for index/embeddings/runtime", async () => {
    await withTempPmPath(async (context) => {
      await mkdir(path.join(context.pmPath, "index"), { recursive: true });
      await writeFile(path.join(context.pmPath, "index", "manifest.json"), '{"seed":true}\n', "utf8");
      await writeFile(path.join(context.pmPath, "search", "embeddings.jsonl"), '{"id":"seed"}\n', "utf8");
      await writeFile(path.join(context.pmPath, "search", "vectorization-status.json"), '{"version":1,"items":[]}\n', "utf8");
      await mkdir(path.join(context.pmPath, "search", "lancedb"), { recursive: true });
      await mkdir(path.join(context.pmPath, "runtime", "test-runs"), { recursive: true });
      await writeFile(path.join(context.pmPath, "runtime", "test-runs", "seed.log"), "seed\n", "utf8");

      const indexOnly = await runGc({ path: context.pmPath }, { scope: ["index"] });
      expect(indexOnly.scope).toEqual(["index"]);
      expect(indexOnly.removed).toEqual(["index/manifest.json"]);
      expect(indexOnly.retained).toEqual([]);
      await expect(fs.stat(path.join(context.pmPath, "search", "embeddings.jsonl"))).resolves.toBeTruthy();
      await expect(fs.stat(path.join(context.pmPath, "runtime", "test-runs"))).resolves.toBeTruthy();

      const runtimeOnly = await runGc({ path: context.pmPath }, { scope: ["runtime"] });
      expect(runtimeOnly.scope).toEqual(["runtime"]);
      expect(runtimeOnly.removed).toEqual(["runtime/test-runs"]);
      expect(runtimeOnly.retained).toEqual([]);
      await expect(fs.stat(path.join(context.pmPath, "runtime", "test-runs"))).rejects.toBeTruthy();

      const embeddingsOnly = await runGc({ path: context.pmPath }, { scope: ["embeddings"] });
      expect(embeddingsOnly.scope).toEqual(["embeddings"]);
      expect(embeddingsOnly.removed).toEqual([
        "search/embeddings.jsonl",
        "search/vectorization-status.json",
        "search/lancedb",
      ]);
      expect(embeddingsOnly.retained).toEqual([]);
    });
  });

  it("sweeps expired lock debris under the locks scope and retains active locks", async () => {
    await withTempPmPath(async (context) => {
      const locksDir = path.join(context.pmPath, "locks");
      await mkdir(locksDir, { recursive: true });
      const stale = {
        id: "pm-old1",
        pid: 4242,
        owner: "crashed-agent",
        created_at: new Date(Date.now() - 10 * 3600 * 1000).toISOString(),
        ttl_seconds: 1800,
      };
      const fresh = {
        id: "pm-new1",
        pid: 99,
        owner: "live-agent",
        created_at: new Date().toISOString(),
        ttl_seconds: 1800,
      };
      await writeFile(path.join(locksDir, "pm-old1.lock"), JSON.stringify(stale), "utf8");
      await writeFile(path.join(locksDir, "pm-new1.lock"), JSON.stringify(fresh), "utf8");

      const writeOps: string[] = [];
      setActiveExtensionHooks({
        beforeCommand: [],
        afterCommand: [],
        onWrite: [
          {
            layer: "project",
            name: "lock-gc-write-hook",
            run: (hookContext) => {
              writeOps.push(`${hookContext.op}:${path.basename(hookContext.path)}`);
            },
          },
        ],
        onRead: [],
        onIndex: [],
      });

      const gc = await runGc({ path: context.pmPath }, { scope: ["locks"] });
      expect(gc.scope).toEqual(["locks"]);
      expect(gc.ok).toBe(true);
      expect(gc.removed).toEqual(["locks/pm-old1.lock"]);
      expect(gc.retained).toEqual(["locks/pm-new1.lock"]);
      expect(gc.locks).toEqual({ scanned: 2, removed: 1, retained: 1 });
      expect(writeOps).toEqual(["gc:lock_remove:pm-old1.lock"]);

      await expect(fs.stat(path.join(locksDir, "pm-old1.lock"))).rejects.toBeTruthy();
      await expect(fs.stat(path.join(locksDir, "pm-new1.lock"))).resolves.toBeTruthy();
    });
  });

  it("omits the locks summary when the locks scope is not selected", async () => {
    await withTempPmPath(async (context) => {
      const gc = await runGc({ path: context.pmPath }, { scope: ["index"] });
      expect(gc.scope).toEqual(["index"]);
      expect(gc.locks).toBeUndefined();
    });
  });

  it("rejects invalid gc scope values", async () => {
    await withTempPmPath(async (context) => {
      await expect(runGc({ path: context.pmPath }, { scope: ["index,invalid"] })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(runGc({ path: context.pmPath }, { scope: [" , "] })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
    });
  });

  it("dispatches active read/write hooks for gc cache targets", async () => {
    await withTempPmPath(async (context) => {
      await mkdir(path.join(context.pmPath, "index"), { recursive: true });
      await writeFile(path.join(context.pmPath, "index", "manifest.json"), '{"seed":true}\n', "utf8");
      await writeFile(path.join(context.pmPath, "search", "embeddings.jsonl"), '{"id":"seed"}\n', "utf8");
      await writeFile(path.join(context.pmPath, "search", "vectorization-status.json"), '{"version":1,"items":[]}\n', "utf8");
      await mkdir(path.join(context.pmPath, "search", "lancedb"), { recursive: true });

      const events: string[] = [];
      setActiveExtensionHooks({
        beforeCommand: [],
        afterCommand: [],
        onWrite: [
          {
            layer: "project",
            name: "gc-write-hook",
            run: (hookContext) => {
              events.push(`write:${hookContext.op}:${path.basename(hookContext.path)}`);
            },
          },
        ],
        onRead: [
          {
            layer: "project",
            name: "gc-read-hook",
            run: (hookContext) => {
              events.push(`read:${path.basename(hookContext.path)}`);
            },
          },
          {
            layer: "project",
            name: "boom-read-hook",
            run: () => {
              throw new Error("boom-read");
            },
          },
        ],
        onIndex: [
          {
            layer: "project",
            name: "gc-index-hook",
            run: (hookContext) => {
              events.push(`index:${hookContext.mode}:${hookContext.total_items ?? -1}`);
            },
          },
        ],
      });

      const gc = await runGc({ path: context.pmPath });
      expect(gc.ok).toBe(false);
      expect(gc.removed).toEqual([
        "index/manifest.json",
        "search/embeddings.jsonl",
        "search/vectorization-status.json",
        "search/lancedb",
      ]);
      expect(gc.retained).toEqual(["runtime/test-runs"]);
      expect(gc.warnings).toEqual([
        "extension_hook_failed:project:boom-read-hook:onRead",
        "extension_hook_failed:project:boom-read-hook:onRead",
        "extension_hook_failed:project:boom-read-hook:onRead",
        "extension_hook_failed:project:boom-read-hook:onRead",
        "extension_hook_failed:project:boom-read-hook:onRead",
      ]);
      expect(events).toContain("read:manifest.json");
      expect(events).toContain("read:embeddings.jsonl");
      expect(events).toContain("read:vectorization-status.json");
      expect(events).toContain("read:lancedb");
      expect(events).toContain("read:test-runs");
      expect(events).toContain("write:gc:remove:manifest.json");
      expect(events).toContain("write:gc:remove:embeddings.jsonl");
      expect(events).toContain("write:gc:remove:vectorization-status.json");
      expect(events).toContain("write:gc:remove:lancedb");
      expect(events).toContain("index:gc:5");
    });
  });

  it("propagates onIndex hook failures as deterministic warnings", async () => {
    await withTempPmPath(async (context) => {
      setActiveExtensionHooks({
        beforeCommand: [],
        afterCommand: [],
        onWrite: [],
        onRead: [],
        onIndex: [
          {
            layer: "project",
            name: "boom-index-hook",
            run: () => {
              throw new Error("boom-index");
            },
          },
        ],
      });

      const gc = await runGc({ path: context.pmPath });
      expect(gc.ok).toBe(false);
      expect(gc.removed).toEqual([]);
      expect(gc.retained).toEqual([
        "index/manifest.json",
        "search/embeddings.jsonl",
        "search/vectorization-status.json",
        "search/lancedb",
        "runtime/test-runs",
      ]);
      expect(gc.warnings).toEqual(["extension_hook_failed:project:boom-index-hook:onIndex"]);
    });
  });

  it("rethrows unexpected filesystem errors", async () => {
    await withTempPmPath(async (context) => {
      const statSpy = vi.spyOn(fs, "stat").mockRejectedValueOnce(new Error("stat failure"));
      try {
        await expect(runGc({ path: context.pmPath })).rejects.toThrow("stat failure");
      } finally {
        statSpy.mockRestore();
      }
    });
  });
});
