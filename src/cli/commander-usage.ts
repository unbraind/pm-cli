/**
 * @module cli/commander-usage
 *
 * Provides CLI runtime support for Commander Usage.
 */
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
  PM_CORE_COMMAND_NAMES,
  resolveSubcommandFlagContractsForCommand,
  type CliFlagContract,
} from "../sdk/cli-contracts.js";
import {
  type CommanderGuidanceContext,
  formatCommanderErrorForDisplay,
  formatCommanderErrorForJson,
  projectLeanErrorEnvelope,
} from "./error-guidance.js";
import { normalizeHelpCommandPath } from "./help-content.js";
import { getCommandPath } from "./registration-helpers.js";
import {
  EXECUTABLE_COMMAND_ALIASES,
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
import { normalizeExtensionNameForMatch } from "./commands/extension/shared.js";

/** Supported values accepted by the builtin type help contract. */
export const BUILTIN_TYPE_HELP_VALUES = BUILTIN_ITEM_TYPE_VALUES.join("|");

const OPTIONAL_PACKAGE_INSTALL_HINTS: Record<string, string> = {
  calendar: "calendar",
  cal: "calendar",
  reindex: "search-advanced",
  "search-advanced": "search-advanced",
  guide: "guide-shell",
  completion: "guide-shell",
  templates: "templates",
  "test-runs": "linked-test-adapters",
  beads: "beads",
  todos: "todos",
};

const SEMANTIC_UNKNOWN_OPTION_SUGGESTIONS: Record<
  string,
  Record<string, string[]>
> = {
  comments: {
    "--body": ["--add"],
    "--text": ["--add"],
    "--comment": ["--add"],
  },
  notes: {
    "--body": ["--add"],
    "--text": ["--add"],
    "--note": ["--add"],
  },
  learnings: {
    "--body": ["--add"],
    "--text": ["--add"],
    "--learning": ["--add"],
  },
  // pm update / pm create now accept --add-tags natively, so the singular
  // --add-tag and the old "--tag" mistype still need to be redirected at the
  // canonical additive flag (not at --tags, which would silently replace).
  update: {
    "--add-tag": ["--add-tags"],
    "--remove-tag": ["--remove-tags"],
    "--tag": ["--tags"],
  },
  create: {
    "--add-tag": ["--add-tags"],
    "--tag": ["--tags"],
  },
};

function getSemanticUnknownOptionSuggestions(
  commandName: string,
  unknownOption: string,
): string[] {
  const commandSuggestions = SEMANTIC_UNKNOWN_OPTION_SUGGESTIONS[commandName];
  if (!commandSuggestions) {
    return [];
  }
  const normalizedUnknown = normalizeLongFlag(unknownOption);
  for (const [flag, suggestions] of Object.entries(commandSuggestions)) {
    if (normalizeLongFlag(flag) === normalizedUnknown) {
      return suggestions;
    }
  }
  return [];
}

/** Documents the commander usage context payload exchanged by command, SDK, and package integrations. */
export interface CommanderUsageContext extends CommanderGuidanceContext {
  /** Human-readable explanation suitable for logs and agent-facing output. */
  message: string;
  /** Value that configures or reports command name for this contract. */
  commandName: string | undefined;
  /** Value that configures or reports allowed types for this contract. */
  allowedTypes: string;
}

/** Implements collect runtime command paths for the public runtime surface of this module. */
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
    const hasInternalSegment = normalizedPath
      .split(" ")
      .some((segment) => segment.startsWith("_"));
    if (normalizedPath.length > 0 && !hasInternalSegment) {
      commandPaths.add(normalizedPath);
    }
    queue.push(...current.commands);
  }
  for (const descriptorPath of extensionDescriptors.keys()) {
    const normalizedPath = normalizeHelpCommandPath(descriptorPath);
    const hasInternalSegment = normalizedPath
      .split(" ")
      .some((segment) => segment.startsWith("_"));
    if (normalizedPath.length > 0 && !hasInternalSegment) {
      commandPaths.add(normalizedPath);
    }
  }
  return [...commandPaths].sort((left, right) => left.localeCompare(right));
}

