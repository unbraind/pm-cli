/** @module tests/unit/cli/item-search-namespaces Shared command-path registration and parser compatibility. */
import { Command } from "commander";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { installCommandNamespaces } from "../../../src/cli/command-namespaces.js";
import { applyDynamicExtensionFlagOptions, buildExtensionCommandCollisionWarning, ensureCommandPath } from "../../../src/cli/extension-command-help.js";
import { _testOnly as help } from "../../../src/cli/help-json-payload.js";
import { _testOnly as cli } from "../../../src/cli/main.js";
import { SEARCH_EXTENSION_FLAG_DEFINITIONS } from "../../../packages/pm-search-advanced/extensions/search-advanced/runtime.ts";
import { normalizeBootstrapInvocation } from "../../../src/sdk/cli-bootstrap.js";
import { findPmNamespacedCommand, resolvePmCommandOperation } from "../../../src/sdk/cli-contracts/command-aliases.js";
import { activateExtensionForTest } from "../../../src/sdk/testing.js";
import searchPackage from "../../../packages/pm-search-advanced/extensions/search-advanced/index.ts";
import governancePackage from "../../../packages/pm-governance-audit/extensions/governance-audit/index.ts";
import { generateBashScript } from "../../../src/sdk/completion.js";
import { resolveFlagContractCommand } from "../../../scripts/release/docs-skills-gate.mjs";

