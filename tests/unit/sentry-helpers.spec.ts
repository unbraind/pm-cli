import { describe, expect, it } from "vitest";

import { shouldCaptureCliError } from "../../src/core/sentry/helpers.js";
import { _testOnly } from "../../src/core/sentry/instrument.js";
import { PmCliError } from "../../src/core/shared/errors.js";
import { EXIT_CODE } from "../../src/core/shared/constants.js";

const { isExpectedCliErrorEvent, isPmCliErrorBreadcrumb, scrubString } = _testOnly;
const PRIVATE_TEST_IP = ["192", "168", "42", "17"].join(".");
const TEST_LOCAL_PATH = ["/home", "example", "project"].join("/");

describe("sentry helpers", () => {
  it("does not capture expected CLI errors as Sentry exceptions", () => {
    expect(shouldCaptureCliError(new PmCliError("No update flags provided", EXIT_CODE.USAGE))).toBe(false);
    expect(shouldCaptureCliError(new PmCliError("Item pm-missing not found", EXIT_CODE.NOT_FOUND))).toBe(false);
    expect(shouldCaptureCliError(new PmCliError("Item is locked", EXIT_CODE.CONFLICT))).toBe(false);
  });

  it("captures unexpected errors for Sentry triage", () => {
    expect(shouldCaptureCliError(new Error("unexpected crash"))).toBe(true);
    expect(shouldCaptureCliError("unexpected non-error throw")).toBe(true);
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
