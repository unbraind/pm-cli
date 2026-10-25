import { encode } from "@toon-format/toon";
import { describe, expect, it } from "vitest";
import {
  fitOutputEnvelope,
  OutputEnvelopeFitError,
  type FitOutputEnvelopeOptions,
  type OutputEnvelopeFitResult,
} from "../../../../src/sdk/output/fit-envelope.js";

type Packet = { items: readonly string[]; source: string; charged: number };
const base: FitOutputEnvelopeOptions<string, Packet> = {
  tokenBudget: 10_000,
  buildEnvelope: (items, receipt) => ({ items, source: "connector", charged: receipt.estimated_tokens }),
  renderers: { json: (value) => `${JSON.stringify(value)}\n`, toon: (value) => `${encode(value)}\n` },
};

/** Independently check emitted bytes, receipts and budgets with no second SDK estimate. */
function verifyPacket(result: OutputEnvelopeFitResult<string, Packet>, divisor = 4): void {
  const measurements = result.renderings.map(({ text }) => ({ bytes: Buffer.byteLength(text, "utf8"), tokens: Math.ceil(Buffer.byteLength(text, "utf8") / divisor) }));
  const receipt = result.envelope.output_fit;
  expect(receipt.output_bytes).toBe(Math.max(...measurements.map((value) => value.bytes)));
  expect(receipt.estimated_tokens).toBe(Math.max(...measurements.map((value) => value.tokens)));
  expect(result.envelope.charged).toBe(receipt.estimated_tokens);
  expect(receipt.estimated_tokens).toBeLessThanOrEqual(receipt.token_budget);
  expect(result.work.render_calls).toBeLessThanOrEqual(result.work.max_render_calls);
  expect(result.renderings.every(({ text }) => text.endsWith("\n"))).toBe(true);
  expect(Reflect.set(receipt, "estimated_tokens", -1)).toBe(false);
  expect(Reflect.set(receipt.included_indices, "0", -1)).toBe(false);
}

