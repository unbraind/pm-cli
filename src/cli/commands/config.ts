import { pathExists } from "../../core/fs/fs-utils.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { migrateItemFilesToFormat } from "../../core/store/item-format-migration.js";
import {
  getSettingsPath,
  resolveGlobalPmRoot,
  resolvePmRoot,
} from "../../core/store/paths.js";
import { readSettingsWithMetadata, writeSettings } from "../../core/store/settings.js";
import type { ItemFormat } from "../../types/index.js";

const CONFIG_SCOPE_VALUES = ["project", "global"] as const;
type ConfigScope = (typeof CONFIG_SCOPE_VALUES)[number];

const CONFIG_KEY_VALUES = ["definition-of-done", "definition_of_done", "item-format", "item_format"] as const;
type ConfigAction = "get" | "set";
type ConfigKey = "definition_of_done" | "item_format";

export interface ConfigCommandOptions {
  criterion?: string[];
  format?: string;
}

export interface ConfigResult {
  scope: ConfigScope;
  key: ConfigKey;
  criteria?: string[];
  format?: ItemFormat;
  has_explicit_item_format?: boolean;
  migration?: {
    target_format: ItemFormat;
    scanned: number;
    migrated: string[];
    removed: string[];
    warnings: string[];
  };
  settings_path: string;
  changed: boolean;
}

function normalizeScope(value: string): ConfigScope {
  if ((CONFIG_SCOPE_VALUES as readonly string[]).includes(value)) {
    return value as ConfigScope;
  }
  throw new PmCliError(
    `Invalid config scope "${value}". Allowed: ${CONFIG_SCOPE_VALUES.join(", ")}`,
    EXIT_CODE.USAGE,
  );
}

function normalizeAction(value: string): ConfigAction {
  if (value === "get" || value === "set") {
    return value;
  }
  throw new PmCliError(`Invalid config action "${value}". Allowed: get, set`, EXIT_CODE.USAGE);
}

function normalizeKey(value: string): ConfigKey {
  if ((CONFIG_KEY_VALUES as readonly string[]).includes(value)) {
    if (value === "item-format" || value === "item_format") {
      return "item_format";
    }
    return "definition_of_done";
  }
  throw new PmCliError(
    `Invalid config key "${value}". Supported: ${CONFIG_KEY_VALUES.join(", ")}`,
    EXIT_CODE.USAGE,
  );
}

function normalizeCriteria(values: string[] | undefined): string[] {
  const normalized = [...new Set((values ?? []).map((value) => value.trim()).filter((value) => value.length > 0))].sort(
    (left, right) => left.localeCompare(right),
  );
  if (normalized.length === 0) {
    throw new PmCliError("Config set definition-of-done requires at least one non-empty --criterion value", EXIT_CODE.USAGE);
  }
  return normalized;
}

function normalizeItemFormat(value: string | undefined): ItemFormat {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "toon" || normalized === "json_markdown") {
    return normalized;
  }
  throw new PmCliError('Config set item-format requires --format with one of: toon, json_markdown', EXIT_CODE.USAGE);
}

async function resolveSettingsTarget(
  scope: ConfigScope,
  global: GlobalOptions,
): Promise<{ pmRoot: string; settingsPath: string }> {
  const cwd = process.cwd();
  const pmRoot = scope === "project" ? resolvePmRoot(cwd, global.path) : resolveGlobalPmRoot(cwd);
  const settingsPath = getSettingsPath(pmRoot);
  if (scope === "project" && !(await pathExists(settingsPath))) {
    throw new PmCliError(`Tracker is not initialized at ${pmRoot}. Run pm init first.`, EXIT_CODE.NOT_FOUND);
  }
  return { pmRoot, settingsPath };
}

export async function runConfig(
  scopeValue: string,
  actionValue: string,
  keyValue: string,
  options: ConfigCommandOptions,
  global: GlobalOptions,
): Promise<ConfigResult> {
  const scope = normalizeScope(scopeValue);
  const action = normalizeAction(actionValue);
  const key = normalizeKey(keyValue);
  const target = await resolveSettingsTarget(scope, global);
  const { settings, metadata } = await readSettingsWithMetadata(target.pmRoot);

  if (action === "get") {
    if (key === "item_format") {
      return {
        scope,
        key,
        format: settings.item_format,
        has_explicit_item_format: metadata.has_explicit_item_format,
        settings_path: target.settingsPath,
        changed: false,
      };
    }
    return {
      scope,
      key,
      criteria: [...settings.workflow.definition_of_done],
      settings_path: target.settingsPath,
      changed: false,
    };
  }

  if (key === "item_format") {
    const nextFormat = normalizeItemFormat(options.format);
    const changed = settings.item_format !== nextFormat || !metadata.has_explicit_item_format;
    let migration: ConfigResult["migration"] = undefined;
    settings.item_format = nextFormat;
    if (changed) {
      await writeSettings(target.pmRoot, settings, "config:set:item_format");
      const migrated = await migrateItemFilesToFormat(target.pmRoot, nextFormat, "config:set:item_format:migrate");
      migration = {
        target_format: migrated.target_format,
        scanned: migrated.scanned,
        migrated: migrated.migrated,
        removed: migrated.removed,
        warnings: migrated.warnings,
      };
    }
    return {
      scope,
      key,
      format: settings.item_format,
      has_explicit_item_format: true,
      migration,
      settings_path: target.settingsPath,
      changed,
    };
  }

  const nextCriteria = normalizeCriteria(options.criterion);
  const changed =
    nextCriteria.length !== settings.workflow.definition_of_done.length ||
    nextCriteria.some((value, index) => value !== settings.workflow.definition_of_done[index]);

  settings.workflow.definition_of_done = nextCriteria;
  if (changed) {
    await writeSettings(target.pmRoot, settings, "config:set:definition_of_done");
  }

  return {
    scope,
    key,
    criteria: [...settings.workflow.definition_of_done],
    settings_path: target.settingsPath,
    changed,
  };
}
