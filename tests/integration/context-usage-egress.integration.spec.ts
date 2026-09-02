import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PmClient } from "../../src/sdk/index.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

type LedgerDelivery = {
  kind: "delivery";
  surface: "context" | "next";
  result_omitted: boolean;
  delivered_item_ids: string[];
};

async function deliveries(pmRoot: string): Promise<LedgerDelivery[]> {
  return (
    await fs.readFile(
      path.join(pmRoot, "runtime", "context-usage.jsonl"),
      "utf8",
    )
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { kind: string })
    .filter((event): event is LedgerDelivery => event.kind === "delivery");
}

describe("context usage egress receipts", () => {
  it("records CLI inclusions from emitted rows and zero rows for omitted output", async () => {
    await withTempPmPath(async (context) => {
      for (const title of ["First", "Second", "Third"]) {
        expect(
          context.runCli([
            "create",
            "--json",
            "--title",
            title,
            "--description",
            `${title} context`,
            "--type",
            "Task",
            "--status",
            "open",
          ]).code,
        ).toBe(0);
      }

      const delivered = context.runCli(["next", "--json"], {
        expectJson: true,
      });
      expect(delivered.code).toBe(0);
      const deliveredResult = delivered.json as {
        recommended?: { id: string } | null;
        ready: Array<{ id: string }>;
        decision_needed: Array<{ id: string }>;
        blocked: Array<{ id: string }>;
      };
      const emittedIds = [
        ...(deliveredResult.recommended
          ? [deliveredResult.recommended.id]
          : []),
        ...deliveredResult.ready.map((row) => row.id),
        ...deliveredResult.decision_needed.map((row) => row.id),
        ...deliveredResult.blocked.map((row) => row.id),
      ];
      expect(emittedIds.length).toBeGreaterThan(0);
      expect((await deliveries(context.pmPath)).at(-1)).toEqual(
        expect.objectContaining({
          surface: "next",
          result_omitted: false,
          delivered_item_ids: emittedIds,
        }),
      );

      const omitted = context.runCli(
        ["--output-budget", "1", "next", "--json", "--for", "execute"],
        { expectJson: true },
      );
      expect(omitted.code).toBe(2);
      expect((await deliveries(context.pmPath)).at(-1)).toEqual(
        expect.objectContaining({
          surface: "next",
          result_omitted: true,
          delivered_item_ids: [],
        }),
      );
    });
  });

  it("finalizes the same exact delivery contract through PmClient", async () => {
    await withTempPmPath(async (context) => {
      const created = context.runCli([
        "create",
        "--json",
        "--title",
        "SDK delivery",
        "--description",
        "SDK delivery fixture",
        "--type",
        "Task",
        "--status",
        "open",
      ]);
      expect(created.code).toBe(0);
      const result = await new PmClient({
        pmRoot: context.pmPath,
        noExtensions: true,
      }).next({ outputBudget: "unbounded" });
      const emittedIds = [
        ...(result.recommended ? [result.recommended.id] : []),
        ...result.ready.map((row) => row.id),
        ...result.decision_needed.map((row) => row.id),
        ...result.blocked.map((row) => row.id),
      ];
      expect(emittedIds.length).toBeGreaterThan(0);
      expect((await deliveries(context.pmPath)).at(-1)).toEqual(
        expect.objectContaining({
          surface: "next",
          result_omitted: false,
          delivered_item_ids: emittedIds,
        }),
      );
    });
  });
});
