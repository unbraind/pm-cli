import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runTest } from "../../src/cli/commands/test.js";
import { EXIT_CODE } from "../../src/constants.js";
import { parseItemDocument, serializeItemDocument } from "../../src/item-format.js";
import { withTempPmPath, type TempPmContext } from "../helpers/withTempPmPath.js";

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

async function overwriteTaskTests(
  context: TempPmContext,
  id: string,
  tests: Array<Record<string, unknown>>,
): Promise<void> {
  const taskPath = path.join(context.pmPath, "tasks", `${id}.md`);
  const source = await readFile(taskPath, "utf8");
  const parsed = parseItemDocument(source);
  parsed.front_matter.tests = tests as unknown as never;
  await writeFile(taskPath, serializeItemDocument(parsed), "utf8");
}

describe("runTest", () => {
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
      await expect(runTest(id, { remove: ["   "] }, { path: context.pmPath })).rejects.toMatchObject({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(runTest(id, { remove: ["scope=project"] }, { path: context.pmPath })).rejects.toMatchObject({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(runTest(id, { run: true, timeout: "not-a-number" }, { path: context.pmPath })).rejects.toMatchObject({
        exitCode: EXIT_CODE.USAGE,
      });
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
            "path=tests/example.spec.ts,note=implicit project scope",
          ],
          message: "add linked tests",
        },
        { path: context.pmPath },
      );

      expect(added.changed).toBe(true);
      expect(added.count).toBe(2);
      const commandEntry = added.tests.find((entry) => entry.command === "node --version");
      expect(commandEntry?.scope).toBe("project");
      expect(commandEntry?.timeout_seconds).toBe(2);
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
      expect(noOpRemoval.count).toBe(2);

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
            "path=tests/no-command.spec.ts,scope=project",
          ],
          message: "seed run entries",
        },
        { path: context.pmPath },
      );
      expect(linked.count).toBe(4);

      const run = await runTest(
        id,
        {
          run: true,
          timeout: "0.01",
        },
        { path: context.pmPath },
      );
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

      const timeoutFailure = run.run_results.find((entry) => entry.command?.includes("setTimeout(() => {}, 2000)"));
      expect(timeoutFailure?.status).toBe("failed");
      expect(timeoutFailure?.exit_code).toBe(1);

      const skipped = run.run_results.find((entry) => entry.status === "skipped");
      expect(skipped?.path).toBe("tests/no-command.spec.ts");
      expect(skipped?.error ?? "").toContain("No command configured");
    });
  });
});
