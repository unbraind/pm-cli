import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { expect, it } from "vitest";
import { withTempDir } from "../helpers/temp.js";

// Windows kill forcibly terminates a process; it does not deliver Unix signals.
it.skipIf(process.platform === "win32").each(["0", "1"])("stops the test child and releases its lease before signal cleanup (prebuilt=%s)", async (skipBuild) => {
  await withTempDir("pm-runner-interrupt-", async (root) => {
    const workspace = path.join(root, "workspace");
    const scratch = path.join(root, "scratch");
    const scripts = path.join(workspace, "scripts");
    const vitest = path.join(workspace, "node_modules", "vitest");
    await Promise.all([mkdir(scripts, { recursive: true }), mkdir(vitest, { recursive: true }), mkdir(scratch)]);
    for (const script of ["run-tests.mjs", "build-lease.mjs", "temp-lifecycle.mjs", "smoke-cleanup.mjs"]) {
      await copyFile(path.resolve("scripts", script), path.join(scripts, script));
    }
    await writeFile(path.join(scripts, "build.mjs"), "// Independent build fixture.\n");
    const stopped = path.join(root, "child-stopped");
    await writeFile(path.join(vitest, "vitest.mjs"), `
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const root = path.resolve(process.env.PM_PATH, '../../..');
process.on('SIGTERM', () => setTimeout(() => {
  if (!existsSync(root)) process.exit(9);
  writeFileSync(${JSON.stringify(stopped)}, 'stopped');
  process.exit(0);
}, 30));
console.log(root);
setInterval(() => {}, 1000);
`);
    const child = spawn(process.execPath, [path.join(scripts, "run-tests.mjs"), "coverage"], {
      cwd: workspace,
      env: { ...process.env, PM_BUILD_CONSUMER_LEASE: "", PM_RUN_TESTS_SKIP_BUILD: skipBuild, TMPDIR: scratch },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const lines = createInterface({ input: child.stdout });
    const closed = once(child, "close");
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    try {
      const [ownedRoot] = await Promise.race([
        once(lines, "line"),
        closed.then(() => { throw new Error(`Runner exited before readiness: ${stderr}`); }),
      ]);
      expect(existsSync(ownedRoot)).toBe(true);
      child.kill("SIGTERM");
      expect((await closed)[0], stderr).toBe(143);
      expect(existsSync(stopped)).toBe(true);
      expect(await readdir(scratch)).toEqual([]);
      expect(existsSync(path.join(workspace, ".cache", "build-lease"))).toBe(false);
    } finally {
      lines.close();
      child.kill();
    }
  });
}, 15_000);