/** Implements score command path match for the public runtime surface of this module. */
export function scoreCommandPathMatch(
  commandPath: string,
  queryToken: string,
): number {
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
  // Fall back to edit distance so transposition/typo cases (e.g. "lst" -> "list") still rank.
  const maxDistance = normalizedToken.length >= 5 ? 2 : 1;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const segment of pathSegments) {
    const distance = levenshteinDistanceWithinLimit(
      segment,
      normalizedToken,
      maxDistance,
    );
    if (distance !== null) {
      bestDistance = Math.min(bestDistance, distance);
    }
  }
  if (Number.isFinite(bestDistance)) {
    return 4 + bestDistance;
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

function normalizePackageCommandAliasToken(value: string): string {
  let normalized = normalizeExtensionNameForMatch(value);
  // Strip outer package/source prefixes and then the pm- package stem so scoped
  // and builtin package guesses converge on the exported command alias.
  for (const prefix of ["@unbraind/", "@unbrained/", "builtin-", "pm-"]) {
    if (normalized.startsWith(prefix)) {
      normalized = normalized.slice(prefix.length);
    }
  }
  return normalized;
}

function collectInstalledPackageCommandPathHints(
  unknownToken: string,
  extensionDescriptors: ReadonlyMap<string, ExtensionCommandHelpDescriptor>,
): string[] {
  const normalizedUnknown = normalizePackageCommandAliasToken(unknownToken);
  if (normalizedUnknown.length === 0) {
    return [];
  }
  const hints: string[] = [];
  for (const descriptor of extensionDescriptors.values()) {
    const identifiers = new Set<string>();
    const source = descriptor.source;
    if (source) {
      for (const identifier of [source.name, source.package]) {
        const normalizedIdentifier = normalizePackageCommandAliasToken(
          identifier ?? "",
        );
        if (normalizedIdentifier.length > 0) {
          identifiers.add(normalizedIdentifier);
        }
      }
    }
    if (identifiers.size === 0) {
      continue;
    }
    const matches = [...identifiers].some(
      (identifier) =>
        identifier === normalizedUnknown ||
        identifier.includes(normalizedUnknown) ||
        normalizedUnknown.includes(identifier),
    );
    if (matches) {
      hints.push(descriptor.command);
    }
  }
  return [...new Set(hints)].sort((left, right) => left.localeCompare(right));
}

function collectKnownLongFlags(
  commandName: string | undefined,
  contractsOverride?: CliFlagContract[],
): string[] {
  const flags = new Set<string>();
  const contracts =
    contractsOverride ?? resolveSubcommandFlagContractsForCommand(commandName);
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

function suggestNearestLongFlags(
  unknownOption: string,
  knownFlags: string[],
): string[] {
  if (!unknownOption.startsWith("--")) {
    return [];
  }
  const unknownComparable = toComparableFlag(unknownOption);
  if (unknownComparable.length === 0) {
    return [];
  }
  const maxDistance = unknownComparable.length >= 8 ? 2 : 1;
  // rank 0 = abbreviation/prefix match (e.g. --desc -> --description), rank 1 = edit-distance typo.
  const candidates: Array<{ flag: string; rank: number; distance: number }> =
    [];
  for (const flag of knownFlags) {
    const flagComparable = toComparableFlag(flag);
    if (flagComparable === unknownComparable) {
      continue;
    }
    if (
      unknownComparable.length >= 3 &&
      flagComparable.startsWith(unknownComparable)
    ) {
      candidates.push({
        flag,
        rank: 0,
        distance: flagComparable.length - unknownComparable.length,
      });
      continue;
    }
    const distance = levenshteinDistanceWithinLimit(
      unknownComparable,
      flagComparable,
      maxDistance,
    );
    if (distance === null || distance <= 0) {
      continue;
    }
    candidates.push({ flag, rank: 1, distance });
  }
  return candidates
    .sort((left, right) => {
      if (left.rank !== right.rank) {
        return left.rank - right.rank;
      }
      if (left.distance !== right.distance) {
        return left.distance - right.distance;
      }
      return left.flag.localeCompare(right.flag);
    })
    .map((entry) => entry.flag)
    .slice(0, 3);
}

let crossCommandFlagIndexCache: Map<string, string[]> | undefined;

// Alias/shortcut command names that duplicate a canonical command. Excluding them
// keeps cross-command flag hints focused on the primary commands an agent should use.
const CROSS_COMMAND_FLAG_EXCLUSIONS = new Set<string>([
  "ctx",
  "packages",
  "list-draft",
  "list-open",
  "list-in-progress",
  "list-blocked",
  "list-closed",
  "list-canceled",
  "start-task",
  "pause-task",
  "close-task",
  "help",
]);

// Index of long flag -> command names that accept it (in declaration order), so an
// unknown flag on one command can be recognised as valid elsewhere (e.g. --type is
// rejected on test-all but valid on create/list). Built once from core command contracts.
function getCrossCommandFlagIndex(): Map<string, string[]> {
  if (crossCommandFlagIndexCache) {
    return crossCommandFlagIndexCache;
  }
  const index = new Map<string, string[]>();
  for (const command of PM_CORE_COMMAND_NAMES) {
    if (CROSS_COMMAND_FLAG_EXCLUSIONS.has(command)) {
      continue;
    }
    for (const flag of collectKnownLongFlags(command)) {
      const commands = index.get(flag) ?? [];
      commands.push(command);
      index.set(flag, commands);
    }
  }
  crossCommandFlagIndexCache = index;
  return crossCommandFlagIndexCache;
}

function findOtherCommandsForFlag(
  unknownOption: string,
  currentCommand: string | undefined,
): string[] {
  if (!unknownOption.startsWith("--")) {
    return [];
  }
  const commands = getCrossCommandFlagIndex().get(
    normalizeLongFlag(unknownOption),
  );
  if (!commands) {
    return [];
  }
  const normalizedCurrent = currentCommand?.trim().toLowerCase();
  return commands
    .filter((command) => command !== normalizedCurrent)
    .slice(0, 3);
}

function rewriteUnknownOptionArgv(
  argv: string[],
  unknownOption: string,
  replacementFlag: string,
): string[] | undefined {
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
    next[index] =
      equalsIndex >= 0
        ? `${replacementFlag}${token.slice(equalsIndex)}`
        : replacementFlag;
    return next;
  }
  return undefined;
}

function scoreRuntimeCommandCandidates(params: {
  commandPaths: string[];
  normalizedUnknown: string;
  primaryToken: string;
}): string[] {
  const commandPathSet = new Set(params.commandPaths);
  const scoreAgainstUnknown = (candidatePath: string): number =>
    Math.min(
      scoreCommandPathMatch(candidatePath, params.normalizedUnknown),
      params.primaryToken !== params.normalizedUnknown
        ? scoreCommandPathMatch(candidatePath, params.primaryToken)
        : Number.POSITIVE_INFINITY,
    );
  const scoresByCommandPath = new Map<string, number>();
  const recordCandidateScore = (commandPath: string, score: number): void => {
    if (!Number.isFinite(score) || !commandPathSet.has(commandPath)) {
      return;
    }
    const existing = scoresByCommandPath.get(commandPath);
    if (existing === undefined || score < existing) {
      scoresByCommandPath.set(commandPath, score);
    }
  };
  for (const commandPath of params.commandPaths) {
    recordCandidateScore(commandPath, scoreAgainstUnknown(commandPath));
  }
  for (const [aliasToken, canonicalPath] of Object.entries(
    EXECUTABLE_COMMAND_ALIASES,
  )) {
    recordCandidateScore(canonicalPath, scoreAgainstUnknown(aliasToken));
  }
  return [...scoresByCommandPath.entries()]
    .sort(([leftPath, leftScore], [rightPath, rightScore]) =>
      leftScore !== rightScore
        ? leftScore - rightScore
        : leftPath.localeCompare(rightPath),
    )
    .map(([commandPath]) => commandPath);
}

function resolveUnknownCommandCandidates(params: {
  commandPaths: string[];
  normalizedUnknown: string;
  primaryToken: string;
  extensionDescriptors: ReadonlyMap<string, ExtensionCommandHelpDescriptor>;
}): string[] {
  const rankedCandidates = scoreRuntimeCommandCandidates(params);
  const installedPackageCandidates = collectInstalledPackageCommandPathHints(
    params.primaryToken,
    params.extensionDescriptors,
  ).filter((commandPath) => params.commandPaths.includes(commandPath));
  return dedupeStrings([...rankedCandidates, ...installedPackageCandidates]);
}

function resolveUnknownCommandFallbacks(commandPaths: string[]): string[] {
  const topLevel = [
    ...new Set(
      commandPaths
        .map((commandPath) => commandPath.split(" ")[0])
        .filter((segment) => segment.length > 0),
    ),
  ];
  return topLevel.sort((left, right) => left.localeCompare(right));
}

function buildUnknownCommandExamples(
  suggestedPaths: string[],
  hasConcreteCandidates: boolean,
): string[] {
  const suggestedExamples = suggestedPaths.map((path) => `pm ${path} --help`);
  if (hasConcreteCandidates) {
    return [...new Set([...suggestedExamples, "pm --help"])];
  }
  return [...new Set(["pm --help", ...suggestedExamples])];
}

/** Implements build unknown command guidance from runtime for the public runtime surface of this module. */
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

  const primaryToken = normalizedUnknown.split(" ")[0];
  // Executable aliases are scored against their canonical runtime command, so a
  // typo of an alias still points at the command path that would actually run.
  const combinedCandidates = resolveUnknownCommandCandidates({
    commandPaths,
    normalizedUnknown,
    primaryToken,
    extensionDescriptors,
  });
  const fallbackTopLevel = resolveUnknownCommandFallbacks(commandPaths);
  const suggestedPaths = (
    combinedCandidates.length > 0 ? combinedCandidates : fallbackTopLevel
  ).slice(0, 3);
  const examples = buildUnknownCommandExamples(
    suggestedPaths,
    combinedCandidates.length > 0,
  );
  const optionalPackageHint =
    resolveOptionalPackageInstallHint(normalizedUnknown);
  const didYouMean =
    combinedCandidates.length > 0
      ? `Did you mean: ${suggestedPaths.join(", ")}?`
      : null;

  return {
    unknownCommandExamples: examples,
    unknownCommandNextSteps: [
      ...(didYouMean ? [didYouMean] : []),
      'Run "pm --help" to list commands available in this runtime, including active extensions.',
      "Use one of the suggested command paths above with --help to inspect valid flags and usage.",
      ...(optionalPackageHint ? [optionalPackageHint] : []),
    ],
  };
}

function dedupeStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

function firstWhitespaceSeparatedToken(input: string): string {
  let token = "";
  for (const character of input) {
    if (
      character === " " ||
      character === "\t" ||
      character === "\n" ||
      character === "\r" ||
      character === "\f" ||
      character === "\v"
    ) {
      break;
    }
    token += character;
  }
  return token;
}

function trimTrailingPunctuationToken(token: string): string {
  let end = token.length;
  while (end > 0) {
    const character = token[end - 1];
    if (character !== "," && character !== ":" && character !== ";") {
      break;
    }
    end -= 1;
  }
  return token.slice(0, end);
}

/** Implements resolve child command by token for the public runtime surface of this module. */
export function resolveChildCommandByToken(
  parent: Command,
  token: string,
): Command | undefined {
  const normalizedToken = token.trim().toLowerCase();
  return parent.commands.find((candidate) => {
    if (candidate.name().trim().toLowerCase() === normalizedToken) {
      return true;
    }
    const aliases =
      typeof candidate.aliases === "function" ? candidate.aliases() : [];
    return aliases.some(
      (alias) => alias.trim().toLowerCase() === normalizedToken,
    );
  });
}

/** Implements check whether known help command path for the public runtime surface of this module. */
export function isKnownHelpCommandPath(
  root: Command,
  commandPathTokens: string[],
): boolean {
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

async function resolveAllowedTypesForUsage(
  bootstrapGlobal: ReturnType<typeof parseBootstrapGlobalOptions>,
): Promise<string> {
  try {
    const pmRoot = resolvePmRoot(process.cwd(), bootstrapGlobal.path);
    if (!(await pathExists(getSettingsPath(pmRoot)))) {
      return BUILTIN_TYPE_HELP_VALUES;
    }
    const settings = await readSettings(pmRoot);
    const extensionRegistrations = bootstrapGlobal.noExtensions
      ? undefined
      : getActiveExtensionRegistrations();
    const typeRegistry = resolveItemTypeRegistry(
      settings,
      extensionRegistrations,
    );
    return typeRegistry.types.length > 0
      ? typeRegistry.types.join("|")
      : BUILTIN_TYPE_HELP_VALUES;
  } catch {
    /* v8 ignore start -- defensive fallback for corrupted settings during usage-error rendering; command behavior is covered through normal settings paths */
    return BUILTIN_TYPE_HELP_VALUES;
    /* v8 ignore stop */
  }
}

function resolveUnknownOptionSuggestions(
  message: string,
  commandName: string | undefined,
): {
  match: RegExpMatchArray | null;
  suggestions: string[] | undefined;
  otherCommands: string[];
} {
  const match = message.match(/unknown option '([^']+)'/i);
  const suggestions =
    match && commandName
      ? dedupeStrings([
          ...getSemanticUnknownOptionSuggestions(commandName, match[1]),
          ...suggestNearestLongFlags(
            match[1],
            collectKnownLongFlags(commandName),
          ),
        ])
      : undefined;
  return {
    match,
    suggestions,
    otherCommands: match ? findOtherCommandsForFlag(match[1], commandName) : [],
  };
}

