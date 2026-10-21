import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { runDirectDistCli } from "../../helpers/cliRunner.js";

it.each([
  { nestedFirst: false, trackerRoot: "sub/t[1]" },
  { nestedFirst: true, trackerRoot: "sub/t[1]" },
  { nestedFirst: false, trackerRoot: "!tracker" },
  { nestedFirst: true, trackerRoot: "!tracker" },
])("preserves Git cache and merge protection for $trackerRoot (nested first: $nestedFirst)", async ({ nestedFirst, trackerRoot }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pm-init-cache-scopes-"));
  try {
    const env = { ...process.env, PM_PATH: path.join(root, ".agents", "pm"), PM_GLOBAL_PATH: path.join(root, "global"), GIT_CONFIG_GLOBAL: path.join(root, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1" };
    for (const key of Object.keys(env)) if (key.startsWith("GIT_") && !["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"].includes(key)) delete env[key as keyof typeof env];
    execFileSync("git", ["init", "--quiet"], { cwd: root, env });
    await writeFile(path.join(root, ".gitignore"), "node_modules/\n# user sentinel\n");
    const nested = path.join(root, trackerRoot);
    await mkdir(nested, { recursive: true });
    const trackers = [env.PM_PATH, nested];
    if (nestedFirst) trackers.reverse();
    for (const tracker of [...trackers, ...trackers]) {
      const result = runDirectDistCli(["--pm-path", tracker, "init", "--defaults", "--agent-guidance", "skip", "--json"], { cwd: tracker === nested ? nested : root, env, expectJson: true });
      expect(result.code, result.stderr).toBe(0);
    }
    expect(await readFile(path.join(root, ".gitignore"), "utf8")).toContain("node_modules/\n# user sentinel\n");
    for (const tracker of [".agents/pm", trackerRoot]) {
      for (const directory of ["runtime", "search", "locks", "transactions", "checkpoints"]) {
        const candidate = `${tracker}/${directory}/cache`;
        expect(spawnSync("git", ["check-ignore", "--no-index", "--", candidate], { cwd: root, env }).status, candidate).toBe(0);
      }
      expect(spawnSync("git", ["check-ignore", "--no-index", "--", `${tracker}/search/eval-queries.json`], { cwd: root, env }).status).toBe(1);
      expect(execFileSync("git", ["check-attr", "merge", "--", `${tracker}/tasks/example.toon`], { cwd: root, env, encoding: "utf8" })).toContain(": merge: pm-item-toon");
    }
    const unrelated = trackerRoot === "!tracker" ? "tracker" : "sub/t1";
    expect(spawnSync("git", ["check-ignore", "--no-index", "--", `${unrelated}/runtime/cache`], { cwd: root, env }).status).toBe(1);
    expect(execFileSync("git", ["check-attr", "merge", "--", `${unrelated}/tasks/example.toon`], { cwd: root, env, encoding: "utf8" })).toContain(": merge: unspecified");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
