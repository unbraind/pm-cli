import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { create, get, readSettings, resolveRuntimeFieldRegistry, update } from "../../../src/sdk/runtime.js";
import { parseItemDocument } from "../../../src/core/item/item-format.js";
import { itemDocumentToMutationOptions } from "../../../src/sdk/structured-mutations.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

describe("declared custom item JSON transport", () => {
  it("preserves every container and scalar type through real CLI and SDK writes with per-field overrides", async () => {
    await withTempPmPath(async (context) => {
      const settings = await readSettings(context.pmPath);
      const values = {
        schema_text: 'comma,equals=quote"\nUnicode λ',
        schema_count: 0,
        schema_enabled: false,
        schema_object: { nested: { value: null }, text: "a,b=c" },
        schema_array: [null, false, 0, { text: "a,b=c" }],
      };
      const types = ["string", "number", "boolean", "object", "array"] as const;
      settings.schema.fields = Object.keys(values).map((key, index) => ({
        key: `input_${index}`,
        metadata_key: key,
        cli_flag: `custom-${index}`,
        cli_aliases: [`alias-${index}`],
        type: types[index]!,
      }));
      await writeFile(path.join(context.pmPath, "settings.json"), JSON.stringify(settings));
      const extensionValues = Object.fromEntries(Object.entries(values).map(([key, value]) => [key.replace("schema_", "extension_"), value]));
      const extensionRoot = path.join(context.pmPath, "extensions", "custom-fields");
      await mkdir(extensionRoot, { recursive: true });
      await writeFile(path.join(extensionRoot, "manifest.json"), JSON.stringify({ name: "custom-fields", version: "1.0.0", entry: "index.mjs", capabilities: ["schema"] }));
      await copyFile(new URL("../../fixtures/compatibility/custom-fields/index.mjs", import.meta.url), path.join(extensionRoot, "index.mjs"));
      await writeFile(path.join(extensionRoot, "fields.json"), JSON.stringify(Object.keys(extensionValues).map((name, index) => ({ name, type: types[index] }))));
      const created = context.runCli(["create", "--stdin-json", "--json"], {
        input: JSON.stringify({ title: "Custom transport", type: "Task", ...values, ...extensionValues }), expectJson: true,
      });
      expect(created.code, created.stderr).toBe(0);
      const id = (created.json as { item: { id: string } }).item.id;
      const envelope = context.runCli(["get", id, "--full", "--json"], { expectJson: true }).json;
      expect(envelope).toMatchObject({ item: { ...values, ...extensionValues } });
      const roundTrip = context.runCli(["update", id, "--stdin-json", "--alias-0", "Flag text", "--field", "extension_count=7", "--json"], { input: JSON.stringify(envelope), expectJson: true });
      expect(roundTrip.code, roundTrip.stderr).toBe(0);
      expect(context.runCli(["get", id, "--full", "--json"], { expectJson: true }).json).toMatchObject({ item: { ...values, ...extensionValues, schema_text: "Flag text", extension_count: 7 } });
      const fields = resolveRuntimeFieldRegistry(settings.schema).definitions;
      const options = itemDocumentToMutationOptions(JSON.stringify({ title: "SDK custom transport", type: "Task", ...values }), "create", {}, fields);
      const sdkItem = await create(options, { pmRoot: context.pmPath, noExtensions: true });
      expect((await get(sdkItem.item.id, { full: true }, { pmRoot: context.pmPath, noExtensions: true })).item).toMatchObject(values);
      await update(sdkItem.item.id, itemDocumentToMutationOptions(JSON.stringify({ ...values, schema_count: 9 }), "update", {}, fields), { pmRoot: context.pmPath, noExtensions: true });
      expect((await get(sdkItem.item.id, { full: true }, { pmRoot: context.pmPath, noExtensions: true })).item).toMatchObject({ ...values, schema_count: 9 });
      const itemPath = path.join(context.pmPath, "tasks", `${id}.toon`);
      const historyPath = path.join(context.pmPath, "history", `${id}.jsonl`);
      const original = await Promise.all([readFile(itemPath), readFile(historyPath)]);
      for (const invalid of [{ undeclared_metadata: true }, { titlle: "Typo" }, { schema_count: "bad number" }]) {
        const refused = context.runCli(["update", id, "--stdin-json", "--json"], { input: JSON.stringify({ ...invalid, title: "Must not persist" }) });
        expect(refused.code, refused.stderr).toBe(2);
        expect(await Promise.all([readFile(itemPath), readFile(historyPath)])).toEqual(original);
      }
      expect(context.runCli(["history", id, "--verify", "--json"]).code).toBe(0);
    });
  });

  it("refuses newer stored item formats before reads, mutations, deletion, or recovery can change bytes", async () => {
    for (const format of ["toon", "json_markdown"] as const) {
      await withTempPmPath(async (context) => {
        const created = context.runCli(["create", "--title", "Future format", "--type", "Task", "--json"], { expectJson: true }).json as { item: { id: string } };
        const id = created.item.id;
        const createdPath = path.join(context.pmPath, "tasks", `${id}.toon`);
        const itemPath = path.join(context.pmPath, "tasks", `${id}.${format === "toon" ? "toon" : "md"}`);
        const historyPath = path.join(context.pmPath, "history", `${id}.jsonl`);
        const baseline = await readFile(createdPath, "utf8");
        const metadata = { ...parseItemDocument(baseline, { format: "toon" }).metadata, pm_format_version: 2 };
        if (format === "json_markdown") {
          await rename(createdPath, itemPath);
        }
        const variants = format === "toon" ? [
          `${baseline}\npm_format_version: 2\n`,
          `${baseline.replace(/^title:.*$/mu, "title: 123")}\npm_format_version: 2\n`,
          "pm_format_version: 2\n",
          "front_matter:\n  pm_format_version: 2\n  title: 123\nbody[1]: wrong-shape\n",
        ] : [JSON.stringify(metadata), JSON.stringify({ ...metadata, title: 123 }), JSON.stringify({ pm_format_version: 2 })];
        expect(parseItemDocument(variants[0]!, { format }).metadata.pm_format_version).toBe(2);
        expect(() => parseItemDocument(variants[0]!, { format, requireSupportedFormat: true })).toThrow("Upgrade");
        for (const raw of variants) {
          await writeFile(itemPath, raw);
          const original = await Promise.all([readFile(itemPath), readFile(historyPath)]);
          for (const args of [["get", id], ["update", id, "--title", "Unsafe"], ["delete", id], ["restore", id, "1"]]) {
            const refused = context.runCli([...args, "--json"]);
            expect(refused.code, refused.stderr).toBe(4);
            expect(JSON.parse(refused.stderr)).toMatchObject({ code: "item_format_version_unsupported", required: expect.stringContaining("Upgrade") });
            expect(await Promise.all([readFile(itemPath), readFile(historyPath)])).toEqual(original);
          }
          await expect(get(id, {}, { pmRoot: context.pmPath, noExtensions: true })).rejects.toMatchObject({ context: { code: "item_format_version_unsupported", item_id: id, format_version: 2 } });
        }
        for (const raw of format === "toon" ? ["front_matter: null\n", "front_matter: 123\n"] : []) {
          await writeFile(itemPath, raw);
          const invalid = context.runCli(["get", id, "--json"]);
          expect(JSON.parse(invalid.stderr).code).toBe("item_document_invalid");
          const restored = context.runCli(["restore", id, "1", "--json"]);
          expect(restored.code, restored.stderr).toBe(0);
          expect(context.runCli(["history", id, "--verify", "--json"]).code).toBe(0);
        }
      });
    }
  });
});
