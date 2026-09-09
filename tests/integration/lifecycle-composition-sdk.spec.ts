import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  PmClient,
  buildPmActionToolInputSchema,
  runAction,
  type StartTaskResult,
  type PauseTaskResult,
  type CloseTaskResult,
} from "../../src/sdk/index.js";
import { createTestItemId } from "../helpers/itemFactory.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";
import { markMcpMutationTransportInput } from "../../src/sdk/runtime-input.js";

describe("SDK lifecycle composition", () => {
  it("preserves MCP literal dashes through canonical ownership compositions", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "MCP literal composition", createMode: "progressive" });
      for (const [action, controls, status] of [
        ["claim", { start: true }, "in_progress"],
        ["release", { pause: true }, "open"],
      ] as const) {
        await runAction(markMcpMutationTransportInput({ action, id, path: context.pmPath, noExtensions: true, options: { ...controls, body: "-" } }));
        expect((await new PmClient({ pmRoot: context.pmPath }).get(id)).item).toMatchObject({ status, body: "-" });
      }
    });
  });

  it("returns typed compound receipts and persists inline closure evidence", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "SDK lifecycle", createMode: "progressive" });
      const client = new PmClient({ pmRoot: context.pmPath, noExtensions: true });
      const started = await client.claim(id, { start: true });
      expectTypeOf(started).toEqualTypeOf<StartTaskResult>();
      expect(started.update.item.status).toBe("in_progress");
      const paused = await client.release(id, { pause: true });
      expectTypeOf(paused).toEqualTypeOf<PauseTaskResult>();
      expect(paused.update.item.status).toBe("open");
      await client.claim(id);
      const closed = await client.close(id, "Verified", {
        releaseAssignment: true,
        resolution: "Implemented",
        expectedResult: "Evidence and assignment persist correctly",
        actualResult: "Evidence recorded; assignment released",
        validateClose: "warn",
      });
      expectTypeOf(closed).toEqualTypeOf<CloseTaskResult>();
      expect(closed.close.item).toMatchObject({ status: "closed", resolution: "Implemented" });
      const current = await client.get(id);
      expect(current.item.assignee).toBeUndefined();
      expect(current.item.actual_result).toBe("Evidence recorded; assignment released");
    });
  });

  it("hoists flat transport controls and refuses incompatible selection before mutation", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "Transport lifecycle", createMode: "progressive" });
      const common = { id, path: context.pmPath, noExtensions: true };
      await expect(runAction({ ...common, action: "claim", start: true, ifAvailable: true })).rejects.toThrow("cannot be combined");
      expect((await new PmClient({ pmRoot: context.pmPath }).get(id)).item.status).toBe("open");
      expect(await runAction({ ...common, action: "claim", start: true })).toMatchObject({ action: "start_task" });
      expect(await runAction({ ...common, action: "release", pause: true })).toMatchObject({ action: "pause_task" });
      expect(await runAction({ ...common, action: "close", reason: "Verified", releaseAssignment: true, options: { validateClose: "warn" } })).toMatchObject({ action: "close_task" });
    });
  });

  it("rejects incompatible ranked starts and preserves ownership when close validation fails", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "Refusal preserves ownership", createMode: "progressive" });
      const client = new PmClient({ pmRoot: context.pmPath, noExtensions: true });
      await expect(client.claim(id, { start: true, next: true })).rejects.toThrow("cannot be combined");
      expect((await client.get(id)).item.assignee).toBeUndefined();
      await client.claim(id, { start: true, force: true });
      const claimed = (await client.get(id)).item.assignee;
      await expect(client.close(id, "", { releaseAssignment: true, validateClose: "strict" })).rejects.toThrow();
      expect((await client.get(id)).item).toMatchObject({ status: "in_progress", assignee: claimed });
      await client.release(id, { pause: true, force: true });
      expect((await client.get(id)).item.assignee).toBeUndefined();
    });
  });

  it("resolves composition statuses through a custom workflow", async () => {
    await withTempPmPath(async (context) => {
      const statuses = [
        { id: "queued", roles: ["active", "default_open"] },
        { id: "building", aliases: ["in_progress"], roles: ["active"] },
        { id: "shipped", roles: ["terminal", "terminal_done", "default_close"] },
        { id: "dropped", roles: ["terminal", "terminal_canceled", "default_cancel"] },
      ];
      const workflow = { open_status: "queued", close_status: "shipped", canceled_status: "dropped" };
      await mkdir(path.join(context.pmPath, "schema"), { recursive: true });
      await writeFile(path.join(context.pmPath, "schema", "statuses.json"), JSON.stringify({ statuses }));
      await writeFile(path.join(context.pmPath, "schema", "workflows.json"), JSON.stringify({ workflow }));
      const client = new PmClient({ pmRoot: context.pmPath, noExtensions: true });
      const created = await client.create({ title: "Custom lifecycle", type: "Task", status: "queued", createMode: "progressive" });
      const id = created.item.id;
      expect((await client.claim(id, { start: true })).update.item.status).toBe("building");
      expect((await client.release(id, { pause: true })).update.item.status).toBe("queued");
      expect((await client.close(id, "Verified custom workflow", { releaseAssignment: true, validateClose: "warn" })).close.item.status).toBe("shipped");
    });
  });

  it("keeps scheduling start text separate from the claim boolean schema", () => {
    expect(buildPmActionToolInputSchema("claim")).toMatchObject({ properties: { start: { type: "boolean" } } });
    expect(buildPmActionToolInputSchema("meet")).toMatchObject({ properties: { start: { type: "string" } } });
    expect(buildPmActionToolInputSchema("release")).toMatchObject({ properties: { pause: { type: "boolean" } } });
    expect(buildPmActionToolInputSchema("close")).toMatchObject({ properties: { releaseAssignment: { type: "boolean" } } });
  });
});
