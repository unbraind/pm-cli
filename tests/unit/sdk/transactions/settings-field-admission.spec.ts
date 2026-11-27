/**
 * pm-3s4jwl: the extension settings writer (`mutateWorkspaceSettings`) shares
 * the `schema add-field` admission for each inline field definition it adds or
 * changes, while an unrelated write keeps a legacy definition exactly as stored.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createExtensionCommandSdk } from "../../../../src/sdk/extension-command-context.js";
import { PmClient } from "../../../../src/sdk/runtime.js";
import type { PmSettings } from "../../../../src/types/index.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";

type InlineField = PmSettings["schema"]["fields"][number];

const withFields = (current: PmSettings, fields: InlineField[]): PmSettings => ({ ...current, schema: { ...current.schema, fields } });

describe("settings writers share the custom field admission", () => {
  it("refuses a new or changed inline field that shadows a built-in option or splits its flag, before anything is written", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const sdk = createExtensionCommandSdk(pmPath, new PmClient({ pmRoot: pmPath, noExtensions: true }));
      const settingsPath = path.join(pmPath, "settings.json");
      const before = await readFile(settingsPath, "utf8");
      for (const [field, code] of [
        [{ key: "full", type: "string", commands: ["create", "list"] }, "schema_field_option_collision"],
        [{ key: "review_owner", type: "string", commands: ["list"], cli_aliases: ["full|deep"] }, "schema_field_flag_invalid"],
        // A spelling that normalizes to nothing would drop the definition or alias silently (CodeRabbit review).
        [{ key: "review_lead", type: "string", commands: ["list"], cli_flag: "--" }, "schema_field_flag_invalid"],
        [{ key: "review_head", type: "string", commands: ["list"], cli_aliases: ["  "] }, "schema_field_flag_invalid"],
      ] as const) {
        for (const dryRun of [true, false]) {
          await expect(
            sdk.mutateWorkspaceSettings({ operationId: `add-${field.key}-${String(dryRun)}`, dryRun, mutate: (current) => withFields(current, [...current.schema.fields, field as InlineField]) }),
            `${field.key} dryRun=${String(dryRun)}`,
          ).rejects.toMatchObject({ exitCode: 2, context: expect.objectContaining({ code }) });
        }
      }
      expect(await readFile(settingsPath, "utf8")).toBe(before);
      await expect(
        sdk.mutateWorkspaceSettings({ operationId: "add-free", mutate: (current) => withFields(current, [...current.schema.fields, { key: "review_owner", type: "string", commands: ["create", "list"] } as InlineField]) }),
      ).resolves.toMatchObject({ changed: true });
      // A JavaScript proposal that omits schema.fields resets the list, as settings validation allows (Codex review round 2).
      await expect(
        sdk.mutateWorkspaceSettings({ operationId: "omit-fields", dryRun: true, mutate: (current) => ({ ...current, schema: { ...current.schema, fields: undefined } }) as unknown as PmSettings }),
      ).resolves.toMatchObject({ dry_run: true });
    });
  });

  it("judges a new field on a settings file that stores no schema at all", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const settingsPath = path.join(pmPath, "settings.json");
      const { schema: _schema, ...rest } = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
      await writeFile(settingsPath, `${JSON.stringify(rest, null, 2)}\n`);
      const sdk = createExtensionCommandSdk(pmPath, new PmClient({ pmRoot: pmPath, noExtensions: true }));
      await expect(
        sdk.mutateWorkspaceSettings({ operationId: "schema-less", dryRun: true, mutate: (current) => withFields(current, [{ key: "full", type: "string", commands: ["list"] } as InlineField]) }),
      ).rejects.toMatchObject({ context: expect.objectContaining({ code: "schema_field_option_collision" }) });
      // A write that leaves the stored bytes as they are keeps a settings file without a schema, and judges nothing.
      await expect(sdk.mutateWorkspaceSettings({ operationId: "schema-less-unchanged", dryRun: true, mutate: (current) => current })).resolves.toMatchObject({ dry_run: true });
    });
  });

  it("keeps a legacy definition through an unrelated write and judges it again once it changes", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const settingsPath = path.join(pmPath, "settings.json");
      const legacy = { key: "full", type: "string", commands: ["create", "list"] };
      // Stored without its defaults, and one the registry drops entirely (an empty flag).
      const bare = { key: "fields", commands: ["list"] };
      const dropped = { key: "review_dropped", type: "string", cli_flag: "--", commands: ["list"] };
      const raw = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown> & { schema?: Record<string, unknown> };
      await writeFile(settingsPath, `${JSON.stringify({ ...raw, schema: { ...raw.schema, fields: [legacy, bare, dropped] } }, null, 2)}\n`);
      const sdk = createExtensionCommandSdk(pmPath, new PmClient({ pmRoot: pmPath, noExtensions: true }));
      await expect(
        sdk.mutateWorkspaceSettings({ operationId: "unrelated", mutate: (current) => ({ ...current, author_default: "settings-writer" }) }),
      ).resolves.toMatchObject({ changed: true });
      expect((JSON.parse(await readFile(settingsPath, "utf8")) as { schema: { fields: unknown[] } }).schema.fields).toEqual([legacy, bare, dropped]);
      // A new alias that normalizes to nothing is judged even though the registry would drop it unseen (CodeRabbit review).
      await expect(
        sdk.mutateWorkspaceSettings({ operationId: "empty-alias", dryRun: true, mutate: (current) => withFields(current, current.schema.fields.map((field) => (field.key === "fields" ? { ...field, cli_aliases: ["--"] } : field))) }),
      ).rejects.toMatchObject({ context: expect.objectContaining({ code: "schema_field_flag_invalid" }) });
      // Restating a stored definition without its defaults is no change either (Codex review pass 4).
      await expect(
        sdk.mutateWorkspaceSettings({ operationId: "restated", mutate: (current) => ({ ...withFields(current, [legacy, bare, dropped] as InlineField[]), author_default: "restating-writer" }) }),
      ).resolves.toMatchObject({ changed: true });
      // A callback that JSON round-trips the tree drops undefined properties; the legacy field is still unchanged (Codex review round 3).
      await expect(
        sdk.mutateWorkspaceSettings({ operationId: "round-trip", mutate: (current) => ({ ...(JSON.parse(JSON.stringify(current)) as PmSettings), author_default: "round-trip-writer" }) }),
      ).resolves.toMatchObject({ changed: true });
      await expect(
        sdk.mutateWorkspaceSettings({ operationId: "changed", mutate: (current) => withFields(current, current.schema.fields.map((field) => ({ ...field, description: "now changed" }))) }),
      ).rejects.toMatchObject({ context: expect.objectContaining({ code: "schema_field_option_collision" }) });
    });
  });

  it("judges an earlier duplicate definition once a proposal makes it the one the registry reads (pm-2nwcgg)", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const settingsPath = path.join(pmPath, "settings.json");
      // The registry reads the last definition of a key, so the shadowing alias of the first one is inactive.
      const shadowing = { key: "review_owner", type: "string", commands: ["list"], cli_aliases: ["full"] };
      const winner = { key: "review_owner", type: "string", commands: ["list"] };
      const raw = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown> & { schema?: Record<string, unknown> };
      await writeFile(settingsPath, `${JSON.stringify({ ...raw, schema: { ...raw.schema, fields: [shadowing, winner] } }, null, 2)}\n`);
      const before = await readFile(settingsPath, "utf8");
      const sdk = createExtensionCommandSdk(pmPath, new PmClient({ pmRoot: pmPath, noExtensions: true }));
      // Restating both stored entries keeps the winner effective, so nothing is judged.
      await expect(
        sdk.mutateWorkspaceSettings({ operationId: "restate-both", dryRun: true, mutate: (current) => withFields(current, [shadowing, winner] as InlineField[]) }),
      ).resolves.toMatchObject({ dry_run: true });
      // Removing the winner leaves an exact stored copy that now takes effect and shadows --full on list.
      for (const dryRun of [true, false]) {
        await expect(
          sdk.mutateWorkspaceSettings({ operationId: `expose-${String(dryRun)}`, dryRun, mutate: (current) => withFields(current, [shadowing] as InlineField[]) }),
        ).rejects.toMatchObject({ exitCode: 2, context: expect.objectContaining({ code: "schema_field_option_collision", field: "review_owner", flag: "--full" }) });
      }
      expect(await readFile(settingsPath, "utf8")).toBe(before);
      // A file-backed definition of the key masks the inline list, so exposing the earlier inline entry changes
      // nothing the registry reads and is not judged (Codex review).
      await mkdir(path.join(pmPath, "schema"), { recursive: true });
      await writeFile(path.join(pmPath, "schema", "fields.json"), JSON.stringify({ fields: [{ key: "review_owner", type: "string", commands: ["create"] }] }));
      await expect(
        sdk.mutateWorkspaceSettings({ operationId: "masked", dryRun: true, mutate: (current) => withFields(current, [shadowing] as InlineField[]) }),
      ).resolves.toMatchObject({ dry_run: true });
    });
  });

  it("judges a file-backed definition a proposal makes effective, with no inline fields at all (Codex review)", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      await mkdir(path.join(pmPath, "schema"), { recursive: true });
      await writeFile(path.join(pmPath, "schema", "alternate.json"), JSON.stringify({ fields: [{ key: "review_owner", type: "string", commands: ["list"], cli_aliases: ["full"] }] }));
      const sdk = createExtensionCommandSdk(pmPath, new PmClient({ pmRoot: pmPath, noExtensions: true }));
      const pointAtAlternate = (current: PmSettings): PmSettings => ({ ...current, schema: { ...current.schema, fields: [], files: { ...current.schema.files, fields: "schema/alternate.json" } } });
      await expect(
        sdk.mutateWorkspaceSettings({ operationId: "switch-file", dryRun: true, mutate: pointAtAlternate }),
      ).rejects.toMatchObject({ context: expect.objectContaining({ code: "schema_field_option_collision", field: "review_owner", flag: "--full" }) });
    });
  });

  it("judges a definition a file switch makes effective as the registry reads it, leaving a stored blank alias to validate", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const settingsPath = path.join(pmPath, "settings.json");
      const raw = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown> & { schema?: Record<string, unknown> };
      const withInline = (fields: unknown[]) => writeFile(settingsPath, `${JSON.stringify({ ...raw, schema: { ...raw.schema, fields } }, null, 2)}\n`);
      await mkdir(path.join(pmPath, "schema"), { recursive: true });
      await writeFile(path.join(pmPath, "schema", "fields.json"), JSON.stringify({ fields: [{ key: "review_owner", type: "string", commands: ["create"] }] }));
      await writeFile(path.join(pmPath, "schema", "empty.json"), JSON.stringify({ fields: [] }));
      await writeFile(path.join(pmPath, "schema", "blank.json"), JSON.stringify({ fields: [{ key: "review_owner", type: "string", commands: ["list"], cli_aliases: [" "] }] }));
      await writeFile(path.join(pmPath, "schema", "shadow.json"), JSON.stringify({ fields: [{ key: "review_owner", type: "string", commands: ["list"], cli_aliases: [" ", "full"] }] }));
      const sdk = createExtensionCommandSdk(pmPath, new PmClient({ pmRoot: pmPath, noExtensions: true }));
      const pointAt = (file: string) => (current: PmSettings): PmSettings => ({ ...current, schema: { ...current.schema, files: { ...current.schema.files, fields: file } } });
      // The registry drops a blank alias, so it cannot shadow an option or stop a command. A stored entry that
      // keeps one and becomes effective, inline or file-backed, is admitted, and validate reports the alias.
      await withInline([{ key: "review_owner", type: "string", commands: ["list"], cli_aliases: [" "] }]);
      await expect(sdk.mutateWorkspaceSettings({ operationId: "unmask-inline", dryRun: true, mutate: pointAt("schema/empty.json") })).resolves.toMatchObject({ dry_run: true });
      await withInline([{ key: "review_owner", type: "string", commands: ["list"] }]);
      await expect(sdk.mutateWorkspaceSettings({ operationId: "blank-file", dryRun: true, mutate: pointAt("schema/blank.json") })).resolves.toMatchObject({ dry_run: true });
      // What the registry reads is still judged: a newly effective alias that shadows --full on list is refused.
      await expect(sdk.mutateWorkspaceSettings({ operationId: "shadow-file", dryRun: true, mutate: pointAt("schema/shadow.json") })).rejects.toMatchObject({
        context: expect.objectContaining({ code: "schema_field_option_collision", field: "review_owner", flag: "--full" }),
      });
      // A restated legacy entry with an inline value_schema, which validation strips on every read, is unchanged as
      // the registry reads it, so an unrelated write keeps it (Codex review).
      const legacy = { key: "review_owner", type: "string", commands: ["list"], cli_aliases: ["full"], value_schema: { type: "string" } };
      await withInline([legacy]);
      await writeFile(path.join(pmPath, "schema", "fields.json"), JSON.stringify({ fields: [] }));
      await expect(
        sdk.mutateWorkspaceSettings({ operationId: "restate-legacy", dryRun: true, mutate: (current) => ({ ...withFields(current, [legacy] as InlineField[]), author_default: "legacy-writer" }) }),
      ).resolves.toMatchObject({ dry_run: true });
      // The comparison reads the bytes about to be written: serialization drops a definition whose value_schema is
      // invalid, so making the safe later duplicate invalid exposes the earlier shadowing one, which is refused, and
      // an invalid trailing duplicate that serialization drops leaves the safe winner in place (Codex review).
      const shadowing = { key: "review_lead", type: "string", commands: ["list"], cli_aliases: ["full"] };
      const safe = { key: "review_lead", type: "string", commands: ["list"] };
      await withInline([legacy, shadowing, safe]);
      await expect(
        sdk.mutateWorkspaceSettings({ operationId: "drop-winner", dryRun: true, mutate: (current) => withFields(current, [legacy, shadowing, { ...safe, value_schema: { one_of: [] } }] as InlineField[]) }),
      ).rejects.toMatchObject({ context: expect.objectContaining({ code: "schema_field_option_collision", field: "review_lead", flag: "--full" }) });
      await withInline([legacy, safe]);
      await expect(
        sdk.mutateWorkspaceSettings({ operationId: "drop-trailing", dryRun: true, mutate: (current) => withFields(current, [legacy, safe, { ...shadowing, value_schema: { one_of: [] } }] as InlineField[]) }),
      ).resolves.toMatchObject({ dry_run: true });
      // A newly supplied blank spelling is still refused, as before.
      await expect(
        sdk.mutateWorkspaceSettings({ operationId: "new-blank", dryRun: true, mutate: (current) => withFields(current, [{ key: "review_lead", type: "string", commands: ["list"], cli_aliases: [" "] } as InlineField]) }),
      ).rejects.toMatchObject({ context: expect.objectContaining({ code: "schema_field_flag_invalid", field: "review_lead" }) });
    });
  });
});
