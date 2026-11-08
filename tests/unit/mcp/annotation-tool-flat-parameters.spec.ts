import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PM_TOOL_ACTION_PARAMETER_CONTRACTS } from "../../../src/sdk/cli-contracts/tool-schema.js";
import { optionsWithAuthor } from "../../../src/sdk/runtime-input.js";
import { createTestItemId } from "../../helpers/itemFactory.js";
import { withTempPmPath, type TempPmContext } from "../../helpers/withTempPmPath.js";

/**
 * pm-wsqxwb: the annotation and linked-artifact tools declare add, text and
 * their other parameters flat, so every declared flat argument must reach the
 * command; a top-level add used to fall through to a listing read.
 */

const ANNOTATION_ACTIONS = ["comments", "notes", "learnings", "files", "docs", "test"] as const;
const OPERANDS = new Set(["id", "text"]);

const originalProfile = process.env.PM_MCP_PROFILE;
beforeEach(() => {
  process.env.PM_MCP_PROFILE = "full";
});
afterEach(() => {
  if (originalProfile === undefined) delete process.env.PM_MCP_PROFILE;
  else process.env.PM_MCP_PROFILE = originalProfile;
});

async function callTool(context: TempPmContext, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const server = await import("../../../src/mcp/server.js");
  const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    await server.processRpcLine(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { path: context.pmPath, ...args } } }),
    );
    const response = JSON.parse(writeSpy.mock.calls.map(([chunk]) => String(chunk)).join("")) as {
      result: { structuredContent: Record<string, unknown> };
    };
    return response.result.structuredContent;
  } finally {
    writeSpy.mockRestore();
  }
}

describe("MCP annotation tools read every declared flat parameter (pm-wsqxwb)", () => {
  it.each(ANNOTATION_ACTIONS)("hoists every optional %s contract parameter from flat arguments", (action) => {
    const declared = PM_TOOL_ACTION_PARAMETER_CONTRACTS[action].optional ?? [];
    expect(declared).toContain("add");
    const unread = declared.filter((key) => !OPERANDS.has(key) && !(key in optionsWithAuthor({ [key]: "flat" }, action)));
    expect(unread).toEqual([]);
  });

  it("binds annotation text to add, lets nested values win, and refuses disagreeing sources", () => {
    expect(optionsWithAuthor({ text: "flat text" }, "comments")).toMatchObject({ add: "flat text" });
    expect(optionsWithAuthor({ text: "flat text" }, "comments")).not.toHaveProperty("text");
    expect(optionsWithAuthor({ options: { text: "nested text" } }, "notes")).toMatchObject({ add: "nested text" });
    expect(optionsWithAuthor({ text: "flat", options: { text: "nested" } }, "learnings")).toMatchObject({ add: "nested" });
    expect(optionsWithAuthor({ add: "same", text: "same" }, "comments")).toMatchObject({ add: "same" });
    expect(optionsWithAuthor({ add: "nested wins", options: { add: "nested" } }, "comments")).toMatchObject({ add: "nested" });
    expect(() => optionsWithAuthor({ add: "one", text: "two" }, "notes")).toThrow(
      expect.objectContaining({
        message: "Specify note text either as text or with add, not both.",
        context: expect.objectContaining({ code: "annotation_text_source_conflict", field: "text" }),
      }),
    );
    // Text stays an operand everywhere else; close reads it as the reason.
    expect(optionsWithAuthor({ text: "reason" }, "close")).not.toHaveProperty("add");
    expect(optionsWithAuthor({ text: "unrelated" }, "files")).not.toHaveProperty("add");
  });

  it("writes through the tools/call path for every annotation action given top-level add or text", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "Flat annotation writes" });
      const cases: Array<[string, Record<string, unknown>, string, string, string]> = [
        ["pm_comments", { add: "flat comment" }, "comments", "text", "flat comment"],
        ["pm_comments", { text: "flat text comment" }, "comments", "text", "flat text comment"],
        ["pm_notes", { add: "flat note" }, "notes", "text", "flat note"],
        ["pm_notes", { text: "flat text note" }, "notes", "text", "flat text note"],
        ["pm_learnings", { add: "flat learning" }, "learnings", "text", "flat learning"],
        ["pm_learnings", { text: "flat text learning" }, "learnings", "text", "flat text learning"],
        ["pm_files", { add: ["README.md"] }, "files", "path", "README.md"],
        ["pm_docs", { add: "docs/README.md" }, "docs", "path", "docs/README.md"],
        ["pm_test", { add: "command=node -e 0" }, "tests", "command", "node -e 0"],
      ];
      for (const [tool, args, key, field, expected] of cases) {
        const content = await callTool(context, tool, { id, ...args });
        const result = content.result as Record<string, unknown>;
        expect(result, tool).toBeDefined();
        // The write's own result names the new entry; a fallback listing of
        // earlier entries would not contain it.
        const rows = result[key] as Array<Record<string, unknown>>;
        expect(rows.map((row) => row[field]), `${tool} ${JSON.stringify(args)}`).toContain(expected);
      }
      for (const [collection, expected] of [
        ["notes", ["flat note", "flat text note"]],
        ["learnings", ["flat learning", "flat text learning"]],
      ] as const) {
        const listed = context.runCli([collection, id, "--json"], { expectJson: true }).json as Record<string, Array<{ text: string }>>;
        expect(listed[collection]!.map((row) => row.text)).toEqual(expected);
      }
      const comments = context.runCli(["comments", id, "--json"], { expectJson: true }).json as {
        comments: Array<{ index: number; text: string }>;
      };
      expect(comments.comments.map((row) => [row.index, row.text])).toEqual([
        [1, "flat comment"],
        [2, "flat text comment"],
      ]);
      const files = context.runCli(["files", id, "--json"], { expectJson: true }).json as { files: Array<{ path: string }> };
      expect(files.files.map((row) => row.path)).toEqual(["README.md"]);
      const docs = context.runCli(["docs", id, "--json"], { expectJson: true }).json as { docs: Array<{ path: string }> };
      expect(docs.docs.map((row) => row.path)).toEqual(["docs/README.md"]);
    });
  });

  it("guards an MCP edit with a flat expectAt", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "Flat guarded edit" });
      await callTool(context, "pm_comments", { id, add: "first" });
      await callTool(context, "pm_comments", { id, add: "second" });
      const listed = (await callTool(context, "pm_comments", { id })).result as {
        comments: Array<{ index: number; created_at: string }>;
      };
      const newest = listed.comments.at(-1)!;
      const refused = await callTool(context, "pm_comments", { id, edit: 1, text: "wrong", expectAt: newest.created_at });
      expect(refused).toMatchObject({ code: 4, details: { code: "annotation_entry_mismatch" } });
      const edited = (await callTool(context, "pm_comments", {
        id,
        edit: newest.index,
        text: "second edited",
        expectAt: newest.created_at,
      })).result as { comments: Array<{ index: number; text: string }> };
      expect(edited.comments).toEqual([expect.objectContaining({ index: 2, text: "second edited" })]);
    });
  });
});
