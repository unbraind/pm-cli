import { describe, expect, it } from "vitest";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

describe("duplicates command integration", () => {
  it("discovers all-status clusters with bounded filters and actionable guidance", async () => {
    await withTempPmPath(async (context) => {
      for (const status of ["open", "closed"]) {
        const created = context.runCli(
          [
            "create",
            "--json",
            "--title",
            "Universal context duplicate",
            "--type",
            "Task",
            "--status",
            status,
            ...(status === "closed"
              ? ["--message", "seed closed duplicate fixture"]
              : []),
            "--create-mode",
            "progressive",
            "--allow-duplicate",
          ],
          { expectJson: true },
        );
        expect(created.code).toBe(0);
      }

      const allStatuses = context.runCli(
        ["duplicates", "--json", "--threshold", "1", "--limit", "5"],
        { expectJson: true },
      );
      expect(allStatuses.code).toBe(0);
      expect(allStatuses.json).toMatchObject({
        count: 1,
        clusters: [
          {
            canonical_id: expect.stringMatching(/^pm-/),
            close_command: expect.stringMatching(
              /^pm close <duplicate-id> --duplicate-of pm-/,
            ),
          },
        ],
        guidance: {
          strategy: "review_then_close_duplicate",
          command: "pm close <duplicate-id> --duplicate-of <canonical-id>",
        },
      });

      const explicitAllStatuses = context.runCli(
        [
          "duplicates",
          "--json",
          "--status",
          "all",
          "--threshold",
          "1",
          "--limit",
          "5",
        ],
        { expectJson: true },
      );
      expect(explicitAllStatuses.code).toBe(0);
      expect(explicitAllStatuses.json).toMatchObject({
        count: 1,
        filters: { statuses: null },
        cost: {
          item_count: allStatuses.json?.cost?.item_count,
        },
      });

      const filtered = context.runCli(
        [
          "duplicates",
          "--json",
          "--status",
          " OPEN ,, CLOSED ",
          "--threshold",
          "1",
          "--since",
          "2000-01-01T00:00:00.000Z",
          "--limit",
          "5",
        ],
        { expectJson: true },
      );
      expect(filtered.code).toBe(0);
      expect(filtered.json).toMatchObject({
        count: 1,
        filters: { statuses: ["open", "closed"] },
      });

      const mixedAll = context.runCli(
        ["duplicates", "--json", "--status", "all,open"],
        { expectJson: true },
      );
      expect(mixedAll.code).toBe(2);
      expect(mixedAll.stderr).toContain(
        "cannot be combined with other statuses",
      );

      const mixedUnknown = context.runCli(
        ["duplicates", "--json", "--status", "all,not-a-runtime-status"],
        { expectJson: true },
      );
      expect(mixedUnknown.code).toBe(2);
      expect(mixedUnknown.stderr).toContain("not-a-runtime-status");

      const invalid = context.runCli(
        ["duplicates", "--json", "--threshold", "2"],
        { expectJson: true },
      );
      expect(invalid.code).toBe(2);
      expect(invalid.stderr).toContain(
        "Similarity threshold must be a number from 0 to 1.",
      );
    });
  });
});
