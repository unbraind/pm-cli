import { toErrorMessage } from "../shared/primitives.js";

export const DEFAULT_SEARCH_HTTP_TIMEOUT_MS = 30_000;

export interface SearchHttpResponse {
  ok: boolean;
  status: number;
  statusText: string;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export interface SearchHttpRequestInit {
  method: "DELETE" | "POST" | "PUT";
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
}

export type SearchHttpFetcher<ResponseType extends SearchHttpResponse = SearchHttpResponse> = (
  url: string,
  init: SearchHttpRequestInit,
) => Promise<ResponseType>;

export interface ExecuteSearchJsonRequestOptions<ResponseType extends SearchHttpResponse = SearchHttpResponse> {
  endpoint: string;
  method: "DELETE" | "POST" | "PUT";
  headers: Record<string, string>;
  body: Record<string, unknown>;
  timeoutMs: number;
  fetcher: SearchHttpFetcher<ResponseType>;
  requestLabel: string;
  responseLabel: string;
}

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

export function resolveSearchHttpFetcher<ResponseType extends SearchHttpResponse>(
  fetcher: SearchHttpFetcher<ResponseType> | undefined,
  requestLabel: string,
): SearchHttpFetcher<ResponseType> {
  if (fetcher) {
    return fetcher;
  }
  if (typeof globalThis.fetch === "function") {
    return globalThis.fetch.bind(globalThis) as unknown as SearchHttpFetcher<ResponseType>;
  }
  throw new Error(`${requestLabel} execution requires a fetch implementation`);
}

export async function readFailedSearchHttpResponseBody(response: SearchHttpResponse): Promise<string> {
  try {
    return (await response.text()).replaceAll(/\s+/g, " ").trim();
  } catch (error) {
    return `(failed to read response body: ${toErrorMessage(error)})`;
  }
}

export async function executeSearchJsonRequest<ResponseType extends SearchHttpResponse>(
  options: ExecuteSearchJsonRequestOptions<ResponseType>,
): Promise<unknown> {
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
        throw new Error(`${options.requestLabel} timed out after ${options.timeoutMs}ms`);
      }
      throw new Error(`${options.requestLabel} execution failed: ${toErrorMessage(error)}`);
    }

    if (!response.ok) {
      const responseBody = await readFailedSearchHttpResponseBody(response);
      const detail = responseBody.length > 0 ? `: ${responseBody}` : "";
      throw new Error(`${options.requestLabel} failed with status ${response.status} ${response.statusText}${detail}`);
    }

    try {
      return await response.json();
    } catch (error) {
      throw new Error(`${options.responseLabel} JSON parse failed: ${toErrorMessage(error)}`);
    }
  } finally {
    clearTimeout(timeoutHandle);
  }
}
