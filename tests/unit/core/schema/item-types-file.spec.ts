import { describe, expect, it } from "vitest";
import {
  assertAliasesAvailable,
  assertTypeFolderAvailable,
  buildInvalidTypeError,
  buildInvalidTypeHint,
  escapeForDoubleQuotes,
  matchBuiltinTypeName,
  normalizeAddTypeInput,
  parseItemTypesFile,
  removeItemType,
  serializeItemTypesFile,
  upsertItemType,
} from "../../../../src/core/schema/item-types-file.js";
import {
  assertStatusTokensAvailable,
  BUILTIN_STATUS_IDS,
  normalizeAddStatusInput,
  normalizeStatusToken,
  parseStatusDefsFile,
  removeStatusDef,
  serializeStatusDefsFile,
  upsertStatusDef,
} from "../../../../src/core/schema/status-defs-file.js";

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

  it("throws when an alias collides with a built-in type", () => {
    expect(() => normalizeAddTypeInput({ name: "Spike", aliases: ["Task"] })).toThrow(
      /Alias "Task" collides with built-in item type "Task"/,
    );
  });

  it("GH-248: rejects malformed type names (spaces, leading digit, punctuation)", () => {
    for (const name of ["Spike Type", "1Spike", "-spike", "spike!", "spi ke"]) {
      expect(() => normalizeAddTypeInput({ name })).toThrow(/is not a valid identifier/);
    }
  });

  it("GH-248: accepts letter-led tokens with internal hyphen/underscore", () => {
    expect(normalizeAddTypeInput({ name: "code-review" }).name).toBe("code-review");
    expect(normalizeAddTypeInput({ name: "bug_report" }).name).toBe("bug_report");
  });

  it("GH-248: rejects malformed aliases", () => {
    expect(() => normalizeAddTypeInput({ name: "Spike", aliases: ["bad alias"] })).toThrow(
      /Alias "bad alias" is not a valid identifier/,
    );
  });
});

describe("assertTypeFolderAvailable", () => {
  const existing = {
    definitions: [
      { name: "Spike", folder: "spikes" } as Record<string, unknown>,
      { name: "Review", aliases: ["rv"] } as Record<string, unknown>, // default folder "reviews"
      { name: "" } as Record<string, unknown>, // empty name skipped
      { notName: true } as unknown as { name: string }, // non-string name skipped
    ],
  } as never;

  it("passes when the resolved folder does not collide", () => {
    expect(() => assertTypeFolderAvailable({ name: "Bug", aliases: [] }, existing)).not.toThrow();
  });

  it("throws when a distinct name's default slug collides with an existing folder", () => {
    // "Spikes" slugs to folder "spikes", already owned by "Spike".
    expect(() => assertTypeFolderAvailable({ name: "Spikes", aliases: [] }, existing)).toThrow(
      /would store items in folder "spikes", which already belongs to existing item type "Spike"/,
    );
  });

  it("throws when an explicit --folder collides with another definition's default slug", () => {
    expect(() => assertTypeFolderAvailable({ name: "Audit", folder: "reviews", aliases: [] }, existing)).toThrow(
      /folder "reviews", which already belongs to existing item type "Review"/,
    );
  });

  it("ignores the same-named definition being upserted (recase/idempotent re-run)", () => {
    expect(() => assertTypeFolderAvailable({ name: "spike", aliases: [] }, existing)).not.toThrow();
  });

  it("rejects a folder collision with a reserved (built-in/extension) folder", () => {
    // "Tasks" slugs to folder "tasks", owned by the built-in Task.
    const reserved = new Map<string, string>([["tasks", "Task"]]);
    expect(() => assertTypeFolderAvailable({ name: "Tasks", aliases: [] }, { definitions: [] }, reserved)).toThrow(
      /folder "tasks", which already belongs to existing item type "Task"/,
    );
  });

  it("passes when the reserved folder is owned by the same-named definition", () => {
    // Re-registering a custom type whose folder is already reserved under its own
    // name (case-insensitive) is a no-op, not a collision.
    const reserved = new Map<string, string>([["spikes", "Spike"]]);
    expect(() => assertTypeFolderAvailable({ name: "spike", aliases: [] }, { definitions: [] }, reserved)).not.toThrow();
  });

  it("passes when no reserved folder collides", () => {
    const reserved = new Map<string, string>([["tasks", "Task"]]);
    expect(() => assertTypeFolderAvailable({ name: "Bug", aliases: [] }, { definitions: [] }, reserved)).not.toThrow();
  });
});

