/**
 * @module sdk/test/batch
 *
 * Implements the pm test all command surface and its agent-facing runtime behavior.
 */
import { pathExists } from "../../core/fs/fs-utils.js";
import { getActiveExtensionRegistrations } from "../../core/extensions/index.js";
import { resolveItemTypeRegistry } from "../../core/item/type-registry.js";
import { parseOptionalNumber } from "../../core/item/parse.js";
import { normalizeStatusInput } from "../../core/item/status.js";
import {
  resolveRuntimeStatusRegistry,
  type RuntimeStatusRegistry,
} from "../../core/schema/runtime-schema.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { nowIso } from "../../core/shared/time.js";
import { listAllItemMetadataLight } from "../../core/store/item-store.js";
import {
  getSettingsPath,
  resolveGlobalPmRoot,
  resolvePmRoot,
} from "../../core/store/paths.js";
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
} from "./execution.js";

/** Documents the test all command options payload exchanged by command, SDK, and package integrations. */
export interface TestAllCommandOptions {
  /** Explicit author recorded on item test-run tracking events. */
  author?: string;
  /** Lifecycle state reported for status. */
  status?: string;
  /** Value that configures or reports limit for this contract. */
  limit?: string;
  /** Value that configures or reports offset for this contract. */
  offset?: string;
  /** Value that configures or reports timeout for this contract. */
  timeout?: string;
  /** Value that configures or reports progress for this contract. */
  progress?: boolean;
  /** Value that configures or reports env set for this contract. */
  envSet?: string[];
  /** Value that configures or reports env clear for this contract. */
  envClear?: string[];
  /** Value that configures or reports shared host safe for this contract. */
  sharedHostSafe?: boolean;
  /** Value that configures or reports pm context for this contract. */
  pmContext?: string;
  /** Value that configures or reports override linked pm context for this contract. */
  overrideLinkedPmContext?: boolean;
  /** Value that configures or reports fail on context mismatch for this contract. */
  failOnContextMismatch?: boolean;
  /** Value that configures or reports fail on skipped for this contract. */
  failOnSkipped?: boolean;
  /** Value that configures or reports fail on empty test run for this contract. */
  failOnEmptyTestRun?: boolean;
  /** Value that configures or reports require assertions for pm for this contract. */
  requireAssertionsForPm?: boolean;
  /** Value that configures or reports check context for this contract. */
  checkContext?: boolean;
  /** Value that configures or reports auto pm context for this contract. */
  autoPmContext?: boolean;
}

/** Documents the test all item result payload exchanged by command, SDK, and package integrations. */
export interface TestAllItemResult {
  /** Whether the operation completed without a blocking failure. */
  ok: boolean;
  /** Stable identifier used to reference this record across commands and storage. */
  id: string;
  /** Lifecycle state reported for status. */
  status: ItemStatus;
  /** Number of test entries represented by this result. */
  test_count: number;
  /** Value that configures or reports passed for this contract. */
  passed: number;
  /** Value that configures or reports failed for this contract. */
  failed: number;
  /** Value that configures or reports skipped for this contract. */
  skipped: number;
  /** Executes the results operation through the package runtime. */
  run_results: TestRunResult[];
  /** Value that configures or reports failure categories for this contract. */
  failure_categories: Record<LinkedTestFailureCategory, number>;
}

/** Documents the test all result payload exchanged by command, SDK, and package integrations. */
export interface TestAllResult {
  /** Whether the operation completed without a blocking failure. */
  ok: boolean;
  /** Value that configures or reports totals for this contract. */
  totals: {
    items: number;
    linked_tests: number;
    passed: number;
    failed: number;
    skipped: number;
    failure_categories: Record<LinkedTestFailureCategory, number>;
  };
  /** Value that configures or reports failed for this contract. */
  failed: number;
  /** Value that configures or reports passed for this contract. */
  passed: number;
  /** Value that configures or reports skipped for this contract. */
  skipped: number;
  /** Value that configures or reports fail on skipped triggered for this contract. */
  fail_on_skipped_triggered?: boolean;
  /** Value that configures or reports fail on empty test run triggered for this contract. */
  fail_on_empty_test_run_triggered?: boolean;
  /** Value that configures or reports warnings for this contract. */
  warnings?: string[];
  /** Value that configures or reports results for this contract. */
  results: TestAllItemResult[];
}

