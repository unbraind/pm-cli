import { describe, expect, it } from "vitest";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

describe("CLI command exit effect contract", () => {
  it("distinguishes full effect, no effect, and partial effect for bulk mutations", async () => {
    await withTempPmPath(async (context) => {
      const created = context.runCli([
        "create",
        "--id",
        "exit-effect",
        "--title",
        "Exit effect",
        "--type",
        "Task",
        "--create-mode",
        "progressive",
        "--json",
      ]);
      expect(created.code).toBe(0);

      const noEffect = context.runCli([
        "update-many",
        "--ids",
        "pm-not-present",
        "--tags",
        "contracted",
        "--json",
      ]);
      expect(noEffect.code).toBe(6);
      expect(JSON.parse(noEffect.stdout)).toMatchObject({
        outcome: "no_effect",
        exit_code: 6,
        matched_count: 0,
        updated_count: 0,
        unmatched_count: 1,
      });

      const partialEffect = context.runCli([
        "update-many",
        "--ids",
        "pm-exit-effect,pm-not-present",
        "--tags",
        "contracted",
        "--json",
      ]);
      expect(partialEffect.code).toBe(7);
      expect(JSON.parse(partialEffect.stdout)).toMatchObject({
        outcome: "partial_effect",
        exit_code: 7,
        matched_count: 1,
        updated_count: 1,
        unmatched_count: 1,
      });

      const fullEffect = context.runCli([
        "update-many",
        "--ids",
        "pm-exit-effect",
        "--priority",
        "1",
        "--json",
      ]);
      expect(fullEffect.code).toBe(0);
      expect(JSON.parse(fullEffect.stdout)).toMatchObject({
        outcome: "effect",
        exit_code: 0,
        matched_count: 1,
        updated_count: 1,
        unmatched_count: 0,
      });

      const partialClose = context.runCli([
        "close-many",
        "--ids",
        "pm-exit-effect,pm-not-present",
        "--reason",
        "Exit effect contract verified",
        "--json",
      ]);
      expect(partialClose.code).toBe(7);
      expect(JSON.parse(partialClose.stdout)).toMatchObject({
        outcome: "partial_effect",
        exit_code: 7,
        matched_count: 1,
        closed_count: 1,
      });

      const noCloseEffect = context.runCli([
        "close-many",
        "--ids",
        "pm-not-present",
        "--reason",
        "No matching item",
        "--json",
      ]);
      expect(noCloseEffect.code).toBe(6);
      expect(JSON.parse(noCloseEffect.stdout)).toMatchObject({
        outcome: "no_effect",
        exit_code: 6,
        matched_count: 0,
        closed_count: 0,
      });

      const contracts = context.runCli([
        "contracts",
        "--command",
        "update-many",
        "--full",
        "--json",
        "--output-budget",
        "unbounded",
      ]);
      expect(contracts.code).toBe(0);
      expect(JSON.parse(contracts.stdout).command_exit_contracts).toEqual({
        vocabulary: expect.arrayContaining([
          expect.objectContaining({
            exit_code: 6,
            outcome: "no_effect",
            success: true,
          }),
          expect.objectContaining({
            exit_code: 7,
            outcome: "partial_effect",
            success: true,
          }),
        ]),
        command_sets: [
          {
            commands: ["update-many"],
            exit_codes: [0, 1, 2, 3, 4, 5, 6, 7],
          },
        ],
      });
    });
  });
});
