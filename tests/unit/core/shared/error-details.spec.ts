import { describe, expect, it } from "vitest";
import {
  PM_CLI_ERROR_DETAILS_LIMITS,
  admitPmCliErrorDetails,
  isPmCliErrorDetails,
  omitEmbeddedPmCliErrorDetails,
  omitPmCliErrorDetails,
  projectPmCliErrorContextDetails,
  projectPmCliErrorContextDetailsSlot,
  projectPmCliErrorDetails,
  snapshotPmCliErrorContext,
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

  it("refuses accessors without invoking them, and proxy faults as unsupported values", () => {
    let calls = 0;
    const hostile = Object.defineProperty({}, "boom", {
      enumerable: true,
      get() {
        calls += 1;
        throw new Error("getter fault");
      },
    });
    const receipt = { reason: "unsupported_value", path: "details.boom", byte_limit: PM_CLI_ERROR_DETAILS_LIMITS.max_bytes };
    expect(admitPmCliErrorDetails(hostile)).toEqual({ ok: false, omission: receipt });
    expect(isPmCliErrorDetails(hostile)).toBe(false);
    expect(projectPmCliErrorDetails(hostile)).toEqual({ details_omitted: receipt });
    expect(calls).toBe(0);
    const rootTrap = new Proxy({}, { getPrototypeOf: () => { throw new Error("root trap fault"); } });
    expect(isPmCliErrorDetails(rootTrap)).toBe(false);
    expect(projectPmCliErrorDetails(rootTrap)).toEqual({
      details_omitted: { reason: "unsupported_value", path: "details", byte_limit: PM_CLI_ERROR_DETAILS_LIMITS.max_bytes },
    });
    const trapped = new Proxy({}, { ownKeys: () => { throw new Error("trap fault"); } });
    expect(projectPmCliErrorDetails(trapped)).toEqual({
      details_omitted: { reason: "unsupported_value", path: "details", byte_limit: PM_CLI_ERROR_DETAILS_LIMITS.max_bytes },
    });
  });

  it("stops at the byte ceiling while walking, so shared references cannot amplify the work", () => {
    let amplified: unknown = "leaf";
    for (let level = 0; level < PM_CLI_ERROR_DETAILS_LIMITS.max_depth; level += 1) amplified = new Array(10).fill(amplified);
    const started = performance.now();
    expect(admitPmCliErrorDetails({ amplified })).toEqual({
      ok: false,
      omission: { reason: "byte_limit", byte_limit: PM_CLI_ERROR_DETAILS_LIMITS.max_bytes },
    });
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("bounds producer-derived omission paths to a fixed UTF-8 size", () => {
    // Key shape is checked before any bytes are charged, so a huge malformed key reaches the receipt.
    const longKey = `${"\u{1F600}".repeat(5000)}\uD800`;
    const admission = admitPmCliErrorDetails({ [longKey]: 1 });
    if (admission.ok) throw new Error("unreachable");
    expect(admission.omission.reason).toBe("malformed_unicode");
    expect(Buffer.byteLength(admission.omission.path!, "utf8")).toBeLessThanOrEqual(160);
    expect(admission.omission.path!.endsWith("…")).toBe(true);
    expect(admission.omission.path).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
  });

  it("renders diagnostics whole within the byte ceiling and replaces larger ones with a receipt", () => {
    expect(projectPmCliErrorDetails(undefined)).toBeUndefined();
    const fits = { text: "x".repeat(PM_CLI_ERROR_DETAILS_LIMITS.max_bytes - 11) };
    expect(Buffer.byteLength(JSON.stringify(fits), "utf8")).toBe(PM_CLI_ERROR_DETAILS_LIMITS.max_bytes);
    expect(projectPmCliErrorDetails(fits)).toEqual({ details: fits });
    const over = { text: "x".repeat(PM_CLI_ERROR_DETAILS_LIMITS.max_bytes - 10) };
    expect(projectPmCliErrorDetails(over)).toEqual({
      details_omitted: { reason: "byte_limit", byte_limit: PM_CLI_ERROR_DETAILS_LIMITS.max_bytes },
    });
    // The running count is the exact compact JSON size for every container shape.
    for (const sample of [{}, { a: [] }, { a: [1, "é", null, true, { b: -0.5 }], "key \u{1F600}": { c: [[]] } }]) {
      const admitted = admitPmCliErrorDetails(sample);
      expect(admitted).toMatchObject({ ok: true, byte_length: Buffer.byteLength(JSON.stringify(sample), "utf8") });
    }
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

  it("never runs a getter on the details slot itself", () => {
    let calls = 0;
    const context = Object.defineProperty({ code: "probe" }, "details", {
      enumerable: true,
      get() {
        calls += 1;
        throw new Error("slot getter fault");
      },
    });
    const receipt = { reason: "unsupported_value", path: "details", byte_limit: PM_CLI_ERROR_DETAILS_LIMITS.max_bytes };
    expect(projectPmCliErrorContextDetailsSlot(context)).toEqual({ details_omitted: receipt });
    expect(projectPmCliErrorContextDetails(context)).toEqual({ code: "probe", details_omitted: receipt });
    expect(omitPmCliErrorDetails(context)).toEqual({ code: "probe" });
    expect(calls).toBe(0);
    expect(projectPmCliErrorContextDetailsSlot({ code: "probe" })).toBeUndefined();
    expect(projectPmCliErrorContextDetailsSlot(null)).toBeUndefined();
    expect(projectPmCliErrorContextDetailsSlot({ details: { ok: 1 } })).toEqual({ details: { ok: 1 } });
  });

  it("snapshots a foreign context as plain data and honours only valid host receipts", () => {
    let calls = 0;
    const foreign = Object.defineProperties({ code: "probe", details: { ok: 1 } }, {
      hidden: { value: "non-enumerable", enumerable: false },
      lazy: { enumerable: true, get() { calls += 1; return "ran"; } },
    });
    expect(snapshotPmCliErrorContext(foreign)).toEqual({ code: "probe", details: { ok: 1 } });
    const getterDetails = Object.defineProperty({ code: "probe" }, "details", { enumerable: true, get() { calls += 1; return {}; } });
    expect(snapshotPmCliErrorContext(getterDetails)).toEqual({
      code: "probe",
      details_omitted: { reason: "unsupported_value", path: "details", byte_limit: PM_CLI_ERROR_DETAILS_LIMITS.max_bytes },
    });
    expect(calls).toBe(0);
    const prototypeKey = JSON.parse('{"__proto__":{"polluted":true},"code":"probe"}') as object;
    const snapshot = snapshotPmCliErrorContext(prototypeKey);
    expect(Object.getPrototypeOf(snapshot)).toBe(Object.prototype);
    expect(Object.hasOwn(snapshot, "__proto__")).toBe(true);
    for (const value of [undefined, null, "text", [1]]) expect(snapshotPmCliErrorContext(value)).toEqual({});
    const hostile = new Proxy({}, { ownKeys: () => { throw new Error("trap fault"); }, getOwnPropertyDescriptor: () => { throw new Error("trap fault"); } });
    expect(snapshotPmCliErrorContext(hostile)).toEqual({});
    const receipt = { reason: "unsupported_value", path: "details", byte_limit: PM_CLI_ERROR_DETAILS_LIMITS.max_bytes };
    expect(projectPmCliErrorContextDetailsSlot(hostile)).toEqual({ details_omitted: receipt });
    expect(projectPmCliErrorContextDetails(hostile)).toEqual({ details_omitted: receipt });
    expect(omitPmCliErrorDetails(hostile)).toEqual({});
    // A recorded host receipt is re-validated and re-bounded; anything else is ignored.
    const recorded = { code: "probe", details_omitted: { reason: "byte_limit", byte_limit: 1, path: "x".repeat(500) } };
    const projected = projectPmCliErrorContextDetailsSlot(recorded) as { details_omitted: { path: string; byte_limit: number } };
    expect(projected.details_omitted.byte_limit).toBe(PM_CLI_ERROR_DETAILS_LIMITS.max_bytes);
    expect(Buffer.byteLength(projected.details_omitted.path, "utf8")).toBeLessThanOrEqual(160);
    expect(projectPmCliErrorContextDetailsSlot({ details_omitted: { reason: "byte_limit", byte_limit: 4096 } })).toEqual({
      details_omitted: { reason: "byte_limit", byte_limit: 4096 },
    });
    for (const invalid of [{ reason: "made_up" }, "byte_limit", null, { reason: 7 }]) {
      expect(projectPmCliErrorContextDetailsSlot({ details_omitted: invalid })).toBeUndefined();
    }
    expect(projectPmCliErrorContextDetailsSlot({ details: undefined })).toBeUndefined();
    let receiptCalls = 0;
    const accessorReceipt = Object.defineProperty({ byte_limit: 4096 }, "reason", { enumerable: true, get() { receiptCalls += 1; return "byte_limit"; } });
    expect(projectPmCliErrorContextDetailsSlot({ details_omitted: accessorReceipt })).toBeUndefined();
    const accessorPath = Object.defineProperty({ reason: "reserved_key" }, "path", { enumerable: true, get() { receiptCalls += 1; return "details.x"; } });
    expect(projectPmCliErrorContextDetailsSlot({ details_omitted: accessorPath })).toEqual({ details_omitted: { reason: "reserved_key", byte_limit: 4096 } });
    expect(receiptCalls).toBe(0);
    expect(projectPmCliErrorContextDetails(recorded)).toEqual({ code: "probe", ...projected });
    // Telemetry omission removes the receipt too: its path can echo producer keys.
    expect(omitPmCliErrorDetails(recorded)).toEqual({ code: "probe" });
  });

  it("strips diagnostics from every embedded error context in a serialized payload", () => {
    const marker = "producer-diagnostic-payload";
    let calls = 0;
    const payload: Record<string, unknown> = {
      extra: { arguments: [{ name: "Error", context: { code: "probe", details: { marker } } }], error_context: { details: { marker } } },
      breadcrumbs: [{ data: { arguments: [{ context: { details: { marker } } }] } }],
      contexts: { Error: { context: { code: "probe", details: { marker } } }, plain: { context: "not an object" } },
    };
    payload.self = payload;
    Object.defineProperty(payload, "lazy", { enumerable: true, get() { calls += 1; return { context: { details: { marker } } }; } });
    let deep: Record<string, unknown> = { context: { details: { marker: "beyond-depth" } } };
    for (let level = 0; level < 20; level += 1) deep = { next: deep };
    payload.deep = deep;
    omitEmbeddedPmCliErrorDetails(payload);
    expect(calls).toBe(0);
    expect(JSON.stringify([payload.extra, payload.breadcrumbs, payload.contexts])).not.toContain(marker);
    expect(payload.extra).toEqual({ arguments: [{ name: "Error", context: { code: "probe" } }], error_context: {} });
    expect(calls).toBe(0);
    // The walk is bounded: a context nested beyond the scan depth is left as-is.
    expect(JSON.stringify(payload.deep)).toContain("beyond-depth");
    omitEmbeddedPmCliErrorDetails(null);
  });
});
