/** Reconcile every declared, tagged and anonymously published release through the public SDK. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { reconcileArtifactLedgers } from "@unbrained/pm-cli/sdk/governance";
import { commandFor } from "./utils.mjs";

/** Extract release identities while rejecting duplicate section/tag declarations. */
export function releaseLedgerSnapshots(changelog, remoteTags, metadata, packageName) {
  if (Array.isArray(metadata)) {
    if (metadata.length !== 1) throw new Error("Expected one public registry package result.");
    [metadata] = metadata;
  }
  if (metadata?.name !== packageName || !Array.isArray(metadata.versions) || metadata.versions.length === 0 || metadata.versions.some((version) => typeof version !== "string")) throw new Error("Incomplete public registry release inventory.");
  const documented = [...changelog.matchAll(/^## (?:\[)?(\d{4}\.\d{1,2}\.\d{1,2}(?:-\d+)?)(?:\])?(?:\s|$)/gmu)].map((match) => match[1]);
  const tagged = remoteTags.split(/\r?\n/u).filter(Boolean).map((line) => {
    const match = /^[a-f\d]{40}\s+refs\/tags\/(.+)$/u.exec(line);
    if (!match) throw new Error("Malformed remote tag inventory.");
    return match[1];
  }).filter((tag) => /^v\d{4}\.\d{1,2}\.\d{1,2}(?:-\d+)?$/u.test(tag)).map((tag) => tag.slice(1));
  return [
    { name: "documented", complete: true, identities: documented },
    { name: "tagged", complete: true, identities: tagged },
    { name: "delivered", complete: true, identities: metadata.versions },
  ];
}

/** Collect a full anonymous registry inventory with isolated configuration and cache. */
export function collectReleaseLedgers(cwd, exceptions, execute = execFileSync) {
  const manifest = JSON.parse(readFileSync(path.join(cwd, "package.json"), "utf8"));
  if (typeof manifest.name !== "string" || !/^(?:@[a-z\d][a-z\d_.-]*\/)?[a-z\d][a-z\d_.-]*$/u.test(manifest.name)) throw new Error("Invalid release package identity.");
  const temporary = mkdtempSync(path.join(tmpdir(), "pm-release-ledgers-"));
  try {
    const userConfig = path.join(temporary, "user.npmrc");
    const globalConfig = path.join(temporary, "global.npmrc");
    writeFileSync(userConfig, "");
    writeFileSync(globalConfig, "");
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:npm_|NODE_AUTH_TOKEN$|NPM_TOKEN$|GIT_)/iu.test(key)));
    Object.assign(env, { NPM_CONFIG_USERCONFIG: userConfig, NPM_CONFIG_GLOBALCONFIG: globalConfig, NPM_CONFIG_CACHE: path.join(temporary, "cache"), NPM_CONFIG_REGISTRY: "https://registry.npmjs.org" });
    const metadata = JSON.parse(execute(commandFor("npm"), ["view", manifest.name, "name", "versions", "--json", "--registry=https://registry.npmjs.org"], { cwd: temporary, env, encoding: "utf8", timeout: 120_000, maxBuffer: 32 * 1024 * 1024 }));
    const tags = execute("git", ["ls-remote", "--tags", "--refs", "origin"], { cwd, env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/u.test(key))), encoding: "utf8", timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
    const snapshots = releaseLedgerSnapshots(readFileSync(path.join(cwd, "CHANGELOG.md"), "utf8"), tags, metadata, manifest.name);
    const report = reconcileArtifactLedgers(snapshots, exceptions);
    const classes = {
      declared_but_never_delivered: report.findings.filter((finding) => finding.missing_from.includes("delivered")).map((finding) => finding.identity),
      delivered_but_undocumented: report.findings.filter((finding) => finding.present_in.includes("delivered") && finding.missing_from.includes("documented")).map((finding) => finding.identity),
      tagged_but_unsectioned: report.findings.filter((finding) => finding.present_in.includes("tagged") && finding.missing_from.includes("documented")).map((finding) => finding.identity),
    };
    return { ...report, package: manifest.name, census_complete: true, snapshots, classes };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

/** Save replayable input and every historical disposition before enforcing the report. */
export function main(env = process.env, cwd = process.cwd(), execute = execFileSync) {
  const policy = JSON.parse(readFileSync(path.join(cwd, "config/release-ledger-exceptions.json"), "utf8"));
  if (policy.schema !== "release-ledger-exceptions/1" || !Array.isArray(policy.exceptions)) throw new Error("Invalid release ledger exception policy.");
  const report = { ...collectReleaseLedgers(cwd, policy.exceptions, execute), exceptions: policy.exceptions };
  writeFileSync(env.RELEASE_LEDGERS_OUTPUT, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}
