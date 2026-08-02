import { describe, expect, it } from "vitest";
import { _testOnly } from "../../../../src/core/telemetry/runtime.js";

describe("history-redact telemetry disclosure safety", () => {
  it("redacts matcher and replacement values from argv and option payloads", () => {
    const literal = "telemetry-literal-canary-864";
    const regex = "telemetry-regex-canary-864";
    const replacement = "telemetry-replacement-canary-864";

    const sanitizedArgs = _testOnly.sanitizeCommandArgs([
      "history-redact",
      "pm-example",
      "--literal",
      literal,
      `--regex=${regex}`,
      "--replacement",
      replacement,
    ]);
    expect(sanitizedArgs).toEqual([
      "history-redact",
      "pm-example",
      "--literal",
      "[redacted]",
      "--regex=[redacted]",
      "--replacement",
      "[redacted]",
    ]);
    expect(
      _testOnly.sanitizeValue({
        literal: [literal],
        regex: [regex],
        replacement,
      }),
    ).toEqual({
      literal: "[redacted]",
      regex: "[redacted]",
      replacement: "[redacted]",
    });
    expect(
      _testOnly.sanitizeValue({
        literal_count: 1,
        regex_count: 1,
        total_count: 2,
        replacement_is_default: false,
      }),
    ).toEqual({
      literal_count: 1,
      regex_count: 1,
      total_count: 2,
      replacement_is_default: false,
    });
  });
});
