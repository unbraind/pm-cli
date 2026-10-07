import { access, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readSettings, runWithConfigurationOnlySettings, writeSettings } from "../../../../src/core/store/settings.js";
import { finishTelemetryCommand, flushTelemetryQueueNow, startTelemetryCommand, waitForPendingFlush } from "../../../../src/core/telemetry/runtime.js";
import { withTempDir } from "../../../helpers/temp.js";

beforeEach(() => {
  for (const [key, value] of Object.entries({
    PM_TELEMETRY_SEND_TEST_EVENTS: "1", DO_NOT_TRACK: "0",
    PM_TELEMETRY_DISABLED: "0", PM_NO_TELEMETRY: "0",
    PM_TELEMETRY_OTEL_DISABLED: "1", PM_TELEMETRY_INLINE_FLUSH: "1",
    PM_TELEMETRY_FLUSH_CHILD: "0", PM_TELEMETRY_READ_SAMPLE_RATE: "1",
  })) vi.stubEnv(key, value);
});
afterEach(async () => { await waitForPendingFlush(); vi.unstubAllEnvs(); });

it("does not initialize storage after a detached worker's root has been removed", async () => {
  await withTempDir("pm-worker-absent-", async (parent) => {
    const root = path.join(parent, "installation");
    const settings = await readSettings(root);
    settings.telemetry.enabled = true;
    await writeSettings(root, settings, "test:consent");
    await rm(root, { recursive: true });
    vi.stubEnv("PM_TELEMETRY_FLUSH_CHILD", "1");
    await flushTelemetryQueueNow(root);
    await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

it.each([
  { artifact: "events", status: 202, removeRoot: true },
  { artifact: "events", status: 503, removeRoot: true },
  { artifact: "events", status: 202, removeRoot: false },
  { artifact: "spans", status: 202, removeRoot: true },
  { artifact: "spans", status: 503, removeRoot: true },
  { artifact: "spans", status: 202, removeRoot: false },
] as const)("respects storage ownership during $artifact delivery (HTTP $status, remove=$removeRoot)", async ({ artifact, status, removeRoot }) => {
  await withTempDir("pm-worker-inflight-", async (parent) => {
    const root = path.join(parent, "installation");
    const sentinel = path.join(parent, "unrelated");
    await writeFile(sentinel, "preserve me");
    vi.stubEnv("PM_GLOBAL_PATH", root);
    let received = "";
    let deletion: Promise<void> = Promise.resolve();
    const server = createServer((request, response) => {
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => { received += chunk; });
      request.on("end", () => {
        deletion = (removeRoot ? rm(root, { recursive: true }) : Promise.resolve())
          .then(() => { response.writeHead(status).end(); });
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Expected a local TCP collector");
    try {
      const endpoint = "http://127.0.0.1:" + address.port + "/" + artifact;
      const settings = await readSettings(root);
      settings.telemetry.enabled = true;
      settings.telemetry.endpoint = "";
      // This fixture represents an existing consented installation. Capture in
      // the configuration-only scope queues real artifacts without dispatching
      // a foreground exporter before the detached worker owns the delivery.
      settings.telemetry.installation_id = randomUUID();
      await writeSettings(root, settings, "test:existing-installation");
      if (artifact === "spans") {
        vi.stubEnv("PM_TELEMETRY_OTEL_DISABLED", "0");
        vi.stubEnv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", endpoint);
      }
      await runWithConfigurationOnlySettings(root, async () => {
        const command = await startTelemetryCommand({
          command: "create", pm_version: "fixture", args: [], options: {},
          global: { noExtensions: true }, pm_root: root,
        });
        expect(command).not.toBeNull();
        await finishTelemetryCommand(command, { ok: true });
        await waitForPendingFlush();
      });
      const queue = path.join(root, "runtime", "telemetry", artifact === "events" ? "events.jsonl" : "otel-spans.jsonl");
      const queued = await readFile(queue, "utf8");
      expect(queued.split("\n").filter(Boolean)).toHaveLength(artifact === "events" ? 2 : 1);
      if (artifact === "events") {
        const deliverySettings = await readSettings(root);
        deliverySettings.telemetry.endpoint = endpoint;
        await writeSettings(root, deliverySettings, "test:delivery");
      }
      vi.stubEnv("PM_TELEMETRY_FLUSH_CHILD", "1");
      await flushTelemetryQueueNow(root);
      await deletion;
      if (artifact === "events") {
        expect((JSON.parse(received) as { events: Array<{ event_type: string }> }).events.map((event) => event.event_type))
          .toEqual(["command_start", "command_finish"]);
      } else {
        expect(JSON.parse(received)).toMatchObject({
          resourceSpans: [{ scopeSpans: [{ spans: [{ name: "pm.command.create" }] }] }],
        });
      }
      if (removeRoot) await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
      else {
        expect(await readFile(queue, "utf8")).toBe("");
        expect((await readSettings(root)).telemetry.installation_id).toBe(settings.telemetry.installation_id);
      }
      expect(await readFile(sentinel, "utf8")).toBe("preserve me");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
