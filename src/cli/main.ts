#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import {
  runAppend,
  runActivity,
  runClaim,
  runClose,
  runComments,
  runCreate,
  runDelete,
  runDocs,
  runFiles,
  runGet,
  runGc,
  runHealth,
  runHistory,
  runInit,
  runList,
  runSearch,
  runReindex,
  runRestore,
  runRelease,
  runStats,
  runTest,
  runTestAll,
  runUpdate,
  type CreateCommandOptions,
} from "./commands/index.js";
import {
  activateExtensions,
  clearActiveExtensionHooks,
  createEmptyExtensionCommandRegistry,
  createEmptyExtensionHookRegistry,
  createEmptyExtensionRendererRegistry,
  loadExtensions,
  runActiveCommandHandler,
  runAfterCommandHooks,
  runBeforeCommandHooks,
  setActiveCommandContext,
  setActiveExtensionCommands,
  setActiveExtensionHooks,
  setActiveExtensionRenderers,
  type ExtensionCommandRegistry,
  type ExtensionHookRegistry,
  type LoadedExtension,
  type RegisteredExtensionFlagDefinitions,
  type ExtensionRendererRegistry,
} from "../core/extensions/index.js";
import { pathExists } from "../core/fs/fs-utils.js";
import { refreshSearchArtifactsForMutation } from "../core/search/cache.js";
import { EXIT_CODE } from "../core/shared/constants.js";
import { PmCliError } from "../core/shared/errors.js";
import { printError, printResult } from "../core/output/output.js";
import { getSettingsPath, resolvePmRoot } from "../core/store/paths.js";
import { readSettings } from "../core/store/settings.js";
import type { GlobalOptions } from "../core/shared/command-types.js";
import { getEnabledBuiltInExtensions } from "../core/extensions/builtins.js";
import type { ItemStatus, PmSettings } from "../types/index.js";
import { parseLooseCommandOptions } from "./extension-command-options.js";

