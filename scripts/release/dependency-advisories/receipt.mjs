/** Local-only SDK provider receipt validation (pm-eqxjzl). */
import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { OSV_ENDPOINT, SEVERITIES } from "./feeds.mjs";
import { readInputs } from "./inventory.mjs";
import { applyWaivers, describeReport, judgeWaivers } from "./waivers.mjs";

/**
 * A verifier refusal. Its message is built only from fixed text and validated
 * fields, so the gate may print it; Node's assertion messages would append
 * diffs of unvalidated receipt or registry content.
 */
export class AdvisoryRefusal extends Error {}

/** Refuse with a fixed, printable message unless `condition` holds. */
function refuse(condition, message) {
  if (!condition) throw new AdvisoryRefusal(message);
}

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
  refuse(isDeepStrictEqual(registry.counts !== null && typeof registry.counts === "object" ? Object.keys(registry.counts).sort() : null, [...SEVERITIES].sort()), "Incomplete registry audit counts");
  refuse(Array.isArray(registry.advisories) && registry.advisories.every(isStoredAdvisory), "Registry reports vulnerable dependencies");
  refuse(isDeepStrictEqual(registry.advisories.map(({ id }) => id), registry.ids), "Registry reports vulnerable dependencies");
  refuse(registry.advisories.every(({ severity }) => severity !== null), "Registry lists an advisory of unknown severity");
  for (const severity of SEVERITIES) {
    const listed = registry.advisories.filter((advisory) => advisory.severity === severity).length;
    refuse(registry.counts[severity] === listed, `Registry counts ${severity} advisories it does not list`);
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
  refuse(Object.is(receipt.version, RECEIPT_VERSION), "Unsupported advisory receipt");
  refuse(Object.is(receipt.status, "complete"), "Dependency evidence unavailable");
  refuse(isDeepStrictEqual(receipt.inputs, current.inputs), "Dependency inputs changed");
  refuse(Object.is(receipt.scope, "all-pnpm-lock-packages-including-dev-optional"), "Incomplete dependency scope");
  const started = Date.parse(receipt.started_at);
  const completed = Date.parse(receipt.completed_at);
  const now = Date.now();
  refuse(Number.isFinite(started) && Number.isFinite(completed) && started <= completed && completed <= now && now - started <= MAX_AGE_MS, "Stale or invalid advisory receipt");
  const { registry, osv } = receipt.feeds;
  for (const feed of [registry, osv]) {
    const observed = Date.parse(feed.observed_at);
    refuse(feed.status === "complete" && observed >= started && observed <= completed && feed.database_updated_at === null, "Unavailable or invalid advisory source");
  }
  refuse(Object.is(osv.endpoint, OSV_ENDPOINT), "Unexpected advisory source");
  refuse(isDeepStrictEqual(osv.rows.map(({ name, version }) => ({ name, version })), current.packages), "Incomplete independent advisory coverage");
  refuse(osv.rows.every((row) => Array.isArray(row.ids) && row.ids.every((id) => typeof id === "string")), "Independent source reports vulnerable dependencies");
  assertRegistryConsistent(registry);
  const waivers = await judgeWaivers(root, now);
  refuse(waivers.findings.length === 0, `Refused dependency advisory waiver: ${waivers.findings.map(({ detail }) => detail).join(" ")}`);
  const { open, waived, unused } = applyWaivers(reportedAdvisories(registry, osv), waivers.live);
  for (const [source, label] of [["osv", "Independent source"], ["registry", "Registry"]]) {
    const uncovered = open.filter((report) => report.source === source).map(describeReport);
    refuse(uncovered.length === 0, `${label} reports vulnerable dependencies: ${uncovered.join(", ")}`);
  }
  return { verdict: "pass", packages: current.packages.length, inputs: current.inputs, started_at: receipt.started_at, completed_at: receipt.completed_at, database_freshness: "unknown", waived, unused_waivers: unused };
}
