/**
 * pm-x17o8l: a status or type entry in the schema files with a wrong-typed
 * member (a numeric description, a non-string alias) threw inside the settings
 * read, which then fell back to defaults for every setting. The registries now
 * ignore such members, keep the rest of the entry, and `pm validate` names
 * each one with its file and position.
 */
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { inspectItemTypeDefinition } from "../../../../src/core/item/item-type-inspection.js";
import { resolveItemTypeRegistry, resolveTypeDefinition } from "../../../../src/core/item/type-registry.js";
import { inspectRuntimeStatusDefinition, normalizeRuntimeSchemaSettings, resolveRuntimeStatusRegistry } from "../../../../src/core/schema/runtime-schema.js";
import { readSettings } from "../../../../src/core/store/settings.js";
import { resolveItemExecutionRole } from "../../../../src/core/item/actionability.js";
import { scanSchemaFileEntryLosses } from "../../../../src/sdk/schema/schema-file-entry-losses.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";

const STATUS_MEMBERS: Array<[string, Record<string, unknown>, string[]]> = [
  ["a numeric description", { id: "triage", description: 5 }, ["description: is not a string"]],
  ["an object description", { id: "triage", description: { text: "x" } }, ["description: is not a string"]],
  ["aliases that are not a list", { id: "triage", aliases: "tri" }, ["aliases: is not a list"]],
  ["non-string and blank aliases", { id: "triage", aliases: [3, " ", "tri", null] }, ["aliases: 3 is not a status name", 'aliases: " " is not a status name', "aliases: null is not a status name"]],
  ["roles that are not a list", { id: "triage", roles: 7 }, ["roles: is not a list"]],
  ["unknown and non-string roles", { id: "triage", roles: ["terminal", 7, "bogus"] }, ["roles: 7 is not a status role", 'roles: "bogus" is not a status role']],
  ["a string order", { id: "triage", order: "2" }, ['order: "2" is not a number, so the status keeps its position']],
  ["an infinite order", { id: "triage", order: Number.POSITIVE_INFINITY }, ["order: null is not a number, so the status keeps its position"]],
];

describe("stored status definitions", () => {
  it.each(STATUS_MEMBERS)("ignores %s and keeps the status", (_label, definition, ignored) => {
    const { resolved, loss } = inspectRuntimeStatusDefinition(definition, 4);
    expect(loss).toEqual({ ignored });
    expect(resolved?.id).toBe("triage");
    // The registry reads the same function: its definition is the inspected one, at its own position.
    const registered = resolveRuntimeStatusRegistry(normalizeRuntimeSchemaSettings({ statuses: [definition] } as never)).definitions.find((status) => status.id === "triage");
    expect(registered).toEqual({ ...resolved, order: 0 });
  });

  it.each([
    [null, "not_an_object"],
    [[], "not_an_object"],
    ["triage", "not_an_object"],
    [{}, "id_empty"],
    [{ id: 5 }, "id_empty"],
    [{ id: "   " }, "id_empty"],
  ])("drops %j whole", (definition, dropped) => {
    expect(inspectRuntimeStatusDefinition(definition, 0)).toEqual({ resolved: null, loss: { dropped, ignored: [] } });
  });

  it("reports nothing for a definition kept whole and keeps its members", () => {
    expect(inspectRuntimeStatusDefinition({ id: "Triage", aliases: ["tri"], roles: ["terminal"], description: " Waiting ", order: 2 }, 9)).toEqual({
      resolved: { id: "triage", aliases: ["tri"], roles: ["terminal"], description: "Waiting", order: 2 },
      loss: { ignored: [] },
    });
  });
});

