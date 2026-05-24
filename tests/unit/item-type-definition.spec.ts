import { describe, expect, it } from "vitest";
import {
  keepPolicyCommand,
  normalizeItemTypeCommandOptionPolicies,
  normalizeItemTypeCommandOptionPolicy,
  normalizeItemTypeDefinition,
  normalizeItemTypeOption,
  normalizeItemTypeStringList,
  strictPolicyCommand,
} from "../../src/core/item/item-type-definition.js";
import type {
  ItemTypeCommandOptionPolicy,
  ItemTypeOptionDefinition,
} from "../../src/types/index.js";

describe("normalizeItemTypeStringList", () => {
  it("trims, drops blanks, dedupes, and locale-sorts", () => {
    expect(normalizeItemTypeStringList([" b ", "a", "a", "", "  ", "C"])).toEqual(["a", "b", "C"]);
  });

  it("returns an empty list for undefined", () => {
    expect(normalizeItemTypeStringList(undefined)).toEqual([]);
  });
});

describe("normalizeItemTypeOption", () => {
  it("returns null when the key is blank after trim", () => {
    expect(normalizeItemTypeOption({ key: "   ", values: [] })).toBeNull();
  });

  it("normalizes key/values and omits empty optional fields", () => {
    expect(
      normalizeItemTypeOption({ key: "  size ", values: ["m", "s", "s", " l "] }),
    ).toEqual({
      key: "size",
      values: ["l", "m", "s"],
      required: undefined,
      aliases: undefined,
      description: undefined,
    });
  });

  it("keeps required only when strictly true and emits non-empty aliases/description", () => {
    expect(
      normalizeItemTypeOption({
        key: "size",
        values: [],
        required: true,
        aliases: ["sz", "size", "  "],
        description: "  pick a size  ",
      }),
    ).toEqual({
      key: "size",
      values: [],
      required: true,
      aliases: ["size", "sz"],
      description: "pick a size",
    });
  });

  it("coerces non-true required to undefined and drops whitespace-only description/aliases", () => {
    expect(
      normalizeItemTypeOption({
        key: "size",
        values: [],
        required: false,
        aliases: ["   "],
        description: "   ",
      }),
    ).toEqual({
      key: "size",
      values: [],
      required: undefined,
      aliases: undefined,
      description: undefined,
    });
  });
});

describe("policy command resolvers", () => {
  it("keepPolicyCommand passes the value through verbatim", () => {
    expect(keepPolicyCommand("create")).toBe("create");
    expect(keepPolicyCommand("update")).toBe("update");
    // Pass-through trusts already-validated input; it does not re-validate.
    expect(keepPolicyCommand("CREATE" as never)).toBe("CREATE");
  });

  it("strictPolicyCommand trims, lowercases, and rejects unknown commands", () => {
    expect(strictPolicyCommand("  CREATE ")).toBe("create");
    expect(strictPolicyCommand("Update")).toBe("update");
    expect(strictPolicyCommand("delete")).toBeNull();
    expect(strictPolicyCommand("   ")).toBeNull();
  });
});

describe("normalizeItemTypeCommandOptionPolicy", () => {
  it("returns null when the resolver rejects the command", () => {
    expect(
      normalizeItemTypeCommandOptionPolicy(
        { command: "delete" as never, option: "title" },
        strictPolicyCommand,
      ),
    ).toBeNull();
  });

  it("returns null when the option is blank after trim", () => {
    expect(
      normalizeItemTypeCommandOptionPolicy({ command: "create", option: "   " }, keepPolicyCommand),
    ).toBeNull();
  });

  it("trims the option and carries required/visible/enabled through", () => {
    expect(
      normalizeItemTypeCommandOptionPolicy(
        { command: "create", option: "  title  ", required: true, visible: false, enabled: true },
        keepPolicyCommand,
      ),
    ).toEqual({
      command: "create",
      option: "title",
      required: true,
      visible: false,
      enabled: true,
    });
  });

  it("uses the resolved (lowercased) command from the strict resolver", () => {
    expect(
      normalizeItemTypeCommandOptionPolicy(
        { command: "UPDATE" as never, option: "body" },
        strictPolicyCommand,
      ),
    ).toMatchObject({ command: "update", option: "body" });
  });
});

describe("normalizeItemTypeCommandOptionPolicies", () => {
  it("returns an empty list for undefined input", () => {
    expect(normalizeItemTypeCommandOptionPolicies(undefined, keepPolicyCommand)).toEqual([]);
  });

  it("drops invalid entries, dedupes by command+lowercased option, and stable-sorts", () => {
    const policies: ItemTypeCommandOptionPolicy[] = [
      { command: "update", option: "Title", required: true },
      { command: "create", option: "body" },
      { command: "create", option: "title" },
      // duplicate key (create:body) - last one wins
      { command: "create", option: "BODY", required: false },
      // invalid - blank option, dropped
      { command: "create", option: "  " },
    ];
    expect(normalizeItemTypeCommandOptionPolicies(policies, keepPolicyCommand)).toEqual([
      { command: "create", option: "BODY", required: false, visible: undefined, enabled: undefined },
      { command: "create", option: "title", required: undefined, visible: undefined, enabled: undefined },
      { command: "update", option: "Title", required: true, visible: undefined, enabled: undefined },
    ]);
  });

  it("rejects unknown commands when the strict resolver is used", () => {
    const policies: ItemTypeCommandOptionPolicy[] = [
      { command: "delete" as never, option: "title" },
      { command: "  Create " as never, option: "body" },
    ];
    expect(normalizeItemTypeCommandOptionPolicies(policies, strictPolicyCommand)).toEqual([
      { command: "create", option: "body", required: undefined, visible: undefined, enabled: undefined },
    ]);
  });
});

