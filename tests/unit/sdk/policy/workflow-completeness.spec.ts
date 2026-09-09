import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildWorkflowCompletenessCheck } from "../../../../src/sdk/governance/workflow-completeness.js";
import { parseWorkflowPolicyDocument } from "../../../../src/core/policy/workflow-policy.js";
import { PmClient } from "../../../../src/sdk/runtime.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";

const declaration = {
  id: "required-body", subject: { statuses: ["closed"] }, effect: "refuse",
  rule: { kind: "require_fields", fields: ["body"] },
};

describe("lifecycle completeness", () => {
  it("reports state-only requirements consistently without predicting operation permission", async () => {
    await withTempPmPath(async ({ pmPath, runCli }) => {
      const client = new PmClient({ pmRoot: pmPath, noExtensions: true });
      const created = await client.create({ title: "Operation-specific evidence" });
      const policies = [
        { ...declaration, subject: undefined },
        ...["update", "close", "import"].map((operation) => ({
          id: `${operation}-evidence`, effect: "refuse", subject: { operations: [operation] },
          rule: { kind: "require_fields", fields: ["custom.operation_evidence"] },
        })),
      ];
      for (const policy of policies) await client.workflowPolicy("policy-put", policy.id, { definition: policy });
      await client.workflowPolicy("policy-mode", "refuse");
      const historyPath = path.join(pmPath, "history", `${created.item.id}.jsonl`);
      const history = await readFile(historyPath, "utf8");
      const report = await client.validate({ checkCompleteness: true });
      expect(report.checks[0]).toMatchObject({ name: "completeness", status: "error", details: {
        scope: "operation_independent_require_fields", violation_count: 1,
        violations: [{ decision: { policy_id: declaration.id, missing_fields: ["body"] } }],
      } });
      const scan = runCli(["validate", "--check-completeness", "--strict-exit", "--json", "--output-budget", "unbounded"]);
      expect(scan.status).toBe(1);
      expect(JSON.parse(scan.stdout).checks[0]).toEqual(report.checks[0]);
      const inspection = runCli(["schema", "policy-check", created.item.id, "--json"]);
      expect(inspection.status, inspection.stderr).toBe(0);
      expect(JSON.parse(inspection.stdout).result.decisions.map((decision: { policy_id: string }) => decision.policy_id)).toEqual([declaration.id]);
      expect(await readFile(historyPath, "utf8")).toBe(history);
      await client.update(created.item.id, { body: "State evidence" });
      expect(await client.validate({ checkCompleteness: true })).toMatchObject({ ok: true });
      await expect(client.close(created.item.id, "Attempt closure")).rejects.toMatchObject({ code: "workflow_policy_refused" });
    });
  });

  it("reports invalid policy storage without hiding other validation diagnostics or rewriting evidence", async () => {
    await withTempPmPath(async ({ pmPath, runCli }) => {
      const client = new PmClient({ pmRoot: pmPath, noExtensions: true });
      const created = await client.create({ title: "Missing planning evidence" });
      const historyPath = path.join(pmPath, "history", `${created.item.id}.jsonl`);
      const history = await readFile(historyPath, "utf8");
      const policyPath = path.join(pmPath, "schema", "policies.json");
      await mkdir(path.dirname(policyPath), { recursive: true });
      for (const raw of ["{", '{"version":2,"policies":[]}', Buffer.from([0xff])]) {
        await writeFile(policyPath, raw);
        const report = await client.validate({ checkCompleteness: true, checkMetadata: true, counts: true });
        expect(report).toMatchObject({ ok: false, checks: [
          { name: "completeness", status: "error", ok: false, details: { policy_registry_readable: false } },
          { name: "metadata", status: "warn" },
        ] });
        expect(report.warnings).toContain("validate_completeness_policy_registry_unreadable");
        expect(await readFile(policyPath)).toEqual(Buffer.from(raw));
      }
      const cli = runCli(["validate", "--strict-exit", "--json", "--output-budget", "unbounded"]);
      expect(cli.status).toBe(1);
      const report = JSON.parse(cli.stdout);
      expect(report.checks).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "completeness", status: "error" }),
        expect.objectContaining({ name: "metadata", status: "warn" }),
        expect.objectContaining({ name: "storage_integrity" }),
      ]));
      await rm(policyPath);
      await mkdir(policyPath);
      expect(await client.validate({ checkCompleteness: true, checkMetadata: true })).toMatchObject({ ok: false, checks: [
        { name: "completeness", status: "error" }, { name: "metadata", status: "warn" },
      ] });
      await rm(policyPath, { recursive: true });
      await writeFile(policyPath, '{"version":1,"policies":[]}');
      expect(await client.validate({ checkCompleteness: true })).toMatchObject({ ok: true });
      expect(await readFile(historyPath, "utf8")).toBe(history);
    });
  });

  it("counts the whole corpus while bounding rows and grouping missing evidence by custom type", () => {
    const document = parseWorkflowPolicyDocument({ version: 1, policies: [declaration] });
    const items = Array.from({ length: 8 }, (_, index) => ({ id: `pm-${index}`, type: index < 7 ? "Purchase" : "Task", status: "closed", body: "" }));
    expect(buildWorkflowCompletenessCheck(document, items)).toMatchObject({ check: {
      status: "warn", ok: false, details: { checked_items: 8, incomplete_items: 8, violation_count: 8, refused_violations: 0,
        missing_by_type: { Purchase: { items: 7, missing_fields: 7 }, Task: { items: 1 } }, violations_truncated: true },
    } });
    expect(buildWorkflowCompletenessCheck(document, items).check.details.violations).toHaveLength(5);
    expect(buildWorkflowCompletenessCheck({ ...document, enforcement: "refuse" }, items, Infinity).check).toMatchObject({ status: "error", details: { refused_violations: 8, violations_truncated: false } });
    expect(buildWorkflowCompletenessCheck(document, [], 5, true)).toMatchObject({ check: { status: "error", ok: false }, warnings: ["validate_completeness_source_incomplete"] });
    expect(buildWorkflowCompletenessCheck(document, items.map((item) => ({ ...item, body: "Evidence" })))).toMatchObject({ check: { status: "ok", ok: true }, warnings: [] });
  });

  it("shares SDK and CLI validation, preserves counts and fails the strict negative control", async () => {
    await withTempPmPath(async ({ pmPath, runCli }) => {
      const client = new PmClient({ pmRoot: pmPath, noExtensions: true });
      const created = await client.create({ title: "Incomplete historical record" });
      await client.close(created.item.id, "Done");
      const put = runCli(["schema", "policy-put", declaration.id, "--definition", JSON.stringify(declaration), "--json"]);
      expect(put.status, put.stderr).toBe(0);
      const report = await client.validate({ checkCompleteness: true, counts: true });
      expect(report.checks).toHaveLength(1);
      expect(report.checks[0]).toMatchObject({ name: "completeness", status: "warn", details: { incomplete_items: 1, violation_count: 1 } });
      expect(report.checks[0].details).not.toHaveProperty("violations");
      const failure = runCli(["validate", "--check-completeness", "--strict-exit", "--json"]);
      expect(failure.status).toBe(1);
      expect(failure.stdout).toContain("validate_completeness_missing_fields");
      await client.workflowPolicy("policy-mode", "refuse");
      expect(await client.validate({ checkCompleteness: true })).toMatchObject({ ok: false });
      await client.update(created.item.id, { body: "Verified record" });
      expect(runCli(["validate", "--check-completeness", "--strict-exit", "--json"]).status).toBe(0);
      await writeFile(path.join(pmPath, "tasks", "pm-unreadable.toon"), "invalid tracker record\n");
      const unreadable = await client.validate({ checkCompleteness: true });
      expect(unreadable.checks[0]).toMatchObject({ name: "completeness", status: "error", ok: false });
      expect(unreadable.warnings).toContain("validate_completeness_source_incomplete");
    });
  });
});
