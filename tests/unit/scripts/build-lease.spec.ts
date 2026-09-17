import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as fsPromises from "node:fs/promises";
import { fork } from "node:child_process";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createScriptHarness } from "../../helpers/scriptModule";

interface LeaseModule {
  /** Run an asynchronous operation while holding or inheriting the checkout lease. */
  withBuildLease<T>(root: string, operation: (lease: string) => Promise<T>, options?: { inherited?: string; timeoutMs?: number }): Promise<T>;
}

const harness = createScriptHarness();
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("complete build lease", () => {
  it("blocks an independent process until the producer publishes complete exports", async () => {
    const root = await harness.createTempRoot("pm-build-process-");
    const fixture = path.join(root, "consumer.mjs");
    const moduleUrl = pathToFileURL(path.resolve("scripts/build-lease.mjs")).href;
    await writeFile(fixture, `
import { withBuildLease } from ${JSON.stringify(moduleUrl)};
import { spawnSync } from 'node:child_process';
try {
  await withBuildLease(process.cwd(), async () => { throw new Error('overlap'); }, { timeoutMs: 1 });
} catch (error) {
  if (!error.message.startsWith('Timed out')) throw error;
  process.send('blocked');
}
await withBuildLease(process.cwd(), async () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', 'import { complete } from "./output.mjs"; console.log(JSON.stringify(complete));'], { encoding: 'utf8', timeout: 10000 });
  if (result.status !== 0) throw new Error(result.stderr);
  process.send(JSON.parse(result.stdout));
});
process.disconnect();
`);
    const mod = await harness.importModule<LeaseModule>("scripts/build-lease.mjs");
    const { worker: child, completed, closed } = await mod.withBuildLease(root, async () => {
      await writeFile(path.join(root, "output.mjs"), "partial");
      const worker = fork(fixture, [], { cwd: root, stdio: ["ignore", "pipe", "pipe", "ipc"] });
      try {
        expect((await once(worker, "message"))[0]).toBe("blocked");
        const completed = once(worker, "message");
        const closed = once(worker, "close");
        await writeFile(path.join(root, "output.mjs"), "export const complete = true;");
        return { worker, completed, closed };
      } catch (error) {
        worker.kill();
        throw error;
      }
    });
    try {
      expect((await completed)[0]).toBe(true);
      expect((await closed)[0]).toBe(0);
    } finally {
      child.kill();
    }
  });
  it("propagates an acquisition permission failure without entering the operation", async () => {
    const root = await harness.createTempRoot("pm-build-denied-");
    const denied = Object.assign(new Error("access denied"), { code: "EACCES" });
    vi.doMock("node:fs/promises", async () => ({
      ...await vi.importActual<typeof fsPromises>("node:fs/promises"),
      mkdir: vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(denied),
    }));
    const mod = await harness.importModule<LeaseModule>("scripts/build-lease.mjs");
    const operation = vi.fn();
    await expect(mod.withBuildLease(root, operation)).rejects.toBe(denied);
    expect(operation).not.toHaveBeenCalled();
  });
  it("serializes competing producers and keeps a consumer outside partial output", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pm-build-lease-"));
    roots.push(root);
    const mod = await harness.importModule<LeaseModule>("scripts/build-lease.mjs");
    let unblock: () => void = () => {};
    const barrier = new Promise<void>((resolve) => { unblock = resolve; });
    let entered: () => void = () => {};
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const file = path.join(root, "output.js");
    const producer = mod.withBuildLease(root, async () => {
      await writeFile(file, "partial");
      entered();
      await barrier;
      await writeFile(file, "export const complete = true;");
    });
    await started;
    const consumer = mod.withBuildLease(root, async () => readFile(file, "utf8"));
    unblock();
    await producer;
    expect(await consumer).toBe("export const complete = true;");
  });

  it("releases after failure and permits only a matching inherited lease", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pm-build-lease-"));
    roots.push(root);
    const mod = await harness.importModule<LeaseModule>("scripts/build-lease.mjs");
    await expect(mod.withBuildLease(root, async () => { throw new Error("failed build"); })).rejects.toThrow("failed build");
    await mod.withBuildLease(root, async (lease) => {
      expect(await mod.withBuildLease(root, async () => "nested", { inherited: lease })).toBe("nested");
      await expect(mod.withBuildLease(root, async () => "invalid", { inherited: "wrong", timeoutMs: 1 })).rejects.toThrow("lease");
      await expect(mod.withBuildLease(root, async () => "overlap", { timeoutMs: 1 })).rejects.toThrow("Timed out");
    });
    expect(await mod.withBuildLease(root, async () => "released")).toBe("released");
  });
});
