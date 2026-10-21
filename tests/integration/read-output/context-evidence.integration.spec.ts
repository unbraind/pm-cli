import { describe, expect, it } from "vitest";
import { handleRequest } from "../../../src/mcp/server.js";
import { runCreate } from "../../../src/sdk/lifecycle/create.js";
import { runAction } from "../../../src/sdk/runtime.js";
import { renderContextMarkdown, type ContextResult } from "../../../src/sdk/query/context.js";
import { buildRelationshipContext } from "../../../src/sdk/relationship-context.js";
import { RelationshipGraph } from "../../../src/sdk/relationships.js";
import { createQueryFingerprint, encodeQueryCursor } from "../../../src/sdk/pagination.js";
import type { DepsResult } from "../../../src/sdk/dependencies.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";
import { overwriteTaskTestRuns } from "../../helpers/pmWorkspace.js";

describe("bounded context evidence (GH-1534 and GH-1535)", () => {
  it("retains required root endpoints before a lexically earlier descendant and continues in that order", () => {
    const graph = new RelationshipGraph(["root", "a-child", "z-blocker"], [
      { source: "a-child", target: "root", kind: "parent" },
      { source: "root", target: "z-blocker", kind: "blocked_by" },
    ]);
    const details = [{ id: "a-child", title: "padding ".repeat(35) }];
    const bounded = buildRelationshipContext(graph, "root", details, { tokenBudget: 130 });
    expect(bounded.edges).toContainEqual({ source: "root", target: "z-blocker", kind: "blocked_by" });
    expect(bounded.meta.usedTokens).toBeLessThanOrEqual(130);
    const first = buildRelationshipContext(graph, "root", details, { nodeLimit: 1 });
    expect(first.nodes.map(({ id }) => id)).toEqual(["z-blocker"]);
    const second = buildRelationshipContext(graph, "root", details, { nodeLimit: 1, cursor: first.meta.nextCursor });
    expect(second.nodes.map(({ id }) => id)).toEqual(["a-child"]);
    expect(second.meta.nextCursor).toBeUndefined();
    const legacyCursor = encodeQueryCursor(createQueryFingerprint("relationship-context", { rootId: "root", direction: "both", kinds: [], maxDepth: 3 }), "a-child", 0);
    expect(() => buildRelationshipContext(graph, "root", details, { nodeLimit: 1, cursor: legacyCursor })).toThrow("does not match");
  });

  it("skips an oversized edge while retaining later feasible root evidence and omitted counts", () => {
    const oversized = "a".repeat(300);
    const graph = new RelationshipGraph(["root", oversized, "z"], [
      { source: "root", target: oversized, kind: "related" },
      { source: "root", target: "z", kind: "related" },
    ]);
    const packet = buildRelationshipContext(graph, "root", [], { tokenBudget: 175 });
    expect(packet.nodes).toHaveLength(2);
    expect(packet.edges).toEqual([{ source: "root", target: "z", kind: "related" }]);
    expect(packet.meta.omittedEdges).toBe(1);
    expect(packet.meta.usedTokens).toBeLessThanOrEqual(175);
  });

  it("reserves root relationships before spending the kernel budget on distant nodes", () => {
    const graph = new RelationshipGraph(["root", "parent", "blocker", ...Array.from({ length: 10 }, (_, i) => `sibling-${i}`)], [
      { source: "root", target: "parent", kind: "parent" },
      { source: "root", target: "blocker", kind: "blocked_by" },
      ...Array.from({ length: 10 }, (_, i) => ({ source: `sibling-${i}`, target: "parent", kind: "parent" })),
    ]);
    const packet = buildRelationshipContext(graph, "root", graph.nodes().map((id) => ({ id, title: id.repeat(3) })), { tokenBudget: 240 });
    expect(packet.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "root", target: "blocker", kind: "blocked_by" }),
      expect.objectContaining({ source: "root", target: "parent", kind: "parent" }),
    ]));
    expect(packet.meta.usedTokens).toBeLessThanOrEqual(240);
    expect(packet.meta.truncated).toBe(true);
  });

  it("delivers connected root evidence and honest omissions through SDK, CLI and MCP", async () => {
    await withTempPmPath(async ({ pmPath, runCliInProcess }) => {
      await runCreate({ type: "Epic", title: "Delivery", id: "pm-epic", createMode: "progressive" }, { path: pmPath });
      await runCreate({ type: "Feature", title: "Rebuild index", id: "pm-feature", parent: "pm-epic", createMode: "progressive" }, { path: pmPath });
      for (let i = 1; i <= 10; i += 1) {
        await runCreate({ type: "Task", title: `Index checkpoint acceptance scenario ${i}`, id: `pm-task-${i}`, parent: "pm-feature", description: "Check idempotent recovery after restart and retries.", createMode: "progressive", allowDuplicate: true, ...(i === 10 ? { dep: ["id=pm-task-9,kind=blocked_by"] } : {}) }, { path: pmPath });
      }
      const options = { format: "context", tokenBudget: "1200" };
      const cli = await runCliInProcess(["deps", "pm-task-10", "--format", "context", "--token-budget", "1200", "--json", "--output-budget", "unbounded"], { expectJson: true });
      expect(cli.code, cli.stderr).toBe(0);
      const mcp = await handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "pm_deps", arguments: { id: "pm-task-10", path: pmPath, options, json: true, outputBudget: "unbounded" } } }) as { structuredContent: { result: DepsResult } };
      const sdk = await runAction({ action: "deps", id: "pm-task-10", path: pmPath, options, json: true, outputBudget: "unbounded" });
      for (const result of [cli.json, sdk, mcp.structuredContent.result] as Array<DepsResult & { omission_receipt: { has_omissions: boolean } }>) {
        expect(result.context!.edges).toEqual(expect.arrayContaining([
          expect.objectContaining({ source: "pm-task-10", target: "pm-task-9", kind: "blocked_by" }),
          expect.objectContaining({ source: "pm-task-10", target: "pm-feature", kind: "parent" }),
        ]));
        expect(result.context!.meta.usedTokens).toBeLessThanOrEqual(1200);
        expect(result.context!.meta.truncated).toBe(true);
        expect(result.omission_receipt.has_omissions).toBe(true);
      }
    });
  });

  it("counts test health across matching active items independently of focus limits and transport", async () => {
    await withTempPmPath(async (context) => {
      const { pmPath, runCliInProcess } = context;
      for (const [id, status, tags] of [["pm-a", "open", "selected"], ["pm-b", "in_progress", "selected"], ["pm-c", "open", "selected"], ["pm-empty", "open", "selected"], ["pm-draft", "draft", "selected"], ["pm-other", "open", "other"]]) {
        const created = await runCliInProcess(["create", "Task", id!, "--id", id!, "--status", status!, "--tags", tags!, "--create-mode", "progressive", ...(id === "pm-empty" ? [] : ["--test", "command=node --version"]), "--json"], { expectJson: true });
        expect(created.code, created.stderr).toBe(0);
      }
      await overwriteTaskTestRuns(context, "pm-c", [{ run_id: "test-health", kind: "test", status: "failed", started_at: "2026-10-21T00:00:00.000Z", finished_at: "2026-10-21T00:00:01.000Z", recorded_at: "2026-10-21T00:00:02.000Z", passed: 2, failed: 1, skipped: 1 }]);
      for (const limit of ["1", "10"]) {
        const options = { section: ["tests"], limit, tag: "selected", tokenBudget: "8000" };
        const sdk = await runAction({ action: "context", path: pmPath, options, outputBudget: "unbounded" });
        const cli = await runCliInProcess(["context", "--section", "tests", "--limit", limit, "--tag", "selected", "--token-budget", "8000", "--json", "--output-budget", "unbounded"], { expectJson: true });
        expect(cli.code, cli.stderr).toBe(0);
        const mcp = await handleRequest({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "pm_context", arguments: { path: pmPath, options, outputBudget: "unbounded" } } }) as { structuredContent: { result: ContextResult } };
        for (const result of [sdk, cli.json, mcp.structuredContent.result] as ContextResult[]) {
          expect(result.tests).toEqual({ scope: "matching_active_items", total_items: 4, items_with_tests: 3, items_with_recent_runs: 1, recent_runs: { passed: 2, failed: 1, skipped: 1 }, items_failing: ["pm-c"] });
          expect(renderContextMarkdown(result)).toContain("matching_active_items: 4");
        }
      }
      for (const id of ["pm-a", "pm-b"]) {
        await overwriteTaskTestRuns(context, id, [{ run_id: `failure-${id}`, kind: "test", status: "failed", started_at: "2026-10-21T00:00:00.000Z", finished_at: "2026-10-21T00:00:01.000Z", recorded_at: "2026-10-21T00:00:02.000Z", passed: 0, failed: 1, skipped: 0 }]);
      }
      const complete = await runAction({ action: "context", path: pmPath, options: { section: ["tests"], limit: "1", tag: "selected", tokenBudget: "8000" }, outputBudget: "unbounded" }) as ContextResult;
      expect(complete.tests!.items_failing).toEqual(["pm-a", "pm-b", "pm-c"]);
      const sdkMarkdown = renderContextMarkdown(complete);
      expect(sdkMarkdown).toContain("- items_failing: [pm-a]");
      expect(sdkMarkdown).toContain("- items_failing_omitted: 2");
      const markdown = await runCliInProcess(["context", "--section", "tests", "--limit", "1", "--tag", "selected", "--format", "markdown", "--token-budget", "8000"]);
      expect(markdown.code, markdown.stderr).toBe(0);
      expect(markdown.stdout).toContain("- items_failing: [pm-a]");
      expect(markdown.stdout).toContain("- items_failing_omitted: 2");
      expect(markdown.stdout).toContain("- matching_active_items: 4");
      const tiny = renderContextMarkdown({ ...complete, filters: { ...complete.filters, token_budget: 1 } });
      expect(tiny).not.toContain("- items_failing: [");
      expect(tiny).toContain("- items_failing_omitted: 3");
    });
  });
});
