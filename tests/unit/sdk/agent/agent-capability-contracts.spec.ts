import { describe, expect, it } from "vitest";

import {
  PM_COMMAND_CAPABILITY_CONTRACTS,
  PM_CORE_HELP_BUDGET,
  listPmCommandCapabilityGroups,
  listPmCommandsForTierFromContracts,
  listPmMcpToolsForProfileFromContracts,
  measurePmCoreHelp,
  renderPmCapabilityRoutingMarkdown,
  renderPmCommandVisibilityMarkdownFromContracts,
} from "../../../../src/sdk/agent-capability-contracts.js";

describe("agent capability contracts", () => {
  it("projects stable capability groups and generated routing documentation", () => {
    const groups = listPmCommandCapabilityGroups();
    expect(
      groups.find(({ family }) => family === "lifecycle")?.commands,
    ).toContain("claim");
    expect(
      groups.find(({ family }) => family === "extensions")?.commands,
    ).toContain("package");
    expect(
      groups.find(({ family }) => family === "extensions")?.commands,
    ).not.toContain("packages");
    expect(
      groups.find(({ family }) => family === "context")?.commands,
    ).toContain("context");
    expect(
      groups.find(({ family }) => family === "context")?.commands,
    ).not.toContain("ctx");
    const routing = renderPmCapabilityRoutingMarkdown();
    expect(routing).toContain("| lifecycle |");
    expect(routing).toContain("`claim`");
  });

  it("one tier-field edit changes CLI, MCP, completion, and docs projections", () => {
    const edited = PM_COMMAND_CAPABILITY_CONTRACTS.map((entry) =>
      entry.command === "context"
        ? { ...entry, tier: "internal" as const }
        : entry,
    );

    expect(listPmCommandsForTierFromContracts("core", edited)).not.toContain(
      "context",
    );
    expect(listPmCommandsForTierFromContracts("full", edited)).not.toContain(
      "context",
    );
    expect(
      listPmMcpToolsForProfileFromContracts(
        ["pm_context", "pm_create"],
        "core",
        edited,
      ),
    ).toEqual(["pm_create"]);
    expect(renderPmCommandVisibilityMarkdownFromContracts(edited)).toContain(
      "| `context` | internal | context |",
    );
  });

  it("measures the compact core help against a one-screen budget", () => {
    const text = Array.from(
      { length: PM_CORE_HELP_BUDGET.max_lines },
      () => "help",
    ).join("\n");
    expect(measurePmCoreHelp(text)).toMatchObject({ within_budget: true });
    expect(measurePmCoreHelp(`${text}\noverflow`).within_budget).toBe(false);
    expect(measurePmCoreHelp("")).toEqual({
      lines: 0,
      utf8_bytes: 0,
      within_budget: true,
    });
    expect(
      measurePmCoreHelp("x".repeat(PM_CORE_HELP_BUDGET.max_utf8_bytes + 1)),
    ).toMatchObject({
      lines: 1,
      within_budget: false,
    });
  });
});
