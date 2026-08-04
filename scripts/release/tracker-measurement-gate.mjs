#!/usr/bin/env node
// Tracker measurement ratchet (pm-ips23h).
//
// Three shipped ratchets freeze a measured number about the SOURCE tree and fail
// a build that exceeds it: the SDK import boundary, the complexity/suppressions
// baseline, and the command-output token corpus. None of them reads the data
// under .agents/pm, so a population count recorded in a pm item body is inert
// prose. Nothing reads it, therefore nothing can fail on it, therefore the
// maintenance passes that record the number are free to widen it — and they do,
// fastest right after the measurement is published, because that is when
// attention is on the affected items.
//
// This gate closes that loop. Each declaration names the item that owns the
// defect, a selector that recomputes the population from tracked data, and the
// count that was filed. An observed count above its declared ceiling fails the
// build and names the owner, the selector, both counts, and the overshoot.
//
// Ceilings retire themselves: when the owning item reaches a terminal status its
// declaration stops being enforced, so no ceiling outlives the defect it guards
// and honest work never needs a waiver to close.
//
//   node scripts/release/tracker-measurement-gate.mjs                   # check (default)
//   node scripts/release/tracker-measurement-gate.mjs --json            # machine-readable report
//   node scripts/release/tracker-measurement-gate.mjs --update          # re-declare from observation
//   node scripts/release/tracker-measurement-gate.mjs --negative-control # prove the gate can fail

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fail, flagBool, flagString, parseFlags, repoRoot } from "./utils.mjs";

// The item listing carries every stored dependency row, so the payload grows
// with the corpus and overruns the 1 MB spawn default well before it overruns
// memory. Cursor paging is the real answer at a million items; until the gate
// needs it, an explicit ceiling keeps the failure honest instead of silent.
const CLI_MAX_BUFFER_BYTES = 512 * 1024 * 1024;

const DOCUMENT_VERSION = 1;
const DEFAULT_DECLARATIONS_PATH = path.join(
  repoRoot,
  "scripts",
  "release",
  "tracker-measurements.json",
);

/** Selector sources a declaration may recompute its population from. */
export const SELECTOR_SOURCES = Object.freeze([
  "dependency_kind",
  "validate_warning",
  "graph_profile",
  "health_check",
]);

/** Sources whose complete observed key set must be declared in the baseline. */
export const EXHAUSTIVE_SELECTOR_SOURCES = Object.freeze(["validate_warning", "health_check"]);

/** Stable severity ordering used to ratchet `pm health` check statuses. */
export const HEALTH_STATUS_SEVERITY = Object.freeze({ ok: 0, warn: 1, error: 2 });

/** Owner statuses that retire a ceiling because the defect it guards is finished. */
export const TERMINAL_OWNER_STATUSES = Object.freeze(["closed", "canceled"]);

/**
 * Count stored dependency rows per kind across a tracker item collection.
 *
 * Deliberately counts the rows as authored rather than as the graph registry
 * resolves them: aliases such as `related_to` canonicalize on read, so a
 * graph-derived census can never see the population an alias-retirement item
 * exists to shrink.
 */
export function measureDependencyKinds(items) {
  const counts = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    for (const dependency of Array.isArray(item?.dependencies) ? item.dependencies : []) {
      const kind = dependency?.kind;
      if (typeof kind === "string" && kind.length > 0) {
        counts.set(kind, (counts.get(kind) ?? 0) + 1);
      }
    }
  }
  return counts;
}

/**
 * Reduce `pm validate --json` warnings to a code-to-count map.
 *
 * Warnings arrive as `"code:count"` strings, so the count is parsed off the last
 * colon-separated field and a malformed entry contributes nothing rather than
 * silently reading as zero.
 */
export function measureValidateWarnings(report) {
  const counts = new Map();
  for (const warning of Array.isArray(report?.warnings) ? report.warnings : []) {
    if (typeof warning !== "string") {
      continue;
    }
    const separator = warning.lastIndexOf(":");
    const code = separator === -1 ? warning : warning.slice(0, separator);
    const parsed = separator === -1 ? Number.NaN : Number.parseInt(warning.slice(separator + 1), 10);
    if (code.length > 0 && Number.isFinite(parsed)) {
      counts.set(code, parsed);
    }
  }
  return counts;
}

