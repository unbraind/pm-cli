import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../helpers/temp.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("scripts/run-tests.mjs", () => {
  it.each(["standard", "root-layout"])("refuses %s ancestor trackers before allocating fixtures", async (layout) => {
    await withTempDir("pm-runner-ancestor-", async (root) => {
      const tracker = layout === "standard" ? path.join(root, ".agents", "pm") : root;
      const scratch = path.join(root, "scratch");
      await mkdir(tracker, { recursive: true });
      await mkdir(scratch);
      const settings = '{"version":1,"id_prefix":"fixture-"}\n';
      const settingsPath = path.join(tracker, "settings.json");
      await writeFile(settingsPath, settings);
      const result = spawnSync(process.execPath, ["scripts/run-tests.mjs", "test", "--", "--help"], {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          TMPDIR: scratch, TEMP: scratch, TMP: scratch,
          PM_PATH: path.join(root, "isolated-pm"),
          PM_GLOBAL_PATH: path.join(root, "isolated-global"),
          PM_RUN_TESTS_SKIP_BUILD: "1",
        },
      });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(2);
      expect(result.stderr).toContain("ancestor tracker");
      expect(result.stderr).toContain(tracker);
      expect(await readFile(settingsPath, "utf8")).toBe(settings);
    });
  });

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
      expect(normalizedOutput).not.toContain("tests/unit/commands/governance/health-command.spec.ts");
      expect(cleanOutput).toMatch(/Test Files\s+1 passed/);
    },
    120_000,
  );
});
