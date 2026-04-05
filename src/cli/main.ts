#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import {
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
  runValidate,
  type CalendarOptions,
  type ContextOptions,
  type CreateCommandOptions,
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
  pushOptionalBooleanFlag(args, "--fail-on-context-mismatch", options.failOnContextMismatch);
  pushOptionalBooleanFlag(args, "--fail-on-skipped", options.failOnSkipped);
  pushOptionalBooleanFlag(args, "--fail-on-empty-test-run", options.failOnEmptyTestRun);
  pushOptionalBooleanFlag(args, "--require-assertions-for-pm", options.requireAssertionsForPm);
  pushOptionalValueFlag(args, "--author", options.author);
  pushOptionalValueFlag(args, "--message", options.message);
  pushOptionalBooleanFlag(args, "--force", options.force);
  return args;
}

function buildBackgroundTestAllCommandArgs(options: Record<string, unknown>): string[] {
  const args: string[] = ["test-all", "--json", "--progress"];
  pushOptionalValueFlag(args, "--status", options.status);
  pushOptionalValueFlag(args, "--timeout", options.timeout);
  pushRepeatableValueFlag(args, "--env-set", options.envSet);
  pushRepeatableValueFlag(args, "--env-clear", options.envClear);
  pushOptionalBooleanFlag(args, "--shared-host-safe", options.sharedHostSafe);
  pushOptionalValueFlag(args, "--pm-context", options.pmContext);
  pushOptionalBooleanFlag(args, "--fail-on-context-mismatch", options.failOnContextMismatch);
  pushOptionalBooleanFlag(args, "--fail-on-skipped", options.failOnSkipped);
  pushOptionalBooleanFlag(args, "--fail-on-empty-test-run", options.failOnEmptyTestRun);
  pushOptionalBooleanFlag(args, "--require-assertions-for-pm", options.requireAssertionsForPm);
  return args;
}

