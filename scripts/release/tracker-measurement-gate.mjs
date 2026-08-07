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
// property, a selector that recomputes the population from tracked data, and the
// count that was filed. A declaration is enforced in one of two directions and
// a violation names the owner, the selector, both counts, and the distance.
//
// A `ceiling` guards a defect population: observed above declared fails. A
// `floor` guards a deliberately authored property: observed below declared
// fails (pm-g4k74y). Without the second polarity the gate could state that a
// defect may not grow and could not state that the typed relationship structure
// this project spends every maintenance pass authoring may not be destroyed —
// and `--dep-remove` deletes every row matching its selector, so a mass deletion
// would have read as an improvement in every ceiling simultaneously.
//
// Bounds retire themselves: when the owning item reaches a terminal status its
// declaration stops being enforced, so no bound outlives the property it guards
// and honest work never needs a waiver to close.
//
//   node scripts/release/tracker-measurement-gate.mjs                   # check (default)
//   node scripts/release/tracker-measurement-gate.mjs --json            # machine-readable report
//   node scripts/release/tracker-measurement-gate.mjs --update          # re-declare from observation
//   node scripts/release/tracker-measurement-gate.mjs --working-copy    # measure this checkout as-is
//   node scripts/release/tracker-measurement-gate.mjs --negative-control # prove the gate can fail

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
  "graph_finding",
  "health_check",
]);

/**
 * Sources whose complete observed key set must be declared in the baseline.
 *
 * `graph_finding` is exhaustive because the audit emits a finding only while the
 * condition holds, exactly like a validate warning: an undeclared finding code
 * is therefore a class nothing has ever ratcheted, and it must surface rather
 * than pass silently.
 */
export const EXHAUSTIVE_SELECTOR_SOURCES = Object.freeze([
  "validate_warning",
  "graph_finding",
  "health_check",
]);

/** Stable severity ordering used to ratchet `pm health` check statuses. */
export const HEALTH_STATUS_SEVERITY = Object.freeze({ ok: 0, warn: 1, error: 2 });

/** Owner statuses that retire a bound because the property it guards is finished. */
export const TERMINAL_OWNER_STATUSES = Object.freeze(["closed", "canceled"]);

/**
 * Directions a declaration may be enforced in.
 *
 * A `ceiling` guards a defect population, whose good direction is down. A
 * `floor` guards a quality property, whose good direction is up. Both are
 * ratchets and neither may be relaxed by `--update`; the difference is only
 * which side of the declared number the violation lies on. Without the second
 * polarity the gate can state that a defect may not grow and cannot state that
 * a deliberately authored structure may not be destroyed (pm-g4k74y).
 */
export const BOUND_POLARITIES = Object.freeze(["ceiling", "floor"]);

/**
 * Resolve the single bound a declaration is enforced against.
 *
 * Exactly one polarity may be declared. Declaring both would let a population
 * be pinned to a range, which no owning item has ever filed and which would
 * make `--update` ambiguous; declaring neither leaves nothing to compare.
 */
export function resolveDeclaredBound(declaration) {
  const declared = BOUND_POLARITIES.filter((polarity) =>
    Object.hasOwn(declaration ?? {}, polarity),
  );
  if (declared.length !== 1) {
    return null;
  }
  const polarity = declared[0];
  return { polarity, value: declaration[polarity] };
}

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

/**
 * Count `pm graph audit --json` findings per finding code.
 *
 * The profile carries population fields; the findings carry the conditions the
 * audit is willing to name, and only the findings can express a defect class
 * such as an exactly duplicated stored dependency row. Findings are summed by
 * code because the audit emits one entry per detected group (ordering cycles
 * arrive as several entries sharing one code), and the ratchet is about how much
 * of the class exists, not how it was grouped for reporting.
 */
