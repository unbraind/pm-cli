#!/usr/bin/env node
/**
 * @module scripts/release/defect-evidence-gate
 *
 * Enforces captured boundary evidence, versioned recurrence-family negative
 * controls, historical PM lineage, and structured evidence on new defects.
 */
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildDefectRecurrenceIndex,
  createAssuranceWorkspaceContext,
  evaluateBoundaryFixtures,
  evaluateDefectGateEvidence,
  parseDefectRecurrencePolicy,
  resolvePmRoot,
} from "../../dist/sdk/index.js";

function readScope(argv) {
  const args = new Set(argv);
  return {
    json: args.has("--json"),
    boundaryOnly: args.has("--boundary-only"),
    evidenceOnly: args.has("--evidence-only"),
    policyOnly: args.has("--policy-only"),
    negativeControl: args.has("--negative-control"),
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

async function resolveContext(repositoryRoot, boundaryOnly, providedContext) {
  if (boundaryOnly) return { items: [], terminal_statuses: ["closed", "canceled"] };
  if (providedContext) return providedContext;
  return createAssuranceWorkspaceContext(resolvePmRoot(repositoryRoot), {
    include_history: false,
    resolve_tree: false,
  });
}

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
    ok: findings.length === 0,
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

function renderResult(result, json) {
  if (json) return `${JSON.stringify(result, null, 2)}\n`;
  const findingCount = result.checks.reduce(
    (total, check) => total + check.findings.length,
    0,
  );
  return (
    [
      `Defect evidence gate: ${result.ok ? "PASS" : "FAIL"}`,
      `Captured boundaries: ${result.boundary.evaluated ? `${result.boundary.captured_count}/${result.boundary.boundary_count}` : "not evaluated"}`,
      `Live boundary waivers: ${result.boundary.evaluated ? result.boundary.waived_count : "not evaluated"}`,
      `Governed terminal defects: ${result.defect_evidence.evaluated ? result.defect_evidence.governed_item_count : "not evaluated"}`,
      `Recurrence families: ${result.recurrence_policy.evaluated ? result.recurrence_policy.family_count : "not evaluated"}`,
      `Findings: ${findingCount}`,
    ].join("\n") + "\n"
  );
}

/** Evaluate captured boundaries only when the selected gate scope includes them. */
function boundaryReportForScope(scope, corpus) {
  if (scope.evidenceOnly || scope.policyOnly) {
    return {
      ok: true,
      evaluated: false,
      boundary_count: 0,
      captured_count: 0,
      waived_count: 0,
      findings: [],
    };
  }
  return {
    ...evaluateBoundaryFixtures(
      corpus.boundaryRegistry,
      boundaryFixtures(corpus.fixtureEntries, scope.negativeControl),
    ),
    evaluated: true,
  };
}

/** Evaluate terminal defect evidence only when the selected scope includes it. */
function evidenceReportForScope(scope, evidenceItems, recurrencePolicy, terminalStatuses) {
  if (scope.boundaryOnly || scope.policyOnly) {
    return {
      ok: true,
      evaluated: false,
      governed_item_count: 0,
      classified_item_count: 0,
      class_counts: {},
      evidence_disposition_counts: {},
      findings: [],
    };
  }
  return {
    ...evaluateDefectGateEvidence(
      evidenceItems,
      recurrencePolicy,
      terminalStatuses,
    ),
    evaluated: true,
  };
}

/** Evaluate recurrence lineage only when the selected scope includes it. */
function recurrenceReportForScope(scope, recurrencePolicy, context) {
  if (scope.boundaryOnly || scope.evidenceOnly) {
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
  return { ...policyReport(recurrencePolicy, context), evaluated: true };
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

/** Execute the gate with injectable tracker context and output sinks for tests and hosts. */
export async function main(argv = process.argv.slice(2), options = {}) {
  const repositoryRoot =
    options.repositoryRoot ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const writeStdout = options.writeStdout ?? ((value) => process.stdout.write(value));
  const writeStderr = options.writeStderr ?? ((value) => process.stderr.write(value));
  const scope = readScope(argv);
  if ([scope.boundaryOnly, scope.evidenceOnly, scope.policyOnly].filter(Boolean).length > 1) {
    writeStderr("Select at most one of --boundary-only, --evidence-only, or --policy-only.\n");
    return 2;
  }
  const corpus = await readGateCorpus(repositoryRoot, options.recurrencePolicy);
  const boundaryReport = boundaryReportForScope(scope, corpus);
  const context = await resolveContext(repositoryRoot, scope.boundaryOnly, options.context);
  const evidenceItems = scope.negativeControl
    ? [
        ...context.items,
        {
          id: "pm-negative-control",
          status: context.terminal_statuses?.[0] ?? "closed",
          type: "Issue",
          completed_at: new Date(
            Date.parse(corpus.recurrencePolicy.evidence_epoch) + 1,
          ).toISOString(),
        },
      ]
    : context.items;
  const evidenceReport = evidenceReportForScope(
    scope,
    evidenceItems,
    corpus.recurrencePolicy,
    context.terminal_statuses ?? ["closed", "canceled"],
  );
  const recurrenceReport = recurrenceReportForScope(scope, corpus.recurrencePolicy, context);
  const selectedReports = reportsWithFindings(
    scope, boundaryReport, evidenceReport, recurrenceReport,
  );
  const result = {
    ok: selectedReports.every((report) => report.ok),
    checks: selectedReports,
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
