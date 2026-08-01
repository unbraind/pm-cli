#!/usr/bin/env node

/**
 * Reproducible two-item and current-scale intent-budget calibration gate.
 *
 * Trackers: pm-7hbfch, pm-yekkvt, and pm-sf31yl.
 */
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateSyntheticWorkspace } from "../bench/scale-workspace.mjs";
import { cleanupTempRoot } from "../smoke-cleanup.mjs";
import {
  applyContextIntentProjection,
  attachReadOutputContracts,
} from "../../dist/sdk/context-intent-contracts.js";
import { runContext } from "../../dist/sdk/query/context.js";
import { runGet } from "../../dist/sdk/query/get.js";
import { runList } from "../../dist/sdk/query/list.js";
import { runNext } from "../../dist/sdk/query/next.js";
import { runSearch } from "../../dist/sdk/query/search.js";
import { fail, parseFlags, repoRoot } from "./utils.mjs";

const CURRENT_TRACKER_SCALE = 2_243;
const SCALE_SEARCH_QUERY = "status:all Synthetic";
const REPORT_PATH = path.join(
  repoRoot,
  "scripts",
  "release",
  "context-intent-calibration.json",
);
const CALIBRATION_REGRESSION_MARGIN = 1.15;
const INVARIANT_CONTINUATION_KEYS = Object.freeze([
  "applied_limit",
  "completeness",
  "context_intent",
  "count",
  "filters",
  "has_more",
  "now",
  "omission_receipt",
  "projection",
  "row_contract",
  "sorting",
  "total",
  "truncated",
]);

function serializedBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function intentReceiptViolation(command, result) {
  const receipt = result.context_intent;
  if (
    receipt?.command !== command ||
    receipt.declaration_feasible !== true ||
    receipt.result_omitted !== false ||
    receipt.within_budget !== true ||
    !Number.isFinite(receipt.estimated_tokens) ||
    !Number.isFinite(receipt.token_budget) ||
    receipt.estimated_tokens > receipt.token_budget ||
    serializedBytes(result) > receipt.token_budget * 4
  ) {
    return `${command}: intent result lacks a feasible within-budget receipt`;
  }
  return undefined;
}

/** Prove that removing enforcement from a declared intent is rejected by the same gate predicate. */
export function structuralEnforcementNegativeControl(command, result) {
  const unenforced = { ...result };
  delete unenforced.context_intent;
  return intentReceiptViolation(command, unenforced) !== undefined;
}

/** Return forbidden invariant blocks accidentally repeated after the first cursor page. */
export function repeatedContinuationMetadata(page) {
  return INVARIANT_CONTINUATION_KEYS.filter((key) => key in page);
}

function withReadContracts(command, options, result) {
  return attachReadOutputContracts(command, options, result);
}

async function runIntent(command, manifest, global) {
  if (command === "context") {
    const options = applyContextIntentProjection("context", { for: "orient" });
    return withReadContracts(
      command,
      options,
      await runContext(options, global),
    );
  }
  if (command === "get") {
    const options = applyContextIntentProjection("get", { for: "inspect" });
    return withReadContracts(
      command,
      options,
      await runGet(manifest.sample_ids.get, global, options),
    );
  }
  if (command === "list") {
    const options = applyContextIntentProjection("list", {
      for: "triage",
      status: "all",
    });
    return withReadContracts(
      command,
      options,
      await runList(undefined, options, global),
    );
  }
  if (command === "next") {
    const options = applyContextIntentProjection("next", { for: "execute" });
    return withReadContracts(command, options, await runNext(options, global));
  }
  const options = applyContextIntentProjection("search", { for: "discover" });
  return withReadContracts(
    command,
    options,
    await runSearch(SCALE_SEARCH_QUERY, options, global),
  );
}

async function runCursorPage(command, global, after) {
  const options = applyContextIntentProjection(command, {
    for: command === "list" ? "triage" : "discover",
    ...(command === "list" ? { status: "all" } : {}),
    ...(after === undefined ? {} : { after }),
  });
  const raw =
    command === "list"
      ? await runList(undefined, options, global)
      : await runSearch(SCALE_SEARCH_QUERY, options, global);
  return withReadContracts(command, options, raw);
}

