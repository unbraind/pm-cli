/**
 * @module cli/help-json-payload
 *
 * Provides CLI runtime support for Help Json Payload.
 */
import { Command } from "commander";
import {
  hasSubcommandFlagContractsForCommand,
  PM_CORE_COMMAND_NAMES,
} from "../sdk/cli-contracts.js";
import {
  commandOptionFlagLabel,
  resolveCommandOptionPolicyState,
  resolveItemTypeRegistry,
  resolveTypeDefinition,
  EXIT_CODE,
  printError,
  writeStdout,
} from "../sdk/runtime-primitives.js";
import {
  type HelpOptionSummary,
  type ExtensionCommandHelpDescriptor,
  buildDynamicExtensionHelpOptionSummaries,
  mergeHelpOptionSummaries,
  findCommandByPath,
  findDirectChildCommand,
  commandAliases,
} from "./extension-command-help.js";
import {
  normalizeHelpCommandPath,
  resolveHelpDetailMode,
  resolveHelpNarrative,
} from "./help-content.js";
import { getCommandPath } from "./registration-helpers.js";
import {
  parseBootstrapGlobalOptions,
  parseBootstrapHelpRequest,
  parseBootstrapCommandName,
  parseBootstrapTypeValue,
} from "./bootstrap-args.js";
import { extractProvidedOptionFlags, renderPmCommand } from "./argv-utils.js";
import { formatCommanderErrorForJson } from "./error-guidance.js";
import {
  BUILTIN_TYPE_HELP_VALUES,
  buildUnknownCommandGuidanceFromRuntime,
} from "./commander-usage.js";
import { resolveCreateExplicitEmptyFlag } from "../sdk/agent/create-option-policy.js";
import {
  PM_POSITIONAL_ACTION_CONTRACTS,
  resolvePmCommandPositionalContract,
  resolvePmPositionalActionContract,
  type PmPositionalActionContract,
} from "../sdk/cli-contracts/grammar-contracts.js";

/** Documents the help argument summary payload exchanged by command, SDK, and package integrations. */
export interface HelpArgumentSummary {
  /** Value that configures or reports name for this contract. */
  name: string;
  /** Value that configures or reports required for this contract. */
  required: boolean;
  /** Value that configures or reports variadic for this contract. */
  variadic: boolean;
  /** Value that configures or reports description for this contract. */
  description: string | null;
}

/** Documents the help subcommand summary payload exchanged by command, SDK, and package integrations. */
export interface HelpSubcommandSummary {
  /** Value that configures or reports name for this contract. */
  name: string;
  /** Value that configures or reports aliases for this contract. */
  aliases: string[];
  /** Value that configures or reports description for this contract. */
  description: string;
}

function resolveCommandFromPathTokens(
  root: Command,
  pathTokens: string[],
): Command | null {
  if (pathTokens.length === 0) {
    return root;
  }
  const exactCommand = findCommandByPath(root, pathTokens);
  if (exactCommand) {
    return exactCommand;
  }
  const requestedPath = pathTokens.join(" ");
  if (
    !PM_CORE_COMMAND_NAMES.some(
      (commandName) => commandName === requestedPath,
    ) &&
    !hasSubcommandFlagContractsForCommand(requestedPath)
  ) {
    return null;
  }
  for (let length = pathTokens.length - 1; length > 0; length -= 1) {
    const positionalParent = findCommandByPath(
      root,
      pathTokens.slice(0, length),
    );
    if (positionalParent) {
      return positionalParent;
    }
  }
  return pathTokens.length === 1 ? root : null;
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
    return typeof value === "string" && value.trim().length > 0
      ? value.trim()
      : null;
  }
  if (
    typeof optionRecord.attributeName === "string" &&
    optionRecord.attributeName.trim().length > 0
  ) {
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
    if (
      !attributeName ||
      typeof optionRecord.long !== "string" ||
      optionRecord.long.trim().length === 0
    ) {
      continue;
    }
    const existing = aliasMap.get(attributeName) ?? [];
    existing.push(optionRecord.long.trim());
    aliasMap.set(attributeName, existing);
  }
  for (const [attributeName, values] of aliasMap.entries()) {
    aliasMap.set(
      attributeName,
      [
        ...new Set(
          values
            .map((value) => value.trim())
            .filter((value) => value.length > 0),
        ),
      ].sort((left, right) => left.localeCompare(right)),
    );
  }
  return aliasMap;
}

