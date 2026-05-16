#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
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
  type RegisteredExtensionSchemaMigrationDefinition,
  type ExtensionRendererRegistry,
} from "../core/extensions/index.js";
import { pathExists } from "../core/fs/fs-utils.js";
import { resolvePmPackageRootFromModule } from "../core/packages/root.js";
import {
  resolveItemTypeRegistry,
} from "../core/item/type-registry.js";
import {
  resolveRuntimeFieldRegistry,
  type RuntimeFieldCommand,
} from "../core/schema/runtime-schema.js";
import { EXIT_CODE, resolveTelemetryErrorCategory, type TelemetryErrorCategory } from "../core/shared/constants.js";
import { PmCliError, type PmCliErrorContext, type PmCliErrorRecoveryPayload } from "../core/shared/errors.js";
import { toNonEmptyStringOrUndefined } from "../core/shared/primitives.js";
import { printError, printResult, writeStdout } from "../core/output/output.js";
import { maybeRunFirstUseTelemetryPrompt } from "../core/telemetry/consent.js";
import {
  emitTelemetryErrorEvent,
  finishTelemetryCommand,
  startTelemetryCommand,
  type ActiveTelemetryCommand,
  type TelemetryCommandOutcome,
} from "../core/telemetry/runtime.js";
import {
  deriveTelemetryCommandResolution,
  type TelemetryCommandResolution,
  type TelemetryResolutionStage,
} from "../core/telemetry/observability.js";
import {
  sentryCaptureCliError,
  sentryFinishCommandSpan,
  sentryFlush,
  sentryLogCliUsageError,
  sentrySetCommandContext,
  sentryStartCommandSpan,
} from "../core/sentry/helpers.js";
import { ensureSentryInit } from "../core/sentry/instrument.js";
import { getSettingsPath, resolvePmRoot } from "../core/store/paths.js";
import { readSettings } from "../core/store/settings.js";
import type { GlobalOptions } from "../core/shared/command-types.js";
import type { PmSettings } from "../types/index.js";
import { coerceLooseCommandOptionsWithFlagDefinitions, parseLooseCommandOptions } from "./extension-command-options.js";
import { attachRichHelpText } from "./help-content.js";
import {
  extractProvidedOptionFlags,
  normalizeLongOptionFlag,
  renderPmCommand,
} from "./argv-utils.js";
import {
  classifyCommanderError,
  classifyPmCliError,
  classifyUnknownError,
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
import {
  type ExtensionCommandHelpDescriptor,
  normalizeExtensionCommandPath,
  collectDynamicExtensionFlagHelpByCommand,
  collectExtensionCommandHelpDescriptors,
  applyDynamicExtensionArguments,
  buildDynamicExtensionCommandMetadataHelp,
  findCommandByPath,
  ensureCommandPath,
} from "./extension-command-help.js";
import {
  parseBootstrapGlobalOptions,
  applyBootstrapPagerPolicy,
  parseBootstrapHelpRequest,
  parseBootstrapCommandName,
  normalizeBootstrapInvocation,
} from "./bootstrap-args.js";
import {
  type MandatoryMigrationBlocker,
  collectMandatoryMigrationBlockers,
  enforceMandatoryMigrationWriteGate,
  enforceItemFormatWriteGateAndPreflightMigration,
  resolveMigrationId,
  resolveNormalizedMigrationStatus,
} from "./migration-gates.js";
import {
  isKnownHelpCommandPath,
  formatCommanderUsageMessage,
  formatCommanderUsageJson,
  resolveCommanderUsageContext,
} from "./commander-usage.js";
import {
  maybeRenderBootstrapJsonHelp,
  attachCreateUpdatePolicyHelpText,
} from "./help-json-payload.js";

const PM_PACKAGE_ROOT_ENV = "PM_CLI_PACKAGE_ROOT";

function resolvePmPackageRoot(): string {
  return resolvePmPackageRootFromModule(import.meta.url, ["../.."]);
}

if (typeof process.env[PM_PACKAGE_ROOT_ENV] !== "string" || process.env[PM_PACKAGE_ROOT_ENV]?.trim().length === 0) {
  process.env[PM_PACKAGE_ROOT_ENV] = resolvePmPackageRoot();
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

const TELEMETRY_COMMAND_RESOLUTION_SET = new Set<TelemetryCommandResolution>([
  "success",
  "nonexistent_command",
  "invalid_option",
  "missing_required_option",
  "missing_required_argument",
  "invalid_usage",
  "validation_failed",
  "conflict",
  "runtime_failed",
  "unknown_failed",
]);

const TELEMETRY_RESOLUTION_STAGE_SET = new Set<TelemetryResolutionStage>(["parse", "preflight", "execute", "unknown"]);
const TELEMETRY_ERROR_CATEGORY_SET = new Set<TelemetryErrorCategory>(["usage", "validation", "conflict", "runtime", "unknown"]);

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

function describeUnknownError(error: unknown): string {
  if (error instanceof PmCliError) {
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return "Unknown failure";
}

function renderAttemptedCommand(argv: string[]): string {
  return renderPmCommand(argv);
}

function inferMissingFieldsFromErrorMessage(message: string): string[] | undefined {
  const matches = message.match(/--[a-zA-Z0-9][a-zA-Z0-9_-]*/g);
  if (!matches || matches.length === 0) {
    return undefined;
  }
  const normalized = [...new Set(matches.map((entry) => normalizeLongOptionFlag(entry) ?? entry))];
  return normalized.length > 0 ? normalized : undefined;
}

function buildPmCliRecoveryContext(
  context: PmCliErrorContext | undefined,
  invocationArgv: string[],
  rawMessage: string,
): PmCliErrorContext {
  const attemptedCommand = renderAttemptedCommand(invocationArgv);
  const providedFields = extractProvidedOptionFlags(invocationArgv);
  const inferredMissing = inferMissingFieldsFromErrorMessage(rawMessage);
  const existingRecovery = context?.recovery;
  let suggestedRetry = existingRecovery?.suggested_retry;
  if (!suggestedRetry && inferredMissing && inferredMissing.length > 0) {
    const missingFlag = inferredMissing[0];
    const normalizedMissing = normalizeLongOptionFlag(missingFlag);
    if (normalizedMissing) {
      const alreadyProvided = invocationArgv.some((token) => normalizeLongOptionFlag(token) === normalizedMissing);
      if (!alreadyProvided) {
        suggestedRetry = renderAttemptedCommand([...invocationArgv, normalizedMissing, "<value>"]);
      }
    }
  }
  if (!suggestedRetry) {
    suggestedRetry = attemptedCommand;
  }
  const recovery: PmCliErrorRecoveryPayload = {
    attempted_command: existingRecovery?.attempted_command ?? attemptedCommand,
    normalized_args: existingRecovery?.normalized_args ?? [...invocationArgv],
    provided_fields: existingRecovery?.provided_fields ?? (providedFields.length > 0 ? providedFields : undefined),
    missing: existingRecovery?.missing ?? inferredMissing,
    suggested_retry: suggestedRetry,
  };
  return {
    ...(context ?? {}),
    recovery,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readRecordString(record: Record<string, unknown> | null, ...keys: string[]): string | undefined {
  if (!record) {
    return undefined;
  }
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === "string") {
      const normalized = candidate.trim();
      if (normalized.length > 0) {
        return normalized;
      }
    }
  }
  return undefined;
}

function readRecordBoolean(record: Record<string, unknown> | null, ...keys: string[]): boolean | undefined {
  if (!record) {
    return undefined;
  }
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === "boolean") {
      return candidate;
    }
  }
  return undefined;
}

function readRecordNumber(record: Record<string, unknown> | null, ...keys: string[]): number | undefined {
  if (!record) {
    return undefined;
  }
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return Math.max(0, Math.trunc(candidate));
    }
  }
  return undefined;
}

