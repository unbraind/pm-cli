import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sentryNodeMock = vi.hoisted(() => ({
  init: vi.fn(),
  extraErrorDataIntegration: vi.fn((options: unknown) => ({ name: "extraErrorDataIntegration", options })),
  captureConsoleIntegration: vi.fn((options: unknown) => ({ name: "captureConsoleIntegration", options })),
}));

vi.mock("@sentry/node", () => sentryNodeMock);

// Partially mock instrument.js so the runtime span/capture helpers can be
// driven against a fake Sentry client; _testOnly and everything else stay real.
vi.mock("../../src/core/sentry/instrument.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/core/sentry/instrument.js")>();
  return { ...actual, getSentry: vi.fn(actual.getSentry) };
});

import {
  sentryCaptureCliError,
  sentryFinishCommandSpan,
  sentryFlush,
  sentryLogCliUsageError,
  sentrySetCommandContext,
  sentryStartCommandSpan,
  shouldCaptureCliError,
} from "../../src/core/sentry/helpers.js";
import { _testOnly, ensureSentryInit, getSentry } from "../../src/core/sentry/instrument.js";
import { PmCliError } from "../../src/core/shared/errors.js";
import { EXIT_CODE } from "../../src/core/shared/constants.js";

const {
  isExpectedCliErrorEvent,
  isKnownNoisyConsoleEvent,
  isPmCliErrorBreadcrumb,
  isKnownNoisyConsoleBreadcrumb,
  scrubString,
  scrubEventData,
  resetSentryStateForTests,
} = _testOnly;
const PRIVATE_TEST_IP = ["192", "168", "42", "17"].join(".");
const TEST_LOCAL_PATH = ["/home", "example", "project"].join("/");

describe("sentry helpers", () => {
  it("does not capture expected CLI errors as Sentry exceptions", () => {
    expect(shouldCaptureCliError(new PmCliError("No update flags provided", EXIT_CODE.USAGE))).toBe(false);
    expect(shouldCaptureCliError(new PmCliError("Item pm-missing not found", EXIT_CODE.NOT_FOUND))).toBe(false);
    expect(shouldCaptureCliError(new PmCliError("Item is locked", EXIT_CODE.CONFLICT))).toBe(false);
  });

  it("does not capture extension usage errors with CLI exit codes as Sentry exceptions", () => {
    const usageError = Object.assign(new Error("Calendar accepts at most one positional view"), {
      exitCode: EXIT_CODE.USAGE,
    });
    const notFoundError = Object.assign(new Error("Extension command unavailable"), {
      exitCode: EXIT_CODE.NOT_FOUND,
    });

    expect(shouldCaptureCliError(usageError)).toBe(false);
    expect(shouldCaptureCliError(notFoundError)).toBe(false);
  });

  it("captures unexpected errors for Sentry triage", () => {
    expect(shouldCaptureCliError(new Error("unexpected crash"))).toBe(true);
    expect(shouldCaptureCliError("unexpected non-error throw")).toBe(true);
    expect(
      shouldCaptureCliError(
        Object.assign(new Error("dependency failed"), {
          exitCode: EXIT_CODE.DEPENDENCY_FAILED,
        }),
      ),
    ).toBe(true);
  });
});

describe("isExpectedCliErrorEvent", () => {
  it("detects PmCliError via exception type", () => {
    expect(isExpectedCliErrorEvent({
      exception: { values: [{ type: "PmCliError", value: "Item not found" }] },
    })).toBe(true);
  });

  it("detects PmCliError via exception value containing class name", () => {
    expect(isExpectedCliErrorEvent({
      exception: { values: [{ type: "Error", value: "PmCliError: Invalid --limit value" }] },
    })).toBe(true);
  });

  it("detects PmCliError from console-captured message events", () => {
    expect(isExpectedCliErrorEvent({
      logger: "console",
      message: "PmCliError: Item not found",
    })).toBe(true);
  });

  it("does not filter genuine unexpected errors", () => {
    expect(isExpectedCliErrorEvent({
      exception: { values: [{ type: "TypeError", value: "Cannot read property 'x' of undefined" }] },
    })).toBe(false);
  });

  it("does not filter unexpected errors that only mention PmCliError text", () => {
    expect(isExpectedCliErrorEvent({
      exception: { values: [{ type: "TypeError", value: "TypeError while formatting PmCliError context" }] },
    })).toBe(false);
  });

  it("does not filter non-console logger messages", () => {
    expect(isExpectedCliErrorEvent({
      logger: "http",
      message: "PmCliError: some text",
    })).toBe(false);
  });

  it("passes through events without exception or message", () => {
    expect(isExpectedCliErrorEvent({})).toBe(false);
  });
});

