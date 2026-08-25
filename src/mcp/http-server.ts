#!/usr/bin/env node
/**
 * @module mcp/http-server
 *
 * Serves the pm MCP dispatcher through the sessionless 2026-07-28 Streamable
 * HTTP POST binding with request-scoped JSON/SSE responses.
 */
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { PM_MCP_ERROR_CODES, PmMcpProtocolError } from "../sdk/mcp/protocol.js";
import {
  PmMcpAuthorizationError,
  authorizeMcpHttpRequest,
  buildMcpProtectedResourceMetadata,
  createMcpStaticBearerVerifier,
  type PmMcpHttpAuthorizationPolicy,
  type PmMcpProtectedResourceMetadata,
} from "../sdk/mcp/authorization.js";
import { validateMcpHttpRequestHeaders } from "../sdk/mcp/transport.js";
import {
  buildMcpToolCallErrorResult,
  closeMcpSubscription,
  handleRequest,
  isInvokedAsMcpMainModule,
  openMcpSubscription,
  resolveMcpToolSchemaForRequest,
  type JsonRpcRequest,
} from "./server.js";

/** Runtime options for one real Streamable HTTP server. */
export interface PmMcpHttpServerOptions {
  /** Local bind host. Defaults to the DNS-rebinding-safe loopback address. */
  host?: string;
  /** TCP port. Zero requests an ephemeral port. */
  port?: number;
  /** Single modern MCP POST endpoint. */
  endpointPath?: string;
  /** Exact browser origins permitted when an Origin header is present. */
  allowedOrigins?: readonly string[];
  /** Optional RFC 9728/OAuth resource-server policy. */
  authorization?: PmMcpHttpAuthorizationPolicy;
  /** Metadata served at RFC 9728 well-known paths. */
  protectedResourceMetadata?: PmMcpProtectedResourceMetadata;
  /** Maximum accepted JSON request bytes. */
  maximumBodyBytes?: number;
  /** SSE comment interval; zero disables keep-alives. */
  keepAliveMs?: number;
  /** Optional embedding dispatcher; defaults to the canonical pm MCP handler. */
  requestHandler?: (request: JsonRpcRequest) => unknown | Promise<unknown>;
}

interface ActiveHttpSubscription {
  id: string | number;
  key: symbol;
  response: ServerResponse;
  timer?: NodeJS.Timeout;
}

interface PmMcpHttpRuntime {
  activeSubscriptions: Map<symbol, ActiveHttpSubscription>;
  allowedOrigins: Set<string>;
  endpointPath: string;
  keepAliveMs: number;
  maximumBodyBytes: number;
  options: PmMcpHttpServerOptions;
}

const DEFAULT_MAXIMUM_BODY_BYTES = 1024 * 1024;
const DEFAULT_KEEP_ALIVE_MS = 15_000;
const PM_MCP_HTTP_RUNTIMES = new WeakMap<Server, PmMcpHttpRuntime>();

/** Write one SSE event and wait for transport backpressure to clear. */
export function writePmMcpSseEvent(
  response: ServerResponse,
  payload: unknown,
): Promise<void> {
  if (response.write(`data: ${JSON.stringify(payload)}\n\n`))
    return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      response.off("drain", onDrain);
      response.off("close", onClose);
    };
    const onDrain = (): void => {
      cleanup();
      resolve();
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error("MCP response stream closed during backpressure"));
    };
    response.once("drain", onDrain);
    response.once("close", onClose);
  });
}

function writeJson(
  response: ServerResponse,
  status: number,
  payload: Record<string, unknown>,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json",
    ...headers,
  });
  response.end(`${JSON.stringify(payload)}\n`);
}

function writeJsonRpcError(
  response: ServerResponse,
  id: JsonRpcRequest["id"],
  error: unknown,
): void {
  const authorizationError =
    error instanceof PmMcpAuthorizationError ? error : undefined;
  const protocolError = error instanceof PmMcpProtocolError ? error : undefined;
  const code = protocolError?.code ?? -32603;
  const clientErrorCodes = new Set([
    -32700,
    -32600,
    PM_MCP_ERROR_CODES.headerMismatch,
    PM_MCP_ERROR_CODES.unsupportedProtocolVersion,
    PM_MCP_ERROR_CODES.invalidParams,
  ]);
  const status =
    authorizationError?.httpStatus ??
    (code === -32601 ? 404 : clientErrorCodes.has(code) ? 400 : 500);
  writeJson(
    response,
    status,
    {
      jsonrpc: "2.0",
      id: id ?? null,
      error: {
        code,
        message: error instanceof Error ? error.message : "Internal MCP error",
        ...(protocolError ? { data: protocolError.data } : {}),
      },
    },
    authorizationError?.challenge
      ? { "WWW-Authenticate": authorizationError.challenge }
      : {},
  );
}

