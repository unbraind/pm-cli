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

  it("decodes a quoted bracketed-token-then-colon natively with TOON 2.3.1", () => {
    const result = decodeToonItemContent(
      'body: "POST [redacted_endpoint]: HTTP 200, accepted:1"',
    );
    expect(result.usedScalarBracketEscape).toBe(false);
    expect(result.value).toMatchObject({
      body: "POST [redacted_endpoint]: HTTP 200, accepted:1",
    });
  });

  it("preserves strict decoder failures", () => {
    expect(() => decodeToonItemContent("a: 1\na: 2")).toThrow(
      /Duplicate sibling key/,
    );
    expect(() => decodeToonItemContent("tags[2]: one")).toThrow(
      /Expected 2 inline array items/,
    );
    expect(() =>
      decodeToonItemContent(
        'body: "POST [redacted_endpoint]: HTTP 200"\na: 1\na: 2',
      ),
    ).toThrow(/Duplicate sibling key/);
    expect(() =>
      decodeToonItemContent('a: "p[x]: y"\nb: "unterminated'),
    ).toThrow(/Unterminated string/);
  });

  it("preserves array headers beside quoted scalar brackets", () => {
    const result = decodeToonItemContent(
      [
        "tags[2]: alpha,beta",
        'body: "POST [redacted_endpoint]: HTTP 200"',
      ].join("\n"),
    );
    expect(result.usedScalarBracketEscape).toBe(false);
    expect(result.value).toMatchObject({
      tags: ["alpha", "beta"],
      body: "POST [redacted_endpoint]: HTTP 200",
    });
  });
});

describe("TOON scalar bracket fix tracking", () => {
  it("keeps explicit upstream linkage after removing the local workaround", () => {
    expect(TOON_SCALAR_BRACKET_ESCAPE_UPSTREAM_PR).toBe(
      "https://github.com/toon-format/toon/pull/314",
    );
    expect(TOON_SCALAR_BRACKET_ESCAPE_TRACKING).toMatchObject({
      dependency: "@toon-format/toon",
      affected_versions: "<=2.3.0",
      resolved_version: "2.3.1",
      upstream_pr: TOON_SCALAR_BRACKET_ESCAPE_UPSTREAM_PR,
      workaround_status: "removed",
    });
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
    // Native strict decoding is lossless and intentionally warning-free.
    expect(warnings).toEqual([]);
  });
});
