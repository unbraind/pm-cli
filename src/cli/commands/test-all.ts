/**
 * @module cli/commands/test-all
 *
 * Implements the pm test all command surface and its agent-facing runtime behavior.
 */
import { pathExists } from "../../core/fs/fs-utils.js";
import { getActiveExtensionRegistrations } from "../../core/extensions/index.js";
import { resolveItemTypeRegistry } from "../../core/item/type-registry.js";
import { parseOptionalNumber } from "../../core/item/parse.js";
import { normalizeStatusInput } from "../../core/item/status.js";
import { resolveRuntimeStatusRegistry, type RuntimeStatusRegistry } from "../../core/schema/runtime-schema.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { nowIso } from "../../core/shared/time.js";
import { listAllFrontMatterLight } from "../../core/store/item-store.js";
import { getSettingsPath, resolveGlobalPmRoot, resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import { appendTrackedTestRunSummary } from "../../core/test/item-test-run-tracking.js";
import { resolveAuthor } from "../../core/shared/author.js";
import type { ItemStatus, LinkedTest } from "../../types/index.js";
import {
  countFailureCategories,
  runLinkedTests,
  runTest,
  summarizeContextPreflight,
  type LinkedTestFailureCategory,
  type TestRunResult,
} from "./test.js";

/**
 * Documents the test all command options payload exchanged by command, SDK, and package integrations.
 */
export interface TestAllCommandOptions {
  status?: string;
  limit?: string;
  offset?: string;
  timeout?: string;
  progress?: boolean;
  envSet?: string[];
  envClear?: string[];
  sharedHostSafe?: boolean;
  pmContext?: string;
  overrideLinkedPmContext?: boolean;
  failOnContextMismatch?: boolean;
  failOnSkipped?: boolean;
  failOnEmptyTestRun?: boolean;
  requireAssertionsForPm?: boolean;
  checkContext?: boolean;
  autoPmContext?: boolean;
}

/**
 * Documents the test all item result payload exchanged by command, SDK, and package integrations.
 */
export interface TestAllItemResult {
  ok: boolean;
  id: string;
  status: ItemStatus;
  test_count: number;
  passed: number;
  failed: number;
  skipped: number;
  run_results: TestRunResult[];
  failure_categories: Record<LinkedTestFailureCategory, number>;
}

/**
 * Documents the test all result payload exchanged by command, SDK, and package integrations.
 */
export interface TestAllResult {
  ok: boolean;
  totals: {
    items: number;
    linked_tests: number;
    passed: number;
    failed: number;
    skipped: number;
    failure_categories: Record<LinkedTestFailureCategory, number>;
  };
  failed: number;
  passed: number;
  skipped: number;
  fail_on_skipped_triggered?: boolean;
  fail_on_empty_test_run_triggered?: boolean;
  warnings?: string[];
  results: TestAllItemResult[];
}

type TestAllSelectedItem = Awaited<ReturnType<typeof listAllFrontMatterLight>>[number];

interface TestAllItemTests {
  item: TestAllSelectedItem;
  tests: LinkedTest[];
}

interface TestAllItemRunContext {
  pmRoot: string;
  settings: Awaited<ReturnType<typeof readSettings>>;
  options: TestAllCommandOptions;
  defaultTimeoutSeconds: number | undefined;
  sourceRoots: { projectPmRoot: string; globalPmRoot: string };
  seenTestKeys: Set<string>;
  effectiveTimeoutByKey: Map<string, number | undefined>;
  trackingEnabled: boolean;
  trackingAuthor: string;
  trackingRunId: string;
  trackingAttempt: number | undefined;
  trackingResumedFrom: string | undefined;
  runStartedAt: string;
}

interface TestAllItemExecution {
  result: TestAllItemResult;
  passed: number;
  failed: number;
  skipped: number;
  trackingWarnings: string[];
  failureCategories: Record<LinkedTestFailureCategory, number>;
}

interface TestAllSelection {
  filteredItems: TestAllSelectedItem[];
  statusFilter: ItemStatus | undefined;
  limitFilter: number | undefined;
  offsetFilter: number;
}

interface TestAllAccumulation {
  results: TestAllItemResult[];
  passed: number;
  failed: number;
  skipped: number;
  failureCategories: Record<LinkedTestFailureCategory, number>;
  trackingWarnings: string[];
}

function parseStatus(raw: string | undefined, statusRegistry: RuntimeStatusRegistry): ItemStatus | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const normalized = normalizeStatusInput(raw, statusRegistry);
  if (!normalized) {
    const allowedStatuses = statusRegistry.definitions.map((definition) => definition.id);
    throw new PmCliError(`Invalid --status value "${raw}". Allowed: ${allowedStatuses.join(", ")}`, EXIT_CODE.USAGE);
  }
  return normalized;
}