async function readRequestBody(
  request: IncomingMessage,
  maximumBytes: number,
): Promise<string> {
  const chunks: Buffer[] = [];
  let observed = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    observed += buffer.length;
    if (observed > maximumBytes) {
      throw new PmMcpProtocolError(
        "MCP HTTP request body exceeds the configured limit",
        PM_MCP_ERROR_CODES.invalidParams,
        { maximumBytes },
      );
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseJsonRpcRequest(source: string): JsonRpcRequest {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new PmMcpProtocolError("Invalid JSON-RPC request body", -32700);
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    ("jsonrpc" in value && value.jsonrpc !== "2.0") ||
    ("method" in value && typeof value.method !== "string")
  ) {
    throw new PmMcpProtocolError("Invalid JSON-RPC request", -32600);
  }
  return value as JsonRpcRequest;
}

function protectedResourcePaths(endpointPath: string): Set<string> {
  return new Set([
    "/.well-known/oauth-protected-resource",
    `/.well-known/oauth-protected-resource${endpointPath}`,
  ]);
}

function routeMcpHttpBoundary(
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL,
  runtime: PmMcpHttpRuntime,
): boolean {
  if (
    runtime.options.protectedResourceMetadata &&
    request.method === "GET" &&
    protectedResourcePaths(runtime.endpointPath).has(requestUrl.pathname)
  ) {
    writeJson(response, 200, { ...runtime.options.protectedResourceMetadata });
    return true;
  }
  if (requestUrl.pathname !== runtime.endpointPath) {
    writeJson(response, 404, { error: "Not found" });
    return true;
  }
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    writeJson(response, 405, { error: "Method not allowed" });
    return true;
  }
  const origin = request.headers.origin;
  if (origin !== undefined && !runtime.allowedOrigins.has(origin)) {
    writeJson(response, 403, { error: "Origin is not allowed" });
    return true;
  }
  const accept = request.headers.accept;
  const contentType = request.headers["content-type"];
  if (
    typeof accept !== "string" ||
    !accept.includes("application/json") ||
    !accept.includes("text/event-stream") ||
    typeof contentType !== "string" ||
    !contentType.startsWith("application/json")
  ) {
    writeJson(response, 406, {
      error: "MCP requires JSON and SSE content negotiation",
    });
    return true;
  }
  return false;
}

async function openHttpSubscription(input: {
  request: JsonRpcRequest;
  response: ServerResponse;
  runtime: PmMcpHttpRuntime;
}): Promise<void> {
  if (
    typeof input.request.id !== "string" &&
    typeof input.request.id !== "number"
  ) {
    throw new PmMcpProtocolError(
      "subscriptions/listen requires a JSON-RPC id",
      PM_MCP_ERROR_CODES.invalidParams,
    );
  }
  const subscriptionId = input.request.id;
  const subscriptionKey = Symbol("pm-mcp-http-subscription");
  input.response.setHeader("Cache-Control", "no-cache, no-store");
  input.response.setHeader("Connection", "keep-alive");
  input.response.setHeader("Content-Type", "text/event-stream");
  input.response.setHeader("X-Accel-Buffering", "no");
  await openMcpSubscription({
    request: input.request,
    key: subscriptionKey,
    sink: (notification) => writePmMcpSseEvent(input.response, notification),
  });
  const active: ActiveHttpSubscription = {
    id: subscriptionId,
    key: subscriptionKey,
    response: input.response,
  };
  if (input.runtime.keepAliveMs > 0) {
    active.timer = setInterval(
      () => input.response.write(":\r\n\r\n"),
      input.runtime.keepAliveMs,
    );
    active.timer.unref();
  }
  input.runtime.activeSubscriptions.set(subscriptionKey, active);
  input.response.once("close", () => {
    if (active.timer) clearInterval(active.timer);
    input.runtime.activeSubscriptions.delete(subscriptionKey);
    closeMcpSubscription(subscriptionId, subscriptionKey);
  });
}

