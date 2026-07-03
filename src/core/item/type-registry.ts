/**
 * @module core/item/type-registry
 *
 * Defines item parsing, formatting, and lifecycle helpers for Type Registry.
 */
import { TYPE_TO_FOLDER } from "../shared/constants.js";
import type { ExtensionRegistrationRegistry } from "../extensions/loader.js";
import type {
  ItemTypeCommandOptionPolicy,
  ItemTypeDefinition,
  ItemTypeOptionDefinition,
  PmSettings,
} from "../../types/index.js";
import { ITEM_TYPE_VALUES } from "../../types/index.js";
import {
  normalizeItemTypeDefinition as normalizeSharedItemTypeDefinition,
  normalizeItemTypeStringList,
  strictPolicyCommand,
} from "./item-type-definition.js";

export const DEFAULT_REQUIRED_CREATE_FIELDS = [
  "title",
  "description",
  "status",
  "priority",
  "tags",
  "body",
  "deadline",
  "estimatedMinutes",
  "acceptanceCriteria",
  "author",
  "message",
  "assignee",
] as const;

export const DEFAULT_REQUIRED_CREATE_REPEATABLES = ["dep", "comment", "note", "learning", "file", "test", "doc"] as const;

/**
 * Restricts command option policy command values accepted by command, SDK, and storage contracts.
 */
export type CommandOptionPolicyCommand = "create" | "update";

// Keep aligned with cli/commands/shared-unset-fields.ts. This core registry
// cannot import CLI unset metadata without creating a core -> CLI dependency.
export const COMMON_MUTATION_COMMAND_OPTION_KEYS = [
  "deadline",
  "estimatedMinutes",
  "acceptanceCriteria",
  "definitionOfReady",
  "order",
  "goal",
  "objective",
  "value",
  "impact",
  "outcome",
  "whyNow",
  "assignee",
  "parent",
  "reviewer",
  "risk",
  "confidence",
  "sprint",
  "release",
  "blockedBy",
  "blockedReason",
  "unblockNote",
  "reporter",
  "severity",
  "environment",
  "reproSteps",
  "resolution",
  "expectedResult",
  "actualResult",
  "affectedVersion",
  "fixedVersion",
  "component",
  "regression",
  "customerImpact",
] as const;

const CREATE_COMMAND_OPTION_KEYS = [
  "title",
  "description",
  "type",
  "status",
  "priority",
  "tags",
  "body",
  ...COMMON_MUTATION_COMMAND_OPTION_KEYS,
  "author",
  "message",
  "dep",
  "comment",
  "note",
  "learning",
  "file",
  "test",
  "doc",
  "reminder",
  "event",
  "typeOption",
  "field",
] as const;

const UPDATE_COMMAND_OPTION_KEYS = [
  "title",
  "description",
  "body",
  "status",
  "closeReason",
  "priority",
  "type",
  "tags",
  ...COMMON_MUTATION_COMMAND_OPTION_KEYS,
  "author",
  "message",
  "comment",
  "note",
  "learning",
  "file",
  "test",
  "doc",
  "reminder",
  "event",
  "typeOption",
  "field",
  "allowAuditUpdate",
  "force",
] as const;

const SHARED_COMMAND_OPTION_ALIASES: Record<string, string> = {
  "close-reason": "closeReason",
  close_reason: "closeReason",
  "estimated-minutes": "estimatedMinutes",
  estimated_minutes: "estimatedMinutes",
  estimate: "estimatedMinutes",
  "acceptance-criteria": "acceptanceCriteria",
  acceptance_criteria: "acceptanceCriteria",
  ac: "acceptanceCriteria",
  "definition-of-ready": "definitionOfReady",
  definition_of_ready: "definitionOfReady",
  rank: "order",
  "why-now": "whyNow",
  why_now: "whyNow",
  "blocked-by": "blockedBy",
  blocked_by: "blockedBy",
  "blocked-reason": "blockedReason",
  blocked_reason: "blockedReason",
  "unblock-note": "unblockNote",
  unblock_note: "unblockNote",
  "repro-steps": "reproSteps",
  repro_steps: "reproSteps",
  "expected-result": "expectedResult",
  expected_result: "expectedResult",
  "actual-result": "actualResult",
  actual_result: "actualResult",
  "affected-version": "affectedVersion",
  affected_version: "affectedVersion",
  "fixed-version": "fixedVersion",
  fixed_version: "fixedVersion",
  "customer-impact": "customerImpact",
  customer_impact: "customerImpact",
  "type-option": "typeOption",
  type_option: "typeOption",
  type_options: "typeOption",
};

