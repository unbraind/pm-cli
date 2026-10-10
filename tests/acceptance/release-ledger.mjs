/** Native npm/Git acceptance for pm-q91qyd, including Windows's original .cmd launch failure. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { collectReleaseLedgers } from "../../scripts/release/collect-release-ledgers.mjs";
import { registerTempCleanup } from "../../scripts/temp-lifecycle.mjs";

const root = mkdtempSync(path.join(tmpdir(), "pm-native-ledgers-"));
const releaseCleanup = registerTempCleanup(root);
const temporaryKey = process.platform === "win32" ? "TEMP" : "TMPDIR";
const originalTemporary = process.env[temporaryKey];
let npmRoot;
let originalFailure = null;
try {
  const workspace = path.join(root, "workspace with spaces & literal");
  const remote = path.join(root, "remote.git");
  const registryTemporary = path.join(root, "registry state & literal");
  mkdirSync(workspace);
  mkdirSync(registryTemporary);
  process.env[temporaryKey] = registryTemporary;
  process.env.PM_PATH = path.join(root, "project-tracker");
  process.env.PM_GLOBAL_PATH = path.join(root, "global-tracker");
  const gitConfig = path.join(root, "gitconfig");
  writeFileSync(gitConfig, "");
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/u.test(key)));
  Object.assign(env, { GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" });
  execFileSync("git", ["init", "--bare", remote], { env, stdio: "ignore" });
  execFileSync("git", ["init", "--initial-branch=main", workspace], { env, stdio: "ignore" });
  /** Build a genuine local origin without consulting inherited Git configuration. */
  const git = (...args) => execFileSync("git", args, { cwd: workspace, env, stdio: "ignore" });
  git("commit", "--allow-empty", "-m", "Fixture");
  git("tag", "v2026.10.9");
  git("remote", "add", "origin", remote);
  git("push", "origin", "--tags");
  writeFileSync(path.join(workspace, "package.json"), JSON.stringify({ name: "@unbrained/pm-cli" }));
  writeFileSync(path.join(workspace, "CHANGELOG.md"), "## 2026.10.9\n- Native launch fixture\n");
  /** Execute every provider for real; instrument only the original Windows failure and isolation invariants. */
  const execute = (command, args, options) => {
    if (command === "git") {
      return execFileSync(command, args, { ...options, env: { ...options.env, GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: "1" } });
    } else {
      npmRoot = String(options.cwd);
      assert.equal(options.env.NPM_TOKEN, undefined);
      assert.equal(options.env.NODE_AUTH_TOKEN, undefined);
      assert.equal(options.env.NPM_CONFIG_REGISTRY, "https://registry.npmjs.org");
      assert.equal(options.shell, undefined);
      assert.equal(options.timeout, 120_000);
      if (process.platform === "win32") {
        const request = ["view", "@unbrained/pm-cli", "name", "versions", "--json", "--registry=https://registry.npmjs.org"];
        assert.throws(() => execFileSync("npm.cmd", request, options), { code: "EINVAL" });
        originalFailure = "EINVAL";
        assert.equal(command, "cmd.exe");
        assert.deepEqual(args, ["/d", "/s", "/c", `npm.cmd ${request.join(" ")}`]);
      }
    }
    return execFileSync(command, args, options);
  };
  const report = collectReleaseLedgers(workspace, [], execute);
  assert.equal(report.census_complete, true);
  assert.equal(report.ok, false); // The fixture intentionally documents only one real published version.
  assert.equal(report.package, "@unbrained/pm-cli");
  assert.deepEqual(report.snapshots[0].identities, ["2026.10.9"]);
  assert.deepEqual(report.snapshots[1].identities, ["2026.10.9"]);
  assert.ok(report.snapshots[2].identities.includes("2026.10.9"));
  assert.ok(report.counts.delivered > 0);
  assert.ok(npmRoot.startsWith(registryTemporary));
  assert.equal(existsSync(npmRoot), false);
  console.log(JSON.stringify({ ok: true, platform: process.platform, original_cmd_failure: originalFailure, census_complete: true, reconciliation_ok: report.ok, counts: report.counts, native_git: true, isolated_registry_configuration: true, source_temporary_cleaned: true }));
} finally {
  if (originalTemporary === undefined) delete process.env[temporaryKey];
  else process.env[temporaryKey] = originalTemporary;
  rmSync(root, { recursive: true, force: true });
  releaseCleanup();
}
