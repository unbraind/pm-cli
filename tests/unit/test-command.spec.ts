import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyLinkedTestFailure,
  countFailureCategories,
  extractReferencedPmItemIdsFromCommand,
  resolveLinkedTestFailureExitCode,
  runTest,
} from "../../src/cli/commands/test.js";
import { EXIT_CODE } from "../../src/core/shared/constants.js";
import { parseItemDocument, serializeItemDocument } from "../../src/core/item/item-format.js";
import { withTempPmPath, type TempPmContext } from "../helpers/withTempPmPath.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function createTask(context: TempPmContext, title: string): string {
  const result = context.runCli(
    [
      "create",
      "--json",
      "--title",
      title,
      "--description",
      `${title} description`,
      "--type",
      "Task",
      "--status",
      "open",
      "--priority",
      "1",
      "--tags",
      "testing",
      "--body",
      "",
      "--deadline",
      "none",
      "--estimate",
      "10",
      "--acceptance-criteria",
      `${title} acceptance`,
      "--author",
      "test-author",
      "--message",
      `Create ${title}`,
      "--assignee",
      "none",
      "--dep",
      "none",
      "--comment",
      "none",
      "--note",
      "none",
      "--learning",
      "none",
      "--file",
      "none",
      "--test",
      "none",
      "--doc",
      "none",
    ],
    { expectJson: true },
  );
  expect(result.code).toBe(0);
  return (result.json as { item: { id: string } }).item.id;
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

async function setTestResultTracking(pmPath: string, enabled: boolean): Promise<void> {
  const settingsPath = path.join(pmPath, "settings.json");
  const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
    testing?: { record_results_to_items?: boolean };
  };
  settings.testing = {
    ...(settings.testing ?? {}),
    record_results_to_items: enabled,
  };
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

function setGovernancePreset(context: TempPmContext, preset: "minimal" | "default" | "strict" | "custom"): void {
  const result = context.runCli(["config", "project", "set", "governance-preset", "--policy", preset, "--json"], {
    expectJson: true,
  });
  expect(result.code).toBe(0);
}

async function loadTaskFrontMatter(context: TempPmContext, id: string): Promise<Record<string, unknown>> {
  const toonPath = path.join(context.pmPath, "tasks", `${id}.toon`);
  const markdownPath = path.join(context.pmPath, "tasks", `${id}.md`);
  let taskPath = toonPath;
  let source: string;
  try {
    source = await readFile(taskPath, "utf8");
  } catch {
    taskPath = markdownPath;
    source = await readFile(taskPath, "utf8");
  }
  const format = taskPath.endsWith(".toon") ? "toon" : "json_markdown";
  return parseItemDocument(source, { format }).metadata as unknown as Record<string, unknown>;
}

async function overwriteTaskTests(
  context: TempPmContext,
  id: string,
  tests: Array<Record<string, unknown>>,
): Promise<void> {
  const toonPath = path.join(context.pmPath, "tasks", `${id}.toon`);
  const markdownPath = path.join(context.pmPath, "tasks", `${id}.md`);
  let taskPath = toonPath;
  let source: string;
  try {
    source = await readFile(taskPath, "utf8");
  } catch {
    taskPath = markdownPath;
    source = await readFile(taskPath, "utf8");
  }
  const format = taskPath.endsWith(".toon") ? "toon" : "json_markdown";
  const parsed = parseItemDocument(source, { format });
  parsed.metadata.tests = tests as unknown as never;
  await writeFile(taskPath, serializeItemDocument(parsed, { format }), "utf8");
}