function getGlobalOptions(command: Command): GlobalOptions {
  const opts = command.optsWithGlobals();
  return {
    json: Boolean(opts.json),
    quiet: Boolean(opts.quiet),
    path: typeof opts.path === "string" ? opts.path : undefined,
    noExtensions: opts.extensions === false,
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
  json: boolean;
  quiet: boolean;
}

function parseBootstrapGlobalOptions(argv: string[]): BootstrapGlobalOptions {
  let pathValue: string | undefined;
  let noExtensions = false;
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
  const narrative = resolveHelpNarrative(commandPath, detailMode);
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
    options: buildHelpOptionSummaries(targetCommand),
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
    return [
      "",
      "Type-aware option policies:",
      "  pass --type <value> with --help to render required/disabled/hidden option policy details for that type.",
      `  active type values: ${allowed}`,
    ].join("\n");
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
  loadWarnings: string[];
  activationWarnings: string[];
  loadedCount: number;
  loadFailedCount: number;
  activationFailedCount: number;
}

let runtimeExtensionSnapshotCache: { key: string; snapshot: RuntimeExtensionSnapshot | null } | null = null;

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
        let globalOptions = getGlobalOptions(actionCommand);
        const commandPath = getCommandPath(actionCommand);
        let commandArgs = actionCommand.args.map(String);
        const activeRegistrations = getActiveExtensionRegistrations();
        const extensionFlagDefinitions = activeRegistrations
          ? collectExtensionFlagDefinitionsForCommand(activeRegistrations, commandPath)
          : [];
        let commandOptions = extractCommandScopedOptions(actionCommand, commandArgs, extensionFlagDefinitions);
        const pmRoot = resolvePmRoot(process.cwd(), globalOptions.path);
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
        actionCommand.args = [...commandArgs];
        const optionsArgIndex = actionArgs.length - 2;
        if (optionsArgIndex >= 0 && typeof actionArgs[optionsArgIndex] === "object" && actionArgs[optionsArgIndex] !== null) {
          actionArgs[optionsArgIndex] = commandOptions;
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
    return;
  }

  const pmRoot = resolvePmRoot(process.cwd(), bootstrapGlobalOptions.path);
  const snapshot = await loadRuntimeExtensionSnapshot(pmRoot);
  if (!snapshot) {
    return;
  }
  const typeRegistry = resolveItemTypeRegistry(snapshot.settings, snapshot.registrations);
  attachCreateUpdatePolicyHelpText(rootProgram, typeRegistry, process.argv.slice(2));

  for (const commandPath of snapshot.commandHandlers) {
    const pathParts = commandPath.split(" ").filter((part) => part.length > 0);
    if (pathParts.length === 0) {
      continue;
    }
    const existingCommand = findCommandByPath(rootProgram, pathParts);
    const flagHelp = snapshot.commandFlagHelp.get(commandPath);
    if (existingCommand) {
      if (flagHelp) {
        existingCommand.addHelpText("after", flagHelp);
      }
      continue;
    }

    const dynamicCommand = ensureCommandPath(rootProgram, pathParts);
    if (!dynamicCommand) {
      continue;
    }
    if (flagHelp) {
      dynamicCommand.addHelpText("after", flagHelp);
    }

    dynamicCommand
      .allowUnknownOption(true)
      .allowExcessArguments(true)
      .action(async (_options: Record<string, unknown>, command) => {
        const globalOptions = getGlobalOptions(command);
        const startedAt = Date.now();
        const extensionFlagDefinitions = collectExtensionFlagDefinitionsForCommand(snapshot.registrations, commandPath);
        const looseOptions = coerceLooseCommandOptionsWithFlagDefinitions(
          parseLooseCommandOptions(command.args.map(String)),
          extensionFlagDefinitions,
        );
        const result = await runRequiredExtensionCommand(command, looseOptions, globalOptions);
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
    throw new PmCliError("Missing required option --type", EXIT_CODE.USAGE);
  }

  return {
    title: readCreateString("title"),
    description: readCreateString("description"),
    type,
    template: readCreateString("template"),
    createMode: readCreateString("createMode"),
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
  };
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

  return {
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
    comment: readUpdateList("comment"),
    note: readUpdateList("note"),
    learning: readUpdateList("learning"),
    file: readUpdateList("file"),
    test: readUpdateList("test"),
    doc: readUpdateList("doc"),
    reminder: readUpdateList("reminder"),
    event: readUpdateList("event"),
    typeOption: readUpdateList("typeOption"),
  };
}

function normalizeListOptions(options: Record<string, unknown>): ListOptions {
  const readListString = (target: string): string | undefined =>
    readFirstStringFromCommanderOptions(
      options,
      LIST_COMMANDER_STRING_OPTION_CONTRACTS.find((entry) => entry.target === target) ?? {
        target,
        keys: [target],
      },
    );
  return {
    type: readListString("type"),
    tag: readListString("tag"),
    priority: readListString("priority"),
    deadlineBefore: readListString("deadlineBefore"),
    deadlineAfter: readListString("deadlineAfter"),
    assignee: readListString("assignee"),
    sprint: readListString("sprint"),
    release: readListString("release"),
    limit: readListString("limit"),
    offset: readListString("offset"),
    includeBody: options.includeBody === true ? true : undefined,
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

function normalizeSearchOptions(options: Record<string, unknown>): Record<string, string | boolean | undefined> {
  const readSearchString = (target: string): string | undefined =>
    readFirstStringFromCommanderOptions(
      options,
      SEARCH_COMMANDER_STRING_OPTION_CONTRACTS.find((entry) => entry.target === target) ?? {
        target,
        keys: [target],
      },
    );
  return {
    mode: readSearchString("mode"),
    includeLinked: options.includeLinked === true ? true : undefined,
    type: readSearchString("type"),
    tag: readSearchString("tag"),
    priority: readSearchString("priority"),
    deadlineBefore: readSearchString("deadlineBefore"),
    deadlineAfter: readSearchString("deadlineAfter"),
    limit: readSearchString("limit"),
  };
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
  return {
    view: readCalendarString("view"),
    date: readCalendarString("date"),
    from: readCalendarString("from"),
    to: readCalendarString("to"),
    past: options.past === true ? true : undefined,
    limit: readCalendarString("limit"),
    type: readCalendarString("type"),
    tag: readCalendarString("tag"),
    priority: readCalendarString("priority"),
    status: readCalendarString("status"),
    assignee: readCalendarString("assignee"),
    sprint: readCalendarString("sprint"),
    release: readCalendarString("release"),
    include: readCalendarString("include"),
    recurrenceLookaheadDays: readCalendarString("recurrenceLookaheadDays"),
    recurrenceLookbackDays: readCalendarString("recurrenceLookbackDays"),
    occurrenceLimit: readCalendarString("occurrenceLimit"),
    format: readCalendarString("format"),
  };
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
  return {
    date: readContextString("date"),
    from: readContextString("from"),
    to: readContextString("to"),
    past: options.past === true ? true : undefined,
    type: readContextString("type"),
    tag: readContextString("tag"),
    priority: readContextString("priority"),
    assignee: readContextString("assignee"),
    sprint: readContextString("sprint"),
    release: readContextString("release"),
    limit: readContextString("limit"),
    format: readContextString("format"),
  };
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
  .option("--explain", "Render extended rationale and examples in help output")
  .option("--profile", "Print deterministic timing diagnostics")
  .exitOverride();

program.hook("preAction", async (_thisCommand, actionCommand) => {
  activeExtensionHookContext = null;
  clearActiveExtensionHooks();
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
    "Config key for get|set: definition-of-done|item-format|history-missing-stream-policy|sprint-release-format-policy|parent-reference-policy|test-result-tracking",
  )
  .option("--criterion <text>", "Definition-of-Done criterion (repeatable for set)", collect)
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
      },
      globalOptions,
    );
    printResult(result, globalOptions);
    if (globalOptions.profile) {
      printError(`profile:command=config took_ms=${Date.now() - startedAt}`);
    }
  });

program
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
  .action(async (target: string | undefined, options: Record<string, unknown>, command) => {
    const globalOptions = getGlobalOptions(command);
    const startedAt = Date.now();
    const result = await runExtension(
      target,
      {
        install: options.install === true,
        uninstall: options.uninstall === true,
        explore: options.explore === true,
        manage: options.manage === true,
        doctor: options.doctor === true,
        adopt: options.adopt === true,
        adoptAll: options.adoptAll === true,
        activate: options.activate === true,
        deactivate: options.deactivate === true,
        project: options.project === true,
        local: options.local === true,
        global: options.global === true,
        gh: typeof options.gh === "string" ? options.gh : undefined,
        github: typeof options.github === "string" ? options.github : undefined,
        ref: typeof options.ref === "string" ? options.ref : undefined,
        detail: typeof options.detail === "string" ? options.detail : undefined,
        trace: options.trace === true,
        runtimeProbe: options.runtimeProbe === true,
        fixManagedState: options.fixManagedState === true,
        strictExit: Boolean(options.strictExit),
        failOnWarn: Boolean(options.failOnWarn),
      },
      globalOptions,
    );
    printResult(result, globalOptions);
    const strictExit = Boolean(options.strictExit) || Boolean(options.failOnWarn);
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
  .option("--tags <value>", "Template default comma-separated tags, or 'none'")
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
  .requiredOption("--type <value>", "Item type (built-ins plus any configured custom types)")
  .option("--template <value>", "Apply named create template defaults before explicit flags")
  .option("--create-mode <value>", "Create required-option policy mode: strict|progressive")
  .option("--create_mode <value>", "Alias for --create-mode")
  .option("--status, -s <value>", "Item status")
  .option("--priority, -p <value>", "Priority 0..4")
  .option("--tags <value>", "Comma-separated tags, or 'none'")
  .option("--body, -b <value>", "Item markdown body (allow empty string)")
  .option("--deadline <value>", "Deadline (ISO/date string or relative +6h/+1d/+2w/+6m, or none)")
  .option("--estimate, --estimated-minutes <value>", "Estimated minutes, or none")
  .option("--estimated_minutes <value>", "Alias for --estimated-minutes")
  .option("--acceptance-criteria <value>", "Acceptance criteria (allow empty string)")
  .option("--acceptance_criteria <value>", "Alias for --acceptance-criteria")
  .option("--ac <value>", "Alias for --acceptance-criteria")
  .option("--definition-of-ready <value>", "Definition of ready (allow empty string, or none)")
  .option("--definition_of_ready <value>", "Alias for --definition-of-ready")
  .option("--order <value>", "Planning order/rank integer, or none")
  .option("--rank <value>", "Alias for --order")
  .option("--goal <value>", "Goal identifier, or none")
  .option("--objective <value>", "Objective identifier, or none")
  .option("--value <value>", "Business value summary, or none")
  .option("--impact <value>", "Business impact summary, or none")
  .option("--outcome <value>", "Expected outcome summary, or none")
  .option("--why-now <value>", "Why-now rationale, or none")
  .option("--why_now <value>", "Alias for --why-now")
  .option("--author <value>", "Mutation author, or none")
  .option("--message <value>", "History message (allow empty string)")
  .option("--assignee <value>", "Item assignee, or none")
  .option("--parent <value>", "Parent item ID, or none")
  .option("--reviewer <value>", "Reviewer, or none")
  .option("--risk <value>", "Risk level: low|med|medium|high|critical, or none (med persists as medium)")
  .option("--confidence <value>", "Confidence level: 0..100|low|med|medium|high, or none (med persists as medium)")
  .option("--sprint <value>", "Sprint identifier, or none")
  .option("--release <value>", "Release identifier, or none")
  .option("--blocked-by <value>", "Blocked-by item ID or reason, or none")
  .option("--blocked_by <value>", "Alias for --blocked-by")
  .option("--blocked-reason <value>", "Blocked reason, or none")
  .option("--blocked_reason <value>", "Alias for --blocked-reason")
  .option("--unblock-note <value>", "Unblock rationale note, or none")
  .option("--unblock_note <value>", "Alias for --unblock-note")
  .option("--reporter <value>", "Issue reporter, or none")
  .option("--severity <value>", "Issue severity: low|med|medium|high|critical, or none (med persists as medium)")
  .option("--environment <value>", "Issue environment context, or none")
  .option("--repro-steps <value>", "Issue reproduction steps, or none")
  .option("--repro_steps <value>", "Alias for --repro-steps")
  .option("--resolution <value>", "Issue resolution summary, or none")
  .option("--expected-result <value>", "Issue expected behavior, or none")
  .option("--expected_result <value>", "Alias for --expected-result")
  .option("--actual-result <value>", "Issue observed behavior, or none")
  .option("--actual_result <value>", "Alias for --actual-result")
  .option("--affected-version <value>", "Affected version identifier, or none")
  .option("--affected_version <value>", "Alias for --affected-version")
  .option("--fixed-version <value>", "Fixed version identifier, or none")
  .option("--fixed_version <value>", "Alias for --fixed-version")
  .option("--component <value>", "Issue component ownership, or none")
  .option("--regression <value>", "Regression marker: true|false|1|0, or none")
  .option("--customer-impact <value>", "Customer impact summary, or none")
  .option("--customer_impact <value>", "Alias for --customer-impact")
  .option(
    "--dep <value>",
    "Seed dependency entry (key=value CSV, markdown key:value lines, or - for stdin; repeatable; use none for explicit empty)",
    collect,
  )
  .option(
    "--type-option <value>",
    "Type option key=value or key=<name>,value=<value> (also accepts key:value and markdown pairs; use - for stdin; repeatable; use none for explicit empty)",
    collect,
  )
  .option("--type_option <value>", "Alias for --type-option", collect)
  .option(
    "--reminder <value>",
    "Seed reminder entry at=<iso|relative>,text=<text> (also accepts markdown pairs and - for stdin; repeatable; use none for empty)",
    collect,
  )
  .option(
    "--event <value>",
    "Seed event entry start=<iso|relative>,end=<iso|relative>,title=<text>,all_day=<true|false>,recur_* fields (also accepts markdown pairs and - for stdin; repeatable; use none for empty)",
    collect,
  )
  .option(
    "--comment <value>",
    "Seed comment entry (text=<value> CSV/markdown pairs or - for stdin; repeatable; use none for explicit empty)",
    collect,
  )
  .option(
    "--note <value>",
    "Seed note entry (text=<value> CSV/markdown pairs or - for stdin; repeatable; use none for explicit empty)",
    collect,
  )
  .option(
    "--learning <value>",
    "Seed learning entry (text=<value> CSV/markdown pairs or - for stdin; repeatable; use none for explicit empty)",
    collect,
  )
  .option(
    "--file <value>",
    "Seed linked file entry (CSV/markdown pairs or - for stdin; repeatable; use none for explicit empty)",
    collect,
  )
  .option(
    "--test <value>",
    "Seed linked test entry (CSV/markdown pairs or - for stdin; repeatable; use none for explicit empty)",
    collect,
  )
  .option(
    "--doc <value>",
    "Seed linked doc entry (CSV/markdown pairs or - for stdin; repeatable; use none for explicit empty)",
    collect,
  )
  .action(async (options: Record<string, unknown>, command) => {
    const globalOptions = getGlobalOptions(command);
    const startedAt = Date.now();
    const normalized = normalizeCreateOptions(options);
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
    .option("--assignee <value>", "Filter by assignee (use 'none' for unassigned)")
    .option("--sprint <value>", "Filter by sprint")
    .option("--release <value>", "Filter by release")
    .option("--limit <n>", "Limit returned item count")
    .option("--offset <n>", "Skip the first n matching rows before limit is applied")
    .option("--include-body", "Include item body in each returned list row")
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
    .option("--type <value>", "Filter by item type")
    .option("--tag <value>", "Filter by tag")
    .option("--priority <value>", "Filter by priority")
    .option("--status <value>", "Filter by status")
    .option("--assignee <value>", "Filter by assignee (use 'none' for unassigned)")
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
    .option("--assignee <value>", "Filter by assignee (use 'none' for unassigned)")
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
  .argument("<keywords>", "Keyword query string")
  .description("Search items with keyword, semantic, or hybrid modes.")
  .option(
    "--mode <value>",
    "Search mode: keyword|semantic|hybrid (default: hybrid when semantic config or local Ollama auto-defaults are available, else keyword)",
  )
  .option("--include-linked", "Include readable linked docs/files/tests content in keyword and hybrid lexical scoring")
  .option("--type <value>", "Filter by item type")
  .option("--tag <value>", "Filter by tag")
  .option("--priority <value>", "Filter by priority")
  .option("--deadline-before <value>", "Filter by deadline upper bound (ISO/date string or relative)")
  .option("--deadline-after <value>", "Filter by deadline lower bound (ISO/date string or relative)")
  .option("--limit <n>", "Limit returned item count")
  .action(async (keywords: string, options: Record<string, unknown>, command) => {
    const globalOptions = getGlobalOptions(command);
    const startedAt = Date.now();
    const result = await runSearch(keywords, normalizeSearchOptions(options), globalOptions);
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
  .option("--limit <n>", "Return only the latest n activity entries")
  .description("Show recent activity across items.")
  .action(async (options: Record<string, unknown>, command) => {
    const globalOptions = getGlobalOptions(command);
    const startedAt = Date.now();
    const result = await runActivity(
      {
        limit: typeof options.limit === "string" ? options.limit : undefined,
      },
      globalOptions,
    );
    printResult(result, globalOptions);
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
  .option("--close-reason <value>", "Set close reason (or none)")
  .option("--close_reason <value>", "Alias for --close-reason")
  .option("--priority, -p <value>", "Set priority")
  .option("--type <value>", "Set type")
  .option("--tags <value>", "Set comma-separated tags")
  .option("--deadline <value>", "Set deadline (ISO/date string or relative, or none)")
  .option("--estimate, --estimated-minutes <value>", "Set estimated minutes (or none)")
  .option("--estimated_minutes <value>", "Alias for --estimated-minutes")
  .option("--acceptance-criteria <value>", "Set acceptance criteria (or none)")
  .option("--acceptance_criteria <value>", "Alias for --acceptance-criteria")
  .option("--ac <value>", "Alias for --acceptance-criteria")
  .option("--definition-of-ready <value>", "Set definition of ready (or none)")
  .option("--definition_of_ready <value>", "Alias for --definition-of-ready")
  .option("--order <value>", "Set planning order/rank integer (or none)")
  .option("--rank <value>", "Alias for --order")
  .option("--goal <value>", "Set goal identifier (or none)")
  .option("--objective <value>", "Set objective identifier (or none)")
  .option("--value <value>", "Set business value summary (or none)")
  .option("--impact <value>", "Set business impact summary (or none)")
  .option("--outcome <value>", "Set expected outcome summary (or none)")
  .option("--why-now <value>", "Set why-now rationale (or none)")
  .option("--why_now <value>", "Alias for --why-now")
  .option("--author <value>", "Mutation author")
  .option("--message <value>", "Mutation message")
  .option("--assignee <value>", "Set assignee (or none)")
  .option("--parent <value>", "Set parent item ID (or none)")
  .option("--reviewer <value>", "Set reviewer (or none)")
  .option("--risk <value>", "Set risk level: low|med|medium|high|critical (or none; med persists as medium)")
  .option("--confidence <value>", "Set confidence level: 0..100|low|med|medium|high (or none; med persists as medium)")
  .option("--sprint <value>", "Set sprint identifier (or none)")
  .option("--release <value>", "Set release identifier (or none)")
  .option("--blocked-by <value>", "Set blocked-by item ID or reason (or none)")
  .option("--blocked_by <value>", "Alias for --blocked-by")
  .option("--blocked-reason <value>", "Set blocked reason (or none)")
  .option("--blocked_reason <value>", "Alias for --blocked-reason")
  .option("--unblock-note <value>", "Set unblock rationale note (or none)")
  .option("--unblock_note <value>", "Alias for --unblock-note")
  .option("--reporter <value>", "Set issue reporter (or none)")
  .option("--severity <value>", "Set issue severity: low|med|medium|high|critical (or none; med persists as medium)")
  .option("--environment <value>", "Set issue environment context (or none)")
  .option("--repro-steps <value>", "Set issue reproduction steps (or none)")
  .option("--repro_steps <value>", "Alias for --repro-steps")
  .option("--resolution <value>", "Set issue resolution summary (or none)")
  .option("--expected-result <value>", "Set issue expected behavior (or none)")
  .option("--expected_result <value>", "Alias for --expected-result")
  .option("--actual-result <value>", "Set issue observed behavior (or none)")
  .option("--actual_result <value>", "Alias for --actual-result")
  .option("--affected-version <value>", "Set affected version identifier (or none)")
  .option("--affected_version <value>", "Alias for --affected-version")
  .option("--fixed-version <value>", "Set fixed version identifier (or none)")
  .option("--fixed_version <value>", "Alias for --fixed-version")
  .option("--component <value>", "Set issue component ownership (or none)")
  .option("--regression <value>", "Set regression marker: true|false|1|0 (or none)")
  .option("--customer-impact <value>", "Set customer impact summary (or none)")
  .option("--customer_impact <value>", "Alias for --customer-impact")
  .option(
    "--dep <value>",
    "Add dependency entries id=<id>,kind=<value>,author=<value>,created_at=<iso|now>,source_kind=<value> (repeatable; use none to clear all)",
    collect,
  )
  .option(
    "--dep-remove <value>",
    "Remove dependencies by id or id=<id>,kind=<value>,source_kind=<value> selectors (repeatable)",
    collect,
  )
  .option("--dep_remove <value>", "Alias for --dep-remove", collect)
  .option(
    "--comment <value>",
    "Append comment seed author=<value>,created_at=<iso|now>,text=<value> (also accepts markdown pairs and - for stdin; repeatable; use none to clear all comments)",
    collect,
  )
  .option(
    "--note <value>",
    "Append note seed author=<value>,created_at=<iso|now>,text=<value> (also accepts markdown pairs and - for stdin; repeatable; use none to clear all notes)",
    collect,
  )
  .option(
    "--learning <value>",
    "Append learning seed author=<value>,created_at=<iso|now>,text=<value> (also accepts markdown pairs and - for stdin; repeatable; use none to clear all learnings)",
    collect,
  )
  .option(
    "--file <value>",
    "Append linked file path=<value>,scope=<project|global>,note=<text> (also accepts markdown pairs and - for stdin; repeatable; use none to clear all files)",
    collect,
  )
  .option(
    "--test <value>",
    "Append linked test command=<value>,path=<value>,scope=<project|global>,timeout_seconds=<n>,pm_context_mode=<schema|tracker|auto> (also accepts markdown pairs and - for stdin; repeatable; use none to clear all tests)",
    collect,
  )
  .option(
    "--doc <value>",
    "Append linked doc path=<value>,scope=<project|global>,note=<text> (also accepts markdown pairs and - for stdin; repeatable; use none to clear all docs)",
    collect,
  )
  .option(
    "--reminder <value>",
    "Set reminders at=<iso|relative>,text=<text> (also accepts markdown pairs and - for stdin; repeatable; use none to clear)",
    collect,
  )
  .option(
    "--event <value>",
    "Set events start=<iso|relative>,end=<iso|relative>,title=<text>,all_day=<true|false>,recur_* fields (also accepts markdown pairs and - for stdin; repeatable; use none to clear)",
    collect,
  )
  .option(
    "--type-option <value>",
    "Set type options key=value or key=<name>,value=<value> (also accepts key:value and markdown pairs; use - for stdin; repeatable; use none to clear)",
    collect,
  )
  .option("--type_option <value>", "Alias for --type-option", collect)
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
  .option("--assignee <value>", "Filter by assignee (use none for unassigned)")
  .option("--limit-items <n>", "Limit returned item count")
  .option("--full-history", "Export full comment history rows and ignore --latest")
  .option("--latest <n>", "Return latest n comments per item (default: 1)")
  .description("Audit latest comments or full comment history across filtered items.")
  .action(async (options: Record<string, unknown>, command) => {
    const globalOptions = getGlobalOptions(command);
    const startedAt = Date.now();
    const result = await runCommentsAudit(
      {
        status: typeof options.status === "string" ? options.status : undefined,
        type: typeof options.type === "string" ? options.type : undefined,
        assignee: typeof options.assignee === "string" ? options.assignee : undefined,
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
  .description("Show dependency relationships for an item.")
  .action(async (id: string, options: Record<string, unknown>, command) => {
    const globalOptions = getGlobalOptions(command);
    const startedAt = Date.now();
    const result = await runDeps(
      id,
      {
        format: typeof options.format === "string" ? options.format : undefined,
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
  .option("--fail-on-context-mismatch", "Fail linked PM commands when context item counts differ")
  .option("--fail-on-skipped", "Treat skipped linked tests as dependency failures")
  .option(
    "--fail-on-empty-test-run",
    "Treat successful linked-test commands that report zero executed tests as failures",
  )
  .option("--require-assertions-for-pm", "Require assertion metadata for linked PM command tests")
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
        failOnContextMismatch: Boolean(options.failOnContextMismatch),
        failOnSkipped: Boolean(options.failOnSkipped),
        failOnEmptyTestRun: Boolean(options.failOnEmptyTestRun),
        requireAssertionsForPm: Boolean(options.requireAssertionsForPm),
        author: typeof options.author === "string" ? options.author : undefined,
        message: typeof options.message === "string" ? options.message : undefined,
        force: Boolean(options.force),
      },
      globalOptions,
    );
    if (addValues.length > 0 || removeValues.length > 0) {
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
  .option("--background", "Run linked tests in managed background mode")
  .option("--timeout <seconds>", "Default run timeout in seconds")
  .option("--progress", "Emit linked-test progress to stderr (always shown in TTY, opt-in for non-TTY)")
  .option("--env-set <value>", "Set environment variable(s) for linked-test runs (KEY=VALUE, repeatable)", collect)
  .option("--env-clear <value>", "Clear environment variable(s) for linked-test runs (NAME, repeatable)", collect)
  .option("--shared-host-safe", "Apply additive shared-host-safe runtime defaults for linked-test runs")
  .option("--pm-context <mode>", "PM linked-test context mode: schema|tracker|auto (default: schema)")
  .option("--fail-on-context-mismatch", "Fail linked PM commands when context item counts differ")
  .option("--fail-on-skipped", "Treat skipped linked tests as dependency failures")
  .option(
    "--fail-on-empty-test-run",
    "Treat successful linked-test commands that report zero executed tests as failures",
  )
  .option("--require-assertions-for-pm", "Require assertion metadata for linked PM command tests")
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
        timeout: typeof options.timeout === "string" ? options.timeout : undefined,
        progress: Boolean(options.progress),
        envSet: Array.isArray(options.envSet) ? (options.envSet as string[]) : [],
        envClear: Array.isArray(options.envClear) ? (options.envClear as string[]) : [],
        sharedHostSafe: Boolean(options.sharedHostSafe),
        pmContext: typeof options.pmContext === "string" ? options.pmContext : undefined,
        failOnContextMismatch: Boolean(options.failOnContextMismatch),
        failOnSkipped: Boolean(options.failOnSkipped),
        failOnEmptyTestRun: Boolean(options.failOnEmptyTestRun),
        requireAssertionsForPm: Boolean(options.requireAssertionsForPm),
      },
      globalOptions,
    );
    printResult(result, globalOptions);
    if (result.failed > 0 || result.fail_on_skipped_triggered === true) {
      process.exitCode = EXIT_CODE.DEPENDENCY_FAILED;
    }
    if (globalOptions.profile) {
      printError(`profile:command=test-all took_ms=${Date.now() - startedAt}`);
    }
  });

const testRunsCommand = program.command("test-runs").description("Manage background linked-test runs.");

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
  .option("--strict-exit", "Return non-zero exit when health warnings are present (ok=false)")
  .option("--fail-on-warn", "Alias for --strict-exit")
  .action(async (options: Record<string, unknown>, command) => {
    const globalOptions = getGlobalOptions(command);
    const startedAt = Date.now();
    const result = await runHealth(globalOptions, {
      strictDirectories: Boolean(options.strictDirectories),
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
  .description("Run standalone metadata, resolution, files, linked-command reference, and history drift validation checks.")
  .option("--check-metadata", "Run metadata completeness checks")
  .option("--metadata-profile <value>", "Select metadata validation profile for --check-metadata (core|strict|custom)")
  .option("--check-resolution", "Run closed-item resolution metadata checks")
  .option("--check-files", "Run linked-file and orphaned-file checks")
  .option("--check-command-references", "Run linked-command PM-ID reference checks")
  .option("--scan-mode <value>", "Select file candidate scan mode for --check-files (default|tracked-all|tracked-all-strict)")
  .option("--include-pm-internals", "Include PM storage internals in tracked-all candidate scans")
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
        checkFiles: Boolean(options.checkFiles),
        checkCommandReferences: Boolean(options.checkCommandReferences),
        scanMode: typeof options.scanMode === "string" ? options.scanMode : undefined,
        includePmInternals: Boolean(options.includePmInternals),
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
  .description("Clean optional cache artifacts and show a summary.")
  .action(async (_options, command) => {
    const globalOptions = getGlobalOptions(command);
    const startedAt = Date.now();
    const result = await runGc(globalOptions);
    printResult(result, globalOptions);
    if (globalOptions.profile) {
      printError(`profile:command=gc took_ms=${Date.now() - startedAt}`);
    }
  });

program
  .command("contracts")
  .description("Show machine-readable command and schema contracts for agents.")
  .option("--action <value>", "Filter tool schema branches to a specific action")
  .option("--command <value>", "Filter command-flag contracts to one command")
  .option("--schema-only", "Return schema-focused output only")
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
  .option("--force", "Force release override")
  .description("Release an item's active claim.")
  .action(async (id: string, options: Record<string, unknown>, command) => {
    const globalOptions = getGlobalOptions(command);
    const startedAt = Date.now();
    const result = await runRelease(id, Boolean(options.force), globalOptions, {
      author: typeof options.author === "string" ? options.author : undefined,
      message: typeof options.message === "string" ? options.message : undefined,
    });
    await invalidateSearchCachesForMutation(globalOptions, result);
    printResult(result, globalOptions);
    if (globalOptions.profile) {
      printError(`profile:command=release took_ms=${Date.now() - startedAt}`);
    }
  });

program
  .command("completion")
  .argument("<shell>", "Shell type: bash, zsh, or fish")
  .description("Generate shell completion for pm.")
  .action(async (shell: string, _options: Record<string, unknown>, command) => {
    const globalOptions = getGlobalOptions(command);
    const pmRoot = resolvePmRoot(process.cwd(), globalOptions.path);
    let completionTypes: string[] | undefined;
    let completionTags: string[] | undefined;
    if (await pathExists(getSettingsPath(pmRoot))) {
      const settings = await readSettings(pmRoot);
      const typeRegistry = resolveItemTypeRegistry(settings, getActiveExtensionRegistrations());
      completionTypes = typeRegistry.types;
      const items = await listAllFrontMatter(pmRoot, settings.item_format, typeRegistry.type_to_folder);
      completionTags = [...new Set(items.flatMap((item) => item.tags ?? []).map((tag) => tag.trim()).filter((tag) => tag.length > 0))]
        .sort((left, right) => left.localeCompare(right));
    }
    const result = runCompletion(shell, completionTypes, completionTags);
    if (globalOptions.json) {
      printResult(result, globalOptions);
    } else if (!globalOptions.quiet) {
      writeStdout(`${result.script}\n`);
    }
    if (globalOptions.profile) {
      printError(`profile:command=completion took_ms=0`);
    }
  });

attachRichHelpText(program, process.argv.slice(2));

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
  const bootstrapGlobal = parseBootstrapGlobalOptions(process.argv.slice(2));
  const commandName = parseBootstrapCommandName(process.argv.slice(2));
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
  try {
    await registerDynamicExtensionCommandPaths(program);
    wrapProgramActionsForExtensionHandlers(program);
    const renderedBootstrapJsonHelp = await maybeRenderBootstrapJsonHelp(program, process.argv.slice(2));
    if (renderedBootstrapJsonHelp) {
      return;
    }
    await program.parseAsync(process.argv);
  } catch (error: unknown) {
    await runAndClearAfterCommandHooks({
      ok: false,
      error: describeUnknownError(error),
    });
    const bootstrapGlobal = parseBootstrapGlobalOptions(process.argv.slice(2));
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
        const helpRequest = parseBootstrapHelpRequest(process.argv.slice(2));
        if (helpRequest.requested && !isKnownHelpCommandPath(program, helpRequest.commandPathTokens)) {
          const unknownToken = helpRequest.commandPathTokens[0] ?? parseBootstrapCommandName(process.argv.slice(2)) ?? "<command>";
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
