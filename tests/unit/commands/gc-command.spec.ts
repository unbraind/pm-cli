import fs, { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runGc } from "../../../src/cli/commands/gc.js";
import { clearActiveExtensionHooks, setActiveExtensionHooks } from "../../../src/core/extensions/index.js";
import { EXIT_CODE } from "../../../src/core/shared/constants.js";
import { PmCliError } from "../../../src/core/shared/errors.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

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
      expect(gc.scope).toEqual(["index", "embeddings", "runtime", "locks", "checkpoints"]);
      expect(gc.removed).toEqual([
        "index/manifest.json",
        "search/embeddings.jsonl",
        "search/vectorization-status.json",
        "search/lancedb",
      ]);
      expect(gc.retained).toEqual([
        "search/pending-refresh.json",
        "search/pending-refresh.gate.lock",
        "runtime/test-runs",
        "runtime/history-drift-cache.json",
      ]);
      expect(gc.warnings).toEqual([]);
      expect(gc.checkpoints).toEqual({ scanned: 0, removed: 0, retained: 0, retention_days: 14 });
      expect(gc.guidance).toEqual([
        'Search artifacts were removed; the semantic index (including any queued background refresh) is invalidated. Run "pm install search-advanced --project" if reindex is unavailable, then "pm reindex --mode keyword" (and "--mode semantic" when semantic search is enabled) before search-heavy workflows.',
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
        "search/pending-refresh.json",
        "search/pending-refresh.gate.lock",
        "runtime/test-runs",
        "runtime/history-drift-cache.json",
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
        "search/pending-refresh.json",
        "search/pending-refresh.gate.lock",
        "runtime/test-runs",
        "runtime/history-drift-cache.json",
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
      expect(gc.retained).toEqual(["runtime/test-runs", "runtime/history-drift-cache.json"]);
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
      expect(gc.scope).toEqual(["index", "embeddings", "runtime", "locks", "checkpoints"]);
      expect(gc.removed).toEqual([
        "index/manifest.json",
        "search/embeddings.jsonl",
        "search/vectorization-status.json",
        "search/lancedb",
        "runtime/test-runs",
      ]);
      expect(gc.retained).toEqual([
        "search/pending-refresh.json",
        "search/pending-refresh.gate.lock",
        "runtime/history-drift-cache.json",
      ]);
      expect(gc.guidance).toEqual([
        "Dry-run preview only: no cache artifacts were deleted.",
        'Search artifacts were removed; the semantic index (including any queued background refresh) is invalidated. Run "pm install search-advanced --project" if reindex is unavailable, then "pm reindex --mode keyword" (and "--mode semantic" when semantic search is enabled) before search-heavy workflows.',
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
      await writeFile(path.join(context.pmPath, "runtime", "history-drift-cache.json"), '{"version":1,"entries":[]}\n', "utf8");

      const indexOnly = await runGc({ path: context.pmPath }, { scope: ["index"] });
      expect(indexOnly.scope).toEqual(["index"]);
      expect(indexOnly.removed).toEqual(["index/manifest.json"]);
      expect(indexOnly.retained).toEqual([]);
      await expect(fs.stat(path.join(context.pmPath, "search", "embeddings.jsonl"))).resolves.toBeTruthy();
      await expect(fs.stat(path.join(context.pmPath, "runtime", "test-runs"))).resolves.toBeTruthy();

      const runtimeOnly = await runGc({ path: context.pmPath }, { scope: ["runtime"] });
      expect(runtimeOnly.scope).toEqual(["runtime"]);
      expect(runtimeOnly.removed).toEqual(["runtime/test-runs", "runtime/history-drift-cache.json"]);
      expect(runtimeOnly.retained).toEqual([]);
      expect(runtimeOnly.guidance).toEqual([
        'History drift cache was removed; the next "pm health" run performs a full history-drift re-scan.',
      ]);
      await expect(fs.stat(path.join(context.pmPath, "runtime", "test-runs"))).rejects.toBeTruthy();
      await expect(fs.stat(path.join(context.pmPath, "runtime", "history-drift-cache.json"))).rejects.toBeTruthy();

      const embeddingsOnly = await runGc({ path: context.pmPath }, { scope: ["embeddings"] });
      expect(embeddingsOnly.scope).toEqual(["embeddings"]);
      expect(embeddingsOnly.removed).toEqual([
        "search/embeddings.jsonl",
        "search/vectorization-status.json",
        "search/lancedb",
      ]);
      expect(embeddingsOnly.retained).toEqual([
        "search/pending-refresh.json",
        "search/pending-refresh.gate.lock",
      ]);
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

  it("prunes aged rollback checkpoints under the checkpoints scope and retains fresh ones", async () => {
    await withTempPmPath(async (context) => {
      const updateManyDir = path.join(context.pmPath, "checkpoints", "update-many");
      await mkdir(updateManyDir, { recursive: true });
      const oldAt = new Date(Date.now() - 40 * 24 * 3600 * 1000).toISOString();
      const freshAt = new Date().toISOString();
      await writeFile(path.join(updateManyDir, "old.json"), JSON.stringify({ created_at: oldAt }), "utf8");
      await writeFile(path.join(updateManyDir, "fresh.json"), JSON.stringify({ created_at: freshAt }), "utf8");

      const writeOps: string[] = [];
      setActiveExtensionHooks({
        beforeCommand: [],
        afterCommand: [],
        onWrite: [
          {
            layer: "project",
            name: "checkpoint-gc-write-hook",
            run: (hookContext) => {
              writeOps.push(`${hookContext.op}:${path.basename(hookContext.path)}`);
            },
          },
        ],
        onRead: [],
        onIndex: [],
      });

      const gc = await runGc({ path: context.pmPath }, { scope: ["checkpoints"] });
      expect(gc.scope).toEqual(["checkpoints"]);
      expect(gc.removed).toEqual(["checkpoints/update-many/old.json"]);
      expect(gc.retained).toEqual(["checkpoints/update-many/fresh.json"]);
      expect(gc.checkpoints).toEqual({ scanned: 2, removed: 1, retained: 1, retention_days: 14 });
      expect(gc.guidance).toEqual([
        'Aged rollback checkpoints were removed; their "pm update-many"/"pm close-many --rollback" windows are no longer recoverable.',
      ]);
      expect(writeOps).toEqual(["gc:checkpoint_remove:old.json"]);
      await expect(fs.stat(path.join(updateManyDir, "old.json"))).rejects.toBeTruthy();
      await expect(fs.stat(path.join(updateManyDir, "fresh.json"))).resolves.toBeTruthy();
    });
  });

  it("omits the unrecoverable-checkpoints guidance under dry-run", async () => {
    await withTempPmPath(async (context) => {
      const updateManyDir = path.join(context.pmPath, "checkpoints", "update-many");
      await mkdir(updateManyDir, { recursive: true });
      const oldAt = new Date(Date.now() - 40 * 24 * 3600 * 1000).toISOString();
      await writeFile(path.join(updateManyDir, "old.json"), JSON.stringify({ created_at: oldAt }), "utf8");

      const gc = await runGc({ path: context.pmPath }, { scope: ["checkpoints"], dryRun: true });
      expect(gc.removed).toEqual(["checkpoints/update-many/old.json"]);
      expect(gc.guidance).toEqual(["Dry-run preview only: no cache artifacts were deleted."]);
      // The checkpoint must still exist after a dry run.
      await expect(fs.stat(path.join(updateManyDir, "old.json"))).resolves.toBeTruthy();
    });
  });

  it("honors a configured checkpoints.retention_days override", async () => {
    await withTempPmPath(async (context) => {
      const setResult = context.runCli(["config", "set", "checkpoints_retention_days", "3"]);
      expect(setResult.code).toBe(0);
      const updateManyDir = path.join(context.pmPath, "checkpoints", "update-many");
      await mkdir(updateManyDir, { recursive: true });
      const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString();
      await writeFile(path.join(updateManyDir, "c.json"), JSON.stringify({ created_at: fiveDaysAgo }), "utf8");

      const gc = await runGc({ path: context.pmPath }, { scope: ["checkpoints"] });
      expect(gc.checkpoints).toEqual({ scanned: 1, removed: 1, retained: 0, retention_days: 3 });
      expect(gc.removed).toEqual(["checkpoints/update-many/c.json"]);
    });
  });

  it("omits the checkpoints summary when the checkpoints scope is not selected", async () => {
    await withTempPmPath(async (context) => {
      const gc = await runGc({ path: context.pmPath }, { scope: ["index"] });
      expect(gc.checkpoints).toBeUndefined();
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
      expect(gc.retained).toEqual([
        "search/pending-refresh.json",
        "search/pending-refresh.gate.lock",
        "runtime/test-runs",
        "runtime/history-drift-cache.json",
      ]);
      expect(gc.warnings).toEqual([
        "extension_hook_failed:project:boom-read-hook:onRead",
        "extension_hook_failed:project:boom-read-hook:onRead",
        "extension_hook_failed:project:boom-read-hook:onRead",
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
      expect(events).toContain("read:history-drift-cache.json");
      expect(events).toContain("write:gc:remove:manifest.json");
      expect(events).toContain("write:gc:remove:embeddings.jsonl");
      expect(events).toContain("write:gc:remove:vectorization-status.json");
      expect(events).toContain("write:gc:remove:lancedb");
      expect(events).toContain("index:gc:8");
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
        "search/pending-refresh.json",
        "search/pending-refresh.gate.lock",
        "runtime/test-runs",
        "runtime/history-drift-cache.json",
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
