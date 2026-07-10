import { describe, expect, it } from "vitest";
import {
  checkExtensionManifestCompatibility,
  composeExtension,
  composeExtensionPackage,
  defineExtension,
  defineExtensionBlueprint,
  deriveExtensionCapabilities,
  describeExtensionBlueprint,
  lintExtensionBlueprint,
  mergeExtensionBlueprints,
  preflightExtension,
  synthesizeExtensionManifest,
  type ExtensionBlueprint,
} from "../../../src/sdk/compose.js";
import {
  checkExtensionManifestCompatibility as checkExtensionManifestCompatibilityFromBarrel,
  composeExtension as composeExtensionFromBarrel,
  composeExtensionPackage as composeExtensionPackageFromBarrel,
  defineExtension as defineExtensionFromBarrel,
  defineExtensionBlueprint as defineExtensionBlueprintFromBarrel,
  deriveExtensionCapabilities as deriveExtensionCapabilitiesFromBarrel,
  describeExtensionBlueprint as describeExtensionBlueprintFromBarrel,
  lintExtensionBlueprint as lintExtensionBlueprintFromBarrel,
  RESERVED_ITEM_FIELD_NAMES,
  mergeExtensionBlueprints as mergeExtensionBlueprintsFromBarrel,
  preflightExtension as preflightExtensionFromBarrel,
  synthesizeExtensionManifest as synthesizeExtensionManifestFromBarrel,
  type ExtensionApi,
} from "../../../src/sdk/index.js";
import { activateExtensionForTest, describeExtensionActivation } from "../../../src/sdk/testing.js";

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
    profiles: [
      {
        name: "compose-archetype",
        title: "Compose archetype",
        summary: "Profile wired through the blueprint.",
        types: [{ name: "ComposeIncident" }],
        statuses: [],
        fields: [],
        workflows: [],
        config: [],
        templates: [],
        packages: [],
      },
    ],
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
      profiles: 1,
      importers: 1,
      exporters: 1,
      search_providers: 1,
      vector_store_adapters: 1,
    });
    expect(activation.registrations.profiles[0]?.profile.name).toBe("compose-archetype");
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
    expect(
      deriveExtensionCapabilities({
        profiles: [
          {
            name: "p",
            title: "P",
            summary: "",
            types: [],
            statuses: [],
            fields: [],
            workflows: [],
            config: [],
            templates: [],
            packages: [],
          },
        ],
      }),
    ).toEqual(["schema"]);
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
    expect(deriveExtensionCapabilities({ importers: [{ name: "i", importer: () => ({}) }] })).toEqual([
      "commands",
      "importers",
    ]);
    expect(deriveExtensionCapabilities({ exporters: [{ name: "e", exporter: () => ({}) }] })).toEqual([
      "commands",
      "importers",
    ]);
    expect(deriveExtensionCapabilities({ hooks: { afterCommand: [() => undefined] } })).toEqual(["hooks"]);
  });

  it("adds schema for a command that declares inline flags, independent of a top-level flags record", () => {
    // A command-definition `flags` array registers through registerCommand, which
    // asserts the schema capability, so the derived set must include schema even
    // with no separate top-level `flags` field — otherwise composeExtension would
    // activate with a capability-missing failure.
    expect(
      deriveExtensionCapabilities({
        commands: [{ name: "a b", action: "a-b", run: () => ({}), flags: [{ long: "--inline" }] }],
      }),
    ).toEqual(["commands", "schema"]);
  });

  it("adds schema for an importer or exporter that declares options.flags", () => {
    // registerImporter/registerExporter with options.flags register flag metadata
    // through the schema surface (loader applyImportExportCommandMetadata), so a
    // flag-bearing importer/exporter derives `schema` on top of `importers` —
    // otherwise a synthesized least-privilege manifest would under-grant and fail
    // activation (pm-v3ty). Importers/exporters also synthesize command handlers,
    // so even flagless entries derive `commands` alongside `importers`.
    expect(
      deriveExtensionCapabilities({
        importers: [{ name: "tickets", importer: () => ({}), options: { flags: [{ long: "--source" }] } }],
      }),
    ).toEqual(["commands", "importers", "schema"]);
    expect(
      deriveExtensionCapabilities({
        exporters: [{ name: "tickets", exporter: () => ({}), options: { flags: [{ long: "--dest" }] } }],
      }),
    ).toEqual(["commands", "importers", "schema"]);
    // options present but without flags does not add schema.
    expect(
      deriveExtensionCapabilities({
        importers: [{ name: "tickets", importer: () => ({}), options: { description: "no flags" } }],
      }),
    ).toEqual(["commands", "importers"]);
    // A malformed null array entry (untyped .js/JSON boundary) does not crash
    // derivation, mirroring its null-field robustness — `entry?.options` guards it.
    // The non-empty arrays still derive `importers` from field presence; the null
    // entries carry no command handlers or flags, so no `commands` or `schema`
    // capability is added.
    expect(
      deriveExtensionCapabilities({ importers: [null], exporters: [null] } as unknown as ExtensionBlueprint),
    ).toEqual(["importers"]);
  });
});

/**
 * A blueprint exercising every surface declaratively (no imperative activate), so
 * the static describeExtensionBlueprint can be checked equal to the runtime
 * describeExtensionActivation of the same composed-and-activated module.
 */
