import { afterEach, describe, expect, it, vi } from "vitest";

import { createScriptHarness } from "../../../helpers/scriptModule";

const harness = createScriptHarness();
const SHA = "a61cdc0c58252072456661a4c08f4b431625f274";
const PARENT_SHA = "b61cdc0c58252072456661a4c08f4b431625f275";
const RELEASE_VERSION = "2026.8.23";
const PREVIOUS_VERSION = "2026.8.22";
const RELEASE_MANIFESTS = [
  ".agents/plugins/marketplace.json",
  ".claude-plugin/marketplace.json",
  "marketplace.json",
  "package.json",
  "packages/pm-example/package.json",
  "plugins/pm-claude/.claude-plugin/plugin.json",
  "plugins/pm-codex/.codex-plugin/plugin.json",
];
const STRICT_PROTECTION = {
  required_status_checks: {
    strict: true,
    contexts: ["DeepScan"],
    checks: [{ context: "CodeFactor" }],
  },
};
const EFFECTIVE_BRANCH_SUMMARY = {
  protected: true,
  commit: { sha: SHA },
  protection: {
    enabled: true,
    required_status_checks: {
      contexts: ["DeepScan"],
      checks: [{ context: "CodeFactor" }],
      enforcement_level: "non_admins",
    },
  },
};
const SUCCESSFUL_DEEPSCAN = {
  statuses: [
    { context: "DeepScan", state: "success", description: "0 new issues" },
  ],
};
const SUCCESSFUL_CODEFACTOR = {
  check_runs: [
    {
      name: "CodeFactor",
      status: "completed",
      conclusion: "success",
      output: { title: "No issues found.", annotations_count: 0 },
    },
  ],
};
const FAILED_CODEFACTOR = {
  check_runs: [
    {
      name: "CodeFactor",
      status: "completed",
      conclusion: "failure",
      output: { title: "1 new issue.", annotations_count: 1 },
    },
  ],
};

/** Return successful hosted analyzer evidence for one exact commit API target. */
function successfulAnalyzerResponse(target: string, sha: string, status = 0) {
  if (target.includes(`/commits/${sha}/status`)) {
    return { status, stdout: JSON.stringify(SUCCESSFUL_DEEPSCAN), stderr: "" };
  }
  if (target.includes(`/commits/${sha}/check-runs`)) {
    return {
      status: 0,
      stdout: JSON.stringify(SUCCESSFUL_CODEFACTOR),
      stderr: "",
    };
  }
  return null;
}

/** Return one unambiguous reviewed pull request merged into main at the candidate. */
function reviewedPullRequestResponse(headSha = PARENT_SHA) {
  return {
    status: 0,
    stdout: JSON.stringify([
      {
        state: "closed",
        merged_at: "2026-08-15T04:00:00Z",
        merge_commit_sha: SHA,
        base: { ref: "main" },
        head: { sha: headSha },
      },
    ]),
    stderr: "",
  };
}

/** Return successful parent evidence, empty candidate evidence, or repository discovery. */
function analyzerEvidenceOrEmpty(
  args: string[],
  analyzedSha = PARENT_SHA,
  status = 0,
) {
  const target = String(args[1] ?? "");
  const analyzed = successfulAnalyzerResponse(target, analyzedSha, status);
  if (analyzed !== null) {
    return analyzed;
  }
  if (target.endsWith("/status")) {
    return { status: 0, stdout: JSON.stringify({ statuses: [] }), stderr: "" };
  }
  if (target.includes("/check-runs")) {
    return {
      status: 0,
      stdout: JSON.stringify({ check_runs: [] }),
      stderr: "",
    };
  }
  if (args[0] === "repo" && target === "view") {
    return { status: 0, stdout: "unbraind/pm-cli\n", stderr: "" };
  }
  return { status: 1, stdout: "", stderr: "unexpected command" };
}

interface SquashBaseControls {
  message: string;
  messageStatus?: number;
  pullsOutput: string;
  pullsStatus?: number;
  treeSha: string;
}

/** Route command shapes shared by squash-provenance positive and negative controls. */
function squashBaseResponse(args: string[], controls: SquashBaseControls) {
  const target = String(args[1] ?? "");
  if (args[0] === "show") {
    return {
      status: controls.messageStatus ?? 0,
      stdout: controls.message,
      stderr: "",
    };
  }
  if (args[0] === "rev-parse") {
    if (target.endsWith("^2")) {
      return { status: 1, stdout: "", stderr: "not a merge commit" };
    }
    return {
      status: 0,
      stdout: target.endsWith("^{tree}") ? `${controls.treeSha}\n` : `${SHA}\n`,
      stderr: "",
    };
  }
  if (target.endsWith("/protection")) {
    return { status: 0, stdout: JSON.stringify(STRICT_PROTECTION), stderr: "" };
  }
  if (target === `repos/unbraind/pm-cli/commits/${SHA}/pulls?per_page=100`) {
    return {
      status: controls.pullsStatus ?? 0,
      stdout: controls.pullsOutput,
      stderr: "",
    };
  }
  return null;
}

interface GatePayload {
  ok: boolean;
  releasable?: boolean;
  reason?: string;
  repository?: string;
  sha?: string;
  analyzed_sha?: string;
  analysis_source?: string;
  release_precondition?: {
    id: string;
    required_arrival: string;
    direct_main_policy: string;
    generated_release_policy?: string;
    required_analyzers: string[];
  };
  analyzers?: {
    deepscan: { new_issues: number };
    codefactor: { new_issues: number };
  };
  branch_protection?: {
    source: string;
    branch: string;
    strict: boolean | null;
    strict_verified: boolean;
    verification_scope: string;
    required_analyzers: string[];
    candidate_tree: {
      sha: string;
      analyzed_sha: string;
      analysis_source: string;
      exact_or_identical: boolean;
      deterministic_release_transform?: boolean;
      release_parent_sha?: string;
      release_parent_analysis_source?: string;
      release_version?: string;
    };
  };
}

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

/** Serialize the mock GraphQL slurp envelope while preserving malformed controls. */
function serializeGraphqlProtection(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "object" && value !== null && "pages" in value) {
    return JSON.stringify(value.pages);
  }
  return JSON.stringify(value);
}

type MockCommandFailure = Partial<
  Record<
    | "repo"
    | "sha"
    | "statuses"
    | "checks"
    | "protection"
    | "graphqlProtection"
    | "branchSummary",
    number
  >
>;

/** Return a policy API response when the command targets one of the three policy surfaces. */
function policyCommandResponse(
  args: string[],
  protection: unknown,
  graphqlProtection: unknown,
  branchSummary: unknown,
  failures: MockCommandFailure,
) {
  if (String(args[1]).endsWith("/protection")) {
    return {
      status: failures.protection ?? 0,
      stdout:
        typeof protection === "string"
          ? protection
          : JSON.stringify(protection),
      stderr: "",
    };
  }
  if (args[1] === "graphql") {
    return {
      status: failures.graphqlProtection ?? 0,
      stdout: serializeGraphqlProtection(graphqlProtection),
      stderr: "",
    };
  }
  if (String(args[1]).endsWith("/branches/main")) {
    return {
      status: failures.branchSummary ?? 0,
      stdout:
        typeof branchSummary === "string"
          ? branchSummary
          : JSON.stringify(branchSummary),
      stderr: "",
    };
  }
  return null;
}

