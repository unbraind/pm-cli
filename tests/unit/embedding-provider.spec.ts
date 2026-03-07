import { describe, expect, it } from "vitest";
import { SETTINGS_DEFAULTS } from "../../src/core/shared/constants.js";
import {
  buildEmbeddingRequestPlan,
  executeEmbeddingRequest,
  normalizeEmbeddingResponse,
  resolveEmbeddingProviders,
  resolveEmbeddingRequestTarget,
} from "../../src/core/search/providers.js";
import type { PmSettings } from "../../src/types.js";

function makeSettings(): PmSettings {
  return structuredClone(SETTINGS_DEFAULTS);
}

describe("resolveEmbeddingProviders", () => {
  it("returns no active provider when provider settings are empty", () => {
    const result = resolveEmbeddingProviders(makeSettings());
    expect(result.active).toBeNull();
    expect(result.available).toEqual([]);
  });

  it("resolves an OpenAI provider and trims string fields", () => {
    const settings = makeSettings();
    settings.providers.openai.base_url = " https://api.example.test/v1 ";
    settings.providers.openai.model = " text-embedding-3-large ";
    settings.providers.openai.api_key = " secret-token ";

    const result = resolveEmbeddingProviders(settings);
    expect(result.active).toEqual({
      name: "openai",
      base_url: "https://api.example.test/v1",
      model: "text-embedding-3-large",
      api_key: "secret-token",
    });
    expect(result.available).toEqual([result.active]);
  });

  it("omits empty api_key and still resolves OpenAI when required fields exist", () => {
    const settings = makeSettings();
    settings.providers.openai.base_url = "https://api.example.test/v1";
    settings.providers.openai.model = "text-embedding-3-small";

    const result = resolveEmbeddingProviders(settings);
    expect(result.active).toEqual({
      name: "openai",
      base_url: "https://api.example.test/v1",
      model: "text-embedding-3-small",
    });
    expect(result.available).toEqual([result.active]);
  });

  it("falls back to Ollama when OpenAI is incomplete", () => {
    const settings = makeSettings();
    settings.providers.openai.base_url = "https://api.example.test/v1";
    settings.providers.openai.model = "";
    settings.providers.ollama.base_url = "http://localhost:11434";
    settings.providers.ollama.model = "nomic-embed-text";

    const result = resolveEmbeddingProviders(settings);
    expect(result.active).toEqual({
      name: "ollama",
      base_url: "http://localhost:11434",
      model: "nomic-embed-text",
    });
    expect(result.available).toEqual([result.active]);
  });

  it("returns both providers in deterministic OpenAI-then-Ollama order", () => {
    const settings = makeSettings();
    settings.providers.openai.base_url = "https://api.example.test/v1";
    settings.providers.openai.model = "text-embedding-3-small";
    settings.providers.ollama.base_url = "http://localhost:11434";
    settings.providers.ollama.model = "nomic-embed-text";

    const malformedInput = settings as unknown as {
      providers: {
        openai: { base_url: unknown; model: unknown; api_key?: unknown };
        ollama: { base_url: unknown; model: unknown };
      };
    };
    malformedInput.providers.openai.api_key = 42;

    const result = resolveEmbeddingProviders(malformedInput);
    expect(result.available).toEqual([
      {
        name: "openai",
        base_url: "https://api.example.test/v1",
        model: "text-embedding-3-small",
      },
      {
        name: "ollama",
        base_url: "http://localhost:11434",
        model: "nomic-embed-text",
      },
    ]);
    expect(result.active).toEqual(result.available[0]);
  });
});

describe("resolveEmbeddingRequestTarget", () => {
  it("builds OpenAI and Ollama endpoints deterministically", () => {
    expect(
      resolveEmbeddingRequestTarget({
        name: "openai",
        base_url: "https://api.example.test/v1/",
        model: "text-embedding-3-small",
      }),
    ).toEqual({
      provider: "openai",
      endpoint: "https://api.example.test/v1/embeddings",
      model: "text-embedding-3-small",
    });

    expect(
      resolveEmbeddingRequestTarget({
        name: "openai",
        base_url: "https://api.example.test/",
        model: "text-embedding-3-small",
      }),
    ).toEqual({
      provider: "openai",
      endpoint: "https://api.example.test/v1/embeddings",
      model: "text-embedding-3-small",
    });

    expect(
      resolveEmbeddingRequestTarget({
        name: "openai",
        base_url: "https://api.example.test/v1/embeddings",
        model: "text-embedding-3-small",
      }),
    ).toEqual({
      provider: "openai",
      endpoint: "https://api.example.test/v1/embeddings",
      model: "text-embedding-3-small",
    });

    expect(
      resolveEmbeddingRequestTarget({
        name: "ollama",
        base_url: "http://localhost:11434/",
        model: "nomic-embed-text",
      }),
    ).toEqual({
      provider: "ollama",
      endpoint: "http://localhost:11434/api/embeddings",
      model: "nomic-embed-text",
    });
  });
});

