import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { handleRequest } from "../../../src/mcp/server.js";
import { buildItemCompletionMutations, commitItemMutations, previewItemMutations } from "../../../src/sdk/item-transaction.js";
import { createEmptyExtensionHookRegistry, setActiveExtensionHooks } from "../../../src/core/extensions/index.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

/** Snapshot durable tracker bytes, excluding derived caches and transient locks. */
async function durableSnapshot(root: string): Promise<Record<string, string>> {
  const bytes: Record<string, string> = {};
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      const relative = path.relative(root, file);
      if (["runtime", "locks", "cache", ".cache"].includes(relative.split(path.sep)[0]!)) continue;
      if (entry.isDirectory()) await visit(file);
      else bytes[relative] = await readFile(file, "utf8");
    }
  }
  await visit(root);
  return bytes;
}

describe("semantic transaction previews (GH-1370)", () => {
  it("rejects invalid scalar domains and missing targets with apply's codes and no source writes", async () => {
    await withTempPmPath(async (context) => {
      expect(context.runCli(["create", "task", "Preview target", "--id", "preview", "--json"]).code).toBe(0);
      for (const [index, mutation] of [
        { op: "update", id: "pm-preview", options: { risk: "invalid" } },
        { op: "update", id: "pm-preview", options: { status: "invalid" } },
        { op: "update", id: "pm-missing", options: { title: "Absent" } },
      ].entries()) {
        const before = await durableSnapshot(context.pmPath);
        const base = ["item", "mutate", "--transaction-id", `invalid-${index}`, "--json", "--lean"];
        const preview = context.runCli([...base, "--dry-run"], { input: JSON.stringify([mutation]) });
        expect(await durableSnapshot(context.pmPath)).toEqual(before);
        const applied = context.runCli(base, { input: JSON.stringify([mutation]) });
        expect(preview.code).toBe(applied.code);
        expect(preview.code).not.toBe(0);
        const diagnostic = JSON.parse(preview.stderr);
        expect(diagnostic.code).toBe(JSON.parse(applied.stderr).code);
        expect(diagnostic.transaction_operation).toEqual({ index: 0, op: "update", id: mutation.id });
      }
    });
  });

  it("validates strict completion after earlier staged evidence while preserving claims and history", async () => {
    await withTempPmPath(async (context) => {
      expect(context.runCli(["create", "task", "Completion target", "--id", "complete", "--json"]).code).toBe(0);
      expect(context.runCli(["claim", "pm-complete", "--author", "preview-agent", "--json"]).code).toBe(0);
      const before = await durableSnapshot(context.pmPath);
      const base = ["item", "complete", "pm-complete", "Delivered", "--validate-close", "strict", "--author", "preview-agent", "--json"];
      const invalid = context.runCli([...base, "--transaction-id", "completion", "--dry-run"]);
      expect(invalid.code).toBe(2);
      expect(await durableSnapshot(context.pmPath)).toEqual(before);
      expect(context.runCli([...base, "--transaction-id", "completion"]).code).toBe(2);
      const valid = [...base, "--transaction-id", "completion-valid", "--comment", "text=Staged completion evidence", "--resolution", "Delivered", "--expected-result", "Expected", "--actual-result", "Observed"];
      const beforeValid = await durableSnapshot(context.pmPath);
      const preview = context.runCli([...valid, "--dry-run"], { expectJson: true });
      expect(preview.code).toBe(0);
      expect(preview.json).toMatchObject({ mutation_count: 3, validation: { validated: true, state: "staged_snapshot", unresolved_commit_constraints: ["concurrent_tracker_changes", "extension_mutation_guards_and_hooks"] } });
      expect(await durableSnapshot(context.pmPath)).toEqual(beforeValid);
      expect(context.runCli(valid).code).toBe(0);
      expect(context.runCli(["get", "pm-complete", "--full", "--json"], { expectJson: true }).json).toMatchObject({ item: { status: "closed", resolution: "Delivered", comments: [expect.objectContaining({ text: "Staged completion evidence" })] } });
    });
  });

  it("shares SDK and MCP validation, suppresses source hooks, and still revalidates commit", async () => {
    await withTempPmPath(async (context) => {
      const options = { pmRoot: context.pmPath, transactionId: "sdk-preview", author: "preview-agent", mutations: [
        { op: "create" as const, id: "pm-staged", options: { title: "Staged", type: "Task" } },
        { op: "update" as const, id: "pm-staged", options: { resolution: "Delivered", expectedResult: "Expected", actualResult: "Observed" } },
        ...buildItemCompletionMutations({ id: "pm-staged", reason: "Complete", closeOptions: { validateClose: "strict" } }),
      ] };
      let hooks = 0;
      setActiveExtensionHooks({ ...createEmptyExtensionHookRegistry(), beforeMutation: [{ layer: "project", name: "guard", run: async () => { hooks += 1; return { allow: true }; } }], onWrite: [{ layer: "project", name: "writer", run: async () => { hooks += 1; } }] });
      try {
        const before = await durableSnapshot(context.pmPath);
        expect(await previewItemMutations(options)).toMatchObject({ validated: true });
        expect(hooks).toBe(0);
        expect(await durableSnapshot(context.pmPath)).toEqual(before);
      } finally { setActiveExtensionHooks(null); }
      await commitItemMutations(options);
      expect(await previewItemMutations(options)).toMatchObject({ validated: true });
      await expect(previewItemMutations({ ...options, mutations: options.mutations.slice(0, 1) })).rejects.toThrow("journal does not match the supplied plan");
      await expect(handleRequest({ jsonrpc: "2.0", id: "preview", method: "tools/call", params: { name: "pm_mutate", arguments: { path: context.pmPath, transactionId: "mcp-preview", dryRun: true, mutations: [{ op: "update", id: "pm-staged", options: { risk: "invalid" } }] } } })).rejects.toMatchObject({ exitCode: 2, context: { transaction_operation: { index: 0, op: "update", id: "pm-staged" } } });
      const beforeExplicitCwd = await durableSnapshot(context.pmPath);
      const previewWithCwd = await handleRequest({ jsonrpc: "2.0", id: "cwd-preview", method: "tools/call", params: { name: "pm_mutate", arguments: { cwd: context.tempRoot, path: context.pmPath, transactionId: "mcp-explicit-cwd-preview", dryRun: true, author: "preview-agent", mutations: [{ op: "update", id: "pm-staged", options: { risk: "low" } }] } } });
      expect(previewWithCwd?.structuredContent).toMatchObject({ result: { dry_run: true, validation: { validated: true } } });
      expect(await durableSnapshot(context.pmPath)).toEqual(beforeExplicitCwd);
      await expect(previewItemMutations({ ...options, mutations: [] })).rejects.toThrow("at least one mutation");
      await expect(previewItemMutations({ ...options, transactionId: "../invalid" })).rejects.toThrow();
      await expect(previewItemMutations({ ...options, mutations: [{ op: "invalid", id: "x" } as never] })).rejects.toThrow("op must be");
      await expect(previewItemMutations({ ...options, pmRoot: path.join(context.tempRoot, "missing") })).rejects.toThrow();
      await expect(previewItemMutations({ ...options, transactionId: "native-validation", mutations: [{ op: "create", id: "pm-native", options: { title: "Native validation", type: [] as never } }] })).rejects.toBeInstanceOf(TypeError);
      const next = { ...options, transactionId: "changed-since-preview", mutations: [{ op: "update" as const, id: "pm-staged", options: { risk: "low" } }] };
      expect(await previewItemMutations(next)).toMatchObject({ validated: true });
      expect(context.runCli(["delete", "pm-staged", "--reason", "Concurrent fixture change", "--json"]).code).toBe(0);
      await expect(commitItemMutations(next)).rejects.toMatchObject({ exitCode: 3 });
    });
  });
});
