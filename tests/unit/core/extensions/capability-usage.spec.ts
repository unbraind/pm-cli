import { describe, expect, it } from "vitest";
import { activateExtensions } from "../../../../src/core/extensions/loader.js";
import { createDefaultExtensionGovernancePolicy } from "../../../../src/core/extensions/extension-types.js";
import { KNOWN_EXTENSION_CAPABILITIES } from "../../../../src/core/extensions/extension-types.js";
import {
  EXTENSION_CAPABILITY_REGISTRATION_SURFACES,
  collectUsedExtensionCapabilities,
  reconcileExtensionCapabilityUsage,
} from "../../../../src/core/extensions/capability-usage.js";
import type { ExtensionActivationResult, ExtensionApi, ExtensionLayer } from "../../../../src/core/extensions/loader.js";

interface SyntheticExtension {
  name: string;
  layer?: ExtensionLayer;
  capabilities: string[];
  activate?: (api: ExtensionApi) => void;
}

/** Activate one or more in-memory extension modules through the real engine. */
async function activate(extensions: SyntheticExtension[]): Promise<ExtensionActivationResult> {
  return activateExtensions({
    disabled_by_flag: false,
    roots: { global: "", project: "" },
    configured_enabled: [],
    configured_disabled: [],
    discovered: [],
    effective: [],
    warnings: [],
    policy: createDefaultExtensionGovernancePolicy(),
    failed: [],
    loaded: extensions.map((extension) => ({
      layer: extension.layer ?? "project",
      directory: "",
      manifest_path: "",
      name: extension.name,
      version: "0.0.0",
      entry: "./index.js",
      priority: 0,
      entry_path: "",
      capabilities: extension.capabilities,
      module: { activate: extension.activate ?? (() => undefined) },
    })),
  });
}

/** Register at least one surface for every known capability. */
function registerEverySurface(api: ExtensionApi): void {
  api.registerCommand({ name: "ext-a cmd", run: () => ({ ok: true }) });
  api.registerCommand("list", (context) => context.result);
  api.registerItemFields([{ name: "team", type: "string" }]);
  api.registerItemTypes([{ name: "Ticket" }]);
  api.registerMigration({ id: "ext-a-migration", run: () => ({}) });
  api.registerImporter("ext-a-import", async () => ({ items: [] }));
  api.registerExporter("ext-a-export", async () => ({}));
  api.registerSearchProvider({ name: "ext-a-search", query: () => [] });
  api.registerVectorStoreAdapter({ name: "ext-a-vector", query: () => [] });
  api.registerParser("ext-a cmd", () => ({}));
  api.registerPreflight(() => ({}));
  api.registerService("output_format", () => null);
  api.registerRenderer("toon", () => null);
  api.hooks.beforeCommand(() => undefined);
  api.hooks.afterCommand(() => undefined);
  api.hooks.onWrite(() => undefined);
  api.hooks.onRead(() => undefined);
  api.hooks.onIndex(() => undefined);
}

