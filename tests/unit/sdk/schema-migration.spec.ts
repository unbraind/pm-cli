import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  formatSchemaEvolutionMigrationHuman,
  planSchemaEvolutionMigration,
  runSchemaEvolutionMigration,
  schemaMigrationTestOnly,
  type SchemaEvolutionMigrationRequest,
} from "../../../src/sdk/schema-migration.js";
import {
  PmClient,
  runAction,
  schemaRemapStatus,
  schemaRenameField,
  schemaRenameType,
} from "../../../src/sdk/runtime.js";
import {
  runSchemaAddField,
  runSchemaAddStatus,
  runSchemaAddType,
} from "../../../src/sdk/schema.js";
import { runCreate } from "../../../src/cli/commands/create.js";
import type { ItemMetadata } from "../../../src/types/index.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";
import { readHistoryEntries } from "../../../src/core/history/read.js";
import {
  getWorkspaceHistoryPath,
  WORKSPACE_HISTORY_ID,
} from "../../../src/core/history/workspace-history.js";
import { verifyHistoryChain } from "../../../src/core/history/replay.js";
import { runTemplatesSave } from "../../../src/sdk/templates.js";
import { acquireLock } from "../../../src/core/lock/lock.js";
import { listAllDocumentCandidatesCached } from "../../../src/core/store/item-metadata-cache.js";
import {
  readSettings,
  writeSettings,
} from "../../../src/core/store/settings.js";
import { resolveItemTypeRegistry } from "../../../src/core/item/type-registry.js";

function item(
  id: string,
  overrides: Partial<ItemMetadata> = {},
): ItemMetadata {
  return {
    id,
    title: id,
    type: "Task",
    status: "open",
    priority: 2,
    created_at: "2026-07-23T00:00:00.000Z",
    updated_at: "2026-07-23T00:00:00.000Z",
    ...overrides,
  };
}

