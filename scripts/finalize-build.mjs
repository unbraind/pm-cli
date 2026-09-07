#!/usr/bin/env node

import { chmod, glob, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

async function outputExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

/** Compact retained runtime modules without changing identifiers, module boundaries, or declarations. */
export async function compactRuntimeOutputs(directory) {
  const entryPoints = [];
  for await (const relative of glob("**/*.js", {
    cwd: directory,
    exclude: ["cli-bundle/**"],
  })) {
    entryPoints.push(relative);
  }
  if (entryPoints.length === 0) return;
  // esbuild resolves source files through symlinks; use the same physical root
  // for output paths so composed source maps remain relative and stable.
  const outputRoot = await realpath(directory);
  await build({
    entryPoints: entryPoints.map((relative) => path.join(outputRoot, relative)),
    outdir: outputRoot,
    outbase: outputRoot,
    allowOverwrite: true,
    bundle: false,
    platform: "node",
    format: "esm",
    target: "node22",
    minifyWhitespace: true,
    minifyIdentifiers: false,
    minifySyntax: false,
    sourcemap: true,
    sourcesContent: true,
    legalComments: "inline",
    logLevel: "silent",
  });
}

/** Finalize executable modes and the semantically identical compact public SDK manifest. */
export async function main(repoRoot = process.cwd()) {
  await compactRuntimeOutputs(path.join(repoRoot, "dist"));
  const executableOutputs = [
    path.join(repoRoot, "dist", "cli.js"),
    path.join(repoRoot, "dist", "mcp", "server.js"),
    path.join(repoRoot, "dist", "mcp", "http-server.js"),
  ];

  for (const outputPath of executableOutputs) {
    if (await outputExists(outputPath)) {
      await chmod(outputPath, 0o755);
    }
  }

  // Keep the checked-in compatibility manifest readable, while distributing
  // identical JSON data without indentation through its stable public export.
  const manifest = JSON.parse(
    await readFile(path.join(repoRoot, "sdk", "public-surface.json"), "utf8"),
  );
  await writeFile(
    path.join(repoRoot, "dist", "sdk", "public-surface.json"),
    `${JSON.stringify(manifest)}\n`,
    "utf8",
  );
}

/* c8 ignore start -- CLI auto-run guard; logic covered via exported main() */
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
/* c8 ignore stop */
