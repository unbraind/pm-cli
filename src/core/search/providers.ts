import type { PmSettings } from "../../types/index.js";

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

export interface EmbeddingHttpResponse {
  ok: boolean;
  status: number;
  statusText: string;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export type EmbeddingRequestFetcher = (
  url: string,
  init: {
    method: "POST";
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<EmbeddingHttpResponse>;

export interface ExecuteEmbeddingRequestOptions {
  timeout_ms?: number;
  fetcher?: EmbeddingRequestFetcher;
}

const DEFAULT_EMBEDDING_TIMEOUT_MS = 30_000;

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

function trimTrailingSlashes(value: string): string {
  return value.replaceAll(/\/+$/g, "");
}

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

function toNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function resolveOpenAiProvider(settings: ProviderSettingsInput): EmbeddingProviderConfig | null {
  const baseUrl = toNonEmptyString(settings.providers?.openai?.base_url);
  const model = toNonEmptyString(settings.providers?.openai?.model);
  if (!baseUrl || !model) {
    return null;
  }
  const apiKey = toNonEmptyString(settings.providers?.openai?.api_key);
  return {
    name: "openai",
    base_url: baseUrl,
    model,
    ...(apiKey ? { api_key: apiKey } : {}),
  };
}

function resolveOllamaProvider(settings: ProviderSettingsInput): EmbeddingProviderConfig | null {
  const baseUrl = toNonEmptyString(settings.providers?.ollama?.base_url);
  const model = toNonEmptyString(settings.providers?.ollama?.model);
  if (!baseUrl || !model) {
    return null;
  }
  return {
    name: "ollama",
    base_url: baseUrl,
    model,
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

function isFiniteNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "number" && Number.isFinite(entry));
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
  return {
    active: available[0] ?? null,
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
    endpoint: `${baseUrl}/api/embeddings`,
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
    body: normalizedInputs.length === 1
      ? {
          model: provider.model,
          prompt: normalizedInputs[0],
        }
      : {
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

function resolveEmbeddingFetcher(fetcher: EmbeddingRequestFetcher | undefined): EmbeddingRequestFetcher {
  if (fetcher) {
    return fetcher;
  }
  if (typeof globalThis.fetch === "function") {
    return globalThis.fetch.bind(globalThis) as unknown as EmbeddingRequestFetcher;
  }
  throw new Error("Embedding request execution requires a fetch implementation");
}

function normalizeTimeoutMs(timeoutMs: number | undefined): number {
  const resolved = timeoutMs ?? DEFAULT_EMBEDDING_TIMEOUT_MS;
  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw new Error("Embedding request timeout must be a positive finite number");
  }
  return Math.floor(resolved);
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message.trim();
    return message.length > 0 ? message : error.name;
  }
  return String(error);
}

async function readFailedResponseBody(response: EmbeddingHttpResponse): Promise<string> {
  try {
    return (await response.text()).replaceAll(/\s+/g, " ").trim();
  } catch (error) {
    return `(failed to read response body: ${toErrorMessage(error)})`;
  }
}

export async function executeEmbeddingRequest(
  provider: EmbeddingProviderConfig,
  input: string | string[],
  options: ExecuteEmbeddingRequestOptions = {},
): Promise<number[][]> {
  const timeoutMs = normalizeTimeoutMs(options.timeout_ms);
  const fetcher = resolveEmbeddingFetcher(options.fetcher);
  const normalizedInputs = normalizeEmbeddingInputs(input);
  const dedupedInputs = dedupeEmbeddingInputs(normalizedInputs);
  const requestPlan = buildEmbeddingRequestPlan(provider, dedupedInputs.uniqueInputs);
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    let response: EmbeddingHttpResponse;
    try {
      response = await fetcher(requestPlan.target.endpoint, {
        method: requestPlan.method,
        headers: requestPlan.headers,
        body: JSON.stringify(requestPlan.body),
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`Embedding request timed out after ${timeoutMs}ms`);
      }
      throw new Error(`Embedding request execution failed: ${toErrorMessage(error)}`);
    }

    if (!response.ok) {
      const responseBody = await readFailedResponseBody(response);
      const detail = responseBody.length > 0 ? `: ${responseBody}` : "";
      throw new Error(`Embedding request failed with status ${response.status} ${response.statusText}${detail}`);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      throw new Error(`Embedding response JSON parse failed: ${toErrorMessage(error)}`);
    }
    const vectors = normalizeEmbeddingResponse(provider, payload);
    if (vectors.length !== dedupedInputs.uniqueInputs.length) {
      throw new Error(
        `Embedding response cardinality mismatch: expected ${dedupedInputs.uniqueInputs.length} vector(s), received ${vectors.length}`,
      );
    }
    return dedupedInputs.originalToUniqueIndex.map((uniqueIndex) => [...vectors[uniqueIndex]]);
  } finally {
    clearTimeout(timeoutHandle);
  }
}
