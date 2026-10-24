import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PmClient, runCloseMany, runUpdateMany } from "../../../src/sdk/index.js";
import { loadMutationCheckpoint, writeMutationCheckpoint } from "../../../src/core/checkpoint/mutation-checkpoint.js";
import { withCheckpointMutation } from "../../../src/core/checkpoint/mutation-context.js";
import { readSettings, writeSettings } from "../../../src/core/store/settings.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

describe("guarded bulk checkpoint rollback (pm-gh1563, pm-gh1564)", () => {
  it.each(["update", "close"] as const)("undoes %s effects while retaining later peer context and repeat safety", async (mode) => {
    await withTempPmPath(async ({ pmPath }) => {
      const client = new PmClient({ pmRoot: pmPath, noExtensions: true });
      const id = (await client.create({ type: "Task", title: "Original", priority: 2 })).item.id;
      const global = { path: pmPath };
      const batch = mode === "update"
        ? await runUpdateMany({ list: { ids: id }, update: { priority: 0, message: "custom batch message" } }, global)
        : await runCloseMany({ list: { ids: id }, reason: "Batch done", message: "custom batch message" }, global);
      await expect(loadMutationCheckpoint(pmPath, `${mode}-many`, batch.checkpoint!.id, 1)).rejects.toThrow("unsupported schema version");
      await client.comments(id, { add: "New peer evidence" });
      await client.update(id, { title: "Peer continued implementation" });
      const rollback = () => mode === "update"
        ? runUpdateMany({ list: {}, update: {}, rollback: batch.checkpoint!.id }, global)
        : runCloseMany({ rollback: batch.checkpoint!.id }, global);
      expect(await rollback()).toMatchObject({ restored_count: 1, failed_count: 0 });
      const after = (await client.get(id, { full: true })).item;
      expect(after).toMatchObject({ title: "Peer continued implementation", priority: 2, status: "open" });
      expect(after.comments?.map((entry) => entry.text)).toContain("New peer evidence");
      const historyPath = path.join(pmPath, "history", `${id}.jsonl`);
      const history = await readFile(historyPath, "utf8");
      expect(await rollback()).toMatchObject({ restored_count: 0, skipped_count: 1, failed_count: 0 });
      expect(await readFile(historyPath, "utf8")).toBe(history);
    });
  });

  it("refuses a drifted batch field atomically and retains the complete peer state and history", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const client = new PmClient({ pmRoot: pmPath, noExtensions: true });
      const id = (await client.create({ type: "Task", title: "Original", priority: 2 })).item.id;
      const global = { path: pmPath };
      const batch = await runUpdateMany({ list: { ids: id }, update: { title: "Batch title", priority: 0 } }, global);
      await client.comments(id, { add: "Peer evidence" });
      await client.update(id, { priority: 1 });
      const before = (await client.get(id, { full: true })).item;
      const historyPath = path.join(pmPath, "history", `${id}.jsonl`);
      const history = await readFile(historyPath, "utf8");
      const result = await runUpdateMany({ list: {}, update: {}, rollback: batch.checkpoint!.id }, global);
      expect(result).toMatchObject({ restored_count: 0, failed_count: 1, outcome: "dependency_failed", exit_code: 5 });
      expect(result.rows?.[0]).toMatchObject({ status: "failed", error: expect.stringContaining("priority") });
      expect((await client.get(id, { full: true })).item).toEqual(before);
      expect(await readFile(historyPath, "utf8")).toBe(history);
    });
  });

  it("reverses body, added fields, removed fields and collections using actual committed values", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const client = new PmClient({ pmRoot: pmPath, noExtensions: true });
      const id = (await client.create({ type: "Task", title: "Original", body: "Original body", deadline: "2027-01-01T00:00:00.000Z" })).item.id;
      const batch = await runUpdateMany({ list: { ids: id }, update: { body: "Batch body", goal: "Batch goal", tags: "batch", unset: ["deadline"], comment: ["text=Batch evidence"] } }, { path: pmPath });
      await client.notes(id, { add: "Peer note" });
      const result = await runUpdateMany({ list: {}, update: {}, rollback: batch.checkpoint!.id }, { path: pmPath });
      expect(result).toMatchObject({ restored_count: 1, failed_count: 0 });
      const after = (await client.get(id, { full: true })).item;
      expect(after.body).toBe("Original body");
      expect(after.goal).toBeUndefined();
      expect(after.deadline).toBe("2027-01-01T00:00:00.000Z");
      expect(after.tags).toEqual([]);
      expect(after.comments).toEqual([]);
      expect(after.notes?.map((entry) => entry.text)).toContain("Peer note");
    });
  });

  it("attributes nested update-to-close effects even when the nested writer replaces the history message", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const client = new PmClient({ pmRoot: pmPath, noExtensions: true });
      const id = (await client.create({ type: "Task", title: "Original", priority: 2 })).item.id;
      const batch = await runUpdateMany({ list: { ids: id }, update: { title: "Batch title", status: "closed", closeReason: "Batch done" } }, { path: pmPath });
      await client.comments(id, { add: "Peer context after close" });
      const result = await runUpdateMany({ list: {}, update: {}, rollback: batch.checkpoint!.id }, { path: pmPath });
      expect(result).toMatchObject({ restored_count: 1, failed_count: 0 });
      const after = (await client.get(id, { full: true })).item;
      expect(after).toMatchObject({ title: "Original", status: "open" });
      expect(after.comments?.map((entry) => entry.text)).toContain("Peer context after close");
    });
  });

  it.each(["contiguous", "intervening-peer", "net-zero"] as const)("handles %s committed effect sequences without consuming peer changes", async (sequence) => {
    await withTempPmPath(async ({ pmPath }) => {
      const client = new PmClient({ pmRoot: pmPath, noExtensions: true });
      const item = (await client.create({ type: "Task", title: "Original", priority: 2 })).item;
      const checkpointId = "nested-effects";
      await writeMutationCheckpoint(pmPath, "update-many", checkpointId, { schema_version: 2, rollback_strategy: "guarded_inverse", items: [{ id: item.id, target_updated_at: item.updated_at }] });
      const context = { pmRoot: pmPath, itemId: item.id, checkpointId };
      await withCheckpointMutation(context, () => client.update(item.id, { priority: 1 }));
      if (sequence === "intervening-peer") await client.update(item.id, { priority: 3 });
      await withCheckpointMutation(context, () => client.update(item.id, { priority: sequence === "net-zero" ? 2 : 0 }));
      const result = await runUpdateMany({ list: {}, update: {}, rollback: checkpointId }, { path: pmPath });
      expect(result).toMatchObject({
        restored_count: sequence === "contiguous" ? 1 : 0,
        skipped_count: sequence === "net-zero" ? 1 : 0,
        failed_count: sequence === "intervening-peer" ? 1 : 0,
      });
      expect((await client.get(item.id)).item.priority).toBe(sequence === "intervening-peer" ? 0 : 2);
      if (sequence === "intervening-peer") expect(result.rows?.[0]?.error).toContain("intervening edit");
    });
  });

  it("skips failed forward rows without losing their later evidence", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const client = new PmClient({ pmRoot: pmPath, noExtensions: true, author: "owner" });
      const good = (await client.create({ type: "Task", title: "Good", priority: 2 })).item.id;
      const held = (await client.create({ type: "Task", title: "Held", priority: 2, assignee: "peer" })).item.id;
      const settings = await readSettings(pmPath);
      settings.governance.preset = "custom";
      settings.governance.ownership_enforcement = "strict";
      await writeSettings(pmPath, settings);
      const batch = await runUpdateMany({ list: { ids: `${good},${held}` }, update: { priority: 0, author: "owner" } }, { path: pmPath });
      expect(batch).toMatchObject({ updated_count: 1, failed_count: 1 });
      const peer = new PmClient({ pmRoot: pmPath, noExtensions: true, author: "peer" });
      await peer.comments(held, { add: "Peer evidence on failed row" });
      const result = await runUpdateMany({ list: {}, update: { author: "peer" }, rollback: batch.checkpoint!.id }, { path: pmPath });
      expect(result).toMatchObject({ restored_count: 1, skipped_count: 1, failed_count: 0 });
      expect(result.ids).toEqual([good]);
      const after = (await peer.get(held, { full: true })).item;
      expect(after.priority).toBe(2);
      expect(after.comments?.map((entry) => entry.text)).toContain("Peer evidence on failed row");
    });
  });

  it.each(["update", "close"] as const)("refuses unsafe legacy %s checkpoints without rewriting live context", async (mode) => {
    await withTempPmPath(async ({ pmPath }) => {
      const client = new PmClient({ pmRoot: pmPath, noExtensions: true });
      const item = (await client.create({ type: "Task", title: "Preserved" })).item;
      await writeMutationCheckpoint(pmPath, `${mode}-many`, "legacy", { schema_version: 1, items: [{ id: item.id, target_updated_at: item.updated_at }] });
      const operation = mode === "update"
        ? runUpdateMany({ list: {}, update: {}, rollback: "legacy" }, { path: pmPath })
        : runCloseMany({ rollback: "legacy" }, { path: pmPath });
      await expect(operation).rejects.toThrow(/unsupported schema version.*pm history.*pm restore/);
      expect((await client.get(item.id)).item.title).toBe("Preserved");
    });
  });

  it("refuses a current-schema checkpoint that lacks attributed recovery semantics", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const client = new PmClient({ pmRoot: pmPath, noExtensions: true });
      const item = (await client.create({ type: "Task", title: "Preserved" })).item;
      await writeMutationCheckpoint(pmPath, "update-many", "unattributed", { schema_version: 2, items: [{ id: item.id, target_updated_at: item.updated_at }] });
      await expect(runUpdateMany({ list: {}, update: {}, rollback: "unattributed" }, { path: pmPath })).rejects.toThrow(/no attributable inverse effects/);
      expect((await client.get(item.id)).item.title).toBe("Preserved");
    });
  });

  it("refuses corrupted attribution rather than trusting an unverified history marker", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const client = new PmClient({ pmRoot: pmPath, noExtensions: true });
      const id = (await client.create({ type: "Task", title: "Original", priority: 2 })).item.id;
      const batch = await runUpdateMany({ list: { ids: id }, update: { priority: 0 } }, { path: pmPath });
      const historyPath = path.join(pmPath, "history", `${id}.jsonl`);
      const lines = (await readFile(historyPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      lines.at(-1).message = "tampered attribution";
      const tampered = lines.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
      await writeFile(historyPath, tampered);
      const result = await runUpdateMany({ list: {}, update: {}, rollback: batch.checkpoint!.id }, { path: pmPath });
      expect(result).toMatchObject({ restored_count: 0, failed_count: 1 });
      expect(result.rows?.[0]?.error).toContain("verification failed");
      expect((await client.get(id)).item.priority).toBe(0);
      expect(await readFile(historyPath, "utf8")).toBe(tampered);
    });
  });

  it.each([true, false, 123, null, " ", "../outside"])("rejects invalid direct-SDK rollback %j before any forward operation", async (rollback) => {
    await withTempPmPath(async ({ pmPath }) => {
      const client = new PmClient({ pmRoot: pmPath, noExtensions: true });
      const id = (await client.create({ type: "Task", title: "Preserved", priority: 2 })).item.id;
      const before = (await client.get(id, { full: true })).item;
      const historyPath = path.join(pmPath, "history", `${id}.jsonl`);
      const history = await readFile(historyPath, "utf8");
      await expect(runUpdateMany({ list: { ids: id }, update: { title: "Never apply" }, rollback: rollback as never }, { path: pmPath })).rejects.toThrow(/rollback/);
      expect((await client.get(id, { full: true })).item).toEqual(before);
      expect(await readFile(historyPath, "utf8")).toBe(history);
      await expect(runCloseMany({ list: { ids: id }, reason: "Never close", rollback: rollback as never }, { path: pmPath })).rejects.toThrow(/rollback/);
      expect((await client.get(id, { full: true })).item).toEqual(before);
      expect(await readFile(historyPath, "utf8")).toBe(history);
    });
  });
});
