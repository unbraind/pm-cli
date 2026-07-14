#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = process.cwd();
// CLI and SDK entrypoints share one esbuild invocation so their common code
// lands in shared chunks: installed extensions import `@unbrained/pm-cli/sdk`
// through the package `exports`, and resolving that to the same chunk graph the
// running CLI already loaded keeps per-command extension activation cheap
// (pm-4oww) and gives the CLI and extensions a single copy of core state.
const entryPoints = {
  main: path.join(repoRoot, "dist", "cli", "main.js"),
  sdk: path.join(repoRoot, "dist", "sdk", "index.js"),
  "sdk-runtime": path.join(repoRoot, "dist", "sdk", "runtime.js"),
  "sdk-testing": path.join(repoRoot, "dist", "sdk", "testing.js"),
};
const outputDir = path.join(repoRoot, "dist", "cli-bundle");
const lockDir = path.join(repoRoot, "dist", ".cli-bundle-build.lock");
const binPath = path.join(repoRoot, "dist", "cli.js");
const lockRetryMs = 250;
const lockTimeoutMs = 120_000;
const staleLockMs = 10 * 60_000;
const bundleStaleRetentionMs = 10 * 60_000;
const bundleManifestPath = path.join(outputDir, "bundle-manifest.json");

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function hasErrorCode(error, codes) {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      codes.includes(String(error.code)),
  );
}

async function readBundleBuildLockStats() {
  try {
    return await stat(lockDir);
  } catch (error) {
    if (hasErrorCode(error, ["ENOENT"])) {
      return null;
    }
    throw error;
  }
}

async function reclaimStaleBundleBuildLock() {
  const staleCandidateDir = `${lockDir}.stale.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  try {
    await rename(lockDir, staleCandidateDir);
    await rm(staleCandidateDir, { recursive: true, force: true });
  } catch (error) {
    if (!hasErrorCode(error, ["ENOENT", "EEXIST", "ENOTEMPTY"])) {
      throw error;
    }
  }
}

export async function acquireBundleBuildLock() {
  await mkdir(path.dirname(lockDir), { recursive: true });
  const startedAt = Date.now();
  while (true) {
    try {
      await mkdir(lockDir);
      return async () => {
        await rm(lockDir, { recursive: true, force: true });
      };
    } catch (error) {
      if (!hasErrorCode(error, ["EEXIST"])) {
        throw error;
      }
      const lockStats = await readBundleBuildLockStats();
      if (!lockStats) {
        continue;
      }
      if (Date.now() - lockStats.mtimeMs > staleLockMs) {
        await reclaimStaleBundleBuildLock();
        continue;
      }
      if (Date.now() - startedAt > lockTimeoutMs) {
        throw new Error(`Timed out waiting for bundle build lock at ${lockDir}`);
      }
      await sleep(lockRetryMs);
    }
  }
}

export async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  });
  const files = [];
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectFiles(absolutePath));
      continue;
    }
    if (entry.isFile() || entry.isSymbolicLink()) {
      files.push(absolutePath);
    }
  }
  return files;
}

export async function removeStaleBundleFiles(outputs) {
  const expectedFiles = new Set(
    Object.keys(outputs).map((outputPath) => path.resolve(repoRoot, outputPath)),
  );
  const existingFiles = await collectFiles(outputDir);
  const now = Date.now();
  await Promise.all(
    existingFiles
      .filter((filePath) => !expectedFiles.has(filePath))
      .map(async (filePath) => {
        const fileStats = await lstat(filePath).catch(() => null);
        if (!fileStats || now - fileStats.mtimeMs < bundleStaleRetentionMs) {
          return;
        }
        await unlink(filePath).catch(() => {});
      }),
  );
}

export async function writeBundleManifest(outputs) {
  const files = [];
  for (const outputPath of Object.keys(outputs).sort((left, right) => left.localeCompare(right))) {
    const absolutePath = path.resolve(repoRoot, outputPath);
    if (!absolutePath.startsWith(`${outputDir}${path.sep}`)) {
      continue;
    }
    const relativePath = path.relative(outputDir, absolutePath).split(path.sep).join("/");
    const contents = await readFile(absolutePath);
    files.push({
      path: relativePath,
      sha256: createHash("sha256").update(contents).digest("hex"),
    });
  }
  const generation = createHash("sha256")
    .update(files.map((entry) => `${entry.path}:${entry.sha256}`).join("\n"))
    .digest("hex");
  const temporaryPath = `${bundleManifestPath}.tmp-${process.pid}`;
  await writeFile(
    temporaryPath,
    `${JSON.stringify({ schema_version: 1, generation, files }, null, 2)}\n`,
    "utf8",
  );
  await rename(temporaryPath, bundleManifestPath);
}

export async function main() {
  // Do not delete the live bundle before rebuilding. Agents often run docs,
  // dogfood, and build gates concurrently in one checkout; removing this folder
  // creates a transient broken `dist/cli.js` runtime.
  const releaseBundleBuildLock = await acquireBundleBuildLock();
  try {
    const buildResult = await build({
      entryPoints,
      outdir: outputDir,
      bundle: true,
      splitting: true,
      format: "esm",
      platform: "node",
      target: ["node22"],
      packages: "external",
      sourcemap: true,
      metafile: true,
      entryNames: "[name]",
      chunkNames: "chunks/[name]-[hash]",
      logLevel: "warning",
    });
    await removeStaleBundleFiles(buildResult.metafile.outputs);
    await writeBundleManifest(buildResult.metafile.outputs);
  } finally {
    await releaseBundleBuildLock();
  }

  const binSource = await readFile(binPath, "utf8");
  const sourceImport = '"./cli/main.js"';
  const bundledImport = '"./cli-bundle/main.js"';
  if (binSource.includes(bundledImport)) {
    process.exit(0);
  }
  const bundledBinSource = binSource.replace(sourceImport, bundledImport);
  if (bundledBinSource === binSource) {
    throw new Error("Unable to rewrite dist/cli.js to use the bundled CLI entrypoint.");
  }
  await writeFile(binPath, bundledBinSource, "utf8");
}

/* c8 ignore start -- CLI auto-run guard; logic covered via exported main() */
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
/* c8 ignore stop */
