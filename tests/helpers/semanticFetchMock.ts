/**
 * Shared semantic HTTP mock fixtures for semantic/vector specs.
 *
 * health-command, reindex-command, and search-cache specs all stub
 * `globalThis.fetch` for the OpenAI `/v1/embeddings` endpoint and the Qdrant
 * `/collections/pm_items/points{,/delete}?wait=true` endpoints with the same
 * `{ ok, status, statusText, json, text }` Response shape. This helper owns that
 * boilerplate so each spec only expresses the behavior under test.
 */

const EMBEDDINGS_SUFFIX = "/v1/embeddings";
const QDRANT_COLLECTION_SUFFIX = "/collections/pm_items";
const QDRANT_UPSERT_SUFFIX = "/collections/pm_items/points?wait=true";
const QDRANT_DELETE_SUFFIX = "/collections/pm_items/points/delete?wait=true";

export interface FakeResponseInit {
  ok?: boolean;
  status?: number;
  statusText?: string;
  json?: unknown;
  text?: string;
}

/** Build a minimal Response-shaped object matching the specs' inline stubs. */
export function fakeResponse({
  ok = true,
  status = 200,
  statusText = "OK",
  json = {},
  text = "",
}: FakeResponseInit = {}): Response {
  return {
    ok,
    status,
    statusText,
    json: async () => json,
    text: async () => text,
  } as unknown as Response;
}

/** Parsed `/v1/embeddings` request body (the parts the specs inspect). */
export interface EmbeddingsRequest {
  /** Raw parsed request body. */
  body: { input?: string | string[] };
  /** Normalized list of input strings (single string becomes a 1-element array). */
  inputs: string[];
  /** Convenience count: `inputs.length`. */
  inputCount: number;
}

/** Parse an `/v1/embeddings` request body into the shape specs use. */
export function parseEmbeddingsRequest(init?: RequestInit): EmbeddingsRequest {
  const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string | string[] };
  const inputs = Array.isArray(body.input) ? body.input : [body.input ?? ""];
  return { body, inputs, inputCount: inputs.length };
}

/**
 * Default embeddings response: one deterministic vector per input,
 * `[{ index, embedding: [index + 0.1, index + 0.2] }]`, matching every spec.
 */
export function embeddingsResponse(inputCount: number): Response {
  return fakeResponse({
    json: {
      data: Array.from({ length: inputCount }, (_entry, index) => ({
        index,
        embedding: [index + 0.1, index + 0.2],
      })),
    },
  });
}

/** Qdrant upsert/delete acknowledgement response used across the specs. */
export function qdrantAckResponse(): Response {
  return fakeResponse({ json: { result: { status: "acknowledged" } } });
}

export type EmbeddingsHandler = (request: EmbeddingsRequest) => Response | Promise<Response>;

export interface SemanticFetchMockOptions {
  /**
   * Embeddings handler. Defaults to one vector per input. Pass a function for
   * custom sequences (e.g. transient-failure-then-success), or omit to use the
   * default deterministic vectors.
   */
  embeddings?: EmbeddingsHandler;
  /** Qdrant collection lifecycle (`/collections/pm_items`) handler. Defaults to acknowledged. */
  qdrantCollection?: () => Response | Promise<Response>;
  /** Qdrant upsert (`/points?wait=true`) handler. Defaults to acknowledged. */
  qdrantUpsert?: () => Response | Promise<Response>;
  /** Qdrant delete (`/points/delete?wait=true`) handler. Defaults to acknowledged. */
  qdrantDelete?: () => Response | Promise<Response>;
}

export interface SemanticFetchMock {
  /** URLs of every fetch call, in order. */
  calls: string[];
  /** Lengths of every embeddings input string seen, in order. */
  inputLengths: number[];
  /** Restore the original `globalThis.fetch`. */
  restore: () => void;
}

/**
 * Install a routing `globalThis.fetch` stub for semantic/vector specs and return
 * call-capture arrays plus a restore handle. Unhandled targets throw the same
 * `Unexpected fetch target: <url>` error the inline stubs used.
 */
export function installSemanticFetchMock(options: SemanticFetchMockOptions = {}): SemanticFetchMock {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  const inputLengths: number[] = [];

  const embeddings = options.embeddings ?? ((request: EmbeddingsRequest) => embeddingsResponse(request.inputCount));
  const qdrantCollection = options.qdrantCollection ?? qdrantAckResponse;
  const qdrantUpsert = options.qdrantUpsert ?? qdrantAckResponse;
  const qdrantDelete = options.qdrantDelete ?? qdrantAckResponse;

  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const target = String(url);
    calls.push(target);
    if (target.endsWith(EMBEDDINGS_SUFFIX)) {
      const request = parseEmbeddingsRequest(init);
      inputLengths.push(...request.inputs.map((entry) => entry.length));
      return embeddings(request);
    }
    if (target.endsWith(QDRANT_COLLECTION_SUFFIX)) {
      return qdrantCollection();
    }
    if (target.endsWith(QDRANT_UPSERT_SUFFIX)) {
      return qdrantUpsert();
    }
    if (target.endsWith(QDRANT_DELETE_SUFFIX)) {
      return qdrantDelete();
    }
    throw new Error(`Unexpected fetch target: ${target}`);
  }) as typeof globalThis.fetch;

  return {
    calls,
    inputLengths,
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

/**
 * Install a `globalThis.fetch` stub that fails every request with the same
 * `{ ok: false, status, statusText, text }` shape the specs use for whole-fetch
 * failure paths. Returns a restore handle.
 */
export function installFailingFetchMock({
  status = 500,
  statusText = "Internal Server Error",
  text = "",
}: { status?: number; statusText?: string; text?: string } = {}): { restore: () => void } {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    fakeResponse({ ok: false, status, statusText, json: {}, text })) as typeof globalThis.fetch;
  return {
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}
