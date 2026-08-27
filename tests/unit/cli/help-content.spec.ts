import { Command } from "commander";
import { describe, expect, it } from "vitest";

import {
  _testOnly,
  attachRichHelpText,
  firstExampleOrEmpty,
  getPmCommandHelpVisibilityTier,
  resolveHelpNarrative,
  setPmCommandHelpVisibilityTier,
} from "../../../src/cli/help-content.js";
import {
  measurePmCoreHelp,
  PM_CORE_HELP_BUDGET,
} from "../../../src/sdk/agent-capability-contracts.js";

describe("help-content.firstExampleOrEmpty", () => {
  it("returns only the first example when examples are present", () => {
    expect(firstExampleOrEmpty(["one", "two", "three"])).toEqual(["one"]);
  });

  it("returns an empty list when no examples exist", () => {
    expect(firstExampleOrEmpty([])).toEqual([]);
  });
});

describe("help-content rendering helpers", () => {
  it("renders compact bundles without examples and detailed bundles without tips", () => {
    expect(
      _testOnly.renderCompactHelpBundle({
        why: "Short rationale",
        examples: [],
      }),
    ).not.toContain("Example:");

    expect(
      _testOnly.renderDetailedHelpBundle({
        why: "Detailed rationale",
        examples: ["pm list --help"],
      }),
    ).not.toContain("Tips:");
  });

  it("keeps agent-facing examples free of redundant identity flags", () => {
    const commands = [
      "create",
      "list",
      "list-in-progress",
      "calendar",
      "context",
      "next",
      "history-compact",
      "activity",
      "restore",
      "close",
      "delete",
      "comments",
      "claim",
      "release",
      "start-task",
      "pause-task",
      "close-task",
    ];
    const examples = commands.flatMap(
      (command) => resolveHelpNarrative(command, "detailed").examples,
    );
    expect(examples.filter((example) => example.includes("--author"))).toEqual([
      expect.stringContaining("Explicit non-agent identity override"),
    ]);
    expect(examples.some((example) => example.includes("--assignee"))).toBe(
      false,
    );
    expect(examples.some((example) => example.includes("author="))).toBe(false);
  });

  it("attaches action-specific and parent positional help bundles", () => {
    const actionProgram = new Command("pm");
    const actionPlan = actionProgram.command("plan");
    attachRichHelpText(actionProgram, [
      "plan",
      "create",
      "--help",
      "--explain",
    ]);
    let actionHelp = "";
    actionPlan.configureOutput({ writeOut: (text) => (actionHelp += text) });
    actionPlan.outputHelp();
    expect(actionHelp).toContain("Action path: pm plan create");
    expect(actionHelp).toContain("Applicable flags: --acceptance-criteria");
    expect(actionHelp).toContain("pm plan create --title");

    const actionWithOperandProgram = new Command("pm");
    const actionWithOperandPlan = actionWithOperandProgram.command("plan");
    attachRichHelpText(actionWithOperandProgram, [
      "plan",
      "add-step",
      "pm-a1b2",
      "--help",
      "--explain",
    ]);
    let actionWithOperandHelp = "";
    actionWithOperandPlan.configureOutput({
      writeOut: (text) => (actionWithOperandHelp += text),
    });
    actionWithOperandPlan.outputHelp();
    expect(actionWithOperandHelp).toContain("Action path: pm plan add-step");
    expect(actionWithOperandHelp).toContain(
      "Applicable flags: --allow-multiple-active",
    );

    const parentProgram = new Command("pm");
    const parentPlan = parentProgram.command("plan");
    attachRichHelpText(parentProgram, ["plan", "--help"]);
    let parentHelp = "";
    parentPlan.configureOutput({ writeOut: (text) => (parentHelp += text) });
    parentPlan.outputHelp();
    expect(parentHelp).toContain("Dispatches one declared positional action");

    const flaglessProgram = new Command("pm");
    const assurance = flaglessProgram.command("assurance");
    attachRichHelpText(flaglessProgram, [
      "assurance",
      "list",
      "--help",
      "--explain",
    ]);
    let flaglessHelp = "";
    assurance.configureOutput({ writeOut: (text) => (flaglessHelp += text) });
    assurance.outputHelp();
    expect(flaglessHelp).toContain("Applicable flags: none.");
  });

  it("keeps root help to the core contract while preserving nested help", () => {
    const program = new Command("pm");
    program.description("Project management");
    program.command("context").description("Orient to current work");
    const graph = program
      .command("graph")
      .description("Inspect relationships")
      .option("--scope <value>", "Graph scope");
    graph.command("validate").description("Validate the graph");
    program.command("health").description("Run health checks");
    const extensionCore = program
      .command("extension-core")
      .description("A package-declared core command");
    setPmCommandHelpVisibilityTier(extensionCore, "core");
    expect(getPmCommandHelpVisibilityTier(extensionCore)).toBe("core");
    for (let index = 0; index < PM_CORE_HELP_BUDGET.max_lines; index += 1) {
      const dynamic = program
        .command(`dynamic-core-${index}`)
        .description(`Dynamic core ${index} ${"description ".repeat(80)}`);
      setPmCommandHelpVisibilityTier(dynamic, "core");
    }
    attachRichHelpText(program, ["--help"]);

    let rootHelp = "";
    program.configureOutput({ writeOut: (text) => (rootHelp += text) });
    program.outputHelp();
    expect(rootHelp).toContain("context");
    expect(rootHelp).not.toContain("health");
    expect(rootHelp).not.toContain("graph");
    expect(rootHelp).toContain("extension-core");
    expect(rootHelp).not.toContain("dynamic-core-49");
    expect(measurePmCoreHelp(rootHelp)).toMatchObject({ within_budget: true });

    let graphHelp = "";
    graph.configureOutput({ writeOut: (text) => (graphHelp += text) });
    graph.outputHelp();
    expect(graphHelp).toContain("validate");

    const configuredHelp = program.configureHelp();
    expect(
      configuredHelp.visibleCommands?.(graph).map((command) => command.name()),
    ).toContain("validate");
    expect(
      configuredHelp.visibleOptions?.(graph).map((option) => option.long),
    ).toContain("--scope");
  });

  it("reveals every non-internal command and alias lifecycle in full help", () => {
    const program = new Command("pm");
    program.command("context").description("Orient to current work");
    program.command("health").description("Run health checks");
    const graph = program.command("graph").description("Inspect relationships");
    graph.command("validate").description("Validate relationships");
    const internalChild = graph
      .command("internal-index")
      .description("Internal graph index operation");
    setPmCommandHelpVisibilityTier(internalChild, "internal");

    attachRichHelpText(program, ["help", "--all"]);

    let fullHelp = "";
    program.configureOutput({ writeOut: (text) => (fullHelp += text) });
    program.outputHelp();
    expect(fullHelp).toContain("context");
    expect(fullHelp).toContain("health");
    expect(fullHelp).toContain("graph");
    expect(fullHelp).toContain("Deprecated aliases:");
    expect(fullHelp).toContain("list-open -> pm list --status open");
    expect(
      program
        .configureHelp()
        .visibleCommands?.(graph)
        .map((command) => command.name()),
    ).toEqual(["validate", "help"]);
  });
});
