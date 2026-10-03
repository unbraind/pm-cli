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

const SHIM_TARGETS = new Map([
  ["node-gyp-build", "bin.js"],
  ["node-gyp-build-optional", "optional.js"],
  ["node-gyp-build-test", "build-test.js"],
]);
const SHIM_FORMATS = new Map([["", "sh"], [".cmd", "cmd"], [".ps1", "ps1"]]);

/** Compare each known shim's complete program with a reviewed template and audited dependency paths. */
async function verifyGeneratedShim(coreRoot, file) {
  const extension = path.extname(file);
  const command = path.basename(file, extension);
  const program = SHIM_TARGETS.get(command);
  const format = SHIM_FORMATS.get(extension);
  assert.ok(program && format && file === `node_modules/.bin/${command}${extension}`, "Unexpected CodSpeed artifact inventory");
  const pluginRequire = createRequire(import.meta.resolve("@codspeed/vitest-plugin"));
  const coreRequire = createRequire(pluginRequire.resolve("@codspeed/core"));
  const dependencyRoot = path.dirname(coreRequire.resolve("node-gyp-build/package.json"));
  const target = path.join(dependencyRoot, program);
  const relative = path.relative(path.join(coreRoot, "node_modules/.bin"), target);
  const nodePaths = [path.join(dependencyRoot, "node_modules"), path.dirname(dependencyRoot), path.join(path.dirname(path.dirname(path.dirname(dependencyRoot))), "node_modules")];
  const template = await readFile(new URL(`../config/codspeed-shims/${format}.txt`, import.meta.url), "utf8");
  const content = await readFile(path.join(coreRoot, file), "utf8");
  assert.ok(["/mnt", "/proc/cygdrive"].some((mount) => {
    const parameters = {
      "@TARGET_ABSOLUTE_POSIX@": target.replaceAll("\\", "/"),
      "@TARGET_RELATIVE_POSIX@": relative.replaceAll("\\", "/"),
      "@TARGET_RELATIVE_WINDOWS@": relative.replaceAll("/", "\\"),
      "@NODE_PATH_WINDOWS@": nodePaths.map((directory) => directory.replaceAll("/", "\\")).join(";"),
      "@NODE_PATH_POSIX@": nodePaths.map((directory) => directory.replaceAll("\\", "/").replace(/^[A-Za-z]:/u, `${mount}/${directory.slice(0, 1).toLowerCase()}`)).join(":"),
    };
    let expected = template;
    for (const [token, value] of Object.entries(parameters)) expected = expected.replaceAll(token, value);
    if (format === "cmd") expected = expected.replaceAll("\n", "\r\n");
    return content === expected;
  }), "CodSpeed executable shim integrity mismatch");
}

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
    assert.ok(entry.isFile(), "CodSpeed artifacts must be regular files");
    if (file.startsWith("node_modules/.bin/")) {
      await verifyGeneratedShim(coreRoot, file);
      continue;
    }
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
