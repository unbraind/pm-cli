#!/usr/bin/env node

/**
 * Reject GitHub workflows whose default token grants write access.
 * Tracker: pm-003j. Jobs may request the scopes needed by their own steps.
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";

/** Audit one workflow's explicit default token permissions. */
export function auditWorkflowPermissions(source, file) {
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length > 0) {
    return [`${file}: invalid YAML: ${document.errors.map((error) => error.message).join("; ")}`];
  }
  const workflow = document.toJS();
  const permissions = workflow?.permissions;
  if (permissions === "read-all") return [];
  if (typeof permissions !== "object" || permissions === null || Array.isArray(permissions) || Object.keys(permissions).length === 0) {
    return [`${file}: declare explicit read-only workflow permissions`];
  }
  return Object.entries(permissions)
    .filter(([scope, access]) => access !== "read" && access !== "none" || scope === "id-token" && access !== "none")
    .map(([scope, access]) => `${file}: workflow permission ${scope}: ${String(access)} exceeds read-only default`);
}

/** Audit every authored GitHub workflow, refusing an empty or unreadable inventory. */
export async function auditWorkflowDirectory(workflowsRoot) {
  const files = (await readdir(workflowsRoot)).filter((file) => /\.ya?ml$/u.test(file)).sort();
  if (files.length === 0) return ["No GitHub workflow YAML files found"];
  const findings = [];
  for (const file of files) {
    findings.push(...auditWorkflowPermissions(await readFile(path.join(workflowsRoot, file), "utf8"), file));
  }
  return findings;
}

/** Print a stable verdict and fail when a workflow has a broad token default. */
async function main() {
  const negativeControl = process.argv.includes("--negative-control");
  const findings = negativeControl
    ? auditWorkflowPermissions("name: Negative control\npermissions:\n  contents: write\njobs: {}\n", "negative-control.yml")
    : await auditWorkflowDirectory(path.join(process.cwd(), ".github", "workflows"));
  for (const finding of findings) process.stderr.write(`${finding}\n`);
  if (findings.length === 0) process.stdout.write("Workflow permissions: read-only defaults verified\n");
  process.exitCode = findings.length > 0 ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await main();
}
