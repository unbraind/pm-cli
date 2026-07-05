import { describe, expect, it } from "vitest";

import { parseItemDocument, serializeItemDocument, splitFrontMatter } from "../../../../src/core/item/item-format.js";
import { normalizeRuntimeSchemaSettings } from "../../../../src/core/schema/runtime-schema.js";
import { toItemRecord } from "../../../../src/core/item/item-record.js";
import {
  assertParentReferenceIsNotSelf,
  isPlaceholderReferenceToken,
  normalizeParentReferencePolicy,
  normalizeParentReferenceValue,
  validateMissingParentReference,
} from "../../../../src/core/item/parent-reference-policy.js";
import {
  normalizeSprintReleaseFormatPolicy,
  validateSprintOrReleaseValue,
} from "../../../../src/core/item/sprint-release-format.js";
import type { ItemMetadata } from "../../../../src/types/index.js";

function buildItemMetadata(overrides: Partial<ItemMetadata> = {}): ItemMetadata {
  return {
    id: "pm-test",
    title: "Test item",
    description: "",
    type: "Task",
    status: "open",
    priority: 2,
    tags: [],
    created_at: "2026-05-25T00:00:00.000Z",
    updated_at: "2026-05-25T00:00:00.000Z",
    ...overrides,
  } as ItemMetadata;
}

describe("toItemRecord", () => {
  it("returns the same object reference (no runtime transformation)", () => {
    const item = buildItemMetadata();
    const record = toItemRecord(item);
    expect(record).toBe(item as unknown as Record<string, unknown>);
  });

  it("exposes the item fields through a generic record shape", () => {
    const item = buildItemMetadata({ id: "pm-abcd", title: "Widen me", priority: 1 });
    const record = toItemRecord(item);
    expect(record.id).toBe("pm-abcd");
    expect(record.title).toBe("Widen me");
    expect(record.priority).toBe(1);
  });

  it("reflects subsequent mutations because it is the same reference", () => {
    const item = buildItemMetadata();
    const record = toItemRecord(item);
    record.assignee = "maintainer";
    expect(item.assignee).toBe("maintainer");
  });
});

describe("item policy helpers", () => {
  it("normalizes parent reference policies and values", () => {
    expect(normalizeParentReferencePolicy(" warn ")).toBe("warn");
    expect(normalizeParentReferencePolicy("strict-error")).toBe("strict_error");
    expect(normalizeParentReferencePolicy("strict")).toBe("strict_error");
    expect(() => normalizeParentReferencePolicy(undefined)).toThrow("parent-reference-policy requires --policy");

    expect(normalizeParentReferenceValue(" pm-parent ")).toBe("pm-parent");
    expect(() => normalizeParentReferenceValue(null)).toThrow("--parent must be a string");
    expect(() => normalizeParentReferenceValue(" ")).toThrow("--parent must not be empty");
    expect(() => normalizeParentReferenceValue("none")).toThrow("Use --unset parent");
    expect(isPlaceholderReferenceToken(" NONE ")).toBe(true);
    expect(isPlaceholderReferenceToken("pm-none")).toBe(false);
  });

  it("validates missing parent references under warn and strict policies", () => {
    expect(validateMissingParentReference("pm-parent", "warn")).toEqual({
      warnings: ["validation_warning:parent_reference_missing:pm-parent"],
    });
    expect(() => validateMissingParentReference("pm-parent", "strict_error")).toThrow(
      'Parent item "pm-parent" was not found',
    );
  });

  it("rejects self-parent references after id normalization", () => {
    expect(() => assertParentReferenceIsNotSelf("pm-child", "pm-parent", "pm-")).not.toThrow();
    expect(() => assertParentReferenceIsNotSelf("pm-self", "pm-self", "pm-")).toThrow(
      'Parent item "pm-self" cannot be the same as item "pm-self". Use --unset parent to clear this field.',
    );
    expect(() => assertParentReferenceIsNotSelf("PM-SELF", "self", "pm-")).toThrow(
      'Parent item "pm-self" cannot be the same as item "pm-self" (normalized from parent "self" and item "PM-SELF")',
    );
  });

  it("normalizes sprint/release policies and validates values", () => {
    expect(normalizeSprintReleaseFormatPolicy(" warn ")).toBe("warn");
    expect(normalizeSprintReleaseFormatPolicy("strict-error")).toBe("strict_error");
    expect(normalizeSprintReleaseFormatPolicy("strict")).toBe("strict_error");
    expect(() => normalizeSprintReleaseFormatPolicy(undefined)).toThrow("sprint-release-format-policy requires --policy");

    expect(validateSprintOrReleaseValue("sprint", "  Sprint/2026.06  ", "strict_error")).toEqual({
      value: "Sprint/2026.06",
      warnings: [],
    });
    expect(() => validateSprintOrReleaseValue("release", " ", "warn")).toThrow("--release must not be empty");
    expect(validateSprintOrReleaseValue("release", "bad release", "warn")).toEqual({
      value: "bad release",
      warnings: ["validation_warning:release_format:bad release"],
    });
    expect(() => validateSprintOrReleaseValue("sprint", "bad sprint", "strict_error")).toThrow(
      'Invalid --sprint value "bad sprint"',
    );
  });
});

