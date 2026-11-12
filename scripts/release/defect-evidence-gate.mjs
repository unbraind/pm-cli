#!/usr/bin/env node
/**
 * @module scripts/release/defect-evidence-gate
 *
 * Enforces captured boundary evidence, versioned recurrence-family negative
 * controls, historical PM lineage, and structured evidence on new defects.
 * `--waiver-notice` instead fails while any time-bounded waiver is inside its
 * declared notice window or already expired, so a scheduled run can warn days
 * before an expiry blocks a release.
 */
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  analyzeDefectRecurrenceCoverage,
  buildDefectRecurrenceIndex,
  createAssuranceWorkspaceContext,
  evaluateBoundaryFixtures,
  evaluateDefectGateEvidence,
  parseDefectRecurrencePolicy,
  resolvePmRoot,
  sortWaiverNotices,
} from "../../dist/sdk/index.js";

function readScope(argv) {
  const args = new Set(argv);
  return {
    json: args.has("--json"),
    boundaryOnly: args.has("--boundary-only"),
    evidenceOnly: args.has("--evidence-only"),
    policyOnly: args.has("--policy-only"),
    negativeControl: args.has("--negative-control"),
    waiverNotice: args.has("--waiver-notice"),
  };
}

function assertContainedFixturePath(repositoryRoot, fixturePath, label) {
  const relativeFixturePath = path.relative(repositoryRoot, fixturePath);
  if (
    relativeFixturePath === "" ||
    relativeFixturePath.startsWith(`..${path.sep}`) ||
    relativeFixturePath === ".." ||
    path.isAbsolute(relativeFixturePath)
  ) {
    throw new TypeError(
      `Boundary fixture ${label} must stay inside the repository root.`,
    );
  }
}

async function readGateCorpus(repositoryRoot, providedPolicy) {
  const resolvedRepositoryRoot = await realpath(path.resolve(repositoryRoot));
  const [boundaryRegistry, storedRecurrencePolicy] = await Promise.all([
    readFile(path.join(resolvedRepositoryRoot, "config/boundary-fixtures.json"), "utf8").then(JSON.parse),
    readFile(path.join(resolvedRepositoryRoot, "config/defect-recurrence-policy.json"), "utf8")
      .then(JSON.parse)
      .then(parseDefectRecurrencePolicy),
  ]);
  const fixtureEntries = await Promise.all(
    boundaryRegistry.boundaries
      .filter((boundary) => typeof boundary.fixture_path === "string")
      .map(async (boundary) => {
        const requestedFixturePath = path.resolve(
          resolvedRepositoryRoot,
          boundary.fixture_path,
        );
        assertContainedFixturePath(
          resolvedRepositoryRoot,
          requestedFixturePath,
          boundary.fixture_path,
        );
        const resolvedFixturePath = await realpath(requestedFixturePath);
        assertContainedFixturePath(
          resolvedRepositoryRoot,
          resolvedFixturePath,
          boundary.fixture_path,
        );
        return [
          boundary.fixture_path,
          JSON.parse(await readFile(resolvedFixturePath, "utf8")),
        ];
      }),
  );
  return {
    boundaryRegistry,
    recurrencePolicy: providedPolicy ?? storedRecurrencePolicy,
    fixtureEntries,
  };
}

function boundaryFixtures(entries, negativeControl) {
  const fixtures = Object.fromEntries(entries);
  const firstFixturePath = entries[0]?.[0];
  if (negativeControl && firstFixturePath) {
    fixtures[firstFixturePath] = {
      ...fixtures[firstFixturePath],
      capture_source: "self_generated",
    };
  }
  return fixtures;
}

/** Load strict complete workspace input for policy gates; boundary-only checks need no tracker scan. */
async function resolveContext(repositoryRoot, boundaryOnly, providedContext) {
  if (boundaryOnly) return { items: [], terminal_statuses: ["closed", "canceled"] };
  if (providedContext) return providedContext;
  return createAssuranceWorkspaceContext(resolvePmRoot(repositoryRoot), {
    strict_read: true,
    include_history: false,
    resolve_tree: false,
  });
}

/** Validate registered historical seeds and the full recurrence population before bounding finding rows. */
function policyReport(recurrencePolicy, context) {
  const index = buildDefectRecurrenceIndex(recurrencePolicy, context.items);
  const knownItemIds = new Set(context.items.map((item) => item.id));
  const findings = recurrencePolicy.families.flatMap((family) => {
    const familyFindings = [];
    for (const itemId of family.historical_item_ids) {
      if (!knownItemIds.has(itemId)) {
        familyFindings.push({
          family_id: family.id,
          kind: "missing_historical_item",
          detail: `${family.id} refers to missing historical item ${itemId}.`,
        });
      }
    }
    return familyFindings;
  });
  const coverage = analyzeDefectRecurrenceCoverage(recurrencePolicy, context.items, { uncoveredOnly: true });
  for (const row of coverage.items) {
    findings.push({ item_id: row.item_id, kind: row.finding, detail: `Recurrence lineage ${row.lineage_id}: ${row.finding}.` });
  }
  const familyCounts = Object.fromEntries(
    [
      "production_defect",
      "nightly_regression",
      "scanner_finding",
      "review_caught_late",
    ].map((escapeClass) => [
      escapeClass,
      recurrencePolicy.families.filter((family) => family.escape_class === escapeClass).length,
    ]),
  );
  return {
    ok: findings.length === 0 && coverage.ok,
    coverage,
    family_count: recurrencePolicy.families.length,
    family_counts: familyCounts,
    indexed_item_count: index.build.items_indexed,
    policy_fingerprint: index.policy_fingerprint,
    findings,
  };
}

