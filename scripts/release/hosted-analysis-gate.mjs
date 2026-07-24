#!/usr/bin/env node

/**
 * Verify that DeepScan and CodeFactor report zero new issues for the exact
 * current Git commit. The gate intentionally reads GitHub's commit-scoped
 * status and check-run APIs instead of trusting branch-level dashboards.
 */
import { spawnSync } from "node:child_process";

import { commandFor, flagBool, flagString, parseFlags } from "./utils.mjs";

const GH = commandFor("gh");
const GIT = commandFor("git");
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/i;

/** Run a command without a shell and retain bounded text output for validation. */
function runCaptured(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/** Emit one stable machine- or human-readable result and set the exit status. */
function report(outputJson, payload, exitCode) {
  if (outputJson) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else if (payload.ok) {
    console.log(
      `Hosted analysis gate passed for ${payload.repository}@${payload.sha.slice(0, 12)}: DeepScan 0 new issues; CodeFactor no issues found.`,
    );
  } else {
    console.error(`Hosted analysis gate failed: ${payload.reason}`);
  }
  process.exitCode = exitCode;
}

/** Parse a GitHub API response while rejecting arrays and primitive payloads. */
function parseObject(stdout, source) {
  try {
    const parsed = JSON.parse(stdout);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, reason: `${source} returned a non-object JSON payload` };
    }
    return { ok: true, value: parsed };
  } catch {
    return { ok: false, reason: `${source} returned invalid JSON` };
  }
}

