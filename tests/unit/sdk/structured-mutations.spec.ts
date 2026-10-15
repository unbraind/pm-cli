import { describe, expect, it, vi } from "vitest";
import { PmCliError } from "../../../src/core/shared/errors.js";
import { SETTINGS_DEFAULTS } from "../../../src/core/shared/constants.js";
import { resolveRuntimeFieldRegistry } from "../../../src/core/schema/runtime-schema.js";
import {
  deriveMutationTransactionId,
  itemDocumentToMutationOptions,
  parseAtomicMutationControls,
  parseItemMutationBatch,
  resolveItemMutationDocument,
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
    ).toThrow("lockTtlSeconds must be a positive safe integer");
    expect(() => parseAtomicMutationControls({ lockWaitMs: false })).toThrow(
      "lockWaitMs must be a positive safe integer",
    );
    for (const invalid of [" ", 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() =>
        parseAtomicMutationControls({ lockTtlSeconds: invalid }),
      ).toThrow("lockTtlSeconds must be a positive safe integer");
    }
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
              id: " pm-done ",
              reason: " Done ",
              options: { force: true },
            },
          ],
        }),
      ),
    ).toEqual([
      { op: "close", id: "pm-done", reason: "Done", options: { force: true } },
    ]);
  });

  it("resolves stable batch-local aliases and forward references", () => {
    const first = resolveItemMutationDocument(
      JSON.stringify({
        schema_version: 1,
        mutations: [
          {
            op: "create",
            ref: "roadmap",
            options: { title: "Roadmap", type: "Epic" },
          },
          {
            op: "create",
            ref: "delivery",
            options: {
              title: "Delivery",
              type: "Feature",
              parent: "@roadmap",
              dep: ["id=@roadmap,kind=implements"],
            },
          },
          {
            op: "update",
            id: "@roadmap",
            options: { blockedBy: "@delivery" },
          },
        ],
      }),
      { transactionId: "specification-42", idPrefix: "work-" },
    );
    const second = resolveItemMutationDocument(
      JSON.stringify({
        mutations: [
          {
            op: "create",
            ref: "roadmap",
            options: { title: "Roadmap", type: "Epic" },
          },
        ],
      }),
      { transactionId: "specification-42", idPrefix: "work-" },
    );

    expect(first.references).toEqual({
      roadmap: expect.stringMatching(/^work-[a-z0-9]{12}$/u),
      delivery: expect.stringMatching(/^work-[a-z0-9]{12}$/u),
    });
    expect(second.references.roadmap).toBe(first.references.roadmap);
    expect(first.mutations).toEqual([
      expect.objectContaining({ op: "create", id: first.references.roadmap }),
      expect.objectContaining({
        op: "create",
        id: first.references.delivery,
        options: expect.objectContaining({
          parent: first.references.roadmap,
          dep: [`id=${first.references.roadmap},kind=implements`],
        }),
      }),
      expect.objectContaining({
        op: "update",
        id: first.references.roadmap,
        options: expect.objectContaining({
          blockedBy: first.references.delivery,
        }),
      }),
    ]);
  });

  it("rejects malformed, duplicate, unknown, and misplaced batch references", () => {
    const options = { transactionId: "specification-42", idPrefix: "pm-" };
    expect(() =>
      resolveItemMutationDocument(
        '[{"op":"create","ref":"Bad Alias","options":{}}]',
        options,
      ),
    ).toThrow("must match");
    expect(() =>
      resolveItemMutationDocument(
        '[{"op":"create","ref":"same","options":{}},{"op":"create","ref":"same","options":{}}]',
        options,
      ),
    ).toThrow("Duplicate mutation ref");
    expect(() =>
      resolveItemMutationDocument(
        '[{"op":"update","ref":"wrong","id":"pm-a","options":{}}]',
        options,
      ),
    ).toThrow("only valid for create");
    expect(() =>
      resolveItemMutationDocument(
        '[{"op":"create","ref":"child","options":{"parent":"@missing"}}]',
        options,
      ),
    ).toThrow('Unknown mutation reference "@missing"');
    expect(() =>
      resolveItemMutationDocument(
        '[{"op":"create","ref":"child","options":{"dep":"id=@missing,kind=implements"}}]',
        options,
      ),
    ).toThrow('Unknown mutation reference "@missing"');
    expect(() =>
      resolveItemMutationDocument(
        '[{"op":"create","ref":"child","options":{"dep":"id=@Bad,kind=implements"}}]',
        options,
      ),
    ).toThrow("Malformed mutation reference");
    expect(() =>
      resolveItemMutationDocument(
        '[{"op":"create","ref":"a","id":"pm-same","options":{}},{"op":"create","ref":"b","id":"pm-same","options":{}}]',
        options,
      ),
    ).toThrow("Duplicate resolved create id");
    expect(() =>
      resolveItemMutationDocument(
        '[{"op":"create","ref":"missing-options"}]',
        options,
      ),
    ).toThrow("requires an options object");
    expect(() =>
      resolveItemMutationDocument(
        '[{"op":"create","ref":"a","options":{"parent":"@b"}},{"op":"create","ref":"b","options":{"blockedBy":"@a"}}]',
        options,
      ),
    ).toThrow("Mutation reference cycle");
    expect(() =>
      resolveItemMutationDocument(
        '{"schema_version":2,"mutations":[{"op":"create","id":"pm-a","options":{}}]}',
        options,
      ),
    ).toThrow("schema_version must be 1");
    expect(() => resolveItemMutationDocument("null", options)).toThrow(
      "must be a JSON array or object",
    );
    expect(() =>
      resolveItemMutationDocument(
        '{"schema_version":1,"mutations":[],"extra":true}',
        options,
      ),
    ).toThrow("does not recognize key");
    expect(() =>
      resolveItemMutationDocument('{"schema_version":1,"mutations":[]}', options),
    ).toThrow("non-empty mutations array");
    expect(() =>
      resolveItemMutationDocument('{"schema_version":1,"mutations":"bad"}', options),
    ).toThrow("non-empty mutations array");
    expect(() =>
      resolveItemMutationDocument('{"schema_version":1,"mutations":[null]}', options),
    ).toThrow("Mutation 1 must be an object");
    expect(() =>
      resolveItemMutationDocument(
        '{"schema_version":1,"mutations":[{"op":"create","id":"pm-a","unknown":true,"options":{}}]}',
        options,
      ),
    ).toThrow("does not recognize key");
  });

  it("resolves scalar dependency references and traverses converging alias graphs", () => {
    const resolved = resolveItemMutationDocument(
      JSON.stringify({
        schema_version: 1,
        mutations: [
          { op: "create", ref: "root", options: { title: "Root" } },
          {
            op: "create",
            ref: "left",
            options: { title: "Left", parent: "@root" },
          },
          {
            op: "create",
            ref: "right",
            options: { title: "Right", parent: "@root" },
          },
          {
            op: "create",
            ref: "leaf",
            options: {
              title: "Leaf",
              parent: "@left",
              blockedBy: "@right",
              dep: "id=@root,kind=implements",
            },
          },
          { op: "release", id: "@leaf", options: { force: true } },
          { op: "release", id: "@right" },
        ],
      }),
      { transactionId: "converging", idPrefix: "pm-" },
    );
    expect(resolved.mutations.at(-2)).toEqual({
      op: "release",
      id: resolved.references.leaf,
      options: { force: true },
    });
    expect(resolved.mutations.at(-1)).toEqual({
      op: "release",
      id: resolved.references.right,
    });
    expect(resolved.mutations[3]?.options).toMatchObject({
      dep: `id=${resolved.references.root},kind=implements`,
    });
  });

  it("preserves non-string dependency entries for downstream SDK validation", () => {
    expect(
      resolveItemMutationDocument(
        '[{"op":"create","ref":"root","options":{"title":"Root","dep":[42]}}]',
        { transactionId: "bad-dependency", idPrefix: "pm-" },
      ).mutations[0]?.options,
    ).toMatchObject({ dep: [42] });
  });

  it("normalizes explicit referenced ids through the workspace prefix", () => {
    const resolved = resolveItemMutationDocument(
      '[{"op":"create","ref":"root","id":"ROOT","options":{"title":"Root"}}]',
      { transactionId: "explicit-id", idPrefix: "work-" },
    );
    expect(resolved.references).toEqual({ root: "work-root" });
    expect(resolved.mutations[0]?.id).toBe("work-root");
  });

  it("resolves aliases that match Object prototype property names", () => {
    const resolved = resolveItemMutationDocument(
      JSON.stringify({
        mutations: [
          {
            op: "create",
            ref: "constructor",
            options: { title: "Prototype-safe parent" },
          },
          {
            op: "create",
            ref: "child",
            options: { title: "Prototype-safe child", parent: "@constructor" },
          },
        ],
      }),
      { transactionId: "prototype-safe", idPrefix: "pm-" },
    );

    expect(resolved.references.constructor).toMatch(/^pm-[a-z0-9]{12}$/u);
    expect(resolved.references.child).toMatch(/^pm-[a-z0-9]{12}$/u);
    expect(resolved.mutations[1]?.options).toMatchObject({
      parent: resolved.references.constructor,
    });
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
    ).toThrow("must be create, update, close, or release");
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
    expect(parseItemMutationBatch('[{"op":"release","id":"pm-a"}]')).toEqual([
      { op: "release", id: "pm-a" },
    ]);
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
      tags: '["agent","json"]',
      dep: ["id=pm-parent,kind=related"],
      file: ["path=src/index.ts,scope=project,note=implementation"],
    });

    expect(
      itemDocumentToMutationOptions(
        JSON.stringify({
          title: "Imported terminal item",
          type: "Task",
          status: "closed",
          close_reason: "Delivered upstream",
          completed_at: "2025-12-31T23:59:00.000Z",
        }),
        "create",
      ),
    ).toMatchObject({
      closeReason: "Delivered upstream",
      completedAt: "2025-12-31T23:59:00.000Z",
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
        'custom_one={"nested":true}',
        'custom_two=quoted,field',
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
    expect(envelope).not.toHaveProperty("completedAt");

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

  it("routes declared metadata keys through schema option names and merges explicit extension overrides", () => {
    const fields = resolveRuntimeFieldRegistry({
      ...SETTINGS_DEFAULTS.schema,
      fields: [
        { key: "classification", metadata_key: "escape_class", cli_flag: "class", cli_aliases: ["category"], type: "string" },
        { key: "payload", type: "array" },
      ],
    }).definitions;
    expect(itemDocumentToMutationOptions(
      JSON.stringify({ escape_class: "document", payload: [1, { nested: true }], custom_one: "kept", custom_two: "document" }),
      "create",
      { category: "flag", field: ["custom_two=flag"] },
      fields,
    )).toMatchObject({
      classification: "flag",
      payload: '[1,{"nested":true}]',
      field: ["custom_one=kept", "custom_two=document", "custom_two=flag"],
    });
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
    for (const key of ["comments", "notes", "learnings"]) {
      try {
        itemDocumentToMutationOptions(JSON.stringify({ [key]: null }), "update");
        throw new Error("Expected malformed annotation array to be refused.");
      } catch (error) {
        expect(error).toBeInstanceOf(PmCliError);
        expect(error).toMatchObject({
          exitCode: 2,
          message: expect.stringContaining(`${key} must be an array`),
        });
      }
    }
    expect(() => itemDocumentToMutationOptions("[]", "create")).toThrow(
      "must be a JSON object",
    );
  });
});

