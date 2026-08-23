#!/usr/bin/env node

/**
 * Verify that DeepScan and CodeFactor report zero new issues for the current
 * Git tree. GitHub-created merge commits may reuse analyzer evidence from
 * their reviewed second parent only when both commits have an identical tree.
 * A tagged automatic release commit may reuse its parent's evidence only when
 * its complete diff is the deterministic version/changelog transformation.
 * The gate reads commit-scoped APIs instead of branch-level dashboards.
 */
import { spawnSync } from "node:child_process";

import { commandFor, flagBool, flagString, parseFlags } from "./utils.mjs";

const GH = commandFor("gh");
const GIT = commandFor("git");
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const STABLE_RELEASE_PATTERN = /^([1-9]\d{3})\.([1-9]\d*)\.([1-9]\d*)$/u;
const RELEASE_COMMIT_BODY =
  "Automate daily release preparation with strict quality, compatibility, and reliability gates.";
const FIXED_RELEASE_MANIFESTS = [
  ".agents/plugins/marketplace.json",
  ".claude-plugin/marketplace.json",
  "marketplace.json",
  "package.json",
  "plugins/pm-claude/.claude-plugin/plugin.json",
  "plugins/pm-codex/.codex-plugin/plugin.json",
];
const WORKSPACE_MANIFEST_PATTERN = /^packages\/[^/]+\/package\.json$/u;
const RELEASE_PRECONDITION = {
  id: "reviewed_pull_request_analyzer_evidence",
  required_arrival: "reviewed_pull_request_to_main_or_exact_commit_analysis",
  direct_main_policy: "refuse_without_exact_commit_analyzer_evidence",
  generated_release_policy:
    "accept_only_exact_tagged_version_and_changelog_transform_from_analyzed_parent",
  required_analyzers: ["CodeFactor", "DeepScan"],
};

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
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return {
        ok: false,
        reason: `${source} returned a non-object JSON payload`,
      };
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
      : {
          ok: false,
          reason: `invalid --repo value "${explicitRepository}"; expected owner/name`,
        };
  }
  const result = runCaptured(GH, [
    "repo",
    "view",
    "--json",
    "nameWithOwner",
    "--jq",
    ".nameWithOwner",
  ]);
  const value = result.stdout.trim();
  if (result.status !== 0 || !REPOSITORY_PATTERN.test(value)) {
    return {
      ok: false,
      reason: "unable to resolve the GitHub repository with gh repo view",
    };
  }
  return { ok: true, value };
}

