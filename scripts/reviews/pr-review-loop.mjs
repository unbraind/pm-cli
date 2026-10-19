#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

/** Capture complete gh responses within 64 MiB; propagate overflow and other transport failures. */
export function runGh(args, input, executeFile = execFileSync) {
  return executeFile("gh", args, {
    encoding: "utf8",
    input,
    maxBuffer: 64 * 1024 * 1024,
    stdio: [input === undefined ? "inherit" : "pipe", "pipe", "inherit"],
  }).trim();
}

/** Print command guidance and terminate invalid invocations before any GitHub mutation. */
export function usage(message, dependencies = {}) {
  const writeError = dependencies.error ?? console.error;
  const exit = dependencies.exit ?? process.exit;
  if (message) writeError(message);
  writeError(`Usage:
  node scripts/reviews/pr-review-loop.mjs inventory [--pr <number>] [--repo <owner/name>]
  node scripts/reviews/pr-review-loop.mjs watch [--pr <number>] [--repo <owner/name>] [--interval <seconds>] [--phase checks|reviews]
  node scripts/reviews/pr-review-loop.mjs react --node-id <id> --reaction <THUMBS_UP|THUMBS_DOWN|...>
  node scripts/reviews/pr-review-loop.mjs comment --body <text> [--pr <number>] [--repo <owner/name>]
  node scripts/reviews/pr-review-loop.mjs acknowledge --node-id <id> --reaction <THUMBS_UP|THUMBS_DOWN|...> --body <text> [--revision <sha256>] [--pr <number>] [--repo <owner/name>]
  node scripts/reviews/pr-review-loop.mjs reply-inline --comment-id <id> --body <text> [--pr <number>] [--repo <owner/name>]
  node scripts/reviews/pr-review-loop.mjs acknowledge-inline --comment-id <id> --node-id <id> --reaction <THUMBS_UP|THUMBS_DOWN|...> --body <text> [--revision <sha256>] [--pr <number>] [--repo <owner/name>]`);
  exit(2);
}

/** Parse paired flags and validate an optional content revision before dispatching a command. */
export function parseArgs(argv) {
  const [command = "inventory", ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      usage(`Invalid argument: ${flag ?? ""}`);
    } else {
      options[flag.slice(2)] = value;
    }
  }
  if (options.revision !== undefined && !/^[a-f0-9]{64}$/u.test(options.revision)) {
    usage("--revision must be the SHA-256 source revision from the review inventory.");
  }
  return { command, options };
}

/** Resolve an explicit or current pull request and reject malformed repository or numeric identities. */
export function resolveTarget(options, executeGh = runGh) {
  const repo = options.repo ?? JSON.parse(executeGh(["repo", "view", "--json", "nameWithOwner"])).nameWithOwner;
  const pr = Number(options.pr ?? JSON.parse(executeGh(["pr", "view", "--json", "number"])).number);
  if (!repo.includes("/") || !Number.isInteger(pr) || pr <= 0) usage("A valid repository and PR are required.");
  const [owner, name] = repo.split("/");
  return { repo, owner, name, pr };
}

const inventoryQuery = `
query ReviewInventory(
  $owner: String!, $name: String!, $pr: Int!,
  $commentCursor: String, $reviewCursor: String, $threadCursor: String
) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $pr) {
      number url headRefOid baseRefName mergeStateStatus updatedAt
      baseRef { branchProtectionRule { requiredStatusCheckContexts requiredStatusChecks { context app { databaseId } } } }
      comments(first: 100, after: $commentCursor) {
        pageInfo { hasNextPage endCursor }
        nodes { id databaseId author { login } body createdAt updatedAt reactionGroups { content users { totalCount } viewerHasReacted } }
      }
      reviews(first: 100, after: $reviewCursor) {
        pageInfo { hasNextPage endCursor }
        nodes { id databaseId author { login } body state submittedAt updatedAt reactionGroups { content users { totalCount } viewerHasReacted } }
      }
      reviewThreads(first: 100, after: $threadCursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id isResolved isOutdated path line originalLine
          comments(first: 100) {
            pageInfo { hasNextPage endCursor }
            nodes { id databaseId author { login } body createdAt updatedAt reactionGroups { content users { totalCount } viewerHasReacted } }
          }
        }
      }
    }
  }
}`;

