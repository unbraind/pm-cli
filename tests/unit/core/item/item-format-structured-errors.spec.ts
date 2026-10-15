import { describe, expect, it } from "vitest";
import { parseItemDocument, serializeItemDocument } from "../../../../src/core/item/item-format.js";
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

describe("item document text well-formedness (Sentry PM-CLI-3H)", () => {
  const FIXED_TS = "2026-10-15T00:00:00.000Z";
  function document(overrides: Record<string, unknown>) {
    return {
      metadata: {
        id: "pm-1",
        title: "Title",
        status: "open",
        priority: "P2",
        type: "Task",
        created_at: FIXED_TS,
        updated_at: FIXED_TS,
        tags: [],
        dependencies: [],
        links: [],
        test_links: [],
        comments: [],
        notes: [],
        history_events: [],
        ...overrides,
      },
      body: "",
    } as never;
  }

  it("refuses a lone surrogate with a typed usage error naming the field and index instead of a TOON TypeError", () => {
    const truncatedEmoji = `Imported ${"x".repeat(230)}\uD83D`;
    expect(() => serializeItemDocument(document({ description: truncatedEmoji }))).toThrowError(
      expect.objectContaining<PmCliError>({
        exitCode: 2,
        context: expect.objectContaining({ code: "text_unpaired_surrogate", field: "description" }),
        message: expect.stringContaining("index 239"),
      }),
    );
    expect(() =>
      serializeItemDocument(document({ comments: [{ created_at: FIXED_TS, author: "a", text: "\uDC00 low first" }] })),
    ).toThrowError(expect.objectContaining<PmCliError>({ context: expect.objectContaining({ field: "comments[0].text" }) }));
    // The non-TOON format persists the same text and refuses it the same way, in metadata and in the body.
    expect(() => serializeItemDocument(document({ description: truncatedEmoji }), { format: "json_markdown" })).toThrowError(
      expect.objectContaining<PmCliError>({ context: expect.objectContaining({ code: "text_unpaired_surrogate", field: "description" }) }),
    );
    expect(() => serializeItemDocument({ ...document(), body: "body \uD83D" }, { format: "json_markdown" })).toThrowError(
      expect.objectContaining<PmCliError>({ context: expect.objectContaining({ code: "text_unpaired_surrogate", field: "body" }) }),
    );
    expect(serializeItemDocument({ ...document(), body: "well-formed 😀" }, { format: "json_markdown" })).toContain("well-formed 😀");
  });

  it("scans extension values at any depth and object keys", () => {
    const deep = { l1: { l2: { l3: { l4: { l5: { l6: { l7: { l8: "deep \uD83D" } } } } } } } };
    const extension = { extensionFieldNames: ["payload"] };
    expect(() => serializeItemDocument(document({ payload: deep }), extension)).toThrowError(
      expect.objectContaining<PmCliError>({ context: expect.objectContaining({ code: "text_unpaired_surrogate", field: "payload.l1.l2.l3.l4.l5.l6.l7.l8" }) }),
    );
    expect(() => serializeItemDocument(document({ payload: { ["bad\uDC00key"]: "value" } }), extension)).toThrowError(
      expect.objectContaining<PmCliError>({ context: expect.objectContaining({ field: "payload.bad\uDC00key (key)" }) }),
    );
    expect(() => serializeItemDocument(document({ payload: { list: ["ok", { inner: "\uD83D" }] } }), extension)).toThrowError(
      expect.objectContaining<PmCliError>({ context: expect.objectContaining({ field: "payload.list[1].inner" }) }),
    );
  });

  it("keeps whole emoji and astral characters encodable", () => {
    expect(serializeItemDocument(document({ description: "Ship it 🚀 \u{1F600}" }))).toContain("Ship it");
  });
});
