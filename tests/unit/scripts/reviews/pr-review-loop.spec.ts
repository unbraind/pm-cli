import { describe, expect, it, vi } from "vitest";

import {
  fetchReviewInventory,
  inlineReplyPath,
  parseArgs,
} from "../../../../scripts/reviews/pr-review-loop.mjs";

function connection(nodes: unknown[], hasNextPage = false, endCursor: string | null = null) {
  return { nodes, pageInfo: { hasNextPage, endCursor } };
}

describe("PR review loop helper", () => {
  it("parses command options and builds the documented inline reply endpoint", () => {
    expect(parseArgs(["reply-inline", "--pr", "531", "--comment-id", "42"])).toEqual({
      command: "reply-inline",
      options: { pr: "531", "comment-id": "42" },
    });
    expect(inlineReplyPath("unbraind/pm-cli", 531, "42")).toBe(
      "repos/unbraind/pm-cli/pulls/531/comments/42/replies",
    );
  });

  it("paginates top-level conversations and comments inside review threads", () => {
    const executeGh = vi.fn()
      .mockReturnValueOnce(JSON.stringify({
        data: { repository: { pullRequest: {
          number: 531,
          url: "https://github.com/unbraind/pm-cli/pull/531",
          headRefOid: "abc123",
          updatedAt: "2026-07-12T00:00:00Z",
          comments: connection([{ id: "comment-1" }], true, "comment-cursor"),
          reviews: connection([{ id: "review-1" }]),
          reviewThreads: connection([{
            id: "thread-1",
            comments: connection([{ id: "thread-comment-1" }], true, "thread-comment-cursor"),
          }]),
        } } },
      }))
      .mockReturnValueOnce(JSON.stringify({
        data: { repository: { pullRequest: {
          number: 531,
          url: "https://github.com/unbraind/pm-cli/pull/531",
          headRefOid: "abc123",
          updatedAt: "2026-07-12T00:00:00Z",
          comments: connection([{ id: "comment-2" }]),
          reviews: connection([]),
          reviewThreads: connection([]),
        } } },
      }))
      .mockReturnValueOnce(JSON.stringify({
        data: { node: { comments: connection([{ id: "thread-comment-2" }]) } },
      }));

    const result = fetchReviewInventory(
      { owner: "unbraind", name: "pm-cli", repo: "unbraind/pm-cli", pr: 531 },
      executeGh,
    );

    expect(result.comments.nodes).toEqual([{ id: "comment-1" }, { id: "comment-2" }]);
    expect(result.reviews.nodes).toEqual([{ id: "review-1" }]);
    expect(result.reviewThreads.nodes[0]?.comments.nodes).toEqual([
      { id: "thread-comment-1" },
      { id: "thread-comment-2" },
    ]);
    expect(executeGh).toHaveBeenCalledTimes(3);
    expect(executeGh.mock.calls[1]?.[0]).toContain("commentCursor=comment-cursor");
    expect(executeGh.mock.calls[2]?.[0]).toContain("threadId=thread-1");
  });
});
