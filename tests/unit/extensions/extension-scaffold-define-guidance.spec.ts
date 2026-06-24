import { describe, expect, it } from "vitest";
import { buildStarterExtensionScaffoldFiles } from "../../../src/cli/commands/extension/scaffold.js";

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

  it("scaffolds a package as a TypeScript-only project (type-check tsconfig + .ts entry, no compiled output)", () => {
    const scaffold = buildStarterExtensionScaffoldFiles("tool-kit", "tool kit ping", "package", "commands");
    const packageJson = JSON.parse(scaffold["package.json"] ?? "{}") as {
      engines?: Record<string, string>;
      scripts?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const tsconfig = JSON.parse(scaffold["tsconfig.json"] ?? "{}") as {
      compilerOptions?: Record<string, unknown>;
      include?: string[];
    };

    // pm loads the ./index.ts manifest entry directly via Node's native type
    // stripping (Node >=22.18): there is no build step, `typecheck` validates the
    // source, and `test` runs `node --test` (which strips types on load).
    expect(packageJson.engines?.node).toBe(">=22.18.0");
    expect(packageJson.scripts?.build).toBeUndefined();
    expect(packageJson.scripts?.typecheck).toBe("tsc --noEmit");
    expect(packageJson.scripts?.test).toBe("node --test");
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

    expect(readme).not.toContain("## Authoring With define* Builders");
    // Standalone extensions are still authored in TypeScript: typed entrypoint +
    // a tsconfig, with the README documenting the compile step.
    expect(entrypoint).toContain('import type { ExtensionApi } from "@unbrained/pm-cli/sdk";');
    expect(entrypoint).toContain("export function activate(api: ExtensionApi): void {");
    expect(scaffold["tsconfig.json"]).toBeTruthy();
    expect(scaffold["index.js"]).toBeUndefined();
    expect(readme).toContain("npm install -D typescript @types/node @unbrained/pm-cli");
    expect(readme).toContain("npx tsc");
  });
});
