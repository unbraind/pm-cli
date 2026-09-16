import type * as HarnessModule from "../../../scripts/plugin-mcp-smoke-harness.mjs";
import { EventEmitter } from "node:events";
import { access, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createScriptHarness } from "../../helpers/scriptModule";

const harness = createScriptHarness(["node:readline"]);

const SCRIPT = "scripts/plugin-mcp-smoke-harness.mjs";

/** Model child stdio independently from process closure to verify cleanup ordering. */
function mockSpawnedChild() {
  const readlineEmitter = Object.assign(new EventEmitter(), { close: vi.fn() });
  const createInterface = vi.fn(() => readlineEmitter);
  const stdinWrite = vi.fn();
  const stdinEnd = vi.fn();
  const kill = vi.fn();
  const stderr = Object.assign(new EventEmitter(), { destroy: vi.fn() });
  const child = Object.assign(new EventEmitter(), {
    stdin: { write: stdinWrite, end: stdinEnd, destroy: vi.fn() },
    stdout: Object.assign(new EventEmitter(), { destroy: vi.fn() }),
    stderr,
    kill,
    unref: vi.fn(),
  });
  kill.mockImplementation(() => child.emit("close", 0, null));
  const spawn = vi.fn(() => child);
  const remove = vi.fn(async () => undefined);
  vi.doMock("node:child_process", () => ({ spawn }));
  vi.doMock("node:fs/promises", () => ({
    mkdtemp: vi.fn(async () => "/tmp/pm-mcp-harness"),
    rm: remove,
  }));
  vi.doMock("node:readline", () => ({
    default: { createInterface },
    createInterface,
  }));
  return {
    readlineEmitter,
    stdinWrite,
    stdinEnd,
    kill,
    stderr,
    spawn,
    child,
    remove,
  };
}

/** Read the request id most recently written to the fake transport. */
function lastId(stdinWrite: ReturnType<typeof vi.fn>): unknown {
  return JSON.parse(String(stdinWrite.mock.calls.at(-1)?.[0] ?? "{}")).id;
}

/**
 * Drive the mocked child so every JSON-RPC request written to stdin is answered
 * by `respond`, which returns either a result or an error body for that request.
 */
function autoRespond(
  env: ReturnType<typeof mockSpawnedChild>,
  respond: (
    method: string,
    params: Record<string, unknown>,
  ) => Record<string, unknown>,
): void {
  env.stdinWrite.mockImplementation((chunk: string) => {
    const message = JSON.parse(String(chunk));
    const body = respond(message.method, message.params ?? {});
    queueMicrotask(() => {
      env.readlineEmitter.emit(
        "line",
        JSON.stringify({ jsonrpc: "2.0", id: message.id, ...body }),
      );
    });
  });
}

const MATRIX_OPTIONS = {
  serverPath: "/tmp/mock-plugin-server.mjs",
  author: "harness-test",
  tmpPrefix: "pm-harness-",
  modernProtocolVersion: "2026-07-28",
};

