import { describe, expect, it } from "vitest";
import { formatBuiltInOutput } from "../../../src/core/output/output.js";
import {
  formatCommanderErrorForDisplay,
  formatCommanderErrorForJson,
} from "../../../src/cli/error-guidance.js";
import { attachReadOutputContracts } from "../../../src/sdk/context-intent-contracts.js";
import {
  projectPmBriefListEnvelope,
  projectPmBriefSearchEnvelope,
} from "../../../src/sdk/output.js";

const completeList = {
  items: ["one", "two", "three"].map((title, index) => ({
    id: `pm-${index}`,
    status: "open",
    type: "Task",
    title,
  })),
  count: 3,
  total: 3,
  has_more: false,
  truncated: false,
  next_cursor: null,
  completeness: {
    status: "complete",
    unreadable_item_count: 0,
    unreadable_directory_count: 0,
  },
  filters: { runtime_filters: {} },
  projection: { mode: "brief", fields: ["id", "status", "type", "title"] },
  sorting: { sort: "default", order: "asc" },
  now: "2026-09-13T00:00:00Z",
  omission_receipt: {
    has_omissions: true,
    omitted_field_group_count: 1,
    omitted_field_groups: [
      { name: "full_item_fields", restore_with: "--full" },
    ],
  },
};

describe("compact agent presentation", () => {
  it.each([
    null,
    [],
    {},
    { ...completeList, items: null },
    { ...completeList, projection: null },
    {
      ...completeList,
      projection: { mode: "brief", fields: "id,status,type,title" },
    },
    { ...completeList, projection: { mode: "brief", fields: ["id"] } },
    { ...completeList, projection: { mode: "brief", fields: ["id", "status", "type", "title", "deadline"] } },
    {
      ...completeList,
      projection: { ...completeList.projection, evidence: "keep" },
    },
    { ...completeList, completeness: null },
    {
      ...completeList,
      completeness: {
        ...completeList.completeness,
        status: { toString: () => "complete" },
      },
    },
    {
      ...completeList,
      completeness: { ...completeList.completeness, status: "partial" },
    },
    { ...completeList, has_more: undefined },
    { ...completeList, truncated: true },
    { ...completeList, count: 2 },
    { ...completeList, total: "3" },
    { ...completeList, total: 3.5 },
    { ...completeList, total: 4 },
    { ...completeList, next_cursor: "unexpected" },
    { ...completeList, has_more: true, truncated: true },
    { ...completeList, total: 4, has_more: true, truncated: true },
    {
      ...completeList,
      total: 4,
      has_more: true,
      truncated: true,
      next_cursor: "",
    },
    { ...completeList, omission_receipt: null },
    {
      ...completeList,
      omission_receipt: {
        ...completeList.omission_receipt,
        omitted_field_groups: null,
      },
    },
    {
      ...completeList,
      omission_receipt: {
        ...completeList.omission_receipt,
        omitted_field_groups: [],
      },
    },
    {
      ...completeList,
      omission_receipt: {
        ...completeList.omission_receipt,
        omitted_field_groups: [null],
      },
    },
    {
      ...completeList,
      omission_receipt: {
        ...completeList.omission_receipt,
        omitted_field_groups: [{ name: "full_item_fields" }],
      },
    },
    {
      ...completeList,
      omission_receipt: {
        ...completeList.omission_receipt,
        omitted_field_groups: [
          { name: "full_item_fields", restore_with: "other" },
        ],
      },
    },
    {
      ...completeList,
      omission_receipt: {
        ...completeList.omission_receipt,
        has_omissions: false,
      },
    },
    {
      ...completeList,
      omission_receipt: {
        ...completeList.omission_receipt,
        omitted_field_group_count: 2,
      },
    },
    {
      ...completeList,
      omission_receipt: { ...completeList.omission_receipt, evidence: "keep" },
    },
  ])("leaves unsupported or inconsistent SDK envelopes intact: %j", (value) => {
    expect(projectPmBriefListEnvelope(value)).toBe(value);
  });

  it("preserves producer metadata and does not mutate the input SDK receipt", () => {
    const value = structuredClone(completeList);
    const before = structuredClone(value);
    expect(projectPmBriefListEnvelope(value)).toMatchObject({
      details: "--full",
    });
    expect(value).toEqual(before);
    const source = {
      ...completeList.completeness,
      evidence: "provider evidence",
    };
    const sort = { ...completeList.sorting, evidence: "sort evidence" };
    expect(
      projectPmBriefListEnvelope({
        ...value,
        completeness: source,
        sorting: sort,
      }),
    ).toMatchObject({
      completeness: { status: "complete", evidence: "provider evidence" },
      sorting: sort,
    });
    expect(
      projectPmBriefListEnvelope({ ...value, sorting: null }),
    ).toMatchObject({ sorting: null });
    expect(
      projectPmBriefListEnvelope({
        ...value,
        sorting: { sort: "default", order: "desc" },
      }),
    ).toMatchObject({ sorting: { sort: "default", order: "desc" } });
    expect(
      projectPmBriefListEnvelope({
        ...value,
        items: [],
        count: 0,
        total: 0,
        completeness: { ...value.completeness, status: "unchecked" },
      }),
    ).toMatchObject({
      items: [],
      count: 0,
      total: 0,
      has_more: false,
      completeness: { status: "unchecked" },
    });
    expect(
      projectPmBriefListEnvelope({
        ...value,
        total: 4,
        has_more: true,
        truncated: true,
        next_cursor: "next",
      }),
    ).toMatchObject({
      completeness: { status: "complete" },
      next_cursor: "next",
    });
  });

  it("compacts bounded unchecked brief lists while retaining honest source and continuation evidence", () => {
    const value = {
      ...completeList,
      total: 12,
      applied_limit: 3,
      has_more: true,
      truncated: true,
      next_cursor: "continue-after-three",
      completeness: { ...completeList.completeness, status: "unchecked" },
      filters: { status: "open", limit: "3" },
    };
    const text = formatBuiltInOutput(value, "toon");
    expect(text).toContain('status: "unchecked"');
    expect(text).toContain('next_cursor: "continue-after-three"');
    expect(text).toContain("total: 12");
    expect(text).toContain("has_more: true");
    expect(text).not.toContain("projection:");
    expect(text).not.toContain("sorting:");
    expect(text).not.toContain("now:");
    expect(text).not.toContain("unreadable_item_count: 0");
    expect(text).toContain('details: "--full"');
    expect(JSON.parse(formatBuiltInOutput(value, "json"))).toEqual(value);
  });

  it("renders nested search facts in a declared table without changing JSON", () => {
    const value = {
      query: "test",
      items: Array.from({ length: 10 }, (_, index) => ({
        id: `pm-${index}`,
        title: "Preserve facts",
        matched_fields: ["title", "notes"],
      })),
    };
    expect(formatBuiltInOutput(value, "toon")).toContain(
      "items[10]{id,title,matched_fields}",
    );
    expect(JSON.parse(formatBuiltInOutput(value, "json"))).toEqual(value);
  });

  it.each(["json", "toon"] as const)(
    "enforces the context legacy budget on its complete %s envelope",
    (format) => {
      const value = {
        high_level: [],
        low_level: [{ id: "pm-a", title: "Short" }],
        agenda: {
          events: Array.from({ length: 10 }, (_, i) => ({
            id: `event-${i}`,
            description: "Envelope fact ".repeat(20),
          })),
        },
      };
      const result = attachReadOutputContracts(
        "context",
        { tokenBudget: 800, resolvedOutputFormat: format },
        value,
      );
      const estimated = Math.ceil(
        Buffer.byteLength(formatBuiltInOutput(result, format)) / 4,
      );
      expect(estimated).toBeLessThanOrEqual(800);
      expect(result).toMatchObject({
        read_output: { estimated_tokens: estimated, within_budget: true },
      });
    },
  );
  it("renders complete brief lists in six lines and retains full JSON receipts", () => {
    const text = formatBuiltInOutput(completeList, "toon");
    expect(text.trim().split("\n")).toHaveLength(6);
    expect(text).toContain("--full");
    const json = formatBuiltInOutput(completeList, "json");
    expect(JSON.parse(json)).toEqual(completeList);
    expect(json.trim().split("\n")).toHaveLength(1);
    expect(Buffer.byteLength(json)).toBeLessThan(Buffer.byteLength(JSON.stringify(completeList, null, 2)));
    const nonList = { projection: { mode: "brief" }, items: { id: "single-item" } };
    expect(formatBuiltInOutput(nonList, "json")).toBe(`${JSON.stringify(nonList, null, 2)}\n`);
    const emptyLean = formatBuiltInOutput({ ...completeList, items: [], count: 0, total: 0 }, "json", true);
    expect(emptyLean.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(emptyLean)).not.toHaveProperty("items");
  });

  it.each([
    { has_more: true, truncated: true, next_cursor: "next" },
    { completeness: { status: "partial", unreadable_item_count: 1 } },
    { projection: { mode: "full", fields: null } },
    {
      completeness: {
        status: "complete",
        unreadable_item_count: 1,
        unreadable_directory_count: 0,
      },
    },
    {
      completeness: {
        status: "complete",
        unreadable_item_count: 0,
        unreadable_directory_count: 1,
      },
    },
    { count: 2 },
    { total: 4 },
    {
      omission_receipt: {
        omitted_field_groups: [{ name: "additional", restore_with: "--full" }],
      },
    },
  ])(
    "retains detailed receipts for non-default or incomplete output %j",
    (changes) => {
      expect(
        formatBuiltInOutput({ ...completeList, ...changes }, "toon"),
      ).toContain("completeness:");
    },
  );

  it("keeps selected filters, sorting, warnings, and extra producer diagnostics", () => {
    const output = formatBuiltInOutput(
      {
        ...completeList,
        filters: { status: "open" },
        sorting: { sort: "title", order: "desc" },
        warnings: ["source warning"],
        evidence: "retained",
      },
      "toon",
    );
    expect(output).toContain('status: "open"');
    expect(output).toContain('sort: "title"');
    expect(output).toContain('evidence: "retained"');
    expect(output).toContain("source warning");
  });

  it("preserves producer-owned details instead of replacing them with a recovery pointer", () => {
    const output = formatBuiltInOutput(
      { ...completeList, details: { provider: "extension diagnostic" } },
      "toon",
    );
    expect(output).toContain("extension diagnostic");
    expect(output).toContain("completeness:");
  });

  it("echoes long missing-id arguments once in text while preserving structured recovery", () => {
    const value = "a long description with meaningful context";
    const context = {
      attemptedCommand: `pm update --description '${value}'`,
      normalizedInvocationArgs: ["update", "--description", value],
    };
    const text = formatCommanderErrorForDisplay(
      "missing required argument 'id'",
      "update",
      "Task",
      context,
    );
    expect(text.split(value)).toHaveLength(2);
    const json = formatCommanderErrorForJson(
      "missing required argument 'id'",
      "update",
      "Task",
      2,
      context,
    );
    expect(json.recovery?.normalized_args).toEqual(
      context.normalizedInvocationArgs,
    );
  });
});

