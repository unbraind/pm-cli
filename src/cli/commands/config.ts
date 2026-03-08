import { pathExists } from "../../core/fs/fs-utils.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import {
  getSettingsPath,
  resolveGlobalPmRoot,
  resolvePmRoot,
} from "../../core/store/paths.js";
import { readSettings, writeSettings } from "../../core/store/settings.js";

const CONFIG_SCOPE_VALUES = ["project", "global"] as const;
type ConfigScope = (typeof CONFIG_SCOPE_VALUES)[number];

const CONFIG_KEY_VALUES = ["definition-of-done", "definition_of_done"] as const;
type ConfigAction = "get" | "set";

export interface ConfigCommandOptions {
  criterion?: string[];
}

export interface ConfigResult {
  scope: ConfigScope;
  key: "definition_of_done";
  criteria: string[];
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

function normalizeKey(value: string): "definition_of_done" {
  if ((CONFIG_KEY_VALUES as readonly string[]).includes(value)) {
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
  const settings = await readSettings(target.pmRoot);

  if (action === "get") {
    return {
      scope,
      key,
      criteria: [...settings.workflow.definition_of_done],
      settings_path: target.settingsPath,
      changed: false,
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
