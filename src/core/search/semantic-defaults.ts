/**
 * @module core/search/semantic-defaults
 *
 * Powers search, embeddings, and semantic retrieval behavior for Semantic Defaults.
 */
import { spawnSync } from "node:child_process";
import type { PmSettings } from "../../types/index.js";
import { toNonEmptyString } from "../shared/primitives.js";

const DISABLE_AUTO_DEFAULTS_ENV = "PM_DISABLE_OLLAMA_AUTO_DEFAULTS";
const OLLAMA_MODEL_ENV = "PM_OLLAMA_MODEL";
const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434";
const RECOMMENDED_OLLAMA_EMBEDDING_MODEL = "qwen3-embedding:0.6b";
const DEFAULT_LANCEDB_PATH = ".agents/pm/search/lancedb/";
const OLLAMA_VERSION_TIMEOUT_MS = 1_500;
const OLLAMA_LIST_TIMEOUT_MS = 2_500;
const QWEN_EMBEDDING_MODEL_PATTERN = /qwen.*(?:embed|embedding)|(?:embed|embedding).*qwen/i;
const EMBEDDING_MODEL_PATTERN = /embed|embedding/i;

/**
 * Documents the semantic runtime defaults resolution payload exchanged by command, SDK, and package integrations.
 */
export interface SemanticRuntimeDefaultsResolution {
  settings: PmSettings;
  auto_ollama_defaults_applied: boolean;
  auto_ollama_defaults_skipped_reason?: "no_installed_embedding_model";
  auto_ollama_defaults_remediation?: string;
}

const toOptionalNonEmptyString = toNonEmptyString;

