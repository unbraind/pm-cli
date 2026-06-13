import { Command } from "commander";
import {
  commandOptionFlagLabel,
  resolveCommandOptionPolicyState,
  resolveItemTypeRegistry,
  resolveTypeDefinition,
} from "../core/item/type-registry.js";
import { EXIT_CODE } from "../core/shared/constants.js";
import { printError, writeStdout } from "../core/output/output.js";
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

export interface HelpArgumentSummary {
  name: string;
  required: boolean;
  variadic: boolean;
  description: string | null;
}

export interface HelpSubcommandSummary {
  name: string;
  aliases: string[];
  description: string;
}

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

function compactHelpOptionAliases(options: HelpOptionSummary[]): HelpOptionSummary[] {
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
    if (!aliasOption.alias_for || !aliasOption.long) {
      continue;
    }
    const canonical = canonicalByLong.get(aliasOption.alias_for);
    if (!canonical) {
      continue;
    }
    const aliases = new Set([...(canonical.aliases ?? []), aliasOption.long]);
    canonical.aliases = [...aliases].sort((left, right) => left.localeCompare(right));
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

function buildJsonHelpPayload(
  rootProgram: Command,
  targetCommand: Command,
  argv: string[],
  requestedPath: string[],
  extensionDescriptors: ReadonlyMap<string, ExtensionCommandHelpDescriptor>,
): Record<string, unknown> {
  const detailMode = resolveHelpDetailMode(argv);
  const resolvedPath = normalizeHelpCommandPath(getCommandPath(targetCommand));
  const commandPath = resolvedPath.length > 0 ? resolvedPath : undefined;
  const fallbackNarrative = resolveHelpNarrative(commandPath, detailMode);
  const extensionDescriptor = commandPath ? extensionDescriptors.get(commandPath) : undefined;
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
  const optionSummaries = compactHelpOptionAliases(
    mergeHelpOptionSummaries(
      buildHelpOptionSummaries(targetCommand),
      buildDynamicExtensionHelpOptionSummaries(extensionDescriptor),
    ),
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
  const targetCommand = resolveCommandFromPathTokens(rootProgram, helpRequest.commandPathTokens);
  if (!targetCommand) {
    if (!bootstrapGlobal.quiet) {
      const unknownMessage = `unknown command '${helpRequest.commandPathTokens.join(" ")}'`;
      const runtimeContext = buildUnknownCommandGuidanceFromRuntime(unknownMessage, rootProgram, extensionDescriptors);
      const envelope = formatCommanderErrorForJson(
        unknownMessage,
        "help",
        BUILTIN_TYPE_HELP_VALUES,
        EXIT_CODE.USAGE,
        {
          ...(runtimeContext ?? {}),
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
    const payload = buildJsonHelpPayload(rootProgram, targetCommand, argv, helpRequest.commandPathTokens, extensionDescriptors);
    writeStdout(`${JSON.stringify(payload, null, 2)}\n`);
  }
  process.exitCode = EXIT_CODE.SUCCESS;
  return true;
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
  command.addHelpText("after", buildCreateUpdatePolicyHelpText(bootstrapCommand, typeRegistry, argv));
}

export const _testOnly = {
  attachCreateUpdatePolicyHelpText,
  buildCreateUpdatePolicyHelpText,
};
