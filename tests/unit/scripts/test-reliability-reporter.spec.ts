import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";
import type { TestCase } from "vitest/reporters";
import TestReliabilityReporter from "../../../scripts/test-reliability-reporter.mts";
import { withTempDir } from "../../helpers/temp.js";

interface FakeTestCaseOptions {
  diagnostic?: {
    duration: number;
    flaky: boolean;
    retryCount: number;
  };
  errors?: string[];
  file: string;
  state: "failed" | "passed" | "skipped";
  test: string;
  timeout?: number;
}

const fakeTestCase = (options: FakeTestCaseOptions): TestCase =>
  ({
    diagnostic: () => options.diagnostic,
    fullName: options.test,
    module: { relativeModuleId: options.file },
    options: { timeout: options.timeout },
    result: () => ({
      errors: options.errors?.map((message) => ({ message })),
      state: options.state,
    }),
  }) as unknown as TestCase;

describe("test reliability reporter", () => {
  it("records failed, flaky, and at-risk tests in JSON and Markdown", async () => {
    await withTempDir("pm-reliability-reporter-", async (root) => {
      const reportDirectory = path.join(root, "reports");
      const summaryPath = path.join(root, "summary.md");
      const reporter = new TestReliabilityReporter({
        atRiskRatio: 0.8,
        defaultTimeoutMs: 30_000,
        reportDirectory,
        shard: "2/4",
        summaryPath,
      });
      reporter.onTestCaseResult(
        fakeTestCase({
          diagnostic: { duration: 25_000, flaky: false, retryCount: 1 },
          errors: ["persistent | failure\nwith detail"],
          file: "tests/persistent.spec.ts",
          state: "failed",
          test: "persistent assertion",
        }),
      );
      reporter.onTestCaseResult(
        fakeTestCase({
          diagnostic: { duration: 1_200, flaky: true, retryCount: 1 },
          file: "tests/flaky.spec.ts",
          state: "passed",
          test: "transient timeout",
          timeout: 2_000,
        }),
      );
      reporter.onTestCaseResult(
        fakeTestCase({
          diagnostic: { duration: 24_000, flaky: false, retryCount: 0 },
          file: "tests/slow.spec.ts",
          state: "passed",
          test: "near timeout",
        }),
      );
      reporter.onTestCaseResult(
        fakeTestCase({
          diagnostic: { duration: 100, flaky: false, retryCount: 0 },
          file: "tests/clean.spec.ts",
          state: "passed",
          test: "ordinary pass",
        }),
      );
      reporter.onTestCaseResult(
        fakeTestCase({
          file: "tests/skipped.spec.ts",
          state: "skipped",
          test: "declared skip",
        }),
      );

      await reporter.onTestRunEnd();

      const report = JSON.parse(
        await readFile(
          path.join(reportDirectory, "reliability-2-4.json"),
          "utf8",
        ),
      ) as {
        at_risk_count: number;
        failed_count: number;
        flaky_count: number;
        tests: Array<{
          error?: string;
          file: string;
          state: string;
          timeout_ratio: number;
        }>;
      };
      expect(report).toMatchObject({
        at_risk_count: 2,
        failed_count: 1,
        flaky_count: 1,
      });
      expect(report.tests).toHaveLength(3);
      expect(report.tests[0]).toMatchObject({
        file: "tests/flaky.spec.ts",
        state: "passed",
        timeout_ratio: 0.6,
      });
      expect(report.tests[1]?.error).toContain("persistent | failure");
      expect(await readFile(summaryPath, "utf8")).toContain(
        "persistent \\| failure with detail",
      );
    });
  });

  it("uses environment defaults and writes an empty report without a summary", async () => {
    await withTempDir("pm-reliability-defaults-", async (root) => {
      const previousReportDirectory =
        process.env.PM_TEST_RELIABILITY_REPORT_DIR;
      const previousShard = process.env.PM_TEST_SHARD;
      const previousSummary = process.env.GITHUB_STEP_SUMMARY;
      const environmentReportDirectory = path.join(root, "environment");
      const environmentSummaryPath = path.join(root, "environment-summary.md");
      process.env.PM_TEST_RELIABILITY_REPORT_DIR = environmentReportDirectory;
      process.env.PM_TEST_SHARD = "windows latest";
      process.env.GITHUB_STEP_SUMMARY = environmentSummaryPath;
      try {
        const reporter = new TestReliabilityReporter();
        reporter.onTestCaseResult(
          fakeTestCase({
            file: "tests/pending.spec.ts",
            state: "passed",
            test: "missing diagnostics",
          }),
        );
        await reporter.onTestRunEnd();
        await expect(
          readFile(
            path.join(
              environmentReportDirectory,
              "reliability-windows-latest.json",
            ),
            "utf8",
          ),
        ).resolves.toContain('"tests": []');
        await expect(
          readFile(environmentSummaryPath, "utf8"),
        ).resolves.toContain("Failed after retry: 0");

        delete process.env.GITHUB_STEP_SUMMARY;
        const noSummaryReporter = new TestReliabilityReporter({
          reportDirectory: path.join(root, "no-summary"),
          shard: "///",
        });
        noSummaryReporter.onTestCaseResult(
          fakeTestCase({
            errors: [""],
            file: "tests/zero.spec.ts",
            state: "failed",
            test: "zero timeout first",
            timeout: 0,
          }),
        );
        noSummaryReporter.onTestCaseResult(
          fakeTestCase({
            diagnostic: { duration: 1, flaky: false, retryCount: 0 },
            file: "tests/zero.spec.ts",
            state: "failed",
            test: "zero timeout second",
            timeout: 0,
          }),
        );
        await noSummaryReporter.onTestRunEnd();
        await expect(
          readFile(
            path.join(root, "no-summary", "reliability-unsharded.json"),
            "utf8",
          ),
        ).resolves.toContain('"retry_count": 0');

        delete process.env.PM_TEST_RELIABILITY_REPORT_DIR;
        delete process.env.PM_TEST_SHARD;
        const fallbackReporter = new TestReliabilityReporter();
        fallbackReporter.onTestCaseResult(
          fakeTestCase({
            file: "tests/constructor.spec.ts",
            state: "passed",
            test: "constructor fallback only",
          }),
        );
      } finally {
        if (previousReportDirectory === undefined) {
          delete process.env.PM_TEST_RELIABILITY_REPORT_DIR;
        } else {
          process.env.PM_TEST_RELIABILITY_REPORT_DIR = previousReportDirectory;
        }
        if (previousShard === undefined) {
          delete process.env.PM_TEST_SHARD;
        } else {
          process.env.PM_TEST_SHARD = previousShard;
        }
        if (previousSummary === undefined) {
          delete process.env.GITHUB_STEP_SUMMARY;
        } else {
          process.env.GITHUB_STEP_SUMMARY = previousSummary;
        }
      }
    });
  });
});