async function runUnboundedCursorBaseline(command, global) {
  const options =
    command === "list"
      ? { status: "all", noTruncate: true }
      : { full: true, limit: String(CURRENT_TRACKER_SCALE + 1) };
  const raw =
    command === "list"
      ? await runList(undefined, options, global)
      : await runSearch(SCALE_SEARCH_QUERY, options, global);
  return withReadContracts(command, options, raw);
}

function validateCursorPage(command, page, continuation) {
  const repeated = continuation ? repeatedContinuationMetadata(page) : [];
  if (repeated.length > 0) {
    throw new Error(
      `${command}: continuation repeated invariant metadata: ${repeated.join(", ")}`,
    );
  }
  if (!Array.isArray(page.items)) {
    throw new Error(`${command}: cursor page omitted its result collection`);
  }
  if (page.items.length === 0 && typeof page.next_cursor === "string") {
    throw new Error(
      `${command}: resumable cursor page omitted every result row`,
    );
  }
}

function assertCursorRowParity(command, ids, baselineIds) {
  if (
    ids.length !== baselineIds.length ||
    new Set(ids).size !== ids.length ||
    ids.some((id, index) => id !== baselineIds[index])
  ) {
    throw new Error(
      `${command}: cursor walk duplicated, omitted, or reordered rows`,
    );
  }
}

async function runCursorWalk(
  command,
  global,
  {
    runPage = runCursorPage,
    runBaseline = runUnboundedCursorBaseline,
    maxPages = CURRENT_TRACKER_SCALE,
  } = {},
) {
  const pages = [];
  const ids = [];
  let after;
  for (;;) {
    const page = await runPage(command, global, after);
    validateCursorPage(command, page, pages.length > 0);
    pages.push(page);
    ids.push(...page.items.map((item) => item.id));
    if (typeof page.next_cursor !== "string") break;
    after = page.next_cursor;
    if (pages.length > maxPages) {
      throw new Error(`${command}: cursor chain did not terminate`);
    }
  }
  const baseline = await runBaseline(command, global);
  const baselineIds = baseline.items.map((item) => item.id ?? item.item?.id);
  assertCursorRowParity(command, ids, baselineIds);
  const firstInvariant = Object.fromEntries(
    INVARIANT_CONTINUATION_KEYS.flatMap((key) =>
      key in pages[0] ? [[key, pages[0][key]]] : [],
    ),
  );
  const optimizedBytes = pages.reduce(
    (total, page) => total + serializedBytes(page),
    0,
  );
  const repeatedMetadataBytes = pages.reduce(
    (total, page, index) =>
      total +
      serializedBytes(index === 0 ? page : { ...firstInvariant, ...page }),
    0,
  );
  const unboundedBytes = serializedBytes(baseline);
  if (optimizedBytes > unboundedBytes) {
    throw new Error(
      `${command}: bounded cursor walk ${optimizedBytes} bytes exceeds unbounded ${unboundedBytes} bytes`,
    );
  }
  if (pages.length > 1 && repeatedMetadataBytes <= optimizedBytes) {
    throw new Error(
      `${command}: repeated-metadata negative control was not more expensive`,
    );
  }
  return {
    rows: ids.length,
    pages: pages.length,
    bytes_per_row: Number((optimizedBytes / ids.length).toFixed(2)),
    optimized_walk_bytes: optimizedBytes,
    repeated_metadata_control_bytes: repeatedMetadataBytes,
    unbounded_single_call_bytes: unboundedBytes,
    optimized_to_unbounded_ratio: Number(
      (optimizedBytes / unboundedBytes).toFixed(4),
    ),
  };
}

