import { describe, expect, it } from "vitest";
import {
  SUPPRESS_HOST_OUTPUT_MARKER,
  isHostOutputSuppressed,
  suppressHostOutput,
  type SuppressedHostOutput,
} from "../../../src/sdk/index.js";
import { formatOutput } from "../../../src/core/output/output.js";

describe("SDK host-output control", () => {
  it("creates typed suppression envelopes with optional structured results", () => {
    expect(suppressHostOutput()).toEqual({ __pm_suppress_host_output: true });
    expect(suppressHostOutput({ emitted: 3 })).toEqual({
      __pm_suppress_host_output: true,
      result: { emitted: 3 },
    });
    expect(SUPPRESS_HOST_OUTPUT_MARKER).toBe("__pm_suppress_host_output");
  });

  it("recognizes only valid cross-package suppression envelopes", () => {
    const suppressed: SuppressedHostOutput = suppressHostOutput();

    expect(isHostOutputSuppressed(suppressed)).toBe(true);
    expect(isHostOutputSuppressed({ __pm_suppress_host_output: false })).toBe(false);
    expect(isHostOutputSuppressed([])).toBe(false);
    expect(isHostOutputSuppressed(null)).toBe(false);
    expect(isHostOutputSuppressed("suppressed")).toBe(false);
  });

  it("prevents host rendering while retaining the structured command result", () => {
    expect(formatOutput(suppressHostOutput({ emitted: 3 }), { json: true })).toBe("");
  });
});
