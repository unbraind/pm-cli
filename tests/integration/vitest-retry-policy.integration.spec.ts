import { spawnSync } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { withTempDir } from "../helpers/temp.js";

interface ChildRunResult {
  report: {
    failed_count: number;
    flaky_count: number;
    tests: Array<{ flaky: boolean; retry_count: number; test: string }>;
  };
  status: number | null;
  stderr: string;
  stdout: string;
  summary: string;
}

const runReliabilityFixture = async (
  root: string,
  fixture: "persistent" | "transient",
): Promise<ChildRunResult> => {
  await mkdir(root, { recursive: true });
  const reportDirectory = path.join(root, "reports");
  const summaryPath = path.join(root, "summary.md");
  const shard = `${fixture}-control`;
  const result = spawnSync(
    process.execPath,
    [
      path.join(process.cwd(), "node_modules", "vitest", "vitest.mjs"),
      "run",
      `tests/fixtures/vitest-reliability/${fixture}.test.ts`,
      "--config",
      "tests/fixtures/vitest-reliability/vitest.config.ts",
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        CI: "1",
        GITHUB_ACTIONS: "true",
        GITHUB_STEP_SUMMARY: summaryPath,
        PM_TEST_RELIABILITY_REPORT_DIR: reportDirectory,
        PM_TEST_SHARD: shard,
        PM_VITEST_RETRY_STATE: path.join(root, "retry-state"),
      },
      timeout: 60_000,
    },
  );
  return {
    report: JSON.parse(
      await readFile(
        path.join(reportDirectory, `reliability-${shard}.json`),
        "utf8",
      ),
    ) as ChildRunResult["report"],
    status: result.status,
    stderr: result.stderr,
    stdout: result.stdout,
    summary: await readFile(summaryPath, "utf8"),
  };
};

describe("Vitest CI retry policy", () => {
  it("runs every native merge keeper once after parallel contracts with the original deadlines", async () => {
    const { default: config } = await import("../../vitest.config.js");
    const test = config.test!;
    const projects = test.projects as Array<{ test: {
      name: string; include: string[]; exclude?: string[];
      sequence: { groupOrder: number }; fileParallelism?: boolean; maxWorkers?: number;
    } }>;
    const contracts = projects.find((project) => project.test.name === "contracts")!.test;
    const serial = projects.find((project) => project.test.name === "lifecycle-performance")!.test;
    for (const file of [
      "tests/integration/receipt-operation-boundaries.integration.spec.ts",
      "tests/integration/aborted-rebase-recovery.integration.spec.ts",
      "tests/integration/workspace/merge-receipt-settlement.integration.spec.ts",
      "tests/integration/workspace/merge-portability.integration.spec.ts",
      "tests/integration/workspace/lossless-merge-union.integration.spec.ts",
    ]) {
      expect(contracts.exclude).toContain(file);
      expect(serial.include.filter((entry) => entry === file)).toHaveLength(1);
    }
    expect(serial.sequence.groupOrder).toBeGreaterThan(contracts.sequence.groupOrder);
    expect(serial).toMatchObject({ fileParallelism: false, maxWorkers: 1 });
    expect(test.testTimeout).toBe(30_000);
    expect(test.hookTimeout).toBe(30_000);
    expect(test.retry).toBe(process.env.CI ? 1 : 0);
  });

  it("records a transient pass and keeps a persistent assertion failing", async () => {
    await withTempDir("pm-vitest-retry-", async (root) => {
      const transient = await runReliabilityFixture(
        path.join(root, "transient"),
        "transient",
      );
      expect(transient.status).toBe(0);
      expect(transient.report).toMatchObject({
        failed_count: 0,
        flaky_count: 1,
        tests: [
          {
            flaky: true,
            retry_count: 1,
            test: "passes only after one transient attempt",
          },
        ],
      });
      expect(transient.summary).toContain("Passed only after retry: 1");

      const persistent = await runReliabilityFixture(
        path.join(root, "persistent"),
        "persistent",
      );
      expect(persistent.status).toBe(1);
      expect(persistent.report).toMatchObject({
        failed_count: 1,
        flaky_count: 0,
        tests: [
          {
            flaky: false,
            retry_count: 1,
            test: "persistent assertion remains a failure",
          },
        ],
      });
      expect(persistent.summary).toContain(
        "persistent assertion remains a failure",
      );
      expect(`${persistent.stdout}\n${persistent.stderr}`).toContain(
        "persistent assertion remains a failure",
      );
    });
  }, 120_000);
});
