import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { runTest } from "../../../../src/sdk/test/execution.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";
import { createTestItemId } from "../../../helpers/itemFactory.js";

describe("linked-test executable resolution", () => {
  it("distinguishes shell command lookup failures from executed children exiting 127 or printing ENOENT", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "Missing linked executable" });
      await runTest(id, { add: [
        "command=pm-definitely-missing-executable-1604,scope=project",
        'command=node -e "process.exit(127)",scope=project',
        'command=node -e "console.error(\'ENOENT: not found\');process.exit(1)",scope=project',
        'command=node -e "console.error(\'/bin/sh: 1: node: not found\');process.exit(127)",scope=project',
      ] }, { path: context.pmPath });
      const result = await runTest(id, { run: true }, { path: context.pmPath });
      expect(result.run_results).toHaveLength(4);
      const shellFailure = spawnSync("pm-definitely-missing-executable-1604", {
        shell: true, cwd: context.tempRoot, env: context.env, encoding: "utf8",
      });
      expect(shellFailure.error).toBeUndefined();
      expect(result.run_results[0]).toMatchObject({
        status: "failed", failure_category: "spawn_error",
        exit_code: shellFailure.status,
        stderr: shellFailure.stderr,
      });
      expect(result.run_results[0]?.stderr).toContain("pm-definitely-missing-executable-1604");
      expect(result.run_results.slice(1).map((row) => row.failure_category)).toEqual([
        "assertion_failure", "assertion_failure", "assertion_failure",
      ]);
      expect(result.failure_categories).toMatchObject({ spawn_error: 1, assertion_failure: 3 });
    });
  });
});