describe("bulk creation documents (pm-gh1456)", () => {
  const options = { transactionId: "import-1", idPrefix: "pm-" };
  const runtimeFields = resolveRuntimeFieldRegistry({
    ...SETTINGS_DEFAULTS.schema,
    fields: [{ key: "external_id", type: "string", commands: ["create", "update"] }],
  }).definitions;

  it("derives a stable transaction id from the exact document bytes", () => {
    const first = deriveMutationTransactionId('[{"title":"A","type":"Task"}]');
    expect(first).toMatch(/^mutate-[0-9a-f]{24}$/u);
    expect(deriveMutationTransactionId('[{"title":"A","type":"Task"}]')).toBe(first);
    expect(deriveMutationTransactionId('[{"title":"B","type":"Task"}]')).not.toBe(first);
  });

  it("accepts JSON Lines, single records, and op-less create documents with synthesized refs", () => {
    const resolved = resolveItemMutationDocument(
      [
        '{"title":"First","type":"Task","tags":["import"]}',
        "",
        '{"ref":"second","title":"Second","type":"Feature","parent":"@row-1"}',
        '{"op":"update","id":"@second","options":{"addTags":["linked"]}}',
      ].join("\n"),
      options,
    );
    expect(resolved.rows).toEqual([
      { index: 0, ref: "row-1", id: expect.stringMatching(/^pm-[a-z0-9]{12}$/u), op: "create" },
      { index: 1, ref: "second", id: expect.stringMatching(/^pm-[a-z0-9]{12}$/u), op: "create" },
      { index: 2, id: resolved.references.second, op: "update" },
    ]);
    expect(resolved.mutations[0]).toMatchObject({
      op: "create",
      id: resolved.references["row-1"],
      options: { title: "First", type: "Task", tags: '["import"]' },
    });
    expect(resolved.mutations[1]).toMatchObject({
      op: "create",
      options: { title: "Second", type: "Feature", parent: resolved.references["row-1"] },
    });
    const single = resolveItemMutationDocument('{"title":"Only","type":"Task"}', options);
    expect(single.mutations).toHaveLength(1);
    expect(single.rows[0]).toMatchObject({ index: 0, ref: "row-1", op: "create" });
    const itemRow = resolveItemMutationDocument('[{"op":"create","ref":"doc","item":{"title":"Doc","type":"Task"}}]', options);
    expect(itemRow.mutations[0]).toMatchObject({ op: "create", options: { title: "Doc", type: "Task" } });
  });

  it("routes declared schema fields through their option targets and admits them in options rows", () => {
    const resolved = resolveItemMutationDocument(
      '{"title":"Keyed","type":"Task","external_id":"ext-1"}',
      { ...options, runtimeFields },
    );
    expect(resolved.mutations[0]).toMatchObject({ options: { externalId: "ext-1" } });
    expect(
      resolveItemMutationDocument(
        '[{"op":"create","ref":"a","options":{"title":"Keyed","type":"Task","externalId":"ext-2"}}]',
        { ...options, runtimeFields },
      ).mutations[0],
    ).toMatchObject({ options: { externalId: "ext-2" } });
    expect(() =>
      resolveItemMutationDocument(
        '[{"op":"create","ref":"a","options":{"title":"Keyed","type":"Task","externalId":"ext-2"}}]',
        options,
      ),
    ).toThrow('does not recognize key "externalId"');
    expect(() =>
      resolveItemMutationDocument(
        '[{"op":"close","id":"pm-a","reason":"done","options":{"externalId":"x"}}]',
        { ...options, runtimeFields },
      ),
    ).toThrow('does not recognize key "externalId"');
  });

  it("reports malformed JSON Lines by line number and refuses mixed row shapes", () => {
    expect(() =>
      resolveItemMutationDocument('{"title":"ok","type":"Task"}\n{not json', options),
    ).toThrow("Mutation document line 2 must be one valid JSON object");
    expect(() =>
      resolveItemMutationDocument('{"title":"ok","type":"Task"}\n[1]', options),
    ).toThrow("Mutation document line 2 must be a JSON object");
    expect(() => resolveItemMutationDocument("{not json", options)).toThrow("must be valid JSON");
    expect(() =>
      resolveItemMutationDocument('[{"op":"create","ref":"a","item":{"title":"x"},"options":{"title":"y"}}]', options),
    ).toThrow("either item or options, not both");
    expect(() =>
      resolveItemMutationDocument('[{"op":"update","id":"pm-a","item":{"title":"x"}}]', options),
    ).toThrow("only valid for create operations");
    expect(() =>
      resolveItemMutationDocument('[{"item":{"title":"x","type":"Task"},"title":"stray"}]', options),
    ).toThrow("must not mix item document keys");
    expect(() =>
      resolveItemMutationDocument('[{"item":"not-an-object"}]', options),
    ).toThrow("item document must be an object");
    expect(() =>
      resolveItemMutationDocument('[{"op":"create","ref":"a","unknown":1}]', options),
    ).toThrow('does not recognize key "unknown"');
  });

  it("turns keyed create rows into updates of the one matching existing item", () => {
    const upsert = {
      key: "external_id",
      existing: [
        { id: "pm-existing", value: "ext-1" },
        { id: "pm-other", value: "ext-9" },
        { id: "pm-blank", value: null },
      ],
    };
    const resolved = resolveItemMutationDocument(
      [
        '{"title":"Renamed","type":"Task","external_id":"ext-1","tags":["sync"]}',
        '{"title":"Fresh","type":"Task","external_id":"ext-2"}',
        '{"op":"create","ref":"opt","options":{"title":"Option row","type":"Task","field":["external_id=ext-9"]}}',
        '{"op":"create","ref":"child","options":{"title":"Child of upsert","type":"Task","parent":"@opt","externalId":"ext-3"}}',
      ].join("\n"),
      { ...options, runtimeFields, upsert },
    );
    expect(resolved.rows).toEqual([
      { index: 0, ref: "row-1", id: "pm-existing", op: "update", upserted: true },
      { index: 1, ref: "row-2", id: expect.any(String), op: "create" },
      { index: 2, ref: "opt", id: "pm-other", op: "update", upserted: true },
      { index: 3, ref: "child", id: expect.any(String), op: "create" },
    ]);
    // A later row may still address the upserted record by its alias, which now names the matched item.
    expect(resolved.mutations[3]).toMatchObject({ op: "create", options: { parent: "pm-other" } });
    expect(resolved.mutations[0]).toMatchObject({
      op: "update",
      id: "pm-existing",
      options: { title: "Renamed", externalId: "ext-1", tags: '["sync"]' },
    });
    expect(resolved.mutations[0]).not.toHaveProperty("options.documentAnnotationSnapshot");
    // Rows that matched nothing carry the key for the lock-held re-check; matched rows do not.
    expect(resolved.mutations[0]).not.toHaveProperty("unique");
    expect(resolved.mutations[1]).toMatchObject({ op: "create", unique: { key: "external_id", value: "ext-2" } });
    expect(resolved.mutations[3]).toMatchObject({ op: "create", unique: { key: "external_id", value: "ext-3" } });
    expect(resolved.mutations[2]).toMatchObject({ op: "update", id: "pm-other", options: { title: "Option row" } });
    expect(resolved.references).toMatchObject({ "row-1": "pm-existing", opt: "pm-other" });
  });

  it("accepts a unique guard only on create rows that carry a key and a value", () => {
    expect(() =>
      resolveItemMutationDocument('[{"op":"update","id":"pm-a","options":{"title":"x"},"unique":{"key":"k","value":1}}]', options),
    ).toThrow("unique is only valid for create operations");
    expect(() =>
      resolveItemMutationDocument('[{"op":"create","ref":"a","options":{"title":"x","type":"Task"},"unique":{"key":" ","value":1}}]', options),
    ).toThrow("unique must be an object with a non-empty key and a value");
    expect(() =>
      resolveItemMutationDocument('[{"op":"create","ref":"a","options":{"title":"x","type":"Task"},"unique":"k"}]', options),
    ).toThrow("unique must be an object");
    expect(() =>
      resolveItemMutationDocument('[{"op":"create","ref":"a","options":{"title":"x","type":"Task"},"unique":{"key":"k","value":null}}]', options),
    ).toThrow("unique must be an object");
    const explicit = resolveItemMutationDocument(
      '[{"op":"create","ref":"a","options":{"title":"x","type":"Task"},"unique":{"key":" external_id ","value":"ext-1"}}]',
      options,
    );
    expect(explicit.mutations[0]).toMatchObject({ unique: { key: "external_id", value: "ext-1" } });
  });

  it("refuses missing, duplicate, and ambiguous upsert keys before any write", () => {
    const base = { ...options, runtimeFields };
    expect(() =>
      resolveItemMutationDocument('{"title":"No key","type":"Task"}', {
        ...base,
        upsert: { key: "external_id", existing: [] },
      }),
    ).toThrow('missing the upsert key "external_id"');
    expect(() =>
      resolveItemMutationDocument(
        '{"title":"A","type":"Task","external_id":"dup"}\n{"title":"B","type":"Task","external_id":"dup"}',
        { ...base, upsert: { key: "external_id", existing: [] } },
      ),
    ).toThrow("share the upsert key value");
    try {
      resolveItemMutationDocument('{"title":"A","type":"Task","external_id":"twice"}', {
        ...base,
        upsert: {
          key: "external_id",
          existing: [
            { id: "pm-one", value: "twice" },
            { id: "pm-two", value: "twice" },
          ],
        },
      });
      throw new Error("Expected an ambiguous upsert key to be refused.");
    } catch (error) {
      expect(error).toBeInstanceOf(PmCliError);
      expect(error).toMatchObject({
        exitCode: 4,
        context: { code: "upsert_key_ambiguous" },
        message: expect.stringContaining("matches 2 existing items: pm-one, pm-two"),
      });
    }
    expect(() =>
      resolveItemMutationDocument('{"title":"A","type":"Task"}', {
        ...base,
        upsert: { key: "  ", existing: [] },
      }),
    ).toThrow("Upsert key must be a non-empty field name");
  });

  it("covers non-Error line parse failures, explicit document ids, numeric upsert keys, and upsert without runtime fields", () => {
    const parse = vi.spyOn(JSON, "parse");
    parse.mockImplementationOnce(() => { throw "whole-document"; }).mockImplementationOnce(() => { throw "line-one"; });
    expect(() => resolveItemMutationDocument('{"a":1}\n{"b":2}', options)).toThrow("line 1 must be one valid JSON object: Unknown failure");
    parse.mockRestore();
    const explicit = resolveItemMutationDocument('{"id":"pm-explicit","title":"Explicit","type":"Task"}', options);
    expect(explicit.mutations[0]).toMatchObject({ op: "create", id: "pm-explicit" });
    expect(explicit.rows[0]).toEqual({ index: 0, id: "pm-explicit", op: "create" });
    const numeric = resolveItemMutationDocument(
      '[{"op":"create","ref":"n","options":{"title":"Numeric","type":"Task","priority":2}}]',
      { ...options, upsert: { key: "priority", existing: [{ id: "pm-prio", value: 2 }] } },
    );
    expect(numeric.rows).toEqual([{ index: 0, ref: "n", id: "pm-prio", op: "update", upserted: true }]);
    // An explicit-id create row carries no alias, so a keyed match records nothing for later @ref rows.
    const explicitUpsert = resolveItemMutationDocument(
      '{"id":"pm-explicit","title":"Explicit","type":"Task","priority":2}',
      { ...options, upsert: { key: "priority", existing: [{ id: "pm-prio", value: 2 }] } },
    );
    expect(explicitUpsert.rows).toEqual([{ index: 0, id: "pm-prio", op: "update", upserted: true }]);
    expect(Object.keys(explicitUpsert.references)).toEqual([]);
    // Object-valued keys match on content, not on key insertion order.
    const objectKeyed = resolveItemMutationDocument(
      '{"op":"create","ref":"o","options":{"title":"Object keyed","type":"Task","meta":{"b":[1,{"d":1,"c":2}],"a":2}}}',
      { ...options, upsert: { key: "meta", existing: [{ id: "pm-object", value: { a: 2, b: [1, { c: 2, d: 1 }] } }] } },
    );
    expect(objectKeyed.rows).toEqual([{ index: 0, ref: "o", id: "pm-object", op: "update", upserted: true }]);
    expect(numeric.mutations[0]).toMatchObject({ op: "update", options: { title: "Numeric", priority: 2 } });
  });

  it("matches upsert keys through camel-case option targets and refuses rows that carry no document or options", () => {
    const resolved = resolveItemMutationDocument(
      '[{"op":"create","ref":"camel","options":{"title":"Camel","type":"Task","externalId":"ext-camel"}}]',
      { ...options, runtimeFields, upsert: { key: "external_id", existing: [{ id: "pm-camel", value: "ext-camel" }] } },
    );
    expect(resolved.rows).toEqual([{ index: 0, ref: "camel", id: "pm-camel", op: "update", upserted: true }]);
    expect(resolved.mutations[0]).toMatchObject({ options: { title: "Camel", externalId: "ext-camel" } });
    const mixed = resolveItemMutationDocument(
      '[{"op":"update","id":"pm-a","options":{"title":"Untouched"}},{"title":"Keyed","type":"Task","external_id":"ext-k"}]',
      { ...options, runtimeFields, upsert: { key: "external_id", existing: [] } },
    );
    expect(mixed.rows).toEqual([
      { index: 0, id: "pm-a", op: "update" },
      { index: 1, ref: "row-2", id: expect.any(String), op: "create" },
    ]);
    expect(() =>
      resolveItemMutationDocument('[{"op":"create","ref":"bare"}]', {
        ...options,
        upsert: { key: "external_id", existing: [] },
      }),
    ).toThrow("missing the upsert key");
  });

  it("never matches the ids this document itself would create, so a committed import replays as the same plan", () => {
    const first = resolveItemMutationDocument('{"title":"Own","type":"Task","external_id":"own-1"}', { ...options, runtimeFields });
    const ownId = first.rows[0]!.id;
    const replay = resolveItemMutationDocument('{"title":"Own","type":"Task","external_id":"own-1"}', {
      ...options,
      runtimeFields,
      upsert: { key: "external_id", existing: [{ id: ownId, value: "own-1" }] },
    });
    expect(replay.rows).toEqual([{ index: 0, ref: "row-1", id: ownId, op: "create" }]);
    const explicit = resolveItemMutationDocument('[{"op":"create","id":"pm-fixed","options":{"title":"Fixed","type":"Task","externalId":"fixed-1"}}]', {
      ...options,
      runtimeFields,
      upsert: { key: "external_id", existing: [{ id: "pm-fixed", value: "fixed-1" }, { id: "pm-other", value: "other" }] },
    });
    expect(explicit.rows).toEqual([{ index: 0, id: "pm-fixed", op: "create" }]);
  });
});