describe("item document format edge cases", () => {
  const metadata = buildItemMetadata({ id: "pm-format", title: "Format coverage" });

  it("parses legacy JSON markdown wrappers and serializes empty bodies compactly", () => {
    const warnings: string[] = [];
    const parsed = parseItemDocument(
      [
        "---",
        "legacy: yaml",
        "---",
        JSON.stringify({ ...metadata, tags: ["format"] }, null, 2),
        "",
        "Body after front matter",
      ].join("\n"),
      { format: "json_markdown", onWarning: (warning) => warnings.push(warning) },
    );

    expect(warnings).toEqual(["json_markdown_leading_yaml_frontmatter_ignored"]);
    expect(parsed.metadata.id).toBe("pm-format");
    expect(parsed.body).toBe("Body after front matter");
    expect(serializeItemDocument({ metadata, body: "" }, { format: "json_markdown" })).not.toContain("\n\n");
  });

  it("rejects malformed JSON front matter and accepts escaped braces in JSON strings", () => {
    const valid = parseItemDocument(`${JSON.stringify({ ...metadata, title: 'Escaped } brace " quote' })}\nBody`, {
      format: "json_markdown",
    });
    expect(valid.metadata.title).toBe('Escaped } brace " quote');
    expect(valid.body).toBe("Body");

    expect(() => parseItemDocument('{"id":"pm-bad"', { format: "json_markdown" })).toThrow(
      "JSON front matter is not valid JSON",
    );
    expect(() => parseItemDocument("not front matter", { format: "json_markdown" })).toThrow("missing JSON front matter");
    expect(() => parseItemDocument("not toon", { format: "toon" })).toThrow("TOON item document must be an object");
    expect(() => parseItemDocument("---\nlegacy: yaml\n", { format: "json_markdown" })).toThrow("missing JSON front matter");
  });

  it("rejects missing or malformed JSON front matter before metadata validation", () => {
    expect(splitFrontMatter("plain body")).toEqual({ frontMatter: "", body: "plain body" });
    expect(splitFrontMatter('{"id":"pm-open"')).toEqual({ frontMatter: "", body: '{"id":"pm-open"' });
    expect(splitFrontMatter('{"id":"pm-open"}\nbody')).toEqual({ frontMatter: '{"id":"pm-open"}', body: "body" });
    expect(() => parseItemDocument('{"id":"pm-open"', { format: "json_markdown" })).toThrow(
      "JSON front matter is not valid JSON",
    );
    expect(() => parseItemDocument("{bad}\nbody", { format: "json_markdown" })).toThrow(
      "JSON front matter is not valid JSON",
    );
    expect(() => parseItemDocument("body only", { format: "json_markdown" })).toThrow("missing JSON front matter");
  });

  it("parses legacy TOON front_matter wrappers and rejects merge conflict markers", () => {
    const parsed = parseItemDocument(
      [
        "front_matter:",
        '  id: "pm-wrapper"',
        '  title: "Wrapped"',
        '  description: ""',
        '  type: "Task"',
        '  status: "open"',
        "  priority: 1",
        "  tags: []",
        '  created_at: "2026-05-25T00:00:00.000Z"',
        '  updated_at: "2026-05-25T00:00:00.000Z"',
        'body: "wrapped body"',
      ].join("\n"),
      { format: "toon" },
    );

    expect(parsed.metadata.id).toBe("pm-wrapper");
    expect(parsed.body).toBe("wrapped body");
    expect(() => parseItemDocument("front_matter: [", { format: "toon" })).toThrow("front matter must be an object");
    expect(() => parseItemDocument("<<<<<<< HEAD\nid: pm-conflict\n", { format: "toon" })).toThrow(
      "Merge conflict markers detected",
    );
  });

  it("validates optional calendar, reminder, issue, and type option fields", () => {
    const document = serializeItemDocument(
      {
        metadata: {
          ...metadata,
          confidence: "med",
          severity: "med",
          regression: true,
          deadline: "2026-06-20T10:00:00.000Z",
          reminders: [
            { at: "2026-06-19T10:00:00.000Z", text: " remind " },
            { at: "2026-06-18T10:00:00.000Z", text: "prep" },
          ],
          events: [
            {
              start_at: "2026-06-20T09:00:00.000Z",
              end_at: "2026-06-20T10:00:00.000Z",
              title: " Review ",
              all_day: false,
              recurrence: {
                freq: "WEEKLY",
                interval: 2,
                by_weekday: ["fri", "mon", "fri"],
                by_month_day: [20, 1, 20],
                exdates: ["2026-07-04T09:00:00.000Z", "2026-07-04T09:00:00.000Z"],
              },
            },
          ],
          source_type: "github",
          type_options: { channel: "release" },
        },
        body: "body",
      },
      { format: "json_markdown" },
    );

    const parsed = parseItemDocument(document, { format: "json_markdown" });
    expect(parsed.metadata.confidence).toBe("medium");
    expect(parsed.metadata.severity).toBe("medium");
    expect(parsed.metadata.reminders?.map((reminder) => reminder.text)).toEqual(["prep", "remind"]);
    expect(parsed.metadata.events?.[0]?.recurrence).toMatchObject({
      freq: "weekly",
      interval: 2,
      by_weekday: ["mon", "fri"],
      by_month_day: [1, 20],
      exdates: ["2026-07-04T09:00:00.000Z"],
    });

    expect(() =>
      parseItemDocument(JSON.stringify({ ...metadata, confidence: 101 }), { format: "json_markdown" }),
    ).toThrow("confidence number value must be an integer 0..100");
    expect(() =>
      parseItemDocument(JSON.stringify({ ...metadata, severity: "urgent" }), { format: "json_markdown" }),
    ).toThrow("severity value must be one of");
    expect(() =>
      parseItemDocument(JSON.stringify({ ...metadata, regression: "yes" }), { format: "json_markdown" }),
    ).toThrow("regression must be a boolean");
    expect(() =>
      parseItemDocument(JSON.stringify({ ...metadata, events: [{ start_at: "2026-06-20T10:00:00.000Z", end_at: "2026-06-20T09:00:00.000Z" }] }), {
        format: "json_markdown",
      }),
    ).toThrow("event.end_at must be after event.start_at");
    expect(() =>
      parseItemDocument(JSON.stringify({ ...metadata, reminders: [{ at: "nope", text: "x" }] }), { format: "json_markdown" }),
    ).toThrow("reminder.at must be a valid ISO timestamp");
    expect(() =>
      parseItemDocument(JSON.stringify({ ...metadata, type_options: { " ": "x" } }), { format: "json_markdown" }),
    ).toThrow("type_options keys must be non-empty");
  });

  it("applies runtime schema coercion, required fields, and unknown field policies", () => {
    const schema = normalizeRuntimeSchemaSettings({
      unknown_field_policy: "warn",
      fields: [
        {
          key: "estimate",
          label: "Estimate",
          type: "number",
          applies_to: ["Task"],
          required: true,
          required_types: ["Task"],
        },
        {
          key: "customer",
          label: "Customer",
          type: "string",
          applies_to: ["Task"],
        },
      ],
    });
    const warnings: string[] = [];
    const parsed = parseItemDocument(
      JSON.stringify({ ...metadata, estimate: "3", customer: " Acme ", extra_runtime: true }),
      {
        format: "json_markdown",
        schema,
        extensionFieldNames: ["extension_owned"],
        onWarning: (warning) => warnings.push(warning),
      },
    );

    expect(parsed.metadata.estimate).toBe(3);
    expect(parsed.metadata.customer).toBe(" Acme ");
    expect(warnings).toEqual(["item_unknown_schema_fields:extra_runtime"]);

    expect(() => parseItemDocument(JSON.stringify(metadata), { format: "json_markdown", schema })).toThrow(
      "missing required schema field: estimate",
    );

    const rejectSchema = normalizeRuntimeSchemaSettings({
      ...schema,
      unknown_field_policy: "reject",
    });
    expect(() =>
      parseItemDocument(JSON.stringify({ ...metadata, estimate: 1, z_unknown: true }), {
        format: "json_markdown",
        schema: rejectSchema,
      }),
    ).toThrow("unknown schema fields are not allowed: z_unknown");
  });

  it("sorts rejected runtime schema fields and rejects invalid TOON documents", () => {
    const rejectSchema = normalizeRuntimeSchemaSettings({
      unknown_field_policy: "reject",
      fields: [],
    });
    expect(() =>
      parseItemDocument(JSON.stringify({ ...metadata, z_unknown: true, a_unknown: true }), {
        format: "json_markdown",
        schema: rejectSchema,
      }),
    ).toThrow("unknown schema fields are not allowed: a_unknown, z_unknown");
    expect(() => parseItemDocument("front_matter: [", { format: "toon" })).toThrow("front matter must be an object");
  });
});