function normalizeTelemetryCommandResolution(
  value: string | undefined,
): TelemetryCommandResolution | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (!TELEMETRY_COMMAND_RESOLUTION_SET.has(normalized as TelemetryCommandResolution)) {
    return undefined;
  }
  return normalized as TelemetryCommandResolution;
}

function normalizeTelemetryResolutionStage(value: string | undefined): TelemetryResolutionStage | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (!TELEMETRY_RESOLUTION_STAGE_SET.has(normalized as TelemetryResolutionStage)) {
    return undefined;
  }
  return normalized as TelemetryResolutionStage;
}

function normalizeTelemetryErrorCategory(value: string | undefined): TelemetryErrorCategory | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (!TELEMETRY_ERROR_CATEGORY_SET.has(normalized as TelemetryErrorCategory)) {
    return undefined;
  }
  return normalized as TelemetryErrorCategory;
}

function inferPostActionFailureMessage(result: Record<string, unknown> | null): string | undefined {
  const explicit = readRecordString(result, "error", "message");
  if (explicit) {
    return explicit;
  }

  const warnings = result?.warnings;
  if (Array.isArray(warnings)) {
    const firstWarning = warnings.find((value) => typeof value === "string" && value.trim().length > 0);
    if (typeof firstWarning === "string") {
      return firstWarning.trim();
    }
  }

  const skippedTriggered = readRecordBoolean(result, "fail_on_skipped_triggered", "failOnSkippedTriggered");
  if (skippedTriggered) {
    return "linked_test_fail_on_skipped_triggered";
  }

  const failedCount = readRecordNumber(result, "failed");
  if (typeof failedCount === "number" && failedCount > 0) {
    return `failed_runs:${failedCount}`;
  }

  const runResults = result?.run_results;
  if (Array.isArray(runResults)) {
    const failedRuns = runResults.filter((entry) => {
      const row = asRecord(entry);
      return row?.status === "failed";
    }).length;
    if (failedRuns > 0) {
      return `failed_runs:${failedRuns}`;
    }
  }

  return undefined;
}

