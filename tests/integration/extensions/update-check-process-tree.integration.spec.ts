import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GITHUB_REMOTE_LOOKUP_TIMED_OUT, checkGithubUpdate } from "../../../src/sdk/extension/update-check.js";

// pm-5kfzjh and pm-43p2c3: the deadline must settle the lookup even when the
// launcher exits while a descendant still holds its pipes, and must tear the
// descendant down with it.
const tempRoots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilGone(pid: number, limitMs: number): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < limitMs) {
    if (!isRunning(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isRunning(pid);
}

describe.skipIf(process.platform === "win32")("update lookup deadline over a real process tree", () => {
  it("settles at its budget after the launcher exits and kills the descendant holding the pipes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pm-update-deadline-"));
    tempRoots.push(root);
    const pidFile = path.join(root, "descendant.pid");
    const launcher = path.join(root, "git");
    // The launcher leaves a descendant on its stdout and stderr, then exits 0.
    await writeFile(launcher, `#!/bin/sh\nsleep 30 &\necho $! > "${pidFile}"\nexit 0\n`);
    await chmod(launcher, 0o755);
    vi.stubEnv("PATH", `${root}${path.delimiter}${process.env.PATH ?? ""}`);
    vi.stubEnv("PM_EXTENSION_UPDATE_CHECK_TIMEOUT_MS", "1000");
    const started = Date.now();
    const status = await checkGithubUpdate({ kind: "github", input: "github:o/r", location: "o/r", repository: "https://github.com/o/r.git", commit: "abc123" });
    const elapsed = Date.now() - started;
    expect(status).toEqual({ checked_at: expect.any(String), available: null, error: GITHUB_REMOTE_LOOKUP_TIMED_OUT, timeout_ms: 1000 });
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(10_000);
    const descendant = Number((await readFile(pidFile, "utf8")).trim());
    expect(Number.isInteger(descendant) && descendant > 0).toBe(true);
    expect(await waitUntilGone(descendant, 5000)).toBe(true);
  });
});
