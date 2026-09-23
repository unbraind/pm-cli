import { execFile } from "node:child_process";
import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { withTempDir } from "../helpers/temp.js";

const execute = promisify(execFile);

it.each([
  ["verify-installed-agent-session.mjs", ["--manager", "npm"]],
  ["verify-installed-agent-session.mjs", ["--manager", "bun"]],
  ["verify-published-release.mjs", ["--npm-attempts", "1", "--skip-github-release"]],
] as const)("cleans %s on an actual installer refusal (%j)", async (script, args) => {
  await withTempDir("pm-release-exit-", async (root) => {
    const sentinel = "unrelated.txt";
    await writeFile(path.join(root, sentinel), "Preserve unrelated files");
    await expect(execute(process.execPath, [
      path.resolve("scripts/release", script), "--version", "9999.1.1", ...args,
    ], {
      cwd: root,
      env: {
        ...process.env,
        PATH: "",
        TMPDIR: root,
        TEMP: root,
        TMP: root,
        npm_execpath: path.join(root, "unavailable-npm.mjs"),
        PM_VERIFY_SLEEP_MS: "0",
        PM_SENTRY_DISABLED: "1",
        PM_TELEMETRY_DISABLED: "1",
        NODE_DISABLE_COMPILE_CACHE: "1",
      },
      timeout: 10_000,
    })).rejects.toMatchObject({ code: 1 });
    expect(await readdir(root)).toEqual([sentinel]);
  });
});
