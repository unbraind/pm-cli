/**
 * @module tests/integration/read-output-completeness.integration
 *
 * Proves explicit complete-result intent and whole-result omission semantics at
 * the real CLI and shared SDK/MCP action transport boundaries.
 */
import { describe, expect, it } from "vitest";
import { runAction } from "../../src/sdk/index.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

describe("explicit complete read output", () => {
  it("lets explicit full intent defeat only the implicit default ceiling", async () => {
    await withTempPmPath(async (context) => {
      const complete = context.runCli(
        ["--no-extensions", "contracts", "--json", "--full"],
        { expectJson: true },
      );
      expect(complete.code, complete.stderr).toBe(0);
      expect(complete.json).toMatchObject({
        commands: expect.any(Array),
        actions: expect.any(Array),
      });

      const explicitBudget = context.runCli([
        "--no-extensions",
        "contracts",
        "--json",
        "--full",
        "--output-budget",
        "256",
      ]);
      expect(explicitBudget.code).toBe(2);
      expect(JSON.parse(explicitBudget.stdout)).toMatchObject({
        output_budget_exceeded: {
          omitted_result: true,
          reason: "requested_budget_infeasible",
        },
      });

      const action = await runAction({
        action: "contracts",
        path: context.pmRoot,
        noExtensions: true,
        options: { full: true },
      });
      expect(action).toMatchObject({
        commands: expect.any(Array),
        actions: expect.any(Array),
      });
    });
  });
});
