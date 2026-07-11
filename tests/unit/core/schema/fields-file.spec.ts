import { describe, expect, it } from "vitest";
import {
  BUILTIN_FIELD_KEYS,
  normalizeAddFieldInput,
  normalizeFieldKey,
  parseFieldsFile,
  removeField,
  serializeFieldsFile,
  upsertField,
} from "../../../../src/core/schema/fields-file.js";

describe("normalizeFieldKey", () => {
  it("lowercases and collapses whitespace/hyphen runs to underscore", () => {
    expect(normalizeFieldKey("  Severity-Level  ")).toBe("severity_level");
    expect(normalizeFieldKey("owner  team")).toBe("owner_team");
  });

  it("returns empty string for non-string input", () => {
    expect(normalizeFieldKey(undefined)).toBe("");
    expect(normalizeFieldKey(42)).toBe("");
  });
});

describe("normalizeAddFieldInput", () => {
  it("applies defaults for a minimal field", () => {
    const normalized = normalizeAddFieldInput({ key: "Severity Level" });
    expect(normalized).toEqual({
      key: "severity_level",
      type: "string",
      commands: ["create", "update"],
      description: undefined,
      cliFlag: undefined,
      cliAliases: [],
      required: false,
      requiredOnCreate: false,
      allowUnset: true,
      requiredTypes: [],
    });
  });

  it("throws on empty key", () => {
    expect(() => normalizeAddFieldInput({ key: "   " })).toThrow(/Field key must not be empty/);
  });

  it("rejects a key that shadows a built-in field", () => {
    expect(() => normalizeAddFieldInput({ key: "status" })).toThrow(/collides with built-in item metadata/);
    expect(() => normalizeAddFieldInput({ key: "customer-impact" })).toThrow(/collides with built-in item metadata/);
    expect(() => normalizeAddFieldInput({ key: "expected_result" })).toThrow(/Reserved fields:.*expected_result/);
  });

  it("rejects an invalid type", () => {
    expect(() => normalizeAddFieldInput({ key: "owner", type: "datetime" })).toThrow(/Invalid field type/);
  });

  it("accepts an explicit valid type and normalizes case", () => {
    expect(normalizeAddFieldInput({ key: "count", type: "NUMBER" }).type).toBe("number");
  });

  it("rejects an invalid command token", () => {
    expect(() => normalizeAddFieldInput({ key: "owner", commands: ["create", "bogus"] })).toThrow(/Invalid field command/);
  });

  it("dedupes commands and ignores blanks, falling back to defaults when all blank", () => {
    expect(normalizeAddFieldInput({ key: "owner", commands: ["create", "create", "list"] }).commands).toEqual([
      "create",
      "list",
    ]);
    expect(normalizeAddFieldInput({ key: "owner", commands: ["", "   "] }).commands).toEqual(["create", "update"]);
  });

  it("keeps an explicit cli flag only when it differs from the derived flag", () => {
    expect(normalizeAddFieldInput({ key: "owner_team", cliFlag: "--owner-team" }).cliFlag).toBeUndefined();
    expect(normalizeAddFieldInput({ key: "owner_team", cliFlag: "--ot" }).cliFlag).toBe("ot");
  });

  it("dedupes cli aliases and drops the effective flag from them", () => {
    const normalized = normalizeAddFieldInput({
      key: "owner",
      cliFlag: "--lead",
      aliases: ["--lead", "--Owner", "owner", "captain", "captain"],
    });
    expect(normalized.cliFlag).toBe("lead");
    expect(normalized.cliAliases).toEqual(["captain", "owner"]);
  });

  it("captures the required/requiredOnCreate flags and the allow-unset override", () => {
    const normalized = normalizeAddFieldInput({
      key: "owner",
      required: true,
      requiredOnCreate: true,
      allowUnset: false,
      requiredTypes: ["Bug", "  ", "Bug", "Story"],
    });
    expect(normalized.required).toBe(true);
    expect(normalized.requiredOnCreate).toBe(true);
    expect(normalized.allowUnset).toBe(false);
    expect(normalized.requiredTypes).toEqual(["Bug", "Story"]);
  });

  it("trims a description to undefined when empty", () => {
    expect(normalizeAddFieldInput({ key: "owner", description: "   " }).description).toBeUndefined();
    expect(normalizeAddFieldInput({ key: "owner", description: " who owns it " }).description).toBe("who owns it");
  });

  it("exposes the built-in field key set", () => {
    expect(BUILTIN_FIELD_KEYS.has("title")).toBe(true);
    expect(BUILTIN_FIELD_KEYS.has("customer_impact")).toBe(true);
    expect(BUILTIN_FIELD_KEYS.has("severity_level")).toBe(false);
  });
});

