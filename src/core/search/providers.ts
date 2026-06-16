import type { PmSettings } from "../../types/index.js";
import {
  executeSearchJsonRequest,
  normalizeSearchHttpTimeoutMs,
  resolveSearchHttpFetcher,
} from "./http-client.js";
import type { SearchHttpFetcher, SearchHttpResponse } from "./http-client.js";
import {
  isFiniteNumberArray,
  toNonEmptyString,
  trimTrailingSlashes,
} from "../shared/primitives.js";

export type EmbeddingProviderName = "openai" | "ollama";

export interface EmbeddingProviderConfig {
  name: EmbeddingProviderName;
  base_url: string;
  model: string;
  api_key?: string;
}

export interface EmbeddingProviderResolution {
  active: EmbeddingProviderConfig | null;
  available: EmbeddingProviderConfig[];
}

/**
 * GH-244: how an active search-provider / vector-store adapter came to be
 * resolved, so `pm health` can explain why a working runtime can coexist with
 * empty persisted `search.provider` / `vector_store.adapter` settings:
 * - "configured": the persisted setting names the active resolution.
 * - "auto-detected": runtime auto-detection selected it; the setting is empty.
 * - "unconfigured": nothing is active.
 */
export type ProviderConfigSource = "configured" | "auto-detected" | "unconfigured";

/**
 * Classifies the resolution source for an active provider/adapter given the
 * persisted (possibly empty) configured value. Pure and adapter-agnostic so it
 * serves both the embedding provider and the vector-store adapter. "configured"
 * requires the persisted value to actually MATCH the active resolution
 * (case-insensitively): a configured-but-unhonored value (typo or unsupported
 * name that the runtime fell back from) is reported as "auto-detected", not
 * falsely "configured".
 */
export function resolveProviderConfigSource(
  activeName: string | null | undefined,
  configured: string | null | undefined,
): ProviderConfigSource {
  const active = toNonEmptyString(activeName);
  if (!active) {
    return "unconfigured";
  }
  const configuredValue = toNonEmptyString(configured);
  return configuredValue && configuredValue.toLowerCase() === active.toLowerCase() ? "configured" : "auto-detected";
}

export interface EmbeddingRequestTarget {
  provider: EmbeddingProviderName;
  endpoint: string;
  model: string;
}

