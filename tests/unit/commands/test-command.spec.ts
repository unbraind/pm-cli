import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  _testOnlyTestCommand as testInternals,
  classifyLinkedTestFailure,
  countFailureCategories,
  extractReferencedPmItemIdsFromCommand,
  resolveLinkedTestFailureExitCode,
  runTest,
  summarizeContextPreflight,
} from "../../../src/cli/commands/test.js";
import { appendTrackedTestRunSummary } from "../../../src/core/test/item-test-run-tracking.js";
import {
  describeLinkedTestEntries,
  parseOnlyIndexValue,
  resolveLinkedTestRunSelection,
} from "../../../src/core/test/run-selectors.js";
import { EXIT_CODE } from "../../../src/core/shared/constants.js";
import { readSettings } from "../../../src/core/store/settings.js";
import { createTestItemId } from "../../helpers/itemFactory.js";
import {
  loadTaskMetadata,
  overwriteTaskTestRuns,
  overwriteTaskTests,
  setGovernancePreset,
  setTestResultTracking,
  writeSchemaTypeExtension,
} from "../../helpers/pmWorkspace.js";
import { withTempPmPath, type TempPmContext } from "../../helpers/withTempPmPath.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function createTask(context: TempPmContext, title: string): string {
  return createTestItemId(context, {
    title,
    tags: "testing",
    author: "test-author",
  });
}

async function latestHistoryAuthor(pmPath: string, id: string): Promise<string> {
  const historyPath = path.join(pmPath, "history", `${id}.jsonl`);
  const raw = await readFile(historyPath, "utf8");
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const last = JSON.parse(lines.at(-1) ?? "{}") as { author?: string };
  return last.author ?? "";
}

async function setSettingsAuthorDefault(pmPath: string, authorDefault: string): Promise<void> {
  const settingsPath = path.join(pmPath, "settings.json");
  const settings = JSON.parse(await readFile(settingsPath, "utf8")) as { author_default?: string };
  settings.author_default = authorDefault;
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

async function expectHeartbeatProgressRun(
  context: TempPmContext,
  id: string,
  options: { isTTY: boolean; progress?: boolean },
): Promise<void> {
  const previousHeartbeatInterval = process.env.PM_LINKED_TEST_HEARTBEAT_INTERVAL_MS;
  process.env.PM_LINKED_TEST_HEARTBEAT_INTERVAL_MS = "10";
  const originalIsTTY = process.stderr.isTTY;
  Object.defineProperty(process.stderr, "isTTY", {
    value: options.isTTY,
    configurable: true,
  });
  const stderrWriteSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    const run = await runTest(
      id,
      {
        run: true,
        timeout: "5",
        ...(options.progress ? { progress: true } : {}),
      },
      { path: context.pmPath },
    );
    expect(run.run_results).toHaveLength(1);
    expect(run.run_results[0]?.status).toBe("passed");

    const stderrOutput = stderrWriteSpy.mock.calls.map((entry) => String(entry[0])).join("");
    expect(stderrOutput).toContain("[pm test] linked-test 1/1 start");
    expect(stderrOutput).toContain("[pm test] linked-test 1/1 running");
    expect(stderrOutput).toContain("[pm test] linked-test 1/1 end status=passed");
  } finally {
    if (previousHeartbeatInterval === undefined) {
      delete process.env.PM_LINKED_TEST_HEARTBEAT_INTERVAL_MS;
    } else {
      process.env.PM_LINKED_TEST_HEARTBEAT_INTERVAL_MS = previousHeartbeatInterval;
    }
    Object.defineProperty(process.stderr, "isTTY", {
      value: originalIsTTY,
      configurable: true,
    });
  }
}

