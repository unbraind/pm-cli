import { z } from "zod";
import { runActiveOnReadHooks, runActiveOnWriteHooks } from "../extensions/index.js";
import { SETTINGS_DEFAULTS } from "../shared/constants.js";
import { readFileIfExists, writeFileAtomic } from "../fs/fs-utils.js";
import { getSettingsPath } from "./paths.js";
import { orderObject } from "../shared/serialization.js";
import type { ItemTypeDefinition, ItemTypeOptionDefinition, PmSettings } from "../../types/index.js";

const itemTypeOptionSchema = z.object({
  key: z.string(),
  values: z.array(z.string()),
  required: z.boolean().optional(),
  aliases: z.array(z.string()).optional(),
  description: z.string().optional(),
});

const itemTypeDefinitionSchema = z.object({
  name: z.string(),
  folder: z.string().optional(),
  aliases: z.array(z.string()).optional(),
  required_create_fields: z.array(z.string()).optional(),
  required_create_repeatables: z.array(z.string()).optional(),
  options: z.array(itemTypeOptionSchema).optional(),
});

const settingsSchema = z.object({
  version: z.number().int(),
  id_prefix: z.string(),
  author_default: z.string(),
  item_format: z.union([z.literal("toon"), z.literal("json_markdown")]).optional(),
  locks: z.object({
    ttl_seconds: z.number().int(),
  }),
  output: z.object({
    default_format: z.union([z.literal("toon"), z.literal("json")]),
  }),
  workflow: z
    .object({
      definition_of_done: z.array(z.string()),
    })
    .optional(),
  item_types: z
    .object({
      definitions: z.array(itemTypeDefinitionSchema),
    })
    .optional(),
  extensions: z.object({
    enabled: z.array(z.string()),
    disabled: z.array(z.string()),
  }),
  search: z.object({
    score_threshold: z.number(),
    hybrid_semantic_weight: z.number().optional(),
    max_results: z.number().int(),
    embedding_model: z.string(),
    embedding_batch_size: z.number().int(),
    scanner_max_batch_retries: z.number().int(),
  }),
  providers: z.object({
    openai: z.object({
      base_url: z.string(),
      api_key: z.string(),
      model: z.string(),
    }),
    ollama: z.object({
      base_url: z.string(),
      model: z.string(),
    }),
  }),
  vector_store: z.object({
    qdrant: z.object({
      url: z.string(),
      api_key: z.string(),
    }),
    lancedb: z.object({
      path: z.string(),
    }),
  }),
});

const SETTINGS_WRITE_OP = "settings:write";

export interface SettingsReadMetadata {
  has_explicit_item_format: boolean;
}

export interface SettingsReadResult {
  settings: PmSettings;
  metadata: SettingsReadMetadata;
}

function cloneDefaults(): PmSettings {
  return structuredClone(SETTINGS_DEFAULTS);
}

function hasExplicitItemFormat(raw: unknown): boolean {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return false;
  }
  const itemFormat = (raw as Record<string, unknown>).item_format;
  return itemFormat === "toon" || itemFormat === "json_markdown";
}

function normalizeStringList(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter((value) => value.length > 0))].sort((left, right) =>
    left.localeCompare(right),
  );
}

function normalizeItemTypeOptionDefinition(option: ItemTypeOptionDefinition): ItemTypeOptionDefinition | null {
  const key = option.key.trim();
  if (key.length === 0) {
    return null;
  }
  const values = normalizeStringList(option.values);
  const aliases = normalizeStringList(option.aliases);
  const description = option.description?.trim();
  return {
    key,
    values,
    required: option.required === true ? true : undefined,
    aliases: aliases.length > 0 ? aliases : undefined,
    description: description && description.length > 0 ? description : undefined,
  };
}

function normalizeItemTypeDefinition(definition: ItemTypeDefinition): ItemTypeDefinition | null {
  const name = definition.name.trim();
  if (name.length === 0) {
    return null;
  }
  const hasRequiredCreateFields = definition.required_create_fields !== undefined;
  const hasRequiredCreateRepeatables = definition.required_create_repeatables !== undefined;
  const hasOptions = definition.options !== undefined;
  const folder = definition.folder?.trim();
  const aliases = normalizeStringList(definition.aliases);
  const requiredCreateFields = normalizeStringList(definition.required_create_fields);
  const requiredCreateRepeatables = normalizeStringList(definition.required_create_repeatables);
  const options = (definition.options ?? [])
    .map((option) => normalizeItemTypeOptionDefinition(option))
    .filter((option): option is ItemTypeOptionDefinition => option !== null)
    .sort((left, right) => left.key.localeCompare(right.key));
  return {
    name,
    folder: folder && folder.length > 0 ? folder : undefined,
    aliases: aliases.length > 0 ? aliases : undefined,
    required_create_fields: hasRequiredCreateFields ? requiredCreateFields : undefined,
    required_create_repeatables: hasRequiredCreateRepeatables ? requiredCreateRepeatables : undefined,
    options: hasOptions ? options : undefined,
  };
}

