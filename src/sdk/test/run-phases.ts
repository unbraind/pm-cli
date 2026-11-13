/**
 * @module sdk/test/run-phases
 *
 * Linked-test run phases and outcome accounting. An entry declared with
 * `phase=setup` (GH-1671) runs before the item's regular linked commands, in
 * the same sandbox and workspace snapshot, so build output it produces is what
 * those commands see. A setup entry that does not pass stops the run: an
 * executed failure reports the typed `setup_failed` category, a refusal keeps
 * its own category, and every later entry is reported as skipped without
 * executing.
 */
import { EXIT_CODE } from "../../core/shared/constants.js";
import { PmCliError } from "../../core/shared/errors.js";
import type { LinkedTestRunSelection } from "../../core/test/run-selectors.js";
import type { LinkedTest } from "../../types/index.js";
import type { TestRunResult } from "./execution.js";

/** Restricts linked test failure category values accepted by command, SDK, and storage contracts. */
export type LinkedTestFailureCategory =
  | "infra_collision"
  | "trust_refusal"
  | "config_refusal"
  | "assertion_failure"
  | "empty_run"
  | "timeout"
  | "max_buffer"
  | "spawn_error"
  | "signal"
  | "setup_failed";

/** Accepted spellings of a linked test's run phase; `test`, the default, is never stored. */
export const LINKED_TEST_PHASE_VALUES = ["setup", "test"] as const;

/** Whether a linked test is a setup entry that runs before the item's regular commands. */
export function isLinkedTestSetup(test: Pick<LinkedTest, "phase">): boolean {
  return test.phase === "setup";
}

/** Parse one structured-entry phase value, storing the default `test` phase as absent. */
export function parseLinkedTestPhase(
  value: unknown,
  optionName: string,
): LinkedTest["phase"] {
  if (value === undefined) return undefined;
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : value;
  if (normalized === "setup") return "setup";
  if (normalized === "test" || normalized === "") return undefined;
  throw new PmCliError(
    `${optionName} field "phase" must be one of: ${LINKED_TEST_PHASE_VALUES.join(", ")}`,
    EXIT_CODE.USAGE,
    {
      code: "invalid_argument_value",
      required: 'Use phase=setup for a step that runs before the linked commands, or omit phase for a regular linked test.',
      examples: ['pm test <id> --add "command=npm run build,phase=setup"'],
    },
  );
}

/** Every setup entry, in stored order, followed by every regular linked test, in stored order. */
export function orderLinkedTestsSetupFirst(tests: LinkedTest[]): LinkedTest[] {
  return [...tests.filter(isLinkedTestSetup), ...tests.filter((test) => !isLinkedTestSetup(test))];
}

/**
 * Put every stored setup entry ahead of the selected regular commands. A
 * selector that names only setup entries runs just those. The receipt then
 * describes what actually runs: `selected_indexes` and `selected_count` include
 * the prepended setup entries, in run order, so `selected_indexes[i]` is the
 * stored position of `run_results[i]`; `setup_indexes` lists the setup entries
 * the selector itself did not name.
 */
export function withLinkedTestSetupEntries(
  selection: LinkedTestRunSelection,
  stored: LinkedTest[],
): LinkedTestRunSelection {
  if (!selection.selected.some((test) => !isLinkedTestSetup(test))) return selection;
  const setupIndexes = stored.flatMap((test, index) => (isLinkedTestSetup(test) ? [index + 1] : []));
  if (setupIndexes.length === 0) return selection;
  const regular = selection.selected_indexes.filter((index) => !isLinkedTestSetup(stored[index - 1] as LinkedTest));
  const prepended = setupIndexes.filter((index) => !selection.selected_indexes.includes(index));
  return {
    ...selection,
    selected: [...setupIndexes, ...regular].map((index) => stored[index - 1] as LinkedTest),
    selected_indexes: [...setupIndexes, ...regular],
    selected_count: setupIndexes.length + regular.length,
    skipped_count: stored.length - setupIndexes.length - regular.length,
    ...(prepended.length > 0 ? { setup_indexes: prepended } : {}),
  };
}

/** Options a setup entry overrides: empty-run and assertion requirements describe test runners, not build steps. */
interface SetupExemptOptions {
  failOnEmptyTestRun?: boolean;
  requireAssertionsForPm?: boolean;
}

/** Tracks the setup phase across one linked-test run. */
export interface LinkedTestSetupGate {
  /** The skipped row for an entry that must not run because an earlier setup entry did not pass. */
  blocked(linkedTest: LinkedTest): TestRunResult | undefined;
  /** The options one entry runs with. */
  options<T extends SetupExemptOptions>(linkedTest: LinkedTest, options: T | undefined): T | undefined;
  /** Mark a setup entry's row with its phase and its typed outcome, remembering whether it passed. */
  record(linkedTest: LinkedTest, result: TestRunResult): TestRunResult;
}

/** Create the setup gate for one item's run; entries must arrive in run order, setup entries first (see {@link orderLinkedTestsSetupFirst}). */
export function createLinkedTestSetupGate(): LinkedTestSetupGate {
  let failure: { label: string; outcome: string } | undefined;
  return {
    blocked(linkedTest) {
      if (failure === undefined) return undefined;
      return {
        command: linkedTest.command,
        path: linkedTest.path,
        status: "skipped",
        ...(isLinkedTestSetup(linkedTest) ? { phase: "setup" as const } : {}),
        error: `Skipped because setup entry "${failure.label}" did not pass (${failure.outcome}); no later linked command ran.`,
      };
    },
    options(linkedTest, options) {
      if (!isLinkedTestSetup(linkedTest) || options === undefined) return options;
      return { ...options, failOnEmptyTestRun: false, requireAssertionsForPm: false };
    },
    record(linkedTest, result) {
      if (!isLinkedTestSetup(linkedTest)) return result;
      if (result.status === "passed") return { ...result, phase: "setup" };
      // A refusal keeps its own category, because its recovery (trust acknowledgement) differs from a
      // failed build. A setup that never executed (a safety skip, or an entry without a command) fails
      // the run: otherwise every dependent entry would be skipped behind a passing verdict.
      const refused = result.status === "refused" || result.failure_category === "trust_refusal";
      const row: TestRunResult = refused
        ? { ...result, phase: "setup" }
        : {
            ...result,
            status: "failed",
            phase: "setup",
            failure_category: "setup_failed",
            ...(result.failure_category === undefined ? {} : { setup_failure_cause: result.failure_category }),
          };
      failure = {
        label: linkedTest.command ?? linkedTest.path ?? "<no command>",
        outcome: row.failure_category ?? row.status,
      };
      return row;
    },
  };
}

/** Initialize every public failure category so aggregate receipts retain a stable exhaustive shape. */
export function createEmptyFailureCategoryCounts(): Record<
  LinkedTestFailureCategory,
  number
> {
  return {
    infra_collision: 0,
    trust_refusal: 0,
    config_refusal: 0,
    assertion_failure: 0,
    empty_run: 0,
    timeout: 0,
    max_buffer: 0,
    spawn_error: 0,
    signal: 0,
    setup_failed: 0,
  };
}

/** Count failed and refused rows by failure category; passed and skipped rows are not failures and are not counted. */
export function countFailureCategories(
  runResults: TestRunResult[],
): Record<LinkedTestFailureCategory, number> {
  const counts = createEmptyFailureCategoryCounts();
  for (const result of runResults) {
    if ((result.status !== "failed" && result.status !== "refused") || !result.failure_category) {
      continue;
    }
    counts[result.failure_category] += 1;
  }
  return counts;
}
