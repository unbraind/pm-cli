import { describe, expect, it } from "vitest";
import {
  defineAfterCommandHook,
  defineBeforeCommandHook,
  defineCommand,
  defineCommandOverride,
  defineExporter,
  defineExtensionManifest,
  defineFlag,
  defineImporter,
  defineItemField,
  defineItemType,
  defineMigration,
  defineOnIndexHook,
  defineOnReadHook,
  defineOnWriteHook,
  defineParserOverride,
  definePreflightOverride,
  defineProjectProfile,
  defineRendererOverride,
  defineSearchProvider,
  defineServiceOverride,
  defineVectorStoreAdapter,
} from "../../../src/sdk/define.js";
import {
  defineAfterCommandHook as defineAfterCommandHookFromBarrel,
  defineBeforeCommandHook as defineBeforeCommandHookFromBarrel,
  defineCommand as defineCommandFromBarrel,
  defineCommandOverride as defineCommandOverrideFromBarrel,
  defineExporter as defineExporterFromBarrel,
  defineExtensionManifest as defineExtensionManifestFromBarrel,
  defineFlag as defineFlagFromBarrel,
  defineImporter as defineImporterFromBarrel,
  defineItemField as defineItemFieldFromBarrel,
  defineItemType as defineItemTypeFromBarrel,
  defineMigration as defineMigrationFromBarrel,
  defineOnIndexHook as defineOnIndexHookFromBarrel,
  defineOnReadHook as defineOnReadHookFromBarrel,
  defineOnWriteHook as defineOnWriteHookFromBarrel,
  defineParserOverride as defineParserOverrideFromBarrel,
  definePreflightOverride as definePreflightOverrideFromBarrel,
  defineProjectProfile as defineProjectProfileFromBarrel,
  defineRendererOverride as defineRendererOverrideFromBarrel,
  defineSearchProvider as defineSearchProviderFromBarrel,
  defineServiceOverride as defineServiceOverrideFromBarrel,
  defineVectorStoreAdapter as defineVectorStoreAdapterFromBarrel,
  type ExtensionApi,
} from "../../../src/sdk/index.js";
import {
  activateExtensionForTest,
  runRegisteredCommandForTest,
  runRegisteredHookForTest,
} from "../../../src/sdk/testing.js";

