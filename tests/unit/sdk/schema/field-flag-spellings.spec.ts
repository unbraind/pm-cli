/**
 * pm-8patuh: a custom field flag or alias must be exactly one option spelling,
 * and a short spelling or the implicit help option must not shadow what the
 * parser already owns. A stored definition that predates the refusal is
 * reported by validate and skipped at registration, so it can no longer stop
 * a command from starting or take over help.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { describeFieldFlagSpellingDefect, isRegistrableFieldFlagSpelling } from "../../../../src/sdk/schema/field-flag-spelling.js";
import { createSchemaFieldRecoveryResolver } from "../../../../src/sdk/lifecycle/core-field-recovery.js";
import { resolveRuntimeFieldRegistry } from "../../../../src/core/schema/runtime-schema.js";
import { lintProjectProfile } from "../../../../src/core/profile/profile-lint.js";
import { PmClient } from "../../../../src/sdk/index.js";
import {
  resolveFieldFlagSpellingDefects,
  resolveFieldOptionCollisions,
  scanFieldOptionCollisions,
  type FieldOptionSource,
} from "../../../../src/sdk/schema/field-option-collisions.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";

const field = (key: string, commands: FieldOptionSource["commands"], extra: Partial<FieldOptionSource> = {}): FieldOptionSource =>
  ({ key, cli_flag: key.replaceAll("_", "-"), cli_aliases: [], commands, ...extra });

describe("describeFieldFlagSpellingDefect", () => {
  it("accepts one long name or one short flag", () => {
    for (const spelling of ["review-owner", "--review-owner", "token.budget", "x", "-x", "-9", " -x "]) {
      expect(describeFieldFlagSpellingDefect(spelling), spelling).toBeUndefined();
    }
  });

  it("names why the parser cannot register a spelling as one option", () => {
    expect(describeFieldFlagSpellingDefect("full|detail")).toBe('contains "|", which the option parser reads as a break between two flags');
    expect(describeFieldFlagSpellingDefect("a,b")).toBe('contains ",", which the option parser reads as a break between two flags');
    expect(describeFieldFlagSpellingDefect("a b")).toBe("contains whitespace, which the option parser reads as a break between two flags");
    expect(describeFieldFlagSpellingDefect("a=b")).toBe('contains "=", which the option parser reads as the start of an attached value');
    for (const spelling of ["a<b>", "a[b]"]) expect(describeFieldFlagSpellingDefect(spelling)).toContain("a value placeholder");
    for (const spelling of ["-xy", "-", "-|"]) expect(describeFieldFlagSpellingDefect(spelling), spelling).toBe("is not a short flag: a short flag is one dash and one character");
    expect(describeFieldFlagSpellingDefect("---x")).toBe("starts with three dashes");
    // A missing name is not a spelling either (Greptile review).
    for (const spelling of ["", "   ", "--"]) expect(describeFieldFlagSpellingDefect(spelling), JSON.stringify(spelling)).toBe("is empty");
  });

  it("registers a spelling only when it is one option spelling and not the implicit help", () => {
    for (const spelling of ["review-owner", "-x", "--review-owner"]) expect(isRegistrableFieldFlagSpelling(spelling), spelling).toBe(true);
    for (const spelling of ["full|deep", "-xy", "", "-h", "help", "--help"]) expect(isRegistrableFieldFlagSpelling(spelling), spelling).toBe(false);
  });

  it("never advertises a spelling the CLI skips as the retry for a refused --field assignment (Codex review)", () => {
    const registry = resolveRuntimeFieldRegistry({
      fields: [{ key: "review_owner", type: "string", cli_flag: "owner|detail", cli_aliases: ["review-owner"], commands: ["update"] }],
    } as never);
    expect(createSchemaFieldRecoveryResolver(registry, "update")("review_owner")).toMatchObject({ recovery: { suggested_flags: ["--review-owner"] } });
    const unusable = resolveRuntimeFieldRegistry({ fields: [{ key: "review_owner", type: "string", cli_flag: "owner|detail", commands: ["update"] }] } as never);
    expect(createSchemaFieldRecoveryResolver(unusable, "update")("review_owner")?.recovery).not.toHaveProperty("suggested_flags");
  });

  it("lists every defective flag and alias of each field once", () => {
    expect(resolveFieldFlagSpellingDefects([field("review_owner", ["list"], { cli_flag: "full|detail", cli_aliases: ["ok", "-xy", "full|detail"] })])).toEqual([
      { field: "review_owner", spelling: "full|detail", reason: expect.stringContaining('"|"') },
      { field: "review_owner", spelling: "-xy", reason: expect.stringContaining("short flag") },
    ]);
  });
});

describe("short spellings and implicit help", () => {
  it("compares a short spelling with the command's short flags and reserves help on every command", () => {
    // create owns -p for --priority; list has no -p, so the same alias is free there.
    expect(resolveFieldOptionCollisions([field("review_owner", ["create", "list", "update"], { cli_aliases: ["-p"] })])).toEqual([
      { field: "review_owner", command: "create", field_flag: "-p", option: "--priority" },
      { field: "review_owner", command: "update", field_flag: "-p", option: "--priority" },
    ]);
    expect(resolveFieldOptionCollisions([field("review_owner", ["search"], { cli_aliases: ["-h", "help"] })])).toEqual([
      { field: "review_owner", command: "search", field_flag: "-h", option: "--help" },
    ]);
    expect(resolveFieldOptionCollisions([field("help", ["context"])])).toMatchObject([{ field_flag: "--help", option: "--help" }]);
    // A free short letter is accepted, and a short spelling never matches a long option of the same letter.
    expect(resolveFieldOptionCollisions([field("review_owner", ["create", "list"], { cli_aliases: ["-q"] })])).toEqual([]);
  });
});

describe("custom field registration and stored definitions", () => {
  it("refuses a flag the parser would split and a shadowing short spelling in add-field, rename and profile lint", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const client = new PmClient({ pmRoot: pmPath, noExtensions: true });
      for (const [options, flag] of [
        [{ alias: ["full|deep"] }, "full|deep"],
        [{ cliFlag: "fullx|detail" }, "fullx|detail"],
        [{ alias: ["-xy"] }, "-xy"],
        // A comma gets the same typed refusal as every other separator (Greptile review).
        [{ alias: ["a,b"] }, "a,b"],
        [{ cliFlag: "own,er" }, "own,er"],
      ] as const) {
        await expect(client.schemaAddField("review_owner", { type: "string", commands: ["list"], ...options }), flag).rejects.toMatchObject({
          exitCode: 2,
          context: { code: "schema_field_flag_invalid", field: "review_owner", flag },
        });
      }
      for (const [alias, command, option] of [["-h", "search", "--help"], ["help", "list", "--help"], ["-p", "create", "--priority"]] as const) {
        await expect(client.schemaAddField("review_owner", { type: "string", commands: [command], alias: [alias] }), alias).rejects.toMatchObject({
          context: { code: "schema_field_option_collision", flag: option },
        });
      }
      expect((await client.schemaListFields()).fields).toEqual([]);
      await client.schemaAddField("review_owner", { type: "string", commands: ["create", "list"], alias: ["-q"] });
      const before = await readFile(path.join(pmPath, "schema", "fields.json"), "utf8");
      for (const to of ["a,b", "a|b"]) {
        await expect(client.schemaRenameField("review_owner", to, { dryRun: true }), to).rejects.toMatchObject({ context: { code: "schema_field_flag_invalid", flag: to } });
      }
      expect(await readFile(path.join(pmPath, "schema", "fields.json"), "utf8")).toBe(before);
      const profile = { name: "split", title: "Split", summary: "Splits a flag.", types: [], statuses: [], workflows: [], config: [], templates: [], packages: [] };
      expect(lintProjectProfile({ ...profile, fields: [{ key: "review_lead", aliases: ["a,b"] }] } as never).findings.map((finding) => finding.code)).toEqual(["field_flag_invalid"]);
      expect(lintProjectProfile({ ...profile, fields: [{ key: "review_lead", aliases: ["a|b"] }] } as never)).toMatchObject({
        ok: false,
        findings: expect.arrayContaining([expect.objectContaining({ severity: "error", code: "field_flag_invalid", target: "review_lead", message: expect.stringContaining('"a|b" contains "|"') })]),
      });
    });
  });

  it("reports a stored defective spelling through validate and keeps the commands it reaches working", async () => {
    await withTempPmPath(async ({ pmPath, runCliInProcess }) => {
      const client = new PmClient({ pmRoot: pmPath, noExtensions: true });
      await mkdir(path.join(pmPath, "schema"), { recursive: true });
      await writeFile(path.join(pmPath, "schema", "fields.json"), JSON.stringify({ fields: [
        { key: "review_owner", type: "string", commands: ["create", "list"], cli_aliases: ["full|deep"] },
        { key: "review_lead", type: "string", commands: ["search"], cli_aliases: ["-h"] },
      ] }));
      // Before pm-8patuh `pm list --help` failed to register --full|deep, and `pm search -h` demanded a value.
      const listHelp = await runCliInProcess(["list", "--help"]);
      expect(listHelp.code, listHelp.stderr).toBe(0);
      expect(listHelp.stdout).toContain("--review-owner");
      const searchHelp = await runCliInProcess(["search", "-h"]);
      expect(searchHelp.code, searchHelp.stderr).toBe(0);
      expect(searchHelp.stdout).toContain("Usage: pm search");
      const result = await client.validate({ checkMetadata: true });
      expect(result.warnings).toEqual(expect.arrayContaining(["validate_schema_field_flag_invalid:1", "validate_schema_field_option_collision:1"]));
      expect(result.checks.find((check) => check.name === "metadata")?.details).toMatchObject({
        schema_field_flag_invalid_count: 1,
        schema_field_flag_invalid: [{ field: "review_owner", spelling: "full|deep", reason: expect.stringContaining('"|"') }],
        schema_field_flag_invalid_truncated: false,
        schema_field_flag_invalid_fix_hint: expect.stringContaining("one dash and one character"),
        schema_field_option_collisions: [{ field: "review_lead", command: "search", field_flag: "-h", option: "--help" }],
      });
    });
  });

  it("reports spelling defects alone, truncated at the caller's limit", () => {
    const schema = { fields: [{ key: "review_owner", commands: ["list"], cli_aliases: ["a|b", "c,d"] }] } as never;
    const scan = scanFieldOptionCollisions(schema, 1);
    expect(scan.warnings).toEqual(["validate_schema_field_flag_invalid:2"]);
    expect(scan.details).toMatchObject({ schema_field_flag_invalid_count: 2, schema_field_flag_invalid_truncated: true });
    expect(scan.details).not.toHaveProperty("schema_field_option_collision_count");
  });
});
