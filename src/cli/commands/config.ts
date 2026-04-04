import { pathExists } from "../../core/fs/fs-utils.js";
import { getActiveExtensionRegistrations } from "../../core/extensions/index.js";
import { normalizeParentReferencePolicy } from "../../core/item/parent-reference-policy.js";
import { normalizeSprintReleaseFormatPolicy } from "../../core/item/sprint-release-format.js";
import { resolveItemTypeRegistry } from "../../core/item/type-registry.js";
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
import type { ItemFormat, ParentReferencePolicy, SprintReleaseFormatPolicy } from "../../types/index.js";

const CONFIG_SCOPE_VALUES = ["project", "global"] as const;
type ConfigScope = (typeof CONFIG_SCOPE_VALUES)[number];

const CONFIG_KEY_VALUES = [
  "definition-of-done",
  "definition_of_done",
  "item-format",
  "item_format",
  "history-missing-stream-policy",
  "history_missing_stream_policy",
  "sprint-release-format-policy",
  "sprint_release_format_policy",
  "parent-reference-policy",
  "parent_reference_policy",
  "test-result-tracking",
  "test_result_tracking",
] as const;
type ConfigAction = "get" | "set" | "list" | "export";
type ConfigKey =
  | "definition_of_done"
  | "item_format"
  | "history_missing_stream_policy"
  | "sprint_release_format_policy"
  | "parent_reference_policy"
  | "test_result_tracking";
type HistoryMissingStreamPolicy = "auto_create" | "strict_error";
type TestResultTrackingPolicy = "enabled" | "disabled";
type ConfigValue =
  | string[]
  | ItemFormat
  | HistoryMissingStreamPolicy
  | SprintReleaseFormatPolicy
  | ParentReferencePolicy
  | TestResultTrackingPolicy;

interface ConfigKeyDescriptor {
  key: ConfigKey;
  aliases: string[];
  value_kind: "string_array" | "enum";
  set_flags: string[];
  summary: string;
  value: ConfigValue;
}

export interface ConfigCommandOptions {
  criterion?: string[];
  format?: string;
  policy?: string;
}

export interface ConfigResult {
  scope: ConfigScope;
  key?: ConfigKey;
  criteria?: string[];
  format?: ItemFormat;
  policy?: HistoryMissingStreamPolicy | SprintReleaseFormatPolicy | ParentReferencePolicy | TestResultTrackingPolicy;
  keys?: ConfigKeyDescriptor[];
  values?: Record<ConfigKey, ConfigValue>;
  count?: number;
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
  warnings?: string[];
}

const CONFIG_KEY_ALIASES: Record<ConfigKey, string[]> = {
  definition_of_done: ["definition-of-done", "definition_of_done"],
  item_format: ["item-format", "item_format"],
  history_missing_stream_policy: ["history-missing-stream-policy", "history_missing_stream_policy"],
  sprint_release_format_policy: ["sprint-release-format-policy", "sprint_release_format_policy"],
  parent_reference_policy: ["parent-reference-policy", "parent_reference_policy"],
  test_result_tracking: ["test-result-tracking", "test_result_tracking"],
};

const CONFIG_KEY_SUMMARIES: Record<ConfigKey, string> = {
  definition_of_done: "Definition of Done criteria list.",
  item_format: "Default item file format.",
  history_missing_stream_policy: "Missing history stream handling policy.",
  sprint_release_format_policy: "Sprint/release format validation policy.",
  parent_reference_policy: "Parent reference validation policy.",
  test_result_tracking: "Item-level linked test result persistence policy.",
};

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
  if (value === "get" || value === "set" || value === "list" || value === "export") {
    return value;
  }
  throw new PmCliError(`Invalid config action "${value}". Allowed: get, set, list, export`, EXIT_CODE.USAGE);
}

