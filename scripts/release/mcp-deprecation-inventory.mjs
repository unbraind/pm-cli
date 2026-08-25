#!/usr/bin/env node

/**
 * Generated MCP deprecated-symbol inventory and canonical-surface regression gate.
 *
 * Tracker: pm-vzcisw. The dedicated legacy adapter, migration documents, and
 * named negative-control tests are evidence surfaces; every other match fails.
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const RULES = [
  ["protocol-session-header", /Mcp-Session-Id/gu],
  ["sse-replay-header", /Last-Event-ID/gu],
  ["legacy-resource-subscribe", /resources\/(?:subscribe|unsubscribe)/gu],
  ["legacy-log-level-rpc", /logging\/setLevel/gu],
  ["legacy-roots-notification", /notifications\/roots\/list_changed/gu],
  ["legacy-task-result", /tasks\/result/gu],
  ["legacy-initialized-notification", /notifications\/initialized/gu],
  ["deprecated-sampling-context", /includeContext/gu],
  ["removed-ping", /["'`]ping["'`]/gu],
  ["removed-initialize", /["'`]initialize["'`]/gu],
  ["deprecated-http-sse", /HTTP\+SSE/gu],
];
const SOURCE_EXTENSIONS = new Set([".js", ".json", ".md", ".mjs", ".ts"]);
const EXCLUDED_DIRECTORIES = new Set([
  ".agents",
  ".cache",
  ".git",
  "coverage",
  "dist",
  "node_modules",
]);
const NEGATIVE_CONTROL_PATHS = new Set([
  "tests/integration/mcp-handshake.spec.ts",
  "tests/integration/mcp-stateless-protocol.spec.ts",
  "tests/integration/mcp-streamable-http.spec.ts",
  "tests/unit/mcp/mcp-server-branch-residual.spec.ts",
  "tests/unit/mcp/mutation-envelope-parity.spec.ts",
  "tests/unit/sdk/mcp/transport.spec.ts",
]);

function isMcpSurface(relativePath) {
  if (
    relativePath === "scripts/release/mcp-deprecation-inventory.mjs" ||
    relativePath === "tests/unit/scripts/release/mcp-deprecation-gate.spec.ts"
  ) {
    return false;
  }
  return (
    relativePath.startsWith("src/mcp/") ||
    relativePath.startsWith("src/sdk/mcp/") ||
    relativePath.startsWith("docs/MCP_") ||
    relativePath.includes("/mcp-") ||
    relativePath.includes("/mcp/")
  );
}

async function collectSourceFiles(root, directory = root) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name)) continue;
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectSourceFiles(root, absolutePath)));
    } else if (
      entry.isFile() &&
      SOURCE_EXTENSIONS.has(path.extname(entry.name))
    ) {
      const relativePath = path
        .relative(root, absolutePath)
        .split(path.sep)
        .join("/");
      if (isMcpSurface(relativePath))
        files.push({ absolutePath, relativePath });
    }
  }
  return files;
}

function disposition(relativePath, line) {
  if (relativePath === "src/mcp/legacy-adapter.ts") return "legacy_adapter";
  if (relativePath.startsWith("docs/MCP_")) return "migration_document";
  if (NEGATIVE_CONTROL_PATHS.has(relativePath)) return "negative_control";
  if (
    line.includes("mcp-deprecation-negative-control") ||
    line.includes("mcp-legacy-boundary")
  ) {
    return "bounded_source_control";
  }
  return "canonical_violation";
}

async function scanMcpDeprecationFile(file) {
  const source = await readFile(file.absolutePath, "utf8");
  const lines = source.split(/\r?\n/u);
  const findings = [];
  for (const [index, line] of lines.entries()) {
    const context = `${index > 0 ? lines[index - 1] : ""} ${line} ${index + 1 < lines.length ? lines[index + 1] : ""}`;
    for (const [rule, pattern] of RULES) {
      pattern.lastIndex = 0;
      if (!pattern.test(line)) continue;
      findings.push({
        rule,
        path: file.relativePath,
        line: index + 1,
        disposition: disposition(file.relativePath, context),
      });
    }
  }
  return findings;
}

/** Scan every MCP source, test, and public migration-document match. */
export async function scanMcpDeprecations(root) {
  const findings = [];
  for (const file of await collectSourceFiles(root)) {
    findings.push(...(await scanMcpDeprecationFile(file)));
  }
  findings.sort((left, right) =>
    `${left.path}:${String(left.line).padStart(8, "0")}:${left.rule}`.localeCompare(
      `${right.path}:${String(right.line).padStart(8, "0")}:${right.rule}`,
    ),
  );
  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    findings,
    counts: {
      total: findings.length,
      legacy_adapter: findings.filter(
        (finding) => finding.disposition === "legacy_adapter",
      ).length,
      migration_document: findings.filter(
        (finding) => finding.disposition === "migration_document",
      ).length,
      negative_control: findings.filter(
        (finding) => finding.disposition === "negative_control",
      ).length,
      bounded_source_control: findings.filter(
        (finding) => finding.disposition === "bounded_source_control",
      ).length,
      canonical_violation: findings.filter(
        (finding) => finding.disposition === "canonical_violation",
      ).length,
    },
  };
}

/** Run the gate and emit the generated inventory as stable JSON. */
export async function main(root = process.cwd()) {
  const report = await scanMcpDeprecations(root);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.counts.canonical_violation > 0) process.exitCode = 1;
  return report;
}
