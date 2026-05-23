import { describe, expect, it } from "vitest";
import {
  buildInvalidTypeError,
  buildInvalidTypeHint,
  matchBuiltinTypeName,
  normalizeAddTypeInput,
  parseItemTypesFile,
  serializeItemTypesFile,
  upsertItemType,
} from "../../src/core/schema/item-types-file.js";

describe("matchBuiltinTypeName", () => {
  it("matches built-ins case-insensitively and returns the canonical name", () => {
    expect(matchBuiltinTypeName("task")).toBe("Task");
    expect(matchBuiltinTypeName("  TASK  ")).toBe("Task");
    expect(matchBuiltinTypeName("Plan")).toBe("Plan");
  });

  it("returns undefined for non-built-ins", () => {
    expect(matchBuiltinTypeName("Spike")).toBeUndefined();
    expect(matchBuiltinTypeName("")).toBeUndefined();
  });
});

describe("normalizeAddTypeInput", () => {
  it("normalizes a full input and dedupes/sorts aliases", () => {
    const result = normalizeAddTypeInput({
      name: "  Spike ",
      description: "  Time-boxed  ",
      defaultStatus: " open ",
      folder: " spikes ",
      aliases: ["research", "Spike", "research", "  ", "investigate"],
    });
    expect(result).toEqual({
      name: "Spike",
      description: "Time-boxed",
      defaultStatus: "open",
      folder: "spikes",
      aliases: ["investigate", "research", "Spike"],
    });
  });

  it("drops empty optional strings and missing alias list", () => {
    const result = normalizeAddTypeInput({
      name: "Spike",
      description: "   ",
      defaultStatus: "",
      folder: undefined,
    });
    expect(result).toEqual({
      name: "Spike",
      description: undefined,
      defaultStatus: undefined,
      folder: undefined,
      aliases: [],
    });
  });

  it("throws on missing/empty name", () => {
    expect(() => normalizeAddTypeInput({ name: undefined })).toThrow(/must not be empty/);
    expect(() => normalizeAddTypeInput({ name: "   " })).toThrow(/must not be empty/);
  });

  it("throws when colliding with a built-in type", () => {
    expect(() => normalizeAddTypeInput({ name: "task" })).toThrow(/Cannot redefine built-in item type "Task"/);
  });
});

describe("parseItemTypesFile", () => {
  it("returns empty definitions for null/undefined/blank input", () => {
    expect(parseItemTypesFile(null)).toEqual({ definitions: [] });
    expect(parseItemTypesFile(undefined)).toEqual({ definitions: [] });
    expect(parseItemTypesFile("   ")).toEqual({ definitions: [] });
  });

  it("throws on invalid JSON", () => {
    expect(() => parseItemTypesFile("{ not json")).toThrow(/invalid JSON/);
  });

  it("reads the canonical { definitions: [...] } shape", () => {
    const parsed = parseItemTypesFile(JSON.stringify({ definitions: [{ name: "Spike" }] }));
    expect(parsed.definitions).toEqual([{ name: "Spike" }]);
  });

  it("reads a bare array of definitions", () => {
    const parsed = parseItemTypesFile(JSON.stringify([{ name: "Spike" }]));
    expect(parsed.definitions).toEqual([{ name: "Spike" }]);
  });

  it("reads the nested { item_types: { definitions: [...] } } shape", () => {
    const parsed = parseItemTypesFile(JSON.stringify({ item_types: { definitions: [{ name: "Spike" }] } }));
    expect(parsed.definitions).toEqual([{ name: "Spike" }]);
  });

  it("returns empty definitions for an unrecognized object shape", () => {
    expect(parseItemTypesFile(JSON.stringify({ other: true }))).toEqual({ definitions: [] });
    expect(parseItemTypesFile(JSON.stringify({ item_types: { other: true } }))).toEqual({ definitions: [] });
    expect(parseItemTypesFile(JSON.stringify({ item_types: 42 }))).toEqual({ definitions: [] });
    expect(parseItemTypesFile(JSON.stringify(42))).toEqual({ definitions: [] });
    expect(parseItemTypesFile(JSON.stringify(null))).toEqual({ definitions: [] });
  });

  it("skips malformed entries (non-objects, arrays, missing/blank name)", () => {
    const parsed = parseItemTypesFile(
      JSON.stringify({
        definitions: [
          "string",
          ["array"],
          null,
          { name: "" },
          { name: "  " },
          { noName: true },
          { name: "Spike", folder: "spikes" },
        ],
      }),
    );
    expect(parsed.definitions).toEqual([{ name: "Spike", folder: "spikes" }]);
  });
});

