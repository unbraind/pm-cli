import fs from "node:fs/promises";
import path from "node:path";
import { runActiveOnIndexHooks, runActiveOnReadHooks, runActiveOnWriteHooks } from "../../core/extensions/index.js";
import { pathExists } from "../../core/fs/fs-utils.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { nowIso } from "../../core/shared/time.js";
import { getSettingsPath, resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";

const GC_TARGETS = ["index/manifest.json", "search/embeddings.jsonl"] as const;

export interface GcResult {
  ok: boolean;
  removed: string[];
  retained: string[];
  warnings: string[];
  generated_at: string;
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === code;
}

async function removeCacheFile(
  pmRoot: string,
  relativePath: (typeof GC_TARGETS)[number],
): Promise<{ removed: boolean; warnings: string[] }> {
  const absolutePath = path.join(pmRoot, relativePath);
  const warnings = await runActiveOnReadHooks({
    path: absolutePath,
    scope: "project",
  });
  try {
    const stats = await fs.stat(absolutePath);
    if (!stats.isFile()) {
      return {
        removed: false,
        warnings: [...warnings, `not_a_file:${relativePath}`],
      };
    }
    await fs.unlink(absolutePath);
    const writeWarnings = await runActiveOnWriteHooks({
      path: absolutePath,
      scope: "project",
      op: "gc:remove",
    });
    return {
      removed: true,
      warnings: [...warnings, ...writeWarnings],
    };
  } catch (error: unknown) {
    if (isErrno(error, "ENOENT")) {
      return {
        removed: false,
        warnings,
      };
    }
    throw error;
  }
}

export async function runGc(global: GlobalOptions): Promise<GcResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(`Tracker is not initialized at ${pmRoot}. Run pm init first.`, EXIT_CODE.NOT_FOUND);
  }

  await readSettings(pmRoot);

  const removed: string[] = [];
  const retained: string[] = [];
  const warnings: string[] = [];

  for (const target of GC_TARGETS) {
    const result = await removeCacheFile(pmRoot, target);
    if (result.removed) {
      removed.push(target);
    } else {
      retained.push(target);
    }
    warnings.push(...result.warnings);
  }
  warnings.push(
    ...(await runActiveOnIndexHooks({
      mode: "gc",
      total_items: GC_TARGETS.length,
    })),
  );

  return {
    ok: warnings.length === 0,
    removed,
    retained,
    warnings,
    generated_at: nowIso(),
  };
}
