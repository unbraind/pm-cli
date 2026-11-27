/**
 * pm-x9r2h3: the runtime field registry drops a stored definition whose key or
 * flag normalizes to nothing, whose value schema is invalid or which is not an
 * object, and ignores a blank alias, an unknown type or command and a
 * non-string description. Every other diagnostic reads the resolved registry,
 * so validate now judges the stored entries with the registry's own
 * inspection. One null entry in a schema file also used to fail the whole
 * settings read and put every setting back to its default.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  inspectRuntimeFieldDefinition,
  loadRuntimeSchemaFromOptionalFiles,
  normalizeRuntimeSchemaSettings,
  resolveRuntimeFieldRegistry,
} from "../../../../src/core/schema/runtime-schema.js";
import { readSettings } from "../../../../src/core/store/settings.js";
import { PmClient } from "../../../../src/sdk/index.js";
import { scanFieldDefinitionLosses } from "../../../../src/sdk/schema/field-definition-losses.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";

const STORED_SHAPES: Array<[string, unknown, Record<string, unknown>]> = [
  ["a null entry", null, { dropped: "not_an_object" }],
  ["a scalar entry", "review_owner", { dropped: "not_an_object" }],
  ["a list entry", [], { dropped: "not_an_object" }],
  ["a blank key", { key: "  " }, { dropped: "key_empty" }],
  ["a metadata key that normalizes to nothing", { key: "review_owner", metadata_key: "  " }, { ignored: ['metadata_key: "  " names no item key, so values are stored under the field key'] }],
  ["a front matter key that is not a string", { key: "review_owner", front_matter_key: 5 }, { ignored: ["front_matter_key: 5 names no item key, so values are stored under the field key"] }],
  ["a flag that normalizes to nothing", { key: "review_owner", cli_flag: "--" }, { dropped: "cli_flag_empty" }],
  ["an invalid value schema", { key: "review_owner", value_schema: { type: "bogus" } }, { dropped: "value_schema_invalid" }],
  ["blank and empty aliases", { key: "review_owner", cli_aliases: [" ", "--", 7, "owner"] }, { ignored: ['cli_aliases: " " is not a flag spelling', 'cli_aliases: "--" is not a flag spelling', "cli_aliases: 7 is not a flag spelling"] }],
  ["aliases that are not a list", { key: "review_owner", cli_aliases: "owner" }, { ignored: ["cli_aliases: is not a list"] }],
  ["an unknown type", { key: "review_owner", type: "integer" }, { ignored: ['type: "integer" is not a field type, so the field reads as string'] }],
  ["a type that is not a string", { key: "review_owner", type: 5 }, { ignored: ["type: 5 is not a field type, so the field reads as string"] }],
  ["an unknown command", { key: "review_owner", commands: ["creat", "update"] }, { ignored: ['commands: "creat" is not a field command'] }],
  ["blank required types", { key: "review_owner", required_types: ["Task", " "] }, { ignored: ['required_types: " " is not a type name'] }],
  ["a description that is not a string", { key: "review_owner", description: 5 }, { ignored: ["description: is not a string"] }],
  // The registry normalizes a definition more than once, so every leading pair of dashes goes in one pass (Codex review).
  ["a flag of four dashes", { key: "review_owner", cli_flag: "----" }, { dropped: "cli_flag_empty" }],
  ["an alias of four dashes", { key: "review_owner", cli_aliases: ["----", "owner"] }, { ignored: ['cli_aliases: "----" is not a flag spelling'] }],
  // Boolean members that are not booleans leave the default behavior in place (Codex review).
  ["boolean members that are not booleans", { key: "review_owner", required_on_create: "true", allow_unset: "false", repeatable: 1, required: null }, { ignored: [
    "repeatable: 1 is not a boolean, so it reads as false",
    "required: null is not a boolean, so it reads as false",
    'required_on_create: "true" is not a boolean, so it reads as false',
    'allow_unset: "false" is not a boolean, so it reads as true',
  ] }],
  // Value schema keywords the registry does not read are dropped without enforcement, nested schemas included (Codex review).
  ["value schema keywords the registry does not read", {
    key: "review_owner",
    type: "object",
    value_schema: { type: "object", minLength: 10, properties: { name: { type: "string", maxLength: 3 } }, one_of: [{ type: "object", pattern: "x" }] },
  }, { ignored: [
    "value_schema.minLength: is not a value schema keyword, so it is not enforced",
    "value_schema.properties.name.maxLength: is not a value schema keyword, so it is not enforced",
    "value_schema.one_of[0].pattern: is not a value schema keyword, so it is not enforced",
  ] }],
  ["value schema items keywords", { key: "review_tags", type: "array", value_schema: { type: "array", items: { type: "string", uniqueItems: true } } }, { ignored: [
    "value_schema.items.uniqueItems: is not a value schema keyword, so it is not enforced",
  ] }],
  // A value JSON cannot render is still described, and the rest of the definition resolves (Codex review).
  ["an alias JSON cannot render", { key: "review_owner", cli_aliases: [3n, "owner"] }, { ignored: ["cli_aliases: 3 is not a flag spelling"] }],
];

/** The shapes a JSON file can hold; an SDK caller can pass values such as a BigInt that no stored file carries. */
const FILE_SHAPES = STORED_SHAPES.filter(([, definition]) => {
  try {
    JSON.stringify(definition);
    return true;
  } catch {
    return false;
  }
});