/** Extract the numeric population fields of a `pm graph audit --json` profile. */
export function measureGraphProfile(report) {
  const counts = new Map();
  const profile = report?.profile;
  for (const [field, value] of Object.entries(typeof profile === "object" && profile !== null ? profile : {})) {
    if (typeof value === "number" && Number.isFinite(value)) {
      counts.set(field, value);
    }
  }
  return counts;
}

/** Reduce `pm health --check-only --json` checks to stable numeric severities. */
export function measureHealthChecks(report) {
  const counts = new Map();
  for (const check of Array.isArray(report?.checks) ? report.checks : []) {
    const name = check?.name;
    const status = check?.status;
    if (typeof name === "string" && name.length > 0) {
      counts.set(name, HEALTH_STATUS_SEVERITY[status] ?? 3);
    }
  }
  return counts;
}

/** Attribute dependency-kind growth to the authored rows that appeared after measurement. */
export function measureDependencyContributors(items, declarations) {
  const measuredOnByKind = new Map(
    declarations
      .filter((entry) => entry?.selector?.source === "dependency_kind")
      .map((entry) => [entry.selector.kind, entry.measured_on]),
  );
  const contributors = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    for (const dependency of Array.isArray(item?.dependencies) ? item.dependencies : []) {
      if (typeof dependency !== "object" || dependency === null) {
        continue;
      }
      const measuredOn = measuredOnByKind.get(dependency.kind);
      const createdAt = dependency.created_at;
      if (
        typeof measuredOn !== "string" ||
        typeof createdAt !== "string" ||
        createdAt.slice(0, 10) <= measuredOn
      ) {
        continue;
      }
      const key = `dependency_kind:${dependency.kind}`;
      contributors.set(key, [
        ...(contributors.get(key) ?? []),
        {
          item_id: item?.id,
          target_id: dependency.id,
          created_at: createdAt,
          author: dependency.author ?? null,
          source_kind: dependency.source_kind ?? null,
        },
      ]);
    }
  }
  return contributors;
}

/** Map a declaration's selector to the measurement key it is recomputed from. */
export function selectorKey(selector) {
  if (selector?.source === "dependency_kind") {
    return selector.kind;
  }
  if (selector?.source === "validate_warning") {
    return selector.code;
  }
  if (selector?.source === "graph_profile") {
    return selector.field;
  }
  if (selector?.source === "health_check") {
    return selector.name;
  }
  return undefined;
}

/** Human-readable rendering of a selector, used in every failure message. */
export function formatSelector(selector) {
  return `${selector?.source ?? "unknown"}:${selectorKey(selector) ?? "unknown"}`;
}

/**
 * Resolve one declaration's observed count from the measurement bundle.
 *
 * A `dependency_kind` selector that matches nothing is a genuine zero (the alias
 * was fully retired). A `validate_warning` selector that matches nothing is also
 * zero, because validate omits a warning class once it is clean. A
 * `graph_profile` selector that matches nothing is an error, because a profile
 * field either exists or the declaration names a field the product removed.
 */
export function observeDeclaration(declaration, measurements) {
  const selector = declaration?.selector;
  const key = selectorKey(selector);
  if (!SELECTOR_SOURCES.includes(selector?.source) || typeof key !== "string" || key.length === 0) {
    return { error: `unusable selector ${formatSelector(selector)}` };
  }
  const counts = measurements[selector.source];
  if (!(counts instanceof Map)) {
    return { error: `no measurement collected for source ${selector.source}` };
  }
  if (selector.source === "graph_profile" && !counts.has(key)) {
    return { error: `graph profile has no numeric field "${key}"` };
  }
  return { observed: counts.get(key) ?? 0 };
}