function inferPostActionErrorCode(ok: boolean, exitCode: number): string | undefined {
  if (ok) {
    return undefined;
  }
  if (exitCode === EXIT_CODE.USAGE) {
    return "invalid_command_usage";
  }
  if (exitCode === EXIT_CODE.NOT_FOUND) {
    return "item_not_found";
  }
  if (exitCode === EXIT_CODE.CONFLICT) {
    return "lock_conflict";
  }
  if (exitCode === EXIT_CODE.DEPENDENCY_FAILED) {
    return "dependency_failed";
  }
  return "command_failed";
}

function buildPostActionTelemetryOutcome(): TelemetryCommandOutcome {
  const result = asRecord(getActiveCommandResult());
  const processExitCode =
    typeof process.exitCode === "number" && Number.isFinite(process.exitCode)
      ? Math.max(0, Math.trunc(process.exitCode))
      : undefined;
  const resultExitCode = readRecordNumber(result, "exit_code", "exitCode");
  const exitCode = processExitCode ?? resultExitCode ?? EXIT_CODE.SUCCESS;
  const ok = exitCode === EXIT_CODE.SUCCESS;
  const errorCode = readRecordString(result, "error_code", "errorCode") ?? inferPostActionErrorCode(ok, exitCode);
  const errorCategory =
    normalizeTelemetryErrorCategory(readRecordString(result, "error_category", "errorCategory")) ??
    (!ok ? resolveTelemetryErrorCategory(errorCode) : undefined);
  const errorMessage = !ok
    ? inferPostActionFailureMessage(result) ?? `command_exit_${exitCode}`
    : undefined;
  const commandResolution =
    normalizeTelemetryCommandResolution(readRecordString(result, "command_resolution", "commandResolution")) ??
    deriveTelemetryCommandResolution({
      ok,
      errorCode,
      errorCategory,
    });
  const resolutionStage =
    normalizeTelemetryResolutionStage(readRecordString(result, "resolution_stage", "resolutionStage")) ?? "execute";
  return {
    ok,
    error: errorMessage,
    exit_code: exitCode,
    error_code: errorCode,
    error_category: errorCategory,
    command_resolution: commandResolution,
    resolution_stage: resolutionStage,
  };
}


