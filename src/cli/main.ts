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
  runCompletion,
  runConfig,
  runCreate,
  runDelete,
  runDocs,
  runFiles,
  runGet,
  runGc,
  runHealth,
  runHistory,
  runInit,
  runInstall,
  runList,
  runSearch,
  runReindex,
  runRestore,
  renderCalendarMarkdown,
  runRelease,
  resolveCalendarOutputFormat,
  runStats,
  runTest,
  runTestAll,
  runUpdate,
  type CalendarOptions,
  type CreateCommandOptions,
  type ListOptions,
} from "./commands/index.js";
import {
  activateExtensions,
  clearActiveExtensionHooks,
  createEmptyExtensionRegistrationRegistry,
  getActiveCommandResult,
  getActiveExtensionRegistrations,
  loadExtensions,
  runActiveCommandHandler,
  runAfterCommandHooks,
  runBeforeCommandHooks,
  setActiveCommandResult,
  setActiveCommandContext,
  setActiveExtensionCommands,
  setActiveExtensionHooks,
  setActiveExtensionRegistrations,
  setActiveExtensionRenderers,
  type ExtensionCommandRegistry,
  type ExtensionHookRegistry,
  type LoadedExtension,
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
import { printError, printResult } from "../core/output/output.js";
import { migrateItemFilesToFormat } from "../core/store/item-format-migration.js";
import { getSettingsPath, resolvePmRoot } from "../core/store/paths.js";
import { readSettings, readSettingsWithMetadata } from "../core/store/settings.js";
import type { GlobalOptions } from "../core/shared/command-types.js";
import { getEnabledBuiltInExtensions } from "../core/extensions/builtins.js";
import type { ItemStatus, PmSettings } from "../types/index.js";
import { parseLooseCommandOptions } from "./extension-command-options.js";
import { attachRichHelpText } from "./help-content.js";
import { formatCommanderErrorForDisplay, formatPmCliErrorForDisplay } from "./error-guidance.js";

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
    if (token.startsWith("--path=") || token === "--json" || token === "--quiet" || token === "--no-extensions" || token === "--profile") {
      continue;
    }
    if (token.startsWith("-")) {
      continue;
    }
    return token.trim().toLowerCase();
  }
  return undefined;
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
  globalOptions: GlobalOptions,
): Promise<void> {
  const decision = decideWriteGate(commandPath, options);
  if (!decision.isMutation) {
    return;
  }
  const pmRoot = resolvePmRoot(process.cwd(), globalOptions.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    return;
  }
  const { settings, metadata } = await readSettingsWithMetadata(pmRoot);
  if (!metadata.has_explicit_item_format) {
    throw new PmCliError(
      `Write command "${commandPath}" requires explicit item format selection before mutations. Run "pm config project set item-format --format toon" or "pm config project set item-format --format json_markdown".`,
      EXIT_CODE.CONFLICT,
    );
  }
  const typeRegistry = resolveItemTypeRegistry(settings, getActiveExtensionRegistrations());
  await migrateItemFilesToFormat(
    pmRoot,
    settings.item_format,
    "item_format:pre_mutation_sync",
    typeRegistry.type_to_folder,
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

function extractCommandScopedOptions(command: Command, commandArgs: string[]): Record<string, unknown> {
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
  return scoped;
}

function buildRuntimeExtensionSnapshotCacheKey(pmRoot: string): string {
  return `pm-root:${pmRoot}`;
}

function emitExtensionProfile(globalOptions: GlobalOptions, snapshot: RuntimeExtensionSnapshot): void {
  if (!globalOptions.profile) {
    return;
  }
  printError(
    `profile:extensions loaded=${snapshot.loadedCount} failed=${snapshot.loadFailedCount} warnings=${snapshot.loadWarnings.length} activation_failed=${snapshot.activationFailedCount} hook_counts=before:${snapshot.hooks.beforeCommand.length}|after:${snapshot.hooks.afterCommand.length}|write:${snapshot.hooks.onWrite.length}|read:${snapshot.hooks.onRead.length}|index:${snapshot.hooks.onIndex.length} command_overrides=${snapshot.commands.overrides.length} command_handlers=${snapshot.commands.handlers.length} renderer_overrides=${snapshot.renderers.overrides.length}`,
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
    const loadedWithBuiltins: LoadedExtension[] = [...getEnabledBuiltInExtensions(settings), ...loadResult.loaded];
    const activationResult = await activateExtensions({
      ...loadResult,
      loaded: loadedWithBuiltins,
    });
    const commandHandlers = [...new Set(activationResult.commands.handlers.map((entry) => normalizeExtensionCommandPath(entry.command)))]
      .filter((entry) => entry.length > 0)
      .sort((left, right) => left.localeCompare(right));
    const commandFlagHelp = collectDynamicExtensionFlagHelpByCommand(activationResult.registrations.flags);
    const snapshot: RuntimeExtensionSnapshot = {
      hooks: activationResult.hooks,
      commands: activationResult.commands,
      renderers: activationResult.renderers,
      registrations: activationResult.registrations,
      pmRoot,
      settings,
      commandHandlers,
      commandFlagHelp,
      loadWarnings: [...loadResult.warnings],
      activationWarnings: [...activationResult.warnings],
      loadedCount: loadedWithBuiltins.length,
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
  const commandArgs = command.args.map(String);
  const pmRoot = resolvePmRoot(process.cwd(), globalOptions.path);
  setActiveCommandResult(undefined);
  setActiveCommandContext({
    command: commandPath,
    args: commandArgs,
    options: { ...options },
    global: { ...globalOptions },
    pm_root: pmRoot,
  });
  const extensionCommandResult = await runActiveCommandHandler({
    command: commandPath,
    args: commandArgs,
    options,
    global: globalOptions,
    pm_root: pmRoot,
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
        const globalOptions = getGlobalOptions(actionCommand);
        const commandPath = getCommandPath(actionCommand);
        const commandArgs = actionCommand.args.map(String);
        const commandOptions = extractCommandScopedOptions(actionCommand, commandArgs);
        const pmRoot = resolvePmRoot(process.cwd(), globalOptions.path);
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
  const readStringOption = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      if (typeof commandOptions[key] === "string") {
        return commandOptions[key] as string;
      }
    }
    return undefined;
  };
  const estimatedMinutes =
    readStringOption("estimate", "estimatedMinutes", "estimated_minutes");
  const type = readStringOption("type");
  if (type === undefined) {
    throw new PmCliError("Missing required option --type", EXIT_CODE.USAGE);
  }

  return {
    title: readStringOption("title"),
    description: readStringOption("description"),
    type,
    status: readStringOption("status"),
    priority: readStringOption("priority"),
    tags: readStringOption("tags"),
    body: readStringOption("body"),
    deadline: readStringOption("deadline"),
    estimatedMinutes,
    acceptanceCriteria: readStringOption("acceptanceCriteria", "acceptance_criteria", "ac"),
    definitionOfReady: readStringOption("definitionOfReady", "definition_of_ready"),
    order: readStringOption("order"),
    rank: readStringOption("rank"),
    goal: readStringOption("goal"),
    objective: readStringOption("objective"),
    value: readStringOption("value"),
    impact: readStringOption("impact"),
    outcome: readStringOption("outcome"),
    whyNow: readStringOption("whyNow", "why_now"),
    author: readStringOption("author"),
    message: readStringOption("message"),
    assignee: readStringOption("assignee"),
    parent: readStringOption("parent"),
    reviewer: readStringOption("reviewer"),
    risk: readStringOption("risk"),
    confidence: readStringOption("confidence"),
    sprint: readStringOption("sprint"),
    release: readStringOption("release"),
    blockedBy: readStringOption("blockedBy", "blocked_by"),
    blockedReason: readStringOption("blockedReason", "blocked_reason"),
    unblockNote: readStringOption("unblockNote", "unblock_note"),
    reporter: readStringOption("reporter"),
    severity: readStringOption("severity"),
    environment: readStringOption("environment"),
    reproSteps: readStringOption("reproSteps", "repro_steps"),
    resolution: readStringOption("resolution"),
    expectedResult: readStringOption("expectedResult", "expected_result"),
    actualResult: readStringOption("actualResult", "actual_result"),
    affectedVersion: readStringOption("affectedVersion", "affected_version"),
    fixedVersion: readStringOption("fixedVersion", "fixed_version"),
    component: readStringOption("component"),
    regression: readStringOption("regression"),
    customerImpact: readStringOption("customerImpact", "customer_impact"),
    dep: Array.isArray(commandOptions.dep) ? (commandOptions.dep as string[]) : undefined,
    comment: Array.isArray(commandOptions.comment) ? (commandOptions.comment as string[]) : undefined,
    note: Array.isArray(commandOptions.note) ? (commandOptions.note as string[]) : undefined,
    learning: Array.isArray(commandOptions.learning) ? (commandOptions.learning as string[]) : undefined,
    file: Array.isArray(commandOptions.file) ? (commandOptions.file as string[]) : undefined,
    test: Array.isArray(commandOptions.test) ? (commandOptions.test as string[]) : undefined,
    doc: Array.isArray(commandOptions.doc) ? (commandOptions.doc as string[]) : undefined,
    reminder: Array.isArray(commandOptions.reminder) ? (commandOptions.reminder as string[]) : undefined,
    event: Array.isArray(commandOptions.event) ? (commandOptions.event as string[]) : undefined,
    typeOption: Array.isArray(commandOptions.typeOption)
      ? (commandOptions.typeOption as string[])
      : Array.isArray(commandOptions.type_option)
        ? (commandOptions.type_option as string[])
        : undefined,
  };
}

function normalizeUpdateOptions(commandOptions: Record<string, unknown>): Record<string, unknown> {
  const estimatedMinutes =
    (typeof commandOptions.estimate === "string" ? commandOptions.estimate : undefined) ??
    (typeof commandOptions.estimatedMinutes === "string" ? commandOptions.estimatedMinutes : undefined) ??
    (typeof commandOptions.estimated_minutes === "string" ? commandOptions.estimated_minutes : undefined);

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
      (typeof commandOptions.acceptance_criteria === "string" ? commandOptions.acceptance_criteria : undefined) ??
      (typeof commandOptions.ac === "string" ? commandOptions.ac : undefined),
    definitionOfReady:
      (typeof commandOptions.definitionOfReady === "string" ? commandOptions.definitionOfReady : undefined) ??
      (typeof commandOptions.definition_of_ready === "string" ? commandOptions.definition_of_ready : undefined),
    order: typeof commandOptions.order === "string" ? commandOptions.order : undefined,
    rank: typeof commandOptions.rank === "string" ? commandOptions.rank : undefined,
    goal: typeof commandOptions.goal === "string" ? commandOptions.goal : undefined,
    objective: typeof commandOptions.objective === "string" ? commandOptions.objective : undefined,
    value: typeof commandOptions.value === "string" ? commandOptions.value : undefined,
    impact: typeof commandOptions.impact === "string" ? commandOptions.impact : undefined,
    outcome: typeof commandOptions.outcome === "string" ? commandOptions.outcome : undefined,
    whyNow:
      (typeof commandOptions.whyNow === "string" ? commandOptions.whyNow : undefined) ??
      (typeof commandOptions.why_now === "string" ? commandOptions.why_now : undefined),
    author: typeof commandOptions.author === "string" ? commandOptions.author : undefined,
    message: typeof commandOptions.message === "string" ? commandOptions.message : undefined,
    force: Boolean(commandOptions.force),
    assignee: typeof commandOptions.assignee === "string" ? commandOptions.assignee : undefined,
    parent: typeof commandOptions.parent === "string" ? commandOptions.parent : undefined,
    reviewer: typeof commandOptions.reviewer === "string" ? commandOptions.reviewer : undefined,
    risk: typeof commandOptions.risk === "string" ? commandOptions.risk : undefined,
    confidence: typeof commandOptions.confidence === "string" ? commandOptions.confidence : undefined,
    sprint: typeof commandOptions.sprint === "string" ? commandOptions.sprint : undefined,
    release: typeof commandOptions.release === "string" ? commandOptions.release : undefined,
    blockedBy:
      (typeof commandOptions.blockedBy === "string" ? commandOptions.blockedBy : undefined) ??
      (typeof commandOptions.blocked_by === "string" ? commandOptions.blocked_by : undefined),
    blockedReason:
      (typeof commandOptions.blockedReason === "string" ? commandOptions.blockedReason : undefined) ??
      (typeof commandOptions.blocked_reason === "string" ? commandOptions.blocked_reason : undefined),
    unblockNote:
      (typeof commandOptions.unblockNote === "string" ? commandOptions.unblockNote : undefined) ??
      (typeof commandOptions.unblock_note === "string" ? commandOptions.unblock_note : undefined),
    reporter: typeof commandOptions.reporter === "string" ? commandOptions.reporter : undefined,
    severity: typeof commandOptions.severity === "string" ? commandOptions.severity : undefined,
    environment: typeof commandOptions.environment === "string" ? commandOptions.environment : undefined,
    reproSteps:
      (typeof commandOptions.reproSteps === "string" ? commandOptions.reproSteps : undefined) ??
      (typeof commandOptions.repro_steps === "string" ? commandOptions.repro_steps : undefined),
    resolution: typeof commandOptions.resolution === "string" ? commandOptions.resolution : undefined,
    expectedResult:
      (typeof commandOptions.expectedResult === "string" ? commandOptions.expectedResult : undefined) ??
      (typeof commandOptions.expected_result === "string" ? commandOptions.expected_result : undefined),
    actualResult:
      (typeof commandOptions.actualResult === "string" ? commandOptions.actualResult : undefined) ??
      (typeof commandOptions.actual_result === "string" ? commandOptions.actual_result : undefined),
    affectedVersion:
      (typeof commandOptions.affectedVersion === "string" ? commandOptions.affectedVersion : undefined) ??
      (typeof commandOptions.affected_version === "string" ? commandOptions.affected_version : undefined),
    fixedVersion:
      (typeof commandOptions.fixedVersion === "string" ? commandOptions.fixedVersion : undefined) ??
      (typeof commandOptions.fixed_version === "string" ? commandOptions.fixed_version : undefined),
    component: typeof commandOptions.component === "string" ? commandOptions.component : undefined,
    regression: typeof commandOptions.regression === "string" ? commandOptions.regression : undefined,
    customerImpact:
      (typeof commandOptions.customerImpact === "string" ? commandOptions.customerImpact : undefined) ??
      (typeof commandOptions.customer_impact === "string" ? commandOptions.customer_impact : undefined),
    reminder: Array.isArray(commandOptions.reminder) ? (commandOptions.reminder as string[]) : undefined,
    event: Array.isArray(commandOptions.event) ? (commandOptions.event as string[]) : undefined,
    typeOption: Array.isArray(commandOptions.typeOption)
      ? (commandOptions.typeOption as string[])
      : Array.isArray(commandOptions.type_option)
        ? (commandOptions.type_option as string[])
        : undefined,
  };
}

function normalizeListOptions(options: Record<string, unknown>): ListOptions {
  return {
    type: typeof options.type === "string" ? options.type : undefined,
    tag: typeof options.tag === "string" ? options.tag : undefined,
    priority: typeof options.priority === "string" ? options.priority : undefined,
    deadlineBefore: typeof options.deadlineBefore === "string" ? options.deadlineBefore : undefined,
    deadlineAfter: typeof options.deadlineAfter === "string" ? options.deadlineAfter : undefined,
    assignee: typeof options.assignee === "string" ? options.assignee : undefined,
    sprint: typeof options.sprint === "string" ? options.sprint : undefined,
    release: typeof options.release === "string" ? options.release : undefined,
    limit: typeof options.limit === "string" ? options.limit : undefined,
    includeBody: options.includeBody === true ? true : undefined,
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

function normalizeCalendarOptions(options: Record<string, unknown>): CalendarOptions {
  return {
    view: typeof options.view === "string" ? options.view : undefined,
    date: typeof options.date === "string" ? options.date : undefined,
    from: typeof options.from === "string" ? options.from : undefined,
    to: typeof options.to === "string" ? options.to : undefined,
    past: options.past === true ? true : undefined,
    limit: typeof options.limit === "string" ? options.limit : undefined,
    type: typeof options.type === "string" ? options.type : undefined,
    tag: typeof options.tag === "string" ? options.tag : undefined,
    priority: typeof options.priority === "string" ? options.priority : undefined,
    status: typeof options.status === "string" ? options.status : undefined,
    assignee: typeof options.assignee === "string" ? options.assignee : undefined,
    sprint: typeof options.sprint === "string" ? options.sprint : undefined,
    release: typeof options.release === "string" ? options.release : undefined,
    include: typeof options.include === "string" ? options.include : undefined,
    recurrenceLookaheadDays:
      (typeof options.recurrenceLookaheadDays === "string" ? options.recurrenceLookaheadDays : undefined) ??
      (typeof options.recurrence_lookahead_days === "string" ? options.recurrence_lookahead_days : undefined),
    recurrenceLookbackDays:
      (typeof options.recurrenceLookbackDays === "string" ? options.recurrenceLookbackDays : undefined) ??
      (typeof options.recurrence_lookback_days === "string" ? options.recurrence_lookback_days : undefined),
    occurrenceLimit:
      (typeof options.occurrenceLimit === "string" ? options.occurrenceLimit : undefined) ??
      (typeof options.occurrence_limit === "string" ? options.occurrence_limit : undefined),
    format: typeof options.format === "string" ? options.format : undefined,
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
      process.stdout.write(str);
    },
    // Commander errors are rendered in our own catch path.
    writeErr: () => {},
  })
  .option("--json", "Output JSON instead of TOON")
  .option("--quiet", "Suppress stdout output")
  .option("--path <dir>", "Override PM path for this command")
  .option("--no-extensions", "Disable extension loading")
  .option("--profile", "Print deterministic timing diagnostics")
  .exitOverride();

program.hook("preAction", async (_thisCommand, actionCommand) => {
  activeExtensionHookContext = null;
  clearActiveExtensionHooks();
  const globalOptions = getGlobalOptions(actionCommand);
  const commandPath = getCommandPath(actionCommand);
  const commandArgs = actionCommand.args.map(String);
  const commandOptions = extractCommandScopedOptions(actionCommand, commandArgs);
  await enforceItemFormatWriteGateAndPreflightMigration(commandPath, commandOptions, globalOptions);
  const runtimeExtensions = await maybeLoadRuntimeExtensions(actionCommand);
  if (!runtimeExtensions) {
    return;
  }

  const migrationWarnings = await executeRegisteredRuntimeMigrations(
    runtimeExtensions.registrations.migrations,
    runtimeExtensions.pmRoot,
  );
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
  setActiveExtensionHooks(runtimeExtensions.hooks);
  setActiveExtensionCommands(runtimeExtensions.commands);
  setActiveExtensionRenderers(runtimeExtensions.renderers);
  setActiveExtensionRegistrations(runtimeExtensions.registrations);
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
  enforceMandatoryMigrationWriteGate(
    commandPath,
    commandOptions,
    migrationBlockers,
  );
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
  .argument("<action>", "Config action: get|set")
  .argument("<key>", "Config key: definition-of-done|item-format")
  .option("--criterion <text>", "Definition-of-Done criterion (repeatable for set)", collect)
  .option("--format <value>", "Item format for item-format key: toon|json_markdown")
  .description("Read or update pm settings for the current workspace or global profile.")
  .action(async (scope: string, action: string, key: string, options: Record<string, unknown>, command) => {
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
      },
      globalOptions,
    );
    printResult(result, globalOptions);
    if (globalOptions.profile) {
      printError(`profile:command=config took_ms=${Date.now() - startedAt}`);
    }
  });

program
  .command("install")
  .argument("<target>", "Install target: pi")
  .option(
    "--project",
    "Install Pi extension into resolved project root .pi/extensions (derived from --path, default)",
  )
  .option("--global", "Install Pi extension into global PI_CODING_AGENT_DIR or ~/.pi/agent")
  .description("Install supported integrations and extensions.")
  .action(async (target: string, options: Record<string, unknown>, command) => {
    const globalOptions = getGlobalOptions(command);
    const startedAt = Date.now();
    const result = await runInstall(
      target,
      {
        project: options.project === true,
        global: options.global === true,
      },
      globalOptions,
    );
    printResult(result, globalOptions);
    if (globalOptions.profile) {
      printError(`profile:command=install took_ms=${Date.now() - startedAt}`);
    }
  });

program
  .command("create")
  .description("Create a new project management item.")
  .requiredOption("--title, -t <value>", "Item title")
  .requiredOption("--description, -d <value>", "Item description (allow empty string)")
  .requiredOption("--type <value>", "Item type (built-ins plus any configured custom types)")
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
    .option("--include-body", "Include item body in each returned list row")
    .action(async (options: Record<string, unknown>, command) => {
      const globalOptions = getGlobalOptions(command);
      const startedAt = Date.now();
      const listOptions = normalizeListOptions(options);
      if (excludeTerminal) listOptions.excludeTerminal = true;
      const result = await runList(status, listOptions, globalOptions);
      printResult(result, globalOptions);
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
          process.stdout.write(`${renderCalendarMarkdown(result)}\n`);
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

program
  .command("beads")
  .description("Built-in Beads extension commands.")
  .command("import")
  .description("Import Beads JSONL records as PM items.")
  .option("--file <path>", "Path to Beads JSONL file, or - for stdin")
  .option("--author <value>", "Mutation author")
  .option("--message <value>", "History message for import entries")
  .option("--preserve-source-ids", "Preserve explicit Beads ids instead of rewriting them to the tracker prefix")
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
  .description("Show item history entries.")
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
  .option("--status, -s <value>", "Set status (use close command for closed)")
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
  .command("files")
  .argument("<id>", "Item id")
  .option("--add <value>", "Add linked file entry (CSV/markdown pairs or - for stdin)", collect)
  .option("--remove <value>", "Remove linked file by path (path=<value>, path:<value>, plain path, or - for stdin)", collect)
  .option("--author <value>", "Mutation author")
  .option("--message <value>", "History message")
  .option("--force", "Force ownership override")
  .description("Manage files linked to an item.")
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
  .option("--add <value>", "Add linked doc entry (CSV/markdown pairs or - for stdin)", collect)
  .option("--remove <value>", "Remove linked doc by path (path=<value>, path:<value>, plain path, or - for stdin)", collect)
  .option("--author <value>", "Mutation author")
  .option("--message <value>", "History message")
  .option("--force", "Force ownership override")
  .description("Manage docs linked to an item.")
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
  .option("--add <value>", "Add linked test entry (CSV/markdown pairs or - for stdin)", collect)
  .option(
    "--remove <value>",
    "Remove linked test entry by command/path (command=<value>, path=<value>, markdown pairs, plain value, or - for stdin)",
    collect,
  )
  .option("--run", "Run linked test commands")
  .option("--timeout <seconds>", "Default run timeout in seconds")
  .option("--author <value>", "Mutation author")
  .option("--message <value>", "History message")
  .option("--force", "Force ownership override")
  .description("Manage tests linked to an item and optionally run them.")
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
  .description("Run linked tests across matching items.")
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
    if (await pathExists(getSettingsPath(pmRoot))) {
      const settings = await readSettings(pmRoot);
      completionTypes = resolveItemTypeRegistry(settings, getActiveExtensionRegistrations()).types;
    }
    const result = runCompletion(shell, completionTypes);
    if (globalOptions.json) {
      printResult(result, globalOptions);
    } else if (!globalOptions.quiet) {
      process.stdout.write(`${result.script}\n`);
    }
    if (globalOptions.profile) {
      printError(`profile:command=completion took_ms=0`);
    }
  });

attachRichHelpText(program);

async function formatCommanderUsageMessage(error: unknown): Promise<string> {
  const rawMessage = typeof error === "object" && error !== null ? (error as { message?: string }).message : undefined;
  const message = rawMessage ?? "Invalid command usage";
  const bootstrapGlobal = parseBootstrapGlobalOptions(process.argv.slice(2));
  const commandName = parseBootstrapCommandName(process.argv.slice(2));
  let allowedTypes = "Epic|Feature|Task|Chore|Issue";
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
  return formatCommanderErrorForDisplay(message, commandName, allowedTypes);
}

async function main(): Promise<void> {
  try {
    await registerDynamicExtensionCommandPaths(program);
    wrapProgramActionsForExtensionHandlers(program);
    await program.parseAsync(process.argv);
  } catch (error: unknown) {
    await runAndClearAfterCommandHooks({
      ok: false,
      error: describeUnknownError(error),
    });
    if (error instanceof PmCliError) {
      printError(formatPmCliErrorForDisplay(error.message));
      process.exitCode = error.exitCode;
      return;
    }

    if (typeof error === "object" && error !== null && "code" in error) {
      const code = (error as { code?: string }).code;
      if (code === "commander.helpDisplayed") {
        process.exitCode = EXIT_CODE.SUCCESS;
        return;
      }
      if (code === "commander.version") {
        process.exitCode = EXIT_CODE.SUCCESS;
        return;
      }
      if (code?.startsWith("commander.")) {
        printError(await formatCommanderUsageMessage(error));
        process.exitCode = EXIT_CODE.USAGE;
        return;
      }
    }

    const message = describeUnknownError(error);
    printError(message);
    process.exitCode = EXIT_CODE.GENERIC_FAILURE;
  }
}

void main();
