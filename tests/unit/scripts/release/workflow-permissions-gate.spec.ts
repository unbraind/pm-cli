import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { auditWorkflowDirectory, auditWorkflowPermissions } from "../../../../scripts/check-workflow-permissions.mjs";

describe("GitHub workflow token permissions", () => {
  it("accepts job-scoped elevation and rejects workflow-scoped elevation", () => {
    const workflow = "name: Example\npermissions:\n  contents: read\njobs:\n  publish:\n    permissions:\n      contents: write\n";
    expect(auditWorkflowPermissions(workflow, "example.yml")).toEqual([]);
    expect(auditWorkflowPermissions(workflow.replace("contents: read", "contents: write"), "example.yml")).toEqual([
      "example.yml: workflow permission contents: write exceeds read-only default",
    ]);
    expect(auditWorkflowPermissions(workflow.replace("permissions:\n  contents: read\n", ""), "example.yml")).toEqual([
      "example.yml: declare explicit read-only workflow permissions",
    ]);
  });

  it("rejects OIDC at workflow scope and malformed or empty inventories", async () => {
    expect(auditWorkflowPermissions("permissions:\n  id-token: write\n", "oidc.yml")).toEqual([
      "oidc.yml: workflow permission id-token: write exceeds read-only default",
    ]);
    expect(auditWorkflowPermissions("permissions: [broken\n", "broken.yml")[0]).toContain("invalid YAML");
    const root = await mkdtemp(path.join(tmpdir(), "pm-workflow-permissions-"));
    try {
      expect(await auditWorkflowDirectory(root)).toEqual(["No GitHub workflow YAML files found"]);
      await writeFile(path.join(root, "safe.yml"), "permissions: read-all\n");
      await writeFile(path.join(root, "unsafe.yaml"), "permissions:\n  issues: write\n");
      expect(await auditWorkflowDirectory(root)).toEqual([
        "unsafe.yaml: workflow permission issues: write exceeds read-only default",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
