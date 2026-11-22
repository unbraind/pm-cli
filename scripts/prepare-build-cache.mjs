#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, rm, stat } from "node:fs/promises";
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

/** The first compacted output whose bytes no longer match the digest its ledger recorded, if any. */
async function changedCompactedOutput(repoRoot, ledgerPath) {
  let recorded;
  try {
    recorded = JSON.parse(await readFile(ledgerPath, "utf8")).files;
  } catch {
    return undefined;
  }
  for (const [relative, digest] of Object.entries(recorded ?? {})) {
    const actual = await readFile(path.join(repoRoot, "dist", relative)).then((bytes) => createHash("sha256").update(bytes).digest("hex"), () => null);
    if (actual !== digest) return relative;
  }
  return undefined;
}

export async function main(repoRoot = process.cwd()) {
  const buildInfoPath = path.join(repoRoot, ".cache", "tsbuildinfo", "pm-cli.tsbuildinfo");
  const requiredOutputs = [
    path.join(repoRoot, "dist", "cli.js"),
    path.join(repoRoot, "dist", "sdk", "index.js"),
    // Without its ledger the finalizer cannot tell compacted outputs from raw ones; a full
    // re-emit hands it raw compiler output instead of compacting already shortened modules again.
    path.join(repoRoot, "dist", ".runtime-compaction.json"),
  ];

  const missingOutput = [];
  for (const outputPath of requiredOutputs) {
    if (!(await exists(outputPath))) {
      missingOutput.push(path.relative(repoRoot, outputPath));
    }
  }

  // An output changed since it was compacted (source-map injection, a stopped build) would be shortened a
  // second time; without the ledger the finalizer compacts every output of a full re-emit instead.
  const ledgerPath = path.join(repoRoot, "dist", ".runtime-compaction.json");
  if (missingOutput.length === 0 && (await changedCompactedOutput(repoRoot, ledgerPath)) !== undefined) {
    await rm(ledgerPath, { force: true });
    missingOutput.push("dist/.runtime-compaction.json (an output changed after compaction)");
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
