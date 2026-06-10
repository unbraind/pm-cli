import { beforeEach, describe, expect, it, vi } from "vitest";

// Partially mock instrument.js so the runtime span/capture helpers can be
// driven against a fake Sentry client; _testOnly and everything else stay real.
vi.mock("../../src/core/sentry/instrument.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/core/sentry/instrument.js")>();
  return { ...actual, getSentry: vi.fn(() => undefined) };
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
import { _testOnly, getSentry } from "../../src/core/sentry/instrument.js";
import { PmCliError } from "../../src/core/shared/errors.js";
import { EXIT_CODE } from "../../src/core/shared/constants.js";

const {
  isExpectedCliErrorEvent,
  isKnownNoisyConsoleEvent,
  isPmCliErrorBreadcrumb,
  isKnownNoisyConsoleBreadcrumb,
  scrubString,
  scrubEventData,
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
          {
            api_key: "abc123",
            token_value: "secret-token",
          },
        ],
      },
    });
    expect(scrubbed).toEqual({
      outer: {
        details: [
          {
            api_key: "[scrubbed]",
            token_value: "[scrubbed]",
          },
        ],
      },
    });
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

    sentryCaptureCliError("string failure");
    const wrapped = sentry.captureException.mock.calls[1]?.[0] as Error;
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
