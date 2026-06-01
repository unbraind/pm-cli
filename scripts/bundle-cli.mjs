#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";

const repoRoot = process.cwd();
const entryPoint = path.join(repoRoot, "dist", "cli", "main.js");
const outputDir = path.join(repoRoot, "dist", "cli-bundle");
const binPath = path.join(repoRoot, "dist", "cli.js");

// Do not delete the live bundle before rebuilding. Agents often run docs,
// dogfood, and build gates concurrently in one checkout; removing this folder
// creates a transient broken `dist/cli.js` runtime.
await build({
  entryPoints: [entryPoint],
  outdir: outputDir,
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "node",
  target: ["node20"],
  packages: "external",
  sourcemap: true,
  entryNames: "[name]",
  chunkNames: "chunks/[name]-[hash]",
  logLevel: "warning",
});

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
