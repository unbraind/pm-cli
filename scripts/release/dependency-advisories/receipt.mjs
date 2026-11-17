/** Local-only SDK provider receipt validation (pm-eqxjzl). */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { OSV_ENDPOINT, SEVERITIES } from "./feeds.mjs";
import { readInputs } from "./inventory.mjs";
import { applyWaivers, describeReport, judgeWaivers } from "./waivers.mjs";

/** Version 2 records each registry advisory's package, GitHub id and locked versions (pm-03q389). */
export const RECEIPT_VERSION = 2;
export const MAX_AGE_MS = 15 * 60 * 1000;

/** Return whether a stored registry advisory has the shape the collector writes. */
function isStoredAdvisory(entry) {
  return entry !== null && typeof entry === "object" && !Array.isArray(entry) &&
    Object.keys(entry).sort().join(",") === "advisory,id,package,severity,versions" &&
    typeof entry.id === "string" &&
    (entry.severity === null || SEVERITIES.includes(entry.severity)) &&
    (entry.versions === null || (Array.isArray(entry.versions) && entry.versions.every((version) => typeof version === "string")));
}

/**
 * Check that the registry's advisory list accounts for every counted advisory.
 * pnpm counts one per advisory, not per vulnerable version or path (measured
 * 2026-11-18: one high advisory with three vulnerable versions plus another
 * high advisory counted high: 2), so each severity's count must equal the
 * number of listed advisories with that severity. A waived advisory can
 * therefore never stand in for an unlisted one. An advisory of unknown
 * severity cannot be accounted for at all and refuses.
 */
function assertRegistryConsistent(registry) {
  assert.deepEqual(registry.counts !== null && typeof registry.counts === "object" ? Object.keys(registry.counts).sort() : null, [...SEVERITIES].sort(), "Incomplete registry audit counts");
  assert.ok(Array.isArray(registry.advisories) && registry.advisories.every(isStoredAdvisory), "Registry reports vulnerable dependencies");
  assert.deepEqual(registry.advisories.map(({ id }) => id), registry.ids, "Registry reports vulnerable dependencies");
  assert.ok(registry.advisories.every(({ severity }) => severity !== null), "Registry lists an advisory of unknown severity");
  for (const severity of SEVERITIES) {
    const listed = registry.advisories.filter((advisory) => advisory.severity === severity).length;
    assert.ok(registry.counts[severity] === listed, `Registry counts ${severity} advisories it does not list`);
  }
}

/** Flatten both feeds into one report per advisory, package and locked version. */
function reportedAdvisories(registry, osv) {
  return [
    ...osv.rows.flatMap(({ name, version, ids }) => ids.map((advisory) => ({ source: "osv", package: name, version, advisory }))),
    ...registry.advisories.flatMap(({ id, package: name, advisory, versions }) =>
      (versions === null || versions.length === 0 ? [null] : versions).map((version) => ({ source: "registry", id, package: name, version, advisory }))),
  ];
}

/** A fresh query is evidence of retrieval, never proof of database freshness. */
export async function verifyReceipt(root, receiptPath) {
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  const current = await readInputs(root);
  assert.equal(receipt.version, RECEIPT_VERSION, "Unsupported advisory receipt");
  assert.equal(receipt.status, "complete", "Dependency evidence unavailable");
  assert.deepEqual(receipt.inputs, current.inputs, "Dependency inputs changed");
  assert.equal(receipt.scope, "all-pnpm-lock-packages-including-dev-optional", "Incomplete dependency scope");
  const started = Date.parse(receipt.started_at);
  const completed = Date.parse(receipt.completed_at);
  const now = Date.now();
  assert.ok(Number.isFinite(started) && Number.isFinite(completed) && started <= completed && completed <= now && now - started <= MAX_AGE_MS, "Stale or invalid advisory receipt");
  const { registry, osv } = receipt.feeds;
  for (const feed of [registry, osv]) {
    const observed = Date.parse(feed.observed_at);
    assert.ok(feed.status === "complete" && observed >= started && observed <= completed && feed.database_updated_at === null, "Unavailable or invalid advisory source");
  }
  assert.equal(osv.endpoint, OSV_ENDPOINT, "Unexpected advisory source");
  assert.deepEqual(osv.rows.map(({ name, version }) => ({ name, version })), current.packages, "Incomplete independent advisory coverage");
  assert.ok(osv.rows.every((row) => Array.isArray(row.ids) && row.ids.every((id) => typeof id === "string")), "Independent source reports vulnerable dependencies");
  assertRegistryConsistent(registry);
  const waivers = await judgeWaivers(root, now);
  assert.ok(waivers.findings.length === 0, `Refused dependency advisory waiver: ${waivers.findings.map(({ detail }) => detail).join(" ")}`);
  const { open, waived, unused } = applyWaivers(reportedAdvisories(registry, osv), waivers.live);
  for (const [source, label] of [["osv", "Independent source"], ["registry", "Registry"]]) {
    const uncovered = open.filter((report) => report.source === source).map(describeReport);
    assert.ok(uncovered.length === 0, `${label} reports vulnerable dependencies: ${uncovered.join(", ")}`);
  }
  return { verdict: "pass", packages: current.packages.length, inputs: current.inputs, started_at: receipt.started_at, completed_at: receipt.completed_at, database_freshness: "unknown", waived, unused_waivers: unused };
}
