import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("scripts/run-tests.mjs", () => {
  it(
    "forwards targeted Vitest file filters in sandbox mode",
    () => {
      const result = spawnSync(
        process.execPath,
        ["scripts/run-tests.mjs", "test", "--", "tests/unit/list-sort-branches.spec.ts"],
        {
          cwd: repoRoot,
          encoding: "utf8",
          env: {
            ...process.env,
            PM_RUN_TESTS_SKIP_BUILD: "1",
          },
        },
      );

      const combinedOutput = `${result.stdout}\n${result.stderr}`;
      expect(result.status).toBe(0);
      const cleanOutput = combinedOutput.replace(/\x1b\[[0-9;]*m/g, "");
      expect(cleanOutput).toContain("tests/unit/list-sort-branches.spec.ts");
      expect(cleanOutput).not.toContain("tests/unit/health-command.spec.ts");
      expect(cleanOutput).toMatch(/Test Files\s+1 passed/);
    },
    120_000,
  );
});