type TestAllSelectedItem = Awaited<
  ReturnType<typeof listAllItemMetadataLight>
>[number];

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

const parseStatus = (
  raw: string | undefined,
  statusRegistry: RuntimeStatusRegistry,
): ItemStatus | undefined => {
  if (raw === undefined) {
    return undefined;
  }
  const normalized = normalizeStatusInput(raw, statusRegistry);
  if (!normalized) {
    const allowedStatuses = statusRegistry.definitions.map(
      (definition) => definition.id,
    );
    throw new PmCliError(
      `Invalid --status value "${raw}". Allowed: ${allowedStatuses.join(", ")}`,
      EXIT_CODE.USAGE,
    );
  }
  return normalized;
};

const parseTimeout = (raw: string | undefined): number | undefined => {
  if (raw === undefined) {
    return undefined;
  }
  const parsed = parseOptionalNumber(raw, "timeout");
  if (parsed <= 0) {
    throw new PmCliError("timeout must be a positive number", EXIT_CODE.USAGE);
  }
  return parsed;
};

const parseNonNegativeInteger = (
  raw: string | undefined,
  flag: string,
): number | undefined => {
  if (raw === undefined) {
    return undefined;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new PmCliError(
      `${flag} must be a non-negative integer`,
      EXIT_CODE.USAGE,
    );
  }
  return parsed;
};

const formatTrackingError = (error: unknown): string => {
  return error instanceof Error ? error.message : String(error);
};

