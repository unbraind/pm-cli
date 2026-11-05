#!/usr/bin/env node

/**
 * Fail-closed npm artifact composition and size gate.
 *
 * Tracker: pm-998juj. The gate inspects npm's own packlist projection, so its
 * verdict covers the artifact users actually install instead of the build tree.
 */
import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Read one fixed unpacked-size ceiling and reject malformed values. */
function readFixedCeiling(budget, profile) {
  const maxUnpackedSize = budget.max_unpacked_bytes_by_profile[profile];
  if (typeof maxUnpackedSize !== "number") {
    throw new TypeError(`Package artifact profile ${profile} is not numeric`);
  }
  if (!Number.isFinite(maxUnpackedSize)) {
    throw new TypeError(`Package artifact profile ${profile} is not finite`);
  }
  return maxUnpackedSize;
}

/** Require the declared shape of a derived injection profile before trusting its allowance. */
function readInjectionProfile(budget, profile) {
  const declaration = budget.injection_profiles[profile];
  if (
    typeof declaration?.base_profile !== "string" ||
    !Object.hasOwn(budget.max_unpacked_bytes_by_profile, declaration.base_profile)
  ) {
    throw new TypeError(
      `Injection profile ${profile} must name a fixed base profile`,
    );
  }
  for (const field of ["injected_prefix", "injected_suffix"]) {
    if (
      typeof declaration[field] !== "string" ||
      declaration[field].length === 0
    ) {
      throw new TypeError(
        `Injection profile ${profile} requires a non-empty ${field}`,
      );
    }
  }
  if (
    !Number.isSafeInteger(declaration.max_bytes_per_injected_file) ||
    declaration.max_bytes_per_injected_file <= 0
  ) {
    throw new TypeError(
      `Injection profile ${profile} requires a positive safe integer max_bytes_per_injected_file`,
    );
  }
  return declaration;
}

/**
 * Resolve a named unpacked-size ceiling and reject malformed budget profiles.
 *
 * A fixed profile states its ceiling directly. An injection profile derives it:
 * the base ceiling plus a bounded per-file allowance for every packed file the
 * transform rewrites. Debug-ID injection adds a fixed-length snippet to each
 * emitted JavaScript file, so a constant allowance stops covering the transform
 * as soon as the file count grows past it; the derived ceiling cannot, while the
 * base profile keeps bounding every byte the transform did not add.
 */
function resolveMaxUnpackedSize(budget, profile, paths) {
  if (
    typeof budget.max_unpacked_bytes_by_profile !== "object" ||
    budget.max_unpacked_bytes_by_profile === null
  ) {
    throw new TypeError(
      "Package artifact budget is missing named size profiles",
    );
  }
  if (Object.hasOwn(budget.max_unpacked_bytes_by_profile, profile)) {
    return { maxUnpackedSize: readFixedCeiling(budget, profile) };
  }
  if (
    typeof budget.injection_profiles !== "object" ||
    budget.injection_profiles === null ||
    !Object.hasOwn(budget.injection_profiles, profile)
  ) {
    throw new RangeError(`Unknown package artifact profile: ${profile}`);
  }
  const declaration = readInjectionProfile(budget, profile);
  const injectedFileCount = paths.filter(
    (file) =>
      file.startsWith(declaration.injected_prefix) &&
      file.endsWith(declaration.injected_suffix),
  ).length;
  const injectionAllowance =
    injectedFileCount * declaration.max_bytes_per_injected_file;
  return {
    maxUnpackedSize:
      readFixedCeiling(budget, declaration.base_profile) + injectionAllowance,
    injection: {
      base_profile: declaration.base_profile,
      injected_file_count: injectedFileCount,
      max_bytes_per_injected_file: declaration.max_bytes_per_injected_file,
      injection_allowance: injectionAllowance,
    },
  };
}

/** Normalize npm 11/12 receipts without accepting ambiguous or misidentified artifacts. */
function readSingleArtifact(report) {
  const artifacts = Array.isArray(report)
    ? report
    : Array.isArray(report?.files)
      ? [report]
      : Object.values(
          report !== null && typeof report === "object" ? report : {},
        );
  if (artifacts.length !== 1) {
    throw new TypeError("npm pack must return exactly one package report");
  }
  const artifact = artifacts[0];
  if (
    typeof artifact !== "object" ||
    artifact === null ||
    !Array.isArray(artifact.files) ||
    typeof artifact.unpackedSize !== "number"
  ) {
    throw new TypeError("npm pack report is missing files or unpackedSize");
  }
  if (
    !Array.isArray(report) &&
    report !== artifact &&
    report[artifact.name] !== artifact
  ) {
    throw new TypeError(
      "npm pack keyed report identity must match its package name",
    );
  }
  return artifact;
}

/** Require explicit non-negative integer ceilings before counting bundled runtime files. */
function resolveRuntimeBundleBudget(budget) {
  for (const field of ["max_unpacked_bytes", "max_file_count"]) {
    if (!Number.isSafeInteger(budget?.[field]) || budget[field] < 0) {
      throw new TypeError(
        `Runtime bundle budget requires a non-negative safe integer ${field}`,
      );
    }
  }
  return budget;
}