describe("upsertItemType", () => {
  it("inserts a new definition and sorts by name", () => {
    const file = { definitions: [{ name: "Zeta" }] };
    const result = upsertItemType(file, {
      name: "Alpha",
      description: "first",
      defaultStatus: "open",
      folder: "alphas",
      aliases: ["a"],
    });
    expect(result.replaced).toBe(false);
    expect(result.definition).toEqual({
      name: "Alpha",
      description: "first",
      default_status: "open",
      folder: "alphas",
      aliases: ["a"],
    });
    expect(result.file.definitions.map((d) => d.name)).toEqual(["Alpha", "Zeta"]);
  });

  it("inserts with no optional fields when none are provided", () => {
    const result = upsertItemType({ definitions: [] }, {
      name: "Spike",
      aliases: [],
    });
    expect(result.replaced).toBe(false);
    expect(result.definition).toEqual({ name: "Spike" });
  });

  it("upserts case-insensitively, merging aliases and overriding supplied fields", () => {
    const file = {
      definitions: [
        {
          name: "Spike",
          description: "old",
          default_status: "open",
          folder: "spikes",
          aliases: ["existing"],
          required_create_fields: ["title"],
        } as Record<string, unknown>,
      ],
    };
    const result = upsertItemType(file as never, {
      name: "spike",
      description: "new",
      defaultStatus: undefined,
      folder: undefined,
      aliases: ["added", "existing"],
    });
    expect(result.replaced).toBe(true);
    // Name preserved from input; description overridden; aliases merged/deduped/sorted;
    // folder/default_status/required_create_fields preserved (not addressed by flags).
    expect(result.definition).toMatchObject({
      name: "spike",
      description: "new",
      default_status: "open",
      folder: "spikes",
      aliases: ["added", "existing"],
      required_create_fields: ["title"],
    });
    expect(result.file.definitions).toHaveLength(1);
  });

  it("removes a previously-set aliases array when no aliases remain", () => {
    const file = { definitions: [{ name: "Spike", aliases: [] as string[] }] };
    const result = upsertItemType(file, { name: "Spike", aliases: [] });
    expect(result.replaced).toBe(true);
    expect(result.definition).not.toHaveProperty("aliases");
  });

  it("ignores definitions whose name is not a string when locating an existing entry", () => {
    const file = { definitions: [{ notName: true } as unknown as { name: string }, { name: "Spike" }] };
    const result = upsertItemType(file, { name: "Spike", aliases: [] });
    expect(result.replaced).toBe(true);
  });
});

describe("serializeItemTypesFile", () => {
  it("serializes with a trailing newline and only the definitions key", () => {
    const serialized = serializeItemTypesFile({ definitions: [{ name: "Spike" }] });
    expect(serialized).toBe(`${JSON.stringify({ definitions: [{ name: "Spike" }] }, null, 2)}\n`);
    expect(serialized.endsWith("\n")).toBe(true);
  });
});

describe("buildInvalidTypeHint", () => {
  it("produces a copy-pasteable hint with the trimmed name", () => {
    expect(buildInvalidTypeHint("  Spike  ")).toBe(
      'To register a custom type, run: pm schema add-type "Spike" (writes .agents/pm/schema/types.json).',
    );
  });

  it("falls back to the raw name when trimming produces an empty string", () => {
    expect(buildInvalidTypeHint("   ")).toBe(
      'To register a custom type, run: pm schema add-type "   " (writes .agents/pm/schema/types.json).',
    );
  });
});

describe("buildInvalidTypeError", () => {
  it("combines the allowed-list line with the discoverable hint", () => {
    expect(buildInvalidTypeError("Spike", ["Task", "Feature"])).toBe(
      'Invalid type value "Spike". Allowed: Task, Feature. To register a custom type, run: pm schema add-type "Spike" (writes .agents/pm/schema/types.json).',
    );
  });
});
