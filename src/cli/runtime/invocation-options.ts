/**
 * @module cli/runtime/invocation-options
 * Preserves global-option boundaries, contributed flag schemas and read-output provenance.
 */
import { Command } from "commander";
import { resolveSubcommandFlagContractsForCommand } from "../../sdk/cli-contracts.js";
import { resolvePmCommandOperation } from "../../sdk/cli-contracts/command-aliases.js";
import {
  PM_READ_OUTPUT_SURFACE_CONTRACTS,
  applyReadOutputIncludeModes,
  readOutputIncludeModeOptions,
  resolveReadOutputSurface
} from "../../sdk/read-output-contracts.js";
import {
  type FlagDefinition,
  type GlobalOptions,
  EXIT_CODE,
  PmCliError,
  createEmptyExtensionRegistrationRegistry
} from "../../sdk/runtime-primitives.js";
import { extractProvidedOptionFlags } from "../argv-utils.js";
import {
  type ExtensionCommandHelpDescriptor,
  normalizeExtensionCommandPath
} from "../extension-command-help.js";
import {
  type LooseCommandFlagDefinition,
  coerceLooseCommandOptionsWithFlagDefinitions,
  collectLooseCommandOptionKeysForDefinitions,
  parseLooseCommandOptions,
  validateLooseCommandOptionsWithFlagDefinitions
} from "../extension-command-options.js";
import {
  getCommandPath,
  setResolvedGlobalOptions
} from "../registration-helpers.js";

const READ_OUTPUT_INVOCATION_PROVENANCE = Symbol.for("pm.readOutputInvocationProvenance");

/** Carry private read-output provenance across Commander's option rebuilds. */
function copyReadOutputInvocationProvenance(source: object, target: object): void {
  const provenance = Reflect.get(source, READ_OUTPUT_INVOCATION_PROVENANCE);
  if (provenance !== undefined) {
    Reflect.set(target, READ_OUTPUT_INVOCATION_PROVENANCE, provenance);
  }
}

/** Record the exact compatibility flags present in the raw CLI invocation. */
function recordCliReadOutputInvocationProvenance(actionCommand: Command, commandPath: string, commandOptions: Record<string, unknown>): void {
  const surface = resolveReadOutputSurface(commandPath, commandOptions);
  if (!surface) return;
  let rootCommand = actionCommand;
  while (rootCommand.parent) rootCommand = rootCommand.parent;
  const rawArgs = (rootCommand as Command & { rawArgs: string[] }).rawArgs;
  const providedFlags = new Set(extractProvidedOptionFlags(rawArgs.slice(2)));
  const contract = PM_READ_OUTPUT_SURFACE_CONTRACTS.find((candidate) => candidate.command === surface)!;
  const explicitLegacyAliases = Object.values(contract.dimensions).flatMap((dimension) =>
    dimension.legacy_aliases.flatMap((alias) => (providedFlags.has(alias.flag) ? [alias.flag] : [])),
  );
  const previous = Reflect.get(commandOptions, READ_OUTPUT_INVOCATION_PROVENANCE) as
    | {
        canonical_include_modes?: string[];
      }
    | undefined;
  Reflect.set(commandOptions, READ_OUTPUT_INVOCATION_PROVENANCE, {
    canonical_include_modes: previous?.canonical_include_modes ?? [],
    explicit_legacy_aliases: explicitLegacyAliases,
    cli_invocation_observed: true,
  });
  copyReadOutputInvocationProvenance(commandOptions, actionCommand);
}

/* c8 ignore start */

/**
 * Hand canonical `--output-include` projection modes to the command that owns
 * them, leaving only field selectors for post-execution projection.
 *
 * `--output-include brief` must be the exact behaviour of `--brief`, which the
 * emitted migration hint promises; a mode can only be honoured before the
 * command computes its rows, so it cannot be resolved by the output layer.
 */
function forwardReadOutputIncludeModes(actionCommand: Command, commandPath: string, globalOptions: GlobalOptions, commandOptions: Record<string, unknown>): void {
  recordCliReadOutputInvocationProvenance(actionCommand, commandPath, commandOptions);
  const requested = globalOptions.outputInclude;
  if (requested === undefined) return;
  const { selectors, modes } = applyReadOutputIncludeModes(commandPath, requested, commandOptions);
  if (commandPath === "get" && typeof commandOptions.fields === "string") {
    actionCommand.setOptionValueWithSource("fields", commandOptions.fields, "cli");
  }
  if (modes.length === 0) return;
  copyReadOutputInvocationProvenance(commandOptions, actionCommand);
  const modeOptions = readOutputIncludeModeOptions(commandPath);
  for (const mode of modes) {
    const key = modeOptions.get(mode)!;
    const value = commandOptions[key];
    actionCommand.setOptionValueWithSource(key, value, "cli");
  }
  const residual = selectors.length > 0 ? selectors.join(",") : undefined;
  if (residual === undefined) {
    delete globalOptions.outputInclude;
  } else {
    globalOptions.outputInclude = residual;
  }
  // The resolved-global cache is cleared and re-read from Commander before the
  // handler runs, so the consumed modes have to leave the parsed option too.
  for (let scope: Command | null = actionCommand; scope; scope = scope.parent) {
    scope.setOptionValueWithSource("outputInclude", residual, "cli");
  }
  setResolvedGlobalOptions(actionCommand, globalOptions);
}

