import { describe, expect, it, vi } from "vitest";
import {
  PmClient,
  evaluate,
  runSearchEval,
  runStats,
  runTelemetry,
  runTest,
  runTestAll,
  stats,
  telemetry,
  test as runLinkedTest,
  testAll,
} from "../../../src/sdk/index.js";

describe("SDK execution and diagnostics ownership", () => {
  it("exports direct engines and one-off helpers from the public barrel", () => {
    expect(
      [
        runSearchEval,
        runStats,
        runTelemetry,
        runTest,
        runTestAll,
        runLinkedTest,
        testAll,
        stats,
        telemetry,
        evaluate,
      ].every((entry) => typeof entry === "function"),
    ).toBe(true);
  });

  it("routes typed client helpers through SDK actions", async () => {
    const client = new PmClient({
      pmRoot: "/tmp/sdk-execution-diagnostics",
      author: "sdk-quality-host",
      noExtensions: true,
    });
    const run = vi.spyOn(client, "run").mockResolvedValue({ ok: true });

    await client.test("pm-feature", { list: true });
    await client.testAll({ status: "in_progress", progress: true });
    await client.telemetry({ subcommand: "status" });
    await client.evaluate({ k: 10, failUnder: 0.9 });

    expect(run.mock.calls).toEqual([
      ["test", { id: "pm-feature", options: { list: true } }],
      [
        "test-all",
        { options: { status: "in_progress", progress: true } },
      ],
      ["telemetry", { options: { subcommand: "status" } }],
      ["eval", { options: { k: 10, failUnder: 0.9 } }],
    ]);
  });

  it("constructs short-lived clients for one-off execution helpers", async () => {
    const linkedTest = vi
      .spyOn(PmClient.prototype, "test")
      .mockResolvedValue({} as never);
    const linkedTestBatch = vi
      .spyOn(PmClient.prototype, "testAll")
      .mockResolvedValue({} as never);
    const telemetryStatus = vi
      .spyOn(PmClient.prototype, "telemetry")
      .mockResolvedValue({} as never);
    const searchEvaluation = vi
      .spyOn(PmClient.prototype, "evaluate")
      .mockResolvedValue({} as never);

    await runLinkedTest("pm-defaults");
    await runLinkedTest(
      "pm-explicit",
      { list: true },
      { pmRoot: "/tmp/sdk-one-off" },
    );
    await testAll();
    await testAll({ status: "open" }, { noExtensions: true });
    await telemetry();
    await telemetry({ subcommand: "status" }, { noExtensions: true });
    await evaluate();
    await evaluate({ k: 5 }, { noExtensions: true });

    expect(linkedTest.mock.calls).toEqual([
      ["pm-defaults", {}],
      ["pm-explicit", { list: true }],
    ]);
    expect(linkedTestBatch.mock.calls).toEqual([
      [{}],
      [{ status: "open" }],
    ]);
    expect(telemetryStatus.mock.calls).toEqual([
      [{}],
      [{ subcommand: "status" }],
    ]);
    expect(searchEvaluation.mock.calls).toEqual([[{}], [{ k: 5 }]]);
  });
});
