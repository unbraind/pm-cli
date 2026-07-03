import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("scripts/run-tests.mjs", () => {
  it(
    "forwards targeted Vitest file filters in sandbox mode",
    () => {
      const targetSpec = path.posix.join("tests", "unit", "core", "item", "status-normalization.spec.ts");
      const result = spawnSync(
        process.execPath,
        ["scripts/run-tests.mjs", "test", "--", "--reporter=verbose", targetSpec],
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
      expect(result.error, combinedOutput).toBeUndefined();
      expect(result.status, combinedOutput).toBe(0);
      // eslint-disable-next-line no-control-regex -- strips ANSI color escape sequences from CLI output
      const cleanOutput = combinedOutput.replace(/\x1b\[[0-9;]*m/g, "");
      const normalizedOutput = cleanOutput.replace(/\\/g, "/");
      expect(normalizedOutput).toContain("tests/unit/core/item/status-normalization.spec.ts");
      expect(normalizedOutput).not.toContain("tests/unit/commands/health-command.spec.ts");
      expect(cleanOutput).toMatch(/Test Files\s+1 passed/);
    },
    120_000,
  );
});
