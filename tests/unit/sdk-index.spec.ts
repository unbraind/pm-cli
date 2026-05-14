import { describe, expect, it } from "vitest";
import {
  EXTENSION_CAPABILITIES,
  PM_PACKAGE_RESOURCE_KINDS,
  PM_PROVIDER_TOOL_PARAMETERS_SCHEMA,
  PM_TOOL_ACTIONS,
  PM_TOOL_ACTION_PARAMETER_CONTRACTS,
  PM_TOOL_PARAMETERS_SCHEMA,
  appendHistoryEntry,
  createHistoryEntry,
  defineExtension,
  generateItemId,
  getItemPath,
  normalizeItemId,
  pathExists,
  readFileIfExists,
  readSettings,
  resolvePmRoot,
  writeFileAtomic,
} from "../../src/sdk/index.js";

describe("public sdk entrypoint", () => {
  it("exposes deterministic capability names", () => {
    expect(EXTENSION_CAPABILITIES).toEqual([
      "commands",
      "renderers",
      "hooks",
      "schema",
      "importers",
      "search",
      "parser",
      "preflight",
      "services",
    ]);
  });

  it("returns extension modules unchanged", () => {
    const extensionModule = defineExtension({
      manifest: {
        name: "test-ext",
        version: "1.0.0",
        entry: "./index.js",
        priority: 10,
        capabilities: ["commands"],
      },
      activate: () => undefined,
    });
    expect(extensionModule.manifest?.name).toBe("test-ext");
    expect(typeof extensionModule.activate).toBe("function");
  });

  it("exposes package resource kind contracts", () => {
    expect(PM_PACKAGE_RESOURCE_KINDS).toEqual([
      "extensions",
    ]);
  });

  it("exposes stable pm tool contract constants through the sdk barrel", () => {
    expect(PM_TOOL_ACTIONS).toContain("create");
    expect(PM_TOOL_ACTIONS).toContain("install");
    expect(PM_TOOL_ACTIONS).toContain("upgrade");
    expect(PM_TOOL_ACTIONS).not.toContain("beads-import");
    expect(PM_TOOL_ACTIONS).not.toContain("todos-export");

    expect(PM_TOOL_PARAMETERS_SCHEMA.type).toBe("object");
    expect(PM_TOOL_PARAMETERS_SCHEMA.oneOf).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          properties: expect.objectContaining({
            action: expect.objectContaining({ const: "create" }),
          }),
        }),
      ]),
    );
    expect(PM_PROVIDER_TOOL_PARAMETERS_SCHEMA).toMatchObject({
      type: "object",
      properties: {
        action: { type: "string" },
      },
    });
    expect(PM_TOOL_ACTION_PARAMETER_CONTRACTS.create.required).toEqual(expect.arrayContaining(["title"]));
    expect(PM_TOOL_ACTION_PARAMETER_CONTRACTS.upgrade.optional).toEqual(expect.arrayContaining(["dryRun"]));
  });

  it("exposes runtime primitives used by TypeScript pm packages through the sdk barrel", () => {
    expect(typeof pathExists).toBe("function");
    expect(typeof readFileIfExists).toBe("function");
    expect(typeof writeFileAtomic).toBe("function");
    expect(typeof appendHistoryEntry).toBe("function");
    expect(typeof createHistoryEntry).toBe("function");
    expect(typeof generateItemId).toBe("function");
    expect(typeof normalizeItemId).toBe("function");
    expect(typeof getItemPath).toBe("function");
    expect(typeof readSettings).toBe("function");
    expect(typeof resolvePmRoot).toBe("function");
  });
});
