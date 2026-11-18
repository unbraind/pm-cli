import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GITHUB_REMOTE_LOOKUP_FAILED, GITHUB_REMOTE_LOOKUP_TIMED_OUT, checkGithubUpdate } from "../../../src/sdk/extension/update-check.js";

// pm-5kfzjh and pm-43p2c3: the deadline must settle the lookup even when the
// launcher exits while a descendant still holds its pipes, must kill a live
// provider tree, and must leave the provider where a terminal Ctrl-C reaches
// it with the host.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const distUpdateCheck = pathToFileURL(path.join(repoRoot, "dist", "sdk", "extension", "update-check.js")).href;
const GITHUB_SOURCE = { kind: "github", input: "github:o/r", location: "o/r", repository: "https://github.com/o/r.git", commit: "abc123" } as const;
const tempRoots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** A killed process counts as stopped once it is gone or only an unreaped zombie; a probe that cannot run fails the test. */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  const state = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
  const row = state.stdout?.trim() ?? "";
  // ps exits 1 with no row when the pid disappeared between the two probes;
  // any other outcome that is not a clean answer cannot prove anything.
  if (state.status === 1 && row.length === 0) return false;
  if (state.error || state.status !== 0 || row.length === 0) throw new Error(`ps could not probe pid ${pid}: ${state.error?.message ?? `status ${state.status}, signal ${state.signal}`}`);
  return !row.startsWith("Z");
}

/** Wait for a subprocess to exit, or report `undefined` after `limitMs` so the caller's cleanup still runs. */
function exitWithin<T>(exited: Promise<T>, limitMs: number): Promise<T | undefined> {
  return Promise.race([exited, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), limitMs))]);
}