async function dispatchMcpHttpRpc(input: {
  request: IncomingMessage;
  response: ServerResponse;
  requestUrl: URL;
  runtime: PmMcpHttpRuntime;
}): Promise<void> {
  let rpcRequest: JsonRpcRequest | undefined;
  try {
    if (input.runtime.options.authorization) {
      await authorizeMcpHttpRequest({
        headers: input.request.headers,
        requestUrl: input.requestUrl.href,
        policy: input.runtime.options.authorization,
      });
    }
    rpcRequest = parseJsonRpcRequest(
      await readRequestBody(input.request, input.runtime.maximumBodyBytes),
    );
    validateMcpHttpRequestHeaders({
      headers: input.request.headers,
      request: rpcRequest as Record<string, unknown>,
      toolSchema: await resolveMcpToolSchemaForRequest(rpcRequest),
    });
    if (rpcRequest.method === "subscriptions/listen") {
      await openHttpSubscription({
        request: rpcRequest,
        response: input.response,
        runtime: input.runtime,
      });
      return;
    }
    const result = await (
      input.runtime.options.requestHandler ?? handleRequest
    )(rpcRequest);
    if (!Object.prototype.hasOwnProperty.call(rpcRequest, "id")) {
      input.response.writeHead(202);
      input.response.end();
      return;
    }
    writeJson(input.response, 200, {
      jsonrpc: "2.0",
      id: rpcRequest.id ?? null,
      result: result ?? {},
    });
  } catch (error) {
    const toolError = rpcRequest
      ? buildMcpToolCallErrorResult(rpcRequest, error)
      : undefined;
    if (toolError && rpcRequest) {
      writeJson(input.response, 200, {
        jsonrpc: "2.0",
        id: rpcRequest.id ?? null,
        result: toolError,
      });
      return;
    }
    writeJsonRpcError(input.response, rpcRequest?.id, error);
  }
}

async function handleMcpHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  runtime: PmMcpHttpRuntime,
): Promise<void> {
  const requestUrl = new URL(request.url as string, "http://localhost");
  if (routeMcpHttpBoundary(request, response, requestUrl, runtime)) return;
  await dispatchMcpHttpRpc({ request, response, requestUrl, runtime });
}

/** Create a configured HTTP server without binding it. */
export function createPmMcpHttpServer(options: PmMcpHttpServerOptions = {}) {
  const runtime: PmMcpHttpRuntime = {
    activeSubscriptions: new Map<symbol, ActiveHttpSubscription>(),
    allowedOrigins: new Set(options.allowedOrigins ?? []),
    endpointPath: options.endpointPath ?? "/mcp",
    keepAliveMs: options.keepAliveMs ?? DEFAULT_KEEP_ALIVE_MS,
    maximumBodyBytes: options.maximumBodyBytes ?? DEFAULT_MAXIMUM_BODY_BYTES,
    options,
  };
  const server = createServer((request, response) => {
    void handleMcpHttpRequest(request, response, runtime);
  });
  PM_MCP_HTTP_RUNTIMES.set(server, runtime);
  server.on("close", () => {
    closeActiveHttpSubscriptions(runtime);
    PM_MCP_HTTP_RUNTIMES.delete(server);
  });
  return server;
}

function closeActiveHttpSubscriptions(runtime: PmMcpHttpRuntime): void {
  for (const [key, active] of runtime.activeSubscriptions) {
    if (active.timer) clearInterval(active.timer);
    const result = closeMcpSubscription(active.id, key) as Record<
      string,
      unknown
    >;
    active.response.write(
      `data: ${JSON.stringify({ jsonrpc: "2.0", id: active.id, result })}\n\n`,
    );
    active.response.end();
  }
  runtime.activeSubscriptions.clear();
}

/** Gracefully close subscriptions before stopping a Streamable HTTP server. */
export async function closePmMcpHttpServer(server: Server): Promise<void> {
  const runtime = PM_MCP_HTTP_RUNTIMES.get(server);
  if (runtime) closeActiveHttpSubscriptions(runtime);
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  server.closeAllConnections();
}

