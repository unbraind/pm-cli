/** A custom field must not take the option spelling of a built-in option on a command it is registered for (pm-pta8um). */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { lintProjectProfile } from "../../../../src/core/profile/profile-lint.js";
import { PROFILE_NAMES } from "../../../../src/core/profile/profile-presets.js";
import { readSettings, writeSettings } from "../../../../src/core/store/settings.js";
import { PmClient } from "../../../../src/sdk/index.js";
import {
  describeFieldOptionCollision,
  resolveFieldOptionCollisions,
  scanFieldOptionCollisions,
  type FieldOptionSource,
} from "../../../../src/sdk/schema/field-option-collisions.js";
import { writeTestExtension } from "../../../helpers/extensions.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";

const field = (key: string, commands: FieldOptionSource["commands"], extra: Partial<FieldOptionSource> = {}): FieldOptionSource =>
  ({ key, cli_flag: key.replaceAll("_", "-"), cli_aliases: [], commands, ...extra });

describe("resolveFieldOptionCollisions", () => {
  it("names each built-in option a field shadows, per registered command", () => {
    expect(resolveFieldOptionCollisions([field("full", ["create", "list", "search", "context"])])).toEqual([
      { field: "full", command: "list", field_flag: "--full", option: "--full" },
      { field: "full", command: "search", field_flag: "--full", option: "--full" },
    ]);
    expect(resolveFieldOptionCollisions([field("fields", ["list", "search", "context"]), field("compact", ["list", "search", "update_many"])]).map(describeFieldOptionCollision)).toEqual([
      "--compact shadows built-in --compact on pm list",
      "--compact shadows built-in --compact on pm search",
      "--fields shadows built-in --fields on pm context",
      "--fields shadows built-in --fields on pm list",
      "--fields shadows built-in --fields on pm search",
    ]);
  });

  it("compares the stored option key, a custom flag, an alias and a negated built-in", () => {
    // The value is stored under the field key whatever its flag is spelled.
    expect(resolveFieldOptionCollisions([field("output_limit", ["create"], { cli_flag: "ol" })])).toEqual([
      { field: "output_limit", command: "create", field_flag: "--output-limit", option: "--output-limit" },
    ]);
    // Punctuation is a word break for the reader of field values, so a dotted or spaced alias reaches the same key.
    expect(resolveFieldOptionCollisions([field("review_owner", ["list"], { cli_aliases: ["token.budget"] })])).toEqual([
      { field: "review_owner", command: "list", field_flag: "--token.budget", option: "--token-budget" },
    ]);
    expect(resolveFieldOptionCollisions([field("review_owner", ["list"], { cli_aliases: ["output:limit"] })])).toMatchObject([{ option: "--output-limit" }]);
    // A negated built-in is parsed under its base name and delivered to handlers under its own, and both are reserved.
    expect(resolveFieldOptionCollisions([field("no_notes", ["list"], { cli_flag: "review-visibility" })])).toEqual([
      { field: "no_notes", command: "list", field_flag: "--no-notes", option: "--no-notes" },
    ]);
    // The negation is removed once, as the parser does: a doubled prefix is a different option.
    expect(resolveFieldOptionCollisions([field("review_visibility", ["list"], { cli_aliases: ["no-no-full"] })])).toEqual([]);
    // Several options shadowed on one command are ordered by option.
    expect(resolveFieldOptionCollisions([field("owner_team", ["list"], { cli_flag: "sort", cli_aliases: ["limit", "json"] })]).map((row) => row.option)).toEqual(["--json", "--limit", "--sort"]);
    // Two spellings of one built-in option are one collision.
    expect(resolveFieldOptionCollisions([field("output_limit", ["create"], { cli_flag: "output-limit" })])).toHaveLength(1);
    expect(resolveFieldOptionCollisions([field("owner_team", ["list"], { cli_flag: "--limit" })])).toMatchObject([{ option: "--limit", field_flag: "--limit" }]);
    expect(resolveFieldOptionCollisions([field("owner_team", ["update_many"], { cli_aliases: ["pager", "PAGER"] })])).toEqual([
      { field: "owner_team", command: "update-many", field_flag: "--pager", option: "--no-pager" },
    ]);
  });

  it("accepts free names, and the metadata a field may redefine", () => {
    expect(resolveFieldOptionCollisions([
      field("review_owner", ["create", "update", "update_many", "list", "search", "calendar", "context"]),
      field("severity", ["create", "update", "list"], { cli_aliases: ["sev"] }),
    ])).toEqual([]);
    // Only the exact key is exempt: another key that merely reads the same option is a shadow.
    expect(resolveFieldOptionCollisions([field("severity.", ["create"])])).toMatchObject([{ option: "--severity" }]);
    expect(resolveFieldOptionCollisions([field("severity_level", ["create"], { cli_aliases: ["severity"] })])).toMatchObject([{ option: "--severity" }]);
    // Redefinition covers the field's own key only, not another built-in option reached through an alias.
    expect(resolveFieldOptionCollisions([field("severity", ["create"], { cli_aliases: ["json"] })])).toMatchObject([{ option: "--json" }]);
  });
});

