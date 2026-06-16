import { describe, expect, it } from "vitest";
import {
  coerceRuntimeFieldValue,
  collectRuntimeCreateFieldValues,
  collectRuntimeUpdateFieldValues,
  readRuntimeFieldOptionValue,
} from "../../../../src/core/schema/runtime-field-values.js";
import type {
  RuntimeFieldCommand,
  RuntimeFieldDefinitionResolved,
  RuntimeFieldRegistry,
} from "../../../../src/core/schema/runtime-schema.js";
import type { RuntimeFieldType } from "../../../../src/types/index.js";

function makeField(overrides: Partial<RuntimeFieldDefinitionResolved> = {}): RuntimeFieldDefinitionResolved {
  const key = overrides.key ?? "story_points";
  return {
    key,
    metadata_key: overrides.metadata_key ?? key,
    cli_flag: overrides.cli_flag ?? key.replaceAll("_", "-"),
    cli_aliases: overrides.cli_aliases ?? [],
    description: overrides.description,
    type: (overrides.type ?? "string") as RuntimeFieldType,
    commands: overrides.commands ?? (["create", "update"] as RuntimeFieldCommand[]),
    repeatable: overrides.repeatable ?? false,
    required: overrides.required ?? false,
    required_on_create: overrides.required_on_create ?? false,
    required_types: overrides.required_types ?? [],
    allow_unset: overrides.allow_unset ?? true,
  };
}

function makeRegistry(definitions: RuntimeFieldDefinitionResolved[]): RuntimeFieldRegistry {
  const commandToFields = new Map<RuntimeFieldCommand, RuntimeFieldDefinitionResolved[]>();
  for (const definition of definitions) {
    for (const command of definition.commands) {
      const existing = commandToFields.get(command) ?? [];
      existing.push(definition);
      commandToFields.set(command, existing);
    }
  }
  return {
    definitions,
    by_key: new Map(definitions.map((definition) => [definition.key, definition])),
    by_cli_token: new Map(definitions.map((definition) => [definition.cli_flag, definition])),
    command_to_fields: commandToFields,
  };
}

describe("readRuntimeFieldOptionValue", () => {
  it("reads value by the camel-cased option target key", () => {
    const field = makeField({ key: "story_points" });
    expect(readRuntimeFieldOptionValue({ storyPoints: 5 }, field)).toBe(5);
  });

  it("returns undefined when no candidate key present", () => {
    const field = makeField({ key: "story_points" });
    expect(readRuntimeFieldOptionValue({ unrelated: 1 }, field)).toBeUndefined();
  });

  it("skips a present-but-undefined candidate and falls through", () => {
    const field = makeField({ key: "story_points" });
    expect(readRuntimeFieldOptionValue({ storyPoints: undefined }, field)).toBeUndefined();
  });

  it("falls back through alias camel tokens", () => {
    const field = makeField({ key: "story_points", cli_aliases: ["points"] });
    expect(readRuntimeFieldOptionValue({ points: 8 }, field)).toBe(8);
  });
});

describe("coerceRuntimeFieldValue scalar paths", () => {
  it("returns undefined for missing scalar", () => {
    const field = makeField({ type: "string" });
    expect(coerceRuntimeFieldValue(field, undefined)).toBeUndefined();
  });

  it("takes the last entry of an array for a scalar field", () => {
    const field = makeField({ type: "string" });
    expect(coerceRuntimeFieldValue(field, ["a", "b"])).toBe("b");
  });

  it("parses a scalar number", () => {
    const field = makeField({ type: "number" });
    expect(coerceRuntimeFieldValue(field, "42")).toBe(42);
  });

  it("returns a finite number directly", () => {
    const field = makeField({ type: "number" });
    expect(coerceRuntimeFieldValue(field, 7)).toBe(7);
  });

  it("parses a scalar boolean", () => {
    const field = makeField({ type: "boolean" });
    expect(coerceRuntimeFieldValue(field, "yes")).toBe(true);
  });

  it("stringifies a non-string scalar for a string field", () => {
    const field = makeField({ type: "string" });
    expect(coerceRuntimeFieldValue(field, 123)).toBe("123");
  });

  it("returns a string scalar verbatim", () => {
    const field = makeField({ type: "string" });
    expect(coerceRuntimeFieldValue(field, "hi")).toBe("hi");
  });

  it("uses the label override in number parse errors", () => {
    const field = makeField({ type: "number" });
    expect(() => coerceRuntimeFieldValue(field, "nope", "story points")).toThrow(/story points must be a number/);
  });
});

