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

  it("round-trips full item JSON while flags win and compact mutation output is selectable", async () => {
    await withTempPmPath(async (context) => {
      const created = context.runCli(
        ["create", "--stdin-json", "--title", "Flag title", "--json"],
        {
          input: JSON.stringify({
            title: "Document title",
            type: "Feature",
            priority: 1,
            tags: ["json", "agent"],
            comments: [{ text: "Structured comment", author: "io-agent" }],
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
        changed_field_count: 12,
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
        };
      };
      expect(envelope.item.comments).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ text: "Structured comment" }),
        ]),
      );
      expect(envelope.item.files).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "src/structured-proof.ts" }),
        ]),
      );
      envelope.item.description = "Round tripped";
      const updated = context.runCli(
        ["update", id, "--stdin-json", "--no-changed-fields", "--json"],
        {
          input: JSON.stringify(envelope),
          expectJson: true,
        },
      );
      expect(updated.json).toMatchObject({
        item: { id, description: "Round tripped" },
        changed_field_count: 1,
      });

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

  it("omits empty JSON containers and constant error boilerplate in lean mode", async () => {
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
      });
      expect(errorPayload).not.toHaveProperty("required");
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
      expect(
        (committed?.structuredContent as { result: Record<string, unknown> })
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
