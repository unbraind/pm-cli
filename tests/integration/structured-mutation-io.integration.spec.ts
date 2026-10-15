import { describe, expect, it } from "vitest";
import { handleRequest } from "../../src/mcp/server.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

function itemId(payload: unknown): string {
  const result = payload as { id?: string; item?: { id?: string } };
  return result.id ?? result.item?.id ?? "";
}

describe("structured SDK/CLI/MCP mutation IO", () => {
  it("applies, previews, and resumes atomic CLI batches", async () => {
    await withTempPmPath(async (context) => {
      const mutations = [
        {
          op: "create",
          id: "pm-batch-a",
          options: { title: "Batch A", type: "Task" },
        },
        {
          op: "create",
          id: "pm-batch-b",
          options: { title: "Batch B", type: "Feature" },
        },
      ];
      const dryRun = context.runCli(
        [
          "item",
          "mutate",
          "--transaction-id",
          "cli-batch",
          "--dry-run",
          "--json",
          "--lean",
        ],
        { input: JSON.stringify(mutations), expectJson: true },
      );
      expect(dryRun.json).toMatchObject({ dry_run: true, mutation_count: 2 });
      expect(context.runCli(["get", "pm-batch-a", "--json"]).code).toBe(3);

      const committed = context.runCli(
        ["item", "mutate", "--transaction-id", "cli-batch", "--json"],
        { input: JSON.stringify(mutations), expectJson: true },
      );
      expect(committed.json).toMatchObject({
        status: "committed",
        recovered: false,
        mutation_count: 2,
      });
      const replay = context.runCli(
        ["item", "mutate", "--transaction-id", "cli-batch", "--json"],
        { input: JSON.stringify(mutations), expectJson: true },
      );
      expect(replay.json).toMatchObject({
        status: "committed",
        recovered: true,
        mutation_count: 2,
      });
    });
  });

  it("preserves decoded atomic dash values as literal CLI document data", async () => {
    await withTempPmPath(async (context) => {
      const mutations = [
        {
          op: "create",
          id: "pm-atomic-literal-a",
          options: {
            title: "Atomic literal A",
            type: "Task",
            description: "-",
          },
        },
        {
          op: "create",
          id: "pm-atomic-literal-b",
          options: {
            title: "Atomic literal B",
            type: "Task",
            body: "-",
          },
        },
      ];
      const committed = context.runCli(
        [
          "item",
          "mutate",
          "--transaction-id",
          "cli-atomic-literal-dashes",
          "--json",
        ],
        { input: JSON.stringify(mutations), expectJson: true },
      );
      expect(committed.code).toBe(0);
      expect(committed.json).toMatchObject({
        status: "committed",
        mutation_count: 2,
      });
      const first = context.runCli(
        ["get", "pm-atomic-literal-a", "--json", "--full"],
        { expectJson: true },
      );
      const second = context.runCli(
        ["get", "pm-atomic-literal-b", "--json", "--full"],
        { expectJson: true },
      );
      expect(
        (first.json as { item: { description?: string } }).item.description,
      ).toBe("-");
      expect((second.json as { item: { body?: string } }).item.body).toBe("-");
    });
  });

  it("creates a heterogeneous forward-referenced specification and completes work in one call", async () => {
    await withTempPmPath(async (context) => {
      const specification = {
        schema_version: 1,
        mutations: [
          {
            op: "create",
            ref: "initiative",
            options: { title: "Initiative", type: "Epic" },
          },
          {
            op: "create",
            ref: "delivery",
            options: {
              title: "Delivery",
              type: "Feature",
              parent: "@initiative",
              dep: ["id=@initiative,kind=implements"],
            },
          },
          {
            op: "create",
            ref: "decision",
            options: {
              title: "Decision",
              type: "Decision",
              parent: "@initiative",
            },
          },
        ],
      };
      const preview = context.runCli(
        [
          "item",
          "mutate",
          "--transaction-id",
          "specification-forward-refs",
          "--dry-run",
          "--json",
        ],
        { input: JSON.stringify(specification), expectJson: true },
      );
      expect(preview.json).toMatchObject({
        dry_run: true,
        mutation_count: 3,
        references: {
          initiative: expect.stringMatching(/^pm-/u),
          delivery: expect.stringMatching(/^pm-/u),
          decision: expect.stringMatching(/^pm-/u),
        },
      });
      const references = (
        preview.json as {
          references: Record<string, string>;
        }
      ).references;
      expect(
        context.runCli(["get", references.initiative, "--json"]).code,
      ).toBe(3);

      const committed = context.runCli(
        [
          "item",
          "mutate",
          "--transaction-id",
          "specification-forward-refs",
          "--json",
        ],
        { input: JSON.stringify(specification), expectJson: true },
      );
      expect(committed.json).toMatchObject({ references });
      expect(
        context.runCli(["get", references.delivery, "--full", "--json"], {
          expectJson: true,
        }).json,
      ).toMatchObject({
        item: {
          parent: references.initiative,
          dependencies: expect.arrayContaining([
            expect.objectContaining({
              id: references.initiative,
              kind: "implements",
            }),
          ]),
        },
      });

      expect(
        context.runCli([
          "claim",
          references.delivery,
          "--author",
          "completion-agent",
          "--json",
        ]).code,
      ).toBe(0);
      const completed = context.runCli(
        [
          "item",
          "complete",
          references.delivery,
          "Delivered with evidence",
          "--transaction-id",
          "complete-delivery",
          "--comment",
          "text=Isolated acceptance passed",
          "--test",
          "command=pnpm test",
          "--resolution",
          "Delivered atomically",
          "--expected-result",
          "One governed completion",
          "--actual-result",
          "One governed completion",
          "--author",
          "completion-agent",
          "--json",
        ],
        { expectJson: true },
      );
      expect(completed.json).toMatchObject({
        status: "committed",
        mutation_count: 3,
      });
      expect(
        context.runCli(["get", references.delivery, "--full", "--json"], {
          expectJson: true,
        }).json,
      ).toMatchObject({
        item: {
          status: "closed",
          close_reason: "Delivered with evidence",
          resolution: "Delivered atomically",
          comments: expect.arrayContaining([
            expect.objectContaining({ text: "Isolated acceptance passed" }),
          ]),
          tests: expect.arrayContaining([
            expect.objectContaining({ command: "pnpm test" }),
          ]),
        },
        claim_state: { claimed: false },
      });
    });
  });

  it("round-trips full item JSON while flags win and compact mutation output is selectable", async () => {
    await withTempPmPath(async (context) => {
      const created = context.runCli(
        ["create", "--stdin-json", "--title", "Flag title", "--json"],
        {
          input: JSON.stringify({
            title: "Document title",
            type: "Feature",
            description: "-",
            body: "-",
            priority: 1,
            tags: ["json", "agent"],
            comments: [{ text: "-" }],
            files: [
              {
                path: "src/structured-proof.ts",
                scope: "project",
                note: "Structured file facet",
              },
            ],
          }),
          expectJson: true,
          preserveDefaultMutationOutput: true,
        },
      );
      expect(created.code).toBe(0);
      expect(created.json).toMatchObject({
        id: expect.stringMatching(/^pm-/u),
        status: "open",
        changed_field_count: 13,
      });
      expect(created.json).not.toHaveProperty("item");
      expect(created.json).not.toHaveProperty("changed_fields");
      const id = itemId(created.json);

      const get = context.runCli(["get", id, "--full", "--json"], {
        expectJson: true,
      });
      const envelope = get.json as {
        item: Record<string, unknown> & {
          comments: Array<{ text: string }>;
          files: Array<{ path: string }>;
          notes?: Array<{ text: string }>;
        };
      };
      expect(envelope.item.comments).toEqual(
        expect.arrayContaining([expect.objectContaining({ text: "-" })]),
      );
      expect(envelope.item.files).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "src/structured-proof.ts" }),
        ]),
      );
      expect(envelope.item.description).toBe("-");
      expect(envelope.item.body).toBe("-");
      envelope.item.description = "Round tripped";
      envelope.item.notes = [{ text: "-" }];
      const updated = context.runCli(
        ["update", id, "--stdin-json", "--no-changed-fields", "--json"],
        {
          input: JSON.stringify(envelope),
          expectJson: true,
        },
      );
      expect(updated.json).toMatchObject({
        item: { id, description: "Round tripped" },
        changed_field_count: 2,
      });
      const roundTripped = context.runCli(["get", id, "--full", "--json"], {
        expectJson: true,
      });
      expect(roundTripped.json).toMatchObject({
        item: {
          body: "-",
          notes: expect.arrayContaining([
            expect.objectContaining({ text: "-" }),
          ]),
        },
      });
      const editedDocument = structuredClone(roundTripped.json) as {
        item: { notes: Array<{ text: string }> };
      };
      editedDocument.item.notes[0]!.text = "Corrected evidence";
      const rejected = context.runCli(
        ["update", id, "--stdin-json", "--json"],
        { input: JSON.stringify(editedDocument), expectJson: true },
      );
      expect(rejected.code).toBe(2);
      expect(JSON.parse(rejected.stderr)).toMatchObject({
        code: "stdin_json_persisted_annotation_changed",
        required: expect.stringContaining("pm notes"),
      });
      expect(context.runCli(["get", id, "--full", "--json"], {
        expectJson: true,
      }).json).toMatchObject({ item: { notes: [expect.objectContaining({ text: "-" })] } });
      expect(context.runCli(["history", id, "--verify", "--json"], {
        expectJson: true,
      }).code).toBe(0);

      const full = context.runCli(
        [
          "update",
          id,
          "--description",
          "Full delta",
          "--full-changed-fields",
          "--json",
        ],
        { expectJson: true },
      );
      expect(full.json).toMatchObject({ changed_fields: ["description"] });
    });
  });

  it("omits explanatory boilerplate but retains corrective actions in lean mode", async () => {
    await withTempPmPath(async (context) => {
      const normal = context.runCli(["list", "--status", "all", "--json"], {
        expectJson: true,
      });
      const lean = context.runCli(
        ["list", "--status", "all", "--json", "--lean"],
        { expectJson: true },
      );
      expect(lean.stdout.length).toBeLessThan(normal.stdout.length);
      expect(lean.json).not.toHaveProperty("filters.type");

      const error = context.runCli(
        ["update", "pm-missing", "--bogus", "value", "--json", "--lean"],
        { expectJson: true },
      );
      expect(error.code).toBe(2);
      const errorPayload = JSON.parse(error.stderr) as Record<string, unknown>;
      expect(errorPayload).toMatchObject({
        code: "unknown_option",
        exit_code: 2,
        required: expect.any(String),
      });
      expect(errorPayload).not.toHaveProperty("why");
      expect(errorPayload).not.toHaveProperty("title");

      const detailedError = context.runCli(
        ["update", "pm-missing", "--title", "Missing", "--json"],
        { preserveDefaultMutationOutput: true },
      );
      expect(detailedError.code).toBe(3);
      expect(JSON.parse(detailedError.stderr)).toMatchObject({
        code: "item_not_found",
        title: expect.any(String),
      });

      const leanKnownError = context.runCli(
        ["--lean", "update", "pm-missing", "--title", "Missing", "--json"],
        { preserveDefaultMutationOutput: true },
      );
      expect(leanKnownError.code).toBe(3);
      expect(JSON.parse(leanKnownError.stderr)).toMatchObject({
        code: "item_not_found",
        exit_code: 3,
        required: expect.any(String),
      });
      expect(JSON.parse(leanKnownError.stderr)).not.toHaveProperty("title");
    });
  });

  it("exposes MCP parity for dry-run and committed batches", async () => {
    await withTempPmPath(async (context) => {
      const mutations = [
        {
          op: "create",
          id: "pm-mcp-batch",
          options: { title: "MCP batch", type: "Task" },
        },
      ];
      const dryRun = await handleRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "pm_mutate",
          arguments: {
            path: context.pmPath,
            author: "mcp-agent",
            transactionId: "mcp-batch",
            dryRun: true,
            mutations,
          },
        },
      });
      expect(dryRun?.structuredContent).toMatchObject({
        result: { dry_run: true, mutation_count: 1 },
      });

      const committed = await handleRequest({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "pm_mutate",
          arguments: {
            path: context.pmPath,
            author: "mcp-agent",
            transactionId: "mcp-batch",
            createCompensation: "delete",
            lockTtlSeconds: 45,
            lockWaitMs: 900,
            mutations,
          },
        },
      });
      expect(committed?.structuredContent).toMatchObject({
        result: {
          status: "committed",
          transaction_id: "mcp-batch",
          mutation_count: 1,
        },
      });

      const referenced = await handleRequest({
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: {
          name: "pm_mutate",
          arguments: {
            path: context.pmPath,
            transactionId: "mcp-referenced-batch",
            mutations: [
              {
                op: "create",
                ref: "parent",
                options: { title: "MCP referenced parent", type: "Epic" },
              },
              {
                op: "create",
                ref: "child",
                options: {
                  title: "MCP referenced child",
                  type: "Task",
                  parent: "@parent",
                },
              },
            ],
          },
        },
      });
      expect(referenced?.structuredContent).toMatchObject({
        result: {
          status: "committed",
          references: {
            parent: expect.stringMatching(/^pm-/u),
            child: expect.stringMatching(/^pm-/u),
          },
        },
      });
      if (committed === undefined) {
        throw new Error("Committed MCP mutation response is required");
      }
      expect(
        (committed.structuredContent as { result: Record<string, unknown> })
          .result,
      ).not.toHaveProperty("transactionId");

      const cwdCommitted = await handleRequest({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "pm_mutate",
          arguments: {
            cwd: context.tempRoot,
            transactionId: "mcp-cwd-batch",
            mutations: [
              {
                op: "create",
                id: "pm-mcp-cwd",
                options: { title: "MCP cwd batch", type: "Task" },
              },
            ],
          },
        },
      });
      expect(cwdCommitted?.structuredContent).toMatchObject({
        result: { status: "committed", mutation_count: 1 },
      });

      await expect(
        handleRequest({
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: {
            name: "pm_mutate",
            arguments: {
              path: context.pmPath,
              transactionId: "mcp-invalid-lock",
              lockTtlSeconds: "not-a-number",
              mutations,
            },
          },
        }),
      ).rejects.toThrow("lockTtlSeconds must be a positive safe integer");
      await expect(
        handleRequest({
          jsonrpc: "2.0",
          id: 5,
          method: "tools/call",
          params: {
            name: "pm_mutate",
            arguments: {
              path: context.pmPath,
              transactionId: "mcp-invalid-wait",
              lockWaitMs: false,
              mutations,
            },
          },
        }),
      ).rejects.toThrow("lockWaitMs must be a positive safe integer");
    });
  });
});

