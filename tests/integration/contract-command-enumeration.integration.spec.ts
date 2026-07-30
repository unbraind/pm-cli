import { describe, expect, it } from "vitest";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

interface CommandFlagRow {
  /** Command spelling accepted by contract discovery. */
  command: string;
}

interface FlagsOnlyContracts {
  /** Complete resolvable command spelling set. */
  commands: string[];
  /** Per-command invocation metadata proving each spelling resolves. */
  command_flags: CommandFlagRow[];
}

function rootHelpCommandSpellings(help: string): string[] {
  const commandsBlock = help.split("\nCommands:\n")[1]?.split("\n\n")[0] ?? "";
  return commandsBlock
    .split("\n")
    .map((line) => line.trim().split(/\s{2,}/)[0] ?? "")
    .flatMap((syntax) =>
      (syntax.split(/[ <[]/)[0] ?? "")
        .split("|")
        .map((command) => command.trim()),
    )
    .filter(Boolean)
    .sort();
}

describe("contract command enumeration", () => {
  it("keeps the rendered core help set equal to the resolvable contract set", async () => {
    await withTempPmPath(async (context) => {
      const help = context.runCli(["--no-extensions", "--help"]).stdout;
      const contracts = context.runCli(
        ["--no-extensions", "contracts", "--flags-only", "--json"],
        { expectJson: true },
      ).json as FlagsOnlyContracts;
      const helpCommands = rootHelpCommandSpellings(help);
      const enumeratedRoots = [
        ...new Set(contracts.commands.map((command) => command.split(" ")[0]!)),
      ].sort();
      const resolvedRoots = [
        ...new Set(
          contracts.command_flags.map(
            ({ command }) => command.split(" ")[0]!,
          ),
        ),
      ].sort();

      expect(enumeratedRoots).toEqual(resolvedRoots);
      expect(helpCommands).toEqual(enumeratedRoots);
      for (const required of [
        "context",
        "search",
        "list-open",
        "list-in-progress",
      ]) {
        expect(enumeratedRoots).toContain(required);
      }
    });
  });
});
