import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Covers the residual branches in src/core/sentry/instrument.ts that the broad
// sentry-helpers suite leaves uncovered:
//  - isSentryDisabled via PM_TELEMETRY_DISABLED (line 7)
//  - the non-VITEST early-return path of isSentryDisabled (line 8 / 9)
//  - scrubStackFrame post_context entries that are NOT strings (line 111)
//  - resolveCliVersion falling back to "0.0.0" when version resolution is null (line 188)

const sentryNodeMock = vi.hoisted(() => ({
  init: vi.fn(),
  extraErrorDataIntegration: vi.fn((options: unknown) => ({ name: "extraErrorDataIntegration", options })),
  captureConsoleIntegration: vi.fn((options: unknown) => ({ name: "captureConsoleIntegration", options })),
}));

const rootMock = vi.hoisted(() => ({
  resolvePmCliVersion: vi.fn<() => string | null>(() => null),
}));

vi.mock("../../../../src/core/packages/root.js", () => rootMock);

import { _testOnly, ensureSentryInit } from "../../../../src/core/sentry/instrument.js";

const {
  scrubEventData,
  resetSentryStateForTests,
  setSentryLoaderForTests,
} = _testOnly;
let sentryLoaderMock: ReturnType<typeof vi.fn>;

describe("instrument residual branches", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.PM_SENTRY_DISABLED;
    delete process.env.PM_TELEMETRY_DISABLED;
    delete process.env.SENTRY_DSN;
    delete process.env.SENTRY_ENVIRONMENT;
    delete process.env.CI;
    delete process.env.VITEST;
    delete process.env.VITEST_WORKER_ID;
    delete process.env.NODE_ENV;
    resetSentryStateForTests();
    sentryLoaderMock = vi.fn(() => sentryNodeMock as never);
    setSentryLoaderForTests(sentryLoaderMock as never);
    sentryNodeMock.init.mockClear();
    rootMock.resolvePmCliVersion.mockReset();
    rootMock.resolvePmCliVersion.mockReturnValue(null);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    resetSentryStateForTests();
    setSentryLoaderForTests();
  });

  it("treats PM_TELEMETRY_DISABLED as an opt-out without importing Sentry", async () => {
    process.env.PM_TELEMETRY_DISABLED = "On";

    await expect(ensureSentryInit()).resolves.toBeUndefined();
    expect(sentryNodeMock.init).not.toHaveBeenCalled();
    expect(sentryLoaderMock).not.toHaveBeenCalled();
  });

  it("loads the installed Sentry CommonJS export through the production loader", () => {
    const loaded = _testOnly.defaultSentryLoader();
    expect(loaded).toMatchObject({ init: expect.any(Function), flush: expect.any(Function) });
  });

  it("treats a worker id alone (no VITEST flag) as disabled", async () => {
    // Covers the second operand of the VITEST short-circuit in isSentryDisabled:
    // VITEST is absent but VITEST_WORKER_ID is set.
    process.env.VITEST_WORKER_ID = "7";

    await expect(ensureSentryInit()).resolves.toBeUndefined();
    expect(sentryNodeMock.init).not.toHaveBeenCalled();
    expect(sentryLoaderMock).not.toHaveBeenCalled();
  });

  it("falls back to 0.0.0 release when the CLI version cannot be resolved", async () => {
    rootMock.resolvePmCliVersion.mockReturnValue(null);

    await ensureSentryInit();

    expect(rootMock.resolvePmCliVersion).toHaveBeenCalled();
    const options = sentryNodeMock.init.mock.calls[0]?.[0] as {
      release: string;
      beforeSend: (event: Record<string, unknown>) => Record<string, unknown> | null;
    };
    expect(options.release).toBe("pm-cli@0.0.0");

    // Drive scrubStackFrame with a post_context array that mixes strings and
    // non-strings so the non-string ternary branch (line 111) is exercised.
    const event = options.beforeSend({
      exception: {
        values: [
          {
            value: "boom",
            stacktrace: {
              frames: [
                {
                  filename: "/home/example/dist/index.js",
                  post_context: ["at /home/example/src/a.ts:1:2", 42, null],
                },
              ],
            },
          },
        ],
      },
    }) as { exception: { values: Array<{ stacktrace: { frames: Array<{ post_context: unknown[] }> } }> } };

    const frame = event.exception.values[0].stacktrace.frames[0];
    expect(frame.post_context).toEqual(["at [scrubbed_path]", 42, null]);
  });

  it("keeps scrubEventData stable for primitive leaf values", () => {
    expect(scrubEventData({ count: 3, flag: false, missing: null })).toEqual({
      count: 3,
      flag: false,
      missing: null,
    });
  });

  it("leaves message-less / data-less breadcrumbs and falsy contexts untouched in the transaction and breadcrumb hooks", async () => {
    await ensureSentryInit();
    const options = sentryNodeMock.init.mock.calls[0]?.[0] as {
      beforeSendTransaction: (event: Record<string, unknown>) => Record<string, unknown>;
      beforeBreadcrumb: (breadcrumb: Record<string, unknown>) => Record<string, unknown> | null;
    };

    // beforeSendTransaction: a surviving breadcrumb with neither message nor
    // data (skips both the message-scrub and data-scrub branches), plus a
    // contexts map carrying a falsy/non-object entry (skips the ctx scrub).
    const transaction = options.beforeSendTransaction({
      breadcrumbs: [{ category: "navigation" }],
      contexts: { empty: null },
    });
    expect(transaction.breadcrumbs).toEqual([{ category: "navigation" }]);
    expect(transaction.contexts).toEqual({ empty: null });

    // beforeBreadcrumb: a breadcrumb with no message and no data exercises the
    // else (fall-through) of both inner guards while still returning the crumb.
    const breadcrumb = options.beforeBreadcrumb({ category: "navigation" });
    expect(breadcrumb).toEqual({ category: "navigation" });

    // beforeSendTransaction / beforeBreadcrumb with NO breadcrumbs and NO
    // contexts skip those whole guarded blocks (the falsy-event branches).
    const emptyTransaction = options.beforeSendTransaction({ type: "transaction" });
    expect(emptyTransaction).toEqual({ type: "transaction" });
  });

  it("leaves message-less / data-less breadcrumbs and falsy contexts untouched in beforeSend", async () => {
    await ensureSentryInit();
    const options = sentryNodeMock.init.mock.calls[0]?.[0] as {
      beforeSend: (event: Record<string, unknown>) => Record<string, unknown> | null;
    };

    // beforeSend breadcrumb loop: a breadcrumb with neither message nor data
    // (skips both inner scrubs) plus an event.contexts map with a falsy entry
    // (skips the ctx scrub) and an exception value-less / frame-less shape.
    const event = options.beforeSend({
      breadcrumbs: [{ category: "navigation" }],
      contexts: { empty: null },
      exception: { values: [{ type: "Error", stacktrace: {} }] },
    });
    expect(event).toMatchObject({
      breadcrumbs: [{ category: "navigation" }],
      contexts: { empty: null },
    });

    // An event with no exception at all skips the exception-values loop (the
    // else of `if (event.exception?.values)`).
    const noException = options.beforeSend({ message: "plain message" });
    expect(noException).toMatchObject({ message: "plain message" });
  });

  it("short-circuits a repeated init call and returns the cached Sentry module", async () => {
    const first = await ensureSentryInit();
    sentryNodeMock.init.mockClear();
    // Second call hits the `_initDone` guard and returns the cached module
    // without re-importing or re-initializing.
    const second = await ensureSentryInit();
    expect(second).toBe(first);
    expect(sentryLoaderMock).toHaveBeenCalledTimes(1);
    expect(sentryNodeMock.init).not.toHaveBeenCalled();
  });
});
