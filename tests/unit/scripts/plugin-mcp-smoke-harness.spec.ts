import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createScriptHarness } from "../../helpers/scriptModule";

const harness = createScriptHarness(["node:readline"]);

const SCRIPT = "scripts/plugin-mcp-smoke-harness.mjs";
type HarnessModule = typeof import("../../../scripts/plugin-mcp-smoke-harness.mjs");

function mockSpawnedChild() {
  const readlineEmitter = new EventEmitter();
  const createInterface = vi.fn(() => readlineEmitter);
  const stdinWrite = vi.fn();
  const stdinEnd = vi.fn();
  const kill = vi.fn();
  const stderr = new EventEmitter();
  const child = Object.assign(new EventEmitter(), {
    stdin: { write: stdinWrite, end: stdinEnd },
    stdout: new EventEmitter(),
    stderr,
    kill,
  });
  vi.doMock("node:child_process", () => ({ spawn: vi.fn(() => child) }));
  vi.doMock("node:fs/promises", () => ({
    mkdtemp: vi.fn(async () => "/tmp/pm-mcp-harness"),
    rm: vi.fn(async () => undefined),
  }));
  vi.doMock("node:readline", () => ({ default: { createInterface }, createInterface }));
  return { readlineEmitter, stdinWrite, stdinEnd, kill, stderr };
}

function lastId(stdinWrite: ReturnType<typeof vi.fn>): unknown {
  return JSON.parse(String(stdinWrite.mock.calls.at(-1)?.[0] ?? "{}")).id;
}

describe("plugin-mcp-smoke-harness", () => {
  it("resolves requests, parses structured + text tool results, and disposes", async () => {
    const env = mockSpawnedChild();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const mod = await harness.importModule<HarnessModule>(SCRIPT);
    const session = await mod.startPluginMcpSmoke({
      serverPath: "/tmp/mock-plugin-server.mjs",
      author: "harness-test",
      tmpPrefix: "pm-harness-",
      requestTimeoutMs: 50,
    });

    const initializePromise = session.request("initialize", { ping: true });
    env.readlineEmitter.emit(
      "line",
      JSON.stringify({ jsonrpc: "2.0", id: lastId(env.stdinWrite), result: { instructions: "ok" } }),
    );
    await expect(initializePromise).resolves.toEqual({ instructions: "ok" });

    // structuredContent?.result wins (line 108 left side).
    const structuredPromise = session.callTool("pm_get", { id: "pm-1" });
    env.readlineEmitter.emit(
      "line",
      JSON.stringify({
        jsonrpc: "2.0",
        id: lastId(env.stdinWrite),
        result: { isError: false, structuredContent: { result: { item: { id: "pm-1" } } }, content: [{ text: "{}" }] },
      }),
    );
    await expect(structuredPromise).resolves.toEqual({ item: { id: "pm-1" } });

    // No structuredContent -> JSON.parse(content[0].text) fallback (line 108 right side).
    const parsedPromise = session.callTool("pm_context", {});
    env.readlineEmitter.emit(
      "line",
      JSON.stringify({ jsonrpc: "2.0", id: lastId(env.stdinWrite), result: { isError: false, content: [{ text: '{"ok":true}' }] } }),
    );
    await expect(parsedPromise).resolves.toEqual({ ok: true });

    // isError with content text -> message includes the text (line 106 left side).
    const toolErrorPromise = session.callTool("pm_update", {});
    env.readlineEmitter.emit(
      "line",
      JSON.stringify({ jsonrpc: "2.0", id: lastId(env.stdinWrite), result: { isError: true, content: [{ text: "mock tool failure" }] } }),
    );
    await expect(toolErrorPromise).rejects.toThrow("pm_update returned isError: mock tool failure");

    env.readlineEmitter.emit("line", "not-json");
    env.stderr.emit("data", Buffer.from("stderr line\n"));
    await session.dispose();
    expect(env.stdinEnd).toHaveBeenCalled();
    expect(env.kill).toHaveBeenCalled();
    expect(String(errorSpy.mock.calls.at(-1)?.[0] ?? "")).toContain("stderr line");
  });

  it("ignores blank/idless/non-object/unknown-id lines, rejects error responses, and exposes getStderr", async () => {
    const env = mockSpawnedChild();
    const mod = await harness.importModule<HarnessModule>(SCRIPT);
    const session = await mod.startPluginMcpSmoke({
      serverPath: "/tmp/mock.mjs",
      author: "harness-branches",
      tmpPrefix: "pm-harness-branches-",
      requestTimeoutMs: 200,
    });

    // Blank line -> early return (line 61).
    env.readlineEmitter.emit("line", "   ");
    // JSON without an id -> "id" in message false (line 69).
    env.readlineEmitter.emit("line", JSON.stringify({ jsonrpc: "2.0", result: { ok: true } }));
    // Non-object JSON (number) -> typeof guard (line 69).
    env.readlineEmitter.emit("line", "42");
    // Valid shape but unknown id -> no waiter (line 73).
    env.readlineEmitter.emit("line", JSON.stringify({ jsonrpc: "2.0", id: 9999, result: {} }));

    // Error response -> waiter.reject (lines 75-76).
    const errPromise = session.request("initialize", {});
    env.readlineEmitter.emit(
      "line",
      JSON.stringify({ jsonrpc: "2.0", id: lastId(env.stdinWrite), error: { message: "boom from server" } }),
    );
    await expect(errPromise).rejects.toThrow("boom from server");

    // callTool isError with empty content -> `?? "unknown"` fallback (line 106 right side).
    const isErrPromise = session.callTool("pm_update", {});
    env.readlineEmitter.emit(
      "line",
      JSON.stringify({ jsonrpc: "2.0", id: lastId(env.stdinWrite), result: { isError: true, content: [] } }),
    );
    await expect(isErrPromise).rejects.toThrow("pm_update returned isError: unknown");

    env.stderr.emit("data", Buffer.from("harness stderr chunk\n"));
    expect(session.getStderr()).toContain("harness stderr chunk");

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await session.dispose();
    errorSpy.mockRestore();
  });

  it("disposes silently when stderr is empty (no console.error)", async () => {
    mockSpawnedChild();
    const mod = await harness.importModule<HarnessModule>(SCRIPT);
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
    const mod = await harness.importModule<HarnessModule>(SCRIPT);
    const session = await mod.startPluginMcpSmoke({
      serverPath: "/tmp/mock-plugin-server-timeout.mjs",
      author: "harness-timeout",
      tmpPrefix: "pm-harness-timeout-",
      requestTimeoutMs: 5,
    });
    await expect(session.request("tools/list")).rejects.toThrow("Timed out waiting for tools/list");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await session.dispose();
    errorSpy.mockRestore();
    void env;
  });
});