/** Return a terminal observation when a declaration cannot proceed to comparison. */
function resolveNonComparableObservation(base, ownerStatus, result) {
  if (ownerStatus === undefined) {
    return { ...base, observed: null, ok: false, reason: "owner_not_found" };
  }
  if (result.error !== undefined) {
    return { ...base, observed: null, ok: false, reason: result.error };
  }
  if (base.retired) {
    return { ...base, observed: result.observed, ok: true, reason: "retired_with_owner" };
  }
  if (!Number.isInteger(base.ceiling) || base.ceiling < 0) {
    return { ...base, observed: result.observed, ok: false, reason: "ceiling_not_a_count" };
  }
  return null;
}

/** Evaluate one declaration against its measured count and owning lifecycle state. */
function evaluateDeclaration(declaration, measurements, ownerStatuses, contributors) {
  const ownerStatus = ownerStatuses?.get?.(declaration?.owner);
  const base = {
    id: declaration?.id,
    owner: declaration?.owner,
    selector: formatSelector(declaration?.selector),
    ceiling: declaration?.ceiling,
    owner_status: ownerStatus ?? null,
    retired: TERMINAL_OWNER_STATUSES.includes(ownerStatus),
  };
  const result = observeDeclaration(declaration, measurements);
  const nonComparable = resolveNonComparableObservation(base, ownerStatus, result);
  if (nonComparable !== null) {
    return nonComparable;
  }
  const ceiling = base.ceiling;
  const exceeded = result.observed > ceiling;
  const contributionRows = contributors?.get?.(base.selector) ?? [];
  const overshoot = result.observed - ceiling;
  return {
    ...base,
    observed: result.observed,
    ok: !exceeded,
    reason: exceeded ? "ceiling_exceeded" : "within_ceiling",
    ...(exceeded
      ? {
          contributor_count: contributionRows.length,
          contributors: contributionRows.slice(0, Math.min(overshoot, 8)),
        }
      : {}),
  };
}

/** Find observed exhaustive-source keys omitted from the reviewed declaration document. */
function findUndeclaredObservations(declarations, measurements) {
  return EXHAUSTIVE_SELECTOR_SOURCES.flatMap((source) => {
    const declaredKeys = new Set(
      declarations
        .filter((entry) => entry?.selector?.source === source)
        .map((entry) => selectorKey(entry.selector)),
    );
    return [...(measurements[source] ?? [])]
      .filter(([key]) => !declaredKeys.has(key))
      .map(([key, observed]) => ({
        id: null,
        owner: null,
        selector: `${source}:${key}`,
        ceiling: null,
        owner_status: null,
        retired: false,
        observed,
        ok: false,
        reason: "undeclared_population",
      }));
  });
}

/**
 * Evaluate every declaration and exhaustive observed key against reviewed policy.
 *
 * Returns the full observation set alongside violations and retirements so the
 * JSON report can be diffed between local and hosted runs.
 */
export function evaluateDeclarations({ declarations, measurements, ownerStatuses, contributors }) {
  const declarationRows = Array.isArray(declarations) ? declarations : [];
  const observations = declarationRows.map((declaration) =>
    evaluateDeclaration(declaration, measurements, ownerStatuses, contributors),
  );
  const violations = observations.filter((observation) => !observation.ok);
  const undeclared = findUndeclaredObservations(declarationRows, measurements);
  observations.push(...undeclared);
  violations.push(...undeclared);
  return { observations, violations };
}

/** Render one violation as the single line a failing build prints. */
export function formatViolation(observation) {
  const observed = observation.observed === null ? "unmeasured" : String(observation.observed);
  const overshoot =
    observation.reason === "ceiling_exceeded"
      ? ` (+${String(observation.observed - observation.ceiling)} since it was filed)`
      : "";
  const contributorRows = Array.isArray(observation.contributors) ? observation.contributors : [];
  const contributors = contributorRows
    .map(
      (row) =>
        `${row.item_id ?? "<item>"}->${row.target_id ?? "<target>"}@${row.author ?? "unknown"} ${row.created_at ?? "unknown-time"} ${row.source_kind ?? "unknown-source"}`,
    )
    .join("; ");
  const contributorSuffix = contributors.length > 0 ? `; mutations: ${contributors}` : "";
  return `${observation.id ?? "<unnamed>"} [${observation.selector}] owner ${observation.owner ?? "<none>"} (${observation.owner_status ?? "unknown"}): declared ${String(observation.ceiling)}, observed ${observed}${overshoot} — ${observation.reason}${contributorSuffix}`;
}

