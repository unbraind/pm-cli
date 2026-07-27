#!/usr/bin/env node
/**
 * Generate or verify agent-facing command-tier documentation from the SDK
 * contract compiled into dist.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { renderPmCommandVisibilityMarkdown } from "../dist/sdk/agent-capability-contracts.js";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
export async function main(
  root = repositoryRoot,
  args = process.argv.slice(2),
) {
  const outputPath = path.join(
    root,
    "docs",
    "generated",
    "AGENT_COMMAND_SURFACE.md",
  );
  const expected = renderPmCommandVisibilityMarkdown();
  if (args.includes("--check")) {
    const actual = await readFile(outputPath, "utf8").catch(() => "");
    if (actual !== expected) {
      throw new Error(
        "Generated agent command surface is stale. Run pnpm contracts:agent-surfaces:update.",
      );
    }
    return;
  }
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, expected, "utf8");
}

/* c8 ignore start -- CLI auto-run guard; logic is covered through main(). */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
/* c8 ignore stop */
