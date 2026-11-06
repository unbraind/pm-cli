/**
 * GH-1674 (pm-gh1674) and GH-1663 (pm-gh1663): read projections disclose
 * exactly what was requested. Narrower list and search projections share the
 * lean TOON envelope of the default page, and nested get selectors return only
 * the members they name while the receipt names populated siblings they left
 * out. Every case runs the built CLI (and MCP for get) on a real sandbox tracker.
 */
import { describe, expect, it, vi } from "vitest";
import { withTempPmPath, type TempPmContext } from "../../helpers/withTempPmPath.js";

/** Bytes of the envelope lines, excluding the indented `pm-` row lines the projection chose. */
function envelopeBytes(stdout: string): number {
  return stdout
    .split("\n")
    .filter((line) => !/^ {2}pm-/u.test(line))
    .reduce((total, line) => total + Buffer.byteLength(`${line}\n`), 0);
}

/** Run a read command and require success. */
function read(context: TempPmContext, args: string[]): string {
  const result = context.runCli(args);
  expect(result.code, result.stderr).toBe(0);
  return result.stdout;
}

/** Seed a small corpus with more open items than one page holds. */
function seed(context: TempPmContext, count: number): string[] {
  return Array.from({ length: count }, (_, index) => {
    const created = context.runCli(
      ["create", `Envelope probe ${index}`, "--type", "Task", "--priority", String(index % 3), "--json"],
      { expectJson: true },
    );
    expect(created.code, created.stderr).toBe(0);
    return (created.json as { item: { id: string } }).item.id;
  });
}

const LEAN_ENVELOPE_ABSENT = ["truncated:", "projection:", "now:", "omission_receipt:", "unreadable_item_count", 'sort: "default"'];

describe("GH-1674 lean envelopes for every list and search projection", () => {
  it("never makes --fields or --compact list pages carry more envelope than the default brief page", async () => {
    await withTempPmPath(async (context) => {
      seed(context, 5);
      const brief = read(context, ["list", "--status", "open", "--limit", "3"]);
      const fields = read(context, ["list", "--status", "open", "--limit", "3", "--fields", "id,title"]);
      const compact = read(context, ["list", "--status", "open", "--limit", "3", "--compact"]);
      for (const page of [fields, compact]) {
        for (const key of LEAN_ENVELOPE_ABSENT) expect(page).not.toContain(key);
        expect(page).toContain('details: "--full"');
        expect(page).toContain("next_cursor:");
        expect(page).toMatch(/^completeness:\n {2}status: "(complete|unchecked)"$/mu);
      }
      expect(fields).not.toContain('fields: "id,title"');
      expect(fields).not.toContain('limit: "3"');
      expect(envelopeBytes(fields)).toBeLessThanOrEqual(envelopeBytes(brief));
      expect(envelopeBytes(compact)).toBeLessThanOrEqual(envelopeBytes(brief));
      const json = context.runCli(["list", "--status", "open", "--limit", "3", "--fields", "id,title", "--json"], { expectJson: true });
      expect(json.json).toMatchObject({ projection: { mode: "fields", fields: ["id", "title"] }, truncated: true });
      const full = read(context, ["list", "--status", "open", "--limit", "3", "--full"]);
      expect(full).toContain("projection:");
    });
  });

  it("echoes only set search filters for --fields in TOON and JSON and keeps --full verbose", async () => {
    await withTempPmPath(async (context) => {
      seed(context, 4);
      const toon = read(context, ["search", "Envelope probe", "--mode", "keyword", "--limit", "2", "--fields", "id,title"]);
      for (const key of [...LEAN_ENVELOPE_ABSENT, "filters:", "mode_source:", "include_linked", "rerank_model"]) expect(toon).not.toContain(key);
      expect(toon).toContain('details: "--full"');
      const json = context.runCli(["search", "Envelope probe", "--mode", "keyword", "--limit", "2", "--fields", "id,title", "--type", "Task", "--json"], { expectJson: true });
      expect(json.code, json.stderr).toBe(0);
      expect((json.json as { filters: unknown }).filters).toEqual({ type: "Task", limit: "2" });
      const full = context.runCli(["search", "Envelope probe", "--mode", "keyword", "--limit", "2", "--full", "--json"], { expectJson: true });
      expect(Object.keys((full.json as { filters: Record<string, unknown> }).filters)).toEqual(expect.arrayContaining(["include_linked", "rerank_model", "score_threshold"]));
    });
  });
});

describe("GH-1663 nested get selectors return only what they name", () => {
  it("omits unrequested linked groups and names populated siblings in CLI JSON, TOON and MCP", async () => {
    const server = await import("../../../src/mcp/server.js");
    await withTempPmPath(async (context) => {
      const [id] = seed(context, 1);
      for (const args of [["files", id, "--add", "path=src/a.ts"], ["test", id, "--add", "command=node -v"], ["claim", id]]) {
        const linked = context.runCli(args);
        expect(linked.code, linked.stderr).toBe(0);
      }
      const json = context.runCli(["get", id, "--fields", "id,linked.files,claim_state.claimed", "--json"], { expectJson: true });
      expect(json.code, json.stderr).toBe(0);
      const result = json.json as { linked: Record<string, unknown>; claim_state: Record<string, unknown>; omission_receipt: { has_omissions: boolean; omitted_field_groups: Array<{ name: string }> } };
      expect(Object.keys(result.linked)).toEqual(["files"]);
      expect(result.claim_state).toEqual({ claimed: true });
      expect(result.omission_receipt.has_omissions).toBe(true);
      expect(result.omission_receipt.omitted_field_groups.map(({ name }) => name)).toEqual(["linked.tests", "claim_state.assignee", "claim_state.last_claim"]);
      const empty = context.runCli(["get", id, "--fields", "id,linked.docs", "--json"], { expectJson: true });
      expect((empty.json as { linked: unknown }).linked).toEqual({ docs: [] });
      const toon = read(context, ["get", id, "--fields", "id,linked.tests"]);
      expect(toon).toContain("linked.files");
      expect(toon).not.toMatch(/^ {2}files/mu);
      const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      let mcp: { structuredContent: { result: { linked: Record<string, unknown>; omission_receipt?: { omitted_field_groups: Array<{ name: string }> } } } };
      try {
        mcp = (await server.handleRequest({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "pm_get", arguments: { id, path: context.pmPath, fields: "id,linked.tests" } },
        })) as typeof mcp;
      } finally {
        writeSpy.mockRestore();
      }
      expect(Object.keys(mcp.structuredContent.result.linked)).toEqual(["tests"]);
    });
  });
});
