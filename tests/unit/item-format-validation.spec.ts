import { describe, expect, it } from "vitest";
import { normalizeFrontMatter, parseItemDocument, serializeItemDocument } from "../../src/item-format.js";

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

  it("parses and normalizes reminders deterministically", () => {
    const parsed = parseItemDocument(
      buildSource({
        reminders: [
          { at: "2026-02-23T10:00:00.000Z", text: " second reminder " },
          { at: "2026-02-22T10:00:00.000Z", text: "first reminder" },
          { at: "2026-02-23T10:00:00.000Z", text: "alpha reminder" },
        ],
      }),
    );

    expect(parsed.front_matter.reminders).toEqual([
      { at: "2026-02-22T10:00:00.000Z", text: "first reminder" },
      { at: "2026-02-23T10:00:00.000Z", text: "alpha reminder" },
      { at: "2026-02-23T10:00:00.000Z", text: "second reminder" },
    ]);
  });

  it("drops reminders that normalize to empty text in direct normalize fallback", () => {
    const normalized = normalizeFrontMatter({
      id: "pm-reminder-empty-normalize",
      title: "Reminder normalize fallback",
      description: "normalize fallback",
      type: "Task",
      status: "open",
      priority: 1,
      tags: [],
      created_at: FIXED_TS,
      updated_at: FIXED_TS,
      reminders: [{ at: FIXED_TS, text: "   " }],
    } as unknown as Parameters<typeof normalizeFrontMatter>[0]);

    expect(normalized.reminders).toBeUndefined();
  });

  it("throws on invalid reminder structures", () => {
    expect(() => parseItemDocument(buildSource({ reminders: "tomorrow" }))).toThrow("reminders must be an array");
    expect(() => parseItemDocument(buildSource({ reminders: [42] }))).toThrow("reminders entries must be objects");
    expect(() => parseItemDocument(buildSource({ reminders: [{ text: "missing at" }] }))).toThrow(
      "reminder.at must be a string",
    );
    expect(() => parseItemDocument(buildSource({ reminders: [{ at: "invalid", text: "bad ts" }] }))).toThrow(
      "reminder.at must be a valid ISO timestamp",
    );
    expect(() => parseItemDocument(buildSource({ reminders: [{ at: FIXED_TS, text: "" }] }))).toThrow(
      "reminder.text must not be empty",
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

  it("round-trips TOON item documents while preserving canonical document shape", () => {
    const source = parseItemDocument(buildSource({ tags: ["Alpha", "beta"], confidence: "med" }));
    const serializedToon = serializeItemDocument(source, { format: "toon" });
    expect(serializedToon.startsWith("front_matter:")).toBe(false);
    expect(serializedToon.startsWith("id: ")).toBe(true);
    const parsedToon = parseItemDocument(serializedToon, { format: "toon" });
    expect(parsedToon).toEqual({
      front_matter: {
        ...source.front_matter,
        tags: ["alpha", "beta"],
        confidence: "medium",
      },
      body: source.body,
    });
  });

  it("parses TOON root-object item documents without front_matter wrapper", () => {
    const parsed = parseItemDocument(
      [
        "id: pm-root-item",
        "title: Root object title",
        "description: Root object description",
        "type: Task",
        "status: open",
        "priority: 1",
        "tags[2]: beta,alpha",
        `created_at: "${FIXED_TS}"`,
        `updated_at: "${FIXED_TS}"`,
        "body: Root object body",
      ].join("\n"),
      { format: "toon" },
    );
    expect(parsed.front_matter.id).toBe("pm-root-item");
    expect(parsed.front_matter.tags).toEqual(["alpha", "beta"]);
    expect(parsed.body).toBe("Root object body");
  });

  it("keeps backward compatibility with legacy wrapped TOON item documents", () => {
    const parsed = parseItemDocument(
      [
        "front_matter:",
        "  id: pm-legacy-wrapped",
        "  title: Legacy title",
        "  description: Legacy description",
        "  type: Task",
        "  status: open",
        "  priority: 1",
        "  tags[2]: beta,alpha",
        `  created_at: "${FIXED_TS}"`,
        `  updated_at: "${FIXED_TS}"`,
        "body: Legacy body",
      ].join("\n"),
      { format: "toon" },
    );
    expect(parsed.front_matter.id).toBe("pm-legacy-wrapped");
    expect(parsed.front_matter.tags).toEqual(["alpha", "beta"]);
    expect(parsed.body).toBe("Legacy body");
  });

  it("defaults body to empty string for legacy wrapped TOON without body field", () => {
    const parsed = parseItemDocument(
      [
        "front_matter:",
        "  id: pm-legacy-no-body",
        "  title: Legacy no body",
        "  description: Legacy no body description",
        "  type: Task",
        "  status: open",
        "  priority: 1",
        "  tags[1]: alpha",
        `  created_at: "${FIXED_TS}"`,
        `  updated_at: "${FIXED_TS}"`,
      ].join("\n"),
      { format: "toon" },
    );
    expect(parsed.body).toBe("");
  });

  it("throws when TOON item document is malformed", () => {
    expect(() => parseItemDocument("front_matter: [", { format: "toon" })).toThrow("front matter must be an object");
  });

  it("throws when TOON decoding returns a non-object value", () => {
    expect(() => parseItemDocument("<<not-valid-toon>>", { format: "toon" })).toThrow("TOON item document must be an object");
  });

  it("parses JSON front matter with escaped string content", () => {
    const parsed = parseItemDocument(
      buildSource({
        description: String.raw`Escaped quote \" and escaped slash \\ in text`,
      }),
    );
    expect(parsed.front_matter.description).toContain("Escaped quote");
  });

  it("defaults TOON body to empty string when body is omitted", () => {
    const withBody = serializeItemDocument(parseItemDocument(buildSource()), { format: "toon" });
    const withoutBody = withBody.replace(/\nbody:[\s\S]*$/, "");
    const parsed = parseItemDocument(withoutBody, { format: "toon" });
    expect(parsed.body).toBe("");
  });

  it("serializes TOON with empty body when document body is undefined", () => {
    const parsed = parseItemDocument(buildSource());
    const serialized = serializeItemDocument(
      {
        ...parsed,
        body: undefined as unknown as string,
      },
      { format: "toon" },
    );
    const roundTrip = parseItemDocument(serialized, { format: "toon" });
    expect(roundTrip.body).toBe("");
  });
});
