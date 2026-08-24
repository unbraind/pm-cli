import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  withTempPmPath,
  type TempPmContext,
} from "../helpers/withTempPmPath.js";

function expectCompetingStdinConsumers(
  context: TempPmContext,
  args: string[],
  input: string,
): void {
  const result = context.runCli(args, { input });
  expect(result.code).toBe(2);
  expect(result.stderr).toContain(
    "Only one option may consume stdin per command invocation",
  );
}

describe("bulk and file input composability", () => {
  it("pipes IDs into update-many, reads @path in close-many, and previews filters without mutations", async () => {
    await withTempPmPath(async (context) => {
      for (const id of ["pipe-a", "pipe-b", "pipe-filtered-out"]) {
        expect(
          context.runCli([
            "create",
            "--id",
            id,
            "--title",
            id,
            "--type",
            "Task",
            "--create-mode",
            "progressive",
            "--json",
          ]).code,
        ).toBe(0);
      }

      const piped = context.runCli(
        ["update-many", "--ids", "-", "--tags", "piped", "--json"],
        { input: "pm-pipe-a\npm-pipe-b\npm-missing\n" },
      );
      expect(piped.code).toBe(7);
      expect(JSON.parse(piped.stdout)).toMatchObject({
        outcome: "partial_effect",
        matched_count: 2,
        updated_count: 2,
        unmatched_ids: ["pm-missing"],
        unmatched_count: 1,
      });

      const preview = context.runCli([
        "update-many",
        "--filter-tag",
        "piped",
        "--dry-run",
        "--json",
      ]);
      expect(preview.code).toBe(0);
      expect(JSON.parse(preview.stdout)).toMatchObject({
        mode: "dry_run",
        matched_count: 2,
        planned_update_options: {},
        item_plans: [
          expect.objectContaining({ changes: [] }),
          expect.objectContaining({ changes: [] }),
        ],
      });

      const bodyPreview = context.runCli(
        [
          "update-many",
          "--filter-tag",
          "piped",
          "--body",
          "-",
          "--dry-run",
          "--json",
        ],
        { input: "-" },
      );
      expect(bodyPreview.code).toBe(0);
      expect(JSON.parse(bodyPreview.stdout)).toMatchObject({
        mode: "dry_run",
        matched_count: 2,
        planned_update_options: { body: "-" },
        item_plans: [
          expect.objectContaining({
            changes: expect.arrayContaining([
              expect.objectContaining({ field: "body", after: "-" }),
            ]),
          }),
          expect.objectContaining({
            changes: expect.arrayContaining([
              expect.objectContaining({ field: "body", after: "-" }),
            ]),
          }),
        ],
      });

      const bodyApplied = context.runCli(
        ["update-many", "--filter-tag", "piped", "--body", "-", "--json"],
        { input: "-" },
      );
      expect(bodyApplied.code).toBe(0);
      expect(JSON.parse(bodyApplied.stdout)).toMatchObject({
        mode: "apply",
        matched_count: 2,
        updated_count: 2,
        planned_update_options: { body: "-" },
      });
      for (const id of ["pm-pipe-a", "pm-pipe-b"]) {
        const item = context.runCli(["get", id, "--fields", "body", "--json"]);
        expect(item.code).toBe(0);
        expect(JSON.parse(item.stdout)).toMatchObject({
          item: { body: "-" },
        });
      }

      const compactPreview = context.runCli(
        ["history-compact", "--ids", "-", "--dry-run", "--json"],
        { input: "pm-pipe-a\npm-pipe-b\npm-pipe-a\n" },
      );
      expect(compactPreview.code).toBe(0);
      expect(JSON.parse(compactPreview.stdout)).toMatchObject({
        bulk: true,
        dry_run: true,
        mode: "ids",
        results: [
          expect.objectContaining({ id: "pm-pipe-a" }),
          expect.objectContaining({ id: "pm-pipe-b" }),
        ],
      });

      const refusedApply = context.runCli([
        "update-many",
        "--filter-tag",
        "piped",
        "--json",
      ]);
      expect(refusedApply.code).toBe(2);
      expect(refusedApply.stderr).toContain(
        "or pass --dry-run for a filter-only preview",
      );

      const idsPath = path.join(context.tempRoot, "close-ids.txt");
      await writeFile(idsPath, "pm-pipe-a\npm-not-present\n", "utf8");
      const closed = context.runCli([
        "close-many",
        "--ids",
        `@${idsPath}`,
        "--reason",
        "Composability contract verified",
        "--json",
      ]);
      expect(closed.code).toBe(7);
      expect(JSON.parse(closed.stdout)).toMatchObject({
        outcome: "partial_effect",
        matched_count: 1,
        closed_count: 1,
        unmatched_ids: ["pm-not-present"],
        unmatched_count: 1,
      });

      const filteredExisting = context.runCli([
        "close-many",
        "--ids",
        "pm-pipe-filtered-out",
        "--filter-tag",
        "piped",
        "--reason",
        "Should not match the additional filter",
        "--dry-run",
        "--json",
      ]);
      expect(filteredExisting.code).toBe(0);
      expect(JSON.parse(filteredExisting.stdout)).toMatchObject({
        matched_count: 0,
        unmatched_ids: [],
        unmatched_count: 0,
      });
    });
  });

  it("accepts - for every CLI flag that reads UTF-8 content from a file", async () => {
    await withTempPmPath(async (context) => {
      const created = context.runCli(
        [
          "create",
          "--id",
          "stdin-files",
          "--title",
          "stdin files",
          "--type",
          "Task",
          "--create-mode",
          "progressive",
          "--body-file",
          "-",
          "--json",
        ],
        { input: "# Body\n\nfrom stdin" },
      );
      expect(created.code).toBe(0);

      const updated = context.runCli(
        ["update", "pm-stdin-files", "--body-file", "-", "--json"],
        { input: "# Updated body\n\nfrom stdin" },
      );
      expect(updated.code).toBe(0);

      const described = context.runCli(
        [
          "update-many",
          "--ids",
          "pm-stdin-files",
          "--description",
          "-",
          "--json",
        ],
        { input: "-" },
      );
      expect(described.code).toBe(0);

      const dashCreated = context.runCli(
        [
          "create",
          "--id",
          "dash-body-file",
          "--title",
          "dash body file",
          "--type",
          "Task",
          "--create-mode",
          "progressive",
          "--body-file",
          "-",
          "--json",
        ],
        { input: "-" },
      );
      expect(dashCreated.code).toBe(0);

      const dashBodyPath = path.join(context.tempRoot, "dash-body.md");
      await writeFile(dashBodyPath, "-", "utf8");
      const dashUpdated = context.runCli(
        [
          "update",
          "pm-dash-body-file",
          "--body-file",
          dashBodyPath,
          "--comment",
          "-",
          "--json",
        ],
        { input: "comment still consumes stdin" },
      );
      expect(dashUpdated.code).toBe(0);

      const dashItem = context.runCli([
        "get",
        "pm-dash-body-file",
        "--fields",
        "body,comments",
        "--json",
      ]);
      expect(dashItem.code).toBe(0);
      expect(JSON.parse(dashItem.stdout)).toMatchObject({
        item: {
          body: "-",
          comments: [
            expect.objectContaining({ text: "comment still consumes stdin" }),
          ],
        },
      });

      for (const command of ["comments", "notes", "learnings"] as const) {
        const result = context.runCli(
          [command, "pm-stdin-files", "--file", "-", "--json"],
          { input: `${command} from stdin` },
        );
        expect(result.code).toBe(0);
      }

      const item = context.runCli([
        "get",
        "pm-stdin-files",
        "--fields",
        "body,description,comments,notes,learnings",
        "--json",
      ]);
      expect(item.code).toBe(0);
      expect(JSON.parse(item.stdout)).toMatchObject({
        item: {
          body: "# Updated body\n\nfrom stdin",
          description: "-",
          comments: [expect.objectContaining({ text: "comments from stdin" })],
          notes: [expect.objectContaining({ text: "notes from stdin" })],
          learnings: [
            expect.objectContaining({ text: "learnings from stdin" }),
          ],
        },
      });

      expectCompetingStdinConsumers(
        context,
        [
          "create",
          "--title",
          "conflicting stdin",
          "--description",
          "-",
          "--body-file",
          " - ",
          "--json",
        ],
        "one stream cannot supply two fields",
      );

      expectCompetingStdinConsumers(
        context,
        [
          "create",
          "--title",
          "conflicting whitespace stdin",
          "--description",
          " - ",
          "--body-file",
          "-",
          "--json",
        ],
        "one stream still cannot supply two fields",
      );

      expectCompetingStdinConsumers(
        context,
        ["update-many", "--ids", " - ", "--body", "-", "--json"],
        "pm-stdin-files",
      );
    });
  });
});