describe("inspectRuntimeFieldDefinition", () => {
  it.each(STORED_SHAPES)("reports %s exactly as the registry drops or reads it", (_label, definition, loss) => {
    const inspected = inspectRuntimeFieldDefinition(definition);
    expect(inspected.loss).toEqual({ ignored: [], ...loss });
    // The registry reads the same function: a dropped definition resolves to nothing, a kept one resolves whole.
    const registry = resolveRuntimeFieldRegistry({ fields: [definition] } as never);
    expect(registry.definitions).toEqual(inspected.resolved === null ? [] : [inspected.resolved]);
  });

  it("reads flags with any run of leading dash pairs the way repeated normalization does", () => {
    expect(resolveRuntimeFieldRegistry({ fields: [{ key: "review_owner", cli_flag: "----owner" }] } as never).definitions[0]).toMatchObject({ cli_flag: "owner" });
    expect(inspectRuntimeFieldDefinition({ key: "review_owner", cli_flag: "----owner" }).resolved).toMatchObject({ cli_flag: "owner" });
  });

  it("keeps the nullish precedence of metadata_key over front_matter_key (Codex review)", () => {
    const inspected = inspectRuntimeFieldDefinition({ key: "review_owner", metadata_key: null, front_matter_key: "owner" });
    expect(inspected).toMatchObject({ resolved: { metadata_key: "owner" }, loss: { ignored: [] } });
    expect(inspectRuntimeFieldDefinition({ key: "review_owner", metadata_key: null, front_matter_key: " " }).loss.ignored).toEqual([
      'front_matter_key: " " names no item key, so values are stored under the field key',
    ]);
  });

  it("describes a value neither JSON nor String can render without throwing (Codex review)", () => {
    expect(inspectRuntimeFieldDefinition({ key: "review_owner", cli_aliases: [{ toString: null, n: 1n }, "owner"] })).toMatchObject({
      resolved: { cli_aliases: ["owner"] },
      loss: { ignored: ["cli_aliases: a value that cannot be shown is not a flag spelling"] },
    });
  });

  it("describes a cyclic alias without throwing", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(inspectRuntimeFieldDefinition({ key: "review_owner", cli_aliases: [cyclic, "owner"] })).toMatchObject({
      resolved: { cli_aliases: ["owner"] },
      loss: { ignored: ["cli_aliases: [object Object] is not a flag spelling"] },
    });
  });

  it("reports nothing for a definition the registry keeps whole", () => {
    for (const definition of [{ key: "review_owner" }, { key: "Review Owner", type: " String ", cli_flag: "--owner", cli_aliases: ["owner", "lead"], commands: ["create"], description: "Who reviews" }]) {
      expect(inspectRuntimeFieldDefinition(definition).loss).toEqual({ ignored: [] });
    }
  });
});

describe("schema file entries that are not objects", () => {
  it.each([
    ["fields.json", { fields: [null, { key: "review_owner" }] }, "runtime_schema_fields_entry_invalid:1"],
    ["statuses.json", { statuses: [null, 3] }, "runtime_schema_statuses_entry_invalid:2"],
    ["types.json", { definitions: [null] }, "runtime_schema_types_entry_invalid:1"],
  ])("keeps the settings read when %s holds one", async (file, contents, warning) => {
    await withTempPmPath(async ({ pmPath }) => {
      const before = await readSettings(pmPath);
      const settingsPath = path.join(pmPath, "settings.json");
      const settings = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
      await writeFile(settingsPath, JSON.stringify({ ...settings, id_prefix: "zz-" }));
      await mkdir(path.join(pmPath, "schema"), { recursive: true });
      await writeFile(path.join(pmPath, "schema", file), JSON.stringify(contents));
      const loaded = await loadRuntimeSchemaFromOptionalFiles(pmPath, normalizeRuntimeSchemaSettings(before.schema));
      expect(loaded.warnings).toEqual([warning]);
      // The inline setting survives: before, the read failed and every setting fell back to its default.
      expect((await readSettings(pmPath)).id_prefix).toBe("zz-");
    });
  });
});