const threadCommentsQuery = `
query ThreadComments($threadId: ID!, $cursor: String) {
  node(id: $threadId) {
    ... on PullRequestReviewThread {
      comments(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { id databaseId author { login } body createdAt updatedAt reactionGroups { content users { totalCount } viewerHasReacted } }
      }
    }
  }
}`;

const validReactions = new Set([
  "THUMBS_UP", "THUMBS_DOWN", "LAUGH", "HOORAY", "CONFUSED", "HEART", "ROCKET", "EYES",
]);

/** Submit a GraphQL operation with separately encoded variables and decode its response. */
function graphql(executeGh, query, variables) {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [key, value] of Object.entries(variables)) {
    if (value !== undefined && value !== null) args.push("-F", `${key}=${value}`);
  }
  return JSON.parse(executeGh(args));
}

/** Identify source edits independently of timestamp changes caused by reactions. */
function withReviewRevision(node) {
  return typeof node.body === "string"
    ? { ...node, revision: createHash("sha256").update(JSON.stringify([node.body, node.state ?? null])).digest("hex") }
    : node;
}

/** Read every conversation page and nested thread page, retaining content revisions and reaction state. */
export function fetchReviewInventory(target, executeGh = runGh) {
  const comments = [];
  const reviews = [];
  const reviewThreads = [];
  const cursors = { commentCursor: undefined, reviewCursor: undefined, threadCursor: undefined };
  const exhausted = { commentCursor: false, reviewCursor: false, threadCursor: false };
  let pullRequestHeader;
  let hasNextPage = true;

  while (hasNextPage) {
    const payload = graphql(executeGh, inventoryQuery, {
      owner: target.owner,
      name: target.name,
      pr: target.pr,
      ...cursors,
    });
    const page = payload.data.repository.pullRequest;
    pullRequestHeader ??= {
      number: page.number,
      url: page.url,
      headRefOid: page.headRefOid,
      baseRefName: page.baseRefName,
      mergeStateStatus: page.mergeStateStatus,
      requiredContexts: page.baseRef?.branchProtectionRule?.requiredStatusCheckContexts ?? [],
      requiredChecks: (page.baseRef?.branchProtectionRule?.requiredStatusChecks ?? []).map((check) => ({
        context: check.context, integrationId: check.app?.databaseId ?? null,
      })),
      updatedAt: page.updatedAt,
    };
    comments.push(...page.comments.nodes);
    reviews.push(...page.reviews.nodes);
    reviewThreads.push(...page.reviewThreads.nodes);
    const connections = [page.comments, page.reviews, page.reviewThreads];
    const cursorKeys = ["commentCursor", "reviewCursor", "threadCursor"];
    connections.forEach((connection, index) => {
      const key = cursorKeys[index];
      if (!exhausted[key]) {
        cursors[key] = connection.pageInfo.endCursor;
        exhausted[key] = !connection.pageInfo.hasNextPage;
      }
    });
    hasNextPage = connections.some((connection) => connection.pageInfo.hasNextPage);
  }

  for (const thread of reviewThreads) {
    let connection = thread.comments;
    while (connection.pageInfo.hasNextPage) {
      const payload = graphql(executeGh, threadCommentsQuery, {
        threadId: thread.id,
        cursor: connection.pageInfo.endCursor,
      });
      connection = payload.data.node.comments;
      thread.comments.nodes.push(...connection.nodes);
      thread.comments.pageInfo = connection.pageInfo;
    }
  }

  return {
    ...pullRequestHeader,
    comments: { nodes: comments.map(withReviewRevision) },
    reviews: { nodes: reviews.map(withReviewRevision) },
    reviewThreads: { nodes: reviewThreads.map((thread) => ({
      ...thread, comments: { ...thread.comments, nodes: thread.comments.nodes.map(withReviewRevision) },
    })) },
  };
}

/** Address GitHub's actual inline review reply endpoint for a selected parent comment. */
export function inlineReplyPath(repo, pr, commentId) {
  return `repos/${repo}/pulls/${pr}/comments/${commentId}/replies`;
}

/** Address the issue-comment surface used for top-level pull-request discussion. */
export function pullRequestCommentPath(repo, pr) {
  return `repos/${repo}/issues/${pr}/comments`;
}

