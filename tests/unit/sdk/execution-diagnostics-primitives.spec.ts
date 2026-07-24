import { describe, expect, it } from "vitest";
import { runEval as runCliEval } from "../../../src/cli/commands/eval.js";
import { runStats as runCliStats } from "../../../src/cli/commands/stats.js";
import { runList as runCliList } from "../../../src/cli/commands/list.js";
import { runSearch as runCliSearch } from "../../../src/cli/commands/search.js";
import { runTelemetry as runCliTelemetry } from "../../../src/cli/commands/telemetry.js";
import { runTestAll as runCliTestAll } from "../../../src/cli/commands/test-all.js";
import {
  runStartBackgroundRun as runCliStartBackgroundRun,
  runTestRunsList as runCliTestRunsList,
  runTestRunsWorker as runCliTestRunsWorker,
} from "../../../src/cli/commands/test-runs.js";
import { runTest as runCliTest } from "../../../src/cli/commands/test.js";
import {
  LINKED_TEST_PM_CONTEXT_MODE_VALUES,
  TELEMETRY_SUBCOMMANDS,
  parseLinkedTestJsonEntries,
  runEval,
  runStartBackgroundRun,
  runStats,
  runList,
  runSearch,
  runTelemetry,
  runTest,
  runTestAll,
  runTestRunsList,
  runTestRunsWorker,
  type EvalOptions,
  type StartBackgroundRunCommandOptions,
  type TelemetryCommandOptions,
  type TestAllCommandOptions,
  type TestCommandOptions,
} from "../../../src/sdk/index.js";

describe("SDK execution and diagnostics ownership", () => {
  it("keeps every CLI command path as an identity-preserving SDK compatibility export", () => {
    expect(runCliTest).toBe(runTest);
    expect(runCliTestAll).toBe(runTestAll);
    expect(runCliStartBackgroundRun).toBe(runStartBackgroundRun);
    expect(runCliTestRunsList).toBe(runTestRunsList);
    expect(runCliTestRunsWorker).toBe(runTestRunsWorker);
    expect(runCliEval).toBe(runEval);
    expect(runCliTelemetry).toBe(runTelemetry);
    expect(runCliStats).toBe(runStats);
    expect(runCliList).toBe(runList);
    expect(runCliSearch).toBe(runSearch);
  });

  it("exports typed execution options and linked-test parsers from the public barrel", () => {
    const testOptions: TestCommandOptions = {
      run: true,
      autoPmContext: true,
      failOnEmptyTestRun: true,
    };
    const batchOptions: TestAllCommandOptions = {
      status: "open",
      failOnSkipped: true,
      author: "agent",
    };
    const backgroundOptions: StartBackgroundRunCommandOptions = {
      kind: "test",
      commandArgs: ["pm-test", "pm-a1b2", "--run"],
      targetId: "pm-a1b2",
    };
    const evalOptions: EvalOptions = { mode: "keyword", k: 10 };
    const telemetryOptions: TelemetryCommandOptions = {
      subcommand: "stats",
      limit: 20,
    };
    const [linkedTest] = parseLinkedTestJsonEntries(
      JSON.stringify({
        command: "node scripts/run-tests.mjs test",
        pm_context_mode: "auto",
        timeout_seconds: 120,
      }),
      "--add-json",
    );

    expect(testOptions.autoPmContext).toBe(true);
    expect(batchOptions.failOnSkipped).toBe(true);
    expect(batchOptions.author).toBe("agent");
    expect(backgroundOptions.kind).toBe("test");
    expect(evalOptions.k).toBe(10);
    expect(telemetryOptions.limit).toBe(20);
    expect(linkedTest).toMatchObject({
      pm_context_mode: "auto",
      timeout_seconds: 120,
    });
    expect(LINKED_TEST_PM_CONTEXT_MODE_VALUES).toEqual([
      "schema",
      "tracker",
      "auto",
    ]);
    expect(TELEMETRY_SUBCOMMANDS).toEqual([
      "status",
      "flush",
      "stats",
      "clear",
    ]);
  });
});
