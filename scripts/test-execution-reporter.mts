/** Record assertion outcomes independently of Vitest's coverage and reporter exit codes. */
import { writeFile } from "node:fs/promises";
import type { Reporter, SerializedError, TestCase, TestModule, TestRunEndReason } from "vitest/node";

/** Emit a small invocation-owned receipt without copying test details or coverage maps. */
export default class TestExecutionReporter implements Reporter {
  readonly #output = process.env.PM_RUN_TESTS_EXECUTION_REPORT;
  #passed = 0;
  #failed = 0;

  /** Count final assertion outcomes while leaving skipped cases uncounted. */
  onTestCaseResult(test: TestCase): void {
    const state = test.result().state;
    if (state === "passed") this.#passed += 1;
    else if (state === "failed") this.#failed += 1;
  }

  /** Preserve collection errors and interruptions beside the assertion counters. */
  async onTestRunEnd(modules: ReadonlyArray<TestModule>, errors: ReadonlyArray<SerializedError>, reason: TestRunEndReason): Promise<void> {
    if (!this.#output) return;
    await writeFile(this.#output, JSON.stringify({
      version: 1,
      passed_tests: this.#passed,
      failed_tests: this.#failed,
      failed_modules: modules.filter((module) => module.state() === "failed").length,
      unhandled_errors: errors.length,
      interrupted: reason === "interrupted",
    }), "utf8");
  }
}
