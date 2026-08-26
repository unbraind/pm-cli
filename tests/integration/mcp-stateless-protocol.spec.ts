import { spawn } from "node:child_process";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { handleRequest, processRpcLine } from "../../src/mcp/server.js";
import {
  PM_MCP_ERROR_CODES,
  PM_MCP_META_KEYS,
  PM_MCP_PROTOCOL_VERSION,
  PM_MCP_APPS_EXTENSION,
  PM_MCP_APPS_SERVER_CAPABILITY,
  PM_MCP_APP_MIME_TYPE,
  PM_MCP_SKILLS_EXTENSION,
  PM_MCP_SKILLS_SERVER_CAPABILITY,
  PM_MCP_TASKS_EXTENSION,
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

function modernTaskParams(
  params: Record<string, unknown> = {},
): Record<string, unknown> {
  const result = modernParams(params);
  const meta = result._meta as Record<string, unknown>;
  meta[PM_MCP_META_KEYS.clientCapabilities] = {
    extensions: { [PM_MCP_TASKS_EXTENSION]: {} },
  };
  return result;
}

function modernExtensionParams(
  extension: string,
  capability: Record<string, unknown>,
  params: Record<string, unknown> = {},
): Record<string, unknown> {
  const result = modernParams(params);
  const meta = result._meta as Record<string, unknown>;
  meta[PM_MCP_META_KEYS.clientCapabilities] = {
    extensions: { [extension]: capability },
  };
  return result;
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
        extensions: { [PM_MCP_TASKS_EXTENSION]: {} },
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
      ttlMs: 30_000,
      cacheScope: "private",
      _meta: {
        [PM_MCP_META_KEYS.serverInfo]: { name: "pm-mcp" },
      },
    });
    expect(Array.isArray(result?.tools)).toBe(true);
  });

  it("negotiates stable MCP Apps tools and self-contained UI resources", async () => {
    const tools = await handleRequest({
      jsonrpc: "2.0",
      id: 300,
      method: "tools/list",
      params: modernExtensionParams(
        PM_MCP_APPS_EXTENSION,
        PM_MCP_APPS_SERVER_CAPABILITY,
      ),
    });
    expect(tools?.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "pm_context",
          _meta: expect.objectContaining({
            ui: expect.objectContaining({ resourceUri: "ui://pm/context.html" }),
          }),
        }),
      ]),
    );
    const resources = await handleRequest({
      jsonrpc: "2.0",
      id: 301,
      method: "resources/list",
      params: modernExtensionParams(
        PM_MCP_APPS_EXTENSION,
        PM_MCP_APPS_SERVER_CAPABILITY,
      ),
    });
    expect(resources?.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          uri: "ui://pm/context.html",
          mimeType: PM_MCP_APP_MIME_TYPE,
        }),
      ]),
    );
    const incompatibleParams = modernExtensionParams(
      PM_MCP_APPS_EXTENSION,
      {
        specVersion: "1900-01-01",
        mimeTypes: [PM_MCP_APP_MIME_TYPE],
      },
    );
    await expect(
      handleRequest({
        jsonrpc: "2.0",
        id: 3011,
        method: "tools/list",
        params: incompatibleParams,
      }),
    ).resolves.not.toMatchObject({
      tools: expect.arrayContaining([
        expect.objectContaining({ _meta: { ui: expect.anything() } }),
      ]),
    });
    await expect(
      handleRequest({
        jsonrpc: "2.0",
        id: 3012,
        method: "resources/list",
        params: incompatibleParams,
      }),
    ).resolves.not.toMatchObject({
      resources: expect.arrayContaining([
        expect.objectContaining({ uri: "ui://pm/context.html" }),
      ]),
    });
    const capabilityFailure = new Error("client capability access failed");
    const failingParams = modernParams();
    const failingMeta = failingParams._meta as Record<string, unknown>;
    failingMeta[PM_MCP_META_KEYS.clientCapabilities] = new Proxy(
      {},
      {
        get(_target, property) {
          if (property === "extensions") throw capabilityFailure;
          return undefined;
        },
      },
    );
    await expect(
      handleRequest({
        jsonrpc: "2.0",
        id: 3013,
        method: "tools/list",
        params: failingParams,
      }),
    ).rejects.toBe(capabilityFailure);
    const resource = await handleRequest({
      jsonrpc: "2.0",
      id: 302,
      method: "resources/read",
      params: modernExtensionParams(
        PM_MCP_APPS_EXTENSION,
        PM_MCP_APPS_SERVER_CAPABILITY,
        { uri: "ui://pm/context.html" },
      ),
    });
    expect(resource).toMatchObject({
      resultType: "complete",
      contents: [
        {
          uri: "ui://pm/context.html",
          mimeType: PM_MCP_APP_MIME_TYPE,
          text: expect.stringContaining("ui/initialize"),
          _meta: { ui: { prefersBorder: true } },
        },
      ],
    });
    await expect(
      handleRequest({
        jsonrpc: "2.0",
        id: 303,
        method: "resources/read",
        params: modernParams({ uri: "ui://pm/context.html" }),
      }),
    ).rejects.toMatchObject({ code: PM_MCP_ERROR_CODES.missingRequiredClientCapability });
    await expect(
      handleRequest({
        jsonrpc: "2.0",
        id: 3031,
        method: "resources/read",
        params: {
          ...incompatibleParams,
          uri: "ui://pm/context.html",
        },
      }),
    ).rejects.toMatchObject({
      code: PM_MCP_ERROR_CODES.missingRequiredClientCapability,
    });
  });

  it("negotiates draft Skills over MCP list, get, resource, and directory reads", async () => {
    const extensionParams = (params: Record<string, unknown> = {}) =>
      modernExtensionParams(
        PM_MCP_SKILLS_EXTENSION,
        PM_MCP_SKILLS_SERVER_CAPABILITY,
        params,
      );
    const listed = await handleRequest({
      jsonrpc: "2.0",
      id: 310,
      method: "skills/list",
      params: extensionParams({ limit: 2 }),
    });
    expect(listed).toMatchObject({
      resultType: "complete",
      hasMore: true,
      skills: expect.arrayContaining([
        expect.objectContaining({ uri: "skill://pm-developer/SKILL.md" }),
      ]),
    });
    const listedNext = await handleRequest({
      jsonrpc: "2.0",
      id: 3101,
      method: "skills/list",
      params: extensionParams({ cursor: listed?.nextCursor }),
    });
    expect(listedNext).toMatchObject({ resultType: "complete", hasMore: false });
    const skill = await handleRequest({
      jsonrpc: "2.0",
      id: 311,
      method: "skills/get",
      params: extensionParams({ uri: "skill://pm-sdk/SKILL.md" }),
    });
    expect(skill).toMatchObject({
      skill: {
        frontmatter: { name: "pm-sdk" },
        _meta: { origin: "package", trust: "untrusted" },
      },
    });
    const file = await handleRequest({
      jsonrpc: "2.0",
      id: 312,
      method: "resources/read",
      params: extensionParams({ uri: "skill://pm-sdk/SKILL.md" }),
    });
    expect(file).toMatchObject({
      contents: [
        {
          uri: "skill://pm-sdk/SKILL.md",
          text: expect.stringContaining("# pm SDK Skill"),
          _meta: { digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u) },
        },
      ],
    });
    const directory = await handleRequest({
      jsonrpc: "2.0",
      id: 313,
      method: "resources/directory/read",
      params: extensionParams({ uri: "skill://pm-sdk", limit: 1 }),
    });
    expect(directory?.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ uri: expect.stringMatching(/^skill:\/\/pm-sdk\//u) }),
      ]),
    );
    const directoryNext = await handleRequest({
      jsonrpc: "2.0",
      id: 3131,
      method: "resources/directory/read",
      params: extensionParams({
        uri: "skill://pm-sdk",
        cursor: directory?.nextCursor,
      }),
    });
    expect([...(directory?.resources ?? []), ...(directoryNext?.resources ?? [])]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ uri: "skill://pm-sdk/SKILL.md" }),
        expect.objectContaining({
          uri: "skill://pm-sdk/references",
          mimeType: "inode/directory",
        }),
      ]),
    );
    await expect(
      handleRequest({
        jsonrpc: "2.0",
        id: 3132,
        method: "skills/get",
        params: extensionParams({
          uri: "skill://pm-user/SKILL.md",
          cwd: process.cwd(),
        }),
      }),
    ).resolves.toMatchObject({ skill: { frontmatter: { name: "pm-user" } } });
    await expect(
      handleRequest({
        jsonrpc: "2.0",
        id: 314,
        method: "skills/list",
        params: modernParams(),
      }),
    ).rejects.toMatchObject({ code: PM_MCP_ERROR_CODES.missingRequiredClientCapability });
    for (const [id, method, params] of [
      [315, "skills/list", extensionParams({ cursor: 123 })],
      [316, "skills/list", extensionParams({ limit: "2" })],
      [317, "resources/directory/read", extensionParams({ uri: "skill://pm-sdk", limit: "2" })],
    ] as const) {
      await expect(
        handleRequest({ jsonrpc: "2.0", id, method, params }),
      ).rejects.toMatchObject({ code: PM_MCP_ERROR_CODES.invalidParams });
    }
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
      ttlMs: 60_000,
      cacheScope: "public",
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
      ttlMs: 60_000,
      cacheScope: "public",
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

  it("serves cacheable templates and uses Invalid Params for missing resources", async () => {
    await expect(
      handleRequest({
        jsonrpc: "2.0",
        id: 40,
        method: "resources/templates/list",
        params: modernParams(),
      }),
    ).resolves.toMatchObject({
      resultType: "complete",
      resourceTemplates: [],
      ttlMs: 60_000,
      cacheScope: "public",
    });
    await expect(
      handleRequest({
        jsonrpc: "2.0",
        id: 41,
        method: "resources/read",
        params: modernParams({ uri: "pm://workspace/missing" }),
      }),
    ).rejects.toMatchObject({ code: PM_MCP_ERROR_CODES.invalidParams });
    await expect(
      handleRequest({
        jsonrpc: "2.0",
        id: 410,
        method: "resources/read",
        params: modernParams({ uri: "pm://workspace/agent-guide" }),
      }),
    ).resolves.toMatchObject({
      resultType: "complete",
      ttlMs: 0,
      cacheScope: "private",
      contents: expect.any(Array),
    });
    await expect(
      handleRequest({
        jsonrpc: "2.0",
        id: 411,
        method: "resources/read",
        params: modernParams(),
      }),
    ).rejects.toThrow(/Missing required argument: uri/u);
  });

  it("negotiates durable asynchronous tool calls and official task methods", async () => {
    const taskParams = modernTaskParams({
      name: "pm_validate",
      arguments: { options: { checkHistoryDrift: true } },
    });
    const created = await handleRequest({
      jsonrpc: "2.0",
      id: 42,
      method: "tools/call",
      params: taskParams,
    });
    expect(created).toMatchObject({
      resultType: "task",
      status: "working",
      taskId: expect.stringMatching(/^mcp-task-/u),
    });
    const taskId = String(created?.taskId);
    let polled: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      polled = await handleRequest({
        jsonrpc: "2.0",
        id: 43 + attempt,
        method: "tasks/get",
        params: modernTaskParams({ taskId }),
      });
      if (polled?.status !== "working") break;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    expect(polled).toMatchObject({
      resultType: "complete",
      status: "completed",
      result: { resultType: "complete" },
    });
    await expect(
      handleRequest({
        jsonrpc: "2.0",
        id: 150,
        method: "tasks/update",
        params: modernTaskParams({
          taskId,
          inputResponses: {},
        }),
      }),
    ).resolves.toMatchObject({ resultType: "complete" });
    await expect(
      handleRequest({
        jsonrpc: "2.0",
        id: 151,
        method: "tasks/cancel",
        params: modernTaskParams({ taskId }),
      }),
    ).resolves.toMatchObject({ resultType: "complete" });
  });

  it("requires per-request tasks negotiation and rejects removed task methods", async () => {
    await expect(
      handleRequest({
        jsonrpc: "2.0",
        id: 152,
        method: "tasks/get",
        params: modernParams({
          taskId: "mcp-task-123e4567-e89b-42d3-a456-426614174000",
        }),
      }),
    ).rejects.toMatchObject({
      code: PM_MCP_ERROR_CODES.missingRequiredClientCapability,
    });
    for (const method of ["tasks/list", "tasks/result"]) {
      await expect(
        handleRequest({
          jsonrpc: "2.0",
          id: 153,
          method,
          params: modernParams(),
        }),
      ).rejects.toMatchObject({ code: -32601 });
    }
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
        id: 30,
        method: "initialize",
        params: modernParams(),
      }),
    ).rejects.toMatchObject({ code: -32601 });
    await expect(
      handleRequest({
        jsonrpc: "2.0",
        id: 31,
        method: "ping",
        params: {
          _meta: {
            [PM_MCP_META_KEYS.protocolVersion]: 7,
            [PM_MCP_META_KEYS.clientCapabilities]: {},
          },
        },
      }),
    ).rejects.toMatchObject({
      code: PM_MCP_ERROR_CODES.unsupportedProtocolVersion,
      data: { requested: null },
    });
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
    const child = spawn(
      process.execPath,
      [path.join(process.cwd(), "dist", "mcp", "server.js")],
      {
        cwd: process.cwd(),
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          PM_NO_TELEMETRY: "1",
          PM_ANALYTICS_OPTOUT: "1",
        },
      },
    );
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    const requests = [
      {
        jsonrpc: "2.0",
        id: 11,
        method: "server/discover",
        params: modernParams(),
      },
      { jsonrpc: "2.0", id: 12, method: "tools/list", params: modernParams() },
      { jsonrpc: "2.0", id: 13, method: "ping", params: modernParams() },
      {
        jsonrpc: "2.0",
        id: 14,
        method: "missing/current",
        params: modernParams(),
      },
    ];
    child.stdin.end(
      `${requests.map((request) => JSON.stringify(request)).join("\n")}\n`,
    );

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
        reject(
          new Error("timed out waiting for stateless MCP stdio responses"),
        );
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
    expect(responses[0]).toMatchObject({
      id: 11,
      result: { resultType: "complete" },
    });
    expect(responses[1]).toMatchObject({
      id: 12,
      result: { resultType: "complete" },
    });
    expect(responses[2]).toMatchObject({ id: 13, error: { code: -32601 } });
    expect(responses[3]).toMatchObject({ id: 14, error: { code: -32601 } });
  });
});
