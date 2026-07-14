import { describe, expect, it } from "vitest";

import { shouldCaptureCliError } from "../../../../src/core/sentry/helpers.js";
import { EXIT_CODE } from "../../../../src/core/shared/constants.js";
import { PmCliError } from "../../../../src/core/shared/errors.js";

describe("Sentry CLI control-flow classification", () => {
  it("keeps typed pm and package command outcomes out of exception groups", () => {
    expect(
      shouldCaptureCliError(new PmCliError("expected", EXIT_CODE.USAGE)),
    ).toBe(false);

    const packageFailure = Object.assign(
      new Error("verify-release: 1 repo(s) failed"),
      { name: "CommandError", exitCode: 1 },
    );
    expect(shouldCaptureCliError(packageFailure)).toBe(false);

    const untypedPackageFailure = Object.assign(new Error("raw failure"), {
      name: "CommandError",
    });
    expect(shouldCaptureCliError(untypedPackageFailure)).toBe(true);
  });

  it("suppresses explicit user interrupts without hiding unrelated aborts", () => {
    for (const message of [
      "Aborted with Ctrl+C",
      "SIGINT received",
      "user-initiated cancellation",
    ]) {
      expect(
        shouldCaptureCliError(
          Object.assign(new Error(message), { name: "AbortError" }),
        ),
      ).toBe(false);
    }
    expect(
      shouldCaptureCliError(
        Object.assign(new Error("request timeout"), { name: "AbortError" }),
      ),
    ).toBe(true);
    expect(shouldCaptureCliError(new Error("Aborted with Ctrl+C"))).toBe(true);
  });

  it("preserves numeric exit-code policy for non-CommandError values", () => {
    expect(
      shouldCaptureCliError(
        Object.assign(new Error("usage"), { exitCode: EXIT_CODE.USAGE }),
      ),
    ).toBe(false);
    expect(
      shouldCaptureCliError(Object.assign(new Error("boom"), { exitCode: 1 })),
    ).toBe(true);
  });
});
