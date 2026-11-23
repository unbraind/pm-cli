/**
 * pm-3s4jwl: the extension settings writer (`mutateWorkspaceSettings`) shares
 * the `schema add-field` admission for each inline field definition it adds or
 * changes, while an unrelated write keeps a legacy definition exactly as stored.
 */
import { readFile, writeFile } from "node:fs/promises";
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
    });
  });

  it("keeps a legacy definition through an unrelated write and judges it again once it changes", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const settingsPath = path.join(pmPath, "settings.json");
      const legacy = { key: "full", type: "string", commands: ["create", "list"] };
      const raw = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown> & { schema?: Record<string, unknown> };
      await writeFile(settingsPath, `${JSON.stringify({ ...raw, schema: { ...raw.schema, fields: [legacy] } }, null, 2)}\n`);
      const sdk = createExtensionCommandSdk(pmPath, new PmClient({ pmRoot: pmPath, noExtensions: true }));
      await expect(
        sdk.mutateWorkspaceSettings({ operationId: "unrelated", mutate: (current) => ({ ...current, author_default: "settings-writer" }) }),
      ).resolves.toMatchObject({ changed: true });
      expect((JSON.parse(await readFile(settingsPath, "utf8")) as { schema: { fields: unknown[] } }).schema.fields).toEqual([legacy]);
      await expect(
        sdk.mutateWorkspaceSettings({ operationId: "changed", mutate: (current) => withFields(current, current.schema.fields.map((field) => ({ ...field, description: "now changed" }))) }),
      ).rejects.toMatchObject({ context: expect.objectContaining({ code: "schema_field_option_collision" }) });
    });
  });
});
