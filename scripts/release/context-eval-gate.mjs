#!/usr/bin/env node

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONTEXT_EVALUATION_METRIC_NAMES,
  PmClient,
  recordContextUsageServing,
  recordContextUsageTouches,
  runContextEvaluationScenario,
  summarizeContextEvaluationReports,
} from "../../dist/cli-bundle/sdk.js";
import { fail, parseFlags, repoRoot } from "./utils.mjs";

const DEFAULT_CORPUS_PATH = path.join(repoRoot, "tests", "context-eval", "golden-scenarios.json");
const DEFAULT_BASELINE_PATH = path.join(repoRoot, "tests", "context-eval", "baseline.json");
const BASELINE_VERSION = 1;
const REGRESSION_TOLERANCE = 0.0001;

function requiredObject(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`Context evaluation ${label} must be an object`);
  }
  return value;
}

function readCorpus(corpusPath) {
  const corpus = requiredObject(JSON.parse(readFileSync(corpusPath, "utf8")), "corpus");
  if (corpus.version !== 1 || !Array.isArray(corpus.scenarios) || corpus.scenarios.length === 0) {
    fail("Context evaluation corpus requires version 1 and a non-empty scenarios array");
  }
  const thresholds = requiredObject(corpus.thresholds, "thresholds");
  for (const metric of CONTEXT_EVALUATION_METRIC_NAMES) {
    if (!Number.isFinite(thresholds[metric])) {
      fail(`Context evaluation threshold ${metric} must be a finite number`);
    }
  }
  return corpus;
}

function readBaseline(baselinePath) {
  const baseline = requiredObject(JSON.parse(readFileSync(baselinePath, "utf8")), "baseline");
  if (!Array.isArray(baseline.scenarios)) fail("Context evaluation baseline.scenarios must be an array");
  requiredObject(baseline.aggregate, "baseline.aggregate");
  return baseline;
}

function mapKeys(values, idByKey, label) {
  const mapped = {};
  for (const [key, value] of Object.entries(values ?? {})) {
    const id = idByKey.get(key);
    if (!id) fail(`Context evaluation ${label} references unknown item key: ${key}`);
    mapped[id] = value;
  }
  return mapped;
}

function optionalArray(value, label) {
  if (value !== undefined && !Array.isArray(value)) fail(`Context evaluation ${label} must be an array`);
  return value ?? [];
}

function requiredKey(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) fail(`Context evaluation ${label} requires a non-empty key`);
  return value;
}

/** Convert corpus keys into one SDK scenario after its workspace is seeded. */
export function mapScenarioDefinition(definition, idByKey) {
  const options = { ...definition.options };
  if (typeof options.parent_key === "string") {
    const parent = idByKey.get(options.parent_key);
    if (!parent) fail(`Context evaluation options reference unknown parent key: ${options.parent_key}`);
    options.parent = parent;
    delete options.parent_key;
  }
  return {
    id: definition.id,
    surface: definition.surface,
    options,
    judgments: mapKeys(definition.judgments, idByKey, "judgments"),
    required_ids: Object.keys(mapKeys(Object.fromEntries((definition.required_keys ?? []).map((key) => [key, 1])), idByKey, "required_keys")),
    continuity_ids: Object.keys(mapKeys(Object.fromEntries((definition.continuity_keys ?? []).map((key) => [key, 1])), idByKey, "continuity_keys")),
    token_budget: definition.token_budget,
    rationale: definition.rationale,
  };
}

