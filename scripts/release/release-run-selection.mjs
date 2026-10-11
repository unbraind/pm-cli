#!/usr/bin/env node
/**
 * @module release-run-selection
 *
 * Selects the authoritative GitHub Release workflow run for one immutable tag.
 * Tag-push runs prove identity through their branch and commit SHA. Dispatch
 * runs prove identity through the workflow's tag-bearing run name or an
 * explicit run id whose archived log was independently matched to RELEASE_TAG.
 * A completed success is durable publication evidence and therefore wins over
 * stale failures; without one, an active run wins over the latest terminal run.
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Schema tag for machine-readable selection receipts. */
export const RELEASE_RUN_SELECTION_SCHEMA = "release-run-selection/1";

const ACTIVE_STATUSES = new Set([
  "pending",
  "queued",
  "requested",
  "waiting",
  "in_progress",
]);

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function numericRunId(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function timestamp(value) {
  const parsed = Date.parse(text(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizedCandidate(value) {
  if (value === null || typeof value !== "object") {
    return null;
  }
  const databaseId = numericRunId(value.databaseId);
  const createdAtMs = timestamp(value.createdAt);
  if (databaseId === null || createdAtMs === null) {
    return null;
  }
  return {
    database_id: databaseId,
    status: text(value.status),
    conclusion: text(value.conclusion),
    event: text(value.event),
    head_branch: text(value.headBranch),
    head_sha: text(value.headSha).toLowerCase(),
    display_title: text(value.displayTitle),
    created_at: text(value.createdAt),
    created_at_ms: createdAtMs,
  };
}

function validateOptions(options) {
  const tag = text(options?.tag);
  const tagSha = text(options?.tagSha).toLowerCase();
  const defaultBranch = text(options?.defaultBranch);
  if (!/^v\d{4}\.\d{1,2}\.\d{1,2}$/u.test(tag)) {
    throw new Error("Expected an exact release tag with vYYYY.M.D shape.");
  }
  if (!/^[0-9a-f]{40}$/u.test(tagSha)) {
    throw new Error("Expected a 40-character tag commit SHA.");
  }
  if (defaultBranch === "") {
    throw new Error("Expected a non-empty default branch.");
  }
  const createdAfterText = text(options?.createdAfter);
  const createdAfter =
    createdAfterText === "" ? null : timestamp(createdAfterText);
  if (createdAfterText !== "" && createdAfter === null) {
    throw new Error("Expected --created-after to be a valid timestamp.");
  }
  return {
    tag,
    tagSha,
    defaultBranch,
    createdAfter,
    dispatchRunIds:
      options?.dispatchRunIds instanceof Set
        ? options.dispatchRunIds
        : new Set(),
  };
}

function isExactCandidate(candidate, options) {
  if (
    options.createdAfter !== null &&
    candidate.created_at_ms < options.createdAfter
  ) {
    return false;
  }
  if (candidate.event === "push") {
    return (
      candidate.head_branch === options.tag &&
      candidate.head_sha === options.tagSha
    );
  }
  if (candidate.event !== "workflow_dispatch") {
    return false;
  }
  if (candidate.head_branch !== options.defaultBranch) {
    return false;
  }
  return (
    candidate.display_title === `Release ${options.tag}` ||
    ["operator", "morning_dispatcher", "native_schedule", "blocker_retry"].some(
      (origin) => candidate.display_title === `Release ${options.tag} (${origin})`,
    ) ||
    options.dispatchRunIds.has(candidate.database_id)
  );
}

function newest(candidates) {
  return [...candidates].sort(
    (left, right) =>
      right.created_at_ms - left.created_at_ms ||
      right.database_id - left.database_id,
  )[0];
}

function publicCandidate(candidate) {
  if (candidate === undefined) {
    return null;
  }
  const { created_at_ms: _createdAtMs, ...publicFields } = candidate;
  return publicFields;
}

/**
 * Select the authoritative run for an immutable release tag.
 *
 * Completed success is final publication evidence, so it has precedence over
 * active and failed runs. If publication has not succeeded, the newest active
 * run is safe to watch; only then does the newest terminal run become the
 * diagnostic candidate that must be replaced by a current-workflow dispatch.
 */
export function selectAuthoritativeReleaseRun(runs, options) {
  const validated = validateOptions(options);
  const matched = runs
    .map(normalizedCandidate)
    .filter(
      (candidate) =>
        candidate !== null && isExactCandidate(candidate, validated),
    );
  const successful = newest(
    matched.filter(
      (candidate) =>
        candidate.status === "completed" && candidate.conclusion === "success",
    ),
  );
  const active = newest(
    matched.filter((candidate) => ACTIVE_STATUSES.has(candidate.status)),
  );
  const terminal = newest(matched);
  const selected = successful ?? active ?? terminal;
  const reason = successful
    ? "successful_run"
    : active
      ? "active_run"
      : terminal
        ? "latest_terminal_run"
        : "no_matching_run";
  return {
    schema: RELEASE_RUN_SELECTION_SCHEMA,
    tag: validated.tag,
    tag_sha: validated.tagSha,
    default_branch: validated.defaultBranch,
    matched_count: matched.length,
    reason,
    selected: publicCandidate(selected),
  };
}

/** Require a complete, structurally valid inventory before matching release identity. */
function validatePublicationInventory(runs) {
  if (!Array.isArray(runs) || runs.length >= 1000 || runs.some((run) =>
    normalizedCandidate(run) === null || !["push", "workflow_dispatch"].includes(run.event) ||
    !/^[0-9a-f]{40}$/u.test(text(run.headSha)) || text(run.headBranch) === "" ||
    text(run.status) === "" || (run.event === "workflow_dispatch" && typeof run.displayTitle !== "string"))) {
    throw new Error("Incomplete or malformed Release workflow inventory; publication admission refused.");
  }
}

/** Require authoritative run-attempt identity on every canonical publication job. */
function publicationJobCandidates(pages, runId) {
  if (!Array.isArray(pages) || pages.length === 0 || pages.some((page) => !Array.isArray(page?.jobs))) {
    throw new Error("Malformed Release job evidence; publication admission refused.");
  }
  const candidates = pages.flatMap((page) => page.jobs).filter((job) => job?.name === "Build, Test, Publish");
  if (candidates.length === 0 || candidates.some((job) => job.run_id !== runId || !numericRunId(job.run_attempt))) {
    throw new Error("Missing or mismatched Release job-attempt identity; publication admission refused.");
  }
  return candidates;
}

/** Require a known publication stage with complete step status and terminal conclusions. */
function validPublicationSteps(job) {
  return Array.isArray(job.steps) && job.steps.some((step) => step?.name === "Publish to npm") &&
    job.steps.every((step) => step && text(step.name) !== "" &&
      ["queued", "in_progress", "completed"].includes(step.status) &&
      (step.status !== "completed" || ["success", "failure", "neutral", "cancelled", "skipped",
        "timed_out", "action_required", "stale", "startup_failure"].includes(step.conclusion)));
}

/** Refuse first-publication recovery when any exact-tag attempt already accepted npm publication. */
export function assertNoAcceptedPublication(runs, options, loadJobs) {
  validateOptions(options);
  if (options.currentRunId !== undefined && (!numericRunId(options.currentRunId) || !numericRunId(options.currentAttempt))) {
    throw new Error("Invalid current run-attempt identity; publication admission refused.");
  }
  validatePublicationInventory(runs);
  for (const run of runs) {
    if (!selectAuthoritativeReleaseRun([run], options).selected) continue;
    const candidates = publicationJobCandidates(loadJobs(run.databaseId), run.databaseId);
    const jobs = candidates.filter((job) => !(job.run_id === options.currentRunId && job.run_attempt === options.currentAttempt));
    if (jobs.some((job) => !validPublicationSteps(job))) {
      throw new Error("Missing Release publication job evidence; publication admission refused.");
    }
    if (jobs.some((job) => job.steps.some((step) => step?.name === "Publish to npm" &&
      step.status === "completed" && step.conclusion === "success"))) {
      throw new Error(`npm publication was previously accepted by exact-tag Release run ${run.databaseId}; wait for public availability or inspect npm processing before recovery.`);
    }
  }
}

/** Inspect complete earlier attempts from the authoritative Release workflow before allowing first publication. */
export function rejectAcceptedPublication(argv = process.argv.slice(2), env = process.env, execute = execFileSync) {
  const repository = text(env.GITHUB_REPOSITORY);
  if (!/^[\w.-]+\/[\w.-]+$/u.test(repository)) throw new Error("Expected an explicit GitHub repository.");
  const options = {
    tag: flagValue(argv, "tag"), tagSha: flagValue(argv, "tag-sha"), defaultBranch: flagValue(argv, "default-branch"),
    currentRunId: env.GITHUB_RUN_ID === undefined ? undefined : Number(env.GITHUB_RUN_ID),
    currentAttempt: env.GITHUB_RUN_ATTEMPT === undefined ? undefined : Number(env.GITHUB_RUN_ATTEMPT),
  };
  validateOptions(options);
  const command = (args) => JSON.parse(execute("gh", args, { encoding: "utf8", timeout: 60_000, maxBuffer: 64 * 1024 * 1024 }));
  const runs = command(["run", "list", "--repo", repository, "--workflow", "release.yml", "--limit", "1000", "--json", "databaseId,createdAt,status,conclusion,event,headBranch,headSha,displayTitle"]);
  assertNoAcceptedPublication(runs, options, (id) => command([
    "api", `repos/${repository}/actions/runs/${id}/jobs?filter=all&per_page=100`, "--paginate", "--slurp",
  ]));
}

function flagValue(argv, name) {
  const index = argv.indexOf(`--${name}`);
  const value = index >= 0 ? argv[index + 1] : undefined;
  return text(value);
}

function dispatchIds(value) {
  return new Set(
    text(value)
      .split(",")
      .map((entry) => Number(entry.trim()))
      .filter((entry) => Number.isSafeInteger(entry) && entry > 0),
  );
}

/** Parse CLI input, write the JSON receipt, and return it for direct tests. */
export function main(
  argv = process.argv.slice(2),
  input = readFileSync(0, "utf8"),
  write = process.stdout.write.bind(process.stdout),
) {
  const tag = flagValue(argv, "tag");
  const tagSha = flagValue(argv, "tag-sha");
  const defaultBranch = flagValue(argv, "default-branch");
  if (tag === "") {
    throw new Error("Missing --tag <vYYYY.M.D>.");
  }
  if (tagSha === "") {
    throw new Error("Missing --tag-sha <commit-sha>.");
  }
  if (defaultBranch === "") {
    throw new Error("Missing --default-branch <branch>.");
  }
  const runs = JSON.parse(input);
  if (!Array.isArray(runs)) {
    throw new Error("Expected stdin to contain a JSON array of workflow runs.");
  }
  const result = selectAuthoritativeReleaseRun(runs, {
    tag,
    tagSha,
    defaultBranch,
    createdAfter: flagValue(argv, "created-after"),
    dispatchRunIds: dispatchIds(flagValue(argv, "dispatch-run-ids")),
  });
  write(`${JSON.stringify(result)}\n`);
  return result;
}

/* c8 ignore start -- the CLI wrapper is exercised by workflow integration; unit tests call main directly */
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.includes("--reject-accepted-publication")) rejectAcceptedPublication();
    else main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
/* c8 ignore stop */