describe("plugin-mcp-smoke-harness handshake matrix", () => {
  it("negotiates every declared revision, refuses an undeclared one, and confirms discovery", async () => {
    const env = mockSpawnedChild();
    autoRespond(env, (method, params) => {
      if (method === "server/discover") {
        return { result: { supportedVersions: ["2026-07-28"] } };
      }
      const requested = String(
        (params as { protocolVersion?: string }).protocolVersion,
      );
      if (requested === "1900-01-01") {
        return {
          error: {
            code: -32022,
            message: "Unsupported legacy MCP protocol version",
          },
        };
      }
      return {
        result: { protocolVersion: requested, serverInfo: { name: "pm-mcp" } },
      };
    });
    const mod = await harness.importModule<typeof HarnessModule>(SCRIPT);
    const outcome = await mod.assertProtocolHandshakeMatrix({
      ...MATRIX_OPTIONS,
      legacyProtocolVersions: ["2025-11-25", "2025-06-18"],
    });
    expect(outcome.negotiated).toEqual(["2025-11-25", "2025-06-18"]);
    expect(outcome.refused).toContain("protocol version");
  });

  it("falls back to the revision list declared by the built SDK when none is supplied", async () => {
    const env = mockSpawnedChild();
    autoRespond(env, (method, params) => {
      if (method === "server/discover") {
        return { result: { supportedVersions: ["2026-07-28"] } };
      }
      const requested = String(
        (params as { protocolVersion?: string }).protocolVersion,
      );
      return requested === "1900-01-01"
        ? {
            error: {
              code: -32022,
              message: "Unsupported legacy MCP protocol version",
            },
          }
        : {
            result: {
              protocolVersion: requested,
              serverInfo: { name: "pm-mcp" },
            },
          };
    });
    const mod = await harness.importModule<typeof HarnessModule>(SCRIPT);
    const outcome = await mod.assertProtocolHandshakeMatrix({
      serverPath: "/tmp/mock-plugin-server.mjs",
      author: "harness-test",
      tmpPrefix: "pm-harness-",
    });
    // Derived from the artifact, so the matrix cannot iterate a shorter list
    // than the transport accepts.
    expect(outcome.negotiated.length).toBeGreaterThan(0);
    expect(outcome.negotiated).toContain("2025-11-25");
  });

  it("rejects an empty declared revision list rather than passing vacuously", async () => {
    mockSpawnedChild();
    const mod = await harness.importModule<typeof HarnessModule>(SCRIPT);
    await expect(
      mod.assertProtocolHandshakeMatrix({
        ...MATRIX_OPTIONS,
        legacyProtocolVersions: [],
      }),
    ).rejects.toThrow("declared legacy revision list");
  });

  it("fails when the server answers a revision the client did not request", async () => {
    const env = mockSpawnedChild();
    autoRespond(env, () => ({
      result: { protocolVersion: "2025-06-18", serverInfo: { name: "pm-mcp" } },
    }));
    const mod = await harness.importModule<typeof HarnessModule>(SCRIPT);
    await expect(
      mod.assertProtocolHandshakeMatrix({
        ...MATRIX_OPTIONS,
        legacyProtocolVersions: ["2025-11-25"],
      }),
    ).rejects.toThrow("cannot fall forward");
  });

  it("fails when the handshake omits server identity", async () => {
    const env = mockSpawnedChild();
    autoRespond(env, (_method, params) => ({
      result: {
        protocolVersion: String(
          (params as { protocolVersion?: string }).protocolVersion,
        ),
      },
    }));
    const mod = await harness.importModule<typeof HarnessModule>(SCRIPT);
    await expect(
      mod.assertProtocolHandshakeMatrix({
        ...MATRIX_OPTIONS,
        legacyProtocolVersions: ["2025-11-25"],
      }),
    ).rejects.toThrow("serverInfo.name");
  });

  it("fails when an undeclared revision is accepted, so the accept list enforces something", async () => {
    const env = mockSpawnedChild();
    autoRespond(env, (_method, params) => ({
      result: {
        protocolVersion: String(
          (params as { protocolVersion?: string }).protocolVersion,
        ),
        serverInfo: { name: "pm-mcp" },
      },
    }));
    const mod = await harness.importModule<typeof HarnessModule>(SCRIPT);
    await expect(
      mod.assertProtocolHandshakeMatrix({
        ...MATRIX_OPTIONS,
        legacyProtocolVersions: ["2025-11-25"],
      }),
    ).rejects.toThrow("negative control failed");
  });

  it("rethrows a refusal that is not a protocol-version refusal", async () => {
    const env = mockSpawnedChild();
    autoRespond(env, (_method, params) => {
      const requested = String(
        (params as { protocolVersion?: string }).protocolVersion,
      );
      return requested === "1900-01-01"
        ? { error: { code: -32603, message: "spawn failed" } }
        : {
            result: {
              protocolVersion: requested,
              serverInfo: { name: "pm-mcp" },
            },
          };
    });
    const mod = await harness.importModule<typeof HarnessModule>(SCRIPT);
    await expect(
      mod.assertProtocolHandshakeMatrix({
        ...MATRIX_OPTIONS,
        legacyProtocolVersions: ["2025-11-25"],
      }),
    ).rejects.toThrow("spawn failed");
  });

  it("fails when discovery returns no result at all", async () => {
    const env = mockSpawnedChild();
    autoRespond(env, (method, params) => {
      if (method === "server/discover") return {};
      const requested = String(
        (params as { protocolVersion?: string }).protocolVersion,
      );
      return requested === "1900-01-01"
        ? {
            error: {
              code: -32022,
              message: "Unsupported legacy MCP protocol version",
            },
          }
        : {
            result: {
              protocolVersion: requested,
              serverInfo: { name: "pm-mcp" },
            },
          };
    });
    const mod = await harness.importModule<typeof HarnessModule>(SCRIPT);
    await expect(
      mod.assertProtocolHandshakeMatrix({
        ...MATRIX_OPTIONS,
        legacyProtocolVersions: ["2025-11-25"],
      }),
    ).rejects.toThrow("omits the declared canonical revision");
  });

  it("fails when discovery omits the declared canonical revision", async () => {
    const env = mockSpawnedChild();
    autoRespond(env, (method, params) => {
      // No supportedVersions key at all, so the nullish fallback is exercised.
      if (method === "server/discover") return { result: {} };
      const requested = String(
        (params as { protocolVersion?: string }).protocolVersion,
      );
      return requested === "1900-01-01"
        ? {
            error: {
              code: -32022,
              message: "Unsupported legacy MCP protocol version",
            },
          }
        : {
            result: {
              protocolVersion: requested,
              serverInfo: { name: "pm-mcp" },
            },
          };
    });
    const mod = await harness.importModule<typeof HarnessModule>(SCRIPT);
    await expect(
      mod.assertProtocolHandshakeMatrix({
        ...MATRIX_OPTIONS,
        legacyProtocolVersions: ["2025-11-25"],
      }),
    ).rejects.toThrow("omits the declared canonical revision");
  });
});