async function seedWorkspace(definition, workspaceRoot) {
  const pmRoot = path.join(workspaceRoot, ".agents", "pm");
  const client = new PmClient({ pmRoot, cwd: workspaceRoot, author: "context-eval-agent", noExtensions: true });
  await client.init(undefined, { defaults: true });
  const idByKey = new Map();
  const workspace = requiredObject(definition.workspace, `scenario ${definition.id} workspace`);
  for (const rawItem of optionalArray(workspace.items, `scenario ${definition.id} workspace.items`)) {
    const item = requiredObject(rawItem, `scenario ${definition.id} workspace item`);
    const { key, parent_key: parentKey, ...options } = item;
    requiredKey(key, `scenario ${definition.id} workspace item`);
    const parent = parentKey === undefined ? undefined : idByKey.get(parentKey);
    if (parentKey !== undefined && parent === undefined) {
      fail(`Context evaluation item ${key} references unknown parent key: ${parentKey}`);
    }
    const created = await client.create({ ...options, ...(parent === undefined ? {} : { parent }) });
    idByKey.set(key, created.item.id);
  }
  for (const rawGenerator of optionalArray(workspace.generators, `scenario ${definition.id} workspace.generators`)) {
    const generator = requiredObject(rawGenerator, `scenario ${definition.id} workspace generator`);
    requiredKey(generator.key_prefix, `scenario ${definition.id} workspace generator`);
    if (!Number.isInteger(generator.count) || generator.count < 0) {
      fail(`Context evaluation scenario ${definition.id} workspace generator count must be a non-negative integer`);
    }
    for (let index = 1; index <= generator.count; index += 1) {
      const suffix = String(index).padStart(3, "0");
      const key = `${generator.key_prefix}${suffix}`;
      const created = await client.create({
        title: `${generator.title_prefix} ${suffix}`,
        description: generator.description,
        type: generator.type,
        status: generator.status,
        priority: generator.priority,
      });
      idByKey.set(key, created.item.id);
    }
  }
  return { client, idByKey, pmRoot };
}

async function seedUsageFeedback(definition, idByKey, pmRoot) {
  if (definition.usage_feedback === undefined) return;
  const feedback = requiredObject(definition.usage_feedback, `scenario ${definition.id} usage_feedback`);
  const servedKeys = optionalArray(feedback.served_keys, `scenario ${definition.id} usage_feedback.served_keys`);
  const touchedKeys = optionalArray(feedback.touched_keys, `scenario ${definition.id} usage_feedback.touched_keys`);
  const servedIds = servedKeys.map((key) => {
    const id = idByKey.get(requiredKey(key, `scenario ${definition.id} served key`));
    if (!id) fail(`Context evaluation usage_feedback references unknown item key: ${key}`);
    return id;
  });
  const touchedIds = touchedKeys.map((key) => {
    const id = idByKey.get(requiredKey(key, `scenario ${definition.id} touched key`));
    if (!id) fail(`Context evaluation usage_feedback references unknown item key: ${key}`);
    return id;
  });
  await recordContextUsageServing({
    pmRoot,
    author: "context-eval-agent",
    surface: definition.surface,
    profile: definition.surface,
    rows: servedIds.map((id, index) => ({ id, rank: index + 1, included: true })),
    now: "2026-07-01T00:00:00.000Z",
  });
  await recordContextUsageTouches({
    pmRoot,
    author: "context-eval-agent",
    itemIds: touchedIds,
    intent: "update",
    now: "2026-07-01T00:01:00.000Z",
  });
}

/** Build the committed comparison baseline from a current corpus report. */
export function buildContextEvaluationBaseline(report, corpusVersion) {
  return {
    version: BASELINE_VERSION,
    corpus_version: corpusVersion,
    aggregate: report.aggregate,
    scenarios: report.scenarios.map((scenario) => ({ id: scenario.id, metrics: scenario.metrics })),
  };
}

function appendMetricRegressions(failures, prefix, current, previous) {
  for (const metric of Object.keys(previous ?? {})) {
    if (!(metric in current)) failures.push(`${prefix}${metric}:removed_from_report`);
  }
  for (const [metric, value] of Object.entries(current)) {
    const prior = previous?.[metric];
    if (typeof value === "boolean") {
      if (typeof prior !== "boolean") failures.push(`${prefix}${metric}:missing_baseline`);
      else if (prior && !value) failures.push(`${prefix}${metric}:false<baseline:true`);
    } else if (!Number.isFinite(prior)) {
      failures.push(`${prefix}${metric}:missing_baseline`);
    } else if (value + REGRESSION_TOLERANCE < prior) {
      failures.push(`${prefix}${metric}:${value}<baseline:${prior}`);
    }
  }
}