describe("buildEmbeddingRequestPlan", () => {
  it("builds OpenAI plans with optional authorization header", () => {
    expect(
      buildEmbeddingRequestPlan(
        {
          name: "openai",
          base_url: "https://api.example.test/v1",
          model: "text-embedding-3-small",
          api_key: "secret",
        },
        " tokenized ",
      ),
    ).toEqual({
      target: {
        provider: "openai",
        endpoint: "https://api.example.test/v1/embeddings",
        model: "text-embedding-3-small",
      },
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret",
      },
      body: {
        model: "text-embedding-3-small",
        input: "tokenized",
      },
    });

    expect(
      buildEmbeddingRequestPlan(
        {
          name: "openai",
          base_url: "https://api.example.test/v1",
          model: "text-embedding-3-small",
        },
        ["first", " second "],
      ).body,
    ).toEqual({
      model: "text-embedding-3-small",
      input: ["first", "second"],
    });
  });

  it("builds Ollama plans with prompt-or-input payload shape", () => {
    expect(
      buildEmbeddingRequestPlan(
        {
          name: "ollama",
          base_url: "http://localhost:11434",
          model: "nomic-embed-text",
        },
        "single prompt",
      ).body,
    ).toEqual({
      model: "nomic-embed-text",
      prompt: "single prompt",
    });

    expect(
      buildEmbeddingRequestPlan(
        {
          name: "ollama",
          base_url: "http://localhost:11434",
          model: "nomic-embed-text",
        },
        ["one", "two"],
      ).body,
    ).toEqual({
      model: "nomic-embed-text",
      input: ["one", "two"],
    });
  });

  it("rejects empty or whitespace-only embedding input", () => {
    expect(() =>
      buildEmbeddingRequestPlan(
        {
          name: "openai",
          base_url: "https://api.example.test/v1",
          model: "text-embedding-3-small",
        },
        "   ",
      ),
    ).toThrow("Embedding input must include at least one non-empty string");

    expect(() =>
      buildEmbeddingRequestPlan(
        {
          name: "ollama",
          base_url: "http://localhost:11434",
          model: "nomic-embed-text",
        },
        [" ", ""],
      ),
    ).toThrow("Embedding input must include at least one non-empty string");
  });
});

