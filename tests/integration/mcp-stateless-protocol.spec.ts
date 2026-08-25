import { spawn } from "node:child_process";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { handleRequest, processRpcLine } from "../../src/mcp/server.js";
import {
  PM_MCP_ERROR_CODES,
  PM_MCP_META_KEYS,
  PM_MCP_PROTOCOL_VERSION,
  PmMcpProtocolError,
} from "../../src/sdk/index.js";

function modernParams(
  params: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...params,
    _meta: {
      [PM_MCP_META_KEYS.protocolVersion]: PM_MCP_PROTOCOL_VERSION,
      [PM_MCP_META_KEYS.clientCapabilities]: {},
      [PM_MCP_META_KEYS.clientInfo]: {
        name: "stateless-integration-host",
        version: "1.0.0",
      },
    },
  };
}

describe("MCP 2026-07-28 stateless server", () => {
  it("discovers deterministic versions, identity, capabilities, and cache policy", async () => {
    const first = await handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "server/discover",
      params: modernParams(),
    });
    const second = await handleRequest({
      jsonrpc: "2.0",
      id: 2,
      method: "server/discover",
      params: modernParams(),
    });
    expect(second).toEqual(first);
    expect(first).toMatchObject({
      supportedVersions: [PM_MCP_PROTOCOL_VERSION],
      capabilities: {
        prompts: { listChanged: true },
        resources: { listChanged: true },
        tools: { listChanged: true },
        extensions: {},
      },
      ttlMs: 60_000,
      cacheScope: "public",
      resultType: "complete",
      _meta: {
        [PM_MCP_META_KEYS.serverInfo]: {
          name: "pm-mcp",
          version: expect.stringMatching(/^\d+\.\d+\./u),
        },
      },
    });
  });

  it("serves each modern request from its own metadata without initialize", async () => {
    const result = await handleRequest({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/list",
      params: modernParams(),
    });
    expect(result).toMatchObject({
      resultType: "complete",
      _meta: {
        [PM_MCP_META_KEYS.serverInfo]: { name: "pm-mcp" },
      },
    });
    expect(Array.isArray(result?.tools)).toBe(true);
  });

  it("keeps unrelated legacy metadata on the unversioned adapter", async () => {
    await expect(
      handleRequest({
        jsonrpc: "2.0",
        id: 20,
        method: "ping",
        params: { _meta: { progressToken: "legacy-progress" } },
      }),
    ).resolves.toEqual({});
  });

  it("wraps every modern tools, resource, and prompt branch", async () => {
    await expect(
      handleRequest({
        jsonrpc: "2.0",
        id: 21,
        method: "tools/call",
        params: modernParams({ name: "missing/current-tool", arguments: {} }),
      }),
    ).rejects.toThrow(/Unknown pm MCP tool/u);
    await expect(
      handleRequest({
        jsonrpc: "2.0",
        id: 22,
        method: "resources/list",
        params: modernParams(),
      }),
    ).resolves.toMatchObject({
      resultType: "complete",
      resources: expect.arrayContaining([
        expect.objectContaining({ uri: "pm://workspace/context" }),
      ]),
    });
    await expect(
      handleRequest({
        jsonrpc: "2.0",
        id: 23,
        method: "resources/read",
        params: modernParams({ uri: "pm://workspace/missing" }),
      }),
    ).rejects.toThrow(/Unknown pm MCP resource/u);
    await expect(
      handleRequest({
        jsonrpc: "2.0",
        id: 24,
        method: "prompts/list",
        params: modernParams(),
      }),
    ).resolves.toMatchObject({
      resultType: "complete",
      prompts: expect.arrayContaining([
        expect.objectContaining({ name: "orient" }),
      ]),
    });
    await expect(
      handleRequest({
        jsonrpc: "2.0",
        id: 25,
        method: "prompts/get",
        params: modernParams({
          name: "orient",
          arguments: { request: "stateless delivery" },
        }),
      }),
    ).resolves.toMatchObject({
      resultType: "complete",
      messages: [
        { content: { text: expect.stringContaining("stateless delivery") } },
      ],
    });
    await expect(
      handleRequest({
        jsonrpc: "2.0",
        id: 26,
        params: modernParams(),
      }),
    ).rejects.toThrow(/MCP method not found: \(missing\)/u);
    await expect(
      handleRequest({ method: "notifications/cancelled" }),
    ).resolves.toBeUndefined();
  });

  it("serializes allocated modern protocol errors on the JSON-RPC surface", async () => {
    const writeSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    try {
      await processRpcLine(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 27,
          method: "ping",
          params: modernParams(),
        }),
      );
      expect(writeSpy).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(writeSpy.mock.calls[0]?.[0]))).toMatchObject({
        id: 27,
        error: {
          code: -32601,
          data: { removedIn: PM_MCP_PROTOCOL_VERSION },
        },
      });
      await processRpcLine(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 28,
          method: "tools/call",
          params: modernParams({
            name: "missing/current-tool",
            arguments: {},
          }),
        }),
      );
      expect(JSON.parse(String(writeSpy.mock.calls[1]?.[0]))).toMatchObject({
        id: 28,
        result: {
          isError: true,
          resultType: "complete",
          _meta: {
            [PM_MCP_META_KEYS.serverInfo]: { name: "pm-mcp" },
          },
        },
      });
      await processRpcLine(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 29,
          method: "tools/call",
          params: {
            name: "pm_context",
            arguments: {},
            _meta: {
              [PM_MCP_META_KEYS.protocolVersion]: "1900-01-01",
              [PM_MCP_META_KEYS.clientCapabilities]: {},
            },
          },
        }),
      );
      expect(JSON.parse(String(writeSpy.mock.calls[2]?.[0]))).toMatchObject({
        id: 29,
        error: { code: PM_MCP_ERROR_CODES.unsupportedProtocolVersion },
      });
    } finally {
      writeSpy.mockRestore();
    }
  });

  it("returns allocated errors for unsupported versions and removed methods", async () => {
    await expect(
      handleRequest({
        jsonrpc: "2.0",
        id: 3,
        method: "initialize",
        params: {
          protocolVersion: "1900-01-01",
          capabilities: {},
          clientInfo: { name: "obsolete-host", version: "1" },
        },
      }),
    ).rejects.toMatchObject({
      code: PM_MCP_ERROR_CODES.unsupportedProtocolVersion,
      data: {
        supported: ["2025-06-18"],
        requested: "1900-01-01",
        modern: PM_MCP_PROTOCOL_VERSION,
      },
    });
    await expect(
      handleRequest({
        jsonrpc: "2.0",
        id: 4,
        method: "server/discover",
        params: {
          _meta: {
            [PM_MCP_META_KEYS.protocolVersion]: "1900-01-01",
            [PM_MCP_META_KEYS.clientCapabilities]: {},
          },
        },
      }),
    ).rejects.toMatchObject({
      code: PM_MCP_ERROR_CODES.unsupportedProtocolVersion,
      data: {
        supported: [PM_MCP_PROTOCOL_VERSION],
        requested: "1900-01-01",
      },
    });
    await expect(
      handleRequest({
        jsonrpc: "2.0",
        id: 5,
        method: "ping",
        params: modernParams(),
      }),
    ).rejects.toMatchObject({ code: -32601 });
    await expect(
      handleRequest({
        jsonrpc: "2.0",
        id: 6,
        method: "unknown/current-method",
        params: modernParams(),
      }),
    ).rejects.toBeInstanceOf(PmMcpProtocolError);
  });

  it("serves independent modern requests over a real stdio process", async () => {
    const child = spawn(process.execPath, [path.join(process.cwd(), "dist", "mcp", "server.js")], {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PM_NO_TELEMETRY: "1",
        PM_ANALYTICS_OPTOUT: "1",
      },
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    const requests = [
      { jsonrpc: "2.0", id: 11, method: "server/discover", params: modernParams() },
      { jsonrpc: "2.0", id: 12, method: "tools/list", params: modernParams() },
      { jsonrpc: "2.0", id: 13, method: "ping", params: modernParams() },
      { jsonrpc: "2.0", id: 14, method: "missing/current", params: modernParams() },
    ];
    child.stdin.end(`${requests.map((request) => JSON.stringify(request)).join("\n")}\n`);

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error("timed out waiting for stateless MCP stdio responses"));
      }, 5_000);
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timeout);
        resolve(code);
      });
    });

    const responses = Buffer.concat(stdoutChunks)
      .toString("utf8")
      .trim()
      .split(/\n/u)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(exitCode).toBe(0);
    expect(Buffer.concat(stderrChunks).toString("utf8")).toBe("");
    expect(responses).toHaveLength(4);
    expect(responses[0]).toMatchObject({ id: 11, result: { resultType: "complete" } });
    expect(responses[1]).toMatchObject({ id: 12, result: { resultType: "complete" } });
    expect(responses[2]).toMatchObject({ id: 13, error: { code: -32601 } });
    expect(responses[3]).toMatchObject({ id: 14, error: { code: -32601 } });
  });
});