describe("runTest", () => {
  it("summarizes linked-test statuses and pm context preflight counters", () => {
    expect(
      summarizeContextPreflight([
        { status: "passed", execution_context: { is_pm_command: false } },
        {
          status: "failed",
          execution_context: {
            is_pm_command: true,
            is_pm_tracker_read_command: true,
            mismatch_detected: true,
            auto_pm_context_applied: true,
          },
        },
        {
          status: "skipped",
          execution_context: {
            is_pm_command: true,
            is_pm_tracker_read_command: false,
            mismatch_detected: false,
            auto_remediated: false,
          },
        },
      ] as never),
    ).toEqual({
      checked_pm_commands: 2,
      tracker_read_commands: 1,
      mismatches: 1,
      auto_remediated: 1,
    });
  });

  it("normalizes failure exit codes for timeout/maxBuffer edge cases", () => {
    expect(
      resolveLinkedTestFailureExitCode({
        exitCode: null,
        timedOut: false,
        maxBufferExceeded: false,
      }),
    ).toBe(1);
    expect(
      resolveLinkedTestFailureExitCode({
        exitCode: 0,
        timedOut: false,
        maxBufferExceeded: false,
      }),
    ).toBe(0);
    expect(
      resolveLinkedTestFailureExitCode({
        exitCode: 0,
        timedOut: true,
        maxBufferExceeded: false,
      }),
    ).toBe(1);
    expect(
      resolveLinkedTestFailureExitCode({
        exitCode: 0,
        timedOut: false,
        maxBufferExceeded: true,
      }),
    ).toBe(1);
    expect(
      resolveLinkedTestFailureExitCode({
        exitCode: 2,
        timedOut: true,
        maxBufferExceeded: false,
      }),
    ).toBe(2);
  });

  it("classifies linked-test failure categories deterministically", () => {
    expect(
      classifyLinkedTestFailure({
        stdout: "",
        stderr: "Error: EADDRINUSE: address already in use 127.0.0.1:4173",
        spawnError: undefined,
        signal: null,
        timedOut: false,
        maxBufferExceeded: false,
      }),
    ).toBe("infra_collision");
    expect(
      classifyLinkedTestFailure({
        stdout: "",
        stderr: "",
        spawnError: undefined,
        signal: null,
        timedOut: true,
        maxBufferExceeded: false,
      }),
    ).toBe("timeout");
    expect(
      classifyLinkedTestFailure({
        stdout: "",
        stderr: "",
        spawnError: undefined,
        signal: null,
        timedOut: false,
        maxBufferExceeded: true,
      }),
    ).toBe("max_buffer");
    expect(
      classifyLinkedTestFailure({
        stdout: "",
        stderr: "",
        spawnError: "spawn ENOENT",
        signal: null,
        timedOut: false,
        maxBufferExceeded: false,
      }),
    ).toBe("spawn_error");
    expect(
      classifyLinkedTestFailure({
        stdout: "",
        stderr: "",
        spawnError: undefined,
        signal: "SIGTERM",
        timedOut: false,
        maxBufferExceeded: false,
      }),
    ).toBe("signal");
    expect(
      classifyLinkedTestFailure({
        stdout: "",
        stderr: "",
        spawnError: undefined,
        signal: null,
        timedOut: false,
        maxBufferExceeded: false,
      }),
    ).toBe("assertion_failure");
  });

  it("fails when tracker is not initialized", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pm-test-not-init-"));
    try {
      await expect(runTest("pm-missing", {}, { path: tempDir })).rejects.toMatchObject({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
      await expect(
        runTest("pm-missing", { add: ["command=node --version,scope=project"] }, { path: tempDir }),
      ).rejects.toMatchObject({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("accepts --list as a no-mutation alias for listing linked tests", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "test-list-flag");
      context.runCli(
        ["test", id, "--add", "command=node --version,scope=project,note=seed", "--json", "--author", "owner-a"],
        { expectJson: true },
      );
      const listed = context.runCli(["test", id, "--list", "--json", "--author", "owner-a"], { expectJson: true });
      expect(listed.code).toBe(0);
      const payload = listed.json as { tests?: Array<{ command?: string }>; count?: number };
      expect(payload.count).toBe(1);
      expect(payload.tests?.[0]?.command).toContain("node --version");
    });
  });

  it("validates add/remove payloads and timeout parsing", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "validate-test-command");

      await expect(runTest(id, { add: ["scope=project"] }, { path: context.pmPath })).rejects.toMatchObject({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(
        runTest(id, { add: ["command=node --version,scope=workspace"] }, { path: context.pmPath }),
      ).rejects.toMatchObject({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(
        runTest(
          id,
          { add: ["command=node --version,scope=project,timeout=10,timeout_seconds=11"] },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject({
        exitCode: EXIT_CODE.USAGE,
      });
      for (const timeout of ["0", "-1", "1.5", "Infinity"]) {
        await expect(
          runTest(
            id,
            {
              add: [
                `command=node --version,scope=project,timeout_seconds=${timeout}`,
              ],
            },
            { path: context.pmPath },
          ),
        ).rejects.toMatchObject({ exitCode: EXIT_CODE.USAGE });
      }
      await expect(runTest(id, { add: ["path=tests/path-only.spec.ts"] }, { path: context.pmPath })).rejects.toMatchObject({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(
        runTest(id, { add: ["command=node --version,scope=project,env_set=invalid-assignment"] }, { path: context.pmPath }),
      ).rejects.toMatchObject({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(
        runTest(id, { add: ["command=node --version,scope=project,env_set=;;"] }, { path: context.pmPath }),
      ).rejects.toMatchObject({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(
        runTest(id, { add: ["command=node --version,scope=project,env_set=1INVALID=value"] }, { path: context.pmPath }),
      ).rejects.toMatchObject({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(
        runTest(id, { add: ["command=node --version,scope=project,env_set=PM_PATH=/tmp/unsafe"] }, { path: context.pmPath }),
      ).rejects.toMatchObject({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(
        runTest(id, { add: ["command=node --version,scope=project,env_clear=FORCE_COLOR"] }, { path: context.pmPath }),
      ).rejects.toMatchObject({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(
        runTest(id, { add: ["command=node --version,scope=project,env_clear=;;"] }, { path: context.pmPath }),
      ).rejects.toMatchObject({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(
        runTest(id, { add: ["command=node --version,scope=project,env_clear=1INVALID"] }, { path: context.pmPath }),
      ).rejects.toMatchObject({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(
        runTest(id, { add: ["command=node --version,scope=project,shared_host_safe=maybe"] }, { path: context.pmPath }),
      ).rejects.toMatchObject({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(
        runTest(id, { add: ["command=node --version,scope=project,assert_stdout_regex=["] }, { path: context.pmPath }),
      ).rejects.toMatchObject({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(
        runTest(id, { add: ["command=node --version,scope=project,assert_stderr_regex=["] }, { path: context.pmPath }),
      ).rejects.toMatchObject({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(
        runTest(id, { add: ["command=node --version,scope=project,assert_stdout_min_lines=-1"] }, { path: context.pmPath }),
      ).rejects.toMatchObject({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(
        runTest(id, { add: ["command=node --version,scope=project,assert_stdout_min_lines=1.5"] }, { path: context.pmPath }),
      ).rejects.toMatchObject({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(
        runTest(id, { add: ["command=node --version,scope=project,assert_json_field_equals=count"] }, { path: context.pmPath }),
      ).rejects.toMatchObject({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(
        runTest(id, { add: ["command=node --version,scope=project,assert_json_field_equals==value"] }, { path: context.pmPath }),
      ).rejects.toMatchObject({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(
        runTest(id, { add: ["command=node --version,scope=project,assert_json_field_gte=count"] }, { path: context.pmPath }),
      ).rejects.toMatchObject({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(
        runTest(id, { add: ["command=node --version,scope=project,assert_json_field_gte=count=abc"] }, { path: context.pmPath }),
      ).rejects.toMatchObject({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(
        runTest(id, { add: ["command=node --version,scope=project,pm_context_mode=invalid"] }, { path: context.pmPath }),
      ).rejects.toMatchObject({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(runTest(id, { remove: ["   "] }, { path: context.pmPath })).rejects.toMatchObject({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(runTest(id, { remove: ["scope=project"] }, { path: context.pmPath })).rejects.toMatchObject({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(runTest(id, { run: true, timeout: "not-a-number" }, { path: context.pmPath })).rejects.toMatchObject({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(runTest(id, { run: true, pmContext: "invalid" }, { path: context.pmPath })).rejects.toMatchObject({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(runTest(id, { envSet: ["PORT=0"] }, { path: context.pmPath })).rejects.toMatchObject({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(runTest(id, { pmContext: "tracker" }, { path: context.pmPath })).rejects.toMatchObject({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(runTest(id, { overrideLinkedPmContext: true }, { path: context.pmPath })).rejects.toMatchObject({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(runTest(id, { failOnContextMismatch: true }, { path: context.pmPath })).rejects.toMatchObject({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(runTest(id, { failOnSkipped: true }, { path: context.pmPath })).rejects.toMatchObject({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(runTest(id, { failOnEmptyTestRun: true }, { path: context.pmPath })).rejects.toMatchObject({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(runTest(id, { requireAssertionsForPm: true }, { path: context.pmPath })).rejects.toMatchObject({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(runTest(id, { checkContext: true }, { path: context.pmPath })).rejects.toMatchObject({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(runTest(id, { autoPmContext: true }, { path: context.pmPath })).rejects.toMatchObject({
        exitCode: EXIT_CODE.USAGE,
      });

      const seeded = await runTest(
        id,
        { add: ["command=node --version,scope=project,shared_host_safe=false"], message: "seed bool false" },
        { path: context.pmPath },
      );
      expect(seeded.tests.some((entry) => entry.command === "node --version")).toBe(true);
      expect(seeded.tests.every((entry) => entry.shared_host_safe !== true)).toBe(true);

      const seededAssertions = await runTest(
        id,
        {
          add: [
            "command=node --version,scope=project,path=tests/path-metadata.spec.ts,pm_context_mode=auto,assert_stdout_contains=v,assert_stdout_regex=v\\\\d+,assert_stderr_contains=warn,assert_stderr_regex=warn,assert_stdout_min_lines=0,assert_json_field_equals=status=ok,assert_json_field_gte=count=1",
          ],
          message: "seed assertion metadata",
        },
        { path: context.pmPath },
      );
      const assertedEntry = seededAssertions.tests.find((entry) => entry.path === "tests/path-metadata.spec.ts");
      expect(assertedEntry).toMatchObject({
        assert_stdout_contains: ["v"],
        assert_stdout_regex: ["v\\\\d+"],
        assert_stderr_contains: ["warn"],
        assert_stderr_regex: ["warn"],
        assert_stdout_min_lines: 0,
        assert_json_field_equals: { status: "ok" },
        assert_json_field_gte: { count: 1 },
        pm_context_mode: "auto",
      });

      const removedByPath = await runTest(
        id,
        { remove: ["tests/path-metadata.spec.ts"], message: "remove path metadata entry" },
        { path: context.pmPath },
      );
      expect(removedByPath.tests.some((entry) => entry.path === "tests/path-metadata.spec.ts")).toBe(false);

      const runWithEmptyRuntimeDirectives = await runTest(
        id,
        { run: true, envSet: [""], envClear: ["", "DELETE_ME"], timeout: "5" },
        { path: context.pmPath },
      );
      expect(runWithEmptyRuntimeDirectives.run_results.length).toBeGreaterThanOrEqual(1);
    });
  });

  it("accepts cmd as an alias for command in structured --add entries", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "cmd-alias-test");
      const result = await runTest(
        id,
        { add: ["CMD=node --version,SCOPE=project,note=cmd alias"], message: "seed cmd alias" },
        { path: context.pmPath },
      );
      const entry = result.tests.find((test) => test.note === "cmd alias");
      expect(entry?.command).toBe("node --version");
      // The whole pair must NOT be stored as the command (the original bug).
      expect(result.tests.some((test) => test.command.includes("cmd="))).toBe(false);
      expect(result.tests.some((test) => test.command.includes("name="))).toBe(false);
    });
  });

  it("keeps comma-containing command payloads working with the cmd alias", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "cmd-alias-comma-test");
      const result = await runTest(
        id,
        { add: ["cmd=node -e \"console.log('a,b')\",scope=project,note=cmd comma alias"], message: "seed cmd comma alias" },
        { path: context.pmPath },
      );

      const entry = result.tests.find((test) => test.note === "cmd comma alias");
      expect(entry?.command).toBe("node -e \"console.log('a,b')\"");
    });
  });

  it("rejects structured --add entries that use an unknown key instead of silently storing the command", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "unknown-key-test");
      // The original bug: `cmd=...,name=...` was stored verbatim as the command
      // because `name` was unrecognized. Now this must error loudly.
      await expect(
        runTest(id, { add: ["cmd=node --version,name=smoke"] }, { path: context.pmPath }),
      ).rejects.toMatchObject({ exitCode: EXIT_CODE.USAGE });
      await expect(
        runTest(id, { add: ["command=node --version,bogus=1,scope=project"] }, { path: context.pmPath }),
      ).rejects.toMatchObject({ exitCode: EXIT_CODE.USAGE });
      // command/cmd conflict is rejected.
      await expect(
        runTest(id, { add: ["command=node --version,cmd=node --help"] }, { path: context.pmPath }),
      ).rejects.toMatchObject({ exitCode: EXIT_CODE.USAGE });
      // No test entries should have been stored from the rejected payloads.
      const listed = context.runCli(["test", id, "--list", "--json"], { expectJson: true });
      const payload = listed.json as { count?: number };
      expect(payload.count).toBe(0);
    });
  });

  it("keeps bare commands containing = working without key validation", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "bare-command-with-equals");
      const result = await runTest(
        id,
        { add: ["node scripts/run-tests.mjs test --reporter=dot"], message: "seed bare command" },
        { path: context.pmPath },
      );
      expect(result.tests.some((test) => test.command === "node scripts/run-tests.mjs test --reporter=dot")).toBe(true);
    });
  });

  it("preserves history hash chain after tests_add round-trip through TOON", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "history-drift-tests-add");
      await runTest(
        id,
        { add: ["command=node --version,scope=project"], message: "seed test entry" },
        { path: context.pmPath },
      );
      const verify = context.runCli(["history", id, "--verify", "--json", "--full"], { expectJson: true });
      expect(verify.code).toBe(0);
      const payload = verify.json as {
        verification: { ok: boolean; errors?: string[]; current_matches_latest: boolean };
      };
      expect(payload.verification.ok).toBe(true);
      expect(payload.verification.current_matches_latest).toBe(true);
      expect(payload.verification.errors ?? []).not.toContain("verify_failed:current_item_hash_mismatch");
    });
  });

  it("rejects linked commands that invoke test-all recursion variants", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "reject-recursive-test-all");
      const recursiveCommands = [
        "command=pm test-all --json,scope=project",
        "command=pm --json test-all,scope=project",
        "command=pm -- test-all,scope=project",
        "command=pm --path /tmp/pm-safe test-all,scope=project",
        "command=env PM_PATH=/tmp/pm-safe PM_GLOBAL_PATH=/tmp/pm-global pm --json test-all,scope=project",
        "command=npx pm-cli test-all --json,scope=project",
        "command=npx pm-cli@latest --json test-all,scope=project",
        "command=npx pm-cli@0.1.0 --json test-all,scope=project",
        "command=npx @scope/pm-cli --json test-all,scope=project",
        "command=npx @scope/pm-cli@latest --json test-all,scope=project",
        "command=npx --yes pm-cli --json test-all,scope=project",
        "command=npx ./node_modules/.bin/pm-cli --json test-all,scope=project",
        "command=npx -- pm-cli --json test-all,scope=project",
        "command=npx --package=pm-cli pm --json test-all,scope=project",
        "command=npx -p pm-cli pm --json test-all,scope=project",
        "command=bunx pm-cli@latest --json test-all,scope=project",
        "command=bunx --bun pm-cli@latest --json test-all,scope=project",
        "command=pnpm dlx pm-cli@latest --json test-all,scope=project",
        "command=pnpm dlx @scope/pm-cli@latest --json test-all,scope=project",
        "command=pnpm -- dlx pm-cli@latest --json test-all,scope=project",
        "command=pnpm --dir /tmp/pm-safe dlx pm-cli@latest --json test-all,scope=project",
        "command=pnpm --config=/tmp/pm-safe dlx pm-cli@latest --json test-all,scope=project",
        "command=npm exec -- pm-cli@latest --json test-all,scope=project",
        "command=npm exec pm-cli@latest -- --json test-all,scope=project",
        "command=npm --prefix /tmp/pm-safe exec -- pm-cli@latest --json test-all,scope=project",
        "command=npm --silent exec -- pm-cli@latest --json test-all,scope=project",
        "command=npm x -- pm-cli@latest --json test-all,scope=project",
        "command=npm exec --package=pm-cli -- pm --json test-all,scope=project",
        "command=node ./dist/cli.js test-all --json,scope=project",
        "command=node dist/cli.js --json test-all,scope=project",
      ];

      for (const addEntry of recursiveCommands) {
        await expect(runTest(id, { add: [addEntry] }, { path: context.pmPath })).rejects.toMatchObject({
          exitCode: EXIT_CODE.USAGE,
        });
      }
    });
  });

  it("skips legacy recursive test-all linked commands at runtime", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "skip-legacy-recursive-test-all");
      await overwriteTaskTests(context, id, [
        {
          command: "node ./dist/cli.js test-all --json",
          scope: "project",
          timeout_seconds: 20,
        },
        {
          command: "pm --json test-all",
          scope: "project",
          timeout_seconds: 20,
        },
        {
          command: "npx pm-cli@latest --json test-all",
          scope: "project",
          timeout_seconds: 20,
        },
        {
          command: "pnpm dlx pm-cli@latest --json test-all",
          scope: "project",
          timeout_seconds: 20,
        },
        {
          command: "npm exec -- pm-cli@latest --json test-all",
          scope: "project",
          timeout_seconds: 20,
        },
        {
          command: "node --version",
          scope: "project",
          timeout_seconds: 20,
        },
      ]);

      const result = await runTest(id, { run: true, timeout: "20" }, { path: context.pmPath });
      expect(result.ok).toBe(true);
      expect(result.changed).toBe(false);
      expect(result.count).toBe(6);
      expect(result.run_results).toHaveLength(6);

      const recursiveEntries = result.run_results.filter((entry) => entry.command?.includes("test-all"));
      expect(recursiveEntries).toHaveLength(5);
      expect(recursiveEntries.every((entry) => entry.status === "skipped")).toBe(true);
      expect(recursiveEntries.every((entry) => (entry.error ?? "").includes("must not invoke \"pm test-all\""))).toBe(true);

      const safe = result.run_results.find((entry) => entry.command === "node --version");
      expect(safe?.status).toBe("passed");
      expect(safe?.exit_code).toBe(0);
    });
  });

  it("extracts referenced PM item ids from linked command variants", () => {
    expect(extractReferencedPmItemIdsFromCommand("pm get pm-a1b2")).toEqual(["pm-a1b2"]);
    expect(extractReferencedPmItemIdsFromCommand("node dist/cli.js close pm-z9x8 done")).toEqual(["pm-z9x8"]);
    expect(
      extractReferencedPmItemIdsFromCommand("npx @unbrained/pm-cli@latest update pm-b2c3 --status open --json"),
    ).toEqual(["pm-b2c3"]);
    expect(
      extractReferencedPmItemIdsFromCommand("bunx @unbrained/pm-cli@latest update pm-b2c4 --status open --json"),
    ).toEqual(["pm-b2c4"]);
    expect(
      extractReferencedPmItemIdsFromCommand("npm exec -- @unbrained/pm-cli@latest test pm-t123 --run --json"),
    ).toEqual(["pm-t123"]);
    expect(
      extractReferencedPmItemIdsFromCommand(
        "PNPM_HOME=/tmp pnpm --silent dlx @unbrained/pm-cli@latest comments pm-c9d8 --add audit --json",
      ),
    ).toEqual(["pm-c9d8"]);
    expect(
      extractReferencedPmItemIdsFromCommand(
        "npm --silent exec -- @unbrained/pm-cli@latest claim pm-k7m6 --force --author qa",
      ),
    ).toEqual(["pm-k7m6"]);
    expect(extractReferencedPmItemIdsFromCommand("pm --path /tmp get pm-p1q2 --json")).toEqual(["pm-p1q2"]);
    expect(extractReferencedPmItemIdsFromCommand("pm --path /tmp -- get pm-r3s4 --json")).toEqual(["pm-r3s4"]);
    expect(extractReferencedPmItemIdsFromCommand("pm --path /tmp")).toEqual([]);
    expect(extractReferencedPmItemIdsFromCommand("pm get --json")).toEqual([]);
    expect(extractReferencedPmItemIdsFromCommand("pm -h get pm-h1i2")).toEqual(["pm-h1i2"]);
    expect(extractReferencedPmItemIdsFromCommand("pm list-open --limit 1 --json")).toEqual([]);
    expect(extractReferencedPmItemIdsFromCommand("pm stats --json")).toEqual([]);
    expect(extractReferencedPmItemIdsFromCommand("pnpm install")).toEqual([]);
    expect(extractReferencedPmItemIdsFromCommand("npm run test -- --runInBand")).toEqual([]);
    expect(extractReferencedPmItemIdsFromCommand("pm get custom-123", "custom-")).toEqual(["custom-123"]);
    expect(extractReferencedPmItemIdsFromCommand("pm get pm-a1b2", "")).toEqual([]);
    expect(extractReferencedPmItemIdsFromCommand("pm get bad-id", "pm-")).toEqual([]);
    expect(extractReferencedPmItemIdsFromCommand("FOO=bar")).toEqual([]);
    expect(extractReferencedPmItemIdsFromCommand("   ")).toEqual([]);
    expect(extractReferencedPmItemIdsFromCommand("echo no pm invocation")).toEqual([]);
    expect(extractReferencedPmItemIdsFromCommand("pm get pm-z9 && pm get pm-a1")).toEqual(["pm-a1", "pm-z9"]);
  });

  it("counts failure categories only for failed run results", () => {
    const counts = countFailureCategories([
      { status: "passed", command: "node --version" },
      { status: "failed", command: "node -e \"process.exit(1)\"", failure_category: "assertion_failure" },
      { status: "failed", command: "node -e \"process.exit(1)\"", failure_category: "assertion_failure" },
      { status: "failed", command: "node -e \"console.log('No tests found')\"", failure_category: "empty_run" },
      { status: "failed", command: "node -e \"setTimeout(() => {}, 1)\"", failure_category: "timeout" },
      { status: "failed", command: "node -e \"setTimeout(() => {}, 1)\"" },
      { status: "skipped", command: "pm test-all", error: "skipped recursive" },
    ]);
    expect(counts.assertion_failure).toBe(2);
    expect(counts.empty_run).toBe(1);
    expect(counts.timeout).toBe(1);
    expect(counts.infra_collision).toBe(0);
  });

  it("covers pure linked-test helpers for context modes, parsing, sandbox copy, and json paths", async () => {
    const previousAuthor = process.env.PM_AUTHOR;
    const previousRunId = process.env.PM_BACKGROUND_TEST_RUN_ID;
    try {
      delete process.env.PM_AUTHOR;
      delete process.env.PM_BACKGROUND_TEST_RUN_ID;
      expect(testInternals.resolveAuthor(undefined, "fallback-author")).toBe("fallback-author");
      process.env.PM_AUTHOR = " env-author ";
      expect(testInternals.resolveAuthor(undefined, "fallback-author")).toBe("env-author");
      expect(testInternals.resolveAuthor("   ", "fallback-author")).toBe("unknown");
      process.env.PM_BACKGROUND_TEST_RUN_ID = " run-from-env ";
      expect(testInternals.resolveTrackedRunId("test")).toBe("run-from-env");
    } finally {
      if (previousAuthor === undefined) {
        delete process.env.PM_AUTHOR;
      } else {
        process.env.PM_AUTHOR = previousAuthor;
      }
      if (previousRunId === undefined) {
        delete process.env.PM_BACKGROUND_TEST_RUN_ID;
      } else {
        process.env.PM_BACKGROUND_TEST_RUN_ID = previousRunId;
      }
    }

    expect(testInternals.summarizeRunResultStatuses([
      { status: "passed" },
      { status: "failed" },
      { status: "skipped" },
      { status: "unknown" },
    ] as never)).toEqual({ passed: 1, failed: 1, skipped: 2 });
    expect(testInternals.ensureScope(undefined)).toBe("project");
    expect(() => testInternals.ensureScope("workspace")).toThrow('Invalid scope "workspace"');
    expect(testInternals.parsePmContextMode(undefined)).toBe("schema");
    expect(testInternals.parsePmContextMode(" AUTO ")).toBe("auto");
    expect(() => testInternals.parsePmContextMode("bad")).toThrow("Invalid --pm-context value");
    expect(testInternals.resolveLinkedTestRequestedContextMode({ pm_context_mode: "tracker" } as never, "schema", false)).toBe(
      "tracker",
    );
    expect(testInternals.resolveLinkedTestRequestedContextMode({ pm_context_mode: "tracker" } as never, "schema", true)).toBe(
      "schema",
    );
    expect(testInternals.resolveLinkedTestEffectiveContextMode("auto", true)).toBe("tracker");
    expect(testInternals.resolveLinkedTestEffectiveContextMode("auto", false)).toBe("schema");
    expect(testInternals.hasLinkedTestAssertions({ assert_stdout_contains: ["ok"] } as never)).toBe(true);
    expect(testInternals.hasLinkedTestAssertions({ assert_json_field_equals: { ok: true } } as never)).toBe(true);
    expect(testInternals.hasLinkedTestAssertions({} as never)).toBe(false);
    expect(testInternals.commandInvokesPmCli("A=1 pm get pm-123 --json && echo done")).toBe(true);
    expect(testInternals.commandInvokesPmCli("echo pm get pm-123")).toBe(false);
    expect(testInternals.commandInvokesPmTrackerReadCommand("pm get pm-123 --json")).toBe(true);
    expect(testInternals.commandInvokesPmTrackerReadCommand("pm create --title x")).toBe(false);
    expect(testInternals.commandInvokesPmTrackerReadCommand("echo no pm command")).toBe(false);
    expect(testInternals.commandInvokesPmTrackerReadCommand("pm --path /tmp")).toBe(false);
    expect(testInternals.resolveDirectRunnerSubcommand({ subcommand: "vitest", args: [] })).toBe("vitest");
    expect(testInternals.resolveDirectRunnerSubcommand(null)).toBeUndefined();
    expect(testInternals.firstDirectTestRunnerSubcommand("npx", ["--yes", "vitest", "run"])).toBe("vitest");
    expect(testInternals.firstDirectTestRunnerSubcommand("bunx", ["--bun", "vitest", "run"])).toBe("vitest");
    expect(testInternals.firstDirectTestRunnerSubcommand("pmx", ["test"])).toBeUndefined();
    expect(testInternals.extractPmInvocationArgsFromSegment("echo nothing")).toBeNull();
    expect(testInternals.extractPmInvocationArgsFromSegment("npx --yes pm get pm-a1b2 --json")).toEqual([
      "get",
      "pm-a1b2",
      "--json",
    ]);
    expect(testInternals.extractPmInvocationArgsFromSegment("bunx --bun pm get pm-a1b3 --json")).toEqual([
      "get",
      "pm-a1b3",
      "--json",
    ]);
    expect(
      testInternals.buildPmContextMismatchHint({
        executionContext: {
          is_pm_tracker_read_command: false,
          mismatch_detected: true,
          expected_sandbox_pm_path: "/tmp/sandbox/.agents/pm",
          effective_pm_path: "/tmp/project/.agents/pm",
          pm_context_mode: "schema",
          command_invokes_pm_cli: true,
          command_invokes_tracker_read: false,
          command_referenced_pm_ids: [],
        },
        runLevelPmContextMode: "schema",
        linkedOverridePmContextMode: undefined,
      }),
    ).toBe("");
    expect(
      testInternals.buildPmContextMismatchHint({
        executionContext: {
          is_pm_tracker_read_command: true,
          mismatch_detected: true,
          expected_sandbox_pm_path: "/tmp/sandbox/.agents/pm",
          effective_pm_path: "/tmp/project/.agents/pm",
          pm_context_mode: "schema",
          command_invokes_pm_cli: true,
          command_invokes_tracker_read: true,
          command_referenced_pm_ids: [],
        },
        runLevelPmContextMode: "schema",
        linkedOverridePmContextMode: undefined,
      }),
    ).toContain("--auto-pm-context");
    expect(
      testInternals.buildPmContextMismatchHint({
        executionContext: {
          is_pm_tracker_read_command: true,
          mismatch_detected: true,
          expected_sandbox_pm_path: "/tmp/sandbox/.agents/pm",
          effective_pm_path: "/tmp/project/.agents/pm",
          pm_context_mode: "tracker",
          command_invokes_pm_cli: true,
          command_invokes_tracker_read: true,
          command_referenced_pm_ids: [],
        },
        runLevelPmContextMode: "tracker",
        linkedOverridePmContextMode: "schema",
      }),
    ).toContain("pm_context_mode=schema overrides run-level --pm-context tracker");
    expect(testInternals.splitJsonPathSegments("items[0].status")).toEqual(["items", 0, "status"]);
    expect(testInternals.splitJsonPathSegments("items[-1]")).toEqual(["items", "-1"]);
    expect(testInternals.splitJsonPathSegments("items[]")).toEqual(["items"]);
    expect(testInternals.splitJsonPathSegments(`items[${"9".repeat(500)}]`)).toEqual([]);
    expect(testInternals.readJsonPathValue({ items: [{ status: "ok" }] }, "items[0].status")).toEqual({
      found: true,
      value: "ok",
    });
    expect(testInternals.readJsonPathValue({ ok: true }, "   ")).toEqual({
      found: false,
      value: undefined,
    });
    expect(testInternals.readJsonPathValue({ items: [{ status: "ok" }] }, "items.status")).toEqual({
      found: false,
      value: undefined,
    });
    expect(testInternals.readJsonPathValue({ items: [] }, "items[1].status")).toEqual({
      found: false,
      value: undefined,
    });
    expect(() =>
      testInternals.parseAddJsonEntries([
        JSON.stringify([{ command: "   ", scope: "project" }]),
      ]),
    ).toThrow('requires a non-empty "command" string');
    expect(
      testInternals.evaluateLinkedTestAssertions(
        {
          command: "node -e \"0\"",
          scope: "project",
          assert_stdout_regex: ["required-output"],
          assert_stderr_regex: ["("],
        } as never,
        "actual output",
        "stderr output",
      ),
    ).toEqual([
      "stdout failed regex assertion: /required-output/m",
      expect.stringContaining("stderr regex assertion is invalid: /(/"),
    ]);
    const linkedExecution = await testInternals.runLinkedTestCommand(
      "node -e \"process.stdout.write('ok\\\\n'); process.stderr.write('warn\\\\n');\"",
      3_000,
      process.env,
      { index: 1, total: 1, command: "node -e ...", timeoutMs: 3_000 },
      "always",
    );
    expect(linkedExecution.exitCode).toBe(0);
    expect(linkedExecution.stdout).toContain("ok");
    expect(linkedExecution.stderr).toContain("warn");
    const exceededBuffer = {
      stdout: "",
      stderr: "",
      stdoutBytes: 0,
      stderrBytes: 0,
      maxBufferExceeded: true,
    };
    expect(testInternals.appendLinkedTestOutputChunk(exceededBuffer, Buffer.from("ignored"), "stdout")).toBe(false);
    expect(exceededBuffer.stdoutBytes).toBe(0);
    const nearlyFullBuffer = {
      stdout: "",
      stderr: "",
      stdoutBytes: 20 * 1024 * 1024 - 2,
      stderrBytes: 0,
      maxBufferExceeded: false,
    };
    expect(testInternals.appendLinkedTestOutputChunk(nearlyFullBuffer, Buffer.from("abcd"), "stdout")).toBe(true);
    expect(nearlyFullBuffer.stdout).toBe("ab");
    expect(nearlyFullBuffer.stdoutBytes).toBe(20 * 1024 * 1024 + 2);
    expect(nearlyFullBuffer.maxBufferExceeded).toBe(true);

    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pm-test-command-helpers-"));
    try {
      const source = path.join(tempRoot, "source");
      const target = path.join(tempRoot, "target", "copied.txt");
      await mkdir(source, { recursive: true });
      await writeFile(path.join(source, "copied.txt"), "copy me", "utf8");
      await testInternals.copyIntoSandboxIfPresent(path.join(source, "missing.txt"), path.join(tempRoot, "missing.txt"));
      await testInternals.copyIntoSandboxIfPresent(path.join(source, "copied.txt"), target);
      expect(await readFile(target, "utf8")).toBe("copy me");
      await mkdir(path.join(source, "pm", "tasks"), { recursive: true });
      await writeFile(path.join(source, "pm", "tasks", "pm-a.toon"), "item", "utf8");
      await mkdir(path.join(source, "pm", "tasks", "nested"), { recursive: true });
      try {
        await symlink("tasks/pm-a.toon", path.join(source, "pm", "tasks-link"), "file");
      } catch (err) {
        const code = typeof err === "object" && err !== null && "code" in err ? err.code : undefined;
        if (process.platform !== "win32" || (code !== "EPERM" && code !== "EACCES")) {
          throw err;
        }
      }
      await mkdir(path.join(source, "pm", "history"), { recursive: true });
      await writeFile(path.join(source, "pm", "history", "pm-a.jsonl"), "history", "utf8");
      const restrictedDir = path.join(source, "pm", "blocked-folder");
      await mkdir(restrictedDir, { recursive: true });
      await chmod(restrictedDir, 0);
      expect(await testInternals.countLinkedTestItemFiles(path.join(source, "pm"))).toBe(1);
      await chmod(restrictedDir, 0o755);
      await testInternals.seedLinkedTestTrackerData(path.join(source, "pm"), path.join(tempRoot, "sandbox-pm"));
      expect(await readFile(path.join(tempRoot, "sandbox-pm", "tasks", "pm-a.toon"), "utf8")).toBe("item");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects sandbox-unsafe test-runner commands and allows sandbox-safe variants", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "reject-unsafe-test-runners");
      const unsafeRunnerCommands = [
        "command=npm --cache /tmp vitest run,scope=project",
        "command=pnpm dlx vitest run,scope=project",
        "command=npm exec -- vitest run,scope=project",
        "command=npx --yes vitest run,scope=project",
        "command=bunx --bun vitest run,scope=project",
        "command=vitest run,scope=project",
        "command=PM_PATH=/tmp/pm-only vitest run,scope=project",
        "command=./node_modules/.bin/vitest run,scope=project",
        "command=node --test tests/unit/example.test.js,scope=project",
        "command=node --no-warnings --test tests/unit/example.test.js,scope=project",
        "command=node vitest run,scope=project",
        "command=node C:\\repo\\node_modules\\.bin\\vitest run,scope=project",
        "command=node ./scripts/run-tests.mjs coverage; vitest run,scope=project",
      ];

      for (const addEntry of unsafeRunnerCommands) {
        await expect(runTest(id, { add: [addEntry] }, { path: context.pmPath })).rejects.toMatchObject({
          exitCode: EXIT_CODE.USAGE,
        });
      }
      // pm-fl0c #3 (2026-05-28): the rejection error MUST tell agents that
      // env vars need to be INLINE in the command string — exporting them
      // in the parent shell does not satisfy the guard. Previously the
      // message said "set both PM_PATH and PM_GLOBAL_PATH" without that
      // distinction, leading to repeated agent retries.
      await expect(runTest(id, { add: ["command=vitest run,scope=project"] }, { path: context.pmPath })).rejects.toMatchObject({
        message: expect.stringContaining("INLINE in the command string"),
      });

      const safeWithRunner = await runTest(
        id,
        {
          add: ["command=node scripts/run-tests.mjs test -- tests/unit/test-command.spec.ts,scope=project"],
        },
        { path: context.pmPath },
      );
      expect(safeWithRunner.count).toBe(1);

      const safeWithExplicitEnv = await runTest(
        id,
        {
          add: ["command=PM_PATH=/tmp/pm-safe PM_GLOBAL_PATH=/tmp/pm-global pnpm test -- --runInBand,scope=project"],
        },
        { path: context.pmPath },
      );
      expect(safeWithExplicitEnv.count).toBe(2);

      const safeRunScriptWithExplicitEnv = await runTest(
        id,
        {
          add: ["command=PM_PATH=/tmp/pm-safe PM_GLOBAL_PATH=/tmp/pm-global npm run test -- --runInBand,scope=project"],
        },
        { path: context.pmPath },
      );
      expect(safeRunScriptWithExplicitEnv.count).toBe(3);

      const safeFlaggedWithExplicitEnv = await runTest(
        id,
        {
          add: ["command=PM_PATH=/tmp/pm-safe PM_GLOBAL_PATH=/tmp/pm-global pnpm --dir /tmp test -- --runInBand,scope=project"],
        },
        { path: context.pmPath },
      );
      expect(safeFlaggedWithExplicitEnv.count).toBe(4);

      const safeChainedWithExplicitEnv = await runTest(
        id,
        {
          add: [
            "command=node scripts/run-tests.mjs test && PM_PATH=/tmp/pm-safe PM_GLOBAL_PATH=/tmp/pm-global pnpm test -- --runInBand,scope=project",
          ],
        },
        { path: context.pmPath },
      );
      expect(safeChainedWithExplicitEnv.count).toBe(5);

      const safeEachRunnerSegmentSandboxed = await runTest(
        id,
        {
          add: [
            "command=PM_PATH=/tmp/pm-safe PM_GLOBAL_PATH=/tmp/pm-global pnpm test -- --runInBand && PM_PATH=/tmp/pm-safe PM_GLOBAL_PATH=/tmp/pm-global pnpm test:coverage,scope=project",
          ],
        },
        { path: context.pmPath },
      );
      expect(safeEachRunnerSegmentSandboxed.count).toBe(6);

      const safePackageScriptEntries = [
        "command=pnpm test,scope=project",
        "command=pnpm test:coverage,scope=project",
        "command=pnpm --dir /tmp test -- --runInBand,scope=project",
        "command=pnpm -C /tmp test:coverage,scope=project",
        "command=npm test -- --runInBand,scope=project",
        "command=npm run test -- --runInBand,scope=project",
        "command=npm --prefix /tmp test -- --runInBand,scope=project",
        "command=pnpm run test -- --runInBand,scope=project",
        "command=yarn --cwd /tmp test,scope=project",
        "command=yarn run test,scope=project",
        "command=bun --cwd /tmp test,scope=project",
        "command=bun run test,scope=project",
      ];
      const packageScripts = await runTest(id, { add: safePackageScriptEntries }, { path: context.pmPath });
      expect(packageScripts.count).toBe(18);

      const nonRunnerCommand = await runTest(id, { add: ["command=pnpm build,scope=project"] }, { path: context.pmPath });
      expect(nonRunnerCommand.count).toBe(19);

      const envOnlyCommand = await runTest(
        id,
        {
          add: ["command=PM_PATH=/tmp/pm-safe PM_GLOBAL_PATH=/tmp/pm-global,scope=project"],
        },
        { path: context.pmPath },
      );
      expect(envOnlyCommand.count).toBe(20);

      const npxFlagOnlyCommand = await runTest(id, { add: ["command=npx --yes,scope=project"] }, { path: context.pmPath });
      expect(npxFlagOnlyCommand.count).toBe(21);

      const pmFlagsOnlyCommand = await runTest(id, { add: ["command=pm --json,scope=project"] }, { path: context.pmPath });
      expect(pmFlagsOnlyCommand.count).toBe(22);

      const npxNonPmCommand = await runTest(id, { add: ["command=npx cowsay hello,scope=project"] }, { path: context.pmPath });
      expect(npxNonPmCommand.count).toBe(23);

      const npxScopedNonPmCommand = await runTest(
        id,
        { add: ["command=npx @scope hello,scope=project"] },
        { path: context.pmPath },
      );
      expect(npxScopedNonPmCommand.count).toBe(24);

      const pnpmDlxNonPmCommand = await runTest(
        id,
        { add: ["command=pnpm dlx cowsay hello,scope=project"] },
        { path: context.pmPath },
      );
      expect(pnpmDlxNonPmCommand.count).toBe(25);

      const npmExecNonPmCommand = await runTest(
        id,
        { add: ["command=npm exec -- cowsay hello,scope=project"] },
        { path: context.pmPath },
      );
      expect(npmExecNonPmCommand.count).toBe(26);

      const pnpmFlagsOnlyCommand = await runTest(
        id,
        { add: ["command=pnpm --config=/tmp/pm-safe,scope=project"] },
        { path: context.pmPath },
      );
      expect(pnpmFlagsOnlyCommand.count).toBe(27);
    });
  });

  it("lists linked tests and returns not-found for unknown ids", async () => {
    await withTempPmPath(async (context) => {
      await expect(runTest("pm-does-not-exist", {}, { path: context.pmPath })).rejects.toMatchObject({
        exitCode: EXIT_CODE.NOT_FOUND,
      });

      const id = createTask(context, "list-tests");
      const result = await runTest(id, {}, { path: context.pmPath });
      expect(result.id).toBe(id);
      expect(result.changed).toBe(false);
      expect(result.count).toBe(0);
      expect(result.run_results).toEqual([]);
    });
  });

  it("supports deduplicated add and mixed remove selectors", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "mutate-tests");
      const added = await runTest(
        id,
        {
          add: [
            "command=node --version,timeout=2,note=implicit project scope",
            "command=node --version,scope=project,timeout_seconds=2,note=duplicate",
            "command=node --version,scope=project,timeout_seconds=2,pm_context_mode=tracker,note=tracker-variant",
            "command=node -e \"process.stdout.write('path-metadata-token')\",path=tests/example.spec.ts,note=implicit project scope",
          ],
          message: "add linked tests",
        },
        { path: context.pmPath },
      );

      expect(added.changed).toBe(true);
      expect(added.count).toBe(3);
      const commandEntry = added.tests.find((entry) => entry.command === "node --version" && !entry.pm_context_mode);
      expect(commandEntry?.scope).toBe("project");
      expect(commandEntry?.timeout_seconds).toBe(2);
      const trackerContextCommandEntry = added.tests.find(
        (entry) => entry.command === "node --version" && entry.pm_context_mode === "tracker",
      );
      expect(trackerContextCommandEntry?.scope).toBe("project");
      expect(trackerContextCommandEntry?.timeout_seconds).toBe(2);
      const pathEntry = added.tests.find((entry) => entry.path === "tests/example.spec.ts");
      expect(pathEntry?.scope).toBe("project");

      const historyPath = path.join(context.pmPath, "history", `${id}.jsonl`);
      const historyBeforeDuplicate = (await readFile(historyPath, "utf8")).trim().split("\n").length;
      const duplicateOnly = await runTest(
        id,
        {
          add: ["command=node --version,scope=project,timeout_seconds=2,note=duplicate only"],
          message: "attempt duplicate linked test",
        },
        { path: context.pmPath },
      );
      expect(duplicateOnly.changed).toBe(false);
      expect(duplicateOnly.count).toBe(3);
      const historyAfterDuplicate = (await readFile(historyPath, "utf8")).trim().split("\n").length;
      expect(historyAfterDuplicate).toBe(historyBeforeDuplicate);

      const noOpRemoval = await runTest(
        id,
        {
          remove: ["path=tests/does-not-exist.spec.ts"],
          message: "attempt non-matching remove",
        },
        { path: context.pmPath },
      );
      expect(noOpRemoval.changed).toBe(false);
      expect(noOpRemoval.count).toBe(3);

      const removed = await runTest(
        id,
        {
          remove: ["path=tests/example.spec.ts", "command=node --version", "node --version"],
          message: "remove all linked tests",
        },
        { path: context.pmPath },
      );
      expect(removed.changed).toBe(true);
      expect(removed.count).toBe(0);
    });
  });

  it("skips history policy for duplicate linked-test no-op mutations", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "strict-history-noop-tests");
      const added = await runTest(
        id,
        {
          add: ["command=node --version,scope=project,timeout_seconds=2"],
          message: "add linked test before strict history no-op",
        },
        { path: context.pmPath },
      );
      expect(added.changed).toBe(true);
      expect(added.count).toBe(1);

      const historyPath = path.join(context.pmPath, "history", `${id}.jsonl`);
      await rm(historyPath);
      const settingsPath = path.join(context.pmPath, "settings.json");
      const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
        history?: { missing_stream?: "auto_create" | "strict_error" };
      };
      settings.history = {
        ...settings.history,
        missing_stream: "strict_error",
      };
      await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

      const duplicateOnly = await runTest(
        id,
        {
          add: ["command=node --version,scope=project,timeout_seconds=2,note=duplicate only"],
          message: "attempt duplicate linked test with strict missing history",
        },
        { path: context.pmPath },
      );
      expect(duplicateOnly.changed).toBe(false);
      expect(duplicateOnly.count).toBe(1);
      await expect(readFile(historyPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("adds linked tests from JSON without losing complex command syntax", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "json-linked-test-add");
      const command = "node -e \"process.stdout.write('comma,value -- flag $tmp')\"";

      const result = await runTest(
        id,
        {
          addJson: [
            JSON.stringify({
              command,
              timeout_seconds: 30,
              assert_stdout_contains: ["comma,value -- flag $tmp"],
              note: "complex shell command",
            }),
          ],
          message: "add json linked test",
        },
        { path: context.pmPath },
      );

      expect(result.changed).toBe(true);
      expect(result.count).toBe(1);
      expect(result.tests[0]).toEqual(
        expect.objectContaining({
          command,
          scope: "project",
          timeout_seconds: 30,
          assert_stdout_contains: ["comma,value -- flag $tmp"],
          note: "complex shell command",
        }),
      );
    });
  });

  it("runs selected linked tests without mutating the stored list", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "selected-linked-test-run");
      await runTest(
        id,
        {
          addJson: [
            JSON.stringify([
              { command: "node -e \"process.stdout.write('alpha')\"" },
              { command: "node -e \"process.stdout.write('beta')\"" },
              { command: "node -e \"process.stdout.write('gamma')\"" },
            ]),
          ],
          message: "seed selector tests",
        },
        { path: context.pmPath },
      );

      const matched = await runTest(id, { run: true, match: "beta" }, { path: context.pmPath });
      expect(matched.count).toBe(3);
      expect(matched.run_results).toHaveLength(1);
      expect(matched.run_results[0]?.stdout).toBe("beta");
      expect(matched.selection).toEqual({
        selector: "match",
        requested: "beta",
        selected_indexes: [2],
        selected_count: 1,
        skipped_count: 2,
      });
      expect(matched.warnings?.[0]).toContain("linked_test_selection:match=beta");

      const indexed = await runTest(id, { run: true, onlyIndex: 1 }, { path: context.pmPath });
      expect(indexed.run_results[0]?.stdout).toBe("alpha");

      const last = await runTest(id, { run: true, onlyLast: true }, { path: context.pmPath });
      expect(last.run_results[0]?.stdout).toBe("gamma");
    });
  });

  it("rejects invalid linked-test run selector combinations", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "invalid-linked-test-selector");
      await runTest(
        id,
        { addJson: [JSON.stringify({ command: "node --version" })], message: "seed selector validation" },
        { path: context.pmPath },
      );

      await expect(runTest(id, { run: true, match: "node", onlyLast: true }, { path: context.pmPath })).rejects.toMatchObject({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(runTest(id, { run: true, onlyIndex: 0 }, { path: context.pmPath })).rejects.toMatchObject({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(runTest(id, { run: true, match: "missing" }, { path: context.pmPath })).rejects.toMatchObject({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(runTest(id, { match: "node" }, { path: context.pmPath })).rejects.toMatchObject({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(runTest(id, { onlyIndex: 1 }, { path: context.pmPath })).rejects.toMatchObject({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(runTest(id, { onlyLast: true }, { path: context.pmPath })).rejects.toMatchObject({
        exitCode: EXIT_CODE.USAGE,
      });
    });
  });

  it("accepts bare commands for agent-friendly linked test entries", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "bare-test-command");
      const result = await runTest(id, { add: ["pnpm build"], message: "add bare command" }, { path: context.pmPath });

      expect(result.changed).toBe(true);
      expect(result.count).toBe(1);
      expect(result.tests).toEqual([
        expect.objectContaining({
          command: "pnpm build",
          scope: "project",
        }),
      ]);
    });
  });

  it("accepts markdown and stdin token payloads for add/remove entries", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "test-markdown-stdin");
      const stdinSpy = vi.spyOn(process, "stdin", "get");

      const addStdin = new PassThrough();
      addStdin.end(["command: node --version", "scope: project", "note: from stdin"].join("\n"));
      Object.defineProperty(addStdin, "isTTY", { value: false, configurable: true });
      stdinSpy.mockReturnValue(addStdin as unknown as NodeJS.ReadStream);
      const addedFromStdin = await runTest(id, { add: ["-"] }, { path: context.pmPath });
      expect(addedFromStdin.count).toBe(1);

      const addedMarkdown = await runTest(
        id,
        {
          add: ["command:node --help,path:tests/markdown-test.spec.ts,scope:project,timeout:5"],
        },
        { path: context.pmPath },
      );
      expect(addedMarkdown.count).toBe(2);

      const removedMarkdown = await runTest(id, { remove: ["path: tests/markdown-test.spec.ts"] }, { path: context.pmPath });
      expect(removedMarkdown.count).toBe(1);

      const removeStdin = new PassThrough();
      removeStdin.end("command: node --version\n");
      Object.defineProperty(removeStdin, "isTTY", { value: false, configurable: true });
      stdinSpy.mockReturnValue(removeStdin as unknown as NodeJS.ReadStream);
      const removedFromStdin = await runTest(id, { remove: ["-"] }, { path: context.pmPath });
      expect(removedFromStdin.count).toBe(0);
    });
  });

  it("resolves mutation author from explicit env settings and unknown fallbacks", async () => {
    await withTempPmPath(async (context) => {
      const explicitId = createTask(context, "explicit-author-test");
      await runTest(
        explicitId,
        {
          add: ["command=node --version,scope=project"],
          author: " explicit-author ",
          message: "explicit author",
        },
        { path: context.pmPath },
      );
      expect(await latestHistoryAuthor(context.pmPath, explicitId)).toBe("explicit-author");

      const envId = createTask(context, "env-author-test");
      await runTest(envId, { add: ["command=node --version,scope=project"], message: "env author" }, { path: context.pmPath });
      expect(await latestHistoryAuthor(context.pmPath, envId)).toBe("test-author");

      const previousPmAuthor = process.env.PM_AUTHOR;
      delete process.env.PM_AUTHOR;
      try {
        await setSettingsAuthorDefault(context.pmPath, "settings-author");
        const settingsId = createTask(context, "settings-author-test");
        await runTest(
          settingsId,
          {
            add: ["command=node --version,scope=project"],
            message: "settings author",
          },
          { path: context.pmPath },
        );
        expect(await latestHistoryAuthor(context.pmPath, settingsId)).toBe("settings-author");

        await setSettingsAuthorDefault(context.pmPath, "   ");
        const unknownId = createTask(context, "unknown-author-test");
        await runTest(
          unknownId,
          {
            add: ["command=node --version,scope=project"],
            author: "   ",
            message: "unknown author",
          },
          { path: context.pmPath },
        );
        expect(await latestHistoryAuthor(context.pmPath, unknownId)).toBe("unknown");
      } finally {
        if (previousPmAuthor === undefined) {
          delete process.env.PM_AUTHOR;
        } else {
          process.env.PM_AUTHOR = previousPmAuthor;
        }
      }
    });
  });

  it("runs linked tests and reports passed failed and skipped results in sandbox", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "run-linked-tests");
      const linked = await runTest(
        id,
        {
          add: [
            "command=node -e \"console.log(process.env.PM_PATH||'');console.log(process.env.PM_GLOBAL_PATH||'')\",scope=project,timeout_seconds=20",
            "command=node -e \"process.exit(3)\",scope=project,timeout_seconds=20",
            "command=node -e \"setTimeout(() => {}, 2000)\",scope=project",
          ],
          message: "seed run entries",
        },
        { path: context.pmPath },
      );
      expect(linked.count).toBe(3);
      await overwriteTaskTests(context, id, [
        ...(linked.tests as unknown as Array<Record<string, unknown>>),
        { path: "tests/no-command.spec.ts", scope: "project" },
      ]);

      const run = await runTest(
        id,
        {
          run: true,
          timeout: "1",
        },
        { path: context.pmPath },
      );
      expect(run.ok).toBe(false);
      expect(run.changed).toBe(false);
      expect(run.count).toBe(4);
      expect(run.run_results).toHaveLength(4);

      const passed = run.run_results.find((entry) => entry.status === "passed");
      expect(passed?.command).toContain("process.env.PM_PATH");
      expect(passed?.stdout ?? "").toContain("pm-linked-test-");
      expect(passed?.stdout ?? "").not.toContain(context.pmPath);
      expect(passed?.stdout ?? "").not.toContain(context.env.PM_GLOBAL_PATH ?? "");

      const commandFailure = run.run_results.find((entry) => entry.command?.includes("process.exit(3)"));
      expect(commandFailure?.status).toBe("failed");
      expect(commandFailure?.exit_code).toBe(3);
      expect(commandFailure?.failure_category).toBe("assertion_failure");

      const timeoutFailure = run.run_results.find((entry) => entry.command?.includes("setTimeout(() => {}, 2000)"));
      expect(timeoutFailure?.status).toBe("failed");
      expect(timeoutFailure?.exit_code).toBe(1);
      expect(timeoutFailure?.failure_category).toBe("timeout");
      expect(timeoutFailure?.error ?? "").toContain("timed out after");
      expect(run.failure_categories.assertion_failure).toBeGreaterThanOrEqual(1);
      expect(run.failure_categories.timeout).toBeGreaterThanOrEqual(1);

      const skipped = run.run_results.find((entry) => entry.status === "skipped");
      expect(skipped?.path).toBe("tests/no-command.spec.ts");
      expect(skipped?.error ?? "").toContain("No command configured");
    });
  });

  it("runs package-script linked tests with sandboxed PM roots", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "package-script-sandbox-roots");
      const packageDir = await mkdtemp(path.join(os.tmpdir(), "pm-linked-package-script-"));
      try {
        await writeFile(
          path.join(packageDir, "package.json"),
          `${JSON.stringify({ scripts: { probe: "node probe.mjs" } }, null, 2)}\n`,
          "utf8",
        );
        await writeFile(
          path.join(packageDir, "probe.mjs"),
          [
            "const project = process.env.PM_PATH || '';",
            "const global = process.env.PM_GLOBAL_PATH || '';",
            "if (!project.includes('pm-linked-test-') || !global.includes('pm-linked-test-')) process.exit(4);",
            "process.stdout.write(`${project}\\n${global}`);",
            "",
          ].join("\n"),
          "utf8",
        );

        await runTest(
          id,
          {
            add: [`command=npm --prefix ${packageDir} run -s probe,scope=project,timeout_seconds=20`],
            message: "seed package script sandbox probe",
          },
          { path: context.pmPath },
        );

        const run = await runTest(id, { run: true, timeout: "20" }, { path: context.pmPath });
        expect(run.ok).toBe(true);
        expect(run.run_results[0]?.status).toBe("passed");
        const stdout = run.run_results[0]?.stdout ?? "";
        expect(stdout).toContain("pm-linked-test-");
        expect(stdout).not.toContain(context.pmPath);
        expect(stdout).not.toContain(context.env.PM_GLOBAL_PATH ?? "");
      } finally {
        await rm(packageDir, { recursive: true, force: true });
      }
    });
  });

  it("applies run-level and per-test env directives with shared-host-safe defaults", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "linked-test-env-directives");
      await runTest(
        id,
        {
          add: [
            "command=node -e \"process.stdout.write([process.env.RUN_LEVEL||'',process.env.CUSTOM_FLAG||'',process.env.PORT||'',process.env.HOST||'',process.env.PM_SHARED_HOST_SAFE||'',String(process.env.DELETE_ME===undefined),process.env.PW_TEST_HTML_REPORT_OPEN||'',process.env.PLAYWRIGHT_HTML_OPEN||''].join('|'))\",scope=project,env_set=RUN_LEVEL=per-test;CUSTOM_FLAG=linked,env_clear=DELETE_ME,shared_host_safe=true",
          ],
          message: "seed env directive command",
        },
        { path: context.pmPath },
      );

      const run = await runTest(
        id,
        {
          run: true,
          timeout: "20",
          envSet: [
            "RUN_LEVEL=run-level",
            "DELETE_ME=remove-me",
            "PORT=4173",
            "HOST=localhost",
            "PM_SHARED_HOST_SAFE=custom",
            "PW_TEST_HTML_REPORT_OPEN=already-open",
            "PLAYWRIGHT_HTML_OPEN=keep-open",
          ],
        },
        { path: context.pmPath },
      );
      expect(run.run_results).toHaveLength(1);
      expect(run.run_results[0]?.status).toBe("passed");
      expect(run.run_results[0]?.stdout ?? "").toContain(
        "per-test|linked|4173|localhost|custom|true|already-open|keep-open",
      );
    });
  });

  it("ignores protected env directive keys from linked metadata while preserving sandbox safety", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "linked-test-protected-env-keys");
      await overwriteTaskTests(context, id, [
        {
          command:
            "node -e \"process.stdout.write([process.env.PM_PATH||'',process.env.PM_GLOBAL_PATH||'',process.env.SAFE_VAR||'',process.env.FORCE_COLOR||''].join('|'))\"",
          scope: "project",
          env_set: {
            PM_PATH: "/tmp/unsafe-pm-path",
            SAFE_VAR: "ok",
          },
          env_clear: ["PM_GLOBAL_PATH", "FORCE_COLOR"],
        },
      ]);

      const run = await runTest(
        id,
        {
          run: true,
          timeout: "20",
        },
        { path: context.pmPath },
      );
      expect(run.run_results[0]?.status).toBe("passed");
      const stdout = run.run_results[0]?.stdout ?? "";
      expect(stdout).toContain("pm-linked-test-");
      expect(stdout).not.toContain("/tmp/unsafe-pm-path");
      expect(stdout).toContain("|ok|0");
    });
  });

  it("runs linked commands with project and global extension type parity", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "linked-sandbox-extension-parity");
      const globalPmRoot = context.env.PM_GLOBAL_PATH;
      expect(typeof globalPmRoot).toBe("string");
      await writeSchemaTypeExtension(context.pmPath, "project-linked-type", "ProjectAsset");
      await writeSchemaTypeExtension(globalPmRoot as string, "global-linked-type", "GlobalAsset");

      const seeded = await runTest(
        id,
        {
          add: [
            "command=node dist/cli.js list --type ProjectAsset --limit 1 --json,scope=project,timeout_seconds=30",
            "command=node dist/cli.js list --type GlobalAsset --limit 1 --json,scope=project,timeout_seconds=30",
          ],
          message: "seed extension parity linked commands",
        },
        { path: context.pmPath },
      );
      expect(seeded.count).toBe(2);

      const run = await runTest(
        id,
        {
          run: true,
          timeout: "30",
          pmContext: "tracker",
        },
        { path: context.pmPath },
      );
      expect(run.run_results).toHaveLength(2);
      expect(run.run_results.every((entry) => entry.status === "passed")).toBe(true);
    });
  });

  it("omits transient runtime data when seeding tracker-mode linked-test sandboxes", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "linked-sandbox-runtime-skip");
      const globalPmRoot = context.env.PM_GLOBAL_PATH;
      expect(typeof globalPmRoot).toBe("string");
      await mkdir(path.join(context.pmPath, "runtime", "telemetry", "flush.lock"), { recursive: true });
      await mkdir(path.join(globalPmRoot as string, "runtime", "telemetry", "flush.lock"), { recursive: true });
      await runTest(
        id,
        {
          add: [
            "command=node -e \"const fs=require('node:fs');const path=require('node:path');process.stdout.write(String(fs.existsSync(path.join(process.env.PM_GLOBAL_PATH,'runtime'))))\",scope=project,timeout_seconds=20",
          ],
          message: "seed runtime skip linked command",
        },
        { path: context.pmPath },
      );

      const run = await runTest(
        id,
        {
          run: true,
          timeout: "20",
          pmContext: "tracker",
        },
        { path: context.pmPath },
      );
      expect(run.run_results[0]?.status).toBe("passed");
      expect(run.run_results[0]?.stdout).toBe("false");
    });
  });

  it("emits PM execution context metadata and supports mismatch guardrails", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "linked-test-pm-context-metadata");
      await runTest(
        id,
        {
          add: ["command=node dist/cli.js list-all --type Task --limit 200 --json,scope=project,timeout_seconds=30"],
          message: "seed PM context command",
        },
        { path: context.pmPath },
      );

      const schemaMode = await runTest(
        id,
        {
          run: true,
          timeout: "30",
        },
        { path: context.pmPath },
      );
      expect(schemaMode.run_results).toHaveLength(1);
      const schemaResult = schemaMode.run_results[0];
      expect(schemaResult?.status).toBe("failed");
      expect(schemaResult?.execution_context).toMatchObject({
        pm_context_mode: "schema",
        is_pm_command: true,
        is_pm_tracker_read_command: true,
      });
      expect(schemaResult?.execution_context?.source_project_item_count ?? 0).toBeGreaterThan(0);
      expect(schemaResult?.execution_context?.mismatch_detected).toBe(true);
      expect(schemaResult?.error ?? "").toContain("context mismatch");

      const schemaPreflight = await runTest(
        id,
        {
          run: true,
          timeout: "30",
          checkContext: true,
        },
        { path: context.pmPath },
      );
      expect(schemaPreflight.run_results[0]?.status).toBe("failed");
      expect(schemaPreflight.run_results[0]?.error ?? "").toContain("preflight PM context mismatch");
      expect(schemaPreflight.warnings?.[0] ?? "").toContain("context_preflight:");

      const autoPreflight = await runTest(
        id,
        {
          run: true,
          timeout: "30",
          checkContext: true,
          autoPmContext: true,
        },
        { path: context.pmPath },
      );
      expect(autoPreflight.run_results[0]?.status).toBe("passed");
      expect(autoPreflight.run_results[0]?.execution_context?.requested_pm_context_mode).toBe("auto");
      expect(autoPreflight.run_results[0]?.execution_context?.auto_pm_context_applied).toBe(true);
      expect(autoPreflight.run_results[0]?.execution_context?.pm_context_mode).toBe("tracker");
      expect(autoPreflight.warnings?.[0] ?? "").toContain("auto_remediated=1");

      const strictMismatch = await runTest(
        id,
        {
          run: true,
          timeout: "30",
          failOnContextMismatch: true,
        },
        { path: context.pmPath },
      );
      expect(strictMismatch.run_results[0]?.status).toBe("failed");
      expect(strictMismatch.run_results[0]?.error ?? "").toContain("context mismatch");

      const trackerMode = await runTest(
        id,
        {
          run: true,
          timeout: "30",
          pmContext: "tracker",
          failOnContextMismatch: true,
        },
        { path: context.pmPath },
      );
      expect(trackerMode.run_results[0]?.status).toBe("passed");
      expect(trackerMode.run_results[0]?.execution_context?.pm_context_mode).toBe("tracker");
      expect(trackerMode.run_results[0]?.execution_context?.mismatch_detected).toBe(false);

      const autoMode = await runTest(
        id,
        {
          run: true,
          timeout: "30",
          pmContext: "auto",
          failOnContextMismatch: true,
        },
        { path: context.pmPath },
      );
      expect(autoMode.run_results[0]?.status).toBe("passed");
      expect(autoMode.run_results[0]?.execution_context?.pm_context_mode).toBe("tracker");
      expect(autoMode.run_results[0]?.execution_context?.mismatch_detected).toBe(false);

      await overwriteTaskTests(context, id, [
        {
          command: "node dist/cli.js list-all --type Task --limit 200 --json",
          scope: "project",
          pm_context_mode: "tracker",
        },
      ]);
      const perTestTracker = await runTest(
        id,
        {
          run: true,
          timeout: "30",
        },
        { path: context.pmPath },
      );
      expect(perTestTracker.run_results[0]?.status).toBe("passed");
      expect(perTestTracker.run_results[0]?.execution_context?.pm_context_mode).toBe("tracker");
      expect(perTestTracker.run_results[0]?.execution_context?.mismatch_detected).toBe(false);

      await overwriteTaskTests(context, id, [
        {
          command: "node dist/cli.js list-all --type Task --limit 200 --json",
          scope: "project",
          pm_context_mode: "schema",
        },
      ]);
      const perTestSchemaOverride = await runTest(
        id,
        {
          run: true,
          timeout: "30",
          pmContext: "tracker",
        },
        { path: context.pmPath },
      );
      expect(perTestSchemaOverride.run_results[0]?.status).toBe("failed");
      expect(perTestSchemaOverride.run_results[0]?.execution_context?.pm_context_mode).toBe("schema");
      expect(perTestSchemaOverride.run_results[0]?.execution_context?.mismatch_detected).toBe(true);
      expect(perTestSchemaOverride.run_results[0]?.error ?? "").toContain("context mismatch");
      expect(perTestSchemaOverride.run_results[0]?.error ?? "").toContain(
        "pm_context_mode=schema overrides run-level --pm-context tracker",
      );

      const runLevelOverride = await runTest(
        id,
        {
          run: true,
          timeout: "30",
          pmContext: "tracker",
          overrideLinkedPmContext: true,
          failOnContextMismatch: true,
        },
        { path: context.pmPath },
      );
      expect(runLevelOverride.run_results[0]?.status).toBe("passed");
      expect(runLevelOverride.run_results[0]?.execution_context?.pm_context_mode).toBe("tracker");
      expect(runLevelOverride.run_results[0]?.execution_context?.mismatch_detected).toBe(false);
    });
  });

  it("evaluates linked-test assertions and strict PM assertion requirement", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "linked-test-assertions");
      await overwriteTaskTests(context, id, [
        {
          command: "node -e \"process.stdout.write(JSON.stringify({count:2}))\"",
          scope: "project",
          assert_stdout_contains: ["count"],
          assert_stdout_regex: ["count"],
          assert_json_field_gte: {
            count: 1,
          },
        },
      ]);

      const passingAssertions = await runTest(
        id,
        {
          run: true,
          timeout: "20",
        },
        { path: context.pmPath },
      );
      expect(passingAssertions.run_results[0]?.status).toBe("passed");

      await overwriteTaskTests(context, id, [
        {
          command: "node -e \"process.stdout.write(JSON.stringify({count:2}))\"",
          scope: "project",
          assert_json_field_gte: {
            count: 5,
          },
        },
      ]);
      const failingAssertions = await runTest(
        id,
        {
          run: true,
          timeout: "20",
        },
        { path: context.pmPath },
      );
      expect(failingAssertions.run_results[0]?.status).toBe("failed");
      expect(failingAssertions.run_results[0]?.failure_category).toBe("assertion_failure");
      expect(failingAssertions.run_results[0]?.error ?? "").toContain("assert_json_field_gte");

      await overwriteTaskTests(context, id, [
        {
          command: "node dist/cli.js list-all --type Task --limit 10 --json",
          scope: "project",
        },
      ]);
      const strictPmAssertions = await runTest(
        id,
        {
          run: true,
          timeout: "20",
          pmContext: "tracker",
          requireAssertionsForPm: true,
        },
        { path: context.pmPath },
      );
      expect(strictPmAssertions.run_results[0]?.status).toBe("failed");
      expect(strictPmAssertions.run_results[0]?.error ?? "").toContain("requires assertions");
    });
  });

  it("handles assertion literal/path edge cases and legacy invalid regex metadata", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "linked-test-assertion-edge-cases");

      await overwriteTaskTests(context, id, [
        {
          command:
            "node -e \"process.stdout.write(JSON.stringify({flag:true,nil:null,obj:{a:1},literal:'{bad}',count:2,label:'ok'}))\"",
          scope: "project",
          assert_stdout_min_lines: 1,
          assert_json_field_equals: {
            flag: "true",
            nil: "null",
            obj: "{\"a\":1}",
            literal: "{bad}",
            count: "2",
            label: "ok",
          },
          assert_json_field_gte: {
            count: 1,
          },
        },
      ]);
      const literalPass = await runTest(
        id,
        {
          run: true,
          timeout: "20",
        },
        { path: context.pmPath },
      );
      expect(literalPass.run_results[0]?.status).toBe("passed");

      await overwriteTaskTests(context, id, [
        {
          command: "node -e \"process.stdout.write(JSON.stringify({obj:{b:2,a:1}}))\"",
          scope: "project",
          assert_json_field_equals: {
            obj: "{\"a\":1,\"b\":2}",
          },
        },
      ]);
      const reorderedObjectPass = await runTest(
        id,
        {
          run: true,
          timeout: "20",
        },
        { path: context.pmPath },
      );
      expect(reorderedObjectPass.run_results[0]?.status).toBe("passed");

      await overwriteTaskTests(context, id, [
        {
          command: "node -e \"process.stdout.write('not-json')\"",
          scope: "project",
          assert_json_field_gte: {
            count: 1,
          },
        },
      ]);
      const invalidJson = await runTest(
        id,
        {
          run: true,
          timeout: "20",
        },
        { path: context.pmPath },
      );
      expect(invalidJson.run_results[0]?.status).toBe("failed");
      expect(invalidJson.run_results[0]?.error ?? "").toContain("not valid JSON");

      await overwriteTaskTests(context, id, [
        {
          command: "node -e \"process.stdout.write(JSON.stringify({count:'abc'}))\"",
          scope: "project",
          assert_json_field_equals: {
            missing: "1",
          },
          assert_json_field_gte: {
            count: 2,
          },
        },
      ]);
      const missingAndNonNumeric = await runTest(
        id,
        {
          run: true,
          timeout: "20",
        },
        { path: context.pmPath },
      );
      expect(missingAndNonNumeric.run_results[0]?.status).toBe("failed");
      expect(missingAndNonNumeric.run_results[0]?.error ?? "").toContain("assert_json_field_equals missing path");
      expect(missingAndNonNumeric.run_results[0]?.error ?? "").toContain("resolved to non-numeric value");

      await overwriteTaskTests(context, id, [
        {
          command: "node -e \"process.stdout.write(JSON.stringify({items:[{value:2}]}))\"",
          scope: "project",
          assert_json_field_equals: {
            "[]": "1",
          },
          assert_json_field_gte: {
            "items[2].value": 1,
          },
        },
      ]);
      const invalidPathSyntax = await runTest(
        id,
        {
          run: true,
          timeout: "20",
        },
        { path: context.pmPath },
      );
      expect(invalidPathSyntax.run_results[0]?.status).toBe("failed");
      expect(invalidPathSyntax.run_results[0]?.error ?? "").toContain('assert_json_field_equals missing path "[]"');
      expect(invalidPathSyntax.run_results[0]?.error ?? "").toContain(
        'assert_json_field_gte missing path "items[2].value"',
      );

      await overwriteTaskTests(context, id, [
        {
          command: "node -e \"process.stdout.write('plain')\"",
          scope: "project",
          assert_stdout_regex: ["["],
          assert_stderr_regex: ["["],
        },
      ]);
      const invalidRegexMetadata = await runTest(
        id,
        {
          run: true,
          timeout: "20",
        },
        { path: context.pmPath },
      );
      expect(invalidRegexMetadata.run_results[0]?.status).toBe("failed");
      expect(invalidRegexMetadata.run_results[0]?.error ?? "").toContain("regex assertion is invalid");

      const boundedRegexStartedAt = Date.now();
      const boundedRegexFailure = testInternals.evaluateLinkedTestAssertions(
        {
          command: "node --version",
          assert_stdout_regex: ["(a+)+$"],
        },
        `${"a".repeat(100_000)}!`,
        "",
      );
      expect(boundedRegexFailure[0]).toContain("regex assertion is invalid");
      expect(Date.now() - boundedRegexStartedAt).toBeLessThan(1_000);
    });
  });

  it("reports fail-on-skipped policy triggers", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "linked-test-fail-on-skipped");
      await overwriteTaskTests(context, id, [{ path: "tests/legacy-path-only.spec.ts", scope: "project" }]);
      const run = await runTest(
        id,
        {
          run: true,
          failOnSkipped: true,
        },
        { path: context.pmPath },
      );
      expect(run.run_results[0]?.status).toBe("skipped");
      expect(run.fail_on_skipped_triggered).toBe(true);
    });
  });

  it("fails empty linked-test runs when fail-on-empty-test-run is enabled", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "linked-test-fail-on-empty-run");
      await runTest(
        id,
        {
          add: ["command=node -e \"console.log('No projects matched the filters')\",scope=project"],
          message: "seed empty-run detector command",
        },
        { path: context.pmPath },
      );

      const runWithoutGuard = await runTest(
        id,
        {
          run: true,
          timeout: "20",
        },
        { path: context.pmPath },
      );
      expect(runWithoutGuard.run_results[0]?.status).toBe("passed");

      const runWithGuard = await runTest(
        id,
        {
          run: true,
          timeout: "20",
          failOnEmptyTestRun: true,
        },
        { path: context.pmPath },
      );
      expect(runWithGuard.run_results[0]?.status).toBe("failed");
      expect(runWithGuard.run_results[0]?.failure_category).toBe("empty_run");
      expect(runWithGuard.run_results[0]?.error ?? "").toContain("empty test run");
      expect(runWithGuard.failure_categories.empty_run).toBe(1);

      const safeId = createTask(context, "linked-test-fail-on-empty-run-safe-output");
      await runTest(
        safeId,
        {
          add: ['command=node -e "console.log(\'executed tests: 1\')",scope=project'],
          message: "seed non-empty-run output",
        },
        { path: context.pmPath },
      );
      const safeRunWithGuard = await runTest(
        safeId,
        {
          run: true,
          timeout: "20",
          failOnEmptyTestRun: true,
        },
        { path: context.pmPath },
      );
      expect(safeRunWithGuard.run_results[0]?.status).toBe("passed");
      expect(safeRunWithGuard.failure_categories.empty_run).toBe(0);
    });
  });

  it("reports deterministic maxBuffer diagnostics for noisy linked commands", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "linked-test-max-buffer");
      await runTest(
        id,
        {
          add: ['command=node -e "process.stdout.write(\'x\'.repeat(22 * 1024 * 1024))",scope=project,timeout_seconds=20'],
          message: "seed maxBuffer test",
        },
        { path: context.pmPath },
      );

      const run = await runTest(
        id,
        {
          run: true,
          timeout: "20",
        },
        { path: context.pmPath },
      );

      expect(run.run_results).toHaveLength(1);
      expect(run.run_results[0]?.status).toBe("failed");
      expect(run.run_results[0]?.exit_code).toBe(1);
      expect(run.run_results[0]?.error ?? "").toContain("maxBuffer=20971520");
    });
  });

  it("terminates stubborn timed-out linked commands without hanging", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "linked-test-stubborn-timeout");
      await runTest(
        id,
        {
          add: ['command=node -e "process.on(\'SIGTERM\', () => {}); setInterval(() => {}, 1000)",scope=project'],
          message: "seed stubborn timeout command",
        },
        { path: context.pmPath },
      );

      const previousForceKillDelay = process.env.PM_LINKED_TEST_TIMEOUT_FORCE_KILL_DELAY_MS;
      process.env.PM_LINKED_TEST_TIMEOUT_FORCE_KILL_DELAY_MS = "20";
      try {
        const startedAt = Date.now();
        const run = await runTest(
          id,
          {
            run: true,
            timeout: "1",
          },
          { path: context.pmPath },
        );
        const elapsedMs = Date.now() - startedAt;

        expect(elapsedMs).toBeLessThan(3000);
        expect(run.run_results).toHaveLength(1);
        expect(run.run_results[0]?.status).toBe("failed");
        expect(run.run_results[0]?.error ?? "").toContain("timed out after");
      } finally {
        if (previousForceKillDelay === undefined) {
          delete process.env.PM_LINKED_TEST_TIMEOUT_FORCE_KILL_DELAY_MS;
        } else {
          process.env.PM_LINKED_TEST_TIMEOUT_FORCE_KILL_DELAY_MS = previousForceKillDelay;
        }
      }
    });
  });

  it("settles on normal close before the pipe grace fallback even with invalid grace env", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "linked-test-normal-close-invalid-pipe-grace");
      await runTest(
        id,
        {
          add: ['command=node -e "process.stdout.write(\'normal-close\')",scope=project'],
          message: "seed normal close command",
        },
        { path: context.pmPath },
      );

      const previousPipeCloseGrace = process.env.PM_LINKED_TEST_PIPE_CLOSE_GRACE_MS;
      process.env.PM_LINKED_TEST_PIPE_CLOSE_GRACE_MS = "not-a-number";
      try {
        const startedAt = Date.now();
        const run = await runTest(
          id,
          {
            run: true,
            timeout: "5",
          },
          { path: context.pmPath },
        );
        const elapsedMs = Date.now() - startedAt;

        expect(elapsedMs).toBeLessThan(3000);
        expect(run.run_results).toHaveLength(1);
        expect(run.run_results[0]?.status).toBe("passed");
        expect(run.run_results[0]?.stdout).toBe("normal-close");
        expect(run.run_results[0]?.exit_code).toBe(0);
      } finally {
        if (previousPipeCloseGrace === undefined) {
          delete process.env.PM_LINKED_TEST_PIPE_CLOSE_GRACE_MS;
        } else {
          process.env.PM_LINKED_TEST_PIPE_CLOSE_GRACE_MS = previousPipeCloseGrace;
        }
      }
    });
  });

  it("finishes when a linked command exits but a descendant keeps inherited pipes open", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "linked-test-inherited-pipe-descendant");
      const scriptPath = path.join(context.tempRoot, "inherited-pipe-descendant.cjs");
      await writeFile(
        scriptPath,
        [
          "const { spawn } = require('node:child_process');",
          "const child = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 2000)'], { detached: true, stdio: 'inherit' });",
          "child.unref();",
          "process.exit(0);",
          "",
        ].join("\n"),
        "utf8",
      );
      await runTest(
        id,
        {
          add: [`command=${process.execPath} ${scriptPath},scope=project`],
          message: "seed inherited pipe descendant command",
        },
        { path: context.pmPath },
      );

      const previousPipeCloseGrace = process.env.PM_LINKED_TEST_PIPE_CLOSE_GRACE_MS;
      process.env.PM_LINKED_TEST_PIPE_CLOSE_GRACE_MS = "20";
      try {
        const startedAt = Date.now();
        const run = await runTest(
          id,
          {
            run: true,
            timeout: "5",
          },
          { path: context.pmPath },
        );
        const elapsedMs = Date.now() - startedAt;

        expect(elapsedMs).toBeLessThan(3000);
        expect(run.run_results).toHaveLength(1);
        expect(run.run_results[0]?.status).toBe("passed");
        expect(run.run_results[0]?.exit_code).toBe(0);
      } finally {
        if (previousPipeCloseGrace === undefined) {
          delete process.env.PM_LINKED_TEST_PIPE_CLOSE_GRACE_MS;
        } else {
          process.env.PM_LINKED_TEST_PIPE_CLOSE_GRACE_MS = previousPipeCloseGrace;
        }
      }
    });
  });

  it("emits heartbeat progress to stderr for interactive terminal runs", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "linked-test-heartbeat-progress");
      await runTest(
        id,
        {
          add: ['command=node -e "setTimeout(() => {}, 60)",scope=project,timeout_seconds=5'],
          message: "seed heartbeat command",
        },
        { path: context.pmPath },
      );

      await expectHeartbeatProgressRun(context, id, { isTTY: true });
    });
  });

  it("emits heartbeat progress when --progress is enabled in non-interactive runs", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "linked-test-forced-progress");
      await runTest(
        id,
        {
          add: ['command=node -e "setTimeout(() => {}, 60)",scope=project,timeout_seconds=5'],
          message: "seed forced progress command",
        },
        { path: context.pmPath },
      );

      await expectHeartbeatProgressRun(context, id, { isTTY: false, progress: true });
    });
  });

  it("records progress failure reasons for timeout, max-buffer, and signal failures", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "linked-test-progress-failure-reasons");
      const includeSignalFixture = process.platform !== "win32";
      await runTest(
        id,
        {
          add: [
            ...(includeSignalFixture
              ? [
                  "command=PM_SIGNAL_TARGET=$$ node -e \"process.kill(Number(process.env.PM_SIGNAL_TARGET),'SIGTERM')\",scope=project,timeout_seconds=5",
                ]
              : []),
            "command=node -e \"setTimeout(() => {}, 2000)\" && echo xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx,scope=project,timeout_seconds=1",
            'command=node -e "process.stdout.write(\'x\'.repeat(22 * 1024 * 1024))",scope=project,timeout_seconds=20',
          ],
          message: "seed progress reason commands",
        },
        { path: context.pmPath },
      );

      const previousHeartbeatInterval = process.env.PM_LINKED_TEST_HEARTBEAT_INTERVAL_MS;
      process.env.PM_LINKED_TEST_HEARTBEAT_INTERVAL_MS = "not-a-number";
      const originalIsTTY = process.stderr.isTTY;
      Object.defineProperty(process.stderr, "isTTY", {
        value: false,
        configurable: true,
      });
      const stderrWriteSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        const run = await runTest(
          id,
          {
            run: true,
            progress: true,
          },
          { path: context.pmPath },
        );
        expect(run.run_results).toHaveLength(includeSignalFixture ? 3 : 2);
        const categories = run.run_results
          .filter((entry) => entry.status === "failed")
          .map((entry) => entry.failure_category)
          .sort();
        expect(categories).toEqual(includeSignalFixture ? ["max_buffer", "signal", "timeout"] : ["max_buffer", "timeout"]);

        const stderrOutput = stderrWriteSpy.mock.calls.map((entry) => String(entry[0])).join("");
        expect(stderrOutput).toContain("reason=timeout");
        expect(stderrOutput).toContain("reason=max_buffer");
        if (includeSignalFixture) {
          expect(stderrOutput).toContain("signal=SIGTERM");
        }
      } finally {
        if (previousHeartbeatInterval === undefined) {
          delete process.env.PM_LINKED_TEST_HEARTBEAT_INTERVAL_MS;
        } else {
          process.env.PM_LINKED_TEST_HEARTBEAT_INTERVAL_MS = previousHeartbeatInterval;
        }
        Object.defineProperty(process.stderr, "isTTY", {
          value: originalIsTTY,
          configurable: true,
        });
      }
    });
  });

  it("reports JSON assertion mismatch and missing-path failures", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "json-assertion-mismatch");
      await runTest(
        id,
        {
          add: [
            "command=node -e \"process.stdout.write(JSON.stringify({count:1}))\",scope=project,assert_json_field_equals=count=2,assert_json_field_gte=missing=1",
          ],
        },
        { path: context.pmPath },
      );

      const result = await runTest(
        id,
        {
          run: true,
          timeout: "20",
        },
        { path: context.pmPath },
      );
      expect(result.run_results).toHaveLength(1);
      expect(result.run_results[0]?.status).toBe("failed");
      expect(result.run_results[0]?.error ?? "").toContain("assert_json_field_equals mismatch");
      expect(result.run_results[0]?.error ?? "").toContain('assert_json_field_gte missing path "missing"');
    });
  });

  it("reports stderr assertion and minimum stdout line failures", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "stderr-and-line-assertions");
      await runTest(
        id,
        {
          add: [
            "command=node -e \"process.stdout.write('ok\\n')\",scope=project,assert_stderr_contains=boom,assert_stderr_regex=boom.*,assert_stdout_min_lines=2",
          ],
        },
        { path: context.pmPath },
      );

      const result = await runTest(
        id,
        {
          run: true,
          timeout: "20",
        },
        { path: context.pmPath },
      );
      expect(result.run_results).toHaveLength(1);
      expect(result.run_results[0]?.status).toBe("failed");
      const error = result.run_results[0]?.error ?? "";
      expect(error).toContain('stderr missing required text: "boom"');
      expect(error).toContain("stderr failed regex assertion: /boom.*/m");
      expect(error).toContain("stdout line count 1 is below required minimum 2");
    });
  });

  it("evaluates array JSON-path assertions and false literals", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "json-array-path-assertions");
      await runTest(
        id,
        {
          add: [
            "command=node -e \"process.stdout.write(JSON.stringify({items:[{flag:true}]}))\",scope=project,assert_stdout_contains=missing-text,assert_json_field_equals=items[0].flag=false",
          ],
        },
        { path: context.pmPath },
      );

      const result = await runTest(
        id,
        {
          run: true,
          timeout: "20",
        },
        { path: context.pmPath },
      );
      expect(result.run_results).toHaveLength(1);
      expect(result.run_results[0]?.status).toBe("failed");
      const error = result.run_results[0]?.error ?? "";
      expect(error).toContain('stdout missing required text: "missing-text"');
      expect(error).toContain('assert_json_field_equals mismatch at "items[0].flag"');
    });
  });

  it("records item test_runs summaries when tracking is enabled", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "track-test-run-summary");
      await runTest(
        id,
        {
          add: ["command=node --version,scope=project"],
        },
        { path: context.pmPath },
      );
      await setTestResultTracking(context.pmPath, true);

      const previousRunId = process.env.PM_BACKGROUND_TEST_RUN_ID;
      const previousAttempt = process.env.PM_BACKGROUND_TEST_RUN_ATTEMPT;
      const previousResumedFrom = process.env.PM_BACKGROUND_TEST_RUN_RESUMED_FROM;
      process.env.PM_BACKGROUND_TEST_RUN_ID = "tr-unit-success";
      process.env.PM_BACKGROUND_TEST_RUN_ATTEMPT = "2";
      process.env.PM_BACKGROUND_TEST_RUN_RESUMED_FROM = "tr-previous";
      try {
        const result = await runTest(
          id,
          {
            run: true,
            timeout: "20",
          },
          { path: context.pmPath },
        );
        expect(result.warnings).toBeUndefined();
        const itemMetadata = await loadTaskMetadata(context, id);
        const testRuns = (itemMetadata.test_runs ?? []) as Array<Record<string, unknown>>;
        expect(testRuns).toHaveLength(1);
        expect(testRuns[0]).toMatchObject({
          run_id: "tr-unit-success",
          kind: "test",
          status: "passed",
          attempt: 2,
          resumed_from: "tr-previous",
        });
      } finally {
        if (previousRunId === undefined) {
          delete process.env.PM_BACKGROUND_TEST_RUN_ID;
        } else {
          process.env.PM_BACKGROUND_TEST_RUN_ID = previousRunId;
        }
        if (previousAttempt === undefined) {
          delete process.env.PM_BACKGROUND_TEST_RUN_ATTEMPT;
        } else {
          process.env.PM_BACKGROUND_TEST_RUN_ATTEMPT = previousAttempt;
        }
        if (previousResumedFrom === undefined) {
          delete process.env.PM_BACKGROUND_TEST_RUN_RESUMED_FROM;
        } else {
          process.env.PM_BACKGROUND_TEST_RUN_RESUMED_FROM = previousResumedFrom;
        }
      }
    });
  });

  it("does not record item test_runs summaries when tracking is disabled", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "skip-test-run-summary-when-disabled");
      await runTest(
        id,
        {
          add: ["command=node --version,scope=project"],
        },
        { path: context.pmPath },
      );
      await setTestResultTracking(context.pmPath, false);

      const result = await runTest(
        id,
        {
          run: true,
          timeout: "20",
        },
        { path: context.pmPath },
      );

      expect(result.run_results[0]?.status).toBe("passed");
      const itemMetadata = await loadTaskMetadata(context, id);
      expect(itemMetadata.test_runs).toBeUndefined();
    });
  });

  it("normalizes invalid background metadata while tracking test_runs summaries", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "track-test-run-invalid-background-metadata");
      await runTest(
        id,
        {
          add: ["command=node --version,scope=project"],
        },
        { path: context.pmPath },
      );
      await setTestResultTracking(context.pmPath, true);

      const previousRunId = process.env.PM_BACKGROUND_TEST_RUN_ID;
      const previousAttempt = process.env.PM_BACKGROUND_TEST_RUN_ATTEMPT;
      const previousResumedFrom = process.env.PM_BACKGROUND_TEST_RUN_RESUMED_FROM;
      process.env.PM_BACKGROUND_TEST_RUN_ID = "  ";
      process.env.PM_BACKGROUND_TEST_RUN_ATTEMPT = "not-a-number";
      process.env.PM_BACKGROUND_TEST_RUN_RESUMED_FROM = "   ";
      try {
        const result = await runTest(
          id,
          {
            run: true,
            timeout: "20",
          },
          { path: context.pmPath },
        );
        expect(result.warnings).toBeUndefined();
        const itemMetadata = await loadTaskMetadata(context, id);
        const testRuns = (itemMetadata.test_runs ?? []) as Array<Record<string, unknown>>;
        expect(testRuns).toHaveLength(1);
        expect(testRuns[0]?.run_id).toMatch(/^test-local-/);
        expect(testRuns[0]).toMatchObject({
          kind: "test",
          status: "passed",
        });
        expect(testRuns[0]?.attempt).toBeUndefined();
        expect(testRuns[0]?.resumed_from).toBeUndefined();
      } finally {
        if (previousRunId === undefined) {
          delete process.env.PM_BACKGROUND_TEST_RUN_ID;
        } else {
          process.env.PM_BACKGROUND_TEST_RUN_ID = previousRunId;
        }
        if (previousAttempt === undefined) {
          delete process.env.PM_BACKGROUND_TEST_RUN_ATTEMPT;
        } else {
          process.env.PM_BACKGROUND_TEST_RUN_ATTEMPT = previousAttempt;
        }
        if (previousResumedFrom === undefined) {
          delete process.env.PM_BACKGROUND_TEST_RUN_RESUMED_FROM;
        } else {
          process.env.PM_BACKGROUND_TEST_RUN_RESUMED_FROM = previousResumedFrom;
        }
      }
    });
  });

  it("bounds and normalizes tracked test_run history when appending directly", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "append-tracked-test-run-normalization");
      await overwriteTaskTestRuns(context, id, [
        {
          run_id: "   ",
          kind: "test",
          status: "passed",
          started_at: "2026-01-01T00:00:00.000Z",
          finished_at: "2026-01-01T00:00:01.000Z",
          recorded_at: "2026-01-01T00:00:02.000Z",
          passed: 1,
          failed: 0,
          skipped: 0,
        },
        {
          run_id: "tr-newer",
          kind: "test",
          status: "passed",
          started_at: "2026-01-01T00:00:00.000Z",
          finished_at: "2026-01-01T00:00:01.000Z",
          recorded_at: "2026-01-01T00:00:05.000Z",
          passed: 1,
          failed: 0,
          skipped: 0,
        },
        {
          run_id: "tr-same",
          kind: "test-all",
          status: "failed",
          started_at: "2026-01-01T00:00:00.000Z",
          finished_at: "2026-01-01T00:00:01.000Z",
          recorded_at: "2026-01-01T00:00:04.000Z",
          passed: 0,
          failed: 1,
          skipped: 0,
        },
      ]);

      const previousLimit = process.env.PM_TRACKED_TEST_RUN_HISTORY_LIMIT;
      process.env.PM_TRACKED_TEST_RUN_HISTORY_LIMIT = "2";
      try {
        await appendTrackedTestRunSummary({
          pmRoot: context.pmPath,
          settings: await readSettings(context.pmPath),
          itemId: id,
          author: "tracking-unit",
          message: "append bounded tracking summary",
          entry: {
            run_id: "tr-same",
            kind: "test",
            status: "passed",
            started_at: "2026-01-01T00:00:00.000Z",
            finished_at: "2026-01-01T00:00:01.000Z",
            recorded_at: "2026-01-01T00:00:04.000Z",
            passed: 1,
            failed: 0,
            skipped: 0,
          },
        });
      } finally {
        if (previousLimit === undefined) {
          delete process.env.PM_TRACKED_TEST_RUN_HISTORY_LIMIT;
        } else {
          process.env.PM_TRACKED_TEST_RUN_HISTORY_LIMIT = previousLimit;
        }
      }

      const itemMetadata = await loadTaskMetadata(context, id);
      const testRuns = (itemMetadata.test_runs ?? []) as Array<Record<string, unknown>>;
      expect(testRuns.map((entry) => `${entry.run_id}:${entry.kind}`)).toEqual(["tr-same:test-all", "tr-newer:test"]);

      process.env.PM_TRACKED_TEST_RUN_HISTORY_LIMIT = "invalid";
      try {
        await appendTrackedTestRunSummary({
          pmRoot: context.pmPath,
          settings: await readSettings(context.pmPath),
          itemId: id,
          author: "tracking-unit",
          entry: {
            run_id: "tr-after-invalid-limit",
            kind: "test",
            status: "passed",
            started_at: "2026-01-01T00:00:00.000Z",
            finished_at: "2026-01-01T00:00:01.000Z",
            recorded_at: "2026-01-01T00:00:06.000Z",
            passed: 1,
            failed: 0,
            skipped: 0,
          },
        });
      } finally {
        if (previousLimit === undefined) {
          delete process.env.PM_TRACKED_TEST_RUN_HISTORY_LIMIT;
        } else {
          process.env.PM_TRACKED_TEST_RUN_HISTORY_LIMIT = previousLimit;
        }
      }

      const afterInvalidLimit = await loadTaskMetadata(context, id);
      const afterRuns = (afterInvalidLimit.test_runs ?? []) as Array<Record<string, unknown>>;
      expect(afterRuns.map((entry) => entry.run_id)).toContain("tr-after-invalid-limit");

      const sortId = createTask(context, "append-tracked-test-run-run-id-sort");
      await overwriteTaskTestRuns(context, sortId, [
        {
          run_id: "tr-b",
          kind: "test",
          status: "passed",
          started_at: "2026-01-01T00:00:00.000Z",
          finished_at: "2026-01-01T00:00:01.000Z",
          recorded_at: "2026-01-01T00:00:07.000Z",
          passed: 1,
          failed: 0,
          skipped: 0,
        },
      ]);
      await appendTrackedTestRunSummary({
        pmRoot: context.pmPath,
        settings: await readSettings(context.pmPath),
        itemId: sortId,
        author: "tracking-unit",
        entry: {
          run_id: "tr-a",
          kind: "test",
          status: "passed",
          started_at: "2026-01-01T00:00:00.000Z",
          finished_at: "2026-01-01T00:00:01.000Z",
          recorded_at: "2026-01-01T00:00:07.000Z",
          passed: 1,
          failed: 0,
          skipped: 0,
        },
      });
      const sortedItemMetadata = await loadTaskMetadata(context, sortId);
      const sortedRuns = (sortedItemMetadata.test_runs ?? []) as Array<Record<string, unknown>>;
      expect(sortedRuns.map((entry) => entry.run_id)).toEqual(["tr-a", "tr-b"]);
    });
  });

  it("returns tracking warnings when summary persistence cannot mutate item", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "track-test-run-warning");
      setGovernancePreset(context, "strict");
      await runTest(
        id,
        {
          add: ["command=node --version,scope=project"],
        },
        { path: context.pmPath },
      );
      await setTestResultTracking(context.pmPath, true);
      const reassigned = context.runCli(
        ["update", "--json", id, "--assignee", "other-owner", "--message", "Reassign for tracking warning branch"],
        { expectJson: true },
      );
      expect(reassigned.code).toBe(0);

      const result = await runTest(
        id,
        {
          run: true,
        },
        { path: context.pmPath },
      );
      expect(result.run_results[0]?.status).toBe("passed");
      expect(result.warnings?.[0] ?? "").toContain("test_result_tracking_failed");
    });
  });
});