describe("custom field registration", () => {
  it.each([
    ["full", "list", "--full", ["list", "--full"]],
    ["fields", "list", "--fields", ["list", "--fields", "id"]],
    ["compact", "list", "--compact", ["list", "--compact"]],
    ["full", "search", "--full", ["search", "Seed", "--full"]],
    ["fields", "context", "--fields", ["context", "--fields", "id"]],
  ])("refuses %s on %s and leaves the option working", async (key, command, option, argv) => {
    await withTempPmPath(async ({ pmPath, runCli }) => {
      const client = new PmClient({ pmRoot: pmPath, noExtensions: true });
      const seed = (await client.create({ title: "Seed", type: "Task", description: "Seed description" })).item;
      const read = async (): Promise<Record<string, unknown>> => {
        const result = await runCli([...argv, "--json", "--output-budget", "unbounded"], { expectJson: true });
        expect(result.code).toBe(0);
        return JSON.parse(result.stdout) as Record<string, unknown>;
      };
      const before = await read();
      expect(JSON.stringify(before)).toContain(seed.id);
      const refusal = await client.schemaAddField(key, { type: "string", commands: ["create", command] }).then(() => null, (error: unknown) => error);
      expect(refusal).toMatchObject({
        exitCode: 2,
        context: { code: "schema_field_option_collision", field: key, flag: option, nextSteps: [expect.stringContaining(`project_${key}`), expect.stringContaining("--commands create")] },
      });
      expect((refusal as Error).message).toContain(`${option} shadows built-in ${option} on pm ${command}`);
      expect((await client.schemaListFields()).fields).toEqual([]);
      // The same key is accepted where no built-in option carries it, and the command's own option still answers as before.
      await expect(client.schemaAddField(key, { type: "string", commands: ["create"] })).resolves.toMatchObject({ registered: true });
      const after = await read();
      const stable = ({ now: _now, window: _window, generated_at: _generated, ...rest }: Record<string, unknown>) => rest;
      expect(stable(after)).toEqual(stable(before));
      expect((after.filters as { runtime_filters?: unknown } | undefined)?.runtime_filters ?? {}).toEqual({});
    });
  });

  it("judges a key's default flag as registration spells it", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      // no_json registers --no-json, which the parser reads as a negation of the built-in --json.
      await expect(new PmClient({ pmRoot: pmPath, noExtensions: true }).schemaAddField("no_json", { type: "string", commands: ["create"] })).rejects.toMatchObject({
        context: { code: "schema_field_option_collision", field: "no_json", flag: "--json" },
      });
    });
  });

  it("offers the accepted command name in the narrower registration", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const refusal = await new PmClient({ pmRoot: pmPath, noExtensions: true }).schemaAddField("full", { type: "string", commands: ["list", "update_many"] }).then(() => null, (error: unknown) => error);
      expect(refusal).toMatchObject({ context: { nextSteps: [expect.any(String), expect.stringContaining("--commands update_many.")] } });
    });
  });

  it("refuses a rename whose target shadows a built-in option, before anything is staged", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const client = new PmClient({ pmRoot: pmPath, noExtensions: true });
      await client.schemaAddField("review_owner", { type: "string", commands: ["create", "list"] });
      const item = (await client.create({ title: "Seed", type: "Task", reviewOwner: "ada" } as never)).item;
      const before = await readFile(path.join(pmPath, "schema", "fields.json"), "utf8");
      for (const dryRun of [true, false]) {
        await expect(client.schemaRenameField("review_owner", "full", { dryRun })).rejects.toMatchObject({
          context: { code: "schema_field_option_collision", field: "full", flag: "--full" },
        });
      }
      expect(await readFile(path.join(pmPath, "schema", "fields.json"), "utf8")).toBe(before);
      expect((await client.get(item.id, { full: true })).item).toMatchObject({ review_owner: "ada" });
      // A same-named field defined inline for another command does not make this rename a resumed one.
      const settings = await readSettings(pmPath);
      await writeSettings(pmPath, { ...settings, schema: { ...settings.schema, fields: [{ key: "full", type: "string", commands: ["create"] }] } });
      await expect(client.schemaRenameField("review_owner", "full", { dryRun: true })).rejects.toMatchObject({ context: { code: "schema_field_option_collision" } });
      await writeSettings(pmPath, settings);
      await expect(client.schemaRenameField("review_owner", "review_lead", {})).resolves.toBeDefined();
      // The stored entry that staging copies is judged too: a duplicate key whose first entry carries a shadowing alias.
      const fieldsPath = path.join(pmPath, "schema", "fields.json");
      const file = JSON.parse(await readFile(fieldsPath, "utf8")) as { fields: Array<Record<string, unknown>> };
      const lead = file.fields.find((entry) => entry.key === "review_lead")!;
      await writeFile(fieldsPath, JSON.stringify({ fields: [{ ...lead, commands: ["list"], cli_aliases: ["limit"] }, lead] }));
      await expect(client.schemaRenameField("review_lead", "review_head", {})).rejects.toMatchObject({ context: { code: "schema_field_option_collision", field: "review_head", flag: "--limit" } });
      // A rename of a field that does not exist keeps its own diagnostic.
      await expect(client.schemaRenameField("absent_field", "full", {})).rejects.not.toMatchObject({ context: { code: "schema_field_option_collision" } });
    });
  });

  it("names no narrower registration when every requested command carries the option", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const refusal = await new PmClient({ pmRoot: pmPath, noExtensions: true }).schemaAddField("json", { type: "string" }).then(() => null, (error: unknown) => error);
      expect(refusal).toMatchObject({ context: { code: "schema_field_option_collision", nextSteps: [expect.stringContaining("project_json")] } });
    });
  });

  it("reports a field stored before the refusal existed through validate", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const client = new PmClient({ pmRoot: pmPath, noExtensions: true });
      const clean = await client.validate({ checkMetadata: true });
      expect(clean.warnings.filter((warning) => warning.includes("schema_field_option_collision"))).toEqual([]);
      expect(clean.checks.find((check) => check.name === "metadata")?.details).not.toHaveProperty("schema_field_option_collision_count");
      await mkdir(path.join(pmPath, "schema"), { recursive: true });
      await writeFile(path.join(pmPath, "schema", "fields.json"), JSON.stringify({ fields: [
        { key: "full", type: "string", commands: ["create", "list"] },
        { key: "review_owner", type: "string", commands: ["create", "list"] },
      ] }));
      const result = await client.validate({ checkMetadata: true });
      expect(result.warnings).toContain("validate_schema_field_option_collision:1");
      expect(result.checks.find((check) => check.name === "metadata")).toMatchObject({
        ok: false,
        details: {
          schema_field_option_collision_count: 1,
          schema_field_option_collisions: [{ field: "full", command: "list", field_flag: "--full", option: "--full" }],
          schema_field_option_collisions_truncated: false,
          schema_field_option_collision_fix_hint: expect.stringContaining("pm schema rename-field"),
        },
      });
    });
  });

  it("truncates the diagnostic rows at the caller's limit", () => {
    const schema = { fields: [{ key: "full", commands: ["list", "search"] }] } as never;
    expect(scanFieldOptionCollisions(schema, 1).details).toMatchObject({ schema_field_option_collision_count: 2, schema_field_option_collisions_truncated: true });
    expect((scanFieldOptionCollisions(schema, 1).details.schema_field_option_collisions as unknown[])).toHaveLength(1);
  });
});

