import { z } from "zod";
import { runActiveOnReadHooks, runActiveOnWriteHooks } from "../extensions/index.js";
import { SETTINGS_DEFAULTS } from "../shared/constants.js";
import { readFileIfExists, writeFileAtomic } from "../fs/fs-utils.js";
import { getSettingsPath } from "./paths.js";
import { orderObject } from "../shared/serialization.js";
import type { PmSettings } from "../../types/index.js";

const settingsSchema = z.object({
  version: z.number().int(),
  id_prefix: z.string(),
  author_default: z.string(),
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

function cloneDefaults(): PmSettings {
  return structuredClone(SETTINGS_DEFAULTS);
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
    locks: { ...defaults.locks, ...settings.locks },
    output: { ...defaults.output, ...settings.output },
    workflow: {
      definition_of_done: [...(settings.workflow?.definition_of_done ?? defaults.workflow.definition_of_done)],
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
    "locks",
    "output",
    "workflow",
    "extensions",
    "search",
    "providers",
    "vector_store",
  ]);

  ordered.locks = orderObject(ordered.locks as Record<string, unknown>, ["ttl_seconds"]);
  ordered.output = orderObject(ordered.output as Record<string, unknown>, ["default_format"]);
  ordered.workflow = orderObject(ordered.workflow as Record<string, unknown>, ["definition_of_done"]);
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

export async function readSettings(pmRoot: string): Promise<PmSettings> {
  const settingsPath = getSettingsPath(pmRoot);
  const raw = await readFileIfExists(settingsPath);
  if (raw === null) {
    return cloneDefaults();
  }
  await runActiveOnReadHooks({
    path: settingsPath,
    scope: "project",
  });
  try {
    return mergeSettings(JSON.parse(raw));
  } catch {
    return cloneDefaults();
  }
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