const TYPE_MEMBERS: Array<[string, Record<string, unknown>, string[]]> = [
  ["a numeric description", { description: 5 }, ["description: is not a string"]],
  ["a numeric default status", { default_status: 5 }, ["default_status: is not a string"]],
  ["a numeric folder", { folder: 3 }, ["folder: is not a string"]],
  ["aliases that are not a list", { aliases: "spk" }, ["aliases: is not a list"]],
  ["non-string aliases", { aliases: [5, "spk"] }, ["aliases: 5 is not a string"]],
  ["non-string required create fields", { required_create_fields: [1, "title"], required_create_repeatables: "tags" }, ["required_create_fields: 1 is not a string", "required_create_repeatables: is not a list"]],
  ["options that are not a list", { options: { key: "k" } }, ["options: is not a list"]],
  ["options with wrong-typed members", { options: [{ key: "k", values: [1, "a"], aliases: "x", description: 2, required: "yes" }, 7, { key: 3 }, { key: " " }] }, [
    "options[0].values: 1 is not a string",
    'options[0].required: "yes" is not a boolean, so it is ignored',
    "options[0].aliases: is not a list",
    "options[0].description: is not a string",
    "options[1]: 7 is not an option with a key",
    'options[2]: {"key":3} is not an option with a key',
    'options[3]: {"key":" "} is not an option with a key',
  ]],
  ["policies that are not a list", { command_option_policies: 1 }, ["command_option_policies: is not a list"]],
  ["policies with wrong-typed members", { command_option_policies: [{ command: " CREATE ", option: "x", required: 0, visible: 1, enabled: "no" }, { command: "x", option: "y" }, { command: "create", option: 4 }, null, { command: "update", option: " ", enabled: false }] }, [
    "command_option_policies[0].required: 0 is not a boolean, so it is ignored",
    "command_option_policies[0].visible: 1 is not a boolean, so it is ignored",
    'command_option_policies[0].enabled: "no" is not a boolean, so it is ignored',
    'command_option_policies[1]: {"command":"x","option":"y"} is not a create or update policy with an option',
    'command_option_policies[2]: {"command":"create","option":4} is not a create or update policy with an option',
    "command_option_policies[3]: null is not a create or update policy with an option",
    'command_option_policies[4]: {"command":"update","option":" ","enabled":false} is not a create or update policy with an option',
  ]],
];

const NO_SETTINGS = { item_types: { definitions: [] } } as never;

