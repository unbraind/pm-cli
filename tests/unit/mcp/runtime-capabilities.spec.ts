import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  _testOnlyMcpRuntimeCapabilities,
  normalizeWorkspaceToolArguments,
  resolveMcpToolAccess,
  resolveMcpToolProfile,
  resolveMcpToolSurface,
  selectMcpExtensionActions,
} from "../../../src/mcp/runtime-capabilities.js";
import {
  NARROW_TOOL_ACTIONS,
  TOOLS,
  TOOL_SCHEMA_BASE,
} from "../../../src/mcp/tool-definitions.js";
import { handleRequest } from "../../../src/mcp/server.js";
import {
  listPmCommandsForTier,
  listPmMcpToolsForProfile,
  renderPmCommandVisibilityMarkdown,
  resolvePmCommandVisibilityTier,
} from "../../../src/sdk/agent-capability-contracts.js";
import { buildPmActionToolInputSchema } from "../../../src/sdk/cli-contracts.js";
import { buildWorkspaceExtensionCommandContracts } from "../../../src/sdk/workspace-contracts.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";
import { writeTestExtension } from "../../helpers/extensions.js";

describe("runtime MCP capabilities", () => {
  const originalProfile = process.env.PM_MCP_PROFILE;
  const originalTools = process.env.PM_MCP_TOOLS;

  afterEach(() => {
    if (originalProfile === undefined) delete process.env.PM_MCP_PROFILE;
    else process.env.PM_MCP_PROFILE = originalProfile;
    if (originalTools === undefined) delete process.env.PM_MCP_TOOLS;
    else process.env.PM_MCP_TOOLS = originalTools;
  });

  it("defaults to a bounded core profile and expands deterministically", async () => {
    expect(resolveMcpToolProfile({})).toBe("core");
    expect(resolveMcpToolProfile({ PM_MCP_PROFILE: "   " })).toBe("core");
    const core = await resolveMcpToolSurface(TOOLS, {}, {});
    const standard = await resolveMcpToolSurface(TOOLS, {}, {
      PM_MCP_PROFILE: "standard",
    });
    const full = await resolveMcpToolSurface(TOOLS, {}, {
      PM_MCP_PROFILE: "full",
    });
    expect(core.tools.length).toBeLessThan(standard.tools.length);
    expect(standard.tools.length).toBeLessThan(full.tools.length);
    expect(full.tools).toHaveLength(TOOLS.length);
    expect(core.tools.map((tool) => tool.name)).toContain("pm_context");
    expect(JSON.stringify(core.tools[0]?.inputSchema)).not.toContain(
      "Workspace directory to run the native pm operation in.",
    );
    const coreCreate = core.tools.find((tool) => tool.name === "pm_create");
    expect(coreCreate).toBeDefined();
    expect(coreCreate?.inputSchema.properties).toHaveProperty("description");
    expect(JSON.stringify(full.tools[0]?.inputSchema)).toContain(
      '"description"',
    );
    expect(listPmCommandsForTier("core")).toContain("context");
    expect(listPmMcpToolsForProfile(["pm_context", "pm_run"], "full")).toEqual([
      "pm_context",
      "pm_run",
    ]);
    expect(resolvePmCommandVisibilityTier(" CONTEXT ")).toBe("core");
    expect(resolvePmCommandVisibilityTier("extension-owned")).toBe("standard");
    expect(resolvePmCommandVisibilityTier("extension-owned", "full")).toBe(
      "full",
    );
    expect(renderPmCommandVisibilityMarkdown()).toContain(
      "| `context` | core |",
    );
    expect(buildPmActionToolInputSchema("get")).toMatchObject({
      additionalProperties: true,
      required: ["id"],
    });
    expect(
      buildPmActionToolInputSchema("get", {
        additionalProperties: false,
        required: [],
      }),
    ).toMatchObject({ additionalProperties: false, required: [] });
    expect(
      buildPmActionToolInputSchema("search", {
        properties: {},
        required: ["query"],
      }),
    ).toMatchObject({
      required: [],
      anyOf: [{ required: ["query"] }, { required: ["keywords"] }],
    });
    expect(
      buildPmActionToolInputSchema("claim", {
        properties: {},
        required: ["id"],
      }),
    ).toMatchObject({
      required: [],
      oneOf: [{ required: ["id"] }, { required: ["next"] }],
    });
    const claimSchema = buildPmActionToolInputSchema("claim");
    expect(claimSchema.properties).toMatchObject({
      tag: { description: expect.stringContaining("exact tag") },
      tokenBudget: {
        description: expect.stringContaining("next-item context"),
      },
      force: { description: expect.stringContaining("ownership") },
    });
    expect(buildPmActionToolInputSchema("close").properties).toMatchObject({
      text: { description: expect.stringContaining("close reason") },
    });
    expect(
      buildPmActionToolInputSchema("close-task").properties,
    ).toMatchObject({
      text: { description: expect.stringContaining("active assignment") },
    });
    const transportKeys = new Set(Object.keys(TOOL_SCHEMA_BASE.properties));
    for (const [toolName, action] of Object.entries(NARROW_TOOL_ACTIONS)) {
      const actual = TOOLS.find((tool) => tool.name === toolName);
      const canonical = buildPmActionToolInputSchema(action);
      const canonicalKeys = new Set([
        ...Object.keys(canonical.properties as Record<string, unknown>),
        ...transportKeys,
      ]);
      expect(
        Object.keys(
          actual?.inputSchema.properties as Record<string, unknown>,
        ).filter((key) => !canonicalKeys.has(key)),
      ).toEqual([]);
    }
    const extensionCommands = [
      { command: "a", action: "a", arguments: [], tier: "core" as const },
      {
        command: "b",
        action: "b",
        arguments: [],
        tier: "standard" as const,
      },
      { command: "c", action: "c", arguments: [], tier: "full" as const },
      {
        command: "d",
        action: "d",
        arguments: [],
        tier: "internal" as const,
      },
    ];
    expect(
      selectMcpExtensionActions(extensionCommands, "core", new Set()),
    ).toEqual(["a"]);
    expect(
      selectMcpExtensionActions(extensionCommands, "standard", new Set()),
    ).toEqual(["a", "b"]);
    expect(
      selectMcpExtensionActions(extensionCommands, "full", new Set()),
    ).toEqual(["a", "b", "c"]);
    expect(
      selectMcpExtensionActions(
        extensionCommands,
        "custom",
        new Set(["pm_run"]),
      ),
    ).toEqual(["a", "b", "c", "d"]);
    expect(
      selectMcpExtensionActions(extensionCommands, "custom", new Set()),
    ).toEqual([]);
    expect(_testOnlyMcpRuntimeCapabilities.workspaceFields({})).toEqual([]);
    expect(
      _testOnlyMcpRuntimeCapabilities.workspaceExtensionCommands({}),
    ).toEqual([]);
    expect(
      buildWorkspaceExtensionCommandContracts([
        {
          layer: "project",
          name: "projection-test",
          command: "projection test",
          action: "projection-test",
          examples: [],
          failure_hints: [],
          arguments: [
            {
              name: "targets",
              required: true,
              variadic: true,
              description: "Targets to project.",
            },
            { name: "mode" },
          ],
        },
      ]),
    ).toEqual([
      {
        command: "projection test",
        action: "projection-test",
        arguments: [
          {
            name: "targets",
            required: true,
            variadic: true,
            description: "Targets to project.",
          },
          {
            name: "mode",
            required: false,
            variadic: false,
            description: undefined,
          },
        ],
        description: undefined,
        tier: "standard",
      },
    ]);
  });

  it("validates custom profiles and exact tool allowlists", async () => {
    await expect(
      resolveMcpToolSurface(TOOLS, {}, { PM_MCP_PROFILE: "custom" }),
    ).rejects.toThrow("requires a non-empty PM_MCP_TOOLS");
    await expect(
      resolveMcpToolSurface(TOOLS, {}, {
        PM_MCP_PROFILE: "custom",
        PM_MCP_TOOLS: "pm_context,pm_missing",
      }),
    ).rejects.toThrow("unknown tools: pm_missing");
    const custom = await resolveMcpToolSurface(TOOLS, {}, {
      PM_MCP_PROFILE: "custom",
      PM_MCP_TOOLS: " ,pm_context,pm_get,,",
    });
    expect(custom.tools.map((tool) => tool.name)).toEqual([
      "pm_context",
      "pm_get",
    ]);
    expect(() =>
      resolveMcpToolProfile({ PM_MCP_PROFILE: "enormous" }),
    ).toThrow("expected core, standard, full, or custom");
  });

  it("advertises resources and renders canonical workflow prompts", async () => {
    const resources = (await handleRequest({
      id: 1,
      method: "resources/list",
    })) as { resources?: Array<{ uri?: string }> };
    expect(resources.resources?.map((resource) => resource.uri)).toEqual([
      "pm://workspace/context",
      "pm://workspace/focus",
      "pm://workspace/claims",
      "pm://workspace/agent-guide",
    ]);
    const prompts = (await handleRequest({
      id: 2,
      method: "prompts/list",
    })) as { prompts?: Array<{ name?: string }> };
    expect(prompts.prompts?.map((prompt) => prompt.name)).toEqual([
      "orient",
      "claim-and-start",
      "record-evidence-and-close",
    ]);
    const prompt = (await handleRequest({
      id: 3,
      method: "prompts/get",
      params: {
        name: "orient",
        arguments: { request: "custom SDK delivery" },
      },
    })) as { messages?: Array<{ content?: { text?: string } }> };
    expect(prompt.messages?.[0]?.content?.text).toContain(
      "custom SDK delivery",
    );
    await expect(
      handleRequest({
        id: 4,
        method: "prompts/get",
        params: { name: "missing" },
      }),
    ).rejects.toThrow("Unknown pm MCP prompt");
    await expect(
      handleRequest({
        id: 5,
        method: "prompts/get",
        params: { name: "orient", arguments: {} },
      }),
    ).rejects.toThrow("Missing required prompt argument: request");
    process.env.PM_MCP_PROFILE = "core";
    await expect(
      handleRequest({
        id: 6,
        method: "tools/call",
        params: { name: "pm_run", arguments: { action: "context" } },
      }),
    ).rejects.toThrow("unavailable in the core profile");
    await expect(
      resolveMcpToolAccess(TOOLS, "pm_context", {}, {}),
    ).resolves.toEqual({ profile: "core", available: true });
    await expect(resolveMcpToolAccess(TOOLS, "pm_run", {}, {})).resolves.toEqual(
      { profile: "core", available: false },
    );
    await expect(
      resolveMcpToolAccess(TOOLS, "pm_run", {}, {
        PM_MCP_PROFILE: "custom",
        PM_MCP_TOOLS: "pm_context",
      }),
    ).resolves.toEqual({ profile: "custom", available: false });
  });

  it("projects runtime fields into schemas and mutation options", async () => {
    await withTempPmPath(async (context) => {
      const addField = context.runCli([
        "schema",
        "add-field",
        "portfolio-signal",
        "--type",
        "string",
        "--commands",
        "create,update",
        "--description",
        "Portfolio delivery signal",
        "--json",
      ]);
      expect(addField.code).toBe(0);
      const surface = await resolveMcpToolSurface(
        TOOLS,
        { path: context.pmPath },
        { PM_MCP_PROFILE: "full" },
      );
      const create = surface.tools.find((tool) => tool.name === "pm_create");
      expect(
        (
          create?.inputSchema.properties as
            | Record<string, unknown>
            | undefined
        )?.portfolioSignal,
      ).toMatchObject({ type: "string" });
      await expect(
        normalizeWorkspaceToolArguments("pm_create", {
          path: context.pmPath,
          portfolioSignal: "high",
        }),
      ).resolves.toEqual({
        path: context.pmPath,
        options: { portfolioSignal: "high" },
      });
      await expect(
        normalizeWorkspaceToolArguments("pm_update", {
          path: context.pmPath,
          options: { keep: true },
          portfolioSignal: "medium",
        }),
      ).resolves.toMatchObject({
        options: { keep: true, portfolioSignal: "medium" },
      });
      const unchanged = { path: context.pmPath };
      await expect(
        normalizeWorkspaceToolArguments("pm_update", unchanged),
      ).resolves.toBe(unchanged);
      await expect(
        normalizeWorkspaceToolArguments("pm_context", unchanged),
      ).resolves.toBe(unchanged);
      await expect(
        normalizeWorkspaceToolArguments("pm_update", {
          path: context.pmPath,
          options: null,
        }),
      ).resolves.toMatchObject({ options: null });
      await expect(
        normalizeWorkspaceToolArguments("pm_update", {
          path: context.pmPath,
          options: [],
        }),
      ).resolves.toMatchObject({ options: [] });
      await expect(
        normalizeWorkspaceToolArguments("pm_update", {
          cwd: context.tempRoot,
        }),
      ).resolves.toMatchObject({ cwd: context.tempRoot });
      const missingWorkspace = { path: `${context.tempRoot}/missing-pm` };
      await expect(
        normalizeWorkspaceToolArguments("pm_create", missingWorkspace),
      ).resolves.toBe(missingWorkspace);
      const addListField = context.runCli([
        "schema",
        "add-field",
        "delivery-markers",
        "--type",
        "string_array",
        "--commands",
        "create",
        "--json",
      ]);
      expect(addListField.code).toBe(0);
      const refreshed = await resolveMcpToolSurface(
        TOOLS,
        { path: context.pmPath },
        { PM_MCP_PROFILE: "full" },
      );
      const refreshedCreate = refreshed.tools.find(
        (tool) => tool.name === "pm_create",
      );
      expect(refreshedCreate).toBeDefined();
      expect(
        refreshedCreate?.inputSchema.properties,
      ).toMatchObject({
        deliveryMarkers: {
          type: "array",
          items: { type: "string" },
        },
      });
    });
  });

  it("promotes pm_run only for a visible activated extension action", async () => {
    await withTempPmPath(async (context) => {
      await writeTestExtension({
        root: path.join(context.pmPath, "extensions"),
        directory: "mcp-core-command",
        name: "mcp-core-command",
        entrySource: [
          "export default {",
          "  activate(api) {",
          "    api.registerCommand({",
          "      name: 'mcp core ping',",
          "      tier: 'core',",
          "      arguments: [{ name: 'target', required: true }],",
          "      run: () => ({ ok: true }),",
          "    });",
          "  },",
          "};",
          "",
        ].join("\n"),
      });
      await expect(
        resolveMcpToolAccess(
          TOOLS,
          "pm_run",
          { cwd: context.tempRoot, path: context.pmPath },
          {},
        ),
      ).resolves.toEqual({ profile: "core", available: true });
      const surface = await resolveMcpToolSurface(
        TOOLS,
        { cwd: context.tempRoot, path: context.pmPath },
        {},
      );
      expect(surface.extensionActions).toContain("mcp-core-ping");
      expect(
        surface.tools.find((tool) => tool.name === "pm_run")?.inputSchema
          .properties,
      ).toMatchObject({
        action: { enum: expect.arrayContaining(["mcp-core-ping"]) },
      });
    });
  });

  it("reads every bounded workspace resource and rejects unknown URIs", async () => {
    await withTempPmPath(async (context) => {
      await writeFile(
        `${context.tempRoot}/AGENTS.md`,
        "# Temporary agent guide\n",
        "utf8",
      );
      for (const uri of [
        "pm://workspace/context",
        "pm://workspace/focus",
        "pm://workspace/claims",
        "pm://workspace/agent-guide",
      ]) {
        const result = (await handleRequest({
          id: uri,
          method: "resources/read",
          params: {
            uri,
            arguments: {
              path: context.pmPath,
              cwd: context.tempRoot,
            },
          },
        })) as { contents?: Array<{ text?: string; mimeType?: string }> };
        expect(result.contents?.[0]?.text).toBeTypeOf("string");
        expect(result.contents?.[0]?.mimeType).toBeTypeOf("string");
      }
      const missingGuide = (await handleRequest({
        id: 8,
        method: "resources/read",
        params: {
          uri: "pm://workspace/agent-guide",
          arguments: { cwd: context.pmPath },
        },
      })) as { contents?: Array<{ text?: string }> };
      expect(missingGuide.contents?.[0]?.text).toContain("No repository-local");
      await expect(
        handleRequest({
          id: 9,
          method: "resources/read",
          params: { uri: "pm://workspace/missing" },
        }),
      ).rejects.toThrow("Unknown pm MCP resource");
    });
  });
});
