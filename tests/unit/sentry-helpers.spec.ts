import { describe, expect, it } from "vitest";

import { shouldCaptureCliError } from "../../src/core/sentry/helpers.js";
import { _testOnly } from "../../src/core/sentry/instrument.js";
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
