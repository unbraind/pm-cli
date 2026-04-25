#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import {
  runAggregate,
  runAppend,
  runActivity,
  runCalendar,
  runClaim,
  runClose,
  runComments,
  runCommentsAudit,
  runCompletion,
  runConfig,
  runContracts,
  runCreate,
  runDelete,
  runDedupeAudit,
  runDeps,
  runDocs,
  runExtension,
  runFiles,
  runGet,
  runGc,
  runHealth,
  runHistory,
  runInit,
  runLearnings,
  runList,
  runNotes,
  runSearch,
  runReindex,
  runRestore,
  renderCalendarMarkdown,
  renderContextMarkdown,
  runRelease,
  resolveCalendarOutputFormat,
  resolveContextOutputFormat,
  runStats,
  runStartBackgroundRun,
  runTest,
  runTestAll,
  runTestRunsList,
  runTestRunsLogs,
  runTestRunsResume,
  runTestRunsStatus,
  runTestRunsStop,
  runTestRunsWorker,
  runTemplatesList,
  runTemplatesSave,
  runTemplatesShow,
  runUpdate,
  runUpdateMany,
  runValidate,
  type CalendarOptions,
  type ContextOptions,
  type CreateCommandOptions,
  type AggregateOptions,
  type DedupeAuditOptions,
  type ListOptions,
  runContext,
} from "./commands/index.js";
import {
  activateExtensions,
  clearActiveExtensionHooks,
  createEmptyExtensionRegistrationRegistry,
  getActiveCommandResult,
  getActiveExtensionRegistrations,
  loadExtensions,
  runActiveCommandHandler,
  runActiveParserOverride,
  runActivePreflightOverride,
  runActiveServiceOverride,
  runAfterCommandHooks,
  runBeforeCommandHooks,
  setActiveCommandResult,
  setActiveCommandContext,
  setActiveExtensionCommands,
  setActiveExtensionHooks,
  setActiveExtensionParsers,
  setActiveExtensionPreflight,
  setActiveExtensionRegistrations,
  setActiveExtensionRenderers,
  setActiveExtensionServices,
  type ExtensionCommandRegistry,
  type ExtensionHookRegistry,
  type ExtensionParserRegistry,
  type ExtensionPreflightRegistry,
  type ExtensionServiceRegistry,
  type PreflightRuntimeDecision,
  type RegisteredExtensionCommandDefinition,
  type RegisteredExtensionFlagDefinitions,
  type RegisteredExtensionSchemaMigrationDefinition,
  type ExtensionRendererRegistry,
} from "../core/extensions/index.js";
import { pathExists } from "../core/fs/fs-utils.js";
import {
  commandOptionFlagLabel,
  resolveCommandOptionPolicyState,
  resolveItemTypeRegistry,
  resolveTypeDefinition,
} from "../core/item/type-registry.js";
import { normalizeStatusInput } from "../core/item/status.js";
import {
  resolveRuntimeFieldRegistry,
  resolveRuntimeStatusRegistry,
  type RuntimeFieldCommand,
} from "../core/schema/runtime-schema.js";
import { refreshSearchArtifactsForMutation } from "../core/search/cache.js";
import { EXIT_CODE } from "../core/shared/constants.js";
import { PmCliError } from "../core/shared/errors.js";
import { printError, printResult, writeStdout } from "../core/output/output.js";
import { migrateItemFilesToFormat } from "../core/store/item-format-migration.js";
import { listAllFrontMatter } from "../core/store/item-store.js";
import { getSettingsPath, resolvePmRoot } from "../core/store/paths.js";
import { readSettings, readSettingsWithMetadata } from "../core/store/settings.js";
import type { GlobalOptions } from "../core/shared/command-types.js";
import type { ItemStatus, PmSettings } from "../types/index.js";
import { BUILTIN_ITEM_TYPE_VALUES } from "../types/index.js";
import { coerceLooseCommandOptionsWithFlagDefinitions, parseLooseCommandOptions } from "./extension-command-options.js";
import { attachRichHelpText, normalizeHelpCommandPath, resolveHelpDetailMode, resolveHelpNarrative } from "./help-content.js";
import {
  formatCommanderErrorForDisplay,
  formatCommanderErrorForJson,
  formatPmCliErrorForDisplay,
  formatPmCliErrorForJson,
  formatUnknownErrorForJson,
} from "./error-guidance.js";
import {
  CALENDAR_COMMANDER_STRING_OPTION_CONTRACTS,
  ACTIVITY_COMMANDER_STRING_OPTION_CONTRACTS,
  CONTEXT_COMMANDER_STRING_OPTION_CONTRACTS,
  CREATE_COMMANDER_REPEATABLE_OPTION_CONTRACTS,
  CREATE_COMMANDER_STRING_OPTION_CONTRACTS,
  LIST_COMMANDER_STRING_OPTION_CONTRACTS,
  SEARCH_COMMANDER_STRING_OPTION_CONTRACTS,
  UPDATE_COMMANDER_REPEATABLE_OPTION_CONTRACTS,
  UPDATE_COMMANDER_STRING_OPTION_CONTRACTS,
  readFirstStringFromCommanderOptions,
  readStringArrayFromCommanderOptions,
} from "../sdk/cli-contracts.js";

const PM_PACKAGE_ROOT_ENV = "PM_CLI_PACKAGE_ROOT";

function resolvePmPackageRoot(): string {
  const mainPath = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(mainPath), "../..");
}

if (typeof process.env[PM_PACKAGE_ROOT_ENV] !== "string" || process.env[PM_PACKAGE_ROOT_ENV]?.trim().length === 0) {
  process.env[PM_PACKAGE_ROOT_ENV] = resolvePmPackageRoot();
}

function collect(value: string, previous: string[] | undefined): string[] {
  const next = previous ?? [];
  next.push(value);
  return next;
}

function pushOptionalValueFlag(args: string[], flag: string, value: unknown): void {
  if (typeof value !== "string") {
    return;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return;
  }
  args.push(flag, trimmed);
}

function pushOptionalBooleanFlag(args: string[], flag: string, value: unknown): void {
  if (value === true) {
    args.push(flag);
  }
}

function pushRepeatableValueFlag(args: string[], flag: string, values: unknown): void {
  if (!Array.isArray(values)) {
    return;
  }
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      continue;
    }
    args.push(flag, trimmed);
  }
}

function buildBackgroundTestCommandArgs(id: string, options: Record<string, unknown>): string[] {
  const args: string[] = ["test", id, "--run", "--json", "--progress"];
  pushRepeatableValueFlag(args, "--add", options.add);
  pushRepeatableValueFlag(args, "--remove", options.remove);
  pushOptionalValueFlag(args, "--timeout", options.timeout);
  pushRepeatableValueFlag(args, "--env-set", options.envSet);
  pushRepeatableValueFlag(args, "--env-clear", options.envClear);
  pushOptionalBooleanFlag(args, "--shared-host-safe", options.sharedHostSafe);
  pushOptionalValueFlag(args, "--pm-context", options.pmContext);
  pushOptionalBooleanFlag(args, "--override-linked-pm-context", options.overrideLinkedPmContext);
  pushOptionalBooleanFlag(args, "--fail-on-context-mismatch", options.failOnContextMismatch);
  pushOptionalBooleanFlag(args, "--fail-on-skipped", options.failOnSkipped);
  pushOptionalBooleanFlag(args, "--fail-on-empty-test-run", options.failOnEmptyTestRun);
  pushOptionalBooleanFlag(args, "--require-assertions-for-pm", options.requireAssertionsForPm);
  pushOptionalBooleanFlag(args, "--check-context", options.checkContext);
  pushOptionalBooleanFlag(args, "--auto-pm-context", options.autoPmContext);
  pushOptionalValueFlag(args, "--author", options.author);
  pushOptionalValueFlag(args, "--message", options.message);
  pushOptionalBooleanFlag(args, "--force", options.force);
  return args;
}

function buildBackgroundTestAllCommandArgs(options: Record<string, unknown>): string[] {
  const args: string[] = ["test-all", "--json", "--progress"];
  pushOptionalValueFlag(args, "--status", options.status);
  pushOptionalValueFlag(args, "--limit", options.limit);
  pushOptionalValueFlag(args, "--offset", options.offset);
  pushOptionalValueFlag(args, "--timeout", options.timeout);
  pushRepeatableValueFlag(args, "--env-set", options.envSet);
  pushRepeatableValueFlag(args, "--env-clear", options.envClear);
  pushOptionalBooleanFlag(args, "--shared-host-safe", options.sharedHostSafe);
  pushOptionalValueFlag(args, "--pm-context", options.pmContext);
  pushOptionalBooleanFlag(args, "--override-linked-pm-context", options.overrideLinkedPmContext);
  pushOptionalBooleanFlag(args, "--fail-on-context-mismatch", options.failOnContextMismatch);
  pushOptionalBooleanFlag(args, "--fail-on-skipped", options.failOnSkipped);
  pushOptionalBooleanFlag(args, "--fail-on-empty-test-run", options.failOnEmptyTestRun);
  pushOptionalBooleanFlag(args, "--require-assertions-for-pm", options.requireAssertionsForPm);
  pushOptionalBooleanFlag(args, "--check-context", options.checkContext);
  pushOptionalBooleanFlag(args, "--auto-pm-context", options.autoPmContext);
  return args;
}

const RESOLVED_GLOBAL_OPTIONS = Symbol("pm.resolvedGlobalOptions");

type CommandWithResolvedGlobals = Command & {
  [RESOLVED_GLOBAL_OPTIONS]?: GlobalOptions;
};

function setResolvedGlobalOptions(command: Command, globalOptions: GlobalOptions): void {
  (command as CommandWithResolvedGlobals)[RESOLVED_GLOBAL_OPTIONS] = { ...globalOptions };
}

function clearResolvedGlobalOptions(command: Command): void {
  delete (command as CommandWithResolvedGlobals)[RESOLVED_GLOBAL_OPTIONS];
}

async function applyDefaultOutputFormat(globalOptions: GlobalOptions): Promise<GlobalOptions> {
  if (globalOptions.json === true) {
    return globalOptions;
  }
  const pmRoot = resolvePmRoot(process.cwd(), globalOptions.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    return globalOptions;
  }
  const settings = await readSettings(pmRoot);
  return {
    ...globalOptions,
    defaultOutputFormat: settings.output.default_format,
  };
}

function getGlobalOptions(command: Command): GlobalOptions {
  const resolved = (command as CommandWithResolvedGlobals)[RESOLVED_GLOBAL_OPTIONS];
  if (resolved) {
    return { ...resolved };
  }
  const opts = command.optsWithGlobals();
  return {
    json: opts.json === true ? true : undefined,
    quiet: Boolean(opts.quiet),
    path: typeof opts.path === "string" ? opts.path : undefined,
    noExtensions: opts.extensions === false,
    noPager: Boolean(opts.noPager),
    profile: Boolean(opts.profile),
  };
}

function getCommandPath(command: Command): string {
  const parts: string[] = [];
  let current: Command | null = command;
  while (current?.parent) {
    parts.unshift(current.name());
    current = current.parent;
  }
  return parts.join(" ");
}

function normalizeExtensionCommandPath(commandPath: string): string {
  return commandPath
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((part) => part.length > 0)
    .join(" ");
}

function toNonEmptyFlagString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function formatDynamicExtensionFlagHelpLine(definition: Record<string, unknown>): string | null {
  const visible = toOptionalBoolean(definition.visible);
  if (visible === false) {
    return null;
  }
  const longName = toNonEmptyFlagString(definition.long);
  if (!longName || !longName.startsWith("--") || longName.length < 3) {
    return null;
  }

  const shortName = toNonEmptyFlagString(definition.short);
  const shortPrefix = shortName && shortName.startsWith("-") && !shortName.startsWith("--") ? `${shortName}, ` : "";
  const valueName = toNonEmptyFlagString(definition.value_name);
  const valueSuffix = valueName ? ` <${valueName}>` : "";
  const description = toNonEmptyFlagString(definition.description) ?? "Extension-provided option.";
  const markers: string[] = [];
  if (toOptionalBoolean(definition.required) === true) {
    markers.push("required");
  }
  if (toOptionalBoolean(definition.enabled) === false) {
    markers.push("disabled");
  }
  const markerSuffix = markers.length > 0 ? ` [${markers.join(", ")}]` : "";
  return `${shortPrefix}${longName}${valueSuffix}  ${description}${markerSuffix}`;
}

function buildDynamicExtensionFlagHelp(definitions: Array<Record<string, unknown>>): string | null {
  const lines = [
    ...new Set(
      definitions
        .map(formatDynamicExtensionFlagHelpLine)
        .filter((line): line is string => line !== null),
    ),
  ].sort((left, right) => left.localeCompare(right));
  if (lines.length === 0) {
    return null;
  }
  return `\nExtension-provided flags:\n  ${lines.join("\n  ")}`;
}

function collectDynamicExtensionFlagHelpByCommand(
  registrations: RegisteredExtensionFlagDefinitions[],
): Map<string, string> {
  const grouped = new Map<string, Array<Record<string, unknown>>>();
  for (const registration of registrations) {
    const commandPath = normalizeExtensionCommandPath(registration.target_command);
    if (commandPath.length === 0) {
      continue;
    }
    const existing = grouped.get(commandPath) ?? [];
    existing.push(...registration.flags);
    grouped.set(commandPath, existing);
  }

  const entries = [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right));
  const helpByCommand = new Map<string, string>();
  for (const [commandPath, definitions] of entries) {
    const helpText = buildDynamicExtensionFlagHelp(definitions);
    if (!helpText) {
      continue;
    }
    helpByCommand.set(commandPath, helpText);
  }
  return helpByCommand;
}

interface ExtensionCommandArgumentHelpDescriptor {
  name: string;
  required: boolean;
  variadic: boolean;
  description?: string;
}

interface ExtensionCommandHelpDescriptor {
  command: string;
  action: string;
  description?: string;
  intent?: string;
  examples: string[];
  failure_hints: string[];
  arguments: ExtensionCommandArgumentHelpDescriptor[];
  flags: Array<Record<string, unknown>>;
  source?: {
    layer: "global" | "project";
    name: string;
  };
}

function normalizeExtensionCommandAction(commandPath: string, action: string | undefined): string {
  if (typeof action !== "string" || action.trim().length === 0) {
    return commandPath.replace(/\s+/g, "-");
  }
  return action.trim().toLowerCase();
}

function normalizeExtensionCommandStringList(values: string[] | undefined): string[] {
  if (!Array.isArray(values)) {
    return [];
  }
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

function normalizeExtensionCommandArguments(
  values: Array<{ name?: unknown; required?: unknown; variadic?: unknown; description?: unknown }> | undefined,
): ExtensionCommandArgumentHelpDescriptor[] {
  if (!Array.isArray(values)) {
    return [];
  }
  return values
    .map((value) => {
      const name = typeof value.name === "string" ? value.name.trim() : "";
      if (name.length === 0) {
        return null;
      }
      const normalized: ExtensionCommandArgumentHelpDescriptor = {
        name,
        required: value.required === true,
        variadic: value.variadic === true,
      };
      if (typeof value.description === "string" && value.description.trim().length > 0) {
        normalized.description = value.description.trim();
      }
      return normalized;
    })
    .filter((entry): entry is ExtensionCommandArgumentHelpDescriptor => entry !== null);
}

function collectExtensionCommandHelpDescriptors(
  commandHandlers: string[],
  commandDefinitions: RegisteredExtensionCommandDefinition[],
  flagRegistrations: RegisteredExtensionFlagDefinitions[],
): Map<string, ExtensionCommandHelpDescriptor> {
  const definitionsByCommand = new Map<string, ExtensionCommandHelpDescriptor>();
  for (const definition of commandDefinitions) {
    const commandPath = normalizeExtensionCommandPath(definition.command);
    if (commandPath.length === 0) {
      continue;
    }
    const description =
      typeof definition.description === "string" && definition.description.trim().length > 0
        ? definition.description.trim()
        : undefined;
    const intent =
      typeof definition.intent === "string" && definition.intent.trim().length > 0
        ? definition.intent.trim()
        : undefined;
    definitionsByCommand.set(commandPath, {
      command: commandPath,
      action: normalizeExtensionCommandAction(commandPath, definition.action),
      description,
      intent,
      examples: normalizeExtensionCommandStringList(definition.examples),
      failure_hints: normalizeExtensionCommandStringList(definition.failure_hints),
      arguments: normalizeExtensionCommandArguments(definition.arguments),
      flags: [],
      source: {
        layer: definition.layer,
        name: definition.name,
      },
    });
  }

  const flagsByCommand = new Map<string, Array<Record<string, unknown>>>();
  for (const registration of flagRegistrations) {
    const commandPath = normalizeExtensionCommandPath(registration.target_command);
    if (commandPath.length === 0) {
      continue;
    }
    const existing = flagsByCommand.get(commandPath) ?? [];
    existing.push(...registration.flags);
    flagsByCommand.set(commandPath, existing);
  }

  const commandSet = new Set<string>();
  for (const commandPath of commandHandlers) {
    const normalized = normalizeExtensionCommandPath(commandPath);
    if (normalized.length > 0) {
      commandSet.add(normalized);
    }
  }
  for (const commandPath of definitionsByCommand.keys()) {
    commandSet.add(commandPath);
  }
  for (const commandPath of flagsByCommand.keys()) {
    commandSet.add(commandPath);
  }

  const descriptors = new Map<string, ExtensionCommandHelpDescriptor>();
  const sortedCommands = [...commandSet].sort((left, right) => left.localeCompare(right));
  for (const commandPath of sortedCommands) {
    const definition = definitionsByCommand.get(commandPath);
    const flags = flagsByCommand.get(commandPath) ?? [];
    if (definition) {
      descriptors.set(commandPath, {
        ...definition,
        flags,
      });
      continue;
    }
    descriptors.set(commandPath, {
      command: commandPath,
      action: normalizeExtensionCommandAction(commandPath, undefined),
      examples: [],
      failure_hints: [],
      arguments: [],
      flags,
    });
  }

  return descriptors;
}

function buildExtensionArgumentToken(argument: ExtensionCommandArgumentHelpDescriptor): string {
  const variadicSuffix = argument.variadic ? "..." : "";
  if (argument.required) {
    return `<${argument.name}${variadicSuffix}>`;
  }
  return `[${argument.name}${variadicSuffix}]`;
}

function applyDynamicExtensionArguments(command: Command, descriptor: ExtensionCommandHelpDescriptor): void {
  for (const argument of descriptor.arguments) {
    command.argument(buildExtensionArgumentToken(argument), argument.description ?? "Extension argument.");
  }
}

function formatDynamicExtensionOptionFlags(definition: Record<string, unknown>): string | null {
  const visible = toOptionalBoolean(definition.visible);
  if (visible === false) {
    return null;
  }
  const longName = toNonEmptyFlagString(definition.long);
  const shortName = toNonEmptyFlagString(definition.short);
  const normalizedShort = shortName && shortName.startsWith("-") && !shortName.startsWith("--") ? shortName : null;
  const normalizedLong = longName && longName.startsWith("--") && longName.length > 2 ? longName : null;
  if (!normalizedLong && !normalizedShort) {
    return null;
  }
  const optionValueName = toNonEmptyFlagString(definition.value_name);
  const optionValueSuffix = optionValueName ? ` <${optionValueName}>` : "";
  const optionNames = [normalizedShort, normalizedLong].filter((entry): entry is string => entry !== null);
  return `${optionNames.join(", ")}${optionValueSuffix}`;
}

function formatDynamicExtensionOptionDescription(definition: Record<string, unknown>): string {
  const description = toNonEmptyFlagString(definition.description) ?? "Extension-provided option.";
  const markers: string[] = [];
  if (toOptionalBoolean(definition.required) === true) {
    markers.push("required");
  }
  if (toOptionalBoolean(definition.enabled) === false) {
    markers.push("disabled");
  }
  const markerSuffix = markers.length > 0 ? ` [${markers.join(", ")}]` : "";
  return `${description}${markerSuffix}`;
}

function applyDynamicExtensionOptions(command: Command, descriptor: ExtensionCommandHelpDescriptor): void {
  const seen = new Set<string>();
  for (const definition of descriptor.flags) {
    const optionFlags = formatDynamicExtensionOptionFlags(definition);
    if (!optionFlags || seen.has(optionFlags)) {
      continue;
    }
    seen.add(optionFlags);
    command.option(optionFlags, formatDynamicExtensionOptionDescription(definition));
  }
}

function buildDynamicExtensionHelpOptionSummary(definition: Record<string, unknown>): HelpOptionSummary | null {
  const flags = formatDynamicExtensionOptionFlags(definition);
  if (!flags) {
    return null;
  }
  const longName = toNonEmptyFlagString(definition.long);
  const shortName = toNonEmptyFlagString(definition.short);
  const normalizedLong = longName && longName.startsWith("--") && longName.length > 2 ? longName : null;
  const normalizedShort = shortName && shortName.startsWith("-") && !shortName.startsWith("--") ? shortName : null;
  const valueName = toNonEmptyFlagString(definition.value_name);
  const required = toOptionalBoolean(definition.required) === true;
  return {
    flags,
    long: normalizedLong,
    short: normalizedShort,
    description: formatDynamicExtensionOptionDescription(definition),
    takes_value: valueName !== null,
    value_required: valueName !== null,
    value_name: valueName,
    variadic: false,
    required,
    aliases: [],
    alias_for: null,
  };
}

function buildDynamicExtensionHelpOptionSummaries(descriptor: ExtensionCommandHelpDescriptor | undefined): HelpOptionSummary[] {
  if (!descriptor) {
    return [];
  }
  const summaries: HelpOptionSummary[] = [];
  const seen = new Set<string>();
  for (const definition of descriptor.flags) {
    const summary = buildDynamicExtensionHelpOptionSummary(definition);
    if (!summary || seen.has(summary.flags)) {
      continue;
    }
    seen.add(summary.flags);
    summaries.push(summary);
  }
  return summaries;
}

function mergeHelpOptionSummaries(base: HelpOptionSummary[], extension: HelpOptionSummary[]): HelpOptionSummary[] {
  if (extension.length === 0) {
    return base;
  }
  const merged = [...base];
  const seen = new Set(base.map((entry) => entry.flags));
  for (const entry of extension) {
    if (seen.has(entry.flags)) {
      continue;
    }
    seen.add(entry.flags);
    merged.push(entry);
  }
  return merged;
}

function buildDynamicExtensionCommandMetadataHelp(descriptor: ExtensionCommandHelpDescriptor): string | null {
  const lines: string[] = [];
  if (descriptor.intent) {
    lines.push(`Intent: ${descriptor.intent}`);
  }
  if (descriptor.action) {
    lines.push(`Action contract: ${descriptor.action}`);
  }
  if (descriptor.examples.length > 0) {
    lines.push("Examples:");
    for (const example of descriptor.examples) {
      lines.push(`  - ${example}`);
    }
  }
  if (descriptor.failure_hints.length > 0) {
    lines.push("Common failure hints:");
    for (const hint of descriptor.failure_hints) {
      lines.push(`  - ${hint}`);
    }
  }
  if (lines.length === 0) {
    return null;
  }
  return `\nExtension command metadata:\n  ${lines.join("\n  ")}`;
}

function commandAliases(command: Command): string[] {
  const commandRecord = command as unknown as {
    aliases?: () => string[];
    alias?: () => string | undefined;
    _aliases?: string[];
  };
  if (typeof commandRecord.aliases === "function") {
    return commandRecord.aliases().map((value) => value.trim().toLowerCase()).filter((value) => value.length > 0);
  }
  if (typeof commandRecord.alias === "function") {
    const alias = commandRecord.alias();
    if (typeof alias === "string" && alias.trim().length > 0) {
      return [alias.trim().toLowerCase()];
    }
  }
  if (Array.isArray(commandRecord._aliases)) {
    return commandRecord._aliases.map((value) => value.trim().toLowerCase()).filter((value) => value.length > 0);
  }
  return [];
}

function findDirectChildCommand(parent: Command, name: string): Command | null {
  const normalizedTarget = name.trim().toLowerCase();
  return (
    parent.commands.find((entry) => {
      if (entry.name().trim().toLowerCase() === normalizedTarget) {
        return true;
      }
      return commandAliases(entry).includes(normalizedTarget);
    }) ?? null
  );
}

function findCommandByPath(root: Command, pathParts: string[]): Command | null {
  let current: Command = root;
  for (const part of pathParts) {
    const next = findDirectChildCommand(current, part);
    if (!next) {
      return null;
    }
    current = next;
  }
  return current;
}

function ensureCommandPath(root: Command, pathParts: string[]): Command | null {
  if (pathParts.length === 0) {
    return null;
  }

  let current: Command = root;
  for (let index = 0; index < pathParts.length; index += 1) {
    const part = pathParts[index];
    const existing = findDirectChildCommand(current, part);
    if (existing) {
      current = existing;
      continue;
    }

    const created = current.command(part);
    if (index < pathParts.length - 1) {
      created.description("Extension-provided command group.");
    } else {
      created.description("Extension-provided command path.");
    }
    current = created;
  }

  return current;
}

function parseBootstrapPathToken(
  token: string,
  next: string | undefined,
): { consumed: number; pathValue?: string } | null {
  if (token === "--path") {
    if (typeof next === "string" && next.length > 0) {
      return {
        consumed: 2,
        pathValue: next,
      };
    }
    return {
      consumed: 1,
    };
  }

  if (!token.startsWith("--path=")) {
    return null;
  }

  const value = token.slice("--path=".length);
  if (value.length > 0) {
    return {
      consumed: 1,
      pathValue: value,
    };
  }
  return {
    consumed: 1,
  };
}

interface BootstrapGlobalOptions {
  path?: string;
  noExtensions: boolean;
  noPager: boolean;
  json: boolean;
  quiet: boolean;
}

function parseBootstrapGlobalOptions(argv: string[]): BootstrapGlobalOptions {
  let pathValue: string | undefined;
  let noExtensions = false;
  let noPager = false;
  let json = false;
  let quiet = false;
  let index = 0;
  while (index < argv.length) {
    const token = argv[index];
    if (token === "--") {
      break;
    }
    if (token === "--no-extensions") {
      noExtensions = true;
      index += 1;
      continue;
    }
    if (token === "--no-pager") {
      noPager = true;
      index += 1;
      continue;
    }
    if (token === "--json") {
      json = true;
      index += 1;
      continue;
    }
    if (token === "--quiet") {
      quiet = true;
      index += 1;
      continue;
    }
    const parsedPath = parseBootstrapPathToken(token, argv[index + 1]);
    if (parsedPath) {
      if (parsedPath.pathValue !== undefined) {
        pathValue = parsedPath.pathValue;
      }
      index += parsedPath.consumed;
      continue;
    }
    index += 1;
  }
  return {
    path: pathValue,
    noExtensions,
    noPager,
    json,
    quiet,
  };
}

function stripGlobalBootstrapTokens(argv: string[]): string[] {
  const remaining: string[] = [];
  let index = 0;
  while (index < argv.length) {
    const token = argv[index];
    if (token === "--") {
      break;
    }
    if (
      token === "--json" ||
      token === "--quiet" ||
      token === "--no-extensions" ||
      token === "--no-pager" ||
      token === "--profile" ||
      token === "--explain"
    ) {
      index += 1;
      continue;
    }
    if (token === "--path") {
      index += 2;
      continue;
    }
    if (token.startsWith("--path=")) {
      index += 1;
      continue;
    }
    remaining.push(token);
    index += 1;
  }
  return remaining;
}

function shouldDisablePagerForInvocation(argv: string[], bootstrapGlobal: BootstrapGlobalOptions): boolean {
  if (bootstrapGlobal.noPager) {
    return true;
  }
  if (process.stdout.isTTY === true) {
    return false;
  }
  const helpRequest = parseBootstrapHelpRequest(argv);
  return helpRequest.requested;
}

function applyBootstrapPagerPolicy(argv: string[]): void {
  const bootstrapGlobal = parseBootstrapGlobalOptions(argv);
  if (!shouldDisablePagerForInvocation(argv, bootstrapGlobal)) {
    return;
  }
  process.env.PAGER = "cat";
  process.env.MANPAGER = "cat";
  process.env.GIT_PAGER = "cat";
  if (typeof process.env.LESS !== "string" || process.env.LESS.trim().length === 0) {
    process.env.LESS = "FRX";
  }
}

interface BootstrapHelpRequest {
  requested: boolean;
  commandPathTokens: string[];
}

function parseBootstrapHelpRequest(argv: string[]): BootstrapHelpRequest {
  const stripped = stripGlobalBootstrapTokens(argv);
  const first = stripped[0]?.trim().toLowerCase();
  if (first === "help") {
    const commandPathTokens: string[] = [];
    for (let index = 1; index < stripped.length; index += 1) {
      const token = stripped[index];
      if (token.startsWith("-")) {
        break;
      }
      commandPathTokens.push(token.trim().toLowerCase());
    }
    return {
      requested: true,
      commandPathTokens,
    };
  }

  const helpFlagIndex = stripped.findIndex((token) => token === "--help" || token === "-h");
  if (helpFlagIndex < 0) {
    return {
      requested: false,
      commandPathTokens: [],
    };
  }

  const commandPathTokens: string[] = [];
  for (const token of stripped) {
    if (token.startsWith("-")) {
      break;
    }
    commandPathTokens.push(token.trim().toLowerCase());
  }
  return {
    requested: true,
    commandPathTokens,
  };
}

function parseBootstrapCommandName(argv: string[]): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") {
      break;
    }
    if (token === "--path") {
      index += 1;
      continue;
    }
    if (
      token.startsWith("--path=") ||
      token === "--json" ||
      token === "--quiet" ||
      token === "--no-extensions" ||
      token === "--no-pager" ||
      token === "--profile" ||
      token === "--explain"
    ) {
      continue;
    }
    if (token.startsWith("-")) {
      continue;
    }
    return token.trim().toLowerCase();
  }
  return undefined;
}

