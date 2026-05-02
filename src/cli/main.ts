#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
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
import {
  resolveRuntimeFieldRegistry,
  type RuntimeFieldCommand,
} from "../core/schema/runtime-schema.js";
import { EXIT_CODE } from "../core/shared/constants.js";
import { PmCliError } from "../core/shared/errors.js";
import { toNonEmptyStringOrUndefined } from "../core/shared/primitives.js";
import { printError, printResult, writeStdout } from "../core/output/output.js";
import { maybeRunFirstUseTelemetryPrompt } from "../core/telemetry/consent.js";
import {
  finishTelemetryCommand,
  startTelemetryCommand,
  type ActiveTelemetryCommand,
} from "../core/telemetry/runtime.js";
import {
  sentryCaptureCliError,
  sentryFinishCommandSpan,
  sentryFlush,
  sentrySetCommandContext,
  sentryStartCommandSpan,
} from "../core/sentry/helpers.js";
import { migrateItemFilesToFormat } from "../core/store/item-format-migration.js";
import { getSettingsPath, resolvePmRoot } from "../core/store/paths.js";
import { readSettings, readSettingsWithMetadata, writeSettings } from "../core/store/settings.js";
import type { GlobalOptions } from "../core/shared/command-types.js";
import type { PmSettings } from "../types/index.js";
import { BUILTIN_ITEM_TYPE_VALUES } from "../types/index.js";
import { coerceLooseCommandOptionsWithFlagDefinitions, parseLooseCommandOptions } from "./extension-command-options.js";
import { attachRichHelpText, normalizeHelpCommandPath, resolveHelpDetailMode, resolveHelpNarrative } from "./help-content.js";
import {
  type CommanderGuidanceContext,
  formatCommanderErrorForDisplay,
  formatCommanderErrorForJson,
  formatPmCliErrorForDisplay,
  formatPmCliErrorForJson,
  formatUnknownErrorForJson,
} from "./error-guidance.js";
import {
  applyDefaultOutputFormat,
  clearResolvedGlobalOptions,
  collect,
  formatHookWarnings,
  getCommandPath,
  getGlobalOptions,
  invalidateSearchCachesForMutation,
  setResolvedGlobalOptions,
} from "./registration-helpers.js";
import { registerSetupCommands } from "./register-setup.js";
import { registerListQueryCommands } from "./register-list-query.js";
import { registerMutationCommands } from "./register-mutation.js";
import { registerOperationCommands } from "./register-operations.js";

const PM_PACKAGE_ROOT_ENV = "PM_CLI_PACKAGE_ROOT";

function resolvePmPackageRoot(): string {
  const mainPath = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(mainPath), "../..");
}