export interface EmbeddingRequestPlan {
  target: EmbeddingRequestTarget;
  method: "POST";
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

export type EmbeddingHttpResponse = SearchHttpResponse;

export type EmbeddingRequestFetcher = SearchHttpFetcher<EmbeddingHttpResponse>;

export interface ExecuteEmbeddingRequestOptions {
  timeout_ms?: number;
  fetcher?: EmbeddingRequestFetcher;
}

type ProviderSettingsInput = {
  providers?: {
    openai?: {
      base_url?: string;
      api_key?: string;
      model?: string;
    };
    ollama?: {
      base_url?: string;
      model?: string;
    };
  };
};

function normalizeOpenAiEmbeddingsEndpoint(baseUrl: string): string {
  const normalizedBaseUrl = trimTrailingSlashes(baseUrl);
  const normalizedLower = normalizedBaseUrl.toLowerCase();
  if (normalizedLower.endsWith("/embeddings")) {
    return normalizedBaseUrl;
  }
  if (normalizedLower.endsWith("/v1")) {
    return `${normalizedBaseUrl}/embeddings`;
  }
  return `${normalizedBaseUrl}/v1/embeddings`;
}

function resolveSearchEmbeddingModelOverride(settings: ProviderSettingsInput): string | null {
  // `settings.search.embedding_model` is documented as overriding the
  // provider-specific model when set (see CONFIG_KEY_ALIASES for
  // `search_embedding_model` in src/core/config/nested-settings.ts). Each
  // provider resolver picks this up after its own model is read so the
  // override applies to whichever built-in is selected.
  const candidate = (settings as { search?: { embedding_model?: unknown } }).search?.embedding_model;
  return toNonEmptyString(candidate) || null;
}

function resolveOpenAiProvider(settings: ProviderSettingsInput): EmbeddingProviderConfig | null {
  const baseUrl = toNonEmptyString(settings.providers?.openai?.base_url);
  const model = toNonEmptyString(settings.providers?.openai?.model);
  if (!baseUrl || !model) {
    return null;
  }
  const override = resolveSearchEmbeddingModelOverride(settings);
  const apiKey = toNonEmptyString(settings.providers?.openai?.api_key);
  return {
    name: "openai",
    base_url: baseUrl,
    model: override ?? model,
    ...(apiKey ? { api_key: apiKey } : {}),
  };
}

function resolveOllamaProvider(settings: ProviderSettingsInput): EmbeddingProviderConfig | null {
  const baseUrl = toNonEmptyString(settings.providers?.ollama?.base_url);
  const model = toNonEmptyString(settings.providers?.ollama?.model);
  if (!baseUrl || !model) {
    return null;
  }
  const override = resolveSearchEmbeddingModelOverride(settings);
  return {
    name: "ollama",
    base_url: baseUrl,
    model: override ?? model,
  };
}

function normalizeEmbeddingInputs(input: string | string[]): string[] {
  const inputs = (Array.isArray(input) ? input : [input])
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (inputs.length === 0) {
    throw new Error("Embedding input must include at least one non-empty string");
  }
  return inputs;
}

interface DedupedEmbeddingInputs {
  uniqueInputs: string[];
  originalToUniqueIndex: number[];
}

function dedupeEmbeddingInputs(inputs: string[]): DedupedEmbeddingInputs {
  const uniqueInputs: string[] = [];
  const originalToUniqueIndex: number[] = [];
  const uniqueIndexByInput = new Map<string, number>();
  for (const entry of inputs) {
    const existingUniqueIndex = uniqueIndexByInput.get(entry);
    if (existingUniqueIndex === undefined) {
      const nextUniqueIndex = uniqueInputs.length;
      uniqueInputs.push(entry);
      uniqueIndexByInput.set(entry, nextUniqueIndex);
      originalToUniqueIndex.push(nextUniqueIndex);
      continue;
    }
    originalToUniqueIndex.push(existingUniqueIndex);
  }
  return {
    uniqueInputs,
    originalToUniqueIndex,
  };
}

interface OpenAiEmbeddingResponseEntry {
  embedding: unknown;
  index: unknown;
  position: number;
}

function buildOrderedOpenAiEntries(data: unknown[]): OpenAiEmbeddingResponseEntry[] {
  const openAiEntries = data.map((entry, position) => ({
    embedding: (entry as { embedding?: unknown }).embedding,
    index: (entry as { index?: unknown }).index,
    position,
  }));
  const hasExplicitIndex = openAiEntries.some((entry) => entry.index !== undefined);
  if (hasExplicitIndex) {
    for (const entry of openAiEntries) {
      if (!Number.isInteger(entry.index)) {
        throw new TypeError(`OpenAI embedding response entry at position ${entry.position} is missing a valid integer index`);
      }
    }
    return [...openAiEntries].sort((a, b) => {
      const byIndex = (a.index as number) - (b.index as number);
      if (byIndex !== 0) {
        return byIndex;
      }
      return a.position - b.position;
    });
  }
  return openAiEntries;
}

export function resolveEmbeddingProviders(settings: PmSettings | ProviderSettingsInput): EmbeddingProviderResolution {
  const openAi = resolveOpenAiProvider(settings);
  const ollama = resolveOllamaProvider(settings);
  const available = [openAi, ollama].filter((entry): entry is EmbeddingProviderConfig => entry !== null);
  // Honor `settings.search.provider` when set: if both built-in providers are
  // configured, the preferred name wins; otherwise fall back to the first
  // available entry (preserves the previous tie-break: openai > ollama).
  // Match case-insensitively so "OpenAI" / "Ollama" / "OLLAMA" all work.
  const preferredName = toNonEmptyString(
    (settings as { search?: { provider?: unknown } }).search?.provider,
  );
  const preferredKey = preferredName ? preferredName.toLowerCase() : null;
  const preferred = preferredKey
    ? available.find((entry) => entry.name === preferredKey)
    : undefined;
  return {
    active: preferred ?? available[0] ?? null,
    available,
  };
}

export function resolveEmbeddingRequestTarget(provider: EmbeddingProviderConfig): EmbeddingRequestTarget {
  const baseUrl = trimTrailingSlashes(provider.base_url);
  if (provider.name === "openai") {
    return {
      provider: "openai",
      endpoint: normalizeOpenAiEmbeddingsEndpoint(baseUrl),
      model: provider.model,
    };
  }
  return {
    provider: "ollama",
    endpoint: `${baseUrl}/api/embed`,
    model: provider.model,
  };
}

export function buildEmbeddingRequestPlan(provider: EmbeddingProviderConfig, input: string | string[]): EmbeddingRequestPlan {
  const normalizedInputs = normalizeEmbeddingInputs(input);
  if (provider.name === "openai") {
    return {
      target: resolveEmbeddingRequestTarget(provider),
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(provider.api_key ? { authorization: `Bearer ${provider.api_key}` } : {}),
      },
      body: {
        model: provider.model,
        input: normalizedInputs.length === 1 ? normalizedInputs[0] : normalizedInputs,
      },
    };
  }
  return {
    target: resolveEmbeddingRequestTarget(provider),
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: {
      model: provider.model,
      input: normalizedInputs,
    },
  };
}