const CREATE_COMMAND_OPTION_ALIASES: Record<string, string> = {
  ...SHARED_COMMAND_OPTION_ALIASES,
};

const UPDATE_COMMAND_OPTION_ALIASES: Record<string, string> = {
  ...SHARED_COMMAND_OPTION_ALIASES,
  "allow-audit-update": "allowAuditUpdate",
  allow_audit_update: "allowAuditUpdate",
};

const COMMON_MUTATION_COMMAND_OPTION_FLAG_LABELS: Record<(typeof COMMON_MUTATION_COMMAND_OPTION_KEYS)[number], string> = {
  deadline: "--deadline",
  estimatedMinutes: "--estimate/--estimated-minutes",
  acceptanceCriteria: "--acceptance-criteria/--ac",
  definitionOfReady: "--definition-of-ready",
  order: "--order/--rank",
  goal: "--goal",
  objective: "--objective",
  value: "--value",
  impact: "--impact",
  outcome: "--outcome",
  whyNow: "--why-now",
  assignee: "--assignee",
  parent: "--parent",
  reviewer: "--reviewer",
  risk: "--risk",
  confidence: "--confidence",
  sprint: "--sprint",
  release: "--release",
  blockedBy: "--blocked-by",
  blockedReason: "--blocked-reason",
  unblockNote: "--unblock-note",
  reporter: "--reporter",
  severity: "--severity",
  environment: "--environment",
  reproSteps: "--repro-steps",
  resolution: "--resolution",
  expectedResult: "--expected-result",
  actualResult: "--actual-result",
  affectedVersion: "--affected-version",
  fixedVersion: "--fixed-version",
  component: "--component",
  regression: "--regression",
  customerImpact: "--customer-impact",
};

const CREATE_COMMAND_OPTION_FLAG_LABELS: Record<string, string> = {
  title: "--title",
  description: "--description",
  type: "--type",
  status: "--status",
  priority: "--priority",
  tags: "--tags",
  body: "--body",
  ...COMMON_MUTATION_COMMAND_OPTION_FLAG_LABELS,
  author: "--author",
  message: "--message",
  dep: "--dep",
  comment: "--comment",
  note: "--note",
  learning: "--learning",
  file: "--file",
  test: "--test",
  doc: "--doc",
  reminder: "--reminder",
  event: "--event",
  typeOption: "--type-option",
};

const UPDATE_COMMAND_OPTION_FLAG_LABELS: Record<string, string> = {
  title: "--title",
  description: "--description",
  body: "--body",
  status: "--status",
  closeReason: "--close-reason",
  priority: "--priority",
  type: "--type",
  tags: "--tags",
  ...COMMON_MUTATION_COMMAND_OPTION_FLAG_LABELS,
  comment: "--comment",
  note: "--note",
  learning: "--learning",
  file: "--file",
  test: "--test",
  doc: "--doc",
  reminder: "--reminder",
  event: "--event",
  typeOption: "--type-option",
  allowAuditUpdate: "--allow-audit-update",
  author: "--author",
  message: "--message",
  force: "--force",
};

/**
 * Documents the command option policy state payload exchanged by command, SDK, and package integrations.
 */
export interface CommandOptionPolicyState {
  required: string[];
  hidden: string[];
  disabled: string[];
  errors: string[];
}

/**
 * Documents the resolved item type definition payload exchanged by command, SDK, and package integrations.
 */
