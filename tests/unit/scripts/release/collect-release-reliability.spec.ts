/** Exercise paginated GitHub boundary shapes and real data-only artifact reads. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectReleaseReliability, completePages, main, validateReleaseObservation } from "../../../../scripts/release/collect-release-reliability.mjs";

const transport = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFileSync: transport }));
const policy = { schema: "release-reliability-policy/1", window_days: 30, cron_hour_utc: 2, cron_minute_utc: 35, max_dispatch_delay_minutes: 60, max_failure_rate: 0.1, min_completed_runs: 1 };
const run = { id: 42, event: "schedule", run_attempt: 1, created_at: "2026-09-24T02:40:00Z", run_started_at: "2026-09-24T02:42:00Z", status: "completed", conclusion: "success" };
const receipt = { schema: "release-observation/1", run_id: 42, run_attempt: 1, event: "schedule", outcome: "same_day_verified", failure_stage: null };

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); transport.mockReset(); });

describe("GitHub release reliability collector", () => {
  it("requires complete pages and unique identities", () => {
    expect(completePages(JSON.stringify([{ total_count: 2, rows: [{ id: 1 }] }, { total_count: 2, rows: [{ id: 2 }] }]), "rows")).toHaveLength(2);
    for (const input of ["[]", "{}", '[{"rows":[]}]', '[{"rows":[],"total_count":1}]', '[{"rows":[{"id":1},{"id":1}],"total_count":2}]']) {
      expect(() => completePages(input, "rows")).toThrow();
    }
  });

  it("refuses malformed or cross-attempt receipts", () => {
    for (const changed of [{ schema: "other" }, { run_id: 43 }, { run_attempt: 2 }, { event: "issues" }, { outcome: 3 }, { failure_stage: {} }]) {
      expect(() => validateReleaseObservation({ ...receipt, ...changed }, run)).toThrow();
    }
    expect(validateReleaseObservation({ ...receipt, failure_stage: "build" }, run).failure_stage).toBe("build");
  });

  it("recovers original failure after a green rerun and names structured failed steps", () => {
    const read = vi.fn((args: string[]) => {
      const endpoint = args[1] ?? "";
      if (endpoint.includes("/workflows/")) return JSON.stringify([{ total_count: 1, workflow_runs: [{ ...run, run_attempt: 2 }] }]);
      if (endpoint.endsWith("/attempts/1")) return JSON.stringify({ ...run, conclusion: "failure" });
      if (endpoint.includes("/artifacts")) return '[{"total_count":0,"artifacts":[]}]';
      return JSON.stringify([{ total_count: 1, jobs: [{ id: 9, name: "Release", steps: [{ name: "Build", conclusion: "failure" }, { name: "Setup", conclusion: "success" }] }] }]);
    });
    const report = collectReleaseReliability("owner/repo", policy, "2026-09-24T08:00:00Z", read);
    expect(report.failed).toBe(1);
    expect(report.failure_stages).toEqual({ "Release / Build": 1 });
    expect(read.mock.calls.some(([args]) => args[1]?.endsWith("/attempts/1"))).toBe(true);
  });

  it("reads an exact-attempt artifact and cleans its temporary directory", () => {
    let directory = "";
    const read = (args: string[]) => {
      if (args[0] === "run") {
        directory = args.at(-1) ?? "";
        mkdirSync(directory, { recursive: true });
        writeFileSync(path.join(directory, "release-observation.json"), JSON.stringify(receipt));
        return "";
      }
      return args[1]?.includes("/workflows/")
        ? JSON.stringify([{ total_count: 1, workflow_runs: [run] }])
        : JSON.stringify([{ total_count: 1, artifacts: [{ id: 1, name: "release-observation-1", expired: false }] }]);
    };
    expect(collectReleaseReliability("owner/repo", policy, "2026-09-24T08:00:00Z", read).outcomes).toEqual({ same_day_verified: 1 });
    expect(() => readFileSync(path.join(directory, "release-observation.json"))).toThrow();
  });

  it("rejects wrong original identities and ambiguous artifacts", () => {
    expect(() => collectReleaseReliability("../bad", policy, "2026-09-24T08:00:00Z", vi.fn())).toThrow("repository");
    for (const bad of [{ ...run, id: 7 }, { ...run, run_attempt: 2 }, { ...run, event: "issues" }]) {
      const read = (args: string[]) => args[1]?.includes("/workflows/") ? JSON.stringify([{ total_count: 1, workflow_runs: [{ ...run, run_attempt: 2 }] }]) : JSON.stringify(bad);
      expect(() => collectReleaseReliability("owner/repo", policy, "2026-09-24T08:00:00Z", read)).toThrow("attempt mismatch");
    }
    const read = (args: string[]) => args[1]?.includes("/workflows/") ? JSON.stringify([{ total_count: 1, workflow_runs: [run] }]) : JSON.stringify([{ total_count: 2, artifacts: [1, 2].map((id) => ({ id, name: "release-observation-1", expired: false })) }]);
    expect(() => collectReleaseReliability("owner/repo", policy, "2026-09-24T08:00:00Z", read)).toThrow("Ambiguous");
  });

  it("retains unrecorded failure and treats expired artifacts as unavailable", () => {
    const read = (args: string[]) => {
      if (args[1]?.includes("/workflows/")) return JSON.stringify([{ total_count: 1, workflow_runs: [{ ...run, conclusion: "cancelled" }] }]);
      if (args[1]?.includes("/artifacts")) return JSON.stringify([{ total_count: 2, artifacts: [{ id: 1, name: "release-observation-1", expired: true }, { id: 2, name: "other", expired: false }] }]);
      return '[{"total_count":0,"jobs":[]}]';
    };
    expect(collectReleaseReliability("owner/repo", policy, "2026-09-24T08:00:00Z", read).failure_stages).toEqual({ unrecorded: 1 });
  });

  it("writes a report before the workflow enforces its verdict and uses a bounded gh transport", () => {
    const root = mkdtempSync(path.join(tmpdir(), "pm-report-test-"));
    try {
      vi.stubEnv("GITHUB_REPOSITORY", "owner/repo");
      vi.stubEnv("RELEASE_RELIABILITY_OUTPUT", path.join(root, "report.json"));
      transport.mockReturnValue('[{"total_count":0,"workflow_runs":[]}]');
      expect(main().ok).toBe(false);
      expect(JSON.parse(readFileSync(path.join(root, "report.json"), "utf8")).census_complete).toBe(true);
      expect(transport).toHaveBeenCalledWith("gh", expect.any(Array), expect.objectContaining({ timeout: 60000 }));
      expect(collectReleaseReliability("owner/repo", policy, "2026-09-24T08:00:00Z").completed).toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