/** Rebuild the declaration list from the observed counts, for `--update`. */
export function buildUpdatedDeclarations(document, evaluation, today) {
  const observed = new Map(evaluation.observations.map((entry) => [entry.id, entry]));
  return {
    ...document,
    declarations: document.declarations.map((declaration) => {
      const entry = observed.get(declaration.id);
      if (entry === undefined || entry.observed === null || entry.retired) {
        return declaration;
      }
      return {
        ...declaration,
        ceiling: Math.min(declaration.ceiling, entry.observed),
        measured_on: entry.observed < declaration.ceiling ? today : declaration.measured_on,
      };
    }),
  };
}

/** Read and shape-check the checked-in declaration document. */
export function loadDocument(declarationsPath) {
  const document = JSON.parse(readFileSync(declarationsPath, "utf8"));
  if (document?.version !== DOCUMENT_VERSION || !Array.isArray(document?.declarations)) {
    fail(`Unsupported tracker measurement document: ${declarationsPath}`);
  }
  return document;
}

function runCliJson(context, args) {
  const argv = [...context.pmPrefixArgs, ...args, "--json", "--no-extensions"];
  const result = spawnSync(context.pmBin, argv, {
    cwd: context.cwd ?? repoRoot,
    env: { ...process.env, ...context.env },
    encoding: "utf8",
    maxBuffer: CLI_MAX_BUFFER_BYTES,
  });
  if ((result.status ?? 1) !== 0) {
    fail(
      `Tracker measurement command failed: ${context.pmBin} ${argv.join(" ")}\n${(result.stderr ?? "").trim()}`,
    );
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    fail(
      `Tracker measurement command returned unparsable JSON: ${context.pmBin} ${argv.join(" ")}\n${result.stdout.slice(0, 500)}`,
    );
  }
}

/**
 * Collect only the measurements the declared selectors actually need, plus the
 * status of every owning item so retired ceilings drop out.
 */
export function measureTracker(context, declarations) {
  const sources = new Set(declarations.map((declaration) => declaration?.selector?.source));
  const listing = runCliJson(context, [
    "list",
    "--status",
    "all",
    "--limit",
    "1000000",
    "--no-truncate",
    "--fields",
    "id,status,dependencies",
  ]);
  const items = Array.isArray(listing?.items) ? listing.items : [];
  const ownerStatuses = new Map(items.map((item) => [item?.id, item?.status]));
  const measurements = {
    dependency_kind: measureDependencyKinds(items),
    validate_warning: sources.has("validate_warning")
      ? measureValidateWarnings(runCliJson(context, ["validate"]))
      : new Map(),
    graph_profile: sources.has("graph_profile")
      ? measureGraphProfile(runCliJson(context, ["graph", "audit"]))
      : new Map(),
    health_check: sources.has("health_check")
      ? measureHealthChecks(runCliJson(context, ["health", "--check-only"]))
      : new Map(),
  };
  return {
    measurements,
    ownerStatuses,
    contributors: measureDependencyContributors(items, declarations),
    item_count: items.length,
  };
}

/** Resolve how the gate invokes pm: this checkout's dist build, or an explicit bin and tracker. */
export function cliContext(flags) {
  const pmBin = flagString(flags, "pm-bin", null);
  const pmPath = flagString(flags, "pm-path", null);
  return {
    pmBin: pmBin ?? process.execPath,
    pmPrefixArgs: pmBin ? [] : [path.join(repoRoot, "dist", "cli.js")],
    env: pmPath ? { PM_PATH: pmPath, PM_GLOBAL_PATH: path.join(pmPath, ".global"), PM_NO_TELEMETRY: "1" } : {},
  };
}

