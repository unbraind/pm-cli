import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { readSettings, writeSettings } from "../../../../src/core/store/settings.js";
import {
  finishTelemetryCommand,
  startTelemetryCommand,
  waitForPendingFlush,
} from "../../../../src/core/telemetry/runtime.js";
import { withTempGlobalRoot } from "../../../helpers/temp.js";

afterEach(() => vi.unstubAllEnvs());

it.each(["redacted", "max"] as const)(
  "delivers completion and OTLP evidence for optional result fields at %s capture",
  async (captureLevel) => {
    const requests: Array<{ url: string | undefined; body: string }> = [];
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => { body += chunk; });
      request.on("end", () => {
        requests.push({ url: request.url, body });
        response.writeHead(202).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
      server.close();
      throw new Error("Expected a TCP test server address");
    }
    const endpoint = `http://127.0.0.1:${address.port}`;
    try {
      await withTempGlobalRoot("pm-telemetry-optional-result-", async (globalRoot) => {
        vi.stubEnv("PM_GLOBAL_PATH", globalRoot);
        vi.stubEnv("PM_TELEMETRY_DISABLED", "0");
        vi.stubEnv("PM_NO_TELEMETRY", "0");
        vi.stubEnv("PM_TELEMETRY_OTEL_DISABLED", "0");
        vi.stubEnv("PM_TELEMETRY_INLINE_FLUSH", "1");
        vi.stubEnv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", `${endpoint}/v1/traces`);
        const settings = await readSettings(globalRoot);
        settings.telemetry.enabled = true;
        settings.telemetry.capture_level = captureLevel;
        settings.telemetry.endpoint = `${endpoint}/events`;
        await writeSettings(globalRoot, settings, "test:telemetry-result");
        try {
          const active = await startTelemetryCommand({
            command: "files", pm_version: "1.0.0-test", args: [], options: {},
            global: {}, pm_root: globalRoot,
          });
          expect(active).not.toBeNull();
          await waitForPendingFlush();
          await finishTelemetryCommand(active, {
            ok: true,
            result: { added: 1, details: undefined, explicit: null, token: undefined },
          });
          await waitForPendingFlush();
          const events = requests.filter((entry) => entry.url === "/events")
            .flatMap((entry) => (JSON.parse(entry.body) as { events: Array<{
              event_type: string; session_id: string; payload: Record<string, unknown>;
            }> }).events);
          expect(events.map((event) => event.event_type)).toEqual(["command_start", "command_finish"]);
          expect(events[1]?.session_id).toBe(events[0]?.session_id);
          expect(events[1]?.payload).toMatchObject({
            ok: true, exit_code: 0,
            result_summary: { preview: { added: 1, explicit: null, token: "[redacted]" } },
          });
          expect(JSON.stringify(events[1]?.payload)).not.toContain('"details":');
          expect(requests.filter((entry) => entry.url === "/v1/traces")).toHaveLength(1);
          for (const file of ["events.jsonl", "otel-spans.jsonl"]) {
            expect(await readFile(path.join(globalRoot, "runtime", "telemetry", file), "utf8")).toBe("");
          }
        } finally {
          await waitForPendingFlush();
        }
      });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  },
);
