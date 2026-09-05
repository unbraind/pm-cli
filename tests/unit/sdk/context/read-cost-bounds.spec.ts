import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  measureItemMetadataReadWork,
  recordContextUsageServing,
  recordContextUsageDelivery,
  runGet,
} from "../../../../src/sdk/query.js";
import { listAllItemMetadata, listAllItemMetadataLight, listAllItemMetadataWithBody } from "../../../../src/core/store/item-store.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";
import { applyReadOutputSessionReferences, attachReadOutputSessionReceipt, parseReadOutputSession, type PmReadOutputSessionReceipt, type PmReadOutputSessionState } from "../../../../src/sdk/read-output-session.js";

describe("agent read cost bounds", () => {
  it("keeps workspace activity visible without emitting unusable session identities", () => {
    const state: PmReadOutputSessionState = { version: 1, id: "orientation", token_budget: 20000, spent_tokens: 0, seen_item_ids: [] };
    const activity = ["_workspace", "", "bad id", "x".repeat(129), "pm-valid"].map((id) => ({ id, title: "Visible activity" }));
    const result = attachReadOutputSessionReceipt({ activity }, state);
    const receipt = result.read_session as PmReadOutputSessionReceipt;
    expect(parseReadOutputSession(receipt.next_state)).toEqual(receipt.next_state);
    expect(receipt.next_state.seen_item_ids).toEqual(["pm-valid"]);
    const next = applyReadOutputSessionReferences({ activity }, receipt.next_state);
    expect(next.activity).toEqual([...activity.slice(0, 4), { id: "pm-valid", context_ref: "session:orientation:pm-valid" }]);
  });

  it("requires an explicit deep or children projection for a container rollup", async () => {
    await withTempPmPath(async (context) => {
      const created = context.runCli(
        ["create", "--title", "Read cost container", "--type", "Epic", "--json"],
        { expectJson: true },
      ).json as { item: { id: string } };
      context.runCli([
        "create", "--title", "Direct child", "--type", "Task",
        "--parent", created.item.id,
      ]);
      const ordinary = await runGet(created.item.id, { path: context.pmPath });
      expect(ordinary.children).toBeUndefined();
      expect((await runGet(created.item.id, { path: context.pmPath }, {
        fields: "id,children",
      })).children?.count).toBe(1);
    });
  });

  it("measures real full, light and body enumeration with isolated nested async scopes", async () => {
    await withTempPmPath(async (context) => {
      context.runCli(["create", "--title", "Observed metadata", "--type", "Task"]);
      const releaseIdle = Promise.withResolvers<void>();
      const activePromise = measureItemMetadataReadWork(async () => {
          await listAllItemMetadata(context.pmPath);
          const nested = await measureItemMetadataReadWork(() => listAllItemMetadataLight(context.pmPath));
          expect(nested.work).toEqual({ enumeration_calls: 1, metadata_rows: 1 });
          await listAllItemMetadataWithBody(context.pmPath);
          return "completed";
        });
      const idlePromise = measureItemMetadataReadWork(() => releaseIdle.promise);
      const active = await activePromise;
      releaseIdle.resolve();
      const idle = await idlePromise;
      const releaseOutside = Promise.withResolvers<void>();
      const outside = measureItemMetadataReadWork(() => releaseOutside.promise);
      await listAllItemMetadata(context.pmPath);
      releaseOutside.resolve();
      expect((await outside).work.enumeration_calls).toBe(0);
      expect(active).toEqual({ result: "completed", work: { enumeration_calls: 3, metadata_rows: 3 } });
      expect(idle.work).toEqual({ enumeration_calls: 0, metadata_rows: 0 });
      await expect(measureItemMetadataReadWork(() => { throw new Error("operation failed"); })).rejects.toThrow("operation failed");
      expect((await measureItemMetadataReadWork(() => "after failure")).work.enumeration_calls).toBe(0);
    });
  });

  it("bounds persisted candidate rows and keeps the byte ceiling reachable", async () => {
    const pmRoot = await mkdtemp(path.join(os.tmpdir(), "pm-read-bounds-"));
    try {
      const rows = Array.from({ length: 10_000 }, (_, index) => ({
        id: `pm-${index}`, rank: index + 1, included: index < 10,
      }));
      for (let index = 0; index < 40; index += 1) {
        const receipt = await recordContextUsageServing({
          pmRoot, author: "agent", surface: "context", profile: "orient", rows,
        });
        await recordContextUsageDelivery({
          pmRoot, receipt, deliveredItemIds: ["pm-0", "pm-9999"], resultOmitted: false,
        });
      }
      const target = path.join(pmRoot, "runtime", "context-usage.jsonl");
      expect((await stat(target)).size).toBeLessThanOrEqual(262_144);
      const events = (await readFile(target, "utf8")).trim().split("\n")
        .map((line) => JSON.parse(line) as { kind: string; rows?: unknown[] });
      expect(events.filter((event) => event.kind === "serve").length).toBeGreaterThan(0);
      for (const event of events) {
        if (event.kind === "serve") expect(event.rows?.length).toBeLessThanOrEqual(256);
      }
    } finally {
      await rm(pmRoot, { recursive: true, force: true });
    }
  });
});
