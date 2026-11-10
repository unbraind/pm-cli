import { spawnSync } from "node:child_process";
import { copyFile, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../helpers/temp.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Run the real sandbox wrapper and exact gate against one independently incomplete fixture source. */
async function createCoverageVerdictWorkspace(root: string, assertionPasses: boolean): Promise<void> {
  for (const file of ["run-tests.mjs", "build-lease.mjs", "temp-lifecycle.mjs", "smoke-cleanup.mjs", "mcp-contract-reporter.mts", "test-execution-reporter.mts", "release/coverage-threshold-gate.mjs"]) {
    const destination = path.join(root, "scripts", file);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(repoRoot, "scripts", file), destination);
  }
  const linkType = process.platform === "win32" ? "junction" : "dir";
  await symlink(path.join(repoRoot, "node_modules"), path.join(root, "node_modules"), linkType);
  await symlink(path.join(repoRoot, "dist"), path.join(root, "dist"), linkType);
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "package.json"), '{"type":"module","private":true}\n');
  await writeFile(path.join(root, "src", "choose.ts"), "export const choose = (value: boolean): number => value ? 1 : 0;\n");
  await writeFile(path.join(root, "fixture.spec.ts"), `import { expect, it } from "vitest"; import { choose } from "./src/choose"; it("known assertion", () => expect(choose(true)).toBe(${assertionPasses ? 1 : 2}));\n`);
  await writeFile(path.join(root, "vitest.config.mjs"), `export default ${JSON.stringify({ test: {
    include: ["fixture.spec.ts"],
    coverage: { provider: "v8", include: ["src/**/*.ts"], reporter: ["json-summary"], reportOnFailure: true,
      thresholds: { lines: 100, statements: 100, functions: 100, branches: 100 } },
  } })};\n`);
}

describe("scripts/run-tests.mjs", () => {
  it.each([true, false])("separates assertion results from a real coverage refusal (assertions pass=%s)", async (assertionPasses) => {
    await withTempDir("pm-runner-verdict-", async (root) => {
      await createCoverageVerdictWorkspace(root, assertionPasses);
      const env: NodeJS.ProcessEnv = { ...process.env, PM_RUN_TESTS_SKIP_BUILD: "1", PM_PATH: path.join(root, "sandbox-pm"), PM_GLOBAL_PATH: path.join(root, "sandbox-global") };
      delete env.PM_BUILD_CONSUMER_LEASE;
      delete env.PM_BUILD_CONSUMER_LEASE_ROOT;
      const result = spawnSync(process.execPath, ["scripts/run-tests.mjs", "coverage", "--", "--reporter=default"], { cwd: root, encoding: "utf8", timeout: 90_000, env });
      const output = `${result.stdout}\n${result.stderr}`;
      expect(result.error, output).toBeUndefined();
      expect(result.status, output).toBe(3);
      expect(output).toContain(assertionPasses ? "Test assertions passed" : "Tests failed");
      expect(output).toContain("Vitest process exited 1");
      expect(output).toContain("exact coverage failed");
      const summary = JSON.parse(await readFile(path.join(root, "coverage", "coverage-summary.json"), "utf8")) as { total: { branches: { covered: number; total: number } } };
      expect(summary.total.branches.covered).toBeLessThan(summary.total.branches.total);
    });
  }, 120_000);

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
