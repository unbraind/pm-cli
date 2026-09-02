import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectContextUsageDeliveredItemIds,
  PmClient,
} from "../../src/sdk/index.js";
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
      for (const fixture of [
        { id: "pm-first", title: "First", type: "Task" },
        { id: "pm-second", title: "Second", type: "Task" },
        { id: "pm-third", title: "Third", type: "Task" },
        { id: "pm-decision", title: "Decision", type: "Decision" },
        { id: "pm-blocker", title: "Blocker", type: "Task" },
        {
          id: "pm-blocked",
          title: "Blocked",
          type: "Task",
          blockedBy: "pm-blocker",
        },
        {
          id: "pm-held",
          title: "Held",
          type: "Task",
          assignee: "another-agent",
        },
      ]) {
        expect(
          context.runCli([
            "create",
            "--json",
            "--create-mode",
            "progressive",
            "--id",
            fixture.id,
            "--title",
            fixture.title,
            "--description",
            `${fixture.title} context`,
            "--type",
            fixture.type,
            "--status",
            "open",
            ...(fixture.blockedBy ? ["--blocked-by", fixture.blockedBy] : []),
            ...(fixture.assignee ? ["--assignee", fixture.assignee] : []),
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
        decision_needed?: Array<{ id: string }>;
        blocked?: Array<{ id: string }>;
        held_by_others?: Array<{ id: string }>;
      };
      const emittedIds = collectContextUsageDeliveredItemIds(
        deliveredResult,
        "next",
      );
      expect(emittedIds.length).toBeGreaterThan(0);
      expect(emittedIds).toEqual(
        expect.arrayContaining(["pm-decision", "pm-blocked", "pm-held"]),
      );
      expect((await deliveries(context.pmPath)).at(-1)).toEqual(
        expect.objectContaining({
          surface: "next",
          result_omitted: false,
          delivered_item_ids: emittedIds,
        }),
      );
      const serving = (
        await fs.readFile(
          path.join(context.pmPath, "runtime", "context-usage.jsonl"),
          "utf8",
        )
      )
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as {
              kind: string;
              packed_item_ids?: string[];
            },
        )
        .filter((event) => event.kind === "serve")
        .at(-1);
      expect(serving).toBeDefined();
      expect(serving?.packed_item_ids).toEqual(expect.any(Array));
      for (const id of ["pm-decision", "pm-blocked", "pm-held"]) {
        expect(serving?.packed_item_ids).not.toContain(id);
      }

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
      const emittedIds = collectContextUsageDeliveredItemIds(result, "next");
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

  it("finalizes active-extension-host delivery in the requested workspace", async () => {
    await withTempPmPath(async (context) => {
      const created = context.runCli(
        [
          "create",
          "--json",
          "--title",
          "Active host delivery",
          "--description",
          "Requested workspace egress fixture",
          "--type",
          "Task",
          "--status",
          "open",
        ],
        { expectJson: true },
      );
      expect(created.code).toBe(0);
      const createdId = (created.json as { item: { id: string } }).item.id;
      const previousPmPath = process.env.PM_PATH;
      delete process.env.PM_PATH;
      try {
        const result = await PmClient.forActiveExtensionHost({
          cwd: context.tempRoot,
        }).next({ outputBudget: "unbounded" });
        const emittedIds = collectContextUsageDeliveredItemIds(result, "next");
        expect(emittedIds).toContain(createdId);
        expect((await deliveries(context.pmPath)).at(-1)).toMatchObject({
          surface: "next",
          result_omitted: false,
          delivered_item_ids: emittedIds,
        });
      } finally {
        if (previousPmPath === undefined) delete process.env.PM_PATH;
        else process.env.PM_PATH = previousPmPath;
      }
    });
  });
});