describe("stored type definitions", () => {
  it.each(TYPE_MEMBERS)("ignores %s and keeps the type", (_label, members, ignored) => {
    const { definition, loss } = inspectItemTypeDefinition({ name: "Spike", ...members }, "schema_file");
    expect(loss).toEqual({ ignored });
    expect(definition?.name).toBe("Spike");
  });

  it("names values JSON cannot show, and reports nothing for well-typed switches and an option without values", () => {
    expect(inspectItemTypeDefinition({ name: "Spike", aliases: [10n, () => 1] }, "schema_file").loss.ignored).toEqual([
      "aliases: a value that cannot be shown is not a string",
      "aliases: () => 1 is not a string",
    ]);
    expect(inspectItemTypeDefinition({
      name: "Spike",
      options: [{ key: "k", required: true }],
      command_option_policies: [{ command: "update", option: "x", required: false, visible: true, enabled: true }],
    }, "schema_file")).toMatchObject({ definition: { options: [{ key: "k", values: [], required: true }] }, loss: { ignored: [] } });
  });

  it("keeps the readable members of a partly wrong-typed type", () => {
    const { definition } = inspectItemTypeDefinition({
      name: "Spike",
      aliases: [5, "spk"],
      options: [{ key: "k", values: [1, "a"], required: "yes" }, 7],
      command_option_policies: [{ command: " CREATE ", option: "x", visible: 1 }],
    }, "schema_file");
    // A switch that is not a boolean is ignored in a schema file, so `required: "yes"` adds no requirement.
    expect(definition).toMatchObject({
      aliases: ["spk"],
      options: [{ key: "k", values: ["a"] }],
      command_option_policies: [{ command: "create", option: "x" }],
    });
    expect(definition?.options?.[0]?.required).toBeUndefined();
    expect(definition?.command_option_policies?.[0]?.visible).toBeUndefined();
    // An extension registration keeps its earlier Boolean reading.
    expect(inspectItemTypeDefinition({ name: "Spike", options: [{ key: "k", required: "false" }] }, "extension")).toMatchObject({
      definition: { options: [{ key: "k", required: true }] },
      loss: { ignored: ['options[0].required: "false" is not a boolean, so it reads as true'] },
    });
  });

  it("reads a list with no usable entry as absent, never as an explicit empty override (Codex review)", () => {
    const wrong = inspectItemTypeDefinition({ name: "Task", required_create_fields: [5], aliases: [1, 2] }, "schema_file");
    expect(wrong.definition?.required_create_fields).toBeUndefined();
    expect(wrong.definition?.aliases).toBeUndefined();
    expect(wrong.loss.ignored).toEqual(["aliases: 1 is not a string", "aliases: 2 is not a string", "required_create_fields: 5 is not a string"]);
    expect(inspectItemTypeDefinition({ name: "Task", required_create_fields: [] }, "schema_file").definition?.required_create_fields).toEqual([]);
    // A blank entry is as unusable as a wrong-typed one, so it cannot make the list an explicit override (Codex review).
    const blank = inspectItemTypeDefinition({ name: "Task", required_create_fields: [5, " "], required_create_repeatables: ["", "tags"] }, "schema_file");
    expect(blank.definition).toMatchObject({ required_create_repeatables: ["tags"] });
    expect(blank.definition?.required_create_fields).toBeUndefined();
    expect(blank.loss.ignored).toEqual(['required_create_fields: 5 is not a string', 'required_create_fields: " " is blank', 'required_create_repeatables: "" is blank']);
    // A list of records with no usable record reads as absent too, so it cannot clear inherited options (CodeRabbit review).
    const records = inspectItemTypeDefinition({ name: "Task", options: [null], command_option_policies: [7] }, "schema_file");
    expect(records.definition?.options).toBeUndefined();
    expect(records.definition?.command_option_policies).toBeUndefined();
    expect(records.loss.ignored).toEqual(["options[0]: null is not an option with a key", "command_option_policies[0]: 7 is not a create or update policy with an option"]);
    expect(inspectItemTypeDefinition({ name: "Task", options: [] }, "schema_file").definition?.options).toEqual([]);
    // A supplied allowlist with no usable value drops the option instead of admitting any value (Codex review).
    const allowlist = inspectItemTypeDefinition({ name: "Task", options: [{ key: "approval", values: [null, " "] }, { key: "risk", values: [] }] }, "schema_file");
    expect(allowlist.definition?.options).toEqual([{ key: "risk", values: [], required: undefined, aliases: undefined, description: undefined }]);
    expect(allowlist.loss.ignored).toEqual([
      "options[0].values: null is not a string",
      'options[0].values: " " is blank',
      "options[0]: values has no usable value, so the option is dropped",
    ]);
    // Through the registry the built-in Task requirements survive such an override.
    const registry = resolveItemTypeRegistry({ item_types: { definitions: [blank.definition!] } } as never);
    expect(resolveTypeDefinition("Task", registry)?.required_create_fields.length).toBeGreaterThan(0);
  });

  it.each([
    [null, "not_an_object"],
    [[], "not_an_object"],
    [{}, "name_empty"],
    [{ name: 5 }, "name_empty"],
    [{ name: " " }, "name_empty"],
  ])("drops %j whole", (raw, dropped) => {
    expect(inspectItemTypeDefinition(raw, "schema_file")).toEqual({ definition: null, loss: { dropped, ignored: [] } });
  });

  it("fails closed for an unknown execution role in a schema file, and refuses one in a registration", () => {
    for (const role of ["humna", 5, null]) {
      const { definition, loss } = inspectItemTypeDefinition({ name: "Spike", execution_role: role }, "schema_file");
      expect(definition?.execution_role).toBe("human");
      expect(loss.ignored[0]).toMatch(/^execution_role: .* is not agent, human or gate, so the type reads as human/u);
      expect(() => inspectItemTypeDefinition({ name: "Spike", execution_role: role }, "extension")).toThrow("execution_role must be agent, human, or gate");
    }
    for (const role of ["agent", "human", "gate", undefined]) {
      expect(inspectItemTypeDefinition({ name: "Spike", execution_role: role }, "schema_file")).toMatchObject({ definition: { execution_role: role }, loss: { ignored: [] } });
    }
  });

  it("reads an extension registration as before: wrong-typed members are dropped, an unknown role is refused", () => {
    const registrations = (types: unknown[]) => ({ item_types: [{ types }] }) as never;
    const registry = resolveItemTypeRegistry(NO_SETTINGS, registrations([{ name: "Spike", description: 5, aliases: [5, "spk"], options: [7, { key: "k", values: [1, "a"] }, { key: "x", values: [1] }] }, null]));
    // The unusable allowlist of x drops that option rather than admitting any value.
    expect(resolveTypeDefinition("Spike", registry)).toMatchObject({ aliases: ["spk"], options: [{ key: "k", values: ["a"] }] });
    expect(() => resolveItemTypeRegistry(NO_SETTINGS, registrations([{ name: "Spike", execution_role: "humna" }]))).toThrow("execution_role");
  });
});