/**
 * Prove the ratchet can fail. Seeds a throwaway tracker holding exactly one
 * `blocks` row, declares a ceiling of zero for it, and requires the same
 * evaluation path to report a violation. A gate that has never been observed
 * failing is a hypothesis, not a gate.
 */
export function runNegativeControl(flags) {
  const context = { ...cliContext(flags) };
  const root = mkdtempSync(path.join(tmpdir(), "pm-tracker-ratchet-"));
  try {
    context.cwd = root;
    context.env = {
      PM_PATH: path.join(root, ".agents", "pm"),
      PM_GLOBAL_PATH: path.join(root, ".global"),
      PM_NO_TELEMETRY: "1",
    };
    runCliJson(context, ["init", "ctl"]);
    const blocker = runCliJson(context, ["create", "--title", "control blocker", "--type", "Task"]);
    const dependent = runCliJson(context, [
      "create",
      "--title",
      "control dependent",
      "--type",
      "Task",
      "--dep",
      `id=${String(blocker.id)},kind=blocks`,
    ]);
    const declarations = [
      {
        id: "negative-control",
        owner: String(dependent.id),
        selector: { source: "dependency_kind", kind: "blocks" },
        ceiling: 0,
      },
    ];
    const { measurements, ownerStatuses } = measureTracker(context, declarations);
    const evaluation = evaluateDeclarations({ declarations, measurements, ownerStatuses });
    if (evaluation.violations.length === 0) {
      fail("Tracker measurement negative control did not fail on a row beyond its declared ceiling.");
    }
    process.stdout.write(
      `Tracker measurement negative control passed: ${formatViolation(evaluation.violations[0])}\n`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Entrypoint: check by default, `--update` to re-declare, `--negative-control` to prove failure. */
export function main(argv = process.argv.slice(2)) {
  const { flags } = parseFlags(argv);
  if (flagBool(flags, "negative-control", false)) {
    runNegativeControl(flags);
    return;
  }
  const declarationsPath = flagString(flags, "declarations", DEFAULT_DECLARATIONS_PATH);
  const document = loadDocument(declarationsPath);
  const context = cliContext(flags);
  const { measurements, ownerStatuses, contributors, item_count } = measureTracker(
    context,
    document.declarations,
  );
  const evaluation = evaluateDeclarations({
    declarations: document.declarations,
    measurements,
    ownerStatuses,
    contributors,
  });

  if (flagBool(flags, "update", false)) {
    if (evaluation.violations.length > 0) {
      fail(
        "Refusing to update tracker measurements while a ceiling is exceeded or an observed population is undeclared.",
      );
    }
    const today = new Date().toISOString().slice(0, 10);
    const updated = buildUpdatedDeclarations(document, evaluation, today);
    writeFileSync(declarationsPath, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
    process.stdout.write(`Updated tracker measurement declarations: ${declarationsPath}\n`);
    return;
  }

  if (flagBool(flags, "json", false)) {
    process.stdout.write(
      `${JSON.stringify({ ok: evaluation.violations.length === 0, item_count, ...evaluation }, null, 2)}\n`,
    );
  }

  if (evaluation.violations.length > 0) {
    fail(
      `Tracker measurement ratchet failed:\n${evaluation.violations.map((violation) => `- ${formatViolation(violation)}`).join("\n")}\n` +
        "A filed measurement is a ceiling. Shrink the population, or move the owning item to a terminal status to retire it.",
    );
  }

  const enforced = evaluation.observations.filter((observation) => !observation.retired).length;
  if (!flagBool(flags, "json", false)) {
    process.stdout.write(
      `Tracker measurement ratchet passed (${enforced} enforced, ${evaluation.observations.length - enforced} retired, ${item_count} items).\n`,
    );
  }
}

function isMainModule() {
  return (
    process.argv[1] !== undefined &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  );
}

/* c8 ignore next 3 -- the module entrypoint guard is exercised by the CLI, not the spec */
if (isMainModule()) {
  main();
}
