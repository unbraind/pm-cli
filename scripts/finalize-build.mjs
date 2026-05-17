#!/usr/bin/env node

import { chmod, stat } from "node:fs/promises";
import path from "node:path";

const repoRoot = process.cwd();
const executableOutputs = [
  path.join(repoRoot, "dist", "cli.js"),
  path.join(repoRoot, "dist", "mcp", "server.js"),
];

async function outputExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

for (const outputPath of executableOutputs) {
  if (await outputExists(outputPath)) {
    await chmod(outputPath, 0o755);
  }
}