/** Validate one npm pack report against a named committed distribution budget. */
export function validatePackageArtifact(report, budget, profile = "base") {
  const artifact = readSingleArtifact(report);
  const paths = artifact.files
    .map((file) =>
      typeof file === "object" && file !== null && typeof file.path === "string"
        ? file.path
        : "",
    )
    .filter(Boolean);
  const { maxUnpackedSize, injection } = resolveMaxUnpackedSize(
    budget,
    profile,
    paths,
  );
  const violations = [];
  const runtimeFiles = artifact.files.filter((file) =>
    file?.path?.startsWith("node_modules/"),
  );
  const runtimeSize = runtimeFiles.reduce(
    (total, file) => total + file.size,
    0,
  );
  const runtimeBudget = runtimeFiles.length
    ? resolveRuntimeBundleBudget(budget.runtime_bundle)
    : undefined;
  if (
    runtimeFiles.length &&
    (!Number.isFinite(runtimeSize) ||
      runtimeSize > runtimeBudget.max_unpacked_bytes ||
      runtimeFiles.length > runtimeBudget.max_file_count)
  )
    violations.push("runtime_bundle_budget_exceeded");
  const distributionSize = artifact.unpackedSize - runtimeSize;
  const distributionCount = paths.length - runtimeFiles.length;
  if (distributionSize > maxUnpackedSize) {
    violations.push(`unpacked_size:${distributionSize}>${maxUnpackedSize}`);
  }
  if (distributionCount > budget.max_file_count) {
    violations.push(`file_count:${distributionCount}>${budget.max_file_count}`);
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
    ...(injection === undefined ? {} : { injection }),
    file_count: paths.length,
    distribution_size: distributionSize,
    distribution_file_count: distributionCount,
    runtime_bundle_size: runtimeSize,
    runtime_bundle_file_count: runtimeFiles.length,
    forbidden_suffixes: budget.forbidden_suffixes,
  };
}

/**
 * Add the bytes a real transform adds to each packed file, measured on a
 * disposable copy so the checkout's build output is never rewritten.
 *
 * Pre-tag preflight uses this to check the exact injected profile the release
 * workflow later enforces in place. Injecting the checkout itself would leave
 * injected modules behind that an incremental rebuild does not re-emit.
 */
export function simulateInjection(report, budget, profile, { root, inject }) {
  const artifact = readSingleArtifact(report);
  if (
    typeof budget.injection_profiles !== "object" ||
    budget.injection_profiles === null ||
    !Object.hasOwn(budget.injection_profiles, profile)
  ) {
    throw new RangeError(
      `--simulate-injection requires an injection profile, not ${profile}`,
    );
  }
  const declaration = readInjectionProfile(budget, profile);
  const scratch = mkdtempSync(path.join(tmpdir(), "pm-artifact-injection-"));
  try {
    const copy = path.join(scratch, declaration.injected_prefix);
    cpSync(path.join(root, declaration.injected_prefix), copy, {
      recursive: true,
    });
    inject(copy);
    let addedBytes = 0;
    let injectedFiles = 0;
    const files = artifact.files.map((file) => {
      if (
        typeof file?.path !== "string" ||
        !file.path.startsWith(declaration.injected_prefix) ||
        !file.path.endsWith(declaration.injected_suffix)
      ) {
        return file;
      }
      const added =
        statSync(path.join(scratch, file.path)).size -
        statSync(path.join(root, file.path)).size;
      addedBytes += added;
      if (added > 0) injectedFiles += 1;
      return { ...file, size: file.size + added };
    });
    return {
      report: {
        ...artifact,
        unpackedSize: artifact.unpackedSize + addedBytes,
        files,
      },
      simulation: {
        source: "disposable_copy",
        injected_file_count: injectedFiles,
        added_bytes: addedBytes,
      },
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Run the checkout's installed sentry-cli debug-ID injection on one directory. */
async function createSentryInjector(root) {
  const { createRequire } = await import("node:module");
  const { SentryCli } = createRequire(path.join(root, "package.json"))(
    "@sentry/cli",
  );
  const binary = SentryCli.getPath();
  return (directory) =>
    execFileSync(binary, ["sourcemaps", "inject", directory], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, SENTRY_DISABLE_UPDATE_CHECK: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
}

const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const budget = JSON.parse(
  readFileSync(path.join(scriptRoot, "package-artifact-budget.json"), "utf8"),
);
const output = execFileSync(
  process.execPath,
  [path.join(scriptRoot, "package-distribution.mjs")],
  { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
);
const report = JSON.parse(output);
const profileArguments = process.argv
  .slice(2)
  .filter((argument) => argument.startsWith("--profile"));
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
if (process.argv.slice(2).includes("--simulate-injection")) {
  const root = process.cwd();
  const { report: injectedReport, simulation } = simulateInjection(
    report,
    budget,
    profile,
    { root, inject: await createSentryInjector(root) },
  );
  console.log(
    JSON.stringify(
      {
        ...validatePackageArtifact(injectedReport, budget, profile),
        simulation,
      },
      null,
      2,
    ),
  );
} else {
  console.log(
    JSON.stringify(validatePackageArtifact(report, budget, profile), null, 2),
  );
}
