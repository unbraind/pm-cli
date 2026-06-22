import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildExtensionDescribeResult } from "../../../src/cli/commands/extension/describe.js";
import { runExtension } from "../../../src/cli/commands/extension.js";
import { activateExtensions } from "../../../src/core/extensions/loader.js";
import type {
  ExtensionActivationResult,
  ExtensionApi,
  ExtensionLayer,
  ExtensionLoadResult,
  LoadedExtension,
} from "../../../src/core/extensions/loader.js";
import { createDefaultExtensionGovernancePolicy } from "../../../src/core/extensions/extension-types.js";
import { EXIT_CODE } from "../../../src/core/shared/constants.js";
import { writeTestExtension } from "../../helpers/extensions.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

interface SyntheticLoaded {
  name: string;
  layer?: ExtensionLayer;
  version?: string;
  capabilities?: string[];
  activate?: (api: ExtensionApi) => void;
}

function toLoadedExtension(extension: SyntheticLoaded): LoadedExtension {
  return {
    layer: extension.layer ?? "project",
    directory: "",
    manifest_path: "",
    name: extension.name,
    version: extension.version ?? "0.0.0",
    entry: "./index.js",
    priority: 0,
    entry_path: "",
    capabilities: extension.capabilities ?? ["commands"],
    module: { activate: extension.activate ?? (() => undefined) },
  };
}

/** Build a real load+activation pair through the engine for describe assertions. */
async function buildActivation(
  loaded: SyntheticLoaded[],
  failedLoads: Array<{ name: string; layer?: ExtensionLayer }> = [],
): Promise<{ loadResult: ExtensionLoadResult; activationResult: ExtensionActivationResult }> {
  const loadResult: ExtensionLoadResult = {
    disabled_by_flag: false,
    roots: { global: "", project: "" },
    configured_enabled: [],
    configured_disabled: [],
    discovered: [],
    effective: [],
    warnings: [],
    policy: createDefaultExtensionGovernancePolicy(),
    failed: failedLoads.map((entry) => ({
      layer: entry.layer ?? "project",
      name: entry.name,
      entry_path: "",
      error: "load boom",
    })),
    loaded: loaded.map(toLoadedExtension),
  };
  return { loadResult, activationResult: await activateExtensions(loadResult) };
}

