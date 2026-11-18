/**
 * Recorded, time-bounded exceptions for advisories that have no patched release
 * (pm-03q389). A waiver names one advisory, one package and its exact locked
 * versions, an owning tracker item, a reason and an expiry no more than
 * MAX_WAIVER_DAYS ahead of the run that judges it. Anything else is a refusal:
 * the advisory gate never infers an exception from severity, source or age.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

/** Repository-relative waiver registry; an absent file declares no waivers. */
export const WAIVERS_PATH = "config/dependency-advisory-waivers.json";
/** Repository-relative ledger of the published runtime dependency graph (pm-gh1417). */
export const RUNTIME_LEDGER_PATH = "runtime-dependencies.json";
/** Furthest a waiver may reach past the run that evaluates it, in whole days. */
export const MAX_WAIVER_DAYS = 30;
/** Largest number of declared waivers. */
export const MAX_WAIVERS = 20;
const DAY_MS = 86_400_000;
const ADVISORY_ID = /^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/u;
const PACKAGE_NAME = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/u;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const OWNER = /^pm-[a-z0-9]{1,64}$/u;
const REGISTRY_ID = /^\d{1,12}$/u;
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;
const WAIVER_KEYS = ["advisory", "expires_at", "owner", "package", "reason", "versions"];

/** Return whether a value is a plain JSON object. */
function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Return whether a string is a GitHub advisory id. */
export function isAdvisoryId(value) {
  return typeof value === "string" && ADVISORY_ID.test(value);
}

/** Return whether a string is an npm package name as the lockfile inventory spells it. */
export function isPackageName(value) {
  return typeof value === "string" && PACKAGE_NAME.test(value);
}

/** Return whether a string is an exact semantic version as the lockfile inventory spells it. */
export function isExactVersion(value) {
  return typeof value === "string" && VERSION.test(value);
}

/** Return whether an expiry is an RFC 3339 UTC instant that round-trips through Date. */
function isUtcInstant(value) {
  if (typeof value !== "string" || !UTC_INSTANT.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 19) === value.slice(0, 19);
}

/** Return whether one declared waiver has exactly the required, well-formed fields. */
function isWaiver(waiver) {
  return (
    isObject(waiver) &&
    Object.keys(waiver).sort().join(",") === WAIVER_KEYS.join(",") &&
    isAdvisoryId(waiver.advisory) &&
    isPackageName(waiver.package) &&
    Array.isArray(waiver.versions) &&
    waiver.versions.length > 0 &&
    waiver.versions.length <= 20 &&
    waiver.versions.every(isExactVersion) &&
    new Set(waiver.versions).size === waiver.versions.length &&
    typeof waiver.owner === "string" &&
    OWNER.test(waiver.owner) &&
    typeof waiver.reason === "string" &&
    waiver.reason.trim().length >= 20 &&
    waiver.reason.length <= 2000 &&
    isUtcInstant(waiver.expires_at)
  );
}

/** Return whether the registry envelope is version 1 with a bounded window and waiver list. */
function isRegistry(registry) {
  return (
    isObject(registry) &&
    Object.keys(registry).sort().join(",") === "version,waiver_notice_days,waivers" &&
    registry.version === 1 &&
    Number.isSafeInteger(registry.waiver_notice_days) &&
    registry.waiver_notice_days >= 0 &&
    registry.waiver_notice_days <= MAX_WAIVER_DAYS &&
    Array.isArray(registry.waivers) &&
    registry.waivers.length <= MAX_WAIVERS
  );
}

