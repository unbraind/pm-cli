import { describe, expect, it } from "vitest";
import {
  checkExtensionManifestCompatibility,
  composeExtension,
  defineExtension,
  deriveExtensionCapabilities,
  describeExtensionBlueprint,
  lintExtensionBlueprint,
  synthesizeExtensionManifest,
  type ExtensionBlueprint,
} from "../../../src/sdk/compose.js";
import {
  checkExtensionManifestCompatibility as checkExtensionManifestCompatibilityFromBarrel,
  composeExtension as composeExtensionFromBarrel,
  defineExtension as defineExtensionFromBarrel,
  deriveExtensionCapabilities as deriveExtensionCapabilitiesFromBarrel,
  describeExtensionBlueprint as describeExtensionBlueprintFromBarrel,
  lintExtensionBlueprint as lintExtensionBlueprintFromBarrel,
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
    searchProviders: [{ name: "demo-search", query: async () => ({ hits: [] }) }],
    vectorStoreAdapters: [{ name: "demo-vector", query: async () => [] }],
    importers: [{ name: "demo-import", importer: () => ({ imported: 0 }) }],
    exporters: [{ name: "demo-export", exporter: () => ({ exported: true }) }],
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
    expect(summary.commands).toEqual(["demo flagged", "demo run"]);
    expect(summary.command_overrides).toEqual(["list"]);
    expect(summary.flag_commands).toEqual(["demo flagged", "demo run"]);
    expect(summary.item_types).toEqual(["DemoIncident", "DemoTask"]);
    expect(summary.migrations).toEqual(["demo-migration"]);
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
