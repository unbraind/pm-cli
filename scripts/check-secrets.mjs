#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export { RULES, scanContent } from "./check-secrets-lib.mjs";
import { scanContent } from "./check-secrets-lib.mjs";

function fail(message) {
  console.error(message);
  process.exit(1);
}

function gitTrackedFiles() {
  const output = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" });
  return output.split("\0").filter((entry) => entry.length > 0);
}

function isLikelyBinary(buffer) {
  const sampleSize = Math.min(buffer.length, 4096);
  for (let index = 0; index < sampleSize; index += 1) {
    if (buffer[index] === 0) {
      return true;
    }
  }
  return false;
}

function run() {
  const findings = [];
  const files = gitTrackedFiles();

  for (const file of files) {
    let buffer;
    try {
      buffer = readFileSync(file);
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
        // Skip tracked paths that are intentionally deleted in the current worktree.
        continue;
      }
      const message = error instanceof Error ? error.message : String(error);
      fail(`Failed to read ${file}: ${message}`);
    }

    if (buffer.length === 0 || isLikelyBinary(buffer)) {
      continue;
    }

    findings.push(...scanContent(file, buffer.toString("utf8")));
  }

  if (findings.length > 0) {
    console.error("Potential secrets detected:");
    for (const finding of findings) {
      console.error(`- ${finding.file}:${finding.line} [${finding.rule}] redacted`);
    }
    process.exit(1);
  }

  console.log("No credential-like secrets detected in tracked files.");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  run();
}
