#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import {
  activateExtensions,
  clearActiveExtensionHooks,
  createEmptyExtensionRegistrationRegistry,
  discoverExtensions,
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
  type ExtensionDiscoveryResult,
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
import { asRecordOrNull, toNonEmptyStringOrUndefined } from "../core/shared/primitives.js";
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
import {
  coerceLooseCommandOptionsWithFlagDefinitions,
  parseLooseCommandOptions,
  validateLooseCommandOptionsWithFlagDefinitions,
} from "./extension-command-options.js";
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
import type { registerSetupCommands as RegisterSetupCommandsFn } from "./register-setup.js";
import type { registerListQueryCommands as RegisterListQueryCommandsFn } from "./register-list-query.js";
import type { registerMutationCommands as RegisterMutationCommandsFn } from "./register-mutation.js";
import type { registerOperationCommands as RegisterOperationCommandsFn } from "./register-operations.js";
import { createLazyModule } from "../core/shared/lazy-module.js";
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
  stripGlobalBootstrapTokens,
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
  "health_findings",
  "validation_findings",
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

interface RuntimeExtensionDiscoverySnapshot {
  pmRoot: string;
  settings: PmSettings;
  discovery: ExtensionDiscoveryResult;
  discoveryMs: number;
}

interface RuntimeExtensionActivationProbe {
  commandPath?: string;
  commandArgs?: string[];
  allowCommandPrefixMatch?: boolean;
}

let runtimeExtensionSnapshotCache: { key: string; snapshot: RuntimeExtensionSnapshot | null } | null = null;
let runtimeExtensionDiscoverySnapshotCache: { key: string; snapshot: RuntimeExtensionDiscoverySnapshot | null } | null = null;
let activeRuntimeExtensionCommandDescriptors = new Map<string, ExtensionCommandHelpDescriptor>();
const HANDLED_ERROR_SENTRY_FLUSH_TIMEOUT_MS = 250;
const EXPECTED_HANDLED_ERROR_EXIT_CODES = new Set<number>([
  EXIT_CODE.USAGE,
  EXIT_CODE.NOT_FOUND,
  EXIT_CODE.CONFLICT,
]);
const TRUE_LIKE_ENV_VALUES = new Set(["1", "true", "yes", "on"]);

type SetupRegistrationModule = {
  registerSetupCommands: typeof RegisterSetupCommandsFn;
};
type ListQueryRegistrationModule = {
  registerListQueryCommands: typeof RegisterListQueryCommandsFn;
};
type MutationRegistrationModule = {
  registerMutationCommands: typeof RegisterMutationCommandsFn;
};
type OperationRegistrationModule = {
  registerOperationCommands: typeof RegisterOperationCommandsFn;
};

const loadSetupRegistrationModule = createLazyModule<SetupRegistrationModule>(() => import("./register-setup.js"));
const loadListQueryRegistrationModule = createLazyModule<ListQueryRegistrationModule>(() => import("./register-list-query.js"));
const loadMutationRegistrationModule = createLazyModule<MutationRegistrationModule>(() => import("./register-mutation.js"));
const loadOperationRegistrationModule = createLazyModule<OperationRegistrationModule>(() => import("./register-operations.js"));

function describeUnknownError(error: unknown): string {
  if (error instanceof PmCliError) {
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return "Unknown failure";
}

function readThrownExitCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("exitCode" in error)) {
    return undefined;
  }
  const exitCode = (error as { exitCode?: unknown }).exitCode;
  return typeof exitCode === "number" && Number.isFinite(exitCode) ? exitCode : undefined;
}

function normalizeThrownExitCode(exitCode: number): number {
  const normalized = Math.trunc(exitCode);
  return normalized > EXIT_CODE.SUCCESS ? normalized : EXIT_CODE.GENERIC_FAILURE;
}

function isCommanderError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string" &&
    (error as { code: string }).code.startsWith("commander.")
  );
}

