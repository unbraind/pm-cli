/**
 * @module cli/main
 * Coordinates CLI invocation state, extension lifecycle and command dispatch.
 */
import { Command,CommanderError } from "commander";
import { findPmNamespacedCommand,resolvePmCommandOperation } from "../sdk/cli-contracts/command-aliases.js";
import { createPmCliProgram } from "../sdk/cli-program.js";
import { runWithDiscoveredContextIntentContracts } from "../sdk/context-intent-runtime.js";
import { describeUnknownError,isCommanderError,normalizeThrownExitCode,readThrownExitCode,wrapThrownErrorForSentry } from "../sdk/error-runtime.js";
import { createExtensionCommandSdk } from "../sdk/extension-command-context.js";
import { runExtensionMigrations } from "../sdk/extension/migrations.js";
import { applyInvocationAuthorOverride } from "../sdk/invocation-author.js";
import { attachOutputTokenAccounting } from "../sdk/output-token-accounting.js";
import {
  validateReadOutputOptions
} from "../sdk/read-output-contracts.js";
import { runWithReproducibleProcessEnvironment } from "../sdk/reproducibility/process.js";
import {
  type ActiveExtensionHookContext,
  type ActiveTelemetryCommand,
  type ExtensionCommandRegistry,
  type ExtensionDiscoveryResult,
  type ExtensionHookRegistry,
  type ExtensionParserRegistry,
  type ExtensionPreflightRegistry,
  type ExtensionRendererRegistry,
  type ExtensionServiceRegistry,
  type GlobalOptions,
  type PmCliErrorContext,
  type PmCliErrorRecoveryPayload,
  type PreflightRuntimeDecision,
  type RegisteredExtensionSchemaMigrationDefinition,
  type RuntimeFieldCommand,
  type TelemetryCommandOutcome,
  type TelemetryCommandResolution,
  type TelemetryErrorCategory,
  type TelemetryResolutionStage,
  EXIT_CODE,
  PmCliError,
  activateExtensions,
  clearActiveExtensionHooks,
  consumeAfterCommandAffectedItems,
  createCoreCommandHookContext,
  createEmptyExtensionRegistrationRegistry,
  createLazyModule,
  deriveTelemetryCommandResolution,
  discoverExtensions,
  emitTelemetryErrorEvent,
  ensureSentryInit,
  getActiveCommandResult,
  getActiveExtensionRegistrations,
  getSettingsPath,
  loadExtensions,
  maybeRunFirstUseTelemetryPrompt,
  pathExists,
  printError,
  printResult,
  readSettings,
  readSettingsWithMetadata,
  resetActiveExtensionRuntimeState,
  resolveItemTypeRegistry,
  resolvePmCliVersion,
  resolvePmPackageRootFromModule,
  resolvePmRoot,
  resolveRuntimeFieldRegistry,
  resolveTelemetryErrorCategory,
  runActiveCommandHandler,
  runActiveParserOverride,
  runActivePreflightOverride,
  runAfterCommandHooks,
  runBeforeCommandHooks,
  runWithHarnessDetectionSignals,
  runWithWorkspaceHarnessSignalDescriptors,
  sentryCaptureCliError,
  sentryFinishCommandSpan,
  sentryFlush,
  sentryLogCliUsageError,
  sentrySetCommandContext,
  sentryStartCommandSpan,
  setActiveCommandContext,
  setActiveCommandResult,
  setActiveExtensionCommands,
  setActiveExtensionHooks,
  setActiveExtensionParsers,
  setActiveExtensionPreflight,
  setActiveExtensionRegistrations,
  setActiveExtensionRenderers,
  setActiveExtensionServices,
  startTelemetryCommand,
  writeStderr
} from "../sdk/runtime-primitives.js";
import { PmClient } from "../sdk/runtime.js";
import type { PmSettings } from "../types/index.js";
import { finishActiveTelemetryCommand,recordAfterCommandContextUsage } from "./after-command-context-usage.js";
import { extractProvidedOptionFlags,normalizeLongOptionFlag,redactSensitiveCommandArgs,renderPmCommand } from "./argv-utils.js";
import {
  applyBootstrapPagerPolicy,
  findBootstrapCommandTokenIndex,
  normalizeBootstrapInvocation,
  parseBootstrapCommandName,
  parseBootstrapGlobalOptions,
  parseBootstrapHelpRequest,
  stripGlobalBootstrapTokens,
} from "./bootstrap-args.js";
import { installCommandNamespaces } from "./command-namespaces.js";
import {
  appendCommanderExtensionFailures,
  formatCommanderUsageJson,
  formatCommanderUsageMessage,
  isKnownHelpCommandPath,
  resolveCommanderUsageContext,
  resolveUnknownCommanderToken,
} from "./commander-usage.js";
import { loadContextIntentSnapshotForInvocation } from "./context-intent-invocation.js";
import {
  classifyCommanderError,
  classifyPmCliError,
  classifyUnknownError,
  formatPmCliErrorForDisplay,
  formatPmCliErrorForJson,
  formatUnknownErrorForJson,
  projectLeanErrorEnvelope,
} from "./error-guidance.js";
import {
  type ExtensionCommandHelpDescriptor,
  applyDynamicExtensionArguments,
  applyDynamicExtensionFlagOptions,
  buildCanonicalExtensionAliases,
  buildDynamicExtensionCommandMetadataHelp,
  buildResidualDynamicExtensionFlagHelp,
  collectDynamicExtensionFlagHelpByCommand,
  collectExtensionCommandHelpDescriptors,
  collectSafeExtensionCommandPaths,
  ensureCommandPath,
  extensionFlagTakesValueForInvocation,
  findCommandByPath,
  normalizeExtensionCommandPath,
  reportExtensionCommandCollision,
} from "./extension-command-help.js";
import {
  type LooseCommandFlagDefinition,
  collectLoosePositionalArgs,
  stripLooseCommandOptionTokens
} from "./extension-command-options.js";
import { loadExtensionRecoveryFailures,loadUnknownCommandRecoveryFailures } from "./extension-recovery.js";
import {
  attachRichHelpText,
  isFullHelpDiscovery,
  setPmCommandHelpVisibilityTier,
} from "./help-content.js";
import { attachCreateUpdatePolicyHelpText,maybeRenderBootstrapJsonHelp } from "./help-json-payload.js";
import {
  type MandatoryMigrationBlocker,
  collectMandatoryMigrationBlockers,
  enforceItemFormatWriteGateAndPreflightMigration,
  enforceMandatoryMigrationWriteGate,
  enforceMutationGuardPreflight,
} from "./migration-gates.js";
import type { registerListQueryCommands as RegisterListQueryCommandsFn } from "./register-list-query.js";
import type { registerMutationCommands as RegisterMutationCommandsFn } from "./register-mutation.js";
import type { registerOperationCommands as RegisterOperationCommandsFn } from "./register-operations.js";
import type { registerSetupCommands as RegisterSetupCommandsFn } from "./register-setup.js";
import {
  applyDefaultOutputFormat,
  clearResolvedGlobalOptions,
  collect,
  formatHookWarnings,
  getCommandPath,
  getGlobalOptions,
  invalidateSearchCachesForMutation,
  setResolvedGlobalOptions,
  syncCommanderActionOptions,
} from "./registration-helpers.js";
import type { RuntimeExtensionActivationProbe } from "./runtime/activation.js";
import { activationCommandMatchesProbe,buildBootstrapActivationProbe,buildRuntimeExtensionActivationScope,buildRuntimeExtensionFilterForProbe,collectActivationCommandCandidates,collectLeadingCommandArgs,collectParsedActivationCommandArgs,commandPathNeedsSearchExtensions,commandPathNeedsTemplateExtensions,discoveryNeedsActivationForProbe,extensionActivationCommands,extensionCapabilities,extensionNeedsActivationForProbe,extensionProvidesTemplatesRuntime,hasAnyCapability,hasGlobalExtensionContributions,matchesStaticExtensionCommand,probeUsesAnyFlag,resolveStaticExtensionActivationDecision } from "./runtime/activation.js";
import { collectExtensionFlagDefinitionsForCommand,collectExtensionFlagDefinitionsForInvocation,dynamicCommandArguments,extractCommandScopedOptions,forwardReadOutputIncludeModes,isImporterOrExporterCommandPath,recordCliReadOutputInvocationProvenance,validateDynamicExtensionCommandArgs,validateDynamicExtensionCommandInvocation } from "./runtime/invocation-options.js";
import type { CoreCommandRegistrationSelection } from "./runtime/selection.js";
import { LIST_QUERY_COMMAND_NAMES,enforceExplicitRetryForFlagTypos,invocationRequestsVersion,resolveCoreCommandRegistrationSelection,shouldAttachRichHelpTextForInvocation,shouldRegisterDynamicExtensionPaths,shouldRegisterRuntimeSchemaFlags } from "./runtime/selection.js";
import { buildPostActionTelemetryOutcome,inferPostActionErrorCode,inferPostActionFailureMessage,normalizeTelemetryCommandResolution,normalizeTelemetryErrorCategory,normalizeTelemetryResolutionStage,readRecordBoolean,readRecordNumber,readRecordString } from "./runtime/telemetry-outcome.js";

const PM_PACKAGE_ROOT_ENV = "PM_CLI_PACKAGE_ROOT";

function resolvePmPackageRoot(): string {
  return resolvePmPackageRootFromModule(import.meta.url, ["../.."]);
}

if (typeof process.env[PM_PACKAGE_ROOT_ENV] !== "string" || process.env[PM_PACKAGE_ROOT_ENV]?.trim().length === 0) {
  process.env[PM_PACKAGE_ROOT_ENV] = resolvePmPackageRoot();
}

let activeExtensionHookContext: ActiveExtensionHookContext<MandatoryMigrationBlocker> | null = null;

let activeTelemetryCommandContext: ActiveTelemetryCommand | null = null;

function setActiveExtensionHookContextForTest(context: ActiveExtensionHookContext<MandatoryMigrationBlocker> | null): void {
  activeExtensionHookContext = context;
}