function renderAttemptedCommand(argv: string[]): string {
  return renderPmCommand(argv);
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
    const flags =
      typeof optionRecord.flags === "string" ? optionRecord.flags.trim() : "";
    const description =
      typeof optionRecord.description === "string"
        ? optionRecord.description.trim()
        : "";
    const attributeName = readOptionAttributeName(option);
    const aliasCandidates = attributeName
      ? (optionAliasMap.get(attributeName) ?? [])
      : [];
    const aliases = aliasCandidates
      .filter((entry) => entry !== optionRecord.long)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    const aliasForMatch = description.match(/^Alias for ([^ ]+)/i);
    const aliasFor =
      aliasForMatch && aliasForMatch[1] ? aliasForMatch[1].trim() : null;
    const required =
      optionRecord.mandatory === true ||
      description.includes("[required]") ||
      description.toLowerCase().includes("required;");
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

function compactHelpOptionAliases(
  options: HelpOptionSummary[],
): HelpOptionSummary[] {
  const canonicalByLong = new Map<string, HelpOptionSummary>();
  const aliasOptions: HelpOptionSummary[] = [];
  for (const option of options) {
    if (option.alias_for && option.long) {
      aliasOptions.push(option);
      continue;
    }
    if (option.long) {
      canonicalByLong.set(option.long, option);
    }
  }
  for (const aliasOption of aliasOptions) {
    const aliasFor = aliasOption.alias_for as string;
    const canonical = canonicalByLong.get(aliasFor);
    if (!canonical) {
      continue;
    }
    const aliasLong = aliasOption.long as string;
    const aliases = new Set<string>([...(canonical.aliases ?? []), aliasLong]);
    canonical.aliases = [...aliases].sort((left, right) =>
      left.localeCompare(right),
    );
  }
  return options.filter((option) => {
    if (!option.alias_for || !option.long) {
      return true;
    }
    return !canonicalByLong.has(option.alias_for);
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
    const description =
      typeof argument.description === "string" &&
      argument.description.trim().length > 0
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

function buildHelpSubcommandSummaries(
  command: Command,
): HelpSubcommandSummary[] {
  return command.commands
    .map((entry) => ({
      name: entry.name().trim(),
      aliases: commandAliases(entry),
      description: entry.description().trim(),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function buildJsonHelpNarrative(
  detailMode: ReturnType<typeof resolveHelpDetailMode>,
  fallbackNarrative: ReturnType<typeof resolveHelpNarrative>,
  extensionDescriptor: ExtensionCommandHelpDescriptor | undefined,
): ReturnType<typeof resolveHelpNarrative> {
  if (!extensionDescriptor) {
    return fallbackNarrative;
  }
  const extensionExamples = extensionDescriptor.examples ?? [];
  const extensionFailureHints = extensionDescriptor.failure_hints ?? [];
  return {
    intent:
      extensionDescriptor.intent ??
      extensionDescriptor.description ??
      fallbackNarrative.intent,
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
  };
}

interface PositionalActionHelpProjection {
  arguments: HelpArgumentSummary[];
  options: HelpOptionSummary[];
  subcommands: HelpSubcommandSummary[];
  usage: string;
}

/** Build the command/action structural view shared by every JSON help field. */
function buildPositionalActionHelpProjection(
  action: PmPositionalActionContract | undefined,
  targetCommand: Command,
  resolvedPath: string,
  allOptions: HelpOptionSummary[],
): PositionalActionHelpProjection {
  if (!action) {
    const commandContract = resolvePmCommandPositionalContract(resolvedPath);
    const argumentsList = buildHelpArgumentSummaries(targetCommand);
    return {
      arguments: commandContract
        ? argumentsList.map((argument, index) => ({
            ...argument,
            required:
              commandContract.slots[index]?.required ?? argument.required,
            variadic:
              commandContract.slots[index]?.variadic ?? argument.variadic,
          }))
        : argumentsList,
      options: allOptions,
      subcommands: [
        ...buildHelpSubcommandSummaries(targetCommand),
        ...PM_POSITIONAL_ACTION_CONTRACTS.filter(
          ({ parent }) => parent === resolvedPath,
        ).map(({ action: name, description }) => ({
          name,
          aliases: [],
          description,
        })),
      ].sort((left, right) => left.name.localeCompare(right.name)),
      usage: targetCommand.usage(),
    };
  }
  const acceptedFlags = new Set(action.accepted_flags);
  return {
    arguments: action.slots.map(
      ({ name, required, variadic, value_kind: valueKind, polymorphic }) => ({
        name,
        required,
        variadic,
        description: polymorphic
          ? `Polymorphic ${valueKind} value; inspect the action contract before mutation.`
          : `${valueKind.replaceAll("_", " ")} value.`,
      }),
    ),
    options: allOptions.filter(
      ({ long, aliases }) =>
        (long !== null && acceptedFlags.has(long)) ||
        aliases.some((alias) => acceptedFlags.has(alias)),
    ),
    subcommands: [],
    usage: [
      action.command,
      ...action.slots.map(({ name, required, variadic }) => {
        const token = variadic ? `${name}...` : name;
        return required ? `<${token}>` : `[${token}]`;
      }),
    ].join(" "),
  };
}

function buildJsonHelpPayload(
  rootProgram: Command,
  targetCommand: Command,
  argv: string[],
  requestedPath: string[],
  extensionDescriptors: ReadonlyMap<string, ExtensionCommandHelpDescriptor>,
): Record<string, unknown> {
  const detailMode = resolveHelpDetailMode(argv);
  const commanderPath = normalizeHelpCommandPath(getCommandPath(targetCommand));
  const requestedCommandPath = normalizeHelpCommandPath(
    requestedPath.join(" "),
  );
  const resolvedPath =
    requestedCommandPath.length > commanderPath.length
      ? requestedCommandPath
      : commanderPath;
  const commandPath = resolvedPath.length > 0 ? resolvedPath : undefined;
  const fallbackNarrative = resolveHelpNarrative(commandPath, detailMode);
  const extensionDescriptor = commandPath
    ? extensionDescriptors.get(commandPath)
    : undefined;
  const narrative = buildJsonHelpNarrative(
    detailMode,
    fallbackNarrative,
    extensionDescriptor,
  );
  const positionalAction = resolvePmPositionalActionContract(resolvedPath);
  const allOptionSummaries = compactHelpOptionAliases(
    mergeHelpOptionSummaries(
      buildHelpOptionSummaries(targetCommand),
      buildDynamicExtensionHelpOptionSummaries(extensionDescriptor),
    ),
  );
  const projection = buildPositionalActionHelpProjection(
    positionalAction,
    targetCommand,
    resolvedPath,
    allOptionSummaries,
  );
  return {
    format: "pm_help_v1",
    detail_mode: detailMode,
    root_command: rootProgram.name(),
    requested_path: requestedPath,
    resolved_path: resolvedPath.length > 0 ? resolvedPath : rootProgram.name(),
    description: positionalAction?.description ?? targetCommand.description(),
    usage: projection.usage,
    intent: positionalAction?.description ?? narrative.intent,
    examples: positionalAction ? [positionalAction.example] : narrative.examples,
    tips: positionalAction
      ? [
          `Applicable flags: ${positionalAction.accepted_flags.length > 0 ? positionalAction.accepted_flags.join(", ") : "none"}.`,
        ]
      : narrative.tips,
    arguments: projection.arguments,
    options: projection.options,
    subcommands: projection.subcommands,
    has_subcommands: projection.subcommands.length > 0,
  };
}

/** Implements maybe render bootstrap json help for the public runtime surface of this module. */
export async function maybeRenderBootstrapJsonHelp(
  rootProgram: Command,
  argv: string[],
  extensionDescriptors: ReadonlyMap<string, ExtensionCommandHelpDescriptor>,
): Promise<boolean> {
  const bootstrapGlobal = parseBootstrapGlobalOptions(argv);
  if (!bootstrapGlobal.json) {
    return false;
  }
  const helpRequest = parseBootstrapHelpRequest(argv);
  if (!helpRequest.requested) {
    return false;
  }
  const targetCommand = resolveCommandFromPathTokens(
    rootProgram,
    helpRequest.commandPathTokens,
  );
  if (!targetCommand) {
    if (!bootstrapGlobal.quiet) {
      const unknownMessage = `unknown command '${helpRequest.commandPathTokens.join(" ")}'`;
      const runtimeContext = buildUnknownCommandGuidanceFromRuntime(
        unknownMessage,
        rootProgram,
        extensionDescriptors,
      );
      const envelope = formatCommanderErrorForJson(
        unknownMessage,
        "help",
        BUILTIN_TYPE_HELP_VALUES,
        EXIT_CODE.USAGE,
        {
          ...runtimeContext,
          attemptedCommand: renderAttemptedCommand(argv),
          normalizedInvocationArgs: [...argv],
          providedOptionFlags: extractProvidedOptionFlags(argv),
        },
      );
      printError(JSON.stringify(envelope, null, 2));
    }
    process.exitCode = EXIT_CODE.USAGE;
    return true;
  }
  if (!bootstrapGlobal.quiet) {
    const payload = buildJsonHelpPayload(
      rootProgram,
      targetCommand,
      argv,
      helpRequest.commandPathTokens,
      extensionDescriptors,
    );
    writeStdout(`${JSON.stringify(payload, null, 2)}\n`);
  }
  process.exitCode = EXIT_CODE.SUCCESS;
  return true;
}

function buildCreateUpdatePolicyIntro(
  commandName: "create" | "update",
  typeRegistry: ReturnType<typeof resolveItemTypeRegistry>,
): string {
  const lines = [
    "",
    "Type-aware option policies:",
    "  pass --type <value> with --help to render required/disabled/hidden option policy details for that type.",
    `  active type values: ${typeRegistry.types.join("|")}`,
  ];
  if (commandName === "create") {
    lines.push(
      "  scheduling shortcut: use --schedule-preset lightweight for Reminder/Meeting/Event minimal create flows.",
    );
  }
  return lines.join("\n");
}

function appendTypeOptionHelpLines(
  lines: string[],
  typeDefinition: NonNullable<ReturnType<typeof resolveTypeDefinition>>,
): void {
  if (typeDefinition.options.length === 0) {
    lines.push("  type options: none");
    return;
  }
  lines.push("  type options:");
  for (const option of typeDefinition.options) {
    const requiredLabel = option.required ? " (required)" : "";
    const aliases = option.aliases ?? [];
    lines.push(`    - ${option.key}${requiredLabel}`);
    lines.push(
      `      values: ${option.values.length > 0 ? option.values.join("|") : "any non-empty string"}`,
    );
    lines.push(
      `      aliases: ${aliases.length > 0 ? aliases.join("|") : "none"}`,
    );
    if (option.description && option.description.trim().length > 0) {
      lines.push(`      description: ${option.description.trim()}`);
    }
  }
}

function buildCreatePolicyRequiredSets(
  commandName: "create" | "update",
  typeDefinition: NonNullable<ReturnType<typeof resolveTypeDefinition>>,
): { progressive: Set<string>; strict: Set<string> } {
  const progressive =
    commandName === "create"
      ? new Set<string>(["title", "type"])
      : new Set<string>();
  const strict = new Set(progressive);
  if (commandName === "create") {
    for (const option of [
      ...typeDefinition.required_create_fields,
      ...typeDefinition.required_create_repeatables,
    ]) {
      strict.add(option);
    }
  }
  return { progressive, strict };
}

function appendStrictCreatePolicyHelpLines(
  lines: string[],
  typeDefinition: NonNullable<ReturnType<typeof resolveTypeDefinition>>,
  progressiveRequired: string[],
  strictRequired: string[],
): void {
  const progressive = new Set(progressiveRequired);
  const strictOnly = strictRequired.filter(
    (option) => !progressive.has(option),
  );
  const toFlags = (options: string[]): string =>
    options.length > 0
      ? options
          .map((option) => commandOptionFlagLabel("create", option))
          .join(", ")
      : "none";
  lines.push(`  required in strict mode: ${toFlags(strictOnly)}`);
  const explicitEmptyFlags = strictOnly
    .map(resolveCreateExplicitEmptyFlag)
    .filter((flag): flag is string => flag !== undefined);
  lines.push(
    `  explicit empty assertion: ${explicitEmptyFlags.length > 0 ? explicitEmptyFlags.join(", ") : "none"}`,
  );
  if (["Reminder", "Meeting", "Event"].includes(typeDefinition.name)) {
    lines.push(
      "  schedule preset: --schedule-preset lightweight switches schedule artifacts to progressive required-option policy.",
    );
    lines.push("  strict parity remains available via --create-mode strict.");
  }
}

function buildCreateUpdatePolicyHelpText(
  commandName: "create" | "update",
  typeRegistry: ReturnType<typeof resolveItemTypeRegistry>,
  argv: string[],
): string {
  const selectedTypeRaw = parseBootstrapTypeValue(argv);
  if (!selectedTypeRaw) {
    return buildCreateUpdatePolicyIntro(commandName, typeRegistry);
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

  const argumentTerminatorIndex = argv.indexOf("--");
  const optionArgv =
    argumentTerminatorIndex < 0 ? argv : argv.slice(0, argumentTerminatorIndex);
  const createModeTokenIndex = optionArgv.findIndex(
    (token) => token === "--create-mode" || token.startsWith("--create-mode="),
  );
  const createModeToken =
    createModeTokenIndex < 0
      ? undefined
      : optionArgv[createModeTokenIndex]?.startsWith("--create-mode=")
        ? optionArgv[createModeTokenIndex]?.slice("--create-mode=".length)
        : optionArgv[createModeTokenIndex + 1];
  const strictCreateMode =
    commandName === "create" && createModeToken?.toLowerCase() === "strict";
  const requiredSets = buildCreatePolicyRequiredSets(
    commandName,
    typeDefinition,
  );
  const progressivePolicyState = resolveCommandOptionPolicyState(
    typeDefinition,
    commandName,
    requiredSets.progressive,
  );
  const policyState = resolveCommandOptionPolicyState(
    typeDefinition,
    commandName,
    strictCreateMode ? requiredSets.strict : requiredSets.progressive,
  );
  const toFlags = (options: string[]): string =>
    options.length > 0
      ? options
          .map((option) => commandOptionFlagLabel(commandName, option))
          .join(", ")
      : "none";

  const lines = [
    "",
    `Type-aware option policies for ${typeDefinition.name}:`,
    `  required: ${toFlags(policyState.required)}`,
    `  disabled: ${toFlags(policyState.disabled)}`,
    `  hidden: ${toFlags(policyState.hidden)}`,
  ];
  if (commandName === "create") {
    const strictPolicyState = resolveCommandOptionPolicyState(
      typeDefinition,
      commandName,
      requiredSets.strict,
    );
    appendStrictCreatePolicyHelpLines(
      lines,
      typeDefinition,
      progressivePolicyState.required,
      strictPolicyState.required,
    );
  }
  appendTypeOptionHelpLines(lines, typeDefinition);
  if (policyState.errors.length > 0) {
    lines.push(`  config errors: ${policyState.errors.join("; ")}`);
  }
  return lines.join("\n");
}

/** Implements attach create update policy help text for the public runtime surface of this module. */
export function attachCreateUpdatePolicyHelpText(
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
  command.addHelpText(
    "after",
    buildCreateUpdatePolicyHelpText(bootstrapCommand, typeRegistry, argv),
  );
}

/** Public contract for test only, shared by SDK and presentation-layer consumers. */
export const _testOnly = {
  attachCreateUpdatePolicyHelpText,
  buildCreateUpdatePolicyHelpText,
  buildJsonHelpPayload,
  buildPositionalActionHelpProjection,
  buildHelpArgumentSummaries,
  buildHelpOptionSummaries,
  buildHelpSubcommandSummaries,
  buildOptionAliasMap,
  compactHelpOptionAliases,
  readOptionAttributeName,
  resolveCommandFromPathTokens,
};