async function waitUntilStopped(pid: number, limitMs: number): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < limitMs) {
    if (!isRunning(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isRunning(pid);
}

async function waitForFile(file: string, limitMs: number): Promise<string> {
  const started = Date.now();
  while (Date.now() - started < limitMs) {
    const text = await readFile(file, "utf8").catch(() => "");
    if (text.trim().length > 0) return text;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${file}`);
}

/** A fake git on a private PATH entry: it records its pids, leaves `sleep 30` on its pipes and then `tail` runs. */
async function fakeGit(tail: string): Promise<{ root: string; pidFile: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "pm-update-deadline-"));
  tempRoots.push(root);
  const pidFile = path.join(root, "pids");
  await writeFile(path.join(root, "git"), `#!/bin/sh\nsleep 30 &\necho "$$ $!" > "${pidFile}"\n${tail}\n`);
  await chmod(path.join(root, "git"), 0o755);
  return { root, pidFile };
}

/** Kill leftovers by pid so a failed assertion never leaves a sleep behind. */
function killQuietly(pids: number[]): void {
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

async function readPids(pidFile: string, limitMs = 15_000): Promise<number[]> {
  return (await waitForFile(pidFile, limitMs)).trim().split(/\s+/u).map(Number);
}

/**
 * A fake git whose descendant runs in the foreground, as a remote helper
 * does. A background job of a non-interactive shell ignores SIGINT by POSIX
 * rule, so it would not model a terminal Ctrl-C.
 */
async function fakeGitWithForegroundHelper(): Promise<{ root: string; launcherFile: string; helperFile: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "pm-update-interrupt-"));
  tempRoots.push(root);
  const launcherFile = path.join(root, "launcher.pid");
  const helperFile = path.join(root, "helper.pid");
  await writeFile(path.join(root, "git"), `#!/bin/sh\necho "$$" > "${launcherFile}"\nsh -c 'echo "$$" > "${helperFile}"; exec sleep 30'\n`);
  await chmod(path.join(root, "git"), 0o755);
  return { root, launcherFile, helperFile };
}

describe.skipIf(process.platform === "win32")("update lookup deadline over a real process tree", () => {
  it("settles at its budget when the launcher exits while a descendant still holds the pipes", async () => {
    const { root, pidFile } = await fakeGit("exit 0");
    vi.stubEnv("PATH", `${root}${path.delimiter}${process.env.PATH ?? ""}`);
    vi.stubEnv("PM_EXTENSION_UPDATE_CHECK_TIMEOUT_MS", "1000");
    const started = Date.now();
    let pids: number[] = [];
    try {
      const status = await checkGithubUpdate(GITHUB_SOURCE);
      const elapsed = Date.now() - started;
      pids = await readPids(pidFile);
      expect(status).toEqual({ checked_at: expect.any(String), available: null, error: GITHUB_REMOTE_LOOKUP_TIMED_OUT, timeout_ms: 1000 });
      expect(elapsed).toBeGreaterThanOrEqual(900);
      expect(elapsed).toBeLessThan(10_000);
    } finally {
      // The re-parented descendant is outside the live tree the deadline
      // walks; it no longer delays the result and is cleaned up here.
      killQuietly(pids);
    }
  });

  it("kills a still-running launcher and its descendant at the deadline", async () => {
    // The launcher waits for its recorded descendant, so the whole fixture
    // tree is the launcher and that one sleep.
    const { root, pidFile } = await fakeGit("wait");
    vi.stubEnv("PATH", `${root}${path.delimiter}${process.env.PATH ?? ""}`);
    vi.stubEnv("PM_EXTENSION_UPDATE_CHECK_TIMEOUT_MS", "1000");
    let pids: number[] = [];
    try {
      const status = await checkGithubUpdate(GITHUB_SOURCE);
      pids = await readPids(pidFile);
      expect(status).toMatchObject({ error: GITHUB_REMOTE_LOOKUP_TIMED_OUT, timeout_ms: 1000 });
      for (const pid of pids) expect(await waitUntilStopped(pid, 5000)).toBe(true);
    } finally {
      killQuietly(pids);
    }
  });

  it("leaves the lookup in the host's process group, so a terminal Ctrl-C stops it with the host", async () => {
    const { root, launcherFile, helperFile } = await fakeGitWithForegroundHelper();
    // The host leads its own group, as a shell's foreground job does; Ctrl-C
    // signals that whole group.
    const host = spawn(process.execPath, ["--input-type=module", "-e", [
      `import { checkGithubUpdate } from ${JSON.stringify(distUpdateCheck)};`,
      `void checkGithubUpdate(${JSON.stringify(GITHUB_SOURCE)});`,
      "setInterval(() => undefined, 1000);",
    ].join("\n")], {
      detached: true,
      env: { ...process.env, PATH: `${root}${path.delimiter}${process.env.PATH ?? ""}`, PM_EXTENSION_UPDATE_CHECK_TIMEOUT_MS: "25000" },
      stdio: "ignore",
    });
    // close follows exit, and also follows a failed launch that emits only
    // error, so the cleanup wait always ends.
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => host.on("close", (code, signal) => resolve({ code, signal })));
    let launchError: Error | undefined;
    host.on("error", (error) => {
      launchError = error;
    });
    const pids: number[] = [];
    try {
      pids.push(...(await readPids(helperFile)));
      pids.push(...(await readPids(launcherFile)));
      expect(launchError).toBeUndefined();
      for (const pid of pids) expect(isRunning(pid)).toBe(true);
      process.kill(-host.pid!, "SIGINT");
      expect(await exitWithin(exited, 10_000)).toEqual({ code: null, signal: "SIGINT" });
      for (const pid of pids) expect(await waitUntilStopped(pid, 5000)).toBe(true);
    } finally {
      if (host.exitCode === null && host.signalCode === null) host.kill("SIGKILL");
      await exitWithin(exited, 10_000);
      killQuietly(pids);
    }
  }, 30_000);

  it("never reports the provider's stderr in a failed lookup", async () => {
    // A provider that writes a credential-shaped marker to stderr, then fails.
    const root = await mkdtemp(path.join(os.tmpdir(), "pm-update-stderr-"));
    tempRoots.push(root);
    const marker = ["stderr-marker", "private-fixture-value"].join("-");
    await writeFile(path.join(root, "git"), `#!/bin/sh\necho "fatal: ${marker}" >&2\nexit 128\n`);
    await chmod(path.join(root, "git"), 0o755);
    vi.stubEnv("PATH", `${root}${path.delimiter}${process.env.PATH ?? ""}`);
    const status = await checkGithubUpdate(GITHUB_SOURCE);
    expect(status).toEqual({ checked_at: expect.any(String), available: null, error: GITHUB_REMOTE_LOOKUP_FAILED });
    expect(JSON.stringify(status)).not.toContain(marker);
  });
});
