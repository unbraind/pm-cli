import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EXIT_CODE } from "../../src/core/shared/constants.js";
import { readSettings, writeSettings } from "../../src/core/store/settings.js";
import {
  emitTelemetryErrorEvent,
  finishTelemetryCommand,
  startTelemetryCommand,
  waitForPendingFlush,
} from "../../src/core/telemetry/runtime.js";

const originalGlobalPath = process.env.PM_GLOBAL_PATH;
const originalFetch = globalThis.fetch;
const originalOtelTracesEndpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
const originalOtelEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
const originalOtelServiceName = process.env.OTEL_SERVICE_NAME;
const originalTelemetryDisabled = process.env.PM_TELEMETRY_DISABLED;
const originalTelemetryOtelDisabled = process.env.PM_TELEMETRY_OTEL_DISABLED;
const originalTelemetryInlineFlush = process.env.PM_TELEMETRY_INLINE_FLUSH;
const originalTelemetrySourceContext = process.env.PM_TELEMETRY_SOURCE_CONTEXT;
const originalTelemetryIngestKey = process.env.PM_TELEMETRY_INGEST_KEY;
const DAY_MS = 24 * 60 * 60 * 1000;
const PRIVATE_TEST_IP = ["192", "168", "42", "17"].join(".");
const TEST_LOCAL_PATH = ["/home", "example", "private", "path"].join("/");

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
});
