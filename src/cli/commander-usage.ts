import { Command } from "commander";
import { pathExists } from "../core/fs/fs-utils.js";
import { resolveItemTypeRegistry } from "../core/item/type-registry.js";
import { EXIT_CODE } from "../core/shared/constants.js";
import { getSettingsPath, resolvePmRoot } from "../core/store/paths.js";
import { readSettings } from "../core/store/settings.js";
import { BUILTIN_ITEM_TYPE_VALUES } from "../types/index.js";
import {
  getActiveExtensionRegistrations,
  runActiveServiceOverride,
} from "../core/extensions/index.js";
import { resolveSubcommandFlagContractsForCommand } from "../sdk/cli-contracts.js";
import {
  type CommanderGuidanceContext,
  formatCommanderErrorForDisplay,
  formatCommanderErrorForJson,
} from "./error-guidance.js";
import { normalizeHelpCommandPath } from "./help-content.js";
import { getCommandPath } from "./registration-helpers.js";
import {
  normalizeBootstrapInvocation,
  parseBootstrapGlobalOptions,
  parseBootstrapCommandName,
} from "./bootstrap-args.js";
import {
  extractProvidedOptionFlags,
  normalizeLongFlag,
  renderPmCommand,
} from "./argv-utils.js";
import { levenshteinDistanceWithinLimit } from "../core/shared/levenshtein.js";
import type { ExtensionCommandHelpDescriptor } from "./extension-command-help.js";

export const BUILTIN_TYPE_HELP_VALUES = BUILTIN_ITEM_TYPE_VALUES.join("|");

const OPTIONAL_PACKAGE_INSTALL_HINTS: Record<string, string> = {
  calendar: "calendar",
  cal: "calendar",
  reindex: "search-advanced",
  "search-advanced": "search-advanced",
  "dedupe-audit": "governance-audit",
  "comments-audit": "governance-audit",
  normalize: "governance-audit",
  guide: "guide-shell",
  completion: "guide-shell",
  templates: "templates",
  "test-runs": "linked-test-adapters",
  beads: "beads",
  todos: "todos",
};

export interface CommanderUsageContext extends CommanderGuidanceContext {
  message: string;
  commandName: string | undefined;
  allowedTypes: string;
}

export function collectRuntimeCommandPaths(
  root: Command,
  extensionDescriptors: ReadonlyMap<string, ExtensionCommandHelpDescriptor>,
): string[] {
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
  for (const descriptorPath of extensionDescriptors.keys()) {
    const normalizedPath = normalizeHelpCommandPath(descriptorPath);
    const hasInternalSegment = normalizedPath.split(" ").some((segment) => segment.startsWith("_"));
    if (normalizedPath.length > 0 && !hasInternalSegment) {
      commandPaths.add(normalizedPath);
    }
  }
  return [...commandPaths].sort((left, right) => left.localeCompare(right));
}

export function scoreCommandPathMatch(commandPath: string, queryToken: string): number {
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

function toComparableFlag(flag: string): string {
  return normalizeLongFlag(flag).slice(2).replace(/-/g, "");
}

function renderAttemptedCommand(argv: string[]): string {
  return renderPmCommand(argv);
}

function resolveOptionalPackageInstallHint(commandPath: string): string | null {
  const topLevel = commandPath.split(" ")[0]?.trim().toLowerCase();
  if (!topLevel) {
    return null;
  }
  const packageAlias = OPTIONAL_PACKAGE_INSTALL_HINTS[topLevel];
  if (!packageAlias) {
    return null;
  }
  return `If this command comes from an optional package, install it with: pm install ${packageAlias}`;
}

function collectKnownLongFlags(commandName: string | undefined): string[] {
  const flags = new Set<string>();
  const contracts = resolveSubcommandFlagContractsForCommand(commandName);
  for (const contract of contracts) {
    if (contract.flag.startsWith("--")) {
      flags.add(normalizeLongFlag(contract.flag));
    }
    for (const alias of contract.aliases ?? []) {
      if (alias.startsWith("--")) {
        flags.add(normalizeLongFlag(alias));
      }
    }
  }
  return [...flags].sort((left, right) => left.localeCompare(right));
}

function suggestNearestLongFlags(unknownOption: string, knownFlags: string[]): string[] {
  if (!unknownOption.startsWith("--")) {
    return [];
  }
  const unknownComparable = toComparableFlag(unknownOption);
  const maxDistance = unknownComparable.length >= 8 ? 2 : 1;
  const candidates: Array<{ flag: string; distance: number }> = [];
  for (const flag of knownFlags) {
    const distance = levenshteinDistanceWithinLimit(unknownComparable, toComparableFlag(flag), maxDistance);
    if (distance === null) {
      continue;
    }
    if (distance <= 0) {
      continue;
    }
    candidates.push({ flag, distance });
  }
  return candidates
    .sort((left, right) => {
      if (left.distance !== right.distance) {
        return left.distance - right.distance;
      }
      return left.flag.localeCompare(right.flag);
    })
    .map((entry) => entry.flag)
    .slice(0, 3);
}

function rewriteUnknownOptionArgv(argv: string[], unknownOption: string, replacementFlag: string): string[] | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }
    const equalsIndex = token.indexOf("=");
    const key = equalsIndex >= 0 ? token.slice(0, equalsIndex) : token;
    if (normalizeLongFlag(key) !== normalizeLongFlag(unknownOption)) {
      continue;
    }
    const next = [...argv];
    next[index] = equalsIndex >= 0 ? `${replacementFlag}${token.slice(equalsIndex)}` : replacementFlag;
    return next;
  }
  return undefined;
}

