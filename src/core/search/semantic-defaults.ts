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
const DEFAULT_OLLAMA_MODEL = "qwen3-embedding:0.6b";
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

/**
 * True only when the user has opted into a provider/store that COMPETES with the
 * Ollama + LanceDB auto-default stack: an explicit non-Ollama search provider, a
 * non-LanceDB vector adapter, or any OpenAI/Qdrant credentials. A partial Ollama
 * setup (e.g. only `ollama.base_url`) is NOT competing — its missing leaves are
 * filled per-field below so a single config write can never silently disable
 * semantic search and then hard-error `pm reindex`.
 */
function hasCompetingSemanticConfiguration(settings: PmSettings): boolean {
  const provider = toOptionalNonEmptyString(settings.search?.provider);
  if (provider && provider.toLowerCase() !== "ollama") {
    return true;
  }
  const adapter = toOptionalNonEmptyString(settings.vector_store?.adapter);
  if (adapter && adapter.toLowerCase() !== "lancedb") {
    return true;
  }
  const openaiConfigured = [
    settings.providers?.openai?.base_url,
    settings.providers?.openai?.model,
    settings.providers?.openai?.api_key,
  ].some((entry) => toOptionalNonEmptyString(entry) !== null);
  if (openaiConfigured) {
    return true;
  }
  const qdrantConfigured = [
    settings.vector_store?.qdrant?.url,
    settings.vector_store?.qdrant?.api_key,
  ].some((entry) => toOptionalNonEmptyString(entry) !== null);
  return qdrantConfigured;
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

  const needsBaseUrl = toOptionalNonEmptyString(settings.providers?.ollama?.base_url) === null;
  const needsModel = toOptionalNonEmptyString(settings.providers?.ollama?.model) === null;
  const needsLancedbPath = toOptionalNonEmptyString(settings.vector_store?.lancedb?.path) === null;
  const needsEmbeddingModel = toOptionalNonEmptyString(settings.search?.embedding_model) === null;
  if (!needsBaseUrl && !needsModel && !needsLancedbPath && !needsEmbeddingModel) {
    // A fully-configured Ollama/LanceDB stack — nothing to fill, and no need to
    // probe for Ollama at all.
    return unchanged;
  }

  // Auto-discovering the embedding model (via `ollama list`) is the only step that
  // requires Ollama to be installed. When a model is already configured we mirror it
  // into the remaining leaves without forcing an Ollama probe; when it is missing we
  // require Ollama to actually be present rather than writing an unusable default.
  if (needsModel && !isOllamaInstalled()) {
    return unchanged;
  }

  const nextSettings = structuredClone(settings);
  const resolvedModel = resolveAutoOllamaModel(nextSettings);
  // `readSettings` always normalizes these nested objects, but this function is
  // exported and runs on the search hot path with caller-supplied settings, so a
  // partial object (e.g. providers/vector_store set but no `search` block) must
  // fill the missing leaf rather than throwing on an undefined parent.
  if (needsBaseUrl || needsModel) {
    const providers = (nextSettings.providers ??= {} as PmSettings["providers"]);
    const ollama = (providers.ollama ??= {} as PmSettings["providers"]["ollama"]);
    if (needsBaseUrl) {
      ollama.base_url = DEFAULT_OLLAMA_BASE_URL;
    }
    if (needsModel) {
      ollama.model = resolvedModel;
    }
  }
  if (needsLancedbPath) {
    const vectorStore = (nextSettings.vector_store ??= {} as PmSettings["vector_store"]);
    const lancedb = (vectorStore.lancedb ??= {} as PmSettings["vector_store"]["lancedb"]);
    lancedb.path = DEFAULT_LANCEDB_PATH;
  }
  if (needsEmbeddingModel) {
    const search = (nextSettings.search ??= {} as PmSettings["search"]);
    search.embedding_model = resolvedModel;
  }
  return {
    settings: nextSettings,
    auto_ollama_defaults_applied: true,
  };
}
