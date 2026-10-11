#!/usr/bin/env node

import crossSpawn from "cross-spawn";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupTempRoot } from "./smoke-cleanup.mjs";
import { registerTempCleanup } from "./temp-lifecycle.mjs";
import { verifyInstalledAgentRecovery } from "./release/agent-recovery-acceptance.mjs";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const COMMAND_TIMEOUT_MS = 600_000;

/** Resolve the native package-manager shim; the portable launcher handles Windows command interpreters. */
function resolveCommand(base) {
  return process.platform === "win32"
    ? `${base}.${base === "bunx" ? "exe" : "cmd"}`
    : base;
}

/** Render bounded subprocess evidence when a smoke assertion fails. */
function readCommandError(error) {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const stderr = "stderr" in error ? String(error.stderr ?? "").trim() : "";
  const stdout = "stdout" in error ? String(error.stdout ?? "").trim() : "";
  return [error.message, stderr, stdout]
    .filter((entry) => entry.length > 0)
    .join("\n");
}

/** Execute one smoke command with the shared hosted-runner timeout contract. */
function runSmokeCommand(command, args, options = {}) {
  const result = crossSpawn.sync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: COMMAND_TIMEOUT_MS,
    ...options,
  });
  if (result.error || result.status !== 0) {
    throw Object.assign(
      result.error ?? new Error(`${command} failed (${String(result.status)})`),
      {
        stdout: result.stdout,
        stderr: result.stderr,
      },
    );
  }
  return result.stdout.trim();
}

/** Build the current package and return the absolute packed artifact path. */
function packCurrentPackage(tempRoot) {
  const report = JSON.parse(
    runSmokeCommand(process.execPath, [
      path.join(REPO_ROOT, "scripts/release/package-distribution.mjs"),
      `--destination=${tempRoot}`,
    ]),
  );
  if (!report.filename)
    throw new Error("npm pack did not produce a tarball name.");
  return path.resolve(tempRoot, report.filename);
}

/** Reject commands that succeed without returning the evidence under test. */
function assertNonEmptyOutput(label, output, noun = "output") {
  if (output.length === 0) {
    throw new Error(`${label} returned empty ${noun}.`);
  }
}

/** Require an executor to expose the package's exact canonical result. */
function assertEqualOutput(label, actual, expected, noun = "output") {
  if (actual !== expected) {
    throw new Error(
      `${label} returned ${actual || `empty ${noun}`} instead of ${expected}.`,
    );
  }
}

/** Build a runner against one installed tarball consumer without repeated npm reification. */
function buildPackedPmRunner(npm, consumerRoot) {
  return (args, options = {}) =>
    runSmokeCommand(
      npm,
      ["exec", "--prefix", consumerRoot, "--", "pm", ...args],
      options,
    );
}

/** Exercise both package bin names while limiting cold npx installs to two. */
function assertPackedBinarySmoke(npx, tarballPath, tarballSpec, version) {
  assertEqualOutput(
    "Bare npx package smoke",
    runSmokeCommand(npx, ["--yes", tarballSpec, "--version"]),
    version,
    "version output",
  );
  assertNonEmptyOutput(
    "pm-cli bin alias smoke",
    runSmokeCommand(npx, [
      "--yes",
      "--package",
      tarballPath,
      "pm-cli",
      "--help",
    ]),
    "help",
  );
}

/** Install the packed artifact once for multi-command workflow and type checks. */
function installPackedConsumer(npm, tarballPath, tempRoot) {
  const consumerRoot = path.join(tempRoot, "consumer");
  mkdirSync(consumerRoot, { recursive: true });
  writeFileSync(
    path.join(consumerRoot, "package.json"),
    `${JSON.stringify({ name: "pm-pack-consumer", private: true, type: "module", devDependencies: { "@types/node": "^22 || ^24 || ^26" } }, null, 2)}\n`,
  );
  runSmokeCommand(npm, ["install", "--no-audit", "--no-fund", tarballPath], {
    cwd: consumerRoot,
  });
  runSmokeCommand(process.execPath, [
    path.join(REPO_ROOT, "scripts/release/verify-runtime-installation.mjs"),
    path.join(consumerRoot, "node_modules", "@unbrained", "pm-cli"),
  ]);
  return consumerRoot;
}

