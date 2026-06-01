#!/usr/bin/env node

import { readdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";

const repoRoot = process.cwd();
const entryPoint = path.join(repoRoot, "dist", "cli", "main.js");
const outputDir = path.join(repoRoot, "dist", "cli-bundle");
const binPath = path.join(repoRoot, "dist", "cli.js");

async function collectFiles(directory) {
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
    if (entry.isFile()) {
      files.push(absolutePath);
    }
  }
  return files;
}

async function removeStaleBundleFiles(outputs) {
  const expectedFiles = new Set(
    Object.keys(outputs).map((outputPath) => path.resolve(repoRoot, outputPath)),
  );
  const existingFiles = await collectFiles(outputDir);
  await Promise.all(
    existingFiles
      .filter((filePath) => !expectedFiles.has(filePath))
      .map((filePath) => unlink(filePath).catch((error) => {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
          return;
        }
        throw error;
      })),
  );
}

// Do not delete the live bundle before rebuilding. Agents often run docs,
// dogfood, and build gates concurrently in one checkout; removing this folder
// creates a transient broken `dist/cli.js` runtime.
const buildResult = await build({
  entryPoints: [entryPoint],
  outdir: outputDir,
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "node",
  target: ["node20"],
  packages: "external",
  sourcemap: true,
  metafile: true,
  entryNames: "[name]",
  chunkNames: "chunks/[name]-[hash]",
  logLevel: "warning",
});
await removeStaleBundleFiles(buildResult.metafile.outputs);

const binSource = await readFile(binPath, "utf8");
const sourceImport = 'await import("./cli/main.js")';
const bundledImport = 'await import("./cli-bundle/main.js")';
if (binSource.includes(bundledImport)) {
  process.exit(0);
}
const bundledBinSource = binSource.replace(sourceImport, bundledImport);
if (bundledBinSource === binSource) {
  throw new Error("Unable to rewrite dist/cli.js to use the bundled CLI entrypoint.");
}
await writeFile(binPath, bundledBinSource, "utf8");