const searchPage = {
  query: "release workflow",
  mode: "hybrid",
  items: [
    { id: "pm-a", title: "A", matched_fields: ["title"] },
    { id: "pm-b", title: "B", matched_fields: ["title", "body"] },
  ],
  count: 2,
  total: 9,
  applied_limit: 2,
  has_more: true,
  truncated: true,
  next_cursor: "next",
  filters: { limit: "2" },
  omission_receipt: {
    has_omissions: true,
    omitted_field_group_count: 1,
    omitted_field_groups: [{ name: "projection_metadata", restore_with: "--full" }],
  },
};

describe("GH-1642 brief search and list envelopes", () => {
  it("drops the repeated pagination alias, limit echo and default omission receipt from a search page", () => {
    const before = structuredClone(searchPage);
    expect(projectPmBriefSearchEnvelope(searchPage)).toEqual({
      query: "release workflow",
      mode: "hybrid",
      items: searchPage.items,
      count: 2,
      total: 9,
      applied_limit: 2,
      has_more: true,
      next_cursor: "next",
      details: "--full",
    });
    expect(searchPage).toEqual(before);
    const text = formatBuiltInOutput(searchPage, "toon");
    expect(text).not.toContain("truncated:");
    expect(text).not.toContain("omission_receipt:");
    expect(text).not.toContain("filters:");
    expect(text).toContain('details: "--full"');
    expect(Buffer.byteLength(text)).toBeLessThan(Buffer.byteLength(formatBuiltInOutput({ ...searchPage, details: { keep: true } }, "toon")));
    expect(JSON.parse(formatBuiltInOutput(searchPage, "json"))).toEqual(searchPage);
  });

  it("keeps filters that carry information and drops only limit echoes and empty runtime filters", () => {
    expect((projectPmBriefSearchEnvelope({ ...searchPage, filters: { type: "Task", limit: "2" } }) as Record<string, unknown>).filters).toEqual({ type: "Task" });
    expect(projectPmBriefSearchEnvelope({ ...searchPage, filters: { limit: "5" } })).toMatchObject({ filters: { limit: "5" } });
    expect(projectPmBriefSearchEnvelope({ ...searchPage, filters: null })).toMatchObject({ filters: null });
    expect(projectPmBriefSearchEnvelope({ ...searchPage, filters: undefined })).not.toHaveProperty("filters");
    expect(projectPmBriefSearchEnvelope({ ...searchPage, filters: { limit: "2", runtime_filters: {} } })).not.toHaveProperty("filters");
    expect(projectPmBriefSearchEnvelope({ ...searchPage, filters: { runtime_filters: { team: "core" } } })).toMatchObject({ filters: { runtime_filters: { team: "core" } } });
    expect(projectPmBriefSearchEnvelope({ ...searchPage, filters: { runtime_filters: null } })).toMatchObject({ filters: { runtime_filters: null } });
  });

  it("compacts a terminal search page that omits every continuation field", () => {
    const { has_more: _more, truncated: _truncated, next_cursor: _cursor, total: _total, ...rest } = searchPage;
    const terminal = { ...rest, count: 2, applied_limit: 10, filters: { limit: "10" } };
    expect(projectPmBriefSearchEnvelope(terminal)).toEqual({
      query: "release workflow",
      mode: "hybrid",
      items: searchPage.items,
      count: 2,
      applied_limit: 10,
      details: "--full",
    });
    expect(projectPmBriefSearchEnvelope({ ...terminal, total: 2 })).toMatchObject({ total: 2, details: "--full" });
    for (const inconsistent of [{ ...terminal, total: 5 }, { ...terminal, next_cursor: "more" }, { ...terminal, truncated: false }, { ...terminal, count: 3 }]) {
      expect(projectPmBriefSearchEnvelope(inconsistent)).toBe(inconsistent);
    }
  });

  it.each([
    null,
    [],
    { ...searchPage, query: 1 },
    { ...searchPage, items: null },
    { ...searchPage, details: "producer" },
    { ...searchPage, projection: { mode: "full", fields: null } },
    { ...searchPage, truncated: false },
    { ...searchPage, omission_receipt: { ...searchPage.omission_receipt, omitted_field_groups: [{ name: "full_item_fields", restore_with: "--full" }] } },
    { ...searchPage, omission_receipt: { ...searchPage.omission_receipt, omitted_field_group_count: 2 } },
  ])("leaves non-standard search envelopes intact: %j", (value) => {
    expect(projectPmBriefSearchEnvelope(value)).toBe(value);
  });

  it("keeps the effective default order on one line and drops the legacy sort echo and limit echo", () => {
    const value = {
      ...completeList,
      total: 12,
      applied_limit: 3,
      has_more: true,
      truncated: true,
      next_cursor: "continue",
      filters: { status: "open", limit: "3", runtime_filters: {} },
      sorting: { sort: "default", order: "asc", effective_keys: [["priority", "asc"], ["id", "asc"]] },
    };
    const projected = projectPmBriefListEnvelope(value) as Record<string, unknown>;
    expect(projected.sorting).toEqual({ effective_keys: "priority asc, id asc" });
    expect(projected.filters).toEqual({ status: "open" });
    for (const sorting of [
      { ...value.sorting, provider: "keep" },
      { ...value.sorting, effective_keys: "priority" },
      { ...value.sorting, effective_keys: [["priority"]] },
      { ...value.sorting, effective_keys: [["priority", "sideways"]] },
    ]) {
      expect(projectPmBriefListEnvelope({ ...value, sorting })).toMatchObject({ sorting });
    }
    for (const filters of [{ limit: "3" }, { runtime_filters: {} }, { limit: "3", runtime_filters: {} }]) {
      expect(projectPmBriefListEnvelope({ ...value, filters })).not.toHaveProperty("filters");
    }
    expect(projectPmBriefListEnvelope({ ...value, filters: { limit: "9" } })).toMatchObject({ filters: { limit: "9" } });
    const text = formatBuiltInOutput(value, "toon");
    expect(text).toContain('effective_keys: "priority asc, id asc"');
    expect(text).not.toContain('sort: "default"');
    expect(text).toContain('status: "open"');
    expect(JSON.parse(formatBuiltInOutput(value, "json"))).toEqual(value);
  });
});