const resolveTrackedRunId = (): string => {
  const fromEnv = process.env.PM_BACKGROUND_TEST_RUN_ID?.trim();
  if (fromEnv && fromEnv.length > 0) {
    return fromEnv;
  }
  return `test-all-local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
};

const normalizeCommand = (command: string): string => {
  return command.trim().replaceAll(/\s+/g, " ");
};

const normalizeEnvSetSignature = (value: LinkedTest["env_set"]): string => {
  if (!value || Object.keys(value).length === 0) {
    return "{}";
  }
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(value).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
  );
};

const normalizeEnvClearSignature = (value: LinkedTest["env_clear"]): string => {
  if (!value || value.length === 0) {
    return "[]";
  }
  return JSON.stringify(
    [...value].sort((left, right) => left.localeCompare(right)),
  );
};

const normalizePmContextModeSignature = (
  value: LinkedTest["pm_context_mode"],
): string => {
  const normalized = value?.trim().toLowerCase();
  return normalized && normalized.length > 0 ? normalized : "none";
};

/** Sorts and deduplicates optional assertion string lists. */
const normalizeAssertionStrings = (values: string[] | undefined): string[] =>
  [...new Set(values ?? [])].sort((left, right) => left.localeCompare(right));

/** Sorts optional assertion maps into deterministic key order. */
const normalizeAssertionMap = <Value>(
  value: Record<string, Value> | undefined,
): Record<string, Value> =>
  Object.fromEntries(
    Object.entries(value ?? {}).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );

/** Keeps a numeric assertion threshold while omitting other runtime shapes. */
const normalizeAssertionLineCount = (value: unknown): number | undefined =>
  typeof value === "number" ? value : undefined;

const normalizeAssertionSignature = (test: LinkedTest): string => {
  const normalized = {
    assert_stdout_contains: normalizeAssertionStrings(
      test.assert_stdout_contains,
    ),
    assert_stdout_regex: normalizeAssertionStrings(test.assert_stdout_regex),
    assert_stderr_contains: normalizeAssertionStrings(
      test.assert_stderr_contains,
    ),
    assert_stderr_regex: normalizeAssertionStrings(test.assert_stderr_regex),
    assert_stdout_min_lines: normalizeAssertionLineCount(
      test.assert_stdout_min_lines,
    ),
    assert_json_field_equals: normalizeAssertionMap(
      test.assert_json_field_equals,
    ),
    assert_json_field_gte: normalizeAssertionMap(test.assert_json_field_gte),
  };
  return JSON.stringify(normalized);
};

/** Resolves a linked test's command-or-path identity segment. */
const resolveLinkedTestTargetSignature = (test: LinkedTest): string => {
  const command = resolveOptionalEnvironmentValue(test.command);
  if (command !== undefined) {
    return `command:${test.scope}:${normalizeCommand(command)}`;
  }
  return `path:${test.scope}:${resolveOptionalEnvironmentValue(test.path) ?? ""}`;
};

const buildLinkedTestKey = (test: LinkedTest): string => {
  const envSet = normalizeEnvSetSignature(test.env_set);
  const envClear = normalizeEnvClearSignature(test.env_clear);
  const pmContextMode = normalizePmContextModeSignature(test.pm_context_mode);
  const sharedHostSafe = test.shared_host_safe === true ? "true" : "false";
  const assertions = normalizeAssertionSignature(test);
  return `${resolveLinkedTestTargetSignature(test)}:${envSet}:${envClear}:${pmContextMode}:${sharedHostSafe}:${assertions}`;
};

const maxTimeoutSeconds = (
  current: number | undefined,
  candidate: number | undefined,
): number | undefined => {
  if (candidate === undefined) {
    /* c8 ignore next - exercised implicitly by duplicate timeout normalization */
    return current;
  }
  if (current === undefined || candidate > current) {
    return candidate;
  }
  return current;
};

const countStatuses = (
  runResults: TestRunResult[],
): {
  passed: number;
  failed: number;
  skipped: number;
} => {
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
};

const mergeFailureCategoryCounts = (
  target: Record<LinkedTestFailureCategory, number>,
  source: Record<LinkedTestFailureCategory, number>,
): void => {
  for (const [key, value] of Object.entries(source)) {
    target[key as LinkedTestFailureCategory] += value;
  }
};

const emitTestAllProgress = (
  options: TestAllCommandOptions,
  message: string,
): void => {
  if (options.progress !== true) {
    return;
  }
  try {
    process.stderr.write(`[pm test-all] ${message}\n`);
  } catch {
    // Ignore transient stderr write failures.
  }
};

const collectTestAllItemTests = async (
  filteredItems: TestAllSelectedItem[],
  global: GlobalOptions,
  pmRoot: string,
): Promise<{ itemTests: TestAllItemTests[]; linkedTests: number }> => {
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
};

const selectTestAllItems = async (params: {
  pmRoot: string;
  settings: Awaited<ReturnType<typeof readSettings>>;
  options: TestAllCommandOptions;
}): Promise<TestAllSelection> => {
  const statusRegistry = resolveRuntimeStatusRegistry(params.settings.schema);
  const typeRegistry = resolveItemTypeRegistry(
    params.settings,
    getActiveExtensionRegistrations(),
  );
  const statusFilter = parseStatus(params.options.status, statusRegistry);
  const limitFilter = parseNonNegativeInteger(params.options.limit, "--limit");
  const offsetFilter =
    parseNonNegativeInteger(params.options.offset, "--offset") ?? 0;
  const allItems = await listAllItemMetadataLight(
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
};

const buildEffectiveTimeoutByKey = (
  itemTests: TestAllItemTests[],
): Map<string, number | undefined> => {
  const effectiveTimeoutByKey = new Map<string, number | undefined>();
  for (const { tests } of itemTests) {
    for (const test of tests) {
      const key = buildLinkedTestKey(test);
      if (!effectiveTimeoutByKey.has(key)) {
        effectiveTimeoutByKey.set(key, test.timeout_seconds);
        continue;
      }
      effectiveTimeoutByKey.set(
        key,
        maxTimeoutSeconds(effectiveTimeoutByKey.get(key), test.timeout_seconds),
      );
    }
  }
  return effectiveTimeoutByKey;
};

const runTestAllItem = async (
  entry: TestAllItemTests,
  context: TestAllItemRunContext,
): Promise<TestAllItemExecution> => {
  const testsToRun: LinkedTest[] = [];
  const keyedTests = entry.tests.map((test) => {
    const key = buildLinkedTestKey(test);
    const duplicate = context.seenTestKeys.has(key);
    if (!duplicate) {
      context.seenTestKeys.add(key);
      const effectiveTimeoutSeconds = context.effectiveTimeoutByKey.get(key);
      testsToRun.push(
        effectiveTimeoutSeconds === undefined
          ? test
          : { ...test, timeout_seconds: effectiveTimeoutSeconds },
      );
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
  const trackingWarnings = await appendTestAllItemTracking(
    entry,
    summary,
    context,
  );
  return {
    passed: summary.passed,
    failed: summary.failed,
    skipped: summary.skipped,
    trackingWarnings,
    failureCategories,
    result: {
      ok:
        summary.failed === 0 &&
        !(context.options.failOnSkipped === true && summary.skipped > 0),
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
};

/** Resolves whether skip policy makes a tracked item run fail. */
const trackedRunFailed = (
  summary: { passed: number; failed: number; skipped: number },
  options: TestAllCommandOptions,
): boolean =>
  [
    summary.failed > 0,
    options.failOnSkipped === true && summary.skipped > 0,
  ].includes(true);

/** Projects true flags while keeping false values absent from persisted rows. */
const optionalTrue = (value: boolean): true | undefined =>
  value ? true : undefined;

const appendTestAllItemTracking = async (
  entry: TestAllItemTests,
  summary: { passed: number; failed: number; skipped: number },
  context: TestAllItemRunContext,
): Promise<string[]> => {
  if (!context.trackingEnabled) {
    return [];
  }
  try {
    const failed = trackedRunFailed(summary, context.options);
    await appendTrackedTestRunSummary({
      pmRoot: context.pmRoot,
      settings: context.settings,
      itemId: entry.item.id,
      author: context.trackingAuthor,
      message: `Track test-all run summary (${context.trackingRunId})`,
      entry: {
        run_id: context.trackingRunId,
        kind: "test-all",
        status: failed ? "failed" : "passed",
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
        fail_on_skipped_triggered: optionalTrue(
          context.options.failOnSkipped === true && summary.skipped > 0,
        ),
      },
    });
  } catch (error: unknown) {
    return [
      `test_result_tracking_failed:${entry.item.id}:${formatTrackingError(error)}`,
    ];
  }
  return [];
};

/** Parses the optional background-attempt environment contract. */
const resolveTrackingAttempt = (): number | undefined => {
  const raw = process.env.PM_BACKGROUND_TEST_RUN_ATTEMPT?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : undefined;
};

/** Normalizes an optional non-blank environment value. */
const resolveOptionalEnvironmentValue = (
  value: string | undefined,
): string | undefined => {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
};

const buildTestAllItemRunContext = (params: {
  pmRoot: string;
  settings: Awaited<ReturnType<typeof readSettings>>;
  options: TestAllCommandOptions;
  itemTests: TestAllItemTests[];
  defaultTimeoutSeconds: number | undefined;
  runStartedAt: string;
}): TestAllItemRunContext => {
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
    trackingAuthor: resolveAuthor(
      params.options.author,
      params.settings.author_default,
    ),
    trackingRunId: resolveTrackedRunId(),
    trackingAttempt: resolveTrackingAttempt(),
    trackingResumedFrom: resolveOptionalEnvironmentValue(
      process.env.PM_BACKGROUND_TEST_RUN_RESUMED_FROM,
    ),
    runStartedAt: params.runStartedAt,
  };
};

const initializeTestAllAccumulation = (
  options: TestAllCommandOptions,
  linkedTests: number,
  filteredItems: TestAllSelectedItem[],
): {
  accumulation: TestAllAccumulation;
  failOnEmptyTestRunTriggered: boolean;
} => {
  const accumulation: TestAllAccumulation = {
    results: [],
    passed: 0,
    failed: 0,
    skipped: 0,
    failureCategories: countFailureCategories([]),
    trackingWarnings: [],
  };
  const failOnEmptyTestRunTriggered =
    options.failOnEmptyTestRun === true && linkedTests === 0;
  if (failOnEmptyTestRunTriggered) {
    accumulation.failed += 1;
    accumulation.failureCategories.empty_run += 1;
    accumulation.trackingWarnings.push(
      `empty_linked_test_selection:items=${filteredItems.length};linked_tests=0;fail_on_empty_test_run=true`,
    );
  }
  return { accumulation, failOnEmptyTestRunTriggered };
};

const runTestAllItems = async (
  itemTests: TestAllItemTests[],
  context: TestAllItemRunContext,
  accumulation: TestAllAccumulation,
): Promise<void> => {
  for (const [itemIndex, entry] of itemTests.entries()) {
    emitTestAllProgress(
      context.options,
      `item ${itemIndex + 1}/${itemTests.length} start id=${entry.item.id} linked_tests=${entry.tests.length}`,
    );
    const execution = await runTestAllItem(entry, context);
    mergeFailureCategoryCounts(
      accumulation.failureCategories,
      execution.failureCategories,
    );
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
};

const appendContextPreflightWarning = (
  options: TestAllCommandOptions,
  accumulation: TestAllAccumulation,
): void => {
  if (options.checkContext !== true) {
    return;
  }
  const allRunResults = accumulation.results.flatMap(
    (entry) => entry.run_results,
  );
  const preflight = summarizeContextPreflight(allRunResults);
  accumulation.trackingWarnings.push(
    `context_preflight:checked_pm_commands=${preflight.checked_pm_commands};` +
      `tracker_read_commands=${preflight.tracker_read_commands};` +
      `mismatches=${preflight.mismatches};` +
      `auto_remediated=${preflight.auto_remediated}`,
  );
};

const buildTestAllResult = (params: {
  ok: boolean;
  filteredItems: TestAllSelectedItem[];
  linkedTests: number;
  accumulation: TestAllAccumulation;
  failOnSkippedTriggered: boolean;
  failOnEmptyTestRunTriggered: boolean;
}): TestAllResult => {
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
    fail_on_empty_test_run_triggered: params.failOnEmptyTestRunTriggered
      ? true
      : undefined,
    warnings:
      params.accumulation.trackingWarnings.length > 0
        ? params.accumulation.trackingWarnings
        : undefined,
    results: params.accumulation.results,
  };
};

interface PreparedTestAllRun {
  pmRoot: string;
  settings: Awaited<ReturnType<typeof readSettings>>;
  filteredItems: TestAllSelectedItem[];
  itemTests: TestAllItemTests[];
  linkedTests: number;
  defaultTimeoutSeconds: number | undefined;
  runStartedAt: string;
}

/** Formats the selected test-all window without branching command execution. */
const buildTestAllSelectionProgress = (params: {
  filteredItems: TestAllSelectedItem[];
  linkedTests: number;
  statusFilter: ItemStatus | undefined;
  limitFilter: number | undefined;
  offsetFilter: number;
}): string =>
  [
    `selection items=${params.filteredItems.length}`,
    `linked_tests=${params.linkedTests}`,
    params.statusFilter === undefined ? "" : `status=${params.statusFilter}`,
    params.limitFilter === undefined ? "" : `limit=${params.limitFilter}`,
    params.offsetFilter > 0 ? `offset=${params.offsetFilter}` : "",
  ]
    .filter((entry) => entry.length > 0)
    .join(" ");

/** Loads the tracker selection and linked tests for one test-all run. */
const prepareTestAllRun = async (
  options: TestAllCommandOptions,
  global: GlobalOptions,
): Promise<PreparedTestAllRun> => {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(
      `Tracker is not initialized at ${pmRoot}. Run pm init first.`,
      EXIT_CODE.NOT_FOUND,
    );
  }
  const settings = await readSettings(pmRoot);
  const selection = await selectTestAllItems({ pmRoot, settings, options });
  const defaultTimeoutSeconds = parseTimeout(options.timeout);
  const runStartedAt = nowIso();
  const collected = await collectTestAllItemTests(
    selection.filteredItems,
    global,
    pmRoot,
  );
  emitTestAllProgress(
    options,
    buildTestAllSelectionProgress({
      ...selection,
      linkedTests: collected.linkedTests,
    }),
  );
  return {
    pmRoot,
    settings,
    filteredItems: selection.filteredItems,
    itemTests: collected.itemTests,
    linkedTests: collected.linkedTests,
    defaultTimeoutSeconds,
    runStartedAt,
  };
};

/** Resolves aggregate strict-policy state after every item has run. */
const resolveTestAllOutcome = (params: {
  options: TestAllCommandOptions;
  accumulation: TestAllAccumulation;
  failOnEmptyTestRunTriggered: boolean;
}): { failOnSkippedTriggered: boolean; ok: boolean } => {
  const failOnSkippedTriggered =
    params.options.failOnSkipped === true && params.accumulation.skipped > 0;
  const ok = ![
    params.accumulation.failed > 0,
    failOnSkippedTriggered,
    params.failOnEmptyTestRunTriggered,
  ].includes(true);
  return { failOnSkippedTriggered, ok };
};

/** Implements run test all for the public runtime surface of this module. */
export const runTestAll = async (
  options: TestAllCommandOptions,
  global: GlobalOptions,
): Promise<TestAllResult> => {
  const prepared = await prepareTestAllRun(options, global);
  const { accumulation, failOnEmptyTestRunTriggered } =
    initializeTestAllAccumulation(
      options,
      prepared.linkedTests,
      prepared.filteredItems,
    );
  const itemRunContext = buildTestAllItemRunContext({
    pmRoot: prepared.pmRoot,
    settings: prepared.settings,
    options,
    itemTests: prepared.itemTests,
    defaultTimeoutSeconds: prepared.defaultTimeoutSeconds,
    runStartedAt: prepared.runStartedAt,
  });
  await runTestAllItems(prepared.itemTests, itemRunContext, accumulation);
  appendContextPreflightWarning(options, accumulation);
  const outcome = resolveTestAllOutcome({
    options,
    accumulation,
    failOnEmptyTestRunTriggered,
  });
  emitTestAllProgress(
    options,
    `end status=${outcome.ok ? "passed" : "failed"} items=${prepared.filteredItems.length} linked_tests=${prepared.linkedTests}` +
      ` passed=${accumulation.passed} failed=${accumulation.failed} skipped=${accumulation.skipped}`,
  );

  return buildTestAllResult({
    ok: outcome.ok,
    filteredItems: prepared.filteredItems,
    linkedTests: prepared.linkedTests,
    accumulation,
    failOnSkippedTriggered: outcome.failOnSkippedTriggered,
    failOnEmptyTestRunTriggered,
  });
};

/** Public contract for test only test all, shared by SDK and presentation-layer consumers. */
export const _testOnlyTestAll = {
  buildLinkedTestKey,
  formatTrackingError,
};
