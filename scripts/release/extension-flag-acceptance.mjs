/** Required exact-candidate extension grammar acceptance. Trackers: pm-gh1466, pm-gh1467. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runExtensionFlagConsumer } from "../../tests/fixtures/extensions/flag-semantics.mjs";

/** Run a bounded subprocess, refusing launch failures separately from product verdicts. */
export function execute(command, args, options) {
  const result = spawnSync(command, args, { ...options, encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.signal) throw result.error ?? new Error(`Acceptance process terminated: ${result.signal}`);
  return result;
}

/** Execute the same semantic oracle against an extracted or installed package without touching a user's tracker. */
export function verifyInstalledExtensionFlags(root, runtime = process.execPath) {
  const workspace = mkdtempSync(path.join(tmpdir(), "pm-extension-flags-"));
  try {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:PM_|GIT_)/u.test(key)));
    Object.assign(env, { HOME: path.join(workspace, "home"), USERPROFILE: path.join(workspace, "home"), PM_PATH: path.join(workspace, ".agents", "pm"),
      PM_GLOBAL_PATH: path.join(workspace, "global"), PM_TELEMETRY_DISABLED: "1", PM_TELEMETRY_OTEL_DISABLED: "1", PM_SENTRY_DISABLED: "1", PM_AGENT_PROBES: "0" });
    mkdirSync(env.HOME);
    const result = execute(runtime, [fileURLToPath(import.meta.url), "--consumer", path.resolve(root)], { cwd: workspace, env });
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert(receipt.ok === true && receipt.case_count > 0, "Missing required extension acceptance results");
    return receipt;
  } finally { rmSync(workspace, { recursive: true, force: true }); }
}

/** Bind the required semantic verdict to the exact tarball that the release will publish. */
export function verifyExtensionFlagTarball(tarball) {
  const workspace = mkdtempSync(path.join(tmpdir(), "pm-extension-candidate-"));
  try {
    const extraction = execute("tar", ["-xzf", path.resolve(tarball), "-C", workspace]);
    assert.equal(extraction.status, 0, extraction.stderr);
    const report = verifyInstalledExtensionFlags(path.join(workspace, "package"));
    return { ...report, artifact_sha256: createHash("sha256").update(readFileSync(tarball)).digest("hex"),
      runner_sha256: createHash("sha256").update(readFileSync(fileURLToPath(import.meta.url))).digest("hex"), evidence_scope: "packed-candidate" };
  } finally { rmSync(workspace, { recursive: true, force: true }); }
}

/** Dispatch installed-consumer and tarball modes; every missing or failed case refuses acceptance. */
export async function main(argv = process.argv.slice(2)) {
  const report = argv[0] === "--consumer" ? await runExtensionFlagConsumer(argv[1], execute) : verifyExtensionFlagTarball(argv[0]);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  return report;
}

/** Invoke only when this file is the requested executable. */
export async function runIfMain(candidate = process.argv[1]) {
  if (candidate && path.resolve(candidate) === fileURLToPath(import.meta.url)) await main();
}
await runIfMain();