/** Return actionable metric regressions against the committed baseline. */
export function compareContextEvaluationBaseline(report, baseline) {
  const failures = [];
  if (baseline.version !== BASELINE_VERSION) failures.push(`baseline_version:${baseline.version}`);
  if (report.scenario_count !== baseline.scenarios?.length) {
    failures.push(`scenario_count:${report.scenario_count}!=${baseline.scenarios?.length ?? 0}`);
  }
  appendMetricRegressions(failures, "", report.aggregate, baseline.aggregate);
  const reportScenarios = new Map();
  for (const scenario of report.scenarios) {
    if (reportScenarios.has(scenario.id)) {
      failures.push(`scenario:${scenario.id}:duplicate_in_report`);
      continue;
    }
    reportScenarios.set(scenario.id, scenario.metrics);
  }
  const baselineScenarioIds = new Set();
  for (const scenario of baseline.scenarios ?? []) {
    if (baselineScenarioIds.has(scenario.id)) {
      failures.push(`scenario:${scenario.id}:duplicate_in_baseline`);
      continue;
    }
    baselineScenarioIds.add(scenario.id);
    const current = reportScenarios.get(scenario.id);
    if (!current) {
      failures.push(`scenario:${scenario.id}:missing_from_report`);
      continue;
    }
    appendMetricRegressions(failures, `scenario:${scenario.id}:`, current, scenario.metrics);
  }
  for (const scenarioId of reportScenarios.keys()) {
    if (!baselineScenarioIds.has(scenarioId)) failures.push(`scenario:${scenarioId}:missing_baseline`);
  }
  return failures;
}

async function measureCorpus(corpus) {
  const reports = [];
  const originalAuthor = process.env.PM_AUTHOR;
  process.env.PM_AUTHOR = "context-eval-agent";
  try {
    for (const definition of corpus.scenarios) {
      const workspaceRoot = mkdtempSync(path.join(tmpdir(), `pm-context-eval-${definition.id}-`));
      try {
        const { client, idByKey, pmRoot } = await seedWorkspace(definition, workspaceRoot);
        await seedUsageFeedback(definition, idByKey, pmRoot);
        reports.push(await runContextEvaluationScenario(mapScenarioDefinition(definition, idByKey), client));
      } finally {
        rmSync(workspaceRoot, { recursive: true, force: true });
      }
    }
  } finally {
    if (originalAuthor === undefined) delete process.env.PM_AUTHOR;
    else process.env.PM_AUTHOR = originalAuthor;
  }
  return summarizeContextEvaluationReports(reports, corpus.thresholds);
}

/** Run the isolated SDK context-quality gate or intentionally refresh its baseline. */
export async function main(argv = process.argv.slice(2)) {
  const { flags } = parseFlags(argv);
  const corpusFlag = flags.get("corpus");
  const baselineFlag = flags.get("baseline");
  const corpusPath = corpusFlag === undefined || corpusFlag === true ? DEFAULT_CORPUS_PATH : path.resolve(String(corpusFlag));
  const baselinePath = baselineFlag === undefined || baselineFlag === true ? DEFAULT_BASELINE_PATH : path.resolve(String(baselineFlag));
  if (!existsSync(corpusPath)) fail(`Context evaluation corpus missing: ${corpusPath}`);
  const corpus = readCorpus(corpusPath);
  const report = await measureCorpus(corpus);
  if (flags.has("update")) {
    writeFileSync(baselinePath, `${JSON.stringify(buildContextEvaluationBaseline(report, corpus.version), null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report;
  }
  if (!existsSync(baselinePath)) fail(`Context evaluation baseline missing: ${baselinePath}\nRun pnpm quality:context-eval -- --update`);
  const baseline = readBaseline(baselinePath);
  const regressions = compareContextEvaluationBaseline(report, baseline);
  if (!report.passed || regressions.length > 0) {
    fail(`Context evaluation gate failed: ${[...report.failures, ...regressions].join(", ")}`);
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report;
}

/* c8 ignore start -- unit tests invoke main directly; this only guards executable module dispatch */
const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  await main();
}
/* c8 ignore stop */
