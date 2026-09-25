import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

/** Fixed distribution paths shared by stamping, staging, and immutable-tree provenance. */
export const FIXED_DISTRIBUTION_MANIFESTS = [
  "plugins/pm-claude/.claude-plugin/plugin.json",
  "plugins/pm-codex/.codex-plugin/plugin.json",
  "plugins/pm-claude/package.json",
  "plugins/pm-codex/package.json",
  ".claude-plugin/marketplace.json",
  "marketplace.json",
  ".agents/plugins/marketplace.json",
];

/** Enumerate the same distribution manifests for version synchronization and release staging. */
export function distributionManifestPaths(repoRoot) {
  const packages = readdirSync(path.join(repoRoot, "packages"))
    .map((entry) => path.join("packages", entry, "package.json"))
    .filter((relativePath) => existsSync(path.join(repoRoot, relativePath)))
    .sort();
  return [
    ...packages,
    ...FIXED_DISTRIBUTION_MANIFESTS,
  ];
}
