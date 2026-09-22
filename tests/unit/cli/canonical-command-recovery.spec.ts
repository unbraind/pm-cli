import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { canonicalizeCommandSuggestions } from "../../../src/sdk/agent/command-suggestions.js";
import { buildUnknownCommandGuidanceFromRuntime } from "../../../src/cli/commander-usage.js";

describe("canonical unknown-command recovery", () => {
  it("deduplicates replacements, resolves deprecated group prefixes, and excludes unavailable targets", () => {
    expect(canonicalizeCommandSuggestions(["start-task", "claim --start", "extension doctor", "list-open", "custom"], ["claim", "package doctor", "custom"])).toEqual(["claim --start", "package doctor", "custom"]);
    expect(canonicalizeCommandSuggestions([], [])).toEqual([]);
    expect(canonicalizeCommandSuggestions(["start-task", "stats"], ["stats"], "start")).toEqual(["stats"]);
  });

  it("never repeats a refused nested command path in its suggestions", () => {
    const program = new Command().name("pm");
    program.command("ops").command("metrics");
    const guidance = buildUnknownCommandGuidanceFromRuntime("unknown command 'ops metrics'", program, new Map());
    expect(guidance?.unknownCommandExamples).not.toContain("pm ops metrics --help");
  });
  it("preserves lifecycle composition flags when replacing deprecated candidates", () => {
    const program = new Command().name("pm");
    program.command("claim");
    program.command("start-task");
    program.command("stats");
    const guidance = buildUnknownCommandGuidanceFromRuntime("unknown command 'start'", program, new Map());
    expect(guidance?.unknownCommandExamples).toEqual(["pm claim --start --help", "pm --help --all"]);
    expect(JSON.stringify(guidance)).not.toContain("start-task");
  });

  it("replaces deprecated list filters without dropping their arguments", () => {
    const program = new Command().name("pm");
    program.command("list");
    program.command("list-open");
    const guidance = buildUnknownCommandGuidanceFromRuntime("unknown command 'list-ope'", program, new Map());
    expect(guidance?.unknownCommandExamples).toContain("pm list --status open --help");
    expect(JSON.stringify(guidance)).not.toContain("list-open");
  });
  it.each(["meet", "event", "remind"])("names the package and canonical path for missing %s", (command) => {
    const program = new Command().name("pm");
    program.command("list");
    const guidance = buildUnknownCommandGuidanceFromRuntime(`unknown command '${command}'`, program, new Map());
    expect(guidance?.unknownCommandNextSteps).toHaveLength(1);
    expect(guidance?.unknownCommandNextSteps?.[0]).toContain("pm package install calendar --project");
    expect(guidance?.unknownCommandExamples).toContain(`pm calendar ${command} --help`);
    expect(JSON.stringify(guidance)).not.toContain("suggested command paths above");
  });

  it("does not refer to nonexistent suggestions for an unrelated missing command", () => {
    const program = new Command().name("pm");
    program.command("list");
    const guidance = buildUnknownCommandGuidanceFromRuntime("unknown command 'zzzzzzzzzz'", program, new Map());
    expect(JSON.stringify(guidance)).not.toContain("suggested command paths above");
  });

});
