/** Collect original nightly jobs and all-state alert evidence; never execute downloaded code. */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { parseDocument } from "yaml";
import { evaluateReliabilityWindow } from "@unbrained/pm-cli/sdk/governance";
import { completePages } from "./collect-release-reliability.mjs";

/** Execute bounded read-only GitHub requests with complete pagination. */
function github(args) {
  return execFileSync("gh", args, { encoding: "utf8", timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
}

/** Derive the expected leg population from the actual workflow rather than copying a matrix. */
export function nightlyFamilies(source) {
  const document = parseDocument(source);
  if (document.errors.length) throw new Error("Invalid nightly workflow.");
  const workflow = document.toJS();
  const matrix = workflow?.jobs?.nightly?.strategy?.matrix?.include;
  const quality = workflow?.jobs?.quality?.name;
  if (!Array.isArray(matrix)) throw new Error("Missing nightly family population.");
  const families = matrix.map((entry) => {
    if (entry.label !== undefined) return entry.label;
    if (typeof entry.os !== "string" || !/^\d+$/u.test(String(entry.node))) throw new Error("Invalid legacy nightly family identity.");
    return `Nightly (${entry.os}, Node ${entry.node})`;
  });
  if (quality !== undefined) families.push(quality);
  if (families.length === 0 || families.some((family) => typeof family !== "string" || !family.startsWith("Nightly ")) || new Set(families).size !== families.length) throw new Error("Invalid nightly family identity.");
  return families;
}

/** Resolve the alert's job family from stable legacy titles as well as current shard labels. */
function alertFamily(title, families) {
  const match = /^Nightly Validation failed: (\S+) \/ Node (\d+)(?: shard (\d+)\/(\d+)|( quality))?$/u.exec(title);
  if (!match) return null;
  const label = match[5]
    ? `Nightly quality (${match[1]}, Node ${match[2]})`
    : `Nightly (${match[1]}, Node ${match[2]}${match[3] ? `, shard ${match[3]}/${match[4]}` : ""})`;
  return families.includes(label) ? label : null;
}

/** Preserve closure as alert evidence, without relabeling it as a verified product repair. */
function alertEvidence(issue, family, text, links, repository, pmItems) {
  for (const match of text.matchAll(/https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/actions\/runs\/(\d+)(?!\d)/gu)) {
    if (match[1] !== repository) continue;
    const key = `${match[2]}:${family}`;
    const entry = links.get(key) ?? [];
    if (!entry.some((row) => row.number === issue.number)) entry.push({ number: issue.number, url: issue.html_url, closed_at: issue.closed_at, pm_items: pmItems });
    links.set(key, entry);
  }
}

/** Collect complete all-state issue and comment pages, including repaired occurrences. */
function collectAlertLinks(repository, start, families, read) {
  const search = new URLSearchParams({ q: `repo:${repository} is:issue "Nightly Validation failed:" in:title updated:>=${start}`, per_page: "100" });
  const issuePages = JSON.parse(read(["api", `search/issues?${search}`, "--paginate", "--slurp"]));
  if (!Array.isArray(issuePages) || issuePages.some((page) => page.incomplete_results !== false)) throw new Error("Incomplete nightly alert census.");
  const issues = completePages(JSON.stringify(issuePages), "items");
  const links = new Map();
  for (const issue of issues) {
    const family = alertFamily(issue.title, families);
    if (family === null) continue;
    const pages = JSON.parse(read(["api", `repos/${repository}/issues/${issue.number}/comments?per_page=100`, "--paginate", "--slurp"]));
    if (!Array.isArray(pages) || pages.length === 0 || pages.some((page) => !Array.isArray(page))) throw new Error("Incomplete nightly alert comments.");
    const comments = pages.flat();
    if (new Set(comments.map((row) => row.id)).size !== comments.length) throw new Error("Duplicate nightly alert comments.");
    const texts = [issue.body ?? "", ...comments.map((comment) => comment.body ?? "")];
    const pmItems = [...new Set(texts.flatMap((text) => [...text.matchAll(/https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/blob\/[^/\s)]+\/\.agents\/pm\/[^/\s)]+\/(pm-[\w-]+)\.toon/gu)].filter((match) => match[1] === repository).map((match) => match[2])))].sort();
    for (const text of texts) alertEvidence(issue, family, text, links, repository, pmItems);
  }
  return { links, alert_count: issues.length };
}

