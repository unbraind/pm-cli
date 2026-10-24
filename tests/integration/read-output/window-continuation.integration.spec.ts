import { appendFile, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runActivity, type ActivityCommandOptions } from "../../../src/sdk/query/activity.js";
import { runCalendar, renderCalendarMarkdown } from "../../../src/sdk/query/calendar.js";
import { decodeQueryCursorEnvelope, encodeQueryCursor } from "../../../src/sdk/pagination.js";
import { resolveReadOptionRetryArgs } from "../../../src/sdk/agent/command-recovery.js";
import { withTempPmPath, type TempPmContext } from "../../helpers/withTempPmPath.js";
import { handleRequest } from "../../../src/mcp/server.js";
import { fingerprintWindowRows, paginateWindowQuery } from "../../../src/sdk/query/window-pagination.js";

const FROM = "2026-01-01T00:00:00.000Z";
const TO = "2099-01-01T00:00:00.000Z";

/** Seed independent same-time rows, including repeated events on the same item. */
function createSeed(context: TempPmContext, title: string): string {
  const result = context.runCli(["create", "--title", title, "--type", "Task", "--create-mode", "progressive", "--deadline", "2030-01-02", "--reminder", "at=2030-01-02,text=due", "--json"], { expectJson: true });
  expect(result.code, result.stderr).toBe(0);
  return (result.json as { item: { id: string } }).item.id;
}

/** History fixtures deliberately tie on timestamp, item and operation. */
function event(message: string, ts = FROM): string {
  return `${JSON.stringify({ ts, author: "test-author", op: "comment_add", message, patch: [], before_hash: "before", after_hash: "after" })}\n`;
}

