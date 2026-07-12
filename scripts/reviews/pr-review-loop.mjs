#!/usr/bin/env node

import { execFileSync } from "node:child_process";

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

function parseArgs(argv) {
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

function resolveTarget(options) {
  const repo = options.repo ?? JSON.parse(runGh(["repo", "view", "--json", "nameWithOwner"])).nameWithOwner;
  const pr = Number(options.pr ?? JSON.parse(runGh(["pr", "view", "--json", "number"])).number);
  if (!repo.includes("/") || !Number.isInteger(pr) || pr <= 0) usage("A valid repository and PR are required.");
  const [owner, name] = repo.split("/");
  return { repo, owner, name, pr };
}

const inventoryQuery = `
query ReviewInventory($owner: String!, $name: String!, $pr: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $pr) {
      number url headRefOid updatedAt
      comments(first: 100) {
        nodes { id databaseId author { login } body createdAt updatedAt reactionGroups { content users { totalCount } viewerHasReacted } }
      }
      reviews(first: 100) {
        nodes { id databaseId author { login } body state submittedAt updatedAt reactionGroups { content users { totalCount } viewerHasReacted } }
      }
      reviewThreads(first: 100) {
        nodes {
          id isResolved isOutdated path line originalLine
          comments(first: 100) {
            nodes { id databaseId author { login } body createdAt updatedAt reactionGroups { content users { totalCount } viewerHasReacted } }
          }
        }
      }
    }
  }
}`;

const { command, options } = parseArgs(process.argv.slice(2));

if (command === "inventory") {
  const target = resolveTarget(options);
  const raw = runGh([
    "api", "graphql",
    "-f", `query=${inventoryQuery}`,
    "-F", `owner=${target.owner}`,
    "-F", `name=${target.name}`,
    "-F", `pr=${target.pr}`,
  ]);
  const payload = JSON.parse(raw);
  const pullRequest = payload.data.repository.pullRequest;
  console.log(JSON.stringify({ repository: target.repo, pullRequest }, null, 2));
} else if (command === "react") {
  if (!options["node-id"] || !options.reaction) usage("react requires --node-id and --reaction.");
  const mutation = `mutation($subjectId: ID!, $content: ReactionContent!) {
    addReaction(input: { subjectId: $subjectId, content: $content }) { reaction { content } }
  }`;
  console.log(runGh([
    "api", "graphql", "-f", `query=${mutation}`,
    "-F", `subjectId=${options["node-id"]}`, "-F", `content=${options.reaction}`,
  ]));
} else if (command === "reply-inline") {
  const target = resolveTarget(options);
  if (!options["comment-id"] || !options.body) usage("reply-inline requires --comment-id and --body.");
  console.log(runGh([
    "api", `repos/${target.repo}/pulls/${target.pr}/comments/${options["comment-id"]}/replies`,
    "-f", `body=${options.body}`,
  ]));
} else if (command === "reply-top") {
  const target = resolveTarget(options);
  if (!options.body) usage("reply-top requires --body.");
  console.log(runGh(["pr", "comment", String(target.pr), "--repo", target.repo, "--body", options.body]));
} else {
  usage(`Unknown command: ${command}`);
}
