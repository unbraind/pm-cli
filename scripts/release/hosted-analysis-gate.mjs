#!/usr/bin/env node

/**
 * Verify that DeepScan and CodeFactor report zero new issues for the current
 * Git tree. GitHub-created merge commits may reuse analyzer evidence from
 * their reviewed second parent only when both commits have an identical tree.
 * The gate reads commit-scoped APIs instead of branch-level dashboards.
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
      `Hosted analysis gate passed for ${payload.repository}@${payload.sha.slice(0, 12)}: DeepScan 0 new issues; CodeFactor 0 outstanding annotations.`,
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
  const codeFactorAnnotationCount = codeFactor.output?.annotations_count;
  if (codeFactorAnnotationCount !== 0) {
    return {
      ok: false,
      reason: `CodeFactor does not explicitly report 0 outstanding annotations (${typeof codeFactorAnnotationCount === "number" ? codeFactorAnnotationCount : "unknown"})`,
    };
  }
  const codeFactorTitle = typeof codeFactor.output?.title === "string" ? codeFactor.output.title : "";
  if (!/^(?:no issues found|\d+ issues? fixed)\.?$/i.test(codeFactorTitle.trim())) {
    return { ok: false, reason: "CodeFactor success title does not explicitly report no issues or fixed-only results" };
  }

  return {
    ok: true,
    analyzer: {
      status: codeFactorStatus,
      conclusion: codeFactorConclusion,
      title: codeFactorTitle,
      outstanding_annotations: codeFactorAnnotationCount,
      new_issues: 0,
    },
  };
}

/** Read and parse both hosted analyzer payloads for one immutable commit. */
function readAnalyzerEvidence(repository, sha) {
  const statusResult = runCaptured(GH, ["api", `repos/${repository}/commits/${sha}/status`]);
  if (statusResult.status !== 0) {
    return { ok: false, reason: "unable to read commit statuses with gh api" };
  }
  const checksResult = runCaptured(GH, [
    "api",
    `repos/${repository}/commits/${sha}/check-runs?per_page=100`,
  ]);
  if (checksResult.status !== 0) {
    return { ok: false, reason: "unable to read check runs with gh api" };
  }
  const statusPayload = parseObject(statusResult.stdout, "GitHub commit status API");
  if (!statusPayload.ok) {
    return statusPayload;
  }
  const checksPayload = parseObject(checksResult.stdout, "GitHub check-runs API");
  if (!checksPayload.ok) {
    return checksPayload;
  }
  return {
    ok: true,
    deepScan: inspectDeepScan(statusPayload.value),
    codeFactor: inspectCodeFactor(checksPayload.value),
  };
}

/** Read the immutable tree SHA for one GitHub commit. */
function readCommitTree(repository, sha) {
  const result = runCaptured(GH, ["api", `repos/${repository}/commits/${sha}`]);
  if (result.status !== 0) {
    return null;
  }
  const payload = parseObject(result.stdout, "GitHub commit API");
  const treeSha = payload.ok ? payload.value.commit?.tree?.sha : null;
  return typeof treeSha === "string" && SHA_PATTERN.test(treeSha) ? treeSha.toLowerCase() : null;
}

/** Resolve the unique reviewed PR head that GitHub squash-merged as this commit. */
function readSquashPullRequestHead(repository, sha) {
  const result = runCaptured(GH, ["api", `repos/${repository}/commits/${sha}/pulls?per_page=100`]);
  if (result.status !== 0) {
    return null;
  }
  let pullRequests;
  try {
    pullRequests = JSON.parse(result.stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(pullRequests)) {
    return null;
  }
  const candidates = pullRequests.filter(
    (pullRequest) =>
      pullRequest?.state === "closed" &&
      typeof pullRequest.merged_at === "string" &&
      pullRequest.merge_commit_sha?.toLowerCase() === sha &&
      pullRequest.base?.ref === "main" &&
      typeof pullRequest.head?.sha === "string" &&
      SHA_PATTERN.test(pullRequest.head.sha),
  );
  return candidates.length === 1 ? candidates[0].head.sha.toLowerCase() : null;
}

/** Resolve analyzer evidence from an immutable commit with identical-tree provenance. */
function resolveAnalyzerEvidence(repository, sha, initialEvidence) {
  const exact = {
    ...initialEvidence,
    analyzedSha: sha,
    analysisSource: "exact_commit",
  };
  const deepScanMissing =
    !initialEvidence.deepScan.ok &&
    initialEvidence.deepScan.reason.startsWith("DeepScan status is missing");
  const codeFactorMissing =
    !initialEvidence.codeFactor.ok &&
    initialEvidence.codeFactor.reason.startsWith("CodeFactor check run is missing");
  if (!deepScanMissing || !codeFactorMissing) {
    return exact;
  }
  const mergeParent = runCaptured(GIT, ["rev-parse", `${sha}^2`]);
  const exactTree = runCaptured(GIT, ["rev-parse", `${sha}^{tree}`]);
  const parentSha = mergeParent.stdout.trim().toLowerCase();
  if (mergeParent.status === 0 && SHA_PATTERN.test(parentSha) && exactTree.status === 0) {
    const parentTree = runCaptured(GIT, ["rev-parse", `${parentSha}^{tree}`]);
    if (parentTree.status === 0 && exactTree.stdout.trim() === parentTree.stdout.trim()) {
      const parentEvidence = readAnalyzerEvidence(repository, parentSha);
      if (parentEvidence.ok) {
        return {
          ...parentEvidence,
          analyzedSha: parentSha,
          analysisSource: "identical_tree_merge_parent",
        };
      }
    }
  }
  const squashHead = readSquashPullRequestHead(repository, sha);
  if (squashHead === null) {
    return exact;
  }
  const exactGitHubTree = readCommitTree(repository, sha);
  const squashHeadTree = readCommitTree(repository, squashHead);
  if (exactGitHubTree === null || squashHeadTree === null || exactGitHubTree !== squashHeadTree) {
    return exact;
  }
  const squashEvidence = readAnalyzerEvidence(repository, squashHead);
  return squashEvidence.ok
    ? {
        ...squashEvidence,
        analyzedSha: squashHead,
        analysisSource: "identical_tree_squash_pr_head",
      }
    : exact;
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

  const analyzerEvidence = readAnalyzerEvidence(repository.value, sha.value);
  if (!analyzerEvidence.ok) {
    report(outputJson, { ...analyzerEvidence, repository: repository.value, sha: sha.value }, 1);
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

  const protectionPayload = parseObject(protectionResult.stdout, "GitHub branch protection API");
  if (!protectionPayload.ok) {
    report(outputJson, { ...protectionPayload, repository: repository.value, sha: sha.value }, 1);
    return;
  }

  const resolvedEvidence = resolveAnalyzerEvidence(repository.value, sha.value, analyzerEvidence);
  const { deepScan, codeFactor } = resolvedEvidence;
  if (!deepScan.ok) {
    report(outputJson, { ...deepScan, repository: repository.value, sha: sha.value }, 1);
    return;
  }
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
      analyzed_sha: resolvedEvidence.analyzedSha,
      analysis_source: resolvedEvidence.analysisSource,
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
