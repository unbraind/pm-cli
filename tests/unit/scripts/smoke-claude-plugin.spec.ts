import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type * as claudePluginSmokeModule from "../../../scripts/smoke-claude-plugin.mjs";
import { createScriptHarness } from "../../helpers/scriptModule";

const harness = createScriptHarness(["../../../scripts/plugin-mcp-smoke-harness.mjs"]);

const SCRIPT = "scripts/smoke-claude-plugin.mjs";
type ClaudeModule = typeof claudePluginSmokeModule;

const REQUIRED_TOOLS = [
  "pm_run",
  "pm_context",
  "pm_next",
  "pm_search",
  "pm_list",
  "pm_get",
  "pm_create",
  "pm_mutate",
  "pm_copy",
  "pm_focus",
  "pm_update",
  "pm_append",
  "pm_claim",
  "pm_release",
  "pm_close",
  "pm_comments",
  "pm_files",
  "pm_docs",
  "pm_notes",
  "pm_learnings",
  "pm_deps",
  "pm_graph",
  "pm_test",
  "pm_validate",
  "pm_health",
  "pm_contracts",
  "pm_schema",
  "pm_profile",
  "pm_config",
  "pm_plan",
];

interface SmokeOverrides {
  marketplace?: unknown;
  pluginJson?: unknown;
  initResult?: unknown;
  tools?: string[];
  getResult?: unknown;
  existsSync?: () => boolean;
  execSync?: () => string;
  startNever?: boolean;
}

function setupSmoke(overrides: SmokeOverrides = {}) {
  const request = vi.fn(async (method: string) => {
    if (method === "initialize") {
      return overrides.initResult ?? { instructions: "Use pm_context before mutation tools." };
    }
    if (method === "tools/list") {
      return { tools: (overrides.tools ?? REQUIRED_TOOLS).map((name) => ({ name })) };
    }
    return {};
  });
  const callTool = vi.fn(async (toolName: string) => {
    if (toolName === "pm_create") return { item: { id: "pm-claude-smoke" } };
    if (toolName === "pm_get") {
      return (
        overrides.getResult ?? {
          item: { status: "in_progress" },
          linked: { files: [{ path: "README.md" }], tests: [{ command: "node --version" }] },
        }
      );
    }
    return { ok: true };
  });
  const dispose = vi.fn(async () => undefined);
  const startPluginMcpSmoke = overrides.startNever
    ? vi.fn()
    : vi.fn(async () => ({ tmpRoot: "/tmp/pm-claude-smoke", request, callTool, dispose }));
  vi.doMock("../../../scripts/plugin-mcp-smoke-harness.mjs", () => ({ startPluginMcpSmoke }));
  vi.doMock("node:fs", () => ({
    existsSync: vi.fn(overrides.existsSync ?? (() => true)),
    readFileSync: vi.fn((target: string) => {
      if (String(target).endsWith(path.join(".claude-plugin", "marketplace.json"))) {
        return JSON.stringify(overrides.marketplace ?? { name: "pm", plugins: [{ name: "pm-claude" }] });
      }
      if (String(target).endsWith(path.join("plugins", "pm-claude", ".claude-plugin", "plugin.json"))) {
        return JSON.stringify(overrides.pluginJson ?? { name: "pm-claude" });
      }
      return "{}";
    }),
  }));
  vi.doMock("node:child_process", () => ({ execSync: overrides.execSync ?? vi.fn(() => "") }));
  return { startPluginMcpSmoke, callTool, dispose };
}

