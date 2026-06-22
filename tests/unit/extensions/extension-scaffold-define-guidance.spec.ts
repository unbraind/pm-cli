import { describe, expect, it } from "vitest";
import { buildStarterExtensionScaffoldFiles } from "../../../src/cli/commands/extension/scaffold.js";

describe("extension scaffold define builder guidance", () => {
  it("documents the define* builder upgrade path for commands-only package scaffolds", () => {
    const scaffold = buildStarterExtensionScaffoldFiles("tool-kit", "tool kit ping", "package", "commands");
    const readme = scaffold["README.md"] ?? "";
    const entrypoint = scaffold["index.js"] ?? "";

    expect(readme).toContain("## Authoring With define* Builders");
    expect(readme).toContain('import { defineCommand, defineAfterCommandHook } from "@unbrained/pm-cli/sdk";');
    expect(readme).toContain("Only add this when your package declares and registers hooks.");
    expect(entrypoint).toContain('/** @param {import("@unbrained/pm-cli/sdk").ExtensionApi} api */');
    expect(entrypoint).not.toContain('from "@unbrained/pm-cli/sdk"');
  });

  it("documents the package define* builder upgrade path without adding runtime imports to the entrypoint", () => {
    const scaffold = buildStarterExtensionScaffoldFiles("context-kit", "context kit ping", "package", "hooks");
    const readme = scaffold["README.md"] ?? "";
    const entrypoint = scaffold["index.js"] ?? "";

    expect(readme).toContain("## Authoring With define* Builders");
    expect(readme).toContain('import { defineCommand, defineAfterCommandHook } from "@unbrained/pm-cli/sdk";');
    expect(readme).toContain("Only add this when your package declares and registers hooks.");
    expect(readme).toContain("The builders return their argument unchanged");
    expect(entrypoint).toContain('/** @param {import("@unbrained/pm-cli/sdk").ExtensionApi} api */');
    expect(entrypoint).not.toContain('from "@unbrained/pm-cli/sdk"');
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
