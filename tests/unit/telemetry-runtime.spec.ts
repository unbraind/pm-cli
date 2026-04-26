import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readSettings, writeSettings } from "../../src/core/store/settings.js";
import { finishTelemetryCommand, startTelemetryCommand } from "../../src/core/telemetry/runtime.js";

const originalGlobalPath = process.env.PM_GLOBAL_PATH;
const originalFetch = globalThis.fetch;
const originalOtelTracesEndpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
const originalOtelEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
const originalOtelServiceName = process.env.OTEL_SERVICE_NAME;
const originalTelemetryDisabled = process.env.PM_TELEMETRY_DISABLED;
const originalTelemetryOtelDisabled = process.env.PM_TELEMETRY_OTEL_DISABLED;

function telemetryQueuePath(globalRoot: string): string {
  return path.join(globalRoot, "runtime", "telemetry", "events.jsonl");
}

async function withTempGlobalRoot(run: (globalRoot: string) => Promise<void>): Promise<void> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pm-cli-telemetry-runtime-test-"));
  const globalRoot = path.join(tempRoot, ".pm-cli");
  process.env.PM_GLOBAL_PATH = globalRoot;
  try {
    await run(globalRoot);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

describe("core/telemetry/runtime", () => {
  afterEach(() => {
    if (originalGlobalPath === undefined) {
      delete process.env.PM_GLOBAL_PATH;
    } else {
      process.env.PM_GLOBAL_PATH = originalGlobalPath;
    }
    if (originalOtelTracesEndpoint === undefined) {
      delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    } else {
      process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = originalOtelTracesEndpoint;
    }
    if (originalOtelEndpoint === undefined) {
      delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    } else {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = originalOtelEndpoint;
    }
    if (originalOtelServiceName === undefined) {
      delete process.env.OTEL_SERVICE_NAME;
    } else {
      process.env.OTEL_SERVICE_NAME = originalOtelServiceName;
    }
    if (originalTelemetryDisabled === undefined) {
      delete process.env.PM_TELEMETRY_DISABLED;
    } else {
      process.env.PM_TELEMETRY_DISABLED = originalTelemetryDisabled;
    }
    if (originalTelemetryOtelDisabled === undefined) {
      delete process.env.PM_TELEMETRY_OTEL_DISABLED;
    } else {
      process.env.PM_TELEMETRY_OTEL_DISABLED = originalTelemetryOtelDisabled;
    }
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("queues redacted command_start events when exporter fails", async () => {
    await withTempGlobalRoot(async (globalRoot) => {
      globalThis.fetch = vi.fn(async () => {
        throw new Error("network_down");
      }) as unknown as typeof fetch;

      const active = await startTelemetryCommand({
        command: "create",
        args: ["--api-key", "supersecret", "--token=abc123", "user@example.com"],
        options: {
          apiKey: "value",
          title: "Telemetry smoke",
        },
        global: {
          json: true,
          quiet: false,
          noExtensions: false,
          noPager: false,
          profile: false,
        },
        pm_root: "/tmp/project/.agents/pm",
      });

      expect(active).not.toBeNull();
      const queueRaw = await fs.readFile(telemetryQueuePath(globalRoot), "utf8");
      const firstLine = queueRaw
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.length > 0);
      expect(firstLine).toBeDefined();
      const queued = JSON.parse(firstLine ?? "{}") as {
        attempts: number;
        event: {
          event_type: string;
          payload: {
            command_args: string[];
            command_options: Record<string, string>;
          };
        };
      };
      expect(queued.attempts).toBe(1);
      expect(queued.event.event_type).toBe("command_start");
      expect(queued.event.payload.command_args).toEqual([
        "--api-key",
        "[redacted]",
        "--token=[redacted]",
        "[redacted_email]",
      ]);
      expect(queued.event.payload.command_options.apiKey).toBe("[redacted]");
    });
  });

  it("skips telemetry command collection when PM_TELEMETRY_DISABLED is set", async () => {
    await withTempGlobalRoot(async (globalRoot) => {
      process.env.PM_TELEMETRY_DISABLED = "1";
      const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const active = await startTelemetryCommand({
        command: "list-open",
        args: [],
        options: {},
        global: {
          json: true,
          quiet: false,
          noExtensions: false,
          noPager: false,
          profile: false,
        },
        pm_root: "/tmp/project/.agents/pm",
      });

      expect(active).toBeNull();
      await expect(fs.access(telemetryQueuePath(globalRoot))).rejects.toMatchObject({ code: "ENOENT" });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  it("persists installation id and flushes queue on successful exporter response", async () => {
    await withTempGlobalRoot(async (globalRoot) => {
      const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const active = await startTelemetryCommand({
        command: "list-open",
        args: [],
        options: {},
        global: {
          json: true,
          quiet: false,
          noExtensions: false,
          noPager: false,
          profile: false,
        },
        pm_root: "/tmp/project/.agents/pm",
      });
      expect(active).not.toBeNull();

      await finishTelemetryCommand(active, {
        ok: true,
        result: { count: 0, items: [] },
      });

      const queueRaw = await fs.readFile(telemetryQueuePath(globalRoot), "utf8");
      expect(queueRaw.trim()).toBe("");

      const settings = await readSettings(globalRoot);
      expect(settings.telemetry.installation_id.length).toBeGreaterThan(0);
      expect(settings.telemetry.enabled).toBe(true);
      expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  it("exports an OTLP span when a local OTEL endpoint is configured", async () => {
    await withTempGlobalRoot(async (globalRoot) => {
      const settings = await readSettings(globalRoot);
      settings.telemetry.endpoint = "";
      await writeSettings(globalRoot, settings, "test:disable_remote_telemetry_export");

      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://127.0.0.1:4318";
      process.env.OTEL_SERVICE_NAME = "pm-cli-test";

      const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const active = await startTelemetryCommand({
        command: "list-open",
        args: [],
        options: {},
        global: {
          json: true,
          quiet: false,
          noExtensions: false,
          noPager: false,
          profile: false,
        },
        pm_root: "/tmp/project/.agents/pm",
      });
      expect(active).not.toBeNull();

      await finishTelemetryCommand(active, {
        ok: false,
        error: "synthetic_failure",
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [requestUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(requestUrl).toBe("http://127.0.0.1:4318/v1/traces");

      const body = JSON.parse(String(init.body ?? "{}")) as {
        resourceSpans: Array<{
          resource: { attributes: Array<{ key: string; value: { stringValue?: string } }> };
          scopeSpans: Array<{
            spans: Array<{
              name: string;
              status: { code: number; message: string };
              attributes: Array<{
                key: string;
                value: { stringValue?: string; boolValue?: boolean; intValue?: string };
              }>;
            }>;
          }>;
        }>;
      };
      const span = body.resourceSpans[0]?.scopeSpans[0]?.spans[0];
      expect(span?.name).toBe("pm.command.list-open");
      expect(span?.status.code).toBe(2);
      expect(span?.status.message).toBe("synthetic_failure");
      const attrMap = new Map(span?.attributes.map((entry) => [entry.key, entry.value]) ?? []);
      expect(attrMap.get("pm.command")?.stringValue).toBe("list-open");
      expect(attrMap.get("pm.ok")?.boolValue).toBe(false);
      expect(attrMap.get("pm.error")?.stringValue).toBe("synthetic_failure");
      expect(body.resourceSpans[0]?.resource.attributes[0]?.key).toBe("service.name");
      expect(body.resourceSpans[0]?.resource.attributes[0]?.value.stringValue).toBe("pm-cli-test");
    });
  });
});
