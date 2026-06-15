#!/usr/bin/env node

import { rm, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

async function exists(filePath) {
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
  const buildInfoPath = path.join(repoRoot, ".cache", "tsbuildinfo", "pm-cli.tsbuildinfo");
  const requiredOutputs = [
    path.join(repoRoot, "dist", "cli.js"),
    path.join(repoRoot, "dist", "sdk", "index.js"),
  ];

  const missingOutput = [];
  for (const outputPath of requiredOutputs) {
    if (!(await exists(outputPath))) {
      missingOutput.push(path.relative(repoRoot, outputPath));
    }
  }

  if (missingOutput.length > 0 && (await exists(buildInfoPath))) {
    await rm(buildInfoPath, { force: true });
    console.warn(
      `Removed stale TypeScript build cache because required build output is missing: ${missingOutput.join(", ")}`,
    );
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