describe("isPmCliErrorBreadcrumb", () => {
  it("identifies console breadcrumbs mentioning PmCliError", () => {
    expect(isPmCliErrorBreadcrumb({
      category: "console",
      message: "PmCliError: Item pm-abc not found",
    })).toBe(true);
  });

  it("ignores non-console breadcrumbs even with PmCliError text", () => {
    expect(isPmCliErrorBreadcrumb({
      category: "http",
      message: "PmCliError: something",
    })).toBe(false);
  });

  it("ignores console breadcrumbs without PmCliError text", () => {
    expect(isPmCliErrorBreadcrumb({
      category: "console",
      message: "Some other warning",
    })).toBe(false);
  });

  it("ignores console breadcrumbs that only mention PmCliError text", () => {
    expect(isPmCliErrorBreadcrumb({
      category: "console",
      message: "TypeError while formatting PmCliError context",
    })).toBe(false);
  });

  it("handles missing message", () => {
    expect(isPmCliErrorBreadcrumb({ category: "console" })).toBe(false);
  });
});

describe("noisy console starter filtering", () => {
  it("filters known starter extension console noise events", () => {
    expect(
      isKnownNoisyConsoleEvent({
        logger: "console",
        message: "[starter-extension] Commands: pm starter greet, pm starter summary",
      }),
    ).toBe(true);
  });

  it("keeps unrelated console errors for triage", () => {
    expect(
      isKnownNoisyConsoleEvent({
        logger: "console",
        message: "TypeError: Cannot read properties of undefined",
      }),
    ).toBe(false);
  });

  it("filters known starter extension console noise from exception values", () => {
    expect(
      isKnownNoisyConsoleEvent({
        logger: "console",
        exception: { values: [{ value: "[starter-extension] all 8 capabilities registered." }] },
      }),
    ).toBe(true);
  });

  it("keeps empty console messages and non-string exception values", () => {
    expect(isKnownNoisyConsoleEvent({ logger: "console", message: "   " })).toBe(false);
    expect(
      isKnownNoisyConsoleEvent({
        logger: "console",
        exception: { values: [{ value: undefined }] },
      }),
    ).toBe(false);
  });

  it("filters known noisy console breadcrumbs", () => {
    expect(
      isKnownNoisyConsoleBreadcrumb({
        category: "console",
        message: "[pm-ext-ts-starter] Activating…",
      }),
    ).toBe(true);
  });
});

describe("scrubString", () => {
  it("scrubs credentials, email addresses, private IPs, and absolute paths", () => {
    const scrubbed = scrubString(
      `token=secret user@example.com ${PRIVATE_TEST_IP} ${TEST_LOCAL_PATH} bearer abc.def`,
    );

    expect(scrubbed).toContain("token=[scrubbed]");
    expect(scrubbed).toContain("[scrubbed_email]");
    expect(scrubbed).toContain("[scrubbed_ip]");
    expect(scrubbed).toContain("[scrubbed_path]");
    expect(scrubbed).toContain("bearer [scrubbed]");
    expect(scrubbed).not.toContain("secret");
    expect(scrubbed).not.toContain("user@example.com");
    expect(scrubbed).not.toContain(PRIVATE_TEST_IP);
    expect(scrubbed).not.toContain(TEST_LOCAL_PATH);
  });

  it("scrubs file URLs, Windows paths, and path-hinted fields", () => {
    expect(scrubString(`open file://${TEST_LOCAL_PATH}/item.json`)).toBe("open [scrubbed_path]");
    expect(scrubString(String.raw`failed at C:\Users\steve\secret.txt`)).toBe("failed at [scrubbed_path]");
    expect(scrubString(String.raw`\\server\share\secret.txt`, "filename")).toBe("[scrubbed_path]");
    expect(scrubString(`${TEST_LOCAL_PATH}/item.json`, "filename")).toBe("[scrubbed_path]");
    expect(scrubString(`${TEST_LOCAL_PATH}/token=secret`)).toBe("[scrubbed_path]");
    expect(scrubString(`prefix${TEST_LOCAL_PATH}`)).toBe("[scrubbed_path]");
    expect(scrubString("   ", "filename")).toBe("   ");
    expect(scrubString("relative/path.txt")).toBe("relative/path.txt");
  });
});