export function measureGraphFindings(report) {
  const counts = new Map();
  for (const finding of Array.isArray(report?.findings) ? report.findings : []) {
    const code = finding?.code;
    const count = finding?.count;
    if (typeof code !== "string" || code.length === 0) {
      continue;
    }
    const increment = typeof count === "number" && Number.isFinite(count) ? count : 1;
    counts.set(code, (counts.get(code) ?? 0) + increment);
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
  if (selector?.source === "graph_finding") {
    return selector.code;
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
  if (base.polarity === null) {
    return { ...base, observed: result.observed, ok: false, reason: "bound_polarity_not_declared" };
  }
  if (!Number.isInteger(base.bound) || base.bound < 0) {
    return {
      ...base,
      observed: result.observed,
      ok: false,
      reason: `${base.polarity}_not_a_count`,
    };
  }
  return null;
}

/** Evaluate one declaration against its measured count and owning lifecycle state. */
function evaluateDeclaration(declaration, measurements, ownerStatuses, contributors) {
  const ownerStatus = ownerStatuses?.get?.(declaration?.owner);
  const bound = resolveDeclaredBound(declaration);
  const base = {
    id: declaration?.id,
    owner: declaration?.owner,
    selector: formatSelector(declaration?.selector),
    ceiling: declaration?.ceiling,
    floor: declaration?.floor,
    polarity: bound?.polarity ?? null,
    bound: bound?.value,
    owner_status: ownerStatus ?? null,
    retired: TERMINAL_OWNER_STATUSES.includes(ownerStatus),
  };
  const result = observeDeclaration(declaration, measurements);
  const nonComparable = resolveNonComparableObservation(base, ownerStatus, result);
  if (nonComparable !== null) {
    return nonComparable;
  }
  const outcome = resolveBoundOutcome(base.polarity, result.observed, base.bound);
  return {
    ...base,
    observed: result.observed,
    ok: !outcome.violated,
    reason: outcome.reason,
    ...resolveContribution(base, outcome, result.observed, contributors),
  };
}

/** Compare an observation against its bound in the declared direction. */
function resolveBoundOutcome(polarity, observed, bound) {
  if (polarity === "ceiling") {
    const violated = observed > bound;
    return { violated, reason: violated ? "ceiling_exceeded" : "within_ceiling", overshoot: observed - bound };
  }
  const violated = observed < bound;
  return { violated, reason: violated ? "floor_undercut" : "within_floor", overshoot: bound - observed };
}

/**
 * Attach the mutations that pushed a ceiling past its declaration.
 *
 * Contributor rows are read from the record as it stands, so they can name what
 * was added above a ceiling and can never name what was removed below a floor.
 * Attaching them to a floor violation would be the more useful-looking
 * behaviour and would attribute a deletion to whichever rows survived it.
 */
function resolveContribution(base, outcome, observed, contributors) {
  if (!outcome.violated || base.polarity !== "ceiling") {
    return {};
  }
  const rows = contributors?.get?.(base.selector) ?? [];
  return {
    contributor_count: rows.length,
    contributors: rows.slice(0, Math.min(outcome.overshoot, 8)),
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
      : observation.reason === "floor_undercut"
        ? ` (-${String(observation.floor - observation.observed)} since it was filed)`
        : "";
  const contributorRows = Array.isArray(observation.contributors) ? observation.contributors : [];
  const contributors = contributorRows
    .map(
      (row) =>
        `${row.item_id ?? "<item>"}->${row.target_id ?? "<target>"}@${row.author ?? "unknown"} ${row.created_at ?? "unknown-time"} ${row.source_kind ?? "unknown-source"}`,
    )
    .join("; ");
  const contributorSuffix = contributors.length > 0 ? `; mutations: ${contributors}` : "";
  // A ceiling keeps the original wording so a reader who has seen this gate fail
  // before reads the same line; a floor names its polarity, because "declared 3,
  // observed 2" is otherwise indistinguishable from a ceiling that passed.
  const declared =
    observation.polarity === "floor"
      ? `floor ${String(observation.floor)}`
      : String(observation.ceiling);
  return `${observation.id ?? "<unnamed>"} [${observation.selector}] owner ${observation.owner ?? "<none>"} (${observation.owner_status ?? "unknown"}): declared ${declared}, observed ${observed}${overshoot} — ${observation.reason}${contributorSuffix}`;
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
      // Both polarities tighten only. A ceiling follows a shrinking population
      // down; a floor follows a growing property up. Neither is ever relaxed
      // here, so re-baselining can never be the way a regression is accepted.
      if (Object.hasOwn(declaration, "floor")) {
        return {
          ...declaration,
          floor: Math.max(declaration.floor, entry.observed),
          measured_on: entry.observed > declaration.floor ? today : declaration.measured_on,
        };
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
    ...resolveGraphAuditMeasurements(context, sources),
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

/**
 * Collect both graph-derived measurement maps from a single audit invocation.
 *
 * The profile and the findings are two projections of one report, so requesting
 * them separately would run the audit twice on a workspace where it is already
 * the slowest measurement in the bundle.
 */
export function resolveGraphAuditMeasurements(context, sources) {
  const needsProfile = sources.has("graph_profile");
  const needsFindings = sources.has("graph_finding");
  const report = needsProfile || needsFindings ? runCliJson(context, ["graph", "audit"]) : null;
  return {
    graph_profile: needsProfile ? measureGraphProfile(report) : new Map(),
    graph_finding: needsFindings ? measureGraphFindings(report) : new Map(),
  };
}

/**
 * Materialize a commit view: a throwaway tree holding exactly the files the next
 * commit would contain, and no `.git`.
 *
 * A release gate must return a verdict about a commit. Three of these selectors
 * did not. Linked-path existence is decided by looking at the filesystem, so a
 * link into `.agents/pm/extensions/` — installed packages, gitignored by
 * design — resolves for the developer who ran `pm install` and is missing for
 * every fresh checkout. The merge-driver audit reads clone-local `git config`
 * that `pm merge install` writes and no commit can carry, and `pm health` folds
 * that same audit into its integrity status. The result was a gate that passed
 * on a maintainer's machine and failed on the identical commit in CI, which is
 * the one thing a release gate must never do.
 *
 * Membership is `git ls-files --cached --others --exclude-standard`: tracked
 * files plus untracked files that are not ignored, which is precisely what the
 * next commit would carry and is derived entirely from the committed ignore
 * rules. Uncommitted work stays visible, so `--update` and pre-push checks still
 * measure what the author is about to publish. The view has no `.git`, so every
 * clone-local audit is skipped rather than answered differently per machine.
 *
 * Hardlinks make the copy near-free; a filesystem that refuses them falls back
 * to a byte copy. Nothing in the measurement pass writes to the view.
 */
export function materializeCommitView(root = repoRoot) {
  const listed = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: CLI_MAX_BUFFER_BYTES,
  });
  if ((listed.status ?? 1) !== 0) {
    fail(
      `Tracker measurement gate could not enumerate committable files in ${root}\n${(listed.stderr ?? "").trim()}`,
    );
  }
  const relativePaths = (listed.stdout ?? "").split("\0").filter((entry) => entry.length > 0);
  const viewRoot = mkdtempSync(path.join(tmpdir(), "pm-tracker-commit-view-"));
  let materialized = 0;
  let pendingDeletions = 0;
  for (const relativePath of relativePaths) {
    const source = path.join(root, relativePath);
    // A tracked path already deleted in the working tree is a pending deletion:
    // the next commit drops it, so the view drops it too, and the count is
    // reported rather than silently absorbed.
    if (!existsSync(source)) {
      pendingDeletions += 1;
      continue;
    }
    const destination = path.join(viewRoot, relativePath);
    mkdirSync(path.dirname(destination), { recursive: true });
    try {
      linkSync(source, destination);
    } catch {
      copyFileSync(source, destination);
    }
    materialized += 1;
  }
  return { root: viewRoot, materialized_file_count: materialized, pending_deletion_count: pendingDeletions };
}

/** Point a measurement context at a materialized commit view instead of this checkout. */
export function contextForCommitView(context, view) {
  return {
    ...context,
    cwd: view.root,
    env: {
      ...context.env,
      PM_PATH: path.join(view.root, ".agents", "pm"),
      PM_GLOBAL_PATH: path.join(view.root, ".global"),
      PM_NO_TELEMETRY: "1",
    },
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
    // One control per polarity. The workspace holds exactly one blocks row, so a
    // ceiling of zero must be exceeded and a floor of two must be undercut; a
    // gate that can only prove one direction leaves the other unexercised.
    const declarations = [
      {
        id: "negative-control-ceiling",
        owner: String(dependent.id),
        selector: { source: "dependency_kind", kind: "blocks" },
        ceiling: 0,
      },
      {
        id: "negative-control-floor",
        owner: String(dependent.id),
        selector: { source: "dependency_kind", kind: "blocks" },
        floor: 2,
      },
    ];
    const { measurements, ownerStatuses } = measureTracker(context, declarations);
    const evaluation = evaluateDeclarations({ declarations, measurements, ownerStatuses });
    const reasons = new Set(evaluation.violations.map((violation) => violation.reason));
    for (const expected of ["ceiling_exceeded", "floor_undercut"]) {
      if (!reasons.has(expected)) {
        fail(`Tracker measurement negative control did not report ${expected}.`);
      }
    }
    process.stdout.write(
      `Tracker measurement negative control passed both polarities:\n${evaluation.violations
        .map((violation) => `- ${formatViolation(violation)}`)
        .join("\n")}\n`,
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
  // An explicit tracker path is a sandbox or a foreign workspace; a commit view
  // of this checkout would measure the wrong data, so honour the caller.
  const measureWorkingCopy =
    flagBool(flags, "working-copy", false) || flagString(flags, "pm-path", null) !== null;
  const view = measureWorkingCopy ? null : materializeCommitView();
  let collected;
  try {
    const context = view === null ? cliContext(flags) : contextForCommitView(cliContext(flags), view);
    collected = measureTracker(context, document.declarations);
  } finally {
    if (view !== null) {
      rmSync(view.root, { recursive: true, force: true });
    }
  }
  const { measurements, ownerStatuses, contributors, item_count } = collected;
  const evaluation = evaluateDeclarations({
    declarations: document.declarations,
    measurements,
    ownerStatuses,
    contributors,
  });
  const scope =
    view === null
      ? "working copy"
      : `commit view of ${String(view.materialized_file_count)} committable files`;

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
      `${JSON.stringify({ ok: evaluation.violations.length === 0, item_count, scope, ...evaluation }, null, 2)}\n`,
    );
  }

  if (evaluation.violations.length > 0) {
    fail(
      `Tracker measurement ratchet failed (${scope}):\n${evaluation.violations.map((violation) => `- ${formatViolation(violation)}`).join("\n")}\n` +
        "A filed measurement is a ratchet. A ceiling means shrink the population; a floor means restore the property. " +
          "Either way, re-declaring is not the remedy — move the owning item to a terminal status to retire the bound.",
    );
  }

  const enforced = evaluation.observations.filter((observation) => !observation.retired).length;
  if (!flagBool(flags, "json", false)) {
    process.stdout.write(
      `Tracker measurement ratchet passed (${enforced} enforced, ${evaluation.observations.length - enforced} retired, ${item_count} items, ${scope}).\n`,
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
