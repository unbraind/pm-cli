#!/usr/bin/env node
/** Project one canonical Agent Skills tree into standalone Claude and Codex plugins. */
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(repoRoot, "templates", "agent-skills");
const codexAliasRoot = path.join(sourceRoot, "codex-aliases");
const pluginNames = ["pm-claude", "pm-codex"];
const skillFiles = ["SKILL.md", "agents/openai.yaml"];

/** Check or update one standalone plugin without crossing its package boundary. */
async function syncPluginSkills(pluginName, commonNames, aliasNames, check) {
  const drift = [];
  const pluginRoot = path.join(repoRoot, "plugins", pluginName, "skills");
  const skillNames = pluginName === "pm-codex" ? [...commonNames, ...aliasNames] : commonNames;
  const published = await readdir(pluginRoot);
  const unexpected = published.filter((name) => !skillNames.includes(name));
  if (unexpected.length > 0) {
    throw new Error(
      `${pluginName} has unowned skill directories: ${unexpected.join(", ")}`,
    );
  }
  for (const skillName of skillNames) {
    for (const file of skillFiles) {
      const origin = aliasNames.includes(skillName) ? codexAliasRoot : sourceRoot;
      const source = path.join(origin, skillName, file);
      const target = path.join(pluginRoot, skillName, file);
      const expected = await readFile(source, "utf8");
      const current = await readFile(target, "utf8").catch(() => null);
      if (current === expected) continue;
      if (check) {
        drift.push(path.relative(repoRoot, target));
      } else {
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, expected);
      }
    }
  }
  return drift;
}

/** Compare every published skill with its canonical source, or regenerate copies. */
export async function main() {
  const check = process.argv.includes("--check");
  const commonNames = (await readdir(sourceRoot)).filter((name) => name !== "codex-aliases").sort();
  const aliasNames = (await readdir(codexAliasRoot)).sort();
  if (commonNames.length === 0) throw new Error("Canonical Agent Skills tree is empty");
  const drift = [];
  for (const pluginName of pluginNames) {
    drift.push(...await syncPluginSkills(pluginName, commonNames, aliasNames, check));
  }
  if (drift.length > 0) {
    throw new Error(
      "Agent plugin skills drifted from templates/agent-skills:\n" +
      drift.join("\n") + "\nRun node scripts/gen-agent-plugin-skills.mjs",
    );
  }
  console.log(check ? "Agent plugin skills in sync." : "Agent plugin skills generated.");
}

/* c8 ignore start -- CLI auto-run guard */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
/* c8 ignore stop */