describe("normalizeItemTypeDefinition", () => {
  it("returns null when the name is blank/whitespace", () => {
    expect(normalizeItemTypeDefinition({ name: "   " })).toBeNull();
    expect(normalizeItemTypeDefinition({ name: "" })).toBeNull();
  });

  it("trims the name and leaves all optional fields undefined when unset", () => {
    expect(normalizeItemTypeDefinition({ name: "  Spike  " })).toEqual({
      name: "Spike",
      folder: undefined,
      aliases: undefined,
      required_create_fields: undefined,
      required_create_repeatables: undefined,
      options: undefined,
      command_option_policies: undefined,
    });
  });

  it("trims the folder and drops it when blank", () => {
    expect(normalizeItemTypeDefinition({ name: "Spike", folder: "  spikes  " }).folder).toBe("spikes");
    expect(normalizeItemTypeDefinition({ name: "Spike", folder: "   " }).folder).toBeUndefined();
  });

  it("normalizes aliases and drops the field when none survive", () => {
    expect(normalizeItemTypeDefinition({ name: "Spike", aliases: ["b", "a", "a", "  "] }).aliases).toEqual([
      "a",
      "b",
    ]);
    expect(normalizeItemTypeDefinition({ name: "Spike", aliases: ["  "] }).aliases).toBeUndefined();
  });

  it("preserves presence of required_create_fields/repeatables (set-but-empty vs unset)", () => {
    const setEmpty = normalizeItemTypeDefinition({
      name: "Spike",
      required_create_fields: ["  "],
      required_create_repeatables: [],
    });
    expect(setEmpty.required_create_fields).toEqual([]);
    expect(setEmpty.required_create_repeatables).toEqual([]);

    const populated = normalizeItemTypeDefinition({
      name: "Spike",
      required_create_fields: ["status", "title", "title"],
      required_create_repeatables: ["dep", "comment"],
    });
    expect(populated.required_create_fields).toEqual(["status", "title"]);
    expect(populated.required_create_repeatables).toEqual(["comment", "dep"]);

    const unset = normalizeItemTypeDefinition({ name: "Spike" });
    expect(unset.required_create_fields).toBeUndefined();
    expect(unset.required_create_repeatables).toBeUndefined();
  });

  it("normalizes options (sorted by key, blank keys dropped) and preserves presence", () => {
    const options: ItemTypeOptionDefinition[] = [
      { key: "size", values: ["m", "s"] },
      { key: "color", values: [] },
      { key: "  ", values: [] },
    ];
    const result = normalizeItemTypeDefinition({ name: "Spike", options });
    expect(result.options?.map((option) => option.key)).toEqual(["color", "size"]);

    expect(normalizeItemTypeDefinition({ name: "Spike", options: [] }).options).toEqual([]);
    expect(normalizeItemTypeDefinition({ name: "Spike" }).options).toBeUndefined();
  });

  it("defaults to the pass-through policy resolver (keeps the typed command)", () => {
    const result = normalizeItemTypeDefinition({
      name: "Spike",
      command_option_policies: [{ command: "create", option: "title" }],
    });
    expect(result.command_option_policies).toEqual([
      { command: "create", option: "title", required: undefined, visible: undefined, enabled: undefined },
    ]);
  });

  it("applies the strict policy resolver and dedupe/sort when provided", () => {
    const result = normalizeItemTypeDefinition(
      {
        name: "Spike",
        command_option_policies: [
          { command: "UPDATE" as never, option: "Title" },
          { command: "delete" as never, option: "body" },
          { command: "create" as never, option: "body" },
          { command: "create" as never, option: "BODY", required: true },
        ],
      },
      { resolvePolicyCommand: strictPolicyCommand },
    );
    expect(result.command_option_policies).toEqual([
      { command: "create", option: "BODY", required: true, visible: undefined, enabled: undefined },
      { command: "update", option: "Title", required: undefined, visible: undefined, enabled: undefined },
    ]);
  });

  it("preserves command_option_policies presence (set-but-empty vs unset)", () => {
    expect(normalizeItemTypeDefinition({ name: "Spike", command_option_policies: [] }).command_option_policies).toEqual(
      [],
    );
    expect(normalizeItemTypeDefinition({ name: "Spike" }).command_option_policies).toBeUndefined();
  });
});