describe("profile fields", () => {
  it("refuses to apply or preview a shadowing profile field and lints it as an error", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      await writeTestExtension({
        root: path.join(pmPath, "extensions", "shadow-profile"),
        name: "shadow-profile",
        manifestOverrides: { capabilities: ["schema"] },
        entrySource: `export default { activate(api) {
          api.registerProfile({ name: "shadow", title: "Shadow", summary: "Shadows a list option.", fields: [{ key: "full", commands: ["create", "list"] }] });
          api.registerProfile({ name: "reserved", title: "Reserved", summary: "Takes a reserved key.", fields: [{ key: "status" }] });
        } };`,
      });
      const client = new PmClient({ pmRoot: pmPath });
      for (const dryRun of [true, false]) {
        await expect(client.profileApply("shadow", { dryRun })).rejects.toMatchObject({ context: { code: "schema_field_option_collision", field: "full" } });
      }
      // The shared lint that package checks consume carries the finding, and so does the command.
      expect(lintProjectProfile({ name: "shadow", title: "Shadow", summary: "Shadows a list option.", types: [], statuses: [], workflows: [], config: [], templates: [], packages: [], fields: [{ key: "full", commands: ["create", "list"] }] } as never)).toMatchObject({
        ok: false,
        findings: expect.arrayContaining([expect.objectContaining({ severity: "error", code: "field_option_collision", target: "full" })]),
      });
      await expect(client.profileLint("shadow")).resolves.toMatchObject({
        ok: false,
        error_count: 1,
        warning_count: 1,
        findings: [expect.objectContaining({ severity: "error", code: "field_option_collision", dimension: "fields", target: "full", message: expect.stringContaining("--full shadows built-in --full on pm list") }), expect.objectContaining({ code: "field_mcp_input_collision" })],
      });
      const reserved = await client.profileLint("reserved");
      expect(reserved.findings.map((finding) => finding.code)).toEqual(["field_invalid"]);
      for (const name of PROFILE_NAMES) {
        expect((await client.profileLint(name)).findings.filter((finding) => finding.code === "field_option_collision")).toEqual([]);
      }
      // An invalid field keeps the planner's own diagnostic instead of this refusal.
      await expect(client.profileApply("reserved", { dryRun: true })).rejects.not.toMatchObject({ context: { code: "schema_field_option_collision" } });
      await expect(readFile(path.join(pmPath, "schema", "fields.json"), "utf8").then((raw) => JSON.parse(raw).fields ?? [], () => [])).resolves.toEqual([]);
    });
  });
});