export interface ResolvedItemTypeDefinition {
  name: string;
  /** Optional human description carried from the type definition. */
  description?: string;
  folder: string;
  aliases: string[];
  /** Optional per-type status applied at create time when `--status` is omitted. */
  default_status?: string;
  required_create_fields: string[];
  required_create_repeatables: string[];
  options: ItemTypeOptionDefinition[];
  command_option_policies: ItemTypeCommandOptionPolicy[];
}

/**
 * Documents the item type registry payload exchanged by command, SDK, and package integrations.
 */
export interface ItemTypeRegistry {
  types: string[];
  folders: string[];
  type_to_folder: Record<string, string>;
  by_type: Record<string, ResolvedItemTypeDefinition>;
  alias_to_type: Record<string, string>;
}

function normalizeCommandOptionToken(value: string): string {
  return value.trim().replace(/^--+/, "").toLowerCase();
}

function commandOptionKeys(command: CommandOptionPolicyCommand): readonly string[] {
  return command === "create" ? CREATE_COMMAND_OPTION_KEYS : UPDATE_COMMAND_OPTION_KEYS;
}

function commandOptionAliases(command: CommandOptionPolicyCommand): Record<string, string> {
  return command === "create" ? CREATE_COMMAND_OPTION_ALIASES : UPDATE_COMMAND_OPTION_ALIASES;
}

/**
 * Implements canonicalize command option key for the public runtime surface of this module.
 */
export function canonicalizeCommandOptionKey(
  command: CommandOptionPolicyCommand,
  rawOption: string,
): string | undefined {
  const normalizedToken = normalizeCommandOptionToken(rawOption);
  if (normalizedToken.length === 0) {
    return undefined;
  }
  const aliased = commandOptionAliases(command)[normalizedToken];
  if (aliased) {
    return aliased;
  }
  return commandOptionKeys(command).find((candidate) => candidate.toLowerCase() === normalizedToken);
}

/**
 * Implements command option flag label for the public runtime surface of this module.
 */
export function commandOptionFlagLabel(command: CommandOptionPolicyCommand, optionKey: string): string {
  const labels = command === "create" ? CREATE_COMMAND_OPTION_FLAG_LABELS : UPDATE_COMMAND_OPTION_FLAG_LABELS;
  return labels[optionKey] ?? `--${optionKey.replace(/([A-Z])/g, "-$1").toLowerCase()}`;
}

/**
 * Implements to default folder for the public runtime surface of this module.
 */
export function toDefaultFolder(name: string): string {
  const normalized = toSlugToken(name);
  if (normalized.length === 0) {
    return "items";
  }
  return normalized.endsWith("s") ? normalized : `${normalized}s`;
}

function toSlugToken(value: string): string {
  const trimmed = value.trim().toLowerCase();
  let slug = "";
  let pendingDash = false;
  for (const character of trimmed) {
    const code = character.charCodeAt(0);
    const isAlpha = code >= 97 && code <= 122;
    const isDigit = code >= 48 && code <= 57;
    if (isAlpha || isDigit) {
      if (pendingDash && slug.length > 0) {
        slug += "-";
      }
      slug += character;
      pendingDash = false;
      continue;
    }
    if (slug.length > 0) {
      pendingDash = true;
    }
  }
  return slug;
}

// Runtime registry consumes untrusted extension/file definitions, so it uses the
// strict policy-command resolver (trim + lowercase, reject non-create/update). All
// other normalization is single-sourced from ./item-type-definition.ts (pm-v798).
function normalizeTypeDefinition(definition: ItemTypeDefinition): ItemTypeDefinition | null {
  return normalizeSharedItemTypeDefinition(definition, { resolvePolicyCommand: strictPolicyCommand });
}

function readStringArray(record: Record<string, unknown>, key: string): string[] | undefined {
  const value = record[key];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : undefined;
}

function coerceOptionDefinitionFromUnknown(raw: unknown): ItemTypeOptionDefinition | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  const optionRecord = raw as Record<string, unknown>;
  if (typeof optionRecord.key !== "string") {
    return null;
  }
  return {
    key: optionRecord.key,
    values: readStringArray(optionRecord, "values") ?? [],
    required: optionRecord.required === undefined ? undefined : Boolean(optionRecord.required),
    aliases: readStringArray(optionRecord, "aliases"),
    description: typeof optionRecord.description === "string" ? optionRecord.description : undefined,
  };
}

