import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runComments } from "../../../src/cli/commands/annotations/comments.js";
import { createTestItemId } from "../../helpers/itemFactory.js";
import { withTempPmPath, type TempPmContext } from "../../helpers/withTempPmPath.js";

/**
 * pm-sbqn4h: an MCP pm_comments listing used to page the newest 20 comments
 * only. The output cursor paged backwards inside that producer page and its
 * last page reported has_more without a continuation. A listing now applies
 * no producer page, so following next_cursor alone reaches the oldest comment.
 */

const ENTRIES = 30;
const originalProfile = process.env.PM_MCP_PROFILE;
beforeEach(() => {
  process.env.PM_MCP_PROFILE = "full";
});
afterEach(() => {
  if (originalProfile === undefined) delete process.env.PM_MCP_PROFILE;
  else process.env.PM_MCP_PROFILE = originalProfile;
});

interface CommentsPage {
  comments: Array<{ index: number; text: string }>;
  count: number;
  total_count: number;
  has_more: boolean;
  next_cursor?: string | null;
}

async function callComments(context: TempPmContext, args: Record<string, unknown>): Promise<CommentsPage> {
  const server = await import("../../../src/mcp/server.js");
  const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    await server.processRpcLine(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "pm_comments", arguments: { path: context.pmPath, ...args } } }),
    );
    const response = JSON.parse(writeSpy.mock.calls.map(([chunk]) => String(chunk)).join("")) as {
      result: { structuredContent: { result: CommentsPage } };
    };
    return response.result.structuredContent.result;
  } finally {
    writeSpy.mockRestore();
  }
}

describe("MCP pm_comments continuations reach the oldest comment (pm-sbqn4h)", () => {
  it("follows next_cursor alone from the newest comment to the first, and never reports has_more without one", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "Long comment history" });
      for (let index = 1; index <= ENTRIES; index += 1) {
        await runComments(id, { add: `comment ${index} ${"x".repeat(300)}` }, { path: context.pmPath });
      }
      const seen: number[] = [];
      let page = await callComments(context, { id });
      expect(page.comments.at(-1)?.index).toBe(ENTRIES);
      expect(page.total_count).toBe(ENTRIES);
      // The default budget must withhold older comments, so the walk really follows a cursor.
      expect(typeof page.next_cursor).toBe("string");
      for (let step = 0; step < ENTRIES; step += 1) {
        seen.unshift(...page.comments.map(({ index }) => index));
        expect(page.has_more).toBe(typeof page.next_cursor === "string");
        if (typeof page.next_cursor !== "string") break;
        page = await callComments(context, { id, outputCursor: page.next_cursor });
      }
      expect(seen).toEqual(Array.from({ length: ENTRIES }, (_entry, offset) => offset + 1));
      // The walk ended on a page that offers no cursor and reports nothing more.
      expect(page.next_cursor ?? undefined).toBeUndefined();
      expect(page.has_more).toBe(false);
      // An explicit producer page still returns exactly the newest N comments.
      const newest = await callComments(context, { id, options: { limit: "5" } });
      expect(newest.comments.map(({ index }) => index)).toEqual([26, 27, 28, 29, 30]);
      expect(newest).toMatchObject({ total_count: ENTRIES, has_more: true });
      // The caller chose this window: older comments are reported by has_more, never by a cursor.
      expect(newest.next_cursor ?? undefined).toBeUndefined();
      // A numeric zero limit is summary-only metadata.
      const summary = await callComments(context, { id, options: { limit: 0 } });
      expect(summary).toMatchObject({ comments: [], count: 0, total_count: ENTRIES, has_more: true });
    });
  }, 120_000);
});
