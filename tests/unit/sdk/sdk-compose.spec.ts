import { describe, expect, it } from "vitest";
import {
  composeExtension,
  defineExtension,
  deriveExtensionCapabilities,
  type ExtensionBlueprint,
} from "../../../src/sdk/compose.js";
import {
  composeExtension as composeExtensionFromBarrel,
  defineExtension as defineExtensionFromBarrel,
  deriveExtensionCapabilities as deriveExtensionCapabilitiesFromBarrel,
  type ExtensionApi,
} from "../../../src/sdk/index.js";
import { activateExtensionForTest } from "../../../src/sdk/testing.js";

/**
 * A blueprint that exercises every registration surface exactly once, used to
 * prove composeExtension wires each `api.register*` and deriveExtensionCapabilities
 * reports the full capability union.
 */
function buildFullBlueprint(observed: { imperative: boolean }): ExtensionBlueprint {
  return {
    manifest: {
      name: "compose-full",
      version: "0.1.0",
      entry: "./index.js",
      priority: 0,
      capabilities: ["commands", "schema", "parser", "preflight", "renderers", "services", "search", "importers", "hooks"],
    },
    commands: [{ name: "compose demo", action: "compose-demo", run: () => ({ ok: true }) }],
    commandOverrides: { list: () => undefined },
    flags: { list: [{ long: "--compose-note", value_type: "string", value_name: "text" }] },
    parsers: { "compose demo": () => ({}) },
    renderers: { toon: () => null },
    services: { output_format: () => undefined },
    preflights: [() => ({})],
    itemTypes: [{ name: "ComposeIncident", folder: "compose-incidents", aliases: ["compose-incident"] }],
    itemFields: [{ name: "compose_severity", type: "string" }],
    migrations: [{ id: "compose-migration", description: "demo migration" }],
    searchProviders: [{ name: "compose-search", query: async () => ({ hits: [] }) }],
    vectorStoreAdapters: [{ name: "compose-vector", query: async () => [] }],
    importers: [{ name: "compose-import", importer: () => ({ imported: 0 }) }],
    exporters: [{ name: "compose-export", exporter: () => ({ exported: true }) }],
    hooks: {
      beforeCommand: [() => undefined],
      afterCommand: [() => undefined],
      onWrite: [() => undefined],
      onRead: [() => undefined],
      onIndex: [() => undefined],
    },
    activate: () => {
      observed.imperative = true;
    },
    deactivate: () => undefined,
  };
}

const ALL_CAPABILITIES = ["commands", "hooks", "importers", "parser", "preflight", "renderers", "schema", "search", "services"];

describe("sdk composeExtension", () => {
  it("returns extension modules unchanged via the relocated defineExtension identity helper", () => {
    const extensionModule = {
      manifest: { name: "ident", version: "1.0.0", entry: "./index.js", priority: 0, capabilities: ["commands"] as const },
      activate: () => undefined,
    };
    // defineExtension is a zero-cost identity helper that now lives in compose.ts
    // but is still re-exported from the barrel at the same name.
    expect(defineExtension(extensionModule)).toBe(extensionModule);
    expect(defineExtensionFromBarrel).toBe(defineExtension);
    expect(composeExtensionFromBarrel).toBe(composeExtension);
    expect(deriveExtensionCapabilitiesFromBarrel).toBe(deriveExtensionCapabilities);
  });

  it("wires every declarative registration surface and runs the imperative activate last", async () => {
    const observed = { imperative: false };
    const blueprint = buildFullBlueprint(observed);

    // deriveExtensionCapabilities reports exactly the capabilities the blueprint
    // exercises, sorted and de-duplicated (flags/itemTypes/itemFields/migrations
    // all collapse to a single "schema"; search providers + vector adapters to
    // "search"; importers + exporters to "importers").
    const derived = deriveExtensionCapabilities(blueprint);
    expect(derived).toEqual(ALL_CAPABILITIES);

    const composed = composeExtension(blueprint);
    expect(composed.manifest).toBe(blueprint.manifest);
    expect(typeof composed.deactivate).toBe("function");

    // Activating with exactly the derived capabilities must not produce a single
    // capability-missing failure: derive ⟷ compose ⟷ loader agree by construction.
    const activation = await activateExtensionForTest(composed, { name: "compose-full", capabilities: derived });
    expect(activation.failed).toEqual([]);

    // Every surface registered exactly once.
    expect(activation.registration_counts).toMatchObject({
      commands: 1,
      flags: 1,
      item_types: 1,
      item_fields: 1,
      migrations: 1,
      importers: 1,
      exporters: 1,
      search_providers: 1,
      vector_store_adapters: 1,
    });
    expect(activation.command_override_count).toBe(1);
    expect(activation.parser_override_count).toBe(1);
    expect(activation.preflight_override_count).toBe(1);
    expect(activation.service_override_count).toBe(1);
    expect(activation.renderer_override_count).toBe(1);
    expect(activation.hook_counts).toEqual({
      before_command: 1,
      after_command: 1,
      on_write: 1,
      on_read: 1,
      on_index: 1,
    });
    // The imperative escape hatch ran (after the declarative wiring).
    expect(observed.imperative).toBe(true);
  });

  it("runs declarative registrations before the imperative activate escape hatch", async () => {
    const composed = composeExtension({
      commands: [{ name: "compose alpha", action: "compose-alpha", run: () => ({}) }],
      activate: (api: ExtensionApi) => {
        api.registerCommand({ name: "compose beta", action: "compose-beta", run: () => ({}) });
      },
    });

    const activation = await activateExtensionForTest(composed, { capabilities: ["commands"] });
    // The declarative command is registered first, the imperative one second.
    expect(activation.registrations.commands.map((command) => command.command)).toEqual([
      "compose alpha",
      "compose beta",
    ]);
  });

  it("produces a no-op module from an empty blueprint", async () => {
    const composed = composeExtension({});
    // No manifest, no deactivate, but always a callable activate.
    expect(composed.manifest).toBeUndefined();
    expect(composed.deactivate).toBeUndefined();
    expect(typeof composed.activate).toBe("function");

    const activation = await activateExtensionForTest(composed, {});
    expect(activation.failed).toEqual([]);
    expect(activation.registration_counts).toMatchObject({ commands: 0, flags: 0, item_types: 0, item_fields: 0 });
    expect(activation.hook_counts).toEqual({
      before_command: 0,
      after_command: 0,
      on_write: 0,
      on_read: 0,
      on_index: 0,
    });
  });

  it("tolerates explicit null for optional fields and hooks (untyped .js authors)", async () => {
    // A plain-JavaScript author can pass an explicit null where the type expects
    // an optional field; composeExtension and deriveExtensionCapabilities must
    // treat null like undefined instead of throwing (e.g. Object.keys(null) or a
    // null hooks dereference). The double cast models that out-of-type input.
    const nullish = {
      commands: null,
      flags: null,
      hooks: null,
      manifest: null,
      deactivate: null,
    } as unknown as ExtensionBlueprint;
    expect(deriveExtensionCapabilities(nullish)).toEqual([]);
    const composed = composeExtension(nullish);
    expect(composed.manifest).toBeUndefined();
    expect(composed.deactivate).toBeUndefined();
    const activation = await activateExtensionForTest(composed, {});
    expect(activation.failed).toEqual([]);
    expect(activation.hook_counts.after_command).toBe(0);
  });
});

