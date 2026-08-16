#!/usr/bin/env node
/**
 * @module scripts/release/defect-evidence-gate
 *
 * Enforces captured boundary evidence, versioned recurrence-family negative
 * controls, historical PM lineage, and structured evidence on new defects.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  analyzeDefectChangeRisk,
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

async function readGateCorpus(repositoryRoot, providedPolicy) {
  const [boundaryRegistry, storedRecurrencePolicy] = await Promise.all([
    readFile(path.join(repositoryRoot, "config/boundary-fixtures.json"), "utf8").then(JSON.parse),
    readFile(path.join(repositoryRoot, "config/defect-recurrence-policy.json"), "utf8")
      .then(JSON.parse)
      .then(parseDefectRecurrencePolicy),
  ]);
  const fixtureEntries = await Promise.all(
    boundaryRegistry.boundaries
      .filter((boundary) => typeof boundary.fixture_path === "string")
      .map(async (boundary) => [
        boundary.fixture_path,
        JSON.parse(await readFile(path.join(repositoryRoot, boundary.fixture_path), "utf8")),
      ]),
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
    if (
      !analyzeDefectChangeRisk(index, family.negative_control, { limit: 100 }).items.some(
        (match) => match.family_id === family.id,
      )
    ) {
      familyFindings.push({
        family_id: family.id,
        kind: "ineffective_negative_control",
        detail: `Negative control for ${family.id} does not select its own family.`,
      });
    }
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
  return (
    [
      `Defect evidence gate: ${result.ok ? "PASS" : "FAIL"}`,
      `Captured boundaries: ${result.boundary.captured_count}/${result.boundary.boundary_count}`,
      `Live boundary waivers: ${result.boundary.waived_count}`,
      `Governed terminal defects: ${result.defect_evidence.governed_item_count}`,
      `Recurrence families: ${result.recurrence_policy.family_count}`,
      `Findings: ${result.boundary.findings.length + result.defect_evidence.findings.length + result.recurrence_policy.findings.length}`,
    ].join("\n") + "\n"
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
  const boundaryReport = evaluateBoundaryFixtures(
    corpus.boundaryRegistry,
    boundaryFixtures(corpus.fixtureEntries, scope.negativeControl),
  );
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
  const evidenceReport = evaluateDefectGateEvidence(
    evidenceItems,
    corpus.recurrencePolicy,
    context.terminal_statuses ?? ["closed", "canceled"],
  );
  const recurrenceReport = policyReport(corpus.recurrencePolicy, context);
  const selectedReports = selectedChecks(
    scope,
    boundaryReport,
    evidenceReport,
    recurrenceReport,
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
