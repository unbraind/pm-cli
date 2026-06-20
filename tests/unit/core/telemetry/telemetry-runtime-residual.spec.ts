import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withTempGlobalRoot } from "../../../helpers/temp.js";

const RUNTIME_MODULE = "../../../../src/core/telemetry/runtime.js";
const FS_UTILS_MODULE = "../../../../src/core/fs/fs-utils.js";
const NODE_FS_MODULE = "node:fs";

interface OtelSpanPayloadForTest {
  resourceSpans?: {
    scopeSpans?: {
      spans?: {
        status?: {
          message?: string;
        };
      }[];
    }[];
  }[];
}

async function importRuntime() {
  return import(RUNTIME_MODULE);
}

function makeErrorWithCode(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

describe("telemetry runtime residual coverage", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.doUnmock(FS_UTILS_MODULE);
    vi.doUnmock(NODE_FS_MODULE);
    await vi.resetModules();
  });

  it("covers helper fallback branches and sanitized outcomes", async () => {
    const runtime = await importRuntime();
    const previousNodeEnv = process.env.NODE_ENV;
    const previousDirect = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    const previousBase = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    try {
      delete process.env.NODE_ENV;
      expect(runtime._testOnly.shouldFlushInline()).toBe(true);

      expect(runtime._testOnly.isEmailLocalCharacter(undefined)).toBe(false);
      expect(runtime._testOnly.isEmailDomainCharacter(undefined)).toBe(false);
      expect(runtime._testOnly.looksLikeEmailToken("bad!local@example.com")).toBe(false);
      expect(runtime._testOnly.looksLikeEmailToken("local@example!.com")).toBe(false);
      expect(runtime._testOnly.sanitizeStringRedacted("/private/path")).toBe("[redacted_path]");
      expect(runtime._testOnly.sanitizeStringMax("/another/private/path")).toBe("[redacted_path]");

      delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "https://collector.example.com/custom/base/";
      expect(runtime._testOnly.resolveOtelTracesEndpoint()).toBe("https://collector.example.com/custom/base/v1/traces");

      const spanRequest = runtime._testOnly.buildOtelSpanRequest(
        {
          command: "pm list",
          started_at: new Date().toISOString(),
          pm_version: "1.0.0",
          source_context: "test",
          source_context_source: "explicit",
          installation_id: "install",
          pm_root_hash: "pmhash",
          cwd_hash: "cwdhash",
          otel_traces_endpoint: "https://collector.example.com/v1/traces",
          otel_trace_id: "0123456789abcdef0123456789abcdef",
          otel_span_id: "0123456789abcdef",
        } as never,
        { ok: false, error: undefined, exit_code: 2 },
        new Date().toISOString(),
        12,
      );
      expect(spanRequest).not.toBeNull();
      const spanPayload = spanRequest?.payload as OtelSpanPayloadForTest | undefined;
      const spanErrorMessage = spanPayload?.resourceSpans?.[0]?.scopeSpans?.[0]?.spans?.[0]?.status?.message;
      expect(spanErrorMessage).toBe("command_failed");

      const finishMinimal = runtime._testOnly.buildCommandFinishPayload({
        captureLevel: "minimal",
        pmVersion: "1.0.0",
        sourceContext: {
          source_context: "test",
          source_context_source: "explicit",
        },
        outcome: { ok: false },
        durationMs: 5,
        startedAt: new Date().toISOString(),
        command: "pm list",
        installationId: "install",
        commandTaxonomy: "list",
        exitCode: 1,
        commandResolution: "canonical",
        resolutionStage: "canonical",
      });
      expect(finishMinimal.error).toBeUndefined();

      expect(runtime._testOnly.isExpiredQueueEntry({ event: {}, attempts: 0 } as never, Date.now())).toBe(false);
      expect(
        runtime._testOnly.isExpiredPendingOtelSpan(
          { id: "span", endpoint: "https://collector", payload: {}, enqueued_at: "", attempts: 0 } as never,
          Date.now(),
        ),
      ).toBe(false);
      expect(
        runtime._testOnly.isExpiredPendingOtelSpan(
          { id: "span", endpoint: "https://collector", payload: {}, enqueued_at: "not-a-date", attempts: 0 } as never,
          Date.now(),
        ),
      ).toBe(false);
      await withTempGlobalRoot("pm-cli-telemetry-empty-queue-", async (emptyRoot) => {
        await expect(runtime._testOnly.readCurrentQueueEntries(emptyRoot)).resolves.toEqual([]);
      });
      await runtime._testOnly.sleep(0);
    } finally {
      if (previousNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = previousNodeEnv;
      }
      if (previousDirect === undefined) {
        delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
      } else {
        process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = previousDirect;
      }
      if (previousBase === undefined) {
        delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
      } else {
        process.env.OTEL_EXPORTER_OTLP_ENDPOINT = previousBase;
      }
    }
  });

  it("covers queue mutation and flush catch branches", async () => {
    await withTempGlobalRoot("pm-cli-telemetry-residual-", async (globalRoot) => {
      const runtimeDirectory = path.join(globalRoot, "runtime", "telemetry");
      const queueFile = path.join(runtimeDirectory, "events.jsonl");
      await fs.mkdir(runtimeDirectory, { recursive: true });
      const queueEntry = {
        event: {
          event_id: "11111111-1111-4111-8111-111111111111",
          occurred_at: new Date().toISOString(),
          command: "pm list",
        },
        attempts: 0,
      };
      await fs.writeFile(queueFile, `${JSON.stringify(queueEntry)}\n`, "utf8");

      const writeFileAtomicMock = vi
        .fn()
        .mockRejectedValueOnce("string-rewrite-failure")
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("object-rewrite-failure"))
        .mockResolvedValueOnce(undefined)
        .mockResolvedValue(undefined);

      await vi.resetModules();
      vi.doMock(FS_UTILS_MODULE, async () => {
        const actual = await vi.importActual<typeof import("../../../../src/core/fs/fs-utils.js")>(FS_UTILS_MODULE);
        return {
          ...actual,
          writeFileAtomic: writeFileAtomicMock,
        };
      });
      const runtime = await importRuntime();

      await runtime._testOnly.withQueueMutation(async () => undefined);

      globalThis.fetch = vi.fn(async () => ({ ok: true, status: 202 })) as unknown as typeof fetch;
      await runtime._testOnly.flushQueue(globalRoot, "https://collector.example.com/ingest", 1);
      await runtime._testOnly.flushQueue(globalRoot, "https://collector.example.com/ingest", 1);
      expect(writeFileAtomicMock).toHaveBeenCalled();

      globalThis.fetch = vi.fn(async () => {
        throw new Error("network down");
      }) as unknown as typeof fetch;
      await runtime._testOnly.flushQueue(globalRoot, "https://collector.example.com/ingest", 1);
      expect(writeFileAtomicMock.mock.calls.length).toBeGreaterThanOrEqual(3);
    });
  });

  it("covers createDirectoryLock fallback when parent creation fails", async () => {
    const mkdirSyncMock = vi
      .fn()
      .mockImplementationOnce(() => {
        throw makeErrorWithCode("ENOENT", "missing parent");
      })
      .mockImplementationOnce(() => {
        throw makeErrorWithCode("EPERM", "permission denied");
      });

    await vi.resetModules();
    vi.doMock(NODE_FS_MODULE, async () => {
      const actual = await vi.importActual<typeof import("node:fs")>(NODE_FS_MODULE);
      return {
        ...actual,
        mkdirSync: mkdirSyncMock,
      };
    });
    const runtime = await importRuntime();
    expect(runtime._testOnly.createDirectoryLock(path.join("/tmp", "telemetry-lock", "child", "lock"))).toBe(false);
  });
});
