import { describe, expect, it } from "vitest";
import { buildStarterExtensionScaffoldFiles } from "../../../src/cli/commands/extension/scaffold.js";

describe("extension scaffold define builder guidance", () => {
  it("documents the define* builder upgrade path for commands-only package scaffolds", () => {
    const scaffold = buildStarterExtensionScaffoldFiles("tool-kit", "tool kit ping", "package", "commands");
    const readme = scaffold["README.md"] ?? "";
    const entrypoint = scaffold["index.js"] ?? "";

    expect(readme).toContain("## Authoring With define* Builders");
    expect(readme).toContain('import { defineCommand } from "@unbrained/pm-cli/sdk";');
    expect(readme).not.toContain("defineAfterCommandHook");
    expect(readme).toContain("api.registerCommand(pingCommand);");
    expect(readme).toContain("export default { activate, deactivate };");
    expect(entrypoint).toContain('/** @param {import("@unbrained/pm-cli/sdk").ExtensionApi} api */');
    expect(entrypoint).not.toContain('from "@unbrained/pm-cli/sdk"');
  });

  it("documents the package define* builder upgrade path without adding runtime imports to the entrypoint", () => {
    const scaffold = buildStarterExtensionScaffoldFiles("context-kit", "context kit ping", "package", "hooks");
    const readme = scaffold["README.md"] ?? "";
    const entrypoint = scaffold["index.js"] ?? "";

    expect(readme).toContain("## Authoring With define* Builders");
    expect(readme).toContain('import { defineCommand, defineAfterCommandHook } from "@unbrained/pm-cli/sdk";');
    expect(readme).toContain("api.hooks.afterCommand(afterCommandHook);");
    expect(readme).toContain("export function deactivate() {}");
    expect(readme).toContain("The builders return their argument unchanged");
    expect(entrypoint).toContain('/** @param {import("@unbrained/pm-cli/sdk").ExtensionApi} api */');
    expect(entrypoint).not.toContain('from "@unbrained/pm-cli/sdk"');
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

  it("keeps standalone extension scaffolds dependency-light and import-free", () => {
    const scaffold = buildStarterExtensionScaffoldFiles("local-ext", "local ext ping", "extension", "commands");
    const readme = scaffold["README.md"] ?? "";
    const entrypoint = scaffold["index.js"] ?? "";

    expect(readme).not.toContain("## Authoring With define* Builders");
    expect(entrypoint).toContain('/** @param {import("@unbrained/pm-cli/sdk").ExtensionApi} api */');
    expect(entrypoint).not.toContain('from "@unbrained/pm-cli/sdk"');
  });
});
