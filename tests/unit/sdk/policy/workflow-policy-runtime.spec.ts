import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sealHistoryRecord } from "../../../../src/core/history/history.js";
import type { HistoryEntry } from "../../../../src/types/index.js";
import type { WorkflowPolicyAction } from "../../../../src/sdk/governance/workflow-policy.js";
import { readSettings } from "../../../../src/core/store/settings.js";
import { deleteItem } from "../../../../src/core/store/item-store.js";
import { commitImportedItem } from "../../../../src/sdk/package-import-adapters.js";
import { PmClient } from "../../../../src/sdk/runtime.js";
import { runWorkflowPolicyAction } from "../../../../src/sdk/governance/workflow-policy.js";
import { readWorkflowApprovals, readWorkflowPolicies, MAX_WORKFLOW_POLICY_BYTES } from "../../../../src/core/policy/workflow-policy-store.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";

describe("workspace workflow policy enforcement", () => {
  it("refuses incomplete lifecycle writes atomically and records advisory and refusal evidence", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const client = new PmClient({ pmRoot: pmPath, noExtensions: true });
      const global = { path: pmPath };
      await runWorkflowPolicyAction("policy-put", "complete", { definition: {
        id: "complete", effect: "refuse", subject: { statuses: ["closed"] },
        rule: { kind: "require_fields", fields: ["actual_result"] },
      } }, global);
      const created = await client.create({ title: "Evidence contract", type: "Task" });
      const id = created.item.id;
      await runWorkflowPolicyAction("policy-mode", "refuse", {}, global);
      const historyPath = path.join(pmPath, "history", `${id}.jsonl`);
      const before = await readFile(historyPath, "utf8");
      await expect(client.close(id, "Verified")).rejects.toMatchObject({ code: "workflow_policy_refused" });
      expect(await readFile(historyPath, "utf8")).toBe(before);
      expect(await readFile(path.join(pmPath, "history", "_workspace.jsonl"), "utf8")).toContain('"op":"policy_refused"');
      const closed = await client.close(id, "Verified", { actualResult: "Acceptance passed" });
      expect(closed.item.status).toBe("closed");
      expect(await readFile(historyPath, "utf8")).toContain('"workflow_policies"');
    });
  });

  it("binds independent approvals to the declared fields and rejects stale content", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const client = new PmClient({ pmRoot: pmPath, noExtensions: true });
      const global = { path: pmPath };
      const { item } = await client.create({ title: "Review content", body: "revision one", author: "writer" });
      await runWorkflowPolicyAction("policy-put", "review", { definition: {
        id: "review", effect: "refuse", subject: { statuses: ["closed"] },
        rule: { kind: "approval", fields: ["body"], authors: ["reviewer"] },
      } }, global);
      await runWorkflowPolicyAction("policy-mode", "refuse", {}, global);
      await expect(client.close(item.id, "Complete", { author: "writer" })).rejects.toMatchObject({ code: "workflow_policy_refused" });
      await runWorkflowPolicyAction("policy-approve", item.id, { policy: "review", author: "reviewer" }, global);
      await expect(client.close(item.id, "Complete", { author: "reviewer" })).rejects.toMatchObject({ code: "workflow_policy_refused" });
      await client.update(item.id, { body: "revision two", author: "writer" });
      await expect(client.close(item.id, "Complete", { author: "writer" })).rejects.toMatchObject({ code: "workflow_policy_refused" });
      await runWorkflowPolicyAction("policy-approve", item.id, { policy: "review", author: "reviewer" }, global);
      await expect(client.close(item.id, "Complete", { author: "writer" })).resolves.toMatchObject({ item: { status: "closed" } });
    });
  });
  it("allows initial creation under global approval rules and requires reviewed deletion", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const client = new PmClient({ pmRoot: pmPath, noExtensions: true });
      await client.workflowPolicy("policy-put", "review", { definition: {
        id: "review", effect: "refuse",
        rule: { kind: "approval", fields: ["body"], authors: ["reviewer"] },
      } });
      await client.workflowPolicy("policy-mode", "refuse");
      const { item } = await client.create({ title: "Reviewable record", body: "Reviewed content", author: "writer" });
      const settings = await readSettings(pmPath);
      const deletion = { pmRoot: pmPath, settings, id: item.id, author: "writer" };
      await expect(deleteItem(deletion)).rejects.toMatchObject({ code: "workflow_policy_refused" });
      await client.workflowPolicy("policy-approve", item.id, { policy: "review", author: "reviewer" });
      await expect(deleteItem({ ...deletion, author: "reviewer" })).rejects.toMatchObject({ code: "workflow_policy_refused" });
      await expect(deleteItem(deletion)).resolves.toMatchObject({ item: { id: item.id } });
    });
  });

  it("previews registry changes, preserves no-ops, and validates authoring inputs", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const global = { path: pmPath };
      await expect(runWorkflowPolicyAction("unknown" as WorkflowPolicyAction, undefined, {}, global)).rejects.toThrow("Unknown workflow");
      const definition = { id: "required", rule: { kind: "require_fields", fields: ["body"] } };
      expect(await runWorkflowPolicyAction("policies", undefined, {}, global)).toMatchObject({ result: { policies: [] } });
      expect(await runWorkflowPolicyAction("policy-put", "required", { definition, dryRun: true }, global)).toMatchObject({ changed: false, result: { policies: [definition] } });
      expect(await runWorkflowPolicyAction("policies", undefined, {}, global)).toMatchObject({ result: { policies: [] } });
      expect(await runWorkflowPolicyAction("policy-put", "required", { definition: JSON.stringify(definition) }, global)).toMatchObject({ changed: true });
      expect(await runWorkflowPolicyAction("policy-put", "required", { definition }, global)).toMatchObject({ changed: false });
      for (const invalid of ["{", "[]", [], null, { ...definition, id: "different" }]) {
        await expect(runWorkflowPolicyAction("policy-put", "required", { definition: invalid }, global)).rejects.toThrow();
      }
      await expect(runWorkflowPolicyAction("policy-mode", "invalid", {}, global)).rejects.toThrow();
      await expect(runWorkflowPolicyAction("policy-put", undefined, {}, global)).rejects.toThrow("operand");
      expect(await runWorkflowPolicyAction("policy-remove", "required", {}, global)).toMatchObject({ changed: true, result: { policies: [] } });
      expect(await runWorkflowPolicyAction("policy-presets", undefined)).toMatchObject({ changed: false, result: { enforcement: "advise" } });
    });
  });

  it("fails closed on malformed, oversized, and invalid UTF-8 registry files", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const client = new PmClient({ pmRoot: pmPath, noExtensions: true });
      await mkdir(path.join(pmPath, "schema"), { recursive: true });
      for (const invalid of ["{", "[]", " ".repeat(MAX_WORKFLOW_POLICY_BYTES + 1), Buffer.from([0xff])]) {
        await writeFile(path.join(pmPath, "schema", "policies.json"), invalid);
        await expect(client.create({ title: "Must not persist" })).rejects.toThrow();
      }
    });
  });

  it("previews proposed changes without mutation and rejects invalid approval evidence", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const client = new PmClient({ pmRoot: pmPath, noExtensions: true });
      const global = { path: pmPath };
      const { item } = await client.create({ title: "Preview", author: "writer" });
      await runWorkflowPolicyAction("policy-put", "review", { definition: {
        id: "review", effect: "refuse", subject: { statuses: ["closed"] },
        rule: { kind: "approval", fields: ["body"], authors: ["reviewer"] },
      } }, global);
      await runWorkflowPolicyAction("policy-mode", "refuse", {}, global);
      expect(await runWorkflowPolicyAction("policy-check", item.id, { definition: { status: "closed" }, author: "writer" }, global)).toMatchObject({ changed: false, result: { allowed: false } });
      expect(await runWorkflowPolicyAction("policy-check", item.id, {}, global)).toMatchObject({ changed: false, result: { allowed: true } });
      await expect(runWorkflowPolicyAction("policy-check", item.id, { definition: { id: "replacement" } }, global)).rejects.toThrow("item id");
      await expect(runWorkflowPolicyAction("policy-check", "pm-nonexistent", {}, global)).rejects.toThrow("not found");
      await expect(runWorkflowPolicyAction("policy-approve", item.id, { dryRun: true }, global)).rejects.toThrow("preview");
      await expect(runWorkflowPolicyAction("policy-approve", item.id, { policy: "missing" }, global)).rejects.toThrow("approval rule");
      await expect(runWorkflowPolicyAction("policy-approve", item.id, { policy: "review", author: "writer" }, global)).rejects.toThrow("declared approver");
      expect(await readWorkflowApprovals(pmPath, "pm-absent")).toEqual([]);
      await writeFile(path.join(pmPath, "history", `${item.id}.jsonl`), "{broken");
      await expect(runWorkflowPolicyAction("policy-check", item.id, { definition: { status: "closed" } }, global)).rejects.toMatchObject({ code: "workflow_policy_approval_history_invalid" });
    });
  });

  it("enforces declared evidence on creation and the package import writer", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const client = new PmClient({ pmRoot: pmPath, noExtensions: true });
      await client.workflowPolicy("policy-put", "source-evidence", { definition: {
        id: "source-evidence", effect: "refuse", subject: { operations: ["create", "import"] },
        rule: { kind: "require_fields", fields: ["body"] },
      } });
      await client.workflowPolicy("policy-mode", "refuse");
      await expect(client.create({ title: "Missing source evidence" })).rejects.toMatchObject({ code: "workflow_policy_refused" });
      const { item } = await client.create({ title: "Has evidence", body: "Original source" });
      const settings = await readSettings(pmPath);
      const imported = { ...item, id: "pm-imported" };
      const itemPath = path.join(pmPath, "tasks", "pm-imported.toon");
      const params = { pmRoot: pmPath, id: imported.id, itemPath, document: { metadata: imported, body: "" }, author: "importer", message: "Import source", settings, conflictWarningPrefix: "import_lock" };
      await expect(commitImportedItem(params)).rejects.toMatchObject({ code: "workflow_policy_refused" });
      await expect(readFile(itemPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await commitImportedItem({ ...params, document: { metadata: imported, body: "Verified import source" } })).toMatchObject({ committed: true });
      expect(await readFile(path.join(pmPath, "history", `${imported.id}.jsonl`), "utf8")).toContain('"workflow_policies"');
    });
  });

  it("applies policies to restore and deletion while keeping deletion previews write-free", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const client = new PmClient({ pmRoot: pmPath, noExtensions: true });
      const { item } = await client.create({ title: "Restorable record" });
      await client.update(item.id, { body: "Current evidence" });
      await client.workflowPolicy("policy-put", "restore-evidence", { definition: {
        id: "restore-evidence", effect: "refuse", subject: { operations: ["restore"] },
        rule: { kind: "require_fields", fields: ["body"] },
      } });
      await client.workflowPolicy("policy-mode", "refuse");
      const historyPath = path.join(pmPath, "history", `${item.id}.jsonl`);
      const before = await readFile(historyPath, "utf8");
      await expect(client.restore(item.id, "1")).rejects.toMatchObject({ code: "workflow_policy_refused" });
      expect(await readFile(historyPath, "utf8")).toBe(before);
      await client.workflowPolicy("policy-mode", "advise");
      const restored = await client.restore(item.id, "1");
      expect(restored.warnings).toContain("workflow_policy:warn:restore-evidence:require_fields");
      await client.workflowPolicy("policy-put", "delete-actor", { definition: {
        id: "delete-actor", effect: "refuse", subject: { operations: ["delete"] },
        rule: { kind: "authors", authors: ["owner"] },
      } });
      await client.workflowPolicy("policy-mode", "refuse");
      const settings = await readSettings(pmPath);
      const workspaceHistory = path.join(pmPath, "history", "_workspace.jsonl");
      const auditBefore = await readFile(workspaceHistory, "utf8");
      await expect(deleteItem({ pmRoot: pmPath, settings, id: item.id, author: "other", dryRun: true })).rejects.toMatchObject({ code: "workflow_policy_refused" });
      expect(await readFile(workspaceHistory, "utf8")).toBe(auditBefore);
      await expect(deleteItem({ pmRoot: pmPath, settings, id: item.id, author: "other" })).rejects.toMatchObject({ code: "workflow_policy_refused" });
      expect(await deleteItem({ pmRoot: pmPath, settings, id: item.id, author: "owner", dryRun: true })).toMatchObject({ item: { id: item.id } });
      await deleteItem({ pmRoot: pmPath, settings, id: item.id, author: "owner" });
      expect(await readFile(historyPath, "utf8")).toContain('"delete-actor"');
    });
  });

  it("rejects unreadable storage and tampered history, and ignores sealed malformed approval contexts", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const client = new PmClient({ pmRoot: pmPath, noExtensions: true });
      const { item } = await client.create({ title: "Integrity fixture" });
      const historyPath = path.join(pmPath, "history", `${item.id}.jsonl`);
      const entry = JSON.parse((await readFile(historyPath, "utf8")).trim()) as HistoryEntry;
      await writeFile(historyPath, JSON.stringify({ ...entry, author: "tampered" }));
      await expect(readWorkflowApprovals(pmPath, item.id)).rejects.toMatchObject({ code: "workflow_policy_approval_history_invalid" });
      await writeFile(historyPath, JSON.stringify(sealHistoryRecord({ ...entry, op: "policy_approve", context: { workflow_approval: { policy_fingerprint: 5 } } })));
      expect(await readWorkflowApprovals(pmPath, item.id)).toEqual([]);
      await rm(path.join(pmPath, "schema"), { recursive: true, force: true });
      await writeFile(path.join(pmPath, "schema"), "not a directory");
      await expect(readWorkflowPolicies(pmPath)).rejects.toMatchObject({ code: "ENOTDIR" });
    });
  });

  it("bounds refusal summaries while retaining every decision in the audit", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const client = new PmClient({ pmRoot: pmPath, noExtensions: true });
      for (let index = 0; index < 4; index++) await client.workflowPolicy("policy-put", `evidence-${index}`, { definition: {
        id: `evidence-${index}`, effect: "refuse", rule: { kind: "require_fields", fields: ["body"] },
      } });
      await client.workflowPolicy("policy-mode", "refuse");
      await expect(client.create({ title: "Missing evidence" })).rejects.toThrow("and 1 more");
      const audit = await readFile(path.join(pmPath, "history", "_workspace.jsonl"), "utf8");
      expect(JSON.parse(audit.trim().split("\n").at(-1)!).context.workflow_policies).toHaveLength(4);
    });
  });

  it("rejects oversized normalized registries for both previews and writes", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const terms = Array.from({ length: 64 }, (_, index) => `field_${index}_${"x".repeat(118)}`);
      const policies = Array.from({ length: 120 }, (_, index) => ({
        id: `policy-${index}`, rule: { kind: "require_fields", fields: terms },
      }));
      const raw = JSON.stringify({ version: 1, policies });
      expect(Buffer.byteLength(raw)).toBeLessThan(MAX_WORKFLOW_POLICY_BYTES);
      await mkdir(path.join(pmPath, "schema"), { recursive: true });
      const registryPath = path.join(pmPath, "schema", "policies.json");
      await writeFile(registryPath, raw);
      for (const dryRun of [true, false]) {
        await expect(runWorkflowPolicyAction("policy-put", "next", {
          definition: { id: "next", rule: { kind: "require_fields", fields: terms } }, dryRun,
        }, { path: pmPath })).rejects.toThrow("byte ceiling");
        expect(await readFile(registryPath, "utf8")).toBe(raw);
      }
    });
  });

});