describe("scrubEventData", () => {
  it("scrubs nested stack frame path-bearing fields and frame context strings", () => {
    const scrubbed = scrubEventData({
      exception: {
        values: [
          {
            stacktrace: {
              frames: [
                {
                  filename: `${TEST_LOCAL_PATH}/dist/index.js`,
                  absPath: `${TEST_LOCAL_PATH}/dist/index.js`,
                  module: `file://${TEST_LOCAL_PATH}/dist/index.js`,
                  context_line: `Error from ${TEST_LOCAL_PATH}/src/index.ts`,
                  pre_context: [`at ${TEST_LOCAL_PATH}/src/index.ts:10:2`],
                  vars: {
                    cwd: TEST_LOCAL_PATH,
                    nested: {
                      source_path: `${TEST_LOCAL_PATH}/src/index.ts`,
                    },
                  },
                },
              ],
            },
          },
        ],
      },
    });
    const serialized = JSON.stringify(scrubbed);
    expect(serialized).toContain("[scrubbed_path]");
    expect(serialized).not.toContain(TEST_LOCAL_PATH);
  });

  it("recursively scrubs sensitive-key values in nested objects and arrays", () => {
    const scrubbed = scrubEventData({
      outer: {
        details: [
          42,
          {
            api_key: "abc123",
            token_value: "secret-token",
          },
        ],
      },
      count: 1,
      enabled: true,
    });
    expect(scrubbed).toEqual({
      outer: {
        details: [
          42,
          {
            api_key: "[scrubbed]",
            token_value: "[scrubbed]",
          },
        ],
      },
      count: 1,
      enabled: true,
    });
  });
});