describe("executeEmbeddingRequest", () => {
  it("executes request plan with provided fetcher and normalizes embeddings", async () => {
    const fetcher = async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({
        data: [
          { embedding: [0.11, 0.22] },
          { embedding: [0.33, 0.44] },
        ],
      }),
      text: async () => "",
    });

    const vectors = await executeEmbeddingRequest(
      {
        name: "openai",
        base_url: "https://api.example.test/v1",
        model: "text-embedding-3-small",
        api_key: "secret",
      },
      [" query token ", " second token "],
      { fetcher, timeout_ms: 50 },
    );

    expect(vectors).toEqual([
      [0.11, 0.22],
      [0.33, 0.44],
    ]);
  });

  it("deduplicates normalized duplicate inputs per request and fans out returned vectors", async () => {
    let capturedBody: unknown = null;
    const fetcher = async (_url: string, init: { body: string }) => {
      capturedBody = JSON.parse(init.body) as unknown;
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          data: [
            { index: 0, embedding: [0.11, 0.22] },
            { index: 1, embedding: [0.33, 0.44] },
          ],
        }),
        text: async () => "",
      };
    };

    const vectors = await executeEmbeddingRequest(
      {
        name: "openai",
        base_url: "https://api.example.test/v1",
        model: "text-embedding-3-small",
      },
      [" alpha ", "beta", "alpha", " beta "],
      { fetcher, timeout_ms: 50 },
    );

    expect(capturedBody).toEqual({
      model: "text-embedding-3-small",
      input: ["alpha", "beta"],
    });
    expect(vectors).toEqual([
      [0.11, 0.22],
      [0.33, 0.44],
      [0.11, 0.22],
      [0.33, 0.44],
    ]);
  });

  it("fails when normalized input count and response vector count differ", async () => {
    const fetcher = async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ data: [{ embedding: [0.11, 0.22] }] }),
      text: async () => "",
    });

    await expect(
      executeEmbeddingRequest(
        {
          name: "openai",
          base_url: "https://api.example.test/v1",
          model: "text-embedding-3-small",
        },
        ["first", "second"],
        { fetcher },
      ),
    ).rejects.toThrow("Embedding response cardinality mismatch: expected 2 vector(s), received 1");
  });

  it("uses global fetch fallback when no fetcher option is provided", async () => {
    const originalFetch = globalThis.fetch;
    (globalThis as { fetch?: unknown }).fetch = (async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ embeddings: [[0.9, 0.8]] }),
      text: async () => "",
    })) as unknown;

    try {
      const vectors = await executeEmbeddingRequest(
        {
          name: "ollama",
          base_url: "http://localhost:11434",
          model: "nomic-embed-text",
        },
        "fallback token",
      );
      expect(vectors).toEqual([[0.9, 0.8]]);
    } finally {
      if (originalFetch === undefined) {
        delete (globalThis as { fetch?: unknown }).fetch;
      } else {
        (globalThis as { fetch: typeof globalThis.fetch }).fetch = originalFetch;
      }
    }
  });

  it("fails with deterministic non-ok response messages", async () => {
    const failingWithBody = async () => ({
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
      json: async () => ({}),
      text: async () => "  rate limit exceeded  ",
    });
    await expect(
      executeEmbeddingRequest(
        {
          name: "openai",
          base_url: "https://api.example.test/v1",
          model: "text-embedding-3-small",
        },
        "token",
        { fetcher: failingWithBody },
      ),
    ).rejects.toThrow("Embedding request failed with status 429 Too Many Requests: rate limit exceeded");

    const failingWithoutBody = async () => ({
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
      json: async () => ({}),
      text: async () => "   ",
    });
    await expect(
      executeEmbeddingRequest(
        {
          name: "ollama",
          base_url: "http://localhost:11434",
          model: "nomic-embed-text",
        },
        "token",
        { fetcher: failingWithoutBody },
      ),
    ).rejects.toThrow("Embedding request failed with status 503 Service Unavailable");

    const failingBodyRead = async () => ({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      json: async () => ({}),
      text: async () => {
        throw new Error("stream exploded");
      },
    });
    await expect(
      executeEmbeddingRequest(
        {
          name: "openai",
          base_url: "https://api.example.test/v1",
          model: "text-embedding-3-small",
        },
        "token",
        { fetcher: failingBodyRead },
      ),
    ).rejects.toThrow(
      "Embedding request failed with status 500 Internal Server Error: (failed to read response body: stream exploded)",
    );
  });

  it("fails with deterministic execution and payload-parse errors", async () => {
    const executionFailure = async () => {
      throw new Error("network unreachable");
    };
    await expect(
      executeEmbeddingRequest(
        {
          name: "openai",
          base_url: "https://api.example.test/v1",
          model: "text-embedding-3-small",
        },
        "token",
        { fetcher: executionFailure },
      ),
    ).rejects.toThrow("Embedding request execution failed: network unreachable");

    const executionFailureEmptyMessage = async () => {
      const failure = new Error("   ");
      failure.name = "CustomTransportError";
      throw failure;
    };
    await expect(
      executeEmbeddingRequest(
        {
          name: "openai",
          base_url: "https://api.example.test/v1",
          model: "text-embedding-3-small",
        },
        "token",
        { fetcher: executionFailureEmptyMessage },
      ),
    ).rejects.toThrow("Embedding request execution failed: CustomTransportError");

    const executionFailureNonError = () => Promise.reject("socket hang up");
    await expect(
      executeEmbeddingRequest(
        {
          name: "openai",
          base_url: "https://api.example.test/v1",
          model: "text-embedding-3-small",
        },
        "token",
        { fetcher: executionFailureNonError },
      ),
    ).rejects.toThrow("Embedding request execution failed: socket hang up");

    const malformedPayload = async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => {
        throw new Error("invalid json");
      },
      text: async () => "",
    });
    await expect(
      executeEmbeddingRequest(
        {
          name: "openai",
          base_url: "https://api.example.test/v1",
          model: "text-embedding-3-small",
        },
        "token",
        { fetcher: malformedPayload },
      ),
    ).rejects.toThrow("Embedding response JSON parse failed: invalid json");
  });

  it("fails when timeout is invalid, fetch is unavailable, or request aborts", async () => {
    await expect(
      executeEmbeddingRequest(
        {
          name: "openai",
          base_url: "https://api.example.test/v1",
          model: "text-embedding-3-small",
        },
        "token",
        {
          timeout_ms: 0,
          fetcher: async () => ({
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => ({ data: [{ embedding: [1] }] }),
            text: async () => "",
          }),
        },
      ),
    ).rejects.toThrow("Embedding request timeout must be a positive finite number");

    const originalFetch = globalThis.fetch;
    (globalThis as { fetch?: unknown }).fetch = undefined;
    try {
      await expect(
        executeEmbeddingRequest(
          {
            name: "openai",
            base_url: "https://api.example.test/v1",
            model: "text-embedding-3-small",
          },
          "token",
        ),
      ).rejects.toThrow("Embedding request execution requires a fetch implementation");
    } finally {
      if (originalFetch === undefined) {
        delete (globalThis as { fetch?: unknown }).fetch;
      } else {
        (globalThis as { fetch: typeof globalThis.fetch }).fetch = originalFetch;
      }
    }

    const abortingFetcher = (
      _url: string,
      init: { signal: AbortSignal },
    ) =>
      new Promise<{
        ok: boolean;
        status: number;
        statusText: string;
        json(): Promise<unknown>;
        text(): Promise<string>;
      }>((_, reject) => {
        init.signal.addEventListener("abort", () => {
          const abortError = new Error("aborted");
          abortError.name = "AbortError";
          reject(abortError);
        });
      });

    await expect(
      executeEmbeddingRequest(
        {
          name: "openai",
          base_url: "https://api.example.test/v1",
          model: "text-embedding-3-small",
        },
        "token",
        {
          timeout_ms: 1,
          fetcher: abortingFetcher,
        },
      ),
    ).rejects.toThrow("Embedding request timed out after 1ms");
  });
});

