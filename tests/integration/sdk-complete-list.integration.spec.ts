import { describe, expect, it } from "vitest";
import {
  PmClient,
  PmCompleteListValidationError,
  certifyCompleteListResult,
  listAllComplete,
} from "../../src/sdk/runtime.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";
import { createTestItemId } from "../helpers/itemFactory.js";

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
      expect(result.read_output.legacy_aliases_used).toEqual([]);
      expect(result.read_output.migration_hints).toEqual([]);
      expect(result.read_output.canonical_options_used).toEqual([
        "--output-include",
        "--output-limit",
        "--output-budget",
      ]);

      const explicitAliases = await client.list({
        excludeTerminal: false,
        full: true,
        noTruncate: true,
        outputBudget: "unbounded",
        outputLimit: "unbounded",
      });
      expect(explicitAliases.read_output?.legacy_aliases_used).toEqual([
        "--full",
        "--no-truncate",
      ]);
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
        legacy_aliases_used: ["--no-truncate"],
      });
      expect(recovered.omission_receipt).toEqual({
        has_omissions: false,
        omitted_field_group_count: 0,
        omitted_field_groups: [],
      });
    });
  });

  it("pm-gh1728: executing the emitted recovery returns the bodies, edges, learnings and counts the refused request asked for", async () => {
    await withTempPmPath(async (context) => {
      const parent = createTestItemId(context, { title: "Recovery parent", body: "parent body" });
      createTestItemId(context, { title: "Recovery child", body: "child body", parent });
      const empty = createTestItemId(context, { title: "Recovery empty body", body: "" });
      expect(context.runCli(["learnings", empty, "--add", "A durable lesson"]).code).toBe(0);
      const client = new PmClient({ pmRoot: context.pmPath, noExtensions: true });
      type Row = { id: string; body?: string; parent?: string; learnings?: unknown[] };
      const recoveryFor = async (includeBody: boolean | undefined) => {
        const page = await client.list({ excludeTerminal: false, full: true, outputLimit: 1, ...(includeBody === undefined ? {} : { includeBody }) });
        try {
          certifyCompleteListResult(page);
        } catch (error: unknown) {
          if (error instanceof PmCompleteListValidationError) return error.receipt.recovery;
        }
        throw new Error("Expected the one-row page to be refused");
      };
      const summarize = (items: Row[]) =>
        items.map(({ id, body, parent: edge, learnings }) => ({ id, body, parent: edge, learnings: learnings?.length ?? 0 })).sort((a, b) => a.id.localeCompare(b.id));
      for (const includeBody of [true, false, undefined]) {
        const recovery = await recoveryFor(includeBody);
        const argv = recovery.suggested_retry.split(" ").slice(1);
        const retried = context.runCli(argv, { expectJson: true });
        expect(retried.code, recovery.suggested_retry).toBe(0);
        const viaCli = certifyCompleteListResult(retried.json);
        const viaSdk = await client.listAllComplete(includeBody === true ? { includeBody: true } : {});
        expect(viaCli.complete_list.item_count).toBe(3);
        expect(summarize(viaCli.items as Row[])).toEqual(summarize(viaSdk.items as Row[]));
        const bodies = (viaCli.items as Row[]).map((item) => item.body).filter((body) => body !== undefined).sort();
        // Bodies come back exactly when they were asked for; the empty body stays an empty string.
        expect(bodies).toEqual(includeBody === true ? ["", "child body", "parent body"] : []);
        expect(recovery.sdk).toBe(includeBody === true ? "await client.listAllComplete({ includeBody: true })" : "await client.listAllComplete()");
      }
    });
  });
});
