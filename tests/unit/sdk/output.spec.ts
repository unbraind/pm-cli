import { describe, expect, it } from "vitest";
import {
  SUPPRESS_HOST_OUTPUT_MARKER,
  isHostOutputSuppressed,
  serializeNdjsonRows,
  suppressHostOutput,
  type SuppressedHostOutput,
} from "../../../src/sdk/index.js";
import { formatOutput } from "../../../src/core/output/output.js";

describe("SDK host-output control", () => {
  it("creates typed suppression envelopes with optional structured results", () => {
    expect(suppressHostOutput()).toEqual({
      __pm_suppress_host_output: SUPPRESS_HOST_OUTPUT_MARKER,
    });
    expect(suppressHostOutput({ emitted: 3 })).toEqual({
      __pm_suppress_host_output: SUPPRESS_HOST_OUTPUT_MARKER,
      result: { emitted: 3 },
    });
    expect(SUPPRESS_HOST_OUTPUT_MARKER).toBe(
      "@unbrained/pm-cli:suppress-host-output:v1",
    );
  });

  it("recognizes only valid cross-package suppression envelopes", () => {
    const suppressed: SuppressedHostOutput = suppressHostOutput();

    expect(isHostOutputSuppressed(suppressed)).toBe(true);
    expect(isHostOutputSuppressed({ __pm_suppress_host_output: true })).toBe(false);
    expect(isHostOutputSuppressed({ __pm_suppress_host_output: false })).toBe(false);
    expect(isHostOutputSuppressed([])).toBe(false);
    expect(isHostOutputSuppressed(null)).toBe(false);
    expect(isHostOutputSuppressed("suppressed")).toBe(false);
  });

  it("prevents host rendering while retaining the structured command result", () => {
    expect(formatOutput(suppressHostOutput({ emitted: 3 }), { json: true })).toBe("");
  });

  it("serializes object rows as NDJSON without a trailing summary or newline", () => {
    expect(serializeNdjsonRows([{ id: "pm-1" }, { id: "pm-2", ok: true }])).toBe(
      '{"id":"pm-1"}\n{"id":"pm-2","ok":true}',
    );
    expect(serializeNdjsonRows([])).toBe("");
    expect(() => serializeNdjsonRows([null])).toThrow(
      "NDJSON row 0 must be a non-null object",
    );
    expect(() => serializeNdjsonRows([[]])).toThrow(
      "NDJSON row 0 must be a non-null object",
    );
  });
});
