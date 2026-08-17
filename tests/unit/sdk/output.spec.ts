import { describe, expect, it } from "vitest";
import {
  SUPPRESS_HOST_OUTPUT_MARKER,
  isHostOutputSuppressed,
  serializeNdjsonStream,
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
    expect(() => serializeNdjsonRows([new Date("2026-01-01T00:00:00.000Z")])).toThrow(
      "NDJSON row 0 must serialize to a non-null object",
    );
    expect(() => serializeNdjsonRows([{ toJSON: () => undefined }])).toThrow(
      "NDJSON row 0 must serialize to a non-null object",
    );
    expect(() => serializeNdjsonRows([{ toJSON: () => null }])).toThrow(
      "NDJSON row 0 must serialize to a non-null object",
    );
    expect(() => serializeNdjsonRows([{ toJSON: () => [] }])).toThrow(
      "NDJSON row 0 must serialize to a non-null object",
    );
  });

  it("frames resumable streams with one typed terminal trailer", () => {
    expect(
      serializeNdjsonStream([{ id: "pm-1" }, { id: "pm-2" }], {
        count: 2,
        has_more: true,
        next_cursor: "cursor-2",
        source: "derived_index",
      }),
    ).toBe(
      '{"id":"pm-1"}\n{"id":"pm-2"}\n{"count":2,"has_more":true,"next_cursor":"cursor-2","source":"derived_index","record_type":"pm.stream.trailer"}',
    );
    expect(
      serializeNdjsonStream([], {
        count: 0,
        has_more: false,
        next_cursor: null,
        source: "derived_index",
      }),
    ).toBe(
      '{"count":0,"has_more":false,"next_cursor":null,"source":"derived_index","record_type":"pm.stream.trailer"}',
    );
    expect(() =>
      serializeNdjsonStream(
        [{ record_type: "pm.stream.trailer", count: 99 }],
        {
          count: 1,
          has_more: false,
          next_cursor: null,
          source: "derived_index",
        },
      ),
    ).toThrow("NDJSON row 0 uses reserved record_type pm.stream.trailer");
    expect(() =>
      serializeNdjsonStream([{ id: "pm-1" }], {
        count: 2,
        has_more: false,
        next_cursor: null,
        source: "derived_index",
      }),
    ).toThrow("NDJSON trailer count 2 does not match 1 row");
    expect(() =>
      serializeNdjsonStream([], {
        count: 1,
        has_more: false,
        next_cursor: null,
        source: "derived_index",
      }),
    ).toThrow("NDJSON trailer count 1 does not match 0 rows");
  });
});
