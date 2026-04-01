import { TYPE_TO_FOLDER } from "../shared/constants.js";
import type { ExtensionRegistrationRegistry } from "../extensions/loader.js";
import type { ItemTypeDefinition, ItemTypeOptionDefinition, PmSettings } from "../../types/index.js";
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

export interface ResolvedItemTypeDefinition {
  name: string;
  folder: string;
  aliases: string[];
  required_create_fields: string[];
  required_create_repeatables: string[];
  options: ItemTypeOptionDefinition[];
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

function normalizeTypeDefinition(definition: ItemTypeDefinition): ItemTypeDefinition | null {
  const name = definition.name.trim();
  if (name.length === 0) {
    return null;
  }
  const hasRequiredCreateFields = definition.required_create_fields !== undefined;
  const hasRequiredCreateRepeatables = definition.required_create_repeatables !== undefined;
  const hasOptions = definition.options !== undefined;
  const folder = definition.folder?.trim();
  const options = (definition.options ?? [])
    .map((option) => normalizeOptionDefinition(option))
    .filter((option): option is ItemTypeOptionDefinition => option !== null)
    .sort((left, right) => left.key.localeCompare(right.key));
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
  return {
    name,
    folder,
    aliases,
    required_create_fields: requiredCreateFields,
    required_create_repeatables: requiredCreateRepeatables,
    options,
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
    target.set(lowerName, {
      name: keepName,
      folder,
      aliases,
      required_create_fields: requiredCreateFields,
      required_create_repeatables: requiredCreateRepeatables,
      options,
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
