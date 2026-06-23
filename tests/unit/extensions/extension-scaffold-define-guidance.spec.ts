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

  it("scaffolds a package as a buildable TypeScript project (tsconfig + build script + ignored output)", () => {
    const scaffold = buildStarterExtensionScaffoldFiles("tool-kit", "tool kit ping", "package", "commands");
    const packageJson = JSON.parse(scaffold["package.json"] ?? "{}") as {
      scripts?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const tsconfig = JSON.parse(scaffold["tsconfig.json"] ?? "{}") as {
      compilerOptions?: Record<string, unknown>;
      include?: string[];
    };

    // The package builds index.ts to the ./index.js manifest entry, and `test`
    // compiles before running the emitted *.test.js (Node 20 cannot strip types).
    expect(packageJson.scripts?.build).toBe("tsc");
    expect(packageJson.scripts?.test).toBe("tsc && node --test");
    expect(packageJson.devDependencies?.typescript).toBeTruthy();
    // `@types/node` is required: the colocated index.test.ts imports node:test/node:assert.
    expect(packageJson.devDependencies?.["@types/node"]).toBeTruthy();
    expect(tsconfig.compilerOptions?.strict).toBe(true);
    expect(tsconfig.compilerOptions?.module).toBe("NodeNext");
    expect(tsconfig.compilerOptions?.types).toEqual(["node"]);
    // No `outDir`: tsc auto-excludes its outDir, so an in-package outDir would leave
    // the *.ts inputs unmatched (TS18003). The output lands beside the source.
    expect(tsconfig.compilerOptions?.outDir).toBeUndefined();
    expect(tsconfig.include).toEqual(["*.ts"]);
    // The sample test and entrypoint are TypeScript; the manifest still loads the
    // compiled ./index.js, and the compiled output is git-ignored.
    expect(scaffold["index.test.ts"]).toContain('import extension from "./index.js";');
    expect(scaffold["index.js"]).toBeUndefined();
    expect(JSON.parse(scaffold["manifest.json"] ?? "{}").entry).toBe("./index.js");
    expect(scaffold[".gitignore"]).toContain("/index.js");
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
    expect(readme).toContain("npx tsc");
  });
});