describe("linked test run selectors", () => {
  it("formats long linked-test entries and validates selector errors", () => {
    const longCommand = `pnpm test -- ${"very-long-segment ".repeat(8)}`.trim();
    const tests = [
      { command: longCommand, scope: "project" as const },
      { path: "tests/unit/output.spec.ts", scope: "project" as const },
      { scope: "project" as const },
    ];

    const description = describeLinkedTestEntries(tests);
    expect(description).toContain("...");
    expect(description).toContain("2. tests/unit/output.spec.ts");
    expect(description).toContain("3. <no command>");

    // A label that normalizes to an empty string falls back to the placeholder.
    expect(describeLinkedTestEntries([{ command: "   ", scope: "project" as const }])).toBe("1. <no command>");

    expect(parseOnlyIndexValue(" 2 ")).toBe(2);
    expect(() => parseOnlyIndexValue("0", "--only-index")).toThrow(/1-based integer index/);
    expect(() => resolveLinkedTestRunSelection(tests, { match: "output", onlyLast: true })).toThrow(/Combine at most one/);
    expect(() => resolveLinkedTestRunSelection([], { onlyLast: true })).toThrow(/this item has none/);
    expect(() => resolveLinkedTestRunSelection(tests, { match: "   " })).toThrow(/non-empty substring/);
    expect(() => resolveLinkedTestRunSelection(tests, { match: "missing" })).toThrow(/Available entries/);
    expect(() => resolveLinkedTestRunSelection(tests, { onlyIndex: 9 })).toThrow(/out of range/);
  });

  it("selects all, matching, indexed, and last linked tests", () => {
    const tests = [
      { command: "pnpm test -- tests/unit/output.spec.ts", scope: "project" as const },
      { path: "tests/unit/settings-store.spec.ts", scope: "project" as const },
      { command: "pnpm typecheck", scope: "project" as const },
    ];

    expect(resolveLinkedTestRunSelection(tests, {})).toMatchObject({
      selector: null,
      selected_indexes: [1, 2, 3],
      selected_count: 3,
      skipped_count: 0,
    });
    expect(resolveLinkedTestRunSelection(tests, { match: "SETTINGS" })).toMatchObject({
      selector: "match",
      requested: "SETTINGS",
      selected_indexes: [2],
      selected_count: 1,
      skipped_count: 2,
    });
    expect(resolveLinkedTestRunSelection(tests, { onlyIndex: 1 })).toMatchObject({
      selector: "only-index",
      requested: "1",
      selected: [tests[0]],
      selected_indexes: [1],
    });
    expect(resolveLinkedTestRunSelection(tests, { onlyLast: true })).toMatchObject({
      selector: "only-last",
      requested: "last",
      selected: [tests[2]],
      selected_indexes: [3],
      skipped_count: 2,
    });
  });
});