function collect(value: string, previous: string[] | undefined): string[] {
  const next = previous ?? [];
  next.push(value);
  return next;
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

function formatDynamicExtensionFlagHelpLine(definition: Record<string, unknown>): string | null {
  const longName = toNonEmptyFlagString(definition.long);
  if (!longName || !longName.startsWith("--") || longName.length < 3) {
    return null;
  }

  const shortName = toNonEmptyFlagString(definition.short);
  const shortPrefix = shortName && shortName.startsWith("-") && !shortName.startsWith("--") ? `${shortName}, ` : "";
  const valueName = toNonEmptyFlagString(definition.value_name);
  const valueSuffix = valueName ? ` <${valueName}>` : "";
  const description = toNonEmptyFlagString(definition.description) ?? "Extension-provided option.";
  return `${shortPrefix}${longName}${valueSuffix}  ${description}`;
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

function findDirectChildCommand(parent: Command, name: string): Command | null {
  return parent.commands.find((entry) => entry.name() === name) ?? null;
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

function parseBootstrapGlobalOptions(argv: string[]): { path?: string; noExtensions: boolean } {
  let pathValue: string | undefined;
  let noExtensions = false;
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
  };
}

interface ActiveExtensionHookContext {
  hooks: ExtensionHookRegistry;
  commandName: string;
  commandArgs: string[];
  pmRoot: string;
  profileEnabled: boolean;
  migrationBlockers: MandatoryMigrationBlocker[];
}

let activeExtensionHookContext: ActiveExtensionHookContext | null = null;

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
  clearActiveExtensionHooks();
  if (!runtime) {
    return;
  }

  const hookWarnings = await runAfterCommandHooks(runtime.hooks, {
    command: runtime.commandName,
    args: runtime.commandArgs,
    pm_root: runtime.pmRoot,
    ok: outcome.ok,
    error: outcome.error,
  });
  if (runtime.profileEnabled && hookWarnings.length > 0) {
    printError(`profile:extensions hook_warnings=${formatHookWarnings(hookWarnings)}`);
  }
}

async function maybeLoadRuntimeExtensions(
  command: Command,
): Promise<
  {
    hooks: ExtensionHookRegistry;
    commands: ExtensionCommandRegistry;
    renderers: ExtensionRendererRegistry;
    pmRoot: string;
    migrationBlockers: MandatoryMigrationBlocker[];
  } | null
> {
  const globalOptions = getGlobalOptions(command);
  if (globalOptions.noExtensions) {
    return null;
  }

  const pmRoot = resolvePmRoot(process.cwd(), globalOptions.path);
  const settingsPath = getSettingsPath(pmRoot);
  if (!(await pathExists(settingsPath))) {
    return null;
  }

  try {
    const settings = await readSettings(pmRoot);
    const loadResult = await loadExtensions({
      pmRoot,
      settings,
      cwd: process.cwd(),
      noExtensions: globalOptions.noExtensions,
    });
    const loadedWithBuiltins: LoadedExtension[] = [...getEnabledBuiltInExtensions(settings), ...loadResult.loaded];
    const activationResult = await activateExtensions({
      ...loadResult,
      loaded: loadedWithBuiltins,
    });
    if (globalOptions.profile) {
      printError(
        `profile:extensions loaded=${loadedWithBuiltins.length} failed=${loadResult.failed.length} warnings=${loadResult.warnings.length} activation_failed=${activationResult.failed.length} hook_counts=before:${activationResult.hook_counts.before_command}|after:${activationResult.hook_counts.after_command}|write:${activationResult.hook_counts.on_write}|read:${activationResult.hook_counts.on_read}|index:${activationResult.hook_counts.on_index} command_overrides=${activationResult.command_override_count} command_handlers=${activationResult.command_handler_count} renderer_overrides=${activationResult.renderer_override_count}`,
      );
      if (activationResult.warnings.length > 0) {
        printError(`profile:extensions activation_warnings=${formatHookWarnings(activationResult.warnings)}`);
      }
    }
    const migrationBlockers = collectMandatoryMigrationBlockers(activationResult.registrations.migrations);
    return {
      hooks: activationResult.hooks,
      commands: activationResult.commands,
      renderers: activationResult.renderers,
      pmRoot,
      migrationBlockers,
    };
  } catch (error: unknown) {
    if (globalOptions.profile) {
      const message = error instanceof Error ? error.message : String(error);
      printError(`profile:extensions load_error=${message}`);
    }
    return {
      hooks: createEmptyExtensionHookRegistry(),
      commands: createEmptyExtensionCommandRegistry(),
      renderers: createEmptyExtensionRendererRegistry(),
      pmRoot,
      migrationBlockers: [],
    };
  }
}

async function runRequiredExtensionCommand(
  command: Command,
  options: Record<string, unknown>,
  globalOptions: GlobalOptions,
): Promise<unknown> {
  const commandPath = getCommandPath(command);
  const extensionCommandResult = await runActiveCommandHandler({
    command: commandPath,
    args: command.args.map(String),
    options,
    global: globalOptions,
    pm_root: resolvePmRoot(process.cwd(), globalOptions.path),
  });
  if (globalOptions.profile && extensionCommandResult.warnings.length > 0) {
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
  return extensionCommandResult.result;
}

async function registerDynamicExtensionCommandPaths(rootProgram: Command): Promise<void> {
  const bootstrapGlobalOptions = parseBootstrapGlobalOptions(process.argv.slice(2));
  if (bootstrapGlobalOptions.noExtensions) {
    return;
  }

  const pmRoot = resolvePmRoot(process.cwd(), bootstrapGlobalOptions.path);
  const settingsPath = getSettingsPath(pmRoot);
  if (!(await pathExists(settingsPath))) {
    return;
  }

  let settings: PmSettings;
  try {
    settings = await readSettings(pmRoot);
  } catch {
    return;
  }

  let commandHandlers: string[];
  let commandFlagHelp: Map<string, string>;
  try {
    const loadResult = await loadExtensions({
      pmRoot,
      settings,
      cwd: process.cwd(),
      noExtensions: false,
    });
    const loadedWithBuiltins: LoadedExtension[] = [...getEnabledBuiltInExtensions(settings), ...loadResult.loaded];
    const activationResult = await activateExtensions({
      ...loadResult,
      loaded: loadedWithBuiltins,
    });
    commandHandlers = [...new Set(activationResult.commands.handlers.map((entry) => normalizeExtensionCommandPath(entry.command)))]
      .filter((entry) => entry.length > 0)
      .sort((left, right) => left.localeCompare(right));
    commandFlagHelp = collectDynamicExtensionFlagHelpByCommand(activationResult.registrations.flags);
  } catch {
    return;
  }

  for (const commandPath of commandHandlers) {
    const pathParts = commandPath.split(" ").filter((part) => part.length > 0);
    if (pathParts.length === 0) {
      continue;
    }
    if (findCommandByPath(rootProgram, pathParts)) {
      continue;
    }

    const dynamicCommand = ensureCommandPath(rootProgram, pathParts);
    if (!dynamicCommand) {
      continue;
    }
    const flagHelp = commandFlagHelp.get(commandPath);
    if (flagHelp) {
      dynamicCommand.addHelpText("after", flagHelp);
    }

    dynamicCommand
      .allowUnknownOption(true)
      .allowExcessArguments(true)
      .action(async (_options: Record<string, unknown>, command) => {
        const globalOptions = getGlobalOptions(command);
        const startedAt = Date.now();
        const looseOptions = parseLooseCommandOptions(command.args.map(String));
        const result = await runRequiredExtensionCommand(command, looseOptions, globalOptions);
        printResult(result, globalOptions);
        if (globalOptions.profile) {
          printError(`profile:command=${commandPath} took_ms=${Date.now() - startedAt}`);
        }
      });
  }
}

function normalizeCreateOptions(commandOptions: Record<string, unknown>): CreateCommandOptions {
  const estimatedMinutes =
    (typeof commandOptions.estimate === "string" ? commandOptions.estimate : undefined) ??
    (typeof commandOptions.estimatedMinutes === "string" ? commandOptions.estimatedMinutes : undefined);
  if (estimatedMinutes === undefined) {
    throw new PmCliError("Missing required option --estimate/--estimated-minutes", EXIT_CODE.USAGE);
  }

  const requiredString = (key: string, display: string): string => {
    const value = commandOptions[key];
    if (typeof value !== "string") {
      throw new PmCliError(`Missing required option ${display}`, EXIT_CODE.USAGE);
    }
    return value;
  };

  const requiredRepeatable = (key: string, display: string): string[] => {
    const value = commandOptions[key];
    if (!Array.isArray(value) || value.length === 0) {
      throw new PmCliError(`Missing required option ${display} (use 'none' for explicit empty)`, EXIT_CODE.USAGE);
    }
    return value as string[];
  };

  return {
    title: requiredString("title", "--title"),
    description: requiredString("description", "--description"),
    type: requiredString("type", "--type"),
    status: requiredString("status", "--status"),
    priority: requiredString("priority", "--priority"),
    tags: requiredString("tags", "--tags"),
    body: requiredString("body", "--body"),
    deadline: requiredString("deadline", "--deadline"),
    estimatedMinutes,
    acceptanceCriteria:
      (typeof commandOptions.acceptanceCriteria === "string" ? commandOptions.acceptanceCriteria : undefined) ??
      requiredString("ac", "--acceptance-criteria/--ac"),
    author: requiredString("author", "--author"),
    message: requiredString("message", "--message"),
    assignee: requiredString("assignee", "--assignee"),
    dep: requiredRepeatable("dep", "--dep"),
    comment: requiredRepeatable("comment", "--comment"),
    note: requiredRepeatable("note", "--note"),
    learning: requiredRepeatable("learning", "--learning"),
    file: requiredRepeatable("file", "--file"),
    test: requiredRepeatable("test", "--test"),
    doc: requiredRepeatable("doc", "--doc"),
  };
}

function normalizeUpdateOptions(commandOptions: Record<string, unknown>): Record<string, unknown> {
  const estimatedMinutes =
    (typeof commandOptions.estimate === "string" ? commandOptions.estimate : undefined) ??
    (typeof commandOptions.estimatedMinutes === "string" ? commandOptions.estimatedMinutes : undefined);

  return {
    description: typeof commandOptions.description === "string" ? commandOptions.description : undefined,
    status: typeof commandOptions.status === "string" ? commandOptions.status : undefined,
    priority: typeof commandOptions.priority === "string" ? commandOptions.priority : undefined,
    type: typeof commandOptions.type === "string" ? commandOptions.type : undefined,
    tags: typeof commandOptions.tags === "string" ? commandOptions.tags : undefined,
    deadline: typeof commandOptions.deadline === "string" ? commandOptions.deadline : undefined,
    estimatedMinutes,
    acceptanceCriteria:
      (typeof commandOptions.acceptanceCriteria === "string" ? commandOptions.acceptanceCriteria : undefined) ??
      (typeof commandOptions.ac === "string" ? commandOptions.ac : undefined),
    author: typeof commandOptions.author === "string" ? commandOptions.author : undefined,
    message: typeof commandOptions.message === "string" ? commandOptions.message : undefined,
    force: Boolean(commandOptions.force),
    assignee: typeof commandOptions.assignee === "string" ? commandOptions.assignee : undefined,
  };
}

function normalizeListOptions(options: Record<string, unknown>): Record<string, string | undefined> {
  return {
    type: typeof options.type === "string" ? options.type : undefined,
    tag: typeof options.tag === "string" ? options.tag : undefined,
    priority: typeof options.priority === "string" ? options.priority : undefined,
    deadlineBefore: typeof options.deadlineBefore === "string" ? options.deadlineBefore : undefined,
    deadlineAfter: typeof options.deadlineAfter === "string" ? options.deadlineAfter : undefined,
    limit: typeof options.limit === "string" ? options.limit : undefined,
  };
}

function normalizeSearchOptions(options: Record<string, unknown>): Record<string, string | boolean | undefined> {
  return {
    mode: typeof options.mode === "string" ? options.mode : undefined,
    includeLinked: options.includeLinked === true ? true : undefined,
    type: typeof options.type === "string" ? options.type : undefined,
    tag: typeof options.tag === "string" ? options.tag : undefined,
    priority: typeof options.priority === "string" ? options.priority : undefined,
    deadlineBefore: typeof options.deadlineBefore === "string" ? options.deadlineBefore : undefined,
    deadlineAfter: typeof options.deadlineAfter === "string" ? options.deadlineAfter : undefined,
    limit: typeof options.limit === "string" ? options.limit : undefined,
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
  .description("Agent-friendly, git-native project management CLI.")
  .version(resolveCliVersion())
  .showHelpAfterError()
  .allowExcessArguments(false)
  .allowUnknownOption(false)
  .option("--json", "Output JSON instead of TOON")
  .option("--quiet", "Suppress stdout output")
  .option("--path <dir>", "Override PM path for this command")
  .option("--no-extensions", "Disable extension loading")
  .option("--profile", "Print deterministic timing diagnostics")
  .exitOverride();

program.hook("preAction", async (_thisCommand, actionCommand) => {
  activeExtensionHookContext = null;
  clearActiveExtensionHooks();
  const runtimeExtensions = await maybeLoadRuntimeExtensions(actionCommand);
  if (!runtimeExtensions) {
    return;
  }

  const globalOptions = getGlobalOptions(actionCommand);
  const commandPath = getCommandPath(actionCommand);
  const commandArgs = actionCommand.args.map(String);
  activeExtensionHookContext = {
    hooks: runtimeExtensions.hooks,
    commandName: commandPath,
    commandArgs,
    pmRoot: runtimeExtensions.pmRoot,
    profileEnabled: Boolean(globalOptions.profile),
    migrationBlockers: runtimeExtensions.migrationBlockers,
  };
  setActiveExtensionHooks(runtimeExtensions.hooks);
  setActiveExtensionCommands(runtimeExtensions.commands);
  setActiveExtensionRenderers(runtimeExtensions.renderers);
  setActiveCommandContext({
    command: commandPath,
    args: commandArgs,
    pm_root: runtimeExtensions.pmRoot,
  });

  const hookWarnings = await runBeforeCommandHooks(runtimeExtensions.hooks, {
    command: commandPath,
    args: commandArgs,
    pm_root: runtimeExtensions.pmRoot,
  });
  if (globalOptions.profile && hookWarnings.length > 0) {
    printError(`profile:extensions hook_warnings=${formatHookWarnings(hookWarnings)}`);
  }
  enforceMandatoryMigrationWriteGate(
    commandPath,
    actionCommand.optsWithGlobals(),
    runtimeExtensions.migrationBlockers,
  );
});

program.hook("postAction", async () => {
  await runAndClearAfterCommandHooks({ ok: true });
});

program
  .command("init")
  .argument("[prefix]", "Optional id prefix")
  .description("Initialize .agents/pm storage and settings.")
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
  .command("create")
  .description("Create a new item with deterministic front matter and history entry.")
  .requiredOption("--title, -t <value>", "Item title")
  .requiredOption("--description, -d <value>", "Item description (allow empty string)")
  .requiredOption("--type <value>", "Item type: Epic|Feature|Task|Chore|Issue")
  .requiredOption("--status, -s <value>", "Item status")
  .requiredOption("--priority, -p <value>", "Priority 0..4")
  .requiredOption("--tags <value>", "Comma-separated tags, or 'none'")
  .requiredOption("--body, -b <value>", "Item markdown body (allow empty string)")
  .requiredOption("--deadline <value>", "ISO deadline, relative +6h/+1d/+2w, or none")
  .requiredOption("--estimate, --estimated-minutes <value>", "Estimated minutes, or none")
  .option("--acceptance-criteria <value>", "Acceptance criteria (allow empty string)")
  .option("--ac <value>", "Alias for --acceptance-criteria")
  .requiredOption("--author <value>", "Mutation author, or none")
  .requiredOption("--message <value>", "History message (allow empty string)")
  .requiredOption("--assignee <value>", "Item assignee, or none")
  .option("--dep <value>", "Seed dependency entry (required; use none for empty)", collect)
  .option("--comment <value>", "Seed comment entry (required; use none for empty)", collect)
  .option("--note <value>", "Seed note entry (required; use none for empty)", collect)
  .option("--learning <value>", "Seed learning entry (required; use none for empty)", collect)
  .option("--file <value>", "Seed linked file entry (required; use none for empty)", collect)
  .option("--test <value>", "Seed linked test entry (required; use none for empty)", collect)
  .option("--doc <value>", "Seed linked doc entry (required; use none for empty)", collect)
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

function registerListCommand(name: string, description: string, status?: ItemStatus): void {
  program
    .command(name)
    .description(description)
    .option("--type <value>", "Filter by item type")
    .option("--tag <value>", "Filter by tag")
    .option("--priority <value>", "Filter by priority")
    .option("--deadline-before <value>", "Filter by deadline upper bound")
    .option("--deadline-after <value>", "Filter by deadline lower bound")
    .option("--limit <n>", "Limit returned item count")
    .action(async (options: Record<string, unknown>, command) => {
      const globalOptions = getGlobalOptions(command);
      const startedAt = Date.now();
      const result = await runList(status, normalizeListOptions(options), globalOptions);
      printResult(result, globalOptions);
      if (globalOptions.profile) {
        printError(`profile:command=${name} took_ms=${Date.now() - startedAt}`);
      }
    });
}

registerListCommand("list", "List items with optional filters.");
registerListCommand("list-all", "List all items with optional filters.");
registerListCommand("list-draft", "List draft items with optional filters.", "draft");
registerListCommand("list-open", "List open items with optional filters.", "open");
registerListCommand("list-in-progress", "List in-progress items with optional filters.", "in_progress");
registerListCommand("list-blocked", "List blocked items with optional filters.", "blocked");
registerListCommand("list-closed", "List closed items with optional filters.", "closed");
registerListCommand("list-canceled", "List canceled items with optional filters.", "canceled");

program
  .command("beads")
  .description("Built-in Beads extension commands.")
  .command("import")
  .description("Import Beads JSONL records as PM items.")
  .option("--file <path>", "Path to Beads JSONL file", ".beads/issues.jsonl")
  .option("--author <value>", "Mutation author")
  .option("--message <value>", "History message for import entries")
  .action(async (options: Record<string, unknown>, command) => {
    const globalOptions = getGlobalOptions(command);
    const startedAt = Date.now();
    const result = await runRequiredExtensionCommand(command, options, globalOptions);
    await invalidateSearchCachesForMutation(globalOptions, result);
    printResult(result, globalOptions);
    if (globalOptions.profile) {
      printError(`profile:command=beads import took_ms=${Date.now() - startedAt}`);
    }
  });

const todosCommand = program.command("todos").description("Built-in todos extension commands.");

todosCommand
  .command("import")
  .description("Import todos markdown files as PM items.")
  .option("--folder <path>", "Path to todos markdown folder", ".pi/todos")
  .option("--author <value>", "Mutation author")
  .option("--message <value>", "History message for import entries")
  .action(async (options: Record<string, unknown>, command) => {
    const globalOptions = getGlobalOptions(command);
    const startedAt = Date.now();
    const result = await runRequiredExtensionCommand(command, options, globalOptions);
    await invalidateSearchCachesForMutation(globalOptions, result);
    printResult(result, globalOptions);
    if (globalOptions.profile) {
      printError(`profile:command=todos import took_ms=${Date.now() - startedAt}`);
    }
  });

todosCommand
  .command("export")
  .description("Export PM items to todos markdown files.")
  .option("--folder <path>", "Path to todos markdown folder", ".pi/todos")
  .action(async (options: Record<string, unknown>, command) => {
    const globalOptions = getGlobalOptions(command);
    const startedAt = Date.now();
    const result = await runRequiredExtensionCommand(command, options, globalOptions);
    printResult(result, globalOptions);
    if (globalOptions.profile) {
      printError(`profile:command=todos export took_ms=${Date.now() - startedAt}`);
    }
  });

program
  .command("search")
  .argument("<keywords>", "Keyword query string")
  .description("Search items across keyword and optional semantic/hybrid modes.")
  .option(
    "--mode <value>",
    "Search mode: keyword|semantic|hybrid (default: hybrid when semantic config is available, else keyword)",
  )
  .option("--include-linked", "Include readable linked docs/files/tests content in keyword and hybrid lexical scoring")
  .option("--type <value>", "Filter by item type")
  .option("--tag <value>", "Filter by tag")
  .option("--priority <value>", "Filter by priority")
  .option("--deadline-before <value>", "Filter by deadline upper bound")
  .option("--deadline-after <value>", "Filter by deadline lower bound")
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
  .description("Rebuild deterministic search artifacts for keyword, semantic, and hybrid modes.")
  .option("--mode <value>", "Reindex mode: keyword|semantic|hybrid", "keyword")
  .action(async (options: Record<string, unknown>, command) => {
    const globalOptions = getGlobalOptions(command);
    const startedAt = Date.now();
    const result = await runReindex(
      {
        mode: typeof options.mode === "string" ? options.mode : undefined,
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
  .description("Get item details by id.")
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
  .description("Show append-only history entries for an item.")
  .action(async (id: string, options: Record<string, unknown>, command) => {
    const globalOptions = getGlobalOptions(command);
    const startedAt = Date.now();
    const result = await runHistory(
      id,
      {
        limit: typeof options.limit === "string" ? options.limit : undefined,
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
  .description("Show recent activity across all item history streams.")
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
  .description("Restore an item to a previous timestamp or version.")
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
  .description("Update item front-matter fields.")
  .option("--title, -t <value>", "Set title")
  .option("--description, -d <value>", "Set description")
  .option("--status, -s <value>", "Set status (use close command for closed)")
  .option("--priority, -p <value>", "Set priority")
  .option("--type <value>", "Set type")
  .option("--tags <value>", "Set comma-separated tags")
  .option("--deadline <value>", "Set deadline (or none)")
  .option("--estimate, --estimated-minutes <value>", "Set estimated minutes (or none)")
  .option("--acceptance-criteria <value>", "Set acceptance criteria (or none)")
  .option("--ac <value>", "Alias for --acceptance-criteria")
  .option("--author <value>", "Mutation author")
  .option("--message <value>", "Mutation message")
  .option("--assignee <value>", "Set assignee (or none)")
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
  .option("--force", "Force ownership override")
  .description("Close an item with required reason text.")
  .action(async (id: string, text: string, options: Record<string, unknown>, command) => {
    const globalOptions = getGlobalOptions(command);
    const startedAt = Date.now();
    const result = await runClose(
      id,
      text,
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
      printError(`profile:command=close took_ms=${Date.now() - startedAt}`);
    }
  });

program
  .command("delete")
  .argument("<id>", "Item id")
  .option("--author <value>", "Mutation author")
  .option("--message <value>", "History message")
  .option("--force", "Force ownership override")
  .description("Delete an item and append a delete history entry.")
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
  .requiredOption("--body <value>", "Text to append to body")
  .option("--author <value>", "Mutation author")
  .option("--message <value>", "Mutation message")
  .option("--force", "Force ownership override")
  .description("Append text to an item body.")
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
  .option("--add <text>", "Add one comment entry")
  .option("--limit <n>", "Return only latest n comments")
  .option("--author <value>", "Comment author")
  .option("--message <value>", "History message")
  .option("--force", "Force ownership override")
  .description("List or append comments for an item.")
  .action(async (id: string, options: Record<string, unknown>, command) => {
    const globalOptions = getGlobalOptions(command);
    const startedAt = Date.now();
    const result = await runComments(
      id,
      {
        add: typeof options.add === "string" ? options.add : undefined,
        limit: typeof options.limit === "string" ? options.limit : undefined,
        author: typeof options.author === "string" ? options.author : undefined,
        message: typeof options.message === "string" ? options.message : undefined,
        force: Boolean(options.force),
      },
      globalOptions,
    );
    if (typeof options.add === "string") {
      await invalidateSearchCachesForMutation(globalOptions, result);
    }
    printResult(result, globalOptions);
    if (globalOptions.profile) {
      printError(`profile:command=comments took_ms=${Date.now() - startedAt}`);
    }
  });

program
  .command("files")
  .argument("<id>", "Item id")
  .option("--add <value>", "Add linked file entry", collect)
  .option("--remove <value>", "Remove linked file by path", collect)
  .option("--author <value>", "Mutation author")
  .option("--message <value>", "History message")
  .option("--force", "Force ownership override")
  .description("List/add/remove linked files.")
  .action(async (id: string, options: Record<string, unknown>, command) => {
    const globalOptions = getGlobalOptions(command);
    const startedAt = Date.now();
    const addValues = Array.isArray(options.add) ? (options.add as string[]) : [];
    const removeValues = Array.isArray(options.remove) ? (options.remove as string[]) : [];
    const result = await runFiles(
      id,
      {
        add: addValues,
        remove: removeValues,
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
    if (globalOptions.profile) {
      printError(`profile:command=files took_ms=${Date.now() - startedAt}`);
    }
  });

program
  .command("docs")
  .argument("<id>", "Item id")
  .option("--add <value>", "Add linked doc entry", collect)
  .option("--remove <value>", "Remove linked doc by path", collect)
  .option("--author <value>", "Mutation author")
  .option("--message <value>", "History message")
  .option("--force", "Force ownership override")
  .description("List/add/remove linked docs.")
  .action(async (id: string, options: Record<string, unknown>, command) => {
    const globalOptions = getGlobalOptions(command);
    const startedAt = Date.now();
    const addValues = Array.isArray(options.add) ? (options.add as string[]) : [];
    const removeValues = Array.isArray(options.remove) ? (options.remove as string[]) : [];
    const result = await runDocs(
      id,
      {
        add: addValues,
        remove: removeValues,
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
    if (globalOptions.profile) {
      printError(`profile:command=docs took_ms=${Date.now() - startedAt}`);
    }
  });

program
  .command("test")
  .argument("<id>", "Item id")
  .option("--add <value>", "Add linked test entry", collect)
  .option("--remove <value>", "Remove linked test entry by command/path", collect)
  .option("--run", "Run linked test commands")
  .option("--timeout <seconds>", "Default run timeout in seconds")
  .option("--author <value>", "Mutation author")
  .option("--message <value>", "History message")
  .option("--force", "Force ownership override")
  .description("List/add/remove linked tests and optionally run them.")
  .action(async (id: string, options: Record<string, unknown>, command) => {
    const globalOptions = getGlobalOptions(command);
    const startedAt = Date.now();
    const addValues = Array.isArray(options.add) ? (options.add as string[]) : [];
    const removeValues = Array.isArray(options.remove) ? (options.remove as string[]) : [];
    const result = await runTest(
      id,
      {
        add: addValues,
        remove: removeValues,
        run: Boolean(options.run),
        timeout: typeof options.timeout === "string" ? options.timeout : undefined,
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
    if (globalOptions.profile) {
      printError(`profile:command=test took_ms=${Date.now() - startedAt}`);
    }
  });

program
  .command("test-all")
  .description("Run linked test commands across many items.")
  .option("--status <value>", "Filter items by status before running tests")
  .option("--timeout <seconds>", "Default run timeout in seconds")
  .action(async (options: Record<string, unknown>, command) => {
    const globalOptions = getGlobalOptions(command);
    const startedAt = Date.now();
    const result = await runTestAll(
      {
        status: typeof options.status === "string" ? options.status : undefined,
        timeout: typeof options.timeout === "string" ? options.timeout : undefined,
      },
      globalOptions,
    );
    printResult(result, globalOptions);
    if (result.failed > 0) {
      process.exitCode = EXIT_CODE.DEPENDENCY_FAILED;
    }
    if (globalOptions.profile) {
      printError(`profile:command=test-all took_ms=${Date.now() - startedAt}`);
    }
  });

program
  .command("stats")
  .description("Show deterministic tracker statistics summary.")
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
  .description("Show deterministic tracker health checks summary.")
  .action(async (_options, command) => {
    const globalOptions = getGlobalOptions(command);
    const startedAt = Date.now();
    const result = await runHealth(globalOptions);
    printResult(result, globalOptions);
    if (globalOptions.profile) {
      printError(`profile:command=health took_ms=${Date.now() - startedAt}`);
    }
  });

program
  .command("gc")
  .description("Collect optional cache artifacts and report deterministic summary.")
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
  .command("claim")
  .argument("<id>", "Item id")
  .option("--author <value>", "Mutation author")
  .option("--message <value>", "History message")
  .option("--force", "Force claim override")
  .description("Claim ownership of an item.")
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
  .description("Release ownership of an item.")
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

async function main(): Promise<void> {
  try {
    await registerDynamicExtensionCommandPaths(program);
    await program.parseAsync(process.argv);
  } catch (error: unknown) {
    await runAndClearAfterCommandHooks({
      ok: false,
      error: describeUnknownError(error),
    });
    if (error instanceof PmCliError) {
      printError(error.message);
      process.exit(error.exitCode);
    }

    if (typeof error === "object" && error !== null && "code" in error) {
      const code = (error as { code?: string }).code;
      if (code === "commander.helpDisplayed") {
        process.exit(EXIT_CODE.SUCCESS);
      }
      if (code === "commander.version") {
        process.exit(EXIT_CODE.SUCCESS);
      }
      if (code?.startsWith("commander.")) {
        const message = (error as { message?: string }).message ?? "Invalid command usage";
        printError(message.replace(/\(outputHelp\)/g, "").trim());
        process.exit(EXIT_CODE.USAGE);
      }
    }

    const message = describeUnknownError(error);
    printError(message);
    process.exit(EXIT_CODE.GENERIC_FAILURE);
  }
}

void main();
