import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { parse } from "yaml";

it("runs real telemetry subprocess regressions on Node 22 before merge", async () => {
  const workflow = parse(await readFile(".github/workflows/ci.yml", "utf8")) as {
    jobs: Record<string, { needs?: string; steps: Array<{ uses?: string; run?: string; with?: Record<string, unknown>; "continue-on-error"?: boolean }> }>;
  };
  const job = workflow.jobs["node22-telemetry"];
  expect(job.needs).toBe("build-foundation");
  expect(job.steps.find((step) => step.uses?.startsWith("actions/setup-node@"))?.with?.["node-version"]).toBe(22);
  expect(job.steps.find((step) => step.uses?.startsWith("actions/download-artifact@"))?.with).toMatchObject({ name: "dist-node24-ubuntu", path: "dist" });
  const testStep = job.steps.find((step) => step.run?.includes("run-tests.mjs"));
  expect(testStep?.run).toBe("PM_RUN_TESTS_SKIP_BUILD=1 node scripts/run-tests.mjs test -- tests/unit/core/telemetry/");
  expect(testStep?.["continue-on-error"]).toBeUndefined();
});
