import { describe, expect, it } from "vitest";
import { normalizeFrontMatter, parseItemDocument } from "../../src/item-format.js";

const FIXED_TS = "2026-02-22T00:00:00.000Z";

function buildSource(overrides: Record<string, unknown> = {}, body = "Body"): string {
  const frontMatter: Record<string, unknown> = {
    id: "pm-validate",
    title: "Validate front matter",
    description: "Validation contract",
    type: "Task",
    status: "open",
    priority: 1,
    tags: ["beta", "alpha"],
    created_at: FIXED_TS,
    updated_at: FIXED_TS,
    ...overrides,
  };
  return `${JSON.stringify(frontMatter, null, 2)}\n\n${body}\n`;
}

describe("item-format front-matter validation", () => {
  it("parses and normalizes valid front matter", () => {
    const parsed = parseItemDocument(buildSource());
    expect(parsed.front_matter.id).toBe("pm-validate");
    expect(parsed.front_matter.tags).toEqual(["alpha", "beta"]);
    expect(parsed.body).toBe("Body");
  });

  it("throws when JSON front matter is missing", () => {
    expect(() => parseItemDocument("Body only")).toThrow("missing JSON front matter");
  });

  it("throws when JSON front matter is malformed", () => {
    expect(() => parseItemDocument("{\n  \"id\": \"pm-validate\"\n")).toThrow("not valid JSON");
    expect(() => parseItemDocument("{ invalid }\n\nBody")).toThrow("not valid JSON");
  });

  it("throws when required string fields are missing or invalid", () => {
    expect(() => parseItemDocument(buildSource({ title: undefined }))).toThrow("title is required and must be a string");
    expect(() => parseItemDocument(buildSource({ description: 42 }))).toThrow(
      "description is required and must be a string",
    );
  });

  it("throws on invalid type, status, and priority", () => {
    expect(() => parseItemDocument(buildSource({ type: "Bug" }))).toThrow("type must be one of");
    expect(() => parseItemDocument(buildSource({ status: "doing" }))).toThrow("status must be one of");
    expect(() => parseItemDocument(buildSource({ priority: 7 }))).toThrow("priority must be an integer 0..4");
  });

  it("throws when tags are not string arrays", () => {
    expect(() => parseItemDocument(buildSource({ tags: "core" }))).toThrow("tags must be an array");
    expect(() => parseItemDocument(buildSource({ tags: ["ok", 2] }))).toThrow("tags entries must be strings");
  });

  it("throws when timestamps are invalid", () => {
    expect(() => parseItemDocument(buildSource({ created_at: "not-a-timestamp" }))).toThrow(
      "created_at must be a valid ISO timestamp",
    );
    expect(() => parseItemDocument(buildSource({ deadline: "tomorrow-ish" }))).toThrow(
      "deadline must be a valid ISO timestamp",
    );
  });

  it("parses Beads compatibility fields and sorts dependency source_kind ties deterministically", () => {
    const normalizedDirect = normalizeFrontMatter({
      id: "pm-sort-source-kind",
      title: "Sort source kind",
      description: "sort test",
      type: "Task",
      status: "open",
      priority: 1,
      tags: [],
      created_at: FIXED_TS,
      updated_at: FIXED_TS,
      dependencies: [
        { id: "pm-a", kind: "related_to", created_at: FIXED_TS, source_kind: "z-rel" },
        { id: "pm-a", kind: "related_to", created_at: FIXED_TS, source_kind: "a-rel" },
      ],
    });
    expect(normalizedDirect.dependencies?.map((entry) => entry.source_kind)).toEqual(["a-rel", "z-rel"]);

    const normalizedWithUndefinedSourceKind = normalizeFrontMatter({
      id: "pm-sort-source-kind-undefined",
      title: "Sort source kind undefined",
      description: "sort test",
      type: "Task",
      status: "open",
      priority: 1,
      tags: [],
      created_at: FIXED_TS,
      updated_at: FIXED_TS,
      dependencies: [
        { id: "pm-a", kind: "related_to", created_at: FIXED_TS, source_kind: "b-rel" },
        { id: "pm-a", kind: "related_to", created_at: FIXED_TS },
      ],
    });
    expect(normalizedWithUndefinedSourceKind.dependencies?.map((entry) => entry.source_kind)).toEqual([undefined, "b-rel"]);

    const normalizedWithLeadingUndefinedSourceKind = normalizeFrontMatter({
      id: "pm-sort-source-kind-leading-undefined",
      title: "Sort source kind leading undefined",
      description: "sort test",
      type: "Task",
      status: "open",
      priority: 1,
      tags: [],
      created_at: FIXED_TS,
      updated_at: FIXED_TS,
      dependencies: [
        { id: "pm-a", kind: "related_to", created_at: FIXED_TS },
        { id: "pm-a", kind: "related_to", created_at: FIXED_TS, source_kind: "c-rel" },
      ],
    });
    expect(normalizedWithLeadingUndefinedSourceKind.dependencies?.map((entry) => entry.source_kind)).toEqual([
      undefined,
      "c-rel",
    ]);

    const parsed = parseItemDocument(
      buildSource({
        closed_at: "2026-02-22T01:02:03.123456789+01:00",
        source_type: "bug",
        source_owner: "owner-a",
        design: "Design body",
        external_ref: "EXT-1",
        dependencies: [
          { id: "pm-a", kind: "related_to", created_at: FIXED_TS, source_kind: "z-rel" },
          { id: "pm-a", kind: "related_to", created_at: FIXED_TS, source_kind: "a-rel" },
        ],
      }),
    );

    expect(parsed.front_matter.closed_at).toBe("2026-02-22T01:02:03.123456789+01:00");
    expect(parsed.front_matter.source_type).toBe("bug");
    expect(parsed.front_matter.source_owner).toBe("owner-a");
    expect(parsed.front_matter.design).toBe("Design body");
    expect(parsed.front_matter.external_ref).toBe("EXT-1");
    expect(parsed.front_matter.dependencies?.map((entry) => entry.source_kind)).toEqual(["a-rel", "z-rel"]);
  });

  it("parses and normalizes confidence values", () => {
    const numeric = parseItemDocument(buildSource({ confidence: 42 }));
    expect(numeric.front_matter.confidence).toBe(42);

    const medAlias = parseItemDocument(buildSource({ confidence: "med" }));
    expect(medAlias.front_matter.confidence).toBe("medium");

    const textLevel = parseItemDocument(buildSource({ confidence: "high" }));
    expect(textLevel.front_matter.confidence).toBe("high");
  });

  it("parses and normalizes severity values", () => {
    const medAlias = parseItemDocument(buildSource({ severity: "med" }));
    expect(medAlias.front_matter.severity).toBe("medium");

    const textLevel = parseItemDocument(buildSource({ severity: "high" }));
    expect(textLevel.front_matter.severity).toBe("high");
  });

  it("parses regression boolean values", () => {
    const regressionTrue = parseItemDocument(buildSource({ regression: true }));
    expect(regressionTrue.front_matter.regression).toBe(true);

    const regressionFalse = parseItemDocument(buildSource({ regression: false }));
    expect(regressionFalse.front_matter.regression).toBe(false);
  });

  it("throws on invalid confidence values", () => {
    expect(() => parseItemDocument(buildSource({ confidence: 101 }))).toThrow(
      "confidence number value must be an integer 0..100",
    );
    expect(() => parseItemDocument(buildSource({ confidence: "uncertain" }))).toThrow(
      "confidence string value must be one of",
    );
    expect(() => parseItemDocument(buildSource({ confidence: { value: "low" } }))).toThrow(
      "confidence must be a number or string",
    );
  });

  it("throws on invalid severity and regression values", () => {
    expect(() => parseItemDocument(buildSource({ severity: "urgent" }))).toThrow("severity value must be one of");
    expect(() => parseItemDocument(buildSource({ severity: 3 }))).toThrow("severity must be a string");
    expect(() => parseItemDocument(buildSource({ regression: "true" }))).toThrow("regression must be a boolean");
  });

  it("throws on invalid Beads compatibility metadata values", () => {
    expect(() => parseItemDocument(buildSource({ closed_at: 42 }))).toThrow("closed_at must be a string");
    expect(() => parseItemDocument(buildSource({ closed_at: "not-a-timestamp" }))).toThrow(
      "closed_at must be a valid ISO timestamp",
    );
    expect(() => parseItemDocument(buildSource({ design: 42 }))).toThrow("design must be a string");
  });

  it("drops invalid confidence text during direct normalize fallback", () => {
    const parsed = parseItemDocument(buildSource({ confidence: "low" }));
    const normalized = normalizeFrontMatter({
      ...(parsed.front_matter as Record<string, unknown>),
      confidence: "unknown",
    } as unknown as Parameters<typeof normalizeFrontMatter>[0]);
    expect(normalized.confidence).toBeUndefined();
  });

  it("drops invalid severity text during direct normalize fallback", () => {
    const parsed = parseItemDocument(buildSource({ severity: "low" }));
    const normalized = normalizeFrontMatter({
      ...(parsed.front_matter as Record<string, unknown>),
      severity: "urgent",
    } as unknown as Parameters<typeof normalizeFrontMatter>[0]);
    expect(normalized.severity).toBeUndefined();
  });
});
