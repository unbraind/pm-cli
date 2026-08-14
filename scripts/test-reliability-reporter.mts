/**
 * Records actionable Vitest retry, failure, and near-timeout evidence for CI.
 *
 * The reporter complements Vitest's console output with a stable JSON artifact
 * and a compact GitHub job-summary section. It deliberately records the shard,
 * observed duration, effective timeout, and retry count together so a flaky
 * test's recurrence can be measured without reconstructing raw logs.
 */

import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Reporter, TestCase } from "vitest/reporters";

/** Default per-test timeout retained by the repository test policy. */
export const TEST_TIMEOUT_MS = 30_000;

/** Fraction of a timeout budget at which a completed test becomes at-risk. */
export const TEST_AT_RISK_RATIO = 0.8;

interface TestReliabilityReporterOptions {
  atRiskRatio?: number;
  defaultTimeoutMs?: number;
  reportDirectory?: string;
  shard?: string;
  summaryPath?: string;
}

interface TestReliabilityRecord {
  at_risk: boolean;
  duration_ms: number;
  error?: string;
  file: string;
  flaky: boolean;
  retry_count: number;
  shard: string;
  state: "failed" | "passed";
  test: string;
  timeout_ms: number;
  timeout_ratio: number;
}

interface TestReliabilityReport {
  at_risk_count: number;
  failed_count: number;
  flaky_count: number;
  shard: string;
  tests: TestReliabilityRecord[];
  timeout_policy: {
    at_risk_ratio: number;
    default_timeout_ms: number;
  };
  version: 1;
}

const sanitizeMarkdownCell = (value: string): string =>
  value.replaceAll("|", "\\|").replace(/\s+/g, " ").trim();

/**
 * Vitest reporter that persists reliability evidence without changing verdicts.
 */
export default class TestReliabilityReporter implements Reporter {
  readonly #atRiskRatio: number;
  readonly #defaultTimeoutMs: number;
  readonly #reportDirectory: string;
  readonly #shard: string;
  readonly #summaryPath: string | undefined;
  readonly #records: TestReliabilityRecord[] = [];

  /** Resolves explicit test settings before falling back to CI environment. */
  constructor(options: TestReliabilityReporterOptions = {}) {
    this.#atRiskRatio = options.atRiskRatio ?? TEST_AT_RISK_RATIO;
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? TEST_TIMEOUT_MS;
    this.#reportDirectory =
      options.reportDirectory ??
      process.env.PM_TEST_RELIABILITY_REPORT_DIR ??
      ".vitest-reports";
    this.#shard = options.shard ?? process.env.PM_TEST_SHARD ?? "unsharded";
    this.#summaryPath = options.summaryPath ?? process.env.GITHUB_STEP_SUMMARY;
  }

  /** Captures only failed, flaky, or near-budget test cases. */
  onTestCaseResult(testCase: TestCase): void {
    const result = testCase.result();
    if (result.state !== "failed" && result.state !== "passed") {
      return;
    }
    const diagnostic = testCase.diagnostic();
    const durationMs = diagnostic?.duration ?? 0;
    const timeoutMs = testCase.options.timeout ?? this.#defaultTimeoutMs;
    const timeoutRatio = timeoutMs > 0 ? durationMs / timeoutMs : 0;
    const atRisk = timeoutRatio >= this.#atRiskRatio;
    const flaky = diagnostic?.flaky === true;
    if (result.state !== "failed" && !flaky && !atRisk) {
      return;
    }
    const error = result.errors
      ?.map((entry) => entry.message)
      .filter((message) => message.length > 0)
      .join(" | ");
    this.#records.push({
      at_risk: atRisk,
      duration_ms: durationMs,
      error: error && error.length > 0 ? error.slice(0, 500) : undefined,
      file: testCase.module.relativeModuleId,
      flaky,
      retry_count: diagnostic?.retryCount ?? 0,
      shard: this.#shard,
      state: result.state,
      test: testCase.fullName,
      timeout_ms: timeoutMs,
      timeout_ratio: Number(timeoutRatio.toFixed(4)),
    });
  }

  /** Writes one deterministic shard report and appends its human summary. */
  async onTestRunEnd(): Promise<void> {
    const tests = [...this.#records].sort(
      (left, right) =>
        left.file.localeCompare(right.file) ||
        left.test.localeCompare(right.test),
    );
    const report: TestReliabilityReport = {
      at_risk_count: tests.filter((entry) => entry.at_risk).length,
      failed_count: tests.filter((entry) => entry.state === "failed").length,
      flaky_count: tests.filter((entry) => entry.flaky).length,
      shard: this.#shard,
      tests,
      timeout_policy: {
        at_risk_ratio: this.#atRiskRatio,
        default_timeout_ms: this.#defaultTimeoutMs,
      },
      version: 1,
    };
    await mkdir(this.#reportDirectory, { recursive: true });
    await writeFile(
      path.join(
        this.#reportDirectory,
        `reliability-${this.#shard.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unsharded"}.json`,
      ),
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8",
    );
    if (!this.#summaryPath) {
      return;
    }

    const lines = [
      "## pm test reliability",
      "",
      `- Shard: \`${sanitizeMarkdownCell(this.#shard)}\``,
      `- Failed after retry: ${report.failed_count}`,
      `- Passed only after retry: ${report.flaky_count}`,
      `- At or above ${Math.round(this.#atRiskRatio * 100)}% of timeout budget: ${report.at_risk_count}`,
    ];
    if (tests.length > 0) {
      lines.push(
        "",
        "| Test | File | State | Duration / timeout | Retries | Detail |",
        "| --- | --- | --- | ---: | ---: | --- |",
      );
      for (const test of tests) {
        const state = test.flaky
          ? "flaky pass"
          : test.at_risk && test.state === "passed"
            ? "at-risk pass"
            : test.state;
        lines.push(
          `| ${sanitizeMarkdownCell(test.test)} | \`${sanitizeMarkdownCell(test.file)}\` | ${state} | ${test.duration_ms} / ${test.timeout_ms} ms | ${test.retry_count} | ${sanitizeMarkdownCell(test.error ?? "-")} |`,
        );
      }
    }
    await appendFile(this.#summaryPath, `${lines.join("\n")}\n`, "utf8");
  }
}
