import { EventEmitter } from "node:events";
import { request as httpRequest, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildMcpHttpRequestHeaders,
  buildMcpProtectedResourceMetadata,
  createMcpStaticBearerVerifier,
  PM_MCP_META_KEYS,
  PM_MCP_PROTOCOL_VERSION,
  PM_MCP_SUBSCRIPTION_ID_META_KEY,
} from "../../src/sdk/index.js";
import {
  _testOnly as serverTestOnly,
  closeMcpSubscription,
  openMcpSubscription,
  processRpcLine,
} from "../../src/mcp/server.js";
import {
  closePmMcpHttpServer,
  createPmMcpHttpServer,
  resolvePmMcpHttpListenAddress,
  resolvePmMcpHttpServerOptionsFromEnvironment,
  startPmMcpHttpServer,
  writePmMcpSseEvent,
} from "../../src/mcp/http-server.js";

function modernRequest(
  method: string,
  params: Record<string, unknown> = {},
  id: string | number | undefined = 1,
): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    ...(id === undefined ? {} : { id }),
    method,
    params: {
      ...params,
      _meta: {
        [PM_MCP_META_KEYS.protocolVersion]: PM_MCP_PROTOCOL_VERSION,
        [PM_MCP_META_KEYS.clientCapabilities]: {},
        [PM_MCP_META_KEYS.clientInfo]: { name: "http-test", version: "1" },
      },
    },
  };
}

const servers: ReturnType<typeof createPmMcpHttpServer>[] = [];

