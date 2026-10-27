import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { chmod, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { runTest } from "../../../../src/sdk/test/execution.js";
import { quoteCommandArg } from "../../../../src/sdk/command-line.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";
import { createTestItemId } from "../../../helpers/itemFactory.js";

const nativeEvidence = vi.hoisted(() => ({
  commands: [] as Array<{ command: string; cwd: string; env: NodeJS.ProcessEnv }>,
  probes: [] as Array<{ executable: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; timeout: number; code: unknown; signal: unknown; killed: boolean; duration_ms: number }>,
}));
vi.mock("node:child_process", async (load) => {
  const actual = await load<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  const run = promisify(actual.execFile);
  return {
    ...actual,
    spawn: (...args: unknown[]) => {
      if (args[0] === "pm-definitely-missing-executable-1604") {
        const [command, options] = args as [string, { cwd: string; env: NodeJS.ProcessEnv }];
        nativeEvidence.commands.push({ command, cwd: options.cwd, env: { ...options.env } });
      }
      return Reflect.apply(actual.spawn, actual, args);
    },
    execFile: Object.assign((...args: unknown[]) => Reflect.apply(actual.execFile, actual, args), {
      [Symbol.for("nodejs.util.promisify.custom")]: (...params: Parameters<typeof run>) => {
        if (!Array.isArray(params[1]) || !params[1].includes("pm-definitely-missing-executable-1604")) return run(...params);
        return (async () => {
          const [executable, args, options] = params as [string, string[], { cwd: string; env: NodeJS.ProcessEnv; timeout: number }];
          const started = performance.now();
          const environment = { ...options.env };
          let outcome: { code?: unknown; signal?: unknown; killed?: boolean } = { code: 0 };
          try {
            return await run(executable, args, options);
          } catch (error) {
            outcome = error as typeof outcome;
            throw error;
          } finally {
            nativeEvidence.probes.push({ executable, args, ...options, env: environment, code: outcome.code, signal: outcome.signal, killed: outcome.killed === true, duration_ms: performance.now() - started });
          }
        })();
      },
    }),
  };
});
afterEach(() => {
  nativeEvidence.commands.length = 0;
  nativeEvidence.probes.length = 0;
});

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
      const probes = nativeEvidence.probes.filter((row) => row.args.includes("pm-definitely-missing-executable-1604"));
      expect(probes).toHaveLength(1);
      const probe = probes[0]!;
      const child = nativeEvidence.commands.find((row) => row.command === "pm-definitely-missing-executable-1604")!;
      const sameEnvironment = isDeepStrictEqual(probe.env, child.env);
      expect(sameEnvironment).toBe(true);
      expect(probe.cwd).toBe(child.cwd);
      expect(probe.timeout).toBe(1_000);
      expect(probe.code).not.toBe(0);
      const confirmedAbsent = !probe.killed && !probe.signal && (probe.code === 1 || (process.platform !== "win32" && probe.code === 127));
      const category = confirmedAbsent ? "spawn_error" : "assertion_failure";
      const diagnostic = JSON.stringify({ executable: path.basename(probe.executable), code: probe.code ?? null, signal: probe.signal ?? null, killed: probe.killed, duration_ms: probe.duration_ms, timeout_ms: probe.timeout, cwd: probe.cwd, same_child_environment: sameEnvironment, environment_keys: ["SystemRoot", "ComSpec", "PATH", "PATHEXT"].filter((key) => Object.keys(probe.env).some((name) => name.toUpperCase() === key.toUpperCase())) });
      if (process.platform === "win32") console.info(`Native lookup evidence: ${diagnostic}`);
      expect(result.run_results[0], diagnostic).toMatchObject({
        status: "failed", failure_category: category,
        exit_code: shellFailure.status,
        stderr: shellFailure.stderr,
      });
      expect(result.run_results[0]?.stderr).toContain("pm-definitely-missing-executable-1604");
      expect(result.run_results.slice(1).map((row) => row.failure_category)).toEqual([
        "assertion_failure", "assertion_failure", "assertion_failure",
      ]);
      expect(result.failure_categories).toMatchObject({ spawn_error: confirmedAbsent ? 1 : 0, assertion_failure: confirmedAbsent ? 3 : 4 });
    });
  });
});