function wrapThrownErrorForSentry(error: unknown, message: string): Error {
  if (error instanceof Error) {
    return error;
  }
  const wrapped = new Error(message) as Error & { exitCode?: number };
  const exitCode = readThrownExitCode(error);
  if (exitCode !== undefined) {
    wrapped.exitCode = normalizeThrownExitCode(exitCode);
  }
  return wrapped;
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
  const providedSet = new Set(providedFields.map((flag) => normalizeLongOptionFlag(flag) ?? flag));
  const existingRecovery = context?.recovery;
  const rawInferred = existingRecovery?.suggested_retry ? undefined : inferMissingFieldsFromErrorMessage(rawMessage);
  const trulyMissing = rawInferred?.filter((flag) => !providedSet.has(normalizeLongOptionFlag(flag) ?? flag));
  const inferredMissing = trulyMissing && trulyMissing.length > 0 ? trulyMissing : undefined;
  let suggestedRetry = existingRecovery?.suggested_retry;
  if (!suggestedRetry && inferredMissing && inferredMissing.length > 0) {
    const missingFlag = inferredMissing[0];
    const normalizedMissing = normalizeLongOptionFlag(missingFlag);
    if (normalizedMissing) {
      suggestedRetry = renderAttemptedCommand([...invocationArgv, normalizedMissing, "<value>"]);
    }
  }
  if (!suggestedRetry) {
    suggestedRetry = attemptedCommand;
  }
  if (!existingRecovery?.suggested_retry && suggestedRetry === attemptedCommand) {
    suggestedRetry = undefined;
  }
  const recovery: PmCliErrorRecoveryPayload = {
    attempted_command: existingRecovery?.attempted_command ?? attemptedCommand,
    normalized_args: existingRecovery?.normalized_args ?? [...invocationArgv],
    provided_fields: existingRecovery?.provided_fields ?? (providedFields.length > 0 ? providedFields : undefined),
    missing: existingRecovery?.missing ?? inferredMissing,
    ...(suggestedRetry ? { suggested_retry: suggestedRetry } : {}),
  };
  return {
    ...(context ?? {}),
    recovery,
  };
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
      const row = asRecordOrNull(entry);
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
  const result = asRecordOrNull(getActiveCommandResult());
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

function envFlagEnabled(key: string): boolean {
  return TRUE_LIKE_ENV_VALUES.has((process.env[key] ?? "").trim().toLowerCase());
}

function shouldLogHandledErrorToSentry(exitCode: number): boolean {
  if (envFlagEnabled("PM_SENTRY_CAPTURE_EXPECTED_ERRORS")) {
    return true;
  }
  return !EXPECTED_HANDLED_ERROR_EXIT_CODES.has(Math.trunc(exitCode));
}

async function maybeLogHandledCliErrorToSentry(params: {
  command: string;
  error_code: string;
  error_category: TelemetryErrorCategory;
  exit_code: number;
  error_message: string;
  command_resolution?: TelemetryCommandResolution;
  resolution_stage?: TelemetryResolutionStage;
  source_context?: string;
}): Promise<boolean> {
  if (!shouldLogHandledErrorToSentry(params.exit_code)) {
    return false;
  }
  await ensureSentryForErrorReporting();
  sentryLogCliUsageError(params);
  return true;
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
  // --no-changed-fields is a global output control (commander exposes it as `changedFields`),
  // not a per-command mutation field; strip it so it never counts as an update input.
  delete scoped.changedFields;

  const looseOptions = parseLooseCommandOptions(commandArgs);
  if (extensionFlagDefinitions.length > 0) {
    validateLooseCommandOptionsWithFlagDefinitions(looseOptions, extensionFlagDefinitions, getCommandPath(command));
  }
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

function collectExtensionFlagDefinitionsForInvocation(
  registrations: ReturnType<typeof createEmptyExtensionRegistrationRegistry>,
  commandPath: string,
  commandArgs: string[],
): Array<Record<string, unknown>> {
  const exact = collectExtensionFlagDefinitionsForCommand(registrations, commandPath);
  const pathParts = [commandPath];
  let nestedMatch: Array<Record<string, unknown>> = [];
  for (const arg of commandArgs) {
    if (arg.startsWith("-")) {
      break;
    }
    pathParts.push(arg);
    const nested = collectExtensionFlagDefinitionsForCommand(registrations, pathParts.join(" "));
    if (nested.length > 0) {
      nestedMatch = nested;
    }
  }
  return nestedMatch.length > 0 ? nestedMatch : exact;
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

async function maybeAttachCreateUpdatePolicyHelpText(
  rootProgram: Command,
  pmRoot: string,
  invocationArgv: string[],
  registrations: ReturnType<typeof createEmptyExtensionRegistrationRegistry>,
  settings?: PmSettings,
): Promise<void> {
  const bootstrapCommand = parseBootstrapCommandName(invocationArgv);
  if (bootstrapCommand !== "create" && bootstrapCommand !== "update") {
    return;
  }
  try {
    const resolvedSettings = settings ?? (await readSettings(pmRoot));
    const typeRegistry = resolveItemTypeRegistry(resolvedSettings, registrations);
    attachCreateUpdatePolicyHelpText(rootProgram, typeRegistry, invocationArgv);
  } catch {
    // Help should remain available even when settings cannot be read.
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

function bootstrapProfileEnabled(invocationArgv: string[]): boolean {
  return invocationArgv.some((token) => token === "--profile");
}

function buildRuntimeExtensionDiscoverySnapshotCacheKey(pmRoot: string): string {
  return `pm-root:${pmRoot}`;
}

function collectLeadingCommandArgs(commandArgs: readonly string[] | undefined): string[] {
  const leading: string[] = [];
  for (const arg of commandArgs ?? []) {
    if (arg.startsWith("-")) {
      break;
    }
    const normalized = normalizeExtensionCommandPath(arg);
    if (normalized.length === 0) {
      continue;
    }
    leading.push(normalized);
  }
  return leading;
}

function collectActivationCommandCandidates(probe: RuntimeExtensionActivationProbe): string[] {
  const commandPath = normalizeExtensionCommandPath(probe.commandPath ?? "");
  if (commandPath.length === 0) {
    return [];
  }
  const candidates = [commandPath];
  const parts = commandPath.split(" ").filter((part) => part.length > 0);
  for (const arg of collectLeadingCommandArgs(probe.commandArgs)) {
    parts.push(...arg.split(" ").filter((part) => part.length > 0));
    candidates.push(parts.join(" "));
  }
  return [...new Set(candidates)];
}

function activationCommandMatchesProbe(command: string, probe: RuntimeExtensionActivationProbe): boolean {
  const normalized = normalizeExtensionCommandPath(command);
  if (normalized.length === 0) {
    return false;
  }
  const candidates = collectActivationCommandCandidates(probe);
  for (const candidate of candidates) {
    if (candidate === normalized || candidate.startsWith(`${normalized} `)) {
      return true;
    }
  }
  if (probe.allowCommandPrefixMatch === true) {
    return candidates.some((candidate) => normalized.startsWith(`${candidate} `));
  }
  return false;
}

function extensionActivationCommands(extension: ExtensionDiscoveryResult["effective"][number]): string[] {
  return extension.activation?.commands ?? [];
}

function extensionCapabilities(extension: ExtensionDiscoveryResult["effective"][number]): Set<string> {
  return new Set((extension.capabilities ?? []).map((capability) => capability.trim().toLowerCase()));
}

const GLOBAL_EXTENSION_ACTIVATION_CAPABILITIES = new Set(["hooks", "parser", "preflight", "renderers"]);
const CONSERVATIVE_EXTENSION_ACTIVATION_CAPABILITIES = new Set(["commands", "schema", "services"]);
const SEARCH_EXTENSION_ACTIVATION_COMMANDS = new Set(["reindex", "search", "search-advanced"]);
const CREATE_TEMPLATE_FLAGS = new Set(["--template"]);

function hasAnyCapability(capabilities: Set<string>, expected: Set<string>): boolean {
  for (const capability of expected) {
    if (capabilities.has(capability)) {
      return true;
    }
  }
  return false;
}

function commandPathNeedsSearchExtensions(commandPath: string | undefined): boolean {
  const normalized = normalizeExtensionCommandPath(commandPath ?? "");
  if (normalized.length === 0) {
    return false;
  }
  const [topLevel] = normalized.split(" ");
  return SEARCH_EXTENSION_ACTIVATION_COMMANDS.has(topLevel ?? normalized);
}

function probeUsesAnyFlag(probe: RuntimeExtensionActivationProbe, flags: Set<string>): boolean {
  for (const arg of probe.commandArgs ?? []) {
    if (!arg.startsWith("--")) {
      continue;
    }
    const [flagName] = arg.split("=", 1);
    if (flags.has(flagName)) {
      return true;
    }
  }
  return false;
}

function commandPathNeedsTemplateExtensions(probe: RuntimeExtensionActivationProbe): boolean {
  return normalizeExtensionCommandPath(probe.commandPath ?? "") === "create" && probeUsesAnyFlag(probe, CREATE_TEMPLATE_FLAGS);
}

function extensionProvidesTemplatesRuntime(commands: readonly string[]): boolean {
  return commands.some((command) => {
    const normalized = normalizeExtensionCommandPath(command);
    return normalized === "templates" || normalized.startsWith("templates ");
  });
}

function extensionNeedsActivationForProbe(
  extension: ExtensionDiscoveryResult["effective"][number],
  probe: RuntimeExtensionActivationProbe,
): boolean {
  const capabilities = extensionCapabilities(extension);
  const commands = extensionActivationCommands(extension);
  if (commands.length > 0 && commands.some((command) => activationCommandMatchesProbe(command, probe))) {
    return true;
  }

  if (hasAnyCapability(capabilities, GLOBAL_EXTENSION_ACTIVATION_CAPABILITIES)) {
    return true;
  }

  if (commandPathNeedsTemplateExtensions(probe) && extensionProvidesTemplatesRuntime(commands)) {
    return true;
  }

  if (capabilities.has("search")) {
    return commandPathNeedsSearchExtensions(probe.commandPath);
  }

  if (commands.length > 0) {
    return false;
  }

  if (hasAnyCapability(capabilities, CONSERVATIVE_EXTENSION_ACTIVATION_CAPABILITIES)) {
    return true;
  }

  if (capabilities.has("importers")) {
    return probe.allowCommandPrefixMatch === true;
  }

  return false;
}

function discoveryNeedsActivationForProbe(
  discovery: ExtensionDiscoveryResult,
  probe: RuntimeExtensionActivationProbe,
): boolean {
  if (discovery.effective.length === 0) {
    return false;
  }
  const hasCommandProbe = normalizeExtensionCommandPath(probe.commandPath ?? "").length > 0;
  if (!hasCommandProbe) {
    return discovery.effective.some((extension) => {
      const capabilities = extensionCapabilities(extension);
      return (
        extensionActivationCommands(extension).length > 0 ||
        hasAnyCapability(capabilities, GLOBAL_EXTENSION_ACTIVATION_CAPABILITIES) ||
        hasAnyCapability(capabilities, CONSERVATIVE_EXTENSION_ACTIVATION_CAPABILITIES) ||
        capabilities.has("importers") ||
        capabilities.has("search")
      );
    });
  }
  return discovery.effective.some((extension) => extensionNeedsActivationForProbe(extension, probe));
}

function buildBootstrapActivationProbe(invocationArgv: string[]): RuntimeExtensionActivationProbe {
  const helpRequest = parseBootstrapHelpRequest(invocationArgv);
  if (helpRequest.requested && helpRequest.commandPathTokens.length > 0) {
    const [commandPath, ...commandArgs] = helpRequest.commandPathTokens;
    return {
      commandPath,
      commandArgs,
      allowCommandPrefixMatch: true,
    };
  }

  const stripped = stripGlobalBootstrapTokens(invocationArgv);
  const commandIndex = stripped.findIndex((token) => token.trim().length > 0 && !token.startsWith("-"));
  if (commandIndex < 0) {
    return {};
  }
  return {
    commandPath: stripped[commandIndex],
    commandArgs: stripped.slice(commandIndex + 1),
    allowCommandPrefixMatch: helpRequest.requested,
  };
}

function collectParsedActivationCommandArgs(command: Command): string[] {
  const commandArgs = command.args.map(String);
  const commandPath = normalizeExtensionCommandPath(getCommandPath(command));
  if (commandPath === "create") {
    const options = command.optsWithGlobals() as Record<string, unknown>;
    if (typeof options.template === "string" && options.template.trim().length > 0) {
      commandArgs.push("--template");
    }
  }
  return commandArgs;
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

function emitExtensionSkippedProfile(
  profileEnabled: boolean | undefined,
  snapshot: RuntimeExtensionDiscoverySnapshot,
  probe: RuntimeExtensionActivationProbe,
): void {
  if (!profileEnabled) {
    return;
  }
  const command = normalizeExtensionCommandPath(probe.commandPath ?? "") || "<none>";
  printError(
    `profile:extensions activation=skipped command=${command} effective=${snapshot.discovery.effective.length} warnings=${snapshot.discovery.warnings.length} discovery_ms=${snapshot.discoveryMs}`,
  );
}

async function loadRuntimeExtensionDiscoverySnapshot(pmRoot: string): Promise<RuntimeExtensionDiscoverySnapshot | null> {
  const cacheKey = buildRuntimeExtensionDiscoverySnapshotCacheKey(pmRoot);
  if (runtimeExtensionDiscoverySnapshotCache?.key === cacheKey) {
    return runtimeExtensionDiscoverySnapshotCache.snapshot;
  }

  const settingsPath = getSettingsPath(pmRoot);
  if (!(await pathExists(settingsPath))) {
    runtimeExtensionDiscoverySnapshotCache = {
      key: cacheKey,
      snapshot: null,
    };
    return null;
  }

  try {
    const startedAt = Date.now();
    const settings = await readSettings(pmRoot);
    const discovery = await discoverExtensions({
      pmRoot,
      settings,
      cwd: process.cwd(),
      noExtensions: false,
    });
    const snapshot: RuntimeExtensionDiscoverySnapshot = {
      pmRoot,
      settings,
      discovery,
      discoveryMs: Date.now() - startedAt,
    };
    runtimeExtensionDiscoverySnapshotCache = {
      key: cacheKey,
      snapshot,
    };
    return snapshot;
  } catch {
    runtimeExtensionDiscoverySnapshotCache = {
      key: cacheKey,
      snapshot: null,
    };
    return null;
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
  const discoverySnapshot = await loadRuntimeExtensionDiscoverySnapshot(pmRoot);
  if (!discoverySnapshot) {
    return null;
  }
  const probe: RuntimeExtensionActivationProbe = {
    commandPath: getCommandPath(command),
    commandArgs: collectParsedActivationCommandArgs(command),
  };
  if (!discoveryNeedsActivationForProbe(discoverySnapshot.discovery, probe)) {
    emitExtensionSkippedProfile(globalOptions.profile, discoverySnapshot, probe);
    return null;
  }

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
      const cause = extensionCommandResult.errorMessage?.trim();
      const causeSuffix = cause ? ` ${cause}` : "";
      throw new PmCliError(
        `Command "${commandPath}" failed in extension handler (${warningCode}).${causeSuffix}`,
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
          ? collectExtensionFlagDefinitionsForInvocation(activeRegistrations, commandPath, commandArgs)
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
          printResult(extensionCommandResult.result, {
            ...globalOptions,
            command: commandPath,
            commandArgs,
            commandOptions,
            pmRoot,
          });
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
  const pmRoot = resolvePmRoot(process.cwd(), bootstrapGlobalOptions.path);
  if (bootstrapGlobalOptions.noExtensions) {
    activeRuntimeExtensionCommandDescriptors = new Map<string, ExtensionCommandHelpDescriptor>();
    setActiveExtensionServices({ overrides: [] });
    await maybeAttachCreateUpdatePolicyHelpText(
      rootProgram,
      pmRoot,
      invocationArgv,
      createEmptyExtensionRegistrationRegistry(),
    );
    return;
  }

  const discoverySnapshot = await loadRuntimeExtensionDiscoverySnapshot(pmRoot);
  const probe = buildBootstrapActivationProbe(invocationArgv);
  if (!discoverySnapshot) {
    activeRuntimeExtensionCommandDescriptors = new Map<string, ExtensionCommandHelpDescriptor>();
    setActiveExtensionServices({ overrides: [] });
    return;
  }
  if (!discoveryNeedsActivationForProbe(discoverySnapshot.discovery, probe)) {
    activeRuntimeExtensionCommandDescriptors = new Map<string, ExtensionCommandHelpDescriptor>();
    setActiveExtensionServices({ overrides: [] });
    await maybeAttachCreateUpdatePolicyHelpText(
      rootProgram,
      pmRoot,
      invocationArgv,
      createEmptyExtensionRegistrationRegistry(),
      discoverySnapshot.settings,
    );
    emitExtensionSkippedProfile(bootstrapProfileEnabled(invocationArgv), discoverySnapshot, probe);
    return;
  }

  const snapshot = await loadRuntimeExtensionSnapshot(pmRoot);
  if (!snapshot) {
    activeRuntimeExtensionCommandDescriptors = new Map<string, ExtensionCommandHelpDescriptor>();
    setActiveExtensionServices({ overrides: [] });
    await maybeAttachCreateUpdatePolicyHelpText(
      rootProgram,
      pmRoot,
      invocationArgv,
      createEmptyExtensionRegistrationRegistry(),
      discoverySnapshot.settings,
    );
    return;
  }
  // Ensure usage/help/error formatting overrides are available even when parse
  // errors occur before preAction hooks initialize full runtime extension state.
  setActiveExtensionServices(snapshot.services);
  activeRuntimeExtensionCommandDescriptors = new Map(snapshot.commandDescriptors);
  await maybeAttachCreateUpdatePolicyHelpText(rootProgram, pmRoot, invocationArgv, snapshot.registrations, snapshot.settings);

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
      .action(async (...actionArgs: unknown[]) => {
        const maybeCommand = actionArgs[actionArgs.length - 1];
        const command = maybeCommand instanceof Command ? maybeCommand : dynamicCommand;
        const globalOptions = getGlobalOptions(command);
        const startedAt = Date.now();
        const extensionFlagDefinitions = collectExtensionFlagDefinitionsForInvocation(
          snapshot.registrations,
          commandPath,
          command.args.map(String),
        );
        const scopedOptions = extractCommandScopedOptions(
          command,
          command.args.map(String),
          extensionFlagDefinitions,
        );
        const result = await runRequiredExtensionCommand(command, scopedOptions, globalOptions);
        await invalidateSearchCachesForMutation(globalOptions, result);
        printResult(result, {
          ...globalOptions,
          command: commandPath,
          commandArgs: command.args.map(String),
          commandOptions: scopedOptions,
          pmRoot,
        });
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
  .option("--no-changed-fields", "Omit the changed_fields array from mutation output (keeps changed_field_count)")
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

  const extensionFlagDefinitions = collectExtensionFlagDefinitionsForInvocation(
    runtimeExtensions.registrations,
    commandPath,
    commandArgs,
  );
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

const VERSION_FLAG_TOKENS = new Set(["--version", "-V"]);
const SETUP_COMMAND_NAMES = new Set([
  "config",
  "extension",
  "init",
  "install",
  "package",
  "packages",
  "templates",
  "upgrade",
]);
const LIST_QUERY_COMMAND_NAMES = new Set([
  "activity",
  "aggregate",
  "context",
  "ctx",
  "get",
  "history",
  "list",
  "list-all",
  "list-blocked",
  "list-canceled",
  "list-closed",
  "list-draft",
  "list-in-progress",
  "list-open",
  "search",
]);
const MUTATION_COMMAND_NAMES = new Set([
  "append",
  "close",
  "comments",
  "delete",
  "deps",
  "discover",
  "docs",
  "files",
  "learnings",
  "notes",
  "plan",
  "restore",
  "update",
  "update-many",
  "create",
]);
const OPERATION_COMMAND_NAMES = new Set([
  "claim",
  "close-task",
  "contracts",
  "gc",
  "health",
  "pause-task",
  "release",
  "start-task",
  "stats",
  "test",
  "test-all",
  "test-runs",
  "test-runs-worker",
  "validate",
]);
const MUTATING_OPERATION_COMMAND_NAMES = new Set([
  "claim",
  "close-task",
  "pause-task",
  "release",
  "start-task",
  "test",
]);
interface CoreCommandRegistrationSelection {
  setup: boolean;
  listQuery: boolean;
  mutation: boolean;
  operation: boolean;
  targetCommandName?: string;
}
const REGISTER_ALL_CORE_COMMAND_FAMILIES: CoreCommandRegistrationSelection = {
  setup: true,
  listQuery: true,
  mutation: true,
  operation: true,
};

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

function resolveCoreCommandRegistrationSelection(
  invocationArgv: string[],
): CoreCommandRegistrationSelection {
  if (invocationRequestsVersion(invocationArgv)) {
    return {
      setup: false,
      listQuery: false,
      mutation: false,
      operation: false,
    };
  }
  if (
    invocationArgv.length === 0 ||
    parseBootstrapHelpRequest(invocationArgv).requested
  ) {
    return REGISTER_ALL_CORE_COMMAND_FAMILIES;
  }
  const commandName = parseBootstrapCommandName(invocationArgv);
  if (!commandName) {
    return REGISTER_ALL_CORE_COMMAND_FAMILIES;
  }
  const normalizedCommand = commandName.trim().toLowerCase();
  if (SETUP_COMMAND_NAMES.has(normalizedCommand)) {
    return {
      setup: true,
      listQuery: false,
      mutation: false,
      operation: false,
      targetCommandName: normalizedCommand,
    };
  }
  if (LIST_QUERY_COMMAND_NAMES.has(normalizedCommand)) {
    return {
      setup: false,
      listQuery: true,
      mutation: false,
      operation: false,
      targetCommandName: normalizedCommand,
    };
  }
  if (MUTATION_COMMAND_NAMES.has(normalizedCommand)) {
    return {
      setup: false,
      listQuery: false,
      mutation: true,
      operation: false,
      targetCommandName: normalizedCommand,
    };
  }
  if (OPERATION_COMMAND_NAMES.has(normalizedCommand)) {
    return {
      setup: false,
      listQuery: false,
      mutation: false,
      operation: true,
      targetCommandName: normalizedCommand,
    };
  }
  return REGISTER_ALL_CORE_COMMAND_FAMILIES;
}

function shouldAttachRichHelpTextForInvocation(invocationArgv: string[]): boolean {
  return (
    invocationArgv.length === 0 ||
    parseBootstrapHelpRequest(invocationArgv).requested
  );
}

async function registerCoreCommandFamilies(
  rootProgram: Command,
  selection: CoreCommandRegistrationSelection,
): Promise<void> {
  if (selection.setup) {
    const { registerSetupCommands } = await loadSetupRegistrationModule();
    registerSetupCommands(rootProgram);
  }
  if (selection.listQuery) {
    const { registerListQueryCommands } =
      await loadListQueryRegistrationModule();
    const commandFilter =
      typeof selection.targetCommandName === "string" &&
      LIST_QUERY_COMMAND_NAMES.has(selection.targetCommandName)
        ? new Set([selection.targetCommandName])
        : undefined;
    registerListQueryCommands(rootProgram, commandFilter ? { commandFilter } : undefined);
  }
  if (selection.mutation) {
    const { registerMutationCommands } = await loadMutationRegistrationModule();
    registerMutationCommands(rootProgram);
  }
  if (selection.operation) {
    const { registerOperationCommands } = await loadOperationRegistrationModule();
    registerOperationCommands(rootProgram);
  }
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

function enforceExplicitRetryForMutatingFlagTypos(
  bootstrapInvocation: ReturnType<typeof normalizeBootstrapInvocation>,
): void {
  const commandName = bootstrapInvocation.commandName;
  if (
    !commandName ||
    (!MUTATION_COMMAND_NAMES.has(commandName) &&
      !MUTATING_OPERATION_COMMAND_NAMES.has(commandName))
  ) {
    return;
  }
  const typoEvent = bootstrapInvocation.trace.find((entry) => entry.reason === "flag_typo");
  if (!typoEvent) {
    return;
  }
  const normalizedTokens = Array.isArray(typoEvent.to)
    ? typoEvent.to
    : [String(typoEvent.to ?? "")].filter((entry) => entry.length > 0);
  const normalizedDisplay = normalizedTokens.length > 0 ? normalizedTokens.join(" ") : "the canonical flag";
  throw new PmCliError(
    `Refusing to auto-correct mutating option ${typoEvent.from} to ${normalizedDisplay}. Retry with the canonical flag so the mutation is explicit.`,
    EXIT_CODE.USAGE,
    {
      code: "mutating_flag_typo_requires_retry",
      examples: [renderPmCommand(bootstrapInvocation.argv)],
      nextSteps: ["Retry the command with the canonical flag shown in examples."],
      recovery: {
        normalized_args: [...bootstrapInvocation.argv],
        suggested_retry: renderPmCommand(bootstrapInvocation.argv),
      },
    },
  );
}

export async function runPmCli(rawArgv: string[] = process.argv.slice(2)): Promise<void> {
  const bootstrapInvocation = normalizeBootstrapInvocation(rawArgv);
  const invocationArgv = bootstrapInvocation.argv;
  const invocationProcessArgv = [process.argv[0], process.argv[1], ...invocationArgv];
  const isBareInvocation = invocationArgv.length === 0;
  try {
    enforceExplicitRetryForMutatingFlagTypos(bootstrapInvocation);
    applyBootstrapPagerPolicy(invocationArgv);
    const registrationSelection =
      resolveCoreCommandRegistrationSelection(invocationArgv);
    await registerCoreCommandFamilies(program, registrationSelection);
    if (shouldAttachRichHelpTextForInvocation(invocationArgv)) {
      attachRichHelpText(program, invocationArgv);
    }
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
    if (isBareInvocation) {
      program.outputHelp();
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
      const bootstrapProbe = buildBootstrapActivationProbe(invocationArgv);
      const discoverySnapshot = await loadRuntimeExtensionDiscoverySnapshot(bootstrapPmRoot);
      if (discoverySnapshot && discoveryNeedsActivationForProbe(discoverySnapshot.discovery, bootstrapProbe)) {
        const bootstrapSnapshot = await loadRuntimeExtensionSnapshot(bootstrapPmRoot);
        setActiveExtensionServices(bootstrapSnapshot?.services ?? { overrides: [] });
      } else {
        if (discoverySnapshot) {
          emitExtensionSkippedProfile(bootstrapProfileEnabled(invocationArgv), discoverySnapshot, bootstrapProbe);
        }
        setActiveExtensionServices({ overrides: [] });
      }
    }

    const numericExitCode = readThrownExitCode(error);
    if (
      error instanceof PmCliError ||
      (!isCommanderError(error) && typeof numericExitCode === "number" && Number.isFinite(numericExitCode))
    ) {
      const errorMessage = describeUnknownError(error);
      const exitCode = error instanceof PmCliError ? error.exitCode : normalizeThrownExitCode(numericExitCode as number);
      const context = error instanceof PmCliError ? error.context : undefined;
      const enrichedContext = buildPmCliRecoveryContext(context, invocationArgv, errorMessage);
      const classification = classifyPmCliError(errorMessage, enrichedContext);
      const { errorCategory, commandResolution } = await emitTelemetryCommandError({
        command: attemptedCommand,
        errorCode: classification.code,
        errorMessage: classification.detail,
        exitCode,
        options: {
          bootstrap_global_options: bootstrapGlobal,
        },
        resolutionStage: "execute",
      });
      const loggedHandledErrorToSentry = await maybeLogHandledCliErrorToSentry({
        command: attemptedCommand,
        error_code: classification.code,
        error_category: errorCategory,
        exit_code: exitCode,
        error_message: classification.detail,
        command_resolution: commandResolution,
        resolution_stage: "execute",
        source_context: activeTelemetryCommandContext?.source_context,
      });
      sentryFinishCommandSpan(false, errorMessage, {
        error_code: classification.code,
        error_category: errorCategory,
        exit_code: exitCode,
        command_resolution: commandResolution,
        resolution_stage: "execute",
      });
      await runAndClearAfterCommandHooks({
        ok: false,
        error: errorMessage,
        exit_code: exitCode,
        error_code: classification.code,
        error_category: errorCategory,
        command_resolution: commandResolution,
        resolution_stage: "execute",
      });
      sentryCaptureCliError(wrapThrownErrorForSentry(error, errorMessage));
      if (jsonErrors) {
        printError(JSON.stringify(formatPmCliErrorForJson(errorMessage, exitCode, enrichedContext), null, 2));
      } else {
        printError(formatPmCliErrorForDisplay(errorMessage, enrichedContext));
      }
      if (loggedHandledErrorToSentry) {
        await sentryFlush(HANDLED_ERROR_SENTRY_FLUSH_TIMEOUT_MS);
      }
      process.exitCode = exitCode;
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
          const loggedHandledErrorToSentry = await maybeLogHandledCliErrorToSentry({
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
          if (loggedHandledErrorToSentry) {
            await sentryFlush(HANDLED_ERROR_SENTRY_FLUSH_TIMEOUT_MS);
          }
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
        const loggedHandledErrorToSentry = await maybeLogHandledCliErrorToSentry({
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
        if (loggedHandledErrorToSentry) {
          await sentryFlush(HANDLED_ERROR_SENTRY_FLUSH_TIMEOUT_MS);
        }
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

export const _testOnly = {
  isCommanderError,
  normalizeThrownExitCode,
  readThrownExitCode,
  shouldLogHandledErrorToSentry,
  wrapThrownErrorForSentry,
};
