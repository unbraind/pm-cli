import { afterEach, describe, expect, it, vi } from "vitest";

import { createScriptHarness } from "../../../helpers/scriptModule";

const harness = createScriptHarness();
const SHA = "a61cdc0c58252072456661a4c08f4b431625f274";
const PARENT_SHA = "b61cdc0c58252072456661a4c08f4b431625f275";

interface GatePayload {
  ok: boolean;
  reason?: string;
  repository?: string;
  sha?: string;
  analyzed_sha?: string;
  analysis_source?: string;
  analyzers?: {
    deepscan: { new_issues: number };
    codefactor: { new_issues: number };
  };
  branch_protection?: {
    branch: string;
    strict: boolean;
    required_analyzers: string[];
  };
}

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

/** Install deterministic command responses for one hosted-analysis gate run. */
function mockCommands({
  repository = "unbraind/pm-cli",
  sha = SHA,
  statuses = { statuses: [{ context: "DeepScan", state: "success", description: "0 new and 2 fixed issues" }] },
  checks = {
    check_runs: [
      {
        name: "CodeFactor",
        status: "completed",
        conclusion: "success",
        output: { title: "No issues found." },
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
  failures = {},
}: {
  repository?: string;
  sha?: string;
  statuses?: unknown;
  checks?: unknown;
  protection?: unknown;
  failures?: Partial<Record<"repo" | "sha" | "statuses" | "checks" | "protection", number>>;
} = {}) {
  const spawnSync = vi.fn((_command: string, args: string[]) => {
    if (args[0] === "repo") {
      return { status: failures.repo ?? 0, stdout: `${repository}\n`, stderr: "" };
    }
    if (args[0] === "rev-parse") {
      return { status: failures.sha ?? 0, stdout: `${sha}\n`, stderr: "" };
    }
    if (String(args[1]).endsWith("/status")) {
      return {
        status: failures.statuses ?? 0,
        stdout: typeof statuses === "string" ? statuses : JSON.stringify(statuses),
        stderr: "",
      };
    }
    if (String(args[1]).endsWith("/protection")) {
      return {
        status: failures.protection ?? 0,
        stdout: typeof protection === "string" ? protection : JSON.stringify(protection),
        stderr: "",
      };
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

/** Run the script module once and parse its JSON result. */
async function runJson(args: string[], label: string): Promise<GatePayload> {
  process.argv = ["node", "scripts/release/hosted-analysis-gate.mjs", "--json", ...args];
  const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  await harness.importModule("scripts/release/hosted-analysis-gate.mjs", label);
  return JSON.parse(String(writeSpy.mock.calls.at(-1)?.[0] ?? "{}")) as GatePayload;
}

describe("scripts/release/hosted-analysis-gate", () => {
  it("prints usage without spawning commands", async () => {
    const spawnSync = mockCommands();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    process.argv = ["node", "scripts/release/hosted-analysis-gate.mjs", "--help"];
    await harness.importModule("scripts/release/hosted-analysis-gate.mjs", "hostedAnalysisHelp");
    expect(spawnSync).not.toHaveBeenCalled();
    expect(String(logSpy.mock.calls.at(-1)?.[0] ?? "")).toContain("--sha");
  });

  it("passes only explicit zero-new-issue evidence for an exact supplied head", async () => {
    const spawnSync = mockCommands();
    const payload = await runJson(["--repo", "unbraind/pm-cli", "--sha", SHA], "hostedAnalysisPass");
    expect(payload).toMatchObject({
      ok: true,
      repository: "unbraind/pm-cli",
      sha: SHA,
      analyzers: {
        deepscan: { new_issues: 0 },
        codefactor: { new_issues: 0 },
      },
      branch_protection: {
        branch: "main",
        strict: true,
        required_analyzers: ["CodeFactor", "DeepScan"],
      },
    });
    expect(process.exitCode).toBe(0);
    expect(spawnSync).toHaveBeenCalledTimes(3);
  });

  it("resolves repository and SHA defaults and prints a human success result", async () => {
    mockCommands();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    process.argv = ["node", "scripts/release/hosted-analysis-gate.mjs"];
    await harness.importModule("scripts/release/hosted-analysis-gate.mjs", "hostedAnalysisDefaults");
    expect(String(logSpy.mock.calls.at(-1)?.[0] ?? "")).toContain("DeepScan 0 new issues");
    expect(process.exitCode).toBe(0);
  });

  it("reuses reviewed analyzer evidence only from an identical-tree merge parent", async () => {
    const parentSha = PARENT_SHA;
    const treeSha = "c61cdc0c58252072456661a4c08f4b431625f276";
    const spawnSync = vi.fn((_command: string, args: string[]) => {
      const target = String(args[1] ?? "");
      if (args[0] === "rev-parse") {
        if (target.endsWith("^2")) return { status: 0, stdout: `${parentSha}\n`, stderr: "" };
        if (target.endsWith("^{tree}")) return { status: 0, stdout: `${treeSha}\n`, stderr: "" };
        return { status: 0, stdout: `${SHA}\n`, stderr: "" };
      }
      if (target.endsWith("/protection")) {
        return {
          status: 0,
          stdout: JSON.stringify({
            required_status_checks: {
              strict: true,
              contexts: ["DeepScan"],
              checks: [{ context: "CodeFactor" }],
            },
          }),
          stderr: "",
        };
      }
      if (target.includes(`/commits/${parentSha}/status`)) {
        return {
          status: 0,
          stdout: JSON.stringify({
            statuses: [{ context: "DeepScan", state: "success", description: "0 new issues" }],
          }),
          stderr: "",
        };
      }
      if (target.includes(`/commits/${parentSha}/check-runs`)) {
        return {
          status: 0,
          stdout: JSON.stringify({
            check_runs: [
              {
                name: "CodeFactor",
                status: "completed",
                conclusion: "success",
                output: { title: "No issues found." },
              },
            ],
          }),
          stderr: "",
        };
      }
      if (target.endsWith("/status")) {
        return { status: 0, stdout: JSON.stringify({ statuses: [] }), stderr: "" };
      }
      if (target.includes("/check-runs")) {
        return { status: 0, stdout: JSON.stringify({ check_runs: [] }), stderr: "" };
      }
      return { status: 0, stdout: "unbraind/pm-cli\n", stderr: "" };
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

  it.each([
    { label: "missing merge parent", parentStatus: 1, parentValue: PARENT_SHA, exactTreeStatus: 0, parentTreeStatus: 0, parentTree: SHA },
    { label: "invalid merge parent", parentStatus: 0, parentValue: "main", exactTreeStatus: 0, parentTreeStatus: 0, parentTree: SHA },
    { label: "missing exact tree", parentStatus: 0, parentValue: PARENT_SHA, exactTreeStatus: 1, parentTreeStatus: 0, parentTree: SHA },
    { label: "missing parent tree", parentStatus: 0, parentValue: PARENT_SHA, exactTreeStatus: 0, parentTreeStatus: 1, parentTree: SHA },
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
    async ({ label, parentStatus, parentValue, exactTreeStatus, parentTreeStatus, parentTree }) => {
      const exactTree = "c61cdc0c58252072456661a4c08f4b431625f276";
      const spawnSync = vi.fn((_command: string, args: string[]) => {
        const target = String(args[1] ?? "");
        if (args[0] === "rev-parse") {
          if (target.endsWith("^2")) {
            return { status: parentStatus, stdout: `${parentValue}\n`, stderr: "" };
          }
          if (target === `${SHA}^{tree}`) {
            return { status: exactTreeStatus, stdout: `${exactTree}\n`, stderr: "" };
          }
          if (target.endsWith("^{tree}")) {
            return { status: parentTreeStatus, stdout: `${parentTree}\n`, stderr: "" };
          }
          return { status: 0, stdout: `${SHA}\n`, stderr: "" };
        }
        if (target.endsWith("/protection")) {
          return {
            status: 0,
            stdout: JSON.stringify({
              required_status_checks: {
                strict: true,
                contexts: ["DeepScan"],
                checks: [{ context: "CodeFactor" }],
              },
            }),
            stderr: "",
          };
        }
        if (target.endsWith("/status")) {
          return { status: 0, stdout: JSON.stringify({ statuses: [] }), stderr: "" };
        }
        if (target.includes("/check-runs")) {
          return {
            status: 0,
            stdout: JSON.stringify({
              check_runs: [
                {
                  name: "CodeFactor",
                  status: "completed",
                  conclusion: "success",
                  output: { title: "No issues found." },
                },
              ],
            }),
            stderr: "",
          };
        }
        return { status: 0, stdout: "unbraind/pm-cli\n", stderr: "" };
      });
      vi.doMock("node:child_process", () => ({ spawnSync }));

      const payload = await runJson([], `hostedAnalysisRejectedMergeFallback-${label}`);
      expect(payload).toMatchObject({
        ok: false,
        reason: "DeepScan status is missing for the exact commit",
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
        if (target.endsWith("^2")) return { status: 0, stdout: `${PARENT_SHA}\n`, stderr: "" };
        if (target.endsWith("^{tree}")) return { status: 0, stdout: `${treeSha}\n`, stderr: "" };
        return { status: 0, stdout: `${SHA}\n`, stderr: "" };
      }
      if (target.endsWith("/protection")) {
        return {
          status: 0,
          stdout: JSON.stringify({
            required_status_checks: {
              strict: true,
              contexts: ["DeepScan"],
              checks: [{ context: "CodeFactor" }],
            },
          }),
          stderr: "",
        };
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
          stdout: JSON.stringify({
            check_runs: [
              {
                name: "CodeFactor",
                status: "completed",
                conclusion: "success",
                output: { title: "No issues found." },
              },
            ],
          }),
          stderr: "",
        };
      }
      return { status: 0, stdout: "unbraind/pm-cli\n", stderr: "" };
    });
    vi.doMock("node:child_process", () => ({ spawnSync }));

    const payload = await runJson([], "hostedAnalysisUnreadableMergeParentEvidence");
    expect(payload).toMatchObject({
      ok: false,
      reason: "DeepScan status is missing for the exact commit",
    });
    expect(process.exitCode).toBe(1);
  });

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
    { label: "repo", failures: { repo: 1 }, expected: "resolve the GitHub repository" },
    { label: "sha", failures: { sha: 1 }, expected: "resolve the current Git HEAD" },
    { label: "statuses", failures: { statuses: 1 }, expected: "read commit statuses" },
    { label: "checks", failures: { checks: 1 }, expected: "read check runs" },
    { label: "protection", failures: { protection: 1 }, expected: "read main branch protection" },
  ])("fails when the $label command fails", async ({ label, failures, expected }) => {
    mockCommands({ failures });
    const payload = await runJson([], `hostedAnalysisCommand${label}`);
    expect(payload.reason).toContain(expected);
    expect(process.exitCode).toBe(1);
  });

  it("normalizes omitted command output when repository discovery fails", async () => {
    const spawnSync = vi.fn(() => ({ status: 1 }));
    vi.doMock("node:child_process", () => ({ spawnSync }));
    const payload = await runJson([], "hostedAnalysisMissingCommandOutput");
    expect(payload.reason).toContain("resolve the GitHub repository");
  });

  it.each([
    { label: "statusSyntax", statuses: "{", checks: undefined, expected: "commit status API returned invalid JSON" },
    { label: "statusArray", statuses: [], checks: undefined, expected: "commit status API returned a non-object" },
    { label: "checksSyntax", statuses: undefined, checks: "{", expected: "check-runs API returned invalid JSON" },
    { label: "checksNull", statuses: undefined, checks: null, expected: "check-runs API returned a non-object" },
    {
      label: "protectionSyntax",
      statuses: undefined,
      checks: undefined,
      protection: "{",
      expected: "branch protection API returned invalid JSON",
    },
  ])("rejects malformed $label payloads", async ({ label, statuses, checks, protection, expected }) => {
    mockCommands({
      ...(statuses === undefined ? {} : { statuses }),
      ...(checks === undefined ? {} : { checks }),
      ...(protection === undefined ? {} : { protection }),
    });
    const payload = await runJson([], `hostedAnalysisMalformed${label}`);
    expect(payload.reason).toContain(expected);
    expect(process.exitCode).toBe(1);
  });

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
      statuses: { statuses: [{ context: "DeepScan", state: "failure", description: "2 new and 0 fixed issues" }] },
      expected: "2 new and 0 fixed issues",
    },
    {
      label: "unknownState",
      statuses: { statuses: [{ context: "DeepScan" }] },
      expected: "unknown: no description",
    },
    {
      label: "ambiguous",
      statuses: { statuses: [{ context: "DeepScan", state: "success", description: "Analysis passed" }] },
      expected: "does not explicitly prove 0 new",
    },
  ])("rejects DeepScan $label evidence", async ({ label, statuses, expected }) => {
    mockCommands({ statuses });
    const payload = await runJson([], `hostedAnalysisDeepScan${label}`);
    expect(payload.reason).toContain(expected);
    expect(process.exitCode).toBe(1);
  });

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
      checks: { check_runs: [{ name: "CodeFactor", status: "completed", conclusion: "failure" }] },
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
          { name: "CodeFactor", status: "completed", conclusion: "success", output: { title: "Grade A+" } },
        ],
      },
      expected: "does not explicitly report No issues found",
    },
    {
      label: "missingTitle",
      checks: { check_runs: [{ name: "CodeFactor", status: "completed", conclusion: "success" }] },
      expected: "does not explicitly report No issues found",
    },
  ])("rejects CodeFactor $label evidence", async ({ label, checks, expected }) => {
    mockCommands({ checks });
    const payload = await runJson([], `hostedAnalysisCodeFactor${label}`);
    expect(payload.reason).toContain(expected);
    expect(process.exitCode).toBe(1);
  });

  it("prints a bounded human failure without dumping hosted payloads", async () => {
    mockCommands({ statuses: { statuses: [] } });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.argv = ["node", "scripts/release/hosted-analysis-gate.mjs"];
    await harness.importModule("scripts/release/hosted-analysis-gate.mjs", "hostedAnalysisHumanFailure");
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
      protection: { required_status_checks: { strict: false, contexts: ["CodeFactor", "DeepScan"] } },
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
  ])("rejects branch protection $label policy", async ({ label, protection, expected }) => {
    mockCommands({ protection });
    const payload = await runJson([], `hostedAnalysisProtection${label}`);
    expect(payload.reason).toContain(expected);
    expect(process.exitCode).toBe(1);
  });
});
