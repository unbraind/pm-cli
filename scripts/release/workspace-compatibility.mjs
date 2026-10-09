#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { registerTempCleanup } from "../temp-lifecycle.mjs";
import { commandFor, repoRoot } from "./utils.mjs";

/** Select the two immediately preceding stable calendar releases, refusing a diluted window. */
export function selectWorkspaceCompatibilityVersions(versions, current, policy) {
  assert.equal(policy.schema_version, 1, "Unknown compatibility policy");
  assert.equal(policy.previous_stable_releases, 2, "Compatibility requires two prior stable releases");
  assert.equal(policy.item_format_version, 1, "Update compatibility fixtures before changing the storage baseline");
  const numeric = (version) => {
    assert.match(version, /^\d{4}\.\d{1,2}\.\d{1,2}$/u, "Expected a stable calendar version");
    return version.split(".").map(Number);
  };
  const compare = (left, right) => {
    const a = numeric(left);
    const b = numeric(right);
    return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  };
  numeric(current);
  const previous = [...new Set(versions)].filter((version) => /^\d{4}\.\d{1,2}\.\d{1,2}$/u.test(version) && compare(version, current) < 0).sort(compare).slice(-2);
  assert.equal(previous.length, 2, "Two published prior releases are required");
  return previous;
}

/** Require exact unknown-field values rather than trusting successful exit status. */
export function assertWorkspaceCompatibilityItem(item, expected) {
  for (const [key, value] of Object.entries(expected)) assert.deepEqual(item[key], value, `Compatibility lost ${key}`);
}

