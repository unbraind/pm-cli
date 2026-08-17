import { describe, expect, it } from "vitest";
import {
  PM_CLI_GRAMMAR_CONTRACT,
  PM_CLI_GRAMMAR_NOUNS,
  PM_COMMAND_DESTINATION_CONTRACTS,
  verifyPmCliGrammar,
} from "../../../../src/sdk/cli-contracts/grammar-contracts.js";
import {
  PM_COMMAND_ALIAS_CONTRACTS,
  renderPmCommandAliasMigrationHint,
  resolvePmCommandAlias,
} from "../../../../src/sdk/cli-contracts.js";

describe("CLI noun-verb grammar contracts", () => {
  it("maps every checked-in command exactly once and keeps alias targets live", () => {
    const commands = PM_COMMAND_DESTINATION_CONTRACTS.map(
      (destination) => destination.command,
    );
    const report = verifyPmCliGrammar(commands, PM_COMMAND_ALIAS_CONTRACTS);

    expect(report).toMatchObject({
      ok: true,
      command_count: commands.length,
      destination_count: commands.length,
      hidden_alias_count: 7,
      visible_top_level_ceiling:
        PM_CLI_GRAMMAR_CONTRACT.visible_top_level_ceiling,
    });
    expect(new Set(PM_CLI_GRAMMAR_NOUNS).size).toBe(12);
  });

  it("fails upward for missing and stale census rows", () => {
    const liveCommands = PM_COMMAND_DESTINATION_CONTRACTS.map(
      (destination) => destination.command,
    );
    const missing = verifyPmCliGrammar(
      [...liveCommands, "rogue-command"],
      PM_COMMAND_ALIAS_CONTRACTS,
    );
    expect(missing.findings).toContainEqual(
      expect.objectContaining({
        code: "missing_destination",
        spelling: "rogue-command",
        nearest_target: "ops rogue-command",
      }),
    );
    const knownNounDestination = verifyPmCliGrammar(
      [...liveCommands, "item rogue"],
      PM_COMMAND_ALIAS_CONTRACTS,
    );
    expect(knownNounDestination.findings).toContainEqual(
      expect.objectContaining({
        code: "missing_destination",
        spelling: "item rogue",
        nearest_target: "item",
      }),
    );

    const stale = verifyPmCliGrammar(
      liveCommands.filter((command) => command !== "list"),
      PM_COMMAND_ALIAS_CONTRACTS,
    );
    expect(stale.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "stale_destination", spelling: "list" }),
        expect.objectContaining({ code: "alias_target_missing", spelling: "list-all" }),
      ]),
    );
  });

  it("detects duplicate destinations and nouns outside the grammar", () => {
    const mutableDestinations = PM_COMMAND_DESTINATION_CONTRACTS as Array<
      (typeof PM_COMMAND_DESTINATION_CONTRACTS)[number]
    >;
    const originalLength = mutableDestinations.length;
    mutableDestinations.push({
      command: "list",
      noun: "unregistered-noun" as never,
      target: "list",
      disposition: "keep_as_is",
      owner: "pm-wt43zj",
    });
    try {
      const report = verifyPmCliGrammar(
        PM_COMMAND_DESTINATION_CONTRACTS.map(
          (destination) => destination.command,
        ),
      );
      expect(report.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "duplicate_destination",
            spelling: "list",
          }),
          expect.objectContaining({
            code: "unknown_noun",
            spelling: "list",
          }),
        ]),
      );
    } finally {
      mutableDestinations.splice(originalLength);
    }
  });

  it("resolves deprecated list aliases with stable canonical hints", () => {
    const alias = resolvePmCommandAlias(" LIST-OPEN ");
    expect(alias).toMatchObject({
      canonical: "list",
      canonical_argv: ["list", "--status", "open"],
      lifecycle: "deprecated",
      hidden: true,
      owner: "pm-pfqi",
    });
    expect(renderPmCommandAliasMigrationHint(alias!)).toBe(
      "Deprecated command `list-open`; use `pm list --status open`.",
    );
    expect(resolvePmCommandAlias("unknown")).toBeUndefined();
  });

  it("fails when visible top-level growth exceeds the committed ceiling", () => {
    const liveCommands = PM_COMMAND_DESTINATION_CONTRACTS.map(
      (destination) => destination.command,
    );
    const overflow = Array.from(
      { length: PM_CLI_GRAMMAR_CONTRACT.visible_top_level_ceiling + 1 },
      (_value, index) => `new-${index}`,
    );
    const report = verifyPmCliGrammar([...liveCommands, ...overflow]);
    expect(report.findings).toContainEqual(
      expect.objectContaining({ code: "visible_surface_ceiling_exceeded" }),
    );
  });
});