/** Collect inherited options without leaking namespace-parent defaults into relocated leaves. */
function collectCommandInvocationOptions(command: Command): Record<string, unknown> {
  const allOptions = command.optsWithGlobals() as Record<string, unknown>;
  const commandPath = getCommandPath(command);
  if (resolvePmCommandOperation(commandPath) === commandPath) return allOptions;
  const ownOptions = command.opts() as Record<string, unknown>;
  for (let parent = command.parent; parent?.parent; parent = parent.parent) {
    for (const key of Object.keys(parent.opts())) {
      if (!(key in ownOptions) && parent.getOptionValueSource(key) === "default") delete allOptions[key];
    }
  }
  return allOptions;
}

/** Separate handler options from global controls, then validate and coerce contributed flags against the command's declared schema. */
function extractCommandScopedOptions(command: Command, commandArgs: string[], extensionFlagDefinitions: LooseCommandFlagDefinition[] = []): Record<string, unknown> {
  const allOptions = collectCommandInvocationOptions(command);
  const scoped: Record<string, unknown> = { ...allOptions };
  copyReadOutputInvocationProvenance(command, scoped);
  delete scoped.json;
  delete scoped.quiet;
  delete scoped.path;
  delete scoped.pmPath;
  delete scoped.noExtensions;
  delete scoped.extensions;
  delete scoped.profile;
  delete scoped.pager;
  // Global output controls must not leak into per-command mutation fields.
  delete scoped.changedFields;
  delete scoped.fullChangedFields;
  delete scoped.idOnly;
  delete scoped.lean;
  delete scoped.tokenAccounting;
  delete scoped.outputInclude;
  delete scoped.outputLimit;
  delete scoped.outputBudget;
  delete scoped.outputFormat;
  delete scoped.outputSession;

  const looseOptions = parseLooseCommandOptions(commandArgs);
  for (const [key, value] of Object.entries(looseOptions)) {
    /* c8 ignore next */
    if (scoped[key] === undefined) {
      scoped[key] = value;
    }
  }
  if (extensionFlagDefinitions.length > 0) {
    const extensionOptionKeys = collectLooseCommandOptionKeysForDefinitions(extensionFlagDefinitions);
    const coreFlagDefinitions = resolveSubcommandFlagContractsForCommand(getCommandPath(command)).map((contract) => ({
      long: contract.flag,
      short: contract.short,
      aliases: contract.aliases,
    }));
    const optionsToValidate: Record<string, unknown> = { ...looseOptions };
    for (const key of extensionOptionKeys) {
      /* c8 ignore next */
      if (scoped[key] !== undefined) {
        optionsToValidate[key] = scoped[key];
      }
    }
    validateLooseCommandOptionsWithFlagDefinitions(optionsToValidate, [...coreFlagDefinitions, ...extensionFlagDefinitions], getCommandPath(command));
    return coerceLooseCommandOptionsWithFlagDefinitions(scoped, extensionFlagDefinitions, looseOptions);
  }
  return scoped;
}

/* c8 ignore stop */

/** Join contributed flags by stable operation identity so canonical and compatibility command paths share the same schema. */
function collectExtensionFlagDefinitionsForCommand(registrations: ReturnType<typeof createEmptyExtensionRegistrationRegistry>, commandPath: string): FlagDefinition[] {
  const normalizedCommandPath = normalizeExtensionCommandPath(commandPath);
  if (normalizedCommandPath.length === 0) {
    return [];
  }
  return registrations.flags.filter((entry) => resolvePmCommandOperation(normalizeExtensionCommandPath(entry.target_command)) === resolvePmCommandOperation(normalizedCommandPath)).flatMap((entry) => entry.flags);
}

