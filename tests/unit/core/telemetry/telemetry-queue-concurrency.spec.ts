import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import * as files from "../../../../src/core/fs/fs-utils.js";
import { acquireLock } from "../../../../src/core/lock/lock.js";
import { readSettings, writeSettings } from "../../../../src/core/store/settings.js";
import { _testOnly, startTelemetryCommand, finishTelemetryCommand, emitTelemetryErrorEvent, waitForPendingFlush } from "../../../../src/core/telemetry/runtime.js";
import { withTempGlobalRoot } from "../../../helpers/temp.js";

const runtimeUrl = pathToFileURL(path.resolve("dist/core/telemetry/runtime.js")).href;
afterEach(async () => { await waitForPendingFlush(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it.each(["success", "retry", "expired", "deferred", "span"] as const)(
  "preserves a real process append during %s reconciliation",
  async (mode) => {
    await withTempGlobalRoot("pm-telemetry-concurrent-", async (root) => {
      const queuePath = path.join(root, "runtime", "telemetry", mode === "span" ? "otel-spans.jsonl" : "events.jsonl");
      const initial = {
        event: { schema_version: 1, event_type: "command_start" as const, installation_id: "fixture", session_id: "fixture", command: "list", payload: {}, event_id: "processed", occurred_at: mode === "expired" || mode === "deferred" ? "2000-01-01T00:00:00.000Z" : new Date().toISOString() },
        attempts: 0,
      };
      await _testOnly.rewriteQueue(root, [initial]);
      if (mode === "deferred") {
        await files.appendLineAtomic(queuePath, JSON.stringify({ ...initial, event: { event_id: "later", occurred_at: new Date().toISOString() }, next_attempt_after: "2999-01-01T00:00:00.000Z" }));
      }
      if (mode === "span") {
        await _testOnly.enqueuePendingOtelSpan(root, { endpoint: "http://localhost/unused", payload: {} });
      }
      const originalRead = files.readFileIfExists;
      let intercepted = false;
      let queueReads = 0;
      let childDone: Promise<unknown[]> | undefined;
      // Pause after the authoritative read. The independent appender either
      // completes (old implementation) or reports it is waiting on the mutex.
      vi.spyOn(files, "readFileIfExists").mockImplementation(async (target) => {
        const raw = await originalRead(target);
        if (target !== queuePath || intercepted) return raw;
        queueReads += 1;
        if (mode === "retry" && queueReads === 1) return raw;
        intercepted = true;
        const child = spawn(process.execPath, ["--input-type=module", "-e", `
          import { _testOnly } from ${JSON.stringify(runtimeUrl)};
          const root = process.argv[1];
          /** Append through the real runtime so an unlocked negative control completes before the parent rewrite. */
          const append = () => process.argv[2] === "span"
            ? _testOnly.enqueuePendingOtelSpan(root, { endpoint: "http://localhost/new", payload: { marker: "concurrent" } })
            : _testOnly.enqueueTelemetryEvent(root, { schema_version: 1, event_id: "concurrent", event_type: "command_start", occurred_at: new Date().toISOString(), installation_id: "fixture", session_id: "fixture", command: "list", payload: {} });
          process.env.PM_LOCK_WAIT_MS = "0";
          try { await append(); }
          catch (error) {
            if (error.code !== "lock_conflict") throw error;
            process.send("waiting");
            process.env.PM_LOCK_WAIT_MS = "5000";
            await append();
          }
          process.send("written");
          process.disconnect();
        `, root, mode], { cwd: root, stdio: ["ignore", "ignore", "pipe", "ipc"], env: { ...process.env, PM_PATH: root, PM_GLOBAL_PATH: root } });
        childDone = once(child, "exit");
        await once(child, "message");
        return raw;
      });
      if (mode === "span") {
        const existing = _testOnly.parsePendingOtelSpanLines(await readFile(queuePath, "utf8"));
        await _testOnly.reconcilePendingOtelSpansAfterFlush(root, 1, new Set(existing.map((span) => span.id)), new Map());
      } else if (mode === "success") {
        await _testOnly.removeFlushedEntriesFromCurrentQueue(root, new Set(["processed"]), 1);
      } else {
        vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 503 })));
        try { await _testOnly.flushQueue(root, "http://localhost/unused", 1); }
        finally { vi.unstubAllGlobals(); }
      }
      expect(intercepted).toBe(true);
      expect(await childDone).toEqual([0, null]);
      const retained = await readFile(queuePath, "utf8");
      expect(retained).toContain('"concurrent"');
      if (mode === "retry") expect(retained).toContain('"attempts":1');
      if (mode === "deferred") expect(retained).toContain('"later"');
      if (mode !== "retry") expect(retained).not.toContain('"processed"');
    });
  },
);

it("releases the installation mutex after a failed write", async () => {
  await withTempGlobalRoot("pm-telemetry-queue-failure-", async (root) => {
    await mkdir(root, { recursive: true });
    await expect(_testOnly.withQueueMutation(async () => { throw new Error("write failed"); }, root)).rejects.toThrow("write failed");
    await _testOnly.withQueueMutation(() => writeFile(path.join(root, "recovered"), "ok"), root);
    expect(await readFile(path.join(root, "recovered"), "utf8")).toBe("ok");
  });
});


it.each(["start", "finish", "error"])("bounds the default foreground %s lock wait without a late write", async (mode) => {
  await withTempGlobalRoot("pm-telemetry-busy-", async (root) => {
    for (const [key, value] of Object.entries({
      PM_GLOBAL_PATH: root, PM_TELEMETRY_SEND_TEST_EVENTS: "1", DO_NOT_TRACK: "0",
      PM_TELEMETRY_DISABLED: "0", PM_NO_TELEMETRY: "0", PM_TELEMETRY_OTEL_DISABLED: "1",
      PM_TELEMETRY_INLINE_FLUSH: "1", PM_TELEMETRY_READ_SAMPLE_RATE: "0.1",
    })) vi.stubEnv(key, value);
    vi.stubEnv("PM_LOCK_WAIT_MS", undefined);
    const settings = await readSettings(root);
    settings.telemetry.enabled = true;
    settings.telemetry.endpoint = "";
    await writeSettings(root, settings, "test:local-capture");
    const context = { command: "list", pm_version: "fixture", args: [], options: {}, global: { noExtensions: true }, pm_root: root };
    const active = await startTelemetryCommand(context);
    expect(active).not.toBeNull();
    await waitForPendingFlush();
    const release = await acquireLock(root, "telemetry-queue", 60, "contention-fixture");
    const startedAt = performance.now();
    try {
      if (mode === "start") expect(await startTelemetryCommand(context)).toBeNull();
      else if (mode === "finish") await finishTelemetryCommand(active, { ok: false, error_code: "usage_error" });
      else await emitTelemetryErrorEvent({ ...context, error_code: "usage_error", error_message: "fixture", exit_code: 2 });
    } finally { await release(); }
    expect(performance.now() - startedAt).toBeLessThan(2_000);
    await waitForPendingFlush();
    await expect(readFile(path.join(root, "runtime", "telemetry", "events.jsonl"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
}, 15_000);
