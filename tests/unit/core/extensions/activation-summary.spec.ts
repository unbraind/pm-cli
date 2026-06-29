import { describe, expect, it } from "vitest";
import { activateExtensions } from "../../../../src/core/extensions/loader.js";
import {
  KNOWN_EXTENSION_CAPABILITIES,
  createDefaultExtensionGovernancePolicy,
} from "../../../../src/core/extensions/extension-types.js";
import { describeExtensionActivation } from "../../../../src/core/extensions/activation-summary.js";
import { describeExtensionActivation as describeFromSdkBarrel } from "../../../../src/sdk/index.js";
import { describeExtensionActivation as describeFromSdkTesting } from "../../../../src/sdk/testing.js";
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

/** Register at least one surface for every known capability under one extension. */
function registerEverySurface(api: ExtensionApi): void {
  api.registerCommand({ name: "ext-a cmd", run: () => ({ ok: true }) });
  api.registerCommand("list", (context) => context.result);
  api.registerItemFields([{ name: "team", type: "string" }]);
  api.registerItemTypes([{ name: "Ticket" }]);
  api.registerMigration({ id: "ext-a-migration", run: () => ({}) });
  api.registerProfile({
    name: "ext-a-profile",
    title: "Ext A archetype",
    summary: "Synthetic archetype for the every-surface fixture.",
    types: [],
    statuses: [],
    fields: [],
    workflows: [],
    config: [],
    templates: [],
    packages: [],
  });
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

describe("describeExtensionActivation", () => {
  it("enumerates every registered surface by name", async () => {
    const activation = await activate([
      { name: "ext-a", capabilities: [...KNOWN_EXTENSION_CAPABILITIES], activate: registerEverySurface },
    ]);
    expect(activation.failed).toEqual([]);
    expect(describeExtensionActivation(activation)).toEqual({
      capabilities: [...KNOWN_EXTENSION_CAPABILITIES].sort(),
      // Only the declared definition: importer/exporter command paths are NOT
      // declared in registrations.commands unless command-metadata options are
      // passed (none are here), so they appear only under command_handlers below.
      commands: ["ext-a cmd"],
      command_overrides: ["list"],
      // The synthesized importer/exporter handlers join the declared command.
      command_handlers: ["ext-a cmd", "ext-a-export export", "ext-a-import import"],
      // Canonical hook order matches ExtensionActivationResult.hook_counts.
      hooks: ["before_command", "after_command", "on_write", "on_read", "on_index"],
      flag_commands: [],
      item_types: ["Ticket"],
      item_fields: ["team"],
      migrations: ["ext-a-migration"],
      profiles: ["ext-a-profile"],
      importers: ["ext-a-import"],
      exporters: ["ext-a-export"],
      search_providers: ["ext-a-search"],
      vector_store_adapters: ["ext-a-vector"],
      parser_overrides: ["ext-a cmd"],
      service_overrides: ["output_format"],
      renderer_overrides: ["toon"],
      preflight_overrides: 1,
    });
  });

  it("lists flag target-commands and de-duplicates them across commands and extensions", async () => {
    const activation = await activate([
      {
        name: "flagger",
        capabilities: ["commands", "schema"],
        activate: (api) => {
          // Two commands, registered out of order, the second also carrying flags.
          api.registerCommand({ name: "zeta run", run: () => ({}) });
          api.registerCommand({
            name: "alpha run",
            run: () => ({}),
            flags: [{ long: "--mine", value_type: "boolean" }],
          });
          api.registerFlags("alpha run", [{ long: "--loud", value_type: "boolean" }]);
        },
      },
      {
        name: "second-flagger",
        capabilities: ["commands", "schema"],
        activate: (api) => {
          // Re-flags the SAME "alpha run" target and adds a distinct one.
          api.registerFlags("alpha run", [{ long: "--again", value_type: "boolean" }]);
          api.registerFlags("beta run", [{ long: "--x", value_type: "boolean" }]);
        },
      },
    ]);
    const summary = describeExtensionActivation(activation);
    expect(summary.commands).toEqual(["alpha run", "zeta run"]);
    // "alpha run" is flagged twice within flagger and again by second-flagger;
    // the union across both registration forms and both extensions dedups to one entry.
    expect(summary.flag_commands).toEqual(["alpha run", "beta run"]);
    // Filtering isolates one extension's flag targets from the union.
    expect(describeExtensionActivation(activation, { extensionName: "flagger" }).flag_commands).toEqual(["alpha run"]);
  });

  it("unions surfaces across extensions and filters by extension name", async () => {
    const activation = await activate([
      { name: "ext-a", capabilities: [...KNOWN_EXTENSION_CAPABILITIES], activate: registerEverySurface },
      {
        name: "ext-b",
        capabilities: ["commands"],
        activate: (api) => api.registerCommand({ name: "ext-b cmd", run: () => ({}) }),
      },
    ]);
    // Unfiltered unions both extensions' declared command definitions.
    expect(describeExtensionActivation(activation).commands).toEqual(["ext-a cmd", "ext-b cmd"]);
    // command_handlers unions ext-a's handler (plus its importer/exporter paths) with ext-b's.
    expect(describeExtensionActivation(activation).command_handlers).toEqual([
      "ext-a cmd",
      "ext-a-export export",
      "ext-a-import import",
      "ext-b cmd",
    ]);
    // Filtered to ext-b: only its single command, no hooks, no providers.
    const extB = describeExtensionActivation(activation, { extensionName: "ext-b" });
    expect(extB.commands).toEqual(["ext-b cmd"]);
    expect(extB.hooks).toEqual([]);
    expect(extB.search_providers).toEqual([]);
    expect(extB.preflight_overrides).toBe(0);
    expect(extB.capabilities).toEqual(["commands"]);
    // Name matching is case-insensitive and trims surrounding whitespace.
    expect(describeExtensionActivation(activation, { extensionName: "  EXT-A  " }).search_providers).toEqual([
      "ext-a-search",
    ]);
  });

  it("normalizes whitespace in stored names so named surfaces and capabilities agree under a filter", async () => {
    // Activation stores extension.name verbatim, so a synthetic name can carry
    // whitespace. The filter must trim both sides (the same normalization the
    // capabilities field uses) or the two would disagree.
    const activation = await activate([
      {
        name: "  spacey  ",
        capabilities: ["commands"],
        activate: (api) => api.registerCommand({ name: "spacey cmd", run: () => ({}) }),
      },
    ]);
    const summary = describeExtensionActivation(activation, { extensionName: "spacey" });
    expect(summary.commands).toEqual(["spacey cmd"]);
    expect(summary.capabilities).toEqual(["commands"]);
  });

  it("returns an empty summary when no extension matches the name filter", async () => {
    const activation = await activate([
      { name: "ext-a", capabilities: [...KNOWN_EXTENSION_CAPABILITIES], activate: registerEverySurface },
    ]);
    expect(describeExtensionActivation(activation, { extensionName: "missing" })).toEqual({
      capabilities: [],
      commands: [],
      command_overrides: [],
      command_handlers: [],
      hooks: [],
      flag_commands: [],
      item_types: [],
      item_fields: [],
      migrations: [],
      profiles: [],
      importers: [],
      exporters: [],
      search_providers: [],
      vector_store_adapters: [],
      parser_overrides: [],
      service_overrides: [],
      renderer_overrides: [],
      preflight_overrides: 0,
    });
  });

  it("omits migrations registered without an id", async () => {
    const activation = await activate([
      {
        name: "migrator",
        capabilities: ["schema"],
        activate: (api) => {
          api.registerMigration({ id: "with-id", run: () => ({}) });
          // An id-less migration is registered but carries no identifier to list.
          api.registerMigration({ run: () => ({}) });
        },
      },
    ]);
    expect(activation.registration_counts.migrations).toBe(2);
    expect(describeExtensionActivation(activation).migrations).toEqual(["with-id"]);
  });

  it("summarizes an activation with no registrations as fully empty", async () => {
    const activation = await activate([]);
    const summary = describeExtensionActivation(activation);
    expect(summary.capabilities).toEqual([]);
    expect(summary.commands).toEqual([]);
    expect(summary.hooks).toEqual([]);
    expect(summary.preflight_overrides).toBe(0);
  });

  it("re-exports the same function from both SDK subpaths", () => {
    // The @unbrained/pm-cli/sdk barrel and the /sdk/testing subpath both surface
    // the identical core implementation, not a re-wrapped copy.
    expect(describeFromSdkBarrel).toBe(describeExtensionActivation);
    expect(describeFromSdkTesting).toBe(describeExtensionActivation);
  });
});
