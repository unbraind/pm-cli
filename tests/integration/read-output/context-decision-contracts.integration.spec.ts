import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { handleRequest } from "../../../src/mcp/server.js";
import { runContext, renderContextMarkdown, type ContextResult } from "../../../src/sdk/query/context.js";
import { runCreate } from "../../../src/sdk/lifecycle/create.js";
import { runAction } from "../../../src/sdk/runtime.js";
import { withTempPmPath, type TempPmContext } from "../../helpers/withTempPmPath.js";

/** Exercise the actual MCP envelope rather than duplicating SDK selection in a mock. */
async function mcpContext(pmPath: string, options: Record<string, unknown>): Promise<ContextResult> {
  const response = await handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
    name: "pm_context", arguments: { path: pmPath, options, outputBudget: "unbounded" },
  } }) as { structuredContent?: { result?: ContextResult } };
  expect(response.structuredContent?.result).toBeDefined();
  return response.structuredContent!.result!;
}

/** Keep mutation setup separate from universal read-output controls. */
function cliHarness(runCli: TempPmContext["runCliInProcess"]): TempPmContext["runCliInProcess"] {
  return async (args) => {
    const create = args[0] === "create";
    const read = !["create", "update"].includes(args[0]!);
    const response = await runCli([...args, ...(create ? ["--create-mode", "progressive"] : []), "--json", ...(read ? ["--output-budget", "unbounded"] : [])], { expectJson: true });
    if (create) expect(response.code, response.stderr).toBe(0);
    return response;
  };
}

