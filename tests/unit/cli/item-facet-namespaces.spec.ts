/** @module tests/unit/cli/item-facet-namespaces Preserves facet payloads and hides nested runtime plumbing. */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { generateBashScript } from "../../../src/sdk/completion.js";
import { normalizeBootstrapInvocation } from "../../../src/sdk/cli-bootstrap.js";
import { resolvePmCommandOperation } from "../../../src/sdk/cli-contracts/command-aliases.js";
import { resolveSubcommandFlagContractsForCommand } from "../../../src/sdk/cli-contracts/flag-contracts.js";
import { resolvePmFlagSemanticConcept } from "../../../src/sdk/cli-contracts/flag-lexicon-contracts.js";
import { resolvePmCommandVisibilityTier } from "../../../src/sdk/agent-capability-contracts.js";
import { PM_COMMAND_DESTINATION_CONTRACTS, PM_COMMAND_POSITIONAL_CONTRACTS } from "../../../src/sdk/cli-contracts/grammar-contracts.js";

describe("item facet namespace contracts", () => {
  it.each(["discover", "lookup"])("preserves nested files %s contracts", (action) => {
    const canonical = `item files ${action}`;
    const legacy = `files ${action}`;
    expect(resolvePmCommandOperation(canonical)).toBe(legacy);
    expect(PM_COMMAND_DESTINATION_CONTRACTS.some(({ command }) => command === canonical)).toBe(true);
    expect(PM_COMMAND_POSITIONAL_CONTRACTS.find(({ command }) => command === canonical)?.slots).toEqual(PM_COMMAND_POSITIONAL_CONTRACTS.find(({ command }) => command === legacy)?.slots);
  });

  it("completes evidence flags and omits internal workers beneath the test facet", () => {
    const cases = [
      { words: ["pm", ""], includes: "item", excludes: "test-runs-worker" },
      { words: ["pm", "item", ""], includes: "comments", excludes: "worker" },
      { words: ["pm", "item", "comments", "--"], includes: "--text", excludes: "worker" },
      { words: ["pm", "item", "test", ""], includes: "--run", excludes: "worker" },
      { words: ["pm", "completion", ""], includes: "bash", excludes: "statuses" },
    ];
    const commands = cases.map(({ words }) => `COMP_WORDS=(${words.map((word) => `'${word}'`).join(" ")}); COMP_CWORD=${words.length - 1}; _pm_completion; printf '%s ' "\${COMPREPLY[@]}"; printf '\\n'`);
    const rows = execFileSync("bash", ["-s"], { input: `${generateBashScript()}\n${commands.join("\n")}`, encoding: "utf8" }).trim().split("\n");
    for (const [index, entry] of cases.entries()) {
      const suggestions = rows[index].split(/\s+/);
      expect(suggestions, entry.words.join(" ")).toContain(entry.includes);
      expect(suggestions).not.toContain(entry.excludes);
    }
  });

  it.each(["comments", "notes", "learnings", "files", "docs", "deps", "append", "test"])("preserves %s flags and addressing", (facet) => {
    const canonical = `item ${facet}`;
    expect(resolvePmCommandOperation(canonical)).toBe(facet);
    expect(resolveSubcommandFlagContractsForCommand(canonical)).toEqual(resolveSubcommandFlagContractsForCommand(facet));
    expect(resolvePmFlagSemanticConcept(canonical, "--file")).toBe(resolvePmFlagSemanticConcept(facet, "--file"));
    expect(normalizeBootstrapInvocation([facet, "--id", "pm-a"]).argv).toEqual(["item", facet, "pm-a"]);
    expect(normalizeBootstrapInvocation(["help", facet]).argv).toEqual(["help", "item", facet]);
  });

  it("normalizes ergonomic aliases directly to the canonical leaf", () => {
    for (const [alias, facet] of [["comment", "comments"], ["note", "notes"], ["learning", "learnings"], ["tests", "test"]]) {
      expect(normalizeBootstrapInvocation([alias, "pm-a"]).argv).toEqual(["item", facet, "pm-a"]);
    }
  });

  it("keeps linked-test environment assignments literal and combines structured entries", () => {
    const command = "PM_PATH=/tmp/example node test.mjs";
    for (const prefix of [["test"], ["item", "test"]]) {
      expect(normalizeBootstrapInvocation([...prefix, "pm-a", "--add", "command", command]).argv).toEqual(["item", "test", "pm-a", "--add", `command=${command}`]);
    }
  });

  it.each([
    ["test-runs-worker", "item test worker"],
    ["completion-statuses", "completion statuses"],
    ["completion-tags", "completion tags"],
    ["completion-types", "completion types"],
  ])("keeps %s executable and internal", (alias, canonical) => {
    expect(normalizeBootstrapInvocation([alias, "--help"]).argv).toEqual([...canonical.split(" "), "--help"]);
    expect(resolvePmCommandVisibilityTier(canonical)).toBe("internal");
    expect(resolveSubcommandFlagContractsForCommand(canonical)).toEqual(resolveSubcommandFlagContractsForCommand(undefined));
  });
});
