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
import {
  type CommanderGuidanceContext,
  formatCommanderErrorForDisplay,
  formatCommanderErrorForJson,
} from "./error-guidance.js";
import { normalizeHelpCommandPath } from "./help-content.js";
import { getCommandPath } from "./registration-helpers.js";
import {
  normalizeLegacyExtensionActionSyntax,
  parseBootstrapGlobalOptions,
  parseBootstrapCommandName,
} from "./bootstrap-args.js";
import type { ExtensionCommandHelpDescriptor } from "./extension-command-help.js";

export const BUILTIN_TYPE_HELP_VALUES = BUILTIN_ITEM_TYPE_VALUES.join("|");

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

  return {
    unknownCommandExamples: examples,
    unknownCommandNextSteps: [
      'Run "pm --help" to list commands available in this runtime, including active extensions.',
      "Use one of the suggested command paths above with --help to inspect valid flags and usage.",
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
  const invocationArgv = normalizeLegacyExtensionActionSyntax(process.argv.slice(2));
  const bootstrapGlobal = parseBootstrapGlobalOptions(invocationArgv);
  const commandName = parseBootstrapCommandName(invocationArgv);
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
  return {
    message,
    commandName,
    allowedTypes,
    ...(unknownCommandGuidance ?? {}),
  };
}

export async function formatCommanderUsageMessage(
  error: unknown,
  rootProgram: Command,
  extensionDescriptors: ReadonlyMap<string, ExtensionCommandHelpDescriptor>,
): Promise<string> {
  const usageContext = await resolveCommanderUsageContext(error, rootProgram, extensionDescriptors);
  const { message, commandName, allowedTypes, unknownCommandExamples, unknownCommandNextSteps } = usageContext;
  const formatted = formatCommanderErrorForDisplay(message, commandName, allowedTypes, {
    unknownCommandExamples,
    unknownCommandNextSteps,
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
    },
  );
  return JSON.stringify(envelope, null, 2);
}
