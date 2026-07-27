import { describe, expect, it, vi } from "vitest";
import * as sdk from "../../../src/sdk/index.js";
import {
  runTestRunsListPackage,
  runTestRunsLogsPackage,
  runTestRunsResumePackage,
  runTestRunsStatusPackage,
  runTestRunsStopPackage,
} from "../../../packages/pm-linked-test-adapters/extensions/linked-test-adapters/runtime.ts";

describe("linked-test adapters static SDK runtime", () => {
  it("normalizes options and delegates every adapter", async () => {
    const global = { author: "agent", noExtensions: true } as never;
    const list = vi.spyOn(sdk, "runTestRunsList").mockResolvedValue({ kind: "list" } as never);
    const status = vi.spyOn(sdk, "runTestRunsStatus").mockResolvedValue({ kind: "status" } as never);
    const logs = vi.spyOn(sdk, "runTestRunsLogs").mockResolvedValue({ kind: "logs" } as never);
    const stop = vi.spyOn(sdk, "runTestRunsStop").mockResolvedValue({ kind: "stop" } as never);
    const resume = vi.spyOn(sdk, "runTestRunsResume").mockResolvedValue({ kind: "resume" } as never);

    await runTestRunsListPackage({ status: "failed", limit: "5" }, global);
    expect(list).toHaveBeenCalledWith({ status: "failed", limit: "5" }, global);
    await runTestRunsStatusPackage([" run-1 "], global);
    expect(status).toHaveBeenCalledWith("run-1", global);
    await runTestRunsLogsPackage(["run-2"], { stream: "stderr", tail: "20" }, global);
    expect(logs).toHaveBeenCalledWith("run-2", { stream: "stderr", tail: "20" }, global);
    await runTestRunsStopPackage(["run-3"], { force: true }, global);
    expect(stop).toHaveBeenCalledWith("run-3", { force: true }, global);
    await runTestRunsStopPackage(["run-4"], { force: "no" }, global);
    expect(stop).toHaveBeenLastCalledWith("run-4", { force: false }, global);
    await runTestRunsResumePackage(["run-5"], global);
    expect(resume).toHaveBeenCalledWith(
      "run-5",
      { author: "agent", noExtensions: true },
      global,
    );
    vi.restoreAllMocks();
  });

  it("rejects missing run identifiers for every positional adapter", async () => {
    await expect(runTestRunsStatusPackage([], {} as never)).rejects.toThrow("test-runs status requires a runId");
    await expect(runTestRunsLogsPackage(["   "], {}, {} as never)).rejects.toThrow("test-runs logs requires a runId");
    await expect(runTestRunsStopPackage([], {}, {} as never)).rejects.toThrow("test-runs stop requires a runId");
    await expect(runTestRunsResumePackage([], {} as never)).rejects.toThrow("test-runs resume requires a runId");
  });
});
