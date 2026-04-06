import { TYPE_TO_FOLDER } from "../shared/constants.js";
import type { ExtensionRegistrationRegistry } from "../extensions/loader.js";
import type {
  ItemTypeCommandOptionPolicy,
  ItemTypeDefinition,
  ItemTypeOptionDefinition,
  PmSettings,
} from "../../types/index.js";
import { ITEM_TYPE_VALUES } from "../../types/index.js";

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

export type CommandOptionPolicyCommand = "create" | "update";

const CREATE_COMMAND_OPTION_KEYS = [
  "title",
  "description",
  "type",
  "status",
  "priority",
  "tags",
  "body",
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
  "author",
  "message",
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
  "author",
  "message",
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
  "comment",
  "note",
  "learning",
  "file",
  "test",
  "doc",
  "reminder",
  "event",
  "typeOption",
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

const CREATE_COMMAND_OPTION_FLAG_LABELS: Record<string, string> = {
  title: "--title",
  description: "--description",
  type: "--type",
  status: "--status",
  priority: "--priority",
  tags: "--tags",
  body: "--body",
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
  author: "--author",
  message: "--message",
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

export interface CommandOptionPolicyState {
  required: string[];
  hidden: string[];
  disabled: string[];
  errors: string[];
}

export interface ResolvedItemTypeDefinition {
  name: string;
  folder: string;
  aliases: string[];
  required_create_fields: string[];
  required_create_repeatables: string[];
  options: ItemTypeOptionDefinition[];
  command_option_policies: ItemTypeCommandOptionPolicy[];
}

export interface ItemTypeRegistry {
  types: string[];
  folders: string[];
  type_to_folder: Record<string, string>;
  by_type: Record<string, ResolvedItemTypeDefinition>;
  alias_to_type: Record<string, string>;
}

function normalizeList(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter((value) => value.length > 0))].sort((left, right) =>
    left.localeCompare(right),
  );
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

export function commandOptionFlagLabel(command: CommandOptionPolicyCommand, optionKey: string): string {
  const labels = command === "create" ? CREATE_COMMAND_OPTION_FLAG_LABELS : UPDATE_COMMAND_OPTION_FLAG_LABELS;
  return labels[optionKey] ?? `--${optionKey.replace(/([A-Z])/g, "-$1").toLowerCase()}`;
}

function toDefaultFolder(name: string): string {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (normalized.length === 0) {
    return "items";
  }
  return normalized.endsWith("s") ? normalized : `${normalized}s`;
}

function normalizeOptionDefinition(option: ItemTypeOptionDefinition): ItemTypeOptionDefinition | null {
  const key = option.key.trim();
  if (key.length === 0) {
    return null;
  }
  return {
    key,
    values: normalizeList(option.values),
    required: option.required === true ? true : undefined,
    aliases: (() => {
      const aliases = normalizeList(option.aliases);
      return aliases.length > 0 ? aliases : undefined;
    })(),
    description: (() => {
      const description = option.description?.trim();
      return description && description.length > 0 ? description : undefined;
    })(),
  };
}

function normalizeCommandOptionPolicyDefinition(
  policy: ItemTypeCommandOptionPolicy,
): ItemTypeCommandOptionPolicy | null {
  const normalizedCommand = policy.command.trim().toLowerCase();
  if (normalizedCommand !== "create" && normalizedCommand !== "update") {
    return null;
  }
  const option = policy.option.trim();
  if (option.length === 0) {
    return null;
  }
  return {
    command: normalizedCommand,
    option,
    required: policy.required,
    visible: policy.visible,
    enabled: policy.enabled,
  };
}

function normalizeTypeDefinition(definition: ItemTypeDefinition): ItemTypeDefinition | null {
  const name = definition.name.trim();
  if (name.length === 0) {
    return null;
  }
  const hasRequiredCreateFields = definition.required_create_fields !== undefined;
  const hasRequiredCreateRepeatables = definition.required_create_repeatables !== undefined;
  const hasOptions = definition.options !== undefined;
  const hasCommandOptionPolicies = definition.command_option_policies !== undefined;
  const folder = definition.folder?.trim();
  const options = (definition.options ?? [])
    .map((option) => normalizeOptionDefinition(option))
    .filter((option): option is ItemTypeOptionDefinition => option !== null)
    .sort((left, right) => left.key.localeCompare(right.key));
  const commandOptionPolicies = (() => {
    const dedupedByKey = new Map<string, ItemTypeCommandOptionPolicy>();
    for (const policy of definition.command_option_policies ?? []) {
      const normalized = normalizeCommandOptionPolicyDefinition(policy);
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
  })();
  return {
    name,
    folder: folder && folder.length > 0 ? folder : undefined,
    aliases: (() => {
      const aliases = normalizeList(definition.aliases);
      return aliases.length > 0 ? aliases : undefined;
    })(),
    required_create_fields: hasRequiredCreateFields ? normalizeList(definition.required_create_fields) : undefined,
    required_create_repeatables: hasRequiredCreateRepeatables
      ? normalizeList(definition.required_create_repeatables)
      : undefined,
    options: hasOptions ? options : undefined,
    command_option_policies: hasCommandOptionPolicies ? commandOptionPolicies : undefined,
  };
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
  const aliases = Array.isArray(record.aliases) ? record.aliases.filter((value): value is string => typeof value === "string") : undefined;
  const requiredCreateFields = Array.isArray(record.required_create_fields)
    ? record.required_create_fields.filter((value): value is string => typeof value === "string")
    : undefined;
  const requiredCreateRepeatables = Array.isArray(record.required_create_repeatables)
    ? record.required_create_repeatables.filter((value): value is string => typeof value === "string")
    : undefined;
  let options: ItemTypeOptionDefinition[] | undefined;
  if (Array.isArray(record.options)) {
    options = [];
    for (const entry of record.options) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        continue;
      }
      const optionRecord = entry as Record<string, unknown>;
      if (typeof optionRecord.key !== "string") {
        continue;
      }
      options.push({
        key: optionRecord.key,
        values: Array.isArray(optionRecord.values)
          ? optionRecord.values.filter((value): value is string => typeof value === "string")
          : [],
        required: optionRecord.required === undefined ? undefined : Boolean(optionRecord.required),
        aliases: Array.isArray(optionRecord.aliases)
          ? optionRecord.aliases.filter((value): value is string => typeof value === "string")
          : undefined,
        description: typeof optionRecord.description === "string" ? optionRecord.description : undefined,
      });
    }
  }
  let commandOptionPolicies: ItemTypeCommandOptionPolicy[] | undefined;
  if (Array.isArray(record.command_option_policies)) {
    commandOptionPolicies = [];
    for (const entry of record.command_option_policies) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        continue;
      }
      const policyRecord = entry as Record<string, unknown>;
      if (typeof policyRecord.command !== "string" || typeof policyRecord.option !== "string") {
        continue;
      }
      const normalizedCommand = policyRecord.command.trim().toLowerCase();
      if (normalizedCommand !== "create" && normalizedCommand !== "update") {
        continue;
      }
      commandOptionPolicies.push({
        command: normalizedCommand,
        option: policyRecord.option,
        required: policyRecord.required === undefined ? undefined : Boolean(policyRecord.required),
        visible: policyRecord.visible === undefined ? undefined : Boolean(policyRecord.visible),
        enabled: policyRecord.enabled === undefined ? undefined : Boolean(policyRecord.enabled),
      });
    }
  }
  return {
    name,
    folder,
    aliases,
    required_create_fields: requiredCreateFields,
    required_create_repeatables: requiredCreateRepeatables,
    options,
    command_option_policies: commandOptionPolicies,
  };
}

