#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";

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

function runSmokeCommand(command, args) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function run() {
  const npm = resolveCommand("npm");
  const npx = resolveCommand("npx");

  const packOutput = execFileSync(npm, ["pack", "--silent"], { encoding: "utf8" })
    .trim()
    .split("\n")
    .filter((line) => line.trim().length > 0);
  const tarball = packOutput.at(-1);
  if (!tarball) {
    throw new Error("npm pack did not produce a tarball name.");
  }

  try {
    let version = "";
    try {
      version = runSmokeCommand(npx, ["--yes", "--package", `./${tarball}`, "pm", "--version"]);
    } catch (npxError) {
      version = runSmokeCommand(npm, ["exec", "--yes", "--package", `./${tarball}`, "--", "pm", "--version"]);
      if (version.length === 0) {
        throw new Error(`npx fallback produced empty version output.\n${readCommandError(npxError)}`);
      }
    }
    if (version.length === 0) {
      throw new Error("npx smoke test returned empty version output.");
    }
    console.log(`npx smoke check passed (${version}).`);
  } finally {
    rmSync(tarball, { force: true });
  }
}

run();
