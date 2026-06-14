import { describe, expect, it } from "vitest";

import { withTempPmPath, type TempPmContext } from "../../helpers/withTempPmPath.js";

/**
 * End-to-end command coverage for the metadata-governance surface
 * (GH-228/220/218/213/219/224): pm list / update-many missing-metadata filters,
 * pm stats coverage + grouped breakdowns, and pm validate --all-affected-ids.
 * Drives the real CLI so flag wiring, option normalization, and handler logic
 * are all exercised together.
 */

interface SeedItemParams {
  title: string;
  type?: string;
  status?: string;
  priority?: number;
  assignee?: string;
  tags?: string;
  ac?: string;
  estimate?: number;
  resolution?: string;
}

function seed(context: TempPmContext, params: SeedItemParams): string {
  const args = [
    "create",
    "--json",
    "--title",
    params.title,
    "--description",
    `${params.title} description`,
    "--type",
    params.type ?? "Task",
    "--status",
    params.status ?? "open",
    "--priority",
    String(params.priority ?? 2),
  ];
  if (params.assignee) args.push("--assignee", params.assignee);
  if (params.tags) args.push("--tags", params.tags);
  if (params.ac) args.push("--acceptance-criteria", params.ac);
  if (params.estimate !== undefined) args.push("--estimate", String(params.estimate));
  if (params.resolution) args.push("--resolution", params.resolution);
  const created = context.runCli(args, { expectJson: true });
  expect(created.code).toBe(0);
  return (created.json as { item: { id: string } }).item.id;
}

function titlesOf(json: unknown): string[] {
  const items = (json as { items?: Array<{ title: string }> }).items ?? [];
  return items.map((item) => item.title).sort();
}

