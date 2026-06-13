import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EXIT_CODE } from "../../src/core/shared/constants.js";
import { readSettings, writeSettings } from "../../src/core/store/settings.js";
import {
  _testOnly,
  emitTelemetryErrorEvent,
  finishTelemetryCommand,
  flushTelemetryQueueNow,
  startTelemetryCommand,
  waitForPendingFlush,
} from "../../src/core/telemetry/runtime.js";
import { withTempGlobalRoot as withTempGlobalRootHelper } from "../helpers/temp.js";

const originalGlobalPath = process.env.PM_GLOBAL_PATH;
const originalFetch = globalThis.fetch;
const originalOtelTracesEndpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
const originalOtelEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
const originalOtelServiceName = process.env.OTEL_SERVICE_NAME;
const originalTelemetryDisabled = process.env.PM_TELEMETRY_DISABLED;
const originalNoTelemetry = process.env.PM_NO_TELEMETRY;
const originalTelemetryOtelDisabled = process.env.PM_TELEMETRY_OTEL_DISABLED;
const originalTelemetryInlineFlush = process.env.PM_TELEMETRY_INLINE_FLUSH;
const originalTelemetryFlushChild = process.env.PM_TELEMETRY_FLUSH_CHILD;
const originalTelemetrySourceContext = process.env.PM_TELEMETRY_SOURCE_CONTEXT;
const originalTelemetryIngestKey = process.env.PM_TELEMETRY_INGEST_KEY;
const DAY_MS = 24 * 60 * 60 * 1000;
const PRIVATE_TEST_IP = ["192", "168", "42", "17"].join(".");
const TEST_LOCAL_PATH = ["/home", "example", "private", "path"].join("/");

function telemetryQueuePath(globalRoot: string): string {
  return path.join(globalRoot, "runtime", "telemetry", "events.jsonl");
}

async function withTempGlobalRoot(run: (globalRoot: string) => Promise<void>): Promise<void> {
  await withTempGlobalRootHelper("pm-cli-telemetry-runtime-test-", async (globalRoot) => {
    process.env.PM_GLOBAL_PATH = globalRoot;
    delete process.env.PM_TELEMETRY_DISABLED;
    delete process.env.PM_NO_TELEMETRY;
    await run(globalRoot);
  });
}

