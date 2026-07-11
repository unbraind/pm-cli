/**
 * @module cli/extension-command-help
 *
 * Provides CLI runtime support for Extension Command Help.
 */
import { Command } from "commander";
import type {
  RegisteredExtensionCommandDefinition,
  RegisteredExtensionFlagDefinitions,
} from "../core/extensions/index.js";

/** Documents the extension command argument help descriptor payload exchanged by command, SDK, and package integrations. */
export interface ExtensionCommandArgumentHelpDescriptor {
  /** Value that configures or reports name for this contract. */
  name: string;
  /** Value that configures or reports required for this contract. */
  required: boolean;
  /** Value that configures or reports variadic for this contract. */
  variadic: boolean;
  /** Value that configures or reports description for this contract. */
  description?: string;
}

/** Documents the extension command help descriptor payload exchanged by command, SDK, and package integrations. */
export interface ExtensionCommandHelpDescriptor {
  /** Value that configures or reports command for this contract. */
  command: string;
  /** Value that configures or reports action for this contract. */
  action: string;
  /** Value that configures or reports description for this contract. */
  description?: string;
  /** Value that configures or reports intent for this contract. */
  intent?: string;
  /** Value that configures or reports examples for this contract. */
  examples: string[];
  /** Value that configures or reports failure hints for this contract. */
  failure_hints: string[];
  /** Value that configures or reports arguments for this contract. */
  arguments: ExtensionCommandArgumentHelpDescriptor[];
  /** Value that configures or reports flags for this contract. */
  flags: Array<Record<string, unknown>>;
  /** Value that configures or reports source for this contract. */
  source?: {
    layer: "global" | "project";
    name: string;
    package?: string;
  };
}

/** Documents the help option summary payload exchanged by command, SDK, and package integrations. */
export interface HelpOptionSummary {
  /** Value that configures or reports flags for this contract. */
  flags: string;
  /** Value that configures or reports long for this contract. */
  long: string | null;
  /** Value that configures or reports short for this contract. */
  short: string | null;
  /** Value that configures or reports description for this contract. */
  description: string;
  /** Value that configures or reports takes value for this contract. */
  takes_value: boolean;
  /** Value that configures or reports value required for this contract. */
  value_required: boolean;
  /** Value that configures or reports value name for this contract. */
  value_name: string | null;
  /** Value that configures or reports variadic for this contract. */
  variadic: boolean;
  /** Value that configures or reports required for this contract. */
  required: boolean;
  /** Value that configures or reports aliases for this contract. */
  aliases: string[];
  /** Value that configures or reports alias for for this contract. */
  alias_for: string | null;
  /** Fallback value used when callers do not provide an override. */
  default_value?: unknown;
}

/** Implements normalize extension command path for the public runtime surface of this module. */
export function normalizeExtensionCommandPath(commandPath: string): string {
  return commandPath
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((part) => part.length > 0)
    .join(" ");
}

/** Build verified flattened-alias mappings within one extension and layer. */
export function buildCanonicalExtensionAliases(
  handlers: ReadonlyArray<{
    command: string;
    layer: "project" | "global";
    name: string;
  }>,
  definitions: ReadonlyArray<{
    command: string;
    layer: "project" | "global";
    name: string;
  }>,
): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const handler of handlers) {
    const alias = normalizeExtensionCommandPath(handler.command);
    for (const definition of definitions) {
      if (
        definition.layer !== handler.layer ||
        definition.name !== handler.name
      ) {
        continue;
      }
      const canonical = normalizeExtensionCommandPath(definition.command);
      const parts = canonical.split(" ");
      const action = parts.at(-1);
      const suffix = parts.slice(1).join(" ");
      const expectedAlias = suffix
        ? `${parts[0]}-${action} ${suffix}`
        : `${parts[0]}-${action}`;
      if (
        action &&
        alias === expectedAlias
      ) {
        aliases.set(alias, canonical);
        break;
      }
    }
  }
  return aliases;
}

