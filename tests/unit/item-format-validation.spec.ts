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

  it("parses and normalizes confidence values", () => {
    const numeric = parseItemDocument(buildSource({ confidence: 42 }));
    expect(numeric.front_matter.confidence).toBe(42);

    const medAlias = parseItemDocument(buildSource({ confidence: "med" }));
    expect(medAlias.front_matter.confidence).toBe("medium");

    const textLevel = parseItemDocument(buildSource({ confidence: "high" }));
    expect(textLevel.front_matter.confidence).toBe("high");
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

  it("drops invalid confidence text during direct normalize fallback", () => {
    const parsed = parseItemDocument(buildSource({ confidence: "low" }));
    const normalized = normalizeFrontMatter({
      ...(parsed.front_matter as Record<string, unknown>),
      confidence: "unknown",
    } as unknown as Parameters<typeof normalizeFrontMatter>[0]);
    expect(normalized.confidence).toBeUndefined();
  });
});
