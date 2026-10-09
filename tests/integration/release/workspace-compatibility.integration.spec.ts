import path from "node:path";
import childProcess, { type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { createScriptHarness } from "../../helpers/scriptModule.js";

const harness = createScriptHarness();

describe("published workspace compatibility acceptance", () => {
  it("can be imported without a command entrypoint or network side effects", async () => {
    process.argv = [process.execPath];
    const output = vi.spyOn(console, "log");
    const module = await harness.importModule<{ main: unknown }>("scripts/release/workspace-compatibility.mjs");
    expect(typeof module.main).toBe("function");
    expect(output).not.toHaveBeenCalled();
  });
  it.runIf(process.platform !== "win32")("executes the declared four-way matrix using real published artifacts and native Git drivers", async () => {
    process.env.GIT_DIR = "/invalid-inherited-git-dir";
    process.env.GIT_WORK_TREE = "/invalid-inherited-worktree";
    const hostileRoot = await harness.createTempRoot("pm-hostile-registry-");
    for (const name of ["user", "global"]) {
      const config = path.join(hostileRoot, `${name}.npmrc`);
      await writeFile(config, "registry=http://127.0.0.1:9/\n@unbrained:registry=http://127.0.0.1:9/\n//registry.npmjs.org/:_authToken=fixture-not-a-credential\n");
      process.env[`npm_config_${name}config`] = config;
    }
    process.env.npm_config_registry = "http://127.0.0.1:9/";
    process.env.NPM_CONFIG_REGISTRY = "http://127.0.0.1:9/";
    process.env.npm_config_fetch_retries = "0";
    process.env.NODE_AUTH_TOKEN = "fixture-not-a-credential";
    process.env.NPM_TOKEN = "fixture-not-a-credential";
    const execute = vi.fn((file: string, args: readonly string[], options: ExecFileSyncOptionsWithStringEncoding) => {
      if (file === "npm") {
        expect(options.env).toBeDefined();
        expect(options.env?.NODE_AUTH_TOKEN).toBeUndefined();
        expect(Object.keys(options.env ?? {}).some((key) => /^npm_/iu.test(key))).toBe(false);
        expect(args).toContain("--registry=https://registry.npmjs.org/");
        for (const flag of ["--userconfig=", "--globalconfig="]) {
          const configArg = args.find((arg) => arg.startsWith(flag));
          expect(configArg).toBeDefined();
          expect(readFileSync(String(configArg).slice(flag.length), "utf8")).toBe("");
        }
      }
      return childProcess.execFileSync(file, args, options);
    });
    vi.doMock("node:child_process", () => ({ ...childProcess, execFileSync: execute }));
    const output = vi.spyOn(console, "log");
    process.argv = [process.execPath, path.resolve("scripts/release/workspace-compatibility.mjs"), "--json"];
    await harness.importModule("scripts/release/workspace-compatibility.mjs");
    const receipt = output.mock.calls.map(([value]) => JSON.parse(String(value)) as { ok: boolean; matrix: Array<Record<string, unknown>> }).find((value) => Array.isArray(value.matrix));
    expect(receipt).toMatchObject({ ok: true });
    expect(receipt?.matrix).toHaveLength(4);
    expect(receipt?.matrix.every((row) => row.unknown_fields && row.restore && row.git_merge && row.history && row.sdk && row.cli)).toBe(true);
    expect(execute.mock.calls.some(([file]) => file === "npm")).toBe(true);
  }, 180_000);
});