function selectedChecks(scope, boundaryReport, evidenceReport, recurrenceReport) {
  return [
    ...(scope.evidenceOnly || scope.policyOnly
      ? []
      : [{ name: "boundary", ok: boundaryReport.ok }]),
    ...(scope.boundaryOnly || scope.policyOnly
      ? []
      : [{ name: "defect_evidence", ok: evidenceReport.ok }]),
    ...(scope.boundaryOnly || scope.evidenceOnly
      ? []
      : [{ name: "recurrence_policy", ok: recurrenceReport.ok }]),
  ];
}

/** Name every finding and notice first: hosts keep only the head of failed output. */
function detailLines(result) {
  return [
    ...result.checks.flatMap((check) =>
      check.findings.map((finding) => `Finding [${check.name}] ${finding.detail}`),
    ),
    ...result.waiver_notices.map(
      (notice) =>
        `Waiver notice: ${notice.subject_id} expires ${notice.expires_at} (${notice.days_remaining} whole days left; owner ${notice.owner})`,
    ),
  ];
}

function renderResult(result, json) {
  if (json) return `${JSON.stringify(result, null, 2)}\n`;
  const findingCount = result.checks.reduce(
    (total, check) => total + check.findings.length,
    0,
  );
  return (
    [
      `${result.mode === "waiver_notice" ? "Waiver notice gate" : "Defect evidence gate"}: ${result.ok ? "PASS" : "FAIL"}`,
      ...detailLines(result),
      `Captured boundaries: ${result.boundary.evaluated ? `${result.boundary.captured_count}/${result.boundary.boundary_count}` : "not evaluated"}`,
      `Live boundary waivers: ${result.boundary.evaluated ? result.boundary.waived_count : "not evaluated"}`,
      `Governed terminal defects: ${result.defect_evidence.evaluated ? result.defect_evidence.governed_item_count : "not evaluated"}`,
      `Recurrence families: ${result.recurrence_policy.evaluated ? result.recurrence_policy.family_count : "not evaluated"}`,
      `Findings: ${findingCount}`,
      `Waiver notices: ${result.waiver_notices.length}`,
    ].join("\n") + "\n"
  );
}

/** Evaluate captured boundaries only when the selected gate scope includes them. */
function boundaryReportForScope(scope, corpus, now) {
  if (scope.evidenceOnly || scope.policyOnly) {
    return {
      ok: true,
      evaluated: false,
      boundary_count: 0,
      captured_count: 0,
      waived_count: 0,
      waiver_notices: [],
      findings: [],
    };
  }
  return {
    ...evaluateBoundaryFixtures(
      corpus.boundaryRegistry,
      boundaryFixtures(corpus.fixtureEntries, scope.negativeControl),
      now,
    ),
    evaluated: true,
  };
}

/** Evaluate terminal defect evidence only when the selected scope includes it. */
function evidenceReportForScope(scope, evidenceItems, recurrencePolicy, terminalStatuses, now) {
  if (scope.boundaryOnly || scope.policyOnly) {
    return {
      ok: true,
      evaluated: false,
      governed_item_count: 0,
      classified_item_count: 0,
      class_counts: {},
      evidence_disposition_counts: {},
      waiver_notices: [],
      findings: [],
    };
  }
  return {
    ...evaluateDefectGateEvidence(
      evidenceItems,
      recurrencePolicy,
      terminalStatuses,
      now,
    ),
    evaluated: true,
  };
}

/** Evaluate recurrence lineage only when the selected scope includes it. */
function recurrenceReportForScope(scope, recurrencePolicy, context) {
  if (scope.boundaryOnly || scope.evidenceOnly || scope.waiverNotice) {
    return {
      ok: true,
      evaluated: false,
      family_count: 0,
      family_counts: {},
      indexed_item_count: 0,
      policy_fingerprint: "",
      findings: [],
    };
  }
  const items = scope.negativeControl ? [...context.items,
    { id: "pm-recurrence-negative", dependencies: [{ id: "pm-recurrence-predecessor", kind: "recurs_from" }] },
    { id: "pm-recurrence-predecessor" },
  ] : context.items;
  return { ...policyReport(recurrencePolicy, { ...context, items }), evaluated: true };
}

/** Attach only selected report findings to the gate-level check receipt. */
function reportsWithFindings(scope, boundaryReport, evidenceReport, recurrenceReport) {
  const findingsByName = {
    boundary: boundaryReport.findings,
    defect_evidence: evidenceReport.findings,
    recurrence_policy: recurrenceReport.findings,
  };
  return selectedChecks(scope, boundaryReport, evidenceReport, recurrenceReport).map(
    (report) => ({ ...report, findings: findingsByName[report.name] }),
  );
}

