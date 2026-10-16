import { describe, expect, it } from "vitest";
import { runWithConfigurationOnlySettings } from "../../../../src/core/store/settings.js";
import { PmCliError } from "../../../../src/core/shared/errors.js";
import { commitItemMutations } from "../../../../src/sdk/item-transaction.js";
import { planItemMutationDocument } from "../../../../src/sdk/lifecycle/structured-mutation-plan.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";

describe("planItemMutationDocument (pm-gh1456)", () => {
  it.each(["", " \t\n "])("refuses supplied blank upsert keys before writes: %j", async (upsertKey) => {
    await withTempPmPath(async (context) => {
      const { readdir } = await import("node:fs/promises");
      const before = await readdir(context.pmPath, { recursive: true });
      await expect(planItemMutationDocument({ pmRoot: context.pmPath, upsertKey, input: '{"title":"Never created","type":"Task"}' })).rejects.toMatchObject({ exitCode: 2, message: "Upsert key must be a non-empty field name." });
      expect(await readdir(context.pmPath, { recursive: true })).toEqual(before);
    });
  });

  it("persists and upserts wrapped camelCase core fields under their stored metadata keys", async () => {
    await withTempPmPath(async (context) => {
      const input = (title: string) => JSON.stringify({ item: { title, type: "Task", acceptanceCriteria: "wrapped-key" } });
      const seed = await planItemMutationDocument({ pmRoot: context.pmPath, transactionId: "wrapped-alias-seed", upsertKey: "acceptanceCriteria", input: input("Seed") });
      expect(seed.mutations[0]).toMatchObject({ op: "create", unique: { key: "acceptance_criteria", value: "wrapped-key" } });
      await commitItemMutations({ pmRoot: context.pmPath, transactionId: seed.transaction_id, author: "seed", mutations: seed.mutations });
      const plan = await planItemMutationDocument({ pmRoot: context.pmPath, transactionId: "wrapped-alias-update", upsertKey: "acceptance_criteria", input: input("Renamed") });
      expect(plan).toMatchObject({ rows: [{ id: seed.rows[0]!.id, op: "update", upserted: true }], mutations: [{ match: { key: "acceptance_criteria", value: "wrapped-key" } }] });
      await commitItemMutations({ pmRoot: context.pmPath, transactionId: plan.transaction_id, author: "update", mutations: plan.mutations });
      const result = context.runCli(["get", seed.rows[0]!.id, "--json", "--full"], { expectJson: true }).json as { item: Record<string, unknown> };
      expect(result.item).toMatchObject({ title: "Renamed", acceptance_criteria: "wrapped-key" });
      expect(result.item).not.toHaveProperty("acceptanceCriteria");
      const storedWins = await planItemMutationDocument({ pmRoot: context.pmPath, transactionId: "wrapped-alias-stored-wins", upsertKey: "acceptanceCriteria", input: JSON.stringify({ item: { title: "Stored wins", type: "Task", acceptance_criteria: "wrapped-key", acceptanceCriteria: "ignored-alias" } }) });
      expect(storedWins.mutations[0]).toMatchObject({ match: { key: "acceptance_criteria", value: "wrapped-key" } });
      await commitItemMutations({ pmRoot: context.pmPath, transactionId: storedWins.transaction_id, author: "update", mutations: storedWins.mutations });
      expect(context.runCli(["get", seed.rows[0]!.id, "--json", "--full"], { expectJson: true }).json).toMatchObject({ item: { title: "Stored wins", acceptance_criteria: "wrapped-key" } });
      expect(context.runCli(["list", "--status", "all", "--json"], { expectJson: true }).json).toMatchObject({ count: 1 });
    });
  });

  it("preserves camelCase extension metadata keys outside the core field vocabulary", async () => {
    await withTempPmPath(async (context) => {
      const { mkdir, writeFile } = await import("node:fs/promises");
      const path = await import("node:path");
      const directory = path.join(context.pmPath, "extensions", "legacy-fields");
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, "manifest.json"), JSON.stringify({ name: "legacy-fields", version: "1.0.0", entry: "./index.mjs", capabilities: ["schema"] }));
      await writeFile(path.join(directory, "index.mjs"), 'export default { activate(api) { api.registerItemFields([{ name: "legacyId", type: "string" }]); } };');
      const seed = await planItemMutationDocument({ pmRoot: context.pmPath, transactionId: "legacy-seed", input: '{"id":"pm-legacy","title":"Legacy","type":"Task","legacyId":"legacy-1"}' });
      await commitItemMutations({ pmRoot: context.pmPath, transactionId: seed.transaction_id, author: "seed", mutations: seed.mutations });
      const plan = await planItemMutationDocument({ pmRoot: context.pmPath, transactionId: "legacy-update", upsertKey: "legacyId", input: '{"title":"Renamed legacy","type":"Task","legacyId":"legacy-1"}' });
      expect(plan).toMatchObject({ upsert_key: "legacyId", rows: [{ id: "pm-legacy", op: "update", upserted: true }], mutations: [{ match: { key: "legacyId", value: "legacy-1" } }] });
      await commitItemMutations({ pmRoot: context.pmPath, transactionId: plan.transaction_id, author: "update", mutations: plan.mutations });
      expect(context.runCli(["get", "pm-legacy", "--json", "--full"], { expectJson: true }).json).toMatchObject({ item: { title: "Renamed legacy", legacyId: "legacy-1" } });
      expect(context.runCli(["list", "--status", "all", "--json"], { expectJson: true }).json).toMatchObject({ count: 1 });
    });
  });

  it("matches core camelCase option targets using stored keys across distinct transactions", async () => {
    await withTempPmPath(async (context) => {
      const fields = [
        ["acceptanceCriteria", "acceptance_criteria", "criteria-key"],
        ["definitionOfReady", "definition_of_ready", "ready-key"],
        ["estimatedMinutes", "estimated_minutes", "45"],
        ["affectedVersion", "affected_version", "v1"],
        ["fixedVersion", "fixed_version", "v2"],
        ["customerImpact", "customer_impact", "impact-key"],
      ] as const;
      const seed = await planItemMutationDocument({ pmRoot: context.pmPath, transactionId: "core-alias-seed", input: JSON.stringify({ title: "Seed", type: "Task", ...Object.fromEntries(fields.map(([, stored, value]) => [stored, value])) }) });
      await commitItemMutations({ pmRoot: context.pmPath, transactionId: seed.transaction_id, author: "seed", mutations: seed.mutations });
      for (const [key, stored, value] of fields) {
        const plan = await planItemMutationDocument({ pmRoot: context.pmPath, transactionId: `core-${key}`, upsertKey: key, input: JSON.stringify([{ op: "create", options: { title: "Renamed", type: "Task", [key]: value } }]) });
        expect(plan).toMatchObject({ upsert_key: stored, rows: [{ id: seed.rows[0]!.id, op: "update", upserted: true }], mutations: [{ match: { key: stored, value } }] });
        await commitItemMutations({ pmRoot: context.pmPath, transactionId: plan.transaction_id, author: "update", mutations: plan.mutations });
      }
      expect(context.runCli(["list", "--status", "all", "--json"], { expectJson: true }).json).toMatchObject({ count: 1 });
    });
  });

  it("canonicalizes custom upsert keys before matching and guarding persisted values", async () => {
    await withTempPmPath(async (context) => {
      const { writeFile } = await import("node:fs/promises");
      const path = await import("node:path");
      await writeFile(path.join(context.pmPath, "schema", "fields.json"), JSON.stringify({ fields: [
        { key: "external_id", metadata_key: "shadow_key", type: "string" },
        { key: "ticket_reference", metadata_key: "external_id", type: "string", commands: ["create", "update"] },
      ] }));
      const seed = await planItemMutationDocument({ pmRoot: context.pmPath, transactionId: "alias-seed", input: '{"title":"Seed","type":"Task","external_id":"ext-1"}' });
      await commitItemMutations({ pmRoot: context.pmPath, transactionId: seed.transaction_id, author: "seed", mutations: seed.mutations });
      for (const key of ["external_id", "ticket_reference", "ticketReference"]) {
        const plan = await planItemMutationDocument({ pmRoot: context.pmPath, transactionId: `alias-${key}`, upsertKey: key, input: '{"op":"create","options":{"title":"Renamed","type":"Task","ticketReference":"ext-1"}}' });
        expect(plan).toMatchObject({ upsert_key: "external_id", rows: [{ id: seed.rows[0]!.id, op: "update", upserted: true }], mutations: [{ match: { key: "external_id", value: "ext-1" } }] });
        await commitItemMutations({ pmRoot: context.pmPath, transactionId: plan.transaction_id, author: "update", mutations: plan.mutations });
      }
      const missing = await planItemMutationDocument({ pmRoot: context.pmPath, transactionId: "alias-missing", upsertKey: "ticketReference", input: '{"title":"New","type":"Task","external_id":"ext-2"}' });
      expect(missing.mutations[0]).toMatchObject({ op: "create", unique: { key: "external_id", value: "ext-2" } });
      await commitItemMutations({ pmRoot: context.pmPath, transactionId: missing.transaction_id, author: "create", mutations: missing.mutations });
      const items = context.runCli(["list", "--status", "all", "--json"], { expectJson: true }).json as { items: Array<{ id: string }> };
      expect(items.items.map((item) => item.id).sort()).toEqual([seed.rows[0]!.id, missing.rows[0]!.id].sort());
    });
  });

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
