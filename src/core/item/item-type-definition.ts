/**
 * @module core/item/item-type-definition
 *
 * Defines item parsing, formatting, and lifecycle helpers for Item Type Definition.
 */
import type {
  ItemTypeCommandOptionPolicy,
  ItemTypeDefinition,
  ItemTypeOptionDefinition,
} from "../../types/index.js";

/**
 * Shared, pure normalization for {@link ItemTypeDefinition} objects, single-sourced
 * across the runtime item-type registry and settings persistence (pm-v798).
 *
 * The only genuine difference between the two callers is how a command-option
 * policy's `command` field is resolved:
 *  - the runtime registry consumes untrusted extension/file definitions, so it
 *    must trim+lowercase and reject anything that is not "create"/"update";
 *  - settings persistence operates on already-validated definitions, so it keeps
 *    the typed `command` value verbatim.
 *
 * That single difference is injected via {@link NormalizeItemTypeDefinitionOptions.resolvePolicyCommand};
 * everything else (name trim, optional folder, aliases, required_create_* fields,
 * options normalization, policy dedupe key + stable sort) is shared.
 */

/** Dedupe + sort a string list: trim, drop blanks, unique, locale-sorted. */
export function normalizeItemTypeStringList(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter((value) => value.length > 0))].sort(
    (left, right) => left.localeCompare(right),
  );
}

/** Normalize one type-option definition, or null when its key is blank. */
export function normalizeItemTypeOption(option: ItemTypeOptionDefinition): ItemTypeOptionDefinition | null {
  const key = option.key.trim();
  if (key.length === 0) {
    return null;
  }
  const aliases = normalizeItemTypeStringList(option.aliases);
  const description = option.description?.trim();
  return {
    key,
    values: normalizeItemTypeStringList(option.values),
    required: option.required === true ? true : undefined,
    aliases: aliases.length > 0 ? aliases : undefined,
    description: description && description.length > 0 ? description : undefined,
  };
}

/**
 * Resolves a raw policy `command` value to the canonical "create"/"update" type,
 * or null to drop the policy. Lets each layer plug in its own strictness.
 */
export type ResolvePolicyCommand = (command: string) => ItemTypeCommandOptionPolicy["command"] | null;

/**
 * Pass-through resolver used by settings persistence: the value is already typed
 * "create" | "update" by the settings validator, so it is kept verbatim.
 */
export const keepPolicyCommand: ResolvePolicyCommand = (command) =>
  command as ItemTypeCommandOptionPolicy["command"];

/**
 * Strict resolver used by the runtime registry: trims + lowercases and rejects
 * anything other than "create"/"update".
 */
export const strictPolicyCommand: ResolvePolicyCommand = (command) => {
  const normalized = command.trim().toLowerCase();
  return normalized === "create" || normalized === "update" ? normalized : null;
};

/** Normalize one command-option policy, or null when invalid (blank option / rejected command). */
export function normalizeItemTypeCommandOptionPolicy(
  policy: ItemTypeCommandOptionPolicy,
  resolvePolicyCommand: ResolvePolicyCommand,
): ItemTypeCommandOptionPolicy | null {
  const command = resolvePolicyCommand(policy.command);
  if (command === null) {
    return null;
  }
  const option = policy.option.trim();
  if (option.length === 0) {
    return null;
  }
  return {
    command,
    option,
    required: policy.required,
    visible: policy.visible,
    enabled: policy.enabled,
  };
}

/** Dedupe by `${command}:${option-lowercased}` and stable-sort by command then option. */
export function normalizeItemTypeCommandOptionPolicies(
  policies: ItemTypeCommandOptionPolicy[] | undefined,
  resolvePolicyCommand: ResolvePolicyCommand,
): ItemTypeCommandOptionPolicy[] {
  const dedupedByKey = new Map<string, ItemTypeCommandOptionPolicy>();
  for (const policy of policies ?? []) {
    const normalized = normalizeItemTypeCommandOptionPolicy(policy, resolvePolicyCommand);
    if (!normalized) {
      continue;
    }
    dedupedByKey.set(`${normalized.command}:${normalized.option.toLowerCase()}`, normalized);
  }
  return [...dedupedByKey.values()].sort((left, right) =>
    left.command === right.command
      ? left.option.localeCompare(right.option)
      : left.command.localeCompare(right.command),
  );
}

/**
 * Documents the normalize item type definition options payload exchanged by command, SDK, and package integrations.
 */
export interface NormalizeItemTypeDefinitionOptions {
  /** How to resolve a raw policy `command` value (defaults to {@link keepPolicyCommand}). */
  resolvePolicyCommand?: ResolvePolicyCommand;
}

function normalizeOptionalStringList(
  values: string[] | undefined,
  preservePresence: boolean,
): string[] | undefined {
  return preservePresence ? normalizeItemTypeStringList(values) : undefined;
}

function optionalNonEmptyString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

/**
 * Normalize a full {@link ItemTypeDefinition}, returning null when the name is blank.
 *
 * Optional collection fields (`folder`, `aliases`, `required_create_fields`,
 * `required_create_repeatables`, `options`, `command_option_policies`) are only
 * emitted when present on the input (presence-preserving) so the distinction
 * between "unset" and "set-but-empty" survives the round-trip.
 */
export function normalizeItemTypeDefinition(
  definition: ItemTypeDefinition,
  options: NormalizeItemTypeDefinitionOptions = {},
): ItemTypeDefinition | null {
  const resolvePolicyCommand = options.resolvePolicyCommand ?? keepPolicyCommand;
  const name = definition.name.trim();
  if (name.length === 0) {
    return null;
  }

  const hasRequiredCreateFields = definition.required_create_fields !== undefined;
  const hasRequiredCreateRepeatables = definition.required_create_repeatables !== undefined;
  const hasOptions = definition.options !== undefined;
  const hasCommandOptionPolicies = definition.command_option_policies !== undefined;

  const aliases = normalizeItemTypeStringList(definition.aliases);
  const normalizedOptions = (definition.options ?? [])
    .map((option) => normalizeItemTypeOption(option))
    .filter((option): option is ItemTypeOptionDefinition => option !== null)
    .sort((left, right) => left.key.localeCompare(right.key));
  const commandOptionPolicies = normalizeItemTypeCommandOptionPolicies(
    definition.command_option_policies,
    resolvePolicyCommand,
  );

  return {
    name,
    description: optionalNonEmptyString(definition.description),
    default_status: optionalNonEmptyString(definition.default_status),
    folder: optionalNonEmptyString(definition.folder),
    aliases: aliases.length > 0 ? aliases : undefined,
    required_create_fields: normalizeOptionalStringList(definition.required_create_fields, hasRequiredCreateFields),
    required_create_repeatables: normalizeOptionalStringList(
      definition.required_create_repeatables,
      hasRequiredCreateRepeatables,
    ),
    options: hasOptions ? normalizedOptions : undefined,
    command_option_policies: hasCommandOptionPolicies ? commandOptionPolicies : undefined,
  };
}
