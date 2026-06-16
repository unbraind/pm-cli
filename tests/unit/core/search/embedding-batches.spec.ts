import { describe, expect, it } from "vitest";
import { SETTINGS_DEFAULTS } from "../../../../src/core/shared/constants.js";
import { executeEmbeddingBatchesWithRetry } from "../../../../src/core/search/embedding-batches.js";
import type { EmbeddingProviderConfig } from "../../../../src/core/search/providers.js";
import type { PmSettings } from "../../../../src/types/index.js";

function buildSettings(batchSize: number, retries: number): PmSettings {
  return {
    ...SETTINGS_DEFAULTS,
    locks: { ...SETTINGS_DEFAULTS.locks },
    output: { ...SETTINGS_DEFAULTS.output },
    extensions: {
      enabled: [...SETTINGS_DEFAULTS.extensions.enabled],
      disabled: [...SETTINGS_DEFAULTS.extensions.disabled],
    },
    search: {
      ...SETTINGS_DEFAULTS.search,
      embedding_batch_size: batchSize,
      embedding_timeout_ms: SETTINGS_DEFAULTS.search.embedding_timeout_ms,
      scanner_max_batch_retries: retries,
    },
    providers: {
      openai: { ...SETTINGS_DEFAULTS.providers.openai },
      ollama: { ...SETTINGS_DEFAULTS.providers.ollama },
    },
    vector_store: {
      qdrant: { ...SETTINGS_DEFAULTS.vector_store.qdrant },
      lancedb: { ...SETTINGS_DEFAULTS.vector_store.lancedb },
    },
  };
}

const PROVIDER: EmbeddingProviderConfig = {
  name: "openai",
  base_url: "https://api.example.test/v1",
  model: "text-embedding-3-small",
};

const OLLAMA_PROVIDER: EmbeddingProviderConfig = {
  name: "ollama",
  base_url: "http://localhost:11434",
  model: "qwen3-embedding:0.6b",
};