function resolveSuggestedRetryForUnknownOption(
  invocationArgv: string[],
  unknownOptionMatch: RegExpMatchArray | null,
  unknownOptionSuggestions: string[] | undefined,
): string | undefined {
  if (
    !unknownOptionMatch ||
    !unknownOptionSuggestions ||
    unknownOptionSuggestions.length === 0
  ) {
    return undefined;
  }
  const rewritten = rewriteUnknownOptionArgv(
    invocationArgv,
    unknownOptionMatch[1],
    unknownOptionSuggestions[0],
  );
  return rewritten ? renderAttemptedCommand(rewritten) : undefined;
}

function resolveSuggestedRetryForMissingOption(
  message: string,
  invocationArgv: string[],
): string | undefined {
  const missingRequiredOption = message.match(
    /required option '([^']+)' not specified/i,
  );
  const requiredOptionToken = missingRequiredOption?.[1]
    ? trimTrailingPunctuationToken(
        firstWhitespaceSeparatedToken(missingRequiredOption[1].trim()),
      )
    : undefined;
  if (!requiredOptionToken?.startsWith("--")) {
    return undefined;
  }
  const hasFlag = invocationArgv.some(
    (token) =>
      token === requiredOptionToken ||
      token.startsWith(`${requiredOptionToken}=`),
  );
  return hasFlag
    ? undefined
    : renderAttemptedCommand([
        ...invocationArgv,
        requiredOptionToken,
        "<value>",
      ]);
}