function coerceCommandOptionPolicyFromUnknown(raw: unknown): ItemTypeCommandOptionPolicy | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  const policyRecord = raw as Record<string, unknown>;
  if (typeof policyRecord.command !== "string" || typeof policyRecord.option !== "string") {
    return null;
  }
  const normalizedCommand = policyRecord.command.trim().toLowerCase();
  if (normalizedCommand !== "create" && normalizedCommand !== "update") {
    return null;
  }
  return {
    command: normalizedCommand,
    option: policyRecord.option,
    required: policyRecord.required === undefined ? undefined : Boolean(policyRecord.required),
    visible: policyRecord.visible === undefined ? undefined : Boolean(policyRecord.visible),
    enabled: policyRecord.enabled === undefined ? undefined : Boolean(policyRecord.enabled),
  };
}

function coerceOptionDefinitionsFromRecord(record: Record<string, unknown>): ItemTypeOptionDefinition[] | undefined {
  if (!Array.isArray(record.options)) {
    return undefined;
  }
  return record.options
    .map((entry) => coerceOptionDefinitionFromUnknown(entry))
    .filter((entry): entry is ItemTypeOptionDefinition => entry !== null);
}

function coerceCommandOptionPoliciesFromRecord(record: Record<string, unknown>): ItemTypeCommandOptionPolicy[] | undefined {
  if (!Array.isArray(record.command_option_policies)) {
    return undefined;
  }
  return record.command_option_policies
    .map((entry) => coerceCommandOptionPolicyFromUnknown(entry))
    .filter((entry): entry is ItemTypeCommandOptionPolicy => entry !== null);
}

function coerceTypeDefinitionFromUnknown(raw: unknown): ItemTypeDefinition | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name : "";
  if (name.trim().length === 0) {
    return null;
  }
  const folder = typeof record.folder === "string" ? record.folder : undefined;
  const description = typeof record.description === "string" ? record.description : undefined;
  const defaultStatus = typeof record.default_status === "string" ? record.default_status : undefined;
  return {
    name,
    description,
    default_status: defaultStatus,
    folder,
    aliases: readStringArray(record, "aliases"),
    required_create_fields: readStringArray(record, "required_create_fields"),
    required_create_repeatables: readStringArray(record, "required_create_repeatables"),
    options: coerceOptionDefinitionsFromRecord(record),
    command_option_policies: coerceCommandOptionPoliciesFromRecord(record),
  };
}

function resolveDefinitionRequiredCreateFields(
  normalizedDefinition: ItemTypeDefinition,
  existing: ResolvedItemTypeDefinition | undefined,
): string[] {
  return normalizedDefinition.required_create_fields
    ? normalizeItemTypeStringList(normalizedDefinition.required_create_fields)
    : existing?.required_create_fields ?? [];
}

function resolveDefinitionRequiredCreateRepeatables(
  normalizedDefinition: ItemTypeDefinition,
  existing: ResolvedItemTypeDefinition | undefined,
): string[] {
  return normalizedDefinition.required_create_repeatables
    ? normalizeItemTypeStringList(normalizedDefinition.required_create_repeatables)
    : existing?.required_create_repeatables ?? [];
}

function resolveDefinitionOptions(
  normalizedDefinition: ItemTypeDefinition,
  existing: ResolvedItemTypeDefinition | undefined,
): ItemTypeOptionDefinition[] {
  return normalizedDefinition.options ? normalizedDefinition.options : existing?.options ? [...existing.options] : [];
}

function resolveDefinitionCommandOptionPolicies(
  normalizedDefinition: ItemTypeDefinition,
  existing: ResolvedItemTypeDefinition | undefined,
): ItemTypeCommandOptionPolicy[] {
  return normalizedDefinition.command_option_policies
    ? normalizedDefinition.command_option_policies
    : existing?.command_option_policies
      ? [...existing.command_option_policies]
      : [];
}