/** Run real published writers/readers and Git drivers in both directions without the repository tracker. */
export async function main() {
  const manifest = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
  const policy = JSON.parse(await readFile(path.join(repoRoot, "scripts/release/workspace-compatibility-policy.json"), "utf8"));
  const root = await mkdtemp(path.join(tmpdir(), "pm-workspace-compat-"));
  const releaseCleanup = registerTempCleanup(root);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_") && !["PM_PATH", "PM_GLOBAL_PATH"].includes(key)));
  Object.assign(env, { PM_TELEMETRY_DISABLED: "1", PM_TELEMETRY_OTEL_DISABLED: "1", PM_TELEMETRY_PROMPT: "0", PM_DISABLE_OLLAMA_AUTO_DEFAULTS: "1", PM_AUTHOR: "compatibility-fixture", FORCE_COLOR: "0" });
  const run = (command, args, cwd = root, extraEnv = {}) => execFileSync(command, args, { cwd, env: { ...env, ...extraEnv }, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    const versions = selectWorkspaceCompatibilityVersions(JSON.parse(run(commandFor("npm"), ["view", "@unbrained/pm-cli", "versions", "--json"])), manifest.version, policy);
    const current = { version: manifest.version, cli: path.join(repoRoot, "dist/cli.js"), sdk: path.join(repoRoot, "dist/cli-bundle/sdk-runtime.js") };
    const releases = [];
    for (const version of versions) {
      const prefix = path.join(root, `runtime-${version}`);
      await mkdir(prefix);
      run(commandFor("npm"), ["install", "--prefix", prefix, "--ignore-scripts", "--no-audit", "--no-fund", `@unbrained/pm-cli@${version}`]);
      const installed = path.join(prefix, "node_modules/@unbrained/pm-cli");
      releases.push({ version, cli: path.join(installed, "dist/cli.js"), sdk: path.join(installed, "dist/cli-bundle/sdk-runtime.js") });
    }
    const expected = { compat_text: 'Unicode λ,equals=quote"\nline', compat_count: 0, compat_enabled: false, compat_object: { nested: [null, false, "x,y=z"] }, compat_array: [0, false, null, { x: "y,z" }] };
    const types = ["string", "number", "boolean", "object", "array"];
    const matrix = [];
    for (const release of releases) {
      for (const [writer, reader] of [[release, current], [current, release]]) {
        const cwd = path.join(root, `${writer.version}-to-${reader.version}`);
        await mkdir(cwd);
        const pmRoot = path.join(cwd, ".agents/pm");
        const trackerEnv = { PM_PATH: pmRoot, PM_GLOBAL_PATH: path.join(cwd, ".global") };
        const cli = (runtime, args, extensions = false) => JSON.parse(run(process.execPath, [runtime.cli, ...args, "--json", ...(extensions ? [] : ["--no-extensions"])], cwd, trackerEnv));
        const git = (...args) => run("git", args, cwd, trackerEnv);
        cli(writer, ["init", "--defaults"]);
        const extensionRoot = path.join(pmRoot, "extensions", "compat-fields");
        await mkdir(extensionRoot, { recursive: true });
        await writeFile(path.join(extensionRoot, "manifest.json"), JSON.stringify({ name: "compat-fields", version: "1.0.0", entry: "index.cjs", capabilities: ["schema"] }));
        await writeFile(path.join(extensionRoot, "index.cjs"), `exports.activate = (api) => api.registerItemFields(${JSON.stringify(Object.keys(expected).map((name, index) => ({ name, type: types[index] })))});\n`);
        const flags = Object.entries(expected).flatMap(([key, value]) => ["--field", `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`]);
        const created = cli(writer, ["create", "--title", "Version skew", "--type", "Task", "--body", "Original body", ...(writer === current ? ["--full-changed-fields"] : []), ...flags], true);
        const id = created.id ?? created.item.id;
        // Reads and subsequent writes disable the package: metadata is truly unknown to the reader.
        assertWorkspaceCompatibilityItem(cli(reader, ["get", id, "--full", "--output-budget", "unbounded"]).item, expected);
        const sdkProbe = `import assert from 'node:assert/strict'; import { get, CURRENT_ITEM_FORMAT_VERSION } from ${JSON.stringify(pathToFileURL(reader.sdk).href)}; assert.equal(CURRENT_ITEM_FORMAT_VERSION, ${JSON.stringify(policy.item_format_version)}, 'Runtime storage format drifted from compatibility policy'); const result = await get(${JSON.stringify(id)}, { full: true, outputBudget: 'unbounded' }, { pmRoot: ${JSON.stringify(pmRoot)}, noExtensions: true }); for (const [key,value] of Object.entries(${JSON.stringify(expected)})) assert.deepEqual(result.item[key], value, key);`;
        run(process.execPath, ["--input-type=module", "--eval", sdkProbe], cwd, trackerEnv);
        cli(reader, ["update", id, "--title", "Older and newer writers preserve unknown fields"]);
        assertWorkspaceCompatibilityItem(cli(writer, ["get", id, "--full"]).item, expected);
        cli(reader, ["restore", id, "1"]);
        assertWorkspaceCompatibilityItem(cli(writer, ["get", id, "--full"]).item, { ...expected, title: "Version skew", body: "Original body" });
        assert.equal(cli(reader, ["history", id, "--verify"]).verification.ok, true);
        git("init", "--initial-branch=main");
        git("config", "user.email", "compatibility@example.invalid");
        git("config", "user.name", "Compatibility Fixture");
        cli(reader, ["merge", "install"]);
        git("add", ".agents", ".gitattributes");
        git("commit", "-m", "Seed version skew workspace");
        git("checkout", "-b", "peer");
        cli(writer, ["update", id, "--description", "Peer description"]);
        git("add", ".agents");
        git("commit", "-m", "Write peer description");
        git("checkout", "main");
        cli(reader, ["update", id, "--priority", "1"]);
        git("add", ".agents");
        git("commit", "-m", "Write main priority");
        git("merge", "peer", "--no-edit");
        const reconciled = cli(current, ["merge", "reconcile"]);
        assert.equal(reconciled.ok, true, "Merged history must reconcile without force");
        assertWorkspaceCompatibilityItem(cli(reader, ["get", id, "--full"]).item, { ...expected, description: "Peer description", priority: 1 });
        assert.equal(cli(current, ["history", id, "--verify"]).verification.ok, true);
        const validated = cli(current, ["validate", "--check-history-drift", "--check-storage-integrity"]);
        assert.equal(validated.ok, true, "Merged workspace integrity failed");
        matrix.push({ writer: writer.version, reader: reader.version, cli: true, sdk: true, unknown_fields: true, restore: true, git_merge: true, history: true });
      }
    }
    console.log(JSON.stringify({ ok: true, policy, matrix }, null, 2));
  } finally {
    await rm(root, { recursive: true, force: true });
    releaseCleanup();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