function buildParityBlueprint(): ExtensionBlueprint {
  return {
    commands: [
      { name: "demo run", action: "demo-run", run: () => ({ ok: true }) },
      {
        name: "demo flagged",
        action: "demo-flagged",
        run: () => ({ ok: true }),
        flags: [{ long: "--inline-note", value_type: "string", value_name: "text" }],
      },
    ],
    commandOverrides: { list: () => undefined },
    flags: { "demo run": [{ long: "--top-note", value_type: "string", value_name: "text" }] },
    parsers: { "demo run": () => ({}) },
    renderers: { toon: () => null },
    services: { output_format: () => undefined },
    preflights: [() => ({})],
    itemTypes: [
      { name: "DemoIncident", folder: "demo-incidents", aliases: ["demo-incident"] },
      { name: "DemoTask", folder: "demo-tasks" },
    ],
    itemFields: [
      { name: "demo_severity", type: "string" },
      { name: "demo_score", type: "number" },
    ],
    migrations: [{ id: "demo-migration", description: "demo migration" }],
    profiles: [
      {
        name: "demo-archetype",
        title: "Demo archetype",
        summary: "Profile staged through the parity blueprint.",
        types: [{ name: "DemoTask" }],
        statuses: [],
        fields: [],
        workflows: [],
        config: [],
        templates: [],
        packages: [],
      },
    ],
    searchProviders: [{ name: "demo-search", query: async () => ({ hits: [] }) }],
    vectorStoreAdapters: [{ name: "demo-vector", query: async () => [] }],
    importers: [
      {
        name: "demo-import",
        importer: () => ({ imported: 0 }),
        options: {
          description: "Import demo items",
          flags: [{ long: "--import-source", value_type: "string", value_name: "path" }],
        },
      },
    ],
    exporters: [
      {
        name: "demo-export",
        exporter: () => ({ exported: true }),
        options: {
          description: "Export demo items",
          flags: [{ long: "--export-target", value_type: "string", value_name: "path" }],
        },
      },
    ],
    hooks: {
      beforeCommand: [() => undefined],
      afterCommand: [() => undefined],
      onWrite: [() => undefined],
      onRead: [() => undefined],
      onIndex: [() => undefined],
    },
  };
}