export function buildUnknownCommandGuidanceFromRuntime(
  rawMessage: string,
  root: Command,
  extensionDescriptors: ReadonlyMap<string, ExtensionCommandHelpDescriptor>,
): CommanderGuidanceContext | undefined {
  const unknownCommandMatch = rawMessage.match(/unknown command '([^']+)'/i);
  if (!unknownCommandMatch || typeof unknownCommandMatch[1] !== "string") {
    return undefined;
  }
  const normalizedUnknown = normalizeHelpCommandPath(unknownCommandMatch[1]);
  if (normalizedUnknown.length === 0) {
    return undefined;
  }
  const commandPaths = collectRuntimeCommandPaths(root, extensionDescriptors);
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
  const optionalPackageHint = resolveOptionalPackageInstallHint(normalizedUnknown);

  return {
    unknownCommandExamples: examples,
    unknownCommandNextSteps: [
      'Run "pm --help" to list commands available in this runtime, including active extensions.',
      "Use one of the suggested command paths above with --help to inspect valid flags and usage.",
      ...(optionalPackageHint ? [optionalPackageHint] : []),
    ],
  };
}

export function resolveChildCommandByToken(parent: Command, token: string): Command | undefined {
  const normalizedToken = token.trim().toLowerCase();
  return parent.commands.find((candidate) => {
    if (candidate.name().trim().toLowerCase() === normalizedToken) {
      return true;
    }
    const aliases = typeof candidate.aliases === "function" ? candidate.aliases() : [];
    return aliases.some((alias) => alias.trim().toLowerCase() === normalizedToken);
  });
}

export function isKnownHelpCommandPath(root: Command, commandPathTokens: string[]): boolean {
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

export async function resolveCommanderUsageContext(
  error: unknown,
  rootProgram: Command,
  extensionDescriptors: ReadonlyMap<string, ExtensionCommandHelpDescriptor>,
): Promise<CommanderUsageContext> {
  const rawMessage = typeof error === "object" && error !== null ? (error as { message?: string }).message : undefined;
  const message = rawMessage ?? "Invalid command usage";
  const invocationArgv = normalizeBootstrapInvocation(process.argv.slice(2)).argv;
  const bootstrapGlobal = parseBootstrapGlobalOptions(invocationArgv);
  const commandName = parseBootstrapCommandName(invocationArgv);
  const attemptedCommand = renderAttemptedCommand(invocationArgv);
  const providedOptionFlags = extractProvidedOptionFlags(invocationArgv);
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
  const unknownCommandGuidance = buildUnknownCommandGuidanceFromRuntime(message, rootProgram, extensionDescriptors);
  const unknownOptionMatch = message.match(/unknown option '([^']+)'/i);
  const unknownOptionSuggestions =
    unknownOptionMatch && commandName
      ? suggestNearestLongFlags(unknownOptionMatch[1], collectKnownLongFlags(commandName))
      : undefined;
  let suggestedRetryCommand: string | undefined;
  if (unknownOptionMatch && unknownOptionSuggestions && unknownOptionSuggestions.length > 0) {
    const rewritten = rewriteUnknownOptionArgv(invocationArgv, unknownOptionMatch[1], unknownOptionSuggestions[0]);
    if (rewritten) {
      suggestedRetryCommand = renderAttemptedCommand(rewritten);
    }
  }
  if (!suggestedRetryCommand) {
    const missingRequiredOption = message.match(/required option '([^']+)' not specified/i);
    const requiredOptionToken = missingRequiredOption?.[1]?.trim().split(/\s+/)[0]?.replace(/[,:;]+$/g, "");
    if (requiredOptionToken?.startsWith("--")) {
      const hasFlag = invocationArgv.some((token) => token.startsWith(requiredOptionToken));
      if (!hasFlag) {
        suggestedRetryCommand = renderAttemptedCommand([...invocationArgv, requiredOptionToken, "<value>"]);
      }
    }
  }
  return {
    message,
    commandName,
    allowedTypes,
    attemptedCommand,
    normalizedInvocationArgs: [...invocationArgv],
    providedOptionFlags,
    unknownOptionSuggestions,
    suggestedRetryCommand,
    ...(unknownCommandGuidance ?? {}),
  };
}

export async function formatCommanderUsageMessage(
  error: unknown,
  rootProgram: Command,
  extensionDescriptors: ReadonlyMap<string, ExtensionCommandHelpDescriptor>,
): Promise<string> {
  const usageContext = await resolveCommanderUsageContext(error, rootProgram, extensionDescriptors);
  const {
    message,
    commandName,
    allowedTypes,
    unknownCommandExamples,
    unknownCommandNextSteps,
    attemptedCommand,
    normalizedInvocationArgs,
    providedOptionFlags,
    unknownOptionSuggestions,
    suggestedRetryCommand,
  } = usageContext;
  const formatted = formatCommanderErrorForDisplay(message, commandName, allowedTypes, {
    unknownCommandExamples,
    unknownCommandNextSteps,
    attemptedCommand,
    normalizedInvocationArgs,
    providedOptionFlags,
    unknownOptionSuggestions,
    suggestedRetryCommand,
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

export async function formatCommanderUsageJson(
  error: unknown,
  rootProgram: Command,
  extensionDescriptors: ReadonlyMap<string, ExtensionCommandHelpDescriptor>,
): Promise<string> {
  const usageContext = await resolveCommanderUsageContext(error, rootProgram, extensionDescriptors);
  const envelope = formatCommanderErrorForJson(
    usageContext.message,
    usageContext.commandName,
    usageContext.allowedTypes,
    EXIT_CODE.USAGE,
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
  return JSON.stringify(envelope, null, 2);
}