const fieldsList = {
  ...completeList,
  items: completeList.items.map(({ id, title }) => ({ id, title })),
  total: 12,
  applied_limit: 3,
  has_more: true,
  truncated: true,
  next_cursor: "continue",
  completeness: { status: "unchecked", unreadable_item_count: 0, unreadable_directory_count: 0 },
  filters: { status: "open", limit: "3", fields: "id,title", runtime_filters: {} },
  projection: { mode: "fields", fields: ["id", "title"] },
  sorting: { sort: "default", order: "asc", effective_keys: [["priority", "asc"], ["id", "asc"]] },
};

const fieldsSearchPage = {
  ...searchPage,
  mode_source: "auto",
  items: searchPage.items.map(({ id, title }) => ({ id, title })),
  filters: { limit: "2" },
  projection: { mode: "fields", fields: ["id", "title"] },
  now: "2026-11-06T00:00:00Z",
  omission_receipt: completeList.omission_receipt,
};

describe("GH-1674 fields and compact read envelopes", () => {
  it("gives a --fields list page the lean brief envelope without mutating the SDK result", () => {
    const before = structuredClone(fieldsList);
    expect(projectPmBriefListEnvelope(fieldsList)).toEqual({
      items: fieldsList.items,
      count: 3,
      applied_limit: 3,
      total: 12,
      has_more: true,
      completeness: { status: "unchecked" },
      next_cursor: "continue",
      sorting: { effective_keys: "priority asc, id asc" },
      filters: { status: "open" },
      details: "--full",
    });
    expect(fieldsList).toEqual(before);
    expect(JSON.parse(formatBuiltInOutput(fieldsList, "json"))).toEqual(fieldsList);
  });

  it("gives a --compact list page the same envelope and never makes a narrower projection cost more than brief", () => {
    const compactItems = completeList.items.map((item) => ({ ...item, priority: 1, parent: null, updated_at: "2026-11-06T00:00:00Z" }));
    const compact = { ...fieldsList, items: compactItems, filters: { status: "open", limit: "3" }, projection: { mode: "compact", fields: ["id", "status", "type", "title", "priority", "parent", "updated_at"] } };
    const projected = projectPmBriefListEnvelope(compact) as Record<string, unknown>;
    expect(projected).not.toHaveProperty("projection");
    expect(projected).not.toHaveProperty("truncated");
    expect(projected).not.toHaveProperty("now");
    expect(projected.details).toBe("--full");
    const brief = { ...fieldsList, items: completeList.items, filters: { status: "open", limit: "3" }, projection: completeList.projection };
    const envelopeBytes = (value: Record<string, unknown>, rows: unknown[]): number =>
      Buffer.byteLength(formatBuiltInOutput(value, "toon")) - Buffer.byteLength(formatBuiltInOutput({ items: rows }, "toon"));
    expect(envelopeBytes(fieldsList, fieldsList.items)).toBeLessThanOrEqual(envelopeBytes(brief, brief.items));
    expect(envelopeBytes(compact, compactItems)).toBeLessThanOrEqual(envelopeBytes(brief, brief.items));
  });

  it("keeps a custom field list on an empty page and keeps filters.fields when it differs from the projection", () => {
    const empty = { ...fieldsList, items: [], count: 0, total: 0, has_more: false, truncated: false, next_cursor: null };
    expect(projectPmBriefListEnvelope(empty)).toMatchObject({ projection: { mode: "fields", fields: ["id", "title"] } });
    expect(projectPmBriefListEnvelope({ ...empty, projection: completeList.projection })).not.toHaveProperty("projection");
    for (const fields of ["title,id", "id", "id,title,status", 7]) {
      expect(projectPmBriefListEnvelope({ ...fieldsList, filters: { fields } })).toMatchObject({ filters: { fields } });
    }
    expect(projectPmBriefListEnvelope({ ...fieldsList, filters: { fields: " id , title ," } })).not.toHaveProperty("filters");
  });

  it.each([
    { ...fieldsList, projection: { mode: "full", fields: ["id", "title"] } },
    { ...fieldsList, projection: { mode: "fields", fields: [] } },
    { ...fieldsList, projection: { mode: "fields", fields: ["id", ""] } },
    { ...fieldsList, projection: { mode: "fields", fields: ["id", 7] } },
    { ...fieldsList, projection: { mode: "fields", fields: ["id"] } },
    { ...fieldsList, projection: { mode: "fields", fields: ["id", "status"] } },
    { ...fieldsList, items: [null, ...fieldsList.items.slice(1)] },
    { ...fieldsList, items: [{ ...fieldsList.items[0], extra: true }, ...fieldsList.items.slice(1)] },
  ])("leaves a list page whose projection disagrees with its rows intact: %j", (value) => {
    expect(projectPmBriefListEnvelope(value)).toBe(value);
  });

  it("gives a --fields search page the lean envelope and keeps only a settings-pinned mode source", () => {
    const before = structuredClone(fieldsSearchPage);
    expect(projectPmBriefSearchEnvelope(fieldsSearchPage)).toEqual({
      query: "release workflow",
      mode: "hybrid",
      items: fieldsSearchPage.items,
      count: 2,
      total: 9,
      applied_limit: 2,
      has_more: true,
      next_cursor: "next",
      details: "--full",
    });
    expect(fieldsSearchPage).toEqual(before);
    expect(projectPmBriefSearchEnvelope({ ...fieldsSearchPage, mode_source: "settings" })).toMatchObject({ mode_source: "settings" });
    expect(projectPmBriefSearchEnvelope({ ...fieldsSearchPage, mode_source: "explicit" })).not.toHaveProperty("mode_source");
    expect(projectPmBriefSearchEnvelope({ ...searchPage, mode_source: "settings" })).toMatchObject({ mode_source: "settings" });
    expect(projectPmBriefSearchEnvelope({ ...fieldsSearchPage, filters: { fields: "id,title", type: "Task" } })).toMatchObject({ filters: { type: "Task" } });
    const empty = { ...fieldsSearchPage, items: [], count: 0, total: 0, has_more: false, truncated: false, next_cursor: undefined };
    expect(projectPmBriefSearchEnvelope(empty)).toMatchObject({ projection: { mode: "fields", fields: ["id", "title"] }, details: "--full" });
    expect(projectPmBriefSearchEnvelope(empty)).not.toHaveProperty("now");
    const terminal = { ...fieldsSearchPage, items: [], count: 0, total: undefined, has_more: undefined, truncated: undefined, next_cursor: undefined };
    const { has_more: _more, truncated: _truncated, next_cursor: _cursor, total: _total, ...terminalPage } = terminal;
    expect(projectPmBriefSearchEnvelope(terminalPage)).toMatchObject({ projection: { mode: "fields", fields: ["id", "title"] }, details: "--full" });
    const text = formatBuiltInOutput(fieldsSearchPage, "toon");
    for (const key of ["projection:", "now:", "mode_source:", "truncated:", "omission_receipt:", "filters:"]) expect(text).not.toContain(key);
    expect(JSON.parse(formatBuiltInOutput(fieldsSearchPage, "json"))).toEqual(fieldsSearchPage);
  });

  it.each([
    { ...fieldsSearchPage, projection: { mode: "compact", fields: ["id", "title"] } },
    { ...fieldsSearchPage, projection: { mode: "fields", fields: ["id"] } },
    { ...fieldsSearchPage, now: undefined },
    { ...fieldsSearchPage, omission_receipt: searchPage.omission_receipt },
  ])("leaves a non-standard --fields search page intact: %j", (value) => {
    expect(projectPmBriefSearchEnvelope(value)).toBe(value);
  });
});
