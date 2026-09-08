import { writeFile } from "node:fs/promises";
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