/** Preserve first-attempt jobs, including historical legs removed from today's matrix. */
function collectOriginalJobs(listed, repository, defaultBranch, read) {
  const populations = new Map();
  return listed.map((listedRun) => {
    const base = `repos/${repository}/actions/runs/${listedRun.id}`;
    const run = listedRun.run_attempt === 1 ? listedRun : JSON.parse(read(["api", `${base}/attempts/1`]));
    if (!Number.isSafeInteger(run.id) || run.id < 1 || run.id !== listedRun.id || run.run_attempt !== 1 || run.event !== "schedule" || run.head_branch !== defaultBranch || typeof run.head_sha !== "string" || !/^[a-f\d]{40}$/u.test(run.head_sha)) throw new Error("Nightly original attempt identity mismatch.");
    const jobs = completePages(read(["api", `${base}/attempts/1/jobs?per_page=100`, "--paginate", "--slurp"]), "jobs");
    let families = populations.get(run.head_sha);
    if (!families) {
      families = nightlyFamilies(read(["api", `repos/${repository}/contents/.github/workflows/nightly.yml?ref=${run.head_sha}`, "-H", "Accept: application/vnd.github.raw+json"]));
      populations.set(run.head_sha, families);
    }
    return { run, jobs, families };
  });
}

/** Correlate one original family job with its separately recorded alert closures. */
function nightlyAttempt(run, jobs, family, links) {
  const matches = jobs.filter((job) => job.name === family);
  if (matches.length > 1) throw new Error("Ambiguous nightly family jobs.");
  const job = matches[0];
  const id = `${run.id}:${family}`;
  const alerts = links.get(id) ?? [];
  const outcome = job?.status !== "completed" ? "pending" : job.conclusion === "success" ? "success" : "failure";
  const closures = alerts.map((alert) => alert.closed_at).filter((value) => typeof value === "string").sort();
  const allClosed = alerts.length > 0 && closures.length === alerts.length;
  return {
    attempt: { id, family, started_at: run.created_at, outcome, ...(outcome === "failure" && allClosed ? { repaired_at: closures.at(-1) } : {}) },
    evidence: { id, run_id: run.id, workflow_sha: run.head_sha, job_id: job?.id ?? null, alerts, cause: "unknown", repair_evidence: closures.length ? "alert_closure_only" : "unavailable" },
  };
}

/** Map original job outcomes to stable family occurrences and retain independent closure evidence. */
function nightlyAttempts(observed, links) {
  const attempts = [];
  const evidence = [];
  for (const { run, jobs, families } of observed) {
    const applicable = [...new Set([...families, ...jobs.map((job) => job.name).filter((name) => /^Nightly(?: quality)? \(/u.test(name))])];
    for (const family of applicable) {
      const row = nightlyAttempt(run, jobs, family, links);
      attempts.push(row.attempt);
      evidence.push(row.evidence);
    }
  }
  return { attempts, evidence };
}

/** Collect a complete first-attempt census and independently linked all-state alert closures. */
export function collectNightlyReliability(repository, policy, now, families, read = github) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*\/[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u.test(repository)) throw new Error("Invalid repository.");
  if (policy?.schema !== "nightly-reliability-policy/1" || !Number.isInteger(policy.window_days) || policy.window_days < 1 || policy.window_days > 90) throw new Error("Invalid nightly reliability policy.");
  const end = new Date(now).toISOString();
  const start = new Date(Date.parse(end) - policy.window_days * 86_400_000).toISOString();
  const sdkPolicy = { window_start: start, window_end: end, families, max_failure_rate: policy.max_failure_rate, min_completed_attempts: policy.min_completed_attempts };
  evaluateReliabilityWindow([], sdkPolicy);
  const defaultBranch = JSON.parse(read(["api", `repos/${repository}`])).default_branch;
  if (typeof defaultBranch !== "string" || !defaultBranch) throw new Error("Missing default branch.");
  const query = new URLSearchParams({ per_page: "100", event: "schedule", branch: defaultBranch, created: `${start}..${end}` });
  const listed = completePages(read(["api", `repos/${repository}/actions/workflows/nightly.yml/runs?${query}`, "--paginate", "--slurp"]), "workflow_runs");
  const observed = collectOriginalJobs(listed, repository, defaultBranch, read);
  const historical = observed.flatMap(({ jobs, families: expected }) => [...expected, ...jobs.map((job) => job.name).filter((name) => /^Nightly(?: quality)? \(/u.test(name))]);
  const population = [...new Set([...families, ...historical])];
  const { links, alert_count: alertCount } = collectAlertLinks(repository, start, population, read);
  const { attempts, evidence } = nightlyAttempts(observed, links);
  return {
    ...evaluateReliabilityWindow(attempts, { ...sdkPolicy, families: population }), repository, attempt: 1,
    census_complete: true, policy, attempts, evidence,
    repair_attribution: "alert_closure_only_not_verified_product_repair",
    alert_count: alertCount,
  };
}

/** Persist the complete replayable report before the workflow enforces its verdict. */
export function main(env = process.env, read = github) {
  const policy = JSON.parse(readFileSync("config/nightly-reliability-policy.json", "utf8"));
  const families = nightlyFamilies(readFileSync(".github/workflows/nightly.yml", "utf8"));
  const report = collectNightlyReliability(env.GITHUB_REPOSITORY, policy, new Date().toISOString(), families, read);
  writeFileSync(env.NIGHTLY_RELIABILITY_OUTPUT, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}
