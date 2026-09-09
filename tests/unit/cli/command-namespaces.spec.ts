import { execFileSync } from "node:child_process";
import { generateBashScript, generateFishScript, generateZshScript } from "../../../src/sdk/completion.js";
import { PM_CONTEXT_OPS_COMMAND_ALIASES, resolvePmCommandOperation } from "../../../src/sdk/cli-contracts/command-aliases.js";
import { resolveSubcommandFlagContractsForCommand } from "../../../src/sdk/cli-contracts/flag-contracts.js";
import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { installCommandNamespaces } from "../../../src/cli/command-namespaces.js";
import { normalizeBootstrapInvocation } from "../../../src/sdk/cli-bootstrap.js";
import { _testOnly as mainInternals } from "../../../src/cli/main.js";

describe("canonical navigation and operations namespaces", () => {
  it("moves existing handlers without copying their argument or option contracts", async () => {
    const program = new Command().exitOverride();
    const calls: string[] = [];
    const next = program.command("next").option("--limit <n>").action((options: { limit: string }) => {
      calls.push(options.limit);
    });
    program.command("context").action(() => { calls.push("context"); });
    installCommandNamespaces(program);
    expect(program.commands.map((command) => command.name())).toEqual(["context", "ops"]);
    expect(program.commands[0].commands[0]).toBe(next);
    await program.parseAsync(["context", "next", "--limit", "3"], { from: "user" });
    expect(calls).toEqual(["3"]);
  });

  it("creates a missing navigation parent and keeps unrelated operation registration selective", () => {
    const program = new Command();
    const next = program.command("next");
    installCommandNamespaces(program);
    expect(program.commands.find((command) => command.name() === "context")?.commands).toEqual([next]);
    expect(mainInternals.resolveCoreCommandRegistrationSelection(["claim", "pm-example"])).toEqual({
      setup: false, listQuery: false, mutation: false, operation: true, targetCommandName: "claim",
    });
    expect(normalizeBootstrapInvocation(["help", "--json"]).argv).toEqual(["help", "--json"]);
  });

  it.each([
    ["next", "context", "next"],
    ["focus", "context", "focus"],
    ["health", "ops", "health"],
    ["normalize", "ops", "normalize"],
    ["reindex", "ops", "reindex"],
    ["events", "history", "events"],
    ["update-many", "update", "many"],
    ["close-many", "close", "many"],
    ["delete", "close", "delete"],
  ])("retains the %s invocation through canonical argv", (legacy, noun, verb) => {
    expect(normalizeBootstrapInvocation(["help", legacy]).argv).toEqual(["help", noun, verb]);
    expect(normalizeBootstrapInvocation([legacy, "--help"]).argv).toEqual([noun, verb, "--help"]);
    expect(normalizeBootstrapInvocation(["--pm-path", legacy, legacy]).argv).toEqual(["--pm-path", legacy, noun, verb]);
  });
});


describe("namespace contracts and shell routing", () => {
  it("keeps lifecycle leaf verbs out of item addresses and normalizes their own flags", () => {
    for (const prefix of [["delete"], ["close", "delete"]]) {
      expect(normalizeBootstrapInvocation([...prefix, "--id", "pm-a", "--dry-run"]).argv).toEqual(["close", "delete", "pm-a", "--dry-run"]);
      expect(() => normalizeBootstrapInvocation([...prefix, "pm-a", "--id", "pm-b"])).toThrow("not both");
    }
    expect(normalizeBootstrapInvocation(["update", "--id", "pm-a", "--title", "Title"]).argv).toEqual(["update", "pm-a", "--title", "Title"]);
    expect(normalizeBootstrapInvocation(["close", "--id", "pm-a", "Done"]).argv).toEqual(["close", "pm-a", "Done"]);
    expect(normalizeBootstrapInvocation(["update", "many", "--filter_status", "open"]).argv).toEqual(["update", "many", "--filter-status", "open"]);
    expect(normalizeBootstrapInvocation(["close", "many", "--ids", "pm-a"]).argv).toEqual(["close", "many", "--ids", "pm-a"]);
  });

  it("preserves native and legacy SDK flag contracts", () => {
    for (const { alias, canonical } of PM_CONTEXT_OPS_COMMAND_ALIASES) {
      expect(resolvePmCommandOperation(canonical)).toBe(alias);
      expect(resolveSubcommandFlagContractsForCommand(canonical)).toEqual(resolveSubcommandFlagContractsForCommand(alias));
    }
    expect(resolvePmCommandOperation(" context unknown ")).toBe("context unknown");
  });

  it("installs package commands after activation, preserving nested verbs and detecting collisions", async () => {
    const program = new Command().exitOverride();
    const calls: string[] = [];
    const telemetry = program.command("telemetry");
    telemetry.command("status").action(() => { calls.push("status"); });
    installCommandNamespaces(program);
    installCommandNamespaces(program);
    await program.parseAsync(["ops", "telemetry", "status"], { from: "user" });
    expect(calls).toEqual(["status"]);
    program.command("normalize").option("--dry-run");
    installCommandNamespaces(program);
    expect(program.commands[0].commands.map((command) => command.name())).toEqual(["telemetry", "normalize"]);
    program.command("normalize");
    expect(() => installCommandNamespaces(program)).toThrow("destination already exists");
  });

  it("executes Bash completion through namespace and global-option positions", () => {
    const pairs = [
      ["context", "next", "--ready-only"], ["context", "focus", "--clear"],
      ["ops", "stats", "--storage"], ["ops", "health", "--check-only"],
      ["ops", "validate", "--check-history-drift"], ["ops", "gc", "--dry-run"],
      ["ops", "test-all", "--timeout"], ["ops", "reindex", "--mode"],
      ["history", "events", "--since"],
    ];
    const cases = pairs.flatMap(([noun, verb, flag]) => [
      { words: ["pm", noun, verb, "--"], flag },
      { words: ["pm", verb, "--"], flag },
      { words: ["pm", "--pm-path", verb, noun, "--json", verb, "--"], flag },
    ]);
    cases.push(
      { words: ["pm", "update", "many", "--"], flag: "--filter-status" },
      { words: ["pm", "close", "many", "--"], flag: "--reason" },
      { words: ["pm", "--json", "close", "delete", "--"], flag: "--dry-run" },
      { words: ["pm", "claim", "--"], flag: "--start" },
      { words: ["pm", "release", "--"], flag: "--pause" },
      { words: ["pm", "close", "pm-example", "--"], flag: "--release-assignment" },
      { words: ["pm", "update", "m"], flag: "many" },
      { words: ["pm", "close", "d"], flag: "delete" },
    );
    const commands = cases.map(({ words }) => `COMP_WORDS=(${words.map((word) => `'${word}'`).join(" ")}); COMP_CWORD=${words.length - 1}; _pm_completion; printf '%s ' "\${COMPREPLY[@]}"; printf '\\n'`);
    const stdout = execFileSync("bash", ["-s"], { input: `${generateBashScript()}\n${commands.join("\n")}`, encoding: "utf8" });
    const rows = stdout.split("\n");
    expect(rows.pop()).toBe("");
    expect(rows).toHaveLength(cases.length);
    for (const [index, entry] of cases.entries()) expect(rows[index].trim().split(/\s+/), entry.words.join(" ")).toContain(entry.flag);
    for (const script of [generateZshScript(), generateFishScript()]) {
      for (const { canonical } of PM_CONTEXT_OPS_COMMAND_ALIASES) expect(script).toContain(canonical);
    }
  });
});