/** Create isolated tracker and global roots for packed CLI workflows. */
function createPackedSmokeProject(tempRoot) {
  const projectRoot = path.join(tempRoot, "project");
  mkdirSync(projectRoot, { recursive: true });
  const pmPath = path.join(projectRoot, ".agents", "pm");
  const globalPath = path.join(tempRoot, "global");
  return {
    commandOptions: {
      cwd: projectRoot,
      env: {
        ...process.env,
        PM_PATH: pmPath,
        PM_GLOBAL_PATH: globalPath,
        PM_AUTHOR: "pack-smoke",
      },
    },
  };
}

/** Verify packaged extension installation and catalog discovery end to end. */
function assertPackedPackageWorkflows(runPackedPm, commandOptions) {
  runPackedPm(
    ["init", "--defaults", "--author", "pack-smoke", "--json"],
    commandOptions,
  );
  const installAll = JSON.parse(
    runPackedPm(["install", "all", "--project", "--json"], commandOptions),
  );
  if (
    installAll?.details?.installed_all !== true ||
    installAll?.details?.installed_count < 8
  ) {
    throw new Error(
      `Packed install-all smoke returned unexpected payload: ${JSON.stringify(installAll)}`,
    );
  }
  const catalog = JSON.parse(
    runPackedPm(["package", "catalog", "--project", "--json"], commandOptions),
  );
  const packages = catalog?.details?.packages;
  if (!Array.isArray(packages) || packages.length < 4) {
    throw new Error(
      `Packed package catalog smoke returned unexpected payload: ${JSON.stringify(catalog)}`,
    );
  }
  return packages;
}

/** Verify a packed CLI can create and query deadline/reminder calendar data. */
function assertPackedCalendarWorkflow(runPackedPm, commandOptions) {
  runPackedPm(
    [
      "create",
      "--title",
      "Packed calendar item",
      "--description",
      "Packed smoke item",
      "--type",
      "Task",
      "--status",
      "open",
      "--priority",
      "1",
      "--deadline",
      "2026-04-02T12:00:00.000Z",
      "--reminder",
      "at=2026-04-02T09:30:00.000Z,text=packed reminder",
      "--message",
      "Packed smoke create",
      "--json",
    ],
    commandOptions,
  );
  const calendar = JSON.parse(
    runPackedPm(
      [
        "calendar",
        "--json",
        "--view",
        "agenda",
        "--date",
        "2026-04-02T00:00:00.000Z",
        "--limit",
        "10",
      ],
      commandOptions,
    ),
  );
  if ((calendar?.summary?.events ?? 0) < 1) {
    throw new Error(
      `Packed calendar smoke returned unexpected payload: ${JSON.stringify(calendar)}`,
    );
  }
}

/**
 * Compile the packed SDK and load its CLI entrypoint from a plain consumer.
 *
 * The compiler executable comes from this checkout, but Node declarations must
 * resolve from the consumer's declared optional SDK peer so GH-602 cannot
 * regress behind repository-local dependencies. CLI-only installs omit it.
 */
