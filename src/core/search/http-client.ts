/**
 * @module core/search/http-client
 *
 * Powers search, embeddings, and semantic retrieval behavior for Http Client.
 */
import { toErrorMessage } from "../shared/primitives.js";

const DEFAULT_SEARCH_HTTP_TIMEOUT_MS = 30_000;

/** Documents the search http response payload exchanged by command, SDK, and package integrations. */
export interface SearchHttpResponse {
  /** Whether the operation completed without a blocking failure. */
  ok: boolean;
  /** Lifecycle state reported for status. */
  status: number;
  /** Value that configures or reports status text for this contract. */
  statusText: string;
  /** Value that configures or reports json for this contract. */
  json(): Promise<unknown>;
  /** Value that configures or reports text for this contract. */
  text(): Promise<string>;
}

/** Documents the search http request init payload exchanged by command, SDK, and package integrations. */
export interface SearchHttpRequestInit {
  /** Value that configures or reports method for this contract. */
  method: "DELETE" | "POST" | "PUT";
  /** Value that configures or reports headers for this contract. */
  headers: Record<string, string>;
  /** Value that configures or reports body for this contract. */
  body: string;
  /** Value that configures or reports signal for this contract. */
  signal: AbortSignal;
}

/** Restricts search http fetcher values accepted by command, SDK, and storage contracts. */
export type SearchHttpFetcher<
  ResponseType extends SearchHttpResponse = SearchHttpResponse,
> = (url: string, init: SearchHttpRequestInit) => Promise<ResponseType>;

/** Documents the execute search json request options payload exchanged by command, SDK, and package integrations. */
export interface ExecuteSearchJsonRequestOptions<
  ResponseType extends SearchHttpResponse = SearchHttpResponse,
> {
  /** Value that configures or reports endpoint for this contract. */
  endpoint: string;
  /** Value that configures or reports method for this contract. */
  method: "DELETE" | "POST" | "PUT";
  /** Value that configures or reports headers for this contract. */
  headers: Record<string, string>;
  /** Value that configures or reports body for this contract. */
  body: Record<string, unknown>;
  /** Elapsed time in milliseconds for timeout. */
  timeoutMs: number;
  /** Value that configures or reports fetcher for this contract. */
  fetcher: SearchHttpFetcher<ResponseType>;
  /** Value that configures or reports request label for this contract. */
  requestLabel: string;
  /** Value that configures or reports response label for this contract. */
  responseLabel: string;
}

/** Implements normalize search http timeout ms for the public runtime surface of this module. */
export function normalizeSearchHttpTimeoutMs(
  timeoutMs: number | undefined,
  requestLabel: string,
  defaultTimeoutMs = DEFAULT_SEARCH_HTTP_TIMEOUT_MS,
): number {
  const resolved = timeoutMs ?? defaultTimeoutMs;
  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw new Error(`${requestLabel} timeout must be a positive finite number`);
  }
  return Math.floor(resolved);
}

/** Implements resolve search http fetcher for the public runtime surface of this module. */
export function resolveSearchHttpFetcher<
  ResponseType extends SearchHttpResponse,
>(
  fetcher: SearchHttpFetcher<ResponseType> | undefined,
  requestLabel: string,
): SearchHttpFetcher<ResponseType> {
  if (fetcher) {
    return fetcher;
  }
  if (typeof globalThis.fetch === "function") {
    return globalThis.fetch.bind(
      globalThis,
    ) as unknown as SearchHttpFetcher<ResponseType>;
  }
  throw new Error(`${requestLabel} execution requires a fetch implementation`);
}

/** Implements read failed search http response body for the public runtime surface of this module. */
export async function readFailedSearchHttpResponseBody(
  response: SearchHttpResponse,
): Promise<string> {
  try {
    return (await response.text()).replaceAll(/\s+/g, " ").trim();
  } catch (error) {
    return `(failed to read response body: ${toErrorMessage(error)})`;
  }
}

/** Implements execute search json request for the public runtime surface of this module. */
export async function executeSearchJsonRequest<
  ResponseType extends SearchHttpResponse,
>(options: ExecuteSearchJsonRequestOptions<ResponseType>): Promise<unknown> {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => {
    controller.abort();
  }, options.timeoutMs);

  try {
    let response: ResponseType;
    try {
      response = await options.fetcher(options.endpoint, {
        method: options.method,
        headers: options.headers,
        body: JSON.stringify(options.body),
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(
          `${options.requestLabel} timed out after ${options.timeoutMs}ms`,
        );
      }
      throw new Error(
        `${options.requestLabel} execution failed: ${toErrorMessage(error)}`,
      );
    }

    if (!response.ok) {
      const responseBody = await readFailedSearchHttpResponseBody(response);
      const detail = responseBody.length > 0 ? `: ${responseBody}` : "";
      throw new Error(
        `${options.requestLabel} failed with status ${response.status} ${response.statusText}${detail}`,
      );
    }

    try {
      return await response.json();
    } catch (error) {
      throw new Error(
        `${options.responseLabel} JSON parse failed: ${toErrorMessage(error)}`,
      );
    }
  } finally {
    clearTimeout(timeoutHandle);
  }
}