describe("bulk creation through item mutate (pm-gh1456)", () => {
  it("imports JSON Lines from a file, replays idempotently, and upserts by a declared field", async () => {
    await withTempPmPath(async (context) => {
      const { writeFile } = await import("node:fs/promises");
      const path = await import("node:path");
      expect(context.runCli(["schema", "add-field", "external_id", "--type", "string", "--json"]).code).toBe(0);
      const file = path.join(context.tempRoot, "items.jsonl");
      await writeFile(
        file,
        [
          '{"title":"Imported A","type":"Task","external_id":"ext-1","tags":["import"]}',
          '{"ref":"b","title":"Imported B","type":"Feature","external_id":"ext-2","parent":"@row-1"}',
          "",
        ].join("\n"),
        "utf8",
      );
      const dryRun = context.runCli(["item", "mutate", "--from", file, "--dry-run", "--json"], { expectJson: true });
      expect(dryRun.code).toBe(0);
      expect(dryRun.json).toMatchObject({
        dry_run: true,
        transaction_id_source: "derived",
        mutation_count: 2,
        validation: { validated: true },
        rows: [
          { index: 0, ref: "row-1", op: "create" },
          { index: 1, ref: "b", op: "create" },
        ],
      });
      const committed = context.runCli(["item", "mutate", "--from", file, "--json"], { expectJson: true });
      expect(committed.code).toBe(0);
      const committedJson = committed.json as { transaction_id: string; rows: Array<{ id: string; ref?: string }> };
      expect(committed.json).toMatchObject({ status: "committed", recovered: false, transaction_id_source: "derived" });
      expect(committedJson.transaction_id).toBe((dryRun.json as { transaction_id: string }).transaction_id);
      const [first, second] = committedJson.rows;
      const secondItem = context.runCli(["get", second!.id, "--json"], { expectJson: true }).json as { item: { parent?: string; external_id?: string } };
      expect(secondItem.item).toMatchObject({ parent: first!.id, external_id: "ext-2" });

      const replay = context.runCli(["item", "mutate", "--from", file, "--json"], { expectJson: true });
      expect(replay.json).toMatchObject({ status: "committed", recovered: true });
      expect(context.runCli(["list", "--json"], { expectJson: true }).json).toMatchObject({ count: 2 });

      const upsert = context.runCli(["item", "mutate", "--upsert-key", "external_id", "--json"], {
        expectJson: true,
        input: '{"title":"Imported A (renamed)","type":"Task","external_id":"ext-1"}\n{"title":"Imported C","type":"Task","external_id":"ext-3"}',
      });
      expect(upsert.code).toBe(0);
      expect(upsert.json).toMatchObject({
        status: "committed",
        upsert_key: "external_id",
        rows: [
          { index: 0, id: first!.id, op: "update", upserted: true },
          { index: 1, ref: "row-2", op: "create" },
        ],
      });
      const upsertReplay = context.runCli(["item", "mutate", "--upsert-key", "external_id", "--json"], {
        expectJson: true,
        input: '{"title":"Imported A (renamed)","type":"Task","external_id":"ext-1"}\n{"title":"Imported C","type":"Task","external_id":"ext-3"}',
      });
      expect(upsertReplay.json).toMatchObject({ status: "committed", recovered: true });
      const renamed = context.runCli(["get", first!.id, "--json"], { expectJson: true }).json as { item: { title: string } };
      expect(renamed.item.title).toBe("Imported A (renamed)");
      expect(context.runCli(["list", "--json"], { expectJson: true }).json).toMatchObject({ count: 3 });

      const missingKey = context.runCli(["item", "mutate", "--upsert-key", "external_id", "--json"], {
        input: '{"title":"No key","type":"Task"}',
      });
      expect(missingKey.code).toBe(2);
      expect(missingKey.stderr).toContain("upsert_key_missing");
      const unreadable = context.runCli(["item", "mutate", "--from", path.join(context.tempRoot, "missing.jsonl"), "--json"]);
      expect(unreadable.code).toBe(2);
      expect(unreadable.stderr).toContain("mutation_document_unreadable");
    });
  });

  it("re-checks keyed upsert under the writer lock so a concurrent writer cannot create a duplicate after planning", async () => {
    await withTempPmPath(async (context) => {
      const { planItemMutationDocument } = await import("../../src/sdk/lifecycle/structured-mutation-plan.js");
      const { commitItemMutations, previewItemMutations } = await import("../../src/sdk/item-transaction.js");
      const { WorkspaceTransactionInterruptedError } = await import("../../src/sdk/index.js");
      expect(context.runCli(["schema", "add-field", "external_id", "--type", "string", "--json"]).code).toBe(0);
      const input = '{"title":"Planned","type":"Task","external_id":"ext-race"}';
      const plan = await planItemMutationDocument({ pmRoot: context.pmPath, input, upsertKey: "external_id" });
      expect(plan.mutations[0]).toMatchObject({ op: "create", unique: { key: "external_id", value: "ext-race" } });
      // Another writer lands the same key between planning and commit.
      const rival = context.runCli(["item", "mutate", "--json"], {
        expectJson: true,
        input: '{"title":"Rival","type":"Task","external_id":"ext-race"}',
      });
      expect(rival.code).toBe(0);
      const rivalId = (rival.json as { rows: Array<{ id: string }> }).rows[0]!.id;
      const commit = { pmRoot: context.pmPath, transactionId: plan.transaction_id, author: "import-agent", mutations: plan.mutations };
      await expect(previewItemMutations(commit)).rejects.toMatchObject({
        context: { code: "upsert_key_conflict", transaction_operation: { index: 0, op: "create" } },
      });
      await expect(commitItemMutations(commit)).rejects.toMatchObject({ context: { code: "upsert_key_conflict" } });
      expect(context.runCli(["list", "--json"], { expectJson: true }).json).toMatchObject({ count: 1 });
      // Re-planning resolves the row as an update of the rival item.
      const replanned = await planItemMutationDocument({ pmRoot: context.pmPath, input, upsertKey: "external_id" });
      expect(replanned.rows).toEqual([{ index: 0, ref: "row-1", id: rivalId, op: "update", upserted: true }]);
      // A plan resumes and replays as itself: the items it already created are not collisions for its
      // own guards when a resumed step scans again, and a second row reuses the first row's lock-held scan.
      const fresh = await planItemMutationDocument({
        pmRoot: context.pmPath,
        input: '{"title":"Fresh","type":"Task","external_id":"ext-fresh"}\n{"title":"Fresh too","type":"Task","external_id":"ext-fresh-2"}',
        upsertKey: "external_id",
      });
      const freshCommit = { pmRoot: context.pmPath, transactionId: fresh.transaction_id, author: "import-agent", mutations: fresh.mutations };
      await expect(
        commitItemMutations({
          ...freshCommit,
          onTransition(transition) {
            if (transition.transition === "step_recorded") throw new WorkspaceTransactionInterruptedError("crash after the first create");
          },
        }),
      ).rejects.toBeInstanceOf(WorkspaceTransactionInterruptedError);
      expect((await commitItemMutations(freshCommit)).recovered).toBe(true);
      expect((await commitItemMutations(freshCommit)).recovered).toBe(true);
      expect(context.runCli(["list", "--json"], { expectJson: true }).json).toMatchObject({ count: 3 });
    });
  });

  it("routes pm create many to the bulk surface instead of creating an item titled many", async () => {
    await withTempPmPath(async (context) => {
      const refused = context.runCli(["create", "many", "--json"]);
      expect(refused.code).toBe(2);
      expect(refused.stderr).toContain("bulk_create_route");
      expect(refused.stderr).toContain("pm item mutate --from");
      expect(context.runCli(["list", "--json"], { expectJson: true }).json).toMatchObject({ count: 0 });
      const explicit = context.runCli(["create", "--title", "many", "--type", "Task", "--json"], { expectJson: true });
      expect(explicit.code).toBe(0);
    });
  });

  it("accepts MCP document rows with forward references and keyed upsert without a transaction id", async () => {
    await withTempPmPath(async (context) => {
      expect(context.runCli(["schema", "add-field", "external_id", "--type", "string", "--json"]).code).toBe(0);
      const created = await handleRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "pm_mutate",
          arguments: {
            path: context.pmPath,
            mutations: [
              { ref: "m1", item: { title: "MCP doc", type: "Task", external_id: "mcp-1" } },
              { op: "update", id: "@m1", options: { addTags: ["mcp"] } },
            ],
          },
        },
      });
      const createdResult = (created?.structuredContent as { result: { status: string; transaction_id: string; transaction_id_source: string; rows: Array<{ id: string; op: string }> } }).result;
      expect(createdResult).toMatchObject({ status: "committed", transaction_id_source: "derived", rows: [{ op: "create" }, { op: "update" }] });
      expect(createdResult.transaction_id).toMatch(/^mutate-[0-9a-f]{24}$/u);

      const upserted = await handleRequest({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "pm_mutate",
          arguments: {
            path: context.pmPath,
            upsertKey: "external_id",
            dryRun: true,
            mutations: [{ item: { title: "MCP doc renamed", type: "Task", external_id: "mcp-1" } }],
          },
        },
      });
      expect(upserted?.structuredContent).toMatchObject({
        result: {
          dry_run: true,
          upsert_key: "external_id",
          rows: [{ index: 0, id: createdResult.rows[0]!.id, op: "update", upserted: true }],
        },
      });
    });
  });
});
