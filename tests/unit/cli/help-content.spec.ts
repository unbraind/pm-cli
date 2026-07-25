import { describe, expect, it } from "vitest";

import {
  _testOnly,
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
});