/** Bind the configured Streamable HTTP server and return its actual address. */
export async function startPmMcpHttpServer(
  options: PmMcpHttpServerOptions = {},
): Promise<ReturnType<typeof createPmMcpHttpServer>> {
  const server = createPmMcpHttpServer(options);
  const address = resolvePmMcpHttpListenAddress(options);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(address.port, address.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

/** Resolve loopback-safe bind defaults without opening a socket. */
export function resolvePmMcpHttpListenAddress(
  options: Pick<PmMcpHttpServerOptions, "host" | "port"> = {},
): { host: string; port: number } {
  return {
    host: options.host ?? "127.0.0.1",
    port: options.port ?? 3000,
  };
}

interface PmMcpHttpEnvironment {
  allowedOrigins: string[];
  host: string;
  issuer?: string;
  port: number;
  resource?: string;
  scopes: string[];
  token?: string;
}

function readMcpHttpEnvironment(
  environment: NodeJS.ProcessEnv,
): PmMcpHttpEnvironment {
  const port = Number(environment.PM_MCP_HTTP_PORT ?? "3000");
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("PM_MCP_HTTP_PORT must be an integer from 0 through 65535");
  }
  return {
    host: environment.PM_MCP_HTTP_HOST?.trim() || "127.0.0.1",
    port,
    allowedOrigins: (environment.PM_MCP_HTTP_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
    token: environment.PM_MCP_HTTP_BEARER_TOKEN?.trim() || undefined,
    issuer: environment.PM_MCP_HTTP_AUTH_ISSUER?.trim() || undefined,
    resource: environment.PM_MCP_HTTP_RESOURCE?.trim() || undefined,
    scopes: (environment.PM_MCP_HTTP_SCOPES ?? "pm:read pm:write")
      .split(/\s+/u)
      .filter(Boolean),
  };
}

function buildMcpHttpAuthorizationOptions(
  environment: Required<
    Pick<PmMcpHttpEnvironment, "issuer" | "resource" | "token">
  > &
    Pick<PmMcpHttpEnvironment, "scopes">,
): Pick<PmMcpHttpServerOptions, "authorization" | "protectedResourceMetadata"> {
  const metadata = buildMcpProtectedResourceMetadata({
    resource: environment.resource,
    authorizationServers: [environment.issuer],
    scopes: environment.scopes,
  });
  const acceptedIssuer = environment.issuer;
  return {
    protectedResourceMetadata: metadata,
    authorization: {
      issuer: acceptedIssuer,
      resource: metadata.resource,
      requiredScopes: environment.scopes,
      resourceMetadataUrl: new URL(
        "/.well-known/oauth-protected-resource",
        metadata.resource,
      ).href,
      verifyAccessToken: createMcpStaticBearerVerifier({
        token: environment.token,
        claims: {
          principal: "configured-remote-client",
          issuer: acceptedIssuer,
          audience: metadata.resource,
          scopes: environment.scopes,
        },
      }),
    },
  };
}

function hasCompleteMcpHttpAuthorization(
  environment: PmMcpHttpEnvironment,
): environment is PmMcpHttpEnvironment &
  Required<Pick<PmMcpHttpEnvironment, "issuer" | "resource" | "token">> {
  return Boolean(
    environment.token && environment.issuer && environment.resource,
  );
}

/** Resolve and harden executable HTTP options from an environment map. */
export function resolvePmMcpHttpServerOptionsFromEnvironment(
  processEnvironment: NodeJS.ProcessEnv = process.env,
): PmMcpHttpServerOptions {
  const environment = readMcpHttpEnvironment(processEnvironment);
  const hasAuthorization = hasCompleteMcpHttpAuthorization(environment);
  if (
    environment.host !== "127.0.0.1" &&
    environment.host !== "localhost" &&
    !hasAuthorization
  ) {
    throw new Error(
      "Non-loopback MCP HTTP requires PM_MCP_HTTP_BEARER_TOKEN, PM_MCP_HTTP_AUTH_ISSUER, and PM_MCP_HTTP_RESOURCE",
    );
  }
  const base = {
    host: environment.host,
    port: environment.port,
    allowedOrigins: environment.allowedOrigins,
  };
  return hasAuthorization
    ? {
        ...base,
        ...buildMcpHttpAuthorizationOptions({
          issuer: environment.issuer,
          resource: environment.resource,
          token: environment.token,
          scopes: environment.scopes,
        }),
      }
    : base;
}

/* c8 ignore start -- executable guard and process lifecycle are integration-tested */
if (isInvokedAsMcpMainModule(process.argv[1], import.meta.url)) {
  startPmMcpHttpServer(resolvePmMcpHttpServerOptionsFromEnvironment()).catch(
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
}
/* c8 ignore stop */