const EXTENSION_ACTION_SYNTAX_TOKENS = new Set<ExtensionSubcommandAction>([
  "install",
  "uninstall",
  "explore",
  "manage",
  "doctor",
  "adopt",
  "adopt-all",
  "activate",
  "deactivate",
]);

function normalizeLegacyExtensionActionSyntax(argv: string[]): string[] {
  const extensionIndex = argv.findIndex((token) => token === "extension");
  if (extensionIndex < 0) {
    return [...argv];
  }
  const actionToken = argv[extensionIndex + 1];
  if (!actionToken || actionToken.startsWith("-")) {
    return [...argv];
  }
  if (!EXTENSION_ACTION_SYNTAX_TOKENS.has(actionToken as ExtensionSubcommandAction)) {
    return [...argv];
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    return [...argv];
  }
  const forcedActionFlag = `--${actionToken}`;
  if (argv.includes(forcedActionFlag)) {
    return [...argv];
  }
  return [...argv.slice(0, extensionIndex + 1), forcedActionFlag, ...argv.slice(extensionIndex + 2)];
}

interface HelpArgumentSummary {
  name: string;
  required: boolean;
  variadic: boolean;
  description: string | null;
}

interface HelpOptionSummary {
  flags: string;
  long: string | null;
  short: string | null;
  description: string;
  takes_value: boolean;
  value_required: boolean;
  value_name: string | null;
  variadic: boolean;
  required: boolean;
  aliases: string[];
  alias_for: string | null;
  default_value?: unknown;
}

interface HelpSubcommandSummary {
  name: string;
  aliases: string[];
  description: string;
}

const BUILTIN_TYPE_HELP_VALUES = BUILTIN_ITEM_TYPE_VALUES.join("|");

function resolveCommandFromPathTokens(root: Command, pathTokens: string[]): Command | null {
  if (pathTokens.length === 0) {
    return root;
  }
  return findCommandByPath(root, pathTokens);
}

function extractOptionValueName(flags: string): string | null {
  const match = flags.match(/[<[]([^>\]]+)[>\]]/);
  if (!match) {
    return null;
  }
  const value = match[1]?.trim();
  return value && value.length > 0 ? value : null;
}

function readOptionAttributeName(option: unknown): string | null {
  const optionRecord = option as {
    attributeName?: (() => string) | string;
  };
  if (typeof optionRecord.attributeName === "function") {
    const value = optionRecord.attributeName();
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
  }
  if (typeof optionRecord.attributeName === "string" && optionRecord.attributeName.trim().length > 0) {
    return optionRecord.attributeName.trim();
  }
  return null;
}

function buildOptionAliasMap(options: unknown[]): Map<string, string[]> {
  const aliasMap = new Map<string, string[]>();
  for (const option of options) {
    const optionRecord = option as {
      long?: string;
    };
    const attributeName = readOptionAttributeName(option);
    if (!attributeName || typeof optionRecord.long !== "string" || optionRecord.long.trim().length === 0) {
      continue;
    }
    const existing = aliasMap.get(attributeName) ?? [];
    existing.push(optionRecord.long.trim());
    aliasMap.set(attributeName, existing);
  }
  for (const [attributeName, values] of aliasMap.entries()) {
    aliasMap.set(
      attributeName,
      [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))].sort((left, right) =>
        left.localeCompare(right),
      ),
    );
  }
  return aliasMap;
}

function buildHelpOptionSummaries(command: Command): HelpOptionSummary[] {
  const options = (command.options ?? []) as unknown[];
  const optionAliasMap = buildOptionAliasMap(options);
  return options.map((option) => {
    const optionRecord = option as {
      flags?: string;
      long?: string;
      short?: string;
      description?: string;
      mandatory?: boolean;
      variadic?: boolean;
      defaultValue?: unknown;
    };
    const flags = typeof optionRecord.flags === "string" ? optionRecord.flags.trim() : "";
    const description = typeof optionRecord.description === "string" ? optionRecord.description.trim() : "";
    const attributeName = readOptionAttributeName(option);
    const aliasCandidates = attributeName ? optionAliasMap.get(attributeName) ?? [] : [];
    const aliases = aliasCandidates
      .filter((entry) => entry !== optionRecord.long)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    const aliasForMatch = description.match(/^Alias for ([^ ]+)/i);
    const aliasFor = aliasForMatch && aliasForMatch[1] ? aliasForMatch[1].trim() : null;
    const required =
      optionRecord.mandatory === true || description.includes("[required]") || description.toLowerCase().includes("required;");
    const valueRequired = flags.includes("<");
    const takesValue = valueRequired || flags.includes("[");
    const summary: HelpOptionSummary = {
      flags,
      long: typeof optionRecord.long === "string" ? optionRecord.long : null,
      short: typeof optionRecord.short === "string" ? optionRecord.short : null,
      description,
      takes_value: takesValue,
      value_required: valueRequired,
      value_name: extractOptionValueName(flags),
      variadic: optionRecord.variadic === true,
      required,
      aliases,
      alias_for: aliasFor,
    };
    if (optionRecord.defaultValue !== undefined) {
      summary.default_value = optionRecord.defaultValue;
    }
    return summary;
  });
}

function buildHelpArgumentSummaries(command: Command): HelpArgumentSummary[] {
  const commandRecord = command as unknown as {
    registeredArguments?: Array<{
      name?: (() => string) | string;
      required?: boolean;
      variadic?: boolean;
      description?: string;
    }>;
    _args?: Array<{
      name?: (() => string) | string;
      required?: boolean;
      variadic?: boolean;
      description?: string;
    }>;
  };
  const argumentsList = Array.isArray(commandRecord.registeredArguments)
    ? commandRecord.registeredArguments
    : Array.isArray(commandRecord._args)
      ? commandRecord._args
      : [];

  return argumentsList.map((argument) => {
    const rawName =
      typeof argument.name === "function"
        ? argument.name()
        : typeof argument.name === "string"
          ? argument.name
          : "argument";
    const description = typeof argument.description === "string" && argument.description.trim().length > 0
      ? argument.description.trim()
      : null;
    return {
      name: rawName.trim(),
      required: argument.required === true,
      variadic: argument.variadic === true,
      description,
    };
  });
}

