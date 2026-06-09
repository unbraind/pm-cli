#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupTempRoot } from "./smoke-cleanup.mjs";

function resolveCommand(base) {
  return process.platform === "win32" ? `${base}.cmd` : base;
}

function readCommandError(error) {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const stderr = "stderr" in error ? String(error.stderr ?? "").trim() : "";
  const stdout = "stdout" in error ? String(error.stdout ?? "").trim() : "";
  return [error.message, stderr, stdout].filter((entry) => entry.length > 0).join("\n");
}

function runSmokeCommand(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  }).trim();
}

function run() {
  const npm = resolveCommand("npm");
  const npx = resolveCommand("npx");
  const tempRoot = mkdtempSync(path.join(tmpdir(), "pm-pack-smoke-"));

  const packOutput = execFileSync(npm, ["pack", "--silent", "--pack-destination", tempRoot], { encoding: "utf8" })
    .trim()
    .split("\n")
    .filter((line) => line.trim().length > 0);
  const tarball = packOutput.at(-1);
  if (!tarball) {
    throw new Error("npm pack did not produce a tarball name.");
  }
  const tarballPath = path.resolve(tempRoot, tarball);
  const tarballSpec = `file:${tarballPath}`;

  function runPackedPm(args, options = {}) {
    try {
      return runSmokeCommand(npx, ["--yes", "--package", tarballPath, "pm", ...args], options);
    } catch (npxError) {
      const output = runSmokeCommand(npm, ["exec", "--yes", "--package", tarballPath, "--", "pm", ...args], options);
      if (output.length === 0 && !args.includes("--version")) {
        return output;
      }
      if (output.length === 0) {
        throw new Error(`npx fallback produced empty output.\n${readCommandError(npxError)}`);
      }
      return output;
    }
  }

  try {
    const version = runPackedPm(["--version"]);
    if (version.length === 0) {
      throw new Error("npx smoke test returned empty version output.");
    }
    const directVersion = runSmokeCommand(npx, ["--yes", tarballSpec, "--version"]);
    if (directVersion !== version) {
      throw new Error(`Bare npx package smoke returned ${directVersion || "empty output"} instead of ${version}.`);
    }
    const directHelp = runSmokeCommand(npx, ["--yes", tarballSpec, "--help"]);
    if (directHelp.length === 0) {
      throw new Error("Bare npx package smoke returned empty help output.");
    }
    const aliasVersion = runSmokeCommand(npx, ["--yes", "--package", tarballPath, "pm-cli", "--version"]);
    if (aliasVersion !== version) {
      throw new Error(`pm-cli bin alias smoke returned ${aliasVersion || "empty output"} instead of ${version}.`);
    }
    const aliasHelp = runSmokeCommand(npx, ["--yes", "--package", tarballPath, "pm-cli", "--help"]);
    if (aliasHelp.length === 0) {
      throw new Error("pm-cli bin alias smoke returned empty help output.");
    }

    const projectRoot = path.join(tempRoot, "project");
    mkdirSync(projectRoot, { recursive: true });
    const pmPath = path.join(projectRoot, ".agents", "pm");
    const globalPath = path.join(tempRoot, "global");
    const commandEnv = {
      ...process.env,
      PM_PATH: pmPath,
      PM_GLOBAL_PATH: globalPath,
      PM_AUTHOR: "pack-smoke",
    };
    const commandOptions = {
      cwd: projectRoot,
      env: commandEnv,
    };
    runPackedPm(["init", "--defaults", "--author", "pack-smoke", "--json"], commandOptions);
    const installAll = JSON.parse(runPackedPm(["install", "all", "--project", "--json"], commandOptions));
    if (installAll?.details?.installed_all !== true || installAll?.details?.installed_count < 8) {
      throw new Error(`Packed install-all smoke returned unexpected payload: ${JSON.stringify(installAll)}`);
    }
    const catalog = JSON.parse(runPackedPm(["package", "catalog", "--project", "--json"], commandOptions));
    const packages = catalog?.details?.packages;
    if (!Array.isArray(packages) || packages.length < 4) {
      throw new Error(`Packed package catalog smoke returned unexpected payload: ${JSON.stringify(catalog)}`);
    }
    runPackedPm([
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
    ], commandOptions);
    const calendar = JSON.parse(runPackedPm([
      "calendar",
      "--json",
      "--view",
      "agenda",
      "--date",
      "2026-04-02T00:00:00.000Z",
      "--limit",
      "10",
    ], commandOptions));
    if ((calendar?.summary?.events ?? 0) < 1) {
      throw new Error(`Packed calendar smoke returned unexpected payload: ${JSON.stringify(calendar)}`);
    }
    const upgrade = JSON.parse(runPackedPm(["upgrade", "--packages-only", "--dry-run", "--json"], commandOptions));
    if (upgrade?.summary?.requested_packages !== true || !Array.isArray(upgrade?.packages)) {
      throw new Error(`Packed package upgrade smoke returned unexpected payload: ${JSON.stringify(upgrade)}`);
    }

    console.log(`npx packed package smoke passed (${version}, packages=${packages.length}).`);
  } finally {
    try {
      cleanupTempRoot(tempRoot);
    } catch (cleanupError) {
      // Cleanup failures should not mask the actual smoke result in CI.
      console.warn(`[pm-pack-smoke] cleanup warning for ${tempRoot}: ${readCommandError(cleanupError)}`);
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run();
}
