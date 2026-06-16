import { describe, expect, it } from "vitest";

import {
  TOON_SCALAR_BRACKET_ESCAPE_TRACKING,
  TOON_SCALAR_BRACKET_ESCAPE_UPSTREAM_PR,
  decodeToonItemContent,
} from "../../../../src/core/item/toon-decode.js";
import { parseItemDocument } from "../../../../src/core/item/item-format.js";

describe("decodeToonItemContent", () => {
  it("decodes valid TOON via the strict path without the scalar-bracket escape", () => {
    const result = decodeToonItemContent('title: "Hello"\npriority: 2');
    expect(result.usedScalarBracketEscape).toBe(false);
    expect(result.value).toMatchObject({ title: "Hello", priority: 2 });
  });

  it("recovers a quoted value containing a bracketed-token-then-colon via strict escaped retry", () => {
    // Reproduces the upstream round-trip bug: the strict decoder mis-detects
    // the bracket in the quoted value as a "key[N]:" array header and throws.
    const result = decodeToonItemContent('body: "POST [redacted_endpoint]: HTTP 200, accepted:1"');
    expect(result.usedScalarBracketEscape).toBe(true);
    expect(result.value).toMatchObject({ body: "POST [redacted_endpoint]: HTTP 200, accepted:1" });
  });

  it("does NOT retry unchanged content for non-bracket strict errors", () => {
    expect(() => decodeToonItemContent("a: 1\na: 2")).toThrow(/Duplicate sibling key/);
    expect(() => decodeToonItemContent("tags[2]: one")).toThrow(/Expected 2 inline array items/);
  });

  it("still enforces strict-only invariants after the escaped retry engages", () => {
    // The bracketed scalar causes the escaped retry to run, but duplicate keys
    // must still fail because the retry stays in strict mode.
    expect(() => decodeToonItemContent('body: "POST [redacted_endpoint]: HTTP 200"\na: 1\na: 2')).toThrow(
      /Duplicate sibling key/,
    );
  });

  it("surfaces escaped strict retry errors for genuinely malformed documents", () => {
    expect(() => decodeToonItemContent('a: "p[x]: y"\nb: "unterminated')).toThrow(/Unterminated string/);
  });

  it("preserves array headers while escaping only quoted scalar brackets", () => {
    const result = decodeToonItemContent([
      "tags[2]: alpha,beta",
      'body: "POST [redacted_endpoint]: HTTP 200"',
    ].join("\n"));
    expect(result.usedScalarBracketEscape).toBe(true);
    expect(result.value).toMatchObject({
      tags: ["alpha", "beta"],
      body: "POST [redacted_endpoint]: HTTP 200",
    });
  });
});

describe("TOON scalar bracket workaround tracking", () => {
  it("keeps explicit upstream linkage for future workaround removal", () => {
    expect(TOON_SCALAR_BRACKET_ESCAPE_UPSTREAM_PR).toBe("https://github.com/toon-format/toon/pull/314");
    expect(TOON_SCALAR_BRACKET_ESCAPE_TRACKING).toMatchObject({
      dependency: "@toon-format/toon",
      affected_versions: "<=2.3.0",
      upstream_pr: TOON_SCALAR_BRACKET_ESCAPE_UPSTREAM_PR,
    });
    expect(TOON_SCALAR_BRACKET_ESCAPE_TRACKING.removal_condition).toMatch(/Remove escapeBracketsInQuotedScalars retry/);
  });
});

describe("parseItemDocument TOON scalar-bracket recovery", () => {
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
