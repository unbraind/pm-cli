import { describe, expect, it } from "vitest";
import { runWithConfigurationOnlySettings } from "../../../../src/core/store/settings.js";
import { PmCliError } from "../../../../src/core/shared/errors.js";
import { commitItemMutations } from "../../../../src/sdk/item-transaction.js";
import { planItemMutationDocument } from "../../../../src/sdk/lifecycle/structured-mutation-plan.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";

describe("planItemMutationDocument (pm-gh1456)", () => {
  it("derives or keeps the transaction id and resolves declared fields even under configuration-only reads", async () => {
    await withTempPmPath(async (context) => {
      expect(context.runCli(["schema", "add-field", "external_id", "--type", "string", "--json"]).code).toBe(0);
      const input = '{"title":"Planned","type":"Task","external_id":"plan-1"}';
      const derived = await planItemMutationDocument({ pmRoot: context.pmPath, input });
      expect(derived).toMatchObject({
        transaction_id: expect.stringMatching(/^mutate-[0-9a-f]{24}$/u),
        transaction_id_source: "derived",
        rows: [{ index: 0, ref: "row-1", op: "create" }],
      });
      expect(derived.mutations[0]).toMatchObject({ options: { title: "Planned", externalId: "plan-1" } });
      expect(derived).not.toHaveProperty("upsert_key");

      const explicit = await planItemMutationDocument({ pmRoot: context.pmPath, input, transactionId: " import-7 " });
      expect(explicit).toMatchObject({ transaction_id: "import-7", transaction_id_source: "explicit" });
      expect(explicit.mutations[0]?.id).not.toBe(derived.mutations[0]?.id);

      const scoped = await runWithConfigurationOnlySettings(context.pmPath, () =>
        planItemMutationDocument({ pmRoot: context.pmPath, input }),
      );
      expect(scoped.mutations[0]).toMatchObject({ options: { externalId: "plan-1" } });
      expect(scoped.transaction_id).toBe(derived.transaction_id);
    });
  });

  it("matches existing items by a declared custom field and by a core field for keyed upsert", async () => {
    await withTempPmPath(async (context) => {
      expect(context.runCli(["schema", "add-field", "external_id", "--type", "string", "--json"]).code).toBe(0);
      const seeded = await planItemMutationDocument({
        pmRoot: context.pmPath,
        input: '{"title":"Seed","type":"Task","external_id":"seed-1"}',
      });
      await commitItemMutations({ pmRoot: context.pmPath, transactionId: seeded.transaction_id, author: "seed", mutations: seeded.mutations });
      const seededId = seeded.rows[0]!.id;

      expect(context.runCli(["create", "task", "No key here", "--json"]).code).toBe(0);
      const byCustom = await planItemMutationDocument({
        pmRoot: context.pmPath,
        upsertKey: "external_id",
        input: '{"title":"Seed renamed","type":"Task","external_id":"seed-1"}\n{"title":"Brand new","type":"Task","external_id":"seed-2"}',
      });
      expect(byCustom).toMatchObject({ upsert_key: "external_id" });
      expect(byCustom.rows).toEqual([
        { index: 0, ref: "row-1", id: seededId, op: "update", upserted: true },
        { index: 1, ref: "row-2", id: expect.any(String), op: "create" },
      ]);

      const byTitle = await runWithConfigurationOnlySettings(context.pmPath, () =>
        planItemMutationDocument({
          pmRoot: context.pmPath,
          upsertKey: "title",
          input: '{"title":"Seed","type":"Task","priority":1}',
        }),
      );
      expect(byTitle.rows).toEqual([{ index: 0, ref: "row-1", id: seededId, op: "update", upserted: true }]);

      await expect(
        planItemMutationDocument({ pmRoot: context.pmPath, upsertKey: "external_id", input: '{"title":"No key","type":"Task"}' }),
      ).rejects.toMatchObject({ context: { code: "upsert_key_missing" } });
      await expect(
        planItemMutationDocument({ pmRoot: context.pmPath, input: "{not json" }),
      ).rejects.toBeInstanceOf(PmCliError);
    });
  });
});

describe("planItemMutationDocument schema and settings variants", () => {
  it("scans custom-type folders declared in the types file under configuration-only reads and tolerates absent item_types", async () => {
    await withTempPmPath(async (context) => {
      const { readSettings } = await import("../../../../src/core/store/settings.js");
      expect(context.runCli(["schema", "add-type", "incident", "--json"]).code).toBe(0);
      expect(context.runCli(["create", "incident", "Seeded incident", "--json"]).code).toBe(0);
      const scoped = await runWithConfigurationOnlySettings(context.pmPath, () =>
        planItemMutationDocument({ pmRoot: context.pmPath, upsertKey: "title", input: '{"title":"Seeded incident","type":"incident","priority":1}' }),
      );
      expect(scoped.rows).toEqual([{ index: 0, ref: "row-1", id: expect.any(String), op: "update", upserted: true }]);
      const { rm } = await import("node:fs/promises");
      const path = await import("node:path");
      await rm(path.join(context.pmPath, "schema", "types.json"), { force: true });
      const withoutTypesFile = await runWithConfigurationOnlySettings(context.pmPath, () =>
        planItemMutationDocument({ pmRoot: context.pmPath, input: '{"title":"Plain","type":"Task"}' }),
      );
      expect(withoutTypesFile.rows[0]).toMatchObject({ op: "create" });
      const settings = await readSettings(context.pmPath);
      const withoutTypes = await planItemMutationDocument({
        pmRoot: context.pmPath,
        upsertKey: "title",
        input: '{"title":"Seeded incident","type":"incident"}',
        settings: { ...settings, item_types: undefined } as never,
      });
      // Without the custom type in the registry its folder is not scanned, so the record is a create.
      expect(withoutTypes.rows[0]).toMatchObject({ op: "create" });
    });
  });
});

describe("planItemMutationDocument guarded schema reads", () => {
  it.skipIf(process.platform === "win32")("refuses a special schema file under configuration-only reads instead of opening it", async () => {
    await withTempPmPath(async (context) => {
      const { execFileSync } = await import("node:child_process");
      const { readFile, writeFile } = await import("node:fs/promises");
      const path = await import("node:path");
      const settingsPath = path.join(context.pmPath, "settings.json");
      const settings = JSON.parse(await readFile(settingsPath, "utf8")) as { schema: { files: Record<string, string> } };
      const target = path.join(context.pmPath, "schema", "unsafe-fields.json");
      execFileSync("mkfifo", [target]);
      settings.schema.files.fields = target;
      await writeFile(settingsPath, JSON.stringify(settings));
      const refusal = runWithConfigurationOnlySettings(context.pmPath, () =>
        planItemMutationDocument({ pmRoot: context.pmPath, input: '{"title":"Blocked","type":"Task"}' }),
      );
      await expect(refusal).rejects.toMatchObject({ context: { code: "transaction_preview_non_regular_file" } });
    });
  });
});