function buildResolvedTypeDefinition(
  normalizedDefinition: ItemTypeDefinition,
  existing: ResolvedItemTypeDefinition | undefined,
): ResolvedItemTypeDefinition {
  const keepName = existing?.name ?? normalizedDefinition.name;
  const description = normalizedDefinition.description ?? existing?.description;
  const defaultStatus = normalizedDefinition.default_status ?? existing?.default_status;
  const resolvedDefinition: ResolvedItemTypeDefinition = {
    name: keepName,
    folder: normalizedDefinition.folder ?? existing?.folder ?? toDefaultFolder(keepName),
    aliases: normalizeItemTypeStringList([...(existing?.aliases ?? []), ...(normalizedDefinition.aliases ?? [])]),
    required_create_fields: resolveDefinitionRequiredCreateFields(normalizedDefinition, existing),
    required_create_repeatables: resolveDefinitionRequiredCreateRepeatables(normalizedDefinition, existing),
    options: resolveDefinitionOptions(normalizedDefinition, existing),
    command_option_policies: resolveDefinitionCommandOptionPolicies(normalizedDefinition, existing),
  };
  if (description) {
    resolvedDefinition.description = description;
  }
  if (defaultStatus) {
    resolvedDefinition.default_status = defaultStatus;
  }
  return resolvedDefinition;
}

function applyTypeDefinitions(
  source: ItemTypeDefinition[],
  target: Map<string, ResolvedItemTypeDefinition>,
): void {
  for (const rawDefinition of source) {
    const normalizedDefinition = normalizeTypeDefinition(rawDefinition);
    if (!normalizedDefinition) {
      continue;
    }
    const lowerName = normalizedDefinition.name.toLowerCase();
    const existing = target.get(lowerName);
    target.set(lowerName, buildResolvedTypeDefinition(normalizedDefinition, existing));
  }
}

function collectExtensionTypeDefinitions(registrations: ExtensionRegistrationRegistry | null | undefined): ItemTypeDefinition[] {
  if (!registrations) {
    return [];
  }
  const definitions: ItemTypeDefinition[] = [];
  for (const registration of registrations.item_types ?? []) {
    const typeDefinitionsRaw = (registration as { types?: unknown[] }).types;
    if (!Array.isArray(typeDefinitionsRaw)) {
      continue;
    }
    for (const rawDefinition of typeDefinitionsRaw) {
      const normalized = coerceTypeDefinitionFromUnknown(rawDefinition);
      if (normalized) {
        definitions.push(normalized);
      }
    }
  }
  return definitions;
}

/**
 * Implements resolve item type registry for the public runtime surface of this module.
 */
export function resolveItemTypeRegistry(
  settings: PmSettings,
  extensionRegistrations: ExtensionRegistrationRegistry | null | undefined = null,
): ItemTypeRegistry {
  const byLowerName = new Map<string, ResolvedItemTypeDefinition>();
  for (const builtin of ITEM_TYPE_VALUES) {
    byLowerName.set(builtin.toLowerCase(), {
      name: builtin,
      folder: TYPE_TO_FOLDER[builtin],
      aliases: [],
      required_create_fields: [...DEFAULT_REQUIRED_CREATE_FIELDS],
      required_create_repeatables: [...DEFAULT_REQUIRED_CREATE_REPEATABLES],
      options: [],
      command_option_policies: [],
    });
  }

  applyTypeDefinitions(settings.item_types?.definitions ?? [], byLowerName);
  applyTypeDefinitions(collectExtensionTypeDefinitions(extensionRegistrations), byLowerName);

  const definitions = [...byLowerName.values()].sort((left, right) => left.name.localeCompare(right.name));
  const byType: Record<string, ResolvedItemTypeDefinition> = {};
  const aliasToType: Record<string, string> = {};
  const typeToFolder: Record<string, string> = {};
  for (const definition of definitions) {
    byType[definition.name] = definition;
    typeToFolder[definition.name] = definition.folder;
    aliasToType[definition.name.toLowerCase()] = definition.name;
    for (const alias of definition.aliases) {
      aliasToType[alias.toLowerCase()] = definition.name;
    }
  }
  const folders = [...new Set(definitions.map((definition) => definition.folder))].sort((left, right) => left.localeCompare(right));
  return {
    types: definitions.map((definition) => definition.name),
    folders,
    type_to_folder: typeToFolder,
    by_type: byType,
    alias_to_type: aliasToType,
  };
}

