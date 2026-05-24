import { describe, expect, it } from "vitest";

import { decodeToonItemContent } from "../../src/core/item/toon-decode.js";
import { parseItemDocument } from "../../src/core/item/item-format.js";

describe("decodeToonItemContent", () => {
  it("decodes valid TOON via the strict path without the lenient fallback", () => {
    const result = decodeToonItemContent('title: "Hello"\npriority: 2');
    expect(result.usedLenientFallback).toBe(false);
    expect(result.value).toMatchObject({ title: "Hello", priority: 2 });
  });

  it("recovers a quoted value containing a bracketed-token-then-colon via the lenient fallback", () => {
    // Reproduces the upstream round-trip bug: the strict decoder mis-detects
    // the bracket in the quoted value as a "key[N]:" array header and throws.
    const result = decodeToonItemContent('body: "POST [redacted_endpoint]: HTTP 200, accepted:1"');
    expect(result.usedLenientFallback).toBe(true);
    expect(result.value).toMatchObject({ body: "POST [redacted_endpoint]: HTTP 200, accepted:1" });
  });

  it("does NOT fall back for non-bracket strict errors, preserving strict validation", () => {
    // Duplicate sibling keys are a strict error that lenient mode would silently
    // resolve last-write-wins. The fallback is gated to the bracket mis-parse, so
    // this must still throw rather than silently accept a last-write-wins value.
    expect(() => decodeToonItemContent("a: 1\na: 2")).toThrow(/Duplicate sibling key/);
  });

  it("rethrows the strict bracket error when the gated lenient retry also fails", () => {
    // Line 1 trips the bracket mis-parse (so the fallback engages), but line 2 is
    // malformed in lenient mode too, so the original strict error is surfaced.
    expect(() => decodeToonItemContent('a: "p[x]: y"\nb: "unterminated')).toThrow(/Invalid array length/);
  });
});

describe("parseItemDocument lenient TOON recovery", () => {
  it("recovers an item document whose body contains a bracketed-token-then-colon silently", () => {
    const warnings: string[] = [];
    const document = parseItemDocument(
      [
        "id: pm-test",
        'title: "Telemetry verified"',
        'description: "Verification run"',
        "type: Task",
        "status: closed",
        "priority: 2",
        "tags[1]: telemetry",
        'created_at: "2026-05-24T00:00:00.000Z"',
        'updated_at: "2026-05-24T00:00:00.000Z"',
        "author: tester",
        'body: "evidence: POST [redacted_endpoint]: HTTP 200"',
      ].join("\n"),
      { format: "toon", onWarning: (warning) => warnings.push(warning) },
    );
    expect(document.metadata.id).toBe("pm-test");
    expect(document.body).toContain("[redacted_endpoint]");
    // Recovery is lossless and intentionally silent (no health-flipping warning).
    expect(warnings).toEqual([]);
  });
});
