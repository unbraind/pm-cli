import { describe, expect, it, vi } from "vitest";
import {
  itemDocumentToMutationOptions,
  parseAtomicMutationControls,
  parseItemMutationBatch,
  validateItemMutationRows,
} from "../../../src/sdk/structured-mutations.js";

describe("structured mutation input", () => {
  it("normalizes shared atomic controls and rejects invalid transport values", () => {
    expect(parseAtomicMutationControls({})).toEqual({});
    expect(
      parseAtomicMutationControls({
        createCompensation: "delete",
        lockTtlSeconds: "45",
        lockWaitMs: 900,
      }),
    ).toEqual({
      createCompensation: "delete",
      lockTtlSeconds: 45,
      lockWaitMs: 900,
    });
    expect(() =>
      parseAtomicMutationControls({ createCompensation: "archive" }),
    ).toThrow("must be close or delete");
    expect(() =>
      parseAtomicMutationControls({ lockTtlSeconds: "not-a-number" }),
    ).toThrow("lockTtlSeconds must be a finite number");
    expect(() => parseAtomicMutationControls({ lockWaitMs: false })).toThrow(
      "lockWaitMs must be a finite number",
    );
  });

  it("parses array and envelope batches without weakening operation types", () => {
    expect(
      parseItemMutationBatch(
        JSON.stringify([
          {
            op: "create",
            id: "pm-new",
            options: { title: "New", type: "Task" },
          },
          { op: "update", id: "pm-old", options: { priority: "1" } },
          { op: "close", id: "pm-done", reason: "Done" },
        ]),
      ),
    ).toHaveLength(3);
    expect(
      parseItemMutationBatch(
        JSON.stringify({
          mutations: [
            {
              op: "close",
              id: "pm-done",
              reason: "Done",
              options: { force: true },
            },
          ],
        }),
      ),
    ).toEqual([
      { op: "close", id: "pm-done", reason: "Done", options: { force: true } },
    ]);
  });

  it("rejects malformed JSON, rows, keys, operations, ids, reasons, and options", () => {
    expect(() => parseItemMutationBatch("{")).toThrow("must be valid JSON");
    vi.spyOn(JSON, "parse").mockImplementationOnce(() => {
      throw "non-error parser failure";
    });
    expect(() => parseItemMutationBatch("[]")).toThrow(
      "non-error parser failure",
    );
    expect(() => parseItemMutationBatch("{}")).toThrow("non-empty JSON array");
    expect(() => parseItemMutationBatch("[null]")).toThrow("must be an object");
    expect(() => parseItemMutationBatch("[1]")).toThrow("must be an object");
    expect(() =>
      parseItemMutationBatch('[{"opp":"create","id":"pm-a","options":{}}]'),
    ).toThrow('Did you mean "op"');
    expect(() =>
      parseItemMutationBatch('[{"op":"remove","id":"pm-a","options":{}}]'),
    ).toThrow("must be create, update, or close");
    expect(() =>
      parseItemMutationBatch('[{"op":"create","id":"","options":{}}]'),
    ).toThrow("requires a non-empty id");
    expect(() =>
      parseItemMutationBatch('[{"op":"create","id":"pm-a"}]'),
    ).toThrow("requires an options object");
    expect(() =>
      parseItemMutationBatch('[{"op":"update","id":"pm-a","options":[]}]'),
    ).toThrow("options must be an object");
    expect(() =>
      parseItemMutationBatch(
        '[{"op":"update","id":"pm-a","options":{"prioritty":"1"}}]',
      ),
    ).toThrow('Did you mean "priority"');
    expect(() =>
      parseItemMutationBatch('[{"op":"close","id":"pm-a"}]'),
    ).toThrow("requires a non-empty reason");
    expect(() =>
      parseItemMutationBatch(
        '[{"op":"close","id":"pm-a","reason":"done","options":{"forse":true}}]',
      ),
    ).toThrow('Did you mean "force"');
    expect(() =>
      parseItemMutationBatch(
        '[{"op":"create","id":"pm-a","options":{"completelyUnknown":true}}]',
      ),
    ).toThrow("Allowed keys");
    expect(
      validateItemMutationRows([
        { op: "update", id: "pm-a", options: { title: "A" } },
      ]),
    ).toHaveLength(1);
    const nullPrototypeOptions = Object.assign(Object.create(null), {
      title: "Null prototype",
    }) as Record<string, unknown>;
    expect(
      validateItemMutationRows([
        { op: "update", id: "pm-a", options: nullPrototypeOptions },
      ]),
    ).toHaveLength(1);
    expect(() =>
      parseItemMutationBatch(
        '[{"op":"update","id":"pm-a","options":{"descriptio":"x"}}]',
      ),
    ).toThrow('Did you mean "description"');
    expect(() =>
      parseItemMutationBatch(
        '[{"op":"update","id":"pm-a","options":{"tipe":"x"}}]',
      ),
    ).toThrow('Did you mean "type"');
    expect(() =>
      validateItemMutationRows([
        { op: "update", id: "pm-a", options: null },
      ] as never),
    ).toThrow("options must be an object");
    expect(() =>
      validateItemMutationRows([
        { op: "update", id: "pm-a", options: new Date() },
      ] as never),
    ).toThrow("options must be an object");
  });

  it("normalizes direct and get-envelope item documents with explicit flag precedence", () => {
    const direct = itemDocumentToMutationOptions(
      JSON.stringify({
        id: "pm-new",
        title: "From document",
        type: "Feature",
        priority: 2,
        tags: ["agent", "json"],
        dependencies: [{ id: "pm-parent", kind: "related" }],
        files: [
          { path: "src/index.ts", scope: "project", note: "implementation" },
        ],
      }),
      "create",
      { title: "Flag wins" },
    );
    expect(direct).toMatchObject({
      id: "pm-new",
      title: "Flag wins",
      type: "Feature",
      priority: "2",
      tags: "agent,json",
      dep: ["id=pm-parent,kind=related"],
      file: ["path=src/index.ts,scope=project,note=implementation"],
    });

    const rich = itemDocumentToMutationOptions(
      JSON.stringify({
        title: "Rich",
        acceptance_criteria: "Covered",
        regression: false,
        custom_one: { nested: true },
        custom_two: "quoted,field",
        comments: [{ text: 'said "yes"\non two lines', author: "agent" }],
        notes: [{ text: "note" }],
        learnings: [{ text: "learning" }],
        tests: [{ command: "pnpm test", timeout_seconds: 30 }],
        docs: [{ path: "docs/SDK.md" }],
        reminders: [{ at: "2026-07-21", text: "review" }],
        events: [{ start_at: "2026-07-21", title: "review" }],
        type_options: [{ key: "lane", value: "sdk" }],
      }),
      "create",
      { regression: undefined, message: "explicit" },
    );
    expect(rich).toMatchObject({
      acceptanceCriteria: "Covered",
      regression: "false",
      message: "explicit",
      field: expect.arrayContaining([
        'key=custom_one,value="{\\"nested\\":true}"',
        'key=custom_two,value="quoted,field"',
      ]),
      comment: ['text="said \\"yes\\"\\non two lines",author=agent'],
      note: ["text=note"],
      learning: ["text=learning"],
      test: ["command=pnpm test,timeout_seconds=30"],
      doc: ["path=docs/SDK.md"],
      reminder: ["at=2026-07-21,text=review"],
      event: ["start_at=2026-07-21,title=review"],
      typeOption: ["key=lane,value=sdk"],
    });

    const envelope = itemDocumentToMutationOptions(
      JSON.stringify({
        item: {
          id: "pm-existing",
          title: "Existing",
          description: "Updated",
          author: "original",
          created_at: "2026-01-01T00:00:00.000Z",
          comments: [
            {
              text: "Already persisted",
              author: "original",
              created_at: "2026-01-01T00:00:00.000Z",
            },
            { text: "New annotation", author: "agent" },
          ],
        },
        linked: { docs: [{ path: "docs/SDK.md", scope: "project" }] },
        claim_state: { claimed: false },
      }),
      "update",
    );
    expect(envelope).toMatchObject({
      title: "Existing",
      description: "Updated",
      comment: ["text=New annotation,author=agent"],
      doc: ["path=docs/SDK.md,scope=project"],
    });
    expect(envelope).not.toHaveProperty("id");
    expect(envelope).not.toHaveProperty("author");

    const flatUpdate = itemDocumentToMutationOptions(
      JSON.stringify({
        title: "Flat",
        comments: [
          { text: "Persisted", created_at: "2026-01-01T00:00:00.000Z" },
          { text: "New" },
        ],
        notes: [{ text: "Persisted note", created_at: "2026-01-01" }],
        learnings: [{ text: "New learning" }],
      }),
      "update",
    );
    expect(flatUpdate).toMatchObject({
      comment: ["text=New"],
      learning: ["text=New learning"],
    });
    expect(flatUpdate).not.toHaveProperty("note");
  });

  it("rejects misspelled envelope and item keys and invalid facet arrays", () => {
    const nullPrototypeDocument = Object.assign(Object.create(null), {
      title: "Null prototype",
    }) as Record<string, unknown>;
    vi.spyOn(JSON, "parse").mockReturnValueOnce(nullPrototypeDocument);
    expect(itemDocumentToMutationOptions("{}", "create")).toMatchObject({
      title: "Null prototype",
    });
    vi.spyOn(JSON, "parse").mockReturnValueOnce(new Date());
    expect(() => itemDocumentToMutationOptions("{}", "create")).toThrow(
      "must be a JSON object",
    );
    expect(() => itemDocumentToMutationOptions('{"itm":{}}', "update")).toThrow(
      'Did you mean "item"',
    );
    expect(() =>
      itemDocumentToMutationOptions('{"titel":"bad"}', "create"),
    ).toThrow('Did you mean "title"');
    expect(() =>
      itemDocumentToMutationOptions('{"files":"bad"}', "create"),
    ).toThrow("files must be an array");
    expect(() =>
      itemDocumentToMutationOptions('{"tests":["bad"]}', "create"),
    ).toThrow("tests must be an array of objects");
    expect(() =>
      itemDocumentToMutationOptions('{"item":{},"unexpected":true}', "update"),
    ).toThrow("item envelope does not recognize key");
    expect(() =>
      itemDocumentToMutationOptions('{"item":[]}', "update"),
    ).toThrow("item must be an object");
    expect(() => itemDocumentToMutationOptions("[]", "create")).toThrow(
      "must be a JSON object",
    );
  });
});