describe("item and search namespace compatibility", () => {
  it("discovers installed completion contributors and refuses absent package help leaves", () => {
    expect(cli.buildRuntimeExtensionActivationScope({ commandPath: "completion bash" })).toBe("all");
    const program = new Command();
    const search = program.command("search");
    expect(help.resolveCommandFromPathTokens(program, ["search", "advanced"])).toBeNull();
    const advanced = ensureCommandPath(program, ["search", "advanced"]);
    expect(advanced?.parent).toBe(search);
    expect(help.resolveCommandFromPathTokens(program, ["search", "advanced"])).toBe(advanced);
  });
  it("resolves the longest SDK namespace prefix while preserving operand boundaries", () => {
    expect(findPmNamespacedCommand(["item", "duplicates", "merge", "--keep", "pm-a"])?.alias).toBe("dedupe-merge");
    expect(findPmNamespacedCommand(["item", "duplicates", "pm-a"])?.alias).toBe("duplicates");
    expect(findPmNamespacedCommand(["ctx", "next"])?.canonical).toBe("context next");
    for (const tokens of [[], ["item"], ["search", "--", "advanced"], ["unknown", "copy"], ["item", "--json", "copy"]]) {
      expect(findPmNamespacedCommand(tokens)).toBeUndefined();
    }
  });
  it("validates documentation flags against the deepest declared namespace", () => {
    const table = new Map(["item", "item duplicates", "item duplicates merge"].map((command) => [command, new Set<string>()]));
    expect(resolveFlagContractCommand("pm item duplicates merge --keep pm-a", table)).toBe("item duplicates merge");
    expect(resolveFlagContractCommand("pm item duplicates --limit 2", table)).toBe("item duplicates");
    expect(resolveFlagContractCommand("pm missing --limit 2", table)).toBeNull();
  });
  it("keeps omitted extension absence filters out of command options", async () => {
    const program = new Command();
    const search = program.command("search").enablePositionalOptions();
    const advanced = search.command("advanced").argument("<query...>").action(() => {});
    applyDynamicExtensionFlagOptions(advanced, [...SEARCH_EXTENSION_FLAG_DEFINITIONS]);
    await program.parseAsync(["search", "advanced", "namespace", "--mode", "keyword"], { from: "user" });
    expect(cli.extractCommandScopedOptions(advanced, advanced.args, [...SEARCH_EXTENSION_FLAG_DEFINITIONS])).toEqual({ mode: "keyword" });
    await program.parseAsync(["search", "advanced", "namespace", "--no-notes"], { from: "user" });
    expect(cli.extractCommandScopedOptions(advanced, advanced.args, [...SEARCH_EXTENSION_FLAG_DEFINITIONS])).toEqual({ noNotes: true });
  });
  it("completes nested command paths without mistaking arguments for operations", () => {
    const cases = [
      { words: ["pm", "item", ""], includes: "duplicates" },
      { words: ["pm", "item", "duplicates", ""], includes: "audit" },
      { words: ["pm", "item", "copy", "--"], includes: "--title" },
      { words: ["pm", "search", ""], includes: "advanced" },
      { words: ["pm", "--json", "item", "--pm-path", "audit", "duplicates", ""], includes: "merge" },
    ];
    const commands = cases.map(({ words }) => `COMP_WORDS=(${words.map((word) => `'${word}'`).join(" ")}); COMP_CWORD=${words.length - 1}; _pm_completion; printf '%s ' "\${COMPREPLY[@]}"; printf '\\n'`);
    const rows = execFileSync("bash", ["-s"], { input: `${generateBashScript([], [], false, { namespace_commands: ["search advanced", "item duplicates audit", "dedupe-merge"] })}\n${commands.join("\n")}`, encoding: "utf8" }).trim().split("\n");
    for (const [index, entry] of cases.entries()) expect(rows[index].split(/\s+/), entry.words.join(" ")).toContain(entry.includes);
  });
  it("omits inactive package facets from shell suggestions", () => {
    const input = `${generateBashScript()}\nCOMP_WORDS=(pm item duplicates ''); COMP_CWORD=3; _pm_completion; printf '%s\\n' "\${COMPREPLY[@]}"`;
    const suggestions = execFileSync("bash", ["-s"], { input, encoding: "utf8" }).trim().split(/\s+/);
    expect(suggestions).not.toContain("audit");
    expect(suggestions).not.toContain("merge");
    expect(suggestions).toContain("--limit");
  });
  it("preserves global flags after relocated and ordinary commands", async () => {
    const program = new Command().exitOverride().option("--json");
    program.command("copy").action(() => {});
    program.command("contracts").action(() => {});
    installCommandNamespaces(program);
    await program.parseAsync(["contracts", "--json"], { from: "user" });
    expect(program.opts()).toEqual({ json: true });
  });
  it.each([
    ["copy", "item copy"],
    ["merge", "workspace merge"],
    ["duplicates", "item duplicates"],
    ["dedupe-audit", "item duplicates audit"],
    ["dedupe-merge", "item duplicates merge"],
    ["comments-audit", "item audit-comments"],
    ["search-advanced", "search advanced"],
  ])("preserves %s as a discoverable compatibility mapping", (legacy, canonical) => {
    expect(resolvePmCommandOperation(canonical)).toBe(legacy);
    expect(normalizeBootstrapInvocation([legacy, "--help"]).argv).toEqual([...canonical.split(" "), "--help"]);
    expect(normalizeBootstrapInvocation(["help", legacy]).argv).toEqual(["help", ...canonical.split(" ")]);
  });

  it("moves complete core and legacy-package handlers through three-token paths", async () => {
    const program = new Command().exitOverride();
    const calls: string[] = [];
    const duplicates = program.command("duplicates").option("--limit <n>").action(() => { calls.push("find"); });
    const audit = program.command("dedupe-audit").option("--mode <value>").action((options: { mode: string }) => { calls.push(options.mode); });
    program.command("item");
    installCommandNamespaces(program);
    installCommandNamespaces(program);
    const item = program.commands.find((command) => command.name() === "item")!;
    expect(item.commands).toEqual([duplicates]);
    expect(duplicates.commands).toEqual([audit]);
    await program.parseAsync(["item", "duplicates", "audit", "--mode", "parent_scope"], { from: "user" });
    expect(calls).toEqual(["parent_scope"]);
  });

  it("keeps item copy addresses and literal search queries separate from command paths", () => {
    expect(normalizeBootstrapInvocation(["item", "copy", "--id", "pm-a"]).argv).toEqual(["item", "copy", "pm-a"]);
    expect(() => normalizeBootstrapInvocation(["copy", "pm-a", "--id", "pm-b"])).toThrow("not both");
    expect(normalizeBootstrapInvocation(["search", "--", "advanced", "mode=keyword"]).argv).toEqual(["search", "--", "advanced", "mode=keyword"]);
  });

  it("registers package facets under their canonical nouns with stable SDK actions", async () => {
    const search = await activateExtensionForTest(searchPackage);
    const governance = await activateExtensionForTest(governancePackage);
    expect(search.registrations.commands).toEqual(expect.arrayContaining([
      expect.objectContaining({ command: "search advanced", action: "search-advanced" }),
    ]));
    expect(governance.registrations.commands).toEqual(expect.arrayContaining([
      expect.objectContaining({ command: "item duplicates audit", action: "dedupe-audit" }),
      expect.objectContaining({ command: "item duplicates merge", action: "dedupe-merge" }),
      expect.objectContaining({ command: "item audit-comments", action: "comments-audit" }),
    ]));
  });

  it("allows only explicitly contracted package facets beneath core nouns", () => {
    const program = new Command();
    program.command("search");
    const descriptor = {
      command: "search advanced", action: "search-advanced", examples: [], failure_hints: [], arguments: [], flags: [],
      tier: "standard" as const, family: "extensions" as const,
    };
    expect(buildExtensionCommandCollisionWarning(program, "search advanced", new Map(), descriptor)).toBeNull();
    expect(buildExtensionCommandCollisionWarning(program, "search advanced", new Map(), { ...descriptor, action: "other" })).toContain("extension_command_collision");
    expect(buildExtensionCommandCollisionWarning(program, "search surprise", new Map(), descriptor)).toContain("extension_command_collision");
  });
});
