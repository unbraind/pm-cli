import { execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { readSettings, writeSettings } from "../../../../src/core/store/settings.js";
import { withTempGlobalRoot } from "../../../helpers/temp.js";

const execFileAsync = promisify(execFile);
const primitivesUrl = pathToFileURL(path.resolve("dist/sdk/runtime-primitives.js")).href;
const telemetryUrl = pathToFileURL(path.resolve("dist/core/telemetry/runtime.js")).href;
afterEach(() => { vi.unstubAllEnvs(); });

it("delivers completion-appended during an in-flight background upload without another command", async () => {
  await withTempGlobalRoot("pm-telemetry-tail-", async (root) => {
    let releaseFirst!: () => void;
    let observeFirst!: () => void;
    let observeFinish!: () => void;
    const firstObserved = new Promise<void>((resolve) => { observeFirst = resolve; });
    const finishObserved = new Promise<void>((resolve) => { observeFinish = resolve; });
    const firstReleased = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const types: string[] = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { events: Array<{ event_type: string }> };
      types.push(...body.events.map((event) => event.event_type));
      if (body.events.some((event) => event.event_type === "command_start")) {
        observeFirst();
        await firstReleased;
      }
      response.writeHead(202).end();
      if (body.events.some((event) => event.event_type === "command_finish")) observeFinish();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing loopback address");
    const settings = await readSettings(root);
    await writeSettings(root, { ...settings, telemetry: { ...settings.telemetry, enabled: true, endpoint: `http://127.0.0.1:${address.port}/events` } }, "test:tail-consent");
    const env: NodeJS.ProcessEnv = { ...process.env, PM_PATH: root, PM_GLOBAL_PATH: root,
      DO_NOT_TRACK: "0", PM_TELEMETRY_DISABLED: "0", PM_NO_TELEMETRY: "0",
      PM_TELEMETRY_INLINE_FLUSH: "0", PM_TELEMETRY_FLUSH_CHILD: "0",
      PM_TELEMETRY_READ_SAMPLE_RATE: "1", PM_TELEMETRY_INGEST_KEY: "",
      PM_TELEMETRY_OTEL_DISABLED: "1", PM_SENTRY_DISABLED: "1",
    };
    for (const key of ["VITEST", "VITEST_WORKER_ID", "NODE_ENV"]) delete env[key];
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
      import { startTelemetryCommand, finishTelemetryCommand } from ${JSON.stringify(primitivesUrl)};
      const active = await startTelemetryCommand({ command: "create", pm_version: "fixture", args: [], options: {}, global: { json: true, quiet: true }, pm_root: process.env.PM_PATH });
      if (!active) throw new Error("Capture unavailable");
      await new Promise(resolve => process.stdin.once("data", resolve));
      await finishTelemetryCommand(active, { ok: true, result: { changed: true } });
      process.stdout.write("completion-enqueued");
      process.stdin.destroy();
    `], { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const completionEnqueued = new Promise<void>((resolve) => child.stdout.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("completion-enqueued")) resolve();
    }));
    const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
    const deadline = <T>(promise: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Background delivery did not complete")), 8_000);
      promise.then((value) => { clearTimeout(timer); resolve(value); }, (error: unknown) => { clearTimeout(timer); reject(error); });
    });
    try {
      await deadline(firstObserved);
      child.stdin.end("finish");
      await deadline(completionEnqueued);
      releaseFirst();
      await deadline(finishObserved);
      expect(await deadline(exited)).toBe(0);
      expect(stderr).toBe("");
      expect(types.sort()).toEqual(["command_finish", "command_start"]);
    } finally {
      releaseFirst();
      if (child.exitCode === null) child.kill();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
}, 25_000);

it("delivers every concurrent SDK lifecycle pair with one cold-installation identity", async () => {
  vi.stubEnv("PM_TELEMETRY_INGEST_KEY", "synthetic-parent-key");
  let credentialHeaderSeen = false;
  const events = new Map<string, { event_type: string; installation_id: string; session_id: string; payload: Record<string, unknown> }>();
  const server = createServer(async (request, response) => {
    credentialHeaderSeen ||= request.headers["x-pm-telemetry-key"] !== undefined;
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { events: Array<{ event_id: string; event_type: string; installation_id: string; session_id: string; payload: Record<string, unknown> }> };
    for (const event of body.events) events.set(event.event_id, event);
    response.writeHead(202).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected TCP collector");
  try {
    await withTempGlobalRoot("pm-telemetry-collector-concurrency-", async (root) => {
      const settings = await readSettings(root);
      settings.telemetry.enabled = true;
      settings.telemetry.installation_id = "";
      settings.telemetry.endpoint = `http://127.0.0.1:${address.port}/events`;
      await writeSettings(root, settings, "test:collector");
      const childEnv = { ...process.env, PM_PATH: root, PM_GLOBAL_PATH: root, DO_NOT_TRACK: "0", PM_NO_TELEMETRY: "0", PM_TELEMETRY_DISABLED: "0", PM_TELEMETRY_SEND_TEST_EVENTS: "1", PM_TELEMETRY_SOURCE_CONTEXT: "private-fixture-context", PM_TELEMETRY_INLINE_FLUSH: "1", PM_TELEMETRY_OTEL_DISABLED: "1", PM_TELEMETRY_INGEST_KEY: "", PM_LOCK_WAIT_MS: "5000" };
      const runs = await Promise.all(Array.from({ length: 4 }, () => execFileAsync(process.execPath, ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", `
        import { startTelemetryCommand, finishTelemetryCommand } from ${JSON.stringify(primitivesUrl)};
        import { flushTelemetryQueueNow, waitForPendingFlush } from ${JSON.stringify(telemetryUrl)};
        const root = process.argv[1];
        const active = await startTelemetryCommand({ command: "create", pm_version: "fixture", args: [], options: {}, global: { json: true, quiet: true }, pm_root: root });
        if (!active) throw new Error("Capture unexpectedly disabled");
        await finishTelemetryCommand(active, { ok: true, result: { changed: true } });
        await waitForPendingFlush();
        await flushTelemetryQueueNow(root);
      `, root], {
        cwd: root,
        timeout: 20_000,
        env: childEnv,
      })));
      expect(runs.every((run) => run.stderr === "")).toBe(true);
      // A child's explicit flush may yield to a peer already delivering an
      // earlier snapshot. Verify durability, then drain after all producers exit.
      const queued = (await readFile(path.join(root, "runtime", "telemetry", "events.jsonl"), "utf8"))
        .split("\n").filter(Boolean).map((line) => JSON.parse(line) as { event: { event_id: string } });
      expect(new Set([...events.keys(), ...queued.map((entry) => entry.event.event_id)]).size).toBe(8);
      const drained = await execFileAsync(process.execPath, ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", `
        import { flushTelemetryQueueNow } from ${JSON.stringify(telemetryUrl)};
        await flushTelemetryQueueNow(process.argv[1]);
      `, root], { cwd: root, timeout: 20_000, env: childEnv });
      expect(drained.stderr).toBe("");
      expect(credentialHeaderSeen).toBe(false);
      expect(events.size).toBe(8);
      expect(new Set([...events.values()].map((event) => event.installation_id)).size).toBe(1);
      const sessions = new Set([...events.values()].map((event) => event.session_id));
      expect(sessions.size).toBe(4);
      for (const session of sessions) {
        const pair = [...events.values()].filter((event) => event.session_id === session);
        expect(pair.map((event) => event.event_type).sort()).toEqual(["command_finish", "command_start"]);
        expect(pair.every((event) => event.payload.source_context_source === "env_override_rejected")).toBe(true);
      }
      expect(JSON.stringify([...events.values()])).not.toContain("private-fixture-context");
      expect(await readFile(path.join(root, "runtime", "telemetry", "events.jsonl"), "utf8")).toBe("");
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
