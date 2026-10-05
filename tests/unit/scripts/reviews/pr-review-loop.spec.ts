import { describe, expect, it, vi } from "vitest";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

import {
  addReaction,
  fetchReviewInventory,
  inlineReplyPath,
  main,
  parseArgs,
  pullRequestCommentPath,
  resolveTarget,
  runCliIfDirect,
  runGh,
  usage,
  watchChecksAndInventory,
} from "../../../../scripts/reviews/pr-review-loop.mjs";

function connection(nodes: unknown[], hasNextPage = false, endCursor: string | null = null) {
  return { nodes, pageInfo: { hasNextPage, endCursor } };
}

describe("PR review loop helper", () => {
  it("captures complete large review responses from a real child process", () => {
    const size = 2 * 1024 * 1024;
    const result = runGh([], undefined, (_file: string, _args: string[], options: Parameters<typeof execFileSync>[2]) =>
      execFileSync(process.execPath, ["--eval", `process.stdout.write('x'.repeat(${size}) + 'END')`], options));
    expect(result.length).toBe(size + 3);
    expect(result.endsWith("END")).toBe(true);
  });

  it("identifies edited feedback by content and review state rather than reaction timestamps", () => {
    const read = (body: string, updatedAt: string, state = "COMMENTED") => fetchReviewInventory(
      { owner: "unbraind", name: "pm-cli", repo: "unbraind/pm-cli", pr: 531 },
      () => JSON.stringify({ data: { repository: { pullRequest: {
        number: 531, url: "url", headRefOid: "abc123", updatedAt,
        comments: connection([{ id: "top", body, updatedAt }]),
        reviews: connection([{ id: "review", body, state, updatedAt }]),
        reviewThreads: connection([{ id: "thread", comments: connection([{ id: "inline", body, updatedAt }]) }]),
      } } } }),
    );
    const initial = read("Please cover the recovery branch", "before");
    const reacted = read("Please cover the recovery branch", "after");
    const edited = read("The recovery branch is now covered", "after");
    expect(initial.comments.nodes[0]?.revision).toMatch(/^[a-f0-9]{64}$/u);
    expect(reacted.comments.nodes[0]?.revision).toBe(initial.comments.nodes[0]?.revision);
    expect(edited.comments.nodes[0]?.revision).not.toBe(initial.comments.nodes[0]?.revision);
    expect(edited.reviewThreads.nodes[0]?.comments.nodes[0]?.revision).not.toBe(initial.reviewThreads.nodes[0]?.comments.nodes[0]?.revision);
    expect(read("Please cover the recovery branch", "after", "APPROVED").reviews.nodes[0]?.revision).not.toBe(initial.reviews.nodes[0]?.revision);
  });

  it("reuses acknowledgements only for the selected source revision and actual inline thread", () => {
    const stored: Array<{ id: number; body: string; in_reply_to_id?: number }> = [{
      id: 0, in_reply_to_id: 99, body: `Wrong thread\n\n<!-- pm-review-ack:acknowledge-inline:${"a".repeat(64)} -->`,
    }];
    const executeGh = (args: string[]) => {
      if (args.includes("--paginate")) return stored.map((comment) => JSON.stringify([comment])).join("\n");
      const body = args.find((arg) => arg.startsWith("body="))?.slice(5);
      if (body !== undefined) {
        const comment = { id: stored.length + 1, body, ...(args[1]?.endsWith("/replies") ? { in_reply_to_id: 42 } : {}) };
        stored.push(comment);
        return JSON.stringify(comment);
      }
      return '{"ok":true}';
    };
    const log = vi.fn();
    for (const command of ["acknowledge", "acknowledge-inline"]) {
      for (const revision of ["a".repeat(64), "a".repeat(64), "b".repeat(64)]) {
        main([command, "--repo", "unbraind/pm-cli", "--pr", "531", "--node-id", command,
          "--comment-id", "42", "--reaction", "THUMBS_UP", "--body", "Implemented with regression proof", "--revision", revision], { runGh: executeGh, log });
      }
    }
    expect(stored).toHaveLength(5);
    expect(stored.filter((comment) => comment.in_reply_to_id === 42)).toHaveLength(2);
    expect(stored[1]?.body).toContain(`pm-review-ack:acknowledge:${"a".repeat(64)}`);
    expect(stored[2]?.body).toContain(`pm-review-ack:acknowledge:${"b".repeat(64)}`);
  });

  it("parses command options and builds the documented inline reply endpoint", () => {
    expect(parseArgs(["reply-inline", "--pr", "531", "--comment-id", "42"])).toEqual({
      command: "reply-inline",
      options: { pr: "531", "comment-id": "42" },
    });
    expect(inlineReplyPath("unbraind/pm-cli", 531, "42")).toBe(
      "repos/unbraind/pm-cli/pulls/531/comments/42/replies",
    );
    expect(pullRequestCommentPath("unbraind/pm-cli", 531)).toBe(
      "repos/unbraind/pm-cli/issues/531/comments",
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

  it("dispatches inventory, reactions, and thread-scoped replies through injected gh", () => {
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

    const executeGh = vi.fn((args: string[]) => {
      if (args.includes("--paginate")) return "[]";
      return '{"ok":true}';
    });
    const log = vi.fn();
    main(["react", "--node-id", "node-1", "--reaction", "THUMBS_UP"], { runGh: executeGh, log });
    main(["comment", "--repo", "unbraind/pm-cli", "--pr", "531", "--body", "linked acknowledgement"], { runGh: executeGh, log });
    main([
      "acknowledge", "--repo", "unbraind/pm-cli", "--pr", "531",
      "--node-id", "node-review", "--reaction", "THUMBS_UP",
      "--body", "Review summary acknowledged: https://github.test/review/1",
    ], { runGh: executeGh, log });
    main(["reply-inline", "--repo", "unbraind/pm-cli", "--pr", "531", "--comment-id", "42", "--body", "done"], { runGh: executeGh, log });
    main([
      "acknowledge-inline", "--repo", "unbraind/pm-cli", "--pr", "531",
      "--comment-id", "42", "--node-id", "node-2", "--reaction", "THUMBS_DOWN",
      "--body", "not applicable",
    ], { runGh: executeGh, log });

    expect(executeGh.mock.calls[0]?.[0]).toContain("subjectId=node-1");
    expect(executeGh.mock.calls[1]?.[0]).toContain("repos/unbraind/pm-cli/issues/531/comments");
    expect(executeGh.mock.calls[2]?.[0]).toContain("--paginate");
    expect(executeGh.mock.calls[3]?.[0]).toContain("repos/unbraind/pm-cli/issues/531/comments");
    expect(executeGh.mock.calls[4]?.[0]).toContain("subjectId=node-review");
    expect(executeGh.mock.calls[5]?.[0]).toContain("repos/unbraind/pm-cli/pulls/531/comments/42/replies");
    expect(executeGh.mock.calls[6]?.[0]).toContain("subjectId=node-2");
    expect(executeGh.mock.calls[7]?.[0]).toContain("repos/unbraind/pm-cli/pulls/531/comments/42/replies");
    expect(JSON.parse(log.mock.calls[2]?.[0])).toEqual({
      reaction: { ok: true }, comment: { ok: true },
    });
    expect(JSON.parse(log.mock.calls[4]?.[0])).toEqual({
      reaction: { ok: true }, reply: { ok: true },
    });
  });

  it("reports recoverable partial acknowledgement writes and reuses an existing marker", () => {
    const commentFailureGh = vi.fn((args: string[]) => {
      if (args.includes("--paginate")) return "[]";
      if (args.includes("-f") && args.some((arg) => arg.startsWith("body="))) throw "comment failed";
      return '{"ok":true}';
    });
    const commentFailureLog = vi.fn();
    expect(() => main([
      "acknowledge", "--repo", "unbraind/pm-cli", "--pr", "531",
      "--node-id", "node-review", "--reaction", "THUMBS_UP", "--body", "implemented",
    ], { runGh: commentFailureGh, log: commentFailureLog })).toThrow("partially completed");
    expect(JSON.parse(commentFailureLog.mock.calls[0]?.[0])).toMatchObject({
      status: "partial", reaction: { ok: true }, comment: { ok: false, error: "comment failed" },
    });

    const existing = { id: 42, body: "implemented\n\n<!-- pm-review-ack:node-review -->" };
    const reactionFailureGh = vi.fn((args: string[]) => {
      if (args.includes("--paginate")) return JSON.stringify([existing]);
      throw new Error("reaction failed");
    });
    const reactionFailureLog = vi.fn();
    expect(() => main([
      "acknowledge", "--repo", "unbraind/pm-cli", "--pr", "531",
      "--node-id", "node-review", "--reaction", "THUMBS_UP", "--body", "implemented",
    ], { runGh: reactionFailureGh, log: reactionFailureLog })).toThrow("partially completed");
    expect(JSON.parse(reactionFailureLog.mock.calls[0]?.[0])).toMatchObject({
      status: "partial", reaction: { ok: false, error: "reaction failed" },
      comment: { ok: true, value: existing },
    });
    expect(reactionFailureGh).toHaveBeenCalledTimes(2);
  });

  it("watches emitted checks once without certifying missing required contexts or blocked merge state", () => {
    for (const [mergeStateStatus, emittedContexts, expectedOutcome, missingContexts, protectedBranch] of [
      ["BLOCKED", ["build", "ruleset-scan"], "incomplete", ["codecov/patch"], true],
      ["CLEAN", ["build", "codecov/patch", "ruleset-scan"], "passed", [], true],
      ["CLEAN", ["build", "ruleset-scan"], "incomplete", ["codecov/patch"], true],
      ["BLOCKED", ["build", "codecov/patch", "ruleset-scan"], "incomplete", [], true],
      ["UNKNOWN", ["build", "codecov/patch"], "incomplete", ["ruleset-scan"], true],
      ["CLEAN", null, "incomplete", ["build", "codecov/patch", "ruleset-scan"], true],
      ["CLEAN", null, "passed", [], false],
    ] as const) {
      const executeGh = vi.fn()
        .mockReturnValueOnce('{"headRefOid":"abc123","baseRefName":"release/main"}')
        .mockReturnValueOnce("all checks complete")
        .mockReturnValueOnce(JSON.stringify({
          data: { repository: { pullRequest: {
            number: 531,
            url: "https://github.com/unbraind/pm-cli/pull/531",
            headRefOid: "abc123",
            baseRefName: "release/main",
            mergeStateStatus,
            baseRef: { branchProtectionRule: protectedBranch ? { requiredStatusCheckContexts: ["build", "codecov/patch"] } : null },
            updatedAt: "2026-07-13T00:00:00Z",
            comments: connection([{ id: "top-comment" }]),
            reviews: connection([{ id: "review" }]),
            reviewThreads: connection([{ id: "thread", comments: connection([{ id: "inline" }]) }]),
          } } },
        }))
        .mockReturnValueOnce(JSON.stringify([protectedBranch ? [{ type: "required_status_checks", parameters: {
          required_status_checks: [{ context: "ruleset-scan" }, { context: "build" }],
        } }, { type: "pull_request" }] : []]))
        .mockReturnValueOnce(JSON.stringify({ headRefOid: "abc123", baseRefName: "release/main", mergeStateStatus,
          statusCheckRollup: emittedContexts?.map((context) => context === "build"
            ? { name: context, status: "COMPLETED", conclusion: "SUCCESS" } : { context, state: "SUCCESS" }) ?? null,
        }));
      const log = vi.fn();
      expect(main(["watch", "--repo", "unbraind/pm-cli", "--pr", "531"], { runGh: executeGh, log }))
        .toBe(expectedOutcome === "passed" ? 0 : 1);

      const result = JSON.parse(log.mock.calls[0]?.[0]);
      expect(result.checkWatch.attempts[0].outcome).toBe(expectedOutcome);
      expect(result).toMatchObject({
        repository: "unbraind/pm-cli",
        checkWatch: { attempts: [{ watchedHeadRefOid: "abc123", outcome: expectedOutcome, failedChecks: [],
          mergeReadiness: { baseRefName: "release/main", mergeStateStatus,
            requiredContexts: protectedBranch ? ["build", "codecov/patch", "ruleset-scan"] : [], missingContexts },
        }] },
        pullRequest: { headRefOid: "abc123" },
      });
      expect(executeGh.mock.calls[1]?.[0]).toEqual([
        "pr", "checks", "531", "--repo", "unbraind/pm-cli", "--watch", "--interval", "30",
      ]);
      expect(executeGh.mock.calls[3]?.[0]).toContain("repos/unbraind/pm-cli/rules/branches/release%2Fmain");
      expect(executeGh).toHaveBeenCalledTimes(5);
    }
  });

  it("returns failed review findings, retries head or base races, and refuses unavailable policy evidence", () => {
    const failedCheck = Object.assign(new Error("checks failed"), {
      stdout: "Greptile Review\tfail\t3m31s\thttps://greptile.com/\n",
    });
    const failedGh = vi.fn()
      .mockReturnValueOnce('{"headRefOid":"abc123","baseRefName":"main"}')
      .mockImplementationOnce(() => { throw failedCheck; })
      .mockReturnValueOnce(JSON.stringify({
        data: { repository: { pullRequest: {
          number: 531, url: "url", headRefOid: "abc123", baseRefName: "main", updatedAt: "now",
          comments: connection([]), reviews: connection([]), reviewThreads: connection([]),
        } } },
      }))
      .mockReturnValueOnce('[[]]')
      .mockReturnValueOnce('{"headRefOid":"abc123","baseRefName":"main","mergeStateStatus":"BLOCKED"}');
    expect(watchChecksAndInventory(
      { owner: "unbraind", name: "pm-cli", repo: "unbraind/pm-cli", pr: 531 },
      10,
      failedGh,
    )).toMatchObject({
      checkWatch: {
        attempts: [{
          outcome: "failed",
          failedChecks: [{
            name: "Greptile Review", state: "fail", duration: "3m31s", url: "https://greptile.com/",
          }],
        }],
      },
    });

    for (const changeAt of ["inventory-head", "inventory-base", "readiness-head", "readiness-base", "unavailable-rules"]) {
      let head = 0;
      const changingGh = vi.fn((args: string[]) => {
        if (args.at(-1) === "headRefOid,baseRefName") return JSON.stringify({ headRefOid: `head-${++head}`, baseRefName: "main" });
        if (args[0] === "pr" && args[1] === "checks") throw "review failed";
        if (args[1]?.includes("rules/branches")) {
          if (changeAt === "unavailable-rules") throw new Error("Rules evidence unavailable");
          return "[[]]";
        }
        if (args[0] === "pr" && args[1] === "view") return JSON.stringify({
          headRefOid: changeAt === "readiness-head" ? `different-${head}` : `head-${head}`,
          baseRefName: changeAt === "readiness-base" ? "retargeted" : "main",
          mergeStateStatus: "CLEAN",
        });
        return JSON.stringify({
          data: { repository: { pullRequest: {
            number: 531, url: "url", headRefOid: changeAt === "inventory-head" ? `different-${head}` : `head-${head}`,
            baseRefName: changeAt === "inventory-base" ? "retargeted" : "main", updatedAt: "now",
            comments: connection([]), reviews: connection([]), reviewThreads: connection([]),
          } } },
        });
      });
      expect(() => watchChecksAndInventory(
        { owner: "unbraind", name: "pm-cli", repo: "unbraind/pm-cli", pr: 531 },
        10,
        changingGh,
      )).toThrow(changeAt === "unavailable-rules" ? "Rules evidence unavailable" : "three consecutive");
      expect(changingGh).toHaveBeenCalledTimes(changeAt === "unavailable-rules" ? 4 : changeAt.startsWith("inventory") ? 9 : 15);
    }
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
    expect(() => addReaction("node-1", "INVALID")).toThrow("exit");
    expect(() => main(["comment", "--repo", "unbraind/pm-cli", "--pr", "531"])).toThrow("exit");
    expect(() => main(["acknowledge", "--repo", "unbraind/pm-cli", "--pr", "531"])).toThrow("exit");
    expect(() => main([
      "acknowledge", "--repo", "unbraind/pm-cli", "--pr", "531", "--body", "implemented",
    ])).toThrow("exit");
    expect(() => main([
      "acknowledge", "--repo", "unbraind/pm-cli", "--pr", "531", "--body", "implemented",
      "--node-id", "node-1", "--reaction", "INVALID",
    ])).toThrow("exit");
    expect(() => main(["reply-inline", "--repo", "unbraind/pm-cli", "--pr", "531"])).toThrow("exit");
    expect(() => main(["acknowledge-inline", "--repo", "unbraind/pm-cli", "--pr", "531"])).toThrow("exit");
    expect(() => main(["watch", "--repo", "unbraind/pm-cli", "--pr", "531", "--interval", "9"])).toThrow("exit");
    expect(() => main(["unknown"])).toThrow("exit");
    expect(() => main(["acknowledge", "--revision", "not-a-revision"])).toThrow("exit");

    expect(error).toHaveBeenCalled();
    exit.mockRestore();
    error.mockRestore();
  });

  it("runs the CLI entrypoint only for direct execution", () => {
    const executeMain = vi.fn();
    const scriptPath = process.platform === "win32" ? "C:\\tmp\\review-loop.mjs" : "/tmp/review-loop.mjs";
    const previousExitCode = process.exitCode;
    try {
      runCliIfDirect(["node", scriptPath], pathToFileURL(scriptPath).href, executeMain);
      expect(process.exitCode).toBe(0);
      executeMain.mockReturnValue(1);
      runCliIfDirect(["node", scriptPath], pathToFileURL(scriptPath).href, executeMain);
      expect(process.exitCode).toBe(1);
      runCliIfDirect(["node", scriptPath], pathToFileURL(`${scriptPath}.importer`).href, executeMain);
      runCliIfDirect(["node"], pathToFileURL(scriptPath).href, executeMain);
      expect(executeMain).toHaveBeenCalledTimes(2);
    } finally {
      process.exitCode = previousExitCode;
    }
  });
});