async function runAndClearAfterCommandHooks(outcome: TelemetryCommandOutcome): Promise<void> {
  const telemetryRuntime = activeTelemetryCommandContext;
  activeTelemetryCommandContext = null;
  await finishTelemetryCommand(telemetryRuntime, {
    ok: outcome.ok,
    error: outcome.error,
    result: getActiveCommandResult(),
    exit_code: outcome.exit_code,
    error_code: outcome.error_code,
    error_category: outcome.error_category,
    command_resolution: outcome.command_resolution,
    resolution_stage: outcome.resolution_stage,
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

async function ensureSentryForErrorReporting(): Promise<void> {
  await ensureSentryInit();
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

async function registerRuntimeSchemaFieldFlags(rootProgram: Command, invocationArgv: string[]): Promise<void> {
  const bootstrapGlobalOptions = parseBootstrapGlobalOptions(invocationArgv);
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

async function registerDynamicExtensionCommandPaths(rootProgram: Command, invocationArgv: string[]): Promise<void> {
  const bootstrapGlobalOptions = parseBootstrapGlobalOptions(invocationArgv);
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
  attachCreateUpdatePolicyHelpText(rootProgram, typeRegistry, invocationArgv);

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
    const packageJsonPath = path.join(resolvePmPackageRoot(), "package.json");
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
    sentrySetCommandContext(commandPath, commandArgs, commandOptions, {
      source_context: activeTelemetryCommandContext?.source_context,
      source_context_source: activeTelemetryCommandContext?.source_context_source,
    });
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
  sentrySetCommandContext(commandPath, commandArgs, commandOptions, {
    source_context: activeTelemetryCommandContext?.source_context,
    source_context_source: activeTelemetryCommandContext?.source_context_source,
  });
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
  const outcome = buildPostActionTelemetryOutcome();
  sentryFinishCommandSpan(outcome.ok, outcome.error, {
    error_code: outcome.error_code,
    error_category: outcome.error_category,
    exit_code: outcome.exit_code,
    command_resolution: outcome.command_resolution,
    resolution_stage: outcome.resolution_stage,
  });
  await runAndClearAfterCommandHooks(outcome);
});

registerSetupCommands(program);
registerListQueryCommands(program);
registerMutationCommands(program);
registerOperationCommands(program);

const VERSION_FLAG_TOKENS = new Set(["--version", "-V"]);
const RUNTIME_SCHEMA_FLAG_BOOTSTRAP_COMMANDS = new Set([
  "create",
  "update",
  "update-many",
  "list",
  "list-all",
  "list-draft",
  "list-open",
  "list-in-progress",
  "list-blocked",
  "list-closed",
  "list-canceled",
  "search",
  "calendar",
  "context",
  "templates",
]);

function invocationRequestsVersion(invocationArgv: string[]): boolean {
  return invocationArgv.some((token) => VERSION_FLAG_TOKENS.has(token));
}

function isKnownTopLevelCommandOrAlias(rootProgram: Command, commandName: string): boolean {
  const normalized = commandName.trim().toLowerCase();
  for (const command of rootProgram.commands) {
    if (command.name().trim().toLowerCase() === normalized) {
      return true;
    }
    if (command.aliases().some((alias) => alias.trim().toLowerCase() === normalized)) {
      return true;
    }
  }
  return false;
}

function shouldRegisterDynamicExtensionPaths(rootProgram: Command, invocationArgv: string[]): boolean {
  if (invocationRequestsVersion(invocationArgv)) {
    return false;
  }
  const helpRequest = parseBootstrapHelpRequest(invocationArgv);
  if (helpRequest.requested) {
    return true;
  }
  const commandName = parseBootstrapCommandName(invocationArgv);
  if (!commandName) {
    return false;
  }
  return !isKnownTopLevelCommandOrAlias(rootProgram, commandName);
}

function shouldRegisterRuntimeSchemaFlags(invocationArgv: string[]): boolean {
  if (invocationRequestsVersion(invocationArgv)) {
    return false;
  }
  const commandName = parseBootstrapCommandName(invocationArgv);
  if (!commandName) {
    return false;
  }
  return RUNTIME_SCHEMA_FLAG_BOOTSTRAP_COMMANDS.has(commandName);
}

const bootstrapInvocation = normalizeBootstrapInvocation(process.argv.slice(2));

attachRichHelpText(program, bootstrapInvocation.argv);

async function main(): Promise<void> {
  const invocationArgv = bootstrapInvocation.argv;
  const invocationProcessArgv = [process.argv[0], process.argv[1], ...invocationArgv];
  try {
    applyBootstrapPagerPolicy(invocationArgv);
    const registerDynamicCommands = shouldRegisterDynamicExtensionPaths(program, invocationArgv);
    if (registerDynamicCommands) {
      await registerDynamicExtensionCommandPaths(program, invocationArgv);
    } else {
      activeRuntimeExtensionCommandDescriptors = new Map<string, ExtensionCommandHelpDescriptor>();
      setActiveExtensionServices({ overrides: [] });
    }
    if (shouldRegisterRuntimeSchemaFlags(invocationArgv)) {
      await registerRuntimeSchemaFieldFlags(program, invocationArgv);
    }
    wrapProgramActionsForExtensionHandlers(program);
    const renderedBootstrapJsonHelp = await maybeRenderBootstrapJsonHelp(program, invocationArgv, activeRuntimeExtensionCommandDescriptors);
    if (renderedBootstrapJsonHelp) {
      return;
    }
    await program.parseAsync(invocationProcessArgv);
  } catch (error: unknown) {
    const bootstrapGlobal = parseBootstrapGlobalOptions(invocationArgv);
    const jsonErrors = bootstrapGlobal.json;
    const bootstrapPmRoot = resolvePmRoot(process.cwd(), bootstrapGlobal.path);
    const attemptedCommand = parseBootstrapCommandName(invocationArgv) ?? "<unknown>";

    const emitTelemetryCommandError = async (params: {
      command: string;
      errorCode: string;
      errorMessage: string;
      exitCode: number;
      options: Record<string, unknown>;
      resolutionStage: TelemetryResolutionStage;
    }) => {
      const errorCategory = resolveTelemetryErrorCategory(params.errorCode);
      const commandResolution = deriveTelemetryCommandResolution({
        ok: false,
        errorCode: params.errorCode,
        errorCategory,
      });
      await emitTelemetryErrorEvent({
        command: params.command,
        args: invocationArgv,
        options: params.options,
        global: bootstrapGlobal,
        pm_version: CLI_VERSION,
        pm_root: bootstrapPmRoot,
        error_code: params.errorCode,
        error_message: params.errorMessage,
        exit_code: params.exitCode,
        error_category: errorCategory,
        command_resolution: commandResolution,
        resolution_stage: params.resolutionStage,
      });
      return {
        errorCategory,
        commandResolution,
      };
    };

    if (!bootstrapGlobal.noExtensions) {
      const bootstrapSnapshot = await loadRuntimeExtensionSnapshot(bootstrapPmRoot);
      setActiveExtensionServices(bootstrapSnapshot?.services ?? { overrides: [] });
    }

    if (error instanceof PmCliError) {
      const enrichedContext = buildPmCliRecoveryContext(error.context, invocationArgv, error.message);
      const classification = classifyPmCliError(error.message, enrichedContext);
      const { errorCategory, commandResolution } = await emitTelemetryCommandError({
        command: attemptedCommand,
        errorCode: classification.code,
        errorMessage: classification.detail,
        exitCode: error.exitCode,
        options: {
          bootstrap_global_options: bootstrapGlobal,
        },
        resolutionStage: "execute",
      });
      await ensureSentryForErrorReporting();
      sentryLogCliUsageError({
        command: attemptedCommand,
        error_code: classification.code,
        error_category: errorCategory,
        exit_code: error.exitCode,
        error_message: classification.detail,
        command_resolution: commandResolution,
        resolution_stage: "execute",
        source_context: activeTelemetryCommandContext?.source_context,
      });
      sentryFinishCommandSpan(false, error.message, {
        error_code: classification.code,
        error_category: errorCategory,
        exit_code: error.exitCode,
        command_resolution: commandResolution,
        resolution_stage: "execute",
      });
      await runAndClearAfterCommandHooks({
        ok: false,
        error: error.message,
        exit_code: error.exitCode,
        error_code: classification.code,
        error_category: errorCategory,
        command_resolution: commandResolution,
        resolution_stage: "execute",
      });
      sentryCaptureCliError(error);
      if (jsonErrors) {
        printError(JSON.stringify(formatPmCliErrorForJson(error.message, error.exitCode, enrichedContext), null, 2));
      } else {
        printError(formatPmCliErrorForDisplay(error.message, enrichedContext));
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
          const usageContext = await resolveCommanderUsageContext(
            { message: unknownMessage },
            program,
            activeRuntimeExtensionCommandDescriptors,
          );
          const classification = classifyCommanderError(
            usageContext.message,
            usageContext.commandName,
            usageContext.allowedTypes,
            {
              unknownCommandExamples: usageContext.unknownCommandExamples,
              unknownCommandNextSteps: usageContext.unknownCommandNextSteps,
              attemptedCommand: usageContext.attemptedCommand,
              normalizedInvocationArgs: usageContext.normalizedInvocationArgs,
              providedOptionFlags: usageContext.providedOptionFlags,
              unknownOptionSuggestions: usageContext.unknownOptionSuggestions,
              suggestedRetryCommand: usageContext.suggestedRetryCommand,
            },
          );
          const { errorCategory, commandResolution } = await emitTelemetryCommandError({
            command: unknownToken,
            errorCode: classification.code,
            errorMessage: classification.detail,
            exitCode: EXIT_CODE.USAGE,
            options: {
              bootstrap_global_options: bootstrapGlobal,
              commander_code: code ?? "commander.helpDisplayed",
            },
            resolutionStage: "parse",
          });
          await ensureSentryForErrorReporting();
          sentryLogCliUsageError({
            command: unknownToken,
            error_code: classification.code,
            error_category: errorCategory,
            exit_code: EXIT_CODE.USAGE,
            error_message: classification.detail,
            command_resolution: commandResolution,
            resolution_stage: "parse",
            source_context: activeTelemetryCommandContext?.source_context,
          });
          const renderedUsage = jsonErrors
            ? await formatCommanderUsageJson({ message: unknownMessage }, program, activeRuntimeExtensionCommandDescriptors)
            : await formatCommanderUsageMessage({ message: unknownMessage }, program, activeRuntimeExtensionCommandDescriptors);
          sentryFinishCommandSpan(false, unknownMessage, {
            error_code: classification.code,
            error_category: errorCategory,
            exit_code: EXIT_CODE.USAGE,
            command_resolution: commandResolution,
            resolution_stage: "parse",
          });
          await runAndClearAfterCommandHooks({
            ok: false,
            error: unknownMessage,
            exit_code: EXIT_CODE.USAGE,
            error_code: classification.code,
            error_category: errorCategory,
            command_resolution: commandResolution,
            resolution_stage: "parse",
          });
          if (jsonErrors) {
            printError(renderedUsage);
          } else {
            printError(renderedUsage);
          }
          await sentryFlush();
          process.exitCode = EXIT_CODE.USAGE;
          return;
        }
        sentryFinishCommandSpan(true, undefined, {
          exit_code: EXIT_CODE.SUCCESS,
          command_resolution: "success",
          resolution_stage: "parse",
        });
        await runAndClearAfterCommandHooks({
          ok: true,
          exit_code: EXIT_CODE.SUCCESS,
          command_resolution: "success",
          resolution_stage: "parse",
        });
        process.exitCode = EXIT_CODE.SUCCESS;
        return;
      }
      if (code === "commander.version") {
        sentryFinishCommandSpan(true, undefined, {
          exit_code: EXIT_CODE.SUCCESS,
          command_resolution: "success",
          resolution_stage: "parse",
        });
        await runAndClearAfterCommandHooks({
          ok: true,
          exit_code: EXIT_CODE.SUCCESS,
          command_resolution: "success",
          resolution_stage: "parse",
        });
        process.exitCode = EXIT_CODE.SUCCESS;
        return;
      }
      if (code?.startsWith("commander.")) {
        const usageContext = await resolveCommanderUsageContext(error, program, activeRuntimeExtensionCommandDescriptors);
        const classification = classifyCommanderError(
          usageContext.message,
          usageContext.commandName,
          usageContext.allowedTypes,
          {
            unknownCommandExamples: usageContext.unknownCommandExamples,
            unknownCommandNextSteps: usageContext.unknownCommandNextSteps,
            attemptedCommand: usageContext.attemptedCommand,
            normalizedInvocationArgs: usageContext.normalizedInvocationArgs,
            providedOptionFlags: usageContext.providedOptionFlags,
            unknownOptionSuggestions: usageContext.unknownOptionSuggestions,
            suggestedRetryCommand: usageContext.suggestedRetryCommand,
          },
        );
        const { errorCategory, commandResolution } = await emitTelemetryCommandError({
          command: attemptedCommand,
          errorCode: classification.code,
          errorMessage: classification.detail,
          exitCode: EXIT_CODE.USAGE,
          options: {
            bootstrap_global_options: bootstrapGlobal,
            commander_code: code,
          },
          resolutionStage: "parse",
        });
        await ensureSentryForErrorReporting();
        sentryLogCliUsageError({
          command: attemptedCommand,
          error_code: classification.code,
          error_category: errorCategory,
          exit_code: EXIT_CODE.USAGE,
          error_message: classification.detail,
          command_resolution: commandResolution,
          resolution_stage: "parse",
          source_context: activeTelemetryCommandContext?.source_context,
        });
        const renderedUsage = jsonErrors
          ? await formatCommanderUsageJson(error, program, activeRuntimeExtensionCommandDescriptors)
          : await formatCommanderUsageMessage(error, program, activeRuntimeExtensionCommandDescriptors);
        sentryFinishCommandSpan(false, usageContext.message, {
          error_code: classification.code,
          error_category: errorCategory,
          exit_code: EXIT_CODE.USAGE,
          command_resolution: commandResolution,
          resolution_stage: "parse",
        });
        await runAndClearAfterCommandHooks({
          ok: false,
          error: usageContext.message,
          exit_code: EXIT_CODE.USAGE,
          error_code: classification.code,
          error_category: errorCategory,
          command_resolution: commandResolution,
          resolution_stage: "parse",
        });
        if (jsonErrors) {
          printError(renderedUsage);
        } else {
          printError(renderedUsage);
        }
        await sentryFlush();
        process.exitCode = EXIT_CODE.USAGE;
        return;
      }
    }

    await ensureSentryForErrorReporting();
    sentryCaptureCliError(error);
    const message = describeUnknownError(error);
    const classification = classifyUnknownError(message);
    const { errorCategory, commandResolution } = await emitTelemetryCommandError({
      command: attemptedCommand,
      errorCode: classification.code,
      errorMessage: classification.detail,
      exitCode: EXIT_CODE.GENERIC_FAILURE,
      options: {
        bootstrap_global_options: bootstrapGlobal,
      },
      resolutionStage: "execute",
    });
    sentryFinishCommandSpan(false, message, {
      error_code: classification.code,
      error_category: errorCategory,
      exit_code: EXIT_CODE.GENERIC_FAILURE,
      command_resolution: commandResolution,
      resolution_stage: "execute",
    });
    await runAndClearAfterCommandHooks({
      ok: false,
      error: message,
      exit_code: EXIT_CODE.GENERIC_FAILURE,
      error_code: classification.code,
      error_category: errorCategory,
      command_resolution: commandResolution,
      resolution_stage: "execute",
    });
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
