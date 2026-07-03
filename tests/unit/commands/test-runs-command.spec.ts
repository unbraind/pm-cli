import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { readFile, writeFile } from "node:fs/promises";
import * as fsPromises from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runStartBackgroundRun,
  runTestRunsList,
  runTestRunsLogs,
  runTestRunsResume,
  runTestRunsStatus,
  runTestRunsStop,
  runTestRunsWorker,
} from "../../../src/cli/commands/test-runs.js";
import {
  _testOnly as backgroundRunsTestOnly,
  buildBackgroundTestRunFingerprint,
  getBackgroundTestRunStatus,
  listBackgroundTestRuns,
  readBackgroundTestRunLogs,
  readBackgroundTestRunRecord,
  resumeBackgroundTestRun,
  runBackgroundTestRunWorker,
  spawnBackgroundTestRunWorker,
  startBackgroundTestRun,
} from "../../../src/core/test/background-runs.js";
import {
  getTestRunRecordPath,
  getTestRunResultPath,
  getTestRunStderrPath,
  getTestRunStdoutPath,
} from "../../../src/core/store/paths.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

async function setSettingsAuthorDefault(pmPath: string, authorDefault: string): Promise<void> {
  const settingsPath = path.join(pmPath, "settings.json");
  const settings = JSON.parse(await readFile(settingsPath, "utf8")) as { author_default?: string };
  settings.author_default = authorDefault;
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function withTemporaryEnv<T>(name: string, value: string, callback: () => Promise<T>): Promise<T> {
  const previous = process.env[name];
  process.env[name] = value;
  return callback().finally(() => {
    if (previous === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
    }
  });
}

async function withTemporaryEnvValues<T>(overrides: Record<string, string>, callback: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>(
    Object.keys(overrides).map((name) => [name, process.env[name]]),
  );
  for (const [name, value] of Object.entries(overrides)) {
    process.env[name] = value;
  }
  try {
    return await callback();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

async function withTemporaryCwd<T>(cwd: string, callback: () => Promise<T>): Promise<T> {
  const previous = process.cwd();
  process.chdir(cwd);
  try {
    return await callback();
  } finally {
    process.chdir(previous);
  }
}

async function withTemporaryPlatform<T>(platform: NodeJS.Platform, callback: () => Promise<T>): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform });
  try {
    return await callback();
  } finally {
    if (descriptor) {
      Object.defineProperty(process, "platform", descriptor);
    }
  }
}

function captureProcessSignalHandlers(): {
  sigtermHandlers: NodeJS.SignalsListener[];
  sigintHandlers: NodeJS.SignalsListener[];
  restore: () => void;
} {
  const sigtermHandlers: NodeJS.SignalsListener[] = [];
  const sigintHandlers: NodeJS.SignalsListener[] = [];
  const originalOn: typeof process.on = process.on.bind(process);
  const originalOff: typeof process.off = process.off.bind(process);
  const removeCapturedHandler = (
    handlers: NodeJS.SignalsListener[],
    listener: Parameters<typeof process.off>[1],
  ): boolean => {
    const index = handlers.indexOf(listener as NodeJS.SignalsListener);
    if (index < 0) {
      return false;
    }
    handlers.splice(index, 1);
    return true;
  };
  const onSpy = vi.spyOn(process, "on").mockImplementation((event, listener) => {
    if (event === "SIGTERM") {
      sigtermHandlers.push(listener as NodeJS.SignalsListener);
      return process;
    }
    if (event === "SIGINT") {
      sigintHandlers.push(listener as NodeJS.SignalsListener);
      return process;
    }
    return originalOn(event, listener);
  });
  const addListenerSpy = vi
    .spyOn(process, "addListener")
    .mockImplementation((event, listener) => process.on(event, listener));
  const offSpy = vi.spyOn(process, "off").mockImplementation((event, listener) => {
    if (event === "SIGTERM" && removeCapturedHandler(sigtermHandlers, listener)) {
      return process;
    }
    if (event === "SIGINT" && removeCapturedHandler(sigintHandlers, listener)) {
      return process;
    }
    return originalOff(event, listener);
  });
  const removeListenerSpy = vi
    .spyOn(process, "removeListener")
    .mockImplementation((event, listener) => process.off(event, listener));

  return {
    sigtermHandlers,
    sigintHandlers,
    restore: () => {
      addListenerSpy.mockRestore();
      removeListenerSpy.mockRestore();
      onSpy.mockRestore();
      offSpy.mockRestore();
    },
  };
}

async function dispatchSignalsWhenProgressReady(options: {
  stderrPath: string;
  marker: string;
  isWorkerFinished: () => boolean;
  signalGroups: ReadonlyArray<{
    signal: NodeJS.Signals;
    handlers: readonly NodeJS.SignalsListener[];
  }>;
}): Promise<void> {
  let progressObserved = false;
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    if (options.isWorkerFinished()) {
      break;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    const stderr = await readFile(options.stderrPath, "utf8").catch(() => "");
    if (stderr.includes(options.marker)) {
      progressObserved = true;
      break;
    }
  }
  if (!progressObserved || options.isWorkerFinished()) {
    return;
  }
  for (const group of options.signalGroups) {
    for (const handler of group.handlers) {
      handler(group.signal);
    }
  }
}

describe("test-runs command attribution fallback", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("falls back to USER when PM_AUTHOR and settings author_default are blank", async () => {
    await withTempPmPath(async (context) => {
      await setSettingsAuthorDefault(context.pmPath, "   ");
      await withTemporaryEnvValues({ PM_AUTHOR: "   ", USER: "fallback-user" }, async () => {
        const started = await runStartBackgroundRun(
          {
            kind: "test",
            commandArgs: ["test-runs", "list", "--json"],
            noExtensions: true,
          },
          {
            path: context.pmPath,
            noExtensions: true,
          },
        );
        expect((started.run as { requested_by?: string }).requested_by).toBe("fallback-user");
      });
    });
  });

  it("falls back to os.userInfo username when env candidates are blank", async () => {
    await withTempPmPath(async (context) => {
      await setSettingsAuthorDefault(context.pmPath, " ");
      const userInfoSpy = vi.spyOn(os, "userInfo").mockReturnValue({
        uid: 1000,
        gid: 1000,
        username: "whoami-fallback",
        homedir: "/tmp",
        shell: "/bin/bash",
      });
      try {
        await withTemporaryEnvValues({ PM_AUTHOR: " ", USER: "", LOGNAME: "", USERNAME: "" }, async () => {
          const started = await runStartBackgroundRun(
            {
              kind: "test-all",
              commandArgs: ["test-runs", "list", "--json"],
              noExtensions: true,
            },
            {
              path: context.pmPath,
              noExtensions: true,
            },
          );
          expect((started.run as { requested_by?: string }).requested_by).toBe("whoami-fallback");
        });
      } finally {
        userInfoSpy.mockRestore();
      }
    });
  });

  it("falls back to unknown when all attribution candidates are unavailable", async () => {
    await withTempPmPath(async (context) => {
      await setSettingsAuthorDefault(context.pmPath, " ");
      const userInfoSpy = vi.spyOn(os, "userInfo").mockImplementation(() => {
        throw new Error("no-userinfo");
      });
      try {
        await withTemporaryEnvValues({ PM_AUTHOR: " ", USER: "", LOGNAME: "", USERNAME: "" }, async () => {
          const started = await runStartBackgroundRun(
            {
              kind: "test",
              commandArgs: ["test-runs", "list", "--json"],
              noExtensions: true,
            },
            {
              path: context.pmPath,
              noExtensions: true,
            },
          );
          expect((started.run as { requested_by?: string }).requested_by).toBe("unknown");
        });
      } finally {
        userInfoSpy.mockRestore();
      }
    });
  });
});

