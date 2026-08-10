import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerAssuranceCommand } from "../../../src/cli/register-assurance.js";
import {
  putAssuranceDeclaration,
  type AssuranceAssertionDefinition,
  type AssuranceGateDefinition,
  type AssuranceMeasurementDefinition,
} from "../../../src/sdk/governance/assurance.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

function runRegisteredCommand(pmPath: string, args: string[]): Promise<Command> {
  const program = new Command()
    .name("pm")
    .option("--path <path>")
    .option("--json")
    .exitOverride();
  registerAssuranceCommand(program);
  return program.parseAsync(["node", "pm", "--path", pmPath, "--json", ...args]);
}

describe("assurance Commander registration", () => {
  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it("maps registry, verdict, and blocking run arguments onto the shared action", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const measurement: AssuranceMeasurementDefinition = {
        id: "items",
        source: { kind: "items" },
      };
      const assertion: AssuranceAssertionDefinition = {
        id: "items-floor",
        measurement_id: measurement.id,
        owner_item_id: "pm-owner",
        scope: { kind: "all" },
        floor: 1,
        enforcement: "block",
        negative_control: {
          cases: [
            { observed: 1, expected: "pass" },
            { observed: 0, expected: "fail" },
          ],
        },
      };
      const gate: AssuranceGateDefinition = {
        id: "blocking",
        assertion_ids: [assertion.id],
        triggers: ["ci"],
      };
      await putAssuranceDeclaration(pmPath, "measurement", measurement);
      await putAssuranceDeclaration(pmPath, "assertion", assertion);
      await putAssuranceDeclaration(pmPath, "gate", gate);
      vi.spyOn(process.stdout, "write").mockImplementation(() => true);

      await runRegisteredCommand(pmPath, ["assurance", "list", "measurement"]);
      expect(process.exitCode).toBeUndefined();
      await runRegisteredCommand(pmPath, [
        "assurance",
        "run",
        "ignored",
        gate.id,
        "--trigger",
        "ci",
        "--dry-run",
      ]);
      expect(process.exitCode).toBe(1);
      process.exitCode = undefined;
      await runRegisteredCommand(pmPath, ["assurance", "verdicts", gate.id]);
      expect(process.exitCode).toBeUndefined();

      const command = new Command().name("pm");
      registerAssuranceCommand(command);
      expect(command.commands[0]?.description()).toContain("SDK-owned");
    });
  });
});
