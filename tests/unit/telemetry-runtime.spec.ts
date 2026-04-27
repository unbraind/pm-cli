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
const originalTelemetrySourceContext = process.env.PM_TELEMETRY_SOURCE_CONTEXT;

function telemetryQueuePath(globalRoot: string): string {
  return path.join(globalRoot, "runtime", "telemetry", "events.jsonl");
}

async function withTempGlobalRoot(run: (globalRoot: string) => Promise<void>): Promise<void> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pm-cli-telemetry-runtime-test-"));
  const globalRoot = path.join(tempRoot, ".pm-cli");
  process.env.PM_GLOBAL_PATH = globalRoot;
  delete process.env.PM_TELEMETRY_DISABLED;
  try {
    await run(globalRoot);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

async function setTelemetryCaptureLevel(globalRoot: string, level: "minimal" | "redacted" | "max"): Promise<void> {
  const settings = await readSettings(globalRoot);
  settings.telemetry.capture_level = level;
  await writeSettings(globalRoot, settings, `test:set_capture_level:${level}`);
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
    if (originalTelemetrySourceContext === undefined) {
      delete process.env.PM_TELEMETRY_SOURCE_CONTEXT;
    } else {
      process.env.PM_TELEMETRY_SOURCE_CONTEXT = originalTelemetrySourceContext;
    }
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("queues redacted command_start events when exporter fails", async () => {
    await withTempGlobalRoot(async (globalRoot) => {
      await setTelemetryCaptureLevel(globalRoot, "redacted");
      globalThis.fetch = vi.fn(async () => {
        throw new Error("network_down");
      }) as unknown as typeof fetch;

      const active = await startTelemetryCommand({
        command: "create",
        pm_version: "9.9.9-test",
        args: [
          "--api-key",
          "supersecret",
          "--token=abc123",
          "user@example.com",
          "token=inline-secret --password hunter2 /home/steve/private/path",
        ],
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
            capture_level?: string;
            pm_version?: string;
            source_context?: string;
            source_context_source?: string;
            command_args: string[];
            command_options: Record<string, string>;
          };
        };
      };
      expect(queued.attempts).toBe(1);
      expect(queued.event.event_type).toBe("command_start");
      expect(queued.event.payload.capture_level).toBe("redacted");
      expect(queued.event.payload.pm_version).toBe("9.9.9-test");
      expect(queued.event.payload.source_context).toMatch(/^(user|automation|test|dogfood|audit_smoke)$/);
      expect(queued.event.payload.source_context_source).toMatch(/^(inferred|env_override)$/);
      expect(queued.event.payload.command_args).toEqual([
        "--api-key",
        "[redacted]",
        "--token=[redacted]",
        "[redacted_email]",
        "token=[redacted] --password [redacted] [redacted_path]",
      ]);
      expect(queued.event.payload.command_options.apiKey).toBe("[redacted]");
    });
  });

  it("redacts inline secrets and paths in command_finish result summaries", async () => {
    await withTempGlobalRoot(async (globalRoot) => {
      await setTelemetryCaptureLevel(globalRoot, "redacted");
      globalThis.fetch = vi.fn(async () => {
        throw new Error("network_down");
      }) as unknown as typeof fetch;

      const active = await startTelemetryCommand({
        command: "search",
        pm_version: "9.9.9-test",
        args: ["query"],
        options: {},
        global: {
          json: false,
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
        result: {
          query: "user@example.com token=supersecret --password hunter2 /home/steve/private/path",
        },
      });

      const queueRaw = await fs.readFile(telemetryQueuePath(globalRoot), "utf8");
      const queuedEntries = queueRaw
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) =>
          JSON.parse(line) as {
            event: {
              event_type: string;
              payload: {
                result_summary?: {
                  preview?: {
                    query?: string;
                  };
                };
              };
            };
          },
        );
      const finishEvent = queuedEntries.find((entry) => entry.event.event_type === "command_finish");
      expect(finishEvent).toBeDefined();
      expect(finishEvent?.event.payload.result_summary?.preview?.query).toBe(
        "[redacted_email] token=[redacted] --password [redacted] [redacted_path]",
      );
    });
  });

  it("reduces telemetry payload shape when capture level is minimal", async () => {
    await withTempGlobalRoot(async (globalRoot) => {
      await setTelemetryCaptureLevel(globalRoot, "minimal");
      globalThis.fetch = vi.fn(async () => {
        throw new Error("network_down");
      }) as unknown as typeof fetch;

      const active = await startTelemetryCommand({
        command: "list-open",
        pm_version: "9.9.9-test",
        args: ["--token=secret", "user@example.com"],
        options: { token: "secret", path: "/home/steve/private/path" },
        global: {
          json: true,
          quiet: false,
          noExtensions: false,
          noPager: false,
          profile: false,
        },
        pm_root: "/tmp/project/.agents/pm",
      });
      expect(active?.capture_level).toBe("minimal");

      await finishTelemetryCommand(active, {
        ok: false,
        error: "token=supersecret /home/steve/private/path",
        result: {
          token: "still-secret",
          query: "user@example.com",
        },
      });

      const queueRaw = await fs.readFile(telemetryQueuePath(globalRoot), "utf8");
      const queuedEntries = queueRaw
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as { event: { event_type: string; payload: Record<string, unknown> } });
      const startEvent = queuedEntries.find((entry) => entry.event.event_type === "command_start");
      const finishEvent = queuedEntries.find((entry) => entry.event.event_type === "command_finish");

      expect(startEvent).toBeDefined();
      expect(finishEvent).toBeDefined();
      expect(startEvent?.event.payload).toMatchObject({
        capture_level: "minimal",
        pm_version: "9.9.9-test",
      });
      expect(startEvent?.event.payload.pm_version).toBe("9.9.9-test");
      expect(startEvent?.event.payload.source_context).toMatch(/^(user|automation|test|dogfood|audit_smoke)$/);
      expect(startEvent?.event.payload.source_context_source).toMatch(/^(inferred|env_override)$/);

      const finishPayload = finishEvent?.event.payload ?? {};
      expect(finishPayload.capture_level).toBe("minimal");
      expect(finishPayload.pm_version).toBe("9.9.9-test");
      expect(String(finishPayload.source_context ?? "")).toMatch(/^(user|automation|test|dogfood|audit_smoke)$/);
      expect(String(finishPayload.source_context_source ?? "")).toMatch(/^(inferred|env_override)$/);
      expect(finishPayload.ok).toBe(false);
      expect(typeof finishPayload.duration_ms).toBe("number");
      expect(finishPayload.started_at).toBeUndefined();
      expect(finishPayload.result_summary).toBeUndefined();
      expect(String(finishPayload.error ?? "")).toContain("[redacted]");
      expect(String(finishPayload.error ?? "")).not.toContain("supersecret");
    });
  });

  it("retains non-sensitive context at max capture level while redacting secrets", async () => {
    await withTempGlobalRoot(async (globalRoot) => {
      await setTelemetryCaptureLevel(globalRoot, "max");
      globalThis.fetch = vi.fn(async () => {
        throw new Error("network_down");
      }) as unknown as typeof fetch;

      const active = await startTelemetryCommand({
        command: "search",
        pm_version: "9.9.9-test",
        args: ["user@example.com", "/home/steve/private/path", "--token=abc123"],
        options: {
          contact: "user@example.com",
          path: "/home/steve/private/path",
          apiKey: "top-secret",
        },
        global: {
          json: false,
          quiet: false,
          noExtensions: false,
          noPager: false,
          profile: false,
        },
        pm_root: "/tmp/project/.agents/pm",
      });
      expect(active?.capture_level).toBe("max");

      await finishTelemetryCommand(active, {
        ok: true,
        result: {
          query: "user@example.com token=supersecret /home/steve/private/path",
        },
      });

      const queueRaw = await fs.readFile(telemetryQueuePath(globalRoot), "utf8");
      const queuedEntries = queueRaw
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) =>
          JSON.parse(line) as {
            event: {
              event_type: string;
              payload: {
                capture_level?: string;
                pm_version?: string;
                source_context?: string;
                source_context_source?: string;
                command_args?: string[];
                command_options?: Record<string, unknown>;
                result_summary?: { preview?: Record<string, unknown> };
              };
            };
          },
        );

      const startEvent = queuedEntries.find((entry) => entry.event.event_type === "command_start");
      const finishEvent = queuedEntries.find((entry) => entry.event.event_type === "command_finish");
      expect(startEvent).toBeDefined();
      expect(finishEvent).toBeDefined();
      expect(startEvent?.event.payload.capture_level).toBe("max");
      expect(startEvent?.event.payload.pm_version).toBe("9.9.9-test");
      expect(startEvent?.event.payload.source_context).toMatch(/^(user|automation|test|dogfood|audit_smoke)$/);
      expect(startEvent?.event.payload.source_context_source).toMatch(/^(inferred|env_override)$/);
      expect(startEvent?.event.payload.command_args).toEqual(
        expect.arrayContaining(["user@example.com", "/home/steve/private/path", "--token=[redacted]"]),
      );
      expect(startEvent?.event.payload.command_options?.contact).toBe("user@example.com");
      expect(startEvent?.event.payload.command_options?.path).toBe("/home/steve/private/path");
      expect(startEvent?.event.payload.command_options?.apiKey).toBe("[redacted]");

      const query = String(finishEvent?.event.payload.result_summary?.preview?.query ?? "");
      expect(query).toContain("user@example.com");
      expect(query).toContain("/home/steve/private/path");
      expect(query).toContain("token=[redacted]");
      expect(query).not.toContain("supersecret");
    });
  });

  it("honors PM_TELEMETRY_SOURCE_CONTEXT override in start and finish payloads", async () => {
    await withTempGlobalRoot(async () => {
      process.env.PM_TELEMETRY_SOURCE_CONTEXT = "dogfood";
      globalThis.fetch = vi.fn(async () => {
        throw new Error("network_down");
      }) as unknown as typeof fetch;

      const active = await startTelemetryCommand({
        command: "list-open",
        pm_version: "9.9.9-test",
        args: [],
        options: {},
        global: {
          json: false,
          quiet: false,
          noExtensions: false,
          noPager: false,
          profile: false,
        },
        pm_root: "/tmp/project/.agents/pm",
      });
      expect(active).not.toBeNull();
      expect(active?.source_context).toBe("dogfood");
      expect(active?.source_context_source).toBe("env_override");

      await finishTelemetryCommand(active, {
        ok: true,
        result: { items: 0 },
      });

      if (!active) {
        throw new Error("expected active telemetry context");
      }

      const queueRaw = await fs.readFile(telemetryQueuePath(active.global_pm_root), "utf8");
      const queuedEntries = queueRaw
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as { event: { event_type: string; payload: Record<string, unknown> } });
      const startEvent = queuedEntries.find((entry) => entry.event.event_type === "command_start");
      const finishEvent = queuedEntries.find((entry) => entry.event.event_type === "command_finish");

      expect(startEvent?.event.payload.source_context).toBe("dogfood");
      expect(startEvent?.event.payload.source_context_source).toBe("env_override");
      expect(finishEvent?.event.payload.source_context).toBe("dogfood");
      expect(finishEvent?.event.payload.source_context_source).toBe("env_override");
    });
  });

  it("skips telemetry command collection when PM_TELEMETRY_DISABLED is set", async () => {
    await withTempGlobalRoot(async (globalRoot) => {
      process.env.PM_TELEMETRY_DISABLED = "1";
      const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const active = await startTelemetryCommand({
        command: "list-open",
        pm_version: "9.9.9-test",
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
        pm_version: "9.9.9-test",
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
        pm_version: "9.9.9-test",
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