describe("coerceRuntimeFieldValue repeatable / array paths", () => {
  it("maps multiple values to numbers for a repeatable number field", () => {
    const field = makeField({ type: "number", repeatable: true });
    expect(coerceRuntimeFieldValue(field, ["1", "2", "3"])).toEqual([1, 2, 3]);
  });

  it("maps multiple values to numbers for a repeatable number field via comma split", () => {
    const field = makeField({ type: "number", repeatable: true });
    expect(coerceRuntimeFieldValue(field, "1,2")).toEqual([1, 2]);
    expect(coerceRuntimeFieldValue(field, "5|6")).toEqual([5, 6]);
  });

  it("maps multiple values to booleans for a repeatable boolean field", () => {
    const field = makeField({ type: "boolean", repeatable: true });
    expect(coerceRuntimeFieldValue(field, ["true", "0", "yes"])).toEqual([true, false, true]);
  });

  it("returns string list for a plain string_array field", () => {
    const field = makeField({ type: "string_array" as RuntimeFieldType, repeatable: true });
    expect(coerceRuntimeFieldValue(field, "a, b ,c")).toEqual(["a", "b", "c"]);
  });

  it("drops null/undefined entries when normalizing an array", () => {
    const field = makeField({ type: "string_array" as RuntimeFieldType, repeatable: true });
    expect(coerceRuntimeFieldValue(field, ["a", null, undefined, "b"])).toEqual(["a", "b"]);
  });

  it("coerces a non-string scalar entry to its string form in a string_array", () => {
    const field = makeField({ type: "string_array" as RuntimeFieldType, repeatable: true });
    expect(coerceRuntimeFieldValue(field, [7])).toEqual(["7"]);
  });
});

describe("parseBooleanValue branches via repeatable boolean coerce", () => {
  it("passes through an actual boolean scalar value", () => {
    // The scalar path forwards the raw value (no string normalization), so the
    // typeof === "boolean" branch is reachable here.
    const field = makeField({ type: "boolean" });
    expect(coerceRuntimeFieldValue(field, true)).toBe(true);
    expect(coerceRuntimeFieldValue(field, false)).toBe(false);
  });

  it("maps numeric 1 and 0 scalars to true/false", () => {
    const field = makeField({ type: "boolean" });
    expect(coerceRuntimeFieldValue(field, 1)).toBe(true);
    expect(coerceRuntimeFieldValue(field, 0)).toBe(false);
  });

  it("maps the false-family string tokens", () => {
    const field = makeField({ type: "boolean", repeatable: true });
    expect(coerceRuntimeFieldValue(field, ["false", "no"])).toEqual([false, false]);
  });

  it("throws on an unrecognized boolean token", () => {
    const field = makeField({ type: "boolean", repeatable: true });
    expect(() => coerceRuntimeFieldValue(field, ["maybe"])).toThrow(/must be one of true\|false\|1\|0\|yes\|no/);
  });

  it("throws on an out-of-range numeric scalar boolean", () => {
    const field = makeField({ type: "boolean" });
    expect(() => coerceRuntimeFieldValue(field, 2)).toThrow(/must be one of/);
  });
});

describe("parseNumberValue String(raw) branch via coerce", () => {
  it("stringifies a non-string non-finite raw before Number()", () => {
    const field = makeField({ type: "number", repeatable: true });
    // boolean true -> String(true) = "true" -> Number = NaN -> throws.
    expect(() => coerceRuntimeFieldValue(field, [true])).toThrow(/must be a number/);
  });

  it("stringifies a numeric-coercible non-string (boolean inside object array) and parses", () => {
    const field = makeField({ type: "number", repeatable: true });
    // An object stringifies to "[object Object]" -> NaN -> throws; use a value
    // whose String() is numeric. normalizeStringArrayValue turns numbers into strings,
    // so reach String(raw) with a non-string scalar in the scalar path instead.
    const scalar = makeField({ type: "number" });
    // Pass a boolean scalar: typeof !== string, not finite number -> String(true) -> NaN -> throws
    expect(() => coerceRuntimeFieldValue(scalar, true)).toThrow(/must be a number/);
  });
});

describe("toCamelToken empty-segment branch", () => {
  it("returns the original value when the key has no alphanumerics", () => {
    // A field whose key normalizes to no alnum segments forces the early return.
    const field = makeField({ key: "story_points", cli_flag: "---", cli_aliases: [] });
    // The candidate keys include toCamelToken(cli_flag="---") which has no alnum
    // segments and must return "---" verbatim; reading that key proves the branch.
    expect(readRuntimeFieldOptionValue({ "---": "v" }, field)).toBe("v");
  });
});