describe("parseFieldsFile", () => {
  it("returns empty fields for null/blank input", () => {
    expect(parseFieldsFile(null)).toEqual({ fields: [] });
    expect(parseFieldsFile("   ")).toEqual({ fields: [] });
  });

  it("throws on invalid JSON", () => {
    expect(() => parseFieldsFile("{not json")).toThrow(/invalid JSON/);
  });

  it("accepts the canonical { fields } shape", () => {
    const file = parseFieldsFile(JSON.stringify({ fields: [{ key: "owner", type: "string" }] }));
    expect(file.fields).toHaveLength(1);
    expect(file.fields[0].key).toBe("owner");
  });

  it("accepts a bare array and a { definitions } shape", () => {
    expect(parseFieldsFile(JSON.stringify([{ key: "a" }])).fields).toHaveLength(1);
    expect(parseFieldsFile(JSON.stringify({ definitions: [{ key: "b" }] })).fields).toHaveLength(1);
  });

  it("ignores entries that are not objects or lack a key, and unknown shapes", () => {
    expect(parseFieldsFile(JSON.stringify({ fields: [1, null, [], { key: "" }, { key: "ok" }] })).fields).toHaveLength(1);
    expect(parseFieldsFile(JSON.stringify(42)).fields).toEqual([]);
    expect(parseFieldsFile(JSON.stringify({ other: true })).fields).toEqual([]);
  });
});

describe("serializeFieldsFile", () => {
  it("serializes with a trailing newline", () => {
    const out = serializeFieldsFile({ fields: [{ key: "owner", type: "string" }] });
    expect(out.endsWith("\n")).toBe(true);
    expect(JSON.parse(out)).toEqual({ fields: [{ key: "owner", type: "string" }] });
  });
});

describe("upsertField", () => {
  it("inserts a new field and sorts by key", () => {
    const first = upsertField({ fields: [] }, normalizeAddFieldInput({ key: "zeta" }));
    expect(first.replaced).toBe(false);
    const second = upsertField(first.file, normalizeAddFieldInput({ key: "alpha", type: "number" }));
    expect(second.replaced).toBe(false);
    expect(second.file.fields.map((f) => f.key)).toEqual(["alpha", "zeta"]);
  });

  it("persists optional attributes and clears them on a subsequent bare upsert", () => {
    const withAttrs = upsertField(
      { fields: [] },
      normalizeAddFieldInput({
        key: "owner",
        description: "who owns it",
        cliFlag: "--lead",
        aliases: ["captain"],
        required: true,
        requiredOnCreate: true,
        allowUnset: false,
        requiredTypes: ["Bug"],
      }),
    );
    const stored = withAttrs.file.fields[0];
    expect(stored).toMatchObject({
      key: "owner",
      description: "who owns it",
      cli_flag: "lead",
      cli_aliases: ["captain"],
      required: true,
      required_on_create: true,
      allow_unset: false,
      required_types: ["Bug"],
    });

    const bare = upsertField(withAttrs.file, normalizeAddFieldInput({ key: "owner" }));
    expect(bare.replaced).toBe(true);
    const cleared = bare.file.fields[0] as Record<string, unknown>;
    expect(cleared.description).toBeUndefined();
    expect(cleared.cli_flag).toBeUndefined();
    expect(cleared.cli_aliases).toBeUndefined();
    expect(cleared.required).toBeUndefined();
    expect(cleared.required_on_create).toBeUndefined();
    expect(cleared.allow_unset).toBeUndefined();
    expect(cleared.required_types).toBeUndefined();
  });

  it("preserves an unrelated stored key (e.g. metadata_key) across upsert", () => {
    const seed = { fields: [{ key: "owner", type: "string", metadata_key: "owner_legacy" }] };
    const result = upsertField(seed as never, normalizeAddFieldInput({ key: "owner", type: "number" }));
    expect(result.replaced).toBe(true);
    expect((result.file.fields[0] as Record<string, unknown>).metadata_key).toBe("owner_legacy");
    expect(result.file.fields[0].type).toBe("number");
  });
});

describe("removeField", () => {
  it("throws on empty key", () => {
    expect(() => removeField({ fields: [] }, "  ")).toThrow(/Field key must not be empty/);
  });

  it("returns removed:false when no match", () => {
    const result = removeField({ fields: [{ key: "owner", type: "string" }] }, "missing");
    expect(result.removed).toBe(false);
    expect(result.definition).toBeUndefined();
    expect(result.file.fields).toHaveLength(1);
  });

  it("removes a matching field (key-normalized)", () => {
    const result = removeField({ fields: [{ key: "owner", type: "string" }] }, "Owner");
    expect(result.removed).toBe(true);
    expect(result.definition?.key).toBe("owner");
    expect(result.file.fields).toHaveLength(0);
  });
});