/** Implements resolve commander usage context for the public runtime surface of this module. */
export async function resolveCommanderUsageContext(
  error: unknown,
  rootProgram: Command,
  extensionDescriptors: ReadonlyMap<string, ExtensionCommandHelpDescriptor>,
): Promise<CommanderUsageContext> {
  const rawMessage =
    typeof error === "object" && error !== null
      ? (error as { message?: string }).message
      : undefined;
  const message = rawMessage ?? "Invalid command usage";
  const invocationArgv = normalizeBootstrapInvocation(
    process.argv.slice(2),
  ).argv;
  const bootstrapGlobal = parseBootstrapGlobalOptions(invocationArgv);
  const commandName = parseBootstrapCommandName(invocationArgv);
  const attemptedCommand = renderAttemptedCommand(invocationArgv);
  const providedOptionFlags = extractProvidedOptionFlags(invocationArgv);
  const allowedTypes = await resolveAllowedTypesForUsage(bootstrapGlobal);
  const unknownCommandGuidance = buildUnknownCommandGuidanceFromRuntime(
    message,
    rootProgram,
    extensionDescriptors,
  );
  const unknownOption = resolveUnknownOptionSuggestions(message, commandName);
  const suggestedRetryCommand =
    resolveSuggestedRetryForUnknownOption(
      invocationArgv,
      unknownOption.match,
      unknownOption.suggestions,
    ) ?? resolveSuggestedRetryForMissingOption(message, invocationArgv);
  return {
    message,
    commandName,
    allowedTypes,
    attemptedCommand,
    normalizedInvocationArgs: [...invocationArgv],
    providedOptionFlags,
    unknownOptionSuggestions: unknownOption.suggestions,
    unknownOptionOtherCommands:
      unknownOption.otherCommands.length > 0
        ? unknownOption.otherCommands
        : undefined,
    suggestedRetryCommand,
    ...unknownCommandGuidance,
  };
}

