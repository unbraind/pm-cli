import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { canonicalizeCommandSuggestions, resolveMisnestedCommandPath } from "../../../src/sdk/agent/command-suggestions.js";
import { buildUnknownCommandGuidanceFromRuntime } from "../../../src/cli/commander-usage.js";

describe("canonical unknown-command recovery", () => {
  it("resolves only an unambiguous installed suffix under a known namespace", () => {
    const paths = ["item", "item test", "test", "update", "workspace", "workspace config"];
    expect(resolveMisnestedCommandPath("item update", paths)).toBe("update");
    expect(resolveMisnestedCommandPath("item config", paths)).toBe("workspace config");
    expect(resolveMisnestedCommandPath("workspace tests", paths)).toBe("item test");
    expect(resolveMisnestedCommandPath("workspace config update", paths)).toBe("update");
    expect(resolveMisnestedCommandPath("workspace config update", [...paths, "config update"])).toBe("config update");
    expect(resolveMisnestedCommandPath("workspace config update", [...paths, "config update", "extension config update"])).toBeUndefined();
    expect(resolveMisnestedCommandPath("workspace missing update", paths)).toBeUndefined();
    for (const unknown of ["update", "missing update", "item unavailable", "item test", ""]) {
      expect(resolveMisnestedCommandPath(unknown, paths)).toBeUndefined();
    }
    expect(resolveMisnestedCommandPath("item update", [...paths, "extension update"])).toBeUndefined();
    expect(resolveMisnestedCommandPath("item update", ["item"])).toBeUndefined();
  });

  it("prioritizes canonical help for a misnested command without authorizing execution", () => {
    const program = new Command().name("pm");
    program.command("item").command("comments");
    program.command("update");
    const guidance = buildUnknownCommandGuidanceFromRuntime("unknown command 'item update'", program, new Map());
    expect(guidance?.unknownCommandExamples?.[0]).toBe("pm update --help");
    expect(guidance?.suggestedRetryCommand).toBe("pm update --help");
    expect(guidance?.suggestedRetryArgs).toEqual(["update", "--help"]);
  });

  it("keeps explicit extension suppression in both canonical retry fields and the first example", () => {
    const program = new Command().name("pm");
    program.command("item");
    program.command("update");
    const guidance = buildUnknownCommandGuidanceFromRuntime("unknown command 'item update'", program, new Map(), ["--no-extensions", "item", "update"]);
    expect(guidance?.suggestedRetryArgs).toEqual(["--no-extensions", "update", "--help"]);
    expect(guidance?.suggestedRetryCommand).toBe("pm --no-extensions update --help");
    expect(guidance?.unknownCommandExamples?.[0]).toBe(guidance?.suggestedRetryCommand);
  });

  it("retains every registered namespace before a refused leaf while excluding flag values and trailing operands", () => {
    const program = new Command().name("pm");
    program.command("workspace").command("config");
    program.command("config").command("update");
    const guidance = buildUnknownCommandGuidanceFromRuntime("unknown command 'update'", program, new Map(), [
      "--author", "update", "--no-extensions", "workspace", "--json", "config", "update", "operand", "--title", "update",
    ]);
    expect(guidance?.suggestedRetryArgs).toEqual(["--no-extensions", "config", "update", "--help"]);
    expect(guidance?.unknownCommandExamples?.[0]).toBe("pm --no-extensions config update --help");
    const rootOnly = new Command().name("pm");
    rootOnly.command("workspace").command("config");
    rootOnly.command("update");
    expect(buildUnknownCommandGuidanceFromRuntime("unknown command 'update'", rootOnly, new Map(), ["workspace", "config", "update"])?.suggestedRetryArgs).toEqual(["update", "--help"]);
    for (const argv of [[], ["--"], ["workspace", "config"], ["missing", "config", "update"], ["workspace", "operand", "update"], ["workspace", "--", "config", "update"]]) {
      expect(buildUnknownCommandGuidanceFromRuntime("unknown command 'update'", program, new Map(), argv)?.suggestedRetryArgs).toBeUndefined();
    }
  });

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
