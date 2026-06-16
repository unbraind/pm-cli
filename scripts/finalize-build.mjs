#!/usr/bin/env node

import { chmod, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

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

export async function main(repoRoot = process.cwd()) {
  const executableOutputs = [
    path.join(repoRoot, "dist", "cli.js"),
    path.join(repoRoot, "dist", "mcp", "server.js"),
  ];

  for (const outputPath of executableOutputs) {
    if (await outputExists(outputPath)) {
      await chmod(outputPath, 0o755);
    }
  }
}

/* c8 ignore start -- CLI auto-run guard; logic covered via exported main() */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
/* c8 ignore stop */
