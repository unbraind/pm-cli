import { describe, expect, it } from "vitest";
import {
  PM_COMMAND_EXIT_CONTRACTS,
  PM_COMMAND_EXIT_OUTCOME_CONTRACTS,
  analyzePmCommandExitConformance,
  derivePmBulkMutationEffect,
  isPmKnownExitCode,
  isPmSuccessfulExitCode,
  resolvePmCommandExitContract,
  type PmCommandExitObservation,
} from "../../../src/sdk/cli-contracts/command-exit-contracts.js";
import { PM_CORE_COMMAND_NAMES } from "../../../src/sdk/cli-contracts/enum-contracts.js";
import { _testOnlyContractsCommand } from "../../../src/sdk/cli-contracts/runtime-contracts.js";

describe("command exit contracts", () => {
  it("declares every core command and effect-aware bulk exits", () => {
    expect(PM_COMMAND_EXIT_CONTRACTS.map((entry) => entry.command)).toEqual([
      ...PM_CORE_COMMAND_NAMES,
    ]);
    expect(resolvePmCommandExitContract("update-many")?.exit_codes).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7,
    ]);
    expect(
      resolvePmCommandExitContract("close-many nested")?.exit_codes,
    ).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(resolvePmCommandExitContract("not-a-command")).toBeUndefined();
    expect(resolvePmCommandExitContract("")).toBeUndefined();
    expect(
      _testOnlyContractsCommand.buildCommandExitContractGroups(["acme custom"]),
    ).toEqual([
      {
        commands: ["acme custom"],
        exit_codes: [0, 1, 2, 3, 4, 5],
      },
    ]);
  });

  it("keeps success and known-exit predicates aligned with the vocabulary", () => {
    expect(
      PM_COMMAND_EXIT_OUTCOME_CONTRACTS.map((entry) => entry.exit_code),
    ).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect([0, 6, 7].every(isPmSuccessfulExitCode)).toBe(true);
    expect([1, 2, 3, 4, 5, 8].some(isPmSuccessfulExitCode)).toBe(false);
    expect([0, 1, 2, 3, 4, 5, 6, 7].every(isPmKnownExitCode)).toBe(true);
    expect(isPmKnownExitCode(8)).toBe(false);
  });

  it("derives full, empty, and partial bulk effects from operation counts", () => {
    expect(
      derivePmBulkMutationEffect({
        applied: 1,
        skipped: 0,
        failed: 0,
        unmatched: 0,
      }),
    ).toEqual({ outcome: "effect", exit_code: 0 });
    expect(
      derivePmBulkMutationEffect({
        applied: 0,
        skipped: 1,
        failed: 0,
        unmatched: 0,
      }),
    ).toEqual({ outcome: "no_effect", exit_code: 6 });
    expect(
      derivePmBulkMutationEffect({
        applied: 0,
        skipped: 0,
        failed: 1,
        unmatched: 0,
      }),
    ).toEqual({ outcome: "dependency_failed", exit_code: 5 });
    expect(
      derivePmBulkMutationEffect({
        applied: 1,
        skipped: 1,
        failed: 1,
        unmatched: 1,
      }),
    ).toEqual({ outcome: "partial_effect", exit_code: 7 });
  });

  it("accepts a complete replay and rejects undeclared and unreachable outcomes", () => {
    const replay: PmCommandExitObservation[] = [
      ...PM_CORE_COMMAND_NAMES.map((command) => ({
        command,
        exit_code: 0,
        replay_id: `${command}:success`,
      })),
      ...[1, 2, 3, 4, 5].map((exitCode) => ({
        command: "create",
        exit_code: exitCode,
        replay_id: `create:exit-${exitCode}`,
      })),
      {
        command: "update-many",
        exit_code: 6,
        replay_id: "update-many:no-match",
      },
      { command: "close-many", exit_code: 7, replay_id: "close-many:partial" },
    ];
    expect(analyzePmCommandExitConformance(replay)).toEqual({
      ok: true,
      missing_commands: [],
      undeclared_observations: [],
      unreachable_exit_codes: [],
    });

    const undeclared = analyzePmCommandExitConformance([
      ...replay,
      { command: "create", exit_code: 99, replay_id: "negative:undeclared" },
    ]);
    expect(undeclared.ok).toBe(false);
    expect(undeclared.undeclared_observations).toEqual([
      { command: "create", exit_code: 99, replay_id: "negative:undeclared" },
    ]);

    const unreachable = analyzePmCommandExitConformance(
      replay.filter((entry) => entry.exit_code !== 6 && entry.exit_code !== 7),
    );
    expect(unreachable.ok).toBe(false);
    expect(unreachable.unreachable_exit_codes).toEqual([6, 7]);

    expect(
      analyzePmCommandExitConformance([
        ...replay,
        {
          command: "create nested",
          exit_code: 0,
          replay_id: "nested:root-fallback",
        },
      ]).undeclared_observations,
    ).toEqual([]);

    const missing = analyzePmCommandExitConformance(replay, [
      ...PM_CORE_COMMAND_NAMES,
      "missing-command",
    ]);
    expect(missing.ok).toBe(false);
    expect(missing.missing_commands).toEqual(["missing-command"]);
  });
});
