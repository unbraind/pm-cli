import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

import { _testOnly } from "../../../../src/core/telemetry/runtime.js";

const TELEMETRY_TIMEOUT_ENV = "PM_TELEMETRY_HTTP_TIMEOUT_MS";
const originalFetch = globalThis.fetch;

describe("telemetry HTTP timeout resolution", () => {
  const originalTimeout = process.env[TELEMETRY_TIMEOUT_ENV];

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
    if (originalTimeout === undefined) {
      delete process.env[TELEMETRY_TIMEOUT_ENV];
      return;
    }
    process.env[TELEMETRY_TIMEOUT_ENV] = originalTimeout;
  });

  it("uses the cold-connect-safe default when the override is absent or invalid", () => {
    delete process.env[TELEMETRY_TIMEOUT_ENV];
    expect(_testOnly.resolveTelemetryHttpTimeoutMs()).toBe(20_000);

    process.env[TELEMETRY_TIMEOUT_ENV] = " ";
    expect(_testOnly.resolveTelemetryHttpTimeoutMs()).toBe(20_000);

    process.env[TELEMETRY_TIMEOUT_ENV] = "not-a-timeout";
    expect(_testOnly.resolveTelemetryHttpTimeoutMs()).toBe(20_000);
  });

  it("normalizes finite overrides within the worker lock safety bounds", () => {
    process.env[TELEMETRY_TIMEOUT_ENV] = "12500.9";
    expect(_testOnly.resolveTelemetryHttpTimeoutMs()).toBe(12_500);

    process.env[TELEMETRY_TIMEOUT_ENV] = "250";
    expect(_testOnly.resolveTelemetryHttpTimeoutMs()).toBe(1_000);

    process.env[TELEMETRY_TIMEOUT_ENV] = "90000";
    expect(_testOnly.resolveTelemetryHttpTimeoutMs()).toBe(25_000);
  });

  it("rejects unsupported transport protocols before network I/O", async () => {
    await expect(
      _testOnly.postTelemetryJson(
        "ftp://telemetry.invalid/events",
        { "content-type": "application/json" },
        "{}",
      ),
    ).rejects.toThrow("telemetry_http_protocol_unsupported_ftp:");
  });

  it("enforces the deadline when a replaced fetch ignores its abort signal", async () => {
    vi.useFakeTimers();
    process.env[TELEMETRY_TIMEOUT_ENV] = "1000";
    let requestSignal: AbortSignal | null | undefined;
    globalThis.fetch = (_input, init) => {
      requestSignal = init?.signal;
      return new Promise<Response>(() => {});
    };

    const request = _testOnly.postTelemetryJson(
      "https://telemetry.invalid/events",
      { "content-type": "application/json" },
      "{}",
    );
    const rejection = expect(request).rejects.toThrow(
      "telemetry_http_timeout",
    );
    await vi.advanceTimersByTimeAsync(1_000);

    await rejection;
    expect(requestSignal?.aborted).toBe(true);
  });

  it("posts a complete JSON body and returns the response status", async () => {
    let receivedBody = "";
    let receivedLength = "";
    const server = createServer((request, response) => {
      receivedLength = String(request.headers["content-length"] ?? "");
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        receivedBody += chunk;
      });
      request.on("end", () => {
        response.writeHead(202);
        response.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
      server.close();
      throw new Error("Expected a TCP test server address");
    }

    try {
      await expect(
        _testOnly.postTelemetryJson(
          `http://127.0.0.1:${address.port}/events`,
          { "content-type": "application/json" },
          '{"event":"ok"}',
        ),
      ).resolves.toBe(202);
      expect(receivedBody).toBe('{"event":"ok"}');
      expect(receivedLength).toBe("14");
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