function setActiveRuntimeExtensionCommandDescriptorsForTest(descriptors: Map<string, ExtensionCommandHelpDescriptor>): void {
  activeRuntimeExtensionCommandDescriptors = descriptors;
}

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
  commandAliases: Map<string, string>;
  loadWarnings: string[];
  activationWarnings: string[];
  loadedCount: number;
  loadFailedCount: number;
  activationFailedCount: number;
  contextIntentPackages: Array<{ name: string; module: unknown }>;
}

interface RuntimeExtensionDiscoverySnapshot {
  pmRoot: string;
  settings: PmSettings;
  discovery: ExtensionDiscoveryResult;
  discoveryMs: number;
  settingsReadWarnings: string[];
}

let runtimeExtensionSnapshotCache: {
  key: string;
  snapshot: RuntimeExtensionSnapshot | null;
} | null = null;

let runtimeExtensionDiscoverySnapshotCache: {
  key: string;
  snapshot: RuntimeExtensionDiscoverySnapshot | null;
} | null = null;

let activeRuntimeExtensionCommandDescriptors = new Map<string, ExtensionCommandHelpDescriptor>();

const HANDLED_ERROR_SENTRY_FLUSH_TIMEOUT_MS = 250;

const EXPECTED_HANDLED_ERROR_EXIT_CODES = new Set<number>([EXIT_CODE.USAGE, EXIT_CODE.NOT_FOUND, EXIT_CODE.CONFLICT]);

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

/* c8 ignore start */

function renderAttemptedCommand(argv: string[]): string {
  return renderPmCommand(argv);
}

function inferMissingFieldsFromErrorMessage(message: string): string[] | undefined {
  const matches = message.match(/--[a-zA-Z0-9][a-zA-Z0-9_-]*/g);
  if (!matches || matches.length === 0) {
    return undefined;
  }
  /* c8 ignore next */
  const normalized = [...new Set(matches.map((entry) => normalizeLongOptionFlag(entry) ?? entry))];
  /* c8 ignore next */
  return normalized.length > 0 ? normalized : undefined;
}

function inferMissingFieldsForRecovery(rawMessage: string, invocationArgv: string[], existingRecovery: PmCliErrorRecoveryPayload | undefined): string[] | undefined {
  if (existingRecovery?.suggested_retry || rawMessage.includes("failed in extension handler (") || !/\b(?:missing|required|requires)\b/i.test(rawMessage)) {
    return undefined;
  }
  const providedFields = extractProvidedOptionFlags(invocationArgv);
  const providedSet = new Set(providedFields.map((flag) => normalizeLongOptionFlag(flag) ?? flag));
  const rawInferred = inferMissingFieldsFromErrorMessage(rawMessage);
  const commandName = invocationArgv.find((token) => program.commands.some((candidate) => candidate.name() === token));
  const command = commandName ? program.commands.find((candidate) => candidate.name() === commandName) : undefined;
  const declaredFlags = new Set(
    [...program.options, ...(command?.options ?? [])].flatMap((option) =>
      option.flags
        .split(/[ ,|]+/)
        .map((flag) => normalizeLongOptionFlag(flag))
        .filter((flag): flag is string => flag !== undefined),
    ),
  );
  const trulyMissing = rawInferred?.filter((flag) => {
    const normalized = normalizeLongOptionFlag(flag) ?? flag;
    if (providedSet.has(normalized)) {
      return false;
    }
    return declaredFlags.has(normalized) || extensionFlagTakesValueForInvocation(invocationArgv, commandName, normalized, activeRuntimeExtensionCommandDescriptors) !== undefined;
  });
  return trulyMissing && trulyMissing.length > 0 ? trulyMissing : undefined;
}

function resolveRecoverySuggestedRetry(
  invocationArgv: string[],
  attemptedCommand: string,
  inferredMissing: string[] | undefined,
  existingRecovery: PmCliErrorRecoveryPayload | undefined,
): string | undefined {
  if (existingRecovery?.suggested_retry) {
    return existingRecovery.suggested_retry;
  }
  const missingFlag = inferredMissing?.[0];
  const normalizedMissing = missingFlag ? normalizeLongOptionFlag(missingFlag) : undefined;
  const commandName = invocationArgv.find((token) => program.commands.some((candidate) => candidate.name() === token));
  const command = commandName ? program.commands.find((candidate) => candidate.name() === commandName) : undefined;
  const missingOption = normalizedMissing ? command?.options.find((option) => option.flags.split(/[ ,|]+/).includes(normalizedMissing)) : undefined;
  const extensionFlagTakesValue = extensionFlagTakesValueForInvocation(invocationArgv, commandName, normalizedMissing, activeRuntimeExtensionCommandDescriptors);
  const missingTokens = normalizedMissing ? (missingOption?.isBoolean() === true || extensionFlagTakesValue === false ? [normalizedMissing] : [normalizedMissing, "<value>"]) : [];
  const suggestedRetry = normalizedMissing ? renderAttemptedCommand([...invocationArgv, ...missingTokens]) : attemptedCommand;
  return suggestedRetry === attemptedCommand ? undefined : suggestedRetry;
}

function projectExistingRecoveryOptionalFields(existingRecovery: PmCliErrorRecoveryPayload | undefined): Partial<PmCliErrorRecoveryPayload> {
  if (!existingRecovery) {
    return {};
  }
  const optionalFields: Array<keyof PmCliErrorRecoveryPayload> = [
    "recovery_mode",
    "missing_required_fields",
    "suggested_flags",
    "suggested_retry_args",
    "allowed_values",
    "candidate_commands",
    "candidate_commands_total",
    "candidate_commands_truncated",
    "fallback_candidates",
    "next_best_command",
  ];
  const projected: Partial<PmCliErrorRecoveryPayload> = {};
  for (const field of optionalFields) {
    const value = existingRecovery[field];
    if (value !== undefined && value !== null) {
      (projected as Record<string, unknown>)[field] = value;
    }
  }
  return projected;
}

function buildRecoveryPayload(params: {
  invocationArgv: string[];
  attemptedCommand: string;
  providedFields: string[];
  inferredMissing: string[] | undefined;
  suggestedRetry: string | undefined;
  existingRecovery: PmCliErrorRecoveryPayload | undefined;
}): PmCliErrorRecoveryPayload {
  const existingRecovery = params.existingRecovery;
  return {
    attempted_command: existingRecovery?.attempted_command ?? params.attemptedCommand,
    normalized_args: existingRecovery?.normalized_args ?? [...params.invocationArgv],
    /* c8 ignore next */
    provided_fields: existingRecovery?.provided_fields ?? (params.providedFields.length > 0 ? params.providedFields : undefined),
    missing: existingRecovery?.missing ?? params.inferredMissing,
    ...projectExistingRecoveryOptionalFields(existingRecovery),
    ...(params.suggestedRetry ? { suggested_retry: params.suggestedRetry } : {}),
  };
}

/** Build replayable recovery guidance after removing sensitive matcher values from every invocation representation. */
function buildPmCliRecoveryContext(context: PmCliErrorContext | undefined, invocationArgv: string[], rawMessage: string): PmCliErrorContext {
  const safeInvocationArgv = redactSensitiveCommandArgs(invocationArgv);
  const commandArgs = stripGlobalBootstrapTokens(safeInvocationArgv);
  const commandIndex = findBootstrapCommandTokenIndex(commandArgs);
  const [rootCommand, subcommand] = commandIndex === undefined ? [] : commandArgs.slice(commandIndex, commandIndex + 2);
  const explainRequested = safeInvocationArgv.includes("--explain");
  const rawExistingRecovery = context?.recovery;
  const existingRecovery =
    rawExistingRecovery && (rootCommand === "history-redact" || (rootCommand === "history" && subcommand === "redact"))
      ? {
          ...rawExistingRecovery,
          ...(rawExistingRecovery.attempted_command ? { attempted_command: renderAttemptedCommand(safeInvocationArgv) } : {}),
          ...(rawExistingRecovery.normalized_args ? { normalized_args: [...safeInvocationArgv] } : {}),
          ...(rawExistingRecovery.suggested_retry ? { suggested_retry: renderAttemptedCommand(safeInvocationArgv) } : {}),
          ...(rawExistingRecovery.suggested_retry_args ? { suggested_retry_args: [...safeInvocationArgv] } : {}),
        }
      : rawExistingRecovery;
  if (existingRecovery?.recovery_mode === "compact" && !explainRequested) {
    return {
      /* c8 ignore next */
      ...context,
      recovery: existingRecovery,
    };
  }
  const attemptedCommand = renderAttemptedCommand(safeInvocationArgv);
  const providedFields = extractProvidedOptionFlags(safeInvocationArgv);
  const inferredMissing = inferMissingFieldsForRecovery(rawMessage, safeInvocationArgv, existingRecovery);
  const suggestedRetry = resolveRecoverySuggestedRetry(safeInvocationArgv, attemptedCommand, inferredMissing, existingRecovery);
  const recovery = buildRecoveryPayload({
    invocationArgv: safeInvocationArgv,
    attemptedCommand,
    providedFields,
    inferredMissing,
    suggestedRetry,
    existingRecovery,
  });
  return {
    ...context,
    recovery,
  };
}

