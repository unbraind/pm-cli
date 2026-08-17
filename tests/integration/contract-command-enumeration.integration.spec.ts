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

interface StructuredHelpPayload {
  /** Exact tokens requested by the caller, including accepted aliases. */
  requested_path: string[];
  /** Canonical path resolved by structured help. */
  resolved_path: string;
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
        [
          "--no-extensions",
          "contracts",
          "--flags-only",
          "--json",
          "--output-budget",
          "unbounded",
        ],
        { expectJson: true },
      ).json as FlagsOnlyContracts;
      const helpCommands = rootHelpCommandSpellings(help);
      const enumeratedRoots = [
        ...new Set(contracts.commands.map((command) => command.split(" ")[0]!)),
      ].sort();
      const resolvedRoots = [
        ...new Set(
          contracts.command_flags.map(({ command }) => command.split(" ")[0]!),
        ),
      ].sort();

      expect(enumeratedRoots).toEqual(resolvedRoots);
      expect(helpCommands).toEqual(enumeratedRoots);
      for (const required of ["context", "search", "list"]) {
        expect(enumeratedRoots).toContain(required);
      }
      for (const compatibilityAlias of [
        "list-all",
        "list-draft",
        "list-open",
        "list-in-progress",
        "list-blocked",
        "list-closed",
        "list-canceled",
      ]) {
        expect(enumeratedRoots).not.toContain(compatibilityAlias);
      }
    });
  });

  it("resolves structured help for every contract-enumerated command path", async () => {
    await withTempPmPath(async (context) => {
      const contracts = context.runCli(
        [
          "--no-extensions",
          "contracts",
          "--flags-only",
          "--json",
          "--output-budget",
          "unbounded",
        ],
        { expectJson: true },
      ).json as FlagsOnlyContracts;

      for (const command of contracts.commands) {
        const help = context.runCli(
          ["--no-extensions", "help", ...command.split(" "), "--json"],
          { expectJson: true },
        );
        expect(help.code, command).toBe(0);
        const payload = help.json as StructuredHelpPayload;
        expect(payload.requested_path).toEqual(command.split(" "));
        expect(payload.resolved_path.length).toBeGreaterThan(0);
      }
    });
  }, 120_000);
});