describe("validate --check-metadata", () => {
  it("names every stored definition the registry drops or reads in part, inline and in the fields file", async () => {
    await withTempPmPath(async ({ pmPath, runCli }) => {
      const client = new PmClient({ pmRoot: pmPath, noExtensions: true });
      const clean = await client.validate({ checkMetadata: true });
      expect(clean.checks.find((check) => check.name === "metadata")?.details).not.toHaveProperty("schema_field_definition_loss_count");
      await mkdir(path.join(pmPath, "schema"), { recursive: true });
      await writeFile(path.join(pmPath, "schema", "fields.json"), JSON.stringify({ fields: FILE_SHAPES.map(([, definition]) => definition) }));
      const settingsPath = path.join(pmPath, "settings.json");
      const settings = JSON.parse(await readFile(settingsPath, "utf8")) as { schema?: Record<string, unknown> };
      await writeFile(settingsPath, JSON.stringify({ ...settings, schema: { ...settings.schema, fields: [{ key: "inline_owner", cli_flag: " " }, { key: "inline_lead", cli_aliases: [" "] }] } }));
      // Negative control: the resolved registry, which every other diagnostic reads, no longer holds the dropped entries.
      const registryKeys = resolveRuntimeFieldRegistry((await readSettings(pmPath)).schema).definitions.map((definition) => definition.key);
      expect(registryKeys).not.toContain("inline_owner");
      const result = await client.validate({ checkMetadata: true });
      const dropped = FILE_SHAPES.filter(([, , loss]) => loss.dropped !== undefined).length + 1;
      const partial = FILE_SHAPES.length + 2 - dropped;
      expect(result.warnings).toEqual(expect.arrayContaining([`validate_schema_field_definition_dropped:${dropped}`, `validate_schema_field_definition_partial:${partial}`]));
      const metadata = result.checks.find((check) => check.name === "metadata");
      expect(metadata).toMatchObject({
        ok: false,
        details: {
          schema_field_definition_loss_count: FILE_SHAPES.length + 2,
          schema_field_definition_losses_truncated: false,
          schema_field_definition_loss_fix_hint: expect.stringContaining("pm schema add-field"),
        },
      });
      const rows = metadata?.details.schema_field_definition_losses as Array<Record<string, unknown>>;
      expect(rows.slice(0, 2)).toEqual([
        { source: "settings.json", index: 0, key: "inline_owner", dropped: "cli_flag_empty" },
        { source: "settings.json", index: 1, key: "inline_lead", ignored: ['cli_aliases: " " is not a flag spelling'] },
      ]);
      expect(rows[2]).toEqual({ source: "schema/fields.json", index: 0, key: null, dropped: "not_an_object" });
      expect(rows.find((row) => row.dropped === "cli_flag_empty" && row.source === "schema/fields.json")).toMatchObject({ key: "review_owner" });
      // The built CLI carries the same rows.
      const cli = await runCli(["validate", "--check-metadata", "--json"], { expectJson: true });
      expect(cli.stdout).toContain("validate_schema_field_definition_dropped");
    });
  });

  it("truncates the rows at the caller's limit and skips stored files it cannot read", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const schema = (await readSettings(pmPath)).schema;
      await mkdir(path.join(pmPath, "schema"), { recursive: true });
      await writeFile(path.join(pmPath, "schema", "fields.json"), JSON.stringify([{ key: "a", cli_flag: "--" }, { key: "b", type: "integer" }]));
      const scanned = await scanFieldDefinitionLosses(pmPath, schema, 1);
      expect(scanned.details).toMatchObject({ schema_field_definition_loss_count: 2, schema_field_definition_losses_truncated: true });
      expect(scanned.details.schema_field_definition_losses).toHaveLength(1);
      expect(scanned.warnings).toEqual(["validate_schema_field_definition_dropped:1", "validate_schema_field_definition_partial:1"]);
      // Unparseable stored JSON and an unrecognized file shape are the settings read's to report.
      await writeFile(path.join(pmPath, "schema", "fields.json"), "{");
      await expect(scanFieldDefinitionLosses(pmPath, schema, 10)).resolves.toEqual({ details: {}, warnings: [] });
      await writeFile(path.join(pmPath, "schema", "fields.json"), JSON.stringify({ other: [] }));
      await expect(scanFieldDefinitionLosses(pmPath, schema, 10)).resolves.toEqual({ details: {}, warnings: [] });
    });
  });

  it("warns only for the kind of loss present and reads absent or unreadable stored documents as empty", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const schema = (await readSettings(pmPath)).schema;
      const fieldsPath = path.join(pmPath, "schema", "fields.json");
      await mkdir(path.dirname(fieldsPath), { recursive: true });
      // A definition the registry keeps whole contributes no row.
      await writeFile(fieldsPath, JSON.stringify({ fields: [{ key: "a", cli_flag: "--" }, { key: "review_owner" }] }));
      await expect(scanFieldDefinitionLosses(pmPath, schema, 10)).resolves.toMatchObject({
        details: { schema_field_definition_loss_count: 1 },
        warnings: ["validate_schema_field_definition_dropped:1"],
      });
      await writeFile(fieldsPath, JSON.stringify({ fields: [{ key: "b", type: "integer" }] }));
      await expect(scanFieldDefinitionLosses(pmPath, schema, 10)).resolves.toMatchObject({ warnings: ["validate_schema_field_definition_partial:1"] });
      // No fields file, and a settings document that does not parse, fails validation or stores no schema, contribute no rows.
      await rm(fieldsPath);
      const settingsPath = path.join(pmPath, "settings.json");
      const { schema: _schema, ...schemaless } = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
      for (const raw of ["{", JSON.stringify({ id_prefix: "pm-" }), JSON.stringify(schemaless)]) {
        await writeFile(settingsPath, raw);
        await expect(scanFieldDefinitionLosses(pmPath, schema, 10), raw).resolves.toEqual({ details: {}, warnings: [] });
      }
    });
  });

  it("judges inline entries as settings validation admits them and keeps scanning when a source cannot be read", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const schema = (await readSettings(pmPath)).schema;
      const settingsPath = path.join(pmPath, "settings.json");
      const settings = JSON.parse(await readFile(settingsPath, "utf8")) as { schema?: Record<string, unknown> };
      const withInline = (fields: unknown[]) => writeFile(settingsPath, JSON.stringify({ ...settings, schema: { ...settings.schema, fields } }));
      // Validation strips an inline value_schema, so the field registers and no row is due (Codex review).
      await withInline([{ key: "review_owner", value_schema: { type: "bogus" } }]);
      expect(resolveRuntimeFieldRegistry((await readSettings(pmPath)).schema).definitions.map((definition) => definition.key)).toContain("review_owner");
      await expect(scanFieldDefinitionLosses(pmPath, schema, 10)).resolves.toEqual({ details: {}, warnings: [] });
      // An inline entry validation refuses replaces the whole document with defaults; the settings read reports that.
      await withInline([{ key: "review_owner", type: "integer" }]);
      await expect(scanFieldDefinitionLosses(pmPath, schema, 10)).resolves.toEqual({ details: {}, warnings: [] });
      // A fields file that is a directory is the settings read's to report; inline rows still come through.
      await withInline([{ key: "review_lead", cli_flag: "--" }]);
      const fieldsPath = path.join(pmPath, "schema", "fields.json");
      await rm(fieldsPath, { force: true });
      await mkdir(fieldsPath, { recursive: true });
      await expect(scanFieldDefinitionLosses(pmPath, schema, 10)).resolves.toMatchObject({
        details: { schema_field_definition_losses: [{ source: "settings.json", key: "review_lead", dropped: "cli_flag_empty" }] },
        warnings: ["validate_schema_field_definition_dropped:1"],
      });
      const result = await new PmClient({ pmRoot: pmPath, noExtensions: true }).validate({ checkMetadata: true });
      expect(result.warnings).toContain("validate_schema_field_definition_dropped:1");
      expect(result.checks.find((check) => check.name === "metadata")?.details.schema_field_definition_loss_fix_hint).toContain("value_schema");
    });
  });

  it("scans the fields file the stored settings configure, even when the loaded schema is the default (Codex review)", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const defaults = (await readSettings(pmPath)).schema;
      const settingsPath = path.join(pmPath, "settings.json");
      const settings = JSON.parse(await readFile(settingsPath, "utf8")) as { schema?: Record<string, unknown> };
      await writeFile(settingsPath, JSON.stringify({ ...settings, schema: { ...settings.schema, files: { fields: "schema/alternate.json" } } }));
      await mkdir(path.join(pmPath, "schema"), { recursive: true });
      await writeFile(path.join(pmPath, "schema", "alternate.json"), JSON.stringify({ fields: [{ key: "review_owner", cli_flag: "--" }] }));
      await writeFile(path.join(pmPath, "schema", "fields.json"), JSON.stringify({ fields: [{ key: "unused", cli_flag: "--" }] }));
      const scanned = await scanFieldDefinitionLosses(pmPath, defaults, 10);
      expect(scanned.details.schema_field_definition_losses).toEqual([{ source: "schema/alternate.json", index: 0, key: "review_owner", dropped: "cli_flag_empty" }]);
    });
  });
});
