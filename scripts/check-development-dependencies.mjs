#!/usr/bin/env node

/** Verify the installed CodSpeed patch, maps, and preserved native payload (pm-r61juc). */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REQUIRED_FILES = [
  "LICENSE", "README.md", "package.json",
  "dist/index.cjs.js", "dist/index.cjs.js.map",
  "dist/index.d.ts", "dist/index.d.ts.map",
  "dist/index.es5.js", "dist/index.es5.js.map",
  "prebuilds/darwin-arm64/node.napi.node",
  "prebuilds/linux-arm64/node.napi.node", "prebuilds/linux-x64/node.napi.node",
];

/** Reject unreviewed package files, missing entries, manifest drift, and changed payload bytes. */
export async function verifyDevelopmentBundles(coreRoot, policy) {
  assert.deepEqual(Object.keys(policy.sha256).sort(), [...REQUIRED_FILES].sort(), "Incomplete bundle integrity policy");
  const manifest = JSON.parse(await readFile(path.join(coreRoot, "package.json"), "utf8"));
  assert.equal(manifest.name, policy.name, "Unexpected CodSpeed package identity");
  assert.equal(manifest.version, policy.version, "CodSpeed upgrade requires a reviewed patch and integrity refresh");
  const installedFiles = [];
  for (const entry of await readdir(coreRoot, { recursive: true, withFileTypes: true })) {
    if (entry.isDirectory()) continue;
    const file = path.relative(coreRoot, path.join(entry.parentPath, entry.name)).split(path.sep).join("/");
    if (file.startsWith("node_modules/.bin/")) continue;
    assert.ok(entry.isFile(), "CodSpeed artifacts must be regular files");
    installedFiles.push(file);
  }
  assert.deepEqual(installedFiles.sort(), [...REQUIRED_FILES].sort(), "Unexpected CodSpeed artifact inventory");
  for (const file of REQUIRED_FILES) {
    const actual = createHash("sha256").update(await readFile(path.join(coreRoot, file))).digest("hex");
    assert.equal(actual, policy.sha256[file], `CodSpeed bundle integrity mismatch: ${file}`);
  }
}

/** Resolve through the real ESM plugin and enforce the committed policy at the CLI boundary. */
export async function runIfMain(candidate) {
  if (!candidate || path.resolve(candidate) !== fileURLToPath(import.meta.url)) return;
  const require = createRequire(import.meta.resolve("@codspeed/vitest-plugin"));
  const coreRoot = path.dirname(path.dirname(require.resolve("@codspeed/core")));
  const policy = JSON.parse(await readFile(new URL("../config/dependency-bundle-integrity.json", import.meta.url), "utf8"));
  await verifyDevelopmentBundles(coreRoot, policy);
  process.stdout.write("Development dependency bundles: patch, source maps and native payload verified\n");
}

await runIfMain(process.argv[1]);
