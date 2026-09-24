#!/usr/bin/env node

/** Enforce explicit dependency aging for every updater entry (pm-gkut, pm-dmo5). */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";

/** Accept only whole-day cooldowns meeting the reviewed seven-day aging policy. */
function validCooldownDays(value) {
  return Number.isInteger(value) && value >= 7;
}

/** Reject absent, bypassed, or shorter-than-policy updater cooldowns. */
export function auditDependencyCooldown(source) {
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length > 0) return ["dependabot.yml: invalid YAML"];
  const updates = document.toJS()?.updates;
  if (!Array.isArray(updates) || updates.length === 0) return ["dependabot.yml: updates must be a nonempty array"];
  const findings = [];
  for (const [index, update] of updates.entries()) {
    const cooldown = update?.cooldown;
    const label = `dependabot.yml: updates[${index}]`;
    if (!validCooldownDays(cooldown?.["default-days"])) {
      findings.push(`${label}: default-days must be an integer of at least 7`);
    }
    for (const field of ["semver-major-days", "semver-minor-days", "semver-patch-days"]) {
      if (cooldown?.[field] !== undefined && !validCooldownDays(cooldown[field])) {
        findings.push(`${label}: ${field} must not bypass the seven-day minimum`);
      }
    }
    if (["include", "exclude"].some((field) => cooldown?.[field] !== undefined)) {
      findings.push(`${label}: cooldown must cover all dependencies without include/exclude bypasses`);
    }
  }
  return findings;
}

/** Execute the gate only at its CLI boundary; missing configuration fails closed. */
export async function runIfMain(candidate, configPath) {
  if (!candidate || path.resolve(candidate) !== fileURLToPath(import.meta.url)) return;
  const findings = auditDependencyCooldown(await readFile(configPath, "utf8"));
  for (const finding of findings) process.stderr.write(`${finding}\n`);
  process.exitCode = findings.length > 0 ? 1 : 0;
  if (findings.length === 0) process.stdout.write("Dependency cooldown: explicit seven-day minimum verified\n");
}

await runIfMain(process.argv[1], path.join(process.cwd(), ".github", "dependabot.yml"));
