import { describe, expect, it } from "vitest";
import type { GlobalOptions } from "../../../../src/core/shared/command-types.js";
import { runContracts } from "../../../../src/cli/commands/contracts.js";
import {
  PM_COMMAND_ALIAS_CONTRACTS,
  type PmCommandAliasContract,
} from "../../../../src/sdk/cli-contracts.js";

const GLOBAL_OPTIONS: GlobalOptions = {
  json: true,
  quiet: false,
  profile: false,
  noExtensions: true,
};

describe("runtime command alias surface defenses", () => {
  it("omits declarations whose canonical or Commander alias is absent", async () => {
    const mutableAliases = PM_COMMAND_ALIAS_CONTRACTS as PmCommandAliasContract[];
    const originalLength = mutableAliases.length;
    mutableAliases.push(
      {
        alias: "missing-canonical-alias",
        canonical: "missing-canonical",
        canonical_argv: ["missing-canonical"],
        lifecycle: "permanent",
        hidden: false,
        registration: "commander",
        owner: "pm-0z7n",
      },
      {
        alias: "missing-commander-alias",
        canonical: "list",
        canonical_argv: ["list"],
        lifecycle: "permanent",
        hidden: false,
        registration: "commander",
        owner: "pm-0z7n",
      },
    );
    try {
      const result = await runContracts({ flagsOnly: true }, GLOBAL_OPTIONS);
      const aliases = result.command_aliases?.flatMap(
        (entry) => entry.aliases,
      );
      expect(aliases).not.toContain("missing-canonical-alias");
      expect(aliases).not.toContain("missing-commander-alias");
    } finally {
      mutableAliases.splice(originalLength);
    }
  });
});