async function runAndClearAfterCommandHooks(outcome: TelemetryCommandOutcome): Promise<void> {
  const telemetryRuntime = activeTelemetryCommandContext;
  activeTelemetryCommandContext = null;
  await finishActiveTelemetryCommand(telemetryRuntime, outcome);

  const runtime = activeExtensionHookContext;
  activeExtensionHookContext = null;
  if (!runtime) {
    clearActiveExtensionHooks();
    return;
  }

  let hookWarnings: string[] = [];
  const affected = consumeAfterCommandAffectedItems();
  try {
    await recordAfterCommandContextUsage({
      pmRoot: runtime.pmRoot,
      author: runtime.globalOptions.author,
      itemIds: outcome.ok ? (affected?.map((item) => item.id) ?? []) : [],
      intent: runtime.commandName,
    });
  } catch {
    hookWarnings.push("context_usage_feedback_write_failed");
  }
  try {
    hookWarnings.push(
      ...(await runAfterCommandHooks(runtime.hooks, {
        command: runtime.commandName,
        args: runtime.commandArgs,
        options: { ...runtime.commandOptions },
        global: { ...runtime.globalOptions },
        pm_root: runtime.pmRoot,
        ok: outcome.ok,
        error: outcome.error,
        result: getActiveCommandResult(),
        affected,
      })),
    );
  } catch (error) {
    /* c8 ignore next */
    const message = error instanceof Error ? error.message : String(error);
    hookWarnings = [`afterCommand hooks failed: ${message}`];
  } finally {
    clearActiveExtensionHooks();
  }
  if (!runtime.globalOptions.json && hookWarnings.length > 0) {
    printError(`[pm] warning: afterCommand hook_warnings=${formatHookWarnings(hookWarnings)}`);
  }
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

async function handleGenericRunPmCliError(params: {
  error: unknown;
  attemptedCommand: string;
  bootstrapGlobal: GlobalOptions;
  emitTelemetryCommandError: (event: {
    command: string;
    errorCode: string;
    errorMessage: string;
    exitCode: number;
    options: Record<string, unknown>;
    resolutionStage: TelemetryResolutionStage;
  }) => Promise<{
    errorCategory: TelemetryErrorCategory;
    commandResolution: TelemetryCommandResolution;
  }>;
}): Promise<void> {
  const message = describeUnknownError(params.error);
  const classification = classifyUnknownError(message);
  if (params.bootstrapGlobal.json) {
    printError(JSON.stringify(formatUnknownErrorForJson(message, EXIT_CODE.GENERIC_FAILURE), null, 2));
  } else {
    printError(message);
  }
  process.exitCode = EXIT_CODE.GENERIC_FAILURE;

  let errorCategory: TelemetryErrorCategory = "runtime";
  let commandResolution: TelemetryCommandResolution = "runtime_failed";
  try {
    await ensureSentryForErrorReporting();
    sentryCaptureCliError(params.error);
    const telemetry = await params.emitTelemetryCommandError({
      command: params.attemptedCommand,
      errorCode: classification.code,
      errorMessage: classification.detail,
      exitCode: EXIT_CODE.GENERIC_FAILURE,
      options: {
        bootstrap_global_options: params.bootstrapGlobal,
      },
      resolutionStage: "execute",
    });
    errorCategory = telemetry.errorCategory;
    commandResolution = telemetry.commandResolution;
    sentryFinishCommandSpan(false, message, {
      error_code: classification.code,
      error_category: errorCategory,
      exit_code: EXIT_CODE.GENERIC_FAILURE,
      command_resolution: commandResolution,
      resolution_stage: "execute",
    });
  } catch (reportingError) {
    /* c8 ignore next */
    if (!params.bootstrapGlobal.json) {
      printError(`Failed to report error: ${describeUnknownError(reportingError)}`);
    }
  }
  try {
    await runAndClearAfterCommandHooks({
      ok: false,
      error: message,
      exit_code: EXIT_CODE.GENERIC_FAILURE,
      error_code: classification.code,
      error_category: errorCategory,
      command_resolution: commandResolution,
      resolution_stage: "execute",
    });
  } catch (hookError) {
    /* c8 ignore next */
    if (!params.bootstrapGlobal.json) {
      printError(`Failed to run error hooks: ${describeUnknownError(hookError)}`);
    }
  }
  try {
    await sentryFlush();
  } catch (flushError) {
    /* c8 ignore next */
    if (!params.bootstrapGlobal.json) {
      printError(`Failed to flush error reporting: ${describeUnknownError(flushError)}`);
    }
  }
}

/* c8 ignore stop */

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

const runtimeFieldLooseFlagDefinitionCache = new Map<string, LooseCommandFlagDefinition[]>();

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

async function collectRuntimeFieldLooseFlagDefinitionsForCommand(commandPath: string, pmRoot: string): Promise<LooseCommandFlagDefinition[]> {
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
  const cachedDiscovery =
    runtimeExtensionDiscoverySnapshotCache?.key === buildRuntimeExtensionDiscoverySnapshotCacheKey(pmRoot) ? runtimeExtensionDiscoverySnapshotCache.snapshot : null;
  const settings = cachedDiscovery === null ? await readSettings(pmRoot) : cachedDiscovery.settings;
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

function buildRuntimeExtensionSnapshotCacheKey(pmRoot: string, activationScope = "all"): string {
  return activationScope === "all" ? `pm-root:${pmRoot}` : `pm-root:${pmRoot}:activation:${activationScope}`;
}

function bootstrapProfileEnabled(invocationArgv: string[]): boolean {
  return invocationArgv.some((token) => token === "--profile");
}

function buildRuntimeExtensionDiscoverySnapshotCacheKey(pmRoot: string): string {
  return `pm-root:${pmRoot}`;
}

/** Surface settings-read warnings once per command on stderr. readSettings() silently falls back to defaults when settings.json is invalid, so most commands (create/list/search/...) generate the warning but never show it — a typo would change behavior with no explanation. Only the `settings_read_*` codes are surfaced (the corrupt-settings fallbacks: invalid_json / invalid_schema / merge_failed); other informational settings warnings (schema bootstrap, legacy-format coercion) stay quiet. Mirrors the same finding in `pm health`, which also carries a remediation_map for it. */
function emitSettingsReadWarnings(warnings: readonly string[]): void {
  for (const warning of warnings) {
    if (warning.startsWith("settings_read_")) {
      printError(`[pm] warning: ${warning} — settings.json could not be loaded and pm fell back to defaults; run pm health for remediation.`);
    }
  }
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

function emitExtensionSkippedProfile(profileEnabled: boolean | undefined, snapshot: RuntimeExtensionDiscoverySnapshot, probe: RuntimeExtensionActivationProbe): void {
  if (!profileEnabled) {
    return;
  }
  const command = normalizeExtensionCommandPath(probe.commandPath ?? "") || "<none>";
  printError(
    `profile:extensions activation=skipped command=${command} effective=${snapshot.discovery.effective.length} warnings=${snapshot.discovery.warnings.length} discovery_ms=${snapshot.discoveryMs}`,
  );
}

async function loadRuntimeExtensionDiscoverySnapshot(
  pmRoot: string,
  readSettingsWithMetadataFn: typeof readSettingsWithMetadata = readSettingsWithMetadata,
): Promise<RuntimeExtensionDiscoverySnapshot | null> {
  const cacheKey = buildRuntimeExtensionDiscoverySnapshotCacheKey(pmRoot);
  if (runtimeExtensionDiscoverySnapshotCache?.key === cacheKey) {
    return runtimeExtensionDiscoverySnapshotCache.snapshot;
  }

  try {
    const startedAt = Date.now();
    const { settings, warnings: settingsReadWarnings } = await readSettingsWithMetadataFn(pmRoot);
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
      settingsReadWarnings: [...settingsReadWarnings],
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

async function loadRuntimeExtensionSnapshot(
  pmRoot: string,
  probe?: RuntimeExtensionActivationProbe,
  readSettingsFn: typeof readSettings = readSettings,
): Promise<RuntimeExtensionSnapshot | null> {
  const activationScope = probe ? buildRuntimeExtensionActivationScope(probe) : "all";
  const cacheKey = buildRuntimeExtensionSnapshotCacheKey(pmRoot, activationScope);
  if (runtimeExtensionSnapshotCache?.key === cacheKey) {
    return runtimeExtensionSnapshotCache.snapshot;
  }

  try {
    const settings = await readSettingsFn(pmRoot);
    const loadResult = await loadExtensions({
      pmRoot,
      settings,
      cwd: process.cwd(),
      noExtensions: false,
      extensionFilter: probe ? buildRuntimeExtensionFilterForProbe(probe) : undefined,
    });
    const activationResult = await activateExtensions({
      ...loadResult,
      loaded: loadResult.loaded,
    });
    const commandHandlers = [...new Set(activationResult.commands.handlers.map((entry) => normalizeExtensionCommandPath(entry.command)))]
      .filter((entry) => entry.length > 0)
      .sort((left, right) => left.localeCompare(right));
    const commandFlagHelp = collectDynamicExtensionFlagHelpByCommand(activationResult.registrations.flags);
    const canonicalAliases = buildCanonicalExtensionAliases(activationResult.commands.handlers, activationResult.registrations.commands);
    const commandDescriptors = collectExtensionCommandHelpDescriptors(
      commandHandlers,
      activationResult.registrations.commands,
      activationResult.registrations.flags,
      canonicalAliases,
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
      commandAliases: canonicalAliases,
      loadWarnings: [...loadResult.warnings],
      activationWarnings: [...activationResult.warnings],
      loadedCount: loadResult.loaded.length,
      loadFailedCount: loadResult.failed.length,
      activationFailedCount: activationResult.failed.length,
      contextIntentPackages: loadResult.loaded.map(({ name, module }) => ({
        name,
        module,
      })),
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

/* c8 ignore start */

async function maybeLoadRuntimeExtensions(command: Command): Promise<{
  hooks: ExtensionHookRegistry;
  commands: ExtensionCommandRegistry;
  parsers: ExtensionParserRegistry;
  preflight: ExtensionPreflightRegistry;
  services: ExtensionServiceRegistry;
  renderers: ExtensionRendererRegistry;
  registrations: ReturnType<typeof createEmptyExtensionRegistrationRegistry>;
  pmRoot: string;
} | null> {
  const globalOptions = getGlobalOptions(command);
  if (globalOptions.noExtensions) {
    // Extensions are disabled, so the discovery snapshot that normally carries
    // the settings-read warnings is skipped. Surface them directly here (a single
    // read on this uncommon path) so `pm --no-extensions <cmd>` — the common safe
    // mode — still reports a corrupt settings.json instead of silently running on
    // defaults.
    const noExtPmRoot = resolvePmRoot(process.cwd(), globalOptions.path);
    if (await pathExists(getSettingsPath(noExtPmRoot))) {
      emitSettingsReadWarnings((await readSettingsWithMetadata(noExtPmRoot)).warnings);
    }
    return null;
  }

  const pmRoot = resolvePmRoot(process.cwd(), globalOptions.path);
  const discoverySnapshot = await loadRuntimeExtensionDiscoverySnapshot(pmRoot);
  if (!discoverySnapshot) {
    return null;
  }
  // Surface actionable settings-read warnings once per command, before the
  // activation-skipped fast path returns, so create/list/search/... all report a
  // corrupt settings.json instead of silently running on defaults.
  emitSettingsReadWarnings(discoverySnapshot.settingsReadWarnings);
  const probe: RuntimeExtensionActivationProbe = {
    commandPath: getCommandPath(command),
    commandArgs: collectParsedActivationCommandArgs(command),
  };
  if (!discoveryNeedsActivationForProbe(discoverySnapshot.discovery, probe)) {
    emitExtensionSkippedProfile(globalOptions.profile, discoverySnapshot, probe);
    return null;
  }

  const snapshot = await loadRuntimeExtensionSnapshot(pmRoot, probe);
  /* c8 ignore next */
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

/* c8 ignore stop */

async function loadRuntimeExtensionCommandDescriptorsForRecovery(pmRoot: string): Promise<Map<string, ExtensionCommandHelpDescriptor>> {
  const snapshot = await loadRuntimeExtensionSnapshot(pmRoot);
  return snapshot ? new Map(snapshot.commandDescriptors) : activeRuntimeExtensionCommandDescriptors;
}

async function executeRegisteredRuntimeMigrations(migrations: RegisteredExtensionSchemaMigrationDefinition[], pmRoot: string): Promise<string[]> {
  const result = await runExtensionMigrations({
    pmRoot,
    migrations,
    author: "pm-extension-migration",
  });
  return result.migrations
    .filter((migration) => migration.outcome === "failed")
    .map((migration) => `extension_migration_failed:${migration.layer}:${migration.extension}:${migration.id}`);
}

/* c8 ignore start */

/** Build one host-bound extension SDK using the command's resolved author. */
function buildExtensionCommandSdk(pmRoot: string, global: GlobalOptions) {
  const author = typeof global.author === "string" && global.author.trim() ? global.author.trim() : "pm-extension";
  return createExtensionCommandSdk(pmRoot, PmClient.forActiveExtensionHost({ pmRoot, author }));
}

async function runRequiredExtensionCommand(
  command: Command,
  options: Record<string, unknown>,
  globalOptions: GlobalOptions,
  extensionFlagDefinitions: LooseCommandFlagDefinition[] = [],
): Promise<unknown> {
  const commandPath = getCommandPath(command);
  let commandArgs = stripLooseCommandOptionTokens(command.args.map(String), extensionFlagDefinitions);
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
  validateDynamicExtensionCommandInvocation(
    activeRuntimeExtensionCommandDescriptors.get(normalizeExtensionCommandPath(commandPath)),
    commandArgs,
    commandOptions,
    extensionFlagDefinitions,
  );
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
    sdk: buildExtensionCommandSdk(pmRoot, resolvedGlobalOptions),
  });
  if (resolvedGlobalOptions.profile && extensionCommandResult.warnings.length > 0) {
    printError(`profile:extensions command_handler_warnings=${formatHookWarnings(extensionCommandResult.warnings)}`);
  }
  if (!extensionCommandResult.handled) {
    if (extensionCommandResult.warnings.length > 0) {
      const warningCode = extensionCommandResult.warnings[0];
      const cause = extensionCommandResult.errorMessage?.trim();
      /* c8 ignore next */
      const causeSuffix = cause ? ` ${cause}` : "";
      throw new PmCliError(`Command "${commandPath}" failed in extension handler (${warningCode}).${causeSuffix}`, EXIT_CODE.GENERIC_FAILURE, {
        code: extensionCommandResult.errorCode ?? "command_failed",
        nextSteps: extensionCommandResult.remediation ? [extensionCommandResult.remediation] : undefined,
      });
    }
    throw new PmCliError(`Command "${commandPath}" is provided by extensions and is not currently available.`, EXIT_CODE.NOT_FOUND);
  }
  if (extensionCommandResult.exitCode !== undefined) {
    process.exitCode = extensionCommandResult.exitCode;
  }
  setActiveCommandResult(extensionCommandResult.result);
  return extensionCommandResult.result;
}

const WRAPPED_ACTION_HANDLER = Symbol("pm.wrappedActionHandler");

type ActionMutableCommand = Command & {
  _actionHandler?: (...args: unknown[]) => unknown;
  [WRAPPED_ACTION_HANDLER]?: boolean;
};

function resolveActionCommand(actionArgs: unknown[], fallback: Command): Command {
  const possibleCommand = actionArgs[actionArgs.length - 1];
  /* c8 ignore next */
  return possibleCommand instanceof Command ? possibleCommand : fallback;
}

function maybePrintExtensionProfileWarnings(enabled: boolean | undefined, label: string, warnings: string[]): void {
  if (enabled && warnings.length > 0) {
    printError(`profile:extensions ${label}=${formatHookWarnings(warnings)}`);
  }
}

function validateDynamicInvocationArgs(params: {
  activeRegistrations: ReturnType<typeof getActiveExtensionRegistrations>;
  commandPath: string;
  commandArgs: string[];
  extensionFlagDefinitions: LooseCommandFlagDefinition[];
}): void {
  const dynamicDescriptor = activeRuntimeExtensionCommandDescriptors.get(normalizeExtensionCommandPath(params.commandPath));
  if (!dynamicDescriptor || !isImporterOrExporterCommandPath(params.activeRegistrations, params.commandPath)) {
    return;
  }
  const positionalArgs =
    dynamicCommandArguments(dynamicDescriptor).length === 0
      ? collectLoosePositionalArgs(params.commandArgs)
      : stripLooseCommandOptionTokens(params.commandArgs, params.extensionFlagDefinitions);
  validateDynamicExtensionCommandArgs(dynamicDescriptor, positionalArgs);
}

function syncCommanderActionArgs(actionCommand: Command, actionArgs: unknown[], commandArgs: string[]): void {
  actionCommand.args = [...commandArgs];
  /* c8 ignore next */
  if ("_processArguments" in actionCommand && typeof actionCommand._processArguments === "function") {
    actionCommand._processArguments();
  }
  /* c8 ignore next */
  if (actionArgs.length > 0 && Array.isArray(actionArgs[0])) {
    actionArgs[0] = [...actionCommand.processedArgs];
  }
}

/** Wrap each action once so validated parser overrides and extension handlers precede the original core action. */
function wrapProgramActionsForExtensionHandlers(rootProgram: Command): void {
  /** Traverse nested command registrations and wrap each action at most once. */
  const visit = (entry: Command): void => {
    const actionEntry = entry as ActionMutableCommand;
    if (typeof actionEntry._actionHandler === "function" && actionEntry[WRAPPED_ACTION_HANDLER] !== true) {
      const originalAction = actionEntry._actionHandler;
      /** Apply extension parsing and dispatch while preserving core action receipts. */
      actionEntry._actionHandler = async function wrappedActionHandler(this: unknown, ...actionArgs: unknown[]): Promise<unknown> {
        const actionCommand = resolveActionCommand(actionArgs, entry);
        const startedAt = Date.now();
        clearResolvedGlobalOptions(actionCommand);
        let globalOptions = getGlobalOptions(actionCommand);
        const commandPath = resolvePmCommandOperation(getCommandPath(actionCommand));
        const pmRoot = resolvePmRoot(process.cwd(), globalOptions.path);
        let commandArgs = actionCommand.args.map(String);
        const activeRegistrations = getActiveExtensionRegistrations();
        const extensionFlagDefinitions = activeRegistrations ? collectExtensionFlagDefinitionsForInvocation(activeRegistrations, commandPath, commandArgs) : [];
        const runtimeFieldFlagDefinitions = await collectRuntimeFieldLooseFlagDefinitionsForCommand(commandPath, pmRoot);
        let commandOptions = extractCommandScopedOptions(actionCommand, commandArgs, [...extensionFlagDefinitions, ...runtimeFieldFlagDefinitions]);
        const parserOverride = await runActiveParserOverride({
          command: commandPath,
          args: commandArgs,
          options: commandOptions,
          global: globalOptions,
          pm_root: pmRoot,
        });
        maybePrintExtensionProfileWarnings(globalOptions.profile, "parser_warnings", parserOverride.warnings);
        commandArgs = parserOverride.context.args;
        commandOptions = parserOverride.context.options;
        globalOptions = parserOverride.context.global;
        // Validate importer/exporter positionals on the real dispatch path:
        // these short-circuit before the dynamic action that previously held the
        // only arity validation, so excess positionals could reach handlers.
        // Free-form `registerCommand` commands intentionally accept positionals
        // via context.args, and core commands have no descriptor.
        validateDynamicInvocationArgs({
          activeRegistrations,
          commandPath,
          commandArgs,
          extensionFlagDefinitions,
        });
        globalOptions = await applyDefaultOutputFormat(globalOptions);
        setResolvedGlobalOptions(actionCommand, globalOptions);
        syncCommanderActionArgs(actionCommand, actionArgs, commandArgs);
        syncCommanderActionOptions(actionCommand, commandOptions);
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
          sdk: buildExtensionCommandSdk(pmRoot, globalOptions),
        });
        maybePrintExtensionProfileWarnings(globalOptions.profile, "command_handler_warnings", extensionCommandResult.warnings);
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

/* c8 ignore stop */

async function clearDynamicExtensionCommandState(params?: { rootProgram: Command; pmRoot: string; invocationArgv: string[]; settings?: PmSettings }): Promise<void> {
  activeRuntimeExtensionCommandDescriptors = new Map<string, ExtensionCommandHelpDescriptor>();
  setActiveExtensionServices({ overrides: [] });
  if (params) {
    await maybeAttachCreateUpdatePolicyHelpText(params.rootProgram, params.pmRoot, params.invocationArgv, createEmptyExtensionRegistrationRegistry(), params.settings);
  }
}

/* v8 ignore start -- dynamic help fallback variants are exercised through registration integration tests; residual legacy branches are defensive */
function attachDynamicExtensionHelp(command: Command, descriptor: ExtensionCommandHelpDescriptor | undefined, flagHelp: string | undefined, metadataHelp: string | null): void {
  if (descriptor?.flags && descriptor.flags.length > 0) {
    applyDynamicExtensionFlagOptions(command, descriptor.flags);
    const residualFlagHelp = buildResidualDynamicExtensionFlagHelp(command, descriptor.flags);
    if (residualFlagHelp) {
      command.addHelpText("after", residualFlagHelp);
    }
  } else if (flagHelp) {
    command.addHelpText("after", flagHelp);
  }
  if (metadataHelp) {
    command.addHelpText("after", metadataHelp);
  }
}

/* c8 ignore start */

/* v8 ignore stop */


/** Apply descendant-derived visibility to every generated extension namespace. */
function applyDynamicExtensionRootHelpVisibility(
  rootProgram: Command,
  preexistingTopLevelCommands: ReadonlySet<string>,
  descriptors: ReadonlyMap<string, ExtensionCommandHelpDescriptor>,
): void {
  const tierRank = { core: 0, standard: 1, full: 2, internal: 3 } as const;
  const applyVisibility = (command: Command, pathParts: string[]): void => {
    const commandPath = pathParts.join(" ");
    const matchingDescriptors = [...descriptors.entries()].filter(([path]) => path === commandPath || path.startsWith(`${commandPath} `)).map(([, descriptor]) => descriptor);
    const tier =
      matchingDescriptors.length === 0
        ? "standard"
        : matchingDescriptors.reduce<"core" | "standard" | "full" | "internal">(
            (selected, descriptor) => (tierRank[descriptor.tier] < tierRank[selected] ? descriptor.tier : selected),
            "internal",
          );
    setPmCommandHelpVisibilityTier(command, tier);
    for (const child of command.commands) {
      applyVisibility(child, [...pathParts, child.name()]);
    }
  };
  for (const command of rootProgram.commands) {
    if (!preexistingTopLevelCommands.has(command.name())) {
      applyVisibility(command, [command.name()]);
    }
  }
}

async function registerDynamicExtensionCommandPaths(rootProgram: Command, invocationArgv: string[]): Promise<void> {
  const bootstrapGlobalOptions = parseBootstrapGlobalOptions(invocationArgv);
  const pmRoot = resolvePmRoot(process.cwd(), bootstrapGlobalOptions.path);
  if (bootstrapGlobalOptions.noExtensions) {
    await clearDynamicExtensionCommandState({
      rootProgram,
      pmRoot,
      invocationArgv,
    });
    return;
  }

  const discoverySnapshot = await loadRuntimeExtensionDiscoverySnapshot(pmRoot);
  const probe = buildBootstrapActivationProbe(invocationArgv);
  if (!discoverySnapshot) {
    await clearDynamicExtensionCommandState();
    return;
  }
  if (!discoveryNeedsActivationForProbe(discoverySnapshot.discovery, probe)) {
    await clearDynamicExtensionCommandState({
      rootProgram,
      pmRoot,
      invocationArgv,
      settings: discoverySnapshot.settings,
    });
    emitExtensionSkippedProfile(bootstrapProfileEnabled(invocationArgv), discoverySnapshot, probe);
    return;
  }

  const snapshot = await loadRuntimeExtensionSnapshot(pmRoot, probe);
  /* c8 ignore next */
  if (!snapshot) {
    await clearDynamicExtensionCommandState({
      rootProgram,
      pmRoot,
      invocationArgv,
      settings: discoverySnapshot.settings,
    });
    return;
  }
  // Ensure usage/help/error formatting overrides are available even when parse
  // errors occur before preAction hooks initialize full runtime extension state.
  setActiveExtensionServices(snapshot.services);
  activeRuntimeExtensionCommandDescriptors = new Map(snapshot.commandDescriptors);
  await maybeAttachCreateUpdatePolicyHelpText(rootProgram, pmRoot, invocationArgv, snapshot.registrations, snapshot.settings);

  const commandPaths = collectSafeExtensionCommandPaths(rootProgram, snapshot.commandHandlers, snapshot.commandDescriptors, snapshot.commandAliases, (warning) =>
    reportExtensionCommandCollision(snapshot.activationWarnings, printError, warning),
  );
  const preexistingTopLevelCommands = new Set(rootProgram.commands.map((command) => command.name()));
  const registerCommandPath = (commandPath: string): void => {
    const pathParts = commandPath.split(" ").filter((part) => part.length > 0);
    const descriptor = snapshot.commandDescriptors.get(commandPath);
    const existingCommand = findCommandByPath(rootProgram, pathParts);
    const flagHelp = snapshot.commandFlagHelp.get(commandPath);
    const metadataHelp = descriptor ? buildDynamicExtensionCommandMetadataHelp(descriptor) : null;
    if (existingCommand) {
      attachDynamicExtensionHelp(existingCommand, descriptor, flagHelp, metadataHelp);
      return;
    }

    // Empty command paths were removed above, so ensureCommandPath cannot return null.
    const dynamicCommand = ensureCommandPath(rootProgram, pathParts) as Command;
    if (descriptor?.description) {
      dynamicCommand.description(descriptor.description);
    }
    let residualDynamicFlagHelp = flagHelp;
    if (descriptor) {
      applyDynamicExtensionArguments(dynamicCommand, descriptor);
      if (descriptor.flags.length > 0) {
        applyDynamicExtensionFlagOptions(dynamicCommand, descriptor.flags);
        residualDynamicFlagHelp = buildResidualDynamicExtensionFlagHelp(dynamicCommand, descriptor.flags) ?? undefined;
      }
    }
    if (residualDynamicFlagHelp) {
      dynamicCommand.addHelpText("after", residualDynamicFlagHelp);
    }
    if (metadataHelp) {
      dynamicCommand.addHelpText("after", metadataHelp);
    }

    dynamicCommand
      .allowUnknownOption(true)
      .allowExcessArguments(true)
      .action(async (...actionArgs: unknown[]) => {
        const maybeCommand = actionArgs[actionArgs.length - 1];
        /* c8 ignore next */
        const command = maybeCommand instanceof Command ? maybeCommand : dynamicCommand;
        const globalOptions = getGlobalOptions(command);
        const startedAt = Date.now();
        const extensionFlagDefinitions = collectExtensionFlagDefinitionsForInvocation(snapshot.registrations, commandPath, command.args.map(String));
        const scopedOptions = extractCommandScopedOptions(command, command.args.map(String), extensionFlagDefinitions);
        const result = await runRequiredExtensionCommand(command, scopedOptions, globalOptions, extensionFlagDefinitions);
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
  };
  for (const commandPath of commandPaths) {
    registerCommandPath(commandPath);
  }
  applyDynamicExtensionRootHelpVisibility(rootProgram, preexistingTopLevelCommands, snapshot.commandDescriptors);
}

const CLI_VERSION = resolvePmCliVersion(import.meta.url, ["../.."]) ?? "0.0.0";

/* c8 ignore stop */

let program = createPmCliProgram(CLI_VERSION);

/* c8 ignore start */

/** Bind output validation, extension policy, mutation guards, and observability to the selected semantic command. */
function attachProgramLifecycleHooks(rootProgram: Command): void {
  rootProgram.hook("preAction", async (_thisCommand, actionCommand) => {
    activeExtensionHookContext = null;
    activeTelemetryCommandContext = null;
    clearActiveExtensionHooks();
    clearResolvedGlobalOptions(actionCommand);
    const rawGlobalOptions = actionCommand.optsWithGlobals() as Record<string, unknown>;
    const bootstrapGlobalOptions = getGlobalOptions(actionCommand);
    const commandPath = resolvePmCommandOperation(getCommandPath(actionCommand));
    let commandArgs = actionCommand.args.map(String);
    let commandOptions = extractCommandScopedOptions(actionCommand, commandArgs);
    let globalOptions = { ...bootstrapGlobalOptions };
    validateReadOutputOptions(commandPath, {
      ...commandOptions,
      outputInclude: rawGlobalOptions.outputInclude,
      outputLimit: rawGlobalOptions.outputLimit,
      outputBudget: rawGlobalOptions.outputBudget,
      outputFormat: rawGlobalOptions.outputFormat,
      outputSession: rawGlobalOptions.outputSession,
      outputCursor: rawGlobalOptions.outputCursor,
    });
    forwardReadOutputIncludeModes(actionCommand, commandPath, globalOptions, commandOptions);
    await maybeRunFirstUseTelemetryPrompt(commandPath, globalOptions);
    const fallbackPmRoot = resolvePmRoot(process.cwd(), bootstrapGlobalOptions.path);
    const runtimeExtensions = await maybeLoadRuntimeExtensions(actionCommand);
    if (!runtimeExtensions) {
      activeExtensionHookContext = createCoreCommandHookContext({
        commandName: commandPath,
        commandArgs,
        commandOptions,
        globalOptions,
        pmRoot: fallbackPmRoot,
      });
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
      await enforceItemFormatWriteGateAndPreflightMigration(commandPath, commandOptions, fallbackPmRoot, defaultPreflightDecision());
      await enforceMutationGuardPreflight(commandPath, commandArgs, commandOptions, globalOptions, fallbackPmRoot);
      return;
    }

    setActiveExtensionHooks(runtimeExtensions.hooks);
    setActiveExtensionCommands(runtimeExtensions.commands);
    setActiveExtensionParsers(runtimeExtensions.parsers);
    setActiveExtensionPreflight(runtimeExtensions.preflight);
    setActiveExtensionServices(runtimeExtensions.services);
    setActiveExtensionRenderers(runtimeExtensions.renderers);
    setActiveExtensionRegistrations(runtimeExtensions.registrations);

    const extensionFlagDefinitions = collectExtensionFlagDefinitionsForInvocation(runtimeExtensions.registrations, commandPath, commandArgs);
    commandOptions = extractCommandScopedOptions(actionCommand, commandArgs, extensionFlagDefinitions);
    forwardReadOutputIncludeModes(actionCommand, commandPath, globalOptions, commandOptions);
    const parserOverride = await runActiveParserOverride({
      command: commandPath,
      args: commandArgs,
      options: commandOptions,
      global: globalOptions,
      pm_root: runtimeExtensions.pmRoot,
    });
    /* c8 ignore next */
    if (globalOptions.profile && parserOverride.warnings.length > 0) {
      printError(`profile:extensions parser_warnings=${formatHookWarnings(parserOverride.warnings)}`);
    }
    commandArgs = parserOverride.context.args;
    commandOptions = parserOverride.context.options;
    globalOptions = parserOverride.context.global;
    syncCommanderActionOptions(actionCommand, commandOptions);

    const preflightOverride = await runActivePreflightOverride({
      command: commandPath,
      args: commandArgs,
      options: commandOptions,
      global: globalOptions,
      pm_root: runtimeExtensions.pmRoot,
      decision: defaultPreflightDecision(),
    });
    /* c8 ignore next */
    if (globalOptions.profile && preflightOverride.warnings.length > 0) {
      printError(`profile:extensions preflight_warnings=${formatHookWarnings(preflightOverride.warnings)}`);
    }
    commandArgs = preflightOverride.context.args;
    commandOptions = preflightOverride.context.options;
    globalOptions = preflightOverride.context.global;
    syncCommanderActionOptions(actionCommand, commandOptions);
    const preflightDecision = preflightOverride.decision;

    await enforceItemFormatWriteGateAndPreflightMigration(commandPath, commandOptions, runtimeExtensions.pmRoot, preflightDecision);
    await enforceMutationGuardPreflight(commandPath, commandArgs, commandOptions, globalOptions, runtimeExtensions.pmRoot);

    /* c8 ignore next */
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
    /* c8 ignore next */
    if (globalOptions.profile && hookWarnings.length > 0) {
      printError(`profile:extensions hook_warnings=${formatHookWarnings(hookWarnings)}`);
    }
    /* c8 ignore next */
    if (preflightDecision.enforce_mandatory_migration_gate) {
      enforceMandatoryMigrationWriteGate(commandPath, commandOptions, migrationBlockers);
    }
  });
  /* c8 ignore stop */

  rootProgram.hook("postAction", async () => {
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
}

attachProgramLifecycleHooks(program);

const IDEMPOTENT_TOP_LEVEL_REGISTRATION = Symbol("pmCliIdempotentTopLevelRegistration");

/**
 * The root `program` is a module-level singleton. Any path that enters
 * `runPmCli` a second time in the same process (an embedding host, a long-lived
 * plugin runtime, or a retry) re-runs core command registration against it, and
 * Commander throws `cannot add command 'X' as already have command 'X'` on the
 * second pass. That is a raw `Error` (not a `CommandError`), so it escapes the
 * Sentry release-gate CLI-error allowlist and can silently block the daily
 * auto-release (Sentry PM-CLI-1R / pm-zyez — the fragility class pm-nb08 warns
 * about).
 *
 * Make top-level registration idempotent: a duplicate `program.command(name)`
 * returns a throwaway `Command`, so its chained `.argument()/.option()/.action()`
 * builders apply harmlessly while the already-wired original command is
 * preserved. The guard is installed once per program (Symbol flag) and only
 * short-circuits exact duplicates — every first-time registration still flows
 * through Commander untouched.
 */
function ensureIdempotentTopLevelCommandRegistration(rootProgram: Command): void {
  const guarded = rootProgram as Command & {
    [IDEMPOTENT_TOP_LEVEL_REGISTRATION]?: true;
  };
  if (guarded[IDEMPOTENT_TOP_LEVEL_REGISTRATION]) {
    return;
  }
  guarded[IDEMPOTENT_TOP_LEVEL_REGISTRATION] = true;
  const registerOriginalCommand = rootProgram.command.bind(rootProgram) as (nameAndArgs: string, ...rest: unknown[]) => Command;
  rootProgram.command = ((nameAndArgs: string, ...rest: unknown[]): Command => {
    const commandName = nameAndArgs.split(/\s+/u)[0];
    // Match Commander's own dedup, which collides on an existing command's name
    // OR any of its aliases, so a re-entrant registration can never reach the
    // raw "cannot add command" throw.
    if (rootProgram.commands.some((existing) => existing.name() === commandName || existing.aliases().includes(commandName))) {
      return new Command(commandName);
    }
    return registerOriginalCommand(nameAndArgs, ...rest);
  }) as typeof rootProgram.command;
}

async function registerCoreCommandFamilies(rootProgram: Command, selection: CoreCommandRegistrationSelection): Promise<void> {
  ensureIdempotentTopLevelCommandRegistration(rootProgram);
  if (selection.setup) {
    const { registerSetupCommands } = await loadSetupRegistrationModule();
    registerSetupCommands(rootProgram);
  }
  if (selection.listQuery) {
    const { registerListQueryCommands } = await loadListQueryRegistrationModule();
    const commandFilter =
      typeof selection.targetCommandName === "string" && LIST_QUERY_COMMAND_NAMES.has(selection.targetCommandName) ? new Set([selection.targetCommandName]) : undefined;
    registerListQueryCommands(rootProgram, commandFilter ? { commandFilter } : undefined);
  }
  if (selection.mutation) {
    const { registerMutationCommands } = await loadMutationRegistrationModule();
    registerMutationCommands(rootProgram, {
      targetCommandName: selection.targetCommandName,
    });
  }
  if (selection.operation) {
    const { registerOperationCommands } = await loadOperationRegistrationModule();
    registerOperationCommands(rootProgram);
  }
}

type TelemetryCommandErrorEmitter = (params: {
  command: string;
  errorCode: string;
  errorMessage: string;
  exitCode: number;
  options: Record<string, unknown>;
  resolutionStage: TelemetryResolutionStage;
}) => Promise<{
  errorCategory: TelemetryErrorCategory;
  commandResolution: TelemetryCommandResolution;
}>;

interface RunPmCliErrorContext {
  error: unknown;
  invocationArgv: string[];
  bootstrapGlobal: GlobalOptions;
  jsonErrors: boolean;
  bootstrapPmRoot: string;
  attemptedCommand: string;
  emitTelemetryCommandError: TelemetryCommandErrorEmitter;
}

function createTelemetryCommandErrorEmitter(params: { invocationArgv: string[]; bootstrapGlobal: GlobalOptions; bootstrapPmRoot: string }): TelemetryCommandErrorEmitter {
  return async (event) => {
    const errorCategory = resolveTelemetryErrorCategory(event.errorCode);
    const commandResolution = deriveTelemetryCommandResolution({
      ok: false,
      errorCode: event.errorCode,
      errorCategory,
    });
    await emitTelemetryErrorEvent({
      command: event.command,
      args: params.invocationArgv,
      options: event.options,
      global: params.bootstrapGlobal,
      pm_version: CLI_VERSION,
      pm_root: params.bootstrapPmRoot,
      error_code: event.errorCode,
      error_message: event.errorMessage,
      exit_code: event.exitCode,
      error_category: errorCategory,
      command_resolution: commandResolution,
      resolution_stage: event.resolutionStage,
    });
    return {
      errorCategory,
      commandResolution,
    };
  };
}

async function prepareExtensionServicesForRunPmCliError(params: { invocationArgv: string[]; bootstrapGlobal: GlobalOptions; bootstrapPmRoot: string }): Promise<void> {
  if (params.bootstrapGlobal.noExtensions) {
    return;
  }
  const bootstrapProbe = buildBootstrapActivationProbe(params.invocationArgv);
  const discoverySnapshot = await loadRuntimeExtensionDiscoverySnapshot(params.bootstrapPmRoot);
  if (discoverySnapshot && discoveryNeedsActivationForProbe(discoverySnapshot.discovery, bootstrapProbe)) {
    const bootstrapSnapshot = await loadRuntimeExtensionSnapshot(params.bootstrapPmRoot, bootstrapProbe);
    setRecoveredExtensionServices(bootstrapSnapshot);
    return;
  }
  if (discoverySnapshot) {
    emitExtensionSkippedProfile(bootstrapProfileEnabled(params.invocationArgv), discoverySnapshot, bootstrapProbe);
  }
  setActiveExtensionServices({ overrides: [] });
}

function setRecoveredExtensionServices(bootstrapSnapshot: Pick<RuntimeExtensionSnapshot, "services"> | null): void {
  if (!bootstrapSnapshot) {
    setActiveExtensionServices({ overrides: [] });
    return;
  }
  setActiveExtensionServices(bootstrapSnapshot.services);
}

async function finishRunPmCliFailure(params: {
  errorMessage: string;
  exitCode: number;
  classificationCode: string;
  errorCategory: TelemetryErrorCategory;
  commandResolution: TelemetryCommandResolution;
  resolutionStage: TelemetryResolutionStage;
}): Promise<void> {
  sentryFinishCommandSpan(false, params.errorMessage, {
    error_code: params.classificationCode,
    error_category: params.errorCategory,
    exit_code: params.exitCode,
    command_resolution: params.commandResolution,
    resolution_stage: params.resolutionStage,
  });
  await runAndClearAfterCommandHooks({
    ok: false,
    error: params.errorMessage,
    exit_code: params.exitCode,
    error_code: params.classificationCode,
    error_category: params.errorCategory,
    command_resolution: params.commandResolution,
    resolution_stage: params.resolutionStage,
  });
}

async function finishRunPmCliSuccessParse(): Promise<void> {
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
}

async function handleRunPmCliKnownError(context: RunPmCliErrorContext, numericExitCode: number | undefined): Promise<boolean> {
  const hasExplicitExitCode = typeof numericExitCode === "number" && Number.isFinite(numericExitCode);
  if (!(context.error instanceof PmCliError) && (isCommanderError(context.error) || !hasExplicitExitCode)) {
    return false;
  }
  const errorMessage = describeUnknownError(context.error);
  const exitCode = context.error instanceof PmCliError ? context.error.exitCode : normalizeThrownExitCode(numericExitCode as number);
  const rawContext = context.error instanceof PmCliError ? context.error.context : undefined;
  const enrichedContext = buildPmCliRecoveryContext(rawContext, context.invocationArgv, errorMessage);
  const classification = classifyPmCliError(errorMessage, enrichedContext);
  const jsonErrorPayload = context.bootstrapGlobal.lean
    ? projectLeanErrorEnvelope(formatPmCliErrorForJson(errorMessage, exitCode, enrichedContext))
    : formatPmCliErrorForJson(errorMessage, exitCode, enrichedContext);
  const renderedError = context.jsonErrors
    ? JSON.stringify(
        context.bootstrapGlobal.tokenAccounting ? attachOutputTokenAccounting(jsonErrorPayload, (value) => `${JSON.stringify(value, null, 2)}\n`) : jsonErrorPayload,
        null,
        2,
      )
    : formatPmCliErrorForDisplay(errorMessage, enrichedContext);
  if (context.jsonErrors) writeStderr(`${renderedError}\n`);
  else printError(renderedError);
  const { errorCategory, commandResolution } = await context.emitTelemetryCommandError({
    command: context.attemptedCommand,
    errorCode: classification.code,
    errorMessage: classification.detail,
    exitCode,
    options: {
      bootstrap_global_options: context.bootstrapGlobal,
    },
    resolutionStage: "execute",
  });
  const loggedHandledErrorToSentry = await maybeLogHandledCliErrorToSentry({
    command: context.attemptedCommand,
    error_code: classification.code,
    error_category: errorCategory,
    exit_code: exitCode,
    error_message: classification.detail,
    command_resolution: commandResolution,
    resolution_stage: "execute",
    source_context: activeTelemetryCommandContext?.source_context,
  });
  await finishRunPmCliFailure({
    errorMessage,
    exitCode,
    classificationCode: classification.code,
    errorCategory,
    commandResolution,
    resolutionStage: "execute",
  });
  if (loggedHandledErrorToSentry) {
    sentryCaptureCliError(wrapThrownErrorForSentry(context.error, errorMessage));
    await sentryFlush(HANDLED_ERROR_SENTRY_FLUSH_TIMEOUT_MS);
  }
  process.exitCode = exitCode;
  return true;
}

/** Classify failed help requests by semantic operation so optional package recovery and error telemetry retain the attempted command. */
async function handleUnknownHelpCommandError(context: RunPmCliErrorContext, code: string | undefined): Promise<void> {
  const unknownToken = resolvePmCommandOperation(parseBootstrapHelpRequest(context.invocationArgv).commandPathTokens.join(" ")) || resolveUnknownCommanderToken(context.invocationArgv);
  const unknownMessage = `unknown command '${unknownToken}'`;
  const pmRoot = resolvePmRoot(process.cwd(), context.bootstrapGlobal.path);
  const recoveryCommandDescriptors = await loadRuntimeExtensionCommandDescriptorsForRecovery(pmRoot);
  const recoveryProbe = buildBootstrapActivationProbe(context.invocationArgv);
  const failedExtensions = await loadExtensionRecoveryFailures(pmRoot, {}, collectActivationCommandCandidates(recoveryProbe));
  const usageContext = await resolveCommanderUsageContext({ message: unknownMessage }, program, recoveryCommandDescriptors, { failedExtensions });
  const classification = classifyCommanderError(usageContext.message, usageContext.commandName, usageContext.allowedTypes, {
    unknownCommandExamples: usageContext.unknownCommandExamples,
    unknownCommandNextSteps: usageContext.unknownCommandNextSteps,
    attemptedCommand: usageContext.attemptedCommand,
    normalizedInvocationArgs: usageContext.normalizedInvocationArgs,
    providedOptionFlags: usageContext.providedOptionFlags,
    unknownOptionSuggestions: usageContext.unknownOptionSuggestions,
    suggestedRetryCommand: usageContext.suggestedRetryCommand,
    failedExtensions,
  });
  const { errorCategory, commandResolution } = await context.emitTelemetryCommandError({
    command: unknownToken,
    errorCode: classification.code,
    errorMessage: classification.detail,
    exitCode: EXIT_CODE.USAGE,
    options: {
      bootstrap_global_options: context.bootstrapGlobal,
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
  });
  const baseRenderedUsage = context.jsonErrors
    ? await formatCommanderUsageJson({ message: unknownMessage }, program, recoveryCommandDescriptors, context.bootstrapGlobal.lean === true, { failedExtensions })
    : await formatCommanderUsageMessage({ message: unknownMessage }, program, recoveryCommandDescriptors, { failedExtensions });
  const renderedUsage = appendCommanderExtensionFailures(baseRenderedUsage, context.jsonErrors, failedExtensions);
  await finishRunPmCliFailure({
    errorMessage: unknownMessage,
    exitCode: EXIT_CODE.USAGE,
    classificationCode: classification.code,
    errorCategory,
    commandResolution,
    resolutionStage: "parse",
  });
  if (context.jsonErrors) writeStderr(`${renderedUsage}\n`);
  else printError(renderedUsage);
  if (loggedHandledErrorToSentry) {
    await sentryFlush(HANDLED_ERROR_SENTRY_FLUSH_TIMEOUT_MS);
  }
  process.exitCode = EXIT_CODE.USAGE;
}

async function handleRunPmCliHelpDisplayError(context: RunPmCliErrorContext, code: string | undefined, rawMessage: string): Promise<boolean> {
  const isHelpDisplayCode = code === "commander.helpDisplayed" || code === "commander.help" || code === "commander.helpCommand";
  if (!isHelpDisplayCode && !rawMessage.includes("(outputHelp)")) {
    return false;
  }
  const helpRequest = parseBootstrapHelpRequest(context.invocationArgv);
  if (helpRequest.requested && !isKnownHelpCommandPath(program, helpRequest.commandPathTokens)) {
    await handleUnknownHelpCommandError(context, code);
    return true;
  }
  await finishRunPmCliSuccessParse();
  return true;
}

async function handleRunPmCliCommanderUsageError(context: RunPmCliErrorContext, code: string): Promise<void> {
  const usageContext = await resolveCommanderUsageContext(context.error, program, activeRuntimeExtensionCommandDescriptors);
  const classification = classifyCommanderError(usageContext.message, usageContext.commandName, usageContext.allowedTypes, {
    unknownCommandExamples: usageContext.unknownCommandExamples,
    unknownCommandNextSteps: usageContext.unknownCommandNextSteps,
    attemptedCommand: usageContext.attemptedCommand,
    normalizedInvocationArgs: usageContext.normalizedInvocationArgs,
    providedOptionFlags: usageContext.providedOptionFlags,
    unknownOptionSuggestions: usageContext.unknownOptionSuggestions,
    suggestedRetryCommand: usageContext.suggestedRetryCommand,
  });
  const { errorCategory, commandResolution } = await context.emitTelemetryCommandError({
    command: context.attemptedCommand,
    errorCode: classification.code,
    errorMessage: classification.detail,
    exitCode: EXIT_CODE.USAGE,
    options: {
      bootstrap_global_options: context.bootstrapGlobal,
      commander_code: code,
    },
    resolutionStage: "parse",
  });
  const loggedHandledErrorToSentry = await maybeLogHandledCliErrorToSentry({
    command: context.attemptedCommand,
    error_code: classification.code,
    error_category: errorCategory,
    exit_code: EXIT_CODE.USAGE,
    error_message: classification.detail,
    command_resolution: commandResolution,
    resolution_stage: "parse",
    source_context: activeTelemetryCommandContext?.source_context,
  });
  const baseRenderedUsage = context.jsonErrors
    ? await formatCommanderUsageJson(context.error, program, activeRuntimeExtensionCommandDescriptors, context.bootstrapGlobal.lean === true)
    : await formatCommanderUsageMessage(context.error, program, activeRuntimeExtensionCommandDescriptors);
  const recoveryFailures = await loadUnknownCommandRecoveryFailures(
    classification.code,
    context.bootstrapPmRoot,
    {},
    collectActivationCommandCandidates(buildBootstrapActivationProbe(context.invocationArgv)),
  );
  const renderedUsage = appendCommanderExtensionFailures(baseRenderedUsage, context.jsonErrors, recoveryFailures);
  await finishRunPmCliFailure({
    errorMessage: usageContext.message,
    exitCode: EXIT_CODE.USAGE,
    classificationCode: classification.code,
    errorCategory,
    commandResolution,
    resolutionStage: "parse",
  });
  if (context.jsonErrors) writeStderr(`${renderedUsage}\n`);
  else printError(renderedUsage);
  if (loggedHandledErrorToSentry) {
    await sentryFlush(HANDLED_ERROR_SENTRY_FLUSH_TIMEOUT_MS);
  }
  process.exitCode = EXIT_CODE.USAGE;
}

function shouldHandleRunPmCliCommanderError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && (code === "commander.version" || code.startsWith("commander."))) {
    return true;
  }
  const rawMessage = String((error as { message?: unknown }).message ?? "");
  return rawMessage.includes("(outputHelp)");
}

async function handleRunPmCliCommanderError(context: RunPmCliErrorContext): Promise<void> {
  const code = (context.error as { code?: string }).code;
  const rawMessage = String((context.error as { message?: unknown }).message ?? "");
  if (await handleRunPmCliHelpDisplayError(context, code, rawMessage)) {
    return;
  }
  if (code === "commander.version") {
    await finishRunPmCliSuccessParse();
    return;
  }
  await handleRunPmCliCommanderUsageError(context, code as string);
}

async function handleRunPmCliError(params: { error: unknown; invocationArgv: string[] }): Promise<void> {
  const bootstrapGlobal = parseBootstrapGlobalOptions(params.invocationArgv);
  const bootstrapPmRoot = resolvePmRoot(process.cwd(), bootstrapGlobal.path);
  const context: RunPmCliErrorContext = {
    error: params.error,
    invocationArgv: params.invocationArgv,
    bootstrapGlobal,
    jsonErrors: bootstrapGlobal.json,
    bootstrapPmRoot,
    attemptedCommand: parseBootstrapCommandName(params.invocationArgv) ?? "<unknown>",
    emitTelemetryCommandError: createTelemetryCommandErrorEmitter({
      invocationArgv: params.invocationArgv,
      bootstrapGlobal,
      bootstrapPmRoot,
    }),
  };
  await prepareExtensionServicesForRunPmCliError({
    invocationArgv: params.invocationArgv,
    bootstrapGlobal,
    bootstrapPmRoot,
  });
  if (await handleRunPmCliKnownError(context, readThrownExitCode(params.error))) {
    return;
  }
  if (shouldHandleRunPmCliCommanderError(params.error)) {
    await handleRunPmCliCommanderError(context);
    return;
  }
  await handleGenericRunPmCliError({
    error: params.error,
    attemptedCommand: context.attemptedCommand,
    bootstrapGlobal,
    emitTelemetryCommandError: context.emitTelemetryCommandError,
  });
}

/** Reject unavailable package namespaces before variadic parents consume their names as operands. */
function assertRequestedNamespaceAvailable(program: Command, invocationArgv: string[], helpRequest: ReturnType<typeof parseBootstrapHelpRequest>): void {
  const tokens = helpRequest.requested ? helpRequest.commandPathTokens : stripGlobalBootstrapTokens(invocationArgv);
  const requestedNamespace = findPmNamespacedCommand(tokens);
  if (requestedNamespace && !findCommandByPath(program, [...requestedNamespace.canonical_argv])) {
    throw new CommanderError(EXIT_CODE.USAGE, "commander.unknownCommand", `unknown command '${requestedNamespace.alias}'`);
  }
}

/** Dispatch one fresh CLI invocation with deterministic process state and tracker-scoped attribution. */
async function runPmCliInReproducibleContext(rawArgv: string[]): Promise<void> {
  program = createPmCliProgram(CLI_VERSION);
  attachProgramLifecycleHooks(program);
  // The runtime-extension snapshot caches dedupe discovery work within a
  // single invocation only. Reset them on entry so long-lived embeddings
  // (in-process test runners, future SDK hosts) observe the same fresh
  // extension state a one-shot `pm` process would — e.g. an extension
  // installed by the previous invocation must be visible to this one.
  runtimeExtensionSnapshotCache = null;
  runtimeExtensionDiscoverySnapshotCache = null;
  activeRuntimeExtensionCommandDescriptors = new Map<string, ExtensionCommandHelpDescriptor>();
  resetActiveExtensionRuntimeState();
  let invocationArgv = [...rawArgv];
  let restorePmAuthor: (() => void) | undefined;
  let restorePagerPolicy: (() => void) | undefined;
  try {
    const bootstrapInvocation = normalizeBootstrapInvocation(rawArgv);
    invocationArgv = bootstrapInvocation.argv;
    const invocationProcessArgv = [process.argv[0], process.argv[1], ...invocationArgv];
    const isBareInvocation = invocationArgv.length === 0;
    const bootstrapGlobal = parseBootstrapGlobalOptions(invocationArgv);
    if (bootstrapGlobal.authorMissingValue) {
      throw new PmCliError("--author requires a non-empty value.", EXIT_CODE.USAGE, {
        code: "missing_required_argument",
        nextSteps: ["Pass an explicit author identifier with --author <id>."],
      });
    }
    restorePmAuthor = applyInvocationAuthorOverride(bootstrapGlobal.author);
    enforceExplicitRetryForFlagTypos(bootstrapInvocation);
    restorePagerPolicy = applyBootstrapPagerPolicy(invocationArgv);
    const registrationSelection = resolveCoreCommandRegistrationSelection(invocationArgv);
    await registerCoreCommandFamilies(program, registrationSelection);
    installCommandNamespaces(program, true);
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
    installCommandNamespaces(program);
    const helpRequest = parseBootstrapHelpRequest(invocationArgv);
    assertRequestedNamespaceAvailable(program, invocationArgv, helpRequest);
    if (shouldAttachRichHelpTextForInvocation(invocationArgv)) {
      attachRichHelpText(program, invocationArgv);
    }
    wrapProgramActionsForExtensionHandlers(program);
    const renderedBootstrapJsonHelp = await maybeRenderBootstrapJsonHelp(program, invocationArgv, activeRuntimeExtensionCommandDescriptors, rawArgv);
    if (renderedBootstrapJsonHelp) {
      return;
    }
    if (helpRequest.requested && !isKnownHelpCommandPath(program, helpRequest.commandPathTokens)) {
      throw new CommanderError(EXIT_CODE.USAGE, "commander.helpDisplayed", "(outputHelp)");
    }
    if (
      isBareInvocation ||
      (isFullHelpDiscovery(invocationArgv) &&
        parseBootstrapCommandName(invocationArgv) === undefined)
    ) {
      program.outputHelp();
      return;
    }
    const invocationPmRoot = resolvePmRoot(process.cwd(), bootstrapGlobal.path);
    const invocationSettings = await readSettings(invocationPmRoot);
    const intentSnapshot = await loadContextIntentSnapshotForInvocation(
      invocationArgv,
      invocationPmRoot,
      bootstrapGlobal.noExtensions,
      loadRuntimeExtensionSnapshot,
    );
    await runWithDiscoveredContextIntentContracts(
      {
        pmRoot: invocationPmRoot,
        packages: intentSnapshot?.contextIntentPackages,
      },
      () =>
        runWithHarnessDetectionSignals(
          { env: { ...process.env, PM_PATH: invocationPmRoot }, argv: invocationProcessArgv, cwd: process.cwd() },
          () => runWithWorkspaceHarnessSignalDescriptors(invocationSettings.agent_identity!.harness_signals, () => program.parseAsync(invocationProcessArgv), {
            probesEnabled: invocationSettings.agent_identity?.probes_enabled,
          }),
        ),
    );
  } catch (error: unknown) {
    await handleRunPmCliError({ error, invocationArgv });
  } finally {
    restorePagerPolicy?.();
    restorePmAuthor?.();
  }
}

/** Implements run pm cli for the public runtime surface of this module. */
export async function runPmCli(rawArgv: string[] = process.argv.slice(2)): Promise<void> {
  try {
    await runWithReproducibleProcessEnvironment(process.env, () => runPmCliInReproducibleContext(rawArgv));
  } catch (error: unknown) {
    await handleRunPmCliError({ error, invocationArgv: [...rawArgv] });
  }
}

/** Public contract for test only, shared by SDK and presentation-layer consumers. */
export const _testOnly = {
  activationCommandMatchesProbe,
  applyDynamicExtensionRootHelpVisibility,
  bootstrapProfileEnabled,
  buildBootstrapActivationProbe,
  buildPostActionTelemetryOutcome,
  buildPmCliRecoveryContext,
  buildRuntimeExtensionDiscoverySnapshotCacheKey,
  buildRuntimeExtensionActivationScope,
  buildRuntimeExtensionSnapshotCacheKey,
  buildRuntimeExtensionFilterForProbe,
  addRuntimeFieldOption,
  collectActivationCommandCandidates,
  collectExtensionFlagDefinitionsForCommand,
  collectExtensionFlagDefinitionsForInvocation,
  collectLeadingCommandArgs,
  collectParsedActivationCommandArgs,
  collectRuntimeFieldLooseFlagDefinitionsForCommand,
  commandHasLongOption,
  commandHasShortOption,
  commandPathNeedsSearchExtensions,
  commandPathNeedsTemplateExtensions,
  describeUnknownError,
  defaultPreflightDecision,
  discoveryNeedsActivationForProbe,
  emitExtensionProfile,
  emitExtensionSkippedProfile,
  emitSettingsReadWarnings,
  ensureIdempotentTopLevelCommandRegistration,
  enforceExplicitRetryForFlagTypos,
  envFlagEnabled,
  executeRegisteredRuntimeMigrations,
  extractCommandScopedOptions,
  extensionActivationCommands,
  extensionCapabilities,
  extensionNeedsActivationForProbe,
  extensionProvidesTemplatesRuntime,
  hasAnyCapability,
  hasGlobalExtensionContributions,
  handleGenericRunPmCliError,
  handleRunPmCliCommanderError,
  handleRunPmCliError,
  handleRunPmCliHelpDisplayError,
  handleRunPmCliKnownError,
  handleRunPmCliCommanderUsageError,
  handleUnknownHelpCommandError,
  inferMissingFieldsFromErrorMessage,
  inferPostActionErrorCode,
  inferPostActionFailureMessage,
  invocationRequestsVersion,
  isCommanderError,
  loadRuntimeExtensionCommandDescriptorsForRecovery,
  loadRuntimeExtensionDiscoverySnapshot,
  loadRuntimeExtensionSnapshot,
  maybeLoadRuntimeExtensions,
  maybeAttachCreateUpdatePolicyHelpText,
  maybeLogHandledCliErrorToSentry,
  matchesStaticExtensionCommand,
  normalizeTelemetryCommandResolution,
  normalizeTelemetryErrorCategory,
  normalizeTelemetryResolutionStage,
  normalizeThrownExitCode,
  probeUsesAnyFlag,
  prepareExtensionServicesForRunPmCliError,
  readRecordBoolean,
  readRecordNumber,
  readRecordString,
  recordCliReadOutputInvocationProvenance,
  registerDynamicExtensionCommandPaths,
  registerRuntimeSchemaFieldFlags,
  resolveCoreCommandRegistrationSelection,
  resolveStaticExtensionActivationDecision,
  resolveUnknownHelpToken: resolveUnknownCommanderToken,
  readThrownExitCode,
  runAndClearAfterCommandHooks,
  runRequiredExtensionCommand,
  shouldAttachRichHelpTextForInvocation,
  shouldLogHandledErrorToSentry,
  shouldRegisterDynamicExtensionPaths,
  shouldRegisterRuntimeSchemaFlags,
  shouldHandleRunPmCliCommanderError,
  setActiveExtensionHookContextForTest,
  setActiveRuntimeExtensionCommandDescriptorsForTest,
  setRecoveredExtensionServices,
  toLooseFieldDefinitionType,
  isImporterOrExporterCommandPath,
  validateDynamicExtensionCommandInvocation,
  wrapProgramActionsForExtensionHandlers,
  wrapThrownErrorForSentry,
};