/** Resolve whether a registered extension flag consumes a value. */
export function extensionFlagTakesValueForInvocation(
  invocationArgv: string[],
  commandName: string | undefined,
  normalizedMissing: string | undefined,
  descriptors: ReadonlyMap<string, ExtensionCommandHelpDescriptor>,
): boolean | undefined {
  if (!commandName || !normalizedMissing) {
    return undefined;
  }
  const commandIndex = invocationArgv.indexOf(commandName);
  if (commandIndex < 0) {
    return undefined;
  }
  const commandTokens = invocationArgv.slice(commandIndex);
  const descriptor = [...descriptors.entries()]
    .filter(([path]) =>
      path
        .split(" ")
        .every((token, index) => commandTokens[index] === token),
    )
    .sort(([left], [right]) => right.length - left.length)[0]?.[1];
  const flag = descriptor?.flags.find(
    (candidate) =>
      candidate.long === normalizedMissing ||
      candidate.short === normalizedMissing,
  );
  if (!flag) {
    return undefined;
  }
  const valueName =
    typeof flag.value_name === "string" && flag.value_name.trim().length > 0;
  const valueType =
    typeof flag.value_type === "string"
      ? flag.value_type
      : typeof flag.type === "string"
        ? flag.type
        : undefined;
  return valueName || (valueType !== undefined && valueType !== "boolean");
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

function formatDynamicExtensionFlagHelpLine(
  definition: Record<string, unknown>,
): string | null {
  const visible = toOptionalBoolean(definition.visible);
  if (visible === false) {
    return null;
  }
  const longName = toNonEmptyFlagString(definition.long);
  if (!longName || !longName.startsWith("--") || longName.length < 3) {
    return null;
  }

  const shortName = toNonEmptyFlagString(definition.short);
  const shortPrefix =
    shortName && shortName.startsWith("-") && !shortName.startsWith("--")
      ? `${shortName}, `
      : "";
  const valueName = toNonEmptyFlagString(definition.value_name);
  const valueSuffix = valueName ? ` <${valueName}>` : "";
  const description =
    toNonEmptyFlagString(definition.description) ??
    "Extension-provided option.";
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

function buildDynamicExtensionFlagHelp(
  definitions: Array<Record<string, unknown>>,
): string | null {
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

/** Implements collect dynamic extension flag help by command for the public runtime surface of this module. */
export function collectDynamicExtensionFlagHelpByCommand(
  registrations: RegisteredExtensionFlagDefinitions[],
): Map<string, string> {
  const grouped = new Map<string, Array<Record<string, unknown>>>();
  for (const registration of registrations) {
    const commandPath = normalizeExtensionCommandPath(
      registration.target_command,
    );
    if (commandPath.length === 0) {
      continue;
    }
    const existing = grouped.get(commandPath) ?? [];
    existing.push(...registration.flags);
    grouped.set(commandPath, existing);
  }

  const entries = [...grouped.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  );
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

function normalizeExtensionCommandAction(
  commandPath: string,
  action: string | undefined,
): string {
  if (typeof action !== "string" || action.trim().length === 0) {
    return commandPath.replace(/\s+/g, "-");
  }
  return action.trim().toLowerCase();
}

function normalizeExtensionCommandStringList(
  values: string[] | undefined,
): string[] {
  if (!Array.isArray(values)) {
    return [];
  }
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

function normalizeExtensionCommandArguments(
  values:
    | Array<{
        name?: unknown;
        required?: unknown;
        variadic?: unknown;
        description?: unknown;
      }>
    | undefined,
): ExtensionCommandArgumentHelpDescriptor[] {
  if (!Array.isArray(values)) {
    return [];
  }
  return values
    .map((value) => {
      const name = typeof value.name === "string" ? value.name.trim() : "";
      if (name.length === 0) {
        return null;
      }
      const normalized: ExtensionCommandArgumentHelpDescriptor = {
        name,
        required: value.required === true,
        variadic: value.variadic === true,
      };
      if (
        typeof value.description === "string" &&
        value.description.trim().length > 0
      ) {
        normalized.description = value.description.trim();
      }
      return normalized;
    })
    .filter(
      (entry): entry is ExtensionCommandArgumentHelpDescriptor =>
        entry !== null,
    );
}

function collectExtensionDefinitionsByCommand(
  commandDefinitions: RegisteredExtensionCommandDefinition[],
): Map<string, ExtensionCommandHelpDescriptor> {
  const definitionsByCommand = new Map<
    string,
    ExtensionCommandHelpDescriptor
  >();
  for (const definition of commandDefinitions) {
    const commandPath = normalizeExtensionCommandPath(definition.command);
    if (commandPath.length === 0) {
      continue;
    }
    const description =
      typeof definition.description === "string" &&
      definition.description.trim().length > 0
        ? definition.description.trim()
        : undefined;
    const intent =
      typeof definition.intent === "string" &&
      definition.intent.trim().length > 0
        ? definition.intent.trim()
        : undefined;
    definitionsByCommand.set(commandPath, {
      command: commandPath,
      action: normalizeExtensionCommandAction(commandPath, definition.action),
      description,
      intent,
      examples: normalizeExtensionCommandStringList(definition.examples),
      failure_hints: normalizeExtensionCommandStringList(
        definition.failure_hints,
      ),
      arguments: normalizeExtensionCommandArguments(definition.arguments),
      flags: [],
      source: {
        layer: definition.layer,
        name: definition.name,
        package: definition.source_package,
      },
    });
  }
  return definitionsByCommand;
}

function collectExtensionFlagsByCommand(
  flagRegistrations: RegisteredExtensionFlagDefinitions[],
): Map<string, Array<Record<string, unknown>>> {
  const flagsByCommand = new Map<string, Array<Record<string, unknown>>>();
  for (const registration of flagRegistrations) {
    const commandPath = normalizeExtensionCommandPath(
      registration.target_command,
    );
    if (commandPath.length === 0) {
      continue;
    }
    const existing = flagsByCommand.get(commandPath) ?? [];
    existing.push(...registration.flags);
    flagsByCommand.set(commandPath, existing);
  }
  return flagsByCommand;
}

function collectExtensionHelpCommandSet(
  commandHandlers: string[],
  definitionsByCommand: ReadonlyMap<string, ExtensionCommandHelpDescriptor>,
  flagsByCommand: ReadonlyMap<string, Array<Record<string, unknown>>>,
): Set<string> {
  const commandSet = new Set<string>();
  for (const commandPath of commandHandlers) {
    const normalized = normalizeExtensionCommandPath(commandPath);
    if (normalized.length > 0) {
      commandSet.add(normalized);
    }
  }
  for (const commandPath of definitionsByCommand.keys()) {
    commandSet.add(commandPath);
  }
  for (const commandPath of flagsByCommand.keys()) {
    commandSet.add(commandPath);
  }
  return commandSet;
}

/** Resolve the canonical nested command behind an auto-generated flattened
 * extension alias such as `csv-export export` -> `csv export`. Package authors
 * should not have to duplicate command metadata merely because a compatibility
 * alias was registered by the host package. */
function resolveFlattenedAliasDescriptor(
  commandPath: string,
  definitionsByCommand: ReadonlyMap<string, ExtensionCommandHelpDescriptor>,
  canonicalAliases: ReadonlyMap<string, string>,
): ExtensionCommandHelpDescriptor | undefined {
  const canonical = canonicalAliases.get(commandPath);
  return canonical ? definitionsByCommand.get(canonical) : undefined;
}

/** Implements collect extension command help descriptors for the public runtime surface of this module. */
export function collectExtensionCommandHelpDescriptors(
  commandHandlers: string[],
  commandDefinitions: RegisteredExtensionCommandDefinition[],
  flagRegistrations: RegisteredExtensionFlagDefinitions[],
  canonicalAliases: ReadonlyMap<string, string> = new Map(),
): Map<string, ExtensionCommandHelpDescriptor> {
  const definitionsByCommand =
    collectExtensionDefinitionsByCommand(commandDefinitions);
  const flagsByCommand = collectExtensionFlagsByCommand(flagRegistrations);
  const commandSet = collectExtensionHelpCommandSet(
    commandHandlers,
    definitionsByCommand,
    flagsByCommand,
  );
  const descriptors = new Map<string, ExtensionCommandHelpDescriptor>();
  const sortedCommands = [...commandSet].sort((left, right) =>
    left.localeCompare(right),
  );
  for (const commandPath of sortedCommands) {
    const definition =
      definitionsByCommand.get(commandPath) ??
      resolveFlattenedAliasDescriptor(
        commandPath,
        definitionsByCommand,
        canonicalAliases,
      );
    const flags =
      flagsByCommand.get(commandPath) ??
      (definition ? flagsByCommand.get(definition.command) : undefined) ??
      [];
    if (definition) {
      descriptors.set(commandPath, {
        ...definition,
        command: commandPath,
        flags,
      });
      continue;
    }
    descriptors.set(commandPath, {
      command: commandPath,
      action: normalizeExtensionCommandAction(commandPath, undefined),
      examples: [],
      failure_hints: [],
      arguments: [],
      flags,
    });
  }

  return descriptors;
}

function buildExtensionArgumentToken(
  argument: ExtensionCommandArgumentHelpDescriptor,
): string {
  const variadicSuffix = argument.variadic ? "..." : "";
  if (argument.required) {
    return `<${argument.name}${variadicSuffix}>`;
  }
  return `[${argument.name}${variadicSuffix}]`;
}

/** Implements apply dynamic extension arguments for the public runtime surface of this module. */
export function applyDynamicExtensionArguments(
  command: Command,
  descriptor: ExtensionCommandHelpDescriptor,
): void {
  for (const argument of descriptor.arguments) {
    command.argument(
      buildExtensionArgumentToken(argument),
      argument.description ?? "Extension argument.",
    );
  }
}

function normalizeDynamicExtensionOptionNames(
  definition: Record<string, unknown>,
): string[] | null {
  const visible = toOptionalBoolean(definition.visible);
  if (visible === false) {
    return null;
  }
  const longName = toNonEmptyFlagString(definition.long);
  const shortName = toNonEmptyFlagString(definition.short);
  const normalizedShort =
    shortName && shortName.startsWith("-") && !shortName.startsWith("--")
      ? shortName
      : null;
  const normalizedLong =
    longName && longName.startsWith("--") && longName.length > 2
      ? longName
      : null;
  const optionNames = [normalizedShort, normalizedLong].filter(
    (entry): entry is string => entry !== null,
  );
  return optionNames.length > 0 ? optionNames : null;
}

function formatDynamicExtensionOptionFlags(
  definition: Record<string, unknown>,
): string | null {
  const optionNames = normalizeDynamicExtensionOptionNames(definition);
  if (!optionNames) {
    return null;
  }
  const optionValueName = toNonEmptyFlagString(definition.value_name);
  const optionValueSuffix = optionValueName ? ` <${optionValueName}>` : "";
  return `${optionNames.join(", ")}${optionValueSuffix}`;
}

function formatDynamicExtensionParseOptionFlags(
  definition: Record<string, unknown>,
): string | null {
  const optionNames = normalizeDynamicExtensionOptionNames(definition);
  if (!optionNames) {
    return null;
  }
  const valueType =
    toNonEmptyFlagString(definition.value_type) ??
    toNonEmptyFlagString(definition.type);
  const valueName = toNonEmptyFlagString(definition.value_name);
  const requiresValue =
    valueType !== "boolean" &&
    (valueName !== null ||
      valueType !== null ||
      toOptionalBoolean(definition.required) === true);
  const valueSuffix = requiresValue ? ` <${valueName ?? "value"}>` : "";
  return `${optionNames.join(", ")}${valueSuffix}`;
}

function formatDynamicExtensionOptionDescription(
  definition: Record<string, unknown>,
): string {
  const description =
    toNonEmptyFlagString(definition.description) ??
    "Extension-provided option.";
  const markers: string[] = [];
  if (toOptionalBoolean(definition.required) === true) {
    markers.push("required");
  }
  if (toOptionalBoolean(definition.enabled) === false) {
    markers.push("disabled");
  }
  const markerSuffix = markers.length > 0 ? ` [${markers.join(", ")}]` : "";
  return `${description}${markerSuffix}`;
}

function commandAlreadyHasOption(
  command: Command,
  definition: Record<string, unknown>,
): boolean {
  const longName = toNonEmptyFlagString(definition.long);
  const shortName = toNonEmptyFlagString(definition.short);
  return command.options.some((option) => {
    const optionWithNames = option as { long?: string; short?: string };
    return (
      (longName !== null && optionWithNames.long === longName) ||
      (shortName !== null && optionWithNames.short === shortName)
    );
  });
}

/** Implements apply dynamic extension flag options for the public runtime surface of this module. */
export function applyDynamicExtensionFlagOptions(
  command: Command,
  definitions: Array<Record<string, unknown>>,
): void {
  for (const definition of definitions) {
    if (commandAlreadyHasOption(command, definition)) {
      continue;
    }
    const flags = formatDynamicExtensionParseOptionFlags(definition);
    if (!flags) {
      continue;
    }
    command.option(flags, formatDynamicExtensionOptionDescription(definition));
  }
}

/**
 * Builds the "Extension-provided flags" help block for only the definitions that
 * are NOT already rendered as real commander options on {@link command}. After
 * {@link applyDynamicExtensionFlagOptions} registers extension flags as first
 * class options, repeating them verbatim in an after-text block duplicated every
 * flag in `--help` output; this filters those already-listed flags out so the
 * block is emitted only when it carries flags the Options section does not.
 */
export function buildResidualDynamicExtensionFlagHelp(
  command: Command,
  definitions: Array<Record<string, unknown>>,
): string | null {
  return buildDynamicExtensionFlagHelp(
    definitions.filter(
      (definition) => !commandAlreadyHasOption(command, definition),
    ),
  );
}

function buildDynamicExtensionHelpOptionSummary(
  definition: Record<string, unknown>,
): HelpOptionSummary | null {
  const flags = formatDynamicExtensionOptionFlags(definition);
  if (!flags) {
    return null;
  }
  const longName = toNonEmptyFlagString(definition.long);
  const shortName = toNonEmptyFlagString(definition.short);
  const normalizedLong =
    longName && longName.startsWith("--") && longName.length > 2
      ? longName
      : null;
  const normalizedShort =
    shortName && shortName.startsWith("-") && !shortName.startsWith("--")
      ? shortName
      : null;
  const valueName = toNonEmptyFlagString(definition.value_name);
  const required = toOptionalBoolean(definition.required) === true;
  return {
    flags,
    long: normalizedLong,
    short: normalizedShort,
    description: formatDynamicExtensionOptionDescription(definition),
    takes_value: valueName !== null,
    value_required: valueName !== null,
    value_name: valueName,
    variadic: false,
    required,
    aliases: [],
    alias_for: null,
  };
}

/** Implements build dynamic extension help option summaries for the public runtime surface of this module. */
export function buildDynamicExtensionHelpOptionSummaries(
  descriptor: ExtensionCommandHelpDescriptor | undefined,
): HelpOptionSummary[] {
  if (!descriptor) {
    return [];
  }
  const summaries: HelpOptionSummary[] = [];
  const seen = new Set<string>();
  for (const definition of descriptor.flags) {
    const summary = buildDynamicExtensionHelpOptionSummary(definition);
    if (!summary || seen.has(summary.flags)) {
      continue;
    }
    seen.add(summary.flags);
    summaries.push(summary);
  }
  return summaries;
}

/** Implements merge help option summaries for the public runtime surface of this module. */
export function mergeHelpOptionSummaries(
  base: HelpOptionSummary[],
  extension: HelpOptionSummary[],
): HelpOptionSummary[] {
  if (extension.length === 0) {
    return base;
  }
  const merged = [...base];
  const seen = new Set(base.map((entry) => entry.flags));
  for (const entry of extension) {
    if (seen.has(entry.flags)) {
      continue;
    }
    seen.add(entry.flags);
    merged.push(entry);
  }
  return merged;
}

/** Implements build dynamic extension command metadata help for the public runtime surface of this module. */
export function buildDynamicExtensionCommandMetadataHelp(
  descriptor: ExtensionCommandHelpDescriptor,
): string | null {
  const lines: string[] = [];
  if (descriptor.intent) {
    lines.push(`Intent: ${descriptor.intent}`);
  }
  if (descriptor.action) {
    lines.push(`Action contract: ${descriptor.action}`);
  }
  if (descriptor.examples.length > 0) {
    lines.push("Examples:");
    for (const example of descriptor.examples) {
      lines.push(`  - ${example}`);
    }
  }
  if (descriptor.failure_hints.length > 0) {
    lines.push("Common failure hints:");
    for (const hint of descriptor.failure_hints) {
      lines.push(`  - ${hint}`);
    }
  }
  if (lines.length === 0) {
    return null;
  }
  return `\nExtension command metadata:\n  ${lines.join("\n  ")}`;
}

/** Implements command aliases for the public runtime surface of this module. */
export function commandAliases(command: Command): string[] {
  const commandRecord = command as unknown as {
    aliases?: () => string[];
    alias?: () => string | undefined;
    _aliases?: string[];
  };
  if (typeof commandRecord.aliases === "function") {
    return commandRecord
      .aliases()
      .map((value) => value.trim().toLowerCase())
      .filter((value) => value.length > 0);
  }
  if (typeof commandRecord.alias === "function") {
    const alias = commandRecord.alias();
    if (typeof alias === "string" && alias.trim().length > 0) {
      return [alias.trim().toLowerCase()];
    }
  }
  if (Array.isArray(commandRecord._aliases)) {
    return commandRecord._aliases
      .map((value) => value.trim().toLowerCase())
      .filter((value) => value.length > 0);
  }
  return [];
}

/** Implements find direct child command for the public runtime surface of this module. */
export function findDirectChildCommand(
  parent: Command,
  name: string,
): Command | null {
  const normalizedTarget = name.trim().toLowerCase();
  return (
    parent.commands.find((entry) => {
      if (entry.name().trim().toLowerCase() === normalizedTarget) {
        return true;
      }
      return commandAliases(entry).includes(normalizedTarget);
    }) ?? null
  );
}

/** Implements find command by path for the public runtime surface of this module. */
export function findCommandByPath(
  root: Command,
  pathParts: string[],
): Command | null {
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

/** Implements ensure command path for the public runtime surface of this module. */
export function ensureCommandPath(
  root: Command,
  pathParts: string[],
): Command | null {
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
      // Without a handler, commander routes bare-group help through the error
      // channel, which the root configureOutput intentionally swallows — the
      // group would exit 0 in silence. Render help on stdout instead so agents
      // always get subcommand discovery. A later terminal registration for the
      // same path replaces this handler via Command.action().
      created.action(() => {
        created.help();
      });
    } else {
      created.description("Extension-provided command path.");
    }
    current = created;
  }

  return current;
}