function assertPackedTypescriptConsumer(consumerRoot) {
  writeFileSync(
    path.join(consumerRoot, "consumer.ts"),
    [
      'import { assertTestMeasurementRun, quoteCommandArg } from "@unbrained/pm-cli/sdk";',
      'export const quoted: string = quoteCommandArg("pack-smoke", "linux");',
      'assertTestMeasurementRun("pm-consumer", { onlyIndex: 2, removeIndex: [2] }, {}, "/isolated/tracker");',
      "",
    ].join("\n"),
  );
  writeFileSync(
    path.join(consumerRoot, "cli-consumer.mjs"),
    [
      'import * as cli from "@unbrained/pm-cli/cli";',
      'import assert from "node:assert/strict";',
      'import { assertTestMeasurementRun, PmCliError } from "@unbrained/pm-cli/sdk";',
      'assert.throws(() => assertTestMeasurementRun("pm-consumer", { measure: ["coverage=100"], onlyIndex: 2 }, {}, "/isolated/tracker"), (error) => {',
      "  assert(error instanceof PmCliError);",
      '  assert.equal(error.context.code, "test_measure_requires_run");',
      '  assert.deepEqual(error.context.recovery.suggested_retry_args, ["--pm-path", "/isolated/tracker", "test", "pm-consumer", "--run", "--json", "--progress", "--only-index", "2", "--measure", "coverage=100"]);',
      "  return true;",
      "});",
      "const exportedNames = Object.keys(cli).sort();",
      'const expectedNames = ["runPmCli"];',
      "if (JSON.stringify(exportedNames) !== JSON.stringify(expectedNames)) {",
      '  throw new Error(`Unexpected ./cli exports: ${exportedNames.join(", ")}`);',
      "}",
      "",
    ].join("\n"),
  );
  writeFileSync(
    path.join(consumerRoot, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          module: "nodenext",
          moduleResolution: "nodenext",
          types: ["node"],
          typeRoots: [path.join(consumerRoot, "node_modules", "@types")],
        },
        include: ["consumer.ts"],
      },
      null,
      2,
    )}\n`,
  );
  runSmokeCommand(
    process.execPath,
    [
      path.join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc"),
      "-p",
      consumerRoot,
    ],
    { cwd: consumerRoot },
  );
  runSmokeCommand(
    process.execPath,
    [path.join(consumerRoot, "cli-consumer.mjs")],
    {
      cwd: consumerRoot,
    },
  );
}

/** Run the complete npm, npx, bunx, CLI workflow, and SDK consumer acceptance. */
function run() {
  const npm = resolveCommand("npm");
  const npx = resolveCommand("npx");
  const bunx = resolveCommand("bunx");
  const tempRoot = mkdtempSync(path.join(tmpdir(), "pm-pack-smoke-"));
  const releaseCleanup = registerTempCleanup(tempRoot);

  try {
    const tarballPath = packCurrentPackage(tempRoot);
    const tarballSpec = `file:${tarballPath}`;
    const consumerRoot = installPackedConsumer(npm, tarballPath, tempRoot);
    const runPackedPm = buildPackedPmRunner(npm, consumerRoot);
    const version = runPackedPm(["--version"]);
    assertNonEmptyOutput("npx smoke test", version, "version output");
    assertEqualOutput(
      "bunx packed pm smoke",
      runSmokeCommand(
        bunx,
        ["--silent", "--bun", "--package", tarballPath, "pm", "--version"],
        { env: { ...process.env, TMPDIR: tempRoot } },
      ),
      version,
      "version output",
    );
    assertPackedBinarySmoke(npx, tarballPath, tarballSpec, version);
    const { commandOptions } = createPackedSmokeProject(tempRoot);
    const packages = assertPackedPackageWorkflows(runPackedPm, commandOptions);
    verifyInstalledAgentRecovery(
      npx,
      ["--prefix", consumerRoot, "--no", "--", "pm"],
      commandOptions,
    );
    verifyInstalledAgentRecovery(
      bunx,
      ["--silent", "--bun", "--package", tarballPath, "pm"],
      {
        ...commandOptions,
        env: { ...commandOptions.env, TMPDIR: tempRoot },
      },
    );
    assertPackedCalendarWorkflow(runPackedPm, commandOptions);
    const upgrade = JSON.parse(
      runPackedPm(
        ["upgrade", "--packages-only", "--dry-run", "--json"],
        commandOptions,
      ),
    );
    if (
      upgrade?.summary?.requested_packages !== true ||
      !Array.isArray(upgrade?.packages)
    ) {
      throw new Error(
        `Packed package upgrade smoke returned unexpected payload: ${JSON.stringify(upgrade)}`,
      );
    }
    assertPackedTypescriptConsumer(consumerRoot);

    console.log(
      `npx and bunx packed package smoke passed (${version}, packages=${packages.length}).`,
    );
  } finally {
    try {
      cleanupTempRoot(tempRoot);
      releaseCleanup();
    } catch (cleanupError) {
      // Cleanup failures should not mask the actual smoke result in CI.
      console.warn(
        `[pm-pack-smoke] cleanup warning for ${tempRoot}: ${readCommandError(cleanupError)}`,
      );
    }
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  run();
}