describe("buildExtensionDescribeResult", () => {
  it("describes every loaded extension with ok status and a deduplicated union", async () => {
    const { loadResult, activationResult } = await buildActivation([
      { name: "ext-b", activate: (api) => api.registerCommand({ name: "ext-b cmd", run: () => ({ ok: true }) }) },
      { name: "ext-a", capabilities: ["hooks"], activate: (api) => api.hooks.afterCommand(() => undefined) },
    ]);

    const result = buildExtensionDescribeResult(undefined, loadResult, activationResult);

    expect(result.target).toBeNull();
    expect(result.total).toBe(2);
    // Sorted by name regardless of load order.
    expect(result.extensions.map((entry) => entry.name)).toEqual(["ext-a", "ext-b"]);
    expect(result.extensions.every((entry) => entry.activation_status === "ok")).toBe(true);
    const extA = result.extensions.find((entry) => entry.name === "ext-a");
    expect(extA?.surfaces.hooks).toEqual(["after_command"]);
    expect(extA?.surfaces.commands).toEqual([]);
    expect(result.union.commands).toEqual(["ext-b cmd"]);
    expect(result.union.hooks).toEqual(["after_command"]);
  });

  it("marks an extension whose activate throws as failed with empty surfaces", async () => {
    const { loadResult, activationResult } = await buildActivation([
      {
        name: "boomer",
        activate: () => {
          throw new Error("activation boom");
        },
      },
    ]);
    expect(activationResult.failed).toHaveLength(1);

    const result = buildExtensionDescribeResult(undefined, loadResult, activationResult);

    expect(result.extensions).toHaveLength(1);
    expect(result.extensions[0]?.activation_status).toBe("failed");
    expect(result.extensions[0]?.surfaces.commands).toEqual([]);
  });

  it("marks failed-to-load extensions as not_loaded with an unknown version", async () => {
    const { loadResult, activationResult } = await buildActivation([], [{ name: "broken" }]);

    const result = buildExtensionDescribeResult(undefined, loadResult, activationResult);

    expect(result.extensions).toHaveLength(1);
    expect(result.extensions[0]).toMatchObject({ name: "broken", activation_status: "not_loaded", version: "unknown" });
  });

  it("filters to a named target case-insensitively and scopes the union", async () => {
    const { loadResult, activationResult } = await buildActivation([
      { name: "ext-a", activate: (api) => api.registerCommand({ name: "ext-a cmd", run: () => ({}) }) },
      { name: "ext-b", activate: (api) => api.registerCommand({ name: "ext-b cmd", run: () => ({}) }) },
    ]);

    const result = buildExtensionDescribeResult("  EXT-B  ", loadResult, activationResult);

    // Target echoes the trimmed input verbatim (case preserved).
    expect(result.target).toBe("EXT-B");
    expect(result.total).toBe(1);
    expect(result.extensions[0]?.name).toBe("ext-b");
    expect(result.union.commands).toEqual(["ext-b cmd"]);
  });

  it("returns no extensions for a target that matches nothing", async () => {
    const { loadResult, activationResult } = await buildActivation([{ name: "ext-a" }]);

    const result = buildExtensionDescribeResult("missing", loadResult, activationResult);

    expect(result.total).toBe(0);
    expect(result.extensions).toEqual([]);
    expect(result.union.capabilities).toEqual([]);
  });

  it("sorts entries by name then layer when one name is loaded in multiple layers", async () => {
    const { loadResult, activationResult } = await buildActivation([
      { name: "dup", layer: "project" },
      { name: "dup", layer: "global" },
    ]);

    const result = buildExtensionDescribeResult(undefined, loadResult, activationResult);

    // Equal names fall back to the layer comparator: "global" sorts before "project".
    expect(result.extensions.map((entry) => entry.layer)).toEqual(["global", "project"]);
  });
});

describe("extension describe action", () => {
  it("describes installed extensions and a single extension by name", async () => {
    await withTempPmPath(async (context) => {
      await writeTestExtension({
        root: path.join(context.pmPath, "extensions", "demo-ext"),
        name: "demo-ext",
        entrySource:
          "export default { activate(api) { api.registerCommand({ name: 'demo ping', run: () => ({ ok: true }) }); } };\n",
      });

      const all = await runExtension(undefined, { describe: true, project: true }, { path: context.pmPath });
      expect(all.action).toBe("describe");
      const allDetails = all.details as {
        target: string | null;
        extensions: Array<{ name: string; activation_status: string; surfaces: { commands: string[] } }>;
        union: { commands: string[] };
      };
      expect(allDetails.target).toBeNull();
      const demo = allDetails.extensions.find((entry) => entry.name === "demo-ext");
      expect(demo?.activation_status).toBe("ok");
      expect(demo?.surfaces.commands).toContain("demo ping");
      expect(allDetails.union.commands).toContain("demo ping");

      // A mixed-case target matches case-insensitively yet echoes the original
      // casing verbatim: runExtension forwards the raw (alias-normalized, not
      // lowercased) target, so describe never mangles the requested name.
      const byName = await runExtension("Demo-Ext", { describe: true, project: true }, { path: context.pmPath });
      const byNameDetails = byName.details as { target: string | null; total: number };
      expect(byNameDetails.target).toBe("Demo-Ext");
      expect(byNameDetails.total).toBe(1);
    });
  });

  it("throws NOT_FOUND naming the extension vocabulary for an unknown target", async () => {
    await withTempPmPath(async (context) => {
      await expect(
        runExtension("ghost", { describe: true, project: true }, { path: context.pmPath }),
      ).rejects.toMatchObject({ exitCode: EXIT_CODE.NOT_FOUND, message: /No loaded extension named "ghost"/ });
    });
  });

  it("throws NOT_FOUND naming the package vocabulary for an unknown target", async () => {
    await withTempPmPath(async (context) => {
      await expect(
        runExtension("ghost", { describe: true, project: true, vocabulary: "package" }, { path: context.pmPath }),
      ).rejects.toThrow(/No loaded package named "ghost"/);
    });
  });
});
