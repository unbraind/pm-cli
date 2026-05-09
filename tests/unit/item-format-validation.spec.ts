import { describe, expect, it } from "vitest";
import { encode as encodeToon } from "@toon-format/toon";
import {
  normalizeFrontMatter,
  parseItemDocument as parseRawItemDocument,
  serializeItemDocument,
  type ItemDocumentFormatOptions,
} from "../../src/core/item/item-format.js";
import { SETTINGS_DEFAULTS } from "../../src/core/shared/constants.js";

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

function runtimeSchemaOverrides(overrides: Record<string, unknown> = {}) {
  return {
    ...SETTINGS_DEFAULTS.schema,
    ...overrides,
  };
}

function parseItemDocument(content: string, options: ItemDocumentFormatOptions = {}) {
  return parseRawItemDocument(content, { format: "json_markdown", ...options });
}

describe("item-format front-matter validation", () => {
  it("parses and normalizes valid front matter", () => {
    const parsed = parseItemDocument(buildSource());
    expect(parsed.metadata.id).toBe("pm-validate");
    expect(parsed.metadata.tags).toEqual(["alpha", "beta"]);
    expect(parsed.body).toBe("Body");
  });

  it("ignores legacy YAML wrappers before JSON front matter", () => {
    const warnings: string[] = [];
    const parsed = parseItemDocument(`\uFEFF---\ntitle: "{legacy-yaml-wrapper}"\n---\n  ${buildSource()}`, {
      onWarning: (warning) => warnings.push(warning),
    });
    expect(parsed.metadata.id).toBe("pm-validate");
    expect(parsed.body).toBe("Body");
    expect(warnings).toEqual(["json_markdown_leading_yaml_frontmatter_ignored"]);
  });

  it("accepts a UTF-8 BOM before JSON front matter without YAML warnings", () => {
    const warnings: string[] = [];
    const parsed = parseItemDocument(`\uFEFF${buildSource()}`, {
      onWarning: (warning) => warnings.push(warning),
    });
    expect(parsed.metadata.id).toBe("pm-validate");
    expect(warnings).toEqual([]);
  });

  it("throws when JSON front matter is missing", () => {
    expect(() => parseItemDocument("Body only")).toThrow("missing JSON front matter");
    expect(() => parseItemDocument("---\nyaml without closing marker")).toThrow("missing JSON front matter");
  });

  it("throws when JSON front matter is malformed", () => {
    expect(() => parseItemDocument("{\n  \"id\": \"pm-validate\"\n")).toThrow("not valid JSON");
    expect(() => parseItemDocument("{ invalid }\n\nBody")).toThrow("not valid JSON");
  });

  it("throws actionable guidance when merge conflict markers are present", () => {
    const conflicted = [
      "<<<<<<< HEAD",
      buildSource({ title: "conflict-left" }, "left body").trimEnd(),
      "=======",
      buildSource({ title: "conflict-right" }, "right body").trimEnd(),
      ">>>>>>> feature/conflict",
      "",
    ].join("\n");
    expect(() => parseItemDocument(conflicted)).toThrow("Merge conflict markers detected in item document at line 1");
  });

  it("throws when required string fields are missing or invalid", () => {
    expect(() => parseItemDocument(buildSource({ title: undefined }))).toThrow("title is required and must be a string");
    expect(() => parseItemDocument(buildSource({ description: 42 }))).toThrow(
      "description is required and must be a string",
    );
  });

  it("throws on invalid type, status, and priority", () => {
    expect(() => parseItemDocument(buildSource({ type: "   " }))).toThrow("type must be a non-empty string");
    expect(() => parseItemDocument(buildSource({ status: "doing" }))).toThrow("status must be one of");
    expect(() => parseItemDocument(buildSource({ priority: 7 }))).toThrow("priority must be an integer 0..4");
  });

  it("accepts in-progress status alias and normalizes to canonical status", () => {
    const parsed = parseItemDocument(buildSource({ status: "in-progress" }));
    expect(parsed.metadata.status).toBe("in_progress");
  });

  it("accepts custom statuses when provided via runtime schema", () => {
    const schema = runtimeSchemaOverrides({
      statuses: [
        { id: "open", roles: ["active", "default_open"] },
        { id: "review", roles: ["active"] },
        { id: "done", roles: ["terminal", "terminal_done", "default_close"] },
        { id: "canceled", roles: ["terminal", "terminal_canceled", "default_cancel"] },
      ],
      workflow: {
        ...SETTINGS_DEFAULTS.schema.workflow,
        open_status: "open",
        close_status: "done",
      },
    });
    const parsed = parseItemDocument(buildSource({ status: "review" }), { schema });
    expect(parsed.metadata.status).toBe("review");
  });

  it("enforces runtime field types for TOON metadata values", () => {
    const schema = runtimeSchemaOverrides({
      fields: [
        {
          key: "story_points",
          type: "number",
          commands: ["create", "update", "list", "search", "calendar", "context"],
        },
      ],
    });
    const source = `${encodeToon({
      id: "pm-toon-schema-field",
      title: "TOON runtime field check",
      description: "Validate schema field coercion",
      type: "Task",
      status: "open",
      priority: 1,
      tags: [],
      created_at: FIXED_TS,
      updated_at: FIXED_TS,
      story_points: "abc",
      body: "Body",
    })}\n`;
    expect(() => parseItemDocument(source, { format: "toon", schema })).toThrow('metadata field "story_points" must be a number');
  });

  it("rejects unknown metadata fields when unknown_field_policy is reject", () => {
    const schema = runtimeSchemaOverrides({
      unknown_field_policy: "reject",
    });
    expect(() => parseItemDocument(buildSource({ mystery_field: "x" }), { schema })).toThrow(
      "unknown schema fields are not allowed: mystery_field",
    );
  });

  it("emits warnings for unknown metadata fields when unknown_field_policy is warn", () => {
    const warnings: string[] = [];
    const schema = runtimeSchemaOverrides({
      unknown_field_policy: "warn",
    });
    const parsed = parseItemDocument(buildSource({ mystery_field: "x" }), {
      schema,
      onWarning: (warning) => warnings.push(warning),
    });
    expect((parsed.metadata as Record<string, unknown>).mystery_field).toBe("x");
    expect(warnings).toEqual(["item_unknown_schema_fields:mystery_field"]);
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

    expect(parsed.metadata.reminders).toEqual([
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

  it("parses and normalizes events and recurrence deterministically", () => {
    const parsed = parseItemDocument(
      buildSource({
        events: [
          {
            start_at: "2026-02-24T10:00:00.000Z",
            title: "  weekly sync  ",
            description: "  team weekly planning  ",
            location: "  room 1  ",
            timezone: "  UTC  ",
            all_day: false,
            recurrence: {
              freq: "WEEKLY",
              interval: 1,
              by_weekday: ["fri", "mon", "fri"],
              by_month_day: [3, 1, 3],
              exdates: ["2026-03-02T10:00:00.000Z", "2026-02-24T10:00:00.000Z"],
            },
          },
          {
            start_at: "2026-02-23T09:00:00.000Z",
            end_at: "2026-02-23T09:30:00.000Z",
            title: "alpha event",
          },
        ],
      }),
    );

    expect(parsed.metadata.events).toEqual([
      {
        start_at: "2026-02-23T09:00:00.000Z",
        end_at: "2026-02-23T09:30:00.000Z",
        title: "alpha event",
      },
      {
        start_at: "2026-02-24T10:00:00.000Z",
        title: "weekly sync",
        description: "team weekly planning",
        location: "room 1",
        timezone: "UTC",
        all_day: false,
        recurrence: {
          freq: "weekly",
          by_weekday: ["mon", "fri"],
          by_month_day: [1, 3],
          exdates: ["2026-02-24T10:00:00.000Z", "2026-03-02T10:00:00.000Z"],
        },
      },
    ]);
  });

  it("sorts event ties by timezone, location, description, and recurrence", () => {
    const baseFrontMatter = {
      id: "pm-event-sort-ties",
      title: "Event tie sort",
      description: "Event tie sort description",
      type: "Task",
      status: "open",
      priority: 1,
      tags: ["calendar"],
      created_at: FIXED_TS,
      updated_at: FIXED_TS,
    };

    const timezoneSorted = normalizeFrontMatter({
      ...baseFrontMatter,
      events: [
        {
          start_at: "2026-02-24T09:00:00.000Z",
          end_at: "2026-02-24T10:00:00.000Z",
          title: "Tie event",
          all_day: false,
          timezone: "Zulu",
          location: "alpha room",
          description: "alpha desc",
          recurrence: { freq: "daily" },
        },
        {
          start_at: "2026-02-24T09:00:00.000Z",
          end_at: "2026-02-24T10:00:00.000Z",
          title: "Tie event",
          all_day: false,
          timezone: "UTC",
          location: "alpha room",
          description: "alpha desc",
          recurrence: { freq: "daily" },
        },
      ],
    });
    expect(timezoneSorted.events?.map((event) => event.timezone)).toEqual(["UTC", "Zulu"]);

    const locationSorted = normalizeFrontMatter({
      ...baseFrontMatter,
      events: [
        {
          start_at: "2026-02-24T09:00:00.000Z",
          end_at: "2026-02-24T10:00:00.000Z",
          title: "Tie event",
          all_day: false,
          timezone: "UTC",
          location: "zeta room",
          description: "alpha desc",
          recurrence: { freq: "daily" },
        },
        {
          start_at: "2026-02-24T09:00:00.000Z",
          end_at: "2026-02-24T10:00:00.000Z",
          title: "Tie event",
          all_day: false,
          timezone: "UTC",
          location: "alpha room",
          description: "alpha desc",
          recurrence: { freq: "daily" },
        },
      ],
    });
    expect(locationSorted.events?.map((event) => event.location)).toEqual(["alpha room", "zeta room"]);

    const descriptionSorted = normalizeFrontMatter({
      ...baseFrontMatter,
      events: [
        {
          start_at: "2026-02-24T09:00:00.000Z",
          end_at: "2026-02-24T10:00:00.000Z",
          title: "Tie event",
          all_day: false,
          timezone: "UTC",
          location: "alpha room",
          description: "zeta desc",
          recurrence: { freq: "daily" },
        },
        {
          start_at: "2026-02-24T09:00:00.000Z",
          end_at: "2026-02-24T10:00:00.000Z",
          title: "Tie event",
          all_day: false,
          timezone: "UTC",
          location: "alpha room",
          description: "alpha desc",
          recurrence: { freq: "daily" },
        },
      ],
    });
    expect(descriptionSorted.events?.map((event) => event.description)).toEqual(["alpha desc", "zeta desc"]);

    const recurrenceSorted = normalizeFrontMatter({
      ...baseFrontMatter,
      events: [
        {
          start_at: "2026-02-24T09:00:00.000Z",
          end_at: "2026-02-24T10:00:00.000Z",
          title: "Tie event",
          all_day: false,
          timezone: "UTC",
          location: "alpha room",
          description: "alpha desc",
          recurrence: { freq: "weekly", by_weekday: ["mon"] },
        },
        {
          start_at: "2026-02-24T09:00:00.000Z",
          end_at: "2026-02-24T10:00:00.000Z",
          title: "Tie event",
          all_day: false,
          timezone: "UTC",
          location: "alpha room",
          description: "alpha desc",
          recurrence: { freq: "daily" },
        },
      ],
    });
    expect(recurrenceSorted.events?.map((event) => event.recurrence?.freq)).toEqual(["daily", "weekly"]);
  });

  it("covers event comparator optional-field branches and interval retention", () => {
    const baseFrontMatter = {
      id: "pm-event-comparator-branches",
      title: "Event comparator branches",
      description: "Event comparator branch coverage",
      type: "Task",
      status: "open",
      priority: 1,
      tags: ["calendar"],
      created_at: FIXED_TS,
      updated_at: FIXED_TS,
    };

    const intervalRetained = normalizeFrontMatter({
      ...baseFrontMatter,
      events: [
        {
          start_at: "2026-02-24T09:00:00.000Z",
          recurrence: { freq: "daily", interval: 2 },
        },
      ],
    });
    expect(intervalRetained.events?.[0]?.recurrence?.interval).toBe(2);

    const endSorted = normalizeFrontMatter({
      ...baseFrontMatter,
      events: [
        {
          start_at: "2026-02-24T09:00:00.000Z",
          title: "Tie event",
          all_day: false,
        },
        {
          start_at: "2026-02-24T09:00:00.000Z",
          end_at: "2026-02-24T10:00:00.000Z",
          title: "Tie event",
          all_day: false,
        },
      ],
    });
    expect(endSorted.events?.map((event) => event.end_at)).toEqual([undefined, "2026-02-24T10:00:00.000Z"]);

    const titleSorted = normalizeFrontMatter({
      ...baseFrontMatter,
      events: [
        {
          start_at: "2026-02-24T09:00:00.000Z",
          end_at: "2026-02-24T10:00:00.000Z",
          all_day: false,
        },
        {
          start_at: "2026-02-24T09:00:00.000Z",
          end_at: "2026-02-24T10:00:00.000Z",
          title: "Tie event",
          all_day: false,
        },
      ],
    });
    expect(titleSorted.events?.map((event) => event.title)).toEqual([undefined, "Tie event"]);

    const allDaySorted = normalizeFrontMatter({
      ...baseFrontMatter,
      events: [
        {
          start_at: "2026-02-24T09:00:00.000Z",
          end_at: "2026-02-24T10:00:00.000Z",
          title: "Tie event",
          all_day: true,
        },
        {
          start_at: "2026-02-24T09:00:00.000Z",
          end_at: "2026-02-24T10:00:00.000Z",
          title: "Tie event",
          all_day: false,
        },
      ],
    });
    expect(allDaySorted.events?.map((event) => event.all_day)).toEqual([false, true]);

    const timezoneSorted = normalizeFrontMatter({
      ...baseFrontMatter,
      events: [
        {
          start_at: "2026-02-24T09:00:00.000Z",
          end_at: "2026-02-24T10:00:00.000Z",
          title: "Tie event",
          all_day: false,
          timezone: "UTC",
        },
        {
          start_at: "2026-02-24T09:00:00.000Z",
          end_at: "2026-02-24T10:00:00.000Z",
          title: "Tie event",
          all_day: false,
        },
      ],
    });
    expect(timezoneSorted.events?.map((event) => event.timezone)).toEqual([undefined, "UTC"]);

    const locationSorted = normalizeFrontMatter({
      ...baseFrontMatter,
      events: [
        {
          start_at: "2026-02-24T09:00:00.000Z",
          end_at: "2026-02-24T10:00:00.000Z",
          title: "Tie event",
          all_day: false,
          timezone: "UTC",
          location: "Room 1",
        },
        {
          start_at: "2026-02-24T09:00:00.000Z",
          end_at: "2026-02-24T10:00:00.000Z",
          title: "Tie event",
          all_day: false,
          timezone: "UTC",
        },
      ],
    });
    expect(locationSorted.events?.map((event) => event.location)).toEqual([undefined, "Room 1"]);

    const descriptionSorted = normalizeFrontMatter({
      ...baseFrontMatter,
      events: [
        {
          start_at: "2026-02-24T09:00:00.000Z",
          end_at: "2026-02-24T10:00:00.000Z",
          title: "Tie event",
          all_day: false,
          timezone: "UTC",
          location: "Room 1",
          description: "Description",
        },
        {
          start_at: "2026-02-24T09:00:00.000Z",
          end_at: "2026-02-24T10:00:00.000Z",
          title: "Tie event",
          all_day: false,
          timezone: "UTC",
          location: "Room 1",
        },
      ],
    });
    expect(descriptionSorted.events?.map((event) => event.description)).toEqual([undefined, "Description"]);

    const recurrenceSorted = normalizeFrontMatter({
      ...baseFrontMatter,
      events: [
        {
          start_at: "2026-02-24T09:00:00.000Z",
          end_at: "2026-02-24T10:00:00.000Z",
          title: "Tie event",
          all_day: false,
          timezone: "UTC",
          location: "Room 1",
          description: "Description",
          recurrence: { freq: "weekly", by_weekday: ["mon"] },
        },
        {
          start_at: "2026-02-24T09:00:00.000Z",
          end_at: "2026-02-24T10:00:00.000Z",
          title: "Tie event",
          all_day: false,
          timezone: "UTC",
          location: "Room 1",
          description: "Description",
        },
      ],
    });
    expect(recurrenceSorted.events?.map((event) => event.recurrence?.freq)).toEqual(["weekly", undefined]);

    const bothUndefinedFallback = normalizeFrontMatter({
      ...baseFrontMatter,
      events: [
        {
          start_at: "2026-02-24T09:00:00.000Z",
          all_day: false,
        },
        {
          start_at: "2026-02-24T09:00:00.000Z",
          all_day: false,
        },
      ],
    });
    expect(bothUndefinedFallback.events).toHaveLength(2);
  });

  it("throws on invalid event and recurrence structures", () => {
    expect(() => parseItemDocument(buildSource({ events: "calendar-event" }))).toThrow("events must be an array");
    expect(() => parseItemDocument(buildSource({ events: [42] }))).toThrow("events entries must be objects");
    expect(() => parseItemDocument(buildSource({ events: [{ title: "missing start" }] }))).toThrow("event.start_at must be a string");
    expect(() => parseItemDocument(buildSource({ events: [{ start_at: "not-a-timestamp" }] }))).toThrow(
      "event.start_at must be a valid ISO timestamp",
    );
    expect(() =>
      parseItemDocument(buildSource({ events: [{ start_at: FIXED_TS, end_at: "2026-02-21T00:00:00.000Z" }] })),
    ).toThrow("event.end_at must be after event.start_at");
    expect(() => parseItemDocument(buildSource({ events: [{ start_at: FIXED_TS, title: "   " }] }))).toThrow(
      "event.title must not be empty",
    );
    expect(() => parseItemDocument(buildSource({ events: [{ start_at: FIXED_TS, all_day: "yes" }] }))).toThrow(
      "event.all_day must be a boolean",
    );
    expect(() =>
      parseItemDocument(
        buildSource({
          events: [
            {
              start_at: FIXED_TS,
              recurrence: { freq: "hourly" },
            },
          ],
        }),
      ),
    ).toThrow("event.recurrence.freq must be one of");
    expect(() =>
      parseItemDocument(
        buildSource({
          events: [
            {
              start_at: FIXED_TS,
              recurrence: { freq: "daily", interval: 0 },
            },
          ],
        }),
      ),
    ).toThrow("event.recurrence.interval must be an integer >= 1");
    expect(() =>
      parseItemDocument(
        buildSource({
          events: [
            {
              start_at: FIXED_TS,
              recurrence: { freq: "weekly", by_weekday: ["mon", "funday"] },
            },
          ],
        }),
      ),
    ).toThrow("event.recurrence.by_weekday entries must be one of");
    expect(() =>
      parseItemDocument(
        buildSource({
          events: [
            {
              start_at: FIXED_TS,
              recurrence: { freq: "monthly", by_month_day: [0, 2] },
            },
          ],
        }),
      ),
    ).toThrow("event.recurrence.by_month_day entries must be integers 1..31");
    expect(() =>
      parseItemDocument(
        buildSource({
          events: [
            {
              start_at: FIXED_TS,
              recurrence: { freq: "daily", exdates: ["invalid-timestamp"] },
            },
          ],
        }),
      ),
    ).toThrow("event.recurrence.exdates entries must be valid ISO timestamps");
    expect(() =>
      parseItemDocument(
        buildSource({
          events: [
            {
              start_at: FIXED_TS,
              recurrence: { freq: "daily", until: "2026-02-21T00:00:00.000Z" },
            },
          ],
        }),
      ),
    ).toThrow("event.recurrence.until must be at or after event.start_at");
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

    expect(parsed.metadata.closed_at).toBe("2026-02-22T01:02:03.123456789+01:00");
    expect(parsed.metadata.source_type).toBe("bug");
    expect(parsed.metadata.source_owner).toBe("owner-a");
    expect(parsed.metadata.design).toBe("Design body");
    expect(parsed.metadata.external_ref).toBe("EXT-1");
    expect(parsed.metadata.dependencies?.map((entry) => entry.source_kind)).toEqual(["a-rel", "z-rel"]);
  });

  it("parses and normalizes confidence values", () => {
    const numeric = parseItemDocument(buildSource({ confidence: 42 }));
    expect(numeric.metadata.confidence).toBe(42);

    const medAlias = parseItemDocument(buildSource({ confidence: "med" }));
    expect(medAlias.metadata.confidence).toBe("medium");

    const textLevel = parseItemDocument(buildSource({ confidence: "high" }));
    expect(textLevel.metadata.confidence).toBe("high");
  });

  it("parses and normalizes severity values", () => {
    const medAlias = parseItemDocument(buildSource({ severity: "med" }));
    expect(medAlias.metadata.severity).toBe("medium");

    const textLevel = parseItemDocument(buildSource({ severity: "high" }));
    expect(textLevel.metadata.severity).toBe("high");
  });

  it("parses regression boolean values", () => {
    const regressionTrue = parseItemDocument(buildSource({ regression: true }));
    expect(regressionTrue.metadata.regression).toBe(true);

    const regressionFalse = parseItemDocument(buildSource({ regression: false }));
    expect(regressionFalse.metadata.regression).toBe(false);
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
      ...(parsed.metadata as Record<string, unknown>),
      confidence: "unknown",
    } as unknown as Parameters<typeof normalizeFrontMatter>[0]);
    expect(normalized.confidence).toBeUndefined();
  });

  it("drops invalid severity text during direct normalize fallback", () => {
    const parsed = parseItemDocument(buildSource({ severity: "low" }));
    const normalized = normalizeFrontMatter({
      ...(parsed.metadata as Record<string, unknown>),
      severity: "urgent",
    } as unknown as Parameters<typeof normalizeFrontMatter>[0]);
    expect(normalized.severity).toBeUndefined();
  });

  it("drops invalid recurrence frequency during direct normalize fallback", () => {
    const normalized = normalizeFrontMatter({
      id: "pm-invalid-recurrence-fallback",
      title: "Invalid recurrence fallback",
      description: "invalid recurrence fallback description",
      type: "Task",
      status: "open",
      priority: 1,
      tags: [],
      created_at: FIXED_TS,
      updated_at: FIXED_TS,
      events: [
        {
          start_at: "2026-02-24T10:00:00.000Z",
          recurrence: {
            freq: "hourly" as unknown as "daily",
          },
        },
      ],
    } as unknown as Parameters<typeof normalizeFrontMatter>[0]);

    expect(normalized.events).toEqual([
      {
        start_at: "2026-02-24T10:00:00.000Z",
      },
    ]);
  });

  it("round-trips TOON item documents while preserving canonical document shape", () => {
    const source = parseItemDocument(buildSource({ tags: ["Alpha", "beta"], confidence: "med" }));
    const serializedToon = serializeItemDocument(source, { format: "toon" });
    expect(serializedToon.startsWith("front_matter:")).toBe(false);
    expect(serializedToon.startsWith("id: ")).toBe(true);
    const parsedToon = parseItemDocument(serializedToon, { format: "toon" });
    expect(parsedToon).toEqual({
      metadata: {
        ...source.metadata,
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
    expect(parsed.metadata.id).toBe("pm-root-item");
    expect(parsed.metadata.tags).toEqual(["alpha", "beta"]);
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
    expect(parsed.metadata.id).toBe("pm-legacy-wrapped");
    expect(parsed.metadata.tags).toEqual(["alpha", "beta"]);
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
    expect(parsed.metadata.description).toContain("Escaped quote");
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