function applyTypeDefinitions(
  source: ItemTypeDefinition[],
  target: Map<string, ResolvedItemTypeDefinition>,
  preserveBuiltinDefaults: boolean,
): void {
  for (const rawDefinition of source) {
    const normalizedDefinition = normalizeTypeDefinition(rawDefinition);
    if (!normalizedDefinition) {
      continue;
    }
    const lowerName = normalizedDefinition.name.toLowerCase();
    const existing = target.get(lowerName);
    const keepName = existing?.name ?? normalizedDefinition.name;
    const folder = normalizedDefinition.folder ?? existing?.folder ?? toDefaultFolder(keepName);
    const aliases = normalizeList([...(existing?.aliases ?? []), ...(normalizedDefinition.aliases ?? [])]);
    const requiredCreateFields = normalizedDefinition.required_create_fields
      ? normalizeList(normalizedDefinition.required_create_fields)
      : existing?.required_create_fields ??
        (preserveBuiltinDefaults ? [...DEFAULT_REQUIRED_CREATE_FIELDS] : []);
    const requiredCreateRepeatables = normalizedDefinition.required_create_repeatables
      ? normalizeList(normalizedDefinition.required_create_repeatables)
      : existing?.required_create_repeatables ??
        (preserveBuiltinDefaults ? [...DEFAULT_REQUIRED_CREATE_REPEATABLES] : []);
    const options = normalizedDefinition.options
      ? normalizedDefinition.options
      : existing?.options
        ? [...existing.options]
        : [];
    const commandOptionPolicies = normalizedDefinition.command_option_policies
      ? normalizedDefinition.command_option_policies
      : existing?.command_option_policies
        ? [...existing.command_option_policies]
        : [];
    target.set(lowerName, {
      name: keepName,
      folder,
      aliases,
      required_create_fields: requiredCreateFields,
      required_create_repeatables: requiredCreateRepeatables,
      options,
      command_option_policies: commandOptionPolicies,
    });
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

  applyTypeDefinitions(settings.item_types?.definitions ?? [], byLowerName, false);
  applyTypeDefinitions(collectExtensionTypeDefinitions(extensionRegistrations), byLowerName, false);

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

export function resolveTypeName(rawType: string | undefined, registry: ItemTypeRegistry): string | undefined {
  if (rawType === undefined) {
    return undefined;
  }
  return registry.alias_to_type[rawType.trim().toLowerCase()];
}

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

export function resolveCommandOptionPolicyState(
  typeDefinition: ResolvedItemTypeDefinition,
  command: CommandOptionPolicyCommand,
  baseRequiredOptions: Iterable<string>,
): CommandOptionPolicyState {
  const errors: string[] = [];
  const required = new Set<string>();
  const hidden = new Set<string>();
  const disabled = new Set<string>();

  for (const rawBase of baseRequiredOptions) {
    const canonical = canonicalizeCommandOptionKey(command, rawBase);
    if (!canonical) {
      errors.push(
        `Unsupported base required option "${rawBase}" for command "${command}" on type "${typeDefinition.name}"`,
      );
      continue;
    }
    required.add(canonical);
  }

  for (const policy of typeDefinition.command_option_policies) {
    if (policy.command !== command) {
      continue;
    }
    const canonical = canonicalizeCommandOptionKey(command, policy.option);
    if (!canonical) {
      errors.push(
        `Unsupported command_option_policies option "${policy.option}" for command "${command}" on type "${typeDefinition.name}"`,
      );
      continue;
    }
    if (policy.required !== undefined) {
      if (policy.required) {
        required.add(canonical);
      } else {
        required.delete(canonical);
      }
    }
    if (policy.visible !== undefined) {
      if (policy.visible) {
        hidden.delete(canonical);
      } else {
        hidden.add(canonical);
      }
    }
    if (policy.enabled !== undefined) {
      if (policy.enabled) {
        disabled.delete(canonical);
      } else {
        disabled.add(canonical);
      }
    }
  }

  for (const option of required) {
    if (disabled.has(option)) {
      errors.push(
        `Option "${option}" cannot be both required and disabled for command "${command}" on type "${typeDefinition.name}"`,
      );
    }
  }

  return {
    required: [...required],
    hidden: [...hidden].sort((left, right) => left.localeCompare(right)),
    disabled: [...disabled].sort((left, right) => left.localeCompare(right)),
    errors,
  };
}

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
  const optionByAlias = new Map<string, ItemTypeOptionDefinition>();
  for (const option of typeDefinition.options) {
    optionByAlias.set(option.key.toLowerCase(), option);
    for (const alias of option.aliases ?? []) {
      optionByAlias.set(alias.toLowerCase(), option);
    }
  }

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
    const allowedValues = optionDefinition.values;
    let resolvedValue = trimmedValue;
    if (allowedValues.length > 0) {
      const valueLookup = new Map(allowedValues.map((value) => [value.toLowerCase(), value]));
      const canonical = valueLookup.get(trimmedValue.toLowerCase());
      if (!canonical) {
        errors.push(
          `Invalid value "${trimmedValue}" for type option "${optionDefinition.key}". Allowed: ${allowedValues.join(", ")}`,
        );
        continue;
      }
      resolvedValue = canonical;
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