describe("context decision contracts (GH-1509 through GH-1512)", () => {
  it("walks blocked active work and the next actionable row exactly once", async () => {
    await withTempPmPath(async ({ pmPath, runCliInProcess }) => {
      const run = cliHarness(runCliInProcess);
      expect((await run(["create", "Task", "Active blocked", "--id", "pm-active", "--status", "in_progress", "--priority", "0", "--blocked-reason", "Waiting for input"])).code).toBe(0);
      expect((await run(["create", "Task", "Next actionable", "--id", "pm-next", "--priority", "1"])).code).toBe(0);
      // Lifecycle remains active while this explicit missing prerequisite gates execution.
      expect((await run(["update", "pm-active", "--blocked-by", "pm-missing", "--allow-unresolved-deps"])).code).toBe(0);
      for (const read of [
        async (after?: string) => runContext({ limit: "1", after }, { path: pmPath }),
        async (after?: string) => (await run(["context", "--limit", "1", ...(after ? ["--after", after] : [])])).json as ContextResult,
        async (after?: string) => mcpContext(pmPath, { limit: "1", ...(after ? { after } : {}) }),
      ]) {
        const first = await read();
        expect(first.next_cursor).toBeTruthy();
        const second = await read(first.next_cursor);
        const ids = [first, second].flatMap((page) => [...page.high_level, ...page.low_level, ...page.blocked_fallback].map((row) => row.id));
        expect(ids).toEqual(["pm-active", "pm-next"]);
        expect(first.summary.returned_focus).toEqual({ active_items: 1, in_progress: 1, open: 0, blocked: 1 });
        expect(second.summary.returned_focus).toEqual({ active_items: 1, in_progress: 0, open: 1, blocked: 0 });
        expect(second.next_cursor).toBeUndefined();
      }
    });
  });

  it("resolves persisted legacy blocker aliases without changing source or history", async () => {
    await withTempPmPath(async ({ pmPath, runCliInProcess }) => {
      const run = cliHarness(runCliInProcess);
      expect((await run(["create", "Task", "Prerequisite", "--id", "pm-prereq"])).code).toBe(0);
      expect((await run(["create", "Task", "Waiting", "--id", "pm-wait", "--status", "blocked", "--dep", "id=pm-prereq,kind=blocked_by"])).code).toBe(0);
      const file = path.join(pmPath, "tasks", "pm-wait.toon");
      const historyFile = path.join(pmPath, "history", "pm-wait.jsonl");
      const history = await readFile(historyFile, "utf8");
      const canonical = await readFile(file, "utf8");
      for (const source of [canonical, canonical.replace(",blocked_by,", ",depends_on,")]) {
        await writeFile(file, source);
        const packet = await run(["deps", "pm-wait", "--format", "context"]);
        expect(packet.code, packet.stderr).toBe(0);
        expect(JSON.stringify(packet.json)).toContain('"kind":"blocked_by"');
        const cli = await run(["context", "--depth", "deep"]);
        expect(cli.code, cli.stderr).toBe(0);
        for (const result of [await runContext({ depth: "deep" }, { path: pmPath }), cli.json as ContextResult, await mcpContext(pmPath, { depth: "deep" })]) {
          expect(result.blockers).toContainEqual(expect.objectContaining({ id: "pm-wait", blocked_by: "pm-prereq", blocked_by_title: "Prerequisite", blocked_by_status: "open" }));
        }
        expect(await readFile(file, "utf8")).toBe(source);
        expect(await readFile(historyFile, "utf8")).toBe(history);
      }
    });
  });

  it("rounds count-based completion half up across focus, progress and Markdown hierarchy", async () => {
    await withTempPmPath(async ({ pmPath, runCliInProcess }) => {
      const run = cliHarness(runCliInProcess);
      expect((await run(["create", "Epic", "Parent", "--id", "pm-parent", "--status", "in_progress", "--priority", "0"])).code).toBe(0);
      for (let index = 0; index < 200; index += 1) {
        const closed = index < 29;
        await runCreate({ title: `Child ${index}`, type: "Task", id: `pm-child-${index}`, parent: "pm-parent", priority: "3", allowDuplicate: true, createMode: "progressive", ...(closed ? { status: "closed", closeReason: "completed" } : {}) }, { path: pmPath });
      }
      const cli = await run(["context", "--depth", "deep", "--limit", "1"]);
      expect(cli.code, cli.stderr).toBe(0);
      for (const result of [await runContext({ depth: "deep", limit: "1" }, { path: pmPath }), cli.json as ContextResult, await mcpContext(pmPath, { depth: "deep", limit: "1" })]) {
        expect(result.high_level).toContainEqual(expect.objectContaining({ id: "pm-parent", children_closed: 29, children_total: 200, completion_pct: 15 }));
        expect(result.progress).toContainEqual(expect.objectContaining({ id: "pm-parent", closed: 29, total: 200, completion_pct: 15 }));
        expect(renderContextMarkdown(result)).toContain("15%");
        expect(renderContextMarkdown(result)).not.toContain("14%");
      }
    });
  }, 30_000);

  it("executes scoped relationship cursor recovery for malformed and mismatched cursors", async () => {
    await withTempPmPath(async ({ pmPath, runCliInProcess }) => {
      const run = cliHarness(runCliInProcess);
      expect((await run(["create", "Task", "Root", "--id", "pm-root"])).code).toBe(0);
      for (const id of ["pm-a", "pm-b"]) expect((await run(["create", "Task", id, "--id", id, "--dep", "id=pm-root,kind=related"])).code).toBe(0);
      const base = ["item", "deps", "pm-root", "--format", "context", "--node-limit", "1"];
      const first = await run(base);
      expect(first.code, first.stderr).toBe(0);
      const cursor = (first.json as { context: { meta: { nextCursor: string } } }).context.meta.nextCursor;
      expect(cursor).toBeTruthy();
      for (const invalid of ["bad", cursor]) {
        const options = invalid === "bad" ? [] : ["--direction", "outgoing", "--token-budget", "4096"];
        const refusal = await run([...base, ...options, "--cursor", invalid]);
        expect(refusal.code).toBe(2);
        const error = JSON.parse(refusal.stderr) as { code: string; next_steps: string[]; recovery: { suggested_retry_args: string[] } };
        expect(error.code).toBe("invalid_query_cursor");
        expect(JSON.stringify(error)).not.toContain("--after");
        expect(error.next_steps.join(" ")).toContain("--cursor");
        expect(error.recovery.suggested_retry_args.slice(0, 2)).toEqual(["--pm-path", pmPath]);
        expect(error.recovery.suggested_retry_args).not.toContain("--cursor");
        const recovered = await run(error.recovery.suggested_retry_args);
        expect(recovered.code, recovered.stderr).toBe(0);
        const sdkOptions = { format: "context", nodeLimit: "1", cursor: invalid, ...(invalid === cursor ? { direction: "outgoing", tokenBudget: "4096" } : {}) };
        const expectedError = { code: "invalid_query_cursor", context: { recovery: { suggested_retry_args: expect.arrayContaining(error.recovery.suggested_retry_args) } } };
        await expect(runAction({ action: "deps", id: "pm-root", path: pmPath, options: sdkOptions, outputBudget: "unbounded", json: true })).rejects.toMatchObject(expectedError);
        await expect(handleRequest({ jsonrpc: "2.0", id: 2, method: "tools/call", params: {
          name: "pm_deps", arguments: { id: "pm-root", path: pmPath, options: sdkOptions, outputBudget: "unbounded", json: true },
        } })).rejects.toMatchObject(expectedError);
      }
    });
  });
});
