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

  it("rethrows the strict error when the lenient retry also fails", () => {
    // An unterminated quote is malformed in both strict and lenient modes.
    expect(() => decodeToonItemContent('title: "unterminated')).toThrow(/Unterminated string/);
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