function buildHelpSubcommandSummaries(command: Command): HelpSubcommandSummary[] {
  return command.commands
    .map((entry) => ({
      name: entry.name().trim(),
      aliases: commandAliases(entry),
      description: entry.description().trim(),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function buildJsonHelpPayload(rootProgram: Command, targetCommand: Command, argv: string[], requestedPath: string[]): Record<string, unknown> {
  const detailMode = resolveHelpDetailMode(argv);
  const resolvedPath = normalizeHelpCommandPath(getCommandPath(targetCommand));
  const commandPath = resolvedPath.length > 0 ? resolvedPath : undefined;
  const fallbackNarrative = resolveHelpNarrative(commandPath, detailMode);
  const extensionDescriptor = commandPath ? activeRuntimeExtensionCommandDescriptors.get(commandPath) : undefined;
  const extensionExamples = extensionDescriptor?.examples ?? [];
  const extensionFailureHints = extensionDescriptor?.failure_hints ?? [];
  const narrative = extensionDescriptor
    ? {
        intent: extensionDescriptor.intent ?? extensionDescriptor.description ?? fallbackNarrative.intent,
        examples:
          detailMode === "detailed"
            ? extensionExamples.length > 0
              ? [...extensionExamples]
              : [...fallbackNarrative.examples]
            : extensionExamples.length > 0
              ? [extensionExamples[0]]
              : [...fallbackNarrative.examples],
        tips:
          detailMode === "detailed"
            ? extensionFailureHints.length > 0
              ? [...extensionFailureHints]
              : [...fallbackNarrative.tips]
            : [],
        detail_mode: detailMode,
      }
    : fallbackNarrative;
  const optionSummaries = mergeHelpOptionSummaries(
    buildHelpOptionSummaries(targetCommand),
    buildDynamicExtensionHelpOptionSummaries(extensionDescriptor),
  );
  const subcommands = buildHelpSubcommandSummaries(targetCommand);
  return {
    format: "pm_help_v1",
    detail_mode: detailMode,
    root_command: rootProgram.name(),
    requested_path: requestedPath,
    resolved_path: resolvedPath.length > 0 ? resolvedPath : rootProgram.name(),
    description: targetCommand.description(),
    usage: targetCommand.usage(),
    intent: narrative.intent,
    examples: narrative.examples,
    tips: narrative.tips,
    arguments: buildHelpArgumentSummaries(targetCommand),
    options: optionSummaries,
    subcommands,
    has_subcommands: subcommands.length > 0,
  };
}

async function maybeRenderBootstrapJsonHelp(rootProgram: Command, argv: string[]): Promise<boolean> {
  const bootstrapGlobal = parseBootstrapGlobalOptions(argv);
  if (!bootstrapGlobal.json) {
    return false;
  }
  const helpRequest = parseBootstrapHelpRequest(argv);
  if (!helpRequest.requested) {
    return false;
  }
  const targetCommand = resolveCommandFromPathTokens(rootProgram, helpRequest.commandPathTokens);
  if (!targetCommand) {
    if (!bootstrapGlobal.quiet) {
      const envelope = formatCommanderErrorForJson(
        `unknown command '${helpRequest.commandPathTokens.join(" ")}'`,
        "help",
        BUILTIN_TYPE_HELP_VALUES,
        EXIT_CODE.USAGE,
      );
      printError(JSON.stringify(envelope, null, 2));
    }
    process.exitCode = EXIT_CODE.USAGE;
    return true;
  }
  if (!bootstrapGlobal.quiet) {
    const payload = buildJsonHelpPayload(rootProgram, targetCommand, argv, helpRequest.commandPathTokens);
    writeStdout(`${JSON.stringify(payload, null, 2)}\n`);
  }
  process.exitCode = EXIT_CODE.SUCCESS;
  return true;
}

function parseBootstrapTypeValue(argv: string[]): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--type") {
      const candidate = argv[index + 1];
      if (typeof candidate === "string" && candidate.trim().length > 0) {
        return candidate.trim();
      }
      continue;
    }
    if (token.startsWith("--type=")) {
      const candidate = token.slice("--type=".length).trim();
      if (candidate.length > 0) {
        return candidate;
      }
    }
  }
  return undefined;
}

function buildCreateUpdatePolicyHelpText(
  commandName: "create" | "update",
  typeRegistry: ReturnType<typeof resolveItemTypeRegistry>,
  argv: string[],
): string {
  const selectedTypeRaw = parseBootstrapTypeValue(argv);
  if (!selectedTypeRaw) {
    const allowed = typeRegistry.types.join("|");
    const lines = [
      "",
      "Type-aware option policies:",
      "  pass --type <value> with --help to render required/disabled/hidden option policy details for that type.",
      `  active type values: ${allowed}`,
    ];
    if (commandName === "create") {
      lines.push(
        "  scheduling shortcut: use --schedule-preset lightweight for Reminder/Meeting/Event minimal create flows.",
      );
    }
    return lines.join("\n");
  }

  const typeDefinition = resolveTypeDefinition(selectedTypeRaw, typeRegistry);
  if (!typeDefinition) {
    const allowed = typeRegistry.types.join("|");
    return [
      "",
      `Type-aware option policies: type "${selectedTypeRaw}" is not in the active registry.`,
      `  active type values: ${allowed}`,
    ].join("\n");
  }

  const baseRequired =
    commandName === "create"
      ? new Set<string>(["title", "description", "type", ...typeDefinition.required_create_fields, ...typeDefinition.required_create_repeatables])
      : new Set<string>();
  const policyState = resolveCommandOptionPolicyState(typeDefinition, commandName, baseRequired);
  const toFlags = (options: string[]): string =>
    options.length > 0 ? options.map((option) => commandOptionFlagLabel(commandName, option)).join(", ") : "none";

  const lines = [
    "",
    `Type-aware option policies for ${typeDefinition.name}:`,
    `  required: ${toFlags(policyState.required)}`,
    `  disabled: ${toFlags(policyState.disabled)}`,
    `  hidden: ${toFlags(policyState.hidden)}`,
  ];
  if (commandName === "create" && ["Reminder", "Meeting", "Event"].includes(typeDefinition.name)) {
    lines.push(
      "  schedule preset: --schedule-preset lightweight switches schedule artifacts to progressive required-option policy.",
    );
    lines.push("  strict parity remains available via --create-mode strict.");
  }
  if (typeDefinition.options.length === 0) {
    lines.push("  type options: none");
  } else {
    lines.push("  type options:");
    for (const option of typeDefinition.options) {
      const requiredLabel = option.required ? " (required)" : "";
      const aliases = option.aliases ?? [];
      lines.push(`    - ${option.key}${requiredLabel}`);
      lines.push(`      values: ${option.values.length > 0 ? option.values.join("|") : "any non-empty string"}`);
      lines.push(`      aliases: ${aliases.length > 0 ? aliases.join("|") : "none"}`);
      if (option.description && option.description.trim().length > 0) {
        lines.push(`      description: ${option.description.trim()}`);
      }
    }
  }
  if (policyState.errors.length > 0) {
    lines.push(`  config errors: ${policyState.errors.join("; ")}`);
  }
  return lines.join("\n");
}

function attachCreateUpdatePolicyHelpText(
  rootProgram: Command,
  typeRegistry: ReturnType<typeof resolveItemTypeRegistry>,
  argv: string[],
): void {
  const bootstrapCommand = parseBootstrapCommandName(argv);
  if (bootstrapCommand !== "create" && bootstrapCommand !== "update") {
    return;
  }
  const command = findDirectChildCommand(rootProgram, bootstrapCommand);
  if (!command) {
    return;
  }
  command.addHelpText("after", buildCreateUpdatePolicyHelpText(bootstrapCommand, typeRegistry, argv));
}

interface ActiveExtensionHookContext {
  hooks: ExtensionHookRegistry;
  commandName: string;
  commandArgs: string[];
  commandOptions: Record<string, unknown>;
  globalOptions: GlobalOptions;
  pmRoot: string;
  profileEnabled: boolean;
  migrationBlockers: MandatoryMigrationBlocker[];
}

let activeExtensionHookContext: ActiveExtensionHookContext | null = null;

interface RuntimeExtensionSnapshot {
  hooks: ExtensionHookRegistry;
  commands: ExtensionCommandRegistry;
  parsers: ExtensionParserRegistry;
  preflight: ExtensionPreflightRegistry;
  services: ExtensionServiceRegistry;
  renderers: ExtensionRendererRegistry;
  registrations: ReturnType<typeof createEmptyExtensionRegistrationRegistry>;
  pmRoot: string;
  settings: PmSettings;
  commandHandlers: string[];
  commandFlagHelp: Map<string, string>;
  commandDescriptors: Map<string, ExtensionCommandHelpDescriptor>;
  loadWarnings: string[];
  activationWarnings: string[];
  loadedCount: number;
  loadFailedCount: number;
  activationFailedCount: number;
}

let runtimeExtensionSnapshotCache: { key: string; snapshot: RuntimeExtensionSnapshot | null } | null = null;
let activeRuntimeExtensionCommandDescriptors = new Map<string, ExtensionCommandHelpDescriptor>();

function formatHookWarnings(warnings: string[]): string {
  return warnings.join(",");
}

interface MandatoryMigrationBlocker {
  layer: "global" | "project";
  name: string;
  id: string;
  status: string;
}

interface WriteGateDecision {
  isMutation: boolean;
  forceCapable: boolean;
  forceRequested: boolean;
}

function toNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function resolveMigrationId(definition: Record<string, unknown>, fallbackIndex: number): string {
  const explicit = toNonEmptyString(definition.id);
  if (explicit) {
    return explicit;
  }
  return `migration-${String(fallbackIndex + 1).padStart(3, "0")}`;
}

function resolveNormalizedMigrationStatus(definition: Record<string, unknown>): string {
  const normalized = toNonEmptyString(definition.status)?.toLowerCase();
  return normalized ?? "pending";
}

function isMandatoryMigrationDefinition(definition: Record<string, unknown>): boolean {
  return definition.mandatory === true;
}

function compareMandatoryMigrationBlockers(left: MandatoryMigrationBlocker, right: MandatoryMigrationBlocker): number {
  const byLayer = left.layer.localeCompare(right.layer);
  if (byLayer !== 0) {
    return byLayer;
  }
  const byName = left.name.localeCompare(right.name);
  if (byName !== 0) {
    return byName;
  }
  return left.id.localeCompare(right.id);
}

function collectMandatoryMigrationBlockers(
  migrations: Array<{
    layer: "global" | "project";
    name: string;
    definition: Record<string, unknown>;
  }>,
): MandatoryMigrationBlocker[] {
  const blockers: MandatoryMigrationBlocker[] = [];
  migrations.forEach((entry, index) => {
    if (!isMandatoryMigrationDefinition(entry.definition)) {
      return;
    }
    const status = resolveNormalizedMigrationStatus(entry.definition);
    if (status === "applied") {
      return;
    }
    blockers.push({
      layer: entry.layer,
      name: entry.name,
      id: resolveMigrationId(entry.definition, index),
      status,
    });
  });
  blockers.sort(compareMandatoryMigrationBlockers);
  return blockers;
}

function hasMutatingListValues(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

function decideWriteGate(commandPath: string, options: Record<string, unknown>): WriteGateDecision {
  const forceRequested = options.force === true;
  switch (commandPath) {
    case "create":
    case "beads import":
    case "todos import":
      return {
        isMutation: true,
        forceCapable: false,
        forceRequested: false,
      };
    case "restore":
    case "update":
    case "close":
    case "delete":
    case "append":
    case "claim":
    case "release":
      return {
        isMutation: true,
        forceCapable: true,
        forceRequested,
      };
    case "comments":
    case "notes":
    case "learnings":
      return {
        isMutation: typeof options.add === "string",
        forceCapable: true,
        forceRequested,
      };
    case "files":
    case "docs":
    case "test":
      return {
        isMutation: hasMutatingListValues(options.add) || hasMutatingListValues(options.remove),
        forceCapable: true,
        forceRequested,
      };
    default:
      return {
        isMutation: false,
        forceCapable: false,
        forceRequested: false,
      };
  }
}

function enforceMandatoryMigrationWriteGate(
  commandPath: string,
  options: Record<string, unknown>,
  blockers: MandatoryMigrationBlocker[],
): void {
  if (blockers.length === 0) {
    return;
  }
  const decision = decideWriteGate(commandPath, options);
  if (!decision.isMutation) {
    return;
  }
  if (decision.forceCapable && decision.forceRequested) {
    return;
  }
  const codes = blockers.map(
    (entry) => `extension_migration_blocking:${entry.layer}:${entry.name}:${entry.id}:${entry.status}`,
  );
  const forceGuidance = decision.forceCapable
    ? "Re-run this command with --force to bypass."
    : "This command path does not support --force bypass.";
  throw new PmCliError(
    `Write command "${commandPath}" blocked by unresolved mandatory extension migrations (${codes.join(",")}). ${forceGuidance}`,
    EXIT_CODE.CONFLICT,
  );
}

async function enforceItemFormatWriteGateAndPreflightMigration(
  commandPath: string,
  options: Record<string, unknown>,
  pmRoot: string,
  decision: PreflightRuntimeDecision,
): Promise<void> {
  const writeGate = decideWriteGate(commandPath, options);
  if (!writeGate.isMutation) {
    return;
  }
  if (!decision.enforce_item_format_gate && !decision.run_preflight_item_format_sync) {
    return;
  }
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    return;
  }
  const { settings, metadata, warnings } = await readSettingsWithMetadata(pmRoot);
  for (const warning of warnings) {
    printError(`warning:${warning}`);
  }
  if (decision.enforce_item_format_gate && !metadata.has_explicit_item_format) {
    throw new PmCliError(
      `Write command "${commandPath}" requires explicit item format selection before mutations. Run "pm config project set item-format --format toon" or "pm config project set item-format --format json_markdown".`,
      EXIT_CODE.CONFLICT,
    );
  }
  if (decision.run_preflight_item_format_sync) {
    const typeRegistry = resolveItemTypeRegistry(settings, getActiveExtensionRegistrations());
    await migrateItemFilesToFormat(
      pmRoot,
      settings.item_format,
      "item_format:pre_mutation_sync",
      typeRegistry.type_to_folder,
      settings.schema,
    );
  }
}

function describeUnknownError(error: unknown): string {
  if (error instanceof PmCliError) {
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return "Unknown failure";
}

function collectMutationItemIds(result: unknown): string[] {
  if (!result || typeof result !== "object") {
    return [];
  }
  const record = result as Record<string, unknown>;
  const ids = new Set<string>();
  const pushId = (value: unknown): void => {
    if (typeof value !== "string") {
      return;
    }
    const normalized = value.trim();
    if (normalized.length === 0) {
      return;
    }
    ids.add(normalized);
  };

  pushId(record.id);

  const item = record.item;
  if (item && typeof item === "object") {
    pushId((item as { id?: unknown }).id);
  }

  const explicitIds = record.ids;
  if (Array.isArray(explicitIds)) {
    for (const candidate of explicitIds) {
      pushId(candidate);
    }
  }

  const items = record.items;
  if (Array.isArray(items)) {
    for (const candidate of items) {
      if (!candidate || typeof candidate !== "object") {
        continue;
      }
      pushId((candidate as { id?: unknown }).id);
    }
  }

  return [...ids].sort((left, right) => left.localeCompare(right));
}

async function invalidateSearchCachesForMutation(globalOptions: GlobalOptions, result?: unknown): Promise<void> {
  const pmRoot = resolvePmRoot(process.cwd(), globalOptions.path);
  const refreshResult = await refreshSearchArtifactsForMutation(pmRoot, collectMutationItemIds(result));
  if (globalOptions.profile && refreshResult.warnings.length > 0) {
    printError(`profile:search_refresh_warnings=${formatHookWarnings(refreshResult.warnings)}`);
  }
}

async function runAndClearAfterCommandHooks(outcome: { ok: boolean; error?: string }): Promise<void> {
  const runtime = activeExtensionHookContext;
  activeExtensionHookContext = null;
  if (!runtime) {
    clearActiveExtensionHooks();
    return;
  }

  const hookWarnings = await runAfterCommandHooks(runtime.hooks, {
    command: runtime.commandName,
    args: runtime.commandArgs,
    options: { ...runtime.commandOptions },
    global: { ...runtime.globalOptions },
    pm_root: runtime.pmRoot,
    ok: outcome.ok,
    error: outcome.error,
    result: getActiveCommandResult(),
  });
  clearActiveExtensionHooks();
  if (runtime.profileEnabled && hookWarnings.length > 0) {
    printError(`profile:extensions hook_warnings=${formatHookWarnings(hookWarnings)}`);
  }
}

function extractCommandScopedOptions(
  command: Command,
  commandArgs: string[],
  extensionFlagDefinitions: Array<Record<string, unknown>> = [],
): Record<string, unknown> {
  const allOptions = command.optsWithGlobals() as Record<string, unknown>;
  const scoped: Record<string, unknown> = { ...allOptions };
  delete scoped.json;
  delete scoped.quiet;
  delete scoped.path;
  delete scoped.noExtensions;
  delete scoped.extensions;
  delete scoped.profile;
  delete scoped.pager;

  const looseOptions = parseLooseCommandOptions(commandArgs);
  for (const [key, value] of Object.entries(looseOptions)) {
    if (scoped[key] === undefined) {
      scoped[key] = value;
    }
  }
  if (extensionFlagDefinitions.length > 0) {
    return coerceLooseCommandOptionsWithFlagDefinitions(scoped, extensionFlagDefinitions);
  }
  return scoped;
}

function collectExtensionFlagDefinitionsForCommand(
  registrations: ReturnType<typeof createEmptyExtensionRegistrationRegistry>,
  commandPath: string,
): Array<Record<string, unknown>> {
  const normalizedCommandPath = normalizeExtensionCommandPath(commandPath);
  if (normalizedCommandPath.length === 0) {
    return [];
  }
  return registrations.flags
    .filter((entry) => normalizeExtensionCommandPath(entry.target_command) === normalizedCommandPath)
    .flatMap((entry) => entry.flags);
}

const RUNTIME_FIELD_COMMAND_BY_COMMAND_PATH: Readonly<Record<string, RuntimeFieldCommand>> = {
  create: "create",
  update: "update",
  "update-many": "update_many",
  list: "list",
  "list-all": "list",
  "list-draft": "list",
  "list-open": "list",
  "list-in-progress": "list",
  "list-blocked": "list",
  "list-closed": "list",
  "list-canceled": "list",
  search: "search",
  calendar: "calendar",
  context: "context",
  "templates save": "create",
};

const runtimeFieldLooseFlagDefinitionCache = new Map<string, Array<Record<string, unknown>>>();

function toLooseFieldDefinitionType(fieldType: string): "string" | "number" | "boolean" {
  if (fieldType === "number") {
    return "number";
  }
  if (fieldType === "boolean") {
    return "boolean";
  }
  return "string";
}

function commandHasLongOption(command: Command, longFlag: string): boolean {
  return command.options.some((option) => option.long === longFlag);
}

function commandHasShortOption(command: Command, shortFlag: string): boolean {
  return command.options.some((option) => option.short === shortFlag);
}

function addRuntimeFieldOption(command: Command, flagToken: string, description: string, repeatable: boolean): void {
  const normalizedToken = flagToken.trim();
  if (!normalizedToken) {
    return;
  }
  const helpText = description.length > 0 ? description : `Runtime schema field (${flagToken})`;
  if (normalizedToken.startsWith("-") && !normalizedToken.startsWith("--")) {
    if (commandHasShortOption(command, normalizedToken)) {
      return;
    }
    if (repeatable) {
      command.option(`${normalizedToken} <value>`, `${helpText} (repeatable)`, collect);
      return;
    }
    command.option(`${normalizedToken} <value>`, helpText);
    return;
  }
  const longFlag = normalizedToken.startsWith("--") ? normalizedToken : `--${normalizedToken}`;
  if (commandHasLongOption(command, longFlag)) {
    return;
  }
  if (repeatable) {
    command.option(`${longFlag} <value>`, `${helpText} (repeatable)`, collect);
    return;
  }
  command.option(`${longFlag} <value>`, helpText);
}

async function collectRuntimeFieldLooseFlagDefinitionsForCommand(
  commandPath: string,
  pmRoot: string,
): Promise<Array<Record<string, unknown>>> {
  const runtimeCommand = RUNTIME_FIELD_COMMAND_BY_COMMAND_PATH[commandPath];
  if (!runtimeCommand) {
    return [];
  }
  const cacheKey = `${pmRoot}:${runtimeCommand}`;
  const cached = runtimeFieldLooseFlagDefinitionCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    runtimeFieldLooseFlagDefinitionCache.set(cacheKey, []);
    return [];
  }
  const settings = await readSettings(pmRoot);
  const fieldRegistry = resolveRuntimeFieldRegistry(settings.schema);
  const definitions = (fieldRegistry.command_to_fields.get(runtimeCommand) ?? []).flatMap((field) => {
    const flagTokens = [field.cli_flag, ...field.cli_aliases];
    return flagTokens.map((token) => ({
      long: `--${token}`,
      type: toLooseFieldDefinitionType(field.type),
      value_type: toLooseFieldDefinitionType(field.type),
    }));
  });
  runtimeFieldLooseFlagDefinitionCache.set(cacheKey, definitions);
  return definitions;
}

async function registerRuntimeSchemaFieldFlags(rootProgram: Command): Promise<void> {
  const bootstrapGlobalOptions = parseBootstrapGlobalOptions(process.argv.slice(2));
  const pmRoot = resolvePmRoot(process.cwd(), bootstrapGlobalOptions.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    return;
  }
  const settings = await readSettings(pmRoot);
  const fieldRegistry = resolveRuntimeFieldRegistry(settings.schema);
  const mappings: Array<{ path: string; command: RuntimeFieldCommand }> = [
    { path: "create", command: "create" },
    { path: "update", command: "update" },
    { path: "update-many", command: "update_many" },
    { path: "list", command: "list" },
    { path: "list-all", command: "list" },
    { path: "list-draft", command: "list" },
    { path: "list-open", command: "list" },
    { path: "list-in-progress", command: "list" },
    { path: "list-blocked", command: "list" },
    { path: "list-closed", command: "list" },
    { path: "list-canceled", command: "list" },
    { path: "search", command: "search" },
    { path: "calendar", command: "calendar" },
    { path: "context", command: "context" },
    { path: "templates save", command: "create" },
  ];
  for (const mapping of mappings) {
    const command = findCommandByPath(rootProgram, mapping.path.split(" "));
    if (!command) {
      continue;
    }
    for (const field of fieldRegistry.command_to_fields.get(mapping.command) ?? []) {
      const description = field.description ?? "";
      addRuntimeFieldOption(command, field.cli_flag, description, field.repeatable);
      for (const alias of field.cli_aliases) {
        addRuntimeFieldOption(command, alias, `Alias for --${field.cli_flag}`, field.repeatable);
      }
    }
  }
}

function defaultPreflightDecision(): PreflightRuntimeDecision {
  return {
    enforce_item_format_gate: true,
    run_preflight_item_format_sync: true,
    run_extension_migrations: true,
    enforce_mandatory_migration_gate: true,
  };
}

function buildRuntimeExtensionSnapshotCacheKey(pmRoot: string): string {
  return `pm-root:${pmRoot}`;
}

function emitExtensionProfile(globalOptions: GlobalOptions, snapshot: RuntimeExtensionSnapshot): void {
  if (!globalOptions.profile) {
    return;
  }
  printError(
    `profile:extensions loaded=${snapshot.loadedCount} failed=${snapshot.loadFailedCount} warnings=${snapshot.loadWarnings.length} activation_failed=${snapshot.activationFailedCount} hook_counts=before:${snapshot.hooks.beforeCommand.length}|after:${snapshot.hooks.afterCommand.length}|write:${snapshot.hooks.onWrite.length}|read:${snapshot.hooks.onRead.length}|index:${snapshot.hooks.onIndex.length} command_overrides=${snapshot.commands.overrides.length} command_handlers=${snapshot.commands.handlers.length} parser_overrides=${snapshot.parsers.overrides.length} preflight_overrides=${snapshot.preflight.overrides.length} service_overrides=${snapshot.services.overrides.length} renderer_overrides=${snapshot.renderers.overrides.length}`,
  );
  if (snapshot.activationWarnings.length > 0) {
    printError(`profile:extensions activation_warnings=${formatHookWarnings(snapshot.activationWarnings)}`);
  }
}

async function loadRuntimeExtensionSnapshot(pmRoot: string): Promise<RuntimeExtensionSnapshot | null> {
  const cacheKey = buildRuntimeExtensionSnapshotCacheKey(pmRoot);
  if (runtimeExtensionSnapshotCache?.key === cacheKey) {
    return runtimeExtensionSnapshotCache.snapshot;
  }

  const settingsPath = getSettingsPath(pmRoot);
  if (!(await pathExists(settingsPath))) {
    runtimeExtensionSnapshotCache = {
      key: cacheKey,
      snapshot: null,
    };
    return null;
  }

  try {
    const settings = await readSettings(pmRoot);
    const loadResult = await loadExtensions({
      pmRoot,
      settings,
      cwd: process.cwd(),
      noExtensions: false,
    });
    const activationResult = await activateExtensions({
      ...loadResult,
      loaded: loadResult.loaded,
    });
    const commandHandlers = [...new Set(activationResult.commands.handlers.map((entry) => normalizeExtensionCommandPath(entry.command)))]
      .filter((entry) => entry.length > 0)
      .sort((left, right) => left.localeCompare(right));
    const commandFlagHelp = collectDynamicExtensionFlagHelpByCommand(activationResult.registrations.flags);
    const commandDescriptors = collectExtensionCommandHelpDescriptors(
      commandHandlers,
      activationResult.registrations.commands,
      activationResult.registrations.flags,
    );
    const snapshot: RuntimeExtensionSnapshot = {
      hooks: activationResult.hooks,
      commands: activationResult.commands,
      parsers: activationResult.parsers,
      preflight: activationResult.preflight,
      services: activationResult.services,
      renderers: activationResult.renderers,
      registrations: activationResult.registrations,
      pmRoot,
      settings,
      commandHandlers,
      commandFlagHelp,
      commandDescriptors,
      loadWarnings: [...loadResult.warnings],
      activationWarnings: [...activationResult.warnings],
      loadedCount: loadResult.loaded.length,
      loadFailedCount: loadResult.failed.length,
      activationFailedCount: activationResult.failed.length,
    };
    runtimeExtensionSnapshotCache = {
      key: cacheKey,
      snapshot,
    };
    return snapshot;
  } catch {
    runtimeExtensionSnapshotCache = {
      key: cacheKey,
      snapshot: null,
    };
    return null;
  }
}

async function maybeLoadRuntimeExtensions(
  command: Command,
): Promise<
  {
    hooks: ExtensionHookRegistry;
    commands: ExtensionCommandRegistry;
    parsers: ExtensionParserRegistry;
    preflight: ExtensionPreflightRegistry;
    services: ExtensionServiceRegistry;
    renderers: ExtensionRendererRegistry;
    registrations: ReturnType<typeof createEmptyExtensionRegistrationRegistry>;
    pmRoot: string;
  } | null
> {
  const globalOptions = getGlobalOptions(command);
  if (globalOptions.noExtensions) {
    return null;
  }

  const pmRoot = resolvePmRoot(process.cwd(), globalOptions.path);
  const snapshot = await loadRuntimeExtensionSnapshot(pmRoot);
  if (!snapshot) {
    return null;
  }

  emitExtensionProfile(globalOptions, snapshot);
  return {
    hooks: snapshot.hooks,
    commands: snapshot.commands,
    parsers: snapshot.parsers,
    preflight: snapshot.preflight,
    services: snapshot.services,
    renderers: snapshot.renderers,
    registrations: snapshot.registrations,
    pmRoot,
  };
}

async function executeRegisteredRuntimeMigrations(
  migrations: RegisteredExtensionSchemaMigrationDefinition[],
  pmRoot: string,
): Promise<string[]> {
  const warnings: string[] = [];
  for (let index = 0; index < migrations.length; index += 1) {
    const migration = migrations[index];
    const status = resolveNormalizedMigrationStatus(migration.definition);
    if (status === "applied") {
      continue;
    }

    const runtimeDefinition = migration.runtime_definition ?? migration.definition;
    const run = (runtimeDefinition as { run?: unknown }).run;
    if (typeof run !== "function") {
      continue;
    }

    const migrationId = resolveMigrationId(migration.definition, index);
    try {
      await Promise.resolve(
        run({
          id: migrationId,
          command: "migration",
          layer: migration.layer,
          extension: migration.name,
          pm_root: pmRoot,
          status,
        }),
      );
      migration.definition.status = "applied";
      delete migration.definition.reason;
      delete migration.definition.error;
      delete migration.definition.message;
    } catch (error: unknown) {
      migration.definition.status = "failed";
      migration.definition.reason = describeUnknownError(error);
      warnings.push(`extension_migration_failed:${migration.layer}:${migration.name}:${migrationId}`);
    }
  }
  return warnings;
}

async function runRequiredExtensionCommand(
  command: Command,
  options: Record<string, unknown>,
  globalOptions: GlobalOptions,
): Promise<unknown> {
  const commandPath = getCommandPath(command);
  let commandArgs = command.args.map(String);
  let commandOptions = { ...options };
  let resolvedGlobalOptions = { ...globalOptions };
  const pmRoot = resolvePmRoot(process.cwd(), globalOptions.path);
  const parserOverride = await runActiveParserOverride({
    command: commandPath,
    args: commandArgs,
    options: commandOptions,
    global: resolvedGlobalOptions,
    pm_root: pmRoot,
  });
  if (globalOptions.profile && parserOverride.warnings.length > 0) {
    printError(`profile:extensions parser_warnings=${formatHookWarnings(parserOverride.warnings)}`);
  }
  commandArgs = parserOverride.context.args;
  commandOptions = parserOverride.context.options;
  resolvedGlobalOptions = parserOverride.context.global;
  setActiveCommandResult(undefined);
  setActiveCommandContext({
    command: commandPath,
    args: commandArgs,
    options: { ...commandOptions },
    global: { ...resolvedGlobalOptions },
    pm_root: pmRoot,
  });
  const extensionCommandResult = await runActiveCommandHandler({
    command: commandPath,
    args: commandArgs,
    options: commandOptions,
    global: resolvedGlobalOptions,
    pm_root: pmRoot,
  });
  if (resolvedGlobalOptions.profile && extensionCommandResult.warnings.length > 0) {
    printError(`profile:extensions command_handler_warnings=${formatHookWarnings(extensionCommandResult.warnings)}`);
  }
  if (!extensionCommandResult.handled) {
    if (extensionCommandResult.warnings.length > 0) {
      const warningCode = extensionCommandResult.warnings[0];
      throw new PmCliError(
        `Command "${commandPath}" failed in extension handler (${warningCode}).`,
        EXIT_CODE.GENERIC_FAILURE,
      );
    }
    throw new PmCliError(`Command "${commandPath}" is provided by extensions and is not currently available.`, EXIT_CODE.NOT_FOUND);
  }
  setActiveCommandResult(extensionCommandResult.result);
  return extensionCommandResult.result;
}

const WRAPPED_ACTION_HANDLER = Symbol("pm.wrappedActionHandler");

function wrapProgramActionsForExtensionHandlers(rootProgram: Command): void {
  const visit = (entry: Command): void => {
    type ActionMutableCommand = Command & {
      _actionHandler?: (...args: unknown[]) => unknown;
      [WRAPPED_ACTION_HANDLER]?: boolean;
    };
    const actionEntry = entry as ActionMutableCommand;
    if (typeof actionEntry._actionHandler === "function" && actionEntry[WRAPPED_ACTION_HANDLER] !== true) {
      const originalAction = actionEntry._actionHandler;
      actionEntry._actionHandler = async function wrappedActionHandler(this: unknown, ...actionArgs: unknown[]): Promise<unknown> {
        const possibleCommand = actionArgs[actionArgs.length - 1];
        const actionCommand = possibleCommand instanceof Command ? possibleCommand : entry;
        const startedAt = Date.now();
        clearResolvedGlobalOptions(actionCommand);
        let globalOptions = getGlobalOptions(actionCommand);
        const commandPath = getCommandPath(actionCommand);
        const pmRoot = resolvePmRoot(process.cwd(), globalOptions.path);
        let commandArgs = actionCommand.args.map(String);
        const activeRegistrations = getActiveExtensionRegistrations();
        const extensionFlagDefinitions = activeRegistrations
          ? collectExtensionFlagDefinitionsForCommand(activeRegistrations, commandPath)
          : [];
        const runtimeFieldFlagDefinitions = await collectRuntimeFieldLooseFlagDefinitionsForCommand(commandPath, pmRoot);
        let commandOptions = extractCommandScopedOptions(actionCommand, commandArgs, [
          ...extensionFlagDefinitions,
          ...runtimeFieldFlagDefinitions,
        ]);
        const parserOverride = await runActiveParserOverride({
          command: commandPath,
          args: commandArgs,
          options: commandOptions,
          global: globalOptions,
          pm_root: pmRoot,
        });
        if (globalOptions.profile && parserOverride.warnings.length > 0) {
          printError(`profile:extensions parser_warnings=${formatHookWarnings(parserOverride.warnings)}`);
        }
        commandArgs = parserOverride.context.args;
        commandOptions = parserOverride.context.options;
        globalOptions = parserOverride.context.global;
        globalOptions = await applyDefaultOutputFormat(globalOptions);
        setResolvedGlobalOptions(actionCommand, globalOptions);
        actionCommand.args = [...commandArgs];
        if ("_processArguments" in actionCommand && typeof actionCommand._processArguments === "function") {
          actionCommand._processArguments();
        }
        if (actionArgs.length > 0 && Array.isArray(actionArgs[0])) {
          actionArgs[0] = [...actionCommand.processedArgs];
        }
        for (const [key, value] of Object.entries(commandOptions)) {
          actionCommand.setOptionValueWithSource(key, value, "cli");
        }
        setActiveCommandResult(undefined);
        setActiveCommandContext({
          command: commandPath,
          args: commandArgs,
          options: { ...commandOptions },
          global: { ...globalOptions },
          pm_root: pmRoot,
        });

        const extensionCommandResult = await runActiveCommandHandler({
          command: commandPath,
          args: commandArgs,
          options: commandOptions,
          global: globalOptions,
          pm_root: pmRoot,
        });
        if (globalOptions.profile && extensionCommandResult.warnings.length > 0) {
          printError(`profile:extensions command_handler_warnings=${formatHookWarnings(extensionCommandResult.warnings)}`);
        }
        if (extensionCommandResult.handled) {
          setActiveCommandResult(extensionCommandResult.result);
          printResult(extensionCommandResult.result, globalOptions);
          if (globalOptions.profile) {
            printError(`profile:command=${commandPath} took_ms=${Date.now() - startedAt}`);
          }
          return;
        }

        return await originalAction.apply(this, actionArgs);
      };
      actionEntry[WRAPPED_ACTION_HANDLER] = true;
    }
    for (const child of entry.commands) {
      visit(child);
    }
  };
  visit(rootProgram);
}

async function registerDynamicExtensionCommandPaths(rootProgram: Command): Promise<void> {
  const bootstrapGlobalOptions = parseBootstrapGlobalOptions(process.argv.slice(2));
  if (bootstrapGlobalOptions.noExtensions) {
    activeRuntimeExtensionCommandDescriptors = new Map<string, ExtensionCommandHelpDescriptor>();
    return;
  }

  const pmRoot = resolvePmRoot(process.cwd(), bootstrapGlobalOptions.path);
  const snapshot = await loadRuntimeExtensionSnapshot(pmRoot);
  if (!snapshot) {
    activeRuntimeExtensionCommandDescriptors = new Map<string, ExtensionCommandHelpDescriptor>();
    return;
  }
  activeRuntimeExtensionCommandDescriptors = new Map(snapshot.commandDescriptors);
  const typeRegistry = resolveItemTypeRegistry(snapshot.settings, snapshot.registrations);
  attachCreateUpdatePolicyHelpText(rootProgram, typeRegistry, process.argv.slice(2));

  const commandPaths = [...new Set([...snapshot.commandHandlers, ...snapshot.commandDescriptors.keys()])].sort((left, right) =>
    left.localeCompare(right),
  );
  for (const commandPath of commandPaths) {
    const pathParts = commandPath.split(" ").filter((part) => part.length > 0);
    if (pathParts.length === 0) {
      continue;
    }
    const descriptor = snapshot.commandDescriptors.get(commandPath);
    const existingCommand = findCommandByPath(rootProgram, pathParts);
    const flagHelp = snapshot.commandFlagHelp.get(commandPath);
    const metadataHelp = descriptor ? buildDynamicExtensionCommandMetadataHelp(descriptor) : null;
    if (existingCommand) {
      if (flagHelp) {
        existingCommand.addHelpText("after", flagHelp);
      }
      if (metadataHelp) {
        existingCommand.addHelpText("after", metadataHelp);
      }
      continue;
    }

    const dynamicCommand = ensureCommandPath(rootProgram, pathParts);
    if (!dynamicCommand) {
      continue;
    }
    if (descriptor?.description) {
      dynamicCommand.description(descriptor.description);
    }
    if (descriptor) {
      applyDynamicExtensionArguments(dynamicCommand, descriptor);
    }
    if (flagHelp) {
      dynamicCommand.addHelpText("after", flagHelp);
    }
    if (metadataHelp) {
      dynamicCommand.addHelpText("after", metadataHelp);
    }

    dynamicCommand
      .allowUnknownOption(true)
      .allowExcessArguments(true)
      .action(async (_options: Record<string, unknown>, command) => {
        const globalOptions = getGlobalOptions(command);
        const startedAt = Date.now();
        const extensionFlagDefinitions = collectExtensionFlagDefinitionsForCommand(snapshot.registrations, commandPath);
        const scopedOptions = extractCommandScopedOptions(
          command,
          command.args.map(String),
          extensionFlagDefinitions,
        );
        const result = await runRequiredExtensionCommand(command, scopedOptions, globalOptions);
        await invalidateSearchCachesForMutation(globalOptions, result);
        printResult(result, globalOptions);
        if (globalOptions.profile) {
          printError(`profile:command=${commandPath} took_ms=${Date.now() - startedAt}`);
        }
      });
  }
}

function normalizeCreateOptions(
  commandOptions: Record<string, unknown>,
  options: { requireType?: boolean } = {},
): CreateCommandOptions {
  const readCreateString = (target: string): string | undefined =>
    readFirstStringFromCommanderOptions(
      commandOptions,
      CREATE_COMMANDER_STRING_OPTION_CONTRACTS.find((entry) => entry.target === target) ?? {
        target,
        keys: [target],
      },
    );
  const readCreateList = (target: string): string[] | undefined =>
    readStringArrayFromCommanderOptions(
      commandOptions,
      CREATE_COMMANDER_REPEATABLE_OPTION_CONTRACTS.find((entry) => entry.target === target) ?? {
        target,
        keys: [target],
      },
    );

  const type = readCreateString("type");
  if (options.requireType !== false && type === undefined) {
    throw new PmCliError("Missing required option --type <value>", EXIT_CODE.USAGE);
  }

  const normalized: Record<string, unknown> = {
    title: readCreateString("title"),
    description: readCreateString("description"),
    type,
    template: readCreateString("template"),
    createMode: readCreateString("createMode"),
    schedulePreset: readCreateString("schedulePreset"),
    status: readCreateString("status"),
    priority: readCreateString("priority"),
    tags: readCreateString("tags"),
    body: readCreateString("body"),
    deadline: readCreateString("deadline"),
    estimatedMinutes: readCreateString("estimatedMinutes"),
    acceptanceCriteria: readCreateString("acceptanceCriteria"),
    definitionOfReady: readCreateString("definitionOfReady"),
    order: readCreateString("order"),
    rank: readCreateString("rank"),
    goal: readCreateString("goal"),
    objective: readCreateString("objective"),
    value: readCreateString("value"),
    impact: readCreateString("impact"),
    outcome: readCreateString("outcome"),
    whyNow: readCreateString("whyNow"),
    author: readCreateString("author"),
    message: readCreateString("message"),
    assignee: readCreateString("assignee"),
    parent: readCreateString("parent"),
    reviewer: readCreateString("reviewer"),
    risk: readCreateString("risk"),
    confidence: readCreateString("confidence"),
    sprint: readCreateString("sprint"),
    release: readCreateString("release"),
    blockedBy: readCreateString("blockedBy"),
    blockedReason: readCreateString("blockedReason"),
    unblockNote: readCreateString("unblockNote"),
    reporter: readCreateString("reporter"),
    severity: readCreateString("severity"),
    environment: readCreateString("environment"),
    reproSteps: readCreateString("reproSteps"),
    resolution: readCreateString("resolution"),
    expectedResult: readCreateString("expectedResult"),
    actualResult: readCreateString("actualResult"),
    affectedVersion: readCreateString("affectedVersion"),
    fixedVersion: readCreateString("fixedVersion"),
    component: readCreateString("component"),
    regression: readCreateString("regression"),
    customerImpact: readCreateString("customerImpact"),
    dep: readCreateList("dep"),
    comment: readCreateList("comment"),
    note: readCreateList("note"),
    learning: readCreateList("learning"),
    file: readCreateList("file"),
    test: readCreateList("test"),
    doc: readCreateList("doc"),
    reminder: readCreateList("reminder"),
    event: readCreateList("event"),
    typeOption: readCreateList("typeOption"),
    unset: readCreateList("unset"),
    clearDeps: commandOptions.clearDeps === true ? true : undefined,
    clearComments: commandOptions.clearComments === true ? true : undefined,
    clearNotes: commandOptions.clearNotes === true ? true : undefined,
    clearLearnings: commandOptions.clearLearnings === true ? true : undefined,
    clearFiles: commandOptions.clearFiles === true ? true : undefined,
    clearTests: commandOptions.clearTests === true ? true : undefined,
    clearDocs: commandOptions.clearDocs === true ? true : undefined,
    clearReminders: commandOptions.clearReminders === true ? true : undefined,
    clearEvents: commandOptions.clearEvents === true ? true : undefined,
    clearTypeOptions: commandOptions.clearTypeOptions === true ? true : undefined,
  };
  for (const [key, value] of Object.entries(commandOptions)) {
    if (Object.hasOwn(normalized, key)) {
      continue;
    }
    normalized[key] = value;
  }
  return normalized as CreateCommandOptions;
}

function normalizeUpdateOptions(commandOptions: Record<string, unknown>): Record<string, unknown> {
  const readUpdateString = (target: string): string | undefined =>
    readFirstStringFromCommanderOptions(
      commandOptions,
      UPDATE_COMMANDER_STRING_OPTION_CONTRACTS.find((entry) => entry.target === target) ?? {
        target,
        keys: [target],
      },
    );
  const readUpdateList = (target: string): string[] | undefined =>
    readStringArrayFromCommanderOptions(
      commandOptions,
      UPDATE_COMMANDER_REPEATABLE_OPTION_CONTRACTS.find((entry) => entry.target === target) ?? {
        target,
        keys: [target],
      },
    );

  const normalized: Record<string, unknown> = {
    title: readUpdateString("title"),
    description: readUpdateString("description"),
    body: readUpdateString("body"),
    status: readUpdateString("status"),
    closeReason: readUpdateString("closeReason"),
    priority: readUpdateString("priority"),
    type: readUpdateString("type"),
    tags: readUpdateString("tags"),
    deadline: readUpdateString("deadline"),
    estimatedMinutes: readUpdateString("estimatedMinutes"),
    acceptanceCriteria: readUpdateString("acceptanceCriteria"),
    definitionOfReady: readUpdateString("definitionOfReady"),
    order: readUpdateString("order"),
    rank: readUpdateString("rank"),
    goal: readUpdateString("goal"),
    objective: readUpdateString("objective"),
    value: readUpdateString("value"),
    impact: readUpdateString("impact"),
    outcome: readUpdateString("outcome"),
    whyNow: readUpdateString("whyNow"),
    author: readUpdateString("author"),
    message: readUpdateString("message"),
    force: Boolean(commandOptions.force),
    allowAuditUpdate:
      commandOptions.allowAuditUpdate === true || commandOptions.allow_audit_update === true ? true : undefined,
    allowAuditDepUpdate:
      commandOptions.allowAuditDepUpdate === true || commandOptions.allow_audit_dep_update === true ? true : undefined,
    assignee: readUpdateString("assignee"),
    parent: readUpdateString("parent"),
    reviewer: readUpdateString("reviewer"),
    risk: readUpdateString("risk"),
    confidence: readUpdateString("confidence"),
    sprint: readUpdateString("sprint"),
    release: readUpdateString("release"),
    blockedBy: readUpdateString("blockedBy"),
    blockedReason: readUpdateString("blockedReason"),
    unblockNote: readUpdateString("unblockNote"),
    reporter: readUpdateString("reporter"),
    severity: readUpdateString("severity"),
    environment: readUpdateString("environment"),
    reproSteps: readUpdateString("reproSteps"),
    resolution: readUpdateString("resolution"),
    expectedResult: readUpdateString("expectedResult"),
    actualResult: readUpdateString("actualResult"),
    affectedVersion: readUpdateString("affectedVersion"),
    fixedVersion: readUpdateString("fixedVersion"),
    component: readUpdateString("component"),
    regression: readUpdateString("regression"),
    customerImpact: readUpdateString("customerImpact"),
    dep: readUpdateList("dep"),
    depRemove: readUpdateList("depRemove"),
    replaceDeps: commandOptions.replaceDeps === true ? true : undefined,
    replaceTests: commandOptions.replaceTests === true ? true : undefined,
    comment: readUpdateList("comment"),
    note: readUpdateList("note"),
    learning: readUpdateList("learning"),
    file: readUpdateList("file"),
    test: readUpdateList("test"),
    doc: readUpdateList("doc"),
    reminder: readUpdateList("reminder"),
    event: readUpdateList("event"),
    typeOption: readUpdateList("typeOption"),
    unset: readUpdateList("unset"),
    clearDeps: commandOptions.clearDeps === true ? true : undefined,
    clearComments: commandOptions.clearComments === true ? true : undefined,
    clearNotes: commandOptions.clearNotes === true ? true : undefined,
    clearLearnings: commandOptions.clearLearnings === true ? true : undefined,
    clearFiles: commandOptions.clearFiles === true ? true : undefined,
    clearTests: commandOptions.clearTests === true ? true : undefined,
    clearDocs: commandOptions.clearDocs === true ? true : undefined,
    clearReminders: commandOptions.clearReminders === true ? true : undefined,
    clearEvents: commandOptions.clearEvents === true ? true : undefined,
    clearTypeOptions: commandOptions.clearTypeOptions === true ? true : undefined,
  };
  for (const [key, value] of Object.entries(commandOptions)) {
    if (Object.hasOwn(normalized, key)) {
      continue;
    }
    normalized[key] = value;
  }
  return normalized;
}

const UPDATE_MANY_CONTROL_OPTION_KEYS = new Set<string>([
  "filterStatus",
  "filterType",
  "filterTag",
  "filterPriority",
  "filterDeadlineBefore",
  "filterDeadlineAfter",
  "filterAssignee",
  "filterAssigneeFilter",
  "filterAssignee_filter",
  "filterParent",
  "filterSprint",
  "filterRelease",
  "limit",
  "offset",
  "dryRun",
  "rollback",
  "checkpoint",
]);

function extractUpdateManyMutationOptionSource(commandOptions: Record<string, unknown>): Record<string, unknown> {
  const mutationOptions: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(commandOptions)) {
    if (UPDATE_MANY_CONTROL_OPTION_KEYS.has(key)) {
      continue;
    }
    mutationOptions[key] = value;
  }
  return mutationOptions;
}