function isAutoDefaultsDisabled(): boolean {
  const raw = toOptionalNonEmptyString(process.env[DISABLE_AUTO_DEFAULTS_ENV]);
  if (!raw) {
    return false;
  }
  const normalized = raw.toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function hasConfiguredValue(values: readonly unknown[]): boolean {
  return values.some((entry) => toOptionalNonEmptyString(entry) !== null);
}

function hasCompetingProvider(provider: unknown): boolean {
  const normalized = toOptionalNonEmptyString(provider);
  return Boolean(normalized && normalized.toLowerCase() !== "ollama");
}

function hasCompetingVectorAdapter(adapter: unknown): boolean {
  const normalized = toOptionalNonEmptyString(adapter);
  return Boolean(normalized && normalized.toLowerCase() !== "lancedb");
}

/**
 * True only when the user has opted into a provider/store that COMPETES with the
 * Ollama + LanceDB auto-default stack: an explicit non-Ollama search provider, a
 * non-LanceDB vector adapter, or any OpenAI/Qdrant credentials. A partial Ollama
 * setup (e.g. only `ollama.base_url`) is NOT competing — its missing leaves are
 * filled per-field below so a single config write can never silently disable
 * semantic search and then hard-error `pm reindex`.
 */
function hasCompetingSemanticConfiguration(settings: PmSettings): boolean {
  if (hasCompetingProvider(settings.search?.provider)) {
    return true;
  }
  if (hasCompetingVectorAdapter(settings.vector_store?.adapter)) {
    return true;
  }
  if (hasConfiguredValue([
    settings.providers?.openai?.base_url,
    settings.providers?.openai?.model,
    settings.providers?.openai?.api_key,
  ])) {
    return true;
  }
  return hasConfiguredValue([
    settings.vector_store?.qdrant?.url,
    settings.vector_store?.qdrant?.api_key,
  ]);
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
  const preferredQwenEmbeddingModel = models.find((entry) => QWEN_EMBEDDING_MODEL_PATTERN.test(entry));
  if (preferredQwenEmbeddingModel) {
    return preferredQwenEmbeddingModel;
  }
  const embeddingModel = models.find((entry) => EMBEDDING_MODEL_PATTERN.test(entry));
  return embeddingModel ?? null;
}

function resolveAutoOllamaModel(settings: PmSettings): string | null {
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
  return null;
}

interface SemanticDefaultNeeds {
  baseUrl: boolean;
  model: boolean;
  lancedbPath: boolean;
  embeddingModel: boolean;
}

function resolveSemanticDefaultNeeds(settings: PmSettings): SemanticDefaultNeeds {
  return {
    baseUrl: toOptionalNonEmptyString(settings.providers?.ollama?.base_url) === null,
    model: toOptionalNonEmptyString(settings.providers?.ollama?.model) === null,
    lancedbPath: toOptionalNonEmptyString(settings.vector_store?.lancedb?.path) === null,
    embeddingModel: toOptionalNonEmptyString(settings.search?.embedding_model) === null,
  };
}

function needsAnySemanticDefault(needs: SemanticDefaultNeeds): boolean {
  return needs.baseUrl || needs.model || needs.lancedbPath || needs.embeddingModel;
}

function applyOllamaProviderDefaults(settings: PmSettings, needs: SemanticDefaultNeeds, resolvedModel: string): void {
  if (!needs.baseUrl && !needs.model) {
    return;
  }
  const providers = (settings.providers ??= {} as PmSettings["providers"]);
  const ollama = (providers.ollama ??= {} as PmSettings["providers"]["ollama"]);
  if (needs.baseUrl) {
    ollama.base_url = DEFAULT_OLLAMA_BASE_URL;
  }
  if (needs.model) {
    ollama.model = resolvedModel;
  }
}

function applyVectorStoreDefaults(settings: PmSettings, needs: SemanticDefaultNeeds): void {
  if (!needs.lancedbPath) {
    return;
  }
  const vectorStore = (settings.vector_store ??= {} as PmSettings["vector_store"]);
  const lancedb = (vectorStore.lancedb ??= {} as PmSettings["vector_store"]["lancedb"]);
  lancedb.path = DEFAULT_LANCEDB_PATH;
}

function applySearchEmbeddingDefaults(settings: PmSettings, needs: SemanticDefaultNeeds, resolvedModel: string): void {
  if (!needs.embeddingModel) {
    return;
  }
  const search = (settings.search ??= {} as PmSettings["search"]);
  search.embedding_model = resolvedModel;
}

/**
 * Implements resolve settings with semantic runtime defaults for the public runtime surface of this module.
 */
export function resolveSettingsWithSemanticRuntimeDefaults(settings: PmSettings): SemanticRuntimeDefaultsResolution {
  const unchanged: SemanticRuntimeDefaultsResolution = {
    settings,
    auto_ollama_defaults_applied: false,
  };
  if (isAutoDefaultsDisabled()) {
    return unchanged;
  }
  if (hasCompetingSemanticConfiguration(settings)) {
    return unchanged;
  }

  const needs = resolveSemanticDefaultNeeds(settings);
  if (!needsAnySemanticDefault(needs)) {
    // A fully-configured Ollama/LanceDB stack — nothing to fill, and no need to
    // probe for Ollama at all.
    return unchanged;
  }

  // Auto-discovering the embedding model (via `ollama list`) is the only step that
  // requires Ollama to be installed. When a model is already configured we mirror it
  // into the remaining leaves without forcing an Ollama probe; when it is missing we
  // require Ollama to actually be present rather than writing an unusable default.
  if (needs.model && !isOllamaInstalled()) {
    return unchanged;
  }

  const nextSettings = structuredClone(settings);
  const resolvedModel = resolveAutoOllamaModel(nextSettings);
  if (!resolvedModel) {
    return {
      ...unchanged,
      auto_ollama_defaults_skipped_reason: "no_installed_embedding_model",
      auto_ollama_defaults_remediation:
        `Run ollama pull ${RECOMMENDED_OLLAMA_EMBEDDING_MODEL} or configure providers.ollama.model explicitly (and search.embedding_model if you need an override).`,
    };
  }
  // `readSettings` always normalizes these nested objects, but this function is
  // exported and runs on the search hot path with caller-supplied settings, so a
  // partial object (e.g. providers/vector_store set but no `search` block) must
  // fill the missing leaf rather than throwing on an undefined parent.
  applyOllamaProviderDefaults(nextSettings, needs, resolvedModel);
  applyVectorStoreDefaults(nextSettings, needs);
  applySearchEmbeddingDefaults(nextSettings, needs, resolvedModel);
  return {
    settings: nextSettings,
    auto_ollama_defaults_applied: true,
  };
}
