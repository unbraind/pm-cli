import { describe, expect, it } from "vitest";
import {
  buildStarterExtensionScaffoldFiles,
  SCAFFOLD_PM_MIN_VERSION,
  type ExtensionScaffoldCapability,
} from "../../../src/cli/commands/extension/scaffold.js";

describe("extension scaffold define builder guidance", () => {
  it("documents the define* builder upgrade path for commands-only package scaffolds", () => {
    const scaffold = buildStarterExtensionScaffoldFiles("tool-kit", "tool kit ping", "package", "commands");
    const readme = scaffold["README.md"] ?? "";
    const entrypoint = scaffold["index.ts"] ?? "";

    expect(readme).toContain("## Authoring With define* Builders");
    expect(readme).toContain('import { defineCommand } from "@unbrained/pm-cli/sdk";');
    expect(readme).toContain('import type { ExtensionApi } from "@unbrained/pm-cli/sdk";');
    expect(readme).not.toContain("defineAfterCommandHook");
    expect(readme).toContain("api.registerCommand(pingCommand);");
    expect(readme).toContain("export default { activate, deactivate };");
    // The entrypoint is authored fully in TypeScript: a typed `ExtensionApi`
    // parameter checked against the SDK contract, no JS+JSDoc fallback.
    expect(entrypoint).toContain('import type { ExtensionApi } from "@unbrained/pm-cli/sdk";');
    expect(entrypoint).toContain("export function activate(api: ExtensionApi): void {");
    expect(entrypoint).toContain("export function deactivate(): void {}");
    expect(entrypoint).not.toContain("@param");
  });

  it("documents the package define* builder upgrade path with TypeScript entrypoints", () => {
    const scaffold = buildStarterExtensionScaffoldFiles("context-kit", "context kit ping", "package", "hooks");
    const readme = scaffold["README.md"] ?? "";
    const entrypoint = scaffold["index.ts"] ?? "";

    expect(readme).toContain("## Authoring With define* Builders");
    expect(readme).toContain('import { defineCommand, defineAfterCommandHook } from "@unbrained/pm-cli/sdk";');
    expect(readme).toContain("api.hooks.afterCommand(afterCommandHook);");
    expect(readme).toContain("export function deactivate(): void {}");
    expect(readme).toContain("The builders return their argument unchanged");
    expect(entrypoint).toContain('import type { ExtensionApi } from "@unbrained/pm-cli/sdk";');
    expect(entrypoint).toContain("api.hooks.afterCommand((context) => {");
  });

  it("tailors package define* examples to search and importer capabilities", () => {
    const searchReadme = buildStarterExtensionScaffoldFiles("search-kit", "search kit ping", "package", "search")["README.md"] ?? "";
    const importerReadme =
      buildStarterExtensionScaffoldFiles("sync-kit", "sync kit ping", "package", "importers")["README.md"] ?? "";

    expect(searchReadme).toContain(
      'import { defineCommand, defineSearchProvider, defineVectorStoreAdapter } from "@unbrained/pm-cli/sdk";',
    );
    expect(searchReadme).toContain("api.registerSearchProvider(searchProvider);");
    expect(searchReadme).toContain("api.registerVectorStoreAdapter(vectorStoreAdapter);");
    expect(importerReadme).toContain('import { defineCommand, defineImporter, defineExporter } from "@unbrained/pm-cli/sdk";');
    expect(importerReadme).toContain('api.registerImporter("sync kit items", importer, {');
    expect(importerReadme).toContain('action: "sync kit items import"');
    expect(importerReadme).toContain('long: "--source"');
    expect(importerReadme).toContain('api.registerExporter("sync kit items", exporter, {');
    expect(importerReadme).toContain('action: "sync kit items export"');
    expect(importerReadme).toContain('long: "--destination"');
  });

  it("tailors package define* examples to the schema capability", () => {
    const schemaReadme = buildStarterExtensionScaffoldFiles("domain-kit", "domain kit ping", "package", "schema")["README.md"] ?? "";

    expect(schemaReadme).toContain(
      'import { defineCommand, defineItemType, defineItemField, defineMigration } from "@unbrained/pm-cli/sdk";',
    );
    expect(schemaReadme).toContain('export const noteField = defineItemField({ name: "domain_kit_note", type: "string", optional: true });');
    expect(schemaReadme).toContain("export const itemType = defineItemType({");
    expect(schemaReadme).toContain('name: "domain-kit"');
    expect(schemaReadme).toContain('folder: "domain-kits"');
    expect(schemaReadme).toContain('aliases: ["domainkit"]');
    expect(schemaReadme).toContain("export const initMigration = defineMigration({");
    expect(schemaReadme).toContain('id: "domain-kit-0001-init"');
    expect(schemaReadme).toContain("api.registerItemFields([noteField]);");
    expect(schemaReadme).toContain("api.registerItemTypes([itemType]);");
    expect(schemaReadme).toContain("api.registerMigration(initMigration);");
  });

  it("omits a redundant self-alias when a single-word schema type equals its de-hyphenated alias", () => {
    const scaffold = buildStarterExtensionScaffoldFiles("todo", "todo ping", "package", "schema");
    const entry = scaffold["index.ts"] ?? "";
    const readme = scaffold["README.md"] ?? "";

    // "todo" has no hyphen, so the de-hyphenated alias equals the type name; the
    // starter registers no alias rather than a confusing self-alias. The
    // entrypoint and the README define* snippet agree.
    expect(entry).toContain("aliases: [],");
    expect(entry).not.toContain('aliases: ["todo"]');
    expect(readme).toContain("aliases: [],");
    expect(readme).not.toContain('aliases: ["todo"]');
    // A hyphenated name still gets a useful short alias.
    const hyphenEntry = buildStarterExtensionScaffoldFiles("my-todo", "my todo ping", "package", "schema")["index.ts"] ?? "";
    expect(hyphenEntry).toContain('aliases: ["mytodo"],');
  });

  it("declares manifest activation.commands matching every registered command path per capability", () => {
    const commandsManifest = JSON.parse(
      buildStarterExtensionScaffoldFiles("tool-kit", "tool kit ping", "package", "commands")["manifest.json"] ?? "{}",
    ) as { activation?: { commands?: string[] } };
    const searchManifest = JSON.parse(
      buildStarterExtensionScaffoldFiles("search-kit", "search kit ping", "package", "search")["manifest.json"] ?? "{}",
    ) as { activation?: { commands?: string[] } };
    const importerScaffold = buildStarterExtensionScaffoldFiles("sync-kit", "sync kit ping", "package", "importers");
    const importerManifest = JSON.parse(importerScaffold["manifest.json"] ?? "{}") as {
      activation?: { commands?: string[] };
    };
    const schemaScaffold = buildStarterExtensionScaffoldFiles("domain-kit", "domain kit ping", "package", "schema");
    const schemaManifest = JSON.parse(schemaScaffold["manifest.json"] ?? "{}") as {
      activation?: { commands?: string[] };
    };

    // commands/search variants register just the starter command; the importers
    // variant additionally registers paired import/export command handlers.
    expect(commandsManifest.activation?.commands).toEqual(["tool kit ping"]);
    expect(searchManifest.activation?.commands).toEqual(["search kit ping"]);
    expect(importerManifest.activation?.commands).toEqual([
      "sync kit ping",
      "sync kit items import",
      "sync kit items export",
    ]);
    // The schema variant registers a GLOBAL custom item type, so it omits the
    // activation field entirely and relies on conservative activation instead.
    expect(schemaManifest.activation).toBeUndefined();
    // The README documents the field so authors keep it in sync with index.ts.
    expect(importerScaffold["README.md"]).toContain("## Lazy Activation");
    expect(importerScaffold["README.md"]).toContain("`activation.commands`");
    // The schema README documents conservative activation, not the lazy contract.
    expect(schemaScaffold["README.md"]).toContain("## Activation");
    expect(schemaScaffold["README.md"]).not.toContain("## Lazy Activation");
  });

  it("scaffolds a runnable renderer override starter scoped to its own command", () => {
    const scaffold = buildStarterExtensionScaffoldFiles("view-kit", "view kit ping", "package", "renderers");
    const entry = scaffold["index.ts"] ?? "";
    const sampleTest = scaffold["index.test.ts"] ?? "";
    const readme = scaffold["README.md"] ?? "";
    const manifest = JSON.parse(scaffold["manifest.json"] ?? "{}") as {
      capabilities?: string[];
      activation?: { commands?: string[] };
    };

    expect(manifest.capabilities).toEqual(["commands", "renderers"]);
    // A renderer override is global, but the starter still registers the `ping`
    // command, so it declares activation.commands for lazy command dispatch.
    expect(manifest.activation?.commands).toEqual(["view kit ping"]);
    // The override scopes itself to its own command and passes other output
    // through (returns null) so installing it never disrupts unrelated commands.
    expect(entry).toContain('api.registerRenderer("toon", (context) => {');
    expect(entry).toContain('if (context.command !== "view kit ping") {');
    expect(entry).toContain("return null;");
    expect(entry).toContain('return "view-kit: " + JSON.stringify(context.result);');
    expect(sampleTest).toContain("  createExtensionTestHarness,");
    expect(sampleTest).toContain('const override = ext.assertRendererOverride({ format: "toon", extensionName: "view-kit" });');
    expect(sampleTest).toContain("const rendered = await ext.runRendererOverride({");
    expect(sampleTest).toContain("assert.equal(passthrough.overridden, false);");
    expect(sampleTest).toContain("} finally {");
    expect(sampleTest).toContain("assertExtensionDeactivated(teardown);");
    expect(sampleTest).toContain("if (!deactivated) {");
    expect(sampleTest).toContain("try {");
    expect(sampleTest).toContain("} catch {}");
    expect(sampleTest).toContain("await ext.deactivate();");
    expect(readme).toContain(
      'import { defineCommand, defineRendererOverride } from "@unbrained/pm-cli/sdk";',
    );
    expect(readme).toContain("export const toonRenderer = defineRendererOverride((context) => {");
    expect(readme).toContain('api.registerRenderer("toon", toonRenderer);');
    expect(readme).toContain("## Output Renderer");
    expect(readme).toContain("## Lazy Activation");
  });

  it("scaffolds a runnable parser override starter with matching command flags", () => {
    const scaffold = buildStarterExtensionScaffoldFiles("flag-kit", "flag kit ping", "package", "parser");
    const entry = scaffold["index.ts"] ?? "";
    const sampleTest = scaffold["index.test.ts"] ?? "";
    const readme = scaffold["README.md"] ?? "";
    const manifest = JSON.parse(scaffold["manifest.json"] ?? "{}") as {
      capabilities?: string[];
      activation?: { commands?: string[] };
    };

    // Flag metadata is schema-governed, so the parser starter also declares
    // `schema` so the override is runnable through `pm <command> --shout`.
    expect(manifest.capabilities).toEqual(["commands", "parser", "schema"]);
    expect(manifest.activation?.commands).toEqual(["flag kit ping"]);
    // The command declares the deprecated alias + canonical flag the override
    // normalizes, and surfaces the normalized value so the demo is end-to-end.
    expect(entry).toContain('long: "--shout",');
    expect(entry).toContain('long: "--upper",');
    expect(entry).toContain("upper: context.options.upper === true,");
    expect(entry).toContain('api.registerParser("flag kit ping", (context) => {');
    expect(entry).toContain("if (options.shout === true) {");
    expect(entry).toContain("options.upper = true;");
    expect(entry).toContain("return { options };");
    expect(sampleTest).toContain("  createExtensionTestHarness,");
    expect(sampleTest).toContain('ext.assertParserOverride({ command: "flag kit ping", extensionName: "flag-kit" });');
    expect(sampleTest).toContain("const result = await ext.runParserOverride({");
    expect(sampleTest).toContain("assert.deepEqual(result.context.options, { upper: true });");
    // The sample test feeds the rewritten options into the command handler to
    // prove the normalized flag is surfaced end to end.
    expect(sampleTest).toContain('const invocation = await ext.runCommand({ command: "flag kit ping", options: result.context.options });');
    expect(sampleTest).toContain("      upper: true,");
    expect(sampleTest).toContain("} finally {");
    expect(sampleTest).toContain("assertExtensionDeactivated(teardown);");
    expect(sampleTest).toContain("if (!deactivated) {");
    expect(sampleTest).toContain("try {");
    expect(sampleTest).toContain("} catch {}");
    expect(sampleTest).toContain("await ext.deactivate();");
    expect(readme).toContain(
      'import { defineCommand, defineParserOverride } from "@unbrained/pm-cli/sdk";',
    );
    expect(readme).toContain('long: "--shout"');
    expect(readme).toContain("export const pingParser = defineParserOverride((context) => {");
    expect(readme).toContain('api.registerParser("flag kit ping", pingParser);');
    expect(readme).toContain("## Parser Override");
  });

  it("scaffolds a runnable preflight override starter that echoes the gate decision", () => {
    const scaffold = buildStarterExtensionScaffoldFiles("gate-kit", "gate kit ping", "package", "preflight");
    const entry = scaffold["index.ts"] ?? "";
    const sampleTest = scaffold["index.test.ts"] ?? "";
    const readme = scaffold["README.md"] ?? "";
    const manifest = JSON.parse(scaffold["manifest.json"] ?? "{}") as {
      capabilities?: string[];
      activation?: { commands?: string[] };
    };

    expect(manifest.capabilities).toEqual(["commands", "preflight"]);
    expect(manifest.activation?.commands).toEqual(["gate kit ping"]);
    // The starter returns context.decision unchanged (a safe no-op delta); the
    // comment documents the keys the author can change.
    expect(entry).toContain("api.registerPreflight((context) => context.decision);");
    expect(entry).toContain("run_extension_migrations, enforce_mandatory_migration_gate);");
    expect(sampleTest).toContain("  createExtensionTestHarness,");
    expect(sampleTest).toContain('ext.assertPreflightOverride({ extensionName: "gate-kit" });');
    expect(sampleTest).toContain("const result = await ext.runPreflightOverride({");
    expect(sampleTest).toContain("assert.deepEqual(result.decision, decision);");
    expect(sampleTest).toContain("} finally {");
    expect(sampleTest).toContain("assertExtensionDeactivated(teardown);");
    expect(sampleTest).toContain("if (!deactivated) {");
    expect(sampleTest).toContain("try {");
    expect(sampleTest).toContain("} catch {}");
    expect(sampleTest).toContain("await ext.deactivate();");
    expect(readme).toContain(
      'import { defineCommand, definePreflightOverride } from "@unbrained/pm-cli/sdk";',
    );
    expect(readme).toContain("export const preflightOverride = definePreflightOverride((context) => context.decision);");
    expect(readme).toContain("api.registerPreflight(preflightOverride);");
    expect(readme).toContain("## Preflight Override");
  });

  it("scaffolds a runnable service override starter scoped to its own command", () => {
    const scaffold = buildStarterExtensionScaffoldFiles("svc-kit", "svc kit ping", "package", "services");
    const entry = scaffold["index.ts"] ?? "";
    const sampleTest = scaffold["index.test.ts"] ?? "";
    const readme = scaffold["README.md"] ?? "";
    const manifest = JSON.parse(scaffold["manifest.json"] ?? "{}") as {
      capabilities?: string[];
      activation?: { commands?: string[] };
    };

    expect(manifest.capabilities).toEqual(["commands", "services"]);
    // The service override is scoped to its own command, so the starter declares
    // activation.commands for lazy activation (it is not a global contribution
    // like schema, which would need the field omitted).
    expect(manifest.activation?.commands).toEqual(["svc kit ping"]);
    expect(entry).toContain('api.registerService("output_format", (context) => {');
    expect(entry).toContain('if (context.command !== "svc kit ping") {');
    expect(entry).toContain("return context.payload;");
    expect(entry).toContain('return { rendered_by: "svc-kit", payload: context.payload };');
    expect(sampleTest).toContain("  createExtensionTestHarness,");
    expect(sampleTest).toContain('ext.assertServiceOverride({ service: "output_format", extensionName: "svc-kit" });');
    expect(sampleTest).toContain("const handled = await ext.runServiceOverride({");
    expect(sampleTest).toContain("assert.equal(passthrough.handled, false);");
    expect(sampleTest).toContain("} finally {");
    expect(sampleTest).toContain("assertExtensionDeactivated(teardown);");
    expect(sampleTest).toContain("if (!deactivated) {");
    expect(sampleTest).toContain("try {");
    expect(sampleTest).toContain("} catch {}");
    expect(sampleTest).toContain("await ext.deactivate();");
    expect(readme).toContain(
      'import { defineCommand, defineServiceOverride } from "@unbrained/pm-cli/sdk";',
    );
    expect(readme).toContain("export const outputService = defineServiceOverride((context) => {");
    expect(readme).toContain('api.registerService("output_format", outputService);');
    expect(readme).toContain("## Service Override");
    expect(readme).toContain("## Lazy Activation");
  });

  it("scaffolds a package as a TypeScript-only project (type-check tsconfig + .ts entry, no compiled output)", () => {
    const scaffold = buildStarterExtensionScaffoldFiles("tool-kit", "tool kit ping", "package", "commands");
    const packageJson = JSON.parse(scaffold["package.json"] ?? "{}") as {
      engines?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      scripts?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const manifest = JSON.parse(scaffold["manifest.json"] ?? "{}") as {
      pm_min_version?: string;
    };
    const tsconfig = JSON.parse(scaffold["tsconfig.json"] ?? "{}") as {
      compilerOptions?: Record<string, unknown>;
      include?: string[];
    };

    // pm loads the ./index.ts manifest entry directly via Node's native type
    // stripping (Node >=22.18): there is no build step, `typecheck` validates the
    // source, `test:runtime` runs node:test, and `test` is the self-validating gate.
    expect(packageJson.engines?.node).toBe(">=22.18.0");
    expect(packageJson.peerDependencies?.["@unbrained/pm-cli"]).toBe(`>=${SCAFFOLD_PM_MIN_VERSION}`);
    expect(manifest.pm_min_version).toBe(SCAFFOLD_PM_MIN_VERSION);
    expect(scaffold["README.md"]).toContain(`Scaffolded as \`${SCAFFOLD_PM_MIN_VERSION}\``);
    expect(packageJson.scripts?.build).toBeUndefined();
    expect(packageJson.scripts?.typecheck).toBe("tsc --noEmit");
    expect(packageJson.scripts?.["test:runtime"]).toBe("node --test");
    expect(packageJson.scripts?.test).toBe("npm run typecheck && npm run test:runtime");
    expect(scaffold["README.md"]).toContain("`npm test` is the default");
    expect(scaffold["README.md"]).toContain("npm run test:runtime");
    expect(packageJson.devDependencies?.typescript).toBeTruthy();
    // `@types/node` is required: the colocated index.test.ts imports node:test/node:assert.
    expect(packageJson.devDependencies?.["@types/node"]).toBeTruthy();
    expect(tsconfig.compilerOptions?.strict).toBe(true);
    expect(tsconfig.compilerOptions?.module).toBe("NodeNext");
    expect(tsconfig.compilerOptions?.types).toEqual(["node"]);
    // Type-check-only: noEmit (no compiled output) plus allowImportingTsExtensions
    // so index.test.ts can import the sibling ./index.ts entry with its real extension.
    expect(tsconfig.compilerOptions?.noEmit).toBe(true);
    expect(tsconfig.compilerOptions?.allowImportingTsExtensions).toBe(true);
    expect(tsconfig.compilerOptions?.outDir).toBeUndefined();
    // Recursive include so subdirectory modules type-check as the package grows.
    expect(tsconfig.include).toEqual(["**/*.ts"]);
    // The sample test imports the .ts entry directly; the manifest loads ./index.ts
    // and no .js is emitted or committed.
    expect(scaffold["index.test.ts"]).toContain('import extension from "./index.ts";');
    expect(scaffold["index.test.ts"]).toContain("createExtensionTestHarness,");
    expect(scaffold["index.test.ts"]).toContain("const ext = await createExtensionTestHarness(extension, {");
    expect(scaffold["index.test.ts"]).toContain('const registered = ext.assertCommandContract({');
    expect(scaffold["index.test.ts"]).toContain("const invocation = await ext.runCommand({");
    expect(scaffold["index.test.ts"]).toContain("const teardown = await ext.deactivate();");
    expect(scaffold["index.test.ts"]).not.toContain("activateExtensionForTest,");
    expect(scaffold["index.test.ts"]).not.toContain("assertRegisteredCommandContract,");
    expect(scaffold["index.test.ts"]).not.toContain("deactivateExtensionForTest,");
    expect(scaffold["index.test.ts"]).not.toContain("runRegisteredCommandForTest,");
    expect(scaffold["index.js"]).toBeUndefined();
    expect(JSON.parse(scaffold["manifest.json"] ?? "{}").entry).toBe("./index.ts");
    // No compiled-output ignores remain — only deps, logs, and the tsc cache.
    expect(scaffold[".gitignore"]).toContain("node_modules/");
    expect(scaffold[".gitignore"]).toContain("*.tsbuildinfo");
    expect(scaffold[".gitignore"]).not.toContain("*.test.js");
    expect(scaffold[".gitignore"]).not.toContain("*.d.ts");
  });

  it("scaffolds standalone extensions as TypeScript with a tsconfig and build guidance", () => {
    const scaffold = buildStarterExtensionScaffoldFiles("local-ext", "local ext ping", "extension", "commands");
    const readme = scaffold["README.md"] ?? "";
    const entrypoint = scaffold["index.ts"] ?? "";
    const manifest = JSON.parse(scaffold["manifest.json"] ?? "{}") as {
      pm_min_version?: string;
    };

    expect(readme).not.toContain("## Authoring With define* Builders");
    // Standalone extensions are still authored in TypeScript: typed entrypoint +
    // a tsconfig, with the README documenting the compile step.
    expect(entrypoint).toContain('import type { ExtensionApi } from "@unbrained/pm-cli/sdk";');
    expect(entrypoint).toContain("export function activate(api: ExtensionApi): void {");
    expect(manifest.pm_min_version).toBe(SCAFFOLD_PM_MIN_VERSION);
    expect(readme).toContain(`Scaffolded as \`${SCAFFOLD_PM_MIN_VERSION}\``);
    expect(scaffold["tsconfig.json"]).toBeTruthy();
    expect(scaffold["index.js"]).toBeUndefined();
    expect(readme).toContain("npm install -D typescript @types/node @unbrained/pm-cli");
    expect(readme).toContain("npx tsc");
  });
});

describe("declarative composeExtension package scaffold", () => {
  it("authors index.ts through the composeExtension blueprint loop instead of an imperative activate", () => {
    const scaffold = buildStarterExtensionScaffoldFiles("kit", "kit ping", "package", "commands", true);
    const entry = scaffold["index.ts"] ?? "";

    // The flagship declarative loop: defineCommand authors the command, it is
    // collected into a defineExtensionBlueprint blueprint, and composeExtension
    // generates the runtime module. No hand-written `activate(api)` body.
    expect(entry).toContain('import { composeExtension, defineCommand, defineExtensionBlueprint } from "@unbrained/pm-cli/sdk";');
    expect(entry).toContain("export const pingCommand = defineCommand({");
    expect(entry).toContain('name: "kit ping",');
    expect(entry).toContain("export const blueprint = defineExtensionBlueprint({");
    expect(entry).toContain("commands: [pingCommand],");
    // The blueprint's deactivate hatch is composed onto the module verbatim.
    expect(entry).toContain("deactivate: () => {},");
    expect(entry).toContain("export default composeExtension(blueprint);");
    // It is genuinely declarative: no imperative activate(api) body and no
    // `defineExtension` wrapper.
    expect(entry).not.toContain("export function activate(api: ExtensionApi)");
    expect(entry).not.toContain("import { defineExtension }");
  });

  it("tests the declarative starter via the author-time preflight + runtime harness capstones", () => {
    const scaffold = buildStarterExtensionScaffoldFiles("kit", "kit ping", "package", "commands", true);
    const sampleTest = scaffold["index.test.ts"] ?? "";

    // The two capstones the declarative loop unlocks: author-time preflight over
    // the exported blueprint, and the ergonomic runtime harness over the module.
    expect(sampleTest).toContain(
      'import { assertExtensionDeactivated, assertExtensionPreflight, createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";',
    );
    expect(sampleTest).toContain('import extension, { blueprint } from "./index.ts";');
    expect(sampleTest).toContain("const report = assertExtensionPreflight(blueprint, {");
    // The synthesized manifest + derived capabilities are asserted, proving the
    // blueprint never drifts from manifest.json's capabilities.
    expect(sampleTest).toContain('assert.deepEqual(report.capabilities, ["commands"]);');
    expect(sampleTest).toContain('assert.deepEqual(report.manifest?.capabilities, ["commands"]);');
    expect(sampleTest).toContain("const ext = await createExtensionTestHarness(extension, {");
    expect(sampleTest).toContain('const registered = ext.assertCommandContract({ command: "kit ping" });');
    expect(sampleTest).toContain('const invocation = await ext.runCommand({ command: "kit ping" });');
    expect(sampleTest).toContain("  let deactivated = false;");
    expect(sampleTest).toContain("  try {");
    expect(sampleTest).toContain("  } finally {");
    expect(sampleTest).toContain("    if (!deactivated) {");
    expect(sampleTest).toContain("      try {");
    expect(sampleTest).toContain("      } catch {}");
    expect(sampleTest).toContain("const teardown = await ext.deactivate();");
    expect(sampleTest).toContain("assertExtensionDeactivated(teardown);");
    expect(sampleTest).toContain("deactivated = true;");
    // The declarative test does not reach for the standalone activate/assert
    // helpers the imperative starter uses — the harness binds them for it.
    expect(sampleTest).not.toContain("activateExtensionForTest");
    expect(sampleTest).not.toContain("assertRegisteredCommandContract");
  });

  it("documents the declarative authoring loop in the README", () => {
    const readme = buildStarterExtensionScaffoldFiles("kit", "kit ping", "package", "commands", true)["README.md"] ?? "";
    expect(readme).toContain("Generated by `pm package init --declarative`.");
    expect(readme).toContain("## Declarative Authoring");
    expect(readme).toContain("`composeExtension`");
    expect(readme).toContain("`assertExtensionPreflight`");
    expect(readme).toContain("`createExtensionTestHarness`");
    // The declarative entrypoint bullet replaces the imperative one.
    expect(readme).toContain("composed into the runtime module by `composeExtension`");
  });

  it("keeps the package metadata identical to the imperative commands starter", () => {
    const declarative = buildStarterExtensionScaffoldFiles("kit", "kit ping", "package", "commands", true);
    const imperative = buildStarterExtensionScaffoldFiles("kit", "kit ping", "package", "commands", false);

    // Only the entrypoint, test, and README differ; the manifest, package.json,
    // tsconfig, and .gitignore are byte-identical so the declarative starter
    // installs and activates exactly like the imperative commands starter.
    expect(declarative["manifest.json"]).toBe(imperative["manifest.json"]);
    expect(declarative["package.json"]).toBe(imperative["package.json"]);
    expect(declarative["tsconfig.json"]).toBe(imperative["tsconfig.json"]);
    expect(declarative[".gitignore"]).toBe(imperative[".gitignore"]);
    expect(declarative["index.ts"]).not.toBe(imperative["index.ts"]);
    expect(declarative["index.test.ts"]).not.toBe(imperative["index.test.ts"]);

    const manifest = JSON.parse(declarative["manifest.json"] ?? "{}") as Record<string, unknown>;
    expect(manifest.capabilities).toEqual(["commands"]);
    expect(manifest.activation).toEqual({ commands: ["kit ping"] });
  });

  it("ignores the declarative flag for extension-mode scaffolds (handled by scaffoldExtensionProject)", () => {
    // buildStarterExtensionScaffoldFiles only consumes `declarative` in the
    // package branch; extension-mode passes through to the imperative starter.
    // scaffoldExtensionProject rejects extension-mode + declarative before this.
    const entry = buildStarterExtensionScaffoldFiles("local-ext", "local ext ping", "extension", "commands", true)["index.ts"] ?? "";
    expect(entry).toContain("export function activate(api: ExtensionApi): void {");
    expect(entry).not.toContain("composeExtension(blueprint)");
  });

  // The full capability matrix: every --capability variant emits its
  // composeExtension(blueprint) form (the right define* imports, blueprint fields,
  // and a harness test for the capability surface) — pm-lfdv.
  const MATRIX: ReadonlyArray<{
    capability: ExtensionScaffoldCapability;
    builderImports: readonly string[];
    blueprintFields: readonly string[];
    entrypointMarkers: readonly string[];
    testMarkers: readonly string[];
    derivedCapabilities: string;
    surfacePhrase: string;
  }> = [
    {
      capability: "hooks",
      builderImports: ["defineAfterCommandHook"],
      blueprintFields: ["  hooks: { afterCommand: [afterCommandHook] },"],
      entrypointMarkers: ["export const afterCommandHook = defineAfterCommandHook((context) => {"],
      testMarkers: ['ext.assertHook({ kind: "after_command", extensionName: "kit" });', "const warnings = await ext.runHook({"],
      derivedCapabilities: '["commands","hooks"]',
      surfacePhrase: "starter command and after_command hook",
    },
    {
      capability: "search",
      builderImports: ["defineSearchProvider", "defineVectorStoreAdapter"],
      blueprintFields: ["  searchProviders: [searchProvider],", "  vectorStoreAdapters: [vectorStoreAdapter],"],
      entrypointMarkers: ["export const searchProvider = defineSearchProvider({", "export const vectorStoreAdapter = defineVectorStoreAdapter({"],
      testMarkers: [
        'import type { ItemDocument, PmSettings } from "@unbrained/pm-cli/sdk";',
        "const query = await ext.runSearchProvider({",
        "const vectorHits = await ext.runVectorStoreAdapter({",
      ],
      derivedCapabilities: '["commands","search"]',
      surfacePhrase: "starter command, search provider, and vector-store adapter",
    },
    {
      capability: "importers",
      builderImports: ["defineExporter", "defineImporter"],
      blueprintFields: ["  importers: [", "  exporters: ["],
      entrypointMarkers: ["export const importer = defineImporter(async (context) => ({", "export const exporter = defineExporter(async (context) => ({"],
      testMarkers: ["const imported = await ext.runImporter({", "const exported = await ext.runExporter({"],
      // The importer/exporter declare flags, so the derived set includes `schema`
      // (SDK fix pm-v3ty) — sorted: commands, importers, schema.
      derivedCapabilities: '["commands","importers","schema"]',
      surfacePhrase: "starter command, importer, and exporter",
    },
    {
      capability: "schema",
      builderImports: ["defineItemField", "defineItemType", "defineMigration"],
      blueprintFields: ["  itemTypes: [itemType],", "  itemFields: [noteField],", "  migrations: [initMigration],"],
      entrypointMarkers: ["export const noteField = defineItemField({", "export const initMigration = defineMigration({"],
      testMarkers: ["const itemType = ext.assertItemType({", "const migrated = await ext.runMigration({"],
      derivedCapabilities: '["commands","schema"]',
      surfacePhrase: "starter command, custom item type, item field, and migration",
    },
    {
      capability: "renderers",
      builderImports: ["defineRendererOverride"],
      blueprintFields: ["  renderers: { toon: toonRenderer },"],
      entrypointMarkers: ["export const toonRenderer = defineRendererOverride((context) => {"],
      testMarkers: ["const rendered = await ext.runRendererOverride({", "assert.equal(rendered.overridden, true);"],
      derivedCapabilities: '["commands","renderers"]',
      surfacePhrase: "starter command and toon renderer override",
    },
    {
      capability: "parser",
      builderImports: ["defineParserOverride"],
      blueprintFields: ['  parsers: { "kit ping": pingParser },'],
      entrypointMarkers: ["export const pingParser = defineParserOverride((context) => {", '      long: "--shout",'],
      testMarkers: ["const result = await ext.runParserOverride({", "assert.deepEqual(result.context.options, { upper: true });", "    upper: false,"],
      derivedCapabilities: '["commands","parser","schema"]',
      surfacePhrase: "starter command and parser override",
    },
    {
      capability: "preflight",
      builderImports: ["definePreflightOverride"],
      blueprintFields: ["  preflights: [preflightOverride],"],
      entrypointMarkers: ["export const preflightOverride = definePreflightOverride((context) => context.decision);"],
      testMarkers: ["const result = await ext.runPreflightOverride({", "assert.deepEqual(result.decision, decision);"],
      derivedCapabilities: '["commands","preflight"]',
      surfacePhrase: "starter command and preflight override",
    },
    {
      capability: "services",
      builderImports: ["defineServiceOverride"],
      blueprintFields: ["  services: { output_format: outputService },"],
      entrypointMarkers: ["export const outputService = defineServiceOverride((context) => {"],
      testMarkers: ["const handled = await ext.runServiceOverride({", "assert.equal(passthrough.handled, false);"],
      derivedCapabilities: '["commands","services"]',
      surfacePhrase: "starter command and output_format service override",
    },
  ];

  it.each(MATRIX)(
    "scaffolds the $capability capability through the composeExtension blueprint",
    ({ capability, builderImports, blueprintFields, entrypointMarkers, testMarkers, derivedCapabilities, surfacePhrase }) => {
      const declarative = buildStarterExtensionScaffoldFiles("kit", "kit ping", "package", capability, true);
      const imperative = buildStarterExtensionScaffoldFiles("kit", "kit ping", "package", capability, false);
      const entry = declarative["index.ts"] ?? "";
      const sampleTest = declarative["index.test.ts"] ?? "";
      const readme = declarative["README.md"] ?? "";

      // The entrypoint is the declarative loop — never an imperative activate body.
      expect(entry).toContain("export const blueprint = defineExtensionBlueprint({");
      expect(entry).toContain("export default composeExtension(blueprint);");
      expect(entry).not.toContain("export function activate(api: ExtensionApi)");
      // The capability's define* builders are imported and its blueprint fields wired.
      for (const builder of builderImports) {
        expect(entry).toContain(builder);
      }
      for (const field of blueprintFields) {
        expect(entry).toContain(field);
      }
      for (const marker of entrypointMarkers) {
        expect(entry).toContain(marker);
      }
      // The colocated test exercises the author-time preflight + a harness block for
      // the capability surface, asserting the DERIVED (sorted) capability set.
      expect(sampleTest).toContain("const report = assertExtensionPreflight(blueprint, {");
      expect(sampleTest).toContain(`assert.deepEqual(report.capabilities, ${derivedCapabilities});`);
      expect(sampleTest).toContain(`assert.deepEqual(report.manifest?.capabilities, ${derivedCapabilities});`);
      expect(sampleTest).toContain("const ext = await createExtensionTestHarness(extension, {");
      for (const marker of testMarkers) {
        expect(sampleTest).toContain(marker);
      }
      // The declarative test never reaches for the standalone helpers — the harness
      // binds them.
      expect(sampleTest).not.toContain("activateExtensionForTest");
      // The README documents the declarative loop and the capability's surface.
      expect(readme).toContain("Generated by `pm package init --declarative`.");
      expect(readme).toContain(`blueprint (${surfacePhrase})`);

      // The manifest, package.json, tsconfig, and .gitignore are byte-identical to
      // the imperative starter for the same capability, so a declarative package
      // installs and activates exactly like its imperative twin.
      expect(declarative["manifest.json"]).toBe(imperative["manifest.json"]);
      expect(declarative["package.json"]).toBe(imperative["package.json"]);
      expect(declarative["tsconfig.json"]).toBe(imperative["tsconfig.json"]);
      expect(declarative[".gitignore"]).toBe(imperative[".gitignore"]);
    },
  );

  it("omits activation.commands for the declarative schema starter (global item type)", () => {
    const scaffold = buildStarterExtensionScaffoldFiles("kit", "kit ping", "package", "schema", true);
    const manifest = JSON.parse(scaffold["manifest.json"] ?? "{}") as Record<string, unknown>;
    expect(manifest.capabilities).toEqual(["commands", "schema"]);
    expect(manifest.activation).toBeUndefined();
    // The README explains the conservative-activation tradeoff rather than lazy activation.
    const readme = scaffold["README.md"] ?? "";
    expect(readme).toContain("## Activation");
    expect(readme).toContain("contributes a GLOBAL custom item type");
    expect(readme).not.toContain("## Lazy Activation");
  });
});