describe("ensureSentryInit", () => {
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
    sentryNodeMock.init.mockClear();
    sentryNodeMock.extraErrorDataIntegration.mockClear();
    sentryNodeMock.captureConsoleIntegration.mockClear();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    resetSentryStateForTests();
  });

  it("returns undefined and does not import Sentry when disabled", async () => {
    process.env.PM_SENTRY_DISABLED = " yes ";

    await expect(ensureSentryInit()).resolves.toBeUndefined();
    await expect(ensureSentryInit()).resolves.toBeUndefined();

    expect(sentryNodeMock.init).not.toHaveBeenCalled();
  });

  it("initializes Sentry once with sanitized beforeSend and beforeBreadcrumb hooks", async () => {
    process.env.SENTRY_DSN = " https://example.invalid/custom ";
    process.env.SENTRY_ENVIRONMENT = " staging ";

    await expect(ensureSentryInit()).resolves.toMatchObject({
      init: sentryNodeMock.init,
    });
    await ensureSentryInit();
    expect(getSentry()).toMatchObject({ init: sentryNodeMock.init });

    expect(sentryNodeMock.init).toHaveBeenCalledTimes(1);
    expect(sentryNodeMock.extraErrorDataIntegration).toHaveBeenCalledWith({ depth: 4 });
    expect(sentryNodeMock.captureConsoleIntegration).toHaveBeenCalledWith({ levels: ["warn", "error"] });

    const options = sentryNodeMock.init.mock.calls[0]?.[0] as {
      dsn: string;
      release: string;
      environment: string;
      serverName: unknown;
      sendDefaultPii: boolean;
      initialScope: { tags: Record<string, string> };
      beforeSend: (event: Record<string, any>) => Record<string, any> | null;
      beforeSendTransaction: (event: Record<string, any>) => Record<string, any>;
      beforeBreadcrumb: (breadcrumb: Record<string, any>) => Record<string, any> | null;
    };
    expect(options.dsn).toBe("https://example.invalid/custom");
    expect(options.release).toMatch(/^pm-cli@/);
    expect(options.environment).toBe("staging");
    expect(options.serverName).toBeUndefined();
    expect(options.sendDefaultPii).toBe(false);
    expect(options.initialScope.tags).toMatchObject({
      "cli.name": "pm-cli",
      "runtime.node": process.version,
      "runtime.platform": process.platform,
      "runtime.arch": process.arch,
    });

    expect(
      options.beforeSend({
        exception: { values: [{ type: "PmCliError", value: "PmCliError: missing item" }] },
      }),
    ).toBeNull();
    expect(
      options.beforeSend({
        logger: "console",
        message: "[starter-extension] activating",
      }),
    ).toBeNull();

    const event = options.beforeSend({
      message: `token=secret ${TEST_LOCAL_PATH}/src/index.ts`,
      transaction: `file://${TEST_LOCAL_PATH}/src/index.ts`,
      exception: {
        values: [
          {
            value: `bearer abc.def at ${TEST_LOCAL_PATH}/src/index.ts`,
            stacktrace: {
              frames: [
                {
                  filename: `${TEST_LOCAL_PATH}/src/index.ts`,
                  context_line: `token=secret at ${TEST_LOCAL_PATH}/src/index.ts`,
                  pre_context: [`${TEST_LOCAL_PATH}/src/a.ts`],
                  post_context: "not-an-array",
                  vars: { api_key: "abc123" },
                  data: { cwd: TEST_LOCAL_PATH },
                },
              ],
            },
          },
        ],
      },
      breadcrumbs: [
        {
          message: `visited ${TEST_LOCAL_PATH}`,
          data: { cwd: TEST_LOCAL_PATH },
        },
      ],
      extra: { token: "abc123" },
      contexts: { app: { source_path: `${TEST_LOCAL_PATH}/src/index.ts` } },
      request: { url: `file://${TEST_LOCAL_PATH}/src/index.ts`, cookies: "session=abc" },
      user: { email: "user@example.com" },
      tags: { dsn: "private" },
    });
    const serialized = JSON.stringify(event);
    expect(serialized).toContain("[scrubbed]");
    expect(serialized).toContain("[scrubbed_path]");
    expect(serialized).toContain("[scrubbed_email]");
    expect(serialized).not.toContain(TEST_LOCAL_PATH);
    expect(serialized).not.toContain("user@example.com");
    expect(serialized).not.toContain("secret");

    expect(options.beforeBreadcrumb({ category: "console", message: "PmCliError: bad flag" })).toBeNull();
    expect(options.beforeBreadcrumb({ category: "console", message: "[starter] preflight check for workspace" })).toBeNull();
    const breadcrumb = options.beforeBreadcrumb({
      category: "http",
      message: `loaded ${TEST_LOCAL_PATH}/src/index.ts`,
      data: { authorization: "bearer abc.def" },
    });
    expect(JSON.stringify(breadcrumb)).not.toContain(TEST_LOCAL_PATH);
    expect(JSON.stringify(breadcrumb)).not.toContain("abc.def");
  });

  it("sanitizes transactions and falls back to ci, test, and production environments", async () => {
    process.env.CI = "true";
    await ensureSentryInit();
    let options = sentryNodeMock.init.mock.calls[0]?.[0] as {
      environment: string;
      beforeSendTransaction: (event: Record<string, any>) => Record<string, any>;
    };
    expect(options.environment).toBe("ci");

    const transaction = options.beforeSendTransaction({
      breadcrumbs: [
        { category: "console", message: "PmCliError: bad flag" },
        { category: "console", message: "[starter-extension] activating" },
        { category: "http", message: `loaded ${TEST_LOCAL_PATH}`, data: { cwd: TEST_LOCAL_PATH } },
      ],
      contexts: {
        trace: { source_path: `${TEST_LOCAL_PATH}/src/index.ts` },
      },
    });
    expect(transaction.breadcrumbs).toHaveLength(1);
    expect(JSON.stringify(transaction)).not.toContain(TEST_LOCAL_PATH);

    resetSentryStateForTests();
    sentryNodeMock.init.mockClear();
    delete process.env.CI;
    process.env.NODE_ENV = "test";
    await ensureSentryInit();
    options = sentryNodeMock.init.mock.calls[0]?.[0] as { environment: string };
    expect(options.environment).toBe("test");

    resetSentryStateForTests();
    sentryNodeMock.init.mockClear();
    delete process.env.NODE_ENV;
    await ensureSentryInit();
    options = sentryNodeMock.init.mock.calls[0]?.[0] as { environment: string };
    expect(options.environment).toBe("production");
  });
});

interface FakeSpan {
  setAttribute: ReturnType<typeof vi.fn>;
  setStatus: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
}

function buildFakeSpan(): FakeSpan {
  return {
    setAttribute: vi.fn(),
    setStatus: vi.fn(),
    end: vi.fn(),
  };
}

function buildFakeSentry(span: FakeSpan, options?: { logger?: { warn: ReturnType<typeof vi.fn> } }) {
  return {
    setTag: vi.fn(),
    setContext: vi.fn(),
    addBreadcrumb: vi.fn(),
    startInactiveSpan: vi.fn(() => span),
    captureException: vi.fn(),
    captureMessage: vi.fn(),
    flush: vi.fn(async () => true),
    ...(options?.logger ? { logger: options.logger } : {}),
  };
}

