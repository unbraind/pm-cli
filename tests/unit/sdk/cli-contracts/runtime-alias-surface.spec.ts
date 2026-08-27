import { describe, expect, it } from "vitest";
import { buildCommandAliasSurface } from "../../../../src/cli/commands/contracts.js";
import { PM_COMMAND_ALIAS_CONTRACTS } from "../../../../src/sdk/cli-contracts.js";

describe("runtime command alias surface defenses", () => {
  it("assigns the install alias only to the package install command", () => {
    const aliases = buildCommandAliasSurface([
      "package",
      "package install",
      "extension",
      "packages",
      "install",
    ]);

    expect(
      aliases.find((entry) => entry.canonical === "package")?.aliases,
    ).toEqual(["extension", "packages"]);
    expect(
      aliases.find((entry) => entry.canonical === "package install")?.aliases,
    ).toEqual(["install"]);
  });

  it("omits declarations whose canonical or Commander alias is absent", () => {
    const aliases = buildCommandAliasSurface(
      ["list", "list-all"],
      [
        ...PM_COMMAND_ALIAS_CONTRACTS,
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
      ],
    ).flatMap((entry) => entry.aliases);

    expect(aliases).not.toContain("missing-canonical-alias");
    expect(aliases).not.toContain("missing-commander-alias");
  });
});