if (typeof process.env[PM_PACKAGE_ROOT_ENV] !== "string" || process.env[PM_PACKAGE_ROOT_ENV]?.trim().length === 0) {
  process.env[PM_PACKAGE_ROOT_ENV] = resolvePmPackageRoot();
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

type ExtensionSubcommandAction =
  | "init"
  | "install"
  | "uninstall"
  | "explore"
  | "manage"
  | "doctor"
  | "adopt"
  | "adopt-all"
  | "activate"
  | "deactivate";

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
      const unknownMessage = `unknown command '${helpRequest.commandPathTokens.join(" ")}'`;
      const envelope = formatCommanderErrorForJson(
        unknownMessage,
        "help",
        BUILTIN_TYPE_HELP_VALUES,
        EXIT_CODE.USAGE,
        buildUnknownCommandGuidanceFromRuntime(unknownMessage, rootProgram),
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
let activeTelemetryCommandContext: ActiveTelemetryCommand | null = null;

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


function resolveMigrationId(definition: Record<string, unknown>, fallbackIndex: number): string {
  const explicit = toNonEmptyStringOrUndefined(definition.id);
  if (explicit) {
    return explicit;
  }
  return `migration-${String(fallbackIndex + 1).padStart(3, "0")}`;
}

function resolveNormalizedMigrationStatus(definition: Record<string, unknown>): string {
  const normalized = toNonEmptyStringOrUndefined(definition.status)?.toLowerCase();
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
    await writeSettings(pmRoot, settings, "item_format:auto_select_default");
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
async function runAndClearAfterCommandHooks(outcome: { ok: boolean; error?: string }): Promise<void> {
  const telemetryRuntime = activeTelemetryCommandContext;
  activeTelemetryCommandContext = null;
  await finishTelemetryCommand(telemetryRuntime, {
    ok: outcome.ok,
    error: outcome.error,
    result: getActiveCommandResult(),
  });

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
    setActiveExtensionServices({ overrides: [] });
    return;
  }

  const pmRoot = resolvePmRoot(process.cwd(), bootstrapGlobalOptions.path);
  const snapshot = await loadRuntimeExtensionSnapshot(pmRoot);
  if (!snapshot) {
    activeRuntimeExtensionCommandDescriptors = new Map<string, ExtensionCommandHelpDescriptor>();
    setActiveExtensionServices({ overrides: [] });
    return;
  }
  // Ensure usage/help/error formatting overrides are available even when parse
  // errors occur before preAction hooks initialize full runtime extension state.
  setActiveExtensionServices(snapshot.services);
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

const CLI_VERSION = resolveCliVersion();

const program = new Command();
program
  .name("pm")
  .description("Universal, flexible, extensible, agent-optimized project management CLI for any project or programming language.")
  .version(CLI_VERSION)
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
  activeTelemetryCommandContext = null;
  clearActiveExtensionHooks();
  clearResolvedGlobalOptions(actionCommand);
  const bootstrapGlobalOptions = getGlobalOptions(actionCommand);
  const commandPath = getCommandPath(actionCommand);
  let commandArgs = actionCommand.args.map(String);
  let commandOptions = extractCommandScopedOptions(actionCommand, commandArgs);
  let globalOptions = { ...bootstrapGlobalOptions };
  await maybeRunFirstUseTelemetryPrompt(commandPath, globalOptions);
  const fallbackPmRoot = resolvePmRoot(process.cwd(), bootstrapGlobalOptions.path);
  const runtimeExtensions = await maybeLoadRuntimeExtensions(actionCommand);
  if (!runtimeExtensions) {
    activeTelemetryCommandContext = await startTelemetryCommand({
      command: commandPath,
      pm_version: CLI_VERSION,
      args: commandArgs,
      options: commandOptions,
      global: globalOptions,
      pm_root: fallbackPmRoot,
    });
    sentrySetCommandContext(commandPath, commandArgs, commandOptions);
    sentryStartCommandSpan(commandPath);
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
  activeTelemetryCommandContext = await startTelemetryCommand({
    command: commandPath,
    pm_version: CLI_VERSION,
    args: commandArgs,
    options: commandOptions,
    global: globalOptions,
    pm_root: runtimeExtensions.pmRoot,
  });
  sentrySetCommandContext(commandPath, commandArgs, commandOptions);
  sentryStartCommandSpan(commandPath);

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
  sentryFinishCommandSpan(true);
  await runAndClearAfterCommandHooks({ ok: true });
});

registerSetupCommands(program);
registerListQueryCommands(program);
registerMutationCommands(program);
registerOperationCommands(program);

attachRichHelpText(program, normalizeLegacyExtensionActionSyntax(process.argv.slice(2)));

interface CommanderUsageContext extends CommanderGuidanceContext {
  message: string;
  commandName: string | undefined;
  allowedTypes: string;
}

function collectRuntimeCommandPaths(root: Command): string[] {
  const commandPaths = new Set<string>();
  const queue: Command[] = [...root.commands];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }
    const normalizedPath = normalizeHelpCommandPath(getCommandPath(current));
    const hasInternalSegment = normalizedPath.split(" ").some((segment) => segment.startsWith("_"));
    if (normalizedPath.length > 0 && !hasInternalSegment) {
      commandPaths.add(normalizedPath);
    }
    queue.push(...current.commands);
  }
  for (const descriptorPath of activeRuntimeExtensionCommandDescriptors.keys()) {
    const normalizedPath = normalizeHelpCommandPath(descriptorPath);
    const hasInternalSegment = normalizedPath.split(" ").some((segment) => segment.startsWith("_"));
    if (normalizedPath.length > 0 && !hasInternalSegment) {
      commandPaths.add(normalizedPath);
    }
  }
  return [...commandPaths].sort((left, right) => left.localeCompare(right));
}

function scoreCommandPathMatch(commandPath: string, queryToken: string): number {
  const normalizedPath = commandPath.trim().toLowerCase();
  const normalizedToken = queryToken.trim().toLowerCase();
  if (normalizedToken.length === 0) {
    return Number.POSITIVE_INFINITY;
  }
  const pathSegments = normalizedPath.split(" ");
  if (normalizedPath === normalizedToken) {
    return 0;
  }
  if (pathSegments.includes(normalizedToken)) {
    return 1;
  }
  if (pathSegments.some((segment) => segment.startsWith(normalizedToken))) {
    return 2;
  }
  if (normalizedPath.includes(normalizedToken)) {
    return 3;
  }
  return Number.POSITIVE_INFINITY;
}