function normalizeKey(value: string): ConfigKey {
  if ((CONFIG_KEY_VALUES as readonly string[]).includes(value)) {
    if (value === "item-format" || value === "item_format") {
      return "item_format";
    }
    if (value === "history-missing-stream-policy" || value === "history_missing_stream_policy") {
      return "history_missing_stream_policy";
    }
    if (value === "sprint-release-format-policy" || value === "sprint_release_format_policy") {
      return "sprint_release_format_policy";
    }
    if (value === "parent-reference-policy" || value === "parent_reference_policy") {
      return "parent_reference_policy";
    }
    if (value === "test-result-tracking" || value === "test_result_tracking") {
      return "test_result_tracking";
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

function normalizeHistoryMissingStreamPolicy(value: string | undefined): HistoryMissingStreamPolicy {
  const normalized = value?.trim().toLowerCase().replaceAll("-", "_");
  if (normalized === "auto_create" || normalized === "strict_error") {
    return normalized;
  }
  throw new PmCliError(
    "Config set history-missing-stream-policy requires --policy with one of: auto_create, strict_error",
    EXIT_CODE.USAGE,
  );
}

function normalizeTestResultTrackingPolicy(value: string | undefined): TestResultTrackingPolicy {
  const normalized = value?.trim().toLowerCase().replaceAll("-", "_");
  if (normalized === "enabled" || normalized === "disabled") {
    return normalized;
  }
  throw new PmCliError(
    "Config set test-result-tracking requires --policy with one of: enabled, disabled",
    EXIT_CODE.USAGE,
  );
}

function normalizeWarnings(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function normalizeKeyForAction(action: ConfigAction, value: string | undefined): ConfigKey | undefined {
  if (action === "list" || action === "export") {
    if (typeof value === "string" && value.trim().length > 0) {
      throw new PmCliError(`Config action "${action}" does not accept <key>`, EXIT_CODE.USAGE);
    }
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new PmCliError(`Config action "${action}" requires <key>`, EXIT_CODE.USAGE);
  }
  return normalizeKey(value);
}

function readConfigValue(settings: {
  workflow: { definition_of_done: string[] };
  item_format: ItemFormat;
  history: { missing_stream: HistoryMissingStreamPolicy };
  validation: {
    sprint_release_format: SprintReleaseFormatPolicy;
    parent_reference: ParentReferencePolicy;
  };
  testing: { record_results_to_items: boolean };
}, key: ConfigKey): ConfigValue {
  if (key === "item_format") {
    return settings.item_format;
  }
  if (key === "history_missing_stream_policy") {
    return settings.history.missing_stream;
  }
  if (key === "sprint_release_format_policy") {
    return settings.validation.sprint_release_format;
  }
  if (key === "parent_reference_policy") {
    return settings.validation.parent_reference;
  }
  if (key === "test_result_tracking") {
    return settings.testing.record_results_to_items ? "enabled" : "disabled";
  }
  return [...settings.workflow.definition_of_done];
}

function withWarnings(result: ConfigResult, warnings: string[]): ConfigResult {
  if (warnings.length === 0) {
    return result;
  }
  return {
    ...result,
    warnings,
  };
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
  keyValue: string | undefined,
  options: ConfigCommandOptions,
  global: GlobalOptions,
): Promise<ConfigResult> {
  const scope = normalizeScope(scopeValue);
  const action = normalizeAction(actionValue);
  const key = normalizeKeyForAction(action, keyValue);
  const target = await resolveSettingsTarget(scope, global);
  const { settings, metadata, warnings: settingsReadWarnings } = await readSettingsWithMetadata(target.pmRoot);
  const warnings = normalizeWarnings(settingsReadWarnings);

  if (action === "list") {
    const keys = (Object.keys(CONFIG_KEY_ALIASES) as ConfigKey[]).map((candidate) => ({
      key: candidate,
      aliases: CONFIG_KEY_ALIASES[candidate],
      value_kind: candidate === "definition_of_done" ? ("string_array" as const) : ("enum" as const),
      set_flags:
        candidate === "definition_of_done"
          ? ["--criterion"]
          : candidate === "item_format"
            ? ["--format"]
            : ["--policy"],
      summary: CONFIG_KEY_SUMMARIES[candidate],
      value: readConfigValue(settings, candidate),
    }));
    return withWarnings(
      {
        scope,
        keys,
        count: keys.length,
        settings_path: target.settingsPath,
        changed: false,
      },
      warnings,
    );
  }

  if (action === "export") {
    const values = {
      definition_of_done: readConfigValue(settings, "definition_of_done"),
      item_format: readConfigValue(settings, "item_format"),
      history_missing_stream_policy: readConfigValue(settings, "history_missing_stream_policy"),
      sprint_release_format_policy: readConfigValue(settings, "sprint_release_format_policy"),
      parent_reference_policy: readConfigValue(settings, "parent_reference_policy"),
      test_result_tracking: readConfigValue(settings, "test_result_tracking"),
    } satisfies Record<ConfigKey, ConfigValue>;
    return withWarnings(
      {
        scope,
        values,
        settings_path: target.settingsPath,
        changed: false,
      },
      warnings,
    );
  }

  if (action === "get") {
    if (!key) {
      throw new PmCliError('Config action "get" requires <key>', EXIT_CODE.USAGE);
    }
    if (key === "item_format") {
      return withWarnings({
        scope,
        key,
        format: settings.item_format,
        has_explicit_item_format: metadata.has_explicit_item_format,
        settings_path: target.settingsPath,
        changed: false,
      }, warnings);
    }
    if (key === "history_missing_stream_policy") {
      return withWarnings({
        scope,
        key,
        policy: settings.history.missing_stream,
        settings_path: target.settingsPath,
        changed: false,
      }, warnings);
    }
    if (key === "sprint_release_format_policy") {
      return withWarnings({
        scope,
        key,
        policy: settings.validation.sprint_release_format,
        settings_path: target.settingsPath,
        changed: false,
      }, warnings);
    }
    if (key === "parent_reference_policy") {
      return withWarnings({
        scope,
        key,
        policy: settings.validation.parent_reference,
        settings_path: target.settingsPath,
        changed: false,
      }, warnings);
    }
    if (key === "test_result_tracking") {
      return withWarnings({
        scope,
        key,
        policy: settings.testing.record_results_to_items ? "enabled" : "disabled",
        settings_path: target.settingsPath,
        changed: false,
      }, warnings);
    }
    return withWarnings({
      scope,
      key,
      criteria: [...settings.workflow.definition_of_done],
      settings_path: target.settingsPath,
      changed: false,
    }, warnings);
  }

  if (!key) {
    throw new PmCliError('Config action "set" requires <key>', EXIT_CODE.USAGE);
  }
  if (key === "item_format") {
    const nextFormat = normalizeItemFormat(options.format);
    const changed = settings.item_format !== nextFormat || !metadata.has_explicit_item_format;
    let migration: ConfigResult["migration"] = undefined;
    settings.item_format = nextFormat;
    if (changed) {
      await writeSettings(target.pmRoot, settings, "config:set:item_format");
      const typeRegistry = resolveItemTypeRegistry(settings, getActiveExtensionRegistrations());
      const migrated = await migrateItemFilesToFormat(
        target.pmRoot,
        nextFormat,
        "config:set:item_format:migrate",
        typeRegistry.type_to_folder,
      );
      migration = {
        target_format: migrated.target_format,
        scanned: migrated.scanned,
        migrated: migrated.migrated,
        removed: migrated.removed,
        warnings: migrated.warnings,
      };
    }
    return withWarnings({
      scope,
      key,
      format: settings.item_format,
      has_explicit_item_format: true,
      migration,
      settings_path: target.settingsPath,
      changed,
    }, warnings);
  }

  if (key === "history_missing_stream_policy") {
    const nextPolicy = normalizeHistoryMissingStreamPolicy(options.policy);
    const changed = settings.history.missing_stream !== nextPolicy;
    settings.history.missing_stream = nextPolicy;
    if (changed) {
      await writeSettings(target.pmRoot, settings, "config:set:history_missing_stream_policy");
    }
    return withWarnings({
      scope,
      key,
      policy: settings.history.missing_stream,
      settings_path: target.settingsPath,
      changed,
    }, warnings);
  }

  if (key === "sprint_release_format_policy") {
    const nextPolicy = normalizeSprintReleaseFormatPolicy(options.policy);
    const changed = settings.validation.sprint_release_format !== nextPolicy;
    settings.validation.sprint_release_format = nextPolicy;
    if (changed) {
      await writeSettings(target.pmRoot, settings, "config:set:sprint_release_format_policy");
    }
    return withWarnings({
      scope,
      key,
      policy: settings.validation.sprint_release_format,
      settings_path: target.settingsPath,
      changed,
    }, warnings);
  }

  if (key === "parent_reference_policy") {
    const nextPolicy = normalizeParentReferencePolicy(options.policy);
    const changed = settings.validation.parent_reference !== nextPolicy;
    settings.validation.parent_reference = nextPolicy;
    if (changed) {
      await writeSettings(target.pmRoot, settings, "config:set:parent_reference_policy");
    }
    return withWarnings({
      scope,
      key,
      policy: settings.validation.parent_reference,
      settings_path: target.settingsPath,
      changed,
    }, warnings);
  }

  if (key === "test_result_tracking") {
    const nextPolicy = normalizeTestResultTrackingPolicy(options.policy);
    const nextEnabled = nextPolicy === "enabled";
    const changed = settings.testing.record_results_to_items !== nextEnabled;
    settings.testing.record_results_to_items = nextEnabled;
    if (changed) {
      await writeSettings(target.pmRoot, settings, "config:set:test_result_tracking");
    }
    return withWarnings({
      scope,
      key,
      policy: settings.testing.record_results_to_items ? "enabled" : "disabled",
      settings_path: target.settingsPath,
      changed,
    }, warnings);
  }

  const nextCriteria = normalizeCriteria(options.criterion);
  const changed =
    nextCriteria.length !== settings.workflow.definition_of_done.length ||
    nextCriteria.some((value, index) => value !== settings.workflow.definition_of_done[index]);

  settings.workflow.definition_of_done = nextCriteria;
  if (changed) {
    await writeSettings(target.pmRoot, settings, "config:set:definition_of_done");
  }

  return withWarnings({
    scope,
    key,
    criteria: [...settings.workflow.definition_of_done],
    settings_path: target.settingsPath,
    changed,
  }, warnings);
}
