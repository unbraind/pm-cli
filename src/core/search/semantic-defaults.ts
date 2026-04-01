import { spawnSync } from "node:child_process";
import type { PmSettings } from "../../types/index.js";

const DISABLE_AUTO_DEFAULTS_ENV = "PM_DISABLE_OLLAMA_AUTO_DEFAULTS";
const OLLAMA_MODEL_ENV = "PM_OLLAMA_MODEL";
const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434";
const DEFAULT_OLLAMA_MODEL = "qwen3-embedding:0.6b";
const DEFAULT_LANCEDB_PATH = ".agents/pm/search/lancedb/";
const OLLAMA_VERSION_TIMEOUT_MS = 1_500;
const OLLAMA_LIST_TIMEOUT_MS = 2_500;

export interface SemanticRuntimeDefaultsResolution {
  settings: PmSettings;
  auto_ollama_defaults_applied: boolean;
}

function toOptionalNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function isAutoDefaultsDisabled(): boolean {
  const raw = toOptionalNonEmptyString(process.env[DISABLE_AUTO_DEFAULTS_ENV]);
  if (!raw) {
    return false;
  }
  const normalized = raw.toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function hasAnyExplicitSemanticConfiguration(settings: PmSettings): boolean {
  const candidateValues: Array<unknown> = [
    settings.search?.provider,
    settings.vector_store?.adapter,
    settings.providers?.openai?.base_url,
    settings.providers?.openai?.model,
    settings.providers?.openai?.api_key,
    settings.providers?.ollama?.base_url,
    settings.providers?.ollama?.model,
    settings.vector_store?.qdrant?.url,
    settings.vector_store?.qdrant?.api_key,
    settings.vector_store?.lancedb?.path,
  ];
  return candidateValues.some((entry) => toOptionalNonEmptyString(entry) !== null);
}

function isOllamaInstalled(): boolean {
  const result = spawnSync("ollama", ["--version"], {
    encoding: "utf8",
    timeout: OLLAMA_VERSION_TIMEOUT_MS,
  });
  if (result.error) {
    return false;
  }
  return result.status === 0;
}

function parseOllamaModelList(output: string): string | null {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    return null;
  }
  const models = lines
    .map((line) => line.split(/\s+/)[0]?.trim())
    .filter((entry): entry is string => Boolean(entry && entry.length > 0))
    .filter((entry) => entry.toUpperCase() !== "NAME");
  if (models.length === 0) {
    return null;
  }
  const embeddingModel = models.find((entry) => /embed|embedding/i.test(entry));
  return embeddingModel ?? models[0];
}

function resolveAutoOllamaModel(settings: PmSettings): string {
  const settingsModel = toOptionalNonEmptyString(settings.providers?.ollama?.model);
  if (settingsModel) {
    return settingsModel;
  }
  const envModel = toOptionalNonEmptyString(process.env[OLLAMA_MODEL_ENV]);
  if (envModel) {
    return envModel;
  }
  const listed = spawnSync("ollama", ["list"], {
    encoding: "utf8",
    timeout: OLLAMA_LIST_TIMEOUT_MS,
  });
  if (!listed.error && listed.status === 0) {
    const listedModel = parseOllamaModelList(typeof listed.stdout === "string" ? listed.stdout : "");
    if (listedModel) {
      return listedModel;
    }
  }
  return DEFAULT_OLLAMA_MODEL;
}

export function resolveSettingsWithSemanticRuntimeDefaults(settings: PmSettings): SemanticRuntimeDefaultsResolution {
  if (isAutoDefaultsDisabled()) {
    return {
      settings,
      auto_ollama_defaults_applied: false,
    };
  }
  if (hasAnyExplicitSemanticConfiguration(settings)) {
    return {
      settings,
      auto_ollama_defaults_applied: false,
    };
  }
  if (!isOllamaInstalled()) {
    return {
      settings,
      auto_ollama_defaults_applied: false,
    };
  }

  const nextSettings = structuredClone(settings);
  const resolvedModel = resolveAutoOllamaModel(nextSettings);
  nextSettings.providers.ollama.base_url = DEFAULT_OLLAMA_BASE_URL;
  nextSettings.providers.ollama.model = resolvedModel;
  nextSettings.vector_store.lancedb.path = DEFAULT_LANCEDB_PATH;
  if (!toOptionalNonEmptyString(nextSettings.search.embedding_model)) {
    nextSettings.search.embedding_model = resolvedModel;
  }
  return {
    settings: nextSettings,
    auto_ollama_defaults_applied: true,
  };
}