function readListOptionString(options: Record<string, unknown>, target: string): string | undefined {
  return readFirstStringFromCommanderOptions(
    options,
    LIST_COMMANDER_STRING_OPTION_CONTRACTS.find((entry) => entry.target === target) ?? {
      target,
      keys: [target],
    },
  );
}

function normalizeListOptions(options: Record<string, unknown>): ListOptions {
  const normalized: Record<string, unknown> = {
    type: readListOptionString(options, "type"),
    tag: readListOptionString(options, "tag"),
    priority: readListOptionString(options, "priority"),
    deadlineBefore: readListOptionString(options, "deadlineBefore"),
    deadlineAfter: readListOptionString(options, "deadlineAfter"),
    assignee: readListOptionString(options, "assignee"),
    assigneeFilter: readListOptionString(options, "assigneeFilter"),
    parent: readListOptionString(options, "parent"),
    sprint: readListOptionString(options, "sprint"),
    release: readListOptionString(options, "release"),
    limit: readListOptionString(options, "limit"),
    offset: readListOptionString(options, "offset"),
    includeBody: options.includeBody === true ? true : undefined,
    compact: options.compact === true ? true : undefined,
    fields: readListOptionString(options, "fields"),
    sort: readListOptionString(options, "sort"),
    order: readListOptionString(options, "order"),
  };
  for (const [key, value] of Object.entries(options)) {
    if (Object.hasOwn(normalized, key)) {
      continue;
    }
    normalized[key] = value;
  }
  return normalized as ListOptions;
}

function normalizeAggregateOptions(options: Record<string, unknown>): AggregateOptions {
  return {
    groupBy: typeof options.groupBy === "string" ? options.groupBy : undefined,
    count: options.count === true ? true : undefined,
    includeUnparented: options.includeUnparented === true || options.include_unparented === true,
    status: typeof options.status === "string" ? options.status : undefined,
    type: readListOptionString(options, "type"),
    tag: readListOptionString(options, "tag"),
    priority: readListOptionString(options, "priority"),
    deadlineBefore: readListOptionString(options, "deadlineBefore"),
    deadlineAfter: readListOptionString(options, "deadlineAfter"),
    assignee: readListOptionString(options, "assignee"),
    assigneeFilter: readListOptionString(options, "assigneeFilter"),
    parent: readListOptionString(options, "parent"),
    sprint: readListOptionString(options, "sprint"),
    release: readListOptionString(options, "release"),
  };
}

function normalizeDedupeAuditOptions(options: Record<string, unknown>): DedupeAuditOptions {
  return {
    mode: typeof options.mode === "string" ? options.mode : undefined,
    status: typeof options.status === "string" ? options.status : undefined,
    type: readListOptionString(options, "type"),
    tag: readListOptionString(options, "tag"),
    priority: readListOptionString(options, "priority"),
    deadlineBefore: readListOptionString(options, "deadlineBefore"),
    deadlineAfter: readListOptionString(options, "deadlineAfter"),
    assignee: readListOptionString(options, "assignee"),
    assigneeFilter: readListOptionString(options, "assigneeFilter"),
    parent: readListOptionString(options, "parent"),
    sprint: readListOptionString(options, "sprint"),
    release: readListOptionString(options, "release"),
    limit: readListOptionString(options, "limit"),
    threshold: typeof options.threshold === "string" ? options.threshold : undefined,
  };
}

type ListCommandResult = Awaited<ReturnType<typeof runList>>;

function printListJsonStream(commandName: string, result: ListCommandResult, globalOptions: GlobalOptions): void {
  setActiveCommandResult(result);
  if (globalOptions.quiet) {
    return;
  }
  const warnings = Array.isArray(result.warnings) ? result.warnings : [];
  const metaPayload: Record<string, unknown> = {
    type: "meta",
    command: commandName,
    count: result.count,
    now: result.now,
    filters: result.filters,
  };
  if (warnings.length > 0) {
    metaPayload.warnings = warnings;
  }
  if (!writeStdout(`${JSON.stringify(metaPayload)}\n`)) {
    return;
  }
  for (const item of result.items) {
    if (!writeStdout(`${JSON.stringify({ type: "item", command: commandName, item })}\n`)) {
      return;
    }
  }
  writeStdout(`${JSON.stringify({ type: "end", command: commandName, count: result.count })}\n`);
}

type ActivityCommandResult = Awaited<ReturnType<typeof runActivity>>;

function printActivityJsonStream(
  result: ActivityCommandResult,
  options: {
    id?: string;
    op?: string;
    author?: string;
    from?: string;
    to?: string;
    limit?: string;
  },
  globalOptions: GlobalOptions,
): void {
  setActiveCommandResult(result);
  if (globalOptions.quiet) {
    return;
  }
  const metaPayload = {
    type: "meta",
    command: "activity",
    count: result.count,
    filters: {
      id: options.id ?? null,
      op: options.op ?? null,
      author: options.author ?? null,
      from: options.from ?? null,
      to: options.to ?? null,
      limit: options.limit ?? null,
    },
  };
  if (!writeStdout(`${JSON.stringify(metaPayload)}\n`)) {
    return;
  }
  for (const entry of result.activity) {
    if (!writeStdout(`${JSON.stringify({ type: "entry", command: "activity", entry })}\n`)) {
      return;
    }
  }
  writeStdout(`${JSON.stringify({ type: "end", command: "activity", count: result.count })}\n`);
}

function normalizeSearchOptions(options: Record<string, unknown>): Record<string, unknown> {
  const readSearchString = (target: string): string | undefined =>
    readFirstStringFromCommanderOptions(
      options,
      SEARCH_COMMANDER_STRING_OPTION_CONTRACTS.find((entry) => entry.target === target) ?? {
        target,
        keys: [target],
      },
    );
  const fields = readSearchString("fields");
  const compactRequested = options.compact === true;
  const fullRequested = options.full === true;
  const defaultCompact = !compactRequested && !fullRequested && fields === undefined;
  const normalized: Record<string, unknown> = {
    mode: readSearchString("mode"),
    includeLinked: options.includeLinked === true ? true : undefined,
    titleExact: options.titleExact === true ? true : undefined,
    phraseExact: options.phraseExact === true ? true : undefined,
    type: readSearchString("type"),
    tag: readSearchString("tag"),
    priority: readSearchString("priority"),
    deadlineBefore: readSearchString("deadlineBefore"),
    deadlineAfter: readSearchString("deadlineAfter"),
    limit: readSearchString("limit"),
    fields,
    compact: compactRequested || defaultCompact ? true : undefined,
    full: fullRequested ? true : undefined,
  };
  for (const [key, value] of Object.entries(options)) {
    if (Object.hasOwn(normalized, key)) {
      continue;
    }
    normalized[key] = value;
  }
  return normalized;
}

function normalizeSearchKeywordsInput(keywords: string[]): string {
  const query = keywords
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .join(" ");
  if (query.length === 0) {
    throw new PmCliError("Search query must not be empty", EXIT_CODE.USAGE);
  }
  return query;
}

function normalizeCalendarOptions(options: Record<string, unknown>): CalendarOptions {
  const readCalendarString = (target: string): string | undefined =>
    readFirstStringFromCommanderOptions(
      options,
      CALENDAR_COMMANDER_STRING_OPTION_CONTRACTS.find((entry) => entry.target === target) ?? {
        target,
        keys: [target],
      },
    );
  const normalized: Record<string, unknown> = {
    view: readCalendarString("view"),
    date: readCalendarString("date"),
    from: readCalendarString("from"),
    to: readCalendarString("to"),
    past: options.past === true ? true : undefined,
    fullPeriod: options.fullPeriod === true || options.full_period === true ? true : undefined,
    limit: readCalendarString("limit"),
    type: readCalendarString("type"),
    tag: readCalendarString("tag"),
    priority: readCalendarString("priority"),
    status: readCalendarString("status"),
    assignee: readCalendarString("assignee"),
    assigneeFilter: readCalendarString("assigneeFilter"),
    sprint: readCalendarString("sprint"),
    release: readCalendarString("release"),
    include: readCalendarString("include"),
    recurrenceLookaheadDays: readCalendarString("recurrenceLookaheadDays"),
    recurrenceLookbackDays: readCalendarString("recurrenceLookbackDays"),
    occurrenceLimit: readCalendarString("occurrenceLimit"),
    format: readCalendarString("format"),
  };
  for (const [key, value] of Object.entries(options)) {
    if (Object.hasOwn(normalized, key)) {
      continue;
    }
    normalized[key] = value;
  }
  return normalized as CalendarOptions;
}

function normalizeActivityOptions(options: Record<string, unknown>): {
  id?: string;
  op?: string;
  author?: string;
  from?: string;
  to?: string;
  limit?: string;
} {
  const readActivityString = (target: string): string | undefined =>
    readFirstStringFromCommanderOptions(
      options,
      ACTIVITY_COMMANDER_STRING_OPTION_CONTRACTS.find((entry) => entry.target === target) ?? {
        target,
        keys: [target],
      },
    );
  return {
    id: readActivityString("id"),
    op: readActivityString("op"),
    author: readActivityString("author"),
    from: readActivityString("from"),
    to: readActivityString("to"),
    limit: readActivityString("limit"),
  };
}

function resolveActivityStreamMode(raw: unknown): boolean {
  if (raw === true) {
    return true;
  }
  if (raw === false || raw === undefined || raw === null) {
    return false;
  }
  if (typeof raw === "string") {
    const normalized = raw.trim().toLowerCase();
    if (
      normalized.length === 0 ||
      normalized === "rows" ||
      normalized === "ndjson" ||
      normalized === "jsonl" ||
      normalized === "true" ||
      normalized === "1" ||
      normalized === "yes" ||
      normalized === "on"
    ) {
      return true;
    }
    if (normalized === "false" || normalized === "off" || normalized === "none" || normalized === "0") {
      return false;
    }
  }
  throw new PmCliError("Activity --stream accepts rows|ndjson|jsonl (or no value)", EXIT_CODE.USAGE);
}

function normalizeContextOptions(options: Record<string, unknown>): ContextOptions {
  const readContextString = (target: string): string | undefined =>
    readFirstStringFromCommanderOptions(
      options,
      CONTEXT_COMMANDER_STRING_OPTION_CONTRACTS.find((entry) => entry.target === target) ?? {
        target,
        keys: [target],
      },
    );
  const normalized: Record<string, unknown> = {
    date: readContextString("date"),
    from: readContextString("from"),
    to: readContextString("to"),
    past: options.past === true ? true : undefined,
    type: readContextString("type"),
    tag: readContextString("tag"),
    priority: readContextString("priority"),
    assignee: readContextString("assignee"),
    assigneeFilter: readContextString("assigneeFilter"),
    sprint: readContextString("sprint"),
    release: readContextString("release"),
    limit: readContextString("limit"),
    format: readContextString("format"),
  };
  for (const [key, value] of Object.entries(options)) {
    if (Object.hasOwn(normalized, key)) {
      continue;
    }
    normalized[key] = value;
  }
  return normalized as ContextOptions;
}

