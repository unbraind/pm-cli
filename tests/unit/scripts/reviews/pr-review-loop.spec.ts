import { describe, expect, it, vi } from "vitest";
import { pathToFileURL } from "node:url";

import {
  fetchReviewInventory,
  inlineReplyPath,
  main,
  parseArgs,
  resolveTarget,
  runCliIfDirect,
  runGh,
  usage,
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

  it("resolves explicit and current-branch PR targets", () => {
    expect(resolveTarget({ repo: "unbraind/pm-cli", pr: "531" })).toEqual({
      repo: "unbraind/pm-cli", owner: "unbraind", name: "pm-cli", pr: 531,
    });
    const executeGh = vi.fn()
      .mockReturnValueOnce('{"nameWithOwner":"unbraind/pm-cli"}')
      .mockReturnValueOnce('{"number":531}');
    expect(resolveTarget({}, executeGh)).toEqual({
      repo: "unbraind/pm-cli", owner: "unbraind", name: "pm-cli", pr: 531,
    });
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
          reviews: connection([{ id: "review-1" }], true, "review-cursor-1"),
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
          comments: connection([{ id: "comment-2" }], true, "comment-cursor-2"),
          reviews: connection([{ id: "review-2" }], false, "review-cursor-2"),
          reviewThreads: connection([]),
        } } },
      }))
      .mockReturnValueOnce(JSON.stringify({
        data: { repository: { pullRequest: {
          number: 531,
          url: "https://github.com/unbraind/pm-cli/pull/531",
          headRefOid: "abc123",
          updatedAt: "2026-07-12T00:00:00Z",
          comments: connection([{ id: "comment-3" }]),
          reviews: connection([], false, null),
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

    expect(result.comments.nodes).toEqual([{ id: "comment-1" }, { id: "comment-2" }, { id: "comment-3" }]);
    expect(result.reviews.nodes).toEqual([{ id: "review-1" }, { id: "review-2" }]);
    expect(result.reviewThreads.nodes[0]?.comments.nodes).toEqual([
      { id: "thread-comment-1" },
      { id: "thread-comment-2" },
    ]);
    expect(executeGh).toHaveBeenCalledTimes(4);
    expect(executeGh.mock.calls[1]?.[0]).toContain("commentCursor=comment-cursor");
    expect(executeGh.mock.calls[2]?.[0]).toContain("reviewCursor=review-cursor-2");
    expect(executeGh.mock.calls[3]?.[0]).toContain("threadId=thread-1");
  });

  it("dispatches inventory, reactions, and both reply forms through injected gh", () => {
    const inventoryGh = vi.fn().mockReturnValue(JSON.stringify({
      data: { repository: { pullRequest: {
        number: 531,
        url: "https://github.com/unbraind/pm-cli/pull/531",
        headRefOid: "abc123",
        updatedAt: "2026-07-12T00:00:00Z",
        comments: connection([]),
        reviews: connection([]),
        reviewThreads: connection([]),
      } } },
    }));
    const inventoryLog = vi.fn();
    main(["inventory", "--repo", "unbraind/pm-cli", "--pr", "531"], {
      runGh: inventoryGh,
      log: inventoryLog,
    });
    expect(JSON.parse(inventoryLog.mock.calls[0]?.[0])).toMatchObject({
      repository: "unbraind/pm-cli",
      pullRequest: { headRefOid: "abc123" },
    });

    const executeGh = vi.fn().mockReturnValue('{"ok":true}');
    const log = vi.fn();
    main(["react", "--node-id", "node-1", "--reaction", "THUMBS_UP"], { runGh: executeGh, log });
    main(["reply-inline", "--repo", "unbraind/pm-cli", "--pr", "531", "--comment-id", "42", "--body", "done"], { runGh: executeGh, log });
    main(["reply-top", "--repo", "unbraind/pm-cli", "--pr", "531", "--body", "done"], { runGh: executeGh, log });

    expect(executeGh.mock.calls[0]?.[0]).toContain("subjectId=node-1");
    expect(executeGh.mock.calls[1]?.[0]).toContain("repos/unbraind/pm-cli/pulls/531/comments/42/replies");
    expect(executeGh.mock.calls[2]?.[0]).toEqual([
      "pr", "comment", "531", "--repo", "unbraind/pm-cli", "--body", "done",
    ]);
  });

  it("runs gh with the expected stdio modes and trims its output", () => {
    const executeFile = vi.fn().mockReturnValue(" result\n");
    expect(runGh(["pr", "view"], undefined, executeFile)).toBe("result");
    expect(runGh(["api"], "payload", executeFile)).toBe("result");
    expect(executeFile.mock.calls[0]?.[2]).toMatchObject({
      encoding: "utf8", input: undefined, stdio: ["inherit", "pipe", "inherit"],
    });
    expect(executeFile.mock.calls[1]?.[2]).toMatchObject({
      encoding: "utf8", input: "payload", stdio: ["pipe", "pipe", "inherit"],
    });
  });

  it("renders usage with and without a specific error", () => {
    const error = vi.fn();
    const exit = vi.fn();
    usage("bad input", { error, exit });
    usage(undefined, { error, exit });
    expect(error.mock.calls[0]?.[0]).toBe("bad input");
    expect(error.mock.calls.filter(([value]) => String(value).startsWith("Usage:"))).toHaveLength(2);
    expect(exit).toHaveBeenNthCalledWith(1, 2);
    expect(exit).toHaveBeenNthCalledWith(2, 2);
  });

  it("rejects invalid arguments, targets, and command requirements", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(() => parseArgs(["inventory", "--pr"])).toThrow("exit");
    expect(() => parseArgs(["inventory", "pr", "531"])).toThrow("exit");
    expect(() => parseArgs(["inventory", undefined as never, "531"])).toThrow("exit");
    expect(() => resolveTarget({ repo: "invalid", pr: "0" })).toThrow("exit");
    expect(() => main(["react"])).toThrow("exit");
    expect(() => main(["react", "--node-id", "node-1", "--reaction", "INVALID"])).toThrow("exit");
    expect(() => main(["reply-inline", "--repo", "unbraind/pm-cli", "--pr", "531"])).toThrow("exit");
    expect(() => main(["reply-top", "--repo", "unbraind/pm-cli", "--pr", "531"])).toThrow("exit");
    expect(() => main(["unknown"])).toThrow("exit");

    expect(error).toHaveBeenCalled();
    exit.mockRestore();
    error.mockRestore();
  });

  it("runs the CLI entrypoint only for direct execution", () => {
    const executeMain = vi.fn();
    const scriptPath = process.platform === "win32" ? "C:\\tmp\\review-loop.mjs" : "/tmp/review-loop.mjs";
    runCliIfDirect(["node", scriptPath], pathToFileURL(scriptPath).href, executeMain);
    runCliIfDirect(["node", scriptPath], pathToFileURL(`${scriptPath}.importer`).href, executeMain);
    runCliIfDirect(["node"], pathToFileURL(scriptPath).href, executeMain);
    expect(executeMain).toHaveBeenCalledTimes(1);
  });
});
