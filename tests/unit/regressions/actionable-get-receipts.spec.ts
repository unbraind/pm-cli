/**
 * @module tests/unit/regressions/actionable-get-receipts
 *
 * Verifies current declared blocker state and truthful schedule disclosure
 * through real SDK mutations and item reads in disposable trackers.
 */
import { describe, expect, it, vi } from "vitest";
import { encode } from "@toon-format/toon";
import fs from "node:fs/promises";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { runCreate } from "../../../src/sdk/lifecycle/create.js";
import { runGet } from "../../../src/sdk/query/get.js";
import { resolveOutputOmissionReceipt } from "../../../src/sdk/output-projection.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

describe("actionable get receipts", () => {
  it.each([{}, { author: "legacy-author" }, { source_kind: "import" }])("discloses only actually withheld attribution for timestamp-free legacy rows: %j", async (provenance) => {
    await withTempPmPath(async ({ pmPath }) => {
      const global = { path: pmPath };
      const target = await runCreate({ title: "Legacy relationship target", type: "Task" }, global);
      const created = await runCreate({ title: "Legacy attribution source", type: "Task" }, global);
      const dependency = { id: target.item.id, kind: "related", ...provenance };
      await fs.writeFile(path.join(pmPath, "tasks", `${created.item.id}.toon`), encode({ ...created.item, dependencies: [dependency] }) + "\n");
      for (const options of [{}, { depth: "full", fields: "id" }, { depth: "full", fields: "item.id" }]) {
        const ordinary = await runGet(created.item.id, global, options);
        expect(ordinary.item.dependencies).toEqual(options.fields === undefined ? [{ id: target.item.id, kind: "related" }] : undefined);
        expect(resolveOutputOmissionReceipt("get", ordinary as unknown as Record<string, unknown>)!.omitted_field_groups.some((group) => group.name === "dependency_provenance")).toBe(options.fields === undefined && Object.keys(provenance).length > 0);
        if (options.fields !== undefined) expect(ordinary.item).toEqual({ id: created.item.id });
      }
      for (const options of [{ full: true }, { depth: "full" }, { fields: "dependencies" }, { fields: "item.dependencies" }, { depth: "full", fields: "dependencies" }, { depth: "full", fields: "item.dependencies" }]) {
        const complete = await runGet(created.item.id, global, options);
        expect(complete.item.dependencies).toEqual([dependency]);
        expect(resolveOutputOmissionReceipt("get", complete as unknown as Record<string, unknown>)!.omitted_field_groups.map((group) => group.name)).not.toContain("dependency_provenance");
      }
    });
  });

  it("canonicalizes short blocker references without double-counting their persisted full-ID edges", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const global = { path: pmPath };
      const finished = await runCreate({ id: "pm-abcd", title: "Completed prerequisite", type: "Task", status: "closed", closeReason: "Delivered" }, global);
      const pending = await runCreate({ id: "pm-efgh", title: "Pending prerequisite", type: "Task" }, global);
      for (const target of [finished.item, pending.item]) {
        for (const reference of [target.id.slice(3), target.id.toUpperCase(), target.id.slice(3).toUpperCase()]) {
          const created = await runCreate({ title: "Legacy-reference dependent", type: "Task", blockedBy: reference }, global);
          await fs.writeFile(path.join(pmPath, "tasks", `${created.item.id}.toon`), encode({ ...created.item, blocked_by: reference, dependencies: created.item.dependencies!.map((dependency) => ({ ...dependency, id: reference.toLowerCase() === target.id ? reference : dependency.id })) }) + "\n");
          const result = await runGet(created.item.id, global);
          expect(result.blockers).toEqual({ scope: "declared", closed_count: target.status === "closed" ? 1 : 0, open: target.status === "closed" ? [] : [{ id: target.id, title: target.title, status: target.status }] });
        }
      }
    });
  });
  it.each([false, true])("rejects a declared blocker whose file contains another item identity (matching probe: %s)", async (matchingProbe) => {
    await withTempPmPath(async ({ pmPath }) => {
      const global = { path: pmPath };
      const blocker = await runCreate({ title: "Open prerequisite", type: "Task" }, global);
      const unrelated = await runCreate({ title: "Unrelated completed work", type: "Task", status: "closed", closeReason: "Delivered" }, global);
      const created = await runCreate({ title: "Dependent work", type: "Task", blockedBy: blocker.item.id }, global);
      const blockerPath = path.join(pmPath, "tasks", `${blocker.item.id}.toon`);
      await fs.writeFile(blockerPath, encode({ ...unrelated.item, id: matchingProbe ? blocker.item.id : unrelated.item.id }) + "\n");
      // Native case aliases share one destination; case-sensitive hosts retain colliding leaves.
      if (!matchingProbe) {
        await fs.copyFile(path.join(pmPath, "tasks", `${unrelated.item.id}.toon`), path.join(pmPath, "tasks", `${blocker.item.id.toUpperCase()}.toon`));
        await fs.copyFile(path.join(pmPath, "tasks", `${unrelated.item.id}.toon`), path.join(pmPath, "tasks", `Pm-${blocker.item.id.slice(3)}.toon`));
      }
      const itemPath = path.join(pmPath, "tasks", `${created.item.id}.toon`);
      const historyPath = path.join(pmPath, "history", `${created.item.id}.jsonl`);
      const before = await Promise.all([fs.readFile(itemPath, "utf8"), fs.readFile(historyPath, "utf8")]);
      const failure = Object.assign(new Error("Directory access denied"), { code: "EACCES" });
      const directories = vi.spyOn(fs, "readdir").mockRejectedValueOnce(failure);
      syncBuiltinESMExports();
      try {
        await expect(runGet(created.item.id, global)).rejects.toMatchObject({
          name: "PmCliError", exitCode: 1, context: { code: "blocker_identity_read_failed" }, cause: failure,
        });
        expect(directories).toHaveBeenCalledWith(path.join(pmPath, "tasks"));
      } finally {
        directories.mockRestore();
        syncBuiltinESMExports();
      }
      if (matchingProbe) {
        // Node's default names-only overload returns strings; preserve that type in external spies.
        const nameListingFs: { readdir: (directory: Parameters<typeof fs.readdir>[0]) => Promise<string[]> } = fs;
        const uppercasePath = path.join(pmPath, "tasks", `${blocker.item.id.toUpperCase()}.toon`);
        const nativeCaseAlias = await fs.access(uppercasePath).then(() => true, () => false);
        if (nativeCaseAlias) {
          // A two-step rename forces the actual directory leaf to change on native aliases.
          await fs.rename(blockerPath, `${blockerPath}.rename`);
          await fs.rename(`${blockerPath}.rename`, uppercasePath);
          await expect(runGet(created.item.id, global)).rejects.toMatchObject({ context: { code: "item_identity_conflict" } });
        } else {
          // Model only the external directory response; the SDK and persisted documents remain real.
          const entries = await fs.readdir(path.join(pmPath, "tasks"));
          const aliases = vi.spyOn(nameListingFs, "readdir").mockResolvedValueOnce(entries.map((name) => name === path.basename(blockerPath) ? path.basename(uppercasePath) : name));
          syncBuiltinESMExports();
          try {
            await expect(runGet(created.item.id, global)).rejects.toMatchObject({ context: { code: "item_identity_conflict" } });
          } finally {
            aliases.mockRestore();
            syncBuiltinESMExports();
          }
        }
        const disappeared = vi.spyOn(nameListingFs, "readdir").mockResolvedValueOnce([]);
        syncBuiltinESMExports();
        try {
          await expect(runGet(created.item.id, global)).rejects.toMatchObject({ context: { code: "item_identity_conflict" } });
        } finally {
          disappeared.mockRestore();
          syncBuiltinESMExports();
        }
      } else {
        await expect(runGet(created.item.id, global)).rejects.toMatchObject({ context: { code: "item_identity_conflict" } });
      }
      expect(await Promise.all([fs.readFile(itemPath, "utf8"), fs.readFile(historyPath, "utf8")])).toEqual(before);
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
      const first = await runCreate({ id: "Source-First", title: "First open prerequisite", type: "Task" }, global);
      const second = await runCreate({ id: "Source-Second", title: "Second open prerequisite", type: "Task" }, global);
      const finished = await runCreate({ id: "Source-Finished", title: "Finished prerequisite", type: "Task", status: "closed", closeReason: "Delivered before dependent work" }, global);
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
      if (fields === "schedule.deadline") expect(omitted).not.toContain("schedule");
      expect(omitted.includes("reminders")).toBe(false);
      expect(omitted.includes("events")).toBe(false);
      if (fields === undefined || fields === "schedule.reminders") expect(result.schedule?.reminders).toEqual(created.item.reminders);
      if (fields === undefined || fields === "schedule.events") expect(result.schedule?.events).toEqual(created.item.events);
      if (fields === "reminders") expect(result.item.reminders).toEqual(created.item.reminders);
      if (fields === "id") expect(result.item).toEqual({ id: created.item.id });
    });
  });

  it.each([undefined, "linked.files", "linked.tests", "linked.docs"])("distinguishes rendered linked artifacts from unselected placeholders for %s", async (fields) => {
    await withTempPmPath(async ({ pmPath }) => {
      const global = { path: pmPath };
      const created = await runCreate({ title: "Linked read evidence", type: "Task", file: ["path=source.ts"], test: ["command=node -v"], doc: ["path=README.md"] }, global);
      const result = await runGet(created.item.id, global, { fields });
      const omitted = resolveOutputOmissionReceipt("get", result as unknown as Record<string, unknown>)!.omitted_field_groups.map((group) => group.name);
      for (const group of ["files", "tests", "docs"] as const) {
        expect(omitted.includes(group)).toBe(false);
        expect(result.linked?.[group]).toEqual(fields === undefined || fields === `linked.${group}` ? created.item[group] : []);
      }
    });
  });
});