describe("extension capability usage reconciliation", () => {
  it("maps every known capability to at least one registration surface", () => {
    const mappedCapabilities = Object.keys(EXTENSION_CAPABILITY_REGISTRATION_SURFACES).sort();
    expect(mappedCapabilities).toEqual([...KNOWN_EXTENSION_CAPABILITIES].sort());
    for (const surfaces of Object.values(EXTENSION_CAPABILITY_REGISTRATION_SURFACES)) {
      expect(surfaces.length).toBeGreaterThan(0);
    }
  });

  it("attributes every registration surface to its declared capability", async () => {
    const activation = await activate([
      { name: "ext-a", capabilities: [...KNOWN_EXTENSION_CAPABILITIES], activate: registerEverySurface },
    ]);
    expect(activation.failed).toEqual([]);
    expect(collectUsedExtensionCapabilities(activation)).toEqual([...KNOWN_EXTENSION_CAPABILITIES].sort());
    // Reconciling a manifest that declares every capability yields no unused
    // grant and reports the full sorted used set.
    const [entry] = reconcileExtensionCapabilityUsage(
      [{ layer: "project", name: "ext-a", capabilities: [...KNOWN_EXTENSION_CAPABILITIES] }],
      activation,
    );
    expect(entry.unused).toEqual([]);
    expect(entry.used).toEqual([...KNOWN_EXTENSION_CAPABILITIES].sort());
  });

  it("unions usage across extensions and filters by extension name", async () => {
    const activation = await activate([
      { name: "ext-a", capabilities: [...KNOWN_EXTENSION_CAPABILITIES], activate: registerEverySurface },
      {
        name: "ext-b",
        capabilities: ["commands"],
        activate: (api) => api.registerCommand({ name: "ext-b cmd", run: () => ({}) }),
      },
    ]);
    // Unfiltered unions both extensions' capabilities.
    expect(collectUsedExtensionCapabilities(activation)).toEqual([...KNOWN_EXTENSION_CAPABILITIES].sort());
    // Filtered to ext-b, only its single capability remains (ext-a is skipped).
    expect(collectUsedExtensionCapabilities(activation, { extensionName: "ext-b" })).toEqual(["commands"]);
    // Name matching is case-insensitive and trims surrounding whitespace.
    expect(collectUsedExtensionCapabilities(activation, { extensionName: "  EXT-A  " })).toEqual(
      [...KNOWN_EXTENSION_CAPABILITIES].sort(),
    );
    // A name that matches no extension yields nothing.
    expect(collectUsedExtensionCapabilities(activation, { extensionName: "missing" })).toEqual([]);
  });

  it("reports declared capabilities that are never exercised", async () => {
    const activation = await activate([
      {
        name: "over-declarer",
        capabilities: ["commands", "schema", "search"],
        activate: (api) => api.registerCommand({ name: "over-declarer cmd", run: () => ({}) }),
      },
    ]);
    const reconciliation = reconcileExtensionCapabilityUsage(
      [{ layer: "project", name: "over-declarer", capabilities: ["commands", "schema", "search"] }],
      activation,
    );
    expect(reconciliation).toEqual([
      {
        layer: "project",
        name: "over-declarer",
        declared: ["commands", "schema", "search"],
        used: ["commands"],
        unused: ["schema", "search"],
      },
    ]);
  });

  it("reports no unused capabilities for a least-privilege manifest", async () => {
    const activation = await activate([
      {
        name: "minimal",
        capabilities: ["commands"],
        activate: (api) => api.registerCommand({ name: "minimal cmd", run: () => ({}) }),
      },
    ]);
    const [entry] = reconcileExtensionCapabilityUsage(
      [{ layer: "project", name: "minimal", capabilities: ["commands"] }],
      activation,
    );
    expect(entry.unused).toEqual([]);
    expect(entry.used).toEqual(["commands"]);
  });

  it("treats an extension that registers nothing as fully unused", async () => {
    const activation = await activate([{ name: "inert", capabilities: ["commands"] }]);
    const [entry] = reconcileExtensionCapabilityUsage(
      [{ layer: "project", name: "inert", capabilities: ["commands"] }],
      activation,
    );
    expect(entry.used).toEqual([]);
    expect(entry.unused).toEqual(["commands"]);
  });

  it("skips extensions with no reconcilable declared capabilities and ignores unknown ones", async () => {
    const activation = await activate([
      {
        name: "noise",
        capabilities: ["commands"],
        activate: (api) => api.registerCommand({ name: "noise cmd", run: () => ({}) }),
      },
    ]);
    const reconciliation = reconcileExtensionCapabilityUsage(
      [
        // No capabilities array at all -> skipped.
        { layer: "project", name: "noise" },
        // Only an unknown capability -> normalizes to empty -> skipped.
        { layer: "project", name: "noise", capabilities: ["totally-made-up"] },
        // Mixed known + unknown + duplicate -> unknown dropped, known reconciled.
        { layer: "project", name: "noise", capabilities: ["Commands", "commands", "made-up"] },
      ],
      activation,
    );
    expect(reconciliation).toEqual([
      { layer: "project", name: "noise", declared: ["commands"], used: ["commands"], unused: [] },
    ]);
  });

  it("keeps same-named extensions on different layers distinct", async () => {
    const activation = await activate([
      {
        name: "shared",
        layer: "global",
        capabilities: ["commands"],
        activate: (api) => api.registerCommand({ name: "shared global", run: () => ({}) }),
      },
    ]);
    // The project-layer entry shares the name but registered nothing, so its
    // declared capability is reported unused even though the global layer uses it.
    const reconciliation = reconcileExtensionCapabilityUsage(
      [
        { layer: "global", name: "shared", capabilities: ["commands"] },
        { layer: "project", name: "shared", capabilities: ["commands"] },
      ],
      activation,
    );
    expect(reconciliation).toEqual([
      { layer: "global", name: "shared", declared: ["commands"], used: ["commands"], unused: [] },
      { layer: "project", name: "shared", declared: ["commands"], used: [], unused: ["commands"] },
    ]);
  });

  it("returns no usage for an activation with no registrations", async () => {
    const activation = await activate([]);
    expect(collectUsedExtensionCapabilities(activation)).toEqual([]);
    expect(reconcileExtensionCapabilityUsage([], activation)).toEqual([]);
  });
});