describe("background test run lifecycle", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects invalid records and empty background command arguments", async () => {
    await withTempPmPath(async (context) => {
      await expect(readBackgroundTestRunRecord(context.pmPath, "missing-run")).resolves.toBeNull();
      await expect(listBackgroundTestRuns(context.pmPath, {})).resolves.toEqual([]);
      await expect(getBackgroundTestRunStatus(context.pmPath, "missing-run")).rejects.toThrow(
        "Background test run missing-run not found",
      );
      await expect(spawnBackgroundTestRunWorker({ pmRoot: context.pmPath, runId: "missing-run" })).rejects.toThrow(
        "Background test run missing-run not found",
      );
      await expect(runBackgroundTestRunWorker(context.pmPath, "missing-run")).rejects.toThrow(
        "Background test run missing-run not found",
      );
      await expect(runTestRunsStop("missing-run", {}, { path: context.pmPath })).rejects.toThrow(
        "Background test run missing-run not found",
      );
      await expect(runTestRunsResume("missing-run", {}, { path: context.pmPath })).rejects.toThrow(
        "Background test run missing-run not found",
      );
      await expect(runTestRunsLogs("missing-run", {}, { path: context.pmPath })).rejects.toThrow(
        "Background test run missing-run not found",
      );
      await expect(
        startBackgroundTestRun({
          pmRoot: context.pmPath,
          globalPmRoot: context.globalPmPath,
          kind: "test",
          commandArgs: [" ", ""],
          requestedBy: "unit",
        }),
      ).rejects.toThrow("Background test run requires command arguments.");

      const started = await startBackgroundTestRun({
        pmRoot: context.pmPath,
        globalPmRoot: context.globalPmPath,
        kind: "test",
        commandArgs: ["test", "pm-demo"],
        requestedBy: "unit",
      });
      await writeJsonFile(getTestRunRecordPath(context.pmPath, started.run.id), {
        ...started.run,
        status: "passed",
        finished_at: "2026-01-01T00:00:00.000Z",
      });
      await expect(spawnBackgroundTestRunWorker({ pmRoot: context.pmPath, runId: started.run.id })).rejects.toThrow(
        "is already terminal (passed)",
      );
      await writeFile(getTestRunRecordPath(context.pmPath, started.run.id), "{\"id\": 1}\n", "utf8");

      await expect(readBackgroundTestRunRecord(context.pmPath, started.run.id)).rejects.toThrow(
        "Failed to parse background test run record",
      );
    });
  });

  it("lists, tails logs, marks pidless runs stopped, and refreshes dead active runs", async () => {
    await withTempPmPath(async (context) => {
      const first = await startBackgroundTestRun({
        pmRoot: context.pmPath,
        globalPmRoot: context.globalPmPath,
        kind: "test",
        commandArgs: ["test", "pm-first"],
        requestedBy: "unit",
        targetId: "pm-first",
      });
      const second = await startBackgroundTestRun({
        pmRoot: context.pmPath,
        globalPmRoot: context.globalPmPath,
        kind: "test-all",
        commandArgs: ["test-all", "--status", "open"],
        requestedBy: "unit",
        statusFilter: "open",
      });
      await writeFile(getTestRunStdoutPath(context.pmPath, first.run.id), "one\ntwo\nthree\n", "utf8");
      await writeFile(getTestRunStderrPath(context.pmPath, first.run.id), "err-one\nerr-two\n", "utf8");

      const listResult = await runTestRunsList({ status: "failed", limit: "1" }, { path: context.pmPath });
      expect(listResult.count).toBe(1);
      expect(listResult.filters).toMatchObject({ status: "failed", limit: 1 });
      const defaultListResult = await runTestRunsList({}, { path: context.pmPath });
      expect(defaultListResult.filters).toEqual({});
      await expect(runTestRunsList({ status: "bogus" }, { path: context.pmPath })).rejects.toThrow(
        "Invalid --status value",
      );

      const logs = await runTestRunsLogs(first.run.id, { stream: "both", tail: "2" }, { path: context.pmPath });
      expect(logs.stdout).toEqual(["two", "three"]);
      expect(logs.stderr).toEqual(["err-one", "err-two"]);
      expect(logs.tail).toBe(2);
      const stdoutOnly = await runTestRunsLogs(first.run.id, { stream: "stdout", tail: "0" }, { path: context.pmPath });
      expect(stdoutOnly.stdout).toEqual([]);
      expect(stdoutOnly.stderr).toEqual([]);
      await expect(runTestRunsLogs(first.run.id, { stream: "bogus" }, { path: context.pmPath })).rejects.toThrow(
        "Invalid --stream value",
      );

      const stopRun = await startBackgroundTestRun({
        pmRoot: context.pmPath,
        globalPmRoot: context.globalPmPath,
        kind: "test",
        commandArgs: ["test", "pm-stop"],
        requestedBy: "unit",
      });
      await writeJsonFile(getTestRunRecordPath(context.pmPath, stopRun.run.id), {
        ...stopRun.run,
        status: "running",
        worker_pid: 123_456_789,
      });
      const killSpy = vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
        if (signal === 0) {
          return true;
        }
        throw new Error("signal failed");
      });
      const stopped = await runTestRunsStop(stopRun.run.id, {}, { path: context.pmPath });
      expect(stopped.signal_sent).toBe("none");
      expect((stopped.run as { status?: string }).status).toBe("stopped");
      killSpy.mockRestore();
      const stoppedAgain = await runTestRunsStop(stopRun.run.id, { force: true }, { path: context.pmPath });
      expect(stoppedAgain.signal_sent).toBe("none");
      expect((stoppedAgain.run as { status?: string }).status).toBe("stopped");

      const signalRun = await startBackgroundTestRun({
        pmRoot: context.pmPath,
        globalPmRoot: context.globalPmPath,
        kind: "test",
        commandArgs: ["test", "pm-signal"],
        requestedBy: "unit",
      });
      await writeJsonFile(getTestRunRecordPath(context.pmPath, signalRun.run.id), {
        ...signalRun.run,
        status: "running",
        worker_pid: 234_567_891,
      });
      const signalSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
      const signaled = await runTestRunsStop(signalRun.run.id, { force: true }, { path: context.pmPath });
      expect(signaled.signal_sent).toBe("SIGKILL");
      expect((signaled.run as { progress?: { message?: string } }).progress?.message).toBe("Stop requested via SIGKILL.");
      signalSpy.mockRestore();

      await writeJsonFile(getTestRunRecordPath(context.pmPath, second.run.id), {
        ...second.run,
        status: "running",
        worker_pid: 999_999_991,
        progress: {
          phase: "running",
          message: "worker disappeared",
          heartbeat_at: "2000-01-01T00:00:00.000Z",
        },
      });
      const refreshed = await getBackgroundTestRunStatus(context.pmPath, second.run.id);
      expect(refreshed.run.status).toBe("failed");
      expect(refreshed.run.error).toContain("worker exited");
      expect(refreshed.health.state).toBe("inactive");
    });
  });

  it("requires tracker initialization before listing test runs", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pm-test-runs-not-init-"));
    try {
      await expect(runTestRunsList({}, { path: tempDir })).rejects.toThrow("Tracker is not initialized");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("skips empty record files and reports healthy live runs with resource snapshots", async () => {
    await withTempPmPath(async (context) => {
      const started = await startBackgroundTestRun({
        pmRoot: context.pmPath,
        globalPmRoot: context.globalPmPath,
        kind: "test",
        commandArgs: ["test", "pm-live-resource"],
        requestedBy: "unit",
      });
      await writeFile(getTestRunRecordPath(context.pmPath, "tr-empty-record"), "", "utf8");
      await writeJsonFile(getTestRunRecordPath(context.pmPath, started.run.id), {
        ...started.run,
        status: "running",
        worker_pid: process.pid,
        child_pid: process.pid,
        progress: {
          phase: "running",
          message: "fresh heartbeat",
          heartbeat_at: new Date().toISOString(),
        },
      });

      const listed = await listBackgroundTestRuns(context.pmPath, { limit: -1 });
      expect(listed.map((run) => run.id)).toContain(started.run.id);
      expect(listed.map((run) => run.id)).not.toContain("tr-empty-record");

      const status = await getBackgroundTestRunStatus(context.pmPath, started.run.id);
      expect(status.health.state).toBe("healthy");
      expect(status.health.worker_alive).toBe(true);
      expect(status.health.child_alive).toBe(true);
      // The running record's child pid is this live process, so the status
      // refresh deterministically samples a resource snapshot.
      expect(status.run.resource).toBeDefined();
      expect(Number.isFinite(Date.parse(String(status.run.resource?.recorded_at)))).toBe(true);
    });
  });

  it("reports stale health for live running records and resumes terminal runs", async () => {
    await withTempPmPath(async (context) => {
      const started = await startBackgroundTestRun({
        pmRoot: context.pmPath,
        globalPmRoot: context.globalPmPath,
        kind: "test",
        commandArgs: ["test", "pm-stale"],
        requestedBy: "unit",
      });
      await writeJsonFile(getTestRunRecordPath(context.pmPath, started.run.id), {
        ...started.run,
        status: "running",
        started_at: "2000-01-01T00:00:00.000Z",
        worker_pid: process.pid,
        child_pid: process.pid,
        progress: {
          phase: "running",
          message: "old heartbeat",
          heartbeat_at: "2000-01-01T00:00:00.000Z",
        },
      });

      await withTemporaryEnv("PM_BACKGROUND_RUN_HEARTBEAT_STALE_MS", "1", async () => {
        const status = await runTestRunsStatus(started.run.id, { path: context.pmPath });
        expect((status.health as { state?: string }).state).toBe("stale");
        expect((status.health as { worker_alive?: boolean }).worker_alive).toBe(true);
        expect((status.health as { child_alive?: boolean }).child_alive).toBe(true);
      });

      await expect(resumeBackgroundTestRun(context.pmPath, started.run.id, "unit")).rejects.toThrow(
        "is not terminal and cannot be resumed",
      );

      const terminal = {
        ...(await readBackgroundTestRunRecord(context.pmPath, started.run.id)),
        status: "failed",
        finished_at: "2000-01-01T00:00:01.000Z",
      };
      await writeJsonFile(getTestRunRecordPath(context.pmPath, started.run.id), terminal);
      const cliEntry = path.join(context.tempRoot, "background-entry.cjs");
      await writeFile(cliEntry, "setTimeout(() => process.exit(0), 10);\n", "utf8");

      await withTemporaryEnv("PM_BACKGROUND_CLI_ENTRY", cliEntry, async () => {
        const resumed = await runTestRunsResume(started.run.id, { author: "resume-author", noExtensions: true }, {
          path: context.pmPath,
        });
        const run = resumed.run as { id: string; attempt?: number; resumed_from?: string; resumed_by?: string };
        expect(resumed.resumed_from).toBe(started.run.id);
        expect(run.id).not.toBe(started.run.id);
        expect(run.attempt).toBe(2);
        expect(run.resumed_from).toBe(started.run.id);

        const prior = await readBackgroundTestRunRecord(context.pmPath, started.run.id);
        expect(prior?.resumed_by).toBe(run.id);
      });
    });
  });

  it("deduplicates active runs and resume attempts with the same fingerprint", async () => {
    await withTempPmPath(async (context) => {
      const longArg = "x".repeat(220);
      const active = await startBackgroundTestRun({
        pmRoot: context.pmPath,
        globalPmRoot: context.globalPmPath,
        kind: "test",
        commandArgs: ["test", longArg],
        requestedBy: "unit",
      });
      await writeJsonFile(getTestRunRecordPath(context.pmPath, active.run.id), {
        ...active.run,
        status: "running",
        worker_pid: 345_678_912,
      });
      const killSpy = vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
        if (signal === 0) {
          const error = new Error("permission denied") as Error & { code?: string };
          error.code = "EPERM";
          throw error;
        }
        return true;
      });
      try {
        const duplicate = await startBackgroundTestRun({
          pmRoot: context.pmPath,
          globalPmRoot: context.globalPmPath,
          kind: "test",
          commandArgs: [" test ", longArg],
          requestedBy: "unit",
        });
        expect(duplicate.started).toBe(false);
        expect(duplicate.duplicate_of).toBe(active.run.id);
        expect(duplicate.run.command_label.endsWith("...")).toBe(true);

        const prior = {
          ...active.run,
          id: "tr-prior-duplicate",
          status: "failed",
          finished_at: "2026-01-01T00:00:00.000Z",
          stdout_path: getTestRunStdoutPath(context.pmPath, "tr-prior-duplicate"),
          stderr_path: getTestRunStderrPath(context.pmPath, "tr-prior-duplicate"),
          result_path: getTestRunResultPath(context.pmPath, "tr-prior-duplicate"),
        } as const;
        await writeFile(prior.stdout_path, "", "utf8");
        await writeFile(prior.stderr_path, "", "utf8");
        await writeJsonFile(getTestRunRecordPath(context.pmPath, prior.id), {
          ...prior,
        });
        const resumed = await resumeBackgroundTestRun(context.pmPath, prior.id, "unit");
        expect(resumed.id).toBe(active.run.id);
        expect(resumed.duplicate_of).toBe(active.run.id);
      } finally {
        killSpy.mockRestore();
      }
    });
  });

  it("returns duplicate starts through the command wrapper without spawning another worker", async () => {
    await withTempPmPath(async (context) => {
      const active = await startBackgroundTestRun({
        pmRoot: context.pmPath,
        globalPmRoot: context.globalPmPath,
        kind: "test",
        commandArgs: ["test", "pm-wrapper-duplicate"],
        requestedBy: "unit",
      });
      await writeJsonFile(getTestRunRecordPath(context.pmPath, active.run.id), {
        ...active.run,
        status: "running",
        worker_pid: process.pid,
      });

      const duplicate = await runStartBackgroundRun(
        {
          kind: "test",
          commandArgs: [" test ", "pm-wrapper-duplicate"],
          author: "wrapper-unit",
          noExtensions: true,
        },
        {
          path: context.pmPath,
          noExtensions: true,
        },
      );

      expect(duplicate.started).toBe(false);
      expect(duplicate.duplicate_of).toBe(active.run.id);
      expect((duplicate.run as { duplicate_of?: string }).duplicate_of).toBe(active.run.id);
    });
  });

  it("runs the background worker through the command wrapper", async () => {
    await withTempPmPath(async (context) => {
      const cliEntry = path.join(context.tempRoot, "worker-wrapper-entry.cjs");
      await writeFile(
        cliEntry,
        [
          "process.stdout.write(JSON.stringify({ run_results: [{ status: 'passed' }] }));",
          "process.exit(0);",
          "",
        ].join("\n"),
        "utf8",
      );

      await withTemporaryEnv("PM_BACKGROUND_CLI_ENTRY", cliEntry, async () => {
        const started = await startBackgroundTestRun({
          pmRoot: context.pmPath,
          globalPmRoot: context.globalPmPath,
          kind: "test",
          commandArgs: ["test", "pm-worker-wrapper"],
          requestedBy: "unit",
        });

        const result = await runTestRunsWorker(started.run.id, {
          path: context.pmPath,
          noExtensions: true,
        });

        expect(result).toMatchObject({
          id: started.run.id,
          status: "passed",
          exit_code: 0,
        });
      });
    });
  });

  it("falls back to argv entrypoint and reports missing background CLI entrypoints", async () => {
    await withTempPmPath(async (context) => {
      const previousArgvEntry = process.argv[1];
      const argvEntry = path.join(context.tempRoot, "argv-background-entry.cjs");
      await writeFile(
        argvEntry,
        [
          "process.stdout.write(JSON.stringify({ run_results: [{ status: 'passed' }] }));",
          "process.exit(0);",
          "",
        ].join("\n"),
        "utf8",
      );

      try {
        process.argv[1] = argvEntry;
        await withTemporaryEnv("PM_BACKGROUND_CLI_ENTRY", "./missing-configured-entry.cjs", async () => {
          await withTemporaryCwd(context.tempRoot, async () => {
            const started = await startBackgroundTestRun({
              pmRoot: context.pmPath,
              globalPmRoot: context.globalPmPath,
              kind: "test",
              commandArgs: ["test", "pm-argv-entry"],
              requestedBy: "unit",
            });
            const result = await runBackgroundTestRunWorker(context.pmPath, started.run.id);
            expect(result.status).toBe("passed");

            process.argv[1] = path.join(context.tempRoot, "missing-entry.cjs");
            const missingEntry = await startBackgroundTestRun({
              pmRoot: context.pmPath,
              globalPmRoot: context.globalPmPath,
              kind: "test",
              commandArgs: ["test", "pm-missing-entry"],
              requestedBy: "unit",
            });
            await expect(runBackgroundTestRunWorker(context.pmPath, missingEntry.run.id)).rejects.toThrow(
              "Unable to resolve a CLI entrypoint",
            );
          });
        });
      } finally {
        if (previousArgvEntry === undefined) {
          process.argv.splice(1, 1);
        } else {
          process.argv[1] = previousArgvEntry;
        }
      }
    });
  });

  it("runs workers through passed, failed, and invalid-json result paths", async () => {
    await withTempPmPath(async (context) => {
      const cliEntry = path.join(context.tempRoot, "worker-entry.cjs");
      await writeFile(
        cliEntry,
        [
          "const mode = process.argv.at(-1);",
          "if (mode === 'pass') {",
          "  process.stderr.write('[pm test] linked-test 1/2 start elapsed_ms=7\\n');",
          "  process.stdout.write(JSON.stringify({ run_results: [{ status: 'passed' }, { status: 'skipped' }] }));",
          "  process.exit(0);",
          "}",
          "if (mode === 'test-all') {",
          "  process.stderr.write('[pm test-all] item 1/2 start id=pm-itema linked_tests=1\\n');",
          "  process.stderr.write('[pm test] linked-test 1/3 running elapsed_ms=25 command=\"node slow.js\"\\n');",
          "  process.stderr.write('[pm test-all] item 2/2 end id=pm-itemb status=failed passed=0 failed=1 skipped=0\\n');",
          "  process.stdout.write(JSON.stringify({ totals: { items: 2, linked_tests: 3, passed: 1, failed: 1, skipped: 1 }, fail_on_skipped_triggered: true }));",
          "  process.exit(0);",
          "}",
          "process.stdout.write('not json');",
          "process.exit(1);",
          "",
        ].join("\n"),
        "utf8",
      );

      await withTemporaryEnv("PM_BACKGROUND_CLI_ENTRY", cliEntry, async () => {
        const passRun = await startBackgroundTestRun({
          pmRoot: context.pmPath,
          globalPmRoot: context.globalPmPath,
          kind: "test",
          commandArgs: ["pass"],
          requestedBy: "unit",
        });
        const passed = await runBackgroundTestRunWorker(context.pmPath, passRun.run.id, true);
        expect(passed.status).toBe("passed");
        expect(passed.summary).toMatchObject({ passed: 1, failed: 0, skipped: 1 });
        expect(passed.progress?.linked_test_index).toBe(1);
        expect(JSON.parse(await readFile(getTestRunResultPath(context.pmPath, passRun.run.id), "utf8"))).toMatchObject({
          run_results: [{ status: "passed" }, { status: "skipped" }],
        });

        const allRun = await startBackgroundTestRun({
          pmRoot: context.pmPath,
          globalPmRoot: context.globalPmPath,
          kind: "test-all",
          commandArgs: ["test-all"],
          requestedBy: "unit",
        });
        const failedTotals = await runBackgroundTestRunWorker(context.pmPath, allRun.run.id);
        expect(failedTotals.status).toBe("failed");
        expect(failedTotals.summary).toMatchObject({
          items: 2,
          linked_tests: 3,
          passed: 1,
          failed: 1,
          skipped: 1,
          fail_on_skipped_triggered: true,
        });
        expect(failedTotals.progress).toMatchObject({
          item_index: 2,
          item_total: 2,
          item_id: "pm-itemb",
        });
        expect(failedTotals.progress?.linked_test_index).toBeUndefined();
        expect(failedTotals.progress?.linked_test_total).toBeUndefined();
        expect(failedTotals.progress?.current_command).toBeUndefined();

        const badJsonRun = await startBackgroundTestRun({
          pmRoot: context.pmPath,
          globalPmRoot: context.globalPmPath,
          kind: "test",
          commandArgs: ["bad-json"],
          requestedBy: "unit",
        });
        const failedParse = await runBackgroundTestRunWorker(context.pmPath, badJsonRun.run.id);
        expect(failedParse.status).toBe("failed");
        expect(failedParse.summary).toMatchObject({ passed: 0, failed: 1, skipped: 0 });
        expect(JSON.parse(await readFile(getTestRunResultPath(context.pmPath, badJsonRun.run.id), "utf8"))).toMatchObject({
          parse_error: "Background run output was not valid JSON.",
          stdout_excerpt: ["not json"],
        });
      });
    });
  });

  it("stops a running worker on process signals and records resource heartbeats", async () => {
    await withTempPmPath(async (context) => {
      const cliEntry = path.join(context.tempRoot, "worker-signal-entry.cjs");
      await writeFile(
        cliEntry,
        [
          "let stopped = false;",
          "process.on('SIGTERM', () => {",
          "  stopped = true;",
          "  process.stderr.write('[pm test-all] item 1/1 end id=pm-stop status=failed\\n');",
          "});",
          "const timer = setInterval(() => {",
          "  if (!stopped) {",
          "    process.stderr.write('[pm test] linked-test 1/1 running elapsed_ms=15\\n');",
          "    process.stderr.write('[pm test-all] item 1/1 start id=pm-stop linked_tests=1\\n');",
          "  } else {",
          "    clearInterval(timer);",
          "  }",
          "}, 1);",
          "",
        ].join("\n"),
        "utf8",
      );

      await withTemporaryEnv("PM_BACKGROUND_CLI_ENTRY", cliEntry, async () => {
        await withTemporaryEnv("PM_BACKGROUND_RUN_FORCE_KILL_DELAY_MS", "10", async () => {
          await withTemporaryEnv("PM_BACKGROUND_RUN_RESOURCE_INTERVAL_MS", "1", async () => {
            const started = await startBackgroundTestRun({
              pmRoot: context.pmPath,
              globalPmRoot: context.globalPmPath,
              kind: "test",
              commandArgs: ["signal-stop"],
              requestedBy: "unit",
            });

            let workerFinished = false;
            const { sigtermHandlers, sigintHandlers, restore } = captureProcessSignalHandlers();
            const signalWhenProgressReady = dispatchSignalsWhenProgressReady({
              stderrPath: getTestRunStderrPath(context.pmPath, started.run.id),
              marker: "id=pm-stop",
              isWorkerFinished: () => workerFinished,
              signalGroups: [
                { signal: "SIGTERM", handlers: sigtermHandlers },
                { signal: "SIGINT", handlers: sigintHandlers },
              ],
            }).catch(() => undefined);
            const stopped = await runBackgroundTestRunWorker(context.pmPath, started.run.id, true).finally(async () => {
              workerFinished = true;
              try {
                await signalWhenProgressReady;
              } finally {
                restore();
              }
            });
            expect(stopped.status).toBe("stopped");
            expect(stopped.stop_requested_at).toBeDefined();
            expect(stopped.progress).toMatchObject({
              phase: "finished",
              message: "Background run stopped.",
              item_id: "pm-stop",
            });
            expect([undefined, 1]).toContain(stopped.progress?.linked_test_index);
            expect([undefined, 1]).toContain(stopped.progress?.linked_test_total);
            expect([undefined, 15]).toContain(stopped.progress?.elapsed_ms);
            expect(stopped.progress?.current_command).toBeUndefined();
            // Resource sampling is time-dependent here: the final snapshot sees a dead child, but the 1ms timer may have recorded one.
            expect(stopped.resource === undefined || Number.isFinite(Date.parse(String(stopped.resource.recorded_at)))).toBe(true);
            await expect(readFile(getTestRunStderrPath(context.pmPath, started.run.id), "utf8")).resolves.toContain(
              "linked-test 1/1 running",
            );
          });
        });
      });
    });
  });

  it("covers background run result evaluation and log parsing helper branches", async () => {
    const fingerprintA = buildBackgroundTestRunFingerprint("test", [" test ", "", "--", "spec.ts"], "/tmp/pm-a");
    const fingerprintB = buildBackgroundTestRunFingerprint("test", ["test", "--", "spec.ts"], "/tmp/pm-a");
    const fingerprintC = buildBackgroundTestRunFingerprint("test-all", ["test", "--", "spec.ts"], "/tmp/pm-a");
    expect(fingerprintA).toMatch(/^[a-f0-9]{64}$/);
    expect(fingerprintA).toBe(fingerprintB);
    expect(fingerprintA).not.toBe(fingerprintC);

    expect(backgroundRunsTestOnly.evaluateWorkerResult("test", null)).toMatchObject({
      summary: { passed: 0, failed: 1, skipped: 0 },
      parsedResult: null,
    });
    expect(
      backgroundRunsTestOnly.evaluateWorkerResult("test", {
        run_results: [null, "bad", { status: "failed" }, { status: "unknown" }],
        fail_on_skipped_triggered: true,
      }),
    ).toMatchObject({
      summary: { passed: 0, failed: 1, skipped: 1, fail_on_skipped_triggered: true },
    });
    expect(backgroundRunsTestOnly.evaluateWorkerResult("test-all", { totals: { passed: "1" } })).toMatchObject({
      summary: { passed: 0, failed: 0, skipped: 0 },
    });
    expect(
      backgroundRunsTestOnly.evaluateWorkerResult("test-all", {
        totals: { items: 2, linked_tests: 3, passed: 1, failed: 0, skipped: 2 },
        fail_on_skipped_triggered: true,
      }),
    ).toMatchObject({
      summary: { items: 2, linked_tests: 3, passed: 1, failed: 0, skipped: 2, fail_on_skipped_triggered: true },
    });
    expect(backgroundRunsTestOnly.evaluateWorkerResult("test-all", { fail_on_skipped_triggered: false })).toMatchObject({
      summary: { passed: 0, failed: 0, skipped: 0, fail_on_skipped_triggered: undefined },
    });
    expect(backgroundRunsTestOnly.evaluateWorkerResult("test", { run_results: "not-an-array" })).toMatchObject({
      summary: { passed: 0, failed: 0, skipped: 0, fail_on_skipped_triggered: undefined },
    });

    expect(backgroundRunsTestOnly.parseProgressLine("")).toBeNull();
    expect(backgroundRunsTestOnly.parseProgressLine("plain stderr")).toBeNull();
    expect(backgroundRunsTestOnly.parseProgressLine("[pm test] linked-test 2/5 end")).toMatchObject({
      linked_test_index: 2,
      linked_test_total: 5,
      phase: "finished",
    });
    expect(backgroundRunsTestOnly.parseProgressLine("[pm test-all] item 4/9 start id=pm-abc linked_tests=2")).toMatchObject({
      item_index: 4,
      item_total: 9,
      item_id: "pm-abc",
      linked_test_index: undefined,
      linked_test_total: undefined,
      current_command: undefined,
      phase: "running",
    });
    expect(
      backgroundRunsTestOnly.parseProgressLine(
        "[pm test-all] item 4/9 end id=pm-abc status=passed passed=1 failed=0 skipped=0",
      ),
    ).toMatchObject({
      item_index: 4,
      item_total: 9,
      item_id: "pm-abc",
      phase: "finished",
    });
    expect(backgroundRunsTestOnly.parseProgressLine("[pm test] linked-test bad/5 end")).toBeNull();
    expect(
      backgroundRunsTestOnly.parseProgressLine('[pm test] linked-test 3/5 start elapsed_ms=120 command="node spec.js"'),
    ).toMatchObject({
      linked_test_index: 3,
      linked_test_total: 5,
      current_command: "node spec.js",
      elapsed_ms: 120,
      phase: "running",
    });
    expect(
      backgroundRunsTestOnly.parseProgressLine('[pm test] linked-test 3/5 start command="node \\"quoted\\" \\\\path"'),
    ).toMatchObject({
      current_command: 'node "quoted" \\path',
    });
    expect(backgroundRunsTestOnly.splitLines("one\n\ntwo  \n")).toEqual(["one", "two"]);
    expect(backgroundRunsTestOnly.tailLines("one\ntwo\n", 10)).toEqual(["one", "two"]);
    expect(backgroundRunsTestOnly.tailLines("one\ntwo\nthree\n", 2)).toEqual(["two", "three"]);
    expect(backgroundRunsTestOnly.tailLines("one\n", 0)).toEqual([]);
    expect(backgroundRunsTestOnly.isPidRunning(undefined)).toBe(false);
    expect(backgroundRunsTestOnly.isPidRunning(-1)).toBe(false);

    const killUnknownSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw "killed";
    });
    expect(backgroundRunsTestOnly.isPidRunning(process.pid)).toBe(false);
    killUnknownSpy.mockRestore();

    const killEpermSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      const err = new Error("perm") as NodeJS.ErrnoException;
      err.code = "EPERM";
      throw err;
    });
    expect(backgroundRunsTestOnly.isPidRunning(process.pid)).toBe(true);
    killEpermSpy.mockRestore();

    await withTemporaryPlatform("darwin", async () => {
      await expect(backgroundRunsTestOnly.readLinuxRssBytes(process.pid)).resolves.toBeUndefined();
      await expect(backgroundRunsTestOnly.readLinuxCpuSeconds(process.pid)).resolves.toEqual({});
    });
    await expect(backgroundRunsTestOnly.readLinuxRssBytes(-1)).resolves.toBeUndefined();
    expect(backgroundRunsTestOnly.parseLinuxRssStatus("Name:\tproc\nVmRSS:\t1234 kB\n")).toBe(1234 * 1024);
    expect(backgroundRunsTestOnly.parseLinuxRssStatus("Name:\tproc\nVmRSS:\tabc kB\n")).toBeUndefined();
    expect(backgroundRunsTestOnly.parseLinuxCpuStat("pid stat missing-paren-data")).toEqual({});
    expect(backgroundRunsTestOnly.parseLinuxCpuStat("123 (node) R 1 2 3 4 5 6 7 8 9 ten eleven")).toEqual({});

    await expect(backgroundRunsTestOnly.buildResourceSnapshot({ worker_pid: -1 } as never)).resolves.toBeUndefined();
  });

  it("surfaces non-Error parse failures for persisted run records", async () => {
    await withTempPmPath(async (context) => {
      const started = await startBackgroundTestRun({
        pmRoot: context.pmPath,
        globalPmRoot: context.globalPmPath,
        kind: "test",
        commandArgs: ["test", "pm-parse-failure"],
        requestedBy: "unit",
      });
      const parseSpy = vi.spyOn(JSON, "parse").mockImplementation(() => {
        throw "string-parse-error";
      });
      await expect(readBackgroundTestRunRecord(context.pmPath, started.run.id)).rejects.toThrow("string-parse-error");
      parseSpy.mockRestore();
    });
  });

  it("applies readBackgroundTestRunLogs fallbacks for missing files and invalid tail values", async () => {
    await withTempPmPath(async (context) => {
      const started = await startBackgroundTestRun({
        pmRoot: context.pmPath,
        globalPmRoot: context.globalPmPath,
        kind: "test",
        commandArgs: ["test", "pm-log-fallbacks"],
        requestedBy: "unit",
      });
      await fsPromises.rm(started.run.stdout_path, { force: true });
      await fsPromises.rm(started.run.stderr_path, { force: true });

      const stdoutOnly = await readBackgroundTestRunLogs(context.pmPath, started.run.id, "stdout", Number.NaN);
      expect(stdoutOnly.tail).toBe(100);
      expect(stdoutOnly.stdout).toEqual([]);
      expect(stdoutOnly.stderr).toEqual([]);

      const both = await readBackgroundTestRunLogs(context.pmPath, started.run.id, "both", undefined);
      expect(both.tail).toBe(100);
      expect(both.stdout).toEqual([]);
      expect(both.stderr).toEqual([]);

      const stderrOnly = await readBackgroundTestRunLogs(context.pmPath, started.run.id, "stderr", 5);
      expect(stderrOnly.stdout).toEqual([]);
      expect(stderrOnly.stderr).toEqual([]);
    });
  });

  it("falls back from missing configured CLI entry and spawns without --no-extensions", async () => {
    await withTempPmPath(async (context) => {
      const started = await startBackgroundTestRun({
        pmRoot: context.pmPath,
        globalPmRoot: context.globalPmPath,
        kind: "test",
        commandArgs: ["test", "pm-spawn-default"],
        requestedBy: "unit",
      });
      await withTemporaryEnv("PM_BACKGROUND_CLI_ENTRY", "./missing-background-cli-entry.cjs", async () => {
        const spawned = await spawnBackgroundTestRunWorker({
          pmRoot: context.pmPath,
          runId: started.run.id,
        });
        expect(spawned.id).toBe(started.run.id);
      });
    });
  });

  it("handles stderr chunks without progress markers", async () => {
    await withTempPmPath(async (context) => {
      const cliEntry = path.join(context.tempRoot, "worker-empty-stderr-entry.cjs");
      await writeFile(
        cliEntry,
        [
          "process.stderr.write('\\n');",
          "process.stdout.write(JSON.stringify({ run_results: [{ status: 'passed' }] }));",
          "process.exit(0);",
          "",
        ].join("\n"),
        "utf8",
      );
      await withTemporaryEnv("PM_BACKGROUND_CLI_ENTRY", cliEntry, async () => {
        const started = await startBackgroundTestRun({
          pmRoot: context.pmPath,
          globalPmRoot: context.globalPmPath,
          kind: "test",
          commandArgs: ["empty-stderr"],
          requestedBy: "unit",
        });
        const run = await runBackgroundTestRunWorker(context.pmPath, started.run.id);
        expect(run.status).toBe("passed");
        expect(run.progress?.phase).toBe("finished");
      });
    });
  });

  it("reports running status with missing heartbeat metadata", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const started = await startBackgroundTestRun({
        pmRoot: pmPath,
        globalPmRoot: pmPath,
        kind: "test",
        commandArgs: ["test", "pm-no-heartbeat"],
        requestedBy: "unit-author",
      });
      await writeJsonFile(getTestRunRecordPath(pmPath, started.run.id), {
        ...started.run,
        status: "running",
        worker_pid: process.pid,
        child_pid: process.pid,
        progress: undefined,
      });

      const status = await getBackgroundTestRunStatus(pmPath, started.run.id);
      expect(status.run.status).toBe("running");
      expect(status.health.last_heartbeat_at).toBeUndefined();
      expect(status.health.heartbeat_lag_ms).toBeUndefined();
    });
  });

  it("falls back to default force-kill delay when unset", async () => {
    await withTempPmPath(async (context) => {
      const cliEntry = path.join(context.tempRoot, "worker-default-force-delay.cjs");
      await writeFile(
        cliEntry,
        [
          "process.on('SIGTERM', () => {});",
          "setInterval(() => process.stderr.write('[pm test] linked-test 1/1 running elapsed_ms=10\\n'), 1);",
          "",
        ].join("\n"),
        "utf8",
      );

      const previousForceDelay = process.env.PM_BACKGROUND_RUN_FORCE_KILL_DELAY_MS;
      delete process.env.PM_BACKGROUND_RUN_FORCE_KILL_DELAY_MS;
      try {
        await withTemporaryEnv("PM_BACKGROUND_CLI_ENTRY", cliEntry, async () => {
          await withTemporaryEnv("PM_BACKGROUND_RUN_RESOURCE_INTERVAL_MS", "1", async () => {
            const started = await startBackgroundTestRun({
              pmRoot: context.pmPath,
              globalPmRoot: context.globalPmPath,
              kind: "test",
              commandArgs: ["signal-stop-default-delay"],
              requestedBy: "unit",
            });
            let workerFinished = false;
            const { sigtermHandlers, restore } = captureProcessSignalHandlers();
            const signalWhenProgressReady = dispatchSignalsWhenProgressReady({
              stderrPath: getTestRunStderrPath(context.pmPath, started.run.id),
              marker: "linked-test 1/1 running",
              isWorkerFinished: () => workerFinished,
              signalGroups: [{ signal: "SIGTERM", handlers: sigtermHandlers }],
            }).catch(() => undefined);
            const stopped = await runBackgroundTestRunWorker(context.pmPath, started.run.id, true).finally(async () => {
              workerFinished = true;
              try {
                await signalWhenProgressReady;
              } finally {
                restore();
              }
            });
            expect(stopped.status).toBe("stopped");
            expect(stopped.progress?.phase).toBe("finished");
          });
        });
      } finally {
        if (previousForceDelay === undefined) {
          delete process.env.PM_BACKGROUND_RUN_FORCE_KILL_DELAY_MS;
        } else {
          process.env.PM_BACKGROUND_RUN_FORCE_KILL_DELAY_MS = previousForceDelay;
        }
      }
    });
  });

  it("keeps running phase when worker emits finished progress lines before completion", async () => {
    await withTempPmPath(async (context) => {
      const cliEntry = path.join(context.tempRoot, "worker-finished-progress-entry.cjs");
      await writeFile(
        cliEntry,
        [
          "process.stderr.write('[pm test] linked-test 1/1 end elapsed_ms=12\\n');",
          "process.stdout.write(JSON.stringify({ run_results: [{ status: 'passed' }] }));",
          "process.exit(0);",
          "",
        ].join("\n"),
        "utf8",
      );

      await withTemporaryEnv("PM_BACKGROUND_CLI_ENTRY", cliEntry, async () => {
        const started = await startBackgroundTestRun({
          pmRoot: context.pmPath,
          globalPmRoot: context.globalPmPath,
          kind: "test",
          commandArgs: ["finished-progress"],
          requestedBy: "unit",
        });
        const run = await runBackgroundTestRunWorker(context.pmPath, started.run.id);
        expect(run.status).toBe("passed");
        expect(run.progress?.phase).toBe("finished");
        expect(run.progress?.linked_test_index).toBe(1);
        expect(run.progress?.elapsed_ms).toBe(12);
      });
    });
  });

  it("keeps structured progress stable across plain stderr and split progress lines", async () => {
    await withTempPmPath(async (context) => {
      const cliEntry = path.join(context.tempRoot, "worker-non-progress-entry.cjs");
      await writeFile(
        cliEntry,
        [
          "const mode = process.argv.at(-1);",
          "if (mode === 'seeded') {",
          "  process.stderr.write('[pm test] linked-test 1/1 running elapsed_ms=9\\n');",
          "  setTimeout(() => {",
          "    process.stderr.write('plain stderr message\\n');",
          "    process.stdout.write(JSON.stringify({ run_results: [{ status: 'passed' }] }));",
          "    process.exit(0);",
          "  }, 0);",
          "  return;",
          "} else if (mode === 'split') {",
          "  process.stderr.write('[pm test-all] item 1/1 start id=pm-split');",
          "  setTimeout(() => {",
          "    process.stderr.write(' linked_tests=1\\n');",
          "    process.stdout.write(JSON.stringify({ totals: { items: 1, linked_tests: 1, passed: 1, failed: 0, skipped: 0 } }));",
          "    process.exit(0);",
          "  }, 0);",
          "  return;",
          "} else if (mode === 'trailing') {",
          "  process.stderr.write('[pm test-all] item 1/1 start id=pm-trailing linked_tests=1');",
          "  process.stdout.write(JSON.stringify({ totals: { items: 1, linked_tests: 1, passed: 1, failed: 0, skipped: 0 } }));",
          "  process.exit(0);",
          "  return;",
          "} else {",
          "  process.stderr.write('another plain stderr message\\n');",
          "  process.stdout.write(JSON.stringify({ run_results: [{ status: 'passed' }] }));",
          "  process.exit(0);",
          "  return;",
          "}",
          "",
        ].join("\n"),
        "utf8",
      );

      await withTemporaryEnv("PM_BACKGROUND_CLI_ENTRY", cliEntry, async () => {
        const seeded = await startBackgroundTestRun({
          pmRoot: context.pmPath,
          globalPmRoot: context.globalPmPath,
          kind: "test",
          commandArgs: ["seeded"],
          requestedBy: "unit",
        });
        const seededRun = await runBackgroundTestRunWorker(context.pmPath, seeded.run.id);
        expect(seededRun.status).toBe("passed");
        expect(seededRun.progress?.linked_test_index).toBe(1);
        expect(seededRun.progress?.elapsed_ms).toBe(9);

        const split = await startBackgroundTestRun({
          pmRoot: context.pmPath,
          globalPmRoot: context.globalPmPath,
          kind: "test-all",
          commandArgs: ["split"],
          requestedBy: "unit",
        });
        const splitRun = await runBackgroundTestRunWorker(context.pmPath, split.run.id);
        expect(splitRun.status).toBe("passed");
        expect(splitRun.progress?.item_id).toBe("pm-split");
        expect(splitRun.progress?.item_index).toBe(1);

        const trailing = await startBackgroundTestRun({
          pmRoot: context.pmPath,
          globalPmRoot: context.globalPmPath,
          kind: "test-all",
          commandArgs: ["trailing"],
          requestedBy: "unit",
        });
        const trailingRun = await runBackgroundTestRunWorker(context.pmPath, trailing.run.id);
        expect(trailingRun.status).toBe("passed");
        expect(trailingRun.progress?.item_id).toBe("pm-trailing");

        const plain = await startBackgroundTestRun({
          pmRoot: context.pmPath,
          globalPmRoot: context.globalPmPath,
          kind: "test",
          commandArgs: ["plain"],
          requestedBy: "unit",
        });
        const plainRun = await runBackgroundTestRunWorker(context.pmPath, plain.run.id);
        expect(plainRun.progress?.linked_test_index).toBeUndefined();
        expect(plainRun.progress?.linked_test_total).toBeUndefined();
      });
    });
  });

  it("truncates long command labels and reports healthy running records", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const longArgument = "segment".repeat(40);
      const started = await startBackgroundTestRun({
        pmRoot: pmPath,
        globalPmRoot: pmPath,
        kind: "test",
        commandArgs: ["test", longArgument, "tail"],
        requestedBy: "unit-author",
      });
      expect(started.run.command_label).toHaveLength(180);
      expect(started.run.command_label.endsWith("...")).toBe(true);

      await writeJsonFile(getTestRunRecordPath(pmPath, started.run.id), {
        ...started.run,
        status: "running",
        worker_pid: process.pid,
        child_pid: -1,
        finished_at: undefined,
        error: undefined,
        progress: {
          phase: "running",
          message: "fresh heartbeat",
          heartbeat_at: new Date().toISOString(),
        },
      });

      const status = await getBackgroundTestRunStatus(pmPath, started.run.id);
      expect(status.run.status).toBe("running");
      expect(status.health.state).toBe("healthy");
      expect(status.health.worker_alive).toBe(true);
      expect(status.health.child_alive).toBe(false);
      expect(status.health.heartbeat_lag_ms).toBeGreaterThanOrEqual(0);
    });
  });

  it("marks abandoned running records failed and reports stale running health", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const started = await startBackgroundTestRun({
        pmRoot: pmPath,
        globalPmRoot: pmPath,
        kind: "test",
        commandArgs: ["test", "--", "tests/unit/example.spec.ts"],
        requestedBy: "unit-author",
      });
      const staleHeartbeat = new Date(Date.now() - 60_000).toISOString();
      await writeJsonFile(getTestRunRecordPath(pmPath, started.run.id), {
        ...started.run,
        status: "running",
        worker_pid: -1,
        child_pid: -1,
        progress: {
          phase: "running",
          message: "still running",
          heartbeat_at: staleHeartbeat,
        },
      });

      const deadStatus = await getBackgroundTestRunStatus(pmPath, started.run.id);
      expect(deadStatus.run.status).toBe("failed");
      expect(deadStatus.run.error).toBe("Background test run worker exited before writing terminal status.");
      expect(deadStatus.health.state).toBe("inactive");

      const healthyPid = process.pid;
      const running = {
        ...deadStatus.run,
        status: "running",
        finished_at: undefined,
        error: undefined,
        worker_pid: healthyPid,
        child_pid: healthyPid,
        progress: {
          phase: "running",
          message: "still running",
          heartbeat_at: staleHeartbeat,
        },
      };
      await writeJsonFile(getTestRunRecordPath(pmPath, started.run.id), running);
      await withTemporaryEnv("PM_BACKGROUND_RUN_HEARTBEAT_STALE_MS", "1", async () => {
        const staleStatus = await getBackgroundTestRunStatus(pmPath, started.run.id);
        expect(staleStatus.run.status).toBe("running");
        expect(staleStatus.health.state).toBe("stale");
        expect(staleStatus.health.worker_alive).toBe(true);
        expect(staleStatus.health.child_alive).toBe(true);
        if (typeof staleStatus.run.resource?.rss_bytes === "number") {
          expect(staleStatus.run.resource.rss_bytes).toBeGreaterThan(0);
        }
      });
    });
  });

  it("marks fresh running records failed when both worker processes are gone", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const started = await startBackgroundTestRun({
        pmRoot: pmPath,
        globalPmRoot: pmPath,
        kind: "test",
        commandArgs: ["test", "--", "tests/unit/example.spec.ts"],
        requestedBy: "unit-author",
      });
      await writeJsonFile(getTestRunRecordPath(pmPath, started.run.id), {
        ...started.run,
        status: "running",
        worker_pid: -1,
        child_pid: -1,
        finished_at: undefined,
        error: undefined,
        progress: {
          phase: "running",
          message: "fresh heartbeat",
          heartbeat_at: new Date().toISOString(),
        },
      });

      const status = await getBackgroundTestRunStatus(pmPath, started.run.id);
      expect(status.run.status).toBe("failed");
      expect(status.run.error).toBe("Background test run worker exited before writing terminal status.");
      expect(status.health.worker_alive).toBe(false);
      expect(status.health.child_alive).toBe(false);
    });
  });

  it("covers pid liveness transitions for stale refresh and active duplicate checks", async () => {
    await withTempPmPath(async ({ pmPath, globalPmPath }) => {
      const finished = await startBackgroundTestRun({
        pmRoot: pmPath,
        globalPmRoot: globalPmPath,
        kind: "test",
        commandArgs: ["test", "already-finished"],
        requestedBy: "unit-author",
      });
      const finishedRunning = {
        ...finished.run,
        status: "running",
        worker_pid: -1,
        finished_at: "2026-01-01T00:00:00.000Z",
      } as const;
      await expect(backgroundRunsTestOnly.refreshRunIfStale(pmPath, finishedRunning)).resolves.toMatchObject({
        status: "running",
        finished_at: "2026-01-01T00:00:00.000Z",
      });

      const active = await startBackgroundTestRun({
        pmRoot: pmPath,
        globalPmRoot: globalPmPath,
        kind: "test",
        commandArgs: ["test", "pid-transition"],
        requestedBy: "unit-author",
      });
      await writeJsonFile(getTestRunRecordPath(pmPath, active.run.id), {
        ...active.run,
        status: "running",
        worker_pid: 123_123_123,
        child_pid: -1,
        finished_at: undefined,
        progress: {
          phase: "running",
          message: "fresh heartbeat",
          heartbeat_at: new Date().toISOString(),
        },
      });

      const killSpy = vi.spyOn(process, "kill");
      killSpy
        .mockImplementationOnce(() => true)
        .mockImplementationOnce(() => {
          const error = new Error("gone") as Error & { code?: string };
          error.code = "ESRCH";
          throw error;
        });
      const replacement = await startBackgroundTestRun({
        pmRoot: pmPath,
        globalPmRoot: globalPmPath,
        kind: "test",
        commandArgs: ["test", "pid-transition"],
        requestedBy: "unit-author",
      });
      expect(replacement.started).toBe(true);
      expect(replacement.run.id).not.toBe(active.run.id);
      killSpy.mockRestore();

      const statusRun = await startBackgroundTestRun({
        pmRoot: pmPath,
        globalPmRoot: globalPmPath,
        kind: "test",
        commandArgs: ["test", "dies-between-refresh-and-status"],
        requestedBy: "unit-author",
      });
      await writeJsonFile(getTestRunRecordPath(pmPath, statusRun.run.id), {
        ...statusRun.run,
        status: "running",
        worker_pid: 456_456_456,
        child_pid: -1,
        finished_at: undefined,
        error: undefined,
        progress: {
          phase: "running",
          message: "fresh heartbeat",
          heartbeat_at: new Date().toISOString(),
        },
      });
      const transitionSpy = vi.spyOn(process, "kill");
      transitionSpy
        .mockImplementationOnce(() => true)
        .mockImplementationOnce(() => {
          const error = new Error("worker disappeared") as Error & { code?: string };
          error.code = "ESRCH";
          throw error;
        })
        .mockImplementationOnce(() => {
          const error = new Error("child disappeared") as Error & { code?: string };
          error.code = "ESRCH";
          throw error;
        });
      const status = await getBackgroundTestRunStatus(pmPath, statusRun.run.id);
      expect(status.run.status).toBe("failed");
      expect(status.run.error).toBe("Background run process exited unexpectedly.");
      expect(status.health.worker_alive).toBe(false);
      expect(status.health.child_alive).toBe(false);
      transitionSpy.mockRestore();
    });
  });

  it("covers spawn defaults, missing heartbeats, and stderr-only log tails", async () => {
    await withTempPmPath(async (context) => {
      const cliEntry = path.join(context.tempRoot, "spawn-default-entry.cjs");
      await writeFile(
        cliEntry,
        [
          "process.stdout.write(JSON.stringify({ run_results: [{ status: 'passed' }] }));",
          "process.exit(0);",
          "",
        ].join("\n"),
        "utf8",
      );
      const started = await startBackgroundTestRun({
        pmRoot: context.pmPath,
        globalPmRoot: context.globalPmPath,
        kind: "test",
        commandArgs: ["spawn-defaults"],
        requestedBy: "unit",
      });

      await withTemporaryEnv("PM_BACKGROUND_CLI_ENTRY", cliEntry, async () => {
        const spawned = await spawnBackgroundTestRunWorker({
          pmRoot: context.pmPath,
          runId: started.run.id,
        });
        expect(spawned.status).toBe("queued");
      });

      await writeJsonFile(getTestRunRecordPath(context.pmPath, started.run.id), {
        ...started.run,
        status: "running",
        worker_pid: process.pid,
        child_pid: -1,
        progress: {
          phase: "running",
          message: "heartbeat missing",
        },
      });
      const status = await getBackgroundTestRunStatus(context.pmPath, started.run.id);
      expect(status.health.last_heartbeat_at).toBeUndefined();
      expect(status.health.heartbeat_lag_ms).toBeUndefined();

      await writeFile(started.run.stderr_path, "err-a\nerr-b\n", "utf8");
      const stderrLogs = await readBackgroundTestRunLogs(context.pmPath, started.run.id, "stderr", -1);
      expect(stderrLogs.tail).toBe(100);
      expect(stderrLogs.stdout).toEqual([]);
      expect(stderrLogs.stderr).toEqual(["err-a", "err-b"]);
    });
  });
});
