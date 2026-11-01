import { describe, expect, it } from "vitest";
import {
  PM_CLI_ERROR_DETAILS_LIMITS,
  admitPmCliErrorDetails,
  isPmCliErrorDetails,
  omitPmCliErrorDetails,
  projectPmCliErrorContextDetails,
  projectPmCliErrorDetails,
} from "../../../../src/core/shared/error-details.js";

/** An array whose second slot is a hole rather than an undefined value. */
function holeyList(): number[] {
  const list = [1, 2, 3];
  delete list[1];
  return list;
}

/** Build a value nested `depth` objects below the root. */
function nested(depth: number): Record<string, unknown> {
  let value: Record<string, unknown> = { leaf: true };
  for (let level = 0; level < depth; level += 1) value = { level: value };
  return value;
}

describe("producer error diagnostics admission (GH-1631)", () => {
  it("admits nested plain JSON and returns a detached copy", () => {
    const source = {
      selection_report: {
        filters: { statuses: ["closed"], version: "2026.11.1" },
        stage_counts: [{ stage: "excluded_status", count: 1 }],
        include_empty: false,
        ratio: 0.5,
        note: null,
        emoji: "\u{1F600}",
      },
    };
    const admission = admitPmCliErrorDetails(source);
    expect(admission).toEqual({ ok: true, details: source, byte_length: Buffer.byteLength(JSON.stringify(source), "utf8") });
    if (!admission.ok) throw new Error("unreachable");
    source.selection_report.stage_counts[0]!.count = 99;
    expect((admission.details.selection_report as { stage_counts: Array<{ count: number }> }).stage_counts[0]!.count).toBe(1);
    expect(isPmCliErrorDetails(source)).toBe(true);
    expect(admitPmCliErrorDetails(Object.assign(Object.create(null) as object, { a: 1 }))).toMatchObject({ ok: true });
  });

  it.each([
    ["an array root", [1], "not_plain_object", "details"],
    ["a class instance root", new Date(0), "not_plain_object", "details"],
    ["null", null, "not_plain_object", "details"],
    ["a function value", { run: () => 1 }, "unsupported_value", "details.run"],
    ["an undefined value", { gone: undefined }, "unsupported_value", "details.gone"],
    ["a bigint value", { big: 1n }, "unsupported_value", "details.big"],
    ["a nested class instance", { at: new Date(0) }, "unsupported_value", "details.at"],
    ["an array hole", { list: holeyList() }, "unsupported_value", "details.list[1]"],
    ["a non-finite number", { ratio: Number.NaN }, "non_finite_number", "details.ratio"],
    ["a lone surrogate value", { text: "a\uD800b" }, "malformed_unicode", "details.text"],
    ["a lone surrogate key", { ["k\uDC00"]: 1 }, "malformed_unicode", 'details["k\\udc00"]'],
    ["a prototype key", JSON.parse('{"nested":{"__proto__":{"polluted":true}}}') as unknown, "reserved_key", "details.nested.__proto__"],
  ])("refuses %s with a stable reason and path", (_label, value, reason, path) => {
    expect(admitPmCliErrorDetails(value)).toEqual({
      ok: false,
      omission: { reason, path, byte_limit: PM_CLI_ERROR_DETAILS_LIMITS.max_bytes },
    });
    expect(isPmCliErrorDetails(value)).toBe(false);
  });

  it("bounds nesting depth, which also refuses cycles", () => {
    expect(admitPmCliErrorDetails(nested(PM_CLI_ERROR_DETAILS_LIMITS.max_depth))).toMatchObject({ ok: true });
    expect(admitPmCliErrorDetails(nested(PM_CLI_ERROR_DETAILS_LIMITS.max_depth + 1))).toMatchObject({
      ok: false,
      omission: { reason: "depth_limit" },
    });
    const cycle: Record<string, unknown> = { name: "loop" };
    cycle.self = cycle;
    expect(admitPmCliErrorDetails(cycle)).toMatchObject({ ok: false, omission: { reason: "depth_limit" } });
  });

  it("surfaces accessor faults from admission but never from rendering", () => {
    const hostile = Object.defineProperty({}, "boom", {
      enumerable: true,
      get() {
        throw new Error("getter fault");
      },
    });
    expect(() => admitPmCliErrorDetails(hostile)).toThrow("getter fault");
    expect(isPmCliErrorDetails(hostile)).toBe(false);
    expect(projectPmCliErrorDetails(hostile)).toEqual({
      details_omitted: { reason: "unsupported_value", path: "details", byte_limit: PM_CLI_ERROR_DETAILS_LIMITS.max_bytes },
    });
  });

  it("renders diagnostics whole within the byte ceiling and replaces larger ones with a receipt", () => {
    expect(projectPmCliErrorDetails(undefined)).toBeUndefined();
    const fits = { text: "x".repeat(PM_CLI_ERROR_DETAILS_LIMITS.max_bytes - 11) };
    expect(Buffer.byteLength(JSON.stringify(fits), "utf8")).toBe(PM_CLI_ERROR_DETAILS_LIMITS.max_bytes);
    expect(projectPmCliErrorDetails(fits)).toEqual({ details: fits });
    const over = { text: "x".repeat(PM_CLI_ERROR_DETAILS_LIMITS.max_bytes - 10) };
    expect(projectPmCliErrorDetails(over)).toEqual({
      details_omitted: {
        reason: "byte_limit",
        byte_length: PM_CLI_ERROR_DETAILS_LIMITS.max_bytes + 1,
        byte_limit: PM_CLI_ERROR_DETAILS_LIMITS.max_bytes,
      },
    });
    expect(projectPmCliErrorDetails({ bad: Number.POSITIVE_INFINITY })).toEqual({
      details_omitted: { reason: "non_finite_number", path: "details.bad", byte_limit: PM_CLI_ERROR_DETAILS_LIMITS.max_bytes },
    });
  });

  it("bounds a forwarded context and strips diagnostics for crash reporting", () => {
    const context = { code: "probe", details: { report: { excluded: 1 } } };
    expect(projectPmCliErrorContextDetails(context)).toEqual(context);
    expect(projectPmCliErrorContextDetails({ code: "probe", details: [1] })).toEqual({
      code: "probe",
      details_omitted: { reason: "not_plain_object", path: "details", byte_limit: PM_CLI_ERROR_DETAILS_LIMITS.max_bytes },
    });
    const withoutDetails = { code: "probe" };
    expect(projectPmCliErrorContextDetails(withoutDetails)).toBe(withoutDetails);
    for (const passthrough of [undefined, null, "text", [1]]) {
      expect(projectPmCliErrorContextDetails(passthrough)).toBe(passthrough);
      expect(omitPmCliErrorDetails(passthrough)).toBe(passthrough);
    }
    expect(omitPmCliErrorDetails(context)).toEqual({ code: "probe" });
    expect(context.details).toEqual({ report: { excluded: 1 } });
    expect(omitPmCliErrorDetails(withoutDetails)).toBe(withoutDetails);
  });
});