async function startServer(
  options: Parameters<typeof startPmMcpHttpServer>[0] = {},
): Promise<{
  baseUrl: string;
  server: ReturnType<typeof createPmMcpHttpServer>;
}> {
  const server = await startPmMcpHttpServer({ ...options, port: 0 });
  servers.push(server);
  const address = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${address.port}`, server };
}

async function stopServer(
  server: ReturnType<typeof createPmMcpHttpServer>,
): Promise<void> {
  await closePmMcpHttpServer(server);
  const index = servers.indexOf(server);
  if (index >= 0) servers.splice(index, 1);
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(stopServer));
});

describe("MCP 2026-07-28 Streamable HTTP", () => {
  it("rejects transport adapters that bypass subscription request validation", async () => {
    const sink = vi.fn();
    await expect(
      openMcpSubscription({
        request: {
          jsonrpc: "2.0",
          id: null,
          method: "subscriptions/listen",
        },
        sink,
      }),
    ).rejects.toThrow(/Invalid MCP subscriptions/u);
    await expect(
      openMcpSubscription({
        request: { jsonrpc: "2.0", id: "wrong-method", method: "tools/list" },
        sink,
      }),
    ).rejects.toThrow(/Invalid MCP subscriptions/u);
    expect(sink).not.toHaveBeenCalled();
  });

  it("scopes duplicate ids and prunes failed transport sinks", async () => {
    const request = modernRequest(
      "subscriptions/listen",
      {
        notifications: {
          resourceSubscriptions: ["pm://workspace/context"],
        },
      },
      "transport-scope",
    );
    const failedKey = Symbol("failed-http-stream");
    await openMcpSubscription({
      request,
      key: failedKey,
      sink: (notification) => {
        if (!notification.method.includes("acknowledged")) {
          throw new Error("closed transport");
        }
      },
    });
    await expect(
      openMcpSubscription({ request, key: failedKey, sink: vi.fn() }),
    ).rejects.toThrow(/already active/u);

    const healthyKey = Symbol("healthy-http-stream");
    const healthy = vi.fn();
    await openMcpSubscription({
      request: modernRequest(
        "subscriptions/listen",
        { notifications: { toolsListChanged: true } },
        "transport-scope",
      ),
      key: healthyKey,
      sink: healthy,
    });
    await serverTestOnly.emitMcpChangeNotifications("install");
    expect(healthy).toHaveBeenCalledWith(
      expect.objectContaining({ method: "notifications/tools/list_changed" }),
    );
    expect(serverTestOnly.subscriptionCount()).toBe(1);
    expect(closeMcpSubscription("transport-scope", healthyKey)).toMatchObject({
      resultType: "complete",
    });
  });

  it("closes only stdio-owned streams during stdio shutdown", async () => {
    const scopedKey = Symbol("http-stream");
    await openMcpSubscription({
      request: modernRequest(
        "subscriptions/listen",
        { notifications: {} },
        "shared-id",
      ),
      key: scopedKey,
      sink: vi.fn(),
    });
    await openMcpSubscription({
      request: modernRequest(
        "subscriptions/listen",
        { notifications: {} },
        "stdio-id",
      ),
      sink: vi.fn(),
    });
    expect(serverTestOnly.closeStdioMcpSubscriptions()).toEqual([
      expect.objectContaining({ id: "stdio-id" }),
    ]);
    expect(closeMcpSubscription("shared-id", scopedKey)).toMatchObject({
      resultType: "complete",
    });
  });

  it("preserves SSE ordering through drain and rejects closed backpressure", async () => {
    class BackpressuredResponse extends EventEmitter {
      readonly writes: string[] = [];

      write(value: string): boolean {
        this.writes.push(value);
        return false;
      }
    }
    const drained = new BackpressuredResponse();
    const pendingDrain = writePmMcpSseEvent(
      drained as unknown as ServerResponse,
      { ok: true },
    );
    drained.emit("drain");
    await expect(pendingDrain).resolves.toBeUndefined();
    expect(drained.writes).toEqual(['data: {"ok":true}\n\n']);

    const closed = new BackpressuredResponse();
    const pendingClose = writePmMcpSseEvent(
      closed as unknown as ServerResponse,
      { ok: false },
    );
    closed.emit("close");
    await expect(pendingClose).rejects.toThrow(/backpressure/u);
  });

  it("enforces endpoint, origin, content negotiation, headers, and JSON-RPC status mapping", async () => {
    const { baseUrl, server } = await startServer({ maximumBodyBytes: 512 });
    await expect(fetch(`${baseUrl}/missing`)).resolves.toMatchObject({
      status: 404,
    });
    await expect(fetch(`${baseUrl}/mcp`)).resolves.toMatchObject({
      status: 405,
    });
    await expect(
      fetch(`${baseUrl}/mcp`, { method: "POST", body: "{}" }),
    ).resolves.toMatchObject({ status: 406 });
    await expect(
      fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: { Accept: "application/json, text/event-stream" },
        body: "{}",
      }),
    ).resolves.toMatchObject({ status: 406 });
    await expect(
      fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: "{}",
      }),
    ).resolves.toMatchObject({ status: 406 });
    await expect(
      fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: {
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
          Origin: "https://attacker.test",
        },
        body: "{}",
      }),
    ).resolves.toMatchObject({ status: 403 });

    const discover = modernRequest("server/discover");
    const discoverResponse = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: buildMcpHttpRequestHeaders({ request: discover }),
      body: JSON.stringify(discover),
    });
    expect(discoverResponse.status).toBe(200);
    await expect(discoverResponse.json()).resolves.toMatchObject({
      id: 1,
      result: {
        resultType: "complete",
        capabilities: { resources: { subscribe: true } },
      },
    });

    const mismatched = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        ...buildMcpHttpRequestHeaders({ request: discover }),
        "Mcp-Method": "tools/list",
      },
      body: JSON.stringify(discover),
    });
    expect(mismatched.status).toBe(400);
    await expect(mismatched.json()).resolves.toMatchObject({
      error: { code: -32020 },
    });

    const missing = modernRequest("missing/current");
    const missingResponse = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: buildMcpHttpRequestHeaders({ request: missing }),
      body: JSON.stringify(missing),
    });
    expect(missingResponse.status).toBe(404);
    await expect(missingResponse.json()).resolves.toMatchObject({
      error: { code: -32601 },
    });

    const invalidJson = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
      },
      body: "{",
    });
    expect(invalidJson.status).toBe(400);
    await expect(invalidJson.json()).resolves.toMatchObject({
      error: { code: -32700 },
    });

    const oversized = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: buildMcpHttpRequestHeaders({ request: discover }),
      body: JSON.stringify({ ...discover, padding: "x".repeat(600) }),
    });
    expect(oversized.status).toBe(400);

    const invalidRequest = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
      },
      body: JSON.stringify([]),
    });
    expect(invalidRequest.status).toBe(400);

    const notification = modernRequest("notifications/cancelled", {
      requestId: 999,
    });
    delete notification.id;
    const notificationResponse = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: buildMcpHttpRequestHeaders({ request: notification }),
      body: JSON.stringify(notification),
    });
    expect(notificationResponse.status).toBe(202);
    expect(await notificationResponse.text()).toBe("");

    const missingTool = modernRequest("tools/call", {
      name: "missing/current-tool",
      arguments: {},
    });
    const toolResponse = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: buildMcpHttpRequestHeaders({ request: missingTool }),
      body: JSON.stringify(missingTool),
    });
    expect(toolResponse.status).toBe(200);
    await expect(toolResponse.json()).resolves.toMatchObject({
      result: { isError: true, resultType: "complete" },
    });
    const anonymousTool = { ...missingTool, id: null };
    const anonymousToolResponse = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: buildMcpHttpRequestHeaders({ request: anonymousTool }),
      body: JSON.stringify(anonymousTool),
    });
    await expect(anonymousToolResponse.json()).resolves.toMatchObject({
      id: null,
      result: { isError: true },
    });
    const namelessTool = modernRequest("tools/call", { arguments: {} });
    const namelessToolResponse = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        "MCP-Protocol-Version": PM_MCP_PROTOCOL_VERSION,
        "Mcp-Method": "tools/call",
      },
      body: JSON.stringify(namelessTool),
    });
    expect(namelessToolResponse.status).toBe(400);
    await stopServer(server);
  });

  it("maps embedding failures without exposing non-Error values", async () => {
    for (const [requestHandler, expectedMessage] of [
      [() => undefined, undefined],
      [
        () => {
          throw new Error("embedding failed");
        },
        "embedding failed",
      ],
      [
        () => {
          throw "private failure";
        },
        "Internal MCP error",
      ],
    ] as const) {
      const { baseUrl, server } = await startServer({ requestHandler });
      const request = modernRequest("server/discover", {}, null as never);
      const response = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: buildMcpHttpRequestHeaders({ request }),
        body: JSON.stringify(request),
      });
      expect(response.status).toBe(expectedMessage ? 500 : 200);
      const body = await response.json();
      if (expectedMessage)
        expect(body).toMatchObject({ error: { message: expectedMessage } });
      else expect(body).toMatchObject({ id: null, result: {} });
      await stopServer(server);
    }
  });

  it("refuses anonymous subscriptions and resolves hardened executable options", async () => {
    const { baseUrl, server } = await startServer();
    const listen = modernRequest("subscriptions/listen", { notifications: {} });
    delete listen.id;
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: buildMcpHttpRequestHeaders({ request: listen }),
      body: JSON.stringify(listen),
    });
    expect(response.status).toBe(400);
    await stopServer(server);

    expect(resolvePmMcpHttpListenAddress()).toEqual({
      host: "127.0.0.1",
      port: 3000,
    });
    expect(
      resolvePmMcpHttpListenAddress({ host: "localhost", port: 0 }),
    ).toEqual({ host: "localhost", port: 0 });
    expect(resolvePmMcpHttpServerOptionsFromEnvironment({})).toMatchObject({
      host: "127.0.0.1",
      port: 3000,
      allowedOrigins: [],
    });
    expect(
      resolvePmMcpHttpServerOptionsFromEnvironment({
        PM_MCP_HTTP_HOST: "localhost",
      }),
    ).not.toHaveProperty("authorization");
    for (const port of ["not-a-port", "-1", "65536"]) {
      expect(() =>
        resolvePmMcpHttpServerOptionsFromEnvironment({
          PM_MCP_HTTP_PORT: port,
        }),
      ).toThrow(/PM_MCP_HTTP_PORT/u);
    }
    expect(() =>
      resolvePmMcpHttpServerOptionsFromEnvironment({
        PM_MCP_HTTP_HOST: "0.0.0.0",
      }),
    ).toThrow(/Non-loopback/u);
    const configured = resolvePmMcpHttpServerOptionsFromEnvironment({
      PM_MCP_HTTP_HOST: " 0.0.0.0 ",
      PM_MCP_HTTP_PORT: "8443",
      PM_MCP_HTTP_ALLOWED_ORIGINS: " https://one.test, ,https://two.test ",
      PM_MCP_HTTP_BEARER_TOKEN: " token ",
      PM_MCP_HTTP_AUTH_ISSUER: " https://auth.example.test ",
      PM_MCP_HTTP_RESOURCE: " https://mcp.example.test/mcp ",
      PM_MCP_HTTP_SCOPES: "pm:read   pm:write",
    });
    expect(configured).toMatchObject({
      host: "0.0.0.0",
      port: 8443,
      allowedOrigins: ["https://one.test", "https://two.test"],
      protectedResourceMetadata: {
        authorization_servers: ["https://auth.example.test"],
      },
    });
    expect(configured.authorization?.verifyAccessToken("token")).toMatchObject({
      principal: "configured-remote-client",
    });
  });

  it("surfaces bind conflicts and accepts HTTP/1.0 requests without Host", async () => {
    const { server } = await startServer();
    const address = server.address() as AddressInfo;
    await expect(
      startPmMcpHttpServer({ host: "127.0.0.1", port: address.port }),
    ).rejects.toMatchObject({ code: "EADDRINUSE" });
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(
        {
          host: "127.0.0.1",
          port: address.port,
          path: "/missing",
          method: "GET",
          setHost: false,
        },
        (response) => {
          response.resume();
          response.once("end", () => resolve(response.statusCode));
        },
      );
      request.once("error", reject);
      request.end();
    });
    expect(status).toBe(400);
    await stopServer(server);
  });

  it("reports close failures from embedding servers", async () => {
    const server = {
      close: (callback: (error?: Error) => void) =>
        callback(new Error("close failed")),
      closeAllConnections: vi.fn(),
    };
    await expect(closePmMcpHttpServer(server as never)).rejects.toThrow(
      "close failed",
    );
    expect(server.closeAllConnections).not.toHaveBeenCalled();
  });

  it("serves protected-resource metadata and issuer-bound bearer challenges", async () => {
    const resource = "http://127.0.0.1/mcp";
    const issuer = "https://auth.example.test";
    const metadata = buildMcpProtectedResourceMetadata({
      resource,
      authorizationServers: [issuer],
      scopes: ["pm:read"],
    });
    const policy = {
      issuer,
      resource: metadata.resource,
      requiredScopes: ["pm:read"],
      resourceMetadataUrl:
        "http://127.0.0.1/.well-known/oauth-protected-resource",
      verifyAccessToken: createMcpStaticBearerVerifier({
        token: "test-token",
        claims: {
          principal: "test-client",
          issuer,
          audience: metadata.resource,
          scopes: ["pm:read"],
        },
      }),
    };
    const { baseUrl, server } = await startServer({
      authorization: policy,
      protectedResourceMetadata: metadata,
    });
    const metadataResponse = await fetch(
      `${baseUrl}/.well-known/oauth-protected-resource/mcp`,
    );
    expect(metadataResponse.status).toBe(200);
    await expect(metadataResponse.json()).resolves.toEqual(metadata);

    const discover = modernRequest("server/discover");
    const headers = buildMcpHttpRequestHeaders({ request: discover });
    const unauthorized = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify(discover),
    });
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("www-authenticate")).toContain(
      "resource_metadata",
    );
    const authorized = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { ...headers, Authorization: "Bearer test-token" },
      body: JSON.stringify(discover),
    });
    expect(authorized.status).toBe(200);
    await stopServer(server);
  });

  it("streams subscription acknowledgment and closes cleanly without SSE replay ids", async () => {
    const { baseUrl, server } = await startServer({ keepAliveMs: 5 });
    const controller = new AbortController();
    const listen = modernRequest(
      "subscriptions/listen",
      { notifications: { toolsListChanged: true } },
      "listen-http",
    );
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: buildMcpHttpRequestHeaders({ request: listen }),
      body: JSON.stringify(listen),
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    const reader = response.body?.getReader();
    const first = await reader?.read();
    const decoded = new TextDecoder().decode(first?.value);
    expect(decoded).toContain("notifications/subscriptions/acknowledged");
    expect(decoded).not.toContain("id:");
    const keepAlive = await Promise.race([
      reader?.read(),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("subscription stream stopped")), 100),
      ),
    ]);
    expect(new TextDecoder().decode(keepAlive?.value)).toContain(":");
    const finalRead = reader?.read();
    await stopServer(server);
    const finalEvent = new TextDecoder().decode((await finalRead)?.value);
    expect(finalEvent).toContain('"resultType":"complete"');
    controller.abort();
    await reader?.cancel().catch(() => undefined);
  });

  it("allows independent HTTP clients to reuse a JSON-RPC subscription id", async () => {
    const { baseUrl, server } = await startServer({ keepAliveMs: 0 });
    const listen = modernRequest(
      "subscriptions/listen",
      { notifications: {} },
      "client-local-id",
    );
    const open = () =>
      fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: buildMcpHttpRequestHeaders({ request: listen }),
        body: JSON.stringify(listen),
      });
    const [firstResponse, secondResponse] = await Promise.all([open(), open()]);
    const firstReader = firstResponse.body?.getReader();
    const secondReader = secondResponse.body?.getReader();
    for (const reader of [firstReader, secondReader]) {
      const acknowledgment = await reader?.read();
      expect(new TextDecoder().decode(acknowledgment?.value)).toContain(
        "notifications/subscriptions/acknowledged",
      );
    }
    const firstFinal = firstReader?.read();
    const secondFinal = secondReader?.read();
    await stopServer(server);
    for (const final of [firstFinal, secondFinal]) {
      expect(new TextDecoder().decode((await final)?.value)).toContain(
        '"resultType":"complete"',
      );
    }
  });

  it("closes a timer-free stream after a client disconnect", async () => {
    const { baseUrl, server } = await startServer({ keepAliveMs: 0 });
    const controller = new AbortController();
    const listen = modernRequest(
      "subscriptions/listen",
      { notifications: {} },
      "timer-free",
    );
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: buildMcpHttpRequestHeaders({ request: listen }),
      body: JSON.stringify(listen),
      signal: controller.signal,
    });
    const reader = response.body?.getReader();
    const acknowledgment = await reader?.read();
    expect(new TextDecoder().decode(acknowledgment?.value)).toContain(
      "notifications/subscriptions/acknowledged",
    );
    controller.abort();
    await reader?.cancel().catch(() => undefined);
    await stopServer(server);
  });

  it("supports correlated stdio subscription acknowledgment and cancellation", async () => {
    const writeSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    try {
      const listen = modernRequest(
        "subscriptions/listen",
        { notifications: { resourcesListChanged: true } },
        777,
      );
      await processRpcLine(JSON.stringify(listen));
      expect(JSON.parse(String(writeSpy.mock.calls[0]?.[0]))).toMatchObject({
        method: "notifications/subscriptions/acknowledged",
        params: { _meta: { [PM_MCP_SUBSCRIPTION_ID_META_KEY]: 777 } },
      });
      await processRpcLine(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: 777 },
        }),
      );
      expect(JSON.parse(String(writeSpy.mock.calls[1]?.[0]))).toMatchObject({
        id: 777,
        result: {
          resultType: "complete",
          _meta: { [PM_MCP_SUBSCRIPTION_ID_META_KEY]: 777 },
        },
      });
      expect(closeMcpSubscription(777)).toBeUndefined();
      const writeCount = writeSpy.mock.calls.length;
      await processRpcLine(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: "missing-subscription" },
        }),
      );
      expect(writeSpy).toHaveBeenCalledTimes(writeCount);
    } finally {
      writeSpy.mockRestore();
    }
  });
});