describe("smoke-claude-plugin", () => {
  it("runs the full plugin smoke workflow and logs success", async () => {
    const { startPluginMcpSmoke, callTool, dispose } = setupSmoke();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await harness.importModule(SCRIPT);
    expect(startPluginMcpSmoke).toHaveBeenCalled();
    expect(callTool).toHaveBeenCalledWith("pm_validate", expect.any(Object));
    expect(callTool).toHaveBeenCalledWith("pm_health", expect.any(Object));
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(String(logSpy.mock.calls.at(-1)?.[0] ?? "")).toContain("Claude Code plugin smoke passed");
  });

  it("throws on a missing plugin file before the harness starts", async () => {
    const { startPluginMcpSmoke } = setupSmoke({ existsSync: () => false, startNever: true });
    await expect(harness.importModule(SCRIPT)).rejects.toThrow("Missing plugin file");
    expect(startPluginMcpSmoke).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "marketplace name not pm",
      overrides: { marketplace: { name: "wrong", plugins: [{ name: "pm-claude" }] } } as SmokeOverrides,
      expected: /Root marketplace.json name must be "pm"/,
    },
    {
      name: "marketplace plugin name mismatch",
      overrides: { marketplace: { name: "pm", plugins: [{ name: "other" }] } } as SmokeOverrides,
      expected: /plugins\[0\].name must be "pm-claude"/,
    },
    {
      name: "plugin.json name wrong",
      overrides: { pluginJson: { name: "nope" } } as SmokeOverrides,
      expected: /plugin.json name must be "pm-claude"/,
    },
  ])("throws when $name (manifest validation, before harness starts)", async ({ overrides, expected }) => {
    setupSmoke({ ...overrides, startNever: true });
    await expect(harness.importModule(SCRIPT)).rejects.toThrow(expected);
  });

  it.each([
    {
      name: "init missing instructions",
      overrides: { initResult: { instructions: "" } } as SmokeOverrides,
      expected: /missing instructions/,
    },
    {
      name: "instructions missing pm_context",
      overrides: { initResult: { instructions: "no guidance here" } } as SmokeOverrides,
      expected: /missing pm_context guidance/,
    },
    {
      name: "missing required tool",
      overrides: { tools: REQUIRED_TOOLS.filter((t) => t !== "pm_health") } as SmokeOverrides,
      expected: /Missing required MCP tool: pm_health/,
    },
    {
      name: "tool count mismatch",
      overrides: { tools: [...REQUIRED_TOOLS, "pm_extra"] } as SmokeOverrides,
      expected: /tools but the smoke expects/,
    },
    {
      name: "status not in_progress",
      overrides: { getResult: { item: { status: "open" }, linked: { files: [{}], tests: [{}] } } } as SmokeOverrides,
      expected: /Expected in_progress/,
    },
    {
      name: "no linked files",
      overrides: { getResult: { item: { status: "in_progress" }, linked: { files: [], tests: [{}] } } } as SmokeOverrides,
      expected: /at least 1 linked file/,
    },
    {
      name: "no linked tests",
      overrides: { getResult: { item: { status: "in_progress" }, linked: { files: [{}], tests: [] } } } as SmokeOverrides,
      expected: /at least 1 linked test/,
    },
  ])("throws and disposes when $name", async ({ overrides, expected }) => {
    const { dispose } = setupSmoke(overrides);
    vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(harness.importModuleStable(SCRIPT)).rejects.toThrow(expected);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("rethrows when the session-start hook exits non-zero", async () => {
    const { dispose } = setupSmoke({
      execSync: vi.fn(() => {
        throw Object.assign(new Error("hook boom"), { status: 2, stderr: "hook stderr" });
      }),
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(harness.importModuleStable(SCRIPT)).rejects.toThrow(/session-start hook failed with exit 2/);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("tolerates a hook error whose status is 0 (silent-exit error object)", async () => {
    const { dispose } = setupSmoke({
      execSync: vi.fn(() => {
        throw Object.assign(new Error("interrupted"), { status: 0 });
      }),
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await harness.importModuleStable(SCRIPT);
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes("Claude Code plugin smoke passed"))).toBe(true);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("assertMarketplacePluginNameMatches throws on the runtime-unreachable mismatch branch", async () => {
    // Drive the happy-path module body to completion so the exported `_testOnly`
    // seam is reachable, then exercise its (otherwise dead) mismatch branch and
    // its passing branch directly. The seam exists because the two pinned
    // "pm-claude" guards make the inline check unreachable at runtime.
    setupSmoke();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const mod = await harness.importModule<ClaudeModule>(SCRIPT);
    expect(() => mod.assertMarketplacePluginNameMatches("pm-claude", "other")).toThrow(
      /does not match plugin.json name/,
    );
    expect(() => mod.assertMarketplacePluginNameMatches("pm-claude", "pm-claude")).not.toThrow();
  });
});