/** Resolve and validate a full commit SHA so abbreviated or branch refs cannot drift. */
function resolveSha(explicitSha) {
  if (explicitSha !== null) {
    return SHA_PATTERN.test(explicitSha)
      ? { ok: true, value: explicitSha.toLowerCase() }
      : {
          ok: false,
          reason: `invalid --sha value "${explicitSha}"; expected a full 40-character commit SHA`,
        };
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
  const statuses = Array.isArray(statusPayload.statuses)
    ? statusPayload.statuses
    : [];
  const deepScan = statuses.find((entry) => entry?.context === "DeepScan");
  if (deepScan === undefined) {
    return {
      ok: false,
      reason: "DeepScan status is missing for the exact commit",
    };
  }
  const deepScanState =
    typeof deepScan.state === "string" ? deepScan.state : "";
  const deepScanDescription =
    typeof deepScan.description === "string" ? deepScan.description : "";
  if (deepScanState !== "success") {
    return {
      ok: false,
      reason: `DeepScan is not successful (${deepScanState || "unknown"}: ${deepScanDescription || "no description"})`,
    };
  }
  if (!/\b0 new\b/i.test(deepScanDescription)) {
    return {
      ok: false,
      reason: "DeepScan success does not explicitly prove 0 new issues",
    };
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
  const checkRuns = Array.isArray(checksPayload.check_runs)
    ? checksPayload.check_runs
    : [];
  const codeFactor = checkRuns.find((entry) => entry?.name === "CodeFactor");
  if (codeFactor === undefined) {
    return {
      ok: false,
      reason: "CodeFactor check run is missing for the exact commit",
    };
  }
  const codeFactorStatus =
    typeof codeFactor.status === "string" ? codeFactor.status : "";
  const codeFactorConclusion =
    typeof codeFactor.conclusion === "string" ? codeFactor.conclusion : "";
  if (codeFactorStatus !== "completed") {
    return {
      ok: false,
      reason: `CodeFactor is not complete (${codeFactorStatus || "unknown"})`,
    };
  }
  if (codeFactorConclusion !== "success") {
    return {
      ok: false,
      reason: `CodeFactor did not succeed (${codeFactorConclusion || "unknown"})`,
    };
  }
  const codeFactorAnnotationCount = codeFactor.output?.annotations_count;
  if (codeFactorAnnotationCount !== 0) {
    return {
      ok: false,
      reason: `CodeFactor does not explicitly report 0 outstanding annotations (${typeof codeFactorAnnotationCount === "number" ? codeFactorAnnotationCount : "unknown"})`,
    };
  }
  const codeFactorTitle =
    typeof codeFactor.output?.title === "string" ? codeFactor.output.title : "";
  if (
    !/^(?:no issues found|\d+ issues? fixed)\.?$/i.test(codeFactorTitle.trim())
  ) {
    return {
      ok: false,
      reason:
        "CodeFactor success title does not explicitly report no issues or fixed-only results",
    };
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
  const statusResult = runCaptured(GH, [
    "api",
    `repos/${repository}/commits/${sha}/status`,
  ]);
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
  const statusPayload = parseObject(
    statusResult.stdout,
    "GitHub commit status API",
  );
  if (!statusPayload.ok) {
    return statusPayload;
  }
  const checksPayload = parseObject(
    checksResult.stdout,
    "GitHub check-runs API",
  );
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
  return typeof treeSha === "string" && SHA_PATTERN.test(treeSha)
    ? treeSha.toLowerCase()
    : null;
}

/** Read one tracked file from an immutable commit without touching the worktree. */
function readCommitFile(sha, filePath) {
  const result = runCaptured(GIT, ["show", `${sha}:${filePath}`]);
  return result.status === 0 ? result.stdout : null;
}

/** Validate a stable calendar version and return its changelog date. */
function releaseDateForVersion(version) {
  const match = version.match(STABLE_RELEASE_PATTERN);
  if (match === null) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Return the complete manifest set stamped by the release pipeline. */
function readExpectedReleaseManifests(parentSha) {
  const tracked = runCaptured(GIT, ["ls-tree", "-r", "--name-only", parentSha]);
  if (tracked.status !== 0) {
    return null;
  }
  const trackedPaths = new Set(tracked.stdout.split(/\r?\n/u).filter(Boolean));
  if (FIXED_RELEASE_MANIFESTS.some((filePath) => !trackedPaths.has(filePath))) {
    return null;
  }
  return [...trackedPaths]
    .filter(
      (filePath) =>
        FIXED_RELEASE_MANIFESTS.includes(filePath) ||
        WORKSPACE_MANIFEST_PATTERN.test(filePath),
    )
    .sort();
}

/** Require an exact old-version to new-version substitution in one manifest. */
function validateVersionOnlyManifest(
  parentSha,
  sha,
  filePath,
  previousVersion,
  targetVersion,
) {
  const parentContent = readCommitFile(parentSha, filePath);
  const candidateContent = readCommitFile(sha, filePath);
  if (parentContent === null || candidateContent === null) {
    return false;
  }
  const previousLiteral = `"${previousVersion}"`;
  if (!parentContent.includes(previousLiteral)) {
    return false;
  }
  return (
    candidateContent ===
    parentContent.replaceAll(previousLiteral, `"${targetVersion}"`)
  );
}

/** Read the immutable identity of a canonical tagged release commit. */
function readGeneratedReleaseIdentity(sha) {
  const message = runCaptured(GIT, ["show", "--no-patch", "--format=%B", sha]);
  if (message.status !== 0) {
    return null;
  }
  const normalizedMessage = message.stdout.trimEnd();
  const subject = normalizedMessage.split(/\r?\n/u, 1)[0];
  const targetVersion =
    subject.match(/^chore\(release\): cut (.+)$/u)?.[1] ?? null;
  const releaseDate =
    targetVersion === null ? null : releaseDateForVersion(targetVersion);
  if (
    targetVersion === null ||
    releaseDate === null ||
    normalizedMessage !== `${subject}\n\n${RELEASE_COMMIT_BODY}`
  ) {
    return null;
  }

  const parents = runCaptured(GIT, ["rev-list", "--parents", "-n", "1", sha]);
  const parentParts = parents.stdout.trim().split(/\s+/u);
  if (
    parents.status !== 0 ||
    parentParts.length !== 2 ||
    parentParts[0]?.toLowerCase() !== sha
  ) {
    return null;
  }
  const parentSha = parentParts[1].toLowerCase();
  if (!SHA_PATTERN.test(parentSha)) {
    return null;
  }
  const tag = runCaptured(GIT, [
    "rev-parse",
    `refs/tags/v${targetVersion}^{commit}`,
  ]);
  if (tag.status !== 0 || tag.stdout.trim().toLowerCase() !== sha) {
    return null;
  }

  return { parentSha, targetVersion, releaseDate };
}

/** Require the release candidate to modify the complete expected path set. */
function hasExactReleasePathSet(parentSha, sha, manifests) {
  const changed = runCaptured(GIT, [
    "diff",
    "--name-status",
    parentSha,
    sha,
    "--",
  ]);
  if (changed.status !== 0) {
    return false;
  }
  const changedEntries = changed.stdout
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => line.split("\t"));
  if (
    changedEntries.some(
      ([status, filePath, extra]) =>
        status !== "M" || !filePath || extra !== undefined,
    )
  ) {
    return false;
  }
  const changedPaths = changedEntries.map(([, filePath]) => filePath).sort();
  const expectedPaths = [...manifests, "CHANGELOG.md"].sort();
  return JSON.stringify(changedPaths) === JSON.stringify(expectedPaths);
}

/** Read the old and new root versions while rejecting malformed manifests. */
function readReleaseVersions(parentSha, sha, targetVersion) {
  const parentPackage = readCommitFile(parentSha, "package.json");
  const candidatePackage = readCommitFile(sha, "package.json");
  if (parentPackage === null || candidatePackage === null) {
    return null;
  }
  let previousVersion;
  let candidateVersion;
  try {
    previousVersion = JSON.parse(parentPackage).version;
    candidateVersion = JSON.parse(candidatePackage).version;
  } catch {
    return null;
  }
  if (
    typeof previousVersion !== "string" ||
    previousVersion === targetVersion ||
    candidateVersion !== targetVersion
  ) {
    return null;
  }
  return previousVersion;
}

/** Require the release changelog to change its heading and nothing else. */
function hasExactReleaseChangelog(parentSha, sha, targetVersion, releaseDate) {
  const parentChangelog = readCommitFile(parentSha, "CHANGELOG.md");
  const candidateChangelog = readCommitFile(sha, "CHANGELOG.md");
  if (parentChangelog === null || candidateChangelog === null) {
    return false;
  }
  const unreleasedHeader = "## Unreleased";
  return (
    parentChangelog.includes(unreleasedHeader) &&
    candidateChangelog ===
      parentChangelog.replace(
        unreleasedHeader,
        `## ${targetVersion} - ${releaseDate}`,
      )
  );
}

/** Prove one commit is exactly the tagged deterministic release projection. */
function validateGeneratedReleaseCommit(sha) {
  const identity = readGeneratedReleaseIdentity(sha);
  if (identity === null) {
    return null;
  }
  const { parentSha, targetVersion, releaseDate } = identity;
  const manifests = readExpectedReleaseManifests(parentSha);
  if (manifests === null || !hasExactReleasePathSet(parentSha, sha, manifests)) {
    return null;
  }
  const previousVersion = readReleaseVersions(parentSha, sha, targetVersion);
  if (
    previousVersion === null ||
    !manifests.every((filePath) =>
      validateVersionOnlyManifest(
        parentSha,
        sha,
        filePath,
        previousVersion,
        targetVersion,
      ),
    )
  ) {
    return null;
  }
  if (!hasExactReleaseChangelog(parentSha, sha, targetVersion, releaseDate)) {
    return null;
  }
  return { parentSha, targetVersion };
}

/** Select the unique reviewed PR head whose immutable merge metadata matches. */
function selectReviewedPullRequestHead(pullRequests, sha) {
  if (!Array.isArray(pullRequests)) {
    return { state: "invalid", head: null };
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
  if (candidates.length === 0) {
    return { state: "missing", head: null };
  }
  if (candidates.length > 1) {
    return { state: "ambiguous", head: null };
  }
  return { state: "found", head: candidates[0].head.sha.toLowerCase() };
}

/** Resolve the unique reviewed PR head from association or validated merge metadata. */
function readReviewedPullRequestHead(repository, sha) {
  const associationResult = runCaptured(GH, [
    "api",
    `repos/${repository}/commits/${sha}/pulls?per_page=100`,
  ]);
  let association = { state: "invalid", head: null };
  if (associationResult.status === 0) {
    try {
      association = selectReviewedPullRequestHead(
        JSON.parse(associationResult.stdout),
        sha,
      );
    } catch {
      association = { state: "invalid", head: null };
    }
  }
  if (association.state === "found" || association.state === "ambiguous") {
    return association.head;
  }

  const messageResult = runCaptured(GIT, [
    "show",
    "--no-patch",
    "--format=%B",
    sha,
  ]);
  if (messageResult.status !== 0) {
    return null;
  }
  const subject = messageResult.stdout.split(/\r?\n/u, 1)[0];
  const pullRequestNumber =
    subject.match(/^Merge pull request #([1-9]\d*) from [^\r\n]+$/u)?.[1] ??
    subject.match(/^.+ \(#([1-9]\d*)\)$/u)?.[1];
  if (pullRequestNumber === undefined) {
    return null;
  }
  const pullRequestResult = runCaptured(GH, [
    "api",
    `repos/${repository}/pulls/${pullRequestNumber}`,
  ]);
  if (pullRequestResult.status !== 0) {
    return null;
  }
  const pullRequest = parseObject(
    pullRequestResult.stdout,
    "GitHub pull-request API",
  );
  return pullRequest.ok
    ? selectReviewedPullRequestHead([pullRequest.value], sha).head
    : null;
}

/** Resolve analyzer evidence from an exact commit or identical reviewed tree. */
function resolveReviewedAnalyzerEvidence(repository, sha, initialEvidence) {
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
    initialEvidence.codeFactor.reason.startsWith(
      "CodeFactor check run is missing",
    );
  if (!deepScanMissing || !codeFactorMissing) {
    return exact;
  }
  const reviewedHead = readReviewedPullRequestHead(repository, sha);
  const mergeParent = runCaptured(GIT, ["rev-parse", `${sha}^2`]);
  const exactTree = runCaptured(GIT, ["rev-parse", `${sha}^{tree}`]);
  const parentSha = mergeParent.stdout.trim().toLowerCase();
  if (
    mergeParent.status === 0 &&
    reviewedHead === parentSha &&
    exactTree.status === 0
  ) {
    const parentTree = runCaptured(GIT, ["rev-parse", `${parentSha}^{tree}`]);
    if (
      parentTree.status === 0 &&
      exactTree.stdout.trim() === parentTree.stdout.trim()
    ) {
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
  if (reviewedHead === null) {
    return exact;
  }
  const exactGitHubTree = readCommitTree(repository, sha);
  const reviewedHeadTree = readCommitTree(repository, reviewedHead);
  if (
    exactGitHubTree === null ||
    reviewedHeadTree === null ||
    exactGitHubTree !== reviewedHeadTree
  ) {
    return exact;
  }
  const reviewedHeadEvidence = readAnalyzerEvidence(repository, reviewedHead);
  return reviewedHeadEvidence.ok
    ? {
        ...reviewedHeadEvidence,
        analyzedSha: reviewedHead,
        analysisSource: "identical_tree_squash_pr_head",
      }
    : exact;
}

/** Test whether both required analyzer producers are absent for one commit. */
function bothAnalyzersMissing(evidence) {
  return (
    !evidence.deepScan.ok &&
    evidence.deepScan.reason.startsWith("DeepScan status is missing") &&
    !evidence.codeFactor.ok &&
    evidence.codeFactor.reason.startsWith("CodeFactor check run is missing")
  );
}

/** Resolve evidence through a fully validated deterministic release transform. */
function resolveGeneratedReleaseEvidence(repository, sha) {
  const release = validateGeneratedReleaseCommit(sha);
  if (release === null) {
    return null;
  }
  const parentInitialEvidence = readAnalyzerEvidence(
    repository,
    release.parentSha,
  );
  if (!parentInitialEvidence.ok) {
    return null;
  }
  const parentEvidence = resolveReviewedAnalyzerEvidence(
    repository,
    release.parentSha,
    parentInitialEvidence,
  );
  if (!parentEvidence.deepScan.ok || !parentEvidence.codeFactor.ok) {
    return null;
  }
  return {
    ...parentEvidence,
    analysisSource: "deterministic_release_transform",
    releaseParentSha: release.parentSha,
    releaseParentAnalysisSource: parentEvidence.analysisSource,
    releaseVersion: release.targetVersion,
  };
}

/** Resolve analyzer evidence from an immutable candidate under every trusted path. */
function resolveAnalyzerEvidence(repository, sha, initialEvidence) {
  const reviewedEvidence = resolveReviewedAnalyzerEvidence(
    repository,
    sha,
    initialEvidence,
  );
  if (!bothAnalyzersMissing(reviewedEvidence)) {
    return reviewedEvidence;
  }
  return resolveGeneratedReleaseEvidence(repository, sha) ?? reviewedEvidence;
}

/** Explain the immutable analyzer provenance contract when both results are absent. */
function explainMissingAnalyzerProvenance(resolvedEvidence) {
  if (!bothAnalyzersMissing(resolvedEvidence)) {
    return null;
  }
  return {
    ok: false,
    releasable: false,
    reason:
      "Release analyzer provenance precondition failed: no exact-commit, identical-tree reviewed-PR, or validated deterministic-release evidence was found. Release candidates must reach main through a reviewed pull request whose head passed required DeepScan and CodeFactor checks; direct-main commits without exact analyzer evidence are not releasable unless their complete diff is the exact tagged release transformation of an analyzed parent.",
    analyzed_sha: resolvedEvidence.analyzedSha,
    analysis_source: resolvedEvidence.analysisSource,
    release_precondition: RELEASE_PRECONDITION,
  };
}

/** Resolve effective required checks from either an admin policy or branch summary. */
function resolveRequiredStatusChecks(protectionPayload, source, sha) {
  if (source !== "branch_summary") {
    return { ok: true, value: protectionPayload.required_status_checks };
  }
  if (
    protectionPayload.protected !== true ||
    protectionPayload.protection?.enabled !== true
  ) {
    return {
      ok: false,
      reason: "main branch summary does not report enabled protection",
    };
  }
  const branchSha = protectionPayload.commit?.sha;
  if (typeof branchSha !== "string" || branchSha.toLowerCase() !== sha) {
    return {
      ok: false,
      reason: "main branch summary does not match the release candidate SHA",
    };
  }
  return {
    ok: true,
    value: protectionPayload.protection.required_status_checks,
  };
}

/** Verify effective analyzer requirements and the strongest readable strictness proof. */
function inspectBranchProtection(protectionPayload, source, sha) {
  const branchSummary = source === "branch_summary";
  const resolvedChecks = resolveRequiredStatusChecks(
    protectionPayload,
    source,
    sha,
  );
  if (!resolvedChecks.ok) {
    return resolvedChecks;
  }
  const requiredStatusChecks = resolvedChecks.value;
  if (
    requiredStatusChecks === null ||
    typeof requiredStatusChecks !== "object"
  ) {
    return {
      ok: false,
      reason: "main branch protection has no required status checks",
    };
  }
  if (!branchSummary && requiredStatusChecks.strict !== true) {
    return {
      ok: false,
      reason:
        "main branch protection does not require branches to be up to date",
    };
  }
  if (
    branchSummary &&
    !["non_admins", "everyone"].includes(requiredStatusChecks.enforcement_level)
  ) {
    return {
      ok: false,
      reason:
        "main branch summary does not report enforced required status checks",
    };
  }
  const contexts = Array.isArray(requiredStatusChecks.contexts)
    ? requiredStatusChecks.contexts
    : [];
  const checks = Array.isArray(requiredStatusChecks.checks)
    ? requiredStatusChecks.checks
    : [];
  const requiredContexts = new Set([
    ...contexts.filter((context) => typeof context === "string"),
    ...checks
      .map((check) => check?.context)
      .filter((context) => typeof context === "string"),
  ]);
  const missing = ["CodeFactor", "DeepScan"].filter(
    (context) => !requiredContexts.has(context),
  );
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `main branch protection is missing required analyzer checks: ${missing.join(", ")}`,
    };
  }
  return {
    ok: true,
    branch: "main",
    strict: branchSummary ? null : true,
    strict_verified: !branchSummary,
    verification_scope: branchSummary
      ? "effective_required_checks"
      : "strict_admin_policy",
    required_analyzers: ["CodeFactor", "DeepScan"],
  };
}

/** Validate one slurped GraphQL connection page before accepting its rules. */
function parseBranchProtectionPage(page, index, pageCount) {
  const connection = page?.data?.repository?.branchProtectionRules;
  if (!Array.isArray(connection?.nodes)) {
    return {
      ok: false,
      reason: `GitHub branch protection GraphQL API page ${index + 1} has no rules array`,
    };
  }
  const hasNextPage = connection.pageInfo?.hasNextPage;
  const endCursor = connection.pageInfo?.endCursor;
  const isLastPage = index === pageCount - 1;
  if (typeof hasNextPage !== "boolean") {
    return {
      ok: false,
      reason: `GitHub branch protection GraphQL API page ${index + 1} has invalid pagination metadata`,
    };
  }
  if (hasNextPage === isLastPage) {
    return {
      ok: false,
      reason: `GitHub branch protection GraphQL API page ${index + 1} has inconsistent pagination termination`,
    };
  }
  if (
    !isLastPage &&
    (typeof endCursor !== "string" || endCursor.length === 0)
  ) {
    return {
      ok: false,
      reason: `GitHub branch protection GraphQL API page ${index + 1} has no continuation cursor`,
    };
  }
  return { ok: true, value: connection.nodes };
}

/** Parse and validate every GraphQL policy page returned by gh pagination. */
function parseBranchProtectionPages(stdout) {
  let pages;
  try {
    pages = JSON.parse(stdout);
  } catch {
    return {
      ok: false,
      reason: "GitHub branch protection GraphQL API returned invalid JSON",
    };
  }
  if (!Array.isArray(pages) || pages.length === 0) {
    return {
      ok: false,
      reason:
        "GitHub branch protection GraphQL API returned no paginated policy pages",
    };
  }
  const rules = [];
  for (const [index, page] of pages.entries()) {
    const parsedPage = parseBranchProtectionPage(page, index, pages.length);
    if (!parsedPage.ok) {
      return parsedPage;
    }
    rules.push(...parsedPage.value);
  }
  return { ok: true, value: rules };
}

/** Read main protection through admin APIs, then a contents-readable effective summary. */
function readBranchProtection(repository) {
  const restResult = runCaptured(GH, [
    "api",
    `repos/${repository}/branches/main/protection`,
  ]);
  if (restResult.status === 0) {
    const restPayload = parseObject(
      restResult.stdout,
      "GitHub branch protection API",
    );
    return restPayload.ok
      ? { ok: true, value: restPayload.value, source: "rest" }
      : restPayload;
  }

  const [owner, name] = repository.split("/");
  const graphqlResult = runCaptured(GH, [
    "api",
    "graphql",
    "--paginate",
    "--slurp",
    "-f",
    "query=query($owner:String!,$name:String!,$endCursor:String){repository(owner:$owner,name:$name){branchProtectionRules(first:100,after:$endCursor){nodes{pattern requiresStrictStatusChecks requiredStatusCheckContexts}pageInfo{hasNextPage endCursor}}}}",
    "-F",
    `owner=${owner}`,
    "-F",
    `name=${name}`,
  ]);
  if (graphqlResult.status !== 0) {
    const branchResult = runCaptured(GH, [
      "api",
      `repos/${repository}/branches/main`,
    ]);
    if (branchResult.status !== 0) {
      return {
        ok: false,
        reason:
          "unable to read main branch protection with GitHub REST, GraphQL, or the contents-readable branch summary",
      };
    }
    const branchPayload = parseObject(
      branchResult.stdout,
      "GitHub main branch summary API",
    );
    return branchPayload.ok
      ? { ok: true, value: branchPayload.value, source: "branch_summary" }
      : branchPayload;
  }
  const rulesPayload = parseBranchProtectionPages(graphqlResult.stdout);
  if (!rulesPayload.ok) {
    return rulesPayload;
  }
  const rules = rulesPayload.value;
  const mainRules = rules.filter((rule) => rule?.pattern === "main");
  if (mainRules.length !== 1) {
    return {
      ok: false,
      reason: `GitHub branch protection GraphQL API returned ${mainRules.length} exact main rules; expected 1`,
    };
  }
  return {
    ok: true,
    source: "graphql",
    value: {
      required_status_checks: {
        strict: mainRules[0].requiresStrictStatusChecks,
        contexts: mainRules[0].requiredStatusCheckContexts,
        checks: [],
      },
    },
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
    report(
      outputJson,
      { ...analyzerEvidence, repository: repository.value, sha: sha.value },
      1,
    );
    return;
  }
  const protectionPayload = readBranchProtection(repository.value);
  if (!protectionPayload.ok) {
    report(
      outputJson,
      { ...protectionPayload, repository: repository.value, sha: sha.value },
      1,
    );
    return;
  }

  const resolvedEvidence = resolveAnalyzerEvidence(
    repository.value,
    sha.value,
    analyzerEvidence,
  );
  const { deepScan, codeFactor } = resolvedEvidence;
  const provenanceFailure = explainMissingAnalyzerProvenance(resolvedEvidence);
  if (provenanceFailure !== null) {
    report(
      outputJson,
      { ...provenanceFailure, repository: repository.value, sha: sha.value },
      1,
    );
    return;
  }
  if (!deepScan.ok) {
    report(
      outputJson,
      {
        ...deepScan,
        repository: repository.value,
        sha: sha.value,
        analyzed_sha: resolvedEvidence.analyzedSha,
        analysis_source: resolvedEvidence.analysisSource,
      },
      1,
    );
    return;
  }
  if (!codeFactor.ok) {
    report(
      outputJson,
      {
        ...codeFactor,
        repository: repository.value,
        sha: sha.value,
        analyzed_sha: resolvedEvidence.analyzedSha,
        analysis_source: resolvedEvidence.analysisSource,
      },
      1,
    );
    return;
  }
  const branchProtection = inspectBranchProtection(
    protectionPayload.value,
    protectionPayload.source,
    sha.value,
  );
  if (!branchProtection.ok) {
    report(
      outputJson,
      { ...branchProtection, repository: repository.value, sha: sha.value },
      1,
    );
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
      releasable: true,
      release_precondition: RELEASE_PRECONDITION,
      analyzers: {
        deepscan: deepScan.analyzer,
        codefactor: codeFactor.analyzer,
      },
      branch_protection: {
        source: protectionPayload.source,
        branch: branchProtection.branch,
        strict: branchProtection.strict,
        strict_verified: branchProtection.strict_verified,
        verification_scope: branchProtection.verification_scope,
        required_analyzers: branchProtection.required_analyzers,
        candidate_tree: {
          sha: sha.value,
          analyzed_sha: resolvedEvidence.analyzedSha,
          analysis_source: resolvedEvidence.analysisSource,
          exact_or_identical:
            resolvedEvidence.analysisSource !==
            "deterministic_release_transform",
          deterministic_release_transform:
            resolvedEvidence.analysisSource ===
            "deterministic_release_transform",
          ...(resolvedEvidence.releaseParentSha === undefined
            ? {}
            : {
                release_parent_sha: resolvedEvidence.releaseParentSha,
                release_parent_analysis_source:
                  resolvedEvidence.releaseParentAnalysisSource,
                release_version: resolvedEvidence.releaseVersion,
              }),
        },
      },
    },
    0,
  );
}

main();