describe("schema files with wrong-typed members", () => {
  /** Write both schema files, keeping a custom setting that a failed read would reset. */
  async function seed(pmPath: string, statuses: unknown, types: unknown): Promise<void> {
    const settingsPath = path.join(pmPath, "settings.json");
    const settings = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
    await writeFile(settingsPath, JSON.stringify({ ...settings, id_prefix: "zz-" }));
    await writeFile(path.join(pmPath, "schema", "statuses.json"), JSON.stringify(statuses));
    await writeFile(path.join(pmPath, "schema", "types.json"), JSON.stringify(types));
  }

  it("keeps the settings read and every readable member, and validate names each ignored member", async () => {
    await withTempPmPath(async ({ pmPath, runCli }) => {
      await seed(
        pmPath,
        { statuses: [{ id: "triage", description: 5, aliases: [3, "tri"] }, null] },
        { definitions: [{ name: "Spike", description: 5, aliases: [5, "spk"], folder: 3, execution_role: "humna" }, { name: "" }] },
      );
      const settings = await readSettings(pmPath);
      expect(settings.id_prefix).toBe("zz-");
      expect(settings.schema.statuses.find((status) => status.id === "triage")).toMatchObject({ aliases: ["tri"] });
      const spike = settings.item_types.definitions.find((definition) => definition.name === "Spike");
      expect(spike).toMatchObject({ aliases: ["spk"], execution_role: "human" });
      expect(spike?.description).toBeUndefined();
      expect(resolveItemExecutionRole("Spike", resolveItemTypeRegistry(settings))).toBe("human");

      const scanned = await scanSchemaFileEntryLosses(pmPath, settings.schema, 1);
      expect(scanned.warnings).toEqual([
        "validate_schema_status_definition_dropped:1",
        "validate_schema_status_definition_partial:1",
        "validate_schema_type_definition_dropped:1",
        "validate_schema_type_definition_partial:1",
      ]);
      expect(scanned.details).toMatchObject({
        schema_status_definition_loss_count: 2,
        schema_status_definition_losses: [{ source: "schema/statuses.json", index: 0, id: "triage", ignored: ["aliases: 3 is not a status name", "description: is not a string"] }],
        schema_status_definition_losses_truncated: true,
        schema_type_definition_loss_count: 2,
        schema_type_definition_losses_truncated: true,
      });
      expect(String(scanned.details.schema_definition_loss_fix_hint)).toContain("execution_role");

      const validated = runCli(["validate", "--check-metadata", "--json"], { expectJson: true }).json as { warnings: string[] };
      expect(validated.warnings).toEqual(expect.arrayContaining(["validate_schema_status_definition_partial:1", "validate_schema_type_definition_dropped:1"]));
    });
  });

  it("reports dropped entries alone, and reads nothing from an absent or unreadable file", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      await seed(pmPath, { not_statuses: [] }, [null, { name: 5 }]);
      const scanned = await scanSchemaFileEntryLosses(pmPath, (await readSettings(pmPath)).schema, 10);
      expect(scanned.warnings).toEqual(["validate_schema_type_definition_dropped:2"]);
      expect(scanned.details).not.toHaveProperty("schema_status_definition_losses");
      await rm(path.join(pmPath, "schema", "types.json"));
      await expect(scanSchemaFileEntryLosses(pmPath, (await readSettings(pmPath)).schema, 10)).resolves.toEqual({ details: {}, warnings: [] });
    });
  });

  it("reports nothing for readable schema files, and reads the files the stored settings configure", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      await seed(pmPath, [{ id: "triage" }], [{ name: "Spike" }]);
      const settings = await readSettings(pmPath);
      await expect(scanSchemaFileEntryLosses(pmPath, settings.schema, 10)).resolves.toEqual({ details: {}, warnings: [] });
      const settingsPath = path.join(pmPath, "settings.json");
      const stored = JSON.parse(await readFile(settingsPath, "utf8")) as { schema: { files: Record<string, string> } };
      stored.schema.files.statuses = "schema/custom-statuses.json";
      await writeFile(settingsPath, JSON.stringify(stored));
      await writeFile(path.join(pmPath, "schema", "custom-statuses.json"), JSON.stringify([{ id: "parked", description: 1 }]));
      const scanned = await scanSchemaFileEntryLosses(pmPath, (await readSettings(pmPath)).schema, 10);
      expect(scanned.details).toMatchObject({ schema_status_definition_losses: [{ source: "schema/custom-statuses.json", id: "parked" }] });
      expect(scanned.details).not.toHaveProperty("schema_type_definition_losses");
    });
  });
});
