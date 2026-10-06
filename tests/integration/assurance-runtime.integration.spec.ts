import { describe, expect, it } from "vitest";

import {
  PmClient,
  analyzeSdkActionCoverage,
  runAction,
} from "../../src/sdk/runtime.js";
import { runAssuranceAction } from "../../src/sdk/governance/assurance-action.js";
import { createAssuranceWorkspaceContext } from "../../src/sdk/governance/assurance-runtime.js";
import { evaluateMeasurement } from "../../src/sdk/governance/assurance.js";
import {
  getWorkspaceHistoryPath,
  readHistoryEntries,
  WORKSPACE_HISTORY_ID,
} from "../../src/sdk/runtime-primitives.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

const measurement = {
  id: "open-items",
  source: { kind: "items" as const, statuses: ["open"] },
};

describe("assurance runtime parity", () => {
  it("measures persisted body-only references through both workspace projections and CLI verdicts", async () => {
    await withTempPmPath(async ({ pmPath, runCliInProcess }) => {
      const client = new PmClient({ pmRoot: pmPath });
      const targetId = "pm-body-target";
      const holderId = "pm-body-holder";
      await client.create({
        id: targetId,
        title: "Body reference target",
        type: "Task",
      });
      await client.create({
        id: holderId,
        title: "Body reference holder",
        type: "Task",
        body: `Verifies ${targetId}.`,
      });
      const definition = {
        id: "body-gap",
        source: { kind: "prose_edge_gap" as const },
      };
      for (const strictRead of [true, false]) {
        const context = await createAssuranceWorkspaceContext(pmPath, {
          strict_read: strictRead,
          include_history: false,
          resolve_tree: false,
        });
        await expect(
          evaluateMeasurement(definition, context),
        ).resolves.toMatchObject({
          value: 1,
          population_size: 2,
          contributors: [`${holderId}->${targetId}|subject=implicit`],
          partitions: { explicit_subject: 0, implicit_subject: 1 },
        });
      }
      await client.assurance({
        action: "put",
        kind: "measurement",
        id: definition.id,
        definition,
      });
      await client.assurance({
        action: "put",
        kind: "assertion",
        id: "body-ceiling",
        definition: {
          id: "body-ceiling",
          measurement_id: definition.id,
          owner_item_id: holderId,
          scope: { kind: "all" },
          ceiling: 0,
          enforcement: "block",
          negative_control: {
            cases: [
              { observed: 0, expected: "pass" },
              { observed: 1, expected: "fail" },
            ],
          },
        },
      });
      await client.assurance({
        action: "put",
        kind: "gate",
        id: "body-check",
        definition: {
          id: "body-check",
          assertion_ids: ["body-ceiling"],
          triggers: ["ci"],
        },
      });
      const blocked = await runCliInProcess(
        [
          "assurance",
          "run",
          "body-check",
          "--trigger",
          "ci",
          "--dry-run",
          "--json",
        ],
        { expectJson: true },
      );
      expect(blocked.code).toBe(1);
      expect(blocked.json).toMatchObject({
        verdict: "block",
        assertions: [{ observed: 1, population_size: 2 }],
      });
      await client.update(holderId, { dep: [`id=${targetId},kind=verifies`] });
      const linked = await runCliInProcess(
        [
          "assurance",
          "run",
          "body-check",
          "--trigger",
          "ci",
          "--dry-run",
          "--json",
        ],
        { expectJson: true },
      );
      expect(linked.code).toBe(0);
      expect(linked.json).toMatchObject({
        verdict: "pass",
        assertions: [{ observed: 0 }],
      });
    });
  });

  it("routes PmClient, standalone SDK, and MCP dispatch through one action", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const client = new PmClient({ pmRoot: pmPath, author: "runtime-test" });
      await expect(
        client.assurance({
          action: "put",
          kind: "measurement",
          id: measurement.id,
          definition: measurement,
        }),
      ).resolves.toMatchObject({ action: "created", changed: true });
      expect(
        (
          await readHistoryEntries(
            getWorkspaceHistoryPath(pmPath),
            WORKSPACE_HISTORY_ID,
          )
        )[0]?.author,
      ).toBe("runtime-test");

      await expect(
        runAssuranceAction(
          { action: "show", kind: "measurement", id: measurement.id },
          { path: pmPath },
        ),
      ).resolves.toEqual(measurement);

      await expect(
        runAction({
          action: "assurance",
          path: pmPath,
          options: { subcommand: "list", kind: "measurement" },
        }),
      ).resolves.toMatchObject({ count: 1, items: [measurement] });

      expect(
        analyzeSdkActionCoverage().find((row) => row.action === "assurance"),
      ).toEqual({
        action: "assurance",
        resolved_action: "assurance",
        covered: true,
        route: "native",
      });
    });
  });
});