/**
 * Implements resolve type name for the public runtime surface of this module.
 */
export function resolveTypeName(rawType: string | undefined, registry: ItemTypeRegistry): string | undefined {
  if (rawType === undefined) {
    return undefined;
  }
  return registry.alias_to_type[rawType.trim().toLowerCase()];
}

/**
 * Implements resolve type definition for the public runtime surface of this module.
 */
export function resolveTypeDefinition(
  typeName: string | undefined,
  registry: ItemTypeRegistry,
): ResolvedItemTypeDefinition | undefined {
  const resolvedName = resolveTypeName(typeName, registry);
  if (!resolvedName) {
    return undefined;
  }
  return registry.by_type[resolvedName];
}

function applyBaseRequiredCommandOptions(
  state: Pick<CommandOptionPolicyState, "errors"> & { required: Set<string> },
  typeDefinition: ResolvedItemTypeDefinition,
  command: CommandOptionPolicyCommand,
  baseRequiredOptions: Iterable<string>,
): void {
  for (const rawBase of baseRequiredOptions) {
    const canonical = canonicalizeCommandOptionKey(command, rawBase);
    if (canonical) {
      state.required.add(canonical);
      continue;
    }
    state.errors.push(
      `Unsupported base required option "${rawBase}" for command "${command}" on type "${typeDefinition.name}"`,
    );
  }
}

function applyBooleanPolicySet(target: Set<string>, option: string, enabled: boolean): void {
  if (enabled) {
    target.add(option);
    return;
  }
  target.delete(option);
}

function applyCommandOptionPolicy(
  state: Omit<CommandOptionPolicyState, "required" | "hidden" | "disabled"> & {
    required: Set<string>;
    hidden: Set<string>;
    disabled: Set<string>;
  },
  typeDefinition: ResolvedItemTypeDefinition,
  command: CommandOptionPolicyCommand,
  policy: ItemTypeCommandOptionPolicy,
): void {
  const canonical = canonicalizeCommandOptionKey(command, policy.option);
  if (!canonical) {
    state.errors.push(
      `Unsupported command_option_policies option "${policy.option}" for command "${command}" on type "${typeDefinition.name}"`,
    );
    return;
  }
  if (policy.required !== undefined) {
    applyBooleanPolicySet(state.required, canonical, policy.required);
  }
  if (policy.visible !== undefined) {
    applyBooleanPolicySet(state.hidden, canonical, !policy.visible);
  }
  if (policy.enabled !== undefined) {
    applyBooleanPolicySet(state.disabled, canonical, !policy.enabled);
  }
}

function applyCommandOptionPolicies(
  state: Omit<CommandOptionPolicyState, "required" | "hidden" | "disabled"> & {
    required: Set<string>;
    hidden: Set<string>;
    disabled: Set<string>;
  },
  typeDefinition: ResolvedItemTypeDefinition,
  command: CommandOptionPolicyCommand,
): void {
  for (const policy of typeDefinition.command_option_policies) {
    if (policy.command === command) {
      applyCommandOptionPolicy(state, typeDefinition, command, policy);
    }
  }
}

function appendRequiredDisabledPolicyErrors(
  state: Pick<CommandOptionPolicyState, "errors"> & {
    required: Set<string>;
    disabled: Set<string>;
  },
  typeDefinition: ResolvedItemTypeDefinition,
  command: CommandOptionPolicyCommand,
): void {
  for (const option of state.required) {
    if (state.disabled.has(option)) {
      state.errors.push(
        `Option "${option}" cannot be both required and disabled for command "${command}" on type "${typeDefinition.name}"`,
      );
    }
  }
}

/**
 * Implements resolve command option policy state for the public runtime surface of this module.
 */
