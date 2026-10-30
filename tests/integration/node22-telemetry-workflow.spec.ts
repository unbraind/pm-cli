import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { parse } from "yaml";

it("runs real telemetry subprocess regressions on Node 22 before merge", async () => {
  const workflow = parse(await readFile(".github/workflows/ci.yml", "utf8")) as {
    jobs: Record<string, { needs?: string; steps: Array<{ uses?: string; run?: string; with?: Record<string, unknown>; "continue-on-error"?: boolean }> }>;
  };
  // pm-m6ig79: the Ubuntu packed runtime job owns the Node 22 regressions.
  const job = workflow.jobs["build-test"];
  for (const workflowJob of Object.values(workflow.jobs)) {
    for (const step of workflowJob.steps) {
      if (step.uses?.startsWith("actions/checkout@")) {
        expect(step.with?.["persist-credentials"]).toBe(false);
      }
    }
  }
  expect(job.needs).toBe("build-foundation");
  const nodeSetup = job.steps.findIndex((step) => step.uses?.startsWith("actions/setup-node@") && step.with?.["node-version"] === 22);
  expect(nodeSetup).toBeGreaterThan(0);
  expect((job.steps[nodeSetup] as { if?: string }).if).toBe("matrix.os == 'ubuntu-latest'");
  expect(job.steps.find((step) => step.uses?.startsWith("actions/download-artifact@") && step.with?.name === "dist-node24-ubuntu")?.with).toMatchObject({ name: "dist-node24-ubuntu", path: "dist" });
  const testStep = job.steps.find((step) => step.run?.includes("tests/unit/core/telemetry/"));
  expect(job.steps.indexOf(testStep!)).toBeGreaterThan(nodeSetup);
  expect((testStep as { if?: string }).if).toBe("matrix.os == 'ubuntu-latest'");
  expect(testStep?.run).toBe("PM_RUN_TESTS_SKIP_BUILD=1 node scripts/run-tests.mjs test -- tests/unit/core/telemetry/");
  expect(testStep?.["continue-on-error"]).toBeUndefined();
});
