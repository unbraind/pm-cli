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
  reviewer?: string;
  risk?: string;
  confidence?: string;
  sprint?: string;
  release?: string;
  body?: string;
  note?: string;
  learning?: string;
  file?: string;
  doc?: string;
  comment?: string;
  /** Linked test "command=..." seed; carries a runnable linked_command. */
  test?: string;
}

const SEED_OPTION_FLAGS = [
  ["assignee", "--assignee"],
  ["tags", "--tags"],
  ["ac", "--acceptance-criteria"],
  ["estimate", "--estimate"],
  ["resolution", "--resolution"],
  ["reviewer", "--reviewer"],
  ["risk", "--risk"],
  ["confidence", "--confidence"],
  ["sprint", "--sprint"],
  ["release", "--release"],
  ["body", "--body"],
  ["note", "--note"],
  ["learning", "--learning"],
  ["file", "--file"],
  ["doc", "--doc"],
  ["comment", "--comment"],
  ["test", "--test"],
] as const satisfies ReadonlyArray<readonly [keyof SeedItemParams, string]>;

function seedOptionValue(value: string | number | undefined): string | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }
  return String(value);
}

function appendSeedOptionArgs(args: string[], params: SeedItemParams): void {
  for (const [key, flag] of SEED_OPTION_FLAGS) {
    const value = seedOptionValue(params[key]);
    if (value !== undefined) {
      args.push(flag, value);
    }
  }
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
  appendSeedOptionArgs(args, params);
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

  describe("pm list content-field filters (GH-242)", () => {
    it("filters by every content field present and absent, and echoes active filters", async () => {
      await withTempPmPath(async (context) => {
        seed(context, {
          title: "Rich",
          body: "has body",
          note: "author=t,text=n",
          learning: "author=t,text=l",
          file: "path=src/a.ts",
          doc: "path=docs/a.md",
          comment: "author=t,text=c",
          test: "command=npm test,path=t.spec.ts",
        });
        seed(context, { title: "Bare" });

        const cases: Array<[string, string[]]> = [
          ["--has-notes", ["Rich"]],
          ["--no-notes", ["Bare"]],
          ["--has-learnings", ["Rich"]],
          ["--no-learnings", ["Bare"]],
          ["--has-files", ["Rich"]],
          ["--no-files", ["Bare"]],
          ["--has-docs", ["Rich"]],
          ["--no-docs", ["Bare"]],
          ["--has-tests", ["Rich"]],
          ["--no-tests", ["Bare"]],
          ["--has-comments", ["Rich"]],
          ["--no-comments", ["Bare"]],
          ["--has-body", ["Rich"]],
          ["--empty-body", ["Bare"]],
          ["--has-linked-command", ["Rich"]],
          ["--no-linked-command", ["Bare"]],
        ];
        for (const [flag, expected] of cases) {
          const out = context.runCli(["list", flag, "--json"], { expectJson: true });
          expect(titlesOf(out.json), flag).toEqual(expected);
        }

        // Dependency presence/absence: seed an item that depends on another.
        const target = seed(context, { title: "DepTarget" });
        const created = context.runCli(
          ["create", "--json", "--title", "WithDep", "--type", "Task", "--dep", `id=${target},kind=blocks`],
          { expectJson: true },
        );
        expect(created.code).toBe(0);
        const hasDeps = context.runCli(["list", "--has-deps", "--json"], { expectJson: true });
        expect(titlesOf(hasDeps.json)).toEqual(["WithDep"]);

        // Active content filters are echoed in both compact and verbose summaries.
        const compact = context.runCli(["list", "--has-notes", "--empty-body", "--compact", "--json"], { expectJson: true });
        const compactFilters = (compact.json as { filters: Record<string, unknown> }).filters;
        expect(compactFilters.has_notes).toBe(true);
        expect(compactFilters.empty_body).toBe(true);
        const verbose = context.runCli(["list", "--no-files", "--json"], { expectJson: true });
        expect((verbose.json as { filters: Record<string, unknown> }).filters.no_files).toBe(true);
      });
    }, 60_000);

    it("ANDs multiple content selections and rejects a field requested both present and absent", async () => {
      await withTempPmPath(async (context) => {
        seed(context, { title: "NotesOnly", note: "author=t,text=n" });
        seed(context, { title: "NotesAndBody", note: "author=t,text=n", body: "b" });

        const both = context.runCli(["list", "--has-notes", "--has-body", "--json"], { expectJson: true });
        expect(titlesOf(both.json)).toEqual(["NotesAndBody"]);

        const conflict = context.runCli(["list", "--has-notes", "--no-notes", "--json"]);
        expect(conflict.code).not.toBe(0);
        expect(conflict.stderr + conflict.stdout).toContain("Cannot combine --has-notes with --no-notes");
      });
    });

    it("applies content filters to pm search results", async () => {
      await withTempPmPath(async (context) => {
        seed(context, { title: "Alpha", note: "author=t,text=n" });
        seed(context, { title: "Alpha plain" });

        const withNotes = context.runCli(["search", "Alpha", "--has-notes", "--full", "--json"], { expectJson: true });
        const titles = ((withNotes.json as { items?: Array<{ item?: { title?: string }; title?: string }> }).items ?? [])
          .map((hit) => hit.item?.title ?? hit.title)
          .filter((value): value is string => typeof value === "string");
        expect(titles).toEqual(["Alpha"]);
        const filters = (withNotes.json as { filters: Record<string, unknown> }).filters;
        expect(filters.has_notes).toBe(true);
      });
    });
  });

  describe("pm list governance-missing filters (GH-236)", () => {
    it("filters by each governance-missing predicate and echoes the active filter", async () => {
      await withTempPmPath(async (context) => {
        seed(context, {
          title: "FullyTagged",
          reviewer: "rev",
          risk: "low",
          confidence: "high",
          sprint: "S1",
          release: "R1",
        });
        seed(context, { title: "MissingAll" });

        const cases: Array<[string, string]> = [
          ["--filter-reviewer-missing", "filter_reviewer_missing"],
          ["--filter-risk-missing", "filter_risk_missing"],
          ["--filter-confidence-missing", "filter_confidence_missing"],
          ["--filter-sprint-missing", "filter_sprint_missing"],
          ["--filter-release-missing", "filter_release_missing"],
        ];
        for (const [flag, summaryKey] of cases) {
          const out = context.runCli(["list", flag, "--json"], { expectJson: true });
          expect(titlesOf(out.json), flag).toEqual(["MissingAll"]);
          expect((out.json as { filters: Record<string, unknown> }).filters[summaryKey], summaryKey).toBe(true);
        }
      });
    });

    it("applies governance-missing filters to pm search", async () => {
      await withTempPmPath(async (context) => {
        seed(context, { title: "Beta has reviewer", reviewer: "rev" });
        seed(context, { title: "Beta no reviewer" });

        const out = context.runCli(["search", "Beta", "--filter-reviewer-missing", "--full", "--json"], { expectJson: true });
        const titles = ((out.json as { items?: Array<{ item?: { title?: string }; title?: string }> }).items ?? [])
          .map((hit) => hit.item?.title ?? hit.title)
          .filter((value): value is string => typeof value === "string");
        expect(titles).toEqual(["Beta no reviewer"]);
      });
    });
  });

  describe("pm update-many / close-many bulk content + governance filters (GH-242/236)", () => {
    it("selects only items with notes for bulk update and only empty-body items for bulk close", async () => {
      await withTempPmPath(async (context) => {
        seed(context, { title: "BulkNotes", note: "author=t,text=n", body: "has body" });
        seed(context, { title: "BulkPlain", body: "has body" });
        seed(context, { title: "BulkEmpty" });

        const updated = context.runCli(
          ["update-many", "--filter-has-notes", "--tags", "triaged", "--author", "bot", "--json"],
          { expectJson: true },
        );
        expect(updated.code).toBe(0);
        expect((updated.json as { matched_count: number }).matched_count).toBe(1);

        const closed = context.runCli(
          ["close-many", "--filter-empty-body", "--reason", "stale", "--author", "bot", "--json"],
          { expectJson: true },
        );
        expect(closed.code).toBe(0);
        expect((closed.json as { matched_count: number }).matched_count).toBe(1);
      });
    });

    it("accepts every bulk content + governance filter flag together in a dry-run plan", async () => {
      await withTempPmPath(async (context) => {
        // A rich item satisfies every present + governance-present predicate, so a
        // request combining all presence + governance-missing flags matches it for
        // the present subset and excludes it for the governance-missing subset.
        seed(context, {
          title: "RichAll",
          body: "b",
          note: "author=t,text=n",
          learning: "author=t,text=l",
          file: "path=a.ts",
          doc: "path=a.md",
          comment: "author=t,text=c",
          test: "command=npm test",
        });
        // Exercise the true-branch of every bulk presence mapping in one call.
        const presence = context.runCli(
          [
            "update-many",
            "--filter-has-notes",
            "--filter-has-learnings",
            "--filter-has-files",
            "--filter-has-docs",
            "--filter-has-tests",
            "--filter-has-comments",
            "--filter-has-body",
            "--filter-has-linked-command",
            "--tags",
            "marked",
            "--dry-run",
            "--json",
          ],
          { expectJson: true },
        );
        expect(presence.code).toBe(0);
        expect((presence.json as { matched_count: number }).matched_count).toBe(1);

        // Exercise the true-branch of every bulk absence + governance-missing mapping.
        const absenceAndGovernance = context.runCli(
          [
            "update-many",
            "--filter-no-notes",
            "--filter-no-learnings",
            "--filter-no-files",
            "--filter-no-docs",
            "--filter-no-tests",
            "--filter-no-comments",
            "--filter-no-deps",
            "--filter-empty-body",
            "--filter-no-linked-command",
            "--filter-reviewer-missing",
            "--filter-risk-missing",
            "--filter-confidence-missing",
            "--filter-sprint-missing",
            "--filter-release-missing",
            "--tags",
            "marked",
            "--dry-run",
            "--json",
          ],
          { expectJson: true },
        );
        expect(absenceAndGovernance.code).toBe(0);
        // RichAll has every content field populated, so the all-absent request matches nothing.
        expect((absenceAndGovernance.json as { matched_count: number }).matched_count).toBe(0);
      });
    });

    it("routes every bulk absence + governance filter through close-many selection", async () => {
      await withTempPmPath(async (context) => {
        seed(context, { title: "EmptyAll" });
        // A consistent all-absent + governance-missing set matches the bare item;
        // this exercises the close-many mapping path for every such flag.
        const closed = context.runCli(
          [
            "close-many",
            "--filter-no-notes",
            "--filter-no-learnings",
            "--filter-no-files",
            "--filter-no-docs",
            "--filter-no-tests",
            "--filter-no-comments",
            "--filter-no-deps",
            "--filter-empty-body",
            "--filter-no-linked-command",
            "--filter-reviewer-missing",
            "--filter-risk-missing",
            "--filter-confidence-missing",
            "--filter-sprint-missing",
            "--filter-release-missing",
            "--reason",
            "x",
            "--dry-run",
            "--json",
          ],
          { expectJson: true },
        );
        expect(closed.code).toBe(0);
        expect((closed.json as { matched_count: number }).matched_count).toBe(1);
      });
    });

    it("selects governance-missing items for bulk update", async () => {
      await withTempPmPath(async (context) => {
        seed(context, { title: "HasReviewer", reviewer: "rev" });
        seed(context, { title: "NeedsReviewer1" });
        seed(context, { title: "NeedsReviewer2" });

        const result = context.runCli(
          ["update-many", "--filter-reviewer-missing", "--reviewer", "tbd", "--author", "bot", "--json"],
          { expectJson: true },
        );
        expect(result.code).toBe(0);
        expect((result.json as { matched_count: number }).matched_count).toBe(2);
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