/** Resolve and validate the repository name without accepting URL fragments. */
function resolveRepository(explicitRepository) {
  if (explicitRepository !== null) {
    return REPOSITORY_PATTERN.test(explicitRepository)
      ? { ok: true, value: explicitRepository }
      : { ok: false, reason: `invalid --repo value "${explicitRepository}"; expected owner/name` };
  }
  const result = runCaptured(GH, ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
  const value = result.stdout.trim();
  if (result.status !== 0 || !REPOSITORY_PATTERN.test(value)) {
    return { ok: false, reason: "unable to resolve the GitHub repository with gh repo view" };
  }
  return { ok: true, value };
}

/** Resolve and validate a full commit SHA so abbreviated or branch refs cannot drift. */
function resolveSha(explicitSha) {
  if (explicitSha !== null) {
    return SHA_PATTERN.test(explicitSha)
      ? { ok: true, value: explicitSha.toLowerCase() }
      : { ok: false, reason: `invalid --sha value "${explicitSha}"; expected a full 40-character commit SHA` };
  }
  const result = runCaptured(GIT, ["rev-parse", "HEAD"]);
  const value = result.stdout.trim();
  if (result.status !== 0 || !SHA_PATTERN.test(value)) {
    return { ok: false, reason: "unable to resolve the current Git HEAD" };
  }
  return { ok: true, value: value.toLowerCase() };
}

/** Validate the newest DeepScan commit status and return its bounded summary. */
function inspectDeepScan(statusPayload) {
  const statuses = Array.isArray(statusPayload.statuses) ? statusPayload.statuses : [];
  const deepScan = statuses.find((entry) => entry?.context === "DeepScan");
  if (deepScan === undefined) {
    return { ok: false, reason: "DeepScan status is missing for the exact commit" };
  }
  const deepScanState = typeof deepScan.state === "string" ? deepScan.state : "";
  const deepScanDescription = typeof deepScan.description === "string" ? deepScan.description : "";
  if (deepScanState !== "success") {
    return {
      ok: false,
      reason: `DeepScan is not successful (${deepScanState || "unknown"}: ${deepScanDescription || "no description"})`,
    };
  }
  if (!/\b0 new\b/i.test(deepScanDescription)) {
    return { ok: false, reason: "DeepScan success does not explicitly prove 0 new issues" };
  }
  return {
    ok: true,
    analyzer: {
      state: deepScanState,
      description: deepScanDescription,
      new_issues: 0,
    },
  };
}

/** Validate the newest CodeFactor check run and return its bounded summary. */
function inspectCodeFactor(checksPayload) {
  const checkRuns = Array.isArray(checksPayload.check_runs) ? checksPayload.check_runs : [];
  const codeFactor = checkRuns.find((entry) => entry?.name === "CodeFactor");
  if (codeFactor === undefined) {
    return { ok: false, reason: "CodeFactor check run is missing for the exact commit" };
  }
  const codeFactorStatus = typeof codeFactor.status === "string" ? codeFactor.status : "";
  const codeFactorConclusion = typeof codeFactor.conclusion === "string" ? codeFactor.conclusion : "";
  if (codeFactorStatus !== "completed") {
    return { ok: false, reason: `CodeFactor is not complete (${codeFactorStatus || "unknown"})` };
  }
  if (codeFactorConclusion !== "success") {
    return { ok: false, reason: `CodeFactor did not succeed (${codeFactorConclusion || "unknown"})` };
  }
  const codeFactorTitle = typeof codeFactor.output?.title === "string" ? codeFactor.output.title : "";
  if (!/^no issues found\.?$/i.test(codeFactorTitle.trim())) {
    return { ok: false, reason: "CodeFactor success does not explicitly report No issues found" };
  }

  return {
    ok: true,
    analyzer: {
      status: codeFactorStatus,
      conclusion: codeFactorConclusion,
      title: codeFactorTitle,
      new_issues: 0,
    },
  };
}

/** Verify that both analyzer contexts are strict required checks on main. */
function inspectBranchProtection(protectionPayload) {
  const requiredStatusChecks = protectionPayload.required_status_checks;
  if (requiredStatusChecks === null || typeof requiredStatusChecks !== "object") {
    return { ok: false, reason: "main branch protection has no required status checks" };
  }
  if (requiredStatusChecks.strict !== true) {
    return { ok: false, reason: "main branch protection does not require branches to be up to date" };
  }
  const contexts = Array.isArray(requiredStatusChecks.contexts) ? requiredStatusChecks.contexts : [];
  const checks = Array.isArray(requiredStatusChecks.checks) ? requiredStatusChecks.checks : [];
  const requiredContexts = new Set([
    ...contexts.filter((context) => typeof context === "string"),
    ...checks
      .map((check) => check?.context)
      .filter((context) => typeof context === "string"),
  ]);
  const missing = ["CodeFactor", "DeepScan"].filter((context) => !requiredContexts.has(context));
  if (missing.length > 0) {
    return { ok: false, reason: `main branch protection is missing required analyzer checks: ${missing.join(", ")}` };
  }
  return {
    ok: true,
    branch: "main",
    strict: true,
    required_analyzers: ["CodeFactor", "DeepScan"],
  };
}

/** Execute the exact-head hosted analyzer gate. */
function main() {
  const { flags } = parseFlags(process.argv.slice(2));
  if (flags.get("help") || flags.get("h")) {
    console.log(
      "Usage: node scripts/release/hosted-analysis-gate.mjs [--json] [--repo owner/name] [--sha <40-character-sha>]",
    );
    return;
  }

  const outputJson = flagBool(flags, "json", false);
  const repository = resolveRepository(flagString(flags, "repo", null));
  if (!repository.ok) {
    report(outputJson, repository, 1);
    return;
  }
  const sha = resolveSha(flagString(flags, "sha", null));
  if (!sha.ok) {
    report(outputJson, { ...sha, repository: repository.value }, 1);
    return;
  }

  const statusResult = runCaptured(GH, ["api", `repos/${repository.value}/commits/${sha.value}/status`]);
  if (statusResult.status !== 0) {
    report(
      outputJson,
      { ok: false, repository: repository.value, sha: sha.value, reason: "unable to read commit statuses with gh api" },
      1,
    );
    return;
  }
  const checksResult = runCaptured(GH, [
    "api",
    `repos/${repository.value}/commits/${sha.value}/check-runs?per_page=100`,
  ]);
  if (checksResult.status !== 0) {
    report(
      outputJson,
      { ok: false, repository: repository.value, sha: sha.value, reason: "unable to read check runs with gh api" },
      1,
    );
    return;
  }
  const protectionResult = runCaptured(GH, [
    "api",
    `repos/${repository.value}/branches/main/protection`,
  ]);
  if (protectionResult.status !== 0) {
    report(
      outputJson,
      { ok: false, repository: repository.value, sha: sha.value, reason: "unable to read main branch protection with gh api" },
      1,
    );
    return;
  }

  const statusPayload = parseObject(statusResult.stdout, "GitHub commit status API");
  if (!statusPayload.ok) {
    report(outputJson, { ...statusPayload, repository: repository.value, sha: sha.value }, 1);
    return;
  }
  const checksPayload = parseObject(checksResult.stdout, "GitHub check-runs API");
  if (!checksPayload.ok) {
    report(outputJson, { ...checksPayload, repository: repository.value, sha: sha.value }, 1);
    return;
  }
  const protectionPayload = parseObject(protectionResult.stdout, "GitHub branch protection API");
  if (!protectionPayload.ok) {
    report(outputJson, { ...protectionPayload, repository: repository.value, sha: sha.value }, 1);
    return;
  }

  const deepScan = inspectDeepScan(statusPayload.value);
  if (!deepScan.ok) {
    report(outputJson, { ...deepScan, repository: repository.value, sha: sha.value }, 1);
    return;
  }
  const codeFactor = inspectCodeFactor(checksPayload.value);
  if (!codeFactor.ok) {
    report(outputJson, { ...codeFactor, repository: repository.value, sha: sha.value }, 1);
    return;
  }
  const branchProtection = inspectBranchProtection(protectionPayload.value);
  if (!branchProtection.ok) {
    report(outputJson, { ...branchProtection, repository: repository.value, sha: sha.value }, 1);
    return;
  }
  report(
    outputJson,
    {
      ok: true,
      repository: repository.value,
      sha: sha.value,
      analyzers: {
        deepscan: deepScan.analyzer,
        codefactor: codeFactor.analyzer,
      },
      branch_protection: {
        branch: branchProtection.branch,
        strict: branchProtection.strict,
        required_analyzers: branchProtection.required_analyzers,
      },
    },
    0,
  );
}

main();
