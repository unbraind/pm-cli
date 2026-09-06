import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runAssuranceAction } from "../../src/sdk/governance/assurance-action.js";
import { PmClient, runAction } from "../../src/sdk/runtime.js";
import type { DefectRecurrencePolicy } from "../../src/sdk/governance/defect-recurrence.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

describe("recurrence lineage transport contracts", () => {
  it("derives coverage and invalidates cached risk after a real recorded edge mutation", async () => {
    await withTempPmPath(async (context) => {
      const ids: string[] = [];
      for (const title of [
        "Earlier output corruption",
        "Recurring output corruption",
      ]) {
        const created = await context.runCliInProcess(
          ["create", title, "--type", "Issue", "--json"],
          { expectJson: true },
        );
        expect(created.code).toBe(0);
        ids.push((created.json as { item: { id: string } }).item.id);
      }
      const predecessor = ids[0]!;
      const recurring = ids[1]!;
      expect(
        (
          await context.runCliInProcess(
            [
              "update",
              recurring,
              "--dep",
              `id=${predecessor},kind=recurs_from`,
              "--json",
            ],
            { expectJson: true },
          )
        ).code,
      ).toBe(0);
      const policy: DefectRecurrencePolicy = {
        version: 1,
        evidence_epoch: "2026-01-01T00:00:00.000Z",
        families: [
          {
            id: "output-corruption",
            version: 1,
            title: "Output corruption",
            owner_item_id: predecessor,
            escape_class: "production_defect",
            historical_item_ids: [predecessor],
            triggers: { item_ids: [predecessor] },
            negative_control: { item_ids: [predecessor] },
            checks: {
              local: ["node test-output.mjs"],
              hosted: ["CI / output"],
            },
            budget: { max_escape_rate: 0, max_false_positive_rate: 0.05 },
          },
        ],
      };
      const definition = { policy, limit: 1 };
      const expected = {
        ok: true,
        total: 2,
        has_more: true,
        population: {
          item_count: 2,
          covered_item_count: 2,
          unclassified_item_count: 2,
        },
      };
      const client = new PmClient({ pmRoot: context.pmPath });
      await expect(
        client.assurance({ action: "lineages", definition }),
      ).resolves.toMatchObject(expected);
      await expect(
        runAssuranceAction(
          { action: "lineages", definition },
          { path: context.pmPath },
        ),
      ).resolves.toMatchObject(expected);
      await expect(
        runAction({
          action: "assurance",
          path: context.pmPath,
          options: { subcommand: "lineages", definition },
        }),
      ).resolves.toMatchObject(expected);
      const cli = await context.runCliInProcess(
        [
          "assurance",
          "lineages",
          "--definition",
          JSON.stringify(definition),
          "--json",
        ],
        { expectJson: true },
      );
      expect(cli.code).toBe(0);
      expect(cli.json).toMatchObject(expected);
      const risk = { policy, change: { item_ids: [recurring] } };
      await expect(
        client.assurance({ action: "risk", definition: risk }),
      ).resolves.toMatchObject({
        risk_detected: true,
        required_local_checks: ["node test-output.mjs"],
      });
      expect(
        (
          await context.runCliInProcess(
            ["update", recurring, "--clear-deps", "--json"],
            { expectJson: true },
          )
        ).code,
      ).toBe(0);
      await expect(
        client.assurance({ action: "risk", definition: risk }),
      ).resolves.toMatchObject({ risk_detected: false });
      const externalEdge = await context.runCliInProcess(
        [
          "update",
          recurring,
          "--dep",
          `id=${predecessor},kind=recurs_from,source_kind=external`,
          "--json",
        ],
        { expectJson: true },
      );
      expect(externalEdge.code).toBe(0);
      await expect(
        client.assurance({ action: "lineages", definition }),
      ).resolves.toMatchObject({
        population: { item_count: 0, edge_count: 0 },
      });
      for (const invalid of ["{", JSON.stringify({ policy, limit: 101 }), JSON.stringify({ policy, change: {} })]) {
        const refusal = await context.runCliInProcess(
          ["assurance", "lineages", "--definition", invalid, "--json"],
          { expectJson: true },
        );
        expect(refusal.code).toBe(2);
      }
      await expect(
        client.assurance({ action: "lineages", definition, limit: 1 }),
      ).rejects.toThrow("inside the definition");
      await writeFile(
        path.join(context.pmPath, "issues", `${recurring}.toon`),
        "",
        "utf8",
      );
      for (const action of ["lineages", "risk"]) {
        const request = action === "risk" ? risk : definition;
        await expect(
          client.assurance({ action, definition: request }),
        ).rejects.toThrow("source is incomplete");
        const incomplete = await context.runCliInProcess(
          [
            "assurance",
            action,
            "--definition",
            JSON.stringify(request),
            "--json",
          ],
          { expectJson: true },
        );
        expect(incomplete.code).toBe(1);
        expect(incomplete.stderr).toContain("source is incomplete");
      }
    });
  });
});