describe("metadata-governance commands", () => {
  describe("pm list missing-metadata filters (GH-228)", () => {
    it("filters by each missing-metadata predicate and the union", async () => {
      await withTempPmPath(async (context) => {
        seed(context, { title: "Complete", ac: "Given/When/Then", estimate: 30, assignee: "alice" });
        seed(context, { title: "NoAc", estimate: 30 });
        seed(context, { title: "NoEstimate", ac: "ac only" });
        seed(context, { title: "NoEither" });

        const acMissing = context.runCli(["list", "--filter-ac-missing", "--json"], { expectJson: true });
        expect(titlesOf(acMissing.json)).toEqual(["NoAc", "NoEither"]);

        const estMissing = context.runCli(["list", "--filter-estimates-missing", "--json"], { expectJson: true });
        expect(titlesOf(estMissing.json)).toEqual(["NoEither", "NoEstimate"]);

        // Specific flags AND together: missing AC *and* missing estimate.
        const both = context.runCli(
          ["list", "--filter-ac-missing", "--filter-estimates-missing", "--json"],
          { expectJson: true },
        );
        expect(titlesOf(both.json)).toEqual(["NoEither"]);

        // Union: missing any tracked field.
        const anyMissing = context.runCli(["list", "--filter-metadata-missing", "--json"], { expectJson: true });
        expect(titlesOf(anyMissing.json)).toEqual(["NoAc", "NoEither", "NoEstimate"]);

        // Active filters are echoed in the query filters summary.
        expect((acMissing.json as { filters: Record<string, unknown> }).filters.filter_ac_missing).toBe(true);
      });
    });

    it("scopes --filter-resolution-missing to terminal items and accepts the singular estimate alias", async () => {
      await withTempPmPath(async (context) => {
        const open = seed(context, { title: "OpenNoResolution" });
        const closedNoRes = seed(context, { title: "ClosedNoResolution" });
        const closedWithRes = seed(context, { title: "ClosedWithResolution" });
        // Positional reason sets close_reason but leaves the resolution field empty.
        expect(context.runCli(["close", closedNoRes, "closing without resolution"]).code).toBe(0);
        expect(context.runCli(["close", closedWithRes, "--resolution", "fixed"]).code).toBe(0);
        void open;

        const resMissing = context.runCli(["list-all", "--filter-resolution-missing", "--json"], { expectJson: true });
        // Open items are never resolution-missing; only the closed item without a resolution matches.
        expect(titlesOf(resMissing.json)).toEqual(["ClosedNoResolution"]);

        // Singular alias resolves to the same plural filter.
        const aliasMissing = context.runCli(["list", "--filter-estimate-missing", "--json"], { expectJson: true });
        expect(aliasMissing.code).toBe(0);
      });
    });
  });

  describe("pm update-many missing-metadata selection (GH-220)", () => {
    it("selects only items missing acceptance_criteria for bulk backfill", async () => {
      await withTempPmPath(async (context) => {
        seed(context, { title: "HasAc", ac: "present" });
        seed(context, { title: "NeedsAc1" });
        seed(context, { title: "NeedsAc2" });

        const result = context.runCli(
          [
            "update-many",
            "--filter-ac-missing",
            "--acceptance-criteria",
            "TBD - needs definition",
            "--author",
            "backfiller",
            "--json",
          ],
          { expectJson: true },
        );
        expect(result.code).toBe(0);
        expect((result.json as { matched_count: number }).matched_count).toBe(2);

        // After backfill nothing is AC-missing.
        const remaining = context.runCli(["list", "--filter-ac-missing", "--json"], { expectJson: true });
        expect(titlesOf(remaining.json)).toEqual([]);
      });
    });

    it("rejects missing-metadata filters in rollback mode", async () => {
      await withTempPmPath(async (context) => {
        const rollback = context.runCli(
          ["update-many", "--rollback", "ckpt-1", "--filter-ac-missing", "--json"],
          { expectJson: true },
        );
        expect(rollback.code).not.toBe(0);
      });
    });
  });

  describe("pm stats governance breakdowns (GH-213/218/219)", () => {
    it("reports coverage percentages and grouped lifecycle breakdowns only when requested", async () => {
      await withTempPmPath(async (context) => {
        seed(context, { title: "A", assignee: "alice", tags: "domain:game,layer:server", ac: "x", estimate: 10, priority: 1 });
        seed(context, { title: "B", assignee: "alice", tags: "domain:infra", priority: 2 });
        seed(context, { title: "C", tags: "domain:game", priority: 2 });

        const plain = context.runCli(["stats", "--json"], { expectJson: true });
        const plainJson = plain.json as Record<string, unknown>;
        expect(plainJson.metadata_coverage).toBeUndefined();
        expect(plainJson.breakdowns).toBeUndefined();

        const rich = context.runCli(
          ["stats", "--metadata-coverage", "--by-assignee", "--by-priority", "--json"],
          { expectJson: true },
        );
        const json = rich.json as {
          metadata_coverage: { overall: Record<string, { present: number; applicable: number; percent: number }> };
          breakdowns: {
            assignee: { rows: Array<{ label: string; total: number }> };
            priority: { rows: Array<{ label: string; total: number }> };
          };
        };
        expect(json.metadata_coverage.overall.acceptance_criteria).toEqual({ present: 1, applicable: 3, percent: 33.3 });
        const assigneeLabels = json.breakdowns.assignee.rows.map((row) => row.label);
        expect(assigneeLabels).toContain("alice");
        expect(assigneeLabels).toContain("(unassigned)");
        expect(json.breakdowns.priority.rows.map((row) => row.label).sort()).toEqual(["P1", "P2"]);
      });
    });

    it("groups by tag and honors --tag-prefix", async () => {
      await withTempPmPath(async (context) => {
        seed(context, { title: "Game", tags: "domain:game,layer:server" });
        seed(context, { title: "Infra", tags: "domain:infra" });
        seed(context, { title: "Untagged" });

        const result = context.runCli(["stats", "--by-tag", "--tag-prefix", "domain:", "--json"], { expectJson: true });
        const rows = (result.json as { breakdowns: { tag: { rows: Array<{ label: string }> } } }).breakdowns.tag.rows;
        const labels = rows.map((row) => row.label);
        expect(labels).toContain("domain:game");
        expect(labels).toContain("domain:infra");
        expect(labels).toContain("(untagged)");
        expect(labels).not.toContain("layer:server");
      });
    });
  });

  describe("pm validate --all-affected-ids (GH-224)", () => {
    it("never truncates ID lists in JSON and honors --all-affected-ids in human mode", async () => {
      await withTempPmPath(async (context) => {
        for (let index = 0; index < 7; index += 1) {
          seed(context, { title: `Missing ${index}` });
        }

        const json = context.runCli(["validate", "--check-metadata", "--json"], { expectJson: true });
        const details = (json.json as { checks: Array<{ name: string; details?: Record<string, unknown> }> }).checks.find(
          (check) => check.name === "metadata",
        )?.details as { missing_acceptance_criteria_item_ids: string[]; missing_acceptance_criteria_truncated: boolean };
        expect(details.missing_acceptance_criteria_item_ids.length).toBe(7);
        expect(details.missing_acceptance_criteria_truncated).toBe(false);

        // Human default truncates; --all-affected-ids emits the full list.
        const humanDefault = context.runCli(["validate", "--check-metadata"]);
        expect(humanDefault.stdout).toContain("missing_acceptance_criteria_truncated: true");
        const humanAll = context.runCli(["validate", "--check-metadata", "--all-affected-ids"]);
        expect(humanAll.stdout).toContain("missing_acceptance_criteria_truncated: false");
      });
    });
  });
});
