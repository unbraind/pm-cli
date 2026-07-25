import { describe, expect, it } from "vitest";
import { parseItemDocument } from "../../../../src/core/item/item-format.js";
import { PmCliError } from "../../../../src/core/shared/errors.js";

describe("item document structured SDK errors", () => {
  it("classifies TOON syntax and document-shape failures without misleading field prose", () => {
    for (const content of ["  not: [a valid: toon", "not_an_item: true"]) {
      expect(() => parseItemDocument(content)).toThrowError(
        expect.objectContaining<PmCliError>({
          code: "item_document_invalid",
          context: expect.objectContaining({
            code: "item_document_invalid",
            reason: "syntax_error",
            format: "toon",
          }),
        }),
      );
    }
  });

  it("classifies missing required metadata with a bounded field hint", () => {
    expect(() => parseItemDocument("id: pm-a\ntitle: Example\n")).toThrowError(
      expect.objectContaining<PmCliError>({
        code: "item_document_invalid",
        context: expect.objectContaining({
          code: "item_document_invalid",
          reason: "missing_required_field",
          field: "description",
        }),
      }),
    );
  });

  it("omits a misleading field hint when validation identifies the document rather than a field", () => {
    let thrown: unknown;
    try {
      parseItemDocument("[]");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PmCliError);
    expect((thrown as PmCliError).context).not.toHaveProperty("field");
  });

  it("classifies JSON Markdown syntax separately from schema validation", () => {
    expect(() =>
      parseItemDocument("{ invalid", { format: "json_markdown" }),
    ).toThrowError(
      expect.objectContaining<PmCliError>({
        context: expect.objectContaining({
          reason: "syntax_error",
          format: "json_markdown",
        }),
      }),
    );
    expect(() =>
      parseItemDocument('{"id":"pm-a"}', { format: "json_markdown" }),
    ).toThrowError(
      expect.objectContaining<PmCliError>({
        context: expect.objectContaining({
          reason: "missing_required_field",
          field: "title",
        }),
      }),
    );
  });

  it("preserves the dedicated merge-conflict discriminator", () => {
    expect(() =>
      parseItemDocument("<<<<<<< HEAD\nid: pm-a\n=======\n>>>>>>> branch"),
    ).toThrowError(
      expect.objectContaining<PmCliError>({
        code: "merge_conflict_markers_detected",
        context: expect.objectContaining({
          code: "merge_conflict_markers_detected",
          reason: "merge_conflict",
        }),
      }),
    );
  });
});