describe("sdk define builders", () => {
  it("rejects misspelled authoring keys at the definition boundary", () => {
    // @ts-expect-error value_typo is not part of the exact flag contract.
    expect(defineFlag({ long: "--strict", value_typo: "boolean" })).toEqual({
      long: "--strict",
      value_typo: "boolean",
    });
    // @ts-expect-error foldre is not part of the exact item-type contract.
    expect(defineItemType({ name: "Incident", foldre: "incidents" })).toEqual({
      name: "Incident",
      foldre: "incidents",
    });
  });

  it("returns every registration definition unchanged (zero-cost identity)", () => {
    // Object-definition builders preserve the exact reference they are handed.
    const command = { name: "demo run", action: "demo-run", run: () => ({ ok: true }) };
    expect(defineCommand(command)).toBe(command);
    const flag = { long: "--loud", value_type: "boolean" as const };
    expect(defineFlag(flag)).toBe(flag);
    const manifest = {
      name: "manifest-ext",
      version: "1.0.0",
      entry: "./index.js",
      priority: 0,
      capabilities: ["commands"] as const,
    };
    expect(defineExtensionManifest(manifest)).toBe(manifest);
    const itemType = { name: "Incident", folder: "incidents", aliases: ["incident"] };
    expect(defineItemType(itemType)).toBe(itemType);
    const projectProfile = {
      name: "demo",
      title: "Demo",
      summary: "Demo archetype",
      types: [{ name: "Widget", folder: "widgets", aliases: [] }],
      statuses: [{ id: "verifying", roles: ["active"] as const }],
      fields: [{ key: "widget_size", type: "number" as const }],
      workflows: [{ type: "Widget", allowed_transitions: [["open", "in_progress"]] as [string, string][] }],
      config: [{ key: "search_max_results", value: "30", summary: "cap" }],
      templates: [{ name: "widget", options: { type: "Widget" } }],
      packages: [{ spec: "templates", reason: "reuse" }],
    };
    expect(defineProjectProfile(projectProfile)).toBe(projectProfile);
    const itemField = { name: "severity", type: "string" };
    expect(defineItemField(itemField)).toBe(itemField);
    const migration = { id: "demo-migration", description: "demo" };
    expect(defineMigration(migration)).toBe(migration);
    const searchProvider = { name: "demo-search", query: async () => ({ hits: [] }) };
    expect(defineSearchProvider(searchProvider)).toBe(searchProvider);
    const vectorAdapter = { name: "demo-vector", query: async () => [] };
    expect(defineVectorStoreAdapter(vectorAdapter)).toBe(vectorAdapter);

    // Function-definition builders preserve the exact handler reference.
    const commandOverride = () => undefined;
    expect(defineCommandOverride(commandOverride)).toBe(commandOverride);
    const parserOverride = () => ({});
    expect(defineParserOverride(parserOverride)).toBe(parserOverride);
    const preflightOverride = () => ({});
    expect(definePreflightOverride(preflightOverride)).toBe(preflightOverride);
    const serviceOverride = () => undefined;
    expect(defineServiceOverride(serviceOverride)).toBe(serviceOverride);
    const rendererOverride = () => null;
    expect(defineRendererOverride(rendererOverride)).toBe(rendererOverride);
    const importer = () => ({ imported: 0 });
    expect(defineImporter(importer)).toBe(importer);
    const exporter = () => ({ exported: true });
    expect(defineExporter(exporter)).toBe(exporter);
    const beforeHook = () => undefined;
    expect(defineBeforeCommandHook(beforeHook)).toBe(beforeHook);
    const afterHook = () => undefined;
    expect(defineAfterCommandHook(afterHook)).toBe(afterHook);
    const writeHook = () => undefined;
    expect(defineOnWriteHook(writeHook)).toBe(writeHook);
    const readHook = () => undefined;
    expect(defineOnReadHook(readHook)).toBe(readHook);
    const indexHook = () => undefined;
    expect(defineOnIndexHook(indexHook)).toBe(indexHook);
  });

  it("re-exports every define builder through the sdk barrel", () => {
    // Lock the authoring builders to the same implementation the dedicated
    // entrypoint exports, mirroring the assert*/run* barrel contract.
    expect(defineCommandFromBarrel).toBe(defineCommand);
    expect(defineExtensionManifestFromBarrel).toBe(defineExtensionManifest);
    expect(defineFlagFromBarrel).toBe(defineFlag);
    expect(defineItemTypeFromBarrel).toBe(defineItemType);
    expect(defineItemFieldFromBarrel).toBe(defineItemField);
    expect(defineProjectProfileFromBarrel).toBe(defineProjectProfile);
    expect(defineMigrationFromBarrel).toBe(defineMigration);
    expect(defineSearchProviderFromBarrel).toBe(defineSearchProvider);
    expect(defineVectorStoreAdapterFromBarrel).toBe(defineVectorStoreAdapter);
    expect(defineCommandOverrideFromBarrel).toBe(defineCommandOverride);
    expect(defineParserOverrideFromBarrel).toBe(defineParserOverride);
    expect(definePreflightOverrideFromBarrel).toBe(definePreflightOverride);
    expect(defineServiceOverrideFromBarrel).toBe(defineServiceOverride);
    expect(defineRendererOverrideFromBarrel).toBe(defineRendererOverride);
    expect(defineImporterFromBarrel).toBe(defineImporter);
    expect(defineExporterFromBarrel).toBe(defineExporter);
    expect(defineBeforeCommandHookFromBarrel).toBe(defineBeforeCommandHook);
    expect(defineAfterCommandHookFromBarrel).toBe(defineAfterCommandHook);
    expect(defineOnWriteHookFromBarrel).toBe(defineOnWriteHook);
    expect(defineOnReadHookFromBarrel).toBe(defineOnReadHook);
    expect(defineOnIndexHookFromBarrel).toBe(defineOnIndexHook);
  });

  it("authors definitions that register and run through the activation harness", async () => {
    const observed: string[] = [];
    const activation = await activateExtensionForTest(
      {
        activate(api: ExtensionApi) {
          // Definitions authored via define* flow straight into api.register*
          // with the handler's context parameter fully inferred.
          api.registerCommand(
            defineCommand({
              name: "demo run",
              action: "demo-run",
              description: "Authored with defineCommand.",
              run: (context) => ({ ok: true, command: context.command }),
            }),
          );
          api.registerSearchProvider(
            defineSearchProvider({
              name: "demo-search",
              query: (context) => ({ hits: context.documents.map((document) => ({ id: document.metadata.id, score: 1 })) }),
            }),
          );
          api.hooks.afterCommand(
            defineAfterCommandHook((context) => {
              observed.push(context.command);
            }),
          );
        },
      },
      { name: "define-demo", capabilities: ["commands", "search", "hooks"] },
    );

    expect(activation.registration_counts.search_providers).toBe(1);
    const run = await runRegisteredCommandForTest(activation.commands, { command: "demo run" });
    expect(run).toEqual({ handled: true, result: { ok: true, command: "demo run" }, warnings: [] });

    // The defineAfterCommandHook output is a dispatchable hook: fire it through
    // the real runner and assert its recorded side effect, so the test fails if
    // hook registration or dispatch regresses (not just that activation counted).
    const warnings = await runRegisteredHookForTest(activation.hooks, {
      kind: "after_command",
      context: { command: "demo run", args: [], pm_root: "", ok: true },
    });
    expect(warnings).toEqual([]);
    expect(observed).toEqual(["demo run"]);
  });
});
