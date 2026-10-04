/**
 * @module tests/unit/regressions/actionable-get-receipts
 *
 * Verifies current declared blocker state and truthful schedule disclosure
 * through real SDK mutations and item reads in disposable trackers.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { runCreate } from "../../../src/sdk/lifecycle/create.js";
import { runGet } from "../../../src/sdk/query/get.js";
import { resolveOutputOmissionReceipt } from "../../../src/sdk/output-projection.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

describe("actionable get receipts", () => {
  it("canonicalizes short blocker references without double-counting their persisted full-ID edges", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const global = { path: pmPath };
      const finished = await runCreate({ id: "pm-abcd", title: "Completed prerequisite", type: "Task", status: "closed", closeReason: "Delivered" }, global);
      const pending = await runCreate({ id: "pm-efgh", title: "Pending prerequisite", type: "Task" }, global);
      for (const target of [finished.item, pending.item]) {
        const created = await runCreate({ title: "Short-reference dependent", type: "Task", blockedBy: target.id.slice(3) }, global);
        const result = await runGet(created.item.id, global);
        expect(result.blockers).toEqual({ scope: "declared", closed_count: target.status === "closed" ? 1 : 0, open: target.status === "closed" ? [] : [{ id: target.id, title: target.title, status: target.status }] });
      }
    });
  });
  it("rejects a declared blocker whose file contains another item identity", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const global = { path: pmPath };
      const blocker = await runCreate({ title: "Open prerequisite", type: "Task" }, global);
      const unrelated = await runCreate({ title: "Unrelated completed work", type: "Task", status: "closed", closeReason: "Delivered" }, global);
      const created = await runCreate({ title: "Dependent work", type: "Task", blockedBy: blocker.item.id }, global);
      await fs.copyFile(path.join(pmPath, "tasks", `${unrelated.item.id}.toon`), path.join(pmPath, "tasks", `${blocker.item.id}.toon`));
      await expect(runGet(created.item.id, global)).rejects.toMatchObject({ context: { code: "item_identity_conflict" } });
    });
  });
  it("keeps nonportable legacy blocker text unresolved without reading outside item folders", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const global = { path: pmPath };
      const created = await runCreate({ title: "Legacy free-text prerequisite", type: "Task", blockedBy: "../../outside-item" }, global);
      await fs.copyFile(path.join(pmPath, "tasks", `${created.item.id}.toon`), path.join(pmPath, "..", "outside-item.toon"));
      await expect(runGet(created.item.id, global)).resolves.toMatchObject({ blockers: { open: [{ id: "../../outside-item", title: null, status: null }], closed_count: 0 } });
    });
  });
  it("resolves every declared blocker without certifying missing or external references", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const global = { path: pmPath };
      const first = await runCreate({ title: "First open prerequisite", type: "Task" }, global);
      const second = await runCreate({ title: "Second open prerequisite", type: "Task" }, global);
      const finished = await runCreate({ title: "Finished prerequisite", type: "Task", status: "closed", closeReason: "Delivered before dependent work" }, global);
      const created = await runCreate({
        title: "Dependent work", type: "Task", blockedBy: second.item.id,
        allowUnresolvedDeps: true,
        dep: [
          `id=${first.item.id},kind=blocked_by`,
          `id=${second.item.id},kind=blocked_by`,
          `id=${finished.item.id},kind=blocked_by`,
          "id=pm-missing,kind=blocked_by",
          "id=github:other/repo#1,kind=blocked_by",
        ],
      }, global);
      const result = await runGet(created.item.id, global);
      expect(result.item.blocked_by).toBeUndefined();
      expect(result.item.dependencies).toEqual(created.item.dependencies!.map(({ id, kind }) => ({ id, kind })));
      expect(resolveOutputOmissionReceipt("get", result as unknown as Record<string, unknown>)!.omitted_field_groups).toContainEqual({ name: "dependency_provenance", restore_with: "--fields dependencies" });
      for (const depth of ["brief", "deep"]) expect((await runGet(created.item.id, global, { depth })).item.dependencies).toEqual(result.item.dependencies);
      for (const options of [{ full: true }, { depth: "full" }, { fields: "dependencies" }, { fields: "item.dependencies" }]) {
        const complete = await runGet(created.item.id, global, options);
        expect(complete.item.dependencies).toEqual(created.item.dependencies);
        expect(resolveOutputOmissionReceipt("get", complete as unknown as Record<string, unknown>)!.omitted_field_groups.map((group) => group.name)).not.toContain("dependency_provenance");
      }
      expect((await runGet(created.item.id, global, { fields: "blocked_by" })).item.blocked_by).toBe(second.item.id);
      expect((await runGet(created.item.id, global, { full: true })).item.blocked_by).toBe(second.item.id);
      expect(result).toMatchObject({ blockers: { scope: "declared", closed_count: 1, open: expect.arrayContaining([
        { id: first.item.id, title: first.item.title, status: "open" },
        { id: second.item.id, title: second.item.title, status: "open" },
        { id: "pm-missing", title: null, status: null },
        expect.objectContaining({ id: "github:other/repo#1", status: null, external: true }),
      ]) } });
      expect(result.blockers!.open).toHaveLength(4);
      expect(resolveOutputOmissionReceipt("get", structuredClone(result) as unknown as Record<string, unknown>)!.omitted_field_groups.map((group) => group.name)).not.toContain("blockers");
    });
  });

  it("retains a portable unresolved legacy scalar when there are no dependency rows", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const global = { path: pmPath };
      const created = await runCreate({ title: "Legacy manual prerequisite", type: "Task", blockedBy: "human approval" }, global);
      const result = await runGet(created.item.id, global);
      expect(result.blockers).toMatchObject({ open: [{ id: "human approval", title: null, status: null }], closed_count: 0 });
    });
  });

  it("restores declared blocker evidence explicitly while keeping historical status separate", async () => {
    await withTempPmPath(async (context) => {
      const global = { path: context.pmPath };
      expect(context.runCli(["schema", "add-status", "archived", "--role", "terminal", "--json"]).code).toBe(0);
      const archived = await runCreate({ title: "Custom terminal prerequisite", type: "Task", status: "archived", closeReason: "Archived outcome" }, global);
      const created = await runCreate({ title: "Declared projection", type: "Task", dep: [
        `id=${archived.item.id},kind=blocked_by`,
        "id=remote-id,kind=blocked_by,source_kind=external",
      ] }, global);
      const brief = await runGet(created.item.id, global, { depth: "brief" });
      expect(brief.blockers).toBeUndefined();
      expect(resolveOutputOmissionReceipt("get", brief as unknown as Record<string, unknown>)!.omitted_field_groups).toContainEqual({ name: "blockers", restore_with: "--full" });
      for (const fields of ["blockers", "item.blockers"]) {
        const result = await runGet(created.item.id, global, { fields });
        expect(result.item).toEqual({ id: created.item.id });
        expect(result.blockers).toMatchObject({ scope: "declared", closed_count: 1, open: [{ id: "remote-id", status: null, external: true }] });
        expect(resolveOutputOmissionReceipt("get", result as unknown as Record<string, unknown>)!.omitted_field_groups.map((group) => group.name)).not.toContain("blockers");
      }
      const historical = await runGet(created.item.id, global, { at: "1" });
      expect(historical.blockers).toBeUndefined();
      expect(resolveOutputOmissionReceipt("get", historical as unknown as Record<string, unknown>)!.omitted_field_groups.map((group) => group.name)).not.toContain("blockers");
      await expect(runGet(created.item.id, global, { at: "1", fields: "blockers" })).rejects.toThrow("cannot project current blocker statuses");
    });
  });

  it.each([undefined, "schedule.reminders", "schedule.events", "schedule.deadline", "reminders", "id"])("declares only material schedule members withheld by %s", async (fields) => {
    await withTempPmPath(async ({ pmPath }) => {
      const global = { path: pmPath };
      const created = await runCreate({
        title: "Scheduled evidence", type: "Task", deadline: "2026-10-05T12:00:00.000Z",
        reminder: ["at=2026-10-05T09:00:00.000Z,text=Check outcome"],
        event: ["start=2026-10-05T10:00:00.000Z,end=2026-10-05T11:00:00.000Z,title=Outcome review"],
      }, global);
      const result = await runGet(created.item.id, global, { fields });
      if (fields === "schedule.deadline") expect(result.schedule?.deadline).toBe("2026-10-05T12:00:00.000Z");
      const omitted = resolveOutputOmissionReceipt("get", result as unknown as Record<string, unknown>)!.omitted_field_groups.map((group) => group.name);
      expect(omitted.includes("reminders")).toBe(fields !== undefined && fields !== "schedule.reminders" && fields !== "reminders");
      expect(omitted.includes("events")).toBe(fields !== undefined && fields !== "schedule.events");
    });
  });

  it.each([undefined, "linked.files", "linked.tests", "linked.docs"])("distinguishes rendered linked artifacts from unselected placeholders for %s", async (fields) => {
    await withTempPmPath(async ({ pmPath }) => {
      const global = { path: pmPath };
      const created = await runCreate({ title: "Linked read evidence", type: "Task", file: ["path=source.ts"], test: ["command=node -v"], doc: ["path=README.md"] }, global);
      const result = await runGet(created.item.id, global, { fields });
      const omitted = resolveOutputOmissionReceipt("get", result as unknown as Record<string, unknown>)!.omitted_field_groups.map((group) => group.name);
      for (const group of ["files", "tests", "docs"]) expect(omitted.includes(group)).toBe(fields !== undefined && fields !== `linked.${group}`);
    });
  });
});