describe("schema evolution migration planning", () => {
  it.each([
    {
      request: {
        kind: "rename-type",
        from: "Task",
        to: "WorkItem",
      } satisfies SchemaEvolutionMigrationRequest,
      items: [item("pm-a"), item("pm-b", { type: "Issue" })],
      expected: {
        affected: ["pm-a"],
        changes: [{ field: "type", before: "Task", after: "WorkItem" }],
      },
    },
    {
      request: {
        kind: "rename-field",
        from: "customer",
        to: "account",
      } satisfies SchemaEvolutionMigrationRequest,
      items: [
        item("pm-a", { customer: "Ada" } as Partial<ItemMetadata>),
        item("pm-b"),
      ],
      expected: {
        affected: ["pm-a"],
        changes: [{ field: "customer", before: "Ada", after: undefined }],
      },
    },
    {
      request: {
        kind: "remap-status",
        from: "review",
        to: "ready",
      } satisfies SchemaEvolutionMigrationRequest,
      items: [item("pm-a", { status: "review" }), item("pm-b")],
      expected: {
        affected: ["pm-a"],
        changes: [{ field: "status", before: "review", after: "ready" }],
      },
    },
  ])(
    "builds a deterministic $request.kind plan",
    ({ request, items, expected }) => {
      const plan = planSchemaEvolutionMigration(items, {
        migrationId: "schema-2026-07",
        request,
      });
      expect(plan.migration_id).toBe("schema-2026-07");
      expect(plan.affected_item_count).toBe(1);
      expect(plan.pending_item_count).toBe(1);
      expect(plan.items.map((entry) => entry.id)).toEqual(expected.affected);
      expect(plan.items[0]?.changes).toEqual(
        expect.arrayContaining(expected.changes),
      );
      expect(plan.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    },
  );

  it("refuses a field rename that would overwrite an existing value", () => {
    expect(() =>
      planSchemaEvolutionMigration(
        [
          item("pm-a", {
            customer: "Ada",
            account: "Grace",
          } as Partial<ItemMetadata>),
        ],
        {
          migrationId: "collision",
          request: {
            kind: "rename-field",
            from: "customer",
            to: "account",
          },
        },
      ),
    ).toThrow(
      'Schema migration collision on item "pm-a": target field "account" already exists.',
    );
  });

  it("filters completed item ids without changing the complete-plan fingerprint", () => {
    const items = [item("pm-b"), item("pm-a")];
    const options = {
      migrationId: "resume",
      request: {
        kind: "rename-type",
        from: "Task",
        to: "WorkItem",
      } as const,
    };
    const complete = planSchemaEvolutionMigration(items, options);
    const resumed = planSchemaEvolutionMigration(items, {
      ...options,
      completedItemIds: ["pm-a"],
    });
    expect(complete.fingerprint).toBe(resumed.fingerprint);
    expect(complete.items.map((entry) => entry.id)).toEqual(["pm-a", "pm-b"]);
    expect(resumed.items.map((entry) => entry.id)).toEqual(["pm-b"]);
    expect(resumed.skipped_completed_count).toBe(1);
  });

  it("rejects empty identities and no-op mappings", () => {
    expect(() =>
      planSchemaEvolutionMigration([], {
        migrationId: " ",
        request: { kind: "rename-type", from: "Task", to: "WorkItem" },
      }),
    ).toThrow("Schema migration migrationId must be non-empty");
    expect(() =>
      planSchemaEvolutionMigration([], {
        migrationId: "noop",
        request: { kind: "remap-status", from: "review", to: "review" },
      }),
    ).toThrow("Schema migration source and target must differ");
    expect(() =>
      planSchemaEvolutionMigration([], {
        migrationId: "not/portable",
        request: { kind: "rename-type", from: "Task", to: "WorkItem" },
      }),
    ).toThrow("must match [a-zA-Z0-9._-]+");
  });

  it("supports type-scoped field plans and every idempotent item transition", () => {
    const scoped = planSchemaEvolutionMigration(
      [
        item("pm-task", {
          customer: "Ada",
        } as Partial<ItemMetadata>),
        item("pm-issue", {
          type: "Issue",
          customer: "Grace",
        } as Partial<ItemMetadata>),
      ],
      {
        migrationId: "scoped",
        request: {
          kind: "rename-field",
          from: "customer",
          to: "account",
          type: " Task ",
        },
      },
    );
    expect(scoped.items.map(({ id }) => id)).toEqual(["pm-task"]);

    const typeDocument = { metadata: item("pm-type", { type: "WorkItem" }) };
    expect(
      schemaMigrationTestOnly.applyItemRequest(
        typeDocument,
        { kind: "rename-type", from: "Task", to: "WorkItem" },
        "forward",
      ),
    ).toEqual([]);
    expect(() =>
      schemaMigrationTestOnly.applyItemRequest(
        { metadata: item("pm-type", { type: "Issue" }) },
        { kind: "rename-type", from: "Task", to: "WorkItem" },
        "forward",
      ),
    ).toThrow('expected type "Task"');
    expect(
      schemaMigrationTestOnly.applyItemRequest(
        typeDocument,
        { kind: "rename-type", from: "Task", to: "WorkItem" },
        "reverse",
      ),
    ).toEqual(["type"]);

    const statusDocument = {
      metadata: item("pm-status", { status: "ready" }),
    };
    expect(
      schemaMigrationTestOnly.applyItemRequest(
        statusDocument,
        { kind: "remap-status", from: "review", to: "ready" },
        "forward",
      ),
    ).toEqual([]);
    expect(() =>
      schemaMigrationTestOnly.applyItemRequest(
        { metadata: item("pm-status", { status: "blocked" }) },
        { kind: "remap-status", from: "review", to: "ready" },
        "forward",
      ),
    ).toThrow('expected status "review"');
    expect(
      schemaMigrationTestOnly.applyItemRequest(
        statusDocument,
        { kind: "remap-status", from: "review", to: "ready" },
        "reverse",
      ),
    ).toEqual(["status"]);

    const renamedField = {
      metadata: item("pm-field", {
        account: "Ada",
      } as Partial<ItemMetadata>),
    };
    expect(
      schemaMigrationTestOnly.applyItemRequest(
        renamedField,
        { kind: "rename-field", from: "customer", to: "account" },
        "forward",
      ),
    ).toEqual([]);
    expect(() =>
      schemaMigrationTestOnly.applyItemRequest(
        { metadata: item("pm-field") },
        { kind: "rename-field", from: "customer", to: "account" },
        "forward",
      ),
    ).toThrow("field state changed concurrently");
    expect(
      schemaMigrationTestOnly.changedFieldsForItem(
        renamedField.metadata,
        { kind: "rename-field", from: "customer", to: "account" },
      ),
    ).toEqual([]);
  });

  it("rewrites all persisted reference shapes and refuses template collisions", () => {
    const fieldReferences = schemaMigrationTestOnly.mutateSchemaReferences(
      `${JSON.stringify({
        definitions: [
          {
            required_create_fields: ["customer"],
            required_create_repeatables: ["customer"],
            options: [{ key: "customer" }],
            command_option_policies: [{ option: "customer" }],
          },
        ],
      })}\n`,
      { kind: "rename-field", from: "customer", to: "account" },
    );
    expect(JSON.parse(fieldReferences)).toMatchObject({
      definitions: [
        {
          required_create_fields: ["account"],
          required_create_repeatables: ["account"],
          options: [{ key: "account" }],
          command_option_policies: [{ option: "account" }],
        },
      ],
    });
    expect(
      schemaMigrationTestOnly.mutateSchemaReferences(
        JSON.stringify({ options: { title: "unchanged" } }),
        { kind: "rename-field", from: "customer", to: "account" },
      ),
    ).toContain("unchanged");
    expect(() =>
      schemaMigrationTestOnly.mutateSchemaReferences(
        JSON.stringify({
          name: "collision",
          options: { customer: "Ada", account: "Grace" },
        }),
        { kind: "rename-field", from: "customer", to: "account" },
      ),
    ).toThrow('saved template "collision"');
    expect(() =>
      schemaMigrationTestOnly.mutateSchemaReferences(
        JSON.stringify({
          options: { customer: "Ada", account: "Grace" },
        }),
        { kind: "rename-field", from: "customer", to: "account" },
      ),
    ).toThrow('saved template "unknown"');
    expect(
      schemaMigrationTestOnly.mutateSchemaReferences(
        JSON.stringify([{ options: { customer: "Ada" } }]),
        { kind: "rename-field", from: "customer", to: "account" },
      ),
    ).toContain("customer");
    expect(
      schemaMigrationTestOnly.mutateSchemaReferences(
        JSON.stringify({ fields: [{}], type_workflows: [{}] }),
        { kind: "rename-type", from: "Legacy", to: "WorkItem" },
      ),
    ).toContain("type_workflows");
    expect(
      schemaMigrationTestOnly.mutateSchemaReferences(
        JSON.stringify({ type_workflows: [{}] }),
        { kind: "remap-status", from: "review", to: "ready" },
      ),
    ).toContain("type_workflows");
    expect(
      JSON.parse(
        schemaMigrationTestOnly.mutateSchemaReferences(
          JSON.stringify({
            type_workflows: [
              { allowed_transitions: ["malformed", ["review", "closed"]] },
            ],
          }),
          { kind: "remap-status", from: "review", to: "ready" },
        ),
      ),
    ).toMatchObject({
      type_workflows: [
        { allowed_transitions: ["malformed", ["ready", "closed"]] },
      ],
    });
    expect(
      schemaMigrationTestOnly.changedFieldsForItem(
        item("pm-ready", { status: "ready" }),
        { kind: "remap-status", from: "review", to: "ready" },
      ),
    ).toEqual([]);
    expect(schemaMigrationTestOnly.parseSchemaAuditValue("")).toBeNull();
  });

  it.each([
    {
      request: {
        kind: "rename-type",
        from: "Legacy",
        to: "WorkItem",
      } satisfies SchemaEvolutionMigrationRequest,
      raw: JSON.stringify({ definitions: [{ name: "Legacy" }] }),
      target: "WorkItem",
      unknown: "Missing",
    },
    {
      request: {
        kind: "rename-field",
        from: "customer",
        to: "account",
      } satisfies SchemaEvolutionMigrationRequest,
      raw: JSON.stringify({ fields: [{ key: "customer" }] }),
      target: "account",
      unknown: "missing",
    },
    {
      request: {
        kind: "remap-status",
        from: "review",
        to: "ready",
      } satisfies SchemaEvolutionMigrationRequest,
      raw: JSON.stringify({ statuses: [{ id: "review" }] }),
      target: "ready",
      unknown: "missing",
    },
  ])(
    "stages, resumes, and retires $request.kind definitions",
    ({ request, raw, target, unknown }) => {
      const staged = schemaMigrationTestOnly.mutateSchemaDefinition(
        raw,
        request,
        "stage",
      );
      expect(staged).toContain(target);
      expect(
        schemaMigrationTestOnly.mutateSchemaDefinition(
          staged,
          request,
          "stage",
        ),
      ).toBe(staged);
      const retired = schemaMigrationTestOnly.mutateSchemaDefinition(
        staged,
        request,
        "retire",
      );
      expect(
        schemaMigrationTestOnly.mutateSchemaDefinition(
          retired,
          request,
          "retire",
        ),
      ).toBe(retired);
      expect(() =>
        schemaMigrationTestOnly.mutateSchemaDefinition(
          raw,
          { ...request, from: unknown } as SchemaEvolutionMigrationRequest,
          "stage",
        ),
      ).toThrow("Unknown custom");
    },
  );

  it("renders dry-run and recovered execution summaries", () => {
    const base = planSchemaEvolutionMigration([], {
      migrationId: "human",
      request: { kind: "rename-type", from: "Legacy", to: "WorkItem" },
    });
    expect(
      formatSchemaEvolutionMigrationHuman({
        ...base,
        action: "rename-type",
        applied: false,
        recovered: false,
        migrated_item_count: 0,
      }),
    ).toContain("[dry-run]");
    expect(
      formatSchemaEvolutionMigrationHuman({
        ...base,
        action: "rename-type",
        applied: true,
        recovered: true,
        migrated_item_count: 0,
      }),
    ).toContain("[applied (recovered)]");
  });
});

describe("schema evolution migration execution", () => {
  it("routes every migration through the generic SDK action surface", async () => {
    await withTempPmPath(async (context) => {
      await expect(
        runAction({
          action: "schema",
          path: context.pmPath,
          subcommand: "rename-type",
          name: "Legacy",
          to: "WorkItem",
          migrationId: "action-type",
          dryRun: true,
        }),
      ).resolves.toMatchObject({
        action: "rename-type",
        applied: false,
      });
      await expect(
        runAction({
          action: "schema",
          path: context.pmPath,
          subcommand: "rename-field",
          name: "customer",
          to: "account",
          migration_id: "action-field",
          fieldTypeScope: "Task",
          dryRun: true,
        }),
      ).resolves.toMatchObject({
        action: "rename-field",
        request: { type: "Task" },
      });
      const client = new PmClient({
        pmRoot: context.pmPath,
        noExtensions: true,
      });
      await expect(
        client.schemaRenameField(
          "customer",
          "account",
          { migrationId: "client-field", dryRun: true },
          "Task",
        ),
      ).resolves.toMatchObject({
        action: "rename-field",
        request: { type: "Task" },
      });
      await expect(
        client.schemaRenameField("customer", "account", {
          migrationId: "client-field-unscoped",
          dryRun: true,
        }),
      ).resolves.toMatchObject({
        action: "rename-field",
        request: { kind: "rename-field" },
      });
      await expect(
        runAction({
          action: "schema",
          path: context.pmPath,
          subcommand: "remap-status",
          name: "review",
          to: "ready",
          migrationId: "action-status",
          dryRun: true,
        }),
      ).resolves.toMatchObject({
        action: "remap-status",
      });
      await expect(
        runAction({
          action: "schema",
          path: context.pmPath,
          options: {
            subcommand: "rename-type",
            name: "Legacy",
            to: "WorkItem",
            migration_id: "nested-action-type",
            dryRun: true,
          },
        }),
      ).resolves.toMatchObject({ action: "rename-type" });
      for (const subcommand of [
        "rename-type",
        "rename-field",
        "remap-status",
      ]) {
        await expect(
          runAction({
            action: "schema",
            path: context.pmPath,
            subcommand,
            to: "target",
            migrationId: `missing-name-${subcommand}`,
            dryRun: true,
          }),
        ).rejects.toThrow("must be non-empty");
      }
    });
  });

  it("resolves migration attribution from environment, settings, and fallback", async () => {
    await withTempPmPath(async (context) => {
      const previousAuthor = process.env.PM_AUTHOR;
      try {
        process.env.PM_AUTHOR = "environment-agent";
        await runSchemaEvolutionMigration(
          { kind: "rename-type", from: "Missing", to: "WorkItem" },
          { migrationId: "author-environment", dryRun: true },
          { path: context.pmPath },
        );

        delete process.env.PM_AUTHOR;
        const settings = await readSettings(context.pmPath);
        await writeSettings(context.pmPath, {
          ...settings,
          author_default: "configured-agent",
        });
        await runSchemaEvolutionMigration(
          { kind: "rename-type", from: "Missing", to: "WorkItem" },
          { migrationId: "author-settings", dryRun: true },
          { path: context.pmPath },
        );

        await writeSettings(context.pmPath, {
          ...(await readSettings(context.pmPath)),
          author_default: "",
        });
        await runSchemaEvolutionMigration(
          { kind: "rename-type", from: "Missing", to: "WorkItem" },
          { migrationId: "author-fallback", dryRun: true },
          { path: context.pmPath },
        );
      } finally {
        if (previousAuthor === undefined) {
          delete process.env.PM_AUTHOR;
        } else {
          process.env.PM_AUTHOR = previousAuthor;
        }
      }
    });
  });

  it("uses the bounded derived index and fails if a persisted-plan item disappears", async () => {
    await withTempPmPath(async (context) => {
      await runSchemaAddType(
        "Legacy",
        { folder: "legacy" },
        { path: context.pmPath },
      );
      const created = await runCreate(
        { title: "indexed", type: "Legacy", createMode: "progressive" },
        { path: context.pmPath },
      );
      const settings = await readSettings(context.pmPath);
      const typeToFolder = resolveItemTypeRegistry(settings).type_to_folder;
      await listAllDocumentCandidatesCached(
        context.pmPath,
        settings.item_format,
        typeToFolder,
        [],
        settings.schema,
        {
          includeBody: false,
          includeCollections: false,
          derivedIndexMinimumItems: 1,
          forceSourceScan: true,
        },
      );
      const indexed = await runSchemaEvolutionMigration(
        { kind: "rename-type", from: "Legacy", to: "WorkItem" },
        {
          migrationId: "derived-index",
          dryRun: true,
          author: "schema-test",
        },
        { path: context.pmPath },
      );
      expect(indexed.selection_source).toBe("derived_index");
      const scopedIndex = await runSchemaEvolutionMigration(
        {
          kind: "rename-field",
          from: "customer",
          to: "account",
          type: "Legacy",
        },
        {
          migrationId: "derived-index-scoped",
          dryRun: true,
          author: "schema-test",
        },
        { path: context.pmPath },
      );
      expect(scopedIndex.selection_source).toBe("derived_index");

      const plan = planSchemaEvolutionMigration([created.item], {
        migrationId: "missing-planned-item",
        request: { kind: "rename-type", from: "Legacy", to: "WorkItem" },
      });
      const planDirectory = path.join(
        context.pmPath,
        "transactions",
        "schema",
      );
      await mkdir(planDirectory, { recursive: true });
      await writeFile(
        path.join(planDirectory, "missing-planned-item-plan.json"),
        `${JSON.stringify({
          schema_version: 1,
          plan,
          created_at: "2026-07-23T00:00:00.000Z",
        })}\n`,
      );
      await rm(
        path.join(context.pmPath, "legacy", `${created.item.id}.toon`),
      );
      await expect(
        runSchemaEvolutionMigration(
          { kind: "rename-type", from: "Legacy", to: "WorkItem" },
          { migrationId: "missing-planned-item", author: "schema-test" },
          { path: context.pmPath },
        ),
      ).rejects.toThrow(`item "${created.item.id}" no longer exists`);
    });
  });

  it("exposes default-client top-level migration wrappers", async () => {
    const result = {
      ...planSchemaEvolutionMigration([], {
        migrationId: "wrapper",
        request: { kind: "rename-type", from: "Legacy", to: "WorkItem" },
      }),
      action: "rename-type" as const,
      applied: false,
      recovered: false,
      migrated_item_count: 0,
    };
    const typeSpy = vi
      .spyOn(PmClient.prototype, "schemaRenameType")
      .mockResolvedValue(result);
    await expect(
      schemaRenameType("Legacy", "WorkItem", { migrationId: "wrapper" }),
    ).resolves.toBe(result);
    typeSpy.mockRestore();

    const fieldSpy = vi
      .spyOn(PmClient.prototype, "schemaRenameField")
      .mockResolvedValue({
        ...result,
        action: "rename-field",
        request: { kind: "rename-field", from: "old", to: "new" },
      });
    await schemaRenameField("old", "new", { migrationId: "wrapper-field" });
    await schemaRenameField(
      "old",
      "new",
      { migrationId: "wrapper-field-scoped" },
      "Task",
    );
    fieldSpy.mockRestore();

    const statusSpy = vi
      .spyOn(PmClient.prototype, "schemaRemapStatus")
      .mockResolvedValue({
        ...result,
        action: "remap-status",
        request: { kind: "remap-status", from: "review", to: "ready" },
      });
    await schemaRemapStatus("review", "ready", {
      migrationId: "wrapper-status",
    });
    statusSpy.mockRestore();
  });

  it("fails closed for uninitialized, missing, colliding, corrupt, and reused migration identities", async () => {
    await withTempPmPath(async (context) => {
      await expect(
        runSchemaEvolutionMigration(
          { kind: "rename-type", from: "Legacy", to: "WorkItem" },
          { migrationId: "uninitialized" },
          { path: path.join(context.pmPath, "not-initialized") },
        ),
      ).rejects.toThrow("Tracker is not initialized");

      await expect(
        runSchemaEvolutionMigration(
          { kind: "rename-type", from: "Missing", to: "WorkItem" },
          { migrationId: "missing-source", author: "schema-test" },
          { path: context.pmPath },
        ),
      ).rejects.toThrow("is not a custom definition");

      await runSchemaAddType("Legacy", {}, { path: context.pmPath });
      await runSchemaAddType("WorkItem", {}, { path: context.pmPath });
      await expect(
        runSchemaEvolutionMigration(
          { kind: "rename-type", from: "Legacy", to: "WorkItem" },
          { migrationId: "target-collision", author: "schema-test" },
          { path: context.pmPath },
        ),
      ).rejects.toThrow("already exists");

      const planDirectory = path.join(
        context.pmPath,
        "transactions",
        "schema",
      );
      await mkdir(planDirectory, { recursive: true });
      await writeFile(
        path.join(planDirectory, "corrupt-plan-plan.json"),
        '{"schema_version":1,"plan":{"migration_id":"wrong","items":[]}}\n',
      );
      await expect(
        runSchemaEvolutionMigration(
          { kind: "rename-type", from: "Legacy", to: "NextType" },
          { migrationId: "corrupt-plan", author: "schema-test" },
          { path: context.pmPath },
        ),
      ).rejects.toThrow('Stored schema migration plan "corrupt-plan" is invalid');
    });

    await withTempPmPath(async (context) => {
      await runSchemaAddType("Legacy", {}, { path: context.pmPath });
      await runSchemaEvolutionMigration(
        { kind: "rename-type", from: "Legacy", to: "WorkItem" },
        { migrationId: "identity-reuse", author: "schema-test" },
        { path: context.pmPath },
      );
      await expect(
        runSchemaEvolutionMigration(
          { kind: "rename-type", from: "WorkItem", to: "NextType" },
          { migrationId: "identity-reuse", author: "schema-test" },
          { path: context.pmPath },
        ),
      ).rejects.toThrow("already belongs to a different request");
    });

    await withTempPmPath(async (context) => {
      await runSchemaAddType("Legacy", {}, { path: context.pmPath });
      await writeFile(path.join(context.pmPath, "templates"), "not-a-directory");
      await expect(
        runSchemaEvolutionMigration(
          { kind: "rename-type", from: "Legacy", to: "WorkItem" },
          { migrationId: "templates-io", author: "schema-test" },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject({ code: "ENOTDIR" });
    });

    await withTempPmPath(async (context) => {
      await rm(path.join(context.pmPath, "schema", "types.json"));
      await expect(
        runSchemaEvolutionMigration(
          { kind: "rename-type", from: "Missing", to: "WorkItem" },
          { migrationId: "missing-schema-file", author: "schema-test" },
          { path: context.pmPath },
        ),
      ).rejects.toThrow("is not a custom definition");
    });
  });

  it("compensates staged references and item changes when a later item lock fails", async () => {
    await withTempPmPath(async (context) => {
      await runSchemaAddType("Legacy", {}, { path: context.pmPath });
      const first = await runCreate(
        { title: "first", type: "Legacy", createMode: "progressive" },
        { path: context.pmPath },
      );
      const second = await runCreate(
        { title: "second", type: "Legacy", createMode: "progressive" },
        { path: context.pmPath },
      );
      const workflowsPath = path.join(
        context.pmPath,
        "schema",
        "workflows.json",
      );
      await writeFile(
        workflowsPath,
        `${JSON.stringify({
          workflow: { open_status: "open" },
          type_workflows: [
            { type: "Legacy", allowed_transitions: [["open", "closed"]] },
          ],
        })}\n`,
      );
      const lockedId = [first.item.id, second.item.id].sort((left, right) =>
        left.localeCompare(right),
      )[1]!;
      const release = await acquireLock(
        context.pmPath,
        lockedId,
        30,
        "competing-agent",
        false,
        true,
        10,
      );
      try {
        await expect(
          runSchemaEvolutionMigration(
            { kind: "rename-type", from: "Legacy", to: "WorkItem" },
            {
              migrationId: "compensate-lock",
              author: "schema-test",
            },
            { path: context.pmPath },
          ),
        ).rejects.toThrow("locked");
      } finally {
        await release();
      }
      for (const id of [first.item.id, second.item.id]) {
        expect(
          context.runCli(["get", id, "--full", "--json"], {
            expectJson: true,
          }).json,
        ).toMatchObject({ item: { type: "Legacy" } });
      }
      expect(await readFile(workflowsPath, "utf8")).toContain('"Legacy"');
      expect(
        await readFile(
          path.join(context.pmPath, "schema", "types.json"),
          "utf8",
        ),
      ).not.toContain("WorkItem");
    });
  });

  it("compensates schema and reference steps with validated snapshots", async () => {
    await withTempPmPath(async (context) => {
      const typesPath = path.join(context.pmPath, "schema", "types.json");
      await runSchemaAddType("Legacy", {}, { path: context.pmPath });
      const beforeTypes = await readFile(typesPath, "utf8");
      const schemaStep = schemaMigrationTestOnly.schemaStep({
        id: "stage-schema",
        filePath: typesPath,
        request: { kind: "rename-type", from: "Legacy", to: "WorkItem" },
        phase: "stage",
      });
      expect((await schemaStep.inspect()).state).toBe("pending");
      const schemaSnapshot = await schemaStep.prepareCompensation!();
      await schemaStep.apply();
      expect(await schemaStep.inspect()).toMatchObject({
        state: "applied",
        result: { phase: "stage" },
      });
      await expect(schemaStep.compensate(null)).rejects.toThrow(
        "Missing schema snapshot",
      );
      await schemaStep.compensate(schemaSnapshot);
      expect(await readFile(typesPath, "utf8")).toBe(beforeTypes);
      const missingSnapshot =
        await schemaMigrationTestOnly.readSchemaFileSnapshot(
          path.join(context.pmPath, "missing-schema.json"),
        );
      expect(missingSnapshot).toEqual({ exists: false, raw: "" });
      await expect(
        schemaMigrationTestOnly.validateAndStoreMigrationPlan({
          pmRoot: context.pmPath,
          schemaPath: path.join(context.pmPath, "missing-schema.json"),
          request: {
            kind: "rename-type",
            from: "Missing",
            to: "WorkItem",
          },
          plan: planSchemaEvolutionMigration([], {
            migrationId: "missing-schema-helper",
            request: {
              kind: "rename-type",
              from: "Missing",
              to: "WorkItem",
            },
          }),
        }),
      ).rejects.toThrow("is not a custom definition");

      const workflowsPath = path.join(
        context.pmPath,
        "schema",
        "workflows.json",
      );
      await writeFile(
        workflowsPath,
        `${JSON.stringify({
          workflow: { open_status: "open" },
          type_workflows: [
            { type: "Legacy", allowed_transitions: [["open", "closed"]] },
          ],
        })}\n`,
      );
      const referenceStep = schemaMigrationTestOnly.schemaReferenceStep({
        filePath: workflowsPath,
        request: { kind: "rename-type", from: "Legacy", to: "WorkItem" },
        stepId: "reference-test",
      });
      expect((await referenceStep.inspect()).state).toBe("pending");
      const referenceSnapshot =
        await referenceStep.prepareCompensation!();
      await referenceStep.apply();
      expect((await referenceStep.inspect()).state).toBe("applied");
      await expect(referenceStep.compensate(false)).rejects.toThrow(
        "Missing schema reference snapshot",
      );
      await referenceStep.compensate(referenceSnapshot);
      expect(await readFile(workflowsPath, "utf8")).toContain("Legacy");

      await schemaStep.compensate({ exists: false, raw: "" });
      await expect(readFile(typesPath, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });

      await writeFile(
        typesPath,
        `${JSON.stringify({ definitions: [{ name: "WorkItem" }] })}\n`,
      );
      const retireStep = schemaMigrationTestOnly.schemaStep({
        id: "retire-source",
        filePath: typesPath,
        request: { kind: "rename-type", from: "Legacy", to: "WorkItem" },
        phase: "retire",
      });
      expect(await retireStep.inspect()).toMatchObject({
        state: "applied",
        result: { phase: "retire" },
      });
    });
  });

  it("rewrites schema and saved-template references with the authoritative definition", async () => {
    await withTempPmPath(async (context) => {
      await runSchemaAddStatus(
        "review",
        { role: ["active"] },
        { path: context.pmPath },
      );
      await runSchemaAddType(
        "Legacy",
        { defaultStatus: "review" },
        { path: context.pmPath },
      );
      await runSchemaAddField(
        "customer",
        { type: "string", requiredTypes: ["Legacy"] },
        { path: context.pmPath },
      );
      await writeFile(
        path.join(context.pmPath, "schema", "workflows.json"),
        `${JSON.stringify(
          {
            workflow: { open_status: "review", close_status: "closed" },
            type_workflows: [
              {
                type: "Legacy",
                allowed_transitions: [["review", "closed"]],
              },
            ],
          },
          null,
          2,
        )}\n`,
      );
      await runTemplatesSave(
        "legacy",
        { type: "Legacy", status: "review", customer: "Ada" },
        { path: context.pmPath },
      );

      await runSchemaEvolutionMigration(
        { kind: "rename-type", from: "Legacy", to: "WorkItem" },
        { migrationId: "references-type", author: "schema-test" },
        { path: context.pmPath },
      );
      expect(
        JSON.parse(
          await readFile(
            path.join(context.pmPath, "schema", "fields.json"),
            "utf8",
          ),
        ),
      ).toMatchObject({
        fields: [{ key: "customer", required_types: ["WorkItem"] }],
      });
      expect(
        JSON.parse(
          await readFile(
            path.join(context.pmPath, "schema", "workflows.json"),
            "utf8",
          ),
        ),
      ).toMatchObject({
        type_workflows: [{ type: "WorkItem" }],
      });
      expect(
        JSON.parse(
          await readFile(
            path.join(context.pmPath, "templates", "legacy.json"),
            "utf8",
          ),
        ),
      ).toMatchObject({ options: { type: "WorkItem" } });

      const humanPreview = context.runCli([
        "schema",
        "rename-field",
        "customer",
        "--to",
        "account",
        "--type",
        "WorkItem",
        "--migration-id",
        "references-field-preview",
        "--dry-run",
      ]);
      expect(humanPreview.code).toBe(0);
      expect(humanPreview.stdout).toContain("rename-field: customer -> account");
      expect(humanPreview.stdout).toContain("[dry-run]");

      await schemaRenameField(
        "customer",
        "account",
        { migrationId: "references-field", author: "schema-test" },
        "WorkItem",
        { pmRoot: context.pmPath, noExtensions: true },
      );
      expect(
        JSON.parse(
          await readFile(
            path.join(context.pmPath, "templates", "legacy.json"),
            "utf8",
          ),
        ),
      ).toMatchObject({ options: { account: "Ada" } });

      const typesPath = path.join(context.pmPath, "schema", "types.json");
      const workflowsPath = path.join(
        context.pmPath,
        "schema",
        "workflows.json",
      );

      await schemaRemapStatus(
        "review",
        "ready",
        { migrationId: "references-status", author: "schema-test" },
        { pmRoot: context.pmPath, noExtensions: true },
      );
      expect(
        JSON.parse(await readFile(typesPath, "utf8")),
      ).toMatchObject({
        definitions: [{ default_status: "ready" }],
      });
      expect(
        JSON.parse(await readFile(workflowsPath, "utf8")),
      ).toMatchObject({
        workflow: { open_status: "ready" },
        type_workflows: [
          { allowed_transitions: [["ready", "closed"]] },
        ],
      });
      expect(
        JSON.parse(
          await readFile(
            path.join(context.pmPath, "templates", "legacy.json"),
            "utf8",
          ),
        ),
      ).toMatchObject({ options: { status: "ready" } });
    });
  });

  it("exposes migration planning and execution through CLI and PmClient", async () => {
    await withTempPmPath(async (context) => {
      await runSchemaAddType("Legacy", {}, { path: context.pmPath });
      const created = await runCreate(
        { title: "legacy", type: "Legacy", createMode: "progressive" },
        { path: context.pmPath },
      );
      const preview = context.runCli(
        [
          "schema",
          "rename-type",
          "Legacy",
          "--to",
          "WorkItem",
          "--migration-id",
          "cli-sdk-surface",
          "--dry-run",
          "--json",
        ],
        { expectJson: true },
      );
      expect(preview.code).toBe(0);
      expect(preview.json).toMatchObject({
        action: "rename-type",
        applied: false,
        affected_item_count: 1,
      });

      const client = new PmClient({
        pmRoot: context.pmPath,
        author: "sdk-migration-test",
        noExtensions: true,
      });
      const applied = await client.schemaRenameType("Legacy", "WorkItem", {
        migrationId: "cli-sdk-surface",
      });
      expect(applied).toMatchObject({
        action: "rename-type",
        applied: true,
        migrated_item_count: 1,
      });
      const shown = context.runCli(
        ["get", created.item.id, "--full", "--json"],
        { expectJson: true },
      );
      expect(shown.json).toMatchObject({ item: { type: "WorkItem" } });
    });
  });

  it.each([
    {
      kind: "rename-type",
      setup: async (pmPath: string) => {
        await runSchemaAddType(
          "Legacy",
          { folder: "legacy" },
          { path: pmPath },
        );
        return await runCreate(
          {
            title: "legacy type",
            type: "Legacy",
            createMode: "progressive",
          },
          { path: pmPath },
        );
      },
      request: {
        kind: "rename-type",
        from: "Legacy",
        to: "WorkItem",
      } satisfies SchemaEvolutionMigrationRequest,
      expected: { type: "WorkItem" },
    },
    {
      kind: "rename-field",
      setup: async (pmPath: string) => {
        await runSchemaAddField(
          "customer",
          { type: "string" },
          { path: pmPath },
        );
        return await runCreate(
          {
            title: "custom field",
            createMode: "progressive",
            customer: "Ada",
          } as never,
          { path: pmPath },
        );
      },
      request: {
        kind: "rename-field",
        from: "customer",
        to: "account",
      } satisfies SchemaEvolutionMigrationRequest,
      expected: { account: "Ada" },
    },
    {
      kind: "remap-status",
      setup: async (pmPath: string) => {
        await runSchemaAddStatus(
          "review",
          { role: ["active"] },
          { path: pmPath },
        );
        return await runCreate(
          {
            title: "custom status",
            status: "review",
            createMode: "progressive",
          },
          { path: pmPath },
        );
      },
      request: {
        kind: "remap-status",
        from: "review",
        to: "ready",
      } satisfies SchemaEvolutionMigrationRequest,
      expected: { status: "ready" },
    },
  ])(
    "applies and idempotently resumes $kind with item and workspace history",
    async ({ kind, setup, request, expected }) => {
      await withTempPmPath(async (context) => {
        const created = await setup(context.pmPath);
        const migrationId = `test-${kind}`;
        const preview = await runSchemaEvolutionMigration(
          request,
          { migrationId, dryRun: true, author: "schema-test" },
          { path: context.pmPath },
        );
        expect(preview).toMatchObject({
          applied: false,
          affected_item_count: 1,
          migrated_item_count: 0,
        });
        const applied = await runSchemaEvolutionMigration(
          request,
          { migrationId, author: "schema-test" },
          { path: context.pmPath },
        );
        expect(applied).toMatchObject({
          applied: true,
          recovered: false,
          migrated_item_count: 1,
        });
        const rerun = await runSchemaEvolutionMigration(
          request,
          { migrationId, author: "schema-test" },
          { path: context.pmPath },
        );
        expect(rerun.recovered).toBe(true);

        const shown = context.runCli(
          ["get", created.item.id, "--full", "--json"],
          { expectJson: true },
        );
        expect(shown.code).toBe(0);
        expect(shown.json).toMatchObject({ item: expected });
        if (kind === "rename-field") {
          expect(
            Object.prototype.hasOwnProperty.call(
              (shown.json as { item: Record<string, unknown> }).item,
              "customer",
            ),
          ).toBe(false);
        }
        const itemHistory = await readFile(
          path.join(context.pmPath, "history", `${created.item.id}.jsonl`),
          "utf8",
        );
        expect(itemHistory).toContain(`schema_${kind.replaceAll("-", "_")}`);
        const workspaceHistoryPath = getWorkspaceHistoryPath(context.pmPath);
        const workspaceHistory = await readFile(
          workspaceHistoryPath,
          "utf8",
        );
        expect(workspaceHistory).toContain(`schema_migration:${migrationId}:`);
        expect(workspaceHistory.trim().split("\n")).toHaveLength(2);
        expect(
          verifyHistoryChain(
            await readHistoryEntries(
              workspaceHistoryPath,
              WORKSPACE_HISTORY_ID,
            ),
          ),
        ).toEqual({ ok: true, errors: [] });
      });
    },
  );
});
