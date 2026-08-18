import { Command } from "commander";
import { describe, expect, it } from "vitest";

import {
  _testOnly,
  attachRichHelpText,
  firstExampleOrEmpty,
  resolveHelpNarrative,
} from "../../../src/cli/help-content.js";

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
});