describe("assertAliasesAvailable", () => {
  const existing = {
    definitions: [
      { name: "Gateway", aliases: ["gate", "checkpoint"] } as Record<string, unknown>,
      { name: "Spike", aliases: ["research"] } as Record<string, unknown>,
      { name: "Bare" } as Record<string, unknown>, // valid name, no aliases array
      { name: "Messy", aliases: ["", "  ", 7, "from-messy"] } as unknown as Record<string, unknown>, // malformed alias entries
      { name: "Weird", aliases: "notanarray" } as unknown as Record<string, unknown>, // non-array aliases value
      { notName: true } as unknown as { name: string },
    ],
  } as never;

  it("passes when no alias or name collides with another definition", () => {
    expect(() => assertAliasesAvailable({ name: "Bug", aliases: ["defect"] }, existing)).not.toThrow();
  });

  it("tolerates definitions without aliases, malformed entries, and non-array aliases", () => {
    // "Bare" (no aliases), blank/non-string entries on "Messy", and the non-array
    // "Weird".aliases are all tolerated; only well-formed string aliases are taken.
    expect(() => assertAliasesAvailable({ name: "Bug", aliases: ["bare-ish"] }, existing)).not.toThrow();
    expect(() => assertAliasesAvailable({ name: "Bug", aliases: ["notanarray"] }, existing)).not.toThrow();
    expect(() => assertAliasesAvailable({ name: "Bug", aliases: ["from-messy"] }, existing)).toThrow(
      /Alias "from-messy" already maps to existing item type "Messy"/,
    );
  });

  it("ignores tokens belonging to the same-named definition (idempotent re-run)", () => {
    expect(() => assertAliasesAvailable({ name: "spike", aliases: ["research"] }, existing)).not.toThrow();
  });

  it("throws when an alias maps to another definition's canonical name", () => {
    expect(() => assertAliasesAvailable({ name: "Bug", aliases: ["gateway"] }, existing)).toThrow(
      /Alias "gateway" already maps to existing item type "Gateway"/,
    );
  });

  it("throws when an alias maps to another definition's alias", () => {
    expect(() => assertAliasesAvailable({ name: "Bug", aliases: ["checkpoint"] }, existing)).toThrow(
      /Alias "checkpoint" already maps to existing item type "Gateway"/,
    );
  });

  it("throws when the new type name collides with another definition's alias", () => {
    expect(() => assertAliasesAvailable({ name: "research", aliases: [] }, existing)).toThrow(
      /Type name "research" collides with an alias of existing item type "Spike"/,
    );
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
    expect(result.previousName).toBeUndefined();
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
    // GH-248: previousName exposes the replaced canonical name ("Spike") so the
    // CLI can warn that registering "spike" recased an existing type.
    expect(result.previousName).toBe("Spike");
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

  it("tolerates a non-array persisted aliases value on the existing definition", () => {
    const file = { definitions: [{ name: "Spike", aliases: "corrupt" } as unknown as { name: string }] };
    const result = upsertItemType(file as never, { name: "Spike", aliases: ["research"] });
    expect(result.replaced).toBe(true);
    expect(result.definition.aliases).toEqual(["research"]);
  });

  it("ignores definitions whose name is not a string when locating an existing entry", () => {
    const file = { definitions: [{ notName: true } as unknown as { name: string }, { name: "Spike" }] };
    const result = upsertItemType(file, { name: "Spike", aliases: [] });
    expect(result.replaced).toBe(true);
  });
});

describe("removeItemType", () => {
  it("removes a matching custom definition case-insensitively", () => {
    const file = { definitions: [{ name: "Alpha" }, { name: "Spike", folder: "spikes" }] };
    const result = removeItemType(file, "spike");
    expect(result.removed).toBe(true);
    expect(result.definition).toEqual({ name: "Spike", folder: "spikes" });
    expect(result.file.definitions.map((d) => d.name)).toEqual(["Alpha"]);
  });

  it("returns removed:false when no matching definition exists (idempotent no-op)", () => {
    const file = { definitions: [{ name: "Alpha" }] };
    const result = removeItemType(file, "Spike");
    expect(result.removed).toBe(false);
    expect(result.definition).toBeUndefined();
    expect(result.file.definitions.map((d) => d.name)).toEqual(["Alpha"]);
  });

  it("throws on an empty/whitespace name", () => {
    expect(() => removeItemType({ definitions: [] }, undefined)).toThrow(/must not be empty/);
    expect(() => removeItemType({ definitions: [] }, "   ")).toThrow(/must not be empty/);
  });

  it("refuses to remove a built-in type", () => {
    expect(() => removeItemType({ definitions: [] }, "task")).toThrow(
      /Cannot remove built-in item type "Task"/,
    );
  });

  it("ignores definitions whose name is not a string when locating the entry", () => {
    const file = { definitions: [{ notName: true } as unknown as { name: string }, { name: "Spike" }] };
    const result = removeItemType(file, "Spike");
    expect(result.removed).toBe(true);
    expect(result.file.definitions).toEqual([{ notName: true }]);
  });
});

describe("serializeItemTypesFile", () => {
  it("serializes with a trailing newline and only the definitions key", () => {
    const serialized = serializeItemTypesFile({ definitions: [{ name: "Spike" }] });
    expect(serialized).toBe(`${JSON.stringify({ definitions: [{ name: "Spike" }] }, null, 2)}\n`);
    expect(serialized.endsWith("\n")).toBe(true);
  });
});

describe("escapeForDoubleQuotes", () => {
  it("escapes shell-significant characters for a double-quoted context", () => {
    expect(escapeForDoubleQuotes('a"b`c$d\\e')).toBe('a\\"b\\`c\\$d\\\\e');
  });

  it("leaves plain text unchanged", () => {
    expect(escapeForDoubleQuotes("Spike")).toBe("Spike");
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

  it("escapes shell-significant characters in the name so the command stays copy-pasteable", () => {
    expect(buildInvalidTypeHint('Wei"rd$')).toBe(
      'To register a custom type, run: pm schema add-type "Wei\\"rd\\$" (writes .agents/pm/schema/types.json).',
    );
  });

  it("uses the resolved types-file path when one is provided (custom --pm-path)", () => {
    expect(buildInvalidTypeHint("Spike", "/tmp/hunt/schema/types.json")).toBe(
      'To register a custom type, run: pm schema add-type "Spike" (writes /tmp/hunt/schema/types.json).',
    );
  });

  it("falls back to the default path when the provided path is blank", () => {
    expect(buildInvalidTypeHint("Spike", "   ")).toBe(
      'To register a custom type, run: pm schema add-type "Spike" (writes .agents/pm/schema/types.json).',
    );
  });
});

describe("buildInvalidTypeError", () => {
  it("combines the allowed-list line with the discoverable hint", () => {
    expect(buildInvalidTypeError("Spike", ["Task", "Feature"])).toBe(
      'Invalid type value "Spike". Allowed: Task, Feature. To register a custom type, run: pm schema add-type "Spike" (writes .agents/pm/schema/types.json).',
    );
  });

  it("threads the resolved types-file path into the hint", () => {
    expect(buildInvalidTypeError("Spike", ["Task", "Feature"], "/srv/proj/schema/types.json")).toBe(
      'Invalid type value "Spike". Allowed: Task, Feature. To register a custom type, run: pm schema add-type "Spike" (writes /srv/proj/schema/types.json).',
    );
  });
});

describe("normalizeStatusToken", () => {
  it("lowercases and collapses whitespace/hyphens into underscores", () => {
    expect(normalizeStatusToken("  In Progress ")).toBe("in_progress");
    expect(normalizeStatusToken("In-Progress")).toBe("in_progress");
    expect(normalizeStatusToken("a -  b")).toBe("a_b");
  });

  it("returns an empty string for non-string input", () => {
    expect(normalizeStatusToken(undefined)).toBe("");
    expect(normalizeStatusToken(42 as unknown)).toBe("");
  });

  it("memoizes normalized tokens and keeps normalizing after the memo size cap", () => {
    // Repeat lookups must serve the memoized value unchanged.
    expect(normalizeStatusToken("In-Progress")).toBe("in_progress");
    expect(normalizeStatusToken("In-Progress")).toBe("in_progress");
    // Overflow the memo with unique tokens to force the half-eviction branch.
    for (let index = 0; index < 2_001; index += 1) {
      normalizeStatusToken(`Status-${index}`);
    }
    expect(normalizeStatusToken("  In Progress ")).toBe("in_progress");
  });
});

describe("BUILTIN_STATUS_IDS", () => {
  it("contains the canonical default status ids", () => {
    for (const id of ["draft", "open", "in_progress", "blocked", "closed", "canceled"]) {
      expect(BUILTIN_STATUS_IDS.has(id)).toBe(true);
    }
  });

  it("does not contain custom ids", () => {
    expect(BUILTIN_STATUS_IDS.has("review")).toBe(false);
  });
});

describe("normalizeAddStatusInput", () => {
  it("normalizes id, dedupes/sorts aliases, validates roles, truncates order", () => {
    const result = normalizeAddStatusInput({
      id: "  In Review ",
      roles: ["active", "Active", " blocked "],
      aliases: ["under-review", "Under Review", "in_review", "in review"],
      description: "  needs eyes ",
      order: 3.7,
    });
    // "in review"/"in_review" normalize to the id and are dropped from aliases.
    expect(result).toEqual({
      id: "in_review",
      roles: ["active", "blocked"],
      aliases: ["under_review"],
      description: "needs eyes",
      order: 3,
    });
  });

  it("drops blank role entries, blank aliases, and aliases equal to the id", () => {
    const result = normalizeAddStatusInput({
      id: "review",
      roles: ["", "  ", "active"],
      aliases: ["review", "Review", "", "   ", "in_review"],
    });
    expect(result.roles).toEqual(["active"]);
    expect(result.aliases).toEqual(["in_review"]);
  });

  it("leaves roles/aliases undefined when the lists are omitted (so upsert preserves existing)", () => {
    const result = normalizeAddStatusInput({ id: "review", description: "   ", order: Number.NaN });
    expect(result).toEqual({ id: "review", roles: undefined, aliases: undefined, description: undefined, order: undefined });
  });

  it("normalizes a supplied-but-empty roles/aliases list to an explicit empty array (clear)", () => {
    const result = normalizeAddStatusInput({ id: "review", roles: [], aliases: [] });
    expect(result.roles).toEqual([]);
    expect(result.aliases).toEqual([]);
  });

  it("throws on a missing/empty id", () => {
    expect(() => normalizeAddStatusInput({ id: undefined })).toThrow(/must not be empty/);
    expect(() => normalizeAddStatusInput({ id: "   " })).toThrow(/must not be empty/);
  });

  it("rejects built-in status ids (reserved, symmetric with remove-status)", () => {
    expect(() => normalizeAddStatusInput({ id: "open" })).toThrow(/built-in status "open"/);
    expect(() => normalizeAddStatusInput({ id: "Closed", roles: ["terminal_done"] })).toThrow(
      /built-in status "closed"/,
    );
    expect(() => normalizeAddStatusInput({ id: "in-progress" })).toThrow(/built-in status "in_progress"/);
  });

  it("throws on an invalid role", () => {
    expect(() => normalizeAddStatusInput({ id: "review", roles: ["bogus"] })).toThrow(
      /Invalid status role "bogus"\. Allowed roles: draft, active, blocked, terminal, terminal_done, terminal_canceled, default_open, default_close, default_cancel\./,
    );
  });

  it("ignores non-string role entries", () => {
    const result = normalizeAddStatusInput({ id: "review", roles: [42 as unknown as string, "active"] });
    expect(result.roles).toEqual(["active"]);
  });
});

describe("parseStatusDefsFile", () => {
  it("returns empty statuses for null/undefined/blank input", () => {
    expect(parseStatusDefsFile(null)).toEqual({ statuses: [] });
    expect(parseStatusDefsFile(undefined)).toEqual({ statuses: [] });
    expect(parseStatusDefsFile("   ")).toEqual({ statuses: [] });
  });

  it("throws on invalid JSON", () => {
    expect(() => parseStatusDefsFile("{ not json")).toThrow(/invalid JSON/);
  });

  it("reads the canonical { statuses: [...] } shape", () => {
    const parsed = parseStatusDefsFile(JSON.stringify({ statuses: [{ id: "review" }] }));
    expect(parsed.statuses).toEqual([{ id: "review" }]);
  });

  it("reads a bare array of definitions", () => {
    const parsed = parseStatusDefsFile(JSON.stringify([{ id: "review" }]));
    expect(parsed.statuses).toEqual([{ id: "review" }]);
  });

  it("reads the { definitions: [...] } shape", () => {
    const parsed = parseStatusDefsFile(JSON.stringify({ definitions: [{ id: "review" }] }));
    expect(parsed.statuses).toEqual([{ id: "review" }]);
  });

  it("returns empty statuses for an unrecognized object shape", () => {
    expect(parseStatusDefsFile(JSON.stringify({ other: true }))).toEqual({ statuses: [] });
    expect(parseStatusDefsFile(JSON.stringify(42))).toEqual({ statuses: [] });
    expect(parseStatusDefsFile(JSON.stringify(null))).toEqual({ statuses: [] });
  });

  it("skips malformed entries (non-objects, arrays, missing/blank id)", () => {
    const parsed = parseStatusDefsFile(
      JSON.stringify({
        statuses: ["string", ["array"], null, { id: "" }, { id: "  " }, { noId: true }, { id: "review", order: 9 }],
      }),
    );
    expect(parsed.statuses).toEqual([{ id: "review", order: 9 }]);
  });
});

describe("serializeStatusDefsFile", () => {
  it("serializes with a trailing newline and only the statuses key", () => {
    const serialized = serializeStatusDefsFile({ statuses: [{ id: "review" }] });
    expect(serialized).toBe(`${JSON.stringify({ statuses: [{ id: "review" }] }, null, 2)}\n`);
    expect(serialized.endsWith("\n")).toBe(true);
  });
});

describe("upsertStatusDef", () => {
  it("inserts a new definition with roles/aliases/description/order", () => {
    const result = upsertStatusDef(
      { statuses: [] },
      { id: "review", roles: ["active"], aliases: ["in_review"], description: "needs eyes", order: 2 },
    );
    expect(result.replaced).toBe(false);
    expect(result.definition).toEqual({
      id: "review",
      roles: ["active"],
      aliases: ["in_review"],
      description: "needs eyes",
      order: 2,
    });
    expect(result.file.statuses).toHaveLength(1);
  });

  it("inserts with only an id when no optional fields are provided", () => {
    const result = upsertStatusDef({ statuses: [] }, { id: "review", roles: [], aliases: [] });
    expect(result.replaced).toBe(false);
    expect(result.definition).toEqual({ id: "review" });
  });

  it("upserts by normalized id, replacing roles/aliases and overriding description/order", () => {
    const file = {
      statuses: [
        { id: "review", roles: ["active"], aliases: ["in_review"], description: "old", order: 1, custom_extra: true },
      ] as never,
    };
    const result = upsertStatusDef(file, {
      id: "review",
      roles: ["blocked"],
      aliases: ["awaiting"],
      description: "new",
      order: 5,
    });
    expect(result.replaced).toBe(true);
    expect(result.definition).toMatchObject({
      id: "review",
      roles: ["blocked"],
      aliases: ["awaiting"],
      description: "new",
      order: 5,
      custom_extra: true,
    });
    expect(result.file.statuses).toHaveLength(1);
  });

  it("clears previously-set roles/aliases when an explicit empty array is supplied", () => {
    const file = { statuses: [{ id: "review", roles: ["active"], aliases: ["in_review"] }] as never };
    const result = upsertStatusDef(file, { id: "review", roles: [], aliases: [] });
    expect(result.replaced).toBe(true);
    expect(result.definition).not.toHaveProperty("roles");
    expect(result.definition).not.toHaveProperty("aliases");
  });

  it("preserves existing roles/aliases when the fields are omitted (undefined)", () => {
    // Regression for the data-loss finding: `add-status review --description x`
    // must NOT wipe a previously-set role/alias just because --role/--alias were
    // omitted (normalizeAddStatusInput yields undefined for an omitted flag).
    const file = { statuses: [{ id: "review", roles: ["active"], aliases: ["in_review"] }] as never };
    const result = upsertStatusDef(file, { id: "review", description: "needs eyes" });
    expect(result.replaced).toBe(true);
    expect(result.definition).toMatchObject({
      id: "review",
      roles: ["active"],
      aliases: ["in_review"],
      description: "needs eyes",
    });
  });

  it("preserves existing roles while applying an explicit alias clear (and vice versa)", () => {
    const file = { statuses: [{ id: "review", roles: ["active"], aliases: ["in_review"] }] as never };
    const result = upsertStatusDef(file, { id: "review", aliases: [] });
    expect(result.definition).toMatchObject({ id: "review", roles: ["active"] });
    expect(result.definition).not.toHaveProperty("aliases");
  });

  it("preserves description/order when not supplied on the re-add", () => {
    const file = { statuses: [{ id: "review", description: "keep", order: 4 }] as never };
    const result = upsertStatusDef(file, { id: "review", roles: [], aliases: [] });
    expect(result.definition).toMatchObject({ id: "review", description: "keep", order: 4 });
  });

  it("seeds from baseDefinition when the status is absent from the file (settings-defined)", () => {
    // Regression: a status defined only in settings.schema.statuses (not the
    // file) must keep its roles/aliases when `add-status --description x` omits
    // --role/--alias; the resolved definition is passed as baseDefinition.
    const base = { id: "review", roles: ["active"], aliases: ["in_review"], order: 3 } as never;
    const result = upsertStatusDef({ statuses: [] }, { id: "review", description: "needs eyes" }, base);
    expect(result.replaced).toBe(true);
    expect(result.definition).toMatchObject({
      id: "review",
      roles: ["active"],
      aliases: ["in_review"],
      description: "needs eyes",
      order: 3,
    });
    expect(result.file.statuses).toHaveLength(1);
  });

  it("reports replaced=false for a brand-new status with no file entry and no base", () => {
    const result = upsertStatusDef({ statuses: [] }, { id: "fresh" }, undefined);
    expect(result.replaced).toBe(false);
    expect(result.definition).toEqual({ id: "fresh" });
  });
});

describe("assertStatusTokensAvailable", () => {
  it("throws when the id resolves to a different status (e.g. a built-in alias)", () => {
    // A new id equal to another status's token (here "cancelled" owned by the
    // built-in "canceled") would shadow that lifecycle token.
    expect(() =>
      assertStatusTokensAvailable({ id: "cancelled" }, new Map([["cancelled", "canceled"]])),
    ).toThrow(/already belongs to status "canceled"/);
  });

  it("throws when a supplied alias collides with a different status", () => {
    expect(() =>
      assertStatusTokensAvailable({ id: "review", aliases: ["open"] }, new Map([["open", "open"]])),
    ).toThrow(/already belongs to status "open"/);
  });

  it("allows re-adding the same status (token owned by itself)", () => {
    expect(() =>
      assertStatusTokensAvailable({ id: "review", aliases: ["in_review"] }, new Map([["review", "review"]])),
    ).not.toThrow();
  });

  it("allows a brand-new status whose tokens are unowned", () => {
    expect(() => assertStatusTokensAvailable({ id: "triage", aliases: ["queued"] }, new Map())).not.toThrow();
  });

  it("skips empty/whitespace tokens", () => {
    expect(() =>
      assertStatusTokensAvailable({ id: "review", aliases: ["   "] }, new Map([["open", "open"]])),
    ).not.toThrow();
  });
});

describe("removeStatusDef", () => {
  it("removes a matching custom definition by normalized id", () => {
    const file = { statuses: [{ id: "draft_review" }, { id: "review" }] };
    const result = removeStatusDef(file, "Review");
    expect(result.removed).toBe(true);
    expect(result.definition).toEqual({ id: "review" });
    expect(result.file.statuses.map((s) => s.id)).toEqual(["draft_review"]);
  });

  it("returns removed:false when no matching definition exists (idempotent no-op)", () => {
    const result = removeStatusDef({ statuses: [{ id: "review" }] }, "ghost");
    expect(result.removed).toBe(false);
    expect(result.definition).toBeUndefined();
    expect(result.file.statuses.map((s) => s.id)).toEqual(["review"]);
  });

  it("throws on an empty/whitespace id", () => {
    expect(() => removeStatusDef({ statuses: [] }, undefined)).toThrow(/must not be empty/);
    expect(() => removeStatusDef({ statuses: [] }, "   ")).toThrow(/must not be empty/);
  });

  it("refuses to remove each built-in default status", () => {
    for (const id of ["draft", "open", "in_progress", "blocked", "closed", "canceled"]) {
      expect(() => removeStatusDef({ statuses: [] }, id)).toThrow(/Cannot remove built-in status/);
    }
    // hyphen/space variants normalize to the built-in id and are still refused.
    expect(() => removeStatusDef({ statuses: [] }, "in-progress")).toThrow(/Cannot remove built-in status "in_progress"/);
  });
});
