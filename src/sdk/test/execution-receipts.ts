/**
 * @module sdk/test/execution-receipts
 *
 * Recognizes runner execution summaries independently of process orchestration.
 * Explicit empty summaries remain authoritative; positive receipts retain the
 * output stream that supplied evidence for a filtered linked-test selection.
 */
import { renderPmCommand } from "../command-line.js";

const EMPTY_LINKED_TEST_RUN_PATTERNS: Array<{ code: string; regex: RegExp }> = [
  {
    code: "no_projects_matched_filters",
    regex: /\bNo projects matched the filters\b/i,
  },
  { code: "no_test_files_found", regex: /\bNo test files found\b/i },
  { code: "no_tests_found", regex: /\bNo tests found\b/i },
  { code: "no_matching_tests", regex: /\bNo matching tests?\b/i },
  { code: "collected_zero_items", regex: /\bcollected 0 items?\b/i },
  {
    code: "reported_zero_tests",
    regex: /^\s*Ran 0 tests? across \d+ files?\./imu,
  },
  {
    code: "reported_zero_passes",
    regex:
      /(?:^\s*(?:#|ℹ)?\s*tests\s+0\s*$[\s\S]*^\s*(?:#|ℹ)?\s*pass\s+0\s*$|^\s*(?:#|ℹ)?\s*pass\s+0\s*$[\s\S]*^\s*(?:#|ℹ)?\s*tests\s+0\s*$)/imu,
  },
  {
    code: "reported_zero_tests",
    regex: /^\s*(?:#|ℹ)?\s*tests\s+0\s*$/imu,
  },
];

const POSITIVE_LINKED_TEST_RUN_PATTERNS = [
  {
    receiptCode: "reported_tests",
    regex: /^\s*(?:#|ℹ)?\s*tests\s+[1-9]\d*\s*$/imu,
  },
  {
    receiptCode: "reported_passes",
    regex: /^\s*(?:#|ℹ)?\s*pass\s+[1-9]\d*\s*$/imu,
  },
  { receiptCode: "tests_passed", regex: /\bTests?\s+[1-9]\d*\s+passed\b/iu },
  { receiptCode: "passed_count", regex: /\b[1-9]\d*\s+passed\b/iu },
  {
    receiptCode: "tests_summary",
    regex: /\bTests:\s+(?:.*\b)?[1-9]\d*\s+passed\b/iu,
  },
  { receiptCode: "bun_pass_count", regex: /^\s*[1-9]\d* pass\s*$/imu },
  {
    receiptCode: "bun_executed_tests",
    regex: /^\s*Ran [1-9]\d* tests? across \d+ files?\./imu,
  },
];

/** Detect explicit empty-run summaries even when another output line reports a positive count. */
export function detectEmptyLinkedTestRun(
  stdout: string,
  stderr: string,
): { code: string } | null {
  const combined = `${stdout}\n${stderr}`;
  for (const pattern of EMPTY_LINKED_TEST_RUN_PATTERNS) {
    if (pattern.regex.test(combined)) {
      return { code: pattern.code };
    }
  }
  return null;
}

/** Find the first supported positive execution summary, preferring stdout over stderr. */
export function findLinkedTestExecutionReceipt(
  stdout: string,
  stderr: string,
): { code: string; stream: "stdout" | "stderr" } | undefined {
  for (const [stream, output] of [
    ["stdout", stdout],
    ["stderr", stderr],
  ] as const) {
    const matched = POSITIVE_LINKED_TEST_RUN_PATTERNS.find((pattern) =>
      pattern.regex.test(output),
    );
    if (matched) return { code: matched.receiptCode, stream };
  }
  return undefined;
}

/** Invocation scope a narrowed `pm test` receipt must carry into its restore command. */
export interface LinkedTestRestoreScope {
  /** Tracker the invocation selected explicitly (`--pm-path` or `PM_PATH`), if any. */
  trackerPath?: string;
  /** True when the invocation suppressed extensions, so the restore command must too. */
  noExtensions?: boolean;
  /** Shell dialect to quote for; defaults to the current platform. */
  platform?: NodeJS.Platform;
}

/**
 * Derive the restore scope of an invocation. A tracker chosen through
 * `PM_PATH` has no `--path` flag, so its resolved root is kept explicitly;
 * a tracker found by discovery stays implicit, as the next shell finds it too.
 */
export function resolveLinkedTestRestoreScope(
  global: { path?: string; noExtensions?: boolean },
  pmRoot: string,
): LinkedTestRestoreScope {
  // Same precedence as resolvePmRoot: a blank --path falls through to PM_PATH.
  const trackerPath =
    global.path?.trim() || (process.env.PM_PATH?.trim() ? pmRoot : undefined);
  return { trackerPath, noExtensions: global.noExtensions };
}

/**
 * Render the command that lists every linked test of an item on the same
 * tracker and extension scope as the narrowed invocation. Each argument is
 * quoted for the platform shell, so a copied tracker path never expands `$`
 * or command substitutions.
 */
export function renderLinkedTestRestoreCommand(
  itemId: string,
  scope: LinkedTestRestoreScope = {},
): string {
  const trackerPath = scope.trackerPath?.trim();
  return renderPmCommand(
    [
      "test",
      itemId,
      "--list",
      ...(scope.noExtensions === true ? ["--no-extensions"] : []),
      ...(trackerPath ? ["--pm-path", trackerPath] : []),
    ],
    scope.platform,
  );
}
