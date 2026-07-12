#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

function runGh(args, input) {
  return execFileSync("gh", args, {
    encoding: "utf8",
    input,
    stdio: [input === undefined ? "inherit" : "pipe", "pipe", "inherit"],
  }).trim();
}

function usage(message) {
  if (message) console.error(message);
  console.error(`Usage:
  node scripts/reviews/pr-review-loop.mjs inventory [--pr <number>] [--repo <owner/name>]
  node scripts/reviews/pr-review-loop.mjs react --node-id <id> --reaction <THUMBS_UP|THUMBS_DOWN|...>
  node scripts/reviews/pr-review-loop.mjs reply-inline --comment-id <id> --body <text> [--pr <number>] [--repo <owner/name>]
  node scripts/reviews/pr-review-loop.mjs reply-top --body <text> [--pr <number>] [--repo <owner/name>]`);
  process.exit(2);
}

export function parseArgs(argv) {
  const [command = "inventory", ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!flag?.startsWith("--") || value === undefined) usage(`Invalid argument: ${flag ?? ""}`);
    options[flag.slice(2)] = value;
  }
  return { command, options };
}

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
      number url headRefOid updatedAt
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

function graphql(executeGh, query, variables) {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [key, value] of Object.entries(variables)) {
    if (value !== undefined && value !== null) args.push("-F", `${key}=${value}`);
  }
  return JSON.parse(executeGh(args));
}

export function fetchReviewInventory(target, executeGh = runGh) {
  const comments = [];
  const reviews = [];
  const reviewThreads = [];
  const cursors = { commentCursor: undefined, reviewCursor: undefined, threadCursor: undefined };
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
      updatedAt: page.updatedAt,
    };
    comments.push(...page.comments.nodes);
    reviews.push(...page.reviews.nodes);
    reviewThreads.push(...page.reviewThreads.nodes);
    const connections = [page.comments, page.reviews, page.reviewThreads];
    [cursors.commentCursor, cursors.reviewCursor, cursors.threadCursor] = connections.map(
      (connection) => connection.pageInfo.endCursor,
    );
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
    comments: { nodes: comments },
    reviews: { nodes: reviews },
    reviewThreads: { nodes: reviewThreads },
  };
}

export function inlineReplyPath(repo, pr, commentId) {
  return `repos/${repo}/pulls/${pr}/comments/${commentId}/replies`;
}

export function main(argv = process.argv.slice(2), dependencies = {}) {
  const { command, options } = parseArgs(argv);
  const executeGh = dependencies.runGh ?? runGh;
  const write = dependencies.log ?? console.log;

  if (command === "inventory") {
    const target = resolveTarget(options, executeGh);
    const pullRequest = fetchReviewInventory(target, executeGh);
    write(JSON.stringify({ repository: target.repo, pullRequest }, null, 2));
  } else if (command === "react") {
    if (!options["node-id"] || !options.reaction) usage("react requires --node-id and --reaction.");
    const mutation = `mutation($subjectId: ID!, $content: ReactionContent!) {
    addReaction(input: { subjectId: $subjectId, content: $content }) { reaction { content } }
  }`;
    write(executeGh([
      "api", "graphql", "-f", `query=${mutation}`,
      "-F", `subjectId=${options["node-id"]}`, "-F", `content=${options.reaction}`,
    ]));
  } else if (command === "reply-inline") {
    const target = resolveTarget(options, executeGh);
    if (!options["comment-id"] || !options.body) usage("reply-inline requires --comment-id and --body.");
    write(executeGh([
      "api", inlineReplyPath(target.repo, target.pr, options["comment-id"]),
      "-f", `body=${options.body}`,
    ]));
  } else if (command === "reply-top") {
    const target = resolveTarget(options, executeGh);
    if (!options.body) usage("reply-top requires --body.");
    write(executeGh(["pr", "comment", String(target.pr), "--repo", target.repo, "--body", options.body]));
  } else {
    usage(`Unknown command: ${command}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