describe("sdk describeExtensionBlueprint", () => {
  it("is re-exported by identity from the barrel and /sdk/testing", () => {
    expect(describeExtensionBlueprintFromBarrel).toBe(describeExtensionBlueprint);
  });

  it("matches describeExtensionActivation of the composed-and-activated blueprint, surface for surface", async () => {
    const blueprint = buildParityBlueprint();
    const derived = deriveExtensionCapabilities(blueprint);

    const activation = await activateExtensionForTest(composeExtension(blueprint), {
      name: "parity-ext",
      capabilities: derived,
    });
    // Activation must succeed with exactly the derived capabilities, including the
    // schema grant for the inline-flags command.
    expect(activation.failed).toEqual([]);

    // The keystone: the static, no-activation summary equals the runtime one. This
    // pins the static reimplementation to the loader's behavior so any future drift
    // (command-path normalization, importer/exporter synthesis, hook ordering) fails CI.
    expect(describeExtensionBlueprint(blueprint)).toEqual(describeExtensionActivation(activation));

    // Spot-check a few surfaces so the test is self-documenting and a "both empty"
    // false pass is impossible.
    const summary = describeExtensionBlueprint(blueprint);
    expect(summary.capabilities).toEqual(ALL_CAPABILITIES);
    expect(summary.commands).toEqual(["demo flagged", "demo run", "demo-export export", "demo-import import"]);
    expect(summary.command_overrides).toEqual(["list"]);
    expect(summary.flag_commands).toEqual(["demo flagged", "demo run", "demo-export export", "demo-import import"]);
    expect(summary.item_types).toEqual(["DemoIncident", "DemoTask"]);
    expect(summary.migrations).toEqual(["demo-migration"]);
    expect(summary.profiles).toEqual(["demo-archetype"]);
    expect(summary.hooks).toEqual(["before_command", "after_command", "on_write", "on_read", "on_index"]);
    expect(summary.preflight_overrides).toBe(1);
  });

  it("returns a fully empty summary for an empty blueprint", () => {
    expect(describeExtensionBlueprint({})).toEqual({
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

  it("skips null entries from dynamic blueprint boundaries", () => {
    const blueprint = {
      commands: [
        null,
        {
          name: "null safe run",
          action: "null-safe-run",
          flags: [{ long: "--mode", value_type: "string", value_name: "mode" }],
          run: () => ({ ok: true }),
        },
      ],
      importers: [
        null,
        {
          name: "tickets",
          importer: () => ({ imported: 0 }),
          options: { flags: [{ long: "--source", value_type: "string", value_name: "path" }] },
        },
      ],
      exporters: [
        undefined,
        {
          name: "tickets",
          exporter: () => ({ exported: true }),
          options: { flags: [{ long: "--target", value_type: "string", value_name: "path" }] },
        },
      ],
    } as unknown as ExtensionBlueprint;

    const summary = describeExtensionBlueprint(blueprint);

    expect(summary.commands).toEqual(["null safe run", "tickets export", "tickets import"]);
    expect(summary.command_handlers).toEqual(["null safe run", "tickets export", "tickets import"]);
    expect(summary.flag_commands).toEqual(["null safe run", "tickets export", "tickets import"]);
    expect(summary.importers).toEqual(["tickets"]);
    expect(summary.exporters).toEqual(["tickets"]);
    expect(summary.capabilities).toEqual(expect.arrayContaining(["commands", "importers", "schema"]));
  });

  it("omits id-less migrations, which carry no identifier", () => {
    expect(
      describeExtensionBlueprint({ migrations: [{ id: "m1", description: "d" }, { description: "no id" }] }).migrations,
    ).toEqual(["m1"]);
  });

  it("cannot see surfaces registered through the imperative activate escape hatch", async () => {
    const blueprint: ExtensionBlueprint = {
      activate: (api: ExtensionApi) => {
        api.registerCommand({ name: "ghost cmd", action: "ghost", run: () => ({}) });
      },
    };
    // The static describer reads only the declarative data, so the imperatively
    // registered command is invisible to it.
    expect(describeExtensionBlueprint(blueprint).commands).toEqual([]);
    expect(describeExtensionBlueprint(blueprint).capabilities).toEqual([]);
    // But the runtime describe of the activated module does see it — the documented
    // boundary between the static and runtime verbs.
    const activation = await activateExtensionForTest(composeExtension(blueprint), { capabilities: ["commands"] });
    expect(describeExtensionActivation(activation).commands).toEqual(["ghost cmd"]);
  });
});

describe("sdk lintExtensionBlueprint", () => {
  it("is re-exported by identity from the barrel and /sdk/testing", () => {
    expect(lintExtensionBlueprintFromBarrel).toBe(lintExtensionBlueprint);
  });

  it("passes a blueprint whose declared capabilities exactly match the surfaces it exercises", () => {
    const result = lintExtensionBlueprint({
      commands: [{ name: "a b", action: "a-b", run: () => ({}) }],
      manifest: { name: "x", version: "1.0.0", entry: "./index.js", priority: 0, capabilities: ["commands"] },
    });
    expect(result).toEqual({ ok: true, findings: [], used: ["commands"], declared: ["commands"] });
  });

  it("flags a used-but-undeclared capability as an error (the loader would throw extension_capability_missing)", () => {
    const result = lintExtensionBlueprint(
      { commands: [{ name: "a b", action: "a-b", run: () => ({}) }], flags: { "a b": [{ long: "--x" }] } },
      { declaredCapabilities: ["commands"] },
    );
    expect(result.ok).toBe(false);
    const undeclared = result.findings.find((finding) => finding.code === "capability_undeclared");
    expect(undeclared?.severity).toBe("error");
    expect(undeclared?.capability).toBe("schema");
    expect(undeclared?.message).toContain("extension_capability_missing");
  });

  it("flags a declared-but-unused capability as a least-privilege warning", () => {
    const result = lintExtensionBlueprint(
      { commands: [{ name: "a b", action: "a-b", run: () => ({}) }] },
      { declaredCapabilities: ["commands", "search"] },
    );
    expect(result.ok).toBe(true);
    const unused = result.findings.find((finding) => finding.code === "capability_unused");
    expect(unused?.severity).toBe("warning");
    expect(unused?.capability).toBe("search");
  });

  it("reads declared capabilities from manifest.capabilities and ignores unknown names", () => {
    const result = lintExtensionBlueprint({
      commands: [{ name: "a b", action: "a-b", run: () => ({}) }],
      manifest: {
        name: "x",
        version: "1.0.0",
        entry: "./index.js",
        priority: 0,
        capabilities: ["commands", "totally-bogus"],
      },
    });
    // The unknown name is dropped (a separate unknown-capability diagnostic owns it),
    // leaving no drift to report.
    expect(result.declared).toEqual(["commands"]);
    expect(result.findings).toEqual([]);
  });

  it("normalizes legacy capability aliases when reconciling", () => {
    // "migration" is a legacy alias for "schema"; declaring it satisfies the schema
    // capability the itemTypes surface exercises.
    const result = lintExtensionBlueprint({ itemTypes: [{ name: "T", folder: "t" }] }, { declaredCapabilities: ["migration"] });
    expect(result.declared).toEqual(["schema"]);
    expect(result.findings).toEqual([]);
  });

  it("warns once when a single capability is exercised but none are declared", () => {
    const result = lintExtensionBlueprint({ commands: [{ name: "a b", action: "a-b", run: () => ({}) }] });
    expect(result.declared).toBeNull();
    const finding = result.findings.find((entry) => entry.code === "manifest_capabilities_absent");
    expect(finding?.severity).toBe("warning");
    expect(finding?.message).toContain("capability [commands]");
    expect(result.ok).toBe(true);
  });

  it("treats a non-array declared source as no declared set (untyped .js robustness) and pluralizes the message", () => {
    const result = lintExtensionBlueprint({
      commands: [{ name: "a b", action: "a-b", run: () => ({}) }],
      itemTypes: [{ name: "T", folder: "t" }],
      manifest: {
        name: "x",
        version: "1.0.0",
        entry: "./index.js",
        priority: 0,
        capabilities: "commands" as unknown as string[],
      },
    });
    expect(result.declared).toBeNull();
    const finding = result.findings.find((entry) => entry.code === "manifest_capabilities_absent");
    expect(finding?.message).toContain("capabilities [commands, schema]");
  });

  it("emits nothing for a fully empty blueprint", () => {
    expect(lintExtensionBlueprint({})).toEqual({ ok: true, findings: [], used: [], declared: null });
  });

  it("rejects reserved item-field collisions from the shared runtime list", () => {
    expect(RESERVED_ITEM_FIELD_NAMES.has("severity")).toBe(true);
    const result = lintExtensionBlueprint({ itemFields: [{ name: "severity", type: "string" }] });
    expect(result.ok).toBe(false);
    expect(result.findings).toContainEqual(expect.objectContaining({
      code: "reserved_item_field",
      severity: "error",
      field: "severity",
    }));
    expect(() => lintExtensionBlueprint({ itemFields: [{ name: null }] } as never)).not.toThrow();
  });

  it("flags a command path declared more than once", () => {
    const result = lintExtensionBlueprint(
      {
        commands: [
          { name: "dup cmd", action: "dup-1", run: () => ({}) },
          { name: "dup cmd", action: "dup-2", run: () => ({}) },
        ],
      },
      { declaredCapabilities: ["commands"] },
    );
    const dup = result.findings.find((finding) => finding.code === "duplicate_command");
    expect(dup?.severity).toBe("warning");
    expect(dup?.command).toBe("dup cmd");
    expect(dup?.message).toContain("2 times");
  });

  it("flags a command declared as both a definition and an override", () => {
    const result = lintExtensionBlueprint(
      {
        commands: [{ name: "both", action: "both", run: () => ({}) }],
        commandOverrides: { both: () => undefined },
      },
      { declaredCapabilities: ["commands"] },
    );
    const conflict = result.findings.find((finding) => finding.code === "command_override_conflict");
    expect(conflict?.severity).toBe("warning");
    expect(conflict?.command).toBe("both");
  });

  it("flags registration fields that are present but empty as dead surfaces", () => {
    const result = lintExtensionBlueprint({ commands: [], flags: {}, hooks: {} });
    const emptyFields = result.findings
      .filter((finding) => finding.code === "empty_surface")
      .map((finding) => finding.field)
      .sort();
    expect(emptyFields).toEqual(["commands", "flags", "hooks"]);
    expect(result.used).toEqual([]);
  });

  it("does not flag hooks as empty when at least one lifecycle hook is registered", () => {
    const result = lintExtensionBlueprint({ hooks: { afterCommand: [() => undefined] } });
    expect(result.findings.some((finding) => finding.code === "empty_surface")).toBe(false);
    expect(result.used).toEqual(["hooks"]);
  });

  it("treats a present-but-nullish hooks field as an empty surface (untyped .js robustness)", () => {
    // `"hooks" in blueprint` is true but the value is nullish, exercising the
    // `?? {}` guard that keeps an explicit null/undefined from throwing.
    const result = lintExtensionBlueprint({ hooks: undefined });
    expect(result.findings.filter((finding) => finding.code === "empty_surface").map((finding) => finding.field)).toEqual([
      "hooks",
    ]);
  });
});

describe("sdk synthesizeExtensionManifest", () => {
  const identity = { name: "synth", version: "1.2.3", entry: "./index.js", priority: 0 } as const;

  it("is re-exported by identity from the barrel", () => {
    expect(synthesizeExtensionManifestFromBarrel).toBe(synthesizeExtensionManifest);
  });

  it("fills capabilities from the blueprint and copies every identity field verbatim", () => {
    const manifest = synthesizeExtensionManifest(
      {
        commands: [{ name: "demo", action: "demo", run: () => ({}) }],
        itemFields: [{ name: "sev", type: "string" }],
        hooks: { afterCommand: [() => undefined] },
      },
      {
        ...identity,
        manifest_version: 1,
        pm_min_version: "2026.1.0",
        engines: { node: ">=20" },
        permissions: { fs_read: true },
      },
    );
    expect(manifest).toEqual({
      name: "synth",
      version: "1.2.3",
      entry: "./index.js",
      priority: 0,
      manifest_version: 1,
      pm_min_version: "2026.1.0",
      engines: { node: ">=20" },
      permissions: { fs_read: true },
      // Derived from the blueprint surfaces, sorted and de-duplicated.
      capabilities: ["commands", "hooks", "schema"],
    });
  });

  it("returns an empty capability set for a blueprint that registers nothing", () => {
    expect(synthesizeExtensionManifest({}, identity).capabilities).toEqual([]);
  });

  it("unions additionalCapabilities (escape-hatch surfaces) with the derived set, alias-resolved and de-duplicated", () => {
    const manifest = synthesizeExtensionManifest(
      { commands: [{ name: "demo", action: "demo", run: () => ({}) }] },
      // `renderers` is registered only in an imperative activate (invisible to
      // derivation); `validation` is a legacy alias of `schema`; `commands` is
      // already derived; `bogus` is unknown and dropped.
      { ...identity, additionalCapabilities: ["renderers", "validation", "commands", "bogus"] },
    );
    expect(manifest.capabilities).toEqual(["commands", "renderers", "schema"]);
  });

  it("ignores a non-array additionalCapabilities without leaking it into the manifest (untyped .js robustness)", () => {
    const manifest = synthesizeExtensionManifest(
      { commands: [{ name: "demo", action: "demo", run: () => ({}) }] },
      { ...identity, additionalCapabilities: null as unknown as string[] },
    );
    expect(manifest.capabilities).toEqual(["commands"]);
    expect("additionalCapabilities" in manifest).toBe(false);
  });
});

describe("sdk checkExtensionManifestCompatibility", () => {
  it("is re-exported by identity from the barrel", () => {
    expect(checkExtensionManifestCompatibilityFromBarrel).toBe(checkExtensionManifestCompatibility);
  });

  it("reports a manifest with no version bounds as compatible with no findings", () => {
    expect(checkExtensionManifestCompatibility({}, { pmVersion: "2026.6.23" })).toEqual({
      compatible: true,
      findings: [],
      pmVersion: "2026.6.23",
    });
  });

  it("reports satisfied bounds as compatible with no findings", () => {
    const result = checkExtensionManifestCompatibility(
      { pm_min_version: "2026.1.0", pm_max_version: "2026.9.0" },
      { pmVersion: "2026.6.23" },
    );
    expect(result).toEqual({ compatible: true, findings: [], pmVersion: "2026.6.23" });
  });

  it("flags an unmet pm_min_version as a blocking error", () => {
    const result = checkExtensionManifestCompatibility({ pm_min_version: "2026.9.0" }, { pmVersion: "2026.6.23" });
    expect(result.compatible).toBe(false);
    expect(result.findings).toEqual([
      {
        code: "pm_min_version_unmet",
        severity: "error",
        constraint: "pm_min_version",
        required: "2026.9.0",
        current: "2026.6.23",
        message: "Requires pm >= 2026.9.0 but the target is pm 2026.6.23; the loader skips the extension.",
      },
    ]);
  });

  it("flags a malformed pm_min_version as a blocking error", () => {
    const result = checkExtensionManifestCompatibility({ pm_min_version: "nightly" }, { pmVersion: "2026.6.23" });
    expect(result.compatible).toBe(false);
    expect(result.findings[0]).toMatchObject({ code: "pm_min_version_invalid", severity: "error" });
  });

  it("flags blank or non-string manifest bounds as blocking malformed values", () => {
    const result = checkExtensionManifestCompatibility(
      { pm_min_version: "", pm_max_version: 20260623 },
      { pmVersion: "2026.6.23" },
    );
    expect(result.compatible).toBe(false);
    expect(result.findings).toEqual([
      expect.objectContaining({ code: "pm_min_version_invalid", required: "" }),
      expect.objectContaining({ code: "pm_max_version_invalid", required: "20260623" }),
    ]);
  });

  it("reports an uninterpretable target as an advisory unchecked warning that still loads", () => {
    const result = checkExtensionManifestCompatibility({ pm_min_version: "2026.1.0" }, { pmVersion: "nightly" });
    expect(result.compatible).toBe(true);
    expect(result.findings[0]).toMatchObject({ code: "pm_min_version_unchecked", severity: "warning" });
  });

  it("blocks an exceeded pm_max_version in the default (block) mode", () => {
    const result = checkExtensionManifestCompatibility({ pm_max_version: "2026.1.0" }, { pmVersion: "2026.6.23" });
    expect(result.compatible).toBe(false);
    expect(result.findings[0]).toMatchObject({ code: "pm_max_version_exceeded", severity: "error" });
  });

  it("downgrades an exceeded pm_max_version to an advisory warning in warn mode", () => {
    const result = checkExtensionManifestCompatibility(
      { pm_max_version: "2026.1.0" },
      { pmVersion: "2026.6.23", pmMaxVersionExceededMode: "warn" },
    );
    expect(result.compatible).toBe(true);
    expect(result.findings[0]).toMatchObject({ code: "pm_max_version_exceeded_warn", severity: "warning" });
  });

  it("flags a range-prefixed pm_max_version as a blocking invalid bound", () => {
    const result = checkExtensionManifestCompatibility({ pm_max_version: ">=2026.6.1" }, { pmVersion: "2026.6.23" });
    expect(result.compatible).toBe(false);
    expect(result.findings[0]).toMatchObject({ code: "pm_max_version_invalid", severity: "error" });
  });

  it("reports an uninterpretable target against a pm_max_version as an unchecked warning", () => {
    const result = checkExtensionManifestCompatibility({ pm_max_version: "2026.9.0" }, { pmVersion: "nightly" });
    expect(result.compatible).toBe(true);
    expect(result.findings[0]).toMatchObject({ code: "pm_max_version_unchecked", severity: "warning" });
  });

  it("orders the lower-bound finding before the upper-bound finding", () => {
    const result = checkExtensionManifestCompatibility(
      { pm_min_version: "2026.9.0", pm_max_version: ">=bad" },
      { pmVersion: "2026.6.23" },
    );
    expect(result.findings.map((finding) => finding.constraint)).toEqual(["pm_min_version", "pm_max_version"]);
    expect(result.compatible).toBe(false);
  });
});

describe("sdk preflightExtension", () => {
  const identity = { name: "preflight", version: "1.0.0", entry: "./index.js", priority: 0 } as const;
  const commandBlueprint: ExtensionBlueprint = {
    commands: [{ name: "demo", action: "demo", run: () => ({ ok: true }) }],
  };

  it("is re-exported by identity from the barrel", () => {
    expect(preflightExtensionFromBarrel).toBe(preflightExtension);
  });

  it("lints the blueprint and leaves manifest and compatibility null when neither identity nor target is given", () => {
    const report = preflightExtension(commandBlueprint);
    expect(report.manifest).toBeNull();
    expect(report.compatibility).toBeNull();
    expect(report.ok).toBe(true);
    expect(report.capabilities).toEqual(["commands"]);
    // The blueprint exercises a capability but declares none, so the lone finding
    // is the advisory manifest_capabilities_absent warning, tagged to the blueprint.
    expect(report.findings).toEqual([
      { source: "blueprint", severity: "warning", code: "manifest_capabilities_absent", message: expect.any(String) },
    ]);
    expect(report.blueprint.used).toEqual(["commands"]);
  });

  it("synthesizes the manifest from identity and exposes it on the report", () => {
    const report = preflightExtension(commandBlueprint, { identity });
    expect(report.manifest).toEqual({ ...identity, capabilities: ["commands"] });
    expect(report.compatibility).toBeNull();
    expect(report.ok).toBe(true);
  });

  it("omits the now-moot manifest_capabilities_absent advisory from the consolidated view once the manifest is synthesized", () => {
    const report = preflightExtension(commandBlueprint, { identity });
    // Synthesis authored the capability grant, so the lint's "declares none" advisory
    // is contradictory noise in the consolidated findings…
    expect(report.findings).toEqual([]);
    // …but the raw lint result on report.blueprint still reports it faithfully.
    expect(report.blueprint.findings).toContainEqual(
      expect.objectContaining({ code: "manifest_capabilities_absent" }),
    );
  });

  it("suppresses capability drift against a stale in-module manifest mirror once the manifest is synthesized", () => {
    const report = preflightExtension(
      {
        commands: [{ name: "demo", action: "demo", run: () => ({}) }],
        itemFields: [{ name: "sev", type: "string" }],
        // Stale mirror: it omits the `schema` capability the itemFields surface exercises.
        manifest: { ...identity, capabilities: ["commands"] },
      },
      { identity },
    );
    // The synthesized manifest — not the stale mirror — is what ships, so the blocking
    // capability_undeclared drift must not flip the consolidated verdict to false.
    expect(report.ok).toBe(true);
    expect(report.findings).toEqual([]);
    expect(report.manifest?.capabilities).toEqual(["commands", "schema"]);
    // The raw lint still reports the drift against the mirror it was given.
    expect(report.blueprint.findings).toContainEqual(
      expect.objectContaining({ code: "capability_undeclared", capability: "schema" }),
    );
  });

  it("keeps capability drift findings when the caller pins an explicit declaredCapabilities set, even while synthesizing", () => {
    const report = preflightExtension(
      {
        commands: [{ name: "demo", action: "demo", run: () => ({}) }],
        itemFields: [{ name: "sev", type: "string" }],
      },
      // An explicit declared set is a deliberate "check exactly this" request that
      // omits `schema`, so the drift is honored rather than curated away.
      { identity, declaredCapabilities: ["commands"] },
    );
    expect(report.ok).toBe(false);
    expect(report.findings).toContainEqual(
      expect.objectContaining({ source: "blueprint", code: "capability_undeclared" }),
    );
    // The synthesized manifest itself is still least-privilege-correct.
    expect(report.manifest?.capabilities).toEqual(["commands", "schema"]);
  });

  it("checks the synthesized manifest version bounds against the target and blocks an unmet floor", () => {
    const report = preflightExtension(commandBlueprint, {
      identity: { ...identity, pm_min_version: "2026.9.0" },
      target: { pmVersion: "2026.6.23" },
    });
    expect(report.manifest?.pm_min_version).toBe("2026.9.0");
    expect(report.compatibility?.compatible).toBe(false);
    expect(report.ok).toBe(false);
    expect(report.findings).toContainEqual({
      source: "compatibility",
      severity: "error",
      code: "pm_min_version_unmet",
      message: expect.stringContaining("Requires pm >= 2026.9.0"),
    });
  });

  it("falls back to the blueprint manifest mirror for the version check when no identity is given", () => {
    const report = preflightExtension(
      {
        ...commandBlueprint,
        manifest: { ...identity, capabilities: ["commands"], pm_max_version: "2026.1.0" },
      },
      { target: { pmVersion: "2026.6.23" } },
    );
    expect(report.manifest).toBeNull();
    expect(report.compatibility?.compatible).toBe(false);
    expect(report.findings.map((finding) => finding.code)).toContain("pm_max_version_exceeded");
    expect(report.ok).toBe(false);
  });

  it("treats a target with no manifest bounds anywhere as compatible", () => {
    const report = preflightExtension(commandBlueprint, { target: { pmVersion: "2026.6.23" } });
    expect(report.manifest).toBeNull();
    expect(report.compatibility).toEqual({ compatible: true, findings: [], pmVersion: "2026.6.23" });
    expect(report.ok).toBe(true);
  });

  it("flags a capability the blueprint exercises but the declared set omits as a blocking error", () => {
    const report = preflightExtension(commandBlueprint, { declaredCapabilities: [] });
    expect(report.ok).toBe(false);
    expect(report.findings).toEqual([
      { source: "blueprint", severity: "error", code: "capability_undeclared", message: expect.any(String) },
    ]);
  });

  it("tags every finding by source, ordering blueprint findings before compatibility findings", () => {
    const report = preflightExtension(
      { ...commandBlueprint, flags: {} },
      { identity: { ...identity, pm_min_version: "2026.9.0" }, target: { pmVersion: "2026.6.23" } },
    );
    const sources = report.findings.map((finding) => finding.source);
    expect(sources[sources.length - 1]).toBe("compatibility");
    expect(sources.slice(0, -1).every((source) => source === "blueprint")).toBe(true);
    // The empty `flags` surface is an advisory blueprint warning; the unmet floor is
    // the blocking compatibility error — both flow through one consolidated report.
    // Unified findings carry only source/severity/code/message; per-stage detail
    // (the lint `field`, the compat `constraint`) stays on report.blueprint/compatibility.
    expect(report.findings).toContainEqual({
      source: "blueprint",
      severity: "warning",
      code: "empty_surface",
      message: expect.any(String),
    });
    expect(report.blueprint.findings).toContainEqual(expect.objectContaining({ code: "empty_surface", field: "flags" }));
    expect(report.ok).toBe(false);
  });
});

describe("sdk defineExtensionBlueprint", () => {
  it("re-exports the same function reference from the barrel", () => {
    expect(defineExtensionBlueprintFromBarrel).toBe(defineExtensionBlueprint);
  });

  it("returns the blueprint fragment unchanged so it composes through the modular loop", async () => {
    const commandsModule = defineExtensionBlueprint({
      commands: [{ name: "kit run", action: "kit-run", run: () => ({ ok: true }) }],
    });
    const searchModule = defineExtensionBlueprint({
      searchProviders: [{ name: "kit-search", query: async () => ({ hits: [] }) }],
    });
    // Zero-cost identity helper: the same object reference is returned untouched.
    expect(defineExtensionBlueprint(commandsModule)).toBe(commandsModule);

    // The typed fragments feed the modular loop with no loss of fidelity: merge,
    // compose, and activate exactly as hand-written blueprint literals would.
    const merged = mergeExtensionBlueprints(commandsModule, searchModule);
    expect(deriveExtensionCapabilities(merged)).toEqual(["commands", "search"]);
    const activation = await activateExtensionForTest(composeExtension(merged), {
      capabilities: ["commands", "search"],
    });
    expect(activation.failed).toEqual([]);
    expect(activation.registrations.commands.map((command) => command.command)).toEqual(["kit run"]);
  });
});

describe("sdk mergeExtensionBlueprints", () => {
  it("re-exports the same function reference from the barrel", () => {
    expect(mergeExtensionBlueprintsFromBarrel).toBe(mergeExtensionBlueprints);
  });

  it("concatenates arrays, last-wins handlers, per-command flags, hooks per kind, and chains lifecycle LIFO", async () => {
    const order: string[] = [];
    const overrideA = (): undefined => undefined;
    const overrideB = (): undefined => undefined;
    const parserA = (): Record<string, never> => ({});
    const moduleA: ExtensionBlueprint = {
      manifest: { name: "mod-a", version: "1.0.0", entry: "./a.js", priority: 0, capabilities: ["commands", "schema", "parser"] },
      commands: [{ name: "kit alpha", action: "kit-alpha", run: () => ({ a: 1 }) }],
      flags: { "kit alpha": [{ long: "--alpha", value_type: "string", value_name: "text" }] },
      commandOverrides: { list: overrideA },
      parsers: { "kit alpha": parserA },
      profiles: [
        {
          name: "kit-archetype",
          title: "Kit archetype",
          summary: "",
          types: [],
          statuses: [],
          fields: [],
          workflows: [],
          config: [],
          templates: [],
          packages: [],
        },
      ],
      hooks: { beforeCommand: [() => undefined] },
      activate: () => {
        order.push("activate-a");
      },
      deactivate: () => {
        order.push("deactivate-a");
      },
    };
    const moduleB: ExtensionBlueprint = {
      manifest: { name: "mod-b", version: "2.0.0", entry: "./b.js", priority: 0, capabilities: ["commands", "search"] },
      commands: [{ name: "kit beta", action: "kit-beta", run: () => ({ b: 2 }) }],
      flags: { "kit alpha": [{ long: "--alpha-extra", value_type: "string", value_name: "text" }] },
      commandOverrides: { list: overrideB },
      searchProviders: [{ name: "kit-search", query: async () => ({ hits: [] }) }],
      hooks: {
        beforeCommand: [() => undefined],
        afterCommand: [() => undefined],
        onWrite: [() => undefined],
        onRead: [() => undefined],
        onIndex: [() => undefined],
      },
      activate: () => {
        order.push("activate-b");
      },
      deactivate: () => {
        order.push("deactivate-b");
      },
    };

    const merged = mergeExtensionBlueprints(moduleA, moduleB);

    // Array surfaces concatenate in argument order.
    expect(merged.commands?.map((command) => command.name)).toEqual(["kit alpha", "kit beta"]);
    expect(merged.searchProviders?.map((provider) => provider.name)).toEqual(["kit-search"]);
    expect(merged.profiles?.map((profile) => profile.name)).toEqual(["kit-archetype"]);
    // A shared flag target command concatenates both modules' flag arrays.
    expect(merged.flags?.["kit alpha"].map((flag) => flag.long)).toEqual(["--alpha", "--alpha-extra"]);
    // Single-handler record collision: the later module wins the key.
    expect(merged.commandOverrides?.list).toBe(overrideB);
    // A key only one module declares survives untouched.
    expect(merged.parsers?.["kit alpha"]).toBe(parserA);
    // Hooks concatenate per lifecycle kind.
    expect(merged.hooks?.beforeCommand).toHaveLength(2);
    expect(merged.hooks?.afterCommand).toHaveLength(1);
    expect(merged.hooks?.onWrite).toHaveLength(1);
    expect(merged.hooks?.onRead).toHaveLength(1);
    expect(merged.hooks?.onIndex).toHaveLength(1);
    // The manifest mirror is last-defined-wins.
    expect(merged.manifest?.name).toBe("mod-b");
    // The merged blueprint derives the union of both modules' capabilities.
    expect(deriveExtensionCapabilities(merged)).toEqual(["commands", "hooks", "parser", "schema", "search"]);

    // Imperative activate hatches chain forward; deactivate chains in reverse (LIFO).
    await merged.activate?.({} as ExtensionApi);
    expect(order).toEqual(["activate-a", "activate-b"]);
    await merged.deactivate?.();
    expect(order).toEqual(["activate-a", "activate-b", "deactivate-b", "deactivate-a"]);

    // Inputs are never mutated.
    expect(moduleA.commands).toHaveLength(1);
    expect(moduleB.flags?.["kit alpha"]).toHaveLength(1);
  });

  it("composes and activates a merged blueprint exactly like a hand-written one", async () => {
    const merged = mergeExtensionBlueprints(
      { commands: [{ name: "kit alpha", action: "kit-alpha", run: () => ({}) }] },
      { searchProviders: [{ name: "kit-search", query: async () => ({ hits: [] }) }] },
    );
    const activation = await activateExtensionForTest(composeExtension(merged), {
      capabilities: ["commands", "search"],
    });
    expect(activation.failed).toEqual([]);
    expect(activation.registrations.commands.map((command) => command.command)).toEqual(["kit alpha"]);
    expect(activation.registration_counts.search_providers).toBe(1);
    // describeExtensionBlueprint reads the merged data as the runtime would see it.
    expect(describeExtensionBlueprint(merged).search_providers).toEqual(["kit-search"]);
  });

  it("preserves cross-module duplicates so lintExtensionBlueprint still flags them", () => {
    const merged = mergeExtensionBlueprints(
      {
        manifest: { name: "dup", version: "1.0.0", entry: "./index.js", priority: 0, capabilities: ["commands"] },
        commands: [{ name: "dup cmd", action: "dup-a", run: () => ({}) }],
      },
      { commands: [{ name: "dup cmd", action: "dup-b", run: () => ({}) }] },
    );
    expect(merged.commands).toHaveLength(2);
    const report = lintExtensionBlueprint(merged, { declaredCapabilities: ["commands"] });
    expect(report.findings.some((finding) => finding.code === "duplicate_command")).toBe(true);
  });

  it("returns an empty blueprint when merging nothing", () => {
    expect(mergeExtensionBlueprints()).toEqual({});
  });

  it("runs every deactivate when one throws, then re-throws that failure", async () => {
    const order: string[] = [];
    const boom = new Error("teardown boom");
    const merged = mergeExtensionBlueprints(
      {
        deactivate: () => {
          order.push("deactivate-a");
        },
      },
      {
        deactivate: () => {
          order.push("deactivate-b");
          throw boom;
        },
      },
    );
    // Teardown is LIFO (B before A); B throws but A must still run, and the
    // collected failure is surfaced rather than swallowed.
    await expect(merged.deactivate?.()).rejects.toBe(boom);
    expect(order).toEqual(["deactivate-b", "deactivate-a"]);
  });

  it("runs every deactivate when several throw, then reports the collected failures", async () => {
    const order: string[] = [];
    const boomA = new Error("teardown boom a");
    const boomB = new Error("teardown boom b");
    const merged = mergeExtensionBlueprints(
      {
        deactivate: () => {
          order.push("deactivate-a");
          throw boomA;
        },
      },
      {
        deactivate: () => {
          order.push("deactivate-b");
          throw boomB;
        },
      },
    );

    await expect(merged.deactivate?.()).rejects.toMatchObject({
      errors: [boomB, boomA],
      message: "Multiple extension blueprint deactivate hooks failed.",
    });
    expect(order).toEqual(["deactivate-b", "deactivate-a"]);
  });

  it("preserves blueprint this context while chaining lifecycle methods", async () => {
    const order: string[] = [];
    const moduleA = {
      label: "module-a",
      activate(this: { label: string }): void {
        order.push(`activate:${this.label}`);
      },
      deactivate(this: { label: string }): void {
        order.push(`deactivate:${this.label}`);
      },
    } satisfies ExtensionBlueprint & { label: string };
    const moduleB = {
      label: "module-b",
      activate(this: { label: string }): void {
        order.push(`activate:${this.label}`);
      },
      deactivate(this: { label: string }): void {
        order.push(`deactivate:${this.label}`);
      },
    } satisfies ExtensionBlueprint & { label: string };

    const merged = mergeExtensionBlueprints(moduleA, moduleB);

    await merged.activate?.({} as ExtensionApi);
    await merged.deactivate?.();
    expect(order).toEqual(["activate:module-a", "activate:module-b", "deactivate:module-b", "deactivate:module-a"]);
  });

  it("returns a fresh blueprint object and array containers without mutating the input", () => {
    const source: ExtensionBlueprint = {
      commands: [{ name: "solo cmd", action: "solo", run: () => ({}) }],
      hooks: { beforeCommand: [() => undefined] },
    };
    const merged = mergeExtensionBlueprints(source);
    expect(merged).not.toBe(source);
    expect(merged.commands).not.toBe(source.commands);
    expect(merged.commands?.map((command) => command.name)).toEqual(["solo cmd"]);
    expect(merged.hooks?.beforeCommand).toHaveLength(1);
    expect(source.commands).toHaveLength(1);
  });

  it("omits empty surfaces and tolerates absent and explicit-null fields (untyped .js authors)", async () => {
    const order: string[] = [];
    const rich: ExtensionBlueprint = {
      manifest: { name: "rich", version: "1.0.0", entry: "./r.js", priority: 0, capabilities: ["commands", "schema"] },
      commands: [{ name: "rich cmd", action: "rich", run: () => ({}) }],
      commandOverrides: { list: () => undefined },
      flags: { "rich cmd": [{ long: "--rich", value_type: "string", value_name: "x" }] },
      hooks: { beforeCommand: [() => undefined] },
      activate: () => {
        order.push("a");
      },
      deactivate: () => {
        order.push("d");
      },
    };
    // A plain-JavaScript author can pass explicit null where the type expects an
    // optional field; the merge must treat null like undefined, never throw.
    const nullish = {
      commands: null,
      flags: null,
      hooks: null,
      manifest: null,
      activate: null,
      deactivate: null,
    } as unknown as ExtensionBlueprint;
    const merged = mergeExtensionBlueprints(rich, {}, nullish);

    expect(merged.commands?.map((command) => command.name)).toEqual(["rich cmd"]);
    // The last-defined non-null mirror is the rich module's.
    expect(merged.manifest).toBe(rich.manifest);
    // Surfaces no module contributes are omitted, not emitted empty.
    expect(merged.searchProviders).toBeUndefined();
    expect("services" in merged).toBe(false);
    expect("parsers" in merged).toBe(false);
    // The single contributing module's lifecycle still fires.
    await merged.activate?.({} as ExtensionApi);
    await merged.deactivate?.();
    expect(order).toEqual(["a", "d"]);
  });
});

describe("sdk composeExtensionPackage", () => {
  const identity = { name: "kit", version: "3.1.0", entry: "./index.js", priority: 0 } as const;

  it("re-exports the same function reference from the barrel", () => {
    expect(composeExtensionPackageFromBarrel).toBe(composeExtensionPackage);
  });

  it("returns both halves with the synthesized manifest as the module's authoritative mirror", async () => {
    const blueprint: ExtensionBlueprint = {
      // A stale in-blueprint mirror that must be superseded by the synthesized one.
      manifest: { name: "stale", version: "0.0.0", entry: "./stale.js", priority: 9, capabilities: ["renderers"] },
      commands: [{ name: "kit run", action: "kit-run", run: () => ({ ok: true }) }],
      searchProviders: [{ name: "kit-search", query: async () => ({ hits: [] }) }],
      deactivate: () => undefined,
    };
    const pkg = composeExtensionPackage(blueprint, identity);

    // The manifest is synthesized from identity + derived least-privilege capabilities.
    expect(pkg.manifest).toEqual({ ...identity, capabilities: ["commands", "search"] });
    // The module's mirror IS the returned manifest object — one source, drift-proof.
    expect(pkg.module.manifest).toBe(pkg.manifest);
    // The stale in-blueprint mirror is superseded, not copied onto the module.
    expect(pkg.module.manifest?.name).toBe("kit");
    expect(pkg.module.deactivate).toBe(blueprint.deactivate);

    const activation = await activateExtensionForTest(pkg.module, { capabilities: pkg.manifest.capabilities });
    expect(activation.failed).toEqual([]);
    expect(activation.registrations.commands.map((command) => command.command)).toEqual(["kit run"]);
    expect(activation.registration_counts.search_providers).toBe(1);
  });

  it("unions additionalCapabilities for surfaces wired through the imperative escape hatch", () => {
    const pkg = composeExtensionPackage(
      {
        commands: [{ name: "kit run", action: "kit-run", run: () => ({}) }],
        activate: (api: ExtensionApi) => {
          api.registerRenderer("toon", () => null);
        },
      },
      { ...identity, additionalCapabilities: ["renderers"] },
    );
    expect(pkg.manifest.capabilities).toEqual(["commands", "renderers"]);
  });

  it("ships a blueprint assembled modularly by mergeExtensionBlueprints", async () => {
    const merged = mergeExtensionBlueprints(
      { commands: [{ name: "kit a", action: "kit-a", run: () => ({}) }] },
      { searchProviders: [{ name: "kit-s", query: async () => ({ hits: [] }) }] },
    );
    const pkg = composeExtensionPackage(merged, identity);
    expect(pkg.manifest.capabilities).toEqual(["commands", "search"]);
    const activation = await activateExtensionForTest(pkg.module, { capabilities: pkg.manifest.capabilities });
    expect(activation.failed).toEqual([]);
  });
});