/** Reuse only the acknowledgement for this source revision and reply surface. */
function acknowledgementComment(target, nodeId, body, executeGh, revision, commentId) {
  const listPath = commentId === undefined ? pullRequestCommentPath(target.repo, target.pr)
    : `repos/${target.repo}/pulls/${target.pr}/comments`;
  const writePath = commentId === undefined ? listPath : inlineReplyPath(target.repo, target.pr, commentId);
  const marker = `<!-- pm-review-ack:${nodeId}${revision === undefined ? "" : `:${revision}`} -->`;
  const pageLines = executeGh([
    "api", listPath, "--paginate",
    "--jq", "map({id, body, in_reply_to_id}) | @json",
  ]);
  const pages = JSON.parse(`[${pageLines.trim().split(/\r?\n/u).join(",")}]`);
  const existing = pages.flat().find((comment) => comment?.body?.includes(marker) &&
    (commentId === undefined || String(comment.in_reply_to_id) === commentId));
  if (existing) return JSON.stringify(existing);
  return executeGh(["api", writePath, "-f", `body=${body}\n\n${marker}`]);
}

/** Capture a write result independently so acknowledgement retries can report partial completion. */
function attemptGitHubWrite(write) {
  try {
    return { ok: true, value: JSON.parse(write()) };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

/** Validate a supported usefulness reaction and attach it to the original GitHub artifact. */
export function addReaction(nodeId, reaction, executeGh = runGh) {
  if (!nodeId || !reaction) usage("A reaction requires --node-id and --reaction.");
  if (!validReactions.has(reaction)) usage(`Invalid reaction: ${reaction}`);
  const mutation = `mutation($subjectId: ID!, $content: ReactionContent!) {
    addReaction(input: { subjectId: $subjectId, content: $content }) { reaction { content } }
  }`;
  return executeGh([
    "api", "graphql", "-f", `query=${mutation}`,
    "-F", `subjectId=${nodeId}`, "-F", `content=${reaction}`,
  ]);
}

/** Retain pending and unavailable check signals without interpreting them as review approval. */
function incompleteCheckSignals(checks, requiredContexts) {
  const pendingChecks = [];
  const unavailableChecks = [];
  for (const check of checks) {
    const state = check.conclusion || check.state || check.status;
    const name = check.name ?? check.context;
    const signal = { name, state, required: requiredContexts.includes(name), url: check.detailsUrl ?? check.targetUrl ?? null };
    if (["PENDING", "EXPECTED", "QUEUED", "IN_PROGRESS", "REQUESTED", "WAITING", "PENDING_DEPLOYMENT"].includes(state)) {
      pendingChecks.push(signal);
    } else if (["NEUTRAL", "SKIPPED", "CANCELLED", "TIMED_OUT", "STALE", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR"].includes(state)) {
      unavailableChecks.push(signal);
    }
  }
  return { pendingChecks, unavailableChecks };
}

/** Combine effective publisher bindings, dropping redundant unbound requirements for the same name. */
function requiredCheckRequirements(pullRequest, rules) {
  const records = [
    ...(pullRequest.requiredChecks ?? []),
    ...pullRequest.requiredContexts.map((context) => ({ context, integrationId: null })),
    ...rules.filter((rule) => rule.type === "required_status_checks")
      .flatMap((rule) => rule.parameters.required_status_checks.map((check) => ({
        context: check.context, integrationId: check.integration_id ?? null,
      }))),
  ].map((record) => ({ ...record, integrationId: record.integrationId === -1 ? null : record.integrationId }));
  const boundNames = new Set(records.filter((record) => record.integrationId !== null).map((record) => record.context));
  return [...new Map(records.filter((record) => record.integrationId !== null || !boundNames.has(record.context))
    .map((record) => [JSON.stringify(record), record])).values()];
}

/** Fetch all exact-head check runs only when a required publisher needs independent identity evidence. */
function checkPublisherEvidence(target, headRefOid, requirements, executeGh) {
  if (!requirements.some((record) => record.integrationId !== null)) return [];
  return JSON.parse(executeGh([
    "api", `repos/${target.repo}/commits/${headRefOid}/check-runs?per_page=100&filter=all`, "--paginate", "--slurp",
  ])).flatMap((page) => page.check_runs);
}

/** Read effective requirements and the final rollup without replacing GitHub verdict enforcement. */
function readCheckReadiness(target, pullRequest, executeGh) {
  const rules = JSON.parse(executeGh([
    "api", `repos/${target.repo}/rules/branches/${encodeURIComponent(pullRequest.baseRefName)}`,
    "--paginate", "--slurp",
  ])).flat();
  const requiredChecks = requiredCheckRequirements(pullRequest, rules);
  const requiredContexts = [...new Set(requiredChecks.map((record) => record.context))];
  const readiness = JSON.parse(executeGh([
    "pr", "view", String(target.pr), "--repo", target.repo,
    "--json", "headRefOid,baseRefName,mergeStateStatus,statusCheckRollup",
  ]));
  const publishers = checkPublisherEvidence(target, readiness.headRefOid, requiredChecks, executeGh);
  const emittedContexts = new Set((readiness.statusCheckRollup ?? []).map((check) => check.name ?? check.context));
  const missingContexts = [...new Set(requiredChecks.filter((requirement) =>
    !emittedContexts.has(requirement.context) || (requirement.integrationId !== null && !publishers.some((check) =>
      check.name === requirement.context && check.app?.id === requirement.integrationId && check.head_sha === readiness.headRefOid,
    )),
  ).map((requirement) => requirement.context))];
  const mergeReadiness = {
    headRefOid: readiness.headRefOid,
    baseRefName: readiness.baseRefName,
    mergeStateStatus: readiness.mergeStateStatus,
    requiredContexts,
    requiredChecks,
    missingContexts,
  };
  return { mergeReadiness, ...incompleteCheckSignals(readiness.statusCheckRollup ?? [], requiredContexts) };
}

/** Validate the wait phase and construct one native GitHub CLI watch invocation. */
function checkWatchArguments(target, interval, phase) {
  if (!Number.isInteger(interval) || interval < 10) {
    usage("watch requires --interval to be an integer of at least 10 seconds.");
  }
  if (phase !== "checks" && phase !== "reviews") {
    usage("watch requires --phase checks or reviews.");
  }
  return [
    "pr", "checks", String(target.pr), "--repo", target.repo,
    "--watch", "--interval", String(interval),
    ...(phase === "checks" ? ["--fail-fast"] : []),
  ];
}

/** Wait once per head, returning failures promptly in the checks phase or waiting for every reviewer in the reviews phase. */
export function watchChecksAndInventory(target, interval, executeGh = runGh, phase = "checks") {
  const watchArgs = checkWatchArguments(target, interval, phase);
  const attempts = [];
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const watched = JSON.parse(executeGh([
      "pr", "view", String(target.pr), "--repo", target.repo, "--json", "headRefOid,baseRefName",
    ]));
    const watchedHeadRefOid = watched.headRefOid;
    let outcome = "incomplete";
    let checkOutput;
    try {
      checkOutput = executeGh(watchArgs);
    } catch (error) {
      outcome = "failed";
      checkOutput = String(error?.stdout ?? error).trim();
    }
    const pullRequest = fetchReviewInventory(target, executeGh);
    const failedChecks = [...new Set(
      checkOutput
        .split("\n")
        .map((line) => line.split("\t"))
        .filter((fields) => fields[1] === "fail")
        .map((fields) => fields.slice(0, 4).join("\t")),
    )].map((line) => {
      const [name, state, duration, url] = line.split("\t");
      return { name, state, duration, url };
    });
    const receipt = { attempt, watchedHeadRefOid, outcome, failedChecks };
    attempts.push(receipt);
    if (pullRequest.headRefOid !== watchedHeadRefOid || pullRequest.baseRefName !== watched.baseRefName) {
      receipt.superseded = true;
      continue;
    }
    const signals = readCheckReadiness(target, pullRequest, executeGh);
    const readiness = signals.mergeReadiness;
    if (readiness.headRefOid !== watchedHeadRefOid || readiness.baseRefName !== watched.baseRefName) {
      receipt.superseded = true;
      continue;
    }
    Object.assign(receipt, signals);
    if (outcome !== "failed" && receipt.pendingChecks.length === 0 && readiness.missingContexts.length === 0 && readiness.mergeStateStatus === "CLEAN") {
      receipt.outcome = "passed";
    }
    return { repository: target.repo, checkWatch: { phase, attempts }, pullRequest };
  }
  throw new Error("PR head or base changed during three consecutive check-watch attempts.");
}

/** Dispatch top-level comments or independently retryable acknowledgement and reaction writes. */
function handleTopLevelConversationWrite(command, options, executeGh, write) {
  if (command !== "comment" && command !== "acknowledge") return false;
  const target = resolveTarget(options, executeGh);
  if (!options.body) usage(`${command} requires --body.`);
  const commentArgs = [
    "api", pullRequestCommentPath(target.repo, target.pr),
    "-f", `body=${options.body}`,
  ];
  if (command === "comment") {
    write(executeGh(commentArgs));
    return true;
  }
  const nodeId = options["node-id"];
  if (!nodeId || !options.reaction) usage("A reaction requires --node-id and --reaction.");
  if (!validReactions.has(options.reaction)) usage(`Invalid reaction: ${options.reaction}`);
  const comment = attemptGitHubWrite(() => acknowledgementComment(
    target, nodeId, options.body, executeGh, options.revision,
  ));
  const reaction = attemptGitHubWrite(() => addReaction(nodeId, options.reaction, executeGh));
  if (comment.ok && reaction.ok) {
    write(JSON.stringify({ reaction: reaction.value, comment: comment.value }));
    return true;
  }
  const result = { status: "partial", reaction, comment };
  write(JSON.stringify(result));
  throw new Error(`GitHub acknowledgement partially completed: ${JSON.stringify(result)}`);
}

/** Apply a reaction and its explanation on the selected real review thread. */
function acknowledgeInline(options, executeGh) {
  const target = resolveTarget(options, executeGh);
  if (!options["comment-id"] || !options.body) {
    usage("acknowledge-inline requires --comment-id and --body.");
  }
  const reaction = addReaction(options["node-id"], options.reaction, executeGh);
  const reply = options.revision === undefined ? executeGh([
    "api", inlineReplyPath(target.repo, target.pr, options["comment-id"]),
    "-f", `body=${options.body}`,
  ]) : acknowledgementComment(target, options["node-id"], options.body, executeGh, options.revision, options["comment-id"]);
  return { reaction: JSON.parse(reaction), reply: JSON.parse(reply) };
}

/** Emit complete operation receipts; return a nonzero watch status when merge readiness is unverified. */
export function main(argv = process.argv.slice(2), dependencies = {}) {
  const { command, options } = parseArgs(argv);
  const executeGh = dependencies.runGh ?? runGh;
  const write = dependencies.log ?? console.log;

  if (command === "inventory") {
    const target = resolveTarget(options, executeGh);
    const pullRequest = fetchReviewInventory(target, executeGh);
    write(JSON.stringify({ repository: target.repo, pullRequest }, null, 2));
  } else if (command === "watch") {
    const target = resolveTarget(options, executeGh);
    const interval = Number(options.interval ?? 30);
    const receipt = watchChecksAndInventory(target, interval, executeGh, options.phase);
    write(JSON.stringify(receipt, null, 2));
    return receipt.checkWatch.attempts.at(-1).outcome === "passed" ? 0 : 1;
  } else if (command === "react") {
    write(addReaction(options["node-id"], options.reaction, executeGh));
  } else if (handleTopLevelConversationWrite(command, options, executeGh, write)) {
    return;
  } else if (command === "reply-inline") {
    const target = resolveTarget(options, executeGh);
    if (!options["comment-id"] || !options.body) usage("reply-inline requires --comment-id and --body.");
    write(executeGh([
      "api", inlineReplyPath(target.repo, target.pr, options["comment-id"]),
      "-f", `body=${options.body}`,
    ]));
  } else if (command === "acknowledge-inline") {
    write(JSON.stringify(acknowledgeInline(options, executeGh)));
  } else {
    usage(`Unknown command: ${command}`);
  }
}

/** Preserve import purity and propagate direct watch failure only after its complete receipt is emitted. */
export function runCliIfDirect(argv = process.argv, moduleUrl = import.meta.url, executeMain = main) {
  if (argv[1] && moduleUrl === pathToFileURL(argv[1]).href) process.exitCode = executeMain() ?? 0;
}

runCliIfDirect();