describe("complete output envelope fitting (GH-1567)", () => {
  it.each([[], ["naïve", "東京", "🧑🏽‍💻"], Array.from({ length: 12 }, (_, index) => `row-${index}`)].map((rows) => ({ rows })))("measures receipts, Unicode and framing for $rows", ({ rows }) => {
    const result = fitOutputEnvelope(rows, base);
    expect(result.rows).toEqual(rows);
    expect(result.complete).toBe(true);
    expect(result.envelope.source).toBe("connector");
    expect(result.envelope.output_fit.included_indices).toEqual(rows.map((_, index) => index));
    expect(result.envelope.output_fit.omitted_count).toBe(0);
    expect(JSON.parse(result.renderings[0]!.text)).toEqual(result.envelope);
    verifyPacket(result);
  });

  it.each(["prefix", "skip"] as const)("applies deterministic %s admission and whole-row omission", (policy) => {
    const rows = ["first", "x".repeat(10_000), "last"];
    const result = fitOutputEnvelope(rows, { ...base, tokenBudget: 200, policy });
    expect(result.rows).toEqual(policy === "prefix" ? ["first"] : ["first", "last"]);
    expect(result.complete).toBe(false);
    expect(result.envelope.output_fit).toMatchObject({ total_candidates: 3, omitted_count: policy === "prefix" ? 2 : 1, included_indices: policy === "prefix" ? [0] : [0, 2] });
    expect(result.work.evaluated_candidates).toBe(policy === "prefix" ? 2 : 3);
    expect(fitOutputEnvelope(rows, { ...base, tokenBudget: 200, policy })).toEqual(result);
    verifyPacket(result);
  });

  it("admits the exact inclusive budget and refuses one token below the mandatory minimum", () => {
    // Budget digits are part of the packet; use the same digit width in both trials.
    const options = { ...base, tokenBudget: 99 };
    const minimum = fitOutputEnvelope([], options).envelope.output_fit.estimated_tokens;
    const exact = fitOutputEnvelope([], { ...base, tokenBudget: minimum });
    expect(exact.envelope.output_fit.estimated_tokens).toBe(minimum);
    expect(() => fitOutputEnvelope([], { ...base, tokenBudget: minimum - 1 })).toThrow(OutputEnvelopeFitError);
    try {
      fitOutputEnvelope([], { ...base, tokenBudget: 1 });
      expect.fail("An infeasible envelope must refuse");
    } catch (error) {
      expect(error).toMatchObject({ name: "OutputEnvelopeFitError", code: "output_envelope_infeasible", minimum_tokens: expect.any(Number), work: { evaluated_candidates: 0 } });
      expect(Object.isFrozen((error as OutputEnvelopeFitError).work)).toBe(true);
    }
  });

  it("uses the greatest rendering even when transport size order changes with content", () => {
    const options = { ...base, renderers: {
      json: (value: Parameters<typeof base.renderers[string]>[0]) => `${JSON.stringify(value)}${value.items.includes("first") ? " ".repeat(400) : ""}\n`,
      toon: (value: Parameters<typeof base.renderers[string]>[0]) => `${encode(value)}${value.items.includes("first") ? "" : " ".repeat(500)}\n`,
    } };
    const empty = fitOutputEnvelope([], options);
    const filled = fitOutputEnvelope(["first"], options);
    expect(empty.renderings[1]!.bytes).toBeGreaterThan(empty.renderings[0]!.bytes);
    expect(filled.renderings[0]!.bytes).toBeGreaterThan(filled.renderings[1]!.bytes);
    verifyPacket(empty);
    verifyPacket(filled);
  });

  it("preserves a stronger caller estimator and stabilizes digit-boundary accounting", () => {
    const options = { ...base, tokenBudget: 1_000, estimateTokens: (text: string) => Buffer.byteLength(text, "utf8") };
    const result = fitOutputEnvelope(["ü".repeat(250), "second".repeat(100)], options);
    expect(result.rows).toEqual(["ü".repeat(250)]);
    expect(result.envelope.output_fit.estimated_tokens).toBeGreaterThan(100);
    expect(result.work.render_calls).toBeGreaterThan(6);
    verifyPacket(result, 1);
  });

  it.each([
    { tokenBudget: 0 }, { tokenBudget: Number.POSITIVE_INFINITY },
    { tokenBudget: 1.5 }, { maxRenderCalls: -1 }, { maxStabilizationPasses: Number.NaN },
    { policy: "largest" }, { renderers: {} }, { renderers: { " ": JSON.stringify } },
    { renderers: { invalid: null } },
  ])("rejects invalid controls before invoking caller code: %j", (invalid) => {
    let calls = 0;
    const options = { ...base, ...invalid, buildEnvelope: () => { calls += 1; return { items: [], source: "unused", charged: 0 }; } } as FitOutputEnvelopeOptions<string, Packet>;
    expect(() => fitOutputEnvelope([], options)).toThrow();
    expect(calls).toBe(0);
  });

  it.each([Number.NaN, -1, 0.5, Number.POSITIVE_INFINITY])("rejects invalid estimator result %s", (tokens) => {
    expect(() => fitOutputEnvelope([], { ...base, estimateTokens: () => tokens })).toThrow("non-negative safe integers");
  });

  it("accepts a zero estimate for an empty custom rendering and reserves output_fit", () => {
    const result = fitOutputEnvelope([], { tokenBudget: 1, buildEnvelope: () => ({ output_fit: { fake: true } }), renderers: { custom: () => "" } });
    expect(result.envelope.output_fit).toMatchObject({ version: 1, estimated_tokens: 0, output_bytes: 0 });
    expect(result.envelope.output_fit).not.toHaveProperty("fake");
  });

  it("refuses invalid render output without returning a partial packet", () => {
    expect(() => fitOutputEnvelope([], { ...base, renderers: { broken: () => undefined as unknown as string } })).toThrow("must return strings");
  });

  it("bounds renderer calls globally and reports the completed work on refusal", () => {
    expect(() => fitOutputEnvelope(["first"], { ...base, maxRenderCalls: 7 })).toThrow(expect.objectContaining({ code: "output_envelope_work_limit", work: { evaluated_candidates: 1, render_calls: 7, max_render_calls: 7 }, minimum_tokens: undefined }));
  });

  it("refuses nonconvergent self-accounting within a finite pass ceiling", () => {
    const options = { ...base, maxStabilizationPasses: 4, renderers: { cyclic: (value: Parameters<typeof base.renderers[string]>[0]) => " ".repeat(value.output_fit.output_bytes === 1 ? 2 : 1) } };
    expect(() => fitOutputEnvelope([], options)).toThrow(expect.objectContaining({ code: "output_envelope_unstable", work: { evaluated_candidates: 0, render_calls: 4, max_render_calls: 10_000 } }));
  });
});
