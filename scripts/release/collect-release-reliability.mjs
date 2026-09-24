/**
 * Read-only GitHub adapter for the release reliability evaluator. Pagination is
 * a finite census, never status polling. It fetches original attempts so a green
 * rerun cannot overwrite a red schedule. Expired receipts remain unknown.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { evaluateReleaseReliability, validateReliabilityPolicy } from "./release-reliability.mjs";

/** Run bounded, non-shell GitHub CLI reads; API and JSON errors fail the census. */
function github(args) {
  return execFileSync("gh", args, { encoding: "utf8", timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
}

/** Decode a paginated response and refuse server-side truncation or duplicate rows. */
export function completePages(raw, field) {
  const pages = JSON.parse(raw);
  if (!Array.isArray(pages) || pages.length === 0) throw new Error("Missing GitHub pages.");
  const rows = [];
  for (const page of pages) {
    if (!Array.isArray(page[field]) || !Number.isSafeInteger(page.total_count)) throw new Error("Malformed GitHub census.");
    rows.push(...page[field]);
  }
  if (rows.length !== pages[0].total_count || new Set(rows.map((row) => row.id)).size !== rows.length) {
    throw new Error("Incomplete or duplicated GitHub census.");
  }
  return rows;
}

/** Validate receipt provenance against the immutable run attempt it describes. */
export function validateReleaseObservation(value, run) {
  if (value?.schema !== "release-observation/1" || value.run_id !== run.id || value.run_attempt !== 1 || value.event !== run.event) {
    throw new Error("Release observation identity mismatch.");
  }
  if (typeof value.outcome !== "string" || (value.failure_stage !== null && typeof value.failure_stage !== "string")) {
    throw new Error("Malformed release observation.");
  }
  return { outcome: value.outcome, failure_stage: value.failure_stage };
}

/** Collect one original attempt and its optional structured outcome artifact. */
function originalAttempt(listed, repository, read, root) {
  const base = `repos/${repository}/actions/runs/${listed.id}`;
  const run = listed.run_attempt === 1 ? listed : JSON.parse(read(["api", `${base}/attempts/1`]));
  if (run.id !== listed.id || run.run_attempt !== 1 || run.event !== "schedule") throw new Error("Original attempt mismatch.");
  const artifacts = completePages(read(["api", `${base}/artifacts?per_page=100`, "--paginate", "--slurp"]), "artifacts");
  const receiptName = "release-observation-1";
  const candidates = artifacts.filter((artifact) => artifact.name === receiptName && !artifact.expired);
  if (candidates.length > 1) throw new Error("Ambiguous release observation artifacts.");
  if (candidates.length === 1) {
    const directory = path.join(root, String(run.id));
    read(["run", "download", String(run.id), "--repo", repository, "--name", receiptName, "--dir", directory]);
    Object.assign(run, validateReleaseObservation(JSON.parse(readFileSync(path.join(directory, "release-observation.json"), "utf8")), run));
  }
  if (run.status === "completed" && run.conclusion !== "success" && !run.failure_stage) {
    const jobs = completePages(read(["api", `${base}/attempts/1/jobs?per_page=100`, "--paginate", "--slurp"]), "jobs");
    run.failure_stage = jobs.flatMap((job) => job.steps.filter((step) => step.conclusion === "failure").map((step) => `${job.name} / ${step.name}`)).join("; ") || "unrecorded";
  }
  return run;
}

/**
 * Collect the entire bounded UTC window and evaluate it. A temporary owned root
 * contains data-only artifacts; no downloaded file is imported or executed.
 */
export function collectReleaseReliability(repository, policy, now, read = github) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*\/[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u.test(repository)) throw new Error("Invalid repository.");
  validateReliabilityPolicy(policy);
  const end = new Date(now);
  const start = new Date(end.getTime() - policy.window_days * 86_400_000).toISOString();
  const query = new URLSearchParams({ event: "schedule", per_page: "100", created: `${start}..${end.toISOString()}` });
  const listed = completePages(read(["api", `repos/${repository}/actions/workflows/auto-release.yml/runs?${query}`, "--paginate", "--slurp"]), "workflow_runs");
  const root = mkdtempSync(path.join(tmpdir(), "pm-release-reliability-"));
  try {
    const runs = listed.map((run) => originalAttempt(run, repository, read, root));
    return { ...evaluateReleaseReliability(runs, policy, now), repository, census_complete: true };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Write the replayable JSON report before enforcing the operational policy. */
export function main(env = process.env, read = github) {
  const policy = JSON.parse(readFileSync("config/release-reliability-policy.json", "utf8"));
  const report = collectReleaseReliability(env.GITHUB_REPOSITORY, policy, new Date().toISOString(), read);
  writeFileSync(env.RELEASE_RELIABILITY_OUTPUT, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}
