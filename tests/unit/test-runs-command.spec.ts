import os from "node:os";
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runStartBackgroundRun,
  runTestRunsList,
  runTestRunsLogs,
  runTestRunsResume,
  runTestRunsStatus,
  runTestRunsStop,
  runTestRunsWorker,
} from "../../src/cli/commands/test-runs.js";
import {
  getBackgroundTestRunStatus,
  listBackgroundTestRuns,
  readBackgroundTestRunRecord,
  resumeBackgroundTestRun,
  runBackgroundTestRunWorker,
  spawnBackgroundTestRunWorker,
  startBackgroundTestRun,
} from "../../src/core/test/background-runs.js";
import {
  getTestRunRecordPath,
  getTestRunResultPath,
  getTestRunStderrPath,
  getTestRunStdoutPath,
} from "../../src/core/store/paths.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

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

async function withTemporaryCwd<T>(cwd: string, callback: () => Promise<T>): Promise<T> {
  const previous = process.cwd();
  process.chdir(cwd);
  try {
    return await callback();
  } finally {
    process.chdir(previous);
  }
}

describe("test-runs command attribution fallback", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("falls back to USER when PM_AUTHOR and settings author_default are blank", async () => {
    await withTempPmPath(async (context) => {
      await setSettingsAuthorDefault(context.pmPath, "   ");
      const previousPmAuthor = process.env.PM_AUTHOR;
      const previousUser = process.env.USER;
      try {
        process.env.PM_AUTHOR = "   ";
        process.env.USER = "fallback-user";
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
      } finally {
        if (previousPmAuthor === undefined) {
          delete process.env.PM_AUTHOR;
        } else {
          process.env.PM_AUTHOR = previousPmAuthor;
        }
        if (previousUser === undefined) {
          delete process.env.USER;
        } else {
          process.env.USER = previousUser;
        }
      }
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
      const previousPmAuthor = process.env.PM_AUTHOR;
      const previousUser = process.env.USER;
      const previousLogname = process.env.LOGNAME;
      const previousUsername = process.env.USERNAME;
      try {
        process.env.PM_AUTHOR = " ";
        process.env.USER = "";
        process.env.LOGNAME = "";
        process.env.USERNAME = "";
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
      } finally {
        userInfoSpy.mockRestore();
        if (previousPmAuthor === undefined) {
          delete process.env.PM_AUTHOR;
        } else {
          process.env.PM_AUTHOR = previousPmAuthor;
        }
        if (previousUser === undefined) {
          delete process.env.USER;
        } else {
          process.env.USER = previousUser;
        }
        if (previousLogname === undefined) {
          delete process.env.LOGNAME;
        } else {
          process.env.LOGNAME = previousLogname;
        }
        if (previousUsername === undefined) {
          delete process.env.USERNAME;
        } else {
          process.env.USERNAME = previousUsername;
        }
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
      expect(status.run.resource?.recorded_at).toBeDefined();
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
        delete process.env.PM_BACKGROUND_CLI_ENTRY;
        process.argv[1] = argvEntry;
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
});