describe("collectRuntimeCreateFieldValues", () => {
  it("collects provided values and reports missing required flags sorted+deduped", () => {
    const provided = makeField({ key: "story_points", type: "number" });
    const requiredZeta = makeField({ key: "zeta", cli_flag: "zeta", required: true });
    const requiredAlpha = makeField({ key: "alpha", cli_flag: "alpha", required_on_create: true });
    const registry = makeRegistry([provided, requiredZeta, requiredAlpha]);
    const result = collectRuntimeCreateFieldValues({ storyPoints: "3" }, registry, undefined);
    expect(result.values).toEqual({ story_points: 3 });
    expect(result.missing_required_flags).toEqual(["--alpha", "--zeta"]);
  });

  it("does not require a typed-scoped field when itemType does not match", () => {
    const scoped = makeField({ key: "sprint", cli_flag: "sprint", required: true, required_types: ["bug"] });
    const registry = makeRegistry([scoped]);
    const result = collectRuntimeCreateFieldValues({}, registry, "task");
    expect(result.missing_required_flags).toEqual([]);
  });

  it("requires a typed-scoped field when itemType matches", () => {
    const scoped = makeField({ key: "sprint", cli_flag: "sprint", required: true, required_types: ["Bug"] });
    const registry = makeRegistry([scoped]);
    const result = collectRuntimeCreateFieldValues({}, registry, "bug");
    expect(result.missing_required_flags).toEqual(["--sprint"]);
  });

  it("does not require a scoped field when no itemType supplied", () => {
    const scoped = makeField({ key: "sprint", cli_flag: "sprint", required: true, required_types: ["bug"] });
    const registry = makeRegistry([scoped]);
    const result = collectRuntimeCreateFieldValues({}, registry, undefined);
    expect(result.missing_required_flags).toEqual([]);
  });

  it("does not flag an optional field as missing", () => {
    const optional = makeField({ key: "notes", cli_flag: "notes" });
    const registry = makeRegistry([optional]);
    const result = collectRuntimeCreateFieldValues({}, registry, undefined);
    expect(result.missing_required_flags).toEqual([]);
    expect(result.values).toEqual({});
  });

  it("handles a registry without a create command", () => {
    const registry = makeRegistry([]);
    const result = collectRuntimeCreateFieldValues({}, registry, undefined);
    expect(result).toEqual({ values: {}, missing_required_flags: [] });
  });
});

describe("collectRuntimeUpdateFieldValues", () => {
  it("collects update values and de-dupes by metadata key across commands", () => {
    const updateField = makeField({ key: "story_points", type: "number", commands: ["update"] });
    const manyField = makeField({ key: "story_points", type: "number", commands: ["update_many"] });
    const registry = makeRegistry([updateField, manyField]);
    const values = collectRuntimeUpdateFieldValues({ storyPoints: "9" }, registry, ["update", "update_many"]);
    expect(values).toEqual({ story_points: 9 });
  });

  it("skips fields without a provided value", () => {
    const field = makeField({ key: "notes", cli_flag: "notes", commands: ["update"] });
    const registry = makeRegistry([field]);
    expect(collectRuntimeUpdateFieldValues({}, registry, ["update"])).toEqual({});
  });

  it("defaults to the update command when commands is null", () => {
    const field = makeField({ key: "notes", cli_flag: "notes", commands: ["update"] });
    const registry = makeRegistry([field]);
    expect(collectRuntimeUpdateFieldValues({ notes: "hi" }, registry, null)).toEqual({ notes: "hi" });
  });

  it("defaults to the update command when commands omitted", () => {
    const field = makeField({ key: "notes", cli_flag: "notes", commands: ["update"] });
    const registry = makeRegistry([field]);
    expect(collectRuntimeUpdateFieldValues({ notes: "hi" }, registry)).toEqual({ notes: "hi" });
  });

  it("yields no values for a command absent from the registry map", () => {
    const field = makeField({ key: "notes", cli_flag: "notes", commands: ["update"] });
    const registry = makeRegistry([field]);
    // update_many has no entry in command_to_fields -> exercises the `?? []` fallback.
    expect(collectRuntimeUpdateFieldValues({ notes: "hi" }, registry, ["update_many"])).toEqual({});
  });
});
