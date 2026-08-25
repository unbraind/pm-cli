import { describe, expect, it, vi } from "vitest";
import { createScriptHarness } from "../../helpers/scriptModule";

const harness = createScriptHarness(["../../../scripts/plugin-mcp-smoke-harness.mjs"]);

const SCRIPT = "scripts/smoke-codex-plugin-mcp.mjs";

const FULL_TOOLS = [
  "pm_run",
  "pm_context",
  "pm_create",
  "pm_get",
  "pm_update",
  "pm_comments",
  "pm_files",
  "pm_docs",
  "pm_notes",
  "pm_learnings",
  "pm_deps",
  "pm_test",
];

function mockHarness(request: unknown, callTool: unknown) {
  const dispose = vi.fn(async () => undefined);
  vi.doMock("../../../scripts/plugin-mcp-smoke-harness.mjs", () => ({
    startPluginMcpSmoke: vi.fn(async () => ({
      tmpRoot: "/tmp/pm-codex-smoke",
      request,
      callTool,
      dispose,
    })),
  }));
  return dispose;
}

describe("smoke-codex-plugin-mcp", () => {
  it("runs the full MCP smoke workflow and logs success", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "server/discover") {
        return {
          resultType: "complete",
          supportedVersions: ["2026-07-28"],
        };
      }
      if (method === "tools/list") {
        return { tools: FULL_TOOLS.map((name) => ({ name })) };
      }
      return { ok: true };
    });
    const callTool = vi.fn(async (tool: string) => {
      if (tool === "pm_create") {
        return {
          changed_field_count: 10,
          id: "pm-smoke-1",
          status: "open",
        };
      }
      if (tool === "pm_get") {
        return {
          item: { status: "in_progress" },
          linked: { files: [{ path: "README.md" }], tests: [{ command: "node --version" }] },
        };
      }
      return { ok: true };
    });
    const dispose = mockHarness(request, callTool);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await harness.importModule(SCRIPT);
    expect(request).toHaveBeenCalledWith("server/discover");
    expect(callTool).toHaveBeenCalledWith("pm_run", expect.any(Object));
    expect(callTool).toHaveBeenCalledWith("pm_validate", expect.any(Object));
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(String(logSpy.mock.calls.at(-1)?.[0] ?? "")).toContain("Codex plugin MCP smoke passed");
  });

  it("throws and disposes when a required MCP tool is missing", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "server/discover") {
        return {
          resultType: "complete",
          supportedVersions: ["2026-07-28"],
        };
      }
      if (method === "tools/list") return { tools: [{ name: "pm_run" }] };
      return { ok: true };
    });
    const callTool = vi.fn(async () => ({ ok: true }));
    const dispose = mockHarness(request, callTool);
    await expect(harness.importModule(SCRIPT)).rejects.toThrow(/Missing MCP tool/);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("rejects discovery that omits the canonical revision", async () => {
    const request = vi.fn(async () => ({
      resultType: "complete",
      supportedVersions: ["2025-06-18"],
    }));
    const dispose = mockHarness(request, vi.fn(async () => ({ ok: true })));
    await expect(harness.importModule(SCRIPT)).rejects.toThrow(
      /did not advertise the canonical revision/,
    );
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("rejects a stale create mutation envelope", async () => {
    const request = vi.fn(async (method: string) =>
      method === "server/discover"
        ? {
            resultType: "complete",
            supportedVersions: ["2026-07-28"],
          }
        : method === "tools/list"
          ? { tools: FULL_TOOLS.map((name) => ({ name })) }
          : { ok: true },
    );
    const callTool = vi.fn(async (tool: string) =>
      tool === "pm_create" ? { item: { id: "pm-stale" } } : { ok: true },
    );
    const dispose = mockHarness(request, callTool);
    await expect(harness.importModule(SCRIPT)).rejects.toThrow(
      /lean mutation envelope/,
    );
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("rejects an id-less lean create mutation envelope", async () => {
    const request = vi.fn(async (method: string) =>
      method === "server/discover"
        ? {
            resultType: "complete",
            supportedVersions: ["2026-07-28"],
          }
        : method === "tools/list"
          ? { tools: FULL_TOOLS.map((name) => ({ name })) }
          : { ok: true },
    );
    const callTool = vi.fn(async (tool: string) =>
      tool === "pm_create"
        ? { changed_field_count: 10, id: "", status: "open" }
        : { ok: true },
    );
    const dispose = mockHarness(request, callTool);
    await expect(harness.importModule(SCRIPT)).rejects.toThrow(
      /missing a non-empty id/,
    );
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("throws when the smoke item does not persist the expected status/links", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "server/discover") {
        return {
          resultType: "complete",
          supportedVersions: ["2026-07-28"],
        };
      }
      if (method === "tools/list") return { tools: FULL_TOOLS.map((name) => ({ name })) };
      return { ok: true };
    });
    const callTool = vi.fn(async (tool: string) => {
      if (tool === "pm_create") {
        return {
          changed_field_count: 10,
          id: "pm-smoke-bad",
          status: "open",
        };
      }
      if (tool === "pm_get") return { item: { status: "open" }, linked: { files: [], tests: [] } };
      return { ok: true };
    });
    const dispose = mockHarness(request, callTool);
    await expect(harness.importModule(SCRIPT)).rejects.toThrow(/did not persist expected status\/links/);
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