describe("sdk deriveExtensionCapabilities", () => {
  it("returns an empty array for a blueprint with no registration surfaces", () => {
    expect(deriveExtensionCapabilities({})).toEqual([]);
    // hooks present-but-empty still derives nothing.
    expect(deriveExtensionCapabilities({ hooks: {} })).toEqual([]);
  });

  it("treats empty arrays and empty records as absent surfaces", () => {
    // hasEntries distinguishes an empty collection from a populated one for both
    // array-valued and record-valued fields.
    expect(deriveExtensionCapabilities({ commands: [], flags: {} })).toEqual([]);
  });

  it("maps each surface to its least-privilege capability", () => {
    // The non-obvious surface→capability mappings are pinned individually.
    expect(deriveExtensionCapabilities({ commands: [{ name: "a b", action: "a-b", run: () => ({}) }] })).toEqual([
      "commands",
    ]);
    expect(deriveExtensionCapabilities({ commandOverrides: { list: () => undefined } })).toEqual(["commands"]);
    expect(deriveExtensionCapabilities({ flags: { list: [{ long: "--x" }] } })).toEqual(["schema"]);
    expect(deriveExtensionCapabilities({ itemTypes: [{ name: "T", folder: "t" }] })).toEqual(["schema"]);
    expect(deriveExtensionCapabilities({ itemFields: [{ name: "f", type: "string" }] })).toEqual(["schema"]);
    expect(deriveExtensionCapabilities({ migrations: [{ id: "m", description: "d" }] })).toEqual(["schema"]);
    expect(deriveExtensionCapabilities({ parsers: { "a b": () => ({}) } })).toEqual(["parser"]);
    expect(deriveExtensionCapabilities({ renderers: { toon: () => null } })).toEqual(["renderers"]);
    expect(deriveExtensionCapabilities({ services: { output_format: () => undefined } })).toEqual(["services"]);
    expect(deriveExtensionCapabilities({ preflights: [() => ({})] })).toEqual(["preflight"]);
    expect(deriveExtensionCapabilities({ searchProviders: [{ name: "s", query: async () => ({ hits: [] }) }] })).toEqual([
      "search",
    ]);
    expect(deriveExtensionCapabilities({ vectorStoreAdapters: [{ name: "v", query: async () => [] }] })).toEqual([
      "search",
    ]);
    expect(deriveExtensionCapabilities({ importers: [{ name: "i", importer: () => ({}) }] })).toEqual(["importers"]);
    expect(deriveExtensionCapabilities({ exporters: [{ name: "e", exporter: () => ({}) }] })).toEqual(["importers"]);
    expect(deriveExtensionCapabilities({ hooks: { afterCommand: [() => undefined] } })).toEqual(["hooks"]);
  });
});
