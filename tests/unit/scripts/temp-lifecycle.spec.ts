import { fork } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import * as fs from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTempDir } from "../../helpers/temp.js";
import { createScriptHarness } from "../../helpers/scriptModule.js";

interface LifecycleModule {
  /** Register an owned root and return its explicit retention or disposal release. */
  registerTempCleanup(root: string, options?: { shutdown?: () => Promise<void> }): () => void;
}

const harness = createScriptHarness(["../../../scripts/smoke-cleanup.mjs"]);
const releases: Array<() => void> = [];
beforeEach(() => {
  vi.doUnmock("../../../scripts/smoke-cleanup.mjs");
  vi.doUnmock("node:fs");
});
afterEach(() => { for (const release of releases.splice(0)) release(); });

/** Launch the lifecycle owner as an independent process so real exit and signal semantics are exercised. */
async function runFixture(mode: string): Promise<void> {
  await withTempDir("pm-temp-lifecycle-", async (parent) => {
    const fixture = path.join(parent, "owner.mjs");
    const root = path.join(parent, "owned");
    const sentinel = path.join(parent, "retained");
    await writeFile(sentinel, "unrelated");
    await writeFile(fixture, `
import { closeSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { registerTempCleanup } from ${JSON.stringify(pathToFileURL(path.resolve("scripts/temp-lifecycle.mjs")).href)};
const root = ${JSON.stringify(root)};
mkdirSync(root);
const mode = ${JSON.stringify(mode)};
const release = registerTempCleanup(root, ['shutdown', 'retained', 'closed-stderr'].includes(mode) ? {
  shutdown: async () => {
    await new Promise(resolve => setTimeout(resolve, 20));
    if (!existsSync(root)) throw new Error('workspace removed before shutdown');
    writeFileSync(${JSON.stringify(path.join(parent, "stopped"))}, 'stopped');
  }
} : {});
if (mode === 'release') release();
if (mode === 'closed-stderr') closeSync(2);
if (mode === 'retained' || mode === 'closed-stderr') process.exit(7);
if (mode === 'failure') throw new Error('fixture failure');
if (mode === 'signal' || mode === 'shutdown') {
  process.send('ready');
  setInterval(() => {}, 1000);
}
`);
    const child = fork(fixture, [], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
    let stderr = "";
    child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const closed = once(child, "close");
    try {
      if (mode === "signal" || mode === "shutdown") {
        await Promise.race([
          once(child, "message"),
          closed.then(() => { throw new Error("Fixture exited before readiness"); }),
        ]);
        child.kill("SIGTERM");
      }
      const [code] = await closed;
      expect(code).toBe(["retained", "closed-stderr"].includes(mode) ? 7 : mode === "failure" ? 1 : mode === "signal" || mode === "shutdown" ? 143 : 0);
      expect(existsSync(root)).toBe(["release", "retained", "closed-stderr"].includes(mode));
      expect(existsSync(sentinel)).toBe(true);
      if (mode === "shutdown") expect(existsSync(path.join(parent, "stopped"))).toBe(true);
      if (mode === "retained") expect(stderr).toContain(`Temporary workspace retained at ${root}: process exited before asynchronous shutdown completed\n`);
    } finally {
      child.kill();
    }
  });
}

describe("owned temporary workspace lifecycle", () => {
  it.each(["normal", "failure", "release", "retained", "closed-stderr"])("cleans safely on %s", runFixture);
  // Windows process.kill terminates the target unconditionally; it cannot deliver Unix signals.
  it.skipIf(process.platform === "win32").each(["signal", "shutdown"])("cleans safely on %s", runFixture);

  it("cleans independent roots on exit and detaches the last registration", async () => {
    const before = new Set(process.listeners("exit"));
    const mod = await harness.importModule<LifecycleModule>("scripts/temp-lifecycle.mjs");
    const roots = await Promise.all([harness.createTempRoot("pm-owned-a-"), harness.createTempRoot("pm-owned-b-")]);
    releases.push(...roots.map((root) => mod.registerTempCleanup(root)));
    expect(() => mod.registerTempCleanup(roots[0])).toThrow("already registered");
    const onExit = process.listeners("exit").find((listener) => !before.has(listener))!;
    onExit(0);
    expect(roots.map(existsSync)).toEqual([false, false]);
    releases[0]();
    expect(process.listeners("exit")).toContain(onExit);
    releases[1]();
    expect(process.listeners("exit")).not.toContain(onExit);
  });

  it("retains asynchronous consumers and reports removal failure during abrupt exit", async () => {
    const before = new Set(process.listeners("exit"));
    const remove = vi.fn(() => { throw new Error("filesystem denied"); });
    vi.doMock("../../../scripts/smoke-cleanup.mjs", () => ({ cleanupTempRoot: remove }));
    const error = vi.fn<typeof fs.writeSync>().mockReturnValue(0);
    vi.doMock("node:fs", async () => ({ ...await vi.importActual<typeof fs>("node:fs"), writeSync: error }));
    const mod = await harness.importModule<LifecycleModule>("scripts/temp-lifecycle.mjs");
    releases.push(mod.registerTempCleanup("owned-sync"), mod.registerTempCleanup("owned-async", { shutdown: async () => {} }));
    process.listeners("exit").find((listener) => !before.has(listener))!(1);
    expect(remove).toHaveBeenCalledExactlyOnceWith("owned-sync");
    expect(error.mock.calls.flat().join(" ")).toContain("filesystem denied");
    expect(error.mock.calls.flat().join(" ")).toContain("before asynchronous shutdown");
    expect(error.mock.calls.every(([descriptor, message]) => descriptor === 2 && String(message).endsWith("\n"))).toBe(true);
    error.mockImplementation(() => { throw new Error("stderr unavailable"); });
    expect(() => process.listeners("exit").find((listener) => !before.has(listener))!(1)).not.toThrow();
  });

  it.each(["SIGINT", "SIGTERM"])("waits for shutdown, preserves failures and coalesces repeated %s", async (signal) => {
    const before = new Set(process.listeners(signal));
    const root = await harness.createTempRoot("pm-owned-signal-");
    const failedRoot = await harness.createTempRoot("pm-owned-failure-");
    let finish: () => void = () => {};
    const stopped = new Promise<void>((resolve) => { finish = resolve; });
    const error = vi.fn<typeof fs.writeSync>().mockReturnValue(0);
    vi.doMock("node:fs", async () => ({ ...await vi.importActual<typeof fs>("node:fs"), writeSync: error }));
    const mod = await harness.importModule<LifecycleModule>("scripts/temp-lifecycle.mjs");
    vi.spyOn(process, "exit").mockImplementation((code) => { throw new Error(`exit:${code}`); });
    releases.push(mod.registerTempCleanup(root, { shutdown: () => stopped }));
    releases.push(mod.registerTempCleanup(failedRoot, { shutdown: async () => { throw new Error("still alive"); } }));
    releases.push(mod.registerTempCleanup(await harness.createTempRoot("pm-owned-no-child-")));
    const onSignal = process.listeners(signal).find((listener) => !before.has(listener)) as (value: string) => Promise<void>;
    const completion = onSignal(signal);
    await onSignal(signal);
    expect(existsSync(root)).toBe(true);
    finish();
    await expect(completion).rejects.toThrow(`exit:${signal === "SIGINT" ? 130 : 143}`);
    expect(existsSync(root)).toBe(false);
    expect(existsSync(failedRoot)).toBe(true);
    expect(error.mock.calls.flat().join(" ")).toContain("still alive");
  });
});
