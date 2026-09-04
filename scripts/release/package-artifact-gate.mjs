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

/** Resolve a named unpacked-size ceiling and reject malformed budget profiles. */
function resolveMaxUnpackedSize(budget, profile) {
  if (
    typeof budget.max_unpacked_bytes_by_profile !== "object" ||
    budget.max_unpacked_bytes_by_profile === null
  ) {
    throw new TypeError("Package artifact budget is missing named size profiles");
  }
  if (!Object.hasOwn(budget.max_unpacked_bytes_by_profile, profile)) {
    throw new RangeError(`Unknown package artifact profile: ${profile}`);
  }
  const maxUnpackedSize = budget.max_unpacked_bytes_by_profile[profile];
  if (typeof maxUnpackedSize !== "number") {
    throw new TypeError(`Package artifact profile ${profile} is not numeric`);
  }
  if (!Number.isFinite(maxUnpackedSize)) {
    throw new TypeError(`Package artifact profile ${profile} is not finite`);
  }
  return maxUnpackedSize;
}

/** Validate one npm pack report against a named committed distribution budget. */
export function validatePackageArtifact(report, budget, profile = "base") {
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
  const maxUnpackedSize = resolveMaxUnpackedSize(budget, profile);
  const paths = artifact.files
    .map((file) =>
      typeof file === "object" && file !== null && typeof file.path === "string"
        ? file.path
        : "",
    )
    .filter(Boolean);
  const violations = [];
  if (artifact.unpackedSize > maxUnpackedSize) {
    violations.push(
      `unpacked_size:${artifact.unpackedSize}>${maxUnpackedSize}`,
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
    profile,
    package: artifact.name,
    version: artifact.version,
    unpacked_size: artifact.unpackedSize,
    max_unpacked_size: maxUnpackedSize,
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
const profileArguments = process.argv.slice(2).filter((argument) =>
  argument.startsWith("--profile"),
);
if (profileArguments.length > 1) {
  throw new TypeError("Package artifact gate accepts at most one --profile");
}
const profileArgument = profileArguments[0];
if (
  profileArgument !== undefined &&
  (!profileArgument.startsWith("--profile=") ||
    profileArgument.length === "--profile=".length)
) {
  throw new TypeError("Package artifact gate requires --profile=<name>");
}
const profile = profileArgument?.slice("--profile=".length) ?? "base";
console.log(
  JSON.stringify(validatePackageArtifact(report, budget, profile), null, 2),
);
