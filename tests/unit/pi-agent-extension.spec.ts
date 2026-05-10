import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PM_PI_TOOL_PARAMETERS_SCHEMA, PM_TOOL_ACTIONS, PM_TOOL_PARAMETERS_SCHEMA } from "../../src/sdk/cli-contracts.js";
import { nativeCommandOptions, nativeGlobalOptions, runNativePmAction } from "../../src/pi/native.js";
import pmCliPiExtension, { createPmToolDefinition } from "../../.pi/extensions/pm-cli/index.js";

describe("Pi native pm package integration", () => {
  it("publishes a Pi-compatible action schema", () => {
    expect(PM_TOOL_ACTIONS).toContain("context");
    expect(PM_TOOL_ACTIONS).toContain("ctx");
    expect(PM_TOOL_ACTIONS).toContain("extension");
    expect(PM_TOOL_ACTIONS).toContain("beads-import");
    expect(PM_TOOL_ACTIONS).toContain("todos-export");
    expect(PM_TOOL_ACTIONS).toContain("start-task");
    expect(PM_TOOL_ACTIONS).toContain("close-task");
    expect(PM_TOOL_PARAMETERS_SCHEMA).toMatchObject({ type: "object", oneOf: expect.any(Array) });
    expect(JSON.stringify(PM_TOOL_PARAMETERS_SCHEMA)).toContain('"const":"context"');
    expect(PM_PI_TOOL_PARAMETERS_SCHEMA).toMatchObject({
      type: "object",
      required: ["action"],
      properties: { action: { type: "string" } },
    });
    expect(PM_PI_TOOL_PARAMETERS_SCHEMA).not.toHaveProperty("oneOf");
    expect(PM_PI_TOOL_PARAMETERS_SCHEMA).not.toHaveProperty("enum");
    expect(JSON.stringify(PM_PI_TOOL_PARAMETERS_SCHEMA)).not.toContain('"anyOf"');
    for (const definition of Object.values(PM_PI_TOOL_PARAMETERS_SCHEMA.properties as Record<string, { type?: unknown }>)) {
      expect(typeof definition.type).toBe("string");
    }
  });

  it("registers a hot-reload-safe provider-compatible project extension schema", () => {
    const tool = createPmToolDefinition();
    expect(tool.parameters).toMatchObject({
      type: "object",
      required: ["action"],
      additionalProperties: true,
      properties: { action: { type: "string" } },
    });
    expect(JSON.stringify(tool.parameters)).not.toContain('"oneOf"');
    expect(JSON.stringify(tool.parameters)).not.toContain('"anyOf"');
    expect(tool.description).toContain("beads");
    expect(tool.promptGuidelines.join("\n")).toContain("contracts");
    expect(tool.renderCall?.({ action: "context" }, { fg: (_name: string, text: string) => text, bold: (text: string) => text } as never, {} as never)).toMatchObject({
      render: expect.any(Function),
    });
  });

  it("registers pm TUI helper commands and session UI hooks", () => {
    const commands: string[] = [];
    const events: string[] = [];
    const pi = {
      registerTool(tool: { name: string }) {
        expect(tool.name).toBe("pm");
      },
      registerCommand(name: string) {
        commands.push(name);
      },
      on(event: string) {
        events.push(event);
      },
    };
    pmCliPiExtension(pi as never);
    expect(commands).toEqual(expect.arrayContaining(["pm-board", "pm-item", "pm-history", "pm-actions", "pm-workflows"]));
    expect(events).toEqual(expect.arrayContaining(["session_start", "session_shutdown", "before_provider_request"]));
  });

  it("patches provider payloads defensively if pm parameters are missing", () => {
    const handlers: Record<string, Array<(event: { payload: unknown }) => unknown>> = {};
    const pi = {
      registerTool() {},
      registerCommand() {},
      on(event: string, handler: (event: { payload: unknown }) => unknown) {
        handlers[event] = [...(handlers[event] ?? []), handler];
      },
    };
    pmCliPiExtension(pi as never);
    const payload = { tools: [{ type: "function", name: "pm", description: "pm", parameters: undefined }] };
    const patch = handlers.before_provider_request?.[0]?.({ payload });
    expect(patch).toMatchObject({
      tools: [{ name: "pm", parameters: { type: "object", required: ["action"] } }],
    });
  });

  it("normalizes global and command options without CLI argv construction", () => {
    expect(nativeGlobalOptions({ path: "/tmp/pm", quiet: true, noPager: true })).toMatchObject({
      json: true,
      quiet: true,
      noPager: true,
      path: "/tmp/pm",
    });
    expect(nativeCommandOptions({ action: "context", limit: 5, author: "pi-agent", options: { depth: "standard" } })).toMatchObject({
      limit: 5,
      author: "pi-agent",
      depth: "standard",
    });
  });

  it("runs core pm operations natively against a sandbox", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "pm-pi-native-"));
    try {
      const pmPath = path.join(tmp, "pm");
      const init = await runNativePmAction({ action: "init", path: pmPath, prefix: "pm" });
      expect(init).toMatchObject({ ok: true });

      const context = await runNativePmAction({ action: "context", path: pmPath, limit: 1 });
      expect(context).toMatchObject({ summary: expect.any(Object) });
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
