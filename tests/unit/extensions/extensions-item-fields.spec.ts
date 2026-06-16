import { describe, expect, it } from "vitest";
import {
  applyRegisteredItemFieldDefaultsAndValidation,
  parseRegisteredItemFieldAssignments,
} from "../../../src/core/extensions/item-fields.js";
import { createEmptyExtensionRegistrationRegistry, type ExtensionRegistrationRegistry } from "../../../src/core/extensions/loader.js";

function withFields(fields: Array<Record<string, unknown>>): ExtensionRegistrationRegistry {
  const registrations = createEmptyExtensionRegistrationRegistry();
  registrations.item_fields.push({
    layer: "project",
    name: "test-extension",
    fields,
  });
  return registrations;
}

describe("extensions item field runtime wiring", () => {
  it("applies defaults and validates values when registrations are present", () => {
    const frontMatter: Record<string, unknown> = {};
    applyRegisteredItemFieldDefaultsAndValidation(
      frontMatter,
      withFields([
        { name: "team", type: "string", default: "platform" },
        { name: "size", type: "number", default: 3 },
      ]),
    );
    expect(frontMatter).toEqual({
      team: "platform",
      size: 3,
    });
  });

  it("does nothing when registrations are absent", () => {
    const frontMatter: Record<string, unknown> = {};
    applyRegisteredItemFieldDefaultsAndValidation(frontMatter, null);
    expect(frontMatter).toEqual({});
  });

  it("parses declared extension field assignments with typed values", () => {
    const parsed = parseRegisteredItemFieldAssignments(
      [
        "text_value=hello",
        "number_value=42",
        "boolean_value=yes",
        "array_value=[\"a\",\"b\"]",
        "object_value={\"key\":\"value\"}",
      ],
      withFields([
        { name: "text_value", type: "string" },
        { name: "number_value", type: "number" },
        { name: "boolean_value", type: "boolean" },
        { name: "array_value", type: "array" },
        { name: "object_value", type: "object" },
      ]),
    );

    expect(parsed).toEqual({
      text_value: "hello",
      number_value: 42,
      boolean_value: true,
      array_value: ["a", "b"],
      object_value: { key: "value" },
    });
  });

  it("rejects undeclared and invalid typed extension field assignments", () => {
    const registrations = withFields([
      { name: "count", type: "number" },
      { name: "enabled", type: "boolean" },
      { name: "payload", type: "object" },
    ]);

    expect(() => parseRegisteredItemFieldAssignments(["missing=value"], registrations)).toThrow(
      "--field missing is not declared",
    );
    expect(() => parseRegisteredItemFieldAssignments(["count=NaN"], registrations)).toThrow("must be a number");
    expect(() => parseRegisteredItemFieldAssignments(["count=   "], registrations)).toThrow("must be a number");
    expect(() => parseRegisteredItemFieldAssignments(["enabled=maybe"], registrations)).toThrow("true|false");
    expect(() => parseRegisteredItemFieldAssignments(["payload=not-json"], registrations)).toThrow("valid JSON object");
  });

  it("rejects assignments missing the name=value separator", () => {
    expect(() =>
      parseRegisteredItemFieldAssignments(["=value"], withFields([{ name: "count", type: "number" }])),
    ).toThrow("--field entries must use name=value syntax");
  });

  it("rejects conflicting extension field types for the same field name", () => {
    expect(() =>
      parseRegisteredItemFieldAssignments(
        ["github_number=7"],
        withFields([
          { name: "github_number", type: "number" },
          { name: "github_number", type: "string" },
        ]),
      ),
    ).toThrow('Extension item field "github_number" is declared with conflicting types: number, string');

    expect(() =>
      applyRegisteredItemFieldDefaultsAndValidation(
        {},
        withFields([
          { name: "github_number", type: "number" },
          { name: "github_number", type: "string" },
        ]),
      ),
    ).toThrow('Extension item field "github_number" is declared with conflicting types: number, string');
  });

  it("accepts supported field types", () => {
    const frontMatter: Record<string, unknown> = {
      text_value: "ok",
      number_value: 1,
      boolean_value: true,
      array_value: ["a"],
      object_value: { key: "value" },
    };
    applyRegisteredItemFieldDefaultsAndValidation(
      frontMatter,
      withFields([
        { name: "text_value", type: "string" },
        { name: "number_value", type: "number" },
        { name: "boolean_value", type: "boolean" },
        { name: "array_value", type: "array" },
        { name: "object_value", type: "object" },
      ]),
    );
    expect(frontMatter.object_value).toEqual({ key: "value" });
  });

  it("throws for type mismatch and allowed value mismatch", () => {
    expect(() =>
      applyRegisteredItemFieldDefaultsAndValidation(
        { ext_severity: "high" },
        withFields([{ name: "ext_severity", type: "number" }]),
      ),
    ).toThrow('Item field "ext_severity" must be of type number');

    expect(() =>
      applyRegisteredItemFieldDefaultsAndValidation(
        { ext_status: "blocked" },
        withFields([{ name: "ext_status", type: "string", values: ["open", "closed"] }]),
      ),
    ).toThrow('Item field "ext_status" must match one of the configured allowed values');
  });

  it("rejects extension field names that collide with reserved metadata", () => {
    expect(() =>
      parseRegisteredItemFieldAssignments(["id=pm-other"], withFields([{ name: "id", type: "string" }])),
    ).toThrow('Extension item field "id" collides with reserved item metadata');

    expect(() =>
      applyRegisteredItemFieldDefaultsAndValidation(
        {},
        withFields([{ name: "updated_at", type: "string", default: "2026-01-01T00:00:00.000Z" }]),
      ),
    ).toThrow('Extension item field "updated_at" collides with reserved item metadata');
  });

  it("skips invalid field names and unknown field types", () => {
    const frontMatter: Record<string, unknown> = { tracked: 42 };
    applyRegisteredItemFieldDefaultsAndValidation(
      frontMatter,
      withFields([
        { name: "   ", default: "ignored" },
        { name: "tracked", type: "nonsense-type" },
      ]),
    );
    expect(frontMatter).toEqual({ tracked: 42 });
  });

  it("clones cloneable defaults and preserves non-cloneable defaults", () => {
    const objectDefault = { nested: { value: 1 } };
    const functionDefault = () => "fallback";
    const frontMatter: Record<string, unknown> = {};
    applyRegisteredItemFieldDefaultsAndValidation(
      frontMatter,
      withFields([
        { name: "object_default", default: objectDefault },
        { name: "function_default", default: functionDefault },
      ]),
    );

    expect(frontMatter.object_default).toEqual({ nested: { value: 1 } });
    expect(frontMatter.object_default).not.toBe(objectDefault);
    expect(frontMatter.function_default).toBe(functionDefault);
  });
});