function normalizeItemTypeDefinitions(definitions: ItemTypeDefinition[] | undefined): ItemTypeDefinition[] {
  const normalized = (definitions ?? [])
    .map((definition) => normalizeItemTypeDefinition(definition))
    .filter((definition): definition is ItemTypeDefinition => definition !== null);
  const dedupedByName = new Map<string, ItemTypeDefinition>();
  for (const definition of normalized) {
    dedupedByName.set(definition.name.toLowerCase(), definition);
  }
  return [...dedupedByName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function mergeSettings(raw: unknown): PmSettings {
  const defaults = cloneDefaults();
  const parsed = settingsSchema.safeParse(raw);
  if (!parsed.success) {
    return defaults;
  }
  const settings = parsed.data;
  return {
    ...defaults,
    ...settings,
    item_format: settings.item_format ?? defaults.item_format,
    locks: { ...defaults.locks, ...settings.locks },
    output: { ...defaults.output, ...settings.output },
    workflow: {
      definition_of_done: [...(settings.workflow?.definition_of_done ?? defaults.workflow.definition_of_done)],
    },
    item_types: {
      definitions: normalizeItemTypeDefinitions(settings.item_types?.definitions),
    },
    extensions: {
      enabled: [...settings.extensions.enabled],
      disabled: [...settings.extensions.disabled],
    },
    search: { ...defaults.search, ...settings.search },
    providers: {
      openai: { ...defaults.providers.openai, ...settings.providers.openai },
      ollama: { ...defaults.providers.ollama, ...settings.providers.ollama },
    },
    vector_store: {
      qdrant: { ...defaults.vector_store.qdrant, ...settings.vector_store.qdrant },
      lancedb: { ...defaults.vector_store.lancedb, ...settings.vector_store.lancedb },
    },
  };
}

export function serializeSettings(settings: PmSettings): string {
  const ordered = orderObject(settings as unknown as Record<string, unknown>, [
    "version",
    "id_prefix",
    "author_default",
    "item_format",
    "locks",
    "output",
    "workflow",
    "item_types",
    "extensions",
    "search",
    "providers",
    "vector_store",
  ]);

  ordered.locks = orderObject(ordered.locks as Record<string, unknown>, ["ttl_seconds"]);
  ordered.output = orderObject(ordered.output as Record<string, unknown>, ["default_format"]);
  ordered.workflow = orderObject(ordered.workflow as Record<string, unknown>, ["definition_of_done"]);
  ordered.item_types = orderObject(ordered.item_types as Record<string, unknown>, ["definitions"]);
  ordered.extensions = orderObject(ordered.extensions as Record<string, unknown>, ["enabled", "disabled"]);
  ordered.search = orderObject(ordered.search as Record<string, unknown>, [
    "score_threshold",
    "hybrid_semantic_weight",
    "max_results",
    "embedding_model",
    "embedding_batch_size",
    "scanner_max_batch_retries",
  ]);
  ordered.providers = orderObject(ordered.providers as Record<string, unknown>, ["openai", "ollama"]);
  (ordered.providers as Record<string, unknown>).openai = orderObject(
    ((ordered.providers as Record<string, unknown>).openai ?? {}) as Record<string, unknown>,
    ["base_url", "api_key", "model"],
  );
  (ordered.providers as Record<string, unknown>).ollama = orderObject(
    ((ordered.providers as Record<string, unknown>).ollama ?? {}) as Record<string, unknown>,
    ["base_url", "model"],
  );
  ordered.vector_store = orderObject(ordered.vector_store as Record<string, unknown>, ["qdrant", "lancedb"]);
  (ordered.vector_store as Record<string, unknown>).qdrant = orderObject(
    ((ordered.vector_store as Record<string, unknown>).qdrant ?? {}) as Record<string, unknown>,
    ["url", "api_key"],
  );
  (ordered.vector_store as Record<string, unknown>).lancedb = orderObject(
    ((ordered.vector_store as Record<string, unknown>).lancedb ?? {}) as Record<string, unknown>,
    ["path"],
  );

  return `${JSON.stringify(ordered, null, 2)}\n`;
}

export async function readSettingsWithMetadata(pmRoot: string): Promise<SettingsReadResult> {
  const settingsPath = getSettingsPath(pmRoot);
  const raw = await readFileIfExists(settingsPath);
  if (raw === null) {
    return {
      settings: cloneDefaults(),
      metadata: {
        has_explicit_item_format: false,
      },
    };
  }
  await runActiveOnReadHooks({
    path: settingsPath,
    scope: "project",
  });
  try {
    const parsed = JSON.parse(raw) as unknown;
    return {
      settings: mergeSettings(parsed),
      metadata: {
        has_explicit_item_format: hasExplicitItemFormat(parsed),
      },
    };
  } catch {
    return {
      settings: cloneDefaults(),
      metadata: {
        has_explicit_item_format: false,
      },
    };
  }
}

export async function readSettings(pmRoot: string): Promise<PmSettings> {
  return (await readSettingsWithMetadata(pmRoot)).settings;
}

export async function writeSettings(pmRoot: string, settings: PmSettings, op = SETTINGS_WRITE_OP): Promise<void> {
  const settingsPath = getSettingsPath(pmRoot);
  await writeFileAtomic(settingsPath, serializeSettings(settings));
  await runActiveOnWriteHooks({
    path: settingsPath,
    scope: "project",
    op,
  });
}