function parseTimeout(raw: string | undefined): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  return parseOptionalNumber(raw, "timeout");
}

function parseNonNegativeInteger(raw: string | undefined, flag: string): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new PmCliError(`${flag} must be a non-negative integer`, EXIT_CODE.USAGE);
  }
  return parsed;
}

function formatTrackingError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveTrackedRunId(): string {
  const fromEnv = process.env.PM_BACKGROUND_TEST_RUN_ID?.trim();
  if (fromEnv && fromEnv.length > 0) {
    return fromEnv;
  }
  return `test-all-local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeCommand(command: string): string {
  return command.trim().replaceAll(/\s+/g, " ");
}

function normalizeEnvSetSignature(value: LinkedTest["env_set"]): string {
  if (!value || Object.keys(value).length === 0) {
    return "{}";
  }
  return JSON.stringify(
    Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))),
  );
}

function normalizeEnvClearSignature(value: LinkedTest["env_clear"]): string {
  if (!value || value.length === 0) {
    return "[]";
  }
  return JSON.stringify([...value].sort((left, right) => left.localeCompare(right)));
}

function normalizePmContextModeSignature(value: LinkedTest["pm_context_mode"]): string {
  const normalized = value?.trim().toLowerCase();
  return normalized && normalized.length > 0 ? normalized : "none";
}

function normalizeAssertionSignature(test: LinkedTest): string {
  const normalized = {
    assert_stdout_contains: [...new Set(test.assert_stdout_contains ?? [])].sort((left, right) => left.localeCompare(right)),
    assert_stdout_regex: [...new Set(test.assert_stdout_regex ?? [])].sort((left, right) => left.localeCompare(right)),
    assert_stderr_contains: [...new Set(test.assert_stderr_contains ?? [])].sort((left, right) => left.localeCompare(right)),
    assert_stderr_regex: [...new Set(test.assert_stderr_regex ?? [])].sort((left, right) => left.localeCompare(right)),
    assert_stdout_min_lines: typeof test.assert_stdout_min_lines === "number" ? test.assert_stdout_min_lines : undefined,
    assert_json_field_equals: Object.fromEntries(
      Object.entries(test.assert_json_field_equals ?? {}).sort(([left], [right]) => left.localeCompare(right)),
    ),
    assert_json_field_gte: Object.fromEntries(
      Object.entries(test.assert_json_field_gte ?? {}).sort(([left], [right]) => left.localeCompare(right)),
    ),
  };
  return JSON.stringify(normalized);
}

function buildLinkedTestKey(test: LinkedTest): string {
  const command = test.command?.trim();
  if (command && command.length > 0) {
    const envSet = normalizeEnvSetSignature(test.env_set);
    const envClear = normalizeEnvClearSignature(test.env_clear);
    const pmContextMode = normalizePmContextModeSignature(test.pm_context_mode);
    const sharedHostSafe = test.shared_host_safe === true ? "true" : "false";
    const assertions = normalizeAssertionSignature(test);
    return `command:${test.scope}:${normalizeCommand(command)}:${envSet}:${envClear}:${pmContextMode}:${sharedHostSafe}:${assertions}`;
  }
  const linkedPath = test.path?.trim() ?? "";
  return `path:${test.scope}:${linkedPath}`;
}

function maxTimeoutSeconds(current: number | undefined, candidate: number | undefined): number | undefined {
  if (candidate === undefined) {
    /* c8 ignore next - exercised implicitly by duplicate timeout normalization */
    return current;
  }
  if (current === undefined || candidate > current) {
    return candidate;
  }
  return current;
}

function countStatuses(runResults: TestRunResult[]): { passed: number; failed: number; skipped: number } {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const result of runResults) {
    if (result.status === "passed") {
      passed += 1;
      continue;
    }
    if (result.status === "failed") {
      failed += 1;
      continue;
    }
    skipped += 1;
  }
  return { passed, failed, skipped };
}

function mergeFailureCategoryCounts(
  target: Record<LinkedTestFailureCategory, number>,
  source: Record<LinkedTestFailureCategory, number>,
): void {
  for (const [key, value] of Object.entries(source)) {
    target[key as LinkedTestFailureCategory] += value;
  }
}

function emitTestAllProgress(options: TestAllCommandOptions, message: string): void {
  if (options.progress !== true) {
    return;
  }
  try {
    process.stderr.write(`[pm test-all] ${message}\n`);
  } catch {
    // Ignore transient stderr write failures.
  }
}

async function collectTestAllItemTests(
  filteredItems: TestAllSelectedItem[],
  global: GlobalOptions,
  pmRoot: string,
): Promise<{ itemTests: TestAllItemTests[]; linkedTests: number }> {
  const itemTests: TestAllItemTests[] = [];
  let linkedTests = 0;
  for (const item of filteredItems) {
    const readResult = await runTest(
      item.id,
      { run: false },
      {
        ...global,
        path: pmRoot,
      },
    );
    linkedTests += readResult.tests.length;
    itemTests.push({ item, tests: readResult.tests });
  }
  return { itemTests, linkedTests };
}

async function selectTestAllItems(params: {
  pmRoot: string;
  settings: Awaited<ReturnType<typeof readSettings>>;
  options: TestAllCommandOptions;
}): Promise<TestAllSelection> {
  const statusRegistry = resolveRuntimeStatusRegistry(params.settings.schema);
  const typeRegistry = resolveItemTypeRegistry(params.settings, getActiveExtensionRegistrations());
  const statusFilter = parseStatus(params.options.status, statusRegistry);
  const limitFilter = parseNonNegativeInteger(params.options.limit, "--limit");
  const offsetFilter = parseNonNegativeInteger(params.options.offset, "--offset") ?? 0;
  const allItems = await listAllFrontMatterLight(
    params.pmRoot,
    params.settings.item_format,
    typeRegistry.type_to_folder,
    undefined,
    params.settings.schema,
  );
  const statusFilteredItems = allItems
    .filter((item) => (statusFilter ? item.status === statusFilter : true))
    .sort((a, b) => a.id.localeCompare(b.id));
  const filteredItems =
    limitFilter === undefined
      ? statusFilteredItems.slice(offsetFilter)
      : statusFilteredItems.slice(offsetFilter, offsetFilter + limitFilter);
  return { filteredItems, statusFilter, limitFilter, offsetFilter };
}

function buildEffectiveTimeoutByKey(itemTests: TestAllItemTests[]): Map<string, number | undefined> {
  const effectiveTimeoutByKey = new Map<string, number | undefined>();
  for (const { tests } of itemTests) {
    for (const test of tests) {
      const key = buildLinkedTestKey(test);
      if (!effectiveTimeoutByKey.has(key)) {
        effectiveTimeoutByKey.set(key, test.timeout_seconds);
        continue;
      }
      effectiveTimeoutByKey.set(key, maxTimeoutSeconds(effectiveTimeoutByKey.get(key), test.timeout_seconds));
    }
  }
  return effectiveTimeoutByKey;
}

async function runTestAllItem(
  entry: TestAllItemTests,
  context: TestAllItemRunContext,
): Promise<TestAllItemExecution> {
  const testsToRun: LinkedTest[] = [];
  const keyedTests = entry.tests.map((test) => {
    const key = buildLinkedTestKey(test);
    const duplicate = context.seenTestKeys.has(key);
    if (!duplicate) {
      context.seenTestKeys.add(key);
      const effectiveTimeoutSeconds = context.effectiveTimeoutByKey.get(key);
      testsToRun.push(effectiveTimeoutSeconds === undefined ? test : { ...test, timeout_seconds: effectiveTimeoutSeconds });
    }
    return { test, key, duplicate };
  });

  const executedResults =
    testsToRun.length > 0
      ? await runLinkedTests(testsToRun, context.defaultTimeoutSeconds, {
          progress: context.options.progress,
          sourceRoots: context.sourceRoots,
          envSet: context.options.envSet,
          envClear: context.options.envClear,
          sharedHostSafe: context.options.sharedHostSafe,
          pmContext: context.options.pmContext,
          overrideLinkedPmContext: context.options.overrideLinkedPmContext,
          failOnContextMismatch: context.options.failOnContextMismatch,
          failOnEmptyTestRun: context.options.failOnEmptyTestRun,
          requireAssertionsForPm: context.options.requireAssertionsForPm,
          checkContext: context.options.checkContext,
          autoPmContext: context.options.autoPmContext,
        })
      : [];
  let executedIndex = 0;
  const runResults = keyedTests.map(({ test, key, duplicate }) => {
    if (!duplicate) {
      const executed = executedResults[executedIndex];
      executedIndex += 1;
      return executed;
    }
    return {
      command: test.command,
      path: test.path,
      status: "skipped" as const,
      error: `Duplicate linked test skipped (key=${key}).`,
    };
  });
  const summary = countStatuses(runResults);
  const failureCategories = countFailureCategories(runResults);
  const trackingWarnings = await appendTestAllItemTracking(entry, summary, context);
  return {
    passed: summary.passed,
    failed: summary.failed,
    skipped: summary.skipped,
    trackingWarnings,
    failureCategories,
    result: {
      ok: summary.failed === 0 && !(context.options.failOnSkipped === true && summary.skipped > 0),
      id: entry.item.id,
      status: entry.item.status,
      test_count: entry.tests.length,
      passed: summary.passed,
      failed: summary.failed,
      skipped: summary.skipped,
      run_results: runResults,
      failure_categories: failureCategories,
    },
  };
}

async function appendTestAllItemTracking(
  entry: TestAllItemTests,
  summary: { passed: number; failed: number; skipped: number },
  context: TestAllItemRunContext,
): Promise<string[]> {
  if (!context.trackingEnabled) {
    return [];
  }
  try {
    await appendTrackedTestRunSummary({
      pmRoot: context.pmRoot,
      settings: context.settings,
      itemId: entry.item.id,
      author: context.trackingAuthor,
      message: `Track test-all run summary (${context.trackingRunId})`,
      entry: {
        run_id: context.trackingRunId,
        kind: "test-all",
        status: summary.failed > 0 || (context.options.failOnSkipped === true && summary.skipped > 0) ? "failed" : "passed",
        started_at: context.runStartedAt,
        finished_at: nowIso(),
        recorded_at: nowIso(),
        attempt: context.trackingAttempt,
        resumed_from: context.trackingResumedFrom,
        passed: summary.passed,
        failed: summary.failed,
        skipped: summary.skipped,
        items: 1,
        linked_tests: entry.tests.length,
        fail_on_skipped_triggered: context.options.failOnSkipped === true && summary.skipped > 0 ? true : undefined,
      },
    });
  } catch (error: unknown) {
    return [`test_result_tracking_failed:${entry.item.id}:${formatTrackingError(error)}`];
  }
  return [];
}

function buildTestAllItemRunContext(params: {
  pmRoot: string;
  settings: Awaited<ReturnType<typeof readSettings>>;
  options: TestAllCommandOptions;
  itemTests: TestAllItemTests[];
  defaultTimeoutSeconds: number | undefined;
  runStartedAt: string;
}): TestAllItemRunContext {
  const trackingAttemptRaw = process.env.PM_BACKGROUND_TEST_RUN_ATTEMPT?.trim();
  const trackingParsedAttempt = trackingAttemptRaw ? Number.parseInt(trackingAttemptRaw, 10) : Number.NaN;
  const trackingResumedFrom = process.env.PM_BACKGROUND_TEST_RUN_RESUMED_FROM?.trim();
  return {
    pmRoot: params.pmRoot,
    settings: params.settings,
    options: params.options,
    defaultTimeoutSeconds: params.defaultTimeoutSeconds,
    sourceRoots: {
      projectPmRoot: params.pmRoot,
      globalPmRoot: resolveGlobalPmRoot(process.cwd()),
    },
    seenTestKeys: new Set<string>(),
    effectiveTimeoutByKey: buildEffectiveTimeoutByKey(params.itemTests),
    trackingEnabled: params.settings.testing.record_results_to_items === true,
    trackingAuthor: resolveAuthor(undefined, params.settings.author_default),
    trackingRunId: resolveTrackedRunId(),
    trackingAttempt: Number.isFinite(trackingParsedAttempt) && trackingParsedAttempt >= 1 ? trackingParsedAttempt : undefined,
    trackingResumedFrom: trackingResumedFrom && trackingResumedFrom.length > 0 ? trackingResumedFrom : undefined,
    runStartedAt: params.runStartedAt,
  };
}

function initializeTestAllAccumulation(
  options: TestAllCommandOptions,
  linkedTests: number,
  filteredItems: TestAllSelectedItem[],
): { accumulation: TestAllAccumulation; failOnEmptyTestRunTriggered: boolean } {
  const accumulation: TestAllAccumulation = {
    results: [],
    passed: 0,
    failed: 0,
    skipped: 0,
    failureCategories: countFailureCategories([]),
    trackingWarnings: [],
  };
  const failOnEmptyTestRunTriggered = options.failOnEmptyTestRun === true && linkedTests === 0;
  if (failOnEmptyTestRunTriggered) {
    accumulation.failed += 1;
    accumulation.failureCategories.empty_run += 1;
    accumulation.trackingWarnings.push(
      `empty_linked_test_selection:items=${filteredItems.length};linked_tests=0;fail_on_empty_test_run=true`,
    );
  }
  return { accumulation, failOnEmptyTestRunTriggered };
}

async function runTestAllItems(
  itemTests: TestAllItemTests[],
  context: TestAllItemRunContext,
  accumulation: TestAllAccumulation,
): Promise<void> {
  for (const [itemIndex, entry] of itemTests.entries()) {
    emitTestAllProgress(context.options, `item ${itemIndex + 1}/${itemTests.length} start id=${entry.item.id} linked_tests=${entry.tests.length}`);
    const execution = await runTestAllItem(entry, context);
    mergeFailureCategoryCounts(accumulation.failureCategories, execution.failureCategories);
    accumulation.passed += execution.passed;
    accumulation.failed += execution.failed;
    accumulation.skipped += execution.skipped;
    accumulation.trackingWarnings.push(...execution.trackingWarnings);
    accumulation.results.push(execution.result);
    emitTestAllProgress(
      context.options,
      `item ${itemIndex + 1}/${itemTests.length} end id=${entry.item.id}` +
        ` status=${execution.failed === 0 ? "passed" : "failed"}` +
        ` passed=${execution.passed} failed=${execution.failed} skipped=${execution.skipped}`,
    );
  }
}

function appendContextPreflightWarning(options: TestAllCommandOptions, accumulation: TestAllAccumulation): void {
  if (options.checkContext !== true) {
    return;
  }
  const allRunResults = accumulation.results.flatMap((entry) => entry.run_results);
  const preflight = summarizeContextPreflight(allRunResults);
  accumulation.trackingWarnings.push(
    `context_preflight:checked_pm_commands=${preflight.checked_pm_commands};` +
      `tracker_read_commands=${preflight.tracker_read_commands};` +
      `mismatches=${preflight.mismatches};` +
      `auto_remediated=${preflight.auto_remediated}`,
  );
}

function buildTestAllResult(params: {
  ok: boolean;
  filteredItems: TestAllSelectedItem[];
  linkedTests: number;
  accumulation: TestAllAccumulation;
  failOnSkippedTriggered: boolean;
  failOnEmptyTestRunTriggered: boolean;
}): TestAllResult {
  return {
    ok: params.ok,
    totals: {
      items: params.filteredItems.length,
      linked_tests: params.linkedTests,
      passed: params.accumulation.passed,
      failed: params.accumulation.failed,
      skipped: params.accumulation.skipped,
      failure_categories: params.accumulation.failureCategories,
    },
    failed: params.accumulation.failed,
    passed: params.accumulation.passed,
    skipped: params.accumulation.skipped,
    fail_on_skipped_triggered: params.failOnSkippedTriggered ? true : undefined,
    fail_on_empty_test_run_triggered: params.failOnEmptyTestRunTriggered ? true : undefined,
    warnings: params.accumulation.trackingWarnings.length > 0 ? params.accumulation.trackingWarnings : undefined,
    results: params.accumulation.results,
  };
}

/**
 * Implements run test all for the public runtime surface of this module.
 */
export async function runTestAll(options: TestAllCommandOptions, global: GlobalOptions): Promise<TestAllResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(`Tracker is not initialized at ${pmRoot}. Run pm init first.`, EXIT_CODE.NOT_FOUND);
  }

  const settings = await readSettings(pmRoot);
  const { filteredItems, statusFilter, limitFilter, offsetFilter } = await selectTestAllItems({ pmRoot, settings, options });
  const defaultTimeoutSeconds = parseTimeout(options.timeout);
  const runStartedAt = nowIso();
  const { itemTests, linkedTests } = await collectTestAllItemTests(filteredItems, global, pmRoot);
  emitTestAllProgress(
    options,
    `selection items=${filteredItems.length} linked_tests=${linkedTests}` +
      `${statusFilter ? ` status=${statusFilter}` : ""}` +
      `${limitFilter === undefined ? "" : ` limit=${limitFilter}`}` +
      `${offsetFilter > 0 ? ` offset=${offsetFilter}` : ""}`,
  );

  const { accumulation, failOnEmptyTestRunTriggered } = initializeTestAllAccumulation(options, linkedTests, filteredItems);
  const itemRunContext = buildTestAllItemRunContext({
    pmRoot,
    settings,
    options,
    itemTests,
    defaultTimeoutSeconds,
    runStartedAt,
  });
  await runTestAllItems(itemTests, itemRunContext, accumulation);

  const failOnSkippedTriggered = options.failOnSkipped === true && accumulation.skipped > 0;
  appendContextPreflightWarning(options, accumulation);

  const ok = accumulation.failed === 0 && failOnSkippedTriggered !== true && failOnEmptyTestRunTriggered !== true;
  emitTestAllProgress(
    options,
    `end status=${ok ? "passed" : "failed"} items=${filteredItems.length} linked_tests=${linkedTests}` +
      ` passed=${accumulation.passed} failed=${accumulation.failed} skipped=${accumulation.skipped}`,
  );

  return buildTestAllResult({
    ok,
    filteredItems,
    linkedTests,
    accumulation,
    failOnSkippedTriggered,
    failOnEmptyTestRunTriggered,
  });
}

export const _testOnlyTestAll = {
  formatTrackingError,
};