describe("normalizeEmbeddingResponse", () => {
  it("normalizes OpenAI data-array responses", () => {
    const vectors = normalizeEmbeddingResponse(
      {
        name: "openai",
        base_url: "https://api.example.test/v1",
        model: "text-embedding-3-small",
      },
      {
        data: [{ embedding: [0.1, 0.2] }, { embedding: [0.3, 0.4] }],
      },
    );
    expect(vectors).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
  });

  it("normalizes OpenAI data-array responses deterministically by index when provided", () => {
    const vectors = normalizeEmbeddingResponse(
      {
        name: "openai",
        base_url: "https://api.example.test/v1",
        model: "text-embedding-3-small",
      },
      {
        data: [
          { index: 2, embedding: [0.5, 0.6] },
          { index: 0, embedding: [0.1, 0.2] },
          { index: 1, embedding: [0.3, 0.4] },
        ],
      },
    );
    expect(vectors).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
      [0.5, 0.6],
    ]);
  });

  it("uses original response order as deterministic tie-break for duplicate OpenAI indexes", () => {
    const vectors = normalizeEmbeddingResponse(
      {
        name: "openai",
        base_url: "https://api.example.test/v1",
        model: "text-embedding-3-small",
      },
      {
        data: [
          { index: 1, embedding: [0.3, 0.4] },
          { index: 1, embedding: [0.5, 0.6] },
          { index: 0, embedding: [0.1, 0.2] },
        ],
      },
    );
    expect(vectors).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
      [0.5, 0.6],
    ]);
  });

  it("normalizes Ollama single and batch response shapes", () => {
    expect(
      normalizeEmbeddingResponse(
        {
          name: "ollama",
          base_url: "http://localhost:11434",
          model: "nomic-embed-text",
        },
        { embedding: [0.9, 0.8] },
      ),
    ).toEqual([[0.9, 0.8]]);

    expect(
      normalizeEmbeddingResponse(
        {
          name: "ollama",
          base_url: "http://localhost:11434",
          model: "nomic-embed-text",
        },
        { embeddings: [[0.7], [0.6]] },
      ),
    ).toEqual([[0.7], [0.6]]);
  });

  it("fails on malformed provider responses", () => {
    expect(() =>
      normalizeEmbeddingResponse(
        {
          name: "openai",
          base_url: "https://api.example.test/v1",
          model: "text-embedding-3-small",
        },
        { data: [{ embedding: ["bad"] }] },
      ),
    ).toThrow("OpenAI embedding response entry at index 0 is missing a numeric embedding vector");

    expect(() =>
      normalizeEmbeddingResponse(
        {
          name: "openai",
          base_url: "https://api.example.test/v1",
          model: "text-embedding-3-small",
        },
        { data: [] },
      ),
    ).toThrow("OpenAI embedding response must include a non-empty data array");

    expect(() =>
      normalizeEmbeddingResponse(
        {
          name: "openai",
          base_url: "https://api.example.test/v1",
          model: "text-embedding-3-small",
        },
        { data: [{ index: 0, embedding: [0.1, 0.2] }, { embedding: [0.3, 0.4] }] },
      ),
    ).toThrow("OpenAI embedding response entry at position 1 is missing a valid integer index");

    expect(() =>
      normalizeEmbeddingResponse(
        {
          name: "ollama",
          base_url: "http://localhost:11434",
          model: "nomic-embed-text",
        },
        { embeddings: [[1], ["bad"]] },
      ),
    ).toThrow("Ollama embedding response entry at index 1 is missing a numeric embedding vector");

    expect(() =>
      normalizeEmbeddingResponse(
        {
          name: "ollama",
          base_url: "http://localhost:11434",
          model: "nomic-embed-text",
        },
        {},
      ),
    ).toThrow("Ollama embedding response must include embedding or embeddings vectors");
  });
});
