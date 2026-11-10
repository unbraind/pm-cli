import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SerializedError, TestCase, TestModule } from "vitest/node";
import TestExecutionReporter from "../../../scripts/test-execution-reporter.mts";
import { withTempDir } from "../../helpers/temp.js";

afterEach(() => vi.unstubAllEnvs());

describe("test execution reporter", () => {
  it.each(["interrupted", "failed"] as const)("writes assertion and collection evidence when %s to its captured destination", async (reason) => {
    await withTempDir("pm-assertion-receipt-", async (root) => {
      const destination = path.join(root, "receipt.json");
      vi.stubEnv("PM_RUN_TESTS_EXECUTION_REPORT", destination);
      const reporter = new TestExecutionReporter();
      vi.stubEnv("PM_RUN_TESTS_EXECUTION_REPORT", path.join(root, "another-run.json"));
      for (const state of ["passed", "failed", "skipped"] as const) {
        reporter.onTestCaseResult({ result: () => ({ state }) } as TestCase);
      }
      const modules = ["passed", "failed"].map((state) => ({ state: () => state }) as TestModule);
      await reporter.onTestRunEnd(modules, [{ message: "unhandled fixture error" } as SerializedError], reason);
      expect(JSON.parse(await readFile(destination, "utf8"))).toEqual({
        version: 1, passed_tests: 1, failed_tests: 1, failed_modules: 1, unhandled_errors: 1, interrupted: reason === "interrupted",
      });
      expect(await readdir(root)).toEqual(["receipt.json"]);
    });
  });

  it("does not allocate a receipt when the runner has not supplied a destination", async () => {
    vi.stubEnv("PM_RUN_TESTS_EXECUTION_REPORT", undefined);
    await expect(new TestExecutionReporter().onTestRunEnd([], [], "passed")).resolves.toBeUndefined();
  });
});