/** Implements format commander usage message for the public runtime surface of this module. */
export async function formatCommanderUsageMessage(
  error: unknown,
  rootProgram: Command,
  extensionDescriptors: ReadonlyMap<string, ExtensionCommandHelpDescriptor>,
): Promise<string> {
  const usageContext = await resolveCommanderUsageContext(
    error,
    rootProgram,
    extensionDescriptors,
  );
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
    unknownOptionOtherCommands,
    suggestedRetryCommand,
  } = usageContext;
  const formatted = formatCommanderErrorForDisplay(
    message,
    commandName,
    allowedTypes,
    {
      unknownCommandExamples,
      unknownCommandNextSteps,
      attemptedCommand,
      normalizedInvocationArgs,
      providedOptionFlags,
      unknownOptionSuggestions,
      unknownOptionOtherCommands,
      suggestedRetryCommand,
    },
  );
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

/** Implements format commander usage json for the public runtime surface of this module. */
export async function formatCommanderUsageJson(
  error: unknown,
  rootProgram: Command,
  extensionDescriptors: ReadonlyMap<string, ExtensionCommandHelpDescriptor>,
  lean = false,
): Promise<string> {
  const usageContext = await resolveCommanderUsageContext(
    error,
    rootProgram,
    extensionDescriptors,
  );
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
      unknownOptionOtherCommands: usageContext.unknownOptionOtherCommands,
      suggestedRetryCommand: usageContext.suggestedRetryCommand,
    },
  );
  return JSON.stringify(
    lean ? projectLeanErrorEnvelope(envelope) : envelope,
    null,
    2,
  );
}

/** Public contract for test only, shared by SDK and presentation-layer consumers. */
export const _testOnly = {
  collectKnownLongFlags,
  collectInstalledPackageCommandPathHints,
  resolveOptionalPackageInstallHint,
  resolveSuggestedRetryForMissingOption,
  suggestNearestLongFlags,
};
