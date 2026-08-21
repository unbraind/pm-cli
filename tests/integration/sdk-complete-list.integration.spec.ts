import { describe, expect, it } from "vitest";
import {
  PmClient,
  PmCompleteListValidationError,
  certifyCompleteListResult,
  listAllComplete,
} from "../../src/sdk/runtime.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

describe("complete list SDK acceptance", () => {
  it("preserves the canonical full projection when body inclusion is omitted", async () => {
    await withTempPmPath(async (context) => {
      context.runCli([
        "create",
        "--create-mode",
        "progressive",
        "--title",
        "Default complete-list row",
        "--type",
        "Task",
        "--status",
        "open",
      ]);

      const client = new PmClient({
        pmRoot: context.pmPath,
        noExtensions: true,
      });
      const result = await client.listAllComplete();

      expect(result.complete_list.full_projection).toBe(true);
      expect(result.projection).toEqual({ mode: "full", fields: null });
    });
  });

  it("returns open and terminal items with bodies from a fresh tracker", async () => {
    await withTempPmPath(async (context) => {
      const open = context.runCli(
        [
          "create",
          "--create-mode",
          "progressive",
          "--title",
          "Open complete-list row",
          "--type",
          "Task",
          "--status",
          "open",
          "--body",
          "open body",
          "--json",
        ],
        { expectJson: true },
      ).json as { item: { id: string } };
      const closed = context.runCli(
        [
          "create",
          "--create-mode",
          "progressive",
          "--title",
          "Closed complete-list row",
          "--type",
          "Task",
          "--status",
          "closed",
          "--close-reason",
          "Acceptance fixture",
          "--body",
          "closed body",
          "--json",
        ],
        { expectJson: true },
      ).json as { item: { id: string } };

      const client = new PmClient({
        pmRoot: context.pmPath,
        noExtensions: true,
      });
      const fromClient = await client.listAllComplete({ includeBody: true });
      const fromFunction = await listAllComplete(
        { includeBody: true },
        { pmRoot: context.pmPath, noExtensions: true },
      );

      expect(fromClient.complete_list.item_count).toBe(2);
      expect(fromFunction.complete_list).toEqual(fromClient.complete_list);
      expect(fromClient.items.map((item) => item.id).sort()).toEqual(
        [open.item.id, closed.item.id].sort(),
      );
      expect(fromClient.items.map((item) => item.body).sort()).toEqual([
        "closed body",
        "open body",
      ]);
    });
  });

  it("executes the typed canonical recovery against a fresh tracker", async () => {
    await withTempPmPath(async (context) => {
      const seededIds = Array.from({ length: 3 }, (_, index) => {
        const created = context.runCli(
          [
            "create",
            "--create-mode",
            "progressive",
            "--title",
            `Budget-sensitive complete-list row ${index + 1}`,
            "--description",
            `${index + 1}:`.padEnd(10_000, String(index + 1)),
            "--type",
            "Task",
            "--status",
            "open",
            "--json",
          ],
          { expectJson: true },
        ).json as { item: { id: string } };
        return created.item.id;
      });

      let recovery: string | undefined;
      try {
        certifyCompleteListResult({ items: [] });
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(PmCompleteListValidationError);
        if (error instanceof PmCompleteListValidationError) {
          recovery = error.receipt.recovery.suggested_retry;
        }
      }
      expect(recovery).toBe(
        "pm list --all --output-include full --strict-read --no-truncate --output-budget unbounded --output-limit unbounded --json",
      );
      if (recovery === undefined) {
        throw new Error("Complete-list validation did not provide recovery.");
      }
      const recovered = context.runCli(recovery.split(" ").slice(1), {
        expectJson: true,
      }).json as {
        items: Array<{ id: string; description: string }>;
        omission_receipt: {
          has_omissions: boolean;
          omitted_field_group_count: number;
          omitted_field_groups: string[];
        };
        read_output: {
          within_budget: boolean;
          strings_compacted: boolean;
          rows_compacted: boolean;
          result_omitted: boolean;
        };
      };
      const certified = certifyCompleteListResult(recovered);
      expect(certified.complete_list).toMatchObject({
        item_count: seededIds.length,
        source_complete: true,
        no_omissions: true,
        unbounded: true,
      });
      expect(recovered.items.map((item) => item.id).sort()).toEqual(
        seededIds.sort(),
      );
      expect(
        recovered.items.every((item) => item.description.length === 10_000),
      ).toBe(true);
      expect(recovered.read_output).toMatchObject({
        within_budget: true,
        strings_compacted: false,
        rows_compacted: false,
        result_omitted: false,
      });
      expect(recovered.omission_receipt).toEqual({
        has_omissions: false,
        omitted_field_group_count: 0,
        omitted_field_groups: [],
      });
    });
  });
});