describe("executeEmbeddingBatchesWithRetry", () => {
  it("returns deterministic empty output for empty input", async () => {
    const result = await executeEmbeddingBatchesWithRetry(PROVIDER, buildSettings(2, 1), []);
    expect(result).toEqual({
      vectors: [],
      warnings: [],
    });
  });

  it("executes batches and emits warning when retry succeeds", async () => {
    const originalFetch = globalThis.fetch;
    let attempts = 0;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      attempts += 1;
      if (attempts === 1) {
        return {
          ok: false,
          status: 503,
          statusText: "Service Unavailable",
          json: async () => ({}),
          text: async () => "retry",
        } as unknown as Response;
      }
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string | string[] };
      const count = Array.isArray(body.input) ? body.input.length : 1;
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          data: Array.from({ length: count }, (_entry, index) => ({
            index,
            embedding: [index + 0.1, index + 0.2],
          })),
        }),
        text: async () => "",
      } as unknown as Response;
    }) as typeof globalThis.fetch;

    try {
      const result = await executeEmbeddingBatchesWithRetry(
        PROVIDER,
        buildSettings(2, 1),
        ["alpha", "beta", "gamma"],
      );
      expect(result.vectors).toHaveLength(3);
      expect(result.warnings).toEqual(["search_embedding_batch_retry_succeeded:batch=1:attempt=2:size=2"]);
      expect(attempts).toBe(3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("falls back to safe runtime values for invalid batch settings", async () => {
    const originalFetch = globalThis.fetch;
    let attempts = 0;
    const settings = buildSettings(0, -1);
    settings.search.embedding_timeout_ms = 0;
    globalThis.fetch = (async () => {
      attempts += 1;
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ data: [{ index: 0, embedding: [0.1, 0.2] }] }),
        text: async () => "",
      } as unknown as Response;
    }) as typeof globalThis.fetch;

    try {
      const result = await executeEmbeddingBatchesWithRetry(PROVIDER, settings, ["alpha"]);
      expect(result.warnings).toEqual([]);
      expect(result.vectors).toEqual([[0.1, 0.2]]);
      expect(attempts).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("splits timed-out batches to keep local embedding reindex resilient", async () => {
    const originalFetch = globalThis.fetch;
    const sizes: number[] = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string | string[] };
      const count = Array.isArray(body.input) ? body.input.length : 1;
      sizes.push(count);
      if (count > 1) {
        const error = new Error("Embedding request timed out after 30000ms");
        error.name = "AbortError";
        throw error;
      }
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ data: [{ index: 0, embedding: [count, sizes.length] }] }),
        text: async () => "",
      } as unknown as Response;
    }) as typeof globalThis.fetch;

    try {
      const result = await executeEmbeddingBatchesWithRetry(PROVIDER, buildSettings(4, 0), ["alpha", "beta", "gamma"]);
      expect(result.vectors).toHaveLength(3);
      expect(sizes).toEqual([3, 2, 1, 1, 1]);
      expect(result.warnings).toEqual([
        "search_embedding_batch_split_after_timeout:batch=1:size=3:parts=2|1",
        "search_embedding_batch_split_after_timeout:batch=1.1:size=2:parts=1|1",
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("caps Ollama batch payload size before dispatching embeddings", async () => {
    const originalFetch = globalThis.fetch;
    const sizes: number[] = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string | string[] };
      const inputs = Array.isArray(body.input) ? body.input : [body.input ?? ""];
      sizes.push(inputs.length);
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ embeddings: inputs.map((_entry, index) => [index + 0.1, index + 0.2]) }),
        text: async () => "",
      } as unknown as Response;
    }) as typeof globalThis.fetch;

    try {
      const result = await executeEmbeddingBatchesWithRetry(
        OLLAMA_PROVIDER,
        buildSettings(32, 0),
        ["a".repeat(2000), "b".repeat(2000), "c".repeat(1000)],
      );
      expect(result.vectors).toHaveLength(3);
      expect(sizes).toEqual([1, 2]);
      expect(result.warnings).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("truncates oversized embedding inputs before dispatch for bounded provider runtimes", async () => {
    const originalFetch = globalThis.fetch;
    const inputLengths: number[] = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string | string[] };
      const inputs = Array.isArray(body.input) ? body.input : [body.input ?? ""];
      inputLengths.push(...inputs.map((entry) => entry.length));
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ embeddings: inputs.map((_entry, index) => [index + 0.1, index + 0.2]) }),
        text: async () => "",
      } as unknown as Response;
    }) as typeof globalThis.fetch;

    try {
      const result = await executeEmbeddingBatchesWithRetry(OLLAMA_PROVIDER, buildSettings(4, 0), ["x".repeat(5_000)]);
      expect(result.vectors).toHaveLength(1);
      expect(result.warnings).toEqual(["search_embedding_input_truncated:count=1:max_characters=3200"]);
      expect(inputLengths).toEqual([3_200]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("throws deterministic error when retries are exhausted", async () => {
    const originalFetch = globalThis.fetch;
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts += 1;
      return {
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        json: async () => ({}),
        text: async () => "down",
      } as unknown as Response;
    }) as typeof globalThis.fetch;

    try {
      await expect(executeEmbeddingBatchesWithRetry(PROVIDER, buildSettings(1, 1), ["alpha"])).rejects.toThrow(
        "Embedding batch 1 failed after 2 attempt(s): Embedding request failed with status 500 Internal Server Error: down (provider=openai model=text-embedding-3-small batch_size=1 timeout_ms=30000)",
      );
      expect(attempts).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("uses configurable embedding timeout and reports actionable Ollama timeout guidance", async () => {
    const originalFetch = globalThis.fetch;
    const settings = buildSettings(1, 0);
    settings.search.embedding_timeout_ms = 75;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      if (init?.signal?.aborted) {
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      }
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ embeddings: [[0.1, 0.2]] }),
        text: async () => "",
      } as unknown as Response;
    }) as typeof globalThis.fetch;

    try {
      await expect(executeEmbeddingBatchesWithRetry(OLLAMA_PROVIDER, settings, ["alpha"])).rejects.toThrow(
        "provider=ollama model=qwen3-embedding:0.6b batch_size=1 timeout_ms=75; guidance=check provider availability or lower search.embedding_batch_size, raise search.embedding_timeout_ms, or run keyword search while semantic indexing catches up",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
