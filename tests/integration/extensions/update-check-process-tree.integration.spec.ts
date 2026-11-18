import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GITHUB_REMOTE_LOOKUP_TIMED_OUT, checkGithubUpdate } from "../../../src/sdk/extension/update-check.js";

// pm-5kfzjh and pm-43p2c3: the deadline must settle the lookup even when the
// launcher exits while a descendant still holds its pipes, and must tear the
// descendant down with it; interrupting the host must stop the detached
// lookup group as well.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const distUpdateCheck = pathToFileURL(path.join(repoRoot, "dist", "sdk", "extension", "update-check.js")).href;
const GITHUB_SOURCE = { kind: "github", input: "github:o/r", location: "o/r", repository: "https://github.com/o/r.git", commit: "abc123" } as const;
const tempRoots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** A killed process counts as stopped once it is gone or only an unreaped zombie. */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  const state = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
  return state.status === 0 && state.stdout.trim().length > 0 && !state.stdout.trim().startsWith("Z");
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

describe.skipIf(process.platform === "win32")("update lookup deadline over a real process tree", () => {
  it("settles at its budget after the launcher exits and kills the descendant holding the pipes", async () => {
    const { root, pidFile } = await fakeGit("exit 0");
    vi.stubEnv("PATH", `${root}${path.delimiter}${process.env.PATH ?? ""}`);
    vi.stubEnv("PM_EXTENSION_UPDATE_CHECK_TIMEOUT_MS", "1000");
    const started = Date.now();
    const status = await checkGithubUpdate(GITHUB_SOURCE);
    const elapsed = Date.now() - started;
    expect(status).toEqual({ checked_at: expect.any(String), available: null, error: GITHUB_REMOTE_LOOKUP_TIMED_OUT, timeout_ms: 1000 });
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(10_000);
    const [, descendant] = (await readFile(pidFile, "utf8")).trim().split(" ").map(Number);
    expect(Number.isInteger(descendant) && descendant! > 0).toBe(true);
    expect(await waitUntilStopped(descendant!, 5000)).toBe(true);
  });

  /** Run the built SDK's lookup against a stalled fake git in a host process, then signal the host. */
  async function interruptHost(hostSetup: string, signal: NodeJS.Signals): Promise<{ exit: { code: number | null; signal: NodeJS.Signals | null }; root: string; pids: number[] }> {
    const { root, pidFile } = await fakeGit("sleep 30");
    const host = spawn(process.execPath, ["--input-type=module", "-e", [
      `import { checkGithubUpdate } from ${JSON.stringify(distUpdateCheck)};`,
      hostSetup,
      `void checkGithubUpdate(${JSON.stringify(GITHUB_SOURCE)});`,
      "setInterval(() => undefined, 1000);",
    ].join("\n")], {
      env: { ...process.env, PATH: `${root}${path.delimiter}${process.env.PATH ?? ""}`, PM_EXTENSION_UPDATE_CHECK_TIMEOUT_MS: "60000", PM_HOST_MARKER: path.join(root, "shutdown") },
      stdio: "ignore",
    });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => host.on("exit", (code, exitSignal) => resolve({ code, signal: exitSignal })));
    try {
      const pids = (await waitForFile(pidFile, 15_000)).trim().split(" ").map(Number);
      expect(isRunning(pids[0]!)).toBe(true);
      host.kill(signal);
      return { exit: await exited, root, pids };
    } finally {
      // Never leave the host behind, whatever failed above.
      if (host.exitCode === null && host.signalCode === null) host.kill("SIGKILL");
      await exited;
    }
  }

  it("stops the detached lookup group when the host is interrupted before the deadline", async () => {
    const { exit, pids } = await interruptHost("", "SIGINT");
    expect(exit).toEqual({ code: null, signal: "SIGINT" });
    for (const pid of pids) expect(await waitUntilStopped(pid, 5000)).toBe(true);
  }, 30_000);

  it("keeps a host's one-shot shutdown handler in charge of the signal", async () => {
    // The host's handler is registered before the lookup and removes itself
    // when it runs; it must still finish its asynchronous shutdown.
    const { exit, root, pids } = await interruptHost([
      `import { writeFileSync } from "node:fs";`,
      `process.once("SIGTERM", () => setTimeout(() => { writeFileSync(process.env.PM_HOST_MARKER, "done"); process.exit(0); }, 200));`,
    ].join("\n"), "SIGTERM");
    expect(exit).toEqual({ code: 0, signal: null });
    expect(await readFile(path.join(root, "shutdown"), "utf8")).toBe("done");
    for (const pid of pids) expect(await waitUntilStopped(pid, 5000)).toBe(true);
  }, 30_000);
});
