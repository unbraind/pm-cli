import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmod, writeFile } from "node:fs/promises";
import path from "node:path";
import { runTest } from "../../../../src/sdk/test/execution.js";
import { quoteCommandArg } from "../../../../src/sdk/command-line.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";
import { createTestItemId } from "../../../helpers/itemFactory.js";

describe("linked-test executable resolution", () => {
  it.skipIf(process.platform === "win32")("distinguishes an absent script interpreter from scripts reporting their own launch failures", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "Absent linked script interpreter" });
      const interpreter = path.join(context.tempRoot, "absent-interpreter");
      const scripts = ["missing-interpreter", "reported-127", "reported-126"].map((name) => path.join(context.tempRoot, name));
      const contents = [
        `#!${interpreter}\nexit 0\n`,
        '#!/bin/sh\nprintf "/bin/sh: 1: %s: not found\\n" "$0" >&2\nexit 127\n',
        `#!/bin/sh\nprintf "/bin/sh: %s: ${interpreter}: bad interpreter: No such file or directory\\n" "$0" >&2\nexit 126\n`,
      ];
      for (const [index, script] of scripts.entries()) {
        await writeFile(script, contents[index]!);
        await chmod(script, 0o755);
      }
      await runTest(id, { add: scripts.map((script) => `command=${quoteCommandArg(script)},scope=project`) }, { path: context.pmPath });
      const result = await runTest(id, { run: true }, { path: context.pmPath });
      const native = spawnSync(quoteCommandArg(scripts[0]!), { shell: true, cwd: context.tempRoot, env: context.env, encoding: "utf8" });
      expect(result.run_results[0]).toMatchObject({ status: "failed", failure_category: "spawn_error", exit_code: native.status, stderr: native.stderr });
      expect(result.run_results.slice(1).map((row) => row.failure_category)).toEqual(["assertion_failure", "assertion_failure"]);
      expect(result.failure_categories).toMatchObject({ spawn_error: 1, assertion_failure: 2 });
    });
  });

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
