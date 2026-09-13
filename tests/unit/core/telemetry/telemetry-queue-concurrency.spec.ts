import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import * as files from "../../../../src/core/fs/fs-utils.js";
import { _testOnly, waitForPendingFlush } from "../../../../src/core/telemetry/runtime.js";
import { withTempGlobalRoot } from "../../../helpers/temp.js";

const runtimeUrl = pathToFileURL(path.resolve("dist/core/telemetry/runtime.js")).href;
afterEach(async () => { await waitForPendingFlush(); vi.restoreAllMocks(); });

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
          const pending = process.argv[2] === "span"
            ? _testOnly.enqueuePendingOtelSpan(root, { endpoint: "http://localhost/new", payload: { marker: "concurrent" } })
            : _testOnly.enqueueTelemetryEvent(root, { schema_version: 1, event_id: "concurrent", event_type: "command_start", occurred_at: new Date().toISOString(), installation_id: "fixture", session_id: "fixture", command: "list", payload: {} });
          const timer = setTimeout(() => process.send("waiting"), 100);
          await pending;
          clearTimeout(timer);
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
