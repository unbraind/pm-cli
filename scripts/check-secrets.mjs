#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const RULES = [
  { name: "private-key", regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { name: "github-token", regex: /\b(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g },
  { name: "npm-token", regex: /\bnpm_[A-Za-z0-9]{20,}\b/g },
  { name: "aws-access-key", regex: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "google-api-key", regex: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: "slack-token", regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: "jwt-like-token", regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { name: "npm-auth-token-assignment", regex: /_authToken\s*=\s*\S+/g },
];

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

function lineNumberFromIndex(content, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (content.charCodeAt(i) === 10) {
      line += 1;
    }
  }
  return line;
}

function excerptAround(content, index, width = 80) {
  const start = Math.max(0, index - width);
  const end = Math.min(content.length, index + width);
  return content
    .slice(start, end)
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "")
    .trim();
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

    const content = buffer.toString("utf8");
    for (const rule of RULES) {
      const matches = content.matchAll(rule.regex);
      for (const match of matches) {
        const index = match.index ?? 0;
        findings.push({
          file,
          rule: rule.name,
          line: lineNumberFromIndex(content, index),
          excerpt: excerptAround(content, index),
        });
      }
    }
  }

  if (findings.length > 0) {
    console.error("Potential secrets detected:");
    for (const finding of findings) {
      console.error(`- ${finding.file}:${finding.line} [${finding.rule}] ${finding.excerpt}`);
    }
    process.exit(1);
  }

  console.log("No credential-like secrets detected in tracked files.");
}

run();