async function measureTier(
  itemCount,
  {
    createWorkspaceRoot = mkdtemp,
    generateWorkspace = generateSyntheticWorkspace,
    cleanupWorkspaceRoot = cleanupTempRoot,
    runIntentFn = runIntent,
    negativeControl = structuralEnforcementNegativeControl,
    runCursorWalkFn = runCursorWalk,
  } = {},
) {
  const workspaceRoot = await createWorkspaceRoot(
    path.join(tmpdir(), `pm-intent-calibration-${itemCount}-`),
  );
  try {
    const manifest = await generateWorkspace({
      workspaceRoot,
      itemCount,
      seed: 42,
      shape: "scratch",
      mode: "direct",
      force: true,
    });
    const global = {
      path: manifest.pm_root,
      json: true,
      noExtensions: true,
      author: "context-intent-calibration",
    };
    const intents = {};
    for (const command of ["context", "get", "list", "next", "search"]) {
      const result = await runIntentFn(command, manifest, global);
      const violation = intentReceiptViolation(command, result);
      if (violation !== undefined) throw new Error(violation);
      if (!negativeControl(command, result)) {
        throw new Error(
          `${command}: enforcement negative control escaped detection`,
        );
      }
      intents[command] = {
        delivered_bytes: serializedBytes(result),
        delivered_rows: Array.isArray(result.items)
          ? result.items.length
          : (result.row_contract?.row_keys?.reduce(
              (count, key) =>
                count + (Array.isArray(result[key]) ? result[key].length : 0),
              0,
            ) ?? 0),
        declared_tokens: result.context_intent.token_budget,
        measured_tokens: result.context_intent.estimated_tokens,
        degradation: result.context_intent.degradation,
      };
    }
    return {
      item_count: itemCount,
      intents,
      ...(itemCount === CURRENT_TRACKER_SCALE
        ? {
            cursor_walks: {
              list: await runCursorWalkFn("list", global),
              search: await runCursorWalkFn("search", global),
            },
          }
        : {}),
    };
  } finally {
    cleanupWorkspaceRoot(workspaceRoot);
  }
}

/** Measure both calibration tiers and fail on unreachable budgets or inefficient cursor walks. */
export async function measureContextIntentCalibration(
  measureTierFn = measureTier,
) {
  const previousUsageSetting = process.env.PM_CONTEXT_USAGE_DISABLED;
  process.env.PM_CONTEXT_USAGE_DISABLED = "1";
  try {
    return {
      version: 1,
      metric: "utf8_bytes",
      token_estimate: "ceil(bytes / 4)",
      structural_negative_control:
        "remove context_intent and repeat first-page metadata on a continuation",
      tiers: [
        await measureTierFn(2),
        await measureTierFn(CURRENT_TRACKER_SCALE),
      ],
    };
  } finally {
    if (previousUsageSetting === undefined) {
      delete process.env.PM_CONTEXT_USAGE_DISABLED;
    } else {
      process.env.PM_CONTEXT_USAGE_DISABLED = previousUsageSetting;
    }
  }
}

function assertCalibrationCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function calibrationObjectKeys(value) {
  return value && typeof value === "object" ? Object.keys(value).sort() : [];
}

function assertCalibrationTier(measuredTier, approvedTier) {
  if (measuredTier === null || typeof measuredTier !== "object") {
    throw new Error("calibration tier or intent shape changed");
  }
  const approvedCommands = calibrationObjectKeys(approvedTier.intents);
  const measuredCommands = calibrationObjectKeys(measuredTier.intents);
  assertCalibrationCondition(
    measuredTier.item_count === approvedTier.item_count,
    "calibration tier or intent shape changed",
  );
  assertCalibrationCondition(
    JSON.stringify(measuredCommands) === JSON.stringify(approvedCommands),
    "calibration tier or intent shape changed",
  );
  for (const command of approvedCommands) {
    const approvedIntent = approvedTier.intents[command];
    const measuredIntent = measuredTier.intents[command];
    const message = `${command}: calibration intent ceiling regressed`;
    assertCalibrationCondition(
      measuredIntent.declared_tokens === approvedIntent.declared_tokens,
      message,
    );
    assertCalibrationCondition(
      measuredIntent.degradation === approvedIntent.degradation,
      message,
    );
    assertCalibrationCondition(
      measuredIntent.measured_tokens <= measuredIntent.declared_tokens,
      message,
    );
    assertCalibrationCondition(
      measuredIntent.delivered_bytes <= measuredIntent.declared_tokens * 4,
      message,
    );
  }
  const approvedWalkNames = calibrationObjectKeys(approvedTier.cursor_walks);
  const measuredWalkNames = calibrationObjectKeys(measuredTier.cursor_walks);
  assertCalibrationCondition(
    JSON.stringify(measuredWalkNames) === JSON.stringify(approvedWalkNames),
    "calibration cursor-walk shape changed",
  );
  for (const command of approvedWalkNames) {
    const approvedWalk = approvedTier.cursor_walks[command];
    const measuredWalk = measuredTier.cursor_walks[command];
    const message = `${command}: calibration cursor efficiency regressed`;
    assertCalibrationCondition(
      measuredWalk.rows === approvedWalk.rows,
      message,
    );
    assertCalibrationCondition(
      measuredWalk.pages <=
        Math.ceil(approvedWalk.pages * CALIBRATION_REGRESSION_MARGIN),
      message,
    );
    assertCalibrationCondition(
      measuredWalk.bytes_per_row <=
        approvedWalk.bytes_per_row * CALIBRATION_REGRESSION_MARGIN,
      message,
    );
    assertCalibrationCondition(
      measuredWalk.optimized_to_unbounded_ratio <=
        approvedWalk.optimized_to_unbounded_ratio *
          CALIBRATION_REGRESSION_MARGIN,
      message,
    );
  }
}

