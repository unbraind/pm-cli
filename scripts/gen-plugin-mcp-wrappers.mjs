#!/usr/bin/env node
/** Keep the Claude and Codex cached-plugin launchers byte-identical. */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sources = [
  ["templates/agent-plugins/pm-mcp-server.mjs", "scripts/pm-mcp-server.mjs"],
  ["templates/agent-plugins/plugin-runtime.mjs", "scripts/plugin-runtime.mjs"],
];
const plugins = ["pm-claude", "pm-codex"];

/** Copy each self-contained template into both plugin roots or report drift. */
export async function main() {
  const check = process.argv.includes("--check");
  let drift = false;
  for (const [source, destination] of sources) {
    const content = await readFile(path.join(repoRoot, source), "utf8");
    for (const plugin of plugins) {
      const target = path.join(repoRoot, "plugins", plugin, destination);
      if (!check) {
        await writeFile(target, content);
        console.log(`Wrote ${path.relative(repoRoot, target)}`);
        continue;
      }
      const current = await readFile(target, "utf8").catch(() => "");
      if (current === content) continue;
      drift = true;
      console.error(`Out of sync: ${path.relative(repoRoot, target)}`);
    }
  }
  if (drift) {
    console.error("Run: node scripts/gen-plugin-mcp-wrappers.mjs");
    process.exit(1);
  }
  if (check) console.log("Plugin MCP wrappers in sync.");
}

/* c8 ignore start -- CLI auto-run guard */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
/* c8 ignore stop */