/** Collect contributed flag definitions for the command paths traversed by this invocation. */
function collectExtensionFlagDefinitionsForInvocation(
  registrations: ReturnType<typeof createEmptyExtensionRegistrationRegistry>,
  commandPath: string,
  commandArgs: string[],
): FlagDefinition[] {
  const exact = collectExtensionFlagDefinitionsForCommand(registrations, commandPath);
  const pathParts = [commandPath];
  let nestedMatch: FlagDefinition[] = [];
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

/** Read contributed positional argument definitions for a dynamic command. */
function dynamicCommandArguments(descriptor: ExtensionCommandHelpDescriptor): ExtensionCommandHelpDescriptor["arguments"] {
  return descriptor.arguments ?? [];
}

/** Render required, optional and variadic arguments in the usage string for an extension command. */
function formatDynamicCommandUsage(descriptor: ExtensionCommandHelpDescriptor): string {
  const argumentSuffix = dynamicCommandArguments(descriptor)
    .map((argument) => {
      const label = argument.variadic ? `${argument.name}...` : argument.name;
      return argument.required ? `<${label}>` : `[${label}]`;
    })
    .join(" ");
  return `pm ${descriptor.command}${argumentSuffix ? ` ${argumentSuffix}` : ""}`;
}

/**
 * Reports whether {@link commandPath} is the generated command path of a
 * registered importer (`<name> import`) or exporter (`<name> export`). Importers
 * and exporters read/write a source/destination via flags and take no positional
 * operand, so an unexpected positional is a usage error; free-form
 * `registerCommand` commands intentionally accept positionals via `context.args`
 * and are excluded.
 */
function isImporterOrExporterCommandPath(registrations: ReturnType<typeof createEmptyExtensionRegistrationRegistry> | null, commandPath: string): boolean {
  if (!registrations) {
    return false;
  }
  const normalized = normalizeExtensionCommandPath(commandPath);
  return (
    registrations.importers.some((entry) => normalizeExtensionCommandPath(`${entry.importer} import`) === normalized) ||
    registrations.exporters.some((entry) => normalizeExtensionCommandPath(`${entry.exporter} export`) === normalized)
  );
}

/** Reject missing required or excess positional arguments before invoking a contributed handler. */
function validateDynamicExtensionCommandArgs(descriptor: ExtensionCommandHelpDescriptor, args: string[]): void {
  const descriptorArguments = dynamicCommandArguments(descriptor);
  const requiredCount = descriptorArguments.filter((argument) => argument.required).length;
  const variadic = descriptorArguments.some((argument) => argument.variadic);
  const maxCount = variadic ? Number.POSITIVE_INFINITY : descriptorArguments.length;
  const failureHints = descriptor.failure_hints ?? [];
  const hintSuffix = failureHints.length > 0 ? ` ${failureHints.join(" ")}` : "";
  if (args.length < requiredCount) {
    throw new PmCliError(`Missing required argument for extension command '${descriptor.command}'. Usage: ${formatDynamicCommandUsage(descriptor)}${hintSuffix}`, EXIT_CODE.USAGE);
  }
  if (args.length > maxCount) {
    const extra = args.slice(maxCount).join(" ");
    throw new PmCliError(
      `Too many arguments for extension command '${descriptor.command}': ${extra}. Usage: ${formatDynamicCommandUsage(descriptor)}${hintSuffix}`,
      EXIT_CODE.USAGE,
    );
  }
}

/** Convert a parsed option key to its canonical dashed flag spelling for actionable usage errors. */
function formatDynamicOptionFlag(optionKey: string): string {
  return `--${optionKey
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/_/g, "-")
    .toLowerCase()}`;
}

/** Validate declared extension flags and reject all supplied options when a command declares no flags. */
function validateDynamicExtensionCommandOptions(
  descriptor: ExtensionCommandHelpDescriptor,
  options: Record<string, unknown>,
  extensionFlagDefinitions: LooseCommandFlagDefinition[],
): void {
  if (extensionFlagDefinitions.length > 0) {
    validateLooseCommandOptionsWithFlagDefinitions(options, extensionFlagDefinitions, descriptor.command);
    return;
  }
  const unknownOptions = Object.keys(options)
    .filter((key) => options[key] !== undefined)
    .sort();
  if (unknownOptions.length === 0) {
    return;
  }
  throw new PmCliError(
    `Unknown option '${unknownOptions.map(formatDynamicOptionFlag).join(", ")}' for extension command '${descriptor.command}'. This command does not define extension flags.`,
    EXIT_CODE.USAGE,
  );
}

/** Validate contributed arguments and options together before extension dispatch. */
function validateDynamicExtensionCommandInvocation(
  descriptor: ExtensionCommandHelpDescriptor | undefined,
  args: string[],
  options: Record<string, unknown>,
  extensionFlagDefinitions: LooseCommandFlagDefinition[],
): void {
  if (!descriptor) {
    return;
  }
  validateDynamicExtensionCommandArgs(descriptor, args);
  validateDynamicExtensionCommandOptions(descriptor, options, extensionFlagDefinitions);
}

export { collectExtensionFlagDefinitionsForCommand,collectExtensionFlagDefinitionsForInvocation,dynamicCommandArguments,extractCommandScopedOptions,forwardReadOutputIncludeModes,isImporterOrExporterCommandPath,recordCliReadOutputInvocationProvenance,validateDynamicExtensionCommandArgs,validateDynamicExtensionCommandInvocation };
