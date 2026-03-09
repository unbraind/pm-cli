#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";

function resolveCommand(base) {
  return process.platform === "win32" ? `${base}.cmd` : base;
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
    const version = execFileSync(npx, ["--yes", `./${tarball}`, "--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (version.length === 0) {
      throw new Error("npx smoke test returned empty version output.");
    }
    console.log(`npx smoke check passed (${version}).`);
  } finally {
    rmSync(tarball, { force: true });
  }
}

run();