function buildUnknownCommandGuidanceFromRuntime(rawMessage: string, root: Command): CommanderGuidanceContext | undefined {
  const unknownCommandMatch = rawMessage.match(/unknown command '([^']+)'/i);
  if (!unknownCommandMatch || typeof unknownCommandMatch[1] !== "string") {
    return undefined;
  }
  const normalizedUnknown = normalizeHelpCommandPath(unknownCommandMatch[1]);
  if (normalizedUnknown.length === 0) {
    return undefined;
  }
  const commandPaths = collectRuntimeCommandPaths(root);
  if (commandPaths.length === 0) {
    return undefined;
  }

  const primaryToken = normalizedUnknown.split(" ")[0] ?? normalizedUnknown;
  const rankedCandidates = commandPaths
    .map((commandPath) => {
      const directScore = scoreCommandPathMatch(commandPath, normalizedUnknown);
      const fallbackScore =
        primaryToken !== normalizedUnknown ? scoreCommandPathMatch(commandPath, primaryToken) : Number.POSITIVE_INFINITY;
      const score = Math.min(directScore, fallbackScore);
      return { commandPath, score };
    })
    .filter((entry) => Number.isFinite(entry.score))
    .sort((left, right) => {
      if (left.score !== right.score) {
        return left.score - right.score;
      }
      return left.commandPath.localeCompare(right.commandPath);
    })
    .map((entry) => entry.commandPath);

  const fallbackTopLevel = [...new Set(commandPaths.map((commandPath) => commandPath.split(" ")[0]).filter((segment) => segment.length > 0))];
  fallbackTopLevel.sort((left, right) => left.localeCompare(right));
  const suggestedPaths = (rankedCandidates.length > 0 ? rankedCandidates : fallbackTopLevel).slice(0, 3);
  const examples = [...new Set(["pm --help", ...suggestedPaths.map((path) => `pm ${path} --help`)])];

  return {
    unknownCommandExamples: examples,
    unknownCommandNextSteps: [
      'Run "pm --help" to list commands available in this runtime, including active extensions.',
      "Use one of the suggested command paths above with --help to inspect valid flags and usage.",
    ],
  };
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
  const unknownCommandGuidance = buildUnknownCommandGuidanceFromRuntime(message, program);
  return {
    message,
    commandName,
    allowedTypes,
    ...(unknownCommandGuidance ?? {}),
  };
}

async function formatCommanderUsageMessage(error: unknown): Promise<string> {
  const usageContext = await resolveCommanderUsageContext(error);
  const { message, commandName, allowedTypes, unknownCommandExamples, unknownCommandNextSteps } = usageContext;
  const formatted = formatCommanderErrorForDisplay(message, commandName, allowedTypes, {
    unknownCommandExamples,
    unknownCommandNextSteps,
  });
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
    {
      unknownCommandExamples: usageContext.unknownCommandExamples,
      unknownCommandNextSteps: usageContext.unknownCommandNextSteps,
    },
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
    sentryFinishCommandSpan(false, describeUnknownError(error));
    await runAndClearAfterCommandHooks({
      ok: false,
      error: describeUnknownError(error),
    });
    const bootstrapGlobal = parseBootstrapGlobalOptions(invocationArgv);
    const jsonErrors = bootstrapGlobal.json;
    if (!bootstrapGlobal.noExtensions) {
      const bootstrapPmRoot = resolvePmRoot(process.cwd(), bootstrapGlobal.path);
      const bootstrapSnapshot = await loadRuntimeExtensionSnapshot(bootstrapPmRoot);
      setActiveExtensionServices(bootstrapSnapshot?.services ?? { overrides: [] });
    }
    if (error instanceof PmCliError) {
      sentryCaptureCliError(error);
      if (jsonErrors) {
        printError(JSON.stringify(formatPmCliErrorForJson(error.message, error.exitCode, error.context), null, 2));
      } else {
        printError(formatPmCliErrorForDisplay(error.message, error.context));
      }
      await sentryFlush();
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

    sentryCaptureCliError(error);
    const message = describeUnknownError(error);
    if (jsonErrors) {
      printError(JSON.stringify(formatUnknownErrorForJson(message, EXIT_CODE.GENERIC_FAILURE), null, 2));
    } else {
      printError(message);
    }
    await sentryFlush();
    process.exitCode = EXIT_CODE.GENERIC_FAILURE;
  }
}

void main();
