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

export async function runTestAll(options: TestAllCommandOptions, global: GlobalOptions): Promise<TestAllResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(`Tracker is not initialized at ${pmRoot}. Run pm init first.`, EXIT_CODE.NOT_FOUND);
  }

  const settings = await readSettings(pmRoot);
  const statusRegistry = resolveRuntimeStatusRegistry(settings.schema);
  const typeRegistry = resolveItemTypeRegistry(settings, getActiveExtensionRegistrations());
  const statusFilter = parseStatus(options.status, statusRegistry);
  const limitFilter = parseNonNegativeInteger(options.limit, "--limit");
  const offsetFilter = parseNonNegativeInteger(options.offset, "--offset") ?? 0;
  const allItems = await listAllFrontMatterLight(pmRoot, settings.item_format, typeRegistry.type_to_folder, undefined, settings.schema);
  const statusFilteredItems = allItems
    .filter((item) => (statusFilter ? item.status === statusFilter : true))
    .sort((a, b) => a.id.localeCompare(b.id));
  const filteredItems =
    limitFilter === undefined
      ? statusFilteredItems.slice(offsetFilter)
      : statusFilteredItems.slice(offsetFilter, offsetFilter + limitFilter);
  const defaultTimeoutSeconds = parseTimeout(options.timeout);
  const sourceRoots = {
    projectPmRoot: pmRoot,
    globalPmRoot: resolveGlobalPmRoot(process.cwd()),
  };
  const runStartedAt = nowIso();
  const trackingEnabled = settings.testing.record_results_to_items === true;
  const trackingRunId = resolveTrackedRunId();
  const trackingAuthor = resolveAuthor(undefined, settings.author_default);
  const trackingAttemptRaw = process.env.PM_BACKGROUND_TEST_RUN_ATTEMPT?.trim();
  const trackingParsedAttempt = trackingAttemptRaw ? Number.parseInt(trackingAttemptRaw, 10) : Number.NaN;
  const trackingResumedFrom = process.env.PM_BACKGROUND_TEST_RUN_RESUMED_FROM?.trim();
  const trackingWarnings: string[] = [];

  const results: TestAllItemResult[] = [];
  const seenTestKeys = new Set<string>();
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let linkedTests = 0;
  const failureCategories = countFailureCategories([]);
  const itemTests: Array<{ item: (typeof filteredItems)[number]; tests: LinkedTest[] }> = [];

  for (const item of filteredItems) {
    const readResult = await runTest(
      item.id,
      {
        run: false,
      },
      {
        ...global,
        path: pmRoot,
      },
    );

    linkedTests += readResult.tests.length;
    itemTests.push({ item, tests: readResult.tests });
  }

  const failOnEmptyTestRunTriggered = options.failOnEmptyTestRun === true && linkedTests === 0;
  if (failOnEmptyTestRunTriggered) {
    failed += 1;
    failureCategories.empty_run += 1;
    trackingWarnings.push(
      `empty_linked_test_selection:items=${filteredItems.length};linked_tests=0;fail_on_empty_test_run=true`,
    );
  }

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

  for (const { item, tests } of itemTests) {
    const testsToRun: LinkedTest[] = [];
    const keyedTests = tests.map((test) => {
      const key = buildLinkedTestKey(test);
      const duplicate = seenTestKeys.has(key);
      if (!duplicate) {
        seenTestKeys.add(key);
        const effectiveTimeoutSeconds = effectiveTimeoutByKey.get(key);
        testsToRun.push(
          effectiveTimeoutSeconds === undefined ? test : { ...test, timeout_seconds: effectiveTimeoutSeconds },
        );
      }
      return { test, key, duplicate };
    });

    const executedResults =
      testsToRun.length > 0
        ? await runLinkedTests(testsToRun, defaultTimeoutSeconds, {
            progress: options.progress,
            sourceRoots,
            envSet: options.envSet,
            envClear: options.envClear,
            sharedHostSafe: options.sharedHostSafe,
            pmContext: options.pmContext,
            overrideLinkedPmContext: options.overrideLinkedPmContext,
            failOnContextMismatch: options.failOnContextMismatch,
            failOnEmptyTestRun: options.failOnEmptyTestRun,
            requireAssertionsForPm: options.requireAssertionsForPm,
            checkContext: options.checkContext,
            autoPmContext: options.autoPmContext,
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
    const itemFailureCategories = countFailureCategories(runResults);
    mergeFailureCategoryCounts(failureCategories, itemFailureCategories);
    passed += summary.passed;
    failed += summary.failed;
    skipped += summary.skipped;
    if (trackingEnabled) {
      try {
        await appendTrackedTestRunSummary({
          pmRoot,
          settings,
          itemId: item.id,
          author: trackingAuthor,
          message: `Track test-all run summary (${trackingRunId})`,
          entry: {
            run_id: trackingRunId,
            kind: "test-all",
            status: summary.failed > 0 || (options.failOnSkipped === true && summary.skipped > 0) ? "failed" : "passed",
            started_at: runStartedAt,
            finished_at: nowIso(),
            recorded_at: nowIso(),
            attempt: Number.isFinite(trackingParsedAttempt) && trackingParsedAttempt >= 1 ? trackingParsedAttempt : undefined,
            resumed_from: trackingResumedFrom && trackingResumedFrom.length > 0 ? trackingResumedFrom : undefined,
            passed: summary.passed,
            failed: summary.failed,
            skipped: summary.skipped,
            items: 1,
            linked_tests: tests.length,
            fail_on_skipped_triggered: options.failOnSkipped === true && summary.skipped > 0 ? true : undefined,
          },
        });
      } catch (error: unknown) {
        trackingWarnings.push(`test_result_tracking_failed:${item.id}:${formatTrackingError(error)}`);
      }
    }
    results.push({
      ok: summary.failed === 0 && !(options.failOnSkipped === true && summary.skipped > 0),
      id: item.id,
      status: item.status,
      test_count: tests.length,
      passed: summary.passed,
      failed: summary.failed,
      skipped: summary.skipped,
      run_results: runResults,
      failure_categories: itemFailureCategories,
    });
  }

  const failOnSkippedTriggered = options.failOnSkipped === true && skipped > 0;
  if (options.checkContext === true) {
    const allRunResults = results.flatMap((entry) => entry.run_results);
    const preflight = summarizeContextPreflight(allRunResults);
    trackingWarnings.push(
      `context_preflight:checked_pm_commands=${preflight.checked_pm_commands};` +
        `tracker_read_commands=${preflight.tracker_read_commands};` +
        `mismatches=${preflight.mismatches};` +
        `auto_remediated=${preflight.auto_remediated}`,
    );
  }

  return {
    ok: failed === 0 && failOnSkippedTriggered !== true && failOnEmptyTestRunTriggered !== true,
    totals: {
      items: filteredItems.length,
      linked_tests: linkedTests,
      passed,
      failed,
      skipped,
      failure_categories: failureCategories,
    },
    failed,
    passed,
    skipped,
    fail_on_skipped_triggered: failOnSkippedTriggered ? true : undefined,
    fail_on_empty_test_run_triggered: failOnEmptyTestRunTriggered ? true : undefined,
    warnings: trackingWarnings.length > 0 ? trackingWarnings : undefined,
    results,
  };
}

export const _testOnlyTestAll = {
  formatTrackingError,
};