export function resolveCommandOptionPolicyState(
  typeDefinition: ResolvedItemTypeDefinition,
  command: CommandOptionPolicyCommand,
  baseRequiredOptions: Iterable<string>,
): CommandOptionPolicyState {
  const errors: string[] = [];
  const required = new Set<string>();
  const hidden = new Set<string>();
  const disabled = new Set<string>();
  const state = { required, hidden, disabled, errors };

  applyBaseRequiredCommandOptions(state, typeDefinition, command, baseRequiredOptions);
  applyCommandOptionPolicies(state, typeDefinition, command);
  appendRequiredDisabledPolicyErrors(state, typeDefinition, command);

  return {
    required: [...required],
    hidden: [...hidden].sort((left, right) => left.localeCompare(right)),
    disabled: [...disabled].sort((left, right) => left.localeCompare(right)),
    errors,
  };
}

function buildTypeOptionAliasMap(typeDefinition: ResolvedItemTypeDefinition): Map<string, ItemTypeOptionDefinition> {
  const optionByAlias = new Map<string, ItemTypeOptionDefinition>();
  for (const option of typeDefinition.options) {
    optionByAlias.set(option.key.toLowerCase(), option);
    for (const alias of option.aliases ?? []) {
      optionByAlias.set(alias.toLowerCase(), option);
    }
  }
  return optionByAlias;
}

function resolveTypeOptionValue(
  optionDefinition: ItemTypeOptionDefinition,
  trimmedValue: string,
  errors: string[],
): string | undefined {
  const allowedValues = optionDefinition.values;
  if (allowedValues.length === 0) {
    return trimmedValue;
  }
  const valueLookup = new Map(allowedValues.map((value) => [value.toLowerCase(), value]));
  const canonical = valueLookup.get(trimmedValue.toLowerCase());
  if (!canonical) {
    errors.push(`Invalid value "${trimmedValue}" for type option "${optionDefinition.key}". Allowed: ${allowedValues.join(", ")}`);
    return undefined;
  }
  return canonical;
}

/**
 * Implements validate type options for the public runtime surface of this module.
 */
export function validateTypeOptions(
  typeName: string,
  rawTypeOptions: Record<string, string> | undefined,
  registry: ItemTypeRegistry,
): { normalized: Record<string, string> | undefined; errors: string[] } {
  const typeDefinition = resolveTypeDefinition(typeName, registry);
  if (!typeDefinition) {
    return {
      normalized: undefined,
      errors: [`Unknown type "${typeName}"`],
    };
  }
  const errors: string[] = [];
  const optionByAlias = buildTypeOptionAliasMap(typeDefinition);

  const normalized: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(rawTypeOptions ?? {})) {
    const trimmedKey = rawKey.trim();
    const trimmedValue = rawValue.trim();
    if (trimmedKey.length === 0) {
      errors.push("type option keys must not be empty");
      continue;
    }
    if (trimmedValue.length === 0) {
      errors.push(`type option "${trimmedKey}" must not be empty`);
      continue;
    }
    const optionDefinition = optionByAlias.get(trimmedKey.toLowerCase());
    if (!optionDefinition) {
      const allowed = typeDefinition.options.map((option) => option.key).join(", ");
      errors.push(
        typeDefinition.options.length > 0
          ? `Unknown type option "${trimmedKey}" for type "${typeDefinition.name}". Allowed: ${allowed}`
          : `Type "${typeDefinition.name}" does not define any configurable type options`,
      );
      continue;
    }
    const resolvedValue = resolveTypeOptionValue(optionDefinition, trimmedValue, errors);
    if (resolvedValue === undefined) {
      continue;
    }
    normalized[optionDefinition.key] = resolvedValue;
  }

  for (const option of typeDefinition.options) {
    if (option.required && !(option.key in normalized)) {
      errors.push(`Missing required type option "${option.key}" for type "${typeDefinition.name}"`);
    }
  }

  const sortedKeys = Object.keys(normalized).sort((left, right) => left.localeCompare(right));
  if (sortedKeys.length === 0) {
    return {
      normalized: undefined,
      errors,
    };
  }
  return {
    normalized: Object.fromEntries(sortedKeys.map((key) => [key, normalized[key]])),
    errors,
  };
}
