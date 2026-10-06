import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";

import { PmClient } from "../../../src/sdk/runtime.js";
import { runLinkedTests } from "../../../src/sdk/test/execution.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

it("accepts real Bun filtered runs and rejects empty selections through SDK, test, and test-all", async () => {
  await withTempPmPath(async ({ tempRoot, pmPath, runCliInProcess }) => {
    const fixture = path.join(tempRoot, "selected.test.ts");
    await writeFile(
      fixture,
      'import { test, expect } from "bun:test";\ntest("alpha first", () => expect(1).toBe(1));\ntest("alpha second", () => expect(2).toBe(2));\ntest("beta", () => expect(3).toBe(3));\n',
    );
    const command = `bun test ${JSON.stringify(fixture)} --test-name-pattern alpha`;
    const [positive, empty, failed, assertionFailure] = await runLinkedTests(
      [
        { command, scope: "project" },
        {
          command: command.replace("pattern alpha", "pattern missing"),
          scope: "project",
        },
        { command: `${command} && exit 7`, scope: "project" },
        { command, scope: "project", assert_stderr_contains: ["3 pass"] },
      ],
      30,
      { failOnEmptyTestRun: true },
    );
    expect(positive).toMatchObject({
      status: "passed",
      exit_code: 0,
      execution_receipt: { code: "bun_pass_count", stream: "stderr" },
    });
    expect(positive?.stderr).toMatch(/2 pass/u);
    expect(empty).toMatchObject({ status: "failed", exit_code: 1 });
    expect(empty?.stderr).toMatch(/matched 0 tests|0 pass/u);
    expect(failed).toMatchObject({
      status: "failed",
      failure_category: "assertion_failure",
      exit_code: 7,
    });
    expect(assertionFailure).toMatchObject({
      status: "failed",
      failure_category: "assertion_failure",
      exit_code: 1,
    });
    expect(assertionFailure?.error).toContain("3 pass");
    expect(assertionFailure?.execution_receipt).toBeUndefined();

    const client = new PmClient({ pmRoot: pmPath });
    const { item } = await client.create({
      title: "Bun execution receipt",
      type: "Task",
      status: "open",
    });
    await runCliInProcess([
      "test",
      item.id,
      "--add-json",
      JSON.stringify({ command, assert_stderr_contains: ["2 pass"] }),
    ]);
    await runCliInProcess(["test", item.id, "--acknowledge-linked-tests"]);
    const single = await runCliInProcess(
      ["test", item.id, "--run", "--fail-on-empty-test-run", "--json"],
      { expectJson: true },
    );
    expect(single.code).toBe(0);
    expect(single.json).toMatchObject({
      ok: true,
      run_results: [{ status: "passed" }],
    });
    const all = await runCliInProcess(
      ["test-all", "--status", "open", "--fail-on-empty-test-run", "--json"],
      { expectJson: true },
    );
    expect(all.code).toBe(0);
    expect(all.json).toMatchObject({ ok: true, passed: 1, failed: 0 });
  });
}, 60_000);
