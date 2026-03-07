import fs from "node:fs/promises";
import path from "node:path";
import { runActiveOnWriteHooks } from "../../core/extensions/index.js";
import { pathExists } from "../../core/fs/fs-utils.js";
import { normalizePrefix } from "../../core/item/id.js";
import { PM_REQUIRED_SUBDIRS, SETTINGS_DEFAULTS } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { resolvePmRoot } from "../../core/store/paths.js";
import { readSettings, writeSettings } from "../../core/store/settings.js";
import type { PmSettings } from "../../types/index.js";

export interface InitResult {
  ok: boolean;
  path: string;
  settings: PmSettings;
  created_dirs: string[];
  warnings: string[];
}

function cloneDefaults(): PmSettings {
  return structuredClone(SETTINGS_DEFAULTS);
}

export async function runInit(prefixArg: string | undefined, global: GlobalOptions): Promise<InitResult> {
  const cwd = process.cwd();
  const pmRoot = resolvePmRoot(cwd, global.path);
  const createdDirs: string[] = [];
  const warnings: string[] = [];

  for (const subdir of PM_REQUIRED_SUBDIRS) {
    const target = subdir ? path.join(pmRoot, subdir) : pmRoot;
    const existed = await pathExists(target);
    await fs.mkdir(target, { recursive: true });
    if (existed) {
      warnings.push(`already_exists:${target}`);
    } else {
      createdDirs.push(target);
    }
    warnings.push(
      ...(await runActiveOnWriteHooks({
        path: target,
        scope: "project",
        op: "init:ensure_dir",
      })),
    );
  }

  const settingsPath = path.join(pmRoot, "settings.json");
  const settingsExists = await pathExists(settingsPath);
  const normalizedPrefix = normalizePrefix(prefixArg);

  let settings: PmSettings;
  if (settingsExists) {
    settings = await readSettings(pmRoot);
    warnings.push(`already_exists:${settingsPath}`);
    if (prefixArg !== undefined && settings.id_prefix !== normalizedPrefix) {
      settings.id_prefix = normalizedPrefix;
      await writeSettings(pmRoot, settings);
      warnings.push(`updated:id_prefix:${normalizedPrefix}`);
    }
  } else {
    settings = cloneDefaults();
    settings.id_prefix = normalizedPrefix;
    await writeSettings(pmRoot, settings);
  }

  return {
    ok: true,
    path: pmRoot,
    settings,
    created_dirs: createdDirs,
    warnings,
  };
}