async function waitForFetchCalls(fetchMock: { mock: { calls: unknown[] } }, count: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (fetchMock.mock.calls.length >= count) {
      return;
    }
    await sleep(10);
  }
  throw new Error(`Timed out waiting for ${count} telemetry fetch call(s)`);
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
    if (originalNoTelemetry === undefined) {
      delete process.env.PM_NO_TELEMETRY;
    } else {
      process.env.PM_NO_TELEMETRY = originalNoTelemetry;
    }
    if (originalTelemetryOtelDisabled === undefined) {
      delete process.env.PM_TELEMETRY_OTEL_DISABLED;
    } else {
      process.env.PM_TELEMETRY_OTEL_DISABLED = originalTelemetryOtelDisabled;
    }
    if (originalTelemetryInlineFlush === undefined) {
      delete process.env.PM_TELEMETRY_INLINE_FLUSH;
    } else {
      process.env.PM_TELEMETRY_INLINE_FLUSH = originalTelemetryInlineFlush;
    }
    if (originalTelemetryFlushChild === undefined) {
      delete process.env.PM_TELEMETRY_FLUSH_CHILD;
    } else {
      process.env.PM_TELEMETRY_FLUSH_CHILD = originalTelemetryFlushChild;
    }
    if (originalTelemetrySourceContext === undefined) {
      delete process.env.PM_TELEMETRY_SOURCE_CONTEXT;
    } else {
      process.env.PM_TELEMETRY_SOURCE_CONTEXT = originalTelemetrySourceContext;
    }
    if (originalTelemetryIngestKey === undefined) {
      delete process.env.PM_TELEMETRY_INGEST_KEY;
    } else {
      process.env.PM_TELEMETRY_INGEST_KEY = originalTelemetryIngestKey;
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
          `token=inline-secret --password hunter2 ${TEST_LOCAL_PATH} ${PRIVATE_TEST_IP}`,
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
      await waitForPendingFlush();
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
            command_taxonomy?: {
              command_family?: string;
            };
            command_args: string[];
            command_args_hashes?: string[];
            command_args_digest?: string;
            command_options: Record<string, string>;
            command_options_digest?: string;
            global_options_digest?: string;
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
        "token=[redacted] --password [redacted] [redacted_path] [redacted_ip]",
      ]);
      expect(queued.event.payload.command_taxonomy?.command_family).toBe("mutation");
      expect(queued.event.payload.command_args_hashes).toHaveLength(5);
      expect(String(queued.event.payload.command_args_digest ?? "")).toMatch(/^[a-f0-9]{64}$/);
      expect(String(queued.event.payload.command_options_digest ?? "")).toMatch(/^[a-f0-9]{64}$/);
      expect(String(queued.event.payload.global_options_digest ?? "")).toMatch(/^[a-f0-9]{64}$/);
      expect(queued.event.payload.command_options.apiKey).toBe("[redacted]");
    });
  });

  it("queues command_error telemetry with sanitized payload for parse failures", async () => {
    await withTempGlobalRoot(async (globalRoot) => {
      await setTelemetryCaptureLevel(globalRoot, "redacted");
      globalThis.fetch = vi.fn(async () => {
        throw new Error("network_down");
      }) as unknown as typeof fetch;

      await emitTelemetryErrorEvent({
        command: "lst",
        args: ["lst", "--token=abc123", "/home/steve/private/path"],
        options: {
          token: "abc123",
          attemptedPath: "/home/steve/private/path",
        },
        global: {
          json: false,
          quiet: false,
          noExtensions: false,
          noPager: false,
          profile: false,
        },
        pm_version: "9.9.9-test",
        pm_root: "/tmp/project/.agents/pm",
        error_code: "unknown_command",
        error_message: `unknown command 'lst' token=abc123 ${PRIVATE_TEST_IP} /home/steve/private/path`,
        exit_code: 2,
      });
      await waitForPendingFlush();

      const queueRaw = await fs.readFile(telemetryQueuePath(globalRoot), "utf8");
      const entries = queueRaw
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) =>
          JSON.parse(line) as {
            attempts: number;
            event: {
              event_type: string;
              command: string;
              payload: {
                error_code?: string;
                error_category?: string;
                exit_code?: number;
                command_resolution?: string;
                resolution_stage?: string;
                attempted_args?: string[];
                attempted_args_hashes?: string[];
                attempted_args_digest?: string;
                attempted_options?: Record<string, unknown>;
                attempted_options_digest?: string;
                error?: string;
              };
            };
          },
        );
      const commandError = entries.find((entry) => entry.event.event_type === "command_error");
      expect(commandError).toBeDefined();
      expect(commandError?.attempts).toBe(1);
      expect(commandError?.event.command).toBe("lst");
      expect(commandError?.event.payload.error_code).toBe("unknown_command");
      expect(commandError?.event.payload.error_category).toBe("usage");
      expect(commandError?.event.payload.exit_code).toBe(2);
      expect(commandError?.event.payload.command_resolution).toBe("nonexistent_command");
      expect(commandError?.event.payload.resolution_stage).toBe("unknown");
      expect(commandError?.event.payload.attempted_args).toEqual(["lst", "--token=[redacted]", "[redacted_path]"]);
      expect(commandError?.event.payload.attempted_args_hashes).toHaveLength(3);
      expect(String(commandError?.event.payload.attempted_args_digest ?? "")).toMatch(/^[a-f0-9]{64}$/);
      expect(commandError?.event.payload.attempted_options?.token).toBe("[redacted]");
      expect(commandError?.event.payload.attempted_options?.attemptedPath).toBe("[redacted_path]");
      expect(String(commandError?.event.payload.attempted_options_digest ?? "")).toMatch(/^[a-f0-9]{64}$/);
      expect(commandError?.event.payload.error).toContain("[redacted]");
      expect(commandError?.event.payload.error).not.toContain("abc123");
      expect(commandError?.event.payload.error).not.toContain(PRIVATE_TEST_IP);
    });
  });

  it("skips instrumentation for telemetry clear commands", async () => {
    await withTempGlobalRoot(async (globalRoot) => {
      const active = await startTelemetryCommand({
        command: "telemetry",
        pm_version: "9.9.9-test",
        args: ["clear"],
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
      expect(active).toBeNull();
      await expect(fs.readFile(telemetryQueuePath(globalRoot), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("stamps schema_version and client_schema_version on command_start/finish/error queue entries", async () => {
    await withTempGlobalRoot(async (globalRoot) => {
      globalThis.fetch = vi.fn(async () => {
        throw new Error("network_down");
      }) as unknown as typeof fetch;

      const active = await startTelemetryCommand({
        command: "list-open",
        pm_version: "9.9.9-test",
        args: ["--limit", "5"],
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
        result: { count: 1 },
      });
      await emitTelemetryErrorEvent({
        command: "lst",
        args: ["lst"],
        options: {},
        global: {
          json: false,
          quiet: false,
          noExtensions: false,
          noPager: false,
          profile: false,
        },
        pm_version: "9.9.9-test",
        pm_root: "/tmp/project/.agents/pm",
        error_code: "unknown_command",
        error_message: "unknown command 'lst'",
        exit_code: 2,
      });
      await waitForPendingFlush();

      const queueRaw = await fs.readFile(telemetryQueuePath(globalRoot), "utf8");
      const entries = queueRaw
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) =>
          JSON.parse(line) as {
            client_schema_version?: number;
            event: {
              event_type: string;
              schema_version?: number;
            };
          },
        );
      const byType = new Map(entries.map((entry) => [entry.event.event_type, entry]));
      expect(byType.has("command_start")).toBe(true);
      expect(byType.has("command_finish")).toBe(true);
      expect(byType.has("command_error")).toBe(true);
      for (const eventType of ["command_start", "command_finish", "command_error"] as const) {
        const entry = byType.get(eventType);
        expect(entry?.event.schema_version).toBe(1);
        expect(entry?.client_schema_version).toBe(1);
      }
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
      await waitForPendingFlush();

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
      await waitForPendingFlush();

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
      expect(String(startEvent?.event.payload.command_args_digest ?? "")).toMatch(/^[a-f0-9]{64}$/);
      expect(String(startEvent?.event.payload.command_invocation_digest ?? "")).toMatch(/^[a-f0-9]{64}$/);
      expect(startEvent?.event.payload.command_taxonomy).toMatchObject({
        command_family: "query",
        command_root: "list-open",
      });

      const finishPayload = finishEvent?.event.payload ?? {};
      expect(finishPayload.capture_level).toBe("minimal");
      expect(finishPayload.pm_version).toBe("9.9.9-test");
      expect(String(finishPayload.source_context ?? "")).toMatch(/^(user|automation|test|dogfood|audit_smoke)$/);
      expect(String(finishPayload.source_context_source ?? "")).toMatch(/^(inferred|env_override)$/);
      expect(finishPayload.ok).toBe(false);
      expect(finishPayload.exit_code).toBe(1);
      expect(finishPayload.error_code).toBe("command_failed");
      expect(finishPayload.error_category).toBe("runtime");
      expect(finishPayload.command_resolution).toBe("runtime_failed");
      expect(finishPayload.resolution_stage).toBe("execute");
      expect(typeof finishPayload.duration_ms).toBe("number");
      expect(finishPayload.started_at).toBeUndefined();
      expect(finishPayload.result_summary).toBeUndefined();
      expect(String(finishPayload.error_fingerprint ?? "")).toMatch(/^[a-f0-9]{64}$/);
      expect(String(finishPayload.error ?? "")).toContain("[redacted]");
      expect(String(finishPayload.error ?? "")).not.toContain("supersecret");
    });
  });

  it("retains expanded context at max capture level while redacting secrets and local identifiers", async () => {
    await withTempGlobalRoot(async (globalRoot) => {
      await setTelemetryCaptureLevel(globalRoot, "max");
      globalThis.fetch = vi.fn(async () => {
        throw new Error("network_down");
      }) as unknown as typeof fetch;

      const active = await startTelemetryCommand({
        command: "search",
        pm_version: "9.9.9-test",
        args: ["user@example.com", TEST_LOCAL_PATH, PRIVATE_TEST_IP, "--token=abc123"],
        options: {
          contact: "user@example.com",
          path: TEST_LOCAL_PATH,
          host: PRIVATE_TEST_IP,
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
          query: `user@example.com token=supersecret ${TEST_LOCAL_PATH} ${PRIVATE_TEST_IP}`,
        },
      });
      await waitForPendingFlush();

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
                command_args_hashes?: string[];
                command_args_digest?: string;
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
        expect.arrayContaining(["[redacted_email]", "[redacted_path]", "[redacted_ip]", "--token=[redacted]"]),
      );
      expect(startEvent?.event.payload.command_args_hashes).toHaveLength(4);
      expect(String(startEvent?.event.payload.command_args_digest ?? "")).toMatch(/^[a-f0-9]{64}$/);
      expect(startEvent?.event.payload.command_options?.contact).toBe("[redacted_email]");
      expect(startEvent?.event.payload.command_options?.path).toBe("[redacted_path]");
      expect(startEvent?.event.payload.command_options?.host).toBe("[redacted_ip]");
      expect(startEvent?.event.payload.command_options?.apiKey).toBe("[redacted]");

      const query = String(finishEvent?.event.payload.result_summary?.preview?.query ?? "");
      expect(query).toContain("[redacted_email]");
      expect(query).toContain("[redacted_path]");
      expect(query).toContain("[redacted_ip]");
      expect(query).toContain("token=[redacted]");
      expect(query).not.toContain("supersecret");
    });
  });

  it("includes exit code and classified error metadata in command_finish payload", async () => {
    await withTempGlobalRoot(async (globalRoot) => {
      await setTelemetryCaptureLevel(globalRoot, "redacted");
      globalThis.fetch = vi.fn(async () => {
        throw new Error("network_down");
      }) as unknown as typeof fetch;

      const active = await startTelemetryCommand({
        command: "update",
        pm_version: "9.9.9-test",
        args: ["pm-a1b2", "--status", "closed"],
        options: {
          status: "closed",
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

      await finishTelemetryCommand(active, {
        ok: false,
        error: 'Invalid --status value "closed"',
        exit_code: 2,
        error_code: "invalid_argument_value",
      });
      await waitForPendingFlush();

      const queueRaw = await fs.readFile(telemetryQueuePath(globalRoot), "utf8");
      const entries = queueRaw
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) =>
          JSON.parse(line) as {
            event: {
              event_type: string;
              payload: {
                ok?: boolean;
                exit_code?: number;
                error_code?: string;
                error_category?: string;
                command_resolution?: string;
                resolution_stage?: string;
                error_fingerprint?: string;
              };
            };
          },
        );
      const finishEvent = entries.find((entry) => entry.event.event_type === "command_finish");
      expect(finishEvent).toBeDefined();
      expect(finishEvent?.event.payload.ok).toBe(false);
      expect(finishEvent?.event.payload.exit_code).toBe(2);
      expect(finishEvent?.event.payload.error_code).toBe("invalid_argument_value");
      expect(finishEvent?.event.payload.error_category).toBe("validation");
      expect(finishEvent?.event.payload.command_resolution).toBe("validation_failed");
      expect(finishEvent?.event.payload.resolution_stage).toBe("execute");
      expect(String(finishEvent?.event.payload.error_fingerprint ?? "")).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  it("classifies dependency failures and tracker initialization failures in command_finish payload", async () => {
    await withTempGlobalRoot(async (globalRoot) => {
      await setTelemetryCaptureLevel(globalRoot, "redacted");
      globalThis.fetch = vi.fn(async () => {
        throw new Error("network_down");
      }) as unknown as typeof fetch;

      const dependencyFailed = await startTelemetryCommand({
        command: "test-all",
        pm_version: "9.9.9-test",
        args: ["--status", "open"],
        options: {
          status: "open",
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
      expect(dependencyFailed).not.toBeNull();
      await finishTelemetryCommand(dependencyFailed, {
        ok: false,
        error: "linked tests failed",
        exit_code: EXIT_CODE.DEPENDENCY_FAILED,
      });

      const trackerInitFailure = await startTelemetryCommand({
        command: "context",
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
      expect(trackerInitFailure).not.toBeNull();
      await finishTelemetryCommand(trackerInitFailure, {
        ok: false,
        error: "Tracker is not initialized at /tmp/project/.agents/pm. Run pm init first.",
        exit_code: EXIT_CODE.NOT_FOUND,
      });
      await waitForPendingFlush();

      const queueRaw = await fs.readFile(telemetryQueuePath(globalRoot), "utf8");
      const entries = queueRaw
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) =>
          JSON.parse(line) as {
            event: {
              event_type: string;
              command: string;
              payload: {
                ok?: boolean;
                exit_code?: number;
                error_code?: string;
                error_category?: string;
                command_resolution?: string;
              };
            };
          },
        );

      const dependencyFinish = entries.find(
        (entry) => entry.event.event_type === "command_finish" && entry.event.command === "test-all",
      );
      expect(dependencyFinish).toBeDefined();
      expect(dependencyFinish?.event.payload.ok).toBe(false);
      expect(dependencyFinish?.event.payload.exit_code).toBe(EXIT_CODE.DEPENDENCY_FAILED);
      expect(dependencyFinish?.event.payload.error_code).toBe("dependency_failed");
      expect(dependencyFinish?.event.payload.error_category).toBe("runtime");
      expect(dependencyFinish?.event.payload.command_resolution).toBe("runtime_failed");

      const trackerInitFinish = entries.find(
        (entry) => entry.event.event_type === "command_finish" && entry.event.command === "context",
      );
      expect(trackerInitFinish).toBeDefined();
      expect(trackerInitFinish?.event.payload.ok).toBe(false);
      expect(trackerInitFinish?.event.payload.exit_code).toBe(EXIT_CODE.NOT_FOUND);
      expect(trackerInitFinish?.event.payload.error_code).toBe("tracker_not_initialized");
      expect(trackerInitFinish?.event.payload.error_category).toBe("validation");
      expect(trackerInitFinish?.event.payload.command_resolution).toBe("validation_failed");
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
      await waitForPendingFlush();

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

  it("skips telemetry command collection when PM_NO_TELEMETRY is set", async () => {
    await withTempGlobalRoot(async (globalRoot) => {
      process.env.PM_NO_TELEMETRY = "1";
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

  it("skips telemetry clear commands and disabled flush workers", async () => {
    await withTempGlobalRoot(async (globalRoot) => {
      const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const active = await startTelemetryCommand({
        command: "telemetry",
        pm_version: "9.9.9-test",
        args: ["clear"],
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

      process.env.PM_TELEMETRY_DISABLED = "true";
      await flushTelemetryQueueNow(globalRoot);

      expect(fetchMock).not.toHaveBeenCalled();
      await expect(fs.access(telemetryQueuePath(globalRoot))).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("treats null finish handles and disabled error collection as no-ops", async () => {
    await withTempGlobalRoot(async (globalRoot) => {
      const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await finishTelemetryCommand(null, {
        ok: false,
        error: "ignored",
      });

      process.env.PM_NO_TELEMETRY = "yes";
      await emitTelemetryErrorEvent({
        command: "bad",
        args: ["bad"],
        options: {},
        global: {
          json: true,
          quiet: false,
          noExtensions: false,
          noPager: false,
          profile: false,
        },
        pm_version: "9.9.9-test",
        pm_root: "/tmp/project/.agents/pm",
        error_code: "unknown_command",
        error_message: "unknown command",
        exit_code: 2,
      });

      expect(fetchMock).not.toHaveBeenCalled();
      await expect(fs.access(telemetryQueuePath(globalRoot))).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("skips command collection when telemetry is disabled in settings", async () => {
    await withTempGlobalRoot(async (globalRoot) => {
      const settings = await readSettings(globalRoot);
      settings.telemetry.enabled = false;
      await writeSettings(globalRoot, settings, "test:disable_telemetry");
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
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  it("skips error collection when telemetry is disabled in settings", async () => {
    await withTempGlobalRoot(async (globalRoot) => {
      const settings = await readSettings(globalRoot);
      settings.telemetry.enabled = false;
      await writeSettings(globalRoot, settings, "test:disable_error_telemetry");
      const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await emitTelemetryErrorEvent({
        command: "bad",
        args: ["bad"],
        options: {},
        global: {
          json: true,
          quiet: false,
          noExtensions: false,
          noPager: false,
          profile: false,
        },
        pm_version: "9.9.9-test",
        pm_root: "/tmp/project/.agents/pm",
        error_code: "unknown_command",
        error_message: "unknown command",
        exit_code: 2,
      });

      expect(fetchMock).not.toHaveBeenCalled();
      await expect(fs.access(telemetryQueuePath(globalRoot))).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("normalizes invalid and disabled local OTEL endpoint settings", async () => {
    await withTempGlobalRoot(async () => {
      globalThis.fetch = vi.fn(async () => {
        throw new Error("network_down");
      }) as unknown as typeof fetch;

      process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = "not a url";
      const invalidDirect = await startTelemetryCommand({
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
      expect(invalidDirect?.otel_traces_endpoint).toBeUndefined();

      delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "not a url";
      const invalidBase = await startTelemetryCommand({
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
      expect(invalidBase?.otel_traces_endpoint).toBeUndefined();

      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://127.0.0.1:4318/v1/traces";
      process.env.PM_TELEMETRY_OTEL_DISABLED = "on";
      const disabled = await startTelemetryCommand({
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
      expect(disabled?.otel_traces_endpoint).toBeUndefined();
      await waitForPendingFlush();
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
      await waitForPendingFlush();

      const queueRaw = await fs.readFile(telemetryQueuePath(globalRoot), "utf8");
      expect(queueRaw.trim()).toBe("");

      const settings = await readSettings(globalRoot);
      expect(settings.telemetry.installation_id.length).toBeGreaterThan(0);
      expect(settings.telemetry.enabled).toBe(true);
      expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  it("removes stale telemetry queue temp orphans during flush", async () => {
    await withTempGlobalRoot(async (globalRoot) => {
      process.env.PM_TELEMETRY_INLINE_FLUSH = "1";
      const telemetryDir = path.dirname(telemetryQueuePath(globalRoot));
      await fs.mkdir(telemetryDir, { recursive: true });
      const staleTemp = path.join(telemetryDir, ".events.jsonl.1234.1111111111111.abcdef12.tmp");
      const freshTemp = path.join(telemetryDir, ".events.jsonl.1234.9999999999999.abcdef12.tmp");
      await fs.writeFile(staleTemp, "stale", "utf8");
      await fs.writeFile(freshTemp, "fresh", "utf8");
      const staleDate = new Date(Date.now() - 2 * 60 * 60 * 1000);
      await fs.utimes(staleTemp, staleDate, staleDate);

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
      await waitForPendingFlush();

      await expect(fs.access(staleTemp)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.access(freshTemp)).resolves.toBeUndefined();
    });
  });

  it("deduplicates scheduled flush children while a spawn gate is fresh", async () => {
    await withTempGlobalRoot(async (globalRoot) => {
      delete process.env.PM_TELEMETRY_INLINE_FLUSH;
      delete process.env.PM_TELEMETRY_FLUSH_CHILD;

      expect(_testOnly.acquireTelemetryFlushSpawnGate(globalRoot)).toBe(true);
      await expect(fs.access(_testOnly.flushSpawnLockPath(globalRoot))).resolves.toBeUndefined();

      expect(_testOnly.acquireTelemetryFlushSpawnGate(globalRoot)).toBe(false);
    });
  });

  it("allows another scheduled flush child after a stale spawn gate", async () => {
    await withTempGlobalRoot(async (globalRoot) => {
      delete process.env.PM_TELEMETRY_INLINE_FLUSH;
      delete process.env.PM_TELEMETRY_FLUSH_CHILD;

      expect(_testOnly.acquireTelemetryFlushSpawnGate(globalRoot)).toBe(true);

      const staleDate = new Date(Date.now() - 2 * 60 * 1000);
      await fs.utimes(_testOnly.flushSpawnLockPath(globalRoot), staleDate, staleDate);

      expect(_testOnly.acquireTelemetryFlushSpawnGate(globalRoot)).toBe(true);
    });
  });

  it("skips scheduled flush children while another process owns the flush lock", async () => {
    await withTempGlobalRoot(async (globalRoot) => {
      delete process.env.PM_TELEMETRY_INLINE_FLUSH;
      delete process.env.PM_TELEMETRY_FLUSH_CHILD;
      await fs.mkdir(_testOnly.flushLockPath(globalRoot), { recursive: true });

      expect(_testOnly.acquireTelemetryFlushSpawnGate(globalRoot)).toBe(false);
      await expect(fs.access(_testOnly.flushSpawnLockPath(globalRoot))).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });

  it("clears a parent-created spawn gate once the flush child enters the process lock", async () => {
    await withTempGlobalRoot(async (globalRoot) => {
      await fs.mkdir(path.dirname(_testOnly.flushSpawnLockPath(globalRoot)), { recursive: true });
      await fs.mkdir(_testOnly.flushSpawnLockPath(globalRoot));

      await flushTelemetryQueueNow(globalRoot);

      await expect(fs.access(_testOnly.flushSpawnLockPath(globalRoot))).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });

  it("clears a parent-created spawn gate when the flush process lock is already held", async () => {
    await withTempGlobalRoot(async (globalRoot) => {
      await fs.mkdir(path.dirname(_testOnly.flushSpawnLockPath(globalRoot)), { recursive: true });
      await fs.mkdir(_testOnly.flushSpawnLockPath(globalRoot));
      await fs.mkdir(_testOnly.flushLockPath(globalRoot), { recursive: true });

      await flushTelemetryQueueNow(globalRoot);

      await expect(fs.access(_testOnly.flushSpawnLockPath(globalRoot))).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });

  it("keeps events appended while a successful flush request is in flight", async () => {
    await withTempGlobalRoot(async (globalRoot) => {
      let resolveFirstFetch: ((response: Response) => void) | undefined;
      const firstFetch = new Promise<Response>((resolve) => {
        resolveFirstFetch = resolve;
      });
      const fetchMock = vi.fn(async () => {
        if (fetchMock.mock.calls.length === 1) {
          return firstFetch;
        }
        return new Response("{}", { status: 200 });
      });
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
      await waitForFetchCalls(fetchMock, 1);

      await finishTelemetryCommand(active, {
        ok: true,
        result: { count: 0, items: [] },
      });
      resolveFirstFetch?.(new Response("{}", { status: 200 }));
      await waitForPendingFlush();
      await sleep(50);

      const queueRaw = await fs.readFile(telemetryQueuePath(globalRoot), "utf8");
      expect(queueRaw.trim()).toBe("");
      expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  it("adds ingest key header when PM_TELEMETRY_INGEST_KEY is set", async () => {
    await withTempGlobalRoot(async () => {
      process.env.PM_TELEMETRY_INGEST_KEY = "test-ingest-key";
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

      await waitForPendingFlush();
      expect(fetchMock).toHaveBeenCalled();
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const headerValue = (() => {
        const headers = init.headers;
        if (!headers) {
          return undefined;
        }
        if (headers instanceof Headers) {
          return headers.get("x-pm-telemetry-key") ?? undefined;
        }
        if (Array.isArray(headers)) {
          const pair = headers.find(([key]) => key.toLowerCase() === "x-pm-telemetry-key");
          return pair?.[1];
        }
        return (headers as Record<string, string>)["x-pm-telemetry-key"];
      })();
      expect(headerValue).toBe("test-ingest-key");
    });
  });

  it("prunes stale queue entries based on retention_days during flush", async () => {
    await withTempGlobalRoot(async (globalRoot) => {
      const settings = await readSettings(globalRoot);
      settings.telemetry.endpoint = "https://pm-cli.unbrained.dev/v1/events";
      settings.telemetry.retention_days = 1;
      await writeSettings(globalRoot, settings, "test:set_retention_days");

      const staleEventId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const freshEventId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      const queueEntries = [
        {
          attempts: 0,
          event: {
            schema_version: 1,
            event_id: staleEventId,
            event_type: "command_start",
            occurred_at: new Date(Date.now() - 2 * DAY_MS).toISOString(),
            installation_id: "44444444-4444-4444-8444-444444444444",
            session_id: "55555555-5555-4555-8555-555555555555",
            command: "stale-event",
            payload: { capture_level: "minimal" },
          },
        },
        {
          attempts: 0,
          event: {
            schema_version: 1,
            event_id: freshEventId,
            event_type: "command_start",
            occurred_at: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
            installation_id: "66666666-6666-4666-8666-666666666666",
            session_id: "77777777-7777-4777-8777-777777777777",
            command: "fresh-event",
            payload: { capture_level: "minimal" },
          },
        },
      ];

      await fs.mkdir(path.join(globalRoot, "runtime", "telemetry"), { recursive: true });
      await fs.writeFile(
        telemetryQueuePath(globalRoot),
        `${queueEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
        "utf8",
      );

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
      await waitForPendingFlush();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const payload = JSON.parse(String(init.body ?? "{}")) as {
        events: Array<{ event_id: string }>;
      };
      const sentEventIds = payload.events.map((event) => event.event_id);
      expect(sentEventIds).toContain(freshEventId);
      expect(sentEventIds).not.toContain(staleEventId);

      const queueRaw = await fs.readFile(telemetryQueuePath(globalRoot), "utf8");
      expect(queueRaw.trim()).toBe("");
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
      await waitForPendingFlush();

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
      expect(attrMap.get("pm.exit_code")?.intValue).toBe("1");
      expect(attrMap.get("pm.error_code")?.stringValue).toBe("command_failed");
      expect(attrMap.get("pm.error_category")?.stringValue).toBe("runtime");
      expect(attrMap.get("pm.error")?.stringValue).toBe("synthetic_failure");
      expect(body.resourceSpans[0]?.resource.attributes[0]?.key).toBe("service.name");
      expect(body.resourceSpans[0]?.resource.attributes[0]?.value.stringValue).toBe("pm-cli-test");
    });
  });

  it("covers telemetry runtime state parsing, inline flush detection, and queue rewrite helpers", async () => {
    await withTempGlobalRoot(async (globalRoot) => {
      const statePath = _testOnly.runtimeStatePath(globalRoot);
      await fs.mkdir(path.dirname(statePath), { recursive: true });

      await fs.writeFile(statePath, "", "utf8");
      await expect(_testOnly.readRuntimeState(globalRoot)).resolves.toEqual({});
      await fs.writeFile(statePath, "[]\n", "utf8");
      await expect(_testOnly.readRuntimeState(globalRoot)).resolves.toEqual({});
      await fs.writeFile(statePath, "{ invalid-json", "utf8");
      await expect(_testOnly.readRuntimeState(globalRoot)).resolves.toEqual({});

      await _testOnly.writeRuntimeState(globalRoot, {
        endpoint: "https://telemetry.example.test/events",
        queue_entries: undefined,
        last_failed_flush_error: "network_down",
      });
      expect(JSON.parse(await fs.readFile(statePath, "utf8"))).toEqual({
        endpoint: "https://telemetry.example.test/events",
        last_failed_flush_error: "network_down",
      });

      delete process.env.PM_TELEMETRY_INLINE_FLUSH;
      delete process.env.PM_TELEMETRY_FLUSH_CHILD;
      expect(_testOnly.shouldFlushInline()).toBe(true);
      process.env.PM_TELEMETRY_FLUSH_CHILD = "yes";
      expect(_testOnly.shouldFlushInline()).toBe(true);

      expect(_testOnly.telemetryFlushRunnerPath()).toMatch(/dist\/cli\/telemetry-flush\.js$/);
      expect(_testOnly.isRetryableQueueRewriteError({ code: "EACCES" })).toBe(true);
      expect(_testOnly.isRetryableQueueRewriteError({ code: "EBUSY" })).toBe(true);
      expect(_testOnly.isRetryableQueueRewriteError({ code: "EPERM" })).toBe(true);
      expect(_testOnly.isRetryableQueueRewriteError({ code: "ENOENT" })).toBe(false);
      expect(_testOnly.isRetryableQueueRewriteError(null)).toBe(false);
      expect(_testOnly.parseQueueLines("\nnot-json\n{}\n")).toEqual([]);
      expect(_testOnly.errorCode({ code: "EEXIST" })).toBe("EEXIST");
      expect(_testOnly.errorCode({ code: 1 })).toBeUndefined();
      expect(_testOnly.errorCode(null)).toBeUndefined();
      const directLockPath = path.join(globalRoot, "locks", "direct");
      expect(_testOnly.isFreshDirectoryLock(directLockPath, 1000)).toBe(false);
      expect(_testOnly.createDirectoryLock(directLockPath)).toBe(true);
      expect(_testOnly.isFreshDirectoryLock(directLockPath, 1000)).toBe(true);
      expect(_testOnly.createDirectoryLock(directLockPath)).toBe(false);
      const staleLockPath = path.join(globalRoot, "locks", "stale");
      expect(_testOnly.createDirectoryLock(staleLockPath)).toBe(true);
      expect(_testOnly.createDirectoryLock(staleLockPath)).toBe(false);
      const staleSpawnRoot = path.join(globalRoot, "stale-spawn-root");
      expect(_testOnly.createDirectoryLock(_testOnly.flushSpawnLockPath(staleSpawnRoot))).toBe(true);
      const staleLockTime = new Date(Date.now() - 60_000);
      await fs.utimes(_testOnly.flushSpawnLockPath(staleSpawnRoot), staleLockTime, staleLockTime);
      expect(_testOnly.acquireTelemetryFlushSpawnGate(staleSpawnRoot)).toBe(true);
      expect(await _testOnly.acquireTelemetryFlushLock(globalRoot)).toBe(true);
      expect(await _testOnly.acquireTelemetryFlushLock(globalRoot)).toBe(false);
      _testOnly.removeDirectoryLockBestEffort(directLockPath);
      await expect(fs.access(directLockPath)).rejects.toMatchObject({ code: "ENOENT" });

      const blockedParent = path.join(globalRoot, "blocked-parent");
      await fs.writeFile(blockedParent, "not a dir", "utf8");
      expect(_testOnly.createDirectoryLock(path.join(blockedParent, "child"))).toBe(false);
      expect(_testOnly.normalizeTelemetryExitCode(undefined, true)).toBe(0);
      expect(_testOnly.normalizeTelemetryExitCode(undefined, false)).toBe(1);
      expect(_testOnly.normalizeTelemetryExitCode(2.9, true)).toBe(2);
      expect(_testOnly.normalizeTelemetryErrorCode("  ")).toBeUndefined();
      expect(_testOnly.normalizeTelemetryErrorCategory({ ok: true })).toBeUndefined();
      expect(_testOnly.normalizeTelemetryErrorCategory({ ok: false, errorCategory: "usage" })).toBe("usage");
      expect(_testOnly.normalizeTelemetryErrorCategory({ ok: false, errorCode: "enoent" })).toBe("unknown");
      expect(_testOnly.normalizeTelemetryErrorCategory({ ok: false })).toBe("unknown");

      expect(_testOnly.sanitizeValue(Symbol("secret"))).toBe("Symbol(secret)");
      expect(_testOnly.sanitizeValue({ token: "abc", nested: [{ email: "user@example.com" }] })).toEqual({
        token: "[redacted]",
        nested: [{ email: "[redacted_email]" }],
      });
      expect(_testOnly.sanitizeValue("not-an-email@localhost and bearer abc123")).toBe(
        "not-an-email@localhost and bearer [redacted_token]",
      );
      expect(_testOnly.sanitizeValue("x".repeat(600))).toMatch(/^x{509}\.\.\.$/);
      expect(_testOnly.sanitizeValue("x".repeat(2100), undefined, "max")).toMatch(/^x{2045}\.\.\.$/);
      expect(_testOnly.sanitizeValue("/tmp/private/file.txt")).toBe("[redacted_path]");
      expect(_testOnly.sanitizeValue(Array.from({ length: 25 }, (_value, index) => index))).toHaveLength(20);
      expect(
        _testOnly.sanitizeValue({
          a: { b: { c: { d: { e: { f: { g: "too deep" } } } } } },
        }),
      ).toEqual({ a: { b: { c: { d: { e: { f: "[depth_truncated]" } } } } } });
      expect(_testOnly.summarizeResult(null)).toEqual({ type: "nullish" });
      expect(_testOnly.summarizeResult("hello")).toEqual({ type: "string", value: "hello" });
      expect(_testOnly.summarizeResult(5)).toEqual({ type: "number", value: 5 });
      expect(_testOnly.summarizeResult([1, { token: "secret" }])).toEqual({
        type: "array",
        length: 2,
        sample: [1, { token: "[redacted]" }],
      });
      expect(_testOnly.summarizeResult(Symbol("done"))).toEqual({ type: "symbol", value: "Symbol(done)" });
      const largeSummary = _testOnly.summarizeResult({ big: "x".repeat(70_000), later: "kept" });
      expect(largeSummary).toMatchObject({
        type: "object",
        preview: {
          big: expect.stringMatching(/^x+\.\.\.$/),
        },
      });
      expect(_testOnly.hashTelemetryValue("install", { b: 2, a: 1 })).toBe(_testOnly.hashTelemetryValue("install", { a: 1, b: 2 }));

      const sourceContext = { source_context: "test" as const, source_context_source: "inferred" as const };
      expect(
        _testOnly.buildCommandStartPayload({
          captureLevel: "minimal",
          context: { command: "list-open", args: ["--secret", "value"], options: {}, global: {} },
          pmVersion: "1.0.0",
          sourceContext,
          pmRootHash: "pm-root",
          cwdHash: "cwd",
          installationId: "install",
        }),
      ).toMatchObject({
        capture_level: "minimal",
        command_taxonomy: {
          command_family: "query",
          command_path: "list-open",
        },
      });
      expect(
        _testOnly.buildCommandFinishPayload({
          captureLevel: "redacted",
          pmVersion: "1.0.0",
          sourceContext,
          outcome: { ok: false, error: "failed", result: { token: "secret" } },
          durationMs: 12,
          startedAt: "2026-01-01T00:00:00.000Z",
          command: "list-open",
          installationId: "install",
          commandTaxonomy: "list",
          exitCode: 1,
          errorCode: "command_failed",
          errorCategory: "runtime",
          commandResolution: "native",
          resolutionStage: "execute",
        }),
      ).toMatchObject({ capture_level: "redacted", ok: false, result_summary: { type: "object" } });
      expect(
        _testOnly.buildCommandErrorPayload({
          captureLevel: "minimal",
          pmVersion: "1.0.0",
          sourceContext,
          command: "list-open",
          commandTaxonomy: "list",
          commandResolution: "native",
          resolutionStage: "parse",
          args: ["--token", "secret"],
          options: { token: "secret" },
          pmRootHash: "pm-root",
          cwdHash: "cwd",
          installationId: "install",
          errorCode: "usage",
          errorMessage: "bad input",
          errorCategory: "usage",
          exitCode: 64,
        }),
      ).toMatchObject({ capture_level: "minimal", error_code: "usage", exit_code: 64 });

      const now = new Date().toISOString();
      const old = new Date(Date.now() - 3 * DAY_MS).toISOString();
      const oversizedPayload = "x".repeat(70_000);
      const freshEntry = {
        attempts: 0,
        event: {
          schema_version: 1,
          event_id: "11111111-1111-4111-8111-111111111111",
          event_type: "command_start" as const,
          occurred_at: now,
          installation_id: "22222222-2222-4222-8222-222222222222",
          session_id: "33333333-3333-4333-8333-333333333333",
          command: "fresh",
          payload: {},
        },
      };
      expect(_testOnly.parseQueueLines(`${JSON.stringify(freshEntry)}\n`)).toEqual([freshEntry]);
      expect(_testOnly.parseQueueLines(`${JSON.stringify({ ...freshEntry, client_schema_version: "1" })}\n`)).toEqual([]);
      expect(_testOnly.isDueForRetry(freshEntry)).toBe(true);
      expect(_testOnly.isDueForRetry({ ...freshEntry, next_attempt_after: "not-a-date" })).toBe(true);
      expect(_testOnly.isDueForRetry({ ...freshEntry, next_attempt_after: new Date(Date.now() - 1000).toISOString() })).toBe(true);
      expect(_testOnly.isDueForRetry({ ...freshEntry, next_attempt_after: new Date(Date.now() + DAY_MS).toISOString() })).toBe(false);
      const pruned = _testOnly.pruneExpiredQueueEntries(
        [
          freshEntry,
          {
            ...freshEntry,
            attempts: 0,
            event: { ...freshEntry.event, event_id: "44444444-4444-4444-8444-444444444444", occurred_at: old },
          },
          {
            ...freshEntry,
            attempts: 99,
            event: { ...freshEntry.event, event_id: "55555555-5555-4555-8555-555555555555" },
          },
          {
            ...freshEntry,
            event: {
              ...freshEntry.event,
              event_id: "66666666-6666-4666-8666-666666666666",
              payload: { oversizedPayload },
            },
          },
        ],
        1,
      );
      expect(pruned.prunedCount).toBe(3);
      expect(pruned.entries).toEqual([freshEntry]);

      await _testOnly.rewriteQueue(globalRoot, [freshEntry]);
      expect(await fs.readFile(telemetryQueuePath(globalRoot), "utf8")).toContain(freshEntry.event.event_id);
      await _testOnly.rewriteQueue(globalRoot, []);
      expect(await fs.readFile(telemetryQueuePath(globalRoot), "utf8")).toBe("");
    });
  });

  it("covers telemetry flush disabled settings and empty queue state branches", async () => {
    await withTempGlobalRoot(async (globalRoot) => {
      const settings = await readSettings(globalRoot);
      settings.telemetry.enabled = false;
      await writeSettings(globalRoot, settings);
      await flushTelemetryQueueNow(globalRoot);
      await expect(_testOnly.readRuntimeState(globalRoot)).resolves.toEqual({});

      settings.telemetry.enabled = true;
      settings.telemetry.endpoint = "https://telemetry.example.test/events";
      await writeSettings(globalRoot, settings);
      await flushTelemetryQueueNow(globalRoot);
      await expect(_testOnly.readRuntimeState(globalRoot)).resolves.toMatchObject({
        endpoint: "https://telemetry.example.test/events",
        queue_entries: 0,
      });
    });
  });

  it("covers non-inline scheduler gate and start failure fallback", async () => {
    await withTempGlobalRoot(async (globalRoot) => {
      const originalVitest = process.env.VITEST;
      const originalVitestWorker = process.env.VITEST_WORKER_ID;
      const originalNodeEnv = process.env.NODE_ENV;
      try {
        delete process.env.PM_TELEMETRY_INLINE_FLUSH;
        delete process.env.PM_TELEMETRY_FLUSH_CHILD;
        delete process.env.VITEST;
        delete process.env.VITEST_WORKER_ID;
        process.env.NODE_ENV = "development";

        const invalidGateRoot = path.join(globalRoot, "blocked-gate-root");
        await fs.mkdir(path.dirname(invalidGateRoot), { recursive: true });
        await fs.writeFile(invalidGateRoot, "file blocks runtime path", "utf8");
        expect(_testOnly.acquireTelemetryFlushSpawnGate(invalidGateRoot)).toBe(false);

        const spawnRoot = path.join(globalRoot, "spawn-root");
        await fs.mkdir(spawnRoot, { recursive: true });
        _testOnly.scheduleTelemetryFlush(spawnRoot, "https://telemetry.example.test/events", 1);
        await sleep(25);

        await fs.mkdir(_testOnly.flushLockPath(globalRoot), { recursive: true });
        _testOnly.scheduleTelemetryFlush(globalRoot, "https://telemetry.example.test/events", 1);
        await expect(fs.access(_testOnly.flushLockPath(globalRoot))).resolves.toBeUndefined();

        const invalidGlobalRoot = path.join(globalRoot, "not-a-directory");
        await fs.writeFile(invalidGlobalRoot, "file blocks settings path", "utf8");
        process.env.PM_GLOBAL_PATH = invalidGlobalRoot;
        await expect(
          startTelemetryCommand({
            command: "list-open",
            pm_version: "1.0.0",
            args: [],
            options: {},
            global: {},
            pm_root: globalRoot,
          }),
        ).resolves.toBeNull();
      } finally {
        if (originalVitest === undefined) {
          delete process.env.VITEST;
        } else {
          process.env.VITEST = originalVitest;
        }
        if (originalVitestWorker === undefined) {
          delete process.env.VITEST_WORKER_ID;
        } else {
          process.env.VITEST_WORKER_ID = originalVitestWorker;
        }
        if (originalNodeEnv === undefined) {
          delete process.env.NODE_ENV;
        } else {
          process.env.NODE_ENV = originalNodeEnv;
        }
      }
    });
  });

  it("releases the telemetry spawn gate when detached spawn throws", async () => {
    await vi.resetModules();
    vi.doMock("node:child_process", () => ({
      spawn: vi.fn(() => {
        throw new Error("spawn unavailable");
      }),
    }));
    try {
      const runtime = await import("../../src/core/telemetry/runtime.js");
      await withTempGlobalRoot(async (globalRoot) => {
        const originalVitest = process.env.VITEST;
        const originalVitestWorker = process.env.VITEST_WORKER_ID;
        const originalNodeEnv = process.env.NODE_ENV;
        try {
          delete process.env.PM_TELEMETRY_INLINE_FLUSH;
          delete process.env.PM_TELEMETRY_FLUSH_CHILD;
          delete process.env.VITEST;
          delete process.env.VITEST_WORKER_ID;
          process.env.NODE_ENV = "development";

          runtime._testOnly.scheduleTelemetryFlush(globalRoot, "https://telemetry.example.test/events", 1);
          await expect(fs.access(runtime._testOnly.flushSpawnLockPath(globalRoot))).rejects.toMatchObject({
            code: "ENOENT",
          });
        } finally {
          if (originalVitest === undefined) {
            delete process.env.VITEST;
          } else {
            process.env.VITEST = originalVitest;
          }
          if (originalVitestWorker === undefined) {
            delete process.env.VITEST_WORKER_ID;
          } else {
            process.env.VITEST_WORKER_ID = originalVitestWorker;
          }
          if (originalNodeEnv === undefined) {
            delete process.env.NODE_ENV;
          } else {
            process.env.NODE_ENV = originalNodeEnv;
          }
        }
      });
    } finally {
      vi.doUnmock("node:child_process");
      await vi.resetModules();
    }
  });

  it("covers telemetry sanitizer and queue edge cases directly", async () => {
    await withTempGlobalRoot(async (globalRoot) => {
      expect(_testOnly.sanitizeValue(null)).toBeNull();
      expect(_testOnly.sanitizeValue(undefined)).toBeUndefined();
      expect(_testOnly.sanitizeValue(Symbol.for("telemetry-symbol"))).toBe("Symbol(telemetry-symbol)");
      expect(_testOnly.sanitizeValue("x".repeat(600))).toMatch(/\.\.\.$/);
      expect(_testOnly.sanitizeValue("not-an-email@")).toBe("not-an-email@");
      expect(_testOnly.sanitizeValue("bad@domain.c")).toBe("bad@domain.c");
      expect(_testOnly.sanitizeValue("bad@domain!.com")).toBe("bad@domain!.com");
      expect(_testOnly.sanitizeValue("@example.com")).toBe("@example.com");
      expect(_testOnly.sanitizeValue("user@")).toBe("user@");
      expect(_testOnly.sanitizeValue("bad!local@example.com")).toBe("bad![redacted_email]");
      expect(_testOnly.sanitizeValue("bad@domain!.example")).toBe("bad@domain!.example");
      expect(_testOnly.sanitizeValue(`/tmp/${"x".repeat(2100)}`, undefined, "max")).toBe("[redacted_path]");
      expect(_testOnly.sanitizeValue(`${TEST_LOCAL_PATH}/file.txt`, undefined, "max")).toBe("[redacted_path]");
      expect(_testOnly.sanitizeValue("--secret value")).toBe("--secret [redacted]");
      expect(_testOnly.sanitizeValue({ token: "secret", nested: { email: "bad@domain.c" } })).toEqual({
        nested: { email: "bad@domain.c" },
        token: "[redacted]",
      });
      expect(
        _testOnly.sanitizeValue({
          a: { b: { c: { d: { e: { f: { g: "truncated" } } } } } },
        }),
      ).toMatchObject({
        a: { b: { c: { d: { e: { f: "[depth_truncated]" } } } } },
      });
      expect(_testOnly.sanitizeValue([`${PRIVATE_TEST_IP}`, "user@example.com"])).toEqual(["[redacted_ip]", "[redacted_email]"]);
      const previewLimited = _testOnly.summarizeResult(
        Object.fromEntries(Array.from({ length: 25 }, (_entry, index) => [`k${String(index).padStart(2, "0")}`, "x".repeat(600)])),
      ) as { preview: Record<string, unknown> };
      expect(Object.values(previewLimited.preview)).toContain("[preview_truncated]");
      expect(_testOnly.summarizeResult({ huge: "x".repeat(70_000), later: "value" })).toMatchObject({
        type: "object",
        preview: { huge: expect.stringMatching(/\.\.\.$/) },
      });
      expect(_testOnly.hashTelemetryValue("install", { b: 2, a: 1 })).toMatch(/^[a-f0-9]{64}$/);
      expect(_testOnly.normalizeTelemetryErrorCode("  ")).toBeUndefined();
      expect(_testOnly.normalizeTelemetryExitCode(Number.NaN, false)).toBe(1);
      expect(_testOnly.normalizeTelemetryErrorCategory({ ok: false })).toBe("unknown");

      const queueFile = telemetryQueuePath(globalRoot);
      await fs.mkdir(path.dirname(queueFile), { recursive: true });
      await fs.writeFile(
        queueFile,
        `${JSON.stringify({
          event: { event_id: "77777777-7777-4777-8777-777777777777", occurred_at: "not-a-date" },
          attempts: 0,
        })}\n`,
        "utf8",
      );
      const settings = await readSettings(globalRoot);
      settings.telemetry.endpoint = "https://telemetry.example.test/events";
      await writeSettings(globalRoot, settings, "test:set_endpoint");
      globalThis.fetch = vi.fn(async () => ({ ok: false, status: 503 })) as unknown as typeof fetch;
      await flushTelemetryQueueNow(globalRoot);
      await expect(_testOnly.readRuntimeState(globalRoot)).resolves.toMatchObject({
        endpoint: "https://telemetry.example.test/events",
        queue_entries: 1,
        last_failed_flush_error: "telemetry_flush_http_503",
      });
    });
  });

  it("covers telemetry pure helper residue for source, capture, hashing, and OTLP errors", async () => {
    await withTempGlobalRoot(async () => {
      expect(_testOnly.normalizeCaptureLevel(" MINIMAL ")).toBe("minimal");
      expect(_testOnly.normalizeCaptureLevel("max")).toBe("max");
      expect(_testOnly.normalizeCaptureLevel("unknown")).toBe("redacted");
      expect(_testOnly.normalizeCaptureLevel(undefined)).toBe("redacted");
      expect(_testOnly.normalizePmVersion(" 2.0.0 ")).toBe("2.0.0");
      expect(_testOnly.normalizePmVersion("  ")).toBe("0.0.0");

      expect(
        _testOnly.sanitizeCommandArgs(
          ["--token", "secret", "--path=/tmp/private", "--title=visible", "admin@example.com"],
          "redacted",
        ),
      ).toEqual(["--token", "[redacted]", "--path=[redacted_path]", "--title=visible", "[redacted_email]"]);
      expect(_testOnly.hashTelemetryValue("install", null)).toMatch(/^[a-f0-9]{64}$/);
      expect(_testOnly.hashTelemetryValue("install", [1, { b: 2, a: 1 }])).toMatch(/^[a-f0-9]{64}$/);
      expect(_testOnly.normalizeForHash(Symbol.for("pm-test"))).toBe("Symbol(pm-test)");
      expect(
        _testOnly.hashTelemetryValue("install", {
          a: { b: { c: { d: { e: { f: { g: "deep" } } } } } },
        }),
      ).toMatch(/^[a-f0-9]{64}$/);

      const originalVitest = process.env.VITEST;
      const originalVitestWorker = process.env.VITEST_WORKER_ID;
      const originalNodeEnv = process.env.NODE_ENV;
      const originalCi = process.env.CI;
      const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
      const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
      try {
        process.env.PM_TELEMETRY_SOURCE_CONTEXT = "dogfood";
        expect(_testOnly.resolveTelemetrySourceContext({})).toEqual({
          source_context: "dogfood",
          source_context_source: "env_override",
        });

        delete process.env.PM_TELEMETRY_SOURCE_CONTEXT;
        delete process.env.VITEST;
        delete process.env.VITEST_WORKER_ID;
        delete process.env.NODE_ENV;
        process.env.CI = "true";
        expect(_testOnly.resolveTelemetrySourceContext({})).toEqual({
          source_context: "automation",
          source_context_source: "inferred",
        });

        delete process.env.CI;
        Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
        Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
        expect(_testOnly.resolveTelemetrySourceContext({ json: false, quiet: false })).toEqual({
          source_context: "user",
          source_context_source: "inferred",
        });
      } finally {
        if (originalVitest === undefined) {
          delete process.env.VITEST;
        } else {
          process.env.VITEST = originalVitest;
        }
        if (originalVitestWorker === undefined) {
          delete process.env.VITEST_WORKER_ID;
        } else {
          process.env.VITEST_WORKER_ID = originalVitestWorker;
        }
        if (originalNodeEnv === undefined) {
          delete process.env.NODE_ENV;
        } else {
          process.env.NODE_ENV = originalNodeEnv;
        }
        if (originalCi === undefined) {
          delete process.env.CI;
        } else {
          process.env.CI = originalCi;
        }
        if (originalTelemetrySourceContext === undefined) {
          delete process.env.PM_TELEMETRY_SOURCE_CONTEXT;
        } else {
          process.env.PM_TELEMETRY_SOURCE_CONTEXT = originalTelemetrySourceContext;
        }
        if (stdinDescriptor) {
          Object.defineProperty(process.stdin, "isTTY", stdinDescriptor);
        }
        if (stdoutDescriptor) {
          Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
        }
      }

      globalThis.fetch = vi.fn(async () => ({ ok: false, status: 503 })) as unknown as typeof fetch;
      await expect(
        _testOnly.exportLocalOtelSpan(
          {
            started_at: "not-a-date",
            started_at_ms: Date.now(),
            command: "/tmp/pm secret",
            command_taxonomy: "unknown",
            pm_version: "1.0.0",
            source_context: "test",
            source_context_source: "inferred",
            installation_id: "install",
            pm_root_hash: "pm-root",
            cwd_hash: "cwd",
            endpoint: "https://telemetry.example.test/events",
            retention_days: 1,
            global_pm_root: "/tmp/global",
            capture_level: "redacted",
            otel_traces_endpoint: "https://otel.example.test/v1/traces",
            otel_trace_id: "a".repeat(32),
            otel_span_id: "b".repeat(16),
          },
          { ok: true, exit_code: 2.7 },
          "not-a-date",
          7.9,
        ),
      ).rejects.toThrow("local_otel_export_http_503");
      const body = JSON.parse(String((globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[1]?.body));
      const span = body.resourceSpans[0].scopeSpans[0].spans[0];
      expect(span.status).toEqual({ code: 1, message: "" });
      expect(span.name).toBe("pm.command.[redacted_path] secret");
    });
  });

  it("covers telemetry queue prune, defer, success, and lock branches", async () => {
    await withTempGlobalRoot(async (globalRoot) => {
      expect(_testOnly.isRetryableQueueRewriteError({ code: "EACCES" })).toBe(true);
      expect(_testOnly.isRetryableQueueRewriteError(null)).toBe(false);
      expect(_testOnly.isRetryableQueueRewriteError({ code: "ENOENT" })).toBe(false);
      expect(_testOnly.errorCode({ code: "EEXIST" })).toBe("EEXIST");
      expect(_testOnly.errorCode({ code: 1 })).toBeUndefined();

      const lockPath = path.join(globalRoot, "runtime", "telemetry", "manual.lock");
      expect(_testOnly.createDirectoryLock(lockPath)).toBe(true);
      expect(_testOnly.createDirectoryLock(lockPath)).toBe(false);
      expect(_testOnly.isFreshDirectoryLock(lockPath, DAY_MS)).toBe(true);
      _testOnly.removeDirectoryLockBestEffort(lockPath);
      expect(_testOnly.isFreshDirectoryLock(lockPath, DAY_MS)).toBe(false);

      const heldFlushLock = _testOnly.flushLockPath(globalRoot);
      expect(await _testOnly.acquireTelemetryFlushLock(globalRoot)).toBe(true);
      expect(await _testOnly.acquireTelemetryFlushLock(globalRoot)).toBe(false);
      await fs.rm(heldFlushLock, { recursive: true, force: true });
      expect(await _testOnly.acquireTelemetryFlushLock(globalRoot)).toBe(true);
      const stale = new Date(Date.now() - 2 * DAY_MS);
      await fs.utimes(heldFlushLock, stale, stale);
      expect(await _testOnly.acquireTelemetryFlushLock(globalRoot)).toBe(true);
      await fs.rm(heldFlushLock, { recursive: true, force: true });

      const parentFile = path.join(globalRoot, "runtime", "telemetry", "parent-file");
      await fs.writeFile(parentFile, "not a directory", "utf8");
      expect(_testOnly.createDirectoryLock(path.join(parentFile, "child.lock"))).toBe(false);

      const settings = await readSettings(globalRoot);
      settings.telemetry.endpoint = "https://telemetry.example.test/events";
      settings.telemetry.retention_days = 1;
      await writeSettings(globalRoot, settings, "test:queue_states");

      const oldEntry = {
        client_schema_version: 1,
        attempts: 0,
        event: {
          schema_version: 1,
          event_id: "88888888-8888-4888-8888-888888888888",
          event_type: "command_start" as const,
          occurred_at: new Date(Date.now() - 3 * DAY_MS).toISOString(),
          installation_id: "22222222-2222-4222-8222-222222222222",
          session_id: "33333333-3333-4333-8333-333333333333",
          command: "old",
          payload: {},
        },
      };
      await _testOnly.rewriteQueue(globalRoot, [oldEntry]);
      await flushTelemetryQueueNow(globalRoot);
      await expect(fs.readFile(telemetryQueuePath(globalRoot), "utf8")).resolves.toBe("");
      await expect(_testOnly.readRuntimeState(globalRoot)).resolves.toMatchObject({ queue_entries: 0 });

      const futureEntry = {
        ...oldEntry,
        event: {
          ...oldEntry.event,
          event_id: "99999999-9999-4999-8999-999999999999",
          occurred_at: new Date().toISOString(),
          command: "future",
        },
        next_attempt_after: new Date(Date.now() + DAY_MS).toISOString(),
      };
      await _testOnly.rewriteQueue(globalRoot, [futureEntry]);
      await expect(_testOnly.readCurrentQueueEntries(globalRoot)).resolves.toHaveLength(1);
      await flushTelemetryQueueNow(globalRoot);
      await expect(_testOnly.readRuntimeState(globalRoot)).resolves.toMatchObject({ queue_entries: 1 });

      const dueEntry = {
        ...futureEntry,
        event: {
          ...futureEntry.event,
          event_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          command: "due",
        },
        next_attempt_after: new Date(Date.now() - 1000).toISOString(),
      };
      await _testOnly.rewriteQueue(globalRoot, [dueEntry]);
      globalThis.fetch = vi.fn(async () => ({ ok: true, status: 202 })) as unknown as typeof fetch;
      await flushTelemetryQueueNow(globalRoot);
      await expect(fs.readFile(telemetryQueuePath(globalRoot), "utf8")).resolves.toBe("");
      const successState = await _testOnly.readRuntimeState(globalRoot);
      expect(successState).toMatchObject({ queue_entries: 0 });
      expect(successState).not.toHaveProperty("last_failed_flush_error");

      await fs.writeFile(telemetryQueuePath(globalRoot), "not-json\n{}\n", "utf8");
      await flushTelemetryQueueNow(globalRoot);
      await expect(_testOnly.readRuntimeState(globalRoot)).resolves.toMatchObject({ queue_entries: 0 });

      const futureWithOldPruned = {
        ...futureEntry,
        event: {
          ...futureEntry.event,
          event_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          command: "future-with-pruned",
        },
        next_attempt_after: new Date(Date.now() + DAY_MS).toISOString(),
      };
      await _testOnly.rewriteQueue(globalRoot, [oldEntry, futureWithOldPruned]);
      await flushTelemetryQueueNow(globalRoot);
      const retainedRaw = await fs.readFile(telemetryQueuePath(globalRoot), "utf8");
      expect(retainedRaw).toContain(futureWithOldPruned.event.event_id);
      expect(retainedRaw).not.toContain(oldEntry.event.event_id);

      const hugeEntry = {
        ...futureEntry,
        event: {
          ...futureEntry.event,
          event_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          command: "huge",
          payload: { result_summary: "x".repeat(70_000) },
        },
      };
      await _testOnly.enqueueTelemetryEvent(globalRoot, hugeEntry.event);
      const queuedHuge = JSON.parse((await fs.readFile(telemetryQueuePath(globalRoot), "utf8")).trim().split("\n").at(-1) ?? "{}");
      expect(queuedHuge.event.payload.result_summary).toMatchObject({
        truncated: true,
        reason: "payload_size_exceeded",
      });

      await _testOnly.rewriteQueue(globalRoot, [futureWithOldPruned]);
      await _testOnly.removeFlushedEntriesFromCurrentQueue(globalRoot, new Set([futureWithOldPruned.event.event_id]), 1);
      await expect(fs.readFile(telemetryQueuePath(globalRoot), "utf8")).resolves.toBe("");
    });
  });
});