/** Fail when a measured report changes contract shape or exceeds an approved performance ceiling. */
export function assertCalibrationWithinApprovedCeilings(
  report,
  approvedReport,
) {
  const reportHeader = {
    version: report?.version,
    metric: report?.metric,
    token_estimate: report?.token_estimate,
    structural_negative_control: report?.structural_negative_control,
  };
  const approvedHeader = {
    version: approvedReport?.version,
    metric: approvedReport?.metric,
    token_estimate: approvedReport?.token_estimate,
    structural_negative_control: approvedReport?.structural_negative_control,
  };
  const reportTiers = Array.isArray(report?.tiers) ? report.tiers : [];
  const approvedTiers = Array.isArray(approvedReport?.tiers)
    ? approvedReport.tiers
    : [];
  assertCalibrationCondition(
    JSON.stringify(reportHeader) === JSON.stringify(approvedHeader),
    "calibration contract shape changed",
  );
  assertCalibrationCondition(
    reportTiers.length === approvedTiers.length,
    "calibration contract shape changed",
  );
  for (const [index, approvedTier] of approvedTiers.entries()) {
    assertCalibrationTier(reportTiers[index], approvedTier);
  }
}

/** Exposes deterministic validation seams for exhaustive gate testing. */
export const _testOnly = {
  assertCursorRowParity,
  intentReceiptViolation,
  measureTier,
  runCursorWalk,
  validateCursorPage,
};

/** Execute the calibration gate with injectable output boundaries for tests. */
export async function main(
  args = process.argv.slice(2),
  {
    measure = measureContextIntentCalibration,
    reportPath = REPORT_PATH,
    readReport = readFile,
    writeReport = writeFile,
    assertReport = assertCalibrationWithinApprovedCeilings,
    log = console.log,
  } = {},
) {
  const { flags } = parseFlags(args);
  const report = await measure();
  if (flags.has("update")) {
    await writeReport(
      reportPath,
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8",
    );
    log(`Updated ${path.relative(repoRoot, reportPath)}`);
    return;
  }
  const approvedReport = JSON.parse(await readReport(reportPath, "utf8"));
  try {
    assertReport(report, approvedReport);
  } catch (error) {
    throw new Error(
      `Context intent calibration drifted from ${path.relative(repoRoot, reportPath)}: ${error instanceof Error ? error.message : String(error)}; run pnpm context:intent:calibrate --update and review the approved report`,
      { cause: error },
    );
  }
  log(
    `Context intent calibration passed (${report.tiers.map((tier) => tier.item_count).join(" and ")} items; five intents; list/search full cursor walks).`,
  );
}

/** Route executable entrypoint failures through the shared release-gate failure contract. */
export async function runMain(run = main, failWith = fail) {
  try {
    await run();
  } catch (error) {
    failWith(error instanceof Error ? error.message : String(error));
  }
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  void runMain();
}