/** Install deterministic command responses for one hosted-analysis gate run. */
function mockCommands({
  repository = "unbraind/pm-cli",
  sha = SHA,
  statuses = {
    statuses: [
      {
        context: "DeepScan",
        state: "success",
        description: "0 new and 2 fixed issues",
      },
    ],
  },
  checks = {
    check_runs: [
      {
        name: "CodeFactor",
        status: "completed",
        conclusion: "success",
        output: { title: "No issues found.", annotations_count: 0 },
      },
    ],
  },
  protection = {
    required_status_checks: {
      strict: true,
      contexts: ["DeepScan"],
      checks: [{ context: "CodeFactor", app_id: 25603 }],
    },
  },
  graphqlProtection = {
    pages: [
      {
        data: {
          repository: {
            branchProtectionRules: {
              nodes: [
                {
                  pattern: "main",
                  requiresStrictStatusChecks: true,
                  requiredStatusCheckContexts: ["CodeFactor", "DeepScan"],
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: "cursor-1" },
            },
          },
        },
      },
    ],
  },
  branchSummary = EFFECTIVE_BRANCH_SUMMARY,
  failures = {},
}: {
  repository?: string;
  sha?: string;
  statuses?: unknown;
  checks?: unknown;
  protection?: unknown;
  graphqlProtection?: unknown;
  branchSummary?: unknown;
  failures?: MockCommandFailure;
} = {}) {
  const spawnSync = vi.fn((_command: string, args: string[]) => {
    if (args[0] === "repo") {
      return {
        status: failures.repo ?? 0,
        stdout: `${repository}\n`,
        stderr: "",
      };
    }
    if (args[0] === "rev-parse") {
      return { status: failures.sha ?? 0, stdout: `${sha}\n`, stderr: "" };
    }
    if (String(args[1]).endsWith("/status")) {
      return {
        status: failures.statuses ?? 0,
        stdout:
          typeof statuses === "string" ? statuses : JSON.stringify(statuses),
        stderr: "",
      };
    }
    const policyResponse = policyCommandResponse(
      args,
      protection,
      graphqlProtection,
      branchSummary,
      failures,
    );
    if (policyResponse !== null) {
      return policyResponse;
    }
    return {
      status: failures.checks ?? 0,
      stdout: typeof checks === "string" ? checks : JSON.stringify(checks),
      stderr: "",
    };
  });
  vi.doMock("node:child_process", () => ({ spawnSync }));
  return spawnSync;
}

interface ReleaseCandidateControls {
  message?: string;
  messageStatus?: number;
  parentLine?: string;
  parentStatus?: number;
  tagSha?: string;
  tagStatus?: number;
  trackedPaths?: string[];
  trackedStatus?: number;
  changedEntries?: string[];
  changedStatus?: number;
  parentManifest?: string;
  candidateManifest?: string;
  parentChangelog?: string;
  candidateChangelog?: string;
  unreadableBlob?: string;
  versionlessBlob?: string;
  parentEvidenceStatus?: number;
  parentStatuses?: unknown;
  parentChecks?: unknown;
}

interface ReleaseCandidateFixture {
  message: string;
  parentLine: string;
  trackedPaths: string[];
  changedEntries: string[];
  parentManifest: string;
  candidateManifest: string;
  parentChangelog: string;
  candidateChangelog: string;
}

/** Resolve all successful fixture defaults before command routing. */
function releaseCandidateFixture(
  controls: ReleaseCandidateControls,
): ReleaseCandidateFixture {
  return {
    message:
      controls.message ??
      `chore(release): cut ${RELEASE_VERSION}\n\nAutomate daily release preparation with strict quality, compatibility, and reliability gates.\n`,
    parentLine: controls.parentLine ?? `${SHA} ${PARENT_SHA}\n`,
    trackedPaths: controls.trackedPaths ?? [
      ...RELEASE_MANIFESTS,
      "CHANGELOG.md",
    ],
    changedEntries:
      controls.changedEntries ??
      [...RELEASE_MANIFESTS, "CHANGELOG.md"].map(
        (filePath) => `M\t${filePath}`,
      ),
    parentManifest:
      controls.parentManifest ?? `{"version":"${PREVIOUS_VERSION}"}\n`,
    candidateManifest:
      controls.candidateManifest ?? `{"version":"${RELEASE_VERSION}"}\n`,
    parentChangelog:
      controls.parentChangelog ?? "# Changelog\n\n## Unreleased\n\nEntry.\n",
    candidateChangelog:
      controls.candidateChangelog ??
      `# Changelog\n\n## ${RELEASE_VERSION} - 2026-08-23\n\nEntry.\n`,
  };
}

/** Route rev-parse calls used by exact, merge, tree, and tag proof. */
function releaseRevParseResponse(
  target: string,
  controls: ReleaseCandidateControls,
) {
  if (target === "HEAD") return { status: 0, stdout: `${SHA}\n`, stderr: "" };
  if (target.endsWith("^2"))
    return { status: 1, stdout: "", stderr: "not a merge" };
  if (target.endsWith("^{tree}"))
    return { status: 0, stdout: `${SHA}\n`, stderr: "" };
  return {
    status: controls.tagStatus ?? 0,
    stdout: `${controls.tagSha ?? SHA}\n`,
    stderr: "",
  };
}

/** Route immutable commit-message and blob reads. */
function releaseShowResponse(
  args: string[],
  fixture: ReleaseCandidateFixture,
  controls: ReleaseCandidateControls,
) {
  if (args[1] === "--no-patch") {
    return {
      status: controls.messageStatus ?? 0,
      stdout: fixture.message,
      stderr: "",
    };
  }
  const blob = String(args[1]);
  if (blob.endsWith(`:${controls.unreadableBlob}`)) {
    return { status: 1, stdout: "", stderr: "unreadable" };
  }
  if (blob.endsWith(":CHANGELOG.md")) {
    return {
      status: 0,
      stdout: blob.startsWith(`${PARENT_SHA}:`)
        ? fixture.parentChangelog
        : fixture.candidateChangelog,
      stderr: "",
    };
  }
  if (blob === `${PARENT_SHA}:${controls.versionlessBlob}`) {
    return { status: 0, stdout: '{"name":"pm"}\n', stderr: "" };
  }
  return {
    status: 0,
    stdout: blob.startsWith(`${PARENT_SHA}:`)
      ? fixture.parentManifest
      : fixture.candidateManifest,
    stderr: "",
  };
}

/** Route every git-side release proof command. */
function releaseGitResponse(
  args: string[],
  fixture: ReleaseCandidateFixture,
  controls: ReleaseCandidateControls,
) {
  if (args[0] === "rev-parse")
    return releaseRevParseResponse(String(args[1]), controls);
  if (args[0] === "show") return releaseShowResponse(args, fixture, controls);
  if (args[0] === "rev-list") {
    return {
      status: controls.parentStatus ?? 0,
      stdout: fixture.parentLine,
      stderr: "",
    };
  }
  if (args[0] === "ls-tree") {
    return {
      status: controls.trackedStatus ?? 0,
      stdout: `${fixture.trackedPaths.join("\n")}\n`,
      stderr: "",
    };
  }
  if (args[0] === "diff") {
    return {
      status: controls.changedStatus ?? 0,
      stdout: `${fixture.changedEntries.join("\n")}\n`,
      stderr: "",
    };
  }
  return null;
}

/** Route every GitHub-side policy and analyzer proof command. */
function releaseApiResponse(
  args: string[],
  controls: ReleaseCandidateControls,
) {
  const target = String(args[1] ?? "");
  if (target.endsWith("/protection")) {
    return { status: 0, stdout: JSON.stringify(STRICT_PROTECTION), stderr: "" };
  }
  if (target === `repos/unbraind/pm-cli/commits/${SHA}/pulls?per_page=100`) {
    return { status: 0, stdout: "[]", stderr: "" };
  }
  if (target === `repos/unbraind/pm-cli/commits/${PARENT_SHA}/status`) {
    return {
      status: controls.parentEvidenceStatus ?? 0,
      stdout: JSON.stringify(controls.parentStatuses ?? SUCCESSFUL_DEEPSCAN),
      stderr: "",
    };
  }
  if (
    target ===
    `repos/unbraind/pm-cli/commits/${PARENT_SHA}/check-runs?per_page=100`
  ) {
    return {
      status: 0,
      stdout: JSON.stringify(controls.parentChecks ?? SUCCESSFUL_CODEFACTOR),
      stderr: "",
    };
  }
  if (target.endsWith("/status")) {
    return { status: 0, stdout: JSON.stringify({ statuses: [] }), stderr: "" };
  }
  if (target.includes("/check-runs")) {
    return {
      status: 0,
      stdout: JSON.stringify({ check_runs: [] }),
      stderr: "",
    };
  }
  return { status: 1, stdout: "", stderr: "unexpected command" };
}

/** Install a compact generated-release fixture with independently corruptible proof layers. */
function mockGeneratedReleaseCandidate(
  controls: ReleaseCandidateControls = {},
) {
  const fixture = releaseCandidateFixture(controls);
  const spawnSync = vi.fn((_command: string, args: string[]) => {
    if (args[0] === "repo") {
      return { status: 0, stdout: "unbraind/pm-cli\n", stderr: "" };
    }
    return (
      releaseGitResponse(args, fixture, controls) ??
      releaseApiResponse(args, controls)
    );
  });
  vi.doMock("node:child_process", () => ({ spawnSync }));
  return spawnSync;
}

/** Run the script module once and parse its JSON result. */
async function runJson(args: string[], label: string): Promise<GatePayload> {
  process.argv = [
    "node",
    "scripts/release/hosted-analysis-gate.mjs",
    "--json",
    ...args,
  ];
  const writeSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(() => true);
  await harness.importModule("scripts/release/hosted-analysis-gate.mjs", label);
  return JSON.parse(
    String(writeSpy.mock.calls.at(-1)?.[0] ?? "{}"),
  ) as GatePayload;
}

describe("scripts/release/hosted-analysis-gate", () => {
  it("prints usage without spawning commands", async () => {
    const spawnSync = mockCommands();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    process.argv = [
      "node",
      "scripts/release/hosted-analysis-gate.mjs",
      "--help",
    ];
    await harness.importModule(
      "scripts/release/hosted-analysis-gate.mjs",
      "hostedAnalysisHelp",
    );
    expect(spawnSync).not.toHaveBeenCalled();
    expect(String(logSpy.mock.calls.at(-1)?.[0] ?? "")).toContain("--sha");
  });

  it("passes only explicit zero-new-issue evidence for an exact supplied head", async () => {
    const spawnSync = mockCommands();
    const payload = await runJson(
      ["--repo", "unbraind/pm-cli", "--sha", SHA],
      "hostedAnalysisPass",
    );
    expect(payload).toMatchObject({
      ok: true,
      repository: "unbraind/pm-cli",
      sha: SHA,
      releasable: true,
      release_precondition: {
        id: "reviewed_pull_request_analyzer_evidence",
        direct_main_policy: "refuse_without_exact_commit_analyzer_evidence",
      },
      analyzers: {
        deepscan: { new_issues: 0 },
        codefactor: { new_issues: 0, outstanding_annotations: 0 },
      },
      branch_protection: {
        source: "rest",
        branch: "main",
        strict: true,
        strict_verified: true,
        verification_scope: "strict_admin_policy",
        required_analyzers: ["CodeFactor", "DeepScan"],
        candidate_tree: {
          sha: SHA,
          analyzed_sha: SHA,
          analysis_source: "exact_commit",
          exact_or_identical: true,
        },
      },
    });
    expect(process.exitCode).toBe(0);
    expect(spawnSync).toHaveBeenCalledTimes(3);
  });

  it("reuses analyzed-parent evidence for the exact tagged release transformation", async () => {
    mockGeneratedReleaseCandidate();
    const payload = await runJson(
      [],
      "hostedAnalysisGeneratedReleaseTransform",
    );
    expect(payload).toMatchObject({
      ok: true,
      sha: SHA,
      analyzed_sha: PARENT_SHA,
      analysis_source: "deterministic_release_transform",
      release_precondition: {
        generated_release_policy:
          "accept_only_exact_tagged_version_and_changelog_transform_from_analyzed_parent",
      },
      branch_protection: {
        candidate_tree: {
          exact_or_identical: false,
          deterministic_release_transform: true,
          release_parent_sha: PARENT_SHA,
          release_parent_analysis_source: "exact_commit",
          release_version: RELEASE_VERSION,
        },
      },
    });
    expect(process.exitCode).toBe(0);
  });

  it.each([
    {
      label: "unavailable release message",
      controls: { messageStatus: 1 },
    },
    {
      label: "non-release message",
      controls: { message: "Direct main change\n" },
    },
    {
      label: "invalid release date",
      controls: {
        message:
          "chore(release): cut 2026.2.31\n\nAutomate daily release preparation with strict quality, compatibility, and reliability gates.\n",
      },
    },
    {
      label: "non-stable release version",
      controls: {
        message:
          "chore(release): cut 2026.8.23-2\n\nAutomate daily release preparation with strict quality, compatibility, and reliability gates.\n",
      },
    },
    {
      label: "non-canonical release body",
      controls: {
        message: `chore(release): cut ${RELEASE_VERSION}\n\nDifferent body.\n`,
      },
    },
    {
      label: "multiple parents",
      controls: {
        parentLine: `${SHA} ${PARENT_SHA} c61cdc0c58252072456661a4c08f4b431625f276\n`,
      },
    },
    {
      label: "invalid parent SHA",
      controls: { parentLine: `${SHA} main\n` },
    },
    {
      label: "tag does not resolve",
      controls: { tagStatus: 1 },
    },
    {
      label: "tag targets another commit",
      controls: { tagSha: PARENT_SHA },
    },
    {
      label: "tracked manifest inventory unavailable",
      controls: { trackedStatus: 1 },
    },
    {
      label: "required manifest absent",
      controls: { trackedPaths: RELEASE_MANIFESTS.slice(1) },
    },
    {
      label: "diff inventory unavailable",
      controls: { changedStatus: 1 },
    },
    {
      label: "added release path",
      controls: {
        changedEntries: [...RELEASE_MANIFESTS, "CHANGELOG.md"].map(
          (filePath, index) => `${index === 0 ? "A" : "M"}\t${filePath}`,
        ),
      },
    },
    {
      label: "renamed release path",
      controls: {
        changedEntries: [`R100\tpackage.json\tpackage-renamed.json`],
      },
    },
    {
      label: "unexpected changed path",
      controls: {
        changedEntries: [
          ...RELEASE_MANIFESTS,
          "CHANGELOG.md",
          "src/cli.ts",
        ].map((filePath) => `M\t${filePath}`),
      },
    },
    {
      label: "unreadable package manifest",
      controls: { unreadableBlob: "package.json" },
    },
    {
      label: "unreadable secondary manifest",
      controls: { unreadableBlob: "marketplace.json" },
    },
    {
      label: "malformed package manifest",
      controls: { parentManifest: "{" },
    },
    {
      label: "invalid previous version",
      controls: { parentManifest: '{"version":""}\n' },
    },
    {
      label: "unchanged version",
      controls: {
        parentManifest: `{"version":"${RELEASE_VERSION}"}\n`,
        candidateManifest: `{"version":"${RELEASE_VERSION}"}\n`,
      },
    },
    {
      label: "candidate version mismatch",
      controls: { candidateManifest: `{"version":"2026.8.24"}\n` },
    },
    {
      label: "non-version manifest mutation",
      controls: {
        candidateManifest: `{"version":"${RELEASE_VERSION}","scripts":{"postinstall":"node bad.js"}}\n`,
      },
    },
    {
      label: "manifest without previous version",
      controls: { versionlessBlob: "marketplace.json" },
    },
    {
      label: "unreadable changelog",
      controls: { unreadableBlob: "CHANGELOG.md" },
    },
    {
      label: "missing unreleased header",
      controls: { parentChangelog: "# Changelog\n\nEntry.\n" },
    },
    {
      label: "non-header changelog mutation",
      controls: {
        candidateChangelog: `# Changelog\n\n## ${RELEASE_VERSION} - 2026-08-23\n\nChanged entry.\n`,
      },
    },
    {
      label: "unreadable parent analyzer evidence",
      controls: { parentEvidenceStatus: 1 },
    },
    {
      label: "missing parent analyzer results",
      controls: {
        parentStatuses: { statuses: [] },
        parentChecks: { check_runs: [] },
      },
    },
  ])(
    "rejects generated release provenance for $label",
    async ({ label, controls }) => {
      mockGeneratedReleaseCandidate(controls);
      const payload = await runJson(
        [],
        `hostedAnalysisGeneratedReleaseRejected-${label}`,
      );
      expect(payload).toMatchObject({
        ok: false,
        releasable: false,
        analysis_source: "exact_commit",
        reason: expect.stringContaining(
          "Release analyzer provenance precondition failed",
        ),
      });
      expect(process.exitCode).toBe(1);
    },
  );

  it("resolves repository and SHA defaults and prints a human success result", async () => {
    mockCommands();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    process.argv = ["node", "scripts/release/hosted-analysis-gate.mjs"];
    await harness.importModule(
      "scripts/release/hosted-analysis-gate.mjs",
      "hostedAnalysisDefaults",
    );
    expect(String(logSpy.mock.calls.at(-1)?.[0] ?? "")).toContain(
      "DeepScan 0 new issues",
    );
    expect(process.exitCode).toBe(0);
  });

  it("recovers a REST transport failure through an equivalent GraphQL main policy read", async () => {
    const spawnSync = mockCommands({ failures: { protection: 1 } });
    const payload = await runJson(
      [],
      "hostedAnalysisGraphqlProtectionFallback",
    );
    expect(payload).toMatchObject({
      ok: true,
      branch_protection: {
        source: "graphql",
        branch: "main",
        strict: true,
        required_analyzers: ["CodeFactor", "DeepScan"],
      },
    });
    expect(
      spawnSync.mock.calls.some(
        ([, args]) => args[0] === "api" && args[1] === "graphql",
      ),
    ).toBe(true);
    expect(process.exitCode).toBe(0);
  });

  it("proves exact-main uniqueness across every GraphQL policy page", async () => {
    mockCommands({
      failures: { protection: 1 },
      graphqlProtection: {
        pages: [
          {
            data: {
              repository: {
                branchProtectionRules: {
                  nodes: [
                    {
                      pattern: "main",
                      requiresStrictStatusChecks: true,
                      requiredStatusCheckContexts: ["CodeFactor", "DeepScan"],
                    },
                  ],
                  pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
                },
              },
            },
          },
          {
            data: {
              repository: {
                branchProtectionRules: {
                  nodes: [{ pattern: "release/*" }],
                  pageInfo: { hasNextPage: false, endCursor: "cursor-2" },
                },
              },
            },
          },
        ],
      },
    });
    const payload = await runJson(
      [],
      "hostedAnalysisGraphqlProtectionPagination",
    );
    expect(payload).toMatchObject({
      ok: true,
      branch_protection: { source: "graphql" },
    });
    expect(process.exitCode).toBe(0);
  });

  it("recovers unavailable admin policy APIs through the contents-readable branch summary", async () => {
    const spawnSync = mockCommands({
      failures: { protection: 1, graphqlProtection: 1 },
    });
    const payload = await runJson([], "hostedAnalysisBranchSummaryFallback");
    expect(payload).toMatchObject({
      ok: true,
      branch_protection: {
        source: "branch_summary",
        branch: "main",
        strict: null,
        strict_verified: false,
        verification_scope: "effective_required_checks",
        required_analyzers: ["CodeFactor", "DeepScan"],
        candidate_tree: {
          sha: SHA,
          analyzed_sha: SHA,
          analysis_source: "exact_commit",
          exact_or_identical: true,
        },
      },
    });
    expect(
      spawnSync.mock.calls.some(([, args]) =>
        String(args[1]).endsWith("/branches/main"),
      ),
    ).toBe(true);
    expect(process.exitCode).toBe(0);
  });

  it("accepts a successful zero-annotation CodeFactor run that only reports fixed issues", async () => {
    mockCommands({
      checks: {
        check_runs: [
          {
            name: "CodeFactor",
            status: "completed",
            conclusion: "success",
            output: { title: "1 issue fixed.", annotations_count: 0 },
          },
        ],
      },
    });
    const payload = await runJson([], "hostedAnalysisCodeFactorFixedOnly");
    expect(payload).toMatchObject({
      ok: true,
      analyzers: {
        codefactor: {
          title: "1 issue fixed.",
          new_issues: 0,
        },
      },
    });
    expect(process.exitCode).toBe(0);
  });

  it("reuses reviewed analyzer evidence only from an identical-tree merge parent", async () => {
    const parentSha = PARENT_SHA;
    const treeSha = "c61cdc0c58252072456661a4c08f4b431625f276";
    const spawnSync = vi.fn((_command: string, args: string[]) => {
      const target = String(args[1] ?? "");
      if (args[0] === "rev-parse") {
        if (target.endsWith("^2"))
          return { status: 0, stdout: `${parentSha}\n`, stderr: "" };
        if (target.endsWith("^{tree}"))
          return { status: 0, stdout: `${treeSha}\n`, stderr: "" };
        return { status: 0, stdout: `${SHA}\n`, stderr: "" };
      }
      if (target.endsWith("/protection")) {
        return {
          status: 0,
          stdout: JSON.stringify(STRICT_PROTECTION),
          stderr: "",
        };
      }
      if (
        target === `repos/unbraind/pm-cli/commits/${SHA}/pulls?per_page=100`
      ) {
        return reviewedPullRequestResponse(parentSha);
      }
      return analyzerEvidenceOrEmpty(args, parentSha);
    });
    vi.doMock("node:child_process", () => ({ spawnSync }));

    const payload = await runJson([], "hostedAnalysisMergeTreeFallback");
    expect(payload).toMatchObject({
      ok: true,
      sha: SHA,
      analyzed_sha: parentSha,
      analysis_source: "identical_tree_merge_parent",
    });
    expect(process.exitCode).toBe(0);
  });

  it("validates the merge-message PR when GitHub has not published commit association", async () => {
    const treeSha = "c61cdc0c58252072456661a4c08f4b431625f276";
    const spawnSync = vi.fn((_command: string, args: string[]) => {
      const target = String(args[1] ?? "");
      if (args[0] === "show") {
        return {
          status: 0,
          stdout:
            "Merge pull request #1022 from unbraind/codex/release-readiness-propagation\n",
          stderr: "",
        };
      }
      if (args[0] === "rev-parse") {
        if (target.endsWith("^2"))
          return { status: 0, stdout: `${PARENT_SHA}\n`, stderr: "" };
        if (target.endsWith("^{tree}"))
          return { status: 0, stdout: `${treeSha}\n`, stderr: "" };
        return { status: 0, stdout: `${SHA}\n`, stderr: "" };
      }
      if (target.endsWith("/protection")) {
        return {
          status: 0,
          stdout: JSON.stringify(STRICT_PROTECTION),
          stderr: "",
        };
      }
      if (
        target === `repos/unbraind/pm-cli/commits/${SHA}/pulls?per_page=100`
      ) {
        return { status: 0, stdout: "[]", stderr: "" };
      }
      if (target === "repos/unbraind/pm-cli/pulls/1022") {
        const [pullRequest] = JSON.parse(
          reviewedPullRequestResponse().stdout,
        ) as unknown[];
        return { status: 0, stdout: JSON.stringify(pullRequest), stderr: "" };
      }
      const parentResponse = successfulAnalyzerResponse(target, PARENT_SHA);
      if (parentResponse !== null) return parentResponse;
      if (target.endsWith("/status")) {
        return {
          status: 0,
          stdout: JSON.stringify({ statuses: [] }),
          stderr: "",
        };
      }
      if (target.includes("/check-runs")) {
        return {
          status: 0,
          stdout: JSON.stringify({ check_runs: [] }),
          stderr: "",
        };
      }
      return { status: 0, stdout: "unbraind/pm-cli\n", stderr: "" };
    });
    vi.doMock("node:child_process", () => ({ spawnSync }));

    const payload = await runJson([], "hostedAnalysisMergeMessageFallback");
    expect(payload).toMatchObject({
      ok: true,
      sha: SHA,
      analyzed_sha: PARENT_SHA,
      analysis_source: "identical_tree_merge_parent",
    });
    expect(process.exitCode).toBe(0);
  });

  it.each([
    {
      label:
        "validates the squash-message PR when GitHub has not published commit association",
      reviewedStatuses: SUCCESSFUL_DEEPSCAN,
      reviewedChecks: SUCCESSFUL_CODEFACTOR,
      expected: {
        ok: true,
        sha: SHA,
        analyzed_sha: PARENT_SHA,
        analysis_source: "identical_tree_squash_pr_head",
      },
    },
    {
      label: "reports reviewed squash provenance when DeepScan is absent",
      reviewedStatuses: { statuses: [] },
      reviewedChecks: SUCCESSFUL_CODEFACTOR,
      expected: {
        ok: false,
        reason: expect.stringContaining("DeepScan status is missing"),
        sha: SHA,
        analyzed_sha: PARENT_SHA,
        analysis_source: "identical_tree_squash_pr_head",
      },
    },
    {
      label: "reports reviewed squash provenance when CodeFactor fails",
      reviewedStatuses: SUCCESSFUL_DEEPSCAN,
      reviewedChecks: FAILED_CODEFACTOR,
      expected: {
        ok: false,
        reason: "CodeFactor did not succeed (failure)",
        sha: SHA,
        analyzed_sha: PARENT_SHA,
        analysis_source: "identical_tree_squash_pr_head",
      },
    },
  ])("$label", async ({ reviewedStatuses, reviewedChecks, expected }) => {
    const treeSha = "c61cdc0c58252072456661a4c08f4b431625f276";
    const spawnSync = vi.fn((_command: string, args: string[]) => {
      const base = squashBaseResponse(args, {
        message:
          "Preserve reviewed provenance through PM delivery closeout (#1022)\n\nDetails.\n",
        pullsOutput: "[]",
        treeSha,
      });
      if (base !== null) {
        return base;
      }
      const target = String(args[1] ?? "");
      if (target === "repos/unbraind/pm-cli/pulls/1022") {
        const [pullRequest] = JSON.parse(
          reviewedPullRequestResponse().stdout,
        ) as unknown[];
        return { status: 0, stdout: JSON.stringify(pullRequest), stderr: "" };
      }
      if (
        target === `repos/unbraind/pm-cli/git/commits/${SHA}` ||
        target === `repos/unbraind/pm-cli/git/commits/${PARENT_SHA}`
      ) {
        return {
          status: 0,
          stdout: JSON.stringify({ tree: { sha: treeSha } }),
          stderr: "",
        };
      }
      if (target === `repos/unbraind/pm-cli/commits/${PARENT_SHA}/status`) {
        return {
          status: 0,
          stdout: JSON.stringify(reviewedStatuses),
          stderr: "",
        };
      }
      if (
        target ===
        `repos/unbraind/pm-cli/commits/${PARENT_SHA}/check-runs?per_page=100`
      ) {
        return {
          status: 0,
          stdout: JSON.stringify(reviewedChecks),
          stderr: "",
        };
      }
      if (target.endsWith("/status")) {
        return {
          status: 0,
          stdout: JSON.stringify({ statuses: [] }),
          stderr: "",
        };
      }
      if (target.includes("/check-runs")) {
        return {
          status: 0,
          stdout: JSON.stringify({ check_runs: [] }),
          stderr: "",
        };
      }
      return { status: 0, stdout: "unbraind/pm-cli\n", stderr: "" };
    });
    vi.doMock("node:child_process", () => ({ spawnSync }));

    const payload = await runJson([], "hostedAnalysisSquashMessageFallback");
    expect(payload).toMatchObject(expected);
    expect(process.exitCode).toBe(expected.ok ? 0 : 1);
  });

  it("rejects an identical-tree merge parent without a reviewed pull-request association", async () => {
    const treeSha = "c61cdc0c58252072456661a4c08f4b431625f276";
    const spawnSync = vi.fn((_command: string, args: string[]) => {
      const target = String(args[1] ?? "");
      if (args[0] === "rev-parse") {
        if (target.endsWith("^2"))
          return { status: 0, stdout: `${PARENT_SHA}\n`, stderr: "" };
        if (target.endsWith("^{tree}"))
          return { status: 0, stdout: `${treeSha}\n`, stderr: "" };
        return { status: 0, stdout: `${SHA}\n`, stderr: "" };
      }
      if (target.endsWith("/protection")) {
        return {
          status: 0,
          stdout: JSON.stringify(STRICT_PROTECTION),
          stderr: "",
        };
      }
      if (
        target === `repos/unbraind/pm-cli/commits/${SHA}/pulls?per_page=100`
      ) {
        return { status: 0, stdout: "[]", stderr: "" };
      }
      return analyzerEvidenceOrEmpty(args);
    });
    vi.doMock("node:child_process", () => ({ spawnSync }));

    const payload = await runJson([], "hostedAnalysisUnreviewedMergeParent");
    expect(payload).toMatchObject({
      ok: false,
      releasable: false,
      reason: expect.stringContaining(
        "direct-main commits without exact analyzer evidence are not releasable",
      ),
    });
    expect(process.exitCode).toBe(1);
  });

  it("uses bounded Git commit metadata for an identical-tree squash commit", async () => {
    const treeSha = "c61cdc0c58252072456661a4c08f4b431625f276";
    const spawnSync = vi.fn((_command: string, args: string[]) => {
      const target = String(args[1] ?? "");
      if (args[0] === "rev-parse") {
        if (target.endsWith("^2"))
          return { status: 1, stdout: "", stderr: "not a merge commit" };
        return {
          status: 0,
          stdout: target.endsWith("^{tree}") ? `${treeSha}\n` : `${SHA}\n`,
          stderr: "",
        };
      }
      if (target.endsWith("/protection")) {
        return {
          status: 0,
          stdout: JSON.stringify(STRICT_PROTECTION),
          stderr: "",
        };
      }
      if (
        target === `repos/unbraind/pm-cli/commits/${SHA}/pulls?per_page=100`
      ) {
        return reviewedPullRequestResponse();
      }
      if (
        target === `repos/unbraind/pm-cli/git/commits/${SHA}` ||
        target === `repos/unbraind/pm-cli/git/commits/${PARENT_SHA}`
      ) {
        return {
          status: 0,
          stdout: JSON.stringify({ tree: { sha: treeSha } }),
          stderr: "",
        };
      }
      if (
        target === `repos/unbraind/pm-cli/commits/${SHA}` ||
        target === `repos/unbraind/pm-cli/commits/${PARENT_SHA}`
      ) {
        return { status: null, stdout: "x".repeat(1_048_577), stderr: "" };
      }
      return analyzerEvidenceOrEmpty(args);
    });
    vi.doMock("node:child_process", () => ({ spawnSync }));

    const payload = await runJson([], "hostedAnalysisSquashTreeFallback");
    expect(payload).toMatchObject({
      ok: true,
      sha: SHA,
      analyzed_sha: PARENT_SHA,
      analysis_source: "identical_tree_squash_pr_head",
    });
    expect(
      spawnSync.mock.calls.filter(([, args]) =>
        String(args[1]).includes("/git/commits/"),
      ),
    ).toHaveLength(2);
    expect(process.exitCode).toBe(0);
  });

  it.each([
    { label: "unavailable pull-request association", pullsStatus: 1 },
    { label: "malformed pull-request association", pulls: "{" },
    { label: "non-array pull-request association", pulls: {} },
    {
      label: "ambiguous pull-request association",
      pulls: [
        {
          state: "closed",
          merged_at: "2026-07-26T00:02:53Z",
          merge_commit_sha: SHA,
          base: { ref: "main" },
          head: { sha: PARENT_SHA },
        },
        {
          state: "closed",
          merged_at: "2026-07-26T00:02:54Z",
          merge_commit_sha: SHA,
          base: { ref: "main" },
          head: { sha: "d61cdc0c58252072456661a4c08f4b431625f277" },
        },
      ],
    },
    { label: "unavailable merge message", pulls: [], mergeMessageStatus: 1 },
    {
      label: "unavailable merge pull-request resource",
      pulls: [],
      mergeMessage: "Merge pull request #1022 from unbraind/reviewed-head\n",
      mergePullStatus: 1,
    },
    {
      label: "malformed merge pull-request resource",
      pulls: [],
      mergeMessage: "Merge pull request #1022 from unbraind/reviewed-head\n",
      mergePull: "{",
    },
    {
      label: "non-terminal squash reference",
      pulls: [],
      mergeMessage: "Reviewed change (#1022) with trailing text\n",
    },
    {
      label: "squash message with mismatched pull-request merge",
      pulls: [],
      mergeMessage: "Reviewed change (#1022)\n",
      mergePull: {
        state: "closed",
        merged_at: "2026-07-26T00:02:53Z",
        merge_commit_sha: PARENT_SHA,
        base: { ref: "main" },
        head: { sha: PARENT_SHA },
      },
    },
    { label: "unavailable squash commit", exactCommitStatus: 1 },
    { label: "malformed squash commit", exactCommit: "{" },
    { label: "missing squash commit tree", exactCommit: {} },
    { label: "unavailable pull-request head", headCommitStatus: 1 },
    {
      label: "different pull-request head tree",
      headTree: "d61cdc0c58252072456661a4c08f4b431625f277",
    },
    {
      label: "unreadable pull-request head analyzer evidence",
      headEvidenceStatus: 1,
    },
  ])(
    "fails closed for $label",
    async ({
      label,
      pullsStatus = 0,
      pulls = [
        {
          state: "closed",
          merged_at: "2026-07-26T00:02:53Z",
          merge_commit_sha: SHA,
          base: { ref: "main" },
          head: { sha: PARENT_SHA },
        },
      ],
      exactCommitStatus = 0,
      exactCommit,
      headCommitStatus = 0,
      headTree = "c61cdc0c58252072456661a4c08f4b431625f276",
      headEvidenceStatus = 0,
      mergeMessageStatus = 0,
      mergeMessage = "",
      mergePullStatus = 0,
      mergePull = {},
    }) => {
      const treeSha = "c61cdc0c58252072456661a4c08f4b431625f276";
      const pullsOutput =
        typeof pulls === "string" ? pulls : JSON.stringify(pulls);
      const exactCommitOutput =
        typeof exactCommit === "string"
          ? exactCommit
          : JSON.stringify(exactCommit ?? { tree: { sha: treeSha } });
      const spawnSync = vi.fn((_command: string, args: string[]) => {
        const base = squashBaseResponse(args, {
          message: mergeMessage,
          messageStatus: mergeMessageStatus,
          pullsOutput,
          pullsStatus,
          treeSha,
        });
        if (base !== null) {
          return base;
        }
        const target = String(args[1] ?? "");
        if (target === "repos/unbraind/pm-cli/pulls/1022") {
          return {
            status: mergePullStatus,
            stdout:
              typeof mergePull === "string"
                ? mergePull
                : JSON.stringify(mergePull),
            stderr: "",
          };
        }
        if (target === `repos/unbraind/pm-cli/git/commits/${SHA}`) {
          return {
            status: exactCommitStatus,
            stdout: exactCommitOutput,
            stderr: "",
          };
        }
        if (target === `repos/unbraind/pm-cli/git/commits/${PARENT_SHA}`) {
          return {
            status: headCommitStatus,
            stdout: JSON.stringify({ tree: { sha: headTree } }),
            stderr: "",
          };
        }
        return analyzerEvidenceOrEmpty(args, PARENT_SHA, headEvidenceStatus);
      });
      vi.doMock("node:child_process", () => ({ spawnSync }));

      const payload = await runJson(
        [],
        `hostedAnalysisRejectedSquashFallback-${label}`,
      );
      expect(payload).toMatchObject({
        ok: false,
        releasable: false,
        reason: expect.stringContaining(
          "Release analyzer provenance precondition failed",
        ),
        release_precondition: {
          id: "reviewed_pull_request_analyzer_evidence",
          required_arrival:
            "reviewed_pull_request_to_main_or_exact_commit_analysis",
          direct_main_policy: "refuse_without_exact_commit_analyzer_evidence",
          required_analyzers: ["CodeFactor", "DeepScan"],
        },
      });
      expect(process.exitCode).toBe(1);
    },
  );

  it.each([
    {
      label: "missing merge parent",
      parentStatus: 1,
      parentValue: PARENT_SHA,
      exactTreeStatus: 0,
      parentTreeStatus: 0,
      parentTree: SHA,
    },
    {
      label: "invalid merge parent",
      parentStatus: 0,
      parentValue: "main",
      exactTreeStatus: 0,
      parentTreeStatus: 0,
      parentTree: SHA,
    },
    {
      label: "missing exact tree",
      parentStatus: 0,
      parentValue: PARENT_SHA,
      exactTreeStatus: 1,
      parentTreeStatus: 0,
      parentTree: SHA,
    },
    {
      label: "missing parent tree",
      parentStatus: 0,
      parentValue: PARENT_SHA,
      exactTreeStatus: 0,
      parentTreeStatus: 1,
      parentTree: SHA,
    },
    {
      label: "different parent tree",
      parentStatus: 0,
      parentValue: PARENT_SHA,
      exactTreeStatus: 0,
      parentTreeStatus: 0,
      parentTree: "d61cdc0c58252072456661a4c08f4b431625f277",
    },
  ])(
    "rejects $label as analyzer evidence",
    async ({
      label,
      parentStatus,
      parentValue,
      exactTreeStatus,
      parentTreeStatus,
      parentTree,
    }) => {
      const exactTree = "c61cdc0c58252072456661a4c08f4b431625f276";
      const spawnSync = vi.fn((_command: string, args: string[]) => {
        const target = String(args[1] ?? "");
        if (args[0] === "rev-parse") {
          if (target.endsWith("^2")) {
            return {
              status: parentStatus,
              stdout: `${parentValue}\n`,
              stderr: "",
            };
          }
          if (target === `${SHA}^{tree}`) {
            return {
              status: exactTreeStatus,
              stdout: `${exactTree}\n`,
              stderr: "",
            };
          }
          if (target.endsWith("^{tree}")) {
            return {
              status: parentTreeStatus,
              stdout: `${parentTree}\n`,
              stderr: "",
            };
          }
          return { status: 0, stdout: `${SHA}\n`, stderr: "" };
        }
        if (target.endsWith("/protection")) {
          return {
            status: 0,
            stdout: JSON.stringify(STRICT_PROTECTION),
            stderr: "",
          };
        }
        if (
          target === `repos/unbraind/pm-cli/commits/${SHA}/pulls?per_page=100`
        ) {
          return reviewedPullRequestResponse();
        }
        if (target.endsWith("/status")) {
          return {
            status: 0,
            stdout: JSON.stringify({ statuses: [] }),
            stderr: "",
          };
        }
        if (target.includes("/check-runs")) {
          return {
            status: 0,
            stdout: JSON.stringify({ check_runs: [] }),
            stderr: "",
          };
        }
        return { status: 0, stdout: "unbraind/pm-cli\n", stderr: "" };
      });
      vi.doMock("node:child_process", () => ({ spawnSync }));

      const payload = await runJson(
        [],
        `hostedAnalysisRejectedMergeFallback-${label}`,
      );
      expect(payload).toMatchObject({
        ok: false,
        releasable: false,
        reason: expect.stringContaining(
          "direct-main commits without exact analyzer evidence are not releasable",
        ),
      });
      expect(process.exitCode).toBe(1);
    },
  );

  it("fails closed when identical-tree parent analyzer evidence cannot be read", async () => {
    const treeSha = "c61cdc0c58252072456661a4c08f4b431625f276";
    let statusReads = 0;
    const spawnSync = vi.fn((_command: string, args: string[]) => {
      const target = String(args[1] ?? "");
      if (args[0] === "rev-parse") {
        if (target.endsWith("^2"))
          return { status: 0, stdout: `${PARENT_SHA}\n`, stderr: "" };
        if (target.endsWith("^{tree}"))
          return { status: 0, stdout: `${treeSha}\n`, stderr: "" };
        return { status: 0, stdout: `${SHA}\n`, stderr: "" };
      }
      if (target.endsWith("/protection")) {
        return {
          status: 0,
          stdout: JSON.stringify(STRICT_PROTECTION),
          stderr: "",
        };
      }
      if (
        target === `repos/unbraind/pm-cli/commits/${SHA}/pulls?per_page=100`
      ) {
        return reviewedPullRequestResponse();
      }
      if (target.endsWith("/status")) {
        statusReads += 1;
        return statusReads === 1
          ? { status: 0, stdout: JSON.stringify({ statuses: [] }), stderr: "" }
          : { status: 1, stdout: "", stderr: "unavailable" };
      }
      if (target.includes("/check-runs")) {
        return {
          status: 0,
          stdout: JSON.stringify({ check_runs: [] }),
          stderr: "",
        };
      }
      return { status: 0, stdout: "unbraind/pm-cli\n", stderr: "" };
    });
    vi.doMock("node:child_process", () => ({ spawnSync }));

    const payload = await runJson(
      [],
      "hostedAnalysisUnreadableMergeParentEvidence",
    );
    expect(payload).toMatchObject({
      ok: false,
      releasable: false,
      reason: expect.stringContaining(
        "Release analyzer provenance precondition failed",
      ),
    });
    expect(process.exitCode).toBe(1);
  });

  it.each([
    {
      label: "DeepScan failure with missing CodeFactor",
      statuses: {
        statuses: [
          {
            context: "DeepScan",
            state: "failure",
            description: "2 new issues",
          },
        ],
      },
      checks: { check_runs: [] },
      reason: "DeepScan is not successful",
    },
    {
      label: "missing DeepScan with CodeFactor failure",
      statuses: { statuses: [] },
      checks: {
        check_runs: [
          {
            name: "CodeFactor",
            status: "completed",
            conclusion: "failure",
            output: { title: "2 issues found." },
          },
        ],
      },
      reason: "DeepScan status is missing for the exact commit",
    },
  ])(
    "does not replace partial exact evidence for $label",
    async ({ label, statuses, checks, reason }) => {
      const spawnSync = mockCommands({ statuses, checks });
      const payload = await runJson([], `hostedAnalysisPartialExact-${label}`);
      expect(payload.ok).toBe(false);
      expect(payload.reason).toContain(reason);
      expect(
        spawnSync.mock.calls.some(
          ([, args]) =>
            args[0] === "rev-parse" && String(args[1]).endsWith("^2"),
        ),
      ).toBe(false);
      expect(process.exitCode).toBe(1);
    },
  );

  it.each([
    {
      label: "invalidRepository",
      args: ["--repo", "https://github.com/unbraind/pm-cli", "--sha", SHA],
      expected: "invalid --repo",
    },
    {
      label: "invalidSha",
      args: ["--repo", "unbraind/pm-cli", "--sha", "main"],
      expected: "invalid --sha",
    },
  ])("rejects $label input", async ({ label, args, expected }) => {
    mockCommands();
    const payload = await runJson(args, `hostedAnalysis${label}`);
    expect(payload).toMatchObject({ ok: false });
    expect(payload.reason).toContain(expected);
    expect(process.exitCode).toBe(1);
  });

  it.each([
    {
      label: "repo",
      failures: { repo: 1 },
      expected: "resolve the GitHub repository",
    },
    {
      label: "sha",
      failures: { sha: 1 },
      expected: "resolve the current Git HEAD",
    },
    {
      label: "statuses",
      failures: { statuses: 1 },
      expected: "read commit statuses",
    },
    { label: "checks", failures: { checks: 1 }, expected: "read check runs" },
    {
      label: "protection",
      failures: { protection: 1, graphqlProtection: 1, branchSummary: 1 },
      expected: "contents-readable branch summary",
    },
  ])(
    "fails when the $label command fails",
    async ({ label, failures, expected }) => {
      mockCommands({ failures });
      const payload = await runJson([], `hostedAnalysisCommand${label}`);
      expect(payload.reason).toContain(expected);
      expect(process.exitCode).toBe(1);
    },
  );

  it("normalizes omitted command output when repository discovery fails", async () => {
    const spawnSync = vi.fn(() => ({ status: 1 }));
    vi.doMock("node:child_process", () => ({ spawnSync }));
    const payload = await runJson([], "hostedAnalysisMissingCommandOutput");
    expect(payload.reason).toContain("resolve the GitHub repository");
  });

  it.each([
    {
      label: "statusSyntax",
      statuses: "{",
      checks: undefined,
      expected: "commit status API returned invalid JSON",
    },
    {
      label: "statusArray",
      statuses: [],
      checks: undefined,
      expected: "commit status API returned a non-object",
    },
    {
      label: "checksSyntax",
      statuses: undefined,
      checks: "{",
      expected: "check-runs API returned invalid JSON",
    },
    {
      label: "checksNull",
      statuses: undefined,
      checks: null,
      expected: "check-runs API returned a non-object",
    },
    {
      label: "protectionSyntax",
      statuses: undefined,
      checks: undefined,
      protection: "{",
      expected: "branch protection API returned invalid JSON",
    },
  ])(
    "rejects malformed $label payloads",
    async ({ label, statuses, checks, protection, expected }) => {
      mockCommands({
        ...(statuses === undefined ? {} : { statuses }),
        ...(checks === undefined ? {} : { checks }),
        ...(protection === undefined ? {} : { protection }),
      });
      const payload = await runJson([], `hostedAnalysisMalformed${label}`);
      expect(payload.reason).toContain(expected);
      expect(process.exitCode).toBe(1);
    },
  );

  it.each([
    {
      label: "invalid JSON",
      branchSummary: "{",
      expected: "main branch summary API returned invalid JSON",
    },
    {
      label: "array payload",
      branchSummary: [],
      expected: "main branch summary API returned a non-object",
    },
    {
      label: "unprotected branch",
      branchSummary: { ...EFFECTIVE_BRANCH_SUMMARY, protected: false },
      expected: "does not report enabled protection",
    },
    {
      label: "disabled protection",
      branchSummary: {
        ...EFFECTIVE_BRANCH_SUMMARY,
        protection: { ...EFFECTIVE_BRANCH_SUMMARY.protection, enabled: false },
      },
      expected: "does not report enabled protection",
    },
    {
      label: "missing branch SHA",
      branchSummary: { ...EFFECTIVE_BRANCH_SUMMARY, commit: {} },
      expected: "does not match the release candidate SHA",
    },
    {
      label: "different branch SHA",
      branchSummary: {
        ...EFFECTIVE_BRANCH_SUMMARY,
        commit: { sha: PARENT_SHA },
      },
      expected: "does not match the release candidate SHA",
    },
    {
      label: "missing required checks",
      branchSummary: {
        ...EFFECTIVE_BRANCH_SUMMARY,
        protection: { enabled: true },
      },
      expected: "has no required status checks",
    },
    {
      label: "unenforced required checks",
      branchSummary: {
        ...EFFECTIVE_BRANCH_SUMMARY,
        protection: {
          ...EFFECTIVE_BRANCH_SUMMARY.protection,
          required_status_checks: {
            ...EFFECTIVE_BRANCH_SUMMARY.protection.required_status_checks,
            enforcement_level: "off",
          },
        },
      },
      expected: "does not report enforced required status checks",
    },
    {
      label: "missing analyzer context",
      branchSummary: {
        ...EFFECTIVE_BRANCH_SUMMARY,
        protection: {
          ...EFFECTIVE_BRANCH_SUMMARY.protection,
          required_status_checks: {
            contexts: ["DeepScan"],
            checks: [],
            enforcement_level: "everyone",
          },
        },
      },
      expected: "CodeFactor",
    },
  ])(
    "fails closed for branch summary with $label",
    async ({ label, branchSummary, expected }) => {
      mockCommands({
        branchSummary,
        failures: { protection: 1, graphqlProtection: 1 },
      });
      const payload = await runJson([], `hostedAnalysisBranchSummary-${label}`);
      expect(payload.reason).toContain(expected);
      expect(process.exitCode).toBe(1);
    },
  );

  it.each([
    {
      label: "invalid JSON",
      graphqlProtection: "{",
      expected: "GraphQL API returned invalid JSON",
    },
    {
      label: "missing rules",
      graphqlProtection: {
        pages: [{ data: { repository: {} } }],
      },
      expected: "page 1 has no rules array",
    },
    {
      label: "missing exact main rule",
      graphqlProtection: {
        pages: [
          {
            data: {
              repository: {
                branchProtectionRules: {
                  nodes: [{ pattern: "release/*" }],
                  pageInfo: { hasNextPage: false, endCursor: "cursor-1" },
                },
              },
            },
          },
        ],
      },
      expected: "returned 0 exact main rules",
    },
    {
      label: "ambiguous exact main rules",
      graphqlProtection: {
        pages: [
          {
            data: {
              repository: {
                branchProtectionRules: {
                  nodes: [{ pattern: "main" }, { pattern: "main" }],
                  pageInfo: { hasNextPage: false, endCursor: "cursor-1" },
                },
              },
            },
          },
        ],
      },
      expected: "returned 2 exact main rules",
    },
  ])(
    "fails closed for GraphQL branch protection with $label",
    async ({ label, graphqlProtection, expected }) => {
      mockCommands({ graphqlProtection, failures: { protection: 1 } });
      const payload = await runJson(
        [],
        `hostedAnalysisGraphqlProtection-${label}`,
      );
      expect(payload.reason).toContain(expected);
      expect(process.exitCode).toBe(1);
    },
  );

  it.each([
    {
      label: "non-array page envelope",
      graphqlProtection: {},
      expected: "returned no paginated policy pages",
    },
    {
      label: "empty page envelope",
      graphqlProtection: { pages: [] },
      expected: "returned no paginated policy pages",
    },
    {
      label: "invalid page metadata",
      graphqlProtection: {
        pages: [
          {
            data: {
              repository: {
                branchProtectionRules: {
                  nodes: [],
                  pageInfo: { hasNextPage: "false" },
                },
              },
            },
          },
        ],
      },
      expected: "invalid pagination metadata",
    },
    {
      label: "truncated last page",
      graphqlProtection: {
        pages: [
          {
            data: {
              repository: {
                branchProtectionRules: {
                  nodes: [{ pattern: "main" }],
                  pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
                },
              },
            },
          },
        ],
      },
      expected: "inconsistent pagination termination",
    },
    {
      label: "unexpected extra page",
      graphqlProtection: {
        pages: [
          {
            data: {
              repository: {
                branchProtectionRules: {
                  nodes: [],
                  pageInfo: { hasNextPage: false, endCursor: "cursor-1" },
                },
              },
            },
          },
          {
            data: {
              repository: {
                branchProtectionRules: {
                  nodes: [],
                  pageInfo: { hasNextPage: false, endCursor: "cursor-2" },
                },
              },
            },
          },
        ],
      },
      expected: "inconsistent pagination termination",
    },
    {
      label: "missing continuation cursor",
      graphqlProtection: {
        pages: [
          {
            data: {
              repository: {
                branchProtectionRules: {
                  nodes: [],
                  pageInfo: { hasNextPage: true, endCursor: "" },
                },
              },
            },
          },
          {
            data: {
              repository: {
                branchProtectionRules: {
                  nodes: [],
                  pageInfo: { hasNextPage: false, endCursor: "cursor-2" },
                },
              },
            },
          },
        ],
      },
      expected: "has no continuation cursor",
    },
    {
      label: "duplicate main rule on a later page",
      graphqlProtection: {
        pages: [
          {
            data: {
              repository: {
                branchProtectionRules: {
                  nodes: [{ pattern: "main" }],
                  pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
                },
              },
            },
          },
          {
            data: {
              repository: {
                branchProtectionRules: {
                  nodes: [{ pattern: "main" }],
                  pageInfo: { hasNextPage: false, endCursor: "cursor-2" },
                },
              },
            },
          },
        ],
      },
      expected: "returned 2 exact main rules",
    },
  ])(
    "fails closed for GraphQL pagination with $label",
    async ({ label, graphqlProtection, expected }) => {
      mockCommands({ graphqlProtection, failures: { protection: 1 } });
      const payload = await runJson(
        [],
        `hostedAnalysisGraphqlPagination-${label}`,
      );
      expect(payload.reason).toContain(expected);
      expect(process.exitCode).toBe(1);
    },
  );

  it.each([
    {
      label: "missing",
      statuses: { statuses: [] },
      expected: "DeepScan status is missing",
    },
    {
      label: "missingStatusesArray",
      statuses: {},
      expected: "DeepScan status is missing",
    },
    {
      label: "failed",
      statuses: {
        statuses: [
          {
            context: "DeepScan",
            state: "failure",
            description: "2 new and 0 fixed issues",
          },
        ],
      },
      expected: "2 new and 0 fixed issues",
    },
    {
      label: "unknownState",
      statuses: { statuses: [{ context: "DeepScan" }] },
      expected: "unknown: no description",
    },
    {
      label: "ambiguous",
      statuses: {
        statuses: [
          {
            context: "DeepScan",
            state: "success",
            description: "Analysis passed",
          },
        ],
      },
      expected: "does not explicitly prove 0 new",
    },
  ])(
    "rejects DeepScan $label evidence",
    async ({ label, statuses, expected }) => {
      mockCommands({ statuses });
      const payload = await runJson([], `hostedAnalysisDeepScan${label}`);
      expect(payload.reason).toContain(expected);
      expect(process.exitCode).toBe(1);
    },
  );

  it.each([
    {
      label: "missing",
      checks: { check_runs: [] },
      expected: "CodeFactor check run is missing",
    },
    {
      label: "missingCheckRunsArray",
      checks: {},
      expected: "CodeFactor check run is missing",
    },
    {
      label: "pending",
      checks: { check_runs: [{ name: "CodeFactor", status: "in_progress" }] },
      expected: "not complete (in_progress)",
    },
    {
      label: "unknownStatus",
      checks: { check_runs: [{ name: "CodeFactor" }] },
      expected: "not complete (unknown)",
    },
    {
      label: "failed",
      checks: {
        check_runs: [
          { name: "CodeFactor", status: "completed", conclusion: "failure" },
        ],
      },
      expected: "did not succeed (failure)",
    },
    {
      label: "unknownConclusion",
      checks: { check_runs: [{ name: "CodeFactor", status: "completed" }] },
      expected: "did not succeed (unknown)",
    },
    {
      label: "ambiguous",
      checks: {
        check_runs: [
          {
            name: "CodeFactor",
            status: "completed",
            conclusion: "success",
            output: { title: "Grade A+", annotations_count: 0 },
          },
        ],
      },
      expected:
        "title does not explicitly report no issues or fixed-only results",
    },
    {
      label: "missingTitle",
      checks: {
        check_runs: [
          {
            name: "CodeFactor",
            status: "completed",
            conclusion: "success",
            output: { annotations_count: 0 },
          },
        ],
      },
      expected:
        "title does not explicitly report no issues or fixed-only results",
    },
    {
      label: "missingAnnotationCount",
      checks: {
        check_runs: [
          {
            name: "CodeFactor",
            status: "completed",
            conclusion: "success",
            output: { title: "No issues found." },
          },
        ],
      },
      expected: "0 outstanding annotations (unknown)",
    },
    {
      label: "outstandingAnnotation",
      checks: {
        check_runs: [
          {
            name: "CodeFactor",
            status: "completed",
            conclusion: "success",
            output: { title: "1 issue fixed.", annotations_count: 1 },
          },
        ],
      },
      expected: "0 outstanding annotations (1)",
    },
  ])(
    "rejects CodeFactor $label evidence",
    async ({ label, checks, expected }) => {
      mockCommands({ checks });
      const payload = await runJson([], `hostedAnalysisCodeFactor${label}`);
      expect(payload.reason).toContain(expected);
      expect(process.exitCode).toBe(1);
    },
  );

  it("prints a bounded human failure without dumping hosted payloads", async () => {
    mockCommands({ statuses: { statuses: [] } });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.argv = ["node", "scripts/release/hosted-analysis-gate.mjs"];
    await harness.importModule(
      "scripts/release/hosted-analysis-gate.mjs",
      "hostedAnalysisHumanFailure",
    );
    expect(String(errorSpy.mock.calls.at(-1)?.[0] ?? "")).toBe(
      "Hosted analysis gate failed: DeepScan status is missing for the exact commit",
    );
  });

  it.each([
    {
      label: "missingRequiredChecks",
      protection: {},
      expected: "has no required status checks",
    },
    {
      label: "nullRequiredChecks",
      protection: { required_status_checks: null },
      expected: "has no required status checks",
    },
    {
      label: "nonStrict",
      protection: {
        required_status_checks: {
          strict: false,
          contexts: ["CodeFactor", "DeepScan"],
        },
      },
      expected: "does not require branches to be up to date",
    },
    {
      label: "missingBoth",
      protection: { required_status_checks: { strict: true } },
      expected: "CodeFactor, DeepScan",
    },
    {
      label: "missingDeepScan",
      protection: {
        required_status_checks: {
          strict: true,
          contexts: [42],
          checks: [null, { context: "CodeFactor" }, { context: 42 }],
        },
      },
      expected: "DeepScan",
    },
  ])(
    "rejects branch protection $label policy",
    async ({ label, protection, expected }) => {
      mockCommands({ protection });
      const payload = await runJson([], `hostedAnalysisProtection${label}`);
      expect(payload.reason).toContain(expected);
      expect(process.exitCode).toBe(1);
    },
  );
});
