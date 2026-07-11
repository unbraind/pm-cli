#!/usr/bin/env node

/**
 * Enforce the repo-wide date-based version policy (`YYYY.M.D[-N]`, identical to
 * the root package version — pm-cli does NOT use semver) across every
 * distribution-facing manifest: workspace package.json files, agent plugin
 * manifests, and marketplace catalogs.
 *
 * Extension manifests under `packages/<pkg>/extensions/<name>/manifest.json`
 * are deliberately OUT of scope: their `version` is pm-loader-internal
 * metadata mirrored as literals in each extension's `index.ts` and pinned by
 * unit specs, not a published artifact version.
 *
 * Usage:
 *   node scripts/sync-versions.mjs check   # exit 1 when any manifest drifts from the root version
 *   node scripts/sync-versions.mjs apply   # stamp the root version into every manifest
 *
 * `check` runs in the CI static gate via `pnpm version:check`; `apply` runs in
 * the release pipeline immediately after the root `npm version` bump so every
 * release keeps all manifests in lockstep.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Mirrors scripts/release-version.mjs: YYYY.M.D with optional -N ordinal. */
const VERSION_PATTERN = /^([1-9]\d{3})\.([1-9]\d*)\.([1-9]\d*)(?:-([1-9]\d*))?$/;

const PLUGIN_MANIFESTS = [
  "plugins/pm-claude/.claude-plugin/plugin.json",
  "plugins/pm-codex/.codex-plugin/plugin.json",
];

const MARKETPLACE_CATALOGS = [
  ".claude-plugin/marketplace.json",
  "marketplace.json",
  ".agents/plugins/marketplace.json",
];

function fail(message) {
  console.error(message);
  process.exit(1);
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(repoRoot, relativePath), "utf8"));
}

/** Every workspace package manifest, discovered so new packages join the policy automatically. */
function packageManifestPaths() {
  return readdirSync(path.join(repoRoot, "packages"))
    .map((entry) => path.join("packages", entry, "package.json"))
    .filter((relativePath) => existsSync(path.join(repoRoot, relativePath)))
    .sort();
}

function manifestPaths() {
  return [...packageManifestPaths(), ...PLUGIN_MANIFESTS, ...MARKETPLACE_CATALOGS];
}

/**
 * Version-bearing slots inside one parsed manifest. Marketplace catalogs carry
 * versions in up to three shapes (top-level `version`, `metadata.version`, and
 * per-plugin entry `version`); only slots that already exist are synced, so
 * deleting a duplicate field later is never undone by this script.
 */
function versionSlots(manifest) {
  const slots = [];
  if (typeof manifest.version === "string") {
    slots.push({
      label: "version",
      read: () => manifest.version,
      write: (value) => {
        manifest.version = value;
      },
    });
  }
  if (typeof manifest.metadata?.version === "string") {
    slots.push({
      label: "metadata.version",
      read: () => manifest.metadata.version,
      write: (value) => {
        manifest.metadata.version = value;
      },
    });
  }
  const plugins = Array.isArray(manifest.plugins) ? manifest.plugins : [];
  plugins.forEach((plugin, index) => {
    if (typeof plugin?.version === "string") {
      slots.push({
        label: `plugins[${index}].version`,
        read: () => plugin.version,
        write: (value) => {
          plugin.version = value;
        },
      });
    }
  });
  return slots;
}

/**
 * Compare (and in `apply` mode rewrite) every manifest against the root
 * version. Returns one human-readable line per drifted slot.
 */
function syncManifests(rootVersion, mode) {
  const drift = [];
  for (const relativePath of manifestPaths()) {
    const manifest = readJson(relativePath);
    const stale = versionSlots(manifest).filter((slot) => slot.read() !== rootVersion);
    if (stale.length === 0) {
      continue;
    }
    for (const slot of stale) {
      drift.push(`${relativePath} ${slot.label}: ${slot.read()} -> ${rootVersion}`);
      slot.write(rootVersion);
    }
    if (mode === "apply") {
      writeFileSync(path.join(repoRoot, relativePath), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    }
  }
  return drift;
}

const command = process.argv[2] ?? "check";
if (command !== "check" && command !== "apply") {
  fail(`Unknown command "${command}". Use "check" or "apply".`);
}

const rootVersion = readJson("package.json").version;
if (!VERSION_PATTERN.test(rootVersion)) {
  fail(`Root package.json version "${rootVersion}" is not date-based (YYYY.M.D[-N]); refusing to propagate it.`);
}

const drift = syncManifests(rootVersion, command);
if (command === "check") {
  if (drift.length > 0) {
    fail(
      `Version drift from root ${rootVersion}:\n${drift.map((line) => `  - ${line}`).join("\n")}\n` +
        "Run `node scripts/sync-versions.mjs apply` (or `pnpm version:sync`).",
    );
  }
  console.log(`Version sync check passed (${rootVersion}).`);
} else if (drift.length === 0) {
  console.log(`All manifests already at ${rootVersion}.`);
} else {
  console.log(`Stamped ${rootVersion} into:\n${drift.map((line) => `  - ${line}`).join("\n")}`);
}
