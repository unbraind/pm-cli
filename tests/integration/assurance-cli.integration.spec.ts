import { describe, expect, it } from "vitest";

import type { AssuranceGateVerdict } from "../../src/sdk/governance/assurance.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

const measurement = {
  id: "active-items",
  source: { kind: "items", statuses: ["open", "in_progress"] },
  max_cost: 20,
};
const assertion = {
  id: "active-items-ceiling",
  measurement_id: "active-items",
  owner_item_id: "pm-assurance-owner",
  scope: { kind: "all" },
  ceiling: 0,
  lifetime: "hold",
  enforcement: "block",
  negative_control: {
    cases: [
      { observed: 1, expected: "fail" },
      { observed: 0, expected: "pass" },
    ],
  },
};
const gate = {
  id: "delivery",
  assertion_ids: ["active-items-ceiling"],
  triggers: ["ci", "pre-release"],
};

describe("assurance CLI integration", () => {
  it("explains change risk through the public CLI action", async () => {
    await withTempPmPath(async (context) => {
      const request = {
        policy: {
          version: 1,
          evidence_epoch: "2026-08-17T00:00:00.000Z",
          families: [
            {
              id: "cli-contract-drift",
              version: 1,
              title: "CLI contract drift",
              owner_item_id: "pm-assurance-owner",
              escape_class: "review_caught_late",
              triggers: { file_patterns: ["src/cli/**"] },
              checks: {
                local: ["pnpm contracts:check"],
                hosted: ["CI / contract-drift"],
              },
              negative_control: { files: ["src/cli/register-assurance.ts"] },
              historical_item_ids: ["pm-assurance-owner"],
              budget: { max_escape_rate: 0, max_false_positive_rate: 0.05 },
            },
          ],
        },
        change: { files: ["src/cli/register-assurance.ts"] },
      };
      const result = await context.runCliInProcess(
        ["assurance", "risk", "--definition", JSON.stringify(request), "--json"],
        { expectJson: true },
      );

      expect(result.code).toBe(0);
      expect(result.json).toMatchObject({
        risk_detected: true,
        total: 1,
        items: [{ family_id: "cli-contract-drift" }],
        required_local_checks: ["pnpm contracts:check"],
        required_hosted_checks: ["CI / contract-drift"],
      });
    });
  });

  it("uses one SDK path for registry CRUD, dry runs, and durable verdicts", async () => {
    await withTempPmPath(async (context) => {
      for (const [kind, definition] of [
        ["measurement", measurement],
        ["assertion", assertion],
        ["gate", gate],
      ] as const) {
        const put = await context.runCliInProcess(
          [
            "assurance",
            "put",
            kind,
            definition.id,
            "--definition",
            JSON.stringify(definition),
            "--author",
            "assurance-cli-test",
            "--json",
          ],
          { expectJson: true },
        );
        expect(put.code).toBe(0);
        expect(put.json).toMatchObject({ changed: true, action: "created", kind });
      }

      const listed = await context.runCliInProcess(
        ["assurance", "list", "measurement", "--json"],
        { expectJson: true },
      );
      expect(listed.json).toMatchObject({
        count: 1,
        items: [{ id: measurement.id }],
      });

      const shown = await context.runCliInProcess(
        ["assurance", "show", "gate", gate.id, "--json"],
        { expectJson: true },
      );
      expect(shown.json).toEqual(gate);

      const dryRun = await context.runCliInProcess(
        ["assurance", "run", gate.id, "--trigger", "ci", "--dry-run", "--json"],
        { expectJson: true },
      );
      expect(dryRun.json).toMatchObject({ dry_run: true, verdict: "pass" });

      const run = await context.runCliInProcess(
        ["assurance", "run", gate.id, "--trigger", "ci", "--json"],
        { expectJson: true },
      );
      expect(run.json).toMatchObject({ dry_run: false, verdict: "pass" });

      const verdicts = await context.runCliInProcess(
        ["assurance", "verdicts", gate.id, "--json"],
        { expectJson: true },
      );
      expect((verdicts.json as { items: AssuranceGateVerdict[] }).items).toHaveLength(1);
      expect((verdicts.json as { items: AssuranceGateVerdict[] }).items[0]).toMatchObject({
        gate_id: gate.id,
        verdict: "pass",
      });
    });
  });
});