describe("fixed-window producer continuation", () => {
  it("binds canonical row content and ordering without ambiguous row boundaries", () => {
    const first = [{ id: "same", patch: [{ op: "replace", path: "/body", value: { b: 2, a: 1 } }] }, { id: "next" }];
    const reorderedKeys = [{ patch: [{ value: { a: 1, b: 2 }, path: "/body", op: "replace" }], id: "same" }, { id: "next" }];
    const options = { command: "activity", clock: FROM, query: { filter: "same" }, limit: 1 };
    const page = paginateWindowQuery(first, options);
    expect(paginateWindowQuery(reorderedKeys, { ...options, after: page.next_cursor }).rows).toEqual([{ id: "next" }]);
    expect(fingerprintWindowRows([1, 23])).not.toBe(fingerprintWindowRows([12, 3]));
    expect(fingerprintWindowRows([])).not.toBe(fingerprintWindowRows([undefined]));
    expect(() => paginateWindowQuery([...first].reverse(), { ...options, after: page.next_cursor })).toThrow(expect.objectContaining({ code: "invalid_query_cursor" }));
  });

  it("continues over 384 MiB of logical patch content under a 192 MiB old-generation limit", () => {
    const result = spawnSync(process.execPath, [
      "--max-old-space-size=192",
      fileURLToPath(new URL("../../fixtures/window-pagination/heap-process.mjs", import.meta.url)),
      new URL("../../../dist/sdk/query/window-pagination.js", import.meta.url).href,
    ], { encoding: "utf8", timeout: 60_000 });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ first: 0, second: 1, total: 1536, remaining: 1534 });
  }, 60_000);

  it.each([
    { raw: true }, { raw: true, compact: false }, { provenance: true }, {},
  ] satisfies ActivityCommandOptions[])("recovers activity pages under later writes: %j", async (mode) => {
    await withTempPmPath(async (context) => {
      const ids = [createSeed(context, "first"), createSeed(context, "second")];
      for (const id of ids) await writeFile(path.join(context.pmPath, "history", `${id}.jsonl`), event("one") + event("two"));
      const query = { ...mode, from: FROM, op: "comment_add", limit: "1" };
      const global = { path: context.pmPath };
      const first = await runActivity(query, global);
      expect(first.next_cursor).toBeTypeOf("string");
      const key = first.projection.row_key;
      const expected = await runActivity({ ...query, to: first.window.to!, limit: undefined, unbounded: true }, global);
      await appendFile(path.join(context.pmPath, "history", `${ids[0]}.jsonl`), event("later writer", TO));
      const rows = [...first[key]!];
      let page = first;
      for (let remaining = first.total_count - 1; remaining > 0; remaining -= 1) {
        page = await runActivity({ ...query, after: page.next_cursor }, global);
        expect(page.window).toEqual(first.window);
        expect(page).toMatchObject({ count: 1, total_count: first.total_count, omitted_count: remaining - 1, page_start: first.total_count - remaining });
        rows.push(...page[key]!);
      }
      expect(rows).toEqual(expected[key]);
      expect(page.has_more).toBe(false);
      expect(page.next_cursor).toBeUndefined();
      const historyPath = path.join(context.pmPath, "history", `${ids[0]}.jsonl`);
      const original = await readFile(historyPath, "utf8");
      const lines = original.trimEnd().split("\n");
      lines[0] = JSON.stringify({ ...JSON.parse(lines[0]!), patch: [{ op: "replace", path: "/body", value: "hidden patch change" }] });
      await writeFile(historyPath, lines.join("\n") + "\n");
      await expect(runActivity({ ...query, after: first.next_cursor }, global)).rejects.toMatchObject({ code: "invalid_query_cursor" });
      await writeFile(historyPath, original);
      await appendFile(path.join(context.pmPath, "history", `${ids[0]}.jsonl`), event("backdated writer"));
      await expect(runActivity({ ...query, after: first.next_cursor }, global)).rejects.toMatchObject({ code: "invalid_query_cursor" });
      await expect(runActivity({ ...query, op: "update", after: first.next_cursor }, global)).rejects.toMatchObject({ code: "invalid_query_cursor" });
    });
  });

  it("distinguishes calendar matches from page summaries and preserves relative bounds", async () => {
    await withTempPmPath(async (context) => {
      createSeed(context, "calendar first");
      createSeed(context, "calendar second");
      const global = { path: context.pmPath };
      const query = { from: "now", to: "+2000d", limit: "2" };
      const first = await runCalendar(query, global);
      expect(first).toMatchObject({ count: 2, total_count: 4, omitted_count: 2, page_start: 0, has_more: true, summary_scope: "returned_rows", summary: { events: 2 } });
      expect(renderCalendarMarkdown(first)).toContain(`--after ${first.next_cursor}`);
      const last = await runCalendar({ ...query, limit: "3", after: first.next_cursor }, global);
      expect(last).toMatchObject({ now: first.now, range: first.range, count: 2, total_count: 4, omitted_count: 0, page_start: 2, has_more: false });
      expect(last.next_cursor).toBeUndefined();
      const all = await runCalendar({ from: first.range.start!, to: first.range.end! }, global);
      expect([...first.events, ...last.events]).toEqual(all.events);
      expect(last.days.flatMap(({ events }) => events)).toEqual(last.events);
      const empty = await runCalendar({ ...query, include: "events" }, global);
      expect(empty).toMatchObject({ total_count: 0, count: 0, has_more: false });
      expect(renderCalendarMarkdown(empty)).toContain("No calendar events matched the selected filters.");
      const zero = await runCalendar({ ...query, limit: "0" }, global);
      expect(zero).toMatchObject({ total_count: 4, count: 0, omitted_count: 4, has_more: true });
      expect(zero.next_cursor).toBeUndefined();
      expect(renderCalendarMarkdown(zero)).toContain("--limit 1 or greater");
      expect(renderCalendarMarkdown(zero)).not.toContain("No calendar events matched");
      const zeroContinuation = await runCalendar({ ...query, limit: "0", after: first.next_cursor }, global);
      expect(zeroContinuation).toMatchObject({ page_start: 2, count: 0, omitted_count: 2, has_more: true });
      createSeed(context, "calendar inserted");
      await expect(runCalendar({ ...query, after: first.next_cursor }, global)).rejects.toMatchObject({ code: "invalid_query_cursor" });
    });
  });

  it("rejects cross-command, malformed clock and forged position cursors", async () => {
    await withTempPmPath(async (context) => {
      createSeed(context, "cursor controls");
      const global = { path: context.pmPath };
      const query = { from: FROM, to: TO, limit: "1" };
      const first = await runCalendar(query, global);
      const cursor = decodeQueryCursorEnvelope(first.next_cursor!);
      for (const snapshot of [undefined, "activity:2026-01-01T00:00:00.000Z", "calendar:", "calendar:bad", "calendar:2026-99-99T00:00:00.000Z"]) {
        await expect(runCalendar({ ...query, after: encodeQueryCursor(cursor.fingerprint, cursor.after_id, cursor.after_index, snapshot) }, global)).rejects.toMatchObject({ code: "invalid_query_cursor" });
      }
      for (const [id, index] of [["0", undefined], ["wrong", 0], ["2", 2]] as const) {
        await expect(runCalendar({ ...query, after: encodeQueryCursor(cursor.fingerprint, id, index, cursor.snapshot) }, global)).rejects.toMatchObject({ code: "invalid_query_cursor" });
      }
      await expect(runActivity({ after: first.next_cursor }, global)).rejects.toMatchObject({ code: "invalid_query_cursor" });
    });
  });

  it("transports activity cursors through the native CLI and preserves since intent", async () => {
    await withTempPmPath(async (context) => {
      const id = createSeed(context, "CLI pages");
      await writeFile(path.join(context.pmPath, "history", `${id}.jsonl`), event("one") + event("two"));
      const base = ["history", "activity", "--raw", "--from", FROM, "--to", TO, "--id", id, "--limit", "1", "--json", "--output-budget", "unbounded"];
      const first = context.runCli(base, { expectJson: true });
      expect(first.code, first.stderr).toBe(0);
      const cursor = (first.json as { next_cursor: string }).next_cursor;
      const last = context.runCli([...base, "--after", cursor], { expectJson: true });
      expect(last.code, last.stderr).toBe(0);
      expect(last.json).toMatchObject({ compact_activity: [{ msg: "two" }] });
      expect(last.json).not.toHaveProperty("next_cursor");
      const refusal = context.runCli(["activity", "--since", FROM, "--json"], { expectJson: true });
      expect(refusal.code).not.toBe(0);
      expect((refusal.stderr + refusal.stdout)).toContain(`--from ${FROM}`);
      const conflicting = context.runCli(["activity", "--since", FROM, "--from", FROM, "--json"], { expectJson: true });
      expect(conflicting.code).toBe(2);
      expect(conflicting.stderr + conflicting.stdout).toContain("--since");
      expect(conflicting.stderr + conflicting.stdout).not.toContain("Replay with suggested correction:");
    });
    expect(resolveReadOptionRetryArgs("context", ["context", "--since", FROM], "--since")).toBeUndefined();
    expect(resolveReadOptionRetryArgs("activity", ["activity", `--since=${FROM}`, "--raw"], "--since")).toEqual(["activity", "--from", FROM, "--raw"]);
    for (const args of [["activity", "--since"], ["activity", "--since", "--raw"], ["activity", "--since", FROM, "--from", FROM]]) {
      expect(resolveReadOptionRetryArgs("activity", args, "--since")).toBeUndefined();
    }
  });

  it("transports native and package cursors through MCP and the calendar CLI", async () => {
    await withTempPmPath(async (context) => {
      const id = createSeed(context, "transport pages");
      await writeFile(path.join(context.pmPath, "history", `${id}.jsonl`), event("one") + event("two"));
      const install = context.runCli(["package", "install", "calendar", "--project", "--json"], { expectJson: true });
      expect(install.code, install.stderr).toBe(0);
      for (const action of ["activity", "calendar"]) {
        const options = { from: FROM, to: TO, limit: "1", ...(action === "activity" ? { raw: true, id, outputBudget: "unbounded" } : {}) };
        const call = async (after?: unknown) => {
          const response = await handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "pm_run", arguments: { action, path: context.pmPath, options: { ...options, ...(after ? { after } : {}) } } } }) as { isError?: boolean; structuredContent?: { result: Record<string, unknown> } };
          expect(response.isError, JSON.stringify(response)).not.toBe(true);
          return response.structuredContent!.result;
        };
        const first = await call();
        expect(first.next_cursor).toBeTypeOf("string");
        const last = await call(first.next_cursor);
        const rowKey = action === "activity" ? "compact_activity" : "events";
        expect(last[rowKey]).toHaveLength(1);
        expect(last[rowKey]).not.toEqual(first[rowKey]);
        expect(last).not.toHaveProperty("next_cursor");
      }
      const args = ["calendar", "--from", FROM, "--to", TO, "--limit", "1", "--json"];
      const first = context.runCli(args, { expectJson: true });
      expect(first.code, first.stderr).toBe(0);
      const last = context.runCli([...args, "--after", (first.json as { next_cursor: string }).next_cursor], { expectJson: true });
      expect(last.code, last.stderr).toBe(0);
      expect(last.json).not.toHaveProperty("next_cursor");
      expect(last.json).toMatchObject({ events: [{ kind: "reminder" }] });
    });
  });
});