export function normalizeEmbeddingResponse(provider: EmbeddingProviderConfig, response: unknown): number[][] {
  if (provider.name === "openai") {
    const data = (response as { data?: unknown }).data;
    if (!Array.isArray(data) || data.length === 0) {
      throw new Error("OpenAI embedding response must include a non-empty data array");
    }
    const orderedEntries = buildOrderedOpenAiEntries(data);

    return orderedEntries.map((entry, index) => {
      const embedding = entry.embedding;
      if (!isFiniteNumberArray(embedding)) {
        throw new Error(`OpenAI embedding response entry at index ${index} is missing a numeric embedding vector`);
      }
      return [...embedding];
    });
  }

  const singleEmbedding = (response as { embedding?: unknown }).embedding;
  if (isFiniteNumberArray(singleEmbedding)) {
    return [[...singleEmbedding]];
  }

  const multipleEmbeddings = (response as { embeddings?: unknown }).embeddings;
  if (Array.isArray(multipleEmbeddings) && multipleEmbeddings.length > 0) {
    return multipleEmbeddings.map((entry, index) => {
      if (!isFiniteNumberArray(entry)) {
        throw new Error(`Ollama embedding response entry at index ${index} is missing a numeric embedding vector`);
      }
      return [...entry];
    });
  }

  throw new Error("Ollama embedding response must include embedding or embeddings vectors");
}

export async function executeEmbeddingRequest(
  provider: EmbeddingProviderConfig,
  input: string | string[],
  options: ExecuteEmbeddingRequestOptions = {},
): Promise<number[][]> {
  const timeoutMs = normalizeSearchHttpTimeoutMs(options.timeout_ms, "Embedding request");
  const fetcher = resolveSearchHttpFetcher(options.fetcher, "Embedding request");
  const normalizedInputs = normalizeEmbeddingInputs(input);
  const dedupedInputs = dedupeEmbeddingInputs(normalizedInputs);
  const requestPlan = buildEmbeddingRequestPlan(provider, dedupedInputs.uniqueInputs);
  const payload = await executeSearchJsonRequest({
    endpoint: requestPlan.target.endpoint,
    method: requestPlan.method,
    headers: requestPlan.headers,
    body: requestPlan.body,
    timeoutMs,
    fetcher,
    requestLabel: "Embedding request",
    responseLabel: "Embedding response",
  });
  const vectors = normalizeEmbeddingResponse(provider, payload);
  if (vectors.length !== dedupedInputs.uniqueInputs.length) {
    throw new Error(
      `Embedding response cardinality mismatch: expected ${dedupedInputs.uniqueInputs.length} vector(s), received ${vectors.length}`,
    );
  }
  return dedupedInputs.originalToUniqueIndex.map((uniqueIndex) => [...vectors[uniqueIndex]]);
}
