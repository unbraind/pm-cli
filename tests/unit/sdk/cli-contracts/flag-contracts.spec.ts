import { describe, expect, it } from "vitest";
import { resolveSubcommandFlagContractsForCommand } from "../../../../src/sdk/cli-contracts/flag-contracts.js";
import { _testOnly as bootstrapTestOnly } from "../../../../src/sdk/cli-bootstrap.js";

describe("CLI flag contract resolution", () => {
  it("collapses underscore spellings into one canonical row with an alias", () => {
    const assigneeFilterContracts = resolveSubcommandFlagContractsForCommand(
      "context",
    ).filter(
      ({ flag, aliases }) =>
        flag === "--assignee-filter" ||
        aliases?.includes("--assignee_filter") === true,
    );

    expect(assigneeFilterContracts).toEqual([
      expect.objectContaining({
        flag: "--assignee-filter",
        aliases: expect.arrayContaining(["--assignee_filter"]),
      }),
    ]);

    const lookup = bootstrapTestOnly.buildFlagLookup("context", [
      { flag: "--assignee_filter" },
      { flag: "--assignee-filter" },
    ]);
    expect(lookup.canonicalComparables).toEqual([
      {
        canonicalFlag: "--assignee-filter",
        comparable: "assigneefilter",
      },
    ]);

    expect(
      resolveSubcommandFlagContractsForCommand("comments").find(
        ({ flag }) => flag === "--author",
      ),
    ).not.toHaveProperty("aliases");
  });
});
