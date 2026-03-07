import { pathExists } from "../../core/fs/fs-utils.js";
import { parseOptionalNumber } from "../../core/item/parse.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { listAllFrontMatter } from "../../core/store/item-store.js";
import { getSettingsPath, resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import { STATUS_VALUES } from "../../types/index.js";
import type { ItemStatus, LinkedTest } from "../../types/index.js";
import { runLinkedTests, runTest, type TestRunResult } from "./test.js";

export interface TestAllCommandOptions {
  status?: string;
  timeout?: string;
}

export interface TestAllItemResult {
  id: string;
  status: ItemStatus;
  test_count: number;
  passed: number;
  failed: number;
  skipped: number;
  run_results: TestRunResult[];
}

export interface TestAllResult {
  totals: {
    items: number;
    linked_tests: number;
    passed: number;
    failed: number;
    skipped: number;
  };
  failed: number;
  passed: number;
  skipped: number;
  results: TestAllItemResult[];
}

function parseStatus(raw: string | undefined): ItemStatus | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!STATUS_VALUES.includes(raw as ItemStatus)) {
    throw new PmCliError(`Invalid --status value "${raw}"`, EXIT_CODE.USAGE);
  }
  return raw as ItemStatus;
}

function parseTimeout(raw: string | undefined): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  return parseOptionalNumber(raw, "timeout");
}

function normalizeCommand(command: string): string {
  return command.trim().replaceAll(/\s+/g, " ");
}

function buildLinkedTestKey(test: LinkedTest): string {
  const command = test.command?.trim();
  if (command && command.length > 0) {
    return `command:${test.scope}:${normalizeCommand(command)}`;
  }
  const linkedPath = test.path?.trim() ?? "";
  return `path:${test.scope}:${linkedPath}`;
}

function maxTimeoutSeconds(current: number | undefined, candidate: number | undefined): number | undefined {
  if (candidate === undefined) {
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

export async function runTestAll(options: TestAllCommandOptions, global: GlobalOptions): Promise<TestAllResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(`Tracker is not initialized at ${pmRoot}. Run pm init first.`, EXIT_CODE.NOT_FOUND);
  }

  await readSettings(pmRoot);
  const statusFilter = parseStatus(options.status);
  const allItems = await listAllFrontMatter(pmRoot);
  const filteredItems = allItems
    .filter((item) => (statusFilter ? item.status === statusFilter : true))
    .sort((a, b) => a.id.localeCompare(b.id));
  const defaultTimeoutSeconds = parseTimeout(options.timeout);

  const results: TestAllItemResult[] = [];
  const seenTestKeys = new Set<string>();
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let linkedTests = 0;
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

    const executedResults = testsToRun.length > 0 ? await runLinkedTests(testsToRun, defaultTimeoutSeconds) : [];
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
    passed += summary.passed;
    failed += summary.failed;
    skipped += summary.skipped;
    results.push({
      id: item.id,
      status: item.status,
      test_count: tests.length,
      passed: summary.passed,
      failed: summary.failed,
      skipped: summary.skipped,
      run_results: runResults,
    });
  }

  return {
    totals: {
      items: filteredItems.length,
      linked_tests: linkedTests,
      passed,
      failed,
      skipped,
    },
    failed,
    passed,
    skipped,
    results,
  };
}