/** Read the declared waivers; an absent file declares none and any other failure refuses. */
export async function readWaiverRegistry(root) {
  let text;
  try {
    text = await readFile(path.join(root, WAIVERS_PATH), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { version: 1, waiver_notice_days: 0, waivers: [] };
    throw error;
  }
  return JSON.parse(text);
}

/** Read every name@version the published package installs, or undefined when there is no ledger. */
export async function readRuntimePackages(root) {
  let text;
  try {
    text = await readFile(path.join(root, RUNTIME_LEDGER_PATH), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
  const packages = new Set();
  for (const [key, entry] of Object.entries(JSON.parse(text).packages)) {
    const marker = key.lastIndexOf("node_modules/");
    if (marker !== -1 && typeof entry.version === "string") packages.add(`${key.slice(marker + "node_modules/".length)}@${entry.version}`);
  }
  return packages;
}

/**
 * A waiver never covers a package the published artifact installs: consumers
 * audit that graph themselves and cannot rely on this repository's exception
 * (pm-gh1748), so the fix is to remove the package from the runtime graph.
 */
export function runtimeFindings(live, runtime) {
  // Without the ledger nothing proves a waiver stays clear of the runtime graph.
  if (runtime === undefined) {
    return live.length === 0 ? [] : [{
      kind: "runtime_ledger_missing",
      detail: `${RUNTIME_LEDGER_PATH} is missing, so no waiver can be shown to stay clear of the published runtime graph; restore it with node scripts/release/runtime-lock.mjs apply.`,
    }];
  }
  return live.flatMap((waiver) => waiver.versions
    .filter((version) => runtime.has(`${waiver.package}@${version}`))
    .map((version) => ({
      kind: "waiver_covers_runtime_dependency",
      subject_id: waiverSubject(waiver),
      detail: `${waiverSubject(waiver)} waiver covers ${waiver.package}@${version}, which the published package installs (${RUNTIME_LEDGER_PATH}); remove it from the runtime graph instead of waiving it.`,
    })));
}

/** Read the declared waivers and judge them against the clock and the published runtime graph. */
export async function judgeWaivers(root, nowMs) {
  const result = evaluateWaivers(await readWaiverRegistry(root), nowMs);
  return { ...result, findings: [...result.findings, ...runtimeFindings(result.live, await readRuntimePackages(root))] };
}

/** Name a waiver by its advisory and package once its shape is known to be valid. */
export function waiverSubject(waiver) {
  return `${waiver.advisory} in ${waiver.package}`;
}

/**
 * Judge every declared waiver at `nowMs`. Malformed, duplicate, expired and
 * over-long waivers are findings, and any finding refuses the gate: a broken
 * record could otherwise hide an expiry or widen an exception.
 */
export function evaluateWaivers(registry, nowMs) {
  if (!isRegistry(registry)) {
    return {
      live: [],
      notice_days: 0,
      findings: [{
        kind: "invalid_registry",
        detail: `${WAIVERS_PATH} must hold exactly version 1, a waiver_notice_days window of 0 to ${MAX_WAIVER_DAYS} whole days and at most ${MAX_WAIVERS} waivers.`,
      }],
    };
  }
  const findings = [];
  const live = [];
  const seen = new Set();
  registry.waivers.forEach((waiver, index) => {
    if (!isWaiver(waiver)) {
      findings.push({
        kind: "invalid_waiver",
        detail: `Waiver ${index} in ${WAIVERS_PATH} needs exactly a GitHub advisory id, an npm package, 1 to 20 distinct exact versions, a pm item owner, a reason of at least 20 characters and an RFC 3339 UTC expiry.`,
      });
      return;
    }
    const subject = waiverSubject(waiver);
    if (seen.has(subject)) {
      findings.push({ kind: "duplicate_waiver", subject_id: subject, detail: `${subject} is waived more than once.` });
      return;
    }
    seen.add(subject);
    const remainingMs = Date.parse(waiver.expires_at) - nowMs;
    if (remainingMs <= 0) {
      findings.push({ kind: "expired_waiver", subject_id: subject, detail: `${subject} waiver (owner ${waiver.owner}) expired at ${waiver.expires_at}.` });
    } else if (remainingMs > MAX_WAIVER_DAYS * DAY_MS) {
      findings.push({ kind: "waiver_too_long", subject_id: subject, detail: `${subject} waiver (owner ${waiver.owner}) reaches past ${MAX_WAIVER_DAYS} days; renew it closer to expiry instead.` });
    } else {
      live.push(waiver);
    }
  });
  return { live, notice_days: registry.waiver_notice_days, findings };
}

/**
 * Split reported advisories into those an exact live waiver covers and those it
 * does not. A report matches only when its advisory id, package and locked
 * version are all declared on one waiver; a report missing any of them never
 * matches.
 */
export function applyWaivers(reports, live) {
  const open = [];
  const used = new Map();
  for (const report of reports) {
    const waiver = live.find((candidate) =>
      report.advisory === candidate.advisory &&
      report.package === candidate.package &&
      candidate.versions.includes(report.version));
    if (waiver === undefined) {
      open.push(report);
      continue;
    }
    const entry = used.get(waiver) ?? { advisory: waiver.advisory, package: waiver.package, versions: waiver.versions, owner: waiver.owner, expires_at: waiver.expires_at, sources: [] };
    if (!entry.sources.includes(report.source)) entry.sources.push(report.source);
    used.set(waiver, entry);
  }
  const waived = [...used.values()].map((entry) => ({ ...entry, sources: entry.sources.sort() }));
  const unused = live.filter((waiver) => !used.has(waiver)).map(waiverSubject);
  return { open, waived, unused };
}

/** Spell an uncovered report for a refusal message from validated fields only. */
export function describeReport(report) {
  const name = report.package ?? "unknown package";
  const version = report.version ?? "unknown version";
  // A registry key is printed only in the numeric form npm uses; anything else could carry control text.
  const id = typeof report.id === "string" && REGISTRY_ID.test(report.id) ? report.id : undefined;
  return `${name}@${version} ${report.advisory ?? id ?? "unknown advisory"}`;
}