describe("plugin-mcp-smoke-harness", () => {
  it("resolves requests, parses structured + text tool results, and disposes", async () => {
    const env = mockSpawnedChild();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const mod = await harness.importModule<typeof HarnessModule>(SCRIPT);
    const session = await mod.startPluginMcpSmoke({
      serverPath: "/tmp/mock-plugin-server.mjs",
      author: "harness-test",
      tmpPrefix: "pm-harness-",
      requestTimeoutMs: 50,
    });
    expect(env.spawn).toHaveBeenCalledWith(
      process.execPath,
      ["/tmp/mock-plugin-server.mjs"],
      expect.objectContaining({
        env: expect.objectContaining({
          PM_MCP_PROFILE: "full",
          PM_PATH: path.join("/tmp/pm-mcp-harness", ".agents", "pm"),
        }),
      }),
    );

    const initializePromise = session.request("initialize", { ping: true });
    expect(
      JSON.parse(String(env.stdinWrite.mock.calls.at(-1)?.[0])),
    ).toMatchObject({
      method: "initialize",
      params: { ping: true },
    });
    env.readlineEmitter.emit(
      "line",
      JSON.stringify({
        jsonrpc: "2.0",
        id: lastId(env.stdinWrite),
        result: { instructions: "ok" },
      }),
    );
    await expect(initializePromise).resolves.toEqual({ instructions: "ok" });

    // structuredContent?.result wins (line 108 left side).
    const structuredPromise = session.callTool("pm_get", { id: "pm-1" });
    expect(
      JSON.parse(String(env.stdinWrite.mock.calls.at(-1)?.[0])),
    ).toMatchObject({
      params: {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    });
    env.readlineEmitter.emit(
      "line",
      JSON.stringify({
        jsonrpc: "2.0",
        id: lastId(env.stdinWrite),
        result: {
          isError: false,
          structuredContent: { result: { item: { id: "pm-1" } } },
          content: [{ text: "{}" }],
        },
      }),
    );
    await expect(structuredPromise).resolves.toEqual({ item: { id: "pm-1" } });

    // No structuredContent -> JSON.parse(content[0].text) fallback (line 108 right side).
    const parsedPromise = session.callTool("pm_context", {});
    env.readlineEmitter.emit(
      "line",
      JSON.stringify({
        jsonrpc: "2.0",
        id: lastId(env.stdinWrite),
        result: { isError: false, content: [{ text: '{"ok":true}' }] },
      }),
    );
    await expect(parsedPromise).resolves.toEqual({ ok: true });

    // isError with content text -> message includes the text (line 106 left side).
    const toolErrorPromise = session.callTool("pm_update", {});
    env.readlineEmitter.emit(
      "line",
      JSON.stringify({
        jsonrpc: "2.0",
        id: lastId(env.stdinWrite),
        result: { isError: true, content: [{ text: "mock tool failure" }] },
      }),
    );
    await expect(toolErrorPromise).rejects.toThrow(
      "pm_update returned isError: mock tool failure",
    );

    env.readlineEmitter.emit("line", "not-json");
    env.stderr.emit("data", Buffer.from("stderr line\n"));
    await session.dispose();
    expect(env.stdinEnd).toHaveBeenCalled();
    expect(env.kill).toHaveBeenCalled();
    expect(String(errorSpy.mock.calls.at(-1)?.[0] ?? "")).toContain(
      "stderr line",
    );
  });

  it("ignores blank/idless/non-object/unknown-id lines, rejects error responses, and exposes getStderr", async () => {
    const env = mockSpawnedChild();
    const mod = await harness.importModule<typeof HarnessModule>(SCRIPT);
    const session = await mod.startPluginMcpSmoke({
      serverPath: "/tmp/mock.mjs",
      author: "harness-branches",
      tmpPrefix: "pm-harness-branches-",
      requestTimeoutMs: 200,
    });

    // Blank line -> early return (line 61).
    env.readlineEmitter.emit("line", "   ");
    // JSON without an id -> "id" in message false (line 69).
    env.readlineEmitter.emit(
      "line",
      JSON.stringify({ jsonrpc: "2.0", result: { ok: true } }),
    );
    // Non-object JSON (number) -> typeof guard (line 69).
    env.readlineEmitter.emit("line", "42");
    // Valid shape but unknown id -> no waiter (line 73).
    env.readlineEmitter.emit(
      "line",
      JSON.stringify({ jsonrpc: "2.0", id: 9999, result: {} }),
    );

    // Error response -> waiter.reject (lines 75-76).
    const errPromise = session.request("initialize", {});
    env.readlineEmitter.emit(
      "line",
      JSON.stringify({
        jsonrpc: "2.0",
        id: lastId(env.stdinWrite),
        error: { message: "boom from server" },
      }),
    );
    await expect(errPromise).rejects.toThrow("boom from server");

    // callTool isError with empty content -> `?? "unknown"` fallback (line 106 right side).
    const isErrPromise = session.callTool("pm_update", {});
    env.readlineEmitter.emit(
      "line",
      JSON.stringify({
        jsonrpc: "2.0",
        id: lastId(env.stdinWrite),
        result: { isError: true, content: [] },
      }),
    );
    await expect(isErrPromise).rejects.toThrow(
      "pm_update returned isError: unknown",
    );

    env.stderr.emit("data", Buffer.from("harness stderr chunk\n"));
    expect(session.getStderr()).toContain("harness stderr chunk");

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await session.dispose();
    errorSpy.mockRestore();
  });

  it("waits for process closure before removing its working directory", async () => {
    const env = mockSpawnedChild();
    env.kill.mockImplementation(() => true);
    const mod = await harness.importModule<typeof HarnessModule>(SCRIPT);
    const session = await mod.startPluginMcpSmoke({
      serverPath: "/tmp/mock.mjs",
      author: "harness-close",
      tmpPrefix: "pm-harness-close-",
    });
    const disposal = session.dispose();
    await Promise.resolve();
    expect(env.remove).not.toHaveBeenCalled();
    env.child.emit("close", 0, null);
    await disposal;
    expect(env.remove).toHaveBeenCalledWith(session.tmpRoot, {
      recursive: true,
      force: true,
    });
  });

  it("escalates to SIGKILL when the child ignores graceful shutdown", async () => {
    const env = mockSpawnedChild();
    env.kill.mockImplementation((signal) => {
      if (signal === "SIGKILL") env.child.emit("close", null, signal);
      return true;
    });
    const mod = await harness.importModule<typeof HarnessModule>(SCRIPT);
    const session = await mod.startPluginMcpSmoke({
      serverPath: "/tmp/mock.mjs",
      author: "harness-escalate",
      tmpPrefix: "pm-harness-escalate-",
      shutdownTimeoutMs: 5,
    });
    await session.dispose();
    expect(env.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
    expect(env.remove).toHaveBeenCalled();
  }, 1_000);

  it("fails with diagnostics and releases handles when neither signal closes the child", async () => {
    const env = mockSpawnedChild();
    env.kill.mockImplementation(() => false);
    const mod = await harness.importModule<typeof HarnessModule>(SCRIPT);
    const session = await mod.startPluginMcpSmoke({
      serverPath: "/tmp/mock.mjs",
      author: "harness-stuck",
      tmpPrefix: "pm-harness-stuck-",
      shutdownTimeoutMs: 5,
    });
    env.stderr.emit("data", Buffer.from("child is stuck"));
    await expect(session.dispose()).rejects.toThrow(
      "MCP server did not close after 10ms; retained workspace /tmp/pm-mcp-harness. child is stuck",
    );
    expect(env.remove).not.toHaveBeenCalled();
    expect(env.child.unref).toHaveBeenCalled();
    expect(env.child.stdin.destroy).toHaveBeenCalled();
    expect(env.child.stdout.destroy).toHaveBeenCalled();
    expect(env.child.stderr.destroy).toHaveBeenCalled();
    expect(env.readlineEmitter.close).toHaveBeenCalled();
  }, 1_000);

  it("reaps a real child that keeps running after stdin closes", async () => {
    const root = await harness.createTempRoot("pm-mcp-shutdown-control-");
    const serverPath = path.join(root, "server.mjs");
    await writeFile(
      serverPath,
      `
import readline from "node:readline";
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const { id } = JSON.parse(line);
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result: { ready: true } }) + "\\n");
});
`,
    );
    const mod = await harness.importModule<typeof HarnessModule>(SCRIPT);
    const session = await mod.startPluginMcpSmoke({
      serverPath,
      author: "harness-real-shutdown",
      tmpPrefix: "pm-harness-real-shutdown-",
      shutdownTimeoutMs: 100,
    });
    try {
      await expect(session.request("ready")).resolves.toEqual({ ready: true });
    } finally {
      await session.dispose();
    }
    await expect(access(session.tmpRoot)).rejects.toThrow();
  });

  it("disposes silently when stderr is empty (no console.error)", async () => {
    mockSpawnedChild();
    const mod = await harness.importModule<typeof HarnessModule>(SCRIPT);
    const session = await mod.startPluginMcpSmoke({
      serverPath: "/tmp/mock.mjs",
      author: "harness-clean",
      tmpPrefix: "pm-harness-clean-",
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await session.dispose();
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("rejects with a timeout when no response arrives", async () => {
    const env = mockSpawnedChild();
    const mod = await harness.importModule<typeof HarnessModule>(SCRIPT);
    const session = await mod.startPluginMcpSmoke({
      serverPath: "/tmp/mock-plugin-server-timeout.mjs",
      author: "harness-timeout",
      tmpPrefix: "pm-harness-timeout-",
      requestTimeoutMs: 5,
    });
    await expect(session.request("tools/list")).rejects.toThrow(
      "Timed out waiting for tools/list",
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await session.dispose();
    errorSpy.mockRestore();
    void env;
  });
});