function resolveCliVersion(): string {
  try {
    const currentFilePath = fileURLToPath(import.meta.url);
    const packageJsonPath = path.resolve(path.dirname(currentFilePath), "../../package.json");
    const raw = fs.readFileSync(packageJsonPath, "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const program = new Command();
program
  .name("pm")
  .description("Universal, flexible, extensible, agent-optimized project management CLI for any project or programming language.")
  .version(resolveCliVersion())
  .showHelpAfterError(false)
  .allowExcessArguments(false)
  .allowUnknownOption(false)
  .configureOutput({
    writeOut: (str) => {
      writeStdout(str);
    },
    // Commander errors are rendered in our own catch path.
    writeErr: () => {},
  })
  .option("--json", "Output JSON instead of TOON")
  .option("--quiet", "Suppress stdout output")
  .option("--path <dir>", "Override PM path for this command")
  .option("--no-extensions", "Disable extension loading")
  .option("--no-pager", "Disable pager integration for help and long output")
  .option("--explain", "Render extended rationale and examples in help output")
  .option("--profile", "Print deterministic timing diagnostics")
  .exitOverride();

program.hook("preAction", async (_thisCommand, actionCommand) => {
  activeExtensionHookContext = null;
  clearActiveExtensionHooks();
  clearResolvedGlobalOptions(actionCommand);
  const bootstrapGlobalOptions = getGlobalOptions(actionCommand);
  const commandPath = getCommandPath(actionCommand);
  let commandArgs = actionCommand.args.map(String);
  let commandOptions = extractCommandScopedOptions(actionCommand, commandArgs);
  let globalOptions = { ...bootstrapGlobalOptions };
  const fallbackPmRoot = resolvePmRoot(process.cwd(), bootstrapGlobalOptions.path);
  const runtimeExtensions = await maybeLoadRuntimeExtensions(actionCommand);
  if (!runtimeExtensions) {
    await enforceItemFormatWriteGateAndPreflightMigration(
      commandPath,
      commandOptions,
      fallbackPmRoot,
      defaultPreflightDecision(),
    );
    return;
  }

  setActiveExtensionHooks(runtimeExtensions.hooks);
  setActiveExtensionCommands(runtimeExtensions.commands);
  setActiveExtensionParsers(runtimeExtensions.parsers);
  setActiveExtensionPreflight(runtimeExtensions.preflight);
  setActiveExtensionServices(runtimeExtensions.services);
  setActiveExtensionRenderers(runtimeExtensions.renderers);
  setActiveExtensionRegistrations(runtimeExtensions.registrations);

  const extensionFlagDefinitions = collectExtensionFlagDefinitionsForCommand(runtimeExtensions.registrations, commandPath);
  commandOptions = extractCommandScopedOptions(actionCommand, commandArgs, extensionFlagDefinitions);
  const parserOverride = await runActiveParserOverride({
    command: commandPath,
    args: commandArgs,
    options: commandOptions,
    global: globalOptions,
    pm_root: runtimeExtensions.pmRoot,
  });
  if (globalOptions.profile && parserOverride.warnings.length > 0) {
    printError(`profile:extensions parser_warnings=${formatHookWarnings(parserOverride.warnings)}`);
  }
  commandArgs = parserOverride.context.args;
  commandOptions = parserOverride.context.options;
  globalOptions = parserOverride.context.global;

  const preflightOverride = await runActivePreflightOverride({
    command: commandPath,
    args: commandArgs,
    options: commandOptions,
    global: globalOptions,
    pm_root: runtimeExtensions.pmRoot,
    decision: defaultPreflightDecision(),
  });
  if (globalOptions.profile && preflightOverride.warnings.length > 0) {
    printError(`profile:extensions preflight_warnings=${formatHookWarnings(preflightOverride.warnings)}`);
  }
  commandArgs = preflightOverride.context.args;
  commandOptions = preflightOverride.context.options;
  globalOptions = preflightOverride.context.global;
  const preflightDecision = preflightOverride.decision;

  await enforceItemFormatWriteGateAndPreflightMigration(
    commandPath,
    commandOptions,
    runtimeExtensions.pmRoot,
    preflightDecision,
  );

  const migrationWarnings = preflightDecision.run_extension_migrations
    ? await executeRegisteredRuntimeMigrations(runtimeExtensions.registrations.migrations, runtimeExtensions.pmRoot)
    : [];
  if (globalOptions.profile && migrationWarnings.length > 0) {
    printError(`profile:extensions migration_warnings=${formatHookWarnings(migrationWarnings)}`);
  }
  const migrationBlockers = collectMandatoryMigrationBlockers(runtimeExtensions.registrations.migrations);
  activeExtensionHookContext = {
    hooks: runtimeExtensions.hooks,
    commandName: commandPath,
    commandArgs,
    commandOptions: { ...commandOptions },
    globalOptions: { ...globalOptions },
    pmRoot: runtimeExtensions.pmRoot,
    profileEnabled: Boolean(globalOptions.profile),
    migrationBlockers,
  };
  setActiveCommandResult(undefined);
  setActiveCommandContext({
    command: commandPath,
    args: commandArgs,
    options: { ...commandOptions },
    global: { ...globalOptions },
    pm_root: runtimeExtensions.pmRoot,
  });

  const hookWarnings = await runBeforeCommandHooks(runtimeExtensions.hooks, {
    command: commandPath,
    args: commandArgs,
    options: { ...commandOptions },
    global: { ...globalOptions },
    pm_root: runtimeExtensions.pmRoot,
  });
  if (globalOptions.profile && hookWarnings.length > 0) {
    printError(`profile:extensions hook_warnings=${formatHookWarnings(hookWarnings)}`);
  }
  if (preflightDecision.enforce_mandatory_migration_gate) {
    enforceMandatoryMigrationWriteGate(commandPath, commandOptions, migrationBlockers);
  }
});

program.hook("postAction", async () => {
  await runAndClearAfterCommandHooks({ ok: true });
});

program
  .command("init")
  .argument("[prefix]", "Optional id prefix")
  .description("Initialize pm storage and defaults for the current workspace.")
  .action(async (prefix: string | undefined, _options, command) => {
    const globalOptions = getGlobalOptions(command);
    const startedAt = Date.now();
    const result = await runInit(prefix, globalOptions);
    printResult(result, globalOptions);
    if (globalOptions.profile) {
      printError(`profile:command=init took_ms=${Date.now() - startedAt}`);
    }
  });

program
  .command("config")
  .argument("<scope>", "Config scope: project|global")
  .argument("<action>", "Config action: get|set|list|export")
  .argument(
    "[key]",
    "Config key for get|set: definition-of-done|item-format|history-missing-stream-policy|sprint-release-format-policy|parent-reference-policy|metadata-validation-profile|metadata-required-fields|test-result-tracking",
  )
  .option("--criterion <text>", "Criteria value for definition-of-done or metadata-required-fields (repeatable for set)", collect)
  .option("--clear-criteria", "Clear metadata-required-fields criteria list (set metadata-required-fields only)")
  .option("--format <value>", "Item format for item-format key: toon|json_markdown")
  .option(
    "--policy <value>",
    "Policy key values: history-missing-stream-policy=auto_create|strict_error; sprint-release-format-policy=warn|strict_error; parent-reference-policy=warn|strict_error; test-result-tracking=enabled|disabled",
  )
  .description("Read or update pm settings for the current workspace or global profile.")
  .action(async (scope: string, action: string, key: string | undefined, options: Record<string, unknown>, command) => {
    const globalOptions = getGlobalOptions(command);
    const startedAt = Date.now();
    const criteria = Array.isArray(options.criterion) ? (options.criterion as string[]) : [];
    const result = await runConfig(
      scope,
      action,
      key,
      {
        criterion: criteria,
        format: typeof options.format === "string" ? options.format : undefined,
        policy: typeof options.policy === "string" ? options.policy : undefined,
        clearCriteria: options.clearCriteria === true,
      },
      globalOptions,
    );
    printResult(result, globalOptions);
    if (globalOptions.profile) {
      printError(`profile:command=config took_ms=${Date.now() - startedAt}`);
    }
  });

type ExtensionSubcommandAction =
  | "install"
  | "uninstall"
  | "explore"
  | "manage"
  | "doctor"
  | "adopt"
  | "adopt-all"
  | "activate"
  | "deactivate";

function normalizeExtensionOptions(
  options: Record<string, unknown>,
  forcedAction?: ExtensionSubcommandAction,
): Record<string, unknown> {
  const isForcedAction = (action: ExtensionSubcommandAction): boolean => forcedAction === action;
  const readBoolean = (...keys: string[]): boolean => keys.some((key) => options[key] === true);
  const readString = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      if (typeof options[key] === "string") {
        return options[key] as string;
      }
    }
    return undefined;
  };
  return {
    install: isForcedAction("install") || readBoolean("install"),
    uninstall: isForcedAction("uninstall") || readBoolean("uninstall"),
    explore: isForcedAction("explore") || readBoolean("explore"),
    manage: isForcedAction("manage") || readBoolean("manage"),
    doctor: isForcedAction("doctor") || readBoolean("doctor"),
    adopt: isForcedAction("adopt") || readBoolean("adopt"),
    adoptAll: isForcedAction("adopt-all") || readBoolean("adoptAll", "adopt_all", "adopt-all"),
    activate: isForcedAction("activate") || readBoolean("activate"),
    deactivate: isForcedAction("deactivate") || readBoolean("deactivate"),
    project: readBoolean("project"),
    local: readBoolean("local"),
    global: readBoolean("global"),
    gh: readString("gh"),
    github: readString("github"),
    ref: readString("ref"),
    detail: readString("detail"),
    trace: readBoolean("trace"),
    runtimeProbe: readBoolean("runtimeProbe", "runtime_probe", "runtime-probe"),
    fixManagedState: readBoolean("fixManagedState", "fix_managed_state", "fix-managed-state"),
    strictExit: readBoolean("strictExit", "strict_exit", "strict-exit"),
    failOnWarn: readBoolean("failOnWarn", "fail_on_warn", "fail-on-warn"),
  };
}

async function executeExtensionCommand(
  target: string | undefined,
  options: Record<string, unknown>,
  command: Command,
  forcedAction?: ExtensionSubcommandAction,
): Promise<void> {
  const globalOptions = getGlobalOptions(command);
  const startedAt = Date.now();
  const normalizedOptions = normalizeExtensionOptions(options, forcedAction);
  const result = await runExtension(target, normalizedOptions, globalOptions);
  printResult(result, globalOptions);
  const strictExit = Boolean(normalizedOptions.strictExit) || Boolean(normalizedOptions.failOnWarn);
  if (result.action === "doctor" && strictExit) {
    const detailsRecord = result.details as Record<string, unknown>;
    const summary = (detailsRecord.summary ?? null) as Record<string, unknown> | null;
    const summaryStatus = summary && typeof summary.status === "string" ? summary.status : undefined;
    const shouldFail = summaryStatus ? summaryStatus !== "ok" : result.warnings.length > 0;
    if (shouldFail) {
      process.exitCode = EXIT_CODE.GENERIC_FAILURE;
    }
  }
  if (globalOptions.profile) {
    printError(`profile:command=extension took_ms=${Date.now() - startedAt}`);
  }
}

function addExtensionScopeOptions<T extends Command>(command: T): T {
  return command
    .option("--project", "Use project extension scope (default)")
    .option("--local", "Alias for --project")
    .option("--global", "Use global extension scope");
}

const extensionCommand = program
  .command("extension")
  .argument("[target]", "Extension source (install) or extension name (adopt/activate/deactivate/uninstall)")
  .option("--install", "Install extension from local path or GitHub source")
  .option("--uninstall", "Uninstall an installed extension")
  .option("--explore", "List discovered extensions in selected scope")
  .option("--manage", "List managed extensions with update-check metadata")
  .option("--doctor", "Run consolidated extension diagnostics (summary/deep modes)")
  .option("--adopt", "Adopt an existing unmanaged extension into managed metadata")
  .option("--adopt-all", "Adopt all unmanaged extensions into managed metadata")
  .option("--activate", "Activate an extension in selected scope settings")
  .option("--deactivate", "Deactivate an extension in selected scope settings")
  .option("--project", "Use project extension scope (default)")
  .option("--local", "Alias for --project")
  .option("--global", "Use global extension scope")
  .option("--gh <owner/repo[/path]>", "Install from GitHub shorthand source")
  .option("--github <owner/repo[/path]>", "Alias for --gh")
  .option("--ref <ref>", "Git ref/branch/tag for GitHub install sources")
  .option("--detail <mode>", "Detail mode for extension diagnostics (summary|deep)")
  .option("--trace", "Include actionable registration traces in doctor deep diagnostics")
  .option("--runtime-probe", "Opt-in runtime activation probe for manage output parity")
  .option("--fix-managed-state", "Adopt unmanaged extensions before diagnostics/update checks")
  .option("--strict-exit", "Return non-zero exit when doctor warnings are present (ok=false)")
  .option("--fail-on-warn", "Alias for --strict-exit (doctor)")
  .description("Manage extension lifecycle operations for project or global scope.")
  .action(async (target: string | undefined, _options: Record<string, unknown>, command) => {
    await executeExtensionCommand(target, command.opts() as Record<string, unknown>, command);
  });

addExtensionScopeOptions(
  extensionCommand
    .command("install")
    .argument("[target]", "Extension source (local path or GitHub source)")
    .option("--gh <owner/repo[/path]>", "Install from GitHub shorthand source")
    .option("--github <owner/repo[/path]>", "Alias for --gh")
    .option("--ref <ref>", "Git ref/branch/tag for GitHub install sources")
    .description("Install extension from local path or GitHub source."),
).action(async (target: string | undefined, _options: Record<string, unknown>, command) => {
  await executeExtensionCommand(target, command.opts() as Record<string, unknown>, command, "install");
});

addExtensionScopeOptions(
  extensionCommand.command("uninstall").argument("<target>", "Extension name").description("Uninstall an installed extension."),
).action(async (target: string, _options: Record<string, unknown>, command) => {
  await executeExtensionCommand(target, command.opts() as Record<string, unknown>, command, "uninstall");
});

addExtensionScopeOptions(extensionCommand.command("explore").description("List discovered extensions in selected scope.")).action(
  async (_options: Record<string, unknown>, command) => {
    await executeExtensionCommand(undefined, command.opts() as Record<string, unknown>, command, "explore");
  },
);

addExtensionScopeOptions(
  extensionCommand
    .command("manage")
    .option("--runtime-probe", "Opt-in runtime activation probe for manage output parity")
    .option("--fix-managed-state", "Adopt unmanaged extensions before diagnostics/update checks")
    .description("List managed extensions with update-check metadata."),
).action(async (_options: Record<string, unknown>, command) => {
  await executeExtensionCommand(undefined, command.opts() as Record<string, unknown>, command, "manage");
});

addExtensionScopeOptions(
  extensionCommand
    .command("doctor")
    .option("--detail <mode>", "Detail mode for extension diagnostics (summary|deep)")
    .option("--trace", "Include actionable registration traces in doctor deep diagnostics")
    .option("--fix-managed-state", "Adopt unmanaged extensions before diagnostics/update checks")
    .option("--strict-exit", "Return non-zero exit when doctor warnings are present (ok=false)")
    .option("--fail-on-warn", "Alias for --strict-exit (doctor)")
    .description("Run consolidated extension diagnostics (summary/deep modes)."),
).action(async (_options: Record<string, unknown>, command) => {
  await executeExtensionCommand(undefined, command.opts() as Record<string, unknown>, command, "doctor");
});

addExtensionScopeOptions(
  extensionCommand
    .command("adopt")
    .argument("<target>", "Extension name")
    .option("--gh <owner/repo[/path]>", "GitHub provenance shorthand for adopted extension")
    .option("--github <owner/repo[/path]>", "Alias for --gh")
    .option("--ref <ref>", "Git ref/branch/tag for GitHub shorthand source")
    .description("Adopt an existing unmanaged extension into managed metadata."),
).action(async (target: string, _options: Record<string, unknown>, command) => {
  await executeExtensionCommand(target, command.opts() as Record<string, unknown>, command, "adopt");
});

addExtensionScopeOptions(
  extensionCommand.command("adopt-all").description("Adopt all unmanaged extensions into managed metadata."),
).action(async (_options: Record<string, unknown>, command) => {
  await executeExtensionCommand(undefined, command.opts() as Record<string, unknown>, command, "adopt-all");
});

addExtensionScopeOptions(
  extensionCommand.command("activate").argument("<target>", "Extension name").description("Activate an extension in selected scope settings."),
).action(async (target: string, _options: Record<string, unknown>, command) => {
  await executeExtensionCommand(target, command.opts() as Record<string, unknown>, command, "activate");
});

addExtensionScopeOptions(
  extensionCommand.command("deactivate").argument("<target>", "Extension name").description("Deactivate an extension in selected scope settings."),
).action(async (target: string, _options: Record<string, unknown>, command) => {
  await executeExtensionCommand(target, command.opts() as Record<string, unknown>, command, "deactivate");
});

const templatesCommand = program.command("templates").description("Manage reusable create templates.");

templatesCommand
  .command("save")
  .argument("<name>", "Template name")
  .option("--title, -t <value>", "Template default item title")
  .option("--description, -d <value>", "Template default item description")
  .option("--type <value>", "Template default item type")
  .option("--status, -s <value>", "Template default item status")
  .option("--priority, -p <value>", "Template default priority 0..4")
  .option("--tags <value>", "Template default comma-separated tags")
  .option("--body, -b <value>", "Template default item markdown body")
  .option("--deadline <value>", "Template default deadline")
  .option("--estimate, --estimated-minutes <value>", "Template default estimated minutes")
  .option("--estimated_minutes <value>", "Alias for --estimated-minutes")
  .option("--acceptance-criteria <value>", "Template default acceptance criteria")
  .option("--acceptance_criteria <value>", "Alias for --acceptance-criteria")
  .option("--ac <value>", "Alias for --acceptance-criteria")
  .option("--definition-of-ready <value>", "Template default definition of ready")
  .option("--definition_of_ready <value>", "Alias for --definition-of-ready")
  .option("--order <value>", "Template default planning order/rank integer")
  .option("--rank <value>", "Alias for --order")
  .option("--goal <value>", "Template default goal identifier")
  .option("--objective <value>", "Template default objective identifier")
  .option("--value <value>", "Template default business value summary")
  .option("--impact <value>", "Template default business impact summary")
  .option("--outcome <value>", "Template default expected outcome summary")
  .option("--why-now <value>", "Template default why-now rationale")
  .option("--why_now <value>", "Alias for --why-now")
  .option("--author <value>", "Template default mutation author")
  .option("--message <value>", "Template default history message")
  .option("--assignee <value>", "Template default assignee")
  .option("--parent <value>", "Template default parent item ID")
  .option("--reviewer <value>", "Template default reviewer")
  .option("--risk <value>", "Template default risk level")
  .option("--confidence <value>", "Template default confidence")
  .option("--sprint <value>", "Template default sprint identifier")
  .option("--release <value>", "Template default release identifier")
  .option("--blocked-by <value>", "Template default blocked-by item ID or reason")
  .option("--blocked_by <value>", "Alias for --blocked-by")
  .option("--blocked-reason <value>", "Template default blocked reason")
  .option("--blocked_reason <value>", "Alias for --blocked-reason")
  .option("--unblock-note <value>", "Template default unblock rationale note")
  .option("--unblock_note <value>", "Alias for --unblock-note")
  .option("--reporter <value>", "Template default issue reporter")
  .option("--severity <value>", "Template default issue severity")
  .option("--environment <value>", "Template default issue environment context")
  .option("--repro-steps <value>", "Template default issue reproduction steps")
  .option("--repro_steps <value>", "Alias for --repro-steps")
  .option("--resolution <value>", "Template default issue resolution summary")
  .option("--expected-result <value>", "Template default issue expected behavior")
  .option("--expected_result <value>", "Alias for --expected-result")
  .option("--actual-result <value>", "Template default issue observed behavior")
  .option("--actual_result <value>", "Alias for --actual-result")
  .option("--affected-version <value>", "Template default affected version identifier")
  .option("--affected_version <value>", "Alias for --affected-version")
  .option("--fixed-version <value>", "Template default fixed version identifier")
  .option("--fixed_version <value>", "Alias for --fixed-version")
  .option("--component <value>", "Template default issue component ownership")
  .option("--regression <value>", "Template default regression marker")
  .option("--customer-impact <value>", "Template default customer impact summary")
  .option("--customer_impact <value>", "Alias for --customer-impact")
  .option(
    "--dep <value>",
    "Template default dependency entry (repeatable; CSV/markdown pairs or - for stdin)",
    collect,
  )
  .option(
    "--type-option <value>",
    "Template default type option entry (repeatable; key=value or markdown pairs; use - for stdin)",
    collect,
  )
  .option("--type_option <value>", "Alias for --type-option", collect)
  .option(
    "--reminder <value>",
    "Template default reminder entry (repeatable; at=<iso|relative>,text=<text>)",
    collect,
  )
  .option(
    "--event <value>",
    "Template default event entry (repeatable; start/end/title/recur_* fields)",
    collect,
  )
  .option(
    "--comment <value>",
    "Template default comment seed entry (repeatable; text=<value> CSV/markdown pairs or - for stdin)",
    collect,
  )
  .option(
    "--note <value>",
    "Template default note seed entry (repeatable; text=<value> CSV/markdown pairs or - for stdin)",
    collect,
  )
  .option(
    "--learning <value>",
    "Template default learning seed entry (repeatable; text=<value> CSV/markdown pairs or - for stdin)",
    collect,
  )
  .option(
    "--file <value>",
    "Template default linked file entry (repeatable; CSV/markdown pairs or - for stdin)",
    collect,
  )
  .option(
    "--test <value>",
    "Template default linked test entry (repeatable; CSV/markdown pairs or - for stdin)",
    collect,
  )
  .option(
    "--doc <value>",
    "Template default linked doc entry (repeatable; CSV/markdown pairs or - for stdin)",
    collect,
  )
  .description("Save or update a named create template.")
  .action(async (name: string, options: Record<string, unknown>, command) => {
    const globalOptions = getGlobalOptions(command);
    const startedAt = Date.now();
    const normalized = normalizeCreateOptions(options, { requireType: false }) as unknown as Record<string, unknown>;
    const result = await runTemplatesSave(name, normalized, globalOptions);
    printResult(result, globalOptions);
    if (globalOptions.profile) {
      printError(`profile:command=templates save took_ms=${Date.now() - startedAt}`);
    }
  });

templatesCommand
  .command("list")
  .description("List saved create templates.")
  .action(async (_options: Record<string, unknown>, command) => {
    const globalOptions = getGlobalOptions(command);
    const startedAt = Date.now();
    const result = await runTemplatesList(globalOptions);
    printResult(result, globalOptions);
    if (globalOptions.profile) {
      printError(`profile:command=templates list took_ms=${Date.now() - startedAt}`);
    }
  });

templatesCommand
  .command("show")
  .argument("<name>", "Template name")
  .description("Show saved create template details.")
  .action(async (name: string, _options: Record<string, unknown>, command) => {
    const globalOptions = getGlobalOptions(command);
    const startedAt = Date.now();
    const result = await runTemplatesShow(name, globalOptions);
    printResult(result, globalOptions);
    if (globalOptions.profile) {
      printError(`profile:command=templates show took_ms=${Date.now() - startedAt}`);
    }
  });

program
  .command("create")
  .description("Create a new project management item.")
  .requiredOption("--title, -t <value>", "Item title")
  .requiredOption("--description, -d <value>", "Item description (allow empty string)")
  .option("--type <value>", "Item type (built-ins plus any configured custom types)")
  .option("--template <value>", "Apply named create template defaults before explicit flags")
  .option("--create-mode <value>", "Create required-option policy mode: strict|progressive")
  .option("--create_mode <value>", "Alias for --create-mode")
  .option("--schedule-preset <value>", "Scheduling preset for Reminder|Meeting|Event: lightweight")
  .option("--schedule_preset <value>", "Alias for --schedule-preset")
  .option("--status, -s <value>", "Item status")
  .option("--priority, -p <value>", "Priority 0..4")
  .option("--tags <value>", "Comma-separated tags")
  .option("--body, -b <value>", "Item markdown body (allow empty string)")
  .option("--deadline <value>", "Deadline (ISO/date string or relative +6h/+1d/+2w/+6m)")
  .option("--estimate, --estimated-minutes <value>", "Estimated minutes")
  .option("--estimated_minutes <value>", "Alias for --estimated-minutes")
  .option("--acceptance-criteria <value>", "Acceptance criteria (allow empty string)")
  .option("--acceptance_criteria <value>", "Alias for --acceptance-criteria")
  .option("--ac <value>", "Alias for --acceptance-criteria")
  .option("--definition-of-ready <value>", "Definition of ready (allow empty string)")
  .option("--definition_of_ready <value>", "Alias for --definition-of-ready")
  .option("--order <value>", "Planning order/rank integer")
  .option("--rank <value>", "Alias for --order")
  .option("--goal <value>", "Goal identifier")
  .option("--objective <value>", "Objective identifier")
  .option("--value <value>", "Business value summary")
  .option("--impact <value>", "Business impact summary")
  .option("--outcome <value>", "Expected outcome summary")
  .option("--why-now <value>", "Why-now rationale")
  .option("--why_now <value>", "Alias for --why-now")
  .option("--author <value>", "Mutation author")
  .option("--message <value>", "History message (allow empty string)")
  .option("--assignee <value>", "Item assignee")
  .option("--parent <value>", "Parent item ID")
  .option("--reviewer <value>", "Reviewer")
  .option("--risk <value>", "Risk level: low|med|medium|high|critical (med persists as medium)")
  .option("--confidence <value>", "Confidence level: 0..100|low|med|medium|high (med persists as medium)")
  .option("--sprint <value>", "Sprint identifier")
  .option("--release <value>", "Release identifier")
  .option("--blocked-by <value>", "Blocked-by item ID or reason")
  .option("--blocked_by <value>", "Alias for --blocked-by")
  .option("--blocked-reason <value>", "Blocked reason")
  .option("--blocked_reason <value>", "Alias for --blocked-reason")
  .option("--unblock-note <value>", "Unblock rationale note")
  .option("--unblock_note <value>", "Alias for --unblock-note")
  .option("--reporter <value>", "Issue reporter")
  .option("--severity <value>", "Issue severity: low|med|medium|high|critical (med persists as medium)")
  .option("--environment <value>", "Issue environment context")
  .option("--repro-steps <value>", "Issue reproduction steps")
  .option("--repro_steps <value>", "Alias for --repro-steps")
  .option("--resolution <value>", "Issue resolution summary")
  .option("--expected-result <value>", "Issue expected behavior")
  .option("--expected_result <value>", "Alias for --expected-result")
  .option("--actual-result <value>", "Issue observed behavior")
  .option("--actual_result <value>", "Alias for --actual-result")
  .option("--affected-version <value>", "Affected version identifier")
  .option("--affected_version <value>", "Alias for --affected-version")
  .option("--fixed-version <value>", "Fixed version identifier")
  .option("--fixed_version <value>", "Alias for --fixed-version")
  .option("--component <value>", "Issue component ownership")
  .option("--regression <value>", "Regression marker: true|false|1|0")
  .option("--customer-impact <value>", "Customer impact summary")
  .option("--customer_impact <value>", "Alias for --customer-impact")
  .option(
    "--dep <value>",
    "Seed dependency entry (key=value CSV, markdown key:value lines, or - for stdin; repeatable)",
    collect,
  )
  .option(
    "--type-option <value>",
    "Type option key=value or key=<name>,value=<value> (also accepts key:value and markdown pairs; use - for stdin; repeatable)",
    collect,
  )
  .option("--type_option <value>", "Alias for --type-option", collect)
  .option("--unset <field>", "Clear scalar metadata field by name (repeatable)", collect)
  .option("--clear-deps", "Clear dependency entries")
  .option("--clear-comments", "Clear comments")
  .option("--clear-notes", "Clear notes")
  .option("--clear-learnings", "Clear learnings")
  .option("--clear-files", "Clear linked files")
  .option("--clear-tests", "Clear linked tests")
  .option("--clear-docs", "Clear linked docs")
  .option("--clear-reminders", "Clear reminders")
  .option("--clear-events", "Clear events")
  .option("--clear-type-options", "Clear type options")
  .option(
    "--reminder <value>",
    "Seed reminder entry at=<iso|relative>,text=<text> (also accepts markdown pairs and - for stdin; repeatable)",
    collect,
  )
  .option(
    "--event <value>",
    "Seed event entry start=<iso|relative>,end=<iso|relative>,title=<text>,all_day=<true|false>,recur_* fields (also accepts markdown pairs and - for stdin; repeatable)",
    collect,
  )
  .option(
    "--comment <value>",
    "Seed comment entry (text=<value> CSV/markdown pairs or - for stdin; repeatable)",
    collect,
  )
  .option(
    "--note <value>",
    "Seed note entry (text=<value> CSV/markdown pairs or - for stdin; repeatable)",
    collect,
  )
  .option(
    "--learning <value>",
    "Seed learning entry (text=<value> CSV/markdown pairs or - for stdin; repeatable)",
    collect,
  )
  .option(
    "--file <value>",
    "Seed linked file entry (CSV/markdown pairs or - for stdin; repeatable)",
    collect,
  )
  .option(
    "--test <value>",
    "Seed linked test entry (CSV/markdown pairs or - for stdin; repeatable)",
    collect,
  )
  .option(
    "--doc <value>",
    "Seed linked doc entry (CSV/markdown pairs or - for stdin; repeatable)",
    collect,
  )
  .action(async (options: Record<string, unknown>, command) => {
    const globalOptions = getGlobalOptions(command);
    const startedAt = Date.now();
    const normalized = normalizeCreateOptions(options, { requireType: false });
    const result = await runCreate(normalized, globalOptions);
    await invalidateSearchCachesForMutation(globalOptions, result);
    printResult(result, globalOptions);
    if (globalOptions.profile) {
      printError(`profile:command=create took_ms=${Date.now() - startedAt}`);
    }
  });

function registerListCommand(name: string, description: string, status?: ItemStatus, excludeTerminal?: boolean): void {
  program
    .command(name)
    .description(description)
    .option("--type <value>", "Filter by item type")
    .option("--tag <value>", "Filter by tag")
    .option("--priority <value>", "Filter by priority")
    .option("--deadline-before <value>", "Filter by deadline upper bound (ISO/date string or relative)")
    .option("--deadline-after <value>", "Filter by deadline lower bound (ISO/date string or relative)")
    .option("--assignee <value>", "Filter by assignee")
    .option("--assignee-filter <value>", "Filter assignee presence: assigned|unassigned")
    .option("--assignee_filter <value>", "Alias for --assignee-filter")
    .option("--parent <value>", "Filter by parent item ID")
    .option("--sprint <value>", "Filter by sprint")
    .option("--release <value>", "Filter by release")
    .option("--limit <n>", "Limit returned item count")
    .option("--offset <n>", "Skip the first n matching rows before limit is applied")
    .option("--include-body", "Include item body in each returned list row")
    .option("--compact", "Render compact list projection fields (mutually exclusive with --fields)")
    .option(
      "--fields <value>",
      "Render custom comma-separated list fields (mutually exclusive with --compact; valid: --fields id,title; invalid: --compact --fields id,title)",
    )
    .option("--sort <value>", "Sort field: priority|deadline|updated_at|created_at|title|parent")
    .option("--order <value>", "Sort order: asc|desc (requires --sort)")
    .option("--stream", "Emit line-delimited JSON rows (requires --json)")
    .action(async (options: Record<string, unknown>, command) => {
      const globalOptions = getGlobalOptions(command);
      const startedAt = Date.now();
      const listOptions = normalizeListOptions(options);
      if (excludeTerminal) listOptions.excludeTerminal = true;
      const result = await runList(status, listOptions, globalOptions);
      const streamMode = options.stream === true;
      if (streamMode && !globalOptions.json) {
        throw new PmCliError("--stream requires --json output mode.", EXIT_CODE.USAGE);
      }
      if (streamMode) {
        printListJsonStream(name, result, globalOptions);
      } else {
        printResult(result, globalOptions);
      }
      if (globalOptions.profile) {
        printError(`profile:command=${name} took_ms=${Date.now() - startedAt}`);
      }
    });
}

registerListCommand("list", "List active items with optional filters.", undefined, true);
registerListCommand("list-all", "List all items with optional filters.");
registerListCommand("list-draft", "List draft items with optional filters.", "draft");
registerListCommand("list-open", "List open items with optional filters.", "open");
registerListCommand("list-in-progress", "List in-progress items with optional filters.", "in_progress");
registerListCommand("list-blocked", "List blocked items with optional filters.", "blocked");
registerListCommand("list-closed", "List closed items with optional filters.", "closed");
registerListCommand("list-canceled", "List canceled items with optional filters.", "canceled");

program
  .command("aggregate")
  .description("Aggregate grouped item counts for governance queries.")
  .option("--group-by <value>", "Comma-separated group-by fields (supported: parent,type)")
  .option("--count", "Return grouped counts (default behavior)")
  .option("--include-unparented", "Include unparented rows when grouping by parent")
  .option("--include_unparented", "Alias for --include-unparented")
  .option("--status <value>", "Filter by item status")
  .option("--type <value>", "Filter by item type")
  .option("--tag <value>", "Filter by tag")
  .option("--priority <value>", "Filter by priority")
  .option("--deadline-before <value>", "Filter by deadline upper bound (ISO/date string or relative)")
  .option("--deadline-after <value>", "Filter by deadline lower bound (ISO/date string or relative)")
  .option("--assignee <value>", "Filter by assignee")
  .option("--assignee-filter <value>", "Filter assignee presence: assigned|unassigned")
  .option("--assignee_filter <value>", "Alias for --assignee-filter")
  .option("--parent <value>", "Filter by parent item ID")
  .option("--sprint <value>", "Filter by sprint")
  .option("--release <value>", "Filter by release")
  .action(async (options: Record<string, unknown>, command) => {
    const globalOptions = getGlobalOptions(command);
    const startedAt = Date.now();
    const result = await runAggregate(normalizeAggregateOptions(options), globalOptions);
    printResult(result, globalOptions);
    if (globalOptions.profile) {
      printError(`profile:command=aggregate took_ms=${Date.now() - startedAt}`);
    }
  });

program
  .command("dedupe-audit")
  .description("Audit potential duplicate items with exact, fuzzy, or parent-scoped matching.")
  .option("--mode <value>", "Dedupe mode: title_exact|title_fuzzy|parent_scope")
  .option("--limit <n>", "Limit returned duplicate clusters")
  .option("--threshold <value>", "Fuzzy mode token similarity threshold between 0 and 1")
  .option("--status <value>", "Filter by item status")
  .option("--type <value>", "Filter by item type")
  .option("--tag <value>", "Filter by tag")
  .option("--priority <value>", "Filter by priority")
  .option("--deadline-before <value>", "Filter by deadline upper bound (ISO/date string or relative)")
  .option("--deadline-after <value>", "Filter by deadline lower bound (ISO/date string or relative)")
  .option("--assignee <value>", "Filter by assignee")
  .option("--assignee-filter <value>", "Filter assignee presence: assigned|unassigned")
  .option("--assignee_filter <value>", "Alias for --assignee-filter")
  .option("--parent <value>", "Filter by parent item ID")
  .option("--sprint <value>", "Filter by sprint")
  .option("--release <value>", "Filter by release")
  .action(async (options: Record<string, unknown>, command) => {
    const globalOptions = getGlobalOptions(command);
    const startedAt = Date.now();
    const result = await runDedupeAudit(normalizeDedupeAuditOptions(options), globalOptions);
    printResult(result, globalOptions);
    if (globalOptions.profile) {
      printError(`profile:command=dedupe-audit took_ms=${Date.now() - startedAt}`);
    }
  });

function registerCalendarCommand(): void {
  program
    .command("calendar")
    .alias("cal")
    .description("Show deadline/reminder calendar views (agenda/day/week/month).")
    .option("--view <value>", "Calendar view: agenda|day|week|month (default: agenda)")
    .option("--date <value>", "Anchor date/time for view calculations (ISO/date string or relative)")
    .option("--from <value>", "Agenda lower bound (ISO/date string or relative)")
    .option("--to <value>", "Agenda upper bound (ISO/date string or relative)")
    .option("--past", "Include past entries in the selected view")
    .option("--full-period", "For day/week/month views, include the full anchored period without now-clipping")
    .option("--full_period", "Alias for --full-period")
    .option("--type <value>", "Filter by item type")
    .option("--tag <value>", "Filter by tag")
    .option("--priority <value>", "Filter by priority")
    .option("--status <value>", "Filter by status")
    .option("--assignee <value>", "Filter by assignee")
    .option("--assignee-filter <value>", "Filter assignee presence: assigned|unassigned")
    .option("--assignee_filter <value>", "Alias for --assignee-filter")
    .option("--sprint <value>", "Filter by sprint")
    .option("--release <value>", "Filter by release")
    .option("--include <value>", "Include sources: deadlines|reminders|events|all (comma or | separated)")
    .option("--recurrence-lookahead-days <n>", "Bound open-ended recurrence generation lookahead days")
    .option("--recurrence_lookahead_days <n>", "Alias for --recurrence-lookahead-days")
    .option("--recurrence-lookback-days <n>", "Bound open-ended recurrence generation lookback days")
    .option("--recurrence_lookback_days <n>", "Alias for --recurrence-lookback-days")
    .option("--occurrence-limit <n>", "Cap generated occurrences per recurring event")
    .option("--occurrence_limit <n>", "Alias for --occurrence-limit")
    .option("--limit <n>", "Limit returned event count")
    .option("--format <value>", "Calendar output format override: markdown|toon|json")
    .action(async (options: Record<string, unknown>, actionCommand) => {
      const globalOptions = getGlobalOptions(actionCommand);
      const startedAt = Date.now();
      const normalized = normalizeCalendarOptions(options);
      const result = await runCalendar(normalized, globalOptions);
      const outputFormat = resolveCalendarOutputFormat(normalized, globalOptions);
      if (outputFormat === "markdown") {
        if (!globalOptions.quiet) {
          writeStdout(`${renderCalendarMarkdown(result)}\n`);
        }
      } else {
        printResult(result, {
          ...globalOptions,
          json: outputFormat === "json",
        });
      }
      if (globalOptions.profile) {
        printError(`profile:command=calendar took_ms=${Date.now() - startedAt}`);
      }
    });
}

registerCalendarCommand();

function registerContextCommand(): void {
  program
    .command("context")
    .alias("ctx")
    .description("Show a token-efficient project context snapshot for next-work decisions.")
    .option("--date <value>", "Anchor date/time for agenda window calculations (ISO/date string or relative)")
    .option("--from <value>", "Agenda lower bound (ISO/date string or relative)")
    .option("--to <value>", "Agenda upper bound (ISO/date string or relative)")
    .option("--past", "Include past agenda entries in bounded windows")
    .option("--type <value>", "Filter by item type")
    .option("--tag <value>", "Filter by tag")
    .option("--priority <value>", "Filter by priority")
    .option("--assignee <value>", "Filter by assignee")
    .option("--assignee-filter <value>", "Filter assignee presence: assigned|unassigned")
    .option("--assignee_filter <value>", "Alias for --assignee-filter")
    .option("--sprint <value>", "Filter by sprint")
    .option("--release <value>", "Filter by release")
    .option("--limit <n>", "Limit focus and agenda rows per section")
    .option("--format <value>", "Context output format override: markdown|toon|json")
    .action(async (options: Record<string, unknown>, actionCommand) => {
      const globalOptions = getGlobalOptions(actionCommand);
      const startedAt = Date.now();
      const normalized = normalizeContextOptions(options);
      const result = await runContext(normalized, globalOptions);
      const outputFormat = resolveContextOutputFormat(normalized, globalOptions);
      if (outputFormat === "markdown") {
        if (!globalOptions.quiet) {
          writeStdout(`${renderContextMarkdown(result)}\n`);
        }
      } else {
        printResult(result, {
          ...globalOptions,
          json: outputFormat === "json",
        });
      }
      if (globalOptions.profile) {
        printError(`profile:command=context took_ms=${Date.now() - startedAt}`);
      }
    });
}

registerContextCommand();

program
  .command("search")
  .argument("<keywords...>", "Keyword query tokens")
  .description("Search items with keyword, semantic, or hybrid modes.")
  .option(
    "--mode <value>",
    "Search mode: keyword|semantic|hybrid (default: hybrid when semantic config or local Ollama auto-defaults are available, else keyword)",
  )
  .option("--include-linked", "Include readable linked docs/files/tests content in keyword and hybrid lexical scoring")
  .option("--title-exact", "Require exact normalized title match against the full query")
  .option("--phrase-exact", "Require exact normalized query phrase match in item text fields")
  .option("--type <value>", "Filter by item type")
  .option("--tag <value>", "Filter by tag")
  .option("--priority <value>", "Filter by priority")
  .option("--deadline-before <value>", "Filter by deadline upper bound (ISO/date string or relative)")
  .option("--deadline-after <value>", "Filter by deadline lower bound (ISO/date string or relative)")
  .option("--compact", "Render compact search hits (default; mutually exclusive with --full/--fields)")
  .option("--full", "Render full search hits with nested item payloads (mutually exclusive with --compact/--fields)")
  .option(
    "--fields <value>",
    "Render custom comma-separated search hit fields (mutually exclusive with --compact/--full; valid: --fields id,title,score; invalid: --full --fields id,title)",
  )
  .option("--limit <n>", "Limit returned item count")
  .action(async (keywords: string[], options: Record<string, unknown>, command) => {
    const globalOptions = getGlobalOptions(command);
    const startedAt = Date.now();
    const result = await runSearch(normalizeSearchKeywordsInput(keywords), normalizeSearchOptions(options), globalOptions);
    printResult(result, globalOptions);
    if (globalOptions.profile) {
      printError(`profile:command=search took_ms=${Date.now() - startedAt}`);
    }
  });

program
  .command("reindex")
  .description("Rebuild search artifacts for keyword, semantic, and hybrid modes.")
  .option("--mode <value>", "Reindex mode: keyword|semantic|hybrid", "keyword")
  .option("--progress", "Emit progress updates to stderr (always shown in TTY, opt-in for non-TTY)")
  .action(async (options: Record<string, unknown>, command) => {
    const globalOptions = getGlobalOptions(command);
    const startedAt = Date.now();
    const result = await runReindex(
      {
        mode: typeof options.mode === "string" ? options.mode : undefined,
        progress: Boolean(options.progress),
      },
      globalOptions,
    );
    printResult(result, globalOptions);
    if (globalOptions.profile) {
      printError(`profile:command=reindex took_ms=${Date.now() - startedAt}`);
    }
  });

program
  .command("get")
  .argument("<id>", "Item id")
  .description("Show item details by ID.")
  .action(async (id: string, _options, command) => {
    const globalOptions = getGlobalOptions(command);
    const startedAt = Date.now();
    const result = await runGet(id, globalOptions);
    printResult(result, globalOptions);
    if (globalOptions.profile) {
      printError(`profile:command=get took_ms=${Date.now() - startedAt}`);
    }
  });

program
  .command("history")
  .argument("<id>", "Item id")
  .option("--limit <n>", "Return only the latest n history entries")
  .option("--diff", "Include per-entry changed field summaries from history patches")
  .option("--verify", "Verify hash chain and replay integrity for the full history stream")
  .description("Show item history entries.")
  .action(async (id: string, options: Record<string, unknown>, command) => {
    const globalOptions = getGlobalOptions(command);
    const startedAt = Date.now();
    const result = await runHistory(
      id,
      {
        limit: typeof options.limit === "string" ? options.limit : undefined,
        diff: Boolean(options.diff),
        verify: Boolean(options.verify),
      },
      globalOptions,
    );
    printResult(result, globalOptions);
    if (globalOptions.profile) {
      printError(`profile:command=history took_ms=${Date.now() - startedAt}`);
    }
  });

program
  .command("activity")
  .option("--id <value>", "Filter by item ID")
  .option("--op <value>", "Filter by history operation")
  .option("--author <value>", "Filter by history author")
  .option("--from <value>", "Lower timestamp bound (ISO/date string or relative)")
  .option("--to <value>", "Upper timestamp bound (ISO/date string or relative)")
  .option("--limit <n>", "Return only the latest n activity entries")
  .option("--stream [mode]", "Emit line-delimited JSON rows (requires --json). Optional mode: rows|ndjson|jsonl")
  .description("Show recent activity across items.")
  .action(async (options: Record<string, unknown>, command) => {
    const globalOptions = getGlobalOptions(command);
    const startedAt = Date.now();
    const normalized = normalizeActivityOptions(options);
    const result = await runActivity(normalized, globalOptions);
    const streamMode = resolveActivityStreamMode(options.stream);
    if (streamMode && !globalOptions.json) {
      throw new PmCliError("--stream requires --json output mode.", EXIT_CODE.USAGE);
    }
    if (streamMode) {
      printActivityJsonStream(result, normalized, globalOptions);
    } else {
      printResult(result, globalOptions);
    }
    if (globalOptions.profile) {
      printError(`profile:command=activity took_ms=${Date.now() - startedAt}`);
    }
  });

program
  .command("restore")
  .argument("<id>", "Item id")
  .argument("<target>", "Restore target timestamp or version number")
  .option("--author <value>", "Mutation author")
  .option("--message <value>", "History message")
  .option("--force", "Force ownership/lock override")
  .description("Restore an item to an earlier timestamp or version.")
  .action(async (id: string, target: string, options: Record<string, unknown>, command) => {
    const globalOptions = getGlobalOptions(command);
    const startedAt = Date.now();
    const result = await runRestore(
      id,
      target,
      {
        author: typeof options.author === "string" ? options.author : undefined,
        message: typeof options.message === "string" ? options.message : undefined,
        force: Boolean(options.force),
      },
      globalOptions,
    );
    await invalidateSearchCachesForMutation(globalOptions, result);
    printResult(result, globalOptions);
    if (globalOptions.profile) {
      printError(`profile:command=restore took_ms=${Date.now() - startedAt}`);
    }
  });

program
  .command("update")
  .argument("<id>", "Item id")
  .description("Update item fields and metadata.")
  .option("--title, -t <value>", "Set title")
  .option("--description, -d <value>", "Set description")
  .option("--body, -b <value>", "Set body (allow empty string)")
  .option("--status, -s <value>", "Set status (use close command for closed)")
  .option("--close-reason <value>", "Set close reason")
  .option("--close_reason <value>", "Alias for --close-reason")
  .option("--priority, -p <value>", "Set priority")
  .option("--type <value>", "Set type")
  .option("--tags <value>", "Set comma-separated tags")
  .option("--deadline <value>", "Set deadline (ISO/date string or relative)")
  .option("--estimate, --estimated-minutes <value>", "Set estimated minutes")
  .option("--estimated_minutes <value>", "Alias for --estimated-minutes")
  .option("--acceptance-criteria <value>", "Set acceptance criteria")
  .option("--acceptance_criteria <value>", "Alias for --acceptance-criteria")
  .option("--ac <value>", "Alias for --acceptance-criteria")
  .option("--definition-of-ready <value>", "Set definition of ready")
  .option("--definition_of_ready <value>", "Alias for --definition-of-ready")
  .option("--order <value>", "Set planning order/rank integer")
  .option("--rank <value>", "Alias for --order")
  .option("--goal <value>", "Set goal identifier")
  .option("--objective <value>", "Set objective identifier")
  .option("--value <value>", "Set business value summary")
  .option("--impact <value>", "Set business impact summary")
  .option("--outcome <value>", "Set expected outcome summary")
  .option("--why-now <value>", "Set why-now rationale")
  .option("--why_now <value>", "Alias for --why-now")
  .option("--author <value>", "Mutation author")
  .option("--message <value>", "Mutation message")
  .option("--assignee <value>", "Set assignee")
  .option("--parent <value>", "Set parent item ID")
  .option("--reviewer <value>", "Set reviewer")
  .option("--risk <value>", "Set risk level: low|med|medium|high|critical (med persists as medium)")
  .option("--confidence <value>", "Set confidence level: 0..100|low|med|medium|high (med persists as medium)")
  .option("--sprint <value>", "Set sprint identifier")
  .option("--release <value>", "Set release identifier")
  .option("--blocked-by <value>", "Set blocked-by item ID or reason")
  .option("--blocked_by <value>", "Alias for --blocked-by")
  .option("--blocked-reason <value>", "Set blocked reason")
  .option("--blocked_reason <value>", "Alias for --blocked-reason")
  .option("--unblock-note <value>", "Set unblock rationale note")
  .option("--unblock_note <value>", "Alias for --unblock-note")
  .option("--reporter <value>", "Set issue reporter")
  .option("--severity <value>", "Set issue severity: low|med|medium|high|critical (med persists as medium)")
  .option("--environment <value>", "Set issue environment context")
  .option("--repro-steps <value>", "Set issue reproduction steps")
  .option("--repro_steps <value>", "Alias for --repro-steps")
  .option("--resolution <value>", "Set issue resolution summary")
  .option("--expected-result <value>", "Set issue expected behavior")
  .option("--expected_result <value>", "Alias for --expected-result")
  .option("--actual-result <value>", "Set issue observed behavior")
  .option("--actual_result <value>", "Alias for --actual-result")
  .option("--affected-version <value>", "Set affected version identifier")
  .option("--affected_version <value>", "Alias for --affected-version")
  .option("--fixed-version <value>", "Set fixed version identifier")
  .option("--fixed_version <value>", "Alias for --fixed-version")
  .option("--component <value>", "Set issue component ownership")
  .option("--regression <value>", "Set regression marker: true|false|1|0")
  .option("--customer-impact <value>", "Set customer impact summary")
  .option("--customer_impact <value>", "Alias for --customer-impact")
  .option(
    "--dep <value>",
    "Add dependency entries id=<id>,kind=<value>,author=<value>,created_at=<iso|now>,source_kind=<value> (repeatable)",
    collect,
  )
  .option(
    "--dep-remove <value>",
    "Remove dependencies by id or id=<id>,kind=<value>,source_kind=<value> selectors (repeatable)",
    collect,
  )
  .option("--dep_remove <value>", "Alias for --dep-remove", collect)
  .option("--replace-deps", "Atomically replace dependency entries with the provided --dep values")
  .option("--replace-tests", "Atomically replace linked test entries with the provided --test values")
  .option(
    "--comment <value>",
    "Append comment seed author=<value>,created_at=<iso|now>,text=<value> (also accepts markdown pairs and - for stdin; repeatable)",
    collect,
  )
  .option(
    "--note <value>",
    "Append note seed author=<value>,created_at=<iso|now>,text=<value> (also accepts markdown pairs and - for stdin; repeatable)",
    collect,
  )
  .option(
    "--learning <value>",
    "Append learning seed author=<value>,created_at=<iso|now>,text=<value> (also accepts markdown pairs and - for stdin; repeatable)",
    collect,
  )
  .option(
    "--file <value>",
    "Append linked file path=<value>,scope=<project|global>,note=<text> (also accepts markdown pairs and - for stdin; repeatable)",
    collect,
  )
  .option(
    "--test <value>",
    "Append linked test command=<value>,path=<value>,scope=<project|global>,timeout_seconds=<n>,pm_context_mode=<schema|tracker|auto> (also accepts markdown pairs and - for stdin; repeatable)",
    collect,
  )
  .option(
    "--doc <value>",
    "Append linked doc path=<value>,scope=<project|global>,note=<text> (also accepts markdown pairs and - for stdin; repeatable)",
    collect,
  )
  .option(
    "--reminder <value>",
    "Set reminders at=<iso|relative>,text=<text> (also accepts markdown pairs and - for stdin; repeatable)",
    collect,
  )
  .option(
    "--event <value>",
    "Set events start=<iso|relative>,end=<iso|relative>,title=<text>,all_day=<true|false>,recur_* fields (also accepts markdown pairs and - for stdin; repeatable)",
    collect,
  )
  .option(
    "--type-option <value>",
    "Set type options key=value or key=<name>,value=<value> (also accepts key:value and markdown pairs; use - for stdin; repeatable)",
    collect,
  )
  .option("--type_option <value>", "Alias for --type-option", collect)
  .option("--unset <field>", "Clear scalar metadata field by name (repeatable)", collect)
  .option("--clear-deps", "Clear dependency entries")
  .option("--clear-comments", "Clear comments")
  .option("--clear-notes", "Clear notes")
  .option("--clear-learnings", "Clear learnings")
  .option("--clear-files", "Clear linked files")
  .option("--clear-tests", "Clear linked tests")
  .option("--clear-docs", "Clear linked docs")
  .option("--clear-reminders", "Clear reminders")
  .option("--clear-events", "Clear events")
  .option("--clear-type-options", "Clear type options")
  .option("--allow-audit-update", "Allow non-owner metadata-only audit updates without requiring --force")
  .option("--allow_audit_update", "Alias for --allow-audit-update")
  .option("--allow-audit-dep-update", "Allow non-owner append-only dependency updates without requiring --force")
  .option("--allow_audit_dep_update", "Alias for --allow-audit-dep-update")
  .option("--force", "Force ownership override")
  .action(async (id: string, options: Record<string, unknown>, command) => {
    const globalOptions = getGlobalOptions(command);
    const startedAt = Date.now();
    const result = await runUpdate(id, normalizeUpdateOptions(options), globalOptions);
    await invalidateSearchCachesForMutation(globalOptions, result);
    printResult(result, globalOptions);
    if (globalOptions.profile) {
      printError(`profile:command=update took_ms=${Date.now() - startedAt}`);
    }
  });

program
  .command("update-many")
  .description("Bulk-update matched items with dry-run plans and rollback checkpoints.")
  .option("--filter-status <value>", "Filter by status before applying updates")
  .option("--filter-type <value>", "Filter by item type before applying updates")
  .option("--filter-tag <value>", "Filter by tag before applying updates")
  .option("--filter-priority <value>", "Filter by priority before applying updates")
  .option("--filter-deadline-before <value>", "Filter by deadline upper bound before applying updates")
  .option("--filter-deadline-after <value>", "Filter by deadline lower bound before applying updates")
  .option("--filter-assignee <value>", "Filter by assignee before applying updates")
  .option("--filter-assignee-filter <value>", "Filter assignee presence: assigned|unassigned before applying updates")
  .option("--filter-assignee_filter <value>", "Alias for --filter-assignee-filter")
  .option("--filter-parent <value>", "Filter by parent item ID before applying updates")
  .option("--filter-sprint <value>", "Filter by sprint before applying updates")
  .option("--filter-release <value>", "Filter by release before applying updates")
  .option("--limit <n>", "Limit matched item count before apply/preview")
  .option("--offset <n>", "Skip first n matched rows before apply/preview")
  .option("--dry-run", "Preview per-item diffs and checkpoint intent without mutating")
  .option("--rollback <value>", "Rollback a prior update-many checkpoint ID")
  .option("--no-checkpoint", "Disable checkpoint creation during apply mode")
  .option("--title, -t <value>", "Set title")
  .option("--description, -d <value>", "Set description")
  .option("--body, -b <value>", "Set body (allow empty string)")
  .option("--status, -s <value>", "Set status (use close command for closed)")
  .option("--priority, -p <value>", "Set priority")
  .option("--type <value>", "Set type")
  .option("--tags <value>", "Set comma-separated tags")
  .option("--deadline <value>", "Set deadline (ISO/date string or relative)")
  .option("--estimate, --estimated-minutes <value>", "Set estimated minutes")
  .option("--estimated_minutes <value>", "Alias for --estimated-minutes")
  .option("--acceptance-criteria <value>", "Set acceptance criteria")
  .option("--acceptance_criteria <value>", "Alias for --acceptance-criteria")
  .option("--ac <value>", "Alias for --acceptance-criteria")
  .option("--definition-of-ready <value>", "Set definition of ready")
  .option("--definition_of_ready <value>", "Alias for --definition-of-ready")
  .option("--order <value>", "Set planning order/rank integer")
  .option("--rank <value>", "Alias for --order")
  .option("--goal <value>", "Set goal identifier")
  .option("--objective <value>", "Set objective identifier")
  .option("--value <value>", "Set business value summary")
  .option("--impact <value>", "Set business impact summary")
  .option("--outcome <value>", "Set expected outcome summary")
  .option("--why-now <value>", "Set why-now rationale")
  .option("--why_now <value>", "Alias for --why-now")
  .option("--reviewer <value>", "Set reviewer")
  .option("--risk <value>", "Set risk level")
  .option("--confidence <value>", "Set confidence level")
  .option("--sprint <value>", "Set sprint identifier")
  .option("--release <value>", "Set release identifier")
  .option("--reporter <value>", "Set issue reporter")
  .option("--severity <value>", "Set issue severity")
  .option("--environment <value>", "Set issue environment context")
  .option("--repro-steps <value>", "Set issue reproduction steps")
  .option("--repro_steps <value>", "Alias for --repro-steps")
  .option("--resolution <value>", "Set issue resolution summary")
  .option("--expected-result <value>", "Set issue expected behavior")
  .option("--expected_result <value>", "Alias for --expected-result")
  .option("--actual-result <value>", "Set issue observed behavior")
  .option("--actual_result <value>", "Alias for --actual-result")
  .option("--affected-version <value>", "Set affected version identifier")
  .option("--affected_version <value>", "Alias for --affected-version")
  .option("--fixed-version <value>", "Set fixed version identifier")
  .option("--fixed_version <value>", "Alias for --fixed-version")
  .option("--component <value>", "Set issue component ownership")
  .option("--regression <value>", "Set regression marker: true|false|1|0")
  .option("--customer-impact <value>", "Set customer impact summary")
  .option("--customer_impact <value>", "Alias for --customer-impact")
  .option("--dep <value>", "Add dependency entry id=<id>,kind=<kind>,author=<author>,created_at=<timestamp>", collect)
  .option("--dep-remove <value>", "Remove dependency entries by id/kind/author/timestamp signature", collect)
  .option("--dep_remove <value>", "Alias for --dep-remove", collect)
  .option("--replace-deps", "Atomically replace dependency entries with provided --dep values")
  .option("--replace-tests", "Atomically replace linked tests with provided --test values")
  .option("--comment <value>", "Add comment seed author=<value>,created_at=<iso|now>,text=<value>", collect)
  .option("--note <value>", "Add note seed author=<value>,created_at=<iso|now>,text=<value>", collect)
  .option("--learning <value>", "Add learning seed author=<value>,created_at=<iso|now>,text=<value>", collect)
  .option("--file <value>", "Add linked file path=<value>,scope=<project|global>,note=<text>", collect)
  .option("--test <value>", "Add linked test command=<value>,path=<value>,scope=<project|global>", collect)
  .option("--doc <value>", "Add linked doc path=<value>,scope=<project|global>,note=<text>", collect)
  .option("--reminder <value>", "Add reminder entry at=<iso|relative>,text=<text>", collect)
  .option("--event <value>", "Add event entry start=<iso|relative>,end=<iso|relative>,recur_*", collect)
  .option("--type-option <value>", "Set type options key=value (repeatable)", collect)
  .option("--type_option <value>", "Alias for --type-option", collect)
  .option("--unset <field>", "Clear scalar metadata field by name (repeatable)", collect)
  .option("--clear-deps", "Clear dependency entries")
  .option("--clear-comments", "Clear comments")
  .option("--clear-notes", "Clear notes")
  .option("--clear-learnings", "Clear learnings")
  .option("--clear-files", "Clear linked files")
  .option("--clear-tests", "Clear linked tests")
  .option("--clear-docs", "Clear linked docs")
  .option("--clear-reminders", "Clear reminders")
  .option("--clear-events", "Clear events")
  .option("--clear-type-options", "Clear type options")
  .option("--allow-audit-update", "Allow non-owner metadata-only audit updates without requiring --force")
  .option("--allow_audit_update", "Alias for --allow-audit-update")
  .option("--allow-audit-dep-update", "Allow non-owner append-only dependency updates without requiring --force")
  .option("--allow_audit_dep_update", "Alias for --allow-audit-dep-update")
  .option("--author <value>", "Mutation author")
  .option("--message <value>", "Mutation message")
  .option("--force", "Force ownership override")
  .action(async (options: Record<string, unknown>, command) => {
    const globalOptions = getGlobalOptions(command);
    const startedAt = Date.now();
    const result = await runUpdateMany(
      {
        status: typeof options.filterStatus === "string" ? options.filterStatus : undefined,
        list: {
          type: typeof options.filterType === "string" ? options.filterType : undefined,
          tag: typeof options.filterTag === "string" ? options.filterTag : undefined,
          priority: typeof options.filterPriority === "string" ? options.filterPriority : undefined,
          deadlineBefore: typeof options.filterDeadlineBefore === "string" ? options.filterDeadlineBefore : undefined,
          deadlineAfter: typeof options.filterDeadlineAfter === "string" ? options.filterDeadlineAfter : undefined,
          assignee: typeof options.filterAssignee === "string" ? options.filterAssignee : undefined,
          assigneeFilter:
            typeof options.filterAssigneeFilter === "string"
              ? options.filterAssigneeFilter
              : typeof options.filterAssignee_filter === "string"
                ? options.filterAssignee_filter
                : undefined,
          parent: typeof options.filterParent === "string" ? options.filterParent : undefined,
          sprint: typeof options.filterSprint === "string" ? options.filterSprint : undefined,
          release: typeof options.filterRelease === "string" ? options.filterRelease : undefined,
          limit: typeof options.limit === "string" ? options.limit : undefined,
          offset: typeof options.offset === "string" ? options.offset : undefined,
          includeBody: true,
        },
        update: normalizeUpdateOptions(extractUpdateManyMutationOptionSource(options)),
        dryRun: options.dryRun === true ? true : undefined,
        rollback: typeof options.rollback === "string" ? options.rollback : undefined,
        checkpoint: options.checkpoint === false ? false : undefined,
      },
      globalOptions,
    );
    await invalidateSearchCachesForMutation(globalOptions, result);
    printResult(result, globalOptions);
    if (globalOptions.profile) {
      printError(`profile:command=update-many took_ms=${Date.now() - startedAt}`);
    }
  });

program
  .command("close")
  .argument("<id>", "Item id")
  .argument("<text>", "Close reason text")
  .option("--author <value>", "Mutation author")
  .option("--message <value>", "History message")
  .option("--validate-close [mode]", 'Validate closure metadata before close: "warn" or "strict" (default: warn)')
  .option("--force", "Force ownership override")
  .description("Close an item with a required reason.")
  .action(async (id: string, text: string, options: Record<string, unknown>, command) => {
    const globalOptions = getGlobalOptions(command);
    const startedAt = Date.now();
    const result = await runClose(
      id,
      text,
      {
        author: typeof options.author === "string" ? options.author : undefined,
        message: typeof options.message === "string" ? options.message : undefined,
        validateClose:
          options.validateClose === true
            ? "warn"
            : typeof options.validateClose === "string"
              ? options.validateClose
              : undefined,
        force: Boolean(options.force),
      },
      globalOptions,
    );
    await invalidateSearchCachesForMutation(globalOptions, result);
    printResult(result, globalOptions);
    if (globalOptions.profile) {
      printError(`profile:command=close took_ms=${Date.now() - startedAt}`);
    }
  });

program
  .command("delete")
  .argument("<id>", "Item id")
  .option("--author <value>", "Mutation author")
  .option("--message <value>", "History message")
  .option("--force", "Force ownership override")
  .description("Delete an item and record the change in history.")
  .action(async (id: string, options: Record<string, unknown>, command) => {
    const globalOptions = getGlobalOptions(command);
    const startedAt = Date.now();
    const result = await runDelete(
      id,
      {
        author: typeof options.author === "string" ? options.author : undefined,
        message: typeof options.message === "string" ? options.message : undefined,
        force: Boolean(options.force),
      },
      globalOptions,
    );
    await invalidateSearchCachesForMutation(globalOptions, result);
    printResult(result, globalOptions);
    if (globalOptions.profile) {
      printError(`profile:command=delete took_ms=${Date.now() - startedAt}`);
    }
  });

program
  .command("append")
  .argument("<id>", "Item id")
  .requiredOption("--body <value>", "Text to append to body (or - for stdin)")
  .option("--author <value>", "Mutation author")
  .option("--message <value>", "Mutation message")
  .option("--force", "Force ownership override")
  .description("Append text to an item's body.")
  .action(async (id: string, options: Record<string, unknown>, command) => {
    const globalOptions = getGlobalOptions(command);
    const startedAt = Date.now();
    const result = await runAppend(
      id,
      {
        body: typeof options.body === "string" ? options.body : "",
        author: typeof options.author === "string" ? options.author : undefined,
        message: typeof options.message === "string" ? options.message : undefined,
        force: Boolean(options.force),
      },
      globalOptions,
    );
    await invalidateSearchCachesForMutation(globalOptions, result);
    printResult(result, globalOptions);
    if (globalOptions.profile) {
      printError(`profile:command=append took_ms=${Date.now() - startedAt}`);
    }
  });

program
  .command("comments")
  .argument("<id>", "Item id")
  .argument("[text]", "Optional comment text shorthand (equivalent to --add; use - for stdin)")
  .option("--add <text>", "Add one comment entry (plain text, text=<value>, markdown pairs, or - for stdin)")
  .option("--limit <n>", "Return only latest n comments")
  .option("--author [value]", "Comment author (optional; falls back to PM_AUTHOR/settings)")
  .option("--message <value>", "History message")
  .option("--allow-audit-comment", "Allow non-owner append-only comment audits without requiring --force")
  .option("--force", "Force ownership override")
  .description("List or add comments for an item.")
  .action(async (id: string, text: string | undefined, options: Record<string, unknown>, command) => {
    const globalOptions = getGlobalOptions(command);
    const startedAt = Date.now();
    const addFromOption = typeof options.add === "string" ? options.add : undefined;
    const addFromPositional = typeof text === "string" ? text : undefined;
    if (addFromOption !== undefined && addFromPositional !== undefined) {
      throw new PmCliError("Specify comment text either as positional [text] or with --add, not both", EXIT_CODE.USAGE);
    }
    const add = addFromOption ?? addFromPositional;
    const result = await runComments(
      id,
      {
        add,
        limit: typeof options.limit === "string" ? options.limit : undefined,
        author: typeof options.author === "string" ? options.author : undefined,
        message: typeof options.message === "string" ? options.message : undefined,
        allowAuditComment: Boolean(options.allowAuditComment),
        force: Boolean(options.force),
      },
      globalOptions,
    );
    if (typeof add === "string") {
      await invalidateSearchCachesForMutation(globalOptions, result);
    }
    printResult(result, globalOptions);
    if (globalOptions.profile) {
      printError(`profile:command=comments took_ms=${Date.now() - startedAt}`);
    }
  });

program
  .command("comments-audit")
  .option("--status <value>", "Filter by item status")
  .option("--type <value>", "Filter by item type")
  .option("--tag <value>", "Filter by tag")
  .option("--priority <value>", "Filter by priority")
  .option("--parent <value>", "Filter by parent item ID")
  .option("--sprint <value>", "Filter by sprint")
  .option("--release <value>", "Filter by release")
  .option("--assignee <value>", "Filter by assignee")
  .option("--assignee-filter <value>", "Filter assignee presence: assigned|unassigned")
  .option("--assignee_filter <value>", "Alias for --assignee-filter")
  .option("--limit-items <n>", "Limit returned item count")
  .option("--limit <n>", "Alias for --limit-items")
  .option("--full-history", "Export full comment history rows (cannot be combined with --latest)")
  .option("--latest <n>", "Return latest n comments per item (default: 1, use 0 for summary-only rows)")
  .description("Audit latest comments or full comment history across filtered items.")
  .action(async (options: Record<string, unknown>, command) => {
    const globalOptions = getGlobalOptions(command);
    const startedAt = Date.now();
    const result = await runCommentsAudit(
      {
        status: typeof options.status === "string" ? options.status : undefined,
        type: typeof options.type === "string" ? options.type : undefined,
        tag: typeof options.tag === "string" ? options.tag : undefined,
        priority: typeof options.priority === "string" ? options.priority : undefined,
        parent: typeof options.parent === "string" ? options.parent : undefined,
        sprint: typeof options.sprint === "string" ? options.sprint : undefined,
        release: typeof options.release === "string" ? options.release : undefined,
        assignee: typeof options.assignee === "string" ? options.assignee : undefined,
        assigneeFilter: typeof options.assigneeFilter === "string" ? options.assigneeFilter : undefined,
        limit: typeof options.limit === "string" ? options.limit : undefined,
        limitItems: typeof options.limitItems === "string" ? options.limitItems : undefined,
        fullHistory: options.fullHistory === true,
        latest: typeof options.latest === "string" ? options.latest : undefined,
      },
      globalOptions,
    );
    printResult(result, globalOptions);
    if (globalOptions.profile) {
      printError(`profile:command=comments-audit took_ms=${Date.now() - startedAt}`);
    }
  });

program
  .command("notes")
  .argument("<id>", "Item id")
  .argument("[text]", "Optional note text shorthand (equivalent to --add; use - for stdin)")
  .option("--add <text>", "Add one note entry (plain text, text=<value>, markdown pairs, or - for stdin)")
  .option("--limit <n>", "Return only latest n notes")
  .option("--author [value]", "Note author (optional; falls back to PM_AUTHOR/settings)")
  .option("--message <value>", "History message")
  .option("--allow-audit-note", "Allow non-owner append-only note audits without requiring --force")
  .option("--allow-audit-comment", "Backward-compatible alias for --allow-audit-note")
  .option("--force", "Force ownership override")
  .description("List or add notes for an item.")
  .action(async (id: string, text: string | undefined, options: Record<string, unknown>, command) => {
    const globalOptions = getGlobalOptions(command);
    const startedAt = Date.now();
    const addFromOption = typeof options.add === "string" ? options.add : undefined;
    const addFromPositional = typeof text === "string" ? text : undefined;
    if (addFromOption !== undefined && addFromPositional !== undefined) {
      throw new PmCliError("Specify note text either as positional [text] or with --add, not both", EXIT_CODE.USAGE);
    }
    const add = addFromOption ?? addFromPositional;
    const result = await runNotes(
      id,
      {
        add,
        limit: typeof options.limit === "string" ? options.limit : undefined,
        author: typeof options.author === "string" ? options.author : undefined,
        message: typeof options.message === "string" ? options.message : undefined,
        allowAuditComment: Boolean(options.allowAuditNote || options.allowAuditComment),
        force: Boolean(options.force),
      },
      globalOptions,
    );
    if (typeof add === "string") {
      await invalidateSearchCachesForMutation(globalOptions, result);
    }
    printResult(result, globalOptions);
    if (globalOptions.profile) {
      printError(`profile:command=notes took_ms=${Date.now() - startedAt}`);
    }
  });

program
  .command("learnings")
  .argument("<id>", "Item id")
  .argument("[text]", "Optional learning text shorthand (equivalent to --add; use - for stdin)")
  .option("--add <text>", "Add one learning entry (plain text, text=<value>, markdown pairs, or - for stdin)")
  .option("--limit <n>", "Return only latest n learnings")
  .option("--author [value]", "Learning author (optional; falls back to PM_AUTHOR/settings)")
  .option("--message <value>", "History message")
  .option("--allow-audit-learning", "Allow non-owner append-only learning audits without requiring --force")
  .option("--allow-audit-comment", "Backward-compatible alias for --allow-audit-learning")
  .option("--force", "Force ownership override")
  .description("List or add learnings for an item.")
  .action(async (id: string, text: string | undefined, options: Record<string, unknown>, command) => {
    const globalOptions = getGlobalOptions(command);
    const startedAt = Date.now();
    const addFromOption = typeof options.add === "string" ? options.add : undefined;
    const addFromPositional = typeof text === "string" ? text : undefined;
    if (addFromOption !== undefined && addFromPositional !== undefined) {
      throw new PmCliError("Specify learning text either as positional [text] or with --add, not both", EXIT_CODE.USAGE);
    }
    const add = addFromOption ?? addFromPositional;
    const result = await runLearnings(
      id,
      {
        add,
        limit: typeof options.limit === "string" ? options.limit : undefined,
        author: typeof options.author === "string" ? options.author : undefined,
        message: typeof options.message === "string" ? options.message : undefined,
        allowAuditComment: Boolean(options.allowAuditLearning || options.allowAuditComment),
        force: Boolean(options.force),
      },
      globalOptions,
    );
    if (typeof add === "string") {
      await invalidateSearchCachesForMutation(globalOptions, result);
    }
    printResult(result, globalOptions);
    if (globalOptions.profile) {
      printError(`profile:command=learnings took_ms=${Date.now() - startedAt}`);
    }
  });

program
  .command("files")
  .argument("<id>", "Item id")
  .option("--add <value>", "Add linked file entry (CSV/markdown pairs or - for stdin)", collect)
  .option(
    "--add-glob <value>",
    "Add linked file entries from a glob (plain glob or pattern=<glob>,scope=<scope>,note=<text>; repeatable)",
    collect,
  )
  .option("--remove <value>", "Remove linked file by path (path=<value>, path:<value>, plain path, or - for stdin)", collect)
  .option("--migrate <value>", "Migrate linked file paths in-place (from=<prefix>,to=<prefix>; repeatable)", collect)
  .option("--list", "List linked files without mutating")
  .option("--append-stable", "Preserve existing linked-file order and append new links without full-array resorting")
  .option("--validate-paths", "Validate linked file paths for existence and file shape")
  .option("--audit", "Audit linked file usage across all items for this item's linked paths")
  .option("--author <value>", "Mutation author")
  .option("--message <value>", "History message")
  .option("--force", "Force ownership override")
  .description("Manage files linked to an item.")
  .action(async (id: string, options: Record<string, unknown>, command) => {
    const globalOptions = getGlobalOptions(command);
    const startedAt = Date.now();
    const addValues = Array.isArray(options.add) ? (options.add as string[]) : [];
    const addGlobValues = Array.isArray(options.addGlob) ? (options.addGlob as string[]) : [];
    const removeValues = Array.isArray(options.remove) ? (options.remove as string[]) : [];
    const migrateValues = Array.isArray(options.migrate) ? (options.migrate as string[]) : [];
    const result = await runFiles(
      id,
      {
        add: addValues,
        addGlob: addGlobValues,
        remove: removeValues,
        migrate: migrateValues,
        list: Boolean(options.list),
        appendStable: Boolean(options.appendStable),
        validatePaths: Boolean(options.validatePaths),
        audit: Boolean(options.audit),
        author: typeof options.author === "string" ? options.author : undefined,
        message: typeof options.message === "string" ? options.message : undefined,
        force: Boolean(options.force),
      },
      globalOptions,
    );
    if (addValues.length > 0 || addGlobValues.length > 0 || removeValues.length > 0 || migrateValues.length > 0) {
      await invalidateSearchCachesForMutation(globalOptions, result);
    }
    printResult(result, globalOptions);
    if (globalOptions.profile) {
      printError(`profile:command=files took_ms=${Date.now() - startedAt}`);
    }
  });

program
  .command("docs")
  .argument("<id>", "Item id")
  .option("--add <value>", "Add linked doc entry (CSV/markdown pairs or - for stdin)", collect)
  .option(
    "--add-glob <value>",
    "Add linked doc entries from a glob (plain glob or pattern=<glob>,scope=<scope>,note=<text>; repeatable)",
    collect,
  )
  .option("--remove <value>", "Remove linked doc by path (path=<value>, path:<value>, plain path, or - for stdin)", collect)
  .option("--migrate <value>", "Migrate linked doc paths in-place (from=<prefix>,to=<prefix>; repeatable)", collect)
  .option("--validate-paths", "Validate linked doc paths for existence and file shape")
  .option("--audit", "Audit linked doc usage across all items for this item's linked paths")
  .option("--author <value>", "Mutation author")
  .option("--message <value>", "History message")
  .option("--force", "Force ownership override")
  .description("Manage docs linked to an item.")
  .action(async (id: string, options: Record<string, unknown>, command) => {
    const globalOptions = getGlobalOptions(command);
    const startedAt = Date.now();
    const addValues = Array.isArray(options.add) ? (options.add as string[]) : [];
    const addGlobValues = Array.isArray(options.addGlob) ? (options.addGlob as string[]) : [];
    const removeValues = Array.isArray(options.remove) ? (options.remove as string[]) : [];
    const migrateValues = Array.isArray(options.migrate) ? (options.migrate as string[]) : [];
    const result = await runDocs(
      id,
      {
        add: addValues,
        addGlob: addGlobValues,
        remove: removeValues,
        migrate: migrateValues,
        validatePaths: Boolean(options.validatePaths),
        audit: Boolean(options.audit),
        author: typeof options.author === "string" ? options.author : undefined,
        message: typeof options.message === "string" ? options.message : undefined,
        force: Boolean(options.force),
      },
      globalOptions,
    );
    if (addValues.length > 0 || addGlobValues.length > 0 || removeValues.length > 0 || migrateValues.length > 0) {
      await invalidateSearchCachesForMutation(globalOptions, result);
    }
    printResult(result, globalOptions);
    if (globalOptions.profile) {
      printError(`profile:command=docs took_ms=${Date.now() - startedAt}`);
    }
  });

program
  .command("deps")
  .argument("<id>", "Item id")
  .option("--format <value>", "Output format (tree or graph)", "tree")
  .option("--max-depth <value>", "Maximum dependency traversal depth (0 keeps only the root)")
  .option("--collapse <value>", "Collapse mode (none or repeated)", "none")
  .option("--summary", "Return counts only without full tree/graph payload")
  .description("Show dependency relationships for an item.")
  .action(async (id: string, options: Record<string, unknown>, command) => {
    const globalOptions = getGlobalOptions(command);
    const startedAt = Date.now();
    const result = await runDeps(
      id,
      {
        format: typeof options.format === "string" ? options.format : undefined,
        maxDepth: typeof options.maxDepth === "string" ? options.maxDepth : undefined,
        collapse: typeof options.collapse === "string" ? options.collapse : undefined,
        summary: options.summary === true,
      },
      globalOptions,
    );
    printResult(result, globalOptions);
    if (globalOptions.profile) {
      printError(`profile:command=deps took_ms=${Date.now() - startedAt}`);
    }
  });

program
  .command("test")
  .argument("<id>", "Item id")
  .option("--add <value>", "Add linked test entry (CSV/markdown pairs or - for stdin)", collect)
  .option(
    "--remove <value>",
    "Remove linked test entry by command/path (command=<value>, path=<value>, markdown pairs, plain value, or - for stdin)",
    collect,
  )
  .option("--run", "Run linked test commands")
  .option("--background", "Run linked tests in managed background mode")
  .option("--timeout <seconds>", "Default run timeout in seconds")
  .option("--progress", "Emit linked-test progress to stderr (always shown in TTY, opt-in for non-TTY)")
  .option("--env-set <value>", "Set environment variable(s) for linked-test runs (KEY=VALUE, repeatable)", collect)
  .option("--env-clear <value>", "Clear environment variable(s) for linked-test runs (NAME, repeatable)", collect)
  .option("--shared-host-safe", "Apply additive shared-host-safe runtime defaults for linked-test runs")
  .option("--pm-context <mode>", "PM linked-test context mode: schema|tracker|auto (default: schema)")
  .option(
    "--override-linked-pm-context",
    "Force run-level --pm-context to override per-linked-test pm_context_mode metadata",
  )
  .option("--fail-on-context-mismatch", "Fail linked PM commands when context item counts differ")
  .option("--fail-on-skipped", "Treat skipped linked tests as dependency failures")
  .option(
    "--fail-on-empty-test-run",
    "Treat successful linked-test commands that report zero executed tests as failures",
  )
  .option("--require-assertions-for-pm", "Require assertion metadata for linked PM command tests")
  .option("--check-context", "Preflight linked PM command context diagnostics before executing commands")
  .option(
    "--auto-pm-context",
    "Auto-remediate PM tracker-read context mismatches by routing those linked commands through tracker context",
  )
  .option("--author <value>", "Mutation author")
  .option("--message <value>", "History message")
  .option("--force", "Force ownership override")
  .description("Manage tests linked to an item and optionally run them.")
  .action(async (id: string, options: Record<string, unknown>, command) => {
    const globalOptions = getGlobalOptions(command);
    const startedAt = Date.now();
    const addValues = Array.isArray(options.add) ? (options.add as string[]) : [];
    const removeValues = Array.isArray(options.remove) ? (options.remove as string[]) : [];
    const runInBackground = options.background === true;
    if (runInBackground && options.run !== true) {
      throw new PmCliError("--background requires --run", EXIT_CODE.USAGE);
    }
    if (runInBackground && (addValues.length > 0 || removeValues.length > 0)) {
      throw new PmCliError("--background does not support --add/--remove; update linked tests first, then run in background", EXIT_CODE.USAGE);
    }
    if (runInBackground) {
      const result = await runStartBackgroundRun(
        {
          kind: "test",
          commandArgs: buildBackgroundTestCommandArgs(id, {
            ...options,
            add: addValues,
            remove: removeValues,
          }),
          targetId: id,
          author: typeof options.author === "string" ? options.author : undefined,
          noExtensions: globalOptions.noExtensions === true,
        },
        globalOptions,
      );
      printResult(result, globalOptions);
      if (globalOptions.profile) {
        printError(`profile:command=test took_ms=${Date.now() - startedAt}`);
      }
      return;
    }
    const result = await runTest(
      id,
      {
        add: addValues,
        remove: removeValues,
        run: Boolean(options.run),
        timeout: typeof options.timeout === "string" ? options.timeout : undefined,
        progress: Boolean(options.progress),
        envSet: Array.isArray(options.envSet) ? (options.envSet as string[]) : [],
        envClear: Array.isArray(options.envClear) ? (options.envClear as string[]) : [],
        sharedHostSafe: Boolean(options.sharedHostSafe),
        pmContext: typeof options.pmContext === "string" ? options.pmContext : undefined,
        overrideLinkedPmContext: Boolean(options.overrideLinkedPmContext),
        failOnContextMismatch: Boolean(options.failOnContextMismatch),
        failOnSkipped: Boolean(options.failOnSkipped),
        failOnEmptyTestRun: Boolean(options.failOnEmptyTestRun),
        requireAssertionsForPm: Boolean(options.requireAssertionsForPm),
        checkContext: Boolean(options.checkContext),
        autoPmContext: Boolean(options.autoPmContext),
        author: typeof options.author === "string" ? options.author : undefined,
        message: typeof options.message === "string" ? options.message : undefined,
        force: Boolean(options.force),
      },
      globalOptions,
    );
    if (addValues.length > 0 || removeValues.length > 0 || options.run === true) {
      await invalidateSearchCachesForMutation(globalOptions, result);
    }
    printResult(result, globalOptions);
    if (result.run_results.some((entry) => entry.status === "failed") || result.fail_on_skipped_triggered === true) {
      process.exitCode = EXIT_CODE.DEPENDENCY_FAILED;
    }
    if (globalOptions.profile) {
      printError(`profile:command=test took_ms=${Date.now() - startedAt}`);
    }
  });

program
  .command("test-all")
  .description("Run linked tests across matching items.")
  .option("--status <value>", "Filter items by status before running tests")
  .option("--limit <n>", "Limit matching items before running linked tests")
  .option("--offset <n>", "Skip matching items before running linked tests")
  .option("--background", "Run linked tests in managed background mode")
  .option("--timeout <seconds>", "Default run timeout in seconds")
  .option("--progress", "Emit linked-test progress to stderr (always shown in TTY, opt-in for non-TTY)")
  .option("--env-set <value>", "Set environment variable(s) for linked-test runs (KEY=VALUE, repeatable)", collect)
  .option("--env-clear <value>", "Clear environment variable(s) for linked-test runs (NAME, repeatable)", collect)
  .option("--shared-host-safe", "Apply additive shared-host-safe runtime defaults for linked-test runs")
  .option("--pm-context <mode>", "PM linked-test context mode: schema|tracker|auto (default: schema)")
  .option(
    "--override-linked-pm-context",
    "Force run-level --pm-context to override per-linked-test pm_context_mode metadata",
  )
  .option("--fail-on-context-mismatch", "Fail linked PM commands when context item counts differ")
  .option("--fail-on-skipped", "Treat skipped linked tests as dependency failures")
  .option(
    "--fail-on-empty-test-run",
    "Treat successful linked-test commands that report zero executed tests as failures",
  )
  .option("--require-assertions-for-pm", "Require assertion metadata for linked PM command tests")
  .option("--check-context", "Preflight linked PM command context diagnostics before executing commands")
  .option(
    "--auto-pm-context",
    "Auto-remediate PM tracker-read context mismatches by routing those linked commands through tracker context",
  )
  .action(async (options: Record<string, unknown>, command) => {
    const globalOptions = getGlobalOptions(command);
    const startedAt = Date.now();
    const runInBackground = options.background === true;
    if (runInBackground) {
      const result = await runStartBackgroundRun(
        {
          kind: "test-all",
          commandArgs: buildBackgroundTestAllCommandArgs(options),
          statusFilter: typeof options.status === "string" ? options.status : undefined,
          noExtensions: globalOptions.noExtensions === true,
        },
        globalOptions,
      );
      printResult(result, globalOptions);
      if (globalOptions.profile) {
        printError(`profile:command=test-all took_ms=${Date.now() - startedAt}`);
      }
      return;
    }
    const result = await runTestAll(
      {
        status: typeof options.status === "string" ? options.status : undefined,
        limit: typeof options.limit === "string" ? options.limit : undefined,
        offset: typeof options.offset === "string" ? options.offset : undefined,
        timeout: typeof options.timeout === "string" ? options.timeout : undefined,
        progress: Boolean(options.progress),
        envSet: Array.isArray(options.envSet) ? (options.envSet as string[]) : [],
        envClear: Array.isArray(options.envClear) ? (options.envClear as string[]) : [],
        sharedHostSafe: Boolean(options.sharedHostSafe),
        pmContext: typeof options.pmContext === "string" ? options.pmContext : undefined,
        overrideLinkedPmContext: Boolean(options.overrideLinkedPmContext),
        failOnContextMismatch: Boolean(options.failOnContextMismatch),
        failOnSkipped: Boolean(options.failOnSkipped),
        failOnEmptyTestRun: Boolean(options.failOnEmptyTestRun),
        requireAssertionsForPm: Boolean(options.requireAssertionsForPm),
        checkContext: Boolean(options.checkContext),
        autoPmContext: Boolean(options.autoPmContext),
      },
      globalOptions,
    );
    await invalidateSearchCachesForMutation(globalOptions, {
      ids: result.results.map((entry) => entry.id),
    });
    printResult(result, globalOptions);
    if (result.failed > 0 || result.fail_on_skipped_triggered === true) {
      process.exitCode = EXIT_CODE.DEPENDENCY_FAILED;
    }
    if (globalOptions.profile) {
      printError(`profile:command=test-all took_ms=${Date.now() - startedAt}`);
    }
  });

const testRunsCommand = program
  .command("test-runs")
  .description("Manage background linked-test runs.")
  .action(async (_options: Record<string, unknown>, command) => {
    const globalOptions = getGlobalOptions(command);
    const startedAt = Date.now();
    const result = await runTestRunsList({}, globalOptions);
    printResult(result, globalOptions);
    if (globalOptions.profile) {
      printError(`profile:command=test-runs took_ms=${Date.now() - startedAt}`);
    }
  });

testRunsCommand
  .command("list")
  .option("--status <value>", "Filter by background run status")
  .option("--limit <value>", "Limit number of runs returned")
  .description("List background test runs.")
  .action(async (options: Record<string, unknown>, command) => {
    const globalOptions = getGlobalOptions(command);
    const startedAt = Date.now();
    const result = await runTestRunsList(
      {
        status: typeof options.status === "string" ? options.status : undefined,
        limit: typeof options.limit === "string" ? options.limit : undefined,
      },
      globalOptions,
    );
    printResult(result, globalOptions);
    if (globalOptions.profile) {
      printError(`profile:command=test-runs list took_ms=${Date.now() - startedAt}`);
    }
  });

testRunsCommand
  .command("status")
  .argument("<runId>", "Background run id")
  .description("Show status, health, and resource snapshot for a background run.")
  .action(async (runId: string, _options: Record<string, unknown>, command) => {
    const globalOptions = getGlobalOptions(command);
    const startedAt = Date.now();
    const result = await runTestRunsStatus(runId, globalOptions);
    printResult(result, globalOptions);
    if (globalOptions.profile) {
      printError(`profile:command=test-runs status took_ms=${Date.now() - startedAt}`);
    }
  });

testRunsCommand
  .command("logs")
  .argument("<runId>", "Background run id")
  .option("--stream <value>", "Log stream selector: stdout|stderr|both")
  .option("--tail <value>", "Tail number of lines per selected stream")
  .description("Show tailed logs for a background run.")
  .action(async (runId: string, options: Record<string, unknown>, command) => {
    const globalOptions = getGlobalOptions(command);
    const startedAt = Date.now();
    const result = await runTestRunsLogs(
      runId,
      {
        stream: typeof options.stream === "string" ? options.stream : undefined,
        tail: typeof options.tail === "string" ? options.tail : undefined,
      },
      globalOptions,
    );
    printResult(result, globalOptions);
    if (globalOptions.profile) {
      printError(`profile:command=test-runs logs took_ms=${Date.now() - startedAt}`);
    }
  });

testRunsCommand
  .command("stop")
  .argument("<runId>", "Background run id")
  .option("--force", "Force-stop via SIGKILL")
  .description("Stop a running background test run.")
  .action(async (runId: string, options: Record<string, unknown>, command) => {
    const globalOptions = getGlobalOptions(command);
    const startedAt = Date.now();
    const result = await runTestRunsStop(
      runId,
      {
        force: options.force === true,
      },
      globalOptions,
    );
    printResult(result, globalOptions);
    if (globalOptions.profile) {
      printError(`profile:command=test-runs stop took_ms=${Date.now() - startedAt}`);
    }
  });

testRunsCommand
  .command("resume")
  .argument("<runId>", "Background run id")
  .option("--author <value>", "Resume author (falls back to PM_AUTHOR/settings)")
  .description("Resume a previously terminal background test run by starting a new attempt.")
  .action(async (runId: string, options: Record<string, unknown>, command) => {
    const globalOptions = getGlobalOptions(command);
    const startedAt = Date.now();
    const result = await runTestRunsResume(
      runId,
      {
        author: typeof options.author === "string" ? options.author : undefined,
        noExtensions: globalOptions.noExtensions === true,
      },
      globalOptions,
    );
    printResult(result, globalOptions);
    if (globalOptions.profile) {
      printError(`profile:command=test-runs resume took_ms=${Date.now() - startedAt}`);
    }
  });

program
  .command("test-runs-worker", { hidden: true })
  .argument("<runId>", "Background run id")
  .description("Internal background worker command.")
  .action(async (runId: string, _options: Record<string, unknown>, command: Command) => {
    const globalOptions = getGlobalOptions(command);
    await runTestRunsWorker(runId, globalOptions);
  });

program
  .command("stats")
  .description("Show project tracker statistics.")
  .action(async (_options, command) => {
    const globalOptions = getGlobalOptions(command);
    const startedAt = Date.now();
    const result = await runStats(globalOptions);
    printResult(result, globalOptions);
    if (globalOptions.profile) {
      printError(`profile:command=stats took_ms=${Date.now() - startedAt}`);
    }
  });

program
  .command("health")
  .description("Show project tracker health checks.")
  .option("--strict-directories", "Treat optional item-type directories as required failures")
  .option("--check-only", "Run read-only health diagnostics without refreshing vectors")
  .option("--no-refresh", "Disable automatic vector refresh attempts during health checks")
  .option("--refresh-vectors", "Explicitly enable vector refresh attempts during health checks")
  .option("--verbose-stale-items", "Include full stale vectorization ID lists in health output")
  .option("--strict-exit", "Return non-zero exit when health warnings are present (ok=false)")
  .option("--fail-on-warn", "Alias for --strict-exit")
  .action(async (options: Record<string, unknown>, command) => {
    const globalOptions = getGlobalOptions(command);
    const startedAt = Date.now();
    const result = await runHealth(globalOptions, {
      strictDirectories: Boolean(options.strictDirectories),
      checkOnly: Boolean(options.checkOnly),
      noRefresh: Boolean(options.noRefresh),
      refreshVectors: Boolean(options.refreshVectors),
      verboseStaleItems: Boolean(options.verboseStaleItems),
    });
    printResult(result, globalOptions);
    const strictExit = Boolean(options.strictExit) || Boolean(options.failOnWarn);
    if (strictExit && !result.ok) {
      process.exitCode = EXIT_CODE.GENERIC_FAILURE;
    }
    if (globalOptions.profile) {
      printError(`profile:command=health took_ms=${Date.now() - startedAt}`);
    }
  });

program
  .command("validate")
  .description("Run standalone metadata, resolution, lifecycle, files, linked-command reference, and history drift validation checks.")
  .option("--check-metadata", "Run metadata completeness checks")
  .option("--metadata-profile <value>", "Select metadata validation profile for --check-metadata (core|strict|custom)")
  .option("--check-resolution", "Run closed-item resolution metadata checks")
  .option("--check-lifecycle", "Run active-item lifecycle governance drift checks")
  .option("--check-stale-blockers", "Include stale blocker-pattern diagnostics in lifecycle checks")
  .option("--check-files", "Run linked-file and orphaned-file checks")
  .option("--check-command-references", "Run linked-command PM-ID reference checks")
  .option("--scan-mode <value>", "Select file candidate scan mode for --check-files (default|tracked-all|tracked-all-strict)")
  .option("--include-pm-internals", "Include PM storage internals in tracked-all candidate scans")
  .option("--verbose-file-lists", "Include full file-path lists for validate --check-files details")
  .option("--strict-exit", "Return non-zero exit when validation warnings are present (ok=false)")
  .option("--fail-on-warn", "Alias for --strict-exit")
  .option("--check-history-drift", "Run item/history hash drift checks")
  .action(async (options: Record<string, unknown>, command) => {
    const globalOptions = getGlobalOptions(command);
    const startedAt = Date.now();
    const result = await runValidate(
      {
        checkMetadata: Boolean(options.checkMetadata),
        metadataProfile: typeof options.metadataProfile === "string" ? options.metadataProfile : undefined,
        checkResolution: Boolean(options.checkResolution),
        checkLifecycle: Boolean(options.checkLifecycle),
        checkStaleBlockers: Boolean(options.checkStaleBlockers),
        checkFiles: Boolean(options.checkFiles),
        checkCommandReferences: Boolean(options.checkCommandReferences),
        scanMode: typeof options.scanMode === "string" ? options.scanMode : undefined,
        includePmInternals: Boolean(options.includePmInternals),
        verboseFileLists: Boolean(options.verboseFileLists),
        checkHistoryDrift: Boolean(options.checkHistoryDrift),
      },
      globalOptions,
    );
    printResult(result, globalOptions);
    const strictExit = Boolean(options.strictExit) || Boolean(options.failOnWarn);
    if (strictExit && !result.ok) {
      process.exitCode = EXIT_CODE.GENERIC_FAILURE;
    }
    if (globalOptions.profile) {
      printError(`profile:command=validate took_ms=${Date.now() - startedAt}`);
    }
  });

program
  .command("gc")
  .option("--dry-run", "Preview cleanup targets without deleting files")
  .option(
    "--scope <value>",
    "Limit cleanup to one or more scopes (comma-separated or repeatable): index, embeddings, runtime",
    collect,
  )
  .description("Clean optional cache artifacts and show a summary.")
  .action(async (options: Record<string, unknown>, command) => {
    const globalOptions = getGlobalOptions(command);
    const startedAt = Date.now();
    const result = await runGc(globalOptions, {
      dryRun: options.dryRun === true,
      scope: Array.isArray(options.scope) ? (options.scope as string[]) : [],
    });
    printResult(result, globalOptions);
    if (globalOptions.profile) {
      printError(`profile:command=gc took_ms=${Date.now() - startedAt}`);
    }
  });

program
  .command("contracts")
  .description("Show machine-readable command and schema contracts for agents.")
  .option("--action <value>", "Filter tool schema branches to a specific action")
  .option("--command <value>", "Scope contracts output to one CLI command (narrow-by-default)")
  .option("--schema-only", "Return schema-focused output only")
  .option("--flags-only", "Return command flag contracts only")
  .option("--availability-only", "Return action availability surface only")
  .option("--runtime-only", "Include only actions invocable in the current runtime")
  .option("--active-only", "Alias for --runtime-only")
  .action(async (options: Record<string, unknown>, command) => {
    const globalOptions = getGlobalOptions(command);
    const startedAt = Date.now();
    const result = await runContracts(
      {
        action: typeof options.action === "string" ? options.action : undefined,
        command: typeof options.command === "string" ? options.command : undefined,
        schemaOnly: Boolean(options.schemaOnly),
        flagsOnly: Boolean(options.flagsOnly),
        availabilityOnly: Boolean(options.availabilityOnly),
        runtimeOnly: Boolean(options.runtimeOnly) || Boolean(options.activeOnly),
      },
      globalOptions,
    );
    printResult(result, globalOptions);
    if (globalOptions.profile) {
      printError(`profile:command=contracts took_ms=${Date.now() - startedAt}`);
    }
  });

program
  .command("claim")
  .argument("<id>", "Item id")
  .option("--author <value>", "Mutation author")
  .option("--message <value>", "History message")
  .option("--force", "Force claim override")
  .description("Claim an item for active work.")
  .action(async (id: string, options: Record<string, unknown>, command) => {
    const globalOptions = getGlobalOptions(command);
    const startedAt = Date.now();
    const result = await runClaim(id, Boolean(options.force), globalOptions, {
      author: typeof options.author === "string" ? options.author : undefined,
      message: typeof options.message === "string" ? options.message : undefined,
    });
    await invalidateSearchCachesForMutation(globalOptions, result);
    printResult(result, globalOptions);
    if (globalOptions.profile) {
      printError(`profile:command=claim took_ms=${Date.now() - startedAt}`);
    }
  });

program
  .command("release")
  .argument("<id>", "Item id")
  .option("--author <value>", "Mutation author")
  .option("--message <value>", "History message")
  .option("--allow-audit-release", "Allow non-owner release handoffs without requiring --force")
  .option("--force", "Force release override")
  .description("Release an item's active claim.")
  .action(async (id: string, options: Record<string, unknown>, command) => {
    const globalOptions = getGlobalOptions(command);
    const startedAt = Date.now();
    const result = await runRelease(id, Boolean(options.force), globalOptions, {
      author: typeof options.author === "string" ? options.author : undefined,
      message: typeof options.message === "string" ? options.message : undefined,
      allowAuditRelease: options.allowAuditRelease === true,
    });
    await invalidateSearchCachesForMutation(globalOptions, result);
    printResult(result, globalOptions);
    if (globalOptions.profile) {
      printError(`profile:command=release took_ms=${Date.now() - startedAt}`);
    }
  });

program
  .command("start-task")
  .argument("<id>", "Item id")
  .option("--author <value>", "Mutation author")
  .option("--message <value>", "History message")
  .option("--force", "Force ownership or terminal override when required")
  .description("Lifecycle alias: claim an item and move it to in_progress.")
  .action(async (id: string, options: Record<string, unknown>, command) => {
    const globalOptions = getGlobalOptions(command);
    const startedAt = Date.now();
    const pmRoot = resolvePmRoot(process.cwd(), globalOptions.path);
    const settings = await readSettings(pmRoot);
    const statusRegistry = resolveRuntimeStatusRegistry(settings.schema);
    const inProgressStatus = normalizeStatusInput("in_progress", statusRegistry) ?? statusRegistry.open_status;
    const force = Boolean(options.force);
    const mutationOptions = {
      author: typeof options.author === "string" ? options.author : undefined,
      message: typeof options.message === "string" ? options.message : undefined,
    };
    const claimResult = await runClaim(id, force, globalOptions, mutationOptions);
    await invalidateSearchCachesForMutation(globalOptions, claimResult);
    const updateResult = await runUpdate(
      id,
      {
        ...mutationOptions,
        status: inProgressStatus,
        force,
      },
      globalOptions,
    );
    await invalidateSearchCachesForMutation(globalOptions, updateResult);
    printResult(
      {
        id,
        action: "start_task",
        claim: claimResult,
        update: updateResult,
      },
      globalOptions,
    );
    if (globalOptions.profile) {
      printError(`profile:command=start-task took_ms=${Date.now() - startedAt}`);
    }
  });

program
  .command("pause-task")
  .argument("<id>", "Item id")
  .option("--author <value>", "Mutation author")
  .option("--message <value>", "History message")
  .option("--force", "Force ownership override when required")
  .description("Lifecycle alias: move an item to open and release its claim.")
  .action(async (id: string, options: Record<string, unknown>, command) => {
    const globalOptions = getGlobalOptions(command);
    const startedAt = Date.now();
    const pmRoot = resolvePmRoot(process.cwd(), globalOptions.path);
    const settings = await readSettings(pmRoot);
    const statusRegistry = resolveRuntimeStatusRegistry(settings.schema);
    const openStatus = statusRegistry.open_status;
    const force = Boolean(options.force);
    const mutationOptions = {
      author: typeof options.author === "string" ? options.author : undefined,
      message: typeof options.message === "string" ? options.message : undefined,
    };
    const updateResult = await runUpdate(
      id,
      {
        ...mutationOptions,
        status: openStatus,
        force,
      },
      globalOptions,
    );
    await invalidateSearchCachesForMutation(globalOptions, updateResult);
    const releaseResult = await runRelease(id, force, globalOptions, mutationOptions);
    await invalidateSearchCachesForMutation(globalOptions, releaseResult);
    printResult(
      {
        id,
        action: "pause_task",
        update: updateResult,
        release: releaseResult,
      },
      globalOptions,
    );
    if (globalOptions.profile) {
      printError(`profile:command=pause-task took_ms=${Date.now() - startedAt}`);
    }
  });

program
  .command("close-task")
  .argument("<id>", "Item id")
  .argument("<reason>", "Close reason text")
  .option("--author <value>", "Mutation author")
  .option("--message <value>", "History message")
  .option("--validate-close <value>", "Close-time validation mode: warn|strict")
  .option("--force", "Force ownership or terminal override when required")
  .description("Lifecycle alias: close an item with reason and release assignment metadata.")
  .action(async (id: string, reason: string, options: Record<string, unknown>, command) => {
    const globalOptions = getGlobalOptions(command);
    const startedAt = Date.now();
    const force = Boolean(options.force);
    const mutationOptions = {
      author: typeof options.author === "string" ? options.author : undefined,
      message: typeof options.message === "string" ? options.message : undefined,
    };
    const closeResult = await runClose(
      id,
      reason,
      {
        ...mutationOptions,
        validateClose: typeof options.validateClose === "string" ? options.validateClose : undefined,
        force,
      },
      globalOptions,
    );
    await invalidateSearchCachesForMutation(globalOptions, closeResult);
    const releaseResult = await runRelease(id, force, globalOptions, mutationOptions);
    await invalidateSearchCachesForMutation(globalOptions, releaseResult);
    printResult(
      {
        id,
        action: "close_task",
        close: closeResult,
        release: releaseResult,
      },
      globalOptions,
    );
    if (globalOptions.profile) {
      printError(`profile:command=close-task took_ms=${Date.now() - startedAt}`);
    }
  });

program
  .command("completion")
  .argument("<shell>", "Shell type: bash, zsh, or fish")
  .option("--eager-tags", "Embed current tracker tags directly in generated scripts (legacy eager mode)")
  .description("Generate shell completion for pm.")
  .action(async (shell: string, options: Record<string, unknown>, command) => {
    const globalOptions = getGlobalOptions(command);
    const pmRoot = resolvePmRoot(process.cwd(), globalOptions.path);
    let completionTypes: string[] | undefined;
    let completionTags: string[] | undefined;
    let completionStatuses: string[] | undefined;
    const completionCommandFlags: Partial<
      Record<"list" | "create" | "update" | "update-many" | "search" | "calendar" | "context", string[]>
    > = {};
    const eagerTags = Boolean(options.eagerTags);
    if (await pathExists(getSettingsPath(pmRoot))) {
      const settings = await readSettings(pmRoot);
      const statusRegistry = resolveRuntimeStatusRegistry(settings.schema);
      const runtimeFieldRegistry = resolveRuntimeFieldRegistry(settings.schema);
      const typeRegistry = resolveItemTypeRegistry(settings, getActiveExtensionRegistrations());
      completionTypes = typeRegistry.types;
      completionStatuses = statusRegistry.definitions.map((definition) => definition.id);
      for (const [commandKey, definitions] of runtimeFieldRegistry.command_to_fields.entries()) {
        if (
          commandKey !== "list" &&
          commandKey !== "create" &&
          commandKey !== "update" &&
          commandKey !== "search" &&
          commandKey !== "calendar" &&
          commandKey !== "context"
        ) {
          continue;
        }
        const runtimeFlags = new Set<string>();
        for (const definition of definitions) {
          runtimeFlags.add(`--${definition.cli_flag}`);
          for (const alias of definition.cli_aliases) {
            if (alias.startsWith("--") || (alias.startsWith("-") && !alias.startsWith("--"))) {
              runtimeFlags.add(alias);
            } else {
              runtimeFlags.add(`--${alias}`);
            }
          }
        }
        completionCommandFlags[commandKey] = [...runtimeFlags].sort((left, right) => left.localeCompare(right));
      }
      if (completionCommandFlags.update) {
        completionCommandFlags["update-many"] = [...completionCommandFlags.update];
      }
      if (eagerTags) {
        const items = await listAllFrontMatter(pmRoot, settings.item_format, typeRegistry.type_to_folder, undefined, settings.schema);
        completionTags = [...new Set(items.flatMap((item) => item.tags ?? []).map((tag) => tag.trim()).filter((tag) => tag.length > 0))]
          .sort((left, right) => left.localeCompare(right));
      }
    }
    const result = runCompletion(shell, completionTypes, completionTags ?? [], eagerTags, {
      statuses: completionStatuses,
      command_flags: completionCommandFlags,
    });
    if (globalOptions.json) {
      printResult(result, globalOptions);
    } else if (!globalOptions.quiet) {
      writeStdout(`${result.script}\n`);
    }
    if (globalOptions.profile) {
      printError(`profile:command=completion took_ms=0`);
    }
  });

program
  .command("completion-tags", { hidden: true })
  .description("Internal dynamic completion tag source.")
  .action(async (_options: Record<string, unknown>, command) => {
    const globalOptions = getGlobalOptions(command);
    const startedAt = Date.now();
    const pmRoot = resolvePmRoot(process.cwd(), globalOptions.path);
    let tags: string[] = [];
    if (await pathExists(getSettingsPath(pmRoot))) {
      const settings = await readSettings(pmRoot);
      const typeRegistry = resolveItemTypeRegistry(settings, getActiveExtensionRegistrations());
      const items = await listAllFrontMatter(pmRoot, settings.item_format, typeRegistry.type_to_folder, undefined, settings.schema);
      tags = [...new Set(items.flatMap((item) => item.tags ?? []).map((tag) => tag.trim()).filter((tag) => tag.length > 0))].sort((left, right) =>
        left.localeCompare(right),
      );
    }
    if (globalOptions.json) {
      printResult(
        {
          tags,
          count: tags.length,
        },
        globalOptions,
      );
    } else if (!globalOptions.quiet) {
      writeStdout(tags.join("\n"));
      if (tags.length > 0) {
        writeStdout("\n");
      }
    }
    if (globalOptions.profile) {
      printError(`profile:command=completion-tags took_ms=${Date.now() - startedAt}`);
    }
  });

attachRichHelpText(program, normalizeLegacyExtensionActionSyntax(process.argv.slice(2)));

interface CommanderUsageContext {
  message: string;
  commandName: string | undefined;
  allowedTypes: string;
}

function resolveChildCommandByToken(parent: Command, token: string): Command | undefined {
  const normalizedToken = token.trim().toLowerCase();
  return parent.commands.find((candidate) => {
    if (candidate.name().trim().toLowerCase() === normalizedToken) {
      return true;
    }
    const aliases = typeof candidate.aliases === "function" ? candidate.aliases() : [];
    return aliases.some((alias) => alias.trim().toLowerCase() === normalizedToken);
  });
}

function isKnownHelpCommandPath(root: Command, commandPathTokens: string[]): boolean {
  if (commandPathTokens.length === 0) {
    return true;
  }
  let current = root;
  let matchedAny = false;
  for (const token of commandPathTokens) {
    const next = resolveChildCommandByToken(current, token);
    if (!next) {
      return matchedAny;
    }
    matchedAny = true;
    current = next;
  }
  return matchedAny;
}

async function resolveCommanderUsageContext(error: unknown): Promise<CommanderUsageContext> {
  const rawMessage = typeof error === "object" && error !== null ? (error as { message?: string }).message : undefined;
  const message = rawMessage ?? "Invalid command usage";
  const invocationArgv = normalizeLegacyExtensionActionSyntax(process.argv.slice(2));
  const bootstrapGlobal = parseBootstrapGlobalOptions(invocationArgv);
  const commandName = parseBootstrapCommandName(invocationArgv);
  let allowedTypes = BUILTIN_TYPE_HELP_VALUES;
  try {
    const pmRoot = resolvePmRoot(process.cwd(), bootstrapGlobal.path);
    if (await pathExists(getSettingsPath(pmRoot))) {
      const settings = await readSettings(pmRoot);
      const typeRegistry = resolveItemTypeRegistry(settings, getActiveExtensionRegistrations());
      if (typeRegistry.types.length > 0) {
        allowedTypes = typeRegistry.types.join("|");
      }
    }
  } catch {
    // Fall back to built-in type guidance when settings cannot be read.
  }
  return {
    message,
    commandName,
    allowedTypes,
  };
}

async function formatCommanderUsageMessage(error: unknown): Promise<string> {
  const usageContext = await resolveCommanderUsageContext(error);
  const { message, commandName, allowedTypes } = usageContext;
  const formatted = formatCommanderErrorForDisplay(message, commandName, allowedTypes);
  const serviceOverride = await runActiveServiceOverride("help_format", {
    message: formatted,
    command: commandName,
    allowed_types: allowedTypes,
  });
  if (serviceOverride.handled && typeof serviceOverride.result === "string") {
    return serviceOverride.result;
  }
  return formatted;
}

async function formatCommanderUsageJson(error: unknown): Promise<string> {
  const usageContext = await resolveCommanderUsageContext(error);
  const envelope = formatCommanderErrorForJson(
    usageContext.message,
    usageContext.commandName,
    usageContext.allowedTypes,
    EXIT_CODE.USAGE,
  );
  return JSON.stringify(envelope, null, 2);
}

async function main(): Promise<void> {
  const invocationArgv = normalizeLegacyExtensionActionSyntax(process.argv.slice(2));
  const invocationProcessArgv = [process.argv[0], process.argv[1], ...invocationArgv];
  try {
    applyBootstrapPagerPolicy(invocationArgv);
    await registerDynamicExtensionCommandPaths(program);
    await registerRuntimeSchemaFieldFlags(program);
    wrapProgramActionsForExtensionHandlers(program);
    const renderedBootstrapJsonHelp = await maybeRenderBootstrapJsonHelp(program, invocationArgv);
    if (renderedBootstrapJsonHelp) {
      return;
    }
    await program.parseAsync(invocationProcessArgv);
  } catch (error: unknown) {
    await runAndClearAfterCommandHooks({
      ok: false,
      error: describeUnknownError(error),
    });
    const bootstrapGlobal = parseBootstrapGlobalOptions(invocationArgv);
    const jsonErrors = bootstrapGlobal.json;
    if (error instanceof PmCliError) {
      if (jsonErrors) {
        printError(JSON.stringify(formatPmCliErrorForJson(error.message, error.exitCode, error.context), null, 2));
      } else {
        printError(formatPmCliErrorForDisplay(error.message, error.context));
      }
      process.exitCode = error.exitCode;
      return;
    }

    if (typeof error === "object" && error !== null && "code" in error) {
      const code = (error as { code?: string }).code;
      const rawMessage = typeof (error as { message?: unknown }).message === "string" ? ((error as { message?: string }).message ?? "") : "";
      const isHelpDisplayCode =
        code === "commander.helpDisplayed" || code === "commander.help" || code === "commander.helpCommand";
      if (isHelpDisplayCode || rawMessage.includes("(outputHelp)")) {
        const helpRequest = parseBootstrapHelpRequest(invocationArgv);
        if (helpRequest.requested && !isKnownHelpCommandPath(program, helpRequest.commandPathTokens)) {
          const unknownToken = helpRequest.commandPathTokens[0] ?? parseBootstrapCommandName(invocationArgv) ?? "<command>";
          const unknownMessage = `unknown command '${unknownToken}'`;
          if (jsonErrors) {
            printError(await formatCommanderUsageJson({ message: unknownMessage }));
          } else {
            printError(await formatCommanderUsageMessage({ message: unknownMessage }));
          }
          process.exitCode = EXIT_CODE.USAGE;
          return;
        }
        process.exitCode = EXIT_CODE.SUCCESS;
        return;
      }
      if (code === "commander.version") {
        process.exitCode = EXIT_CODE.SUCCESS;
        return;
      }
      if (code?.startsWith("commander.")) {
        if (jsonErrors) {
          printError(await formatCommanderUsageJson(error));
        } else {
          printError(await formatCommanderUsageMessage(error));
        }
        process.exitCode = EXIT_CODE.USAGE;
        return;
      }
    }

    const message = describeUnknownError(error);
    if (jsonErrors) {
      printError(JSON.stringify(formatUnknownErrorForJson(message, EXIT_CODE.GENERIC_FAILURE), null, 2));
    } else {
      printError(message);
    }
    process.exitCode = EXIT_CODE.GENERIC_FAILURE;
  }
}

void main();