async function writeSchemaTypeExtension(pmRoot: string, extensionDirName: string, typeName: string): Promise<void> {
  const extensionDir = path.join(pmRoot, "extensions", extensionDirName);
  await mkdir(extensionDir, { recursive: true });
  await writeFile(
    path.join(extensionDir, "manifest.json"),
    `${JSON.stringify(
      {
        name: `${extensionDirName}-ext`,
        version: "1.0.0",
        entry: "index.mjs",
        capabilities: ["schema"],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(
    path.join(extensionDir, "index.mjs"),
    [
      "export function activate(api) {",
      "  api.registerItemTypes([",
      `    { name: \"${typeName}\", folder: \"${typeName.toLowerCase()}\" },`,
      "  ]);",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
}

describe("runTest", () => {
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

  it("rejects sandbox-unsafe test-runner commands and allows sandbox-safe variants", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "reject-unsafe-test-runners");
      const unsafeRunnerCommands = [
        "command=pnpm test,scope=project",
        "command=pnpm test:coverage,scope=project",
        "command=pnpm --dir /tmp test -- --runInBand,scope=project",
        "command=pnpm -C /tmp test:coverage,scope=project",
        "command=npm test -- --runInBand,scope=project",
        "command=npm run test -- --runInBand,scope=project",
        "command=npm --prefix /tmp test -- --runInBand,scope=project",
        "command=pnpm run test -- --runInBand,scope=project",
        "command=npm --cache /tmp vitest run,scope=project",
        "command=yarn --cwd /tmp test,scope=project",
        "command=yarn run test,scope=project",
        "command=bun --cwd /tmp test,scope=project",
        "command=bun run test,scope=project",
        "command=npx --yes vitest run,scope=project",
        "command=vitest run,scope=project",
        "command=./node_modules/.bin/vitest run,scope=project",
        "command=node --test tests/unit/example.test.js,scope=project",
        "command=node scripts/run-tests.mjs test && pnpm test,scope=project",
        "command=node ./scripts/run-tests.mjs coverage; vitest run,scope=project",
        "command=PM_PATH=/tmp/pm-safe PM_GLOBAL_PATH=/tmp/pm-global echo seeded && pnpm test -- --runInBand,scope=project",
      ];

      for (const addEntry of unsafeRunnerCommands) {
        await expect(runTest(id, { add: [addEntry] }, { path: context.pmPath })).rejects.toMatchObject({
          exitCode: EXIT_CODE.USAGE,
        });
      }

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

      const nonRunnerCommand = await runTest(id, { add: ["command=pnpm build,scope=project"] }, { path: context.pmPath });
      expect(nonRunnerCommand.count).toBe(7);

      const envOnlyCommand = await runTest(
        id,
        {
          add: ["command=PM_PATH=/tmp/pm-safe PM_GLOBAL_PATH=/tmp/pm-global,scope=project"],
        },
        { path: context.pmPath },
      );
      expect(envOnlyCommand.count).toBe(8);

      const npxFlagOnlyCommand = await runTest(id, { add: ["command=npx --yes,scope=project"] }, { path: context.pmPath });
      expect(npxFlagOnlyCommand.count).toBe(9);

      const pmFlagsOnlyCommand = await runTest(id, { add: ["command=pm --json,scope=project"] }, { path: context.pmPath });
      expect(pmFlagsOnlyCommand.count).toBe(10);

      const npxNonPmCommand = await runTest(id, { add: ["command=npx cowsay hello,scope=project"] }, { path: context.pmPath });
      expect(npxNonPmCommand.count).toBe(11);

      const npxScopedNonPmCommand = await runTest(
        id,
        { add: ["command=npx @scope hello,scope=project"] },
        { path: context.pmPath },
      );
      expect(npxScopedNonPmCommand.count).toBe(12);

      const pnpmDlxNonPmCommand = await runTest(
        id,
        { add: ["command=pnpm dlx cowsay hello,scope=project"] },
        { path: context.pmPath },
      );
      expect(pnpmDlxNonPmCommand.count).toBe(13);

      const npmExecNonPmCommand = await runTest(
        id,
        { add: ["command=npm exec -- cowsay hello,scope=project"] },
        { path: context.pmPath },
      );
      expect(npmExecNonPmCommand.count).toBe(14);

      const pnpmFlagsOnlyCommand = await runTest(
        id,
        { add: ["command=pnpm --config=/tmp/pm-safe,scope=project"] },
        { path: context.pmPath },
      );
      expect(pnpmFlagsOnlyCommand.count).toBe(15);
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
            "command=node --version,scope=project,timeout=2.9,note=version",
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

      const noOpRemoval = await runTest(
        id,
        {
          remove: ["path=tests/does-not-exist.spec.ts"],
          message: "attempt non-matching remove",
        },
        { path: context.pmPath },
      );
      expect(noOpRemoval.changed).toBe(true);
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
          timeout: "0.01",
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

  it("applies run-level and per-test env directives with shared-host-safe defaults", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "linked-test-env-directives");
      await runTest(
        id,
        {
          add: [
            "command=node -e \"process.stdout.write([process.env.RUN_LEVEL||'',process.env.CUSTOM_FLAG||'',process.env.PORT||'',process.env.HOST||'',process.env.PM_SHARED_HOST_SAFE||'',String(process.env.DELETE_ME===undefined)].join('|'))\",scope=project,env_set=RUN_LEVEL=per-test;CUSTOM_FLAG=linked,env_clear=DELETE_ME,shared_host_safe=true",
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
          envSet: ["RUN_LEVEL=run-level", "DELETE_ME=remove-me"],
        },
        { path: context.pmPath },
      );
      expect(run.run_results).toHaveLength(1);
      expect(run.run_results[0]?.status).toBe("passed");
      expect(run.run_results[0]?.stdout ?? "").toContain("per-test|linked|0|127.0.0.1|1|true");
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
            timeout: "0.02",
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

      const previousHeartbeatInterval = process.env.PM_LINKED_TEST_HEARTBEAT_INTERVAL_MS;
      process.env.PM_LINKED_TEST_HEARTBEAT_INTERVAL_MS = "10";
      const originalIsTTY = process.stderr.isTTY;
      Object.defineProperty(process.stderr, "isTTY", {
        value: true,
        configurable: true,
      });
      const stderrWriteSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        const run = await runTest(
          id,
          {
            run: true,
            timeout: "5",
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

      const previousHeartbeatInterval = process.env.PM_LINKED_TEST_HEARTBEAT_INTERVAL_MS;
      process.env.PM_LINKED_TEST_HEARTBEAT_INTERVAL_MS = "10";
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
            timeout: "5",
            progress: true,
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
        const frontMatter = await loadTaskFrontMatter(context, id);
        const testRuns = (frontMatter.test_runs ?? []) as Array<Record<string, unknown>>;
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
