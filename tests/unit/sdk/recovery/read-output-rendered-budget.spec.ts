/** @module tests/unit/sdk/read-output-rendered-budget
 * Verifies complete rendered envelopes retain useful, resumable rows within budget.
 */
import { describe, expect, it } from "vitest";
import { formatBuiltInOutput } from "../../../../src/core/output/output.js";
import { applyReadOutputDimensions, decodeReadOutputContinuationCursor, stabilizeReadOutputReceiptEstimates } from "../../../../src/sdk/read-output-contracts.js";
import { estimateReadOutputTokens } from "../../../../src/sdk/read-output-budget.js";

describe("rendered read-output accounting", () => {
  it.each((["json", "toon"] as const).flatMap((format) =>
    ["outputFormat", "output_format", "format"].map((option) => ({ format, option })),
  ))("bounds the complete $format envelope through $option including session and cursors", ({ format, option }) => {
    const items = Array.from({ length: 80 }, (_, index) => ({ id: `pm-rendered-${index}`, title: `Unicode café ${index}`, description: "Long detail ".repeat(30) }));
    const options = {
      [option]: format,
      outputBudget: 1800,
      outputSession: { version: 1, id: "rendered", token_budget: 5000, spent_tokens: 500, seen_item_ids: [] },
    };
    const result = applyReadOutputDimensions("list", options, { items, count: items.length });
    expect(result).not.toHaveProperty("output_budget_exceeded");
    const envelope = result as unknown as { items: typeof items; read_output: { estimated_tokens: number }; read_session: { spent_this_call_tokens: number }; output_budget_truncation: { continuations: Array<{ cursor: string; retained_rows: number }> } };
    const measured = Math.ceil(Buffer.byteLength(formatBuiltInOutput(result, format), "utf8") / 4);
    expect(measured).toBeLessThanOrEqual(1800);
    expect(envelope.items.length).toBeGreaterThan(0);
    expect(envelope.items.length).toBeLessThan(items.length);
    expect(envelope.read_output.estimated_tokens).toBe(measured);
    expect(envelope.read_session.spent_this_call_tokens).toBe(measured);
    const continuation = envelope.output_budget_truncation.continuations[0]!;
    expect(decodeReadOutputContinuationCursor(continuation.cursor).offset).toBe(envelope.items.length);
    expect(continuation.retained_rows).toBe(envelope.items.length);
    const finalEnvelope = stabilizeReadOutputReceiptEstimates({ ...result, transport: "SDK café" }, options);
    const finalMeasured = Math.ceil(Buffer.byteLength(formatBuiltInOutput(finalEnvelope, format), "utf8") / 4);
    expect(finalEnvelope.read_output).toMatchObject({ estimated_tokens: finalMeasured });
    expect(finalEnvelope.read_session).toMatchObject({ spent_this_call_tokens: finalMeasured });
  });

  it("preserves structured SDK measurement when no renderer is selected", () => {
    const result = { rows: [{ title: "café" }] };
    expect(estimateReadOutputTokens(result)).toBe(Math.ceil(Buffer.byteLength(JSON.stringify(result), "utf8") / 4));
    expect(estimateReadOutputTokens(result, "json")).toBeGreaterThan(estimateReadOutputTokens(result));
  });
});
