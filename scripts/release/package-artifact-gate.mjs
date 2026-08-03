#!/usr/bin/env node

/**
 * Fail-closed npm artifact composition and size gate.
 *
 * Tracker: pm-998juj. The gate inspects npm's own packlist projection, so its
 * verdict covers the artifact users actually install instead of the build tree.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Validate one npm pack report against the committed distribution budget. */
export function validatePackageArtifact(report, budget) {
  if (!Array.isArray(report) || report.length !== 1) {
    throw new TypeError("npm pack must return exactly one package report");
  }
  const artifact = report[0];
  if (
    typeof artifact !== "object" ||
    artifact === null ||
    !Array.isArray(artifact.files) ||
    typeof artifact.unpackedSize !== "number"
  ) {
    throw new TypeError("npm pack report is missing files or unpackedSize");
  }
  const paths = artifact.files
    .map((file) =>
      typeof file === "object" && file !== null && typeof file.path === "string"
        ? file.path
        : "",
    )
    .filter(Boolean);
  const violations = [];
  if (artifact.unpackedSize > budget.max_unpacked_bytes) {
    violations.push(
      `unpacked_size:${artifact.unpackedSize}>${budget.max_unpacked_bytes}`,
    );
  }
  if (paths.length > budget.max_file_count) {
    violations.push(`file_count:${paths.length}>${budget.max_file_count}`);
  }
  for (const suffix of budget.forbidden_suffixes) {
    const matches = paths.filter((file) => file.endsWith(suffix));
    if (matches.length > 0) {
      violations.push(`forbidden_suffix:${suffix}:${matches.length}`);
    }
  }
  violations.push(
    ...budget.required_paths
      .filter((required) => !paths.includes(required))
      .map((required) => `required_path_missing:${required}`),
  );
  if (violations.length > 0) {
    throw new Error(`Package artifact gate failed:\n${violations.join("\n")}`);
  }
  return {
    ok: true,
    package: artifact.name,
    version: artifact.version,
    unpacked_size: artifact.unpackedSize,
    file_count: paths.length,
    forbidden_suffixes: budget.forbidden_suffixes,
  };
}

const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const budget = JSON.parse(
  readFileSync(path.join(scriptRoot, "package-artifact-budget.json"), "utf8"),
);
const output = execFileSync(
  process.platform === "win32" ? "npm.cmd" : "npm",
  ["pack", "--dry-run", "--json", "--ignore-scripts"],
  { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
);
const report = JSON.parse(output);
console.log(JSON.stringify(validatePackageArtifact(report, budget), null, 2));
