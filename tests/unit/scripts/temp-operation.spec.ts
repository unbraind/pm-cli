import { fork, spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { registerTempOperation } from "../../../scripts/temp-lifecycle.mjs";
import { withTempDir } from "../../helpers/temp.js";

it("waits for child closure while retaining another unfinished producer after an interrupt", async () => {
  await withTempDir("pm-operation-child-", async (parent) => {
    const root = path.join(parent, "owned");
    const before = process.listeners("SIGTERM");
    await mkdir(root);
    const operation = registerTempOperation(root);
    const unfinishedRoot = path.join(parent, "unfinished");
    await mkdir(unfinishedRoot);
    const unfinished = registerTempOperation(unfinishedRoot, 50);
    const child = spawn(process.execPath, ["-e", "process.send('ready'); setInterval(() => {}, 1000)"], {
      cwd: root, signal: operation.signal, stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    child.on("error", () => {});
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    await once(child, "message");
    const originalExit = process.exit;
    process.exit = (() => {}) as typeof process.exit;
    try {
      const handler = process.listeners("SIGTERM").find((listener) => !before.includes(listener)) as (signal: string) => Promise<void>;
      const shutdown = handler("SIGTERM");
      expect(operation.signal.aborted).toBe(true);
      await closed;
      expect(await access(root)).toBeUndefined();
      await writeFile(path.join(root, "producer-stopped"), "closed");
      operation.finish();
      await shutdown;
      await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
      expect(unfinished.signal.aborted).toBe(true);
      expect(await access(unfinishedRoot)).toBeUndefined();
      unfinished.finish();
      expect(process.listeners("SIGTERM")).toEqual(before);
    } finally {
      operation.finish();
      unfinished.finish();
      child.kill();
      process.exit = originalExit;
    }
  });
});

// Unix signal handlers are not delivered by process.kill on Windows.
it.skipIf(process.platform === "win32")("retains an unfinished producer under a bounded real process interrupt", async () => {
  await withTempDir("pm-operation-timeout-", async (parent) => {
    const root = path.join(parent, "owned");
    const sentinel = path.join(parent, "unrelated");
    await writeFile(sentinel, "preserved");
    const fixture = path.join(parent, "owner.mjs");
    await writeFile(fixture, [
      'import { mkdirSync } from "node:fs";',
      "import { registerTempOperation } from " + JSON.stringify(pathToFileURL(path.resolve("scripts/temp-lifecycle.mjs")).href) + ";",
      "mkdirSync(" + JSON.stringify(root) + ");",
      "registerTempOperation(" + JSON.stringify(root) + ", 50);",
      'process.send("ready"); setInterval(() => {}, 1000);',
    ].join("\n"));
    const child = fork(fixture, [], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
    let stderr = "";
    child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const closed = once(child, "close");
    try {
      await once(child, "message");
      child.kill("SIGTERM");
      expect(await closed).toEqual([143, null]);
      expect(stderr).toContain("did not finish within 50ms");
      expect(await access(root)).toBeUndefined();
      expect(await readFile(sentinel, "utf8")).toBe("preserved");
    } finally { child.kill(); }
  });
});

it("releases a completed operation without removing deliberately retained storage", async () => {
  await withTempDir("pm-operation-completed-", async (root) => {
    const before = process.listeners("exit");
    const operation = registerTempOperation(root);
    operation.finish();
    operation.finish();
    expect(operation.signal.aborted).toBe(false);
    expect(process.listeners("exit")).toEqual(before);
    await rm(root, { recursive: true });
  });
});