/** Findings that mean a waiver is expired or could not be evaluated for notice at all. */
const NOTICE_FAILURE_KINDS = new Set(["expired_waiver", "invalid_registry", "invalid_waiver"]);

/** Notice mode fails on waivers inside the window and on any waiver it could not evaluate, never vacuously. */
function waiverNoticeChecks(boundaryReport, evidenceReport) {
  return [
    ["boundary", boundaryReport],
    ["defect_evidence", evidenceReport],
  ].map(([name, report]) => {
    const findings = report.findings.filter((finding) => NOTICE_FAILURE_KINDS.has(finding.kind));
    return { name, ok: findings.length === 0 && report.waiver_notices.length === 0, findings };
  });
}

/** Seed one waiver inside each notice window so notice mode must fail. */
function noticeNegativeControl(corpus, evidenceItems, now) {
  const expiresAt = new Date(now.getTime() + 3_600_000).toISOString();
  corpus.boundaryRegistry = {
    ...corpus.boundaryRegistry,
    waiver_notice_days: Math.max(corpus.boundaryRegistry.waiver_notice_days ?? 0, 1),
    boundaries: [...corpus.boundaryRegistry.boundaries, {
      id: "negative-control-waiver", producer: "negative control", consumer: "negative control",
      format: "negative control", waiver_reason: "Seeded inside the notice window.",
      waiver_owner: "pm-negative-control", waiver_expires_at: expiresAt,
    }],
  };
  corpus.recurrencePolicy = {
    ...corpus.recurrencePolicy,
    waiver_notice_days: Math.max(corpus.recurrencePolicy.waiver_notice_days ?? 0, 1),
  };
  return evidenceItems.map((item) => item.id !== "pm-negative-control" ? item : {
    ...item, escape_class: "production_defect",
    gate_evidence: { disposition: "explicit_waiver", owner: "pm-negative-control",
      waiver_reason: "Seeded inside the notice window.", waiver_expires_at: expiresAt },
  });
}

/** Add the scope's seeded negative-control item, then its notice waivers when requested. */
function evidenceItemsForScope(scope, corpus, context, now) {
  if (!scope.negativeControl) return context.items;
  const seededItems = [
    ...context.items,
    {
      id: "pm-negative-control",
      status: context.terminal_statuses?.[0] ?? "closed",
      type: "Issue",
      completed_at: new Date(Date.parse(corpus.recurrencePolicy.evidence_epoch) + 1).toISOString(),
    },
  ];
  return scope.waiverNotice ? noticeNegativeControl(corpus, seededItems, now) : seededItems;
}

/** Execute the gate with injectable tracker context and output sinks for tests and hosts. */
export async function main(argv = process.argv.slice(2), options = {}) {
  const repositoryRoot =
    options.repositoryRoot ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const writeStdout = options.writeStdout ?? ((value) => process.stdout.write(value));
  const writeStderr = options.writeStderr ?? ((value) => process.stderr.write(value));
  const scope = readScope(argv);
  const now = options.now ?? new Date();
  if (
    [scope.boundaryOnly, scope.evidenceOnly, scope.policyOnly, scope.waiverNotice].filter(Boolean)
      .length > 1
  ) {
    writeStderr(
      "Select at most one of --boundary-only, --evidence-only, --policy-only, or --waiver-notice.\n",
    );
    return 2;
  }
  const corpus = await readGateCorpus(repositoryRoot, options.recurrencePolicy);
  const context = await resolveContext(repositoryRoot, scope.boundaryOnly, options.context);
  const evidenceItems = evidenceItemsForScope(scope, corpus, context, now);
  const boundaryReport = boundaryReportForScope(
    scope.waiverNotice ? { ...scope, negativeControl: false } : scope,
    corpus,
    now,
  );
  const evidenceReport = evidenceReportForScope(
    scope,
    evidenceItems,
    corpus.recurrencePolicy,
    context.terminal_statuses ?? ["closed", "canceled"],
    now,
  );
  const recurrenceReport = recurrenceReportForScope(scope, corpus.recurrencePolicy, context);
  const selectedReports = scope.waiverNotice
    ? waiverNoticeChecks(boundaryReport, evidenceReport)
    : reportsWithFindings(scope, boundaryReport, evidenceReport, recurrenceReport);
  const result = {
    ok: selectedReports.every((report) => report.ok),
    mode: scope.waiverNotice ? "waiver_notice" : "evidence",
    checks: selectedReports,
    waiver_notices: sortWaiverNotices([
      ...boundaryReport.waiver_notices,
      ...evidenceReport.waiver_notices,
    ]),
    boundary: boundaryReport,
    defect_evidence: evidenceReport,
    recurrence_policy: recurrenceReport,
  };
  writeStdout(renderResult(result, scope.json));
  return result.ok ? 0 : 1;
}

/* c8 ignore next 3 -- direct-entry wiring is exercised by repository provider execution. */
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