describe("sentry command runtime helpers", () => {
  beforeEach(() => {
    vi.mocked(getSentry).mockReset();
    vi.mocked(getSentry).mockReturnValue(undefined as never);
    // Drain any active span left over from a previous test.
    sentryFinishCommandSpan(true);
  });

  it("is a no-op for every helper when Sentry is not initialized", async () => {
    sentrySetCommandContext("list", [], {});
    sentryStartCommandSpan("list");
    sentryFinishCommandSpan(true);
    sentryCaptureCliError(new Error("boom"));
    sentryLogCliUsageError({
      command: "list",
      error_code: "usage",
      error_category: "usage",
      exit_code: EXIT_CODE.USAGE,
      error_message: "bad flag",
    });
    await sentryFlush();
    expect(vi.mocked(getSentry)).toHaveBeenCalled();
  });

  it("tags command taxonomy, scrubs option-bearing args, and records a breadcrumb", () => {
    const span = buildFakeSpan();
    const sentry = buildFakeSentry(span);
    vi.mocked(getSentry).mockReturnValue(sentry as never);

    sentrySetCommandContext(
      "schema add-type",
      ["Asset", "--workflow=draft,open", "--json"],
      { json: true, workflow: "draft,open" },
      { source_context: "mcp", source_context_source: "env" },
    );

    expect(sentry.setTag).toHaveBeenCalledWith("pm.command", "schema add-type");
    expect(sentry.setTag).toHaveBeenCalledWith("pm.source_context", "mcp");
    const context = sentry.setContext.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(context.args).toEqual(["Asset", "--workflow", "--json"]);
    expect(context.option_keys).toEqual(["json", "workflow"]);
    expect(sentry.addBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({ category: "pm.command", message: "pm schema add-type" }),
    );
  });

  it("starts and finishes a command span with status, tags, and attributes", () => {
    const span = buildFakeSpan();
    const sentry = buildFakeSentry(span);
    vi.mocked(getSentry).mockReturnValue(sentry as never);

    sentryStartCommandSpan("update");
    expect(sentry.startInactiveSpan).toHaveBeenCalledWith(
      expect.objectContaining({ op: "pm.command", name: "pm update" }),
    );

    sentryFinishCommandSpan(false, "usage failure", {
      error_code: "usage",
      error_category: "usage",
      exit_code: EXIT_CODE.USAGE,
      command_resolution: "error_usage",
      resolution_stage: "parse",
    });

    expect(sentry.setTag).toHaveBeenCalledWith("pm.ok", "false");
    expect(sentry.setTag).toHaveBeenCalledWith("pm.exit_code", String(EXIT_CODE.USAGE));
    expect(sentry.setTag).toHaveBeenCalledWith("pm.error_code", "usage");
    expect(sentry.setTag).toHaveBeenCalledWith("pm.error_category", "usage");
    expect(sentry.setTag).toHaveBeenCalledWith("pm.command_resolution", "error_usage");
    expect(sentry.setTag).toHaveBeenCalledWith("pm.resolution_stage", "parse");
    expect(span.setAttribute).toHaveBeenCalledWith("pm.ok", "false");
    expect(span.setStatus).toHaveBeenCalledWith({ code: 2, message: "usage failure" });
    expect(span.end).toHaveBeenCalledTimes(1);

    // Second finish is a no-op because the active span was cleared.
    sentryFinishCommandSpan(true);
    expect(span.end).toHaveBeenCalledTimes(1);
  });

  it("omits optional command context and span metadata when absent and defaults the failure message", () => {
    const span = buildFakeSpan();
    const sentry = buildFakeSentry(span);
    vi.mocked(getSentry).mockReturnValue(sentry as never);

    // No source_context provided → the optional source-context tag is skipped.
    sentrySetCommandContext("list", ["list", "--json"], { json: true });
    expect(sentry.setTag).not.toHaveBeenCalledWith("pm.source_context", expect.anything());

    sentryStartCommandSpan("list");
    // ok=false with no error message and no optional metadata fields.
    sentryFinishCommandSpan(false);
    expect(sentry.setTag).not.toHaveBeenCalledWith("pm.error_code", expect.anything());
    expect(sentry.setTag).not.toHaveBeenCalledWith("pm.command_resolution", expect.anything());
    expect(sentry.setTag).not.toHaveBeenCalledWith("pm.resolution_stage", expect.anything());
    expect(span.setStatus).toHaveBeenCalledWith({ code: 2, message: "command_failed" });
    expect(span.end).toHaveBeenCalledTimes(1);
  });

  it("tolerates spans that do not expose setAttribute", () => {
    const minimalSpan = { setStatus: vi.fn(), end: vi.fn() };
    const sentry = buildFakeSentry(buildFakeSpan());
    sentry.startInactiveSpan = vi.fn(() => minimalSpan) as never;
    vi.mocked(getSentry).mockReturnValue(sentry as never);

    sentryStartCommandSpan("list");
    expect(() =>
      sentryFinishCommandSpan(true, undefined, { exit_code: EXIT_CODE.SUCCESS, error_code: "x" }),
    ).not.toThrow();
    expect(minimalSpan.end).toHaveBeenCalledTimes(1);
  });

  it("finishes an ok span even when Sentry becomes unavailable mid-command", () => {
    const span = buildFakeSpan();
    const sentry = buildFakeSentry(span);
    vi.mocked(getSentry).mockReturnValue(sentry as never);
    sentryStartCommandSpan("list");

    vi.mocked(getSentry).mockReturnValue(undefined as never);
    sentryFinishCommandSpan(true);

    expect(span.setStatus).toHaveBeenCalledWith({ code: 1 });
    expect(span.end).toHaveBeenCalledTimes(1);
  });

  it("captures unexpected errors with exit-code and context extras", () => {
    const span = buildFakeSpan();
    const sentry = buildFakeSentry(span);
    vi.mocked(getSentry).mockReturnValue(sentry as never);

    sentryCaptureCliError(new PmCliError("expected", EXIT_CODE.USAGE));
    expect(sentry.captureException).not.toHaveBeenCalled();

    const unexpected = Object.assign(new Error("boom"), {
      exitCode: 70,
      context: { detail: "x" },
    });
    sentryCaptureCliError(unexpected);
    expect(sentry.captureException).toHaveBeenCalledWith(unexpected, {
      extra: { exit_code: 70, error_context: { detail: "x" } },
    });

    // A plain Error without exitCode/context properties → empty extras object.
    const bareError = new Error("bare");
    sentryCaptureCliError(bareError);
    expect(sentry.captureException).toHaveBeenLastCalledWith(bareError, { extra: {} });

    sentryCaptureCliError("string failure");
    const wrapped = sentry.captureException.mock.calls.at(-1)?.[0] as Error;
    expect(wrapped).toBeInstanceOf(Error);
    expect(wrapped.message).toBe("string failure");
  });

  it("prefers the structured logger for usage errors and falls back to captureMessage", () => {
    const span = buildFakeSpan();
    const warn = vi.fn();
    vi.mocked(getSentry).mockReturnValue(buildFakeSentry(span, { logger: { warn } }) as never);
    sentryLogCliUsageError({
      command: "close",
      error_code: "close_reason_required",
      error_category: "usage",
      exit_code: EXIT_CODE.USAGE,
      error_message: "reason required",
      command_resolution: "error_usage",
      resolution_stage: "execute",
      source_context: "cli",
    });
    expect(warn).toHaveBeenCalledWith(
      "pm_cli_usage_error",
      expect.objectContaining({
        "pm.command": "close",
        "pm.error_code": "close_reason_required",
        "pm.command_resolution": "error_usage",
        "pm.source_context": "cli",
      }),
    );

    const fallbackSentry = buildFakeSentry(span);
    vi.mocked(getSentry).mockReturnValue(fallbackSentry as never);
    sentryLogCliUsageError({
      command: "close",
      error_code: "close_reason_required",
      error_category: "usage",
      exit_code: EXIT_CODE.USAGE,
      error_message: "reason required",
    });
    expect(fallbackSentry.captureMessage).toHaveBeenCalledWith(
      "pm_cli_usage_error:close_reason_required",
      expect.objectContaining({
        level: "warning",
        tags: expect.objectContaining({ "pm.source_context": "unknown" }),
      }),
    );
  });

  it("flushes the Sentry client and swallows flush failures", async () => {
    const span = buildFakeSpan();
    const sentry = buildFakeSentry(span);
    vi.mocked(getSentry).mockReturnValue(sentry as never);
    await sentryFlush(123);
    expect(sentry.flush).toHaveBeenCalledWith(123);

    sentry.flush.mockRejectedValueOnce(new Error("network down"));
    await expect(sentryFlush()).resolves.toBeUndefined();
  });
});
