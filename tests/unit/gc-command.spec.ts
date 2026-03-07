import fs, { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runGc } from "../../src/cli/commands/gc.js";
import { clearActiveExtensionHooks, setActiveExtensionHooks } from "../../src/core/extensions/index.js";
import { EXIT_CODE } from "../../src/constants.js";
import { PmCliError } from "../../src/errors.js";
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
      await writeFile(path.join(context.pmPath, "index", "manifest.json"), '{"seed":true}\n', "utf8");
      await writeFile(path.join(context.pmPath, "search", "embeddings.jsonl"), '{"id":"seed"}\n', "utf8");

      const gc = await runGc({ path: context.pmPath });
      expect(gc.ok).toBe(true);
      expect(gc.removed).toEqual(["index/manifest.json", "search/embeddings.jsonl"]);
      expect(gc.retained).toEqual([]);
      expect(gc.warnings).toEqual([]);
      expect(gc.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      const gcSecondRun = await runGc({ path: context.pmPath });
      expect(gcSecondRun.ok).toBe(true);
      expect(gcSecondRun.removed).toEqual([]);
      expect(gcSecondRun.retained).toEqual(["index/manifest.json", "search/embeddings.jsonl"]);
      expect(gcSecondRun.warnings).toEqual([]);
    });
  });

  it("reports warning when cache target is not a file", async () => {
    await withTempPmPath(async (context) => {
      await mkdir(path.join(context.pmPath, "index", "manifest.json"), { recursive: true });
      await writeFile(path.join(context.pmPath, "search", "embeddings.jsonl"), '{"id":"seed"}\n', "utf8");

      const gc = await runGc({ path: context.pmPath });
      expect(gc.ok).toBe(false);
      expect(gc.removed).toEqual(["search/embeddings.jsonl"]);
      expect(gc.retained).toEqual(["index/manifest.json"]);
      expect(gc.warnings).toEqual(["not_a_file:index/manifest.json"]);
    });
  });

  it("dispatches active read/write hooks for gc cache targets", async () => {
    await withTempPmPath(async (context) => {
      await writeFile(path.join(context.pmPath, "index", "manifest.json"), '{"seed":true}\n', "utf8");
      await writeFile(path.join(context.pmPath, "search", "embeddings.jsonl"), '{"id":"seed"}\n', "utf8");

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
      expect(gc.removed).toEqual(["index/manifest.json", "search/embeddings.jsonl"]);
      expect(gc.retained).toEqual([]);
      expect(gc.warnings).toEqual([
        "extension_hook_failed:project:boom-read-hook:onRead",
        "extension_hook_failed:project:boom-read-hook:onRead",
      ]);
      expect(events).toContain("read:manifest.json");
      expect(events).toContain("read:embeddings.jsonl");
      expect(events).toContain("write:gc:remove:manifest.json");
      expect(events).toContain("write:gc:remove:embeddings.jsonl");
      expect(events).toContain("index:gc:2");
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
      expect(gc.retained).toEqual(["index/manifest.json", "search/embeddings.jsonl"]);
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
