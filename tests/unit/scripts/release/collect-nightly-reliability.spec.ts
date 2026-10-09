/** Exercise first-attempt collection, historical families and data-only alert correlation. */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseDocument } from "yaml";
import type * as childProcess from "node:child_process";
import { collectNightlyReliability, main, nightlyFamilies } from "../../../../scripts/release/collect-nightly-reliability.mjs";

const transport = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (original) => ({ ...await original<typeof childProcess>(), execFileSync: transport }));
const family = "Nightly (windows-latest, Node 24)";
const policy = { schema: "nightly-reliability-policy/1", window_days: 30, max_failure_rate: 0.1, min_completed_attempts: 1 };
const now = "2026-10-09T12:00:00Z";
const run = { id: 42, event: "schedule", head_branch: "main", run_attempt: 1, created_at: "2026-10-08T04:00:00Z" };
const job = { id: 7, name: family, status: "completed", conclusion: "failure" };
const issue = { id: 100, number: 12, title: "Nightly Validation failed: windows-latest / Node 24", body: "Run: https://github.com/owner/repo/actions/runs/42", html_url: "https://github.com/owner/repo/issues/12", closed_at: "2026-10-08T06:00:00Z" };

/** Build API page responses with independent declared totals. */
function pages(field: string, rows: unknown[]) {
  return JSON.stringify([{ total_count: rows.length, [field]: rows }]);
}

/** Supply only the external GitHub boundary; real SDK evaluation remains untouched. */
function reader(overrides: Record<string, string> = {}) {
  return vi.fn((args: string[]) => {
    const endpoint = args[1] ?? "";
    const key = endpoint === "repos/owner/repo" ? "repo"
      : endpoint.startsWith("search/") ? "issues"
        : endpoint.includes("/comments?") ? "comments"
          : endpoint.includes("/workflows/") ? "runs"
            : endpoint.endsWith("/attempts/1") ? "original" : "jobs";
    return overrides[key] ?? ({
      repo: '{"default_branch":"main"}', runs: pages("workflow_runs", [run]),
      original: JSON.stringify(run), jobs: pages("jobs", [job]),
      issues: JSON.stringify([{ total_count: 1, incomplete_results: false, items: [issue] }]), comments: "[[]]",
    })[key];
  });
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); transport.mockReset(); });

describe("nightly recurrence collector", () => {
  it("retains a repaired original failure and its stable all-state alert evidence", () => {
    const read = reader({ runs: pages("workflow_runs", [{ ...run, run_attempt: 2 }]) });
    const report = collectNightlyReliability("owner/repo", policy, now, [family], read);
    expect(report).toMatchObject({ ok: false, census_complete: true, attempt: 1, alert_count: 1 });
    expect(report.families[0]).toMatchObject({ completed: 1, failed: 1, failure_rate: 1, affected_days: ["2026-10-08"], repair_minutes: [120], causes: { unknown: 1 }, unresolved: 0 });
    expect(report.evidence[0]).toMatchObject({ run_id: 42, job_id: 7, repair_evidence: "alert_closure_only", alerts: [{ number: 12 }] });
    expect(read.mock.calls.some(([args]) => args[1]?.endsWith("/attempts/1"))).toBe(true);
    expect(read.mock.calls[1]?.[0][1]).toContain("event=schedule");
    expect(read.mock.calls[1]?.[0][1]).toContain("branch=main");
  });

  it("counts a clean observed period as zero failures while missing jobs remain pending", () => {
    const report = collectNightlyReliability("owner/repo", policy, now, [family, "Nightly (ubuntu-latest, Node 24)"], reader({ jobs: pages("jobs", [{ ...job, conclusion: "success" }]), issues: '[{"total_count":0,"incomplete_results":false,"items":[]}]' }));
    expect(report.families[0]).toMatchObject({ failure_rate: 0, ok: true, repair_minutes: [] });
    expect(report.families[1]).toMatchObject({ completed: 0, pending: 1, failure_rate: null, ok: false });
    expect(report.evidence[1]).toMatchObject({ job_id: null, repair_evidence: "unavailable", alerts: [] });
    expect(collectNightlyReliability("owner/repo", policy, now, [family], reader({ jobs: pages("jobs", [{ ...job, status: "in_progress" }]) })).families[0]?.pending).toBe(1);
  });

  it("preserves retired historical legs and deduplicates body/comment links to the same alert", () => {
    const current = "Nightly (windows-latest, Node 24, shard 1/2)";
    const report = collectNightlyReliability("owner/repo", policy, now, [current], reader({ comments: JSON.stringify([[{ id: 1, body: issue.body }, { id: 2, body: "https://github.com/foreign/repo/actions/runs/42" }, { id: 3 }, { id: 4, body: "Repair: https://github.com/owner/repo/blob/main/.agents/pm/issues/pm-repair.toon Foreign: https://github.com/foreign/repo/blob/main/.agents/pm/issues/pm-other.toon" }]]) }));
    expect(report.families.map((row: { family: string }) => row.family)).toEqual([current, family]);
    expect(report.families[1]).toMatchObject({ completed: 1, failed: 1 });
    expect(report.evidence[1]?.alerts).toHaveLength(1);
    expect(report.evidence[1]?.alerts[0].pm_items).toEqual(["pm-repair"]);
    expect(report.families[0]?.pending).toBe(1);
  });

  it.each([
    ["Nightly Validation failed: windows-latest / Node 24 shard 1/2", "Nightly (windows-latest, Node 24, shard 1/2)"],
    ["Nightly Validation failed: ubuntu-latest / Node 24 quality", "Nightly quality (ubuntu-latest, Node 24)"],
  ])("correlates shard and quality titles %s", (title, label) => {
    const report = collectNightlyReliability("owner/repo", policy, now, [label], reader({ jobs: pages("jobs", [{ ...job, name: label }]), issues: JSON.stringify([{ total_count: 1, incomplete_results: false, items: [{ ...issue, title, body: null }] }]), comments: JSON.stringify([[{ id: 1, body: issue.body }]]) }));
    expect(report.families[0]?.repair_minutes).toEqual([120]);
  });

  it("ignores unrelated and out-of-population alert titles without treating them as repaired jobs", () => {
    const items = [{ ...issue, title: "Other issue" }, { ...issue, id: 101, title: "Nightly Validation failed: other-latest / Node 99" }];
    const report = collectNightlyReliability("owner/repo", policy, now, [family], reader({ issues: JSON.stringify([{ total_count: 2, incomplete_results: false, items }]) }));
    expect(report.families[0]?.unresolved).toBe(1);
    expect(report.evidence[0]?.alerts).toEqual([]);
  });

  it("retains multiple alert closures but censors repairs beyond the report cutoff", () => {
    const items = [issue, { ...issue, id: 101, number: 13, closed_at: "2026-10-10T00:00:00Z" }];
    const report = collectNightlyReliability("owner/repo", policy, now, [family], reader({ issues: JSON.stringify([{ total_count: 2, incomplete_results: false, items }]) }));
    expect(report.evidence[0]?.alerts).toHaveLength(2);
    expect(report.families[0]?.unresolved).toBe(1);
    const open = collectNightlyReliability("owner/repo", policy, now, [family], reader({ issues: JSON.stringify([{ total_count: 1, incomplete_results: false, items: [{ ...issue, closed_at: null }] }]) }));
    expect(open.families[0]?.unresolved).toBe(1);
    const mixed = collectNightlyReliability("owner/repo", policy, now, [family], reader({ issues: JSON.stringify([{ total_count: 2, incomplete_results: false, items: [issue, { ...issue, id: 101, number: 13, closed_at: null }] }]) }));
    expect(mixed.families[0]?.unresolved).toBe(1);
  });

  it.each([
    { repo: "{}" }, { runs: '[{"total_count":1,"workflow_runs":[]}]' },
    { issues: "{}" }, { issues: '[{"total_count":0,"incomplete_results":true,"items":[]}]' },
    { issues: '[{"total_count":1001,"incomplete_results":false,"items":[]}]' },
    { comments: "{}" }, { comments: "[]" }, { comments: "[{}]" },
    { comments: '[[{"id":1},{"id":1}]]' },
    { jobs: pages("jobs", [job, { ...job, id: 8 }]) },
  ])("fails closed on incomplete or ambiguous census %j", (overrides) => {
    expect(() => collectNightlyReliability("owner/repo", policy, now, [family], reader(overrides))).toThrow();
  });

  it.each([{ id: 7 }, { id: 0 }, { run_attempt: 2 }, { event: "workflow_dispatch" }, { head_branch: "other" }])("rejects mismatched original identity %j", (change) => {
    expect(() => collectNightlyReliability("owner/repo", policy, now, [family], reader({ runs: pages("workflow_runs", [{ ...run, run_attempt: 2 }]), original: JSON.stringify({ ...run, ...change }) }))).toThrow("identity mismatch");
  });

  it("rejects invalid repository, clock and policy before reading external evidence", () => {
    const read = reader();
    expect(() => collectNightlyReliability("../bad", policy, now, [family], read)).toThrow("repository");
    for (const change of [{ schema: "wrong" }, { window_days: 0 }, { window_days: 91 }, { window_days: 1.5 }, { max_failure_rate: 1 }]) {
      expect(() => collectNightlyReliability("owner/repo", { ...policy, ...change }, now, [family], read)).toThrow();
    }
    expect(() => collectNightlyReliability("owner/repo", undefined, now, [family], read)).toThrow("policy");
    expect(() => collectNightlyReliability("owner/repo", policy, "bad", [family], read)).toThrow();
    expect(read).not.toHaveBeenCalled();
  });

  it("derives the declared population and rejects malformed workflow matrices", () => {
    expect(nightlyFamilies(readFileSync(".github/workflows/nightly.yml", "utf8"))).toHaveLength(7);
    for (const source of ["x: [", "{}", 'jobs: {nightly: {strategy: {matrix: {include: [{label: wrong}]}}}, quality: {name: Nightly quality}}', 'jobs: {nightly: {strategy: {matrix: {include: [{label: Nightly quality}]}}}, quality: {name: Nightly quality}}']) {
      expect(() => nightlyFamilies(source)).toThrow();
    }
    expect(() => nightlyFamilies('jobs: {nightly: {strategy: {matrix: {include: [{label: 1}]}}}, quality: {name: Nightly quality}}')).toThrow();
  });

  it("persists a replayable empty-census verdict before enforcement with read-only bounded transport", () => {
    const root = mkdtempSync(path.join(tmpdir(), "nightly-report-"));
    try {
      vi.stubEnv("GITHUB_REPOSITORY", "owner/repo");
      vi.stubEnv("NIGHTLY_RELIABILITY_OUTPUT", path.join(root, "report.json"));
      transport.mockImplementation((_command: string, args: string[]) => reader({ runs: pages("workflow_runs", []), issues: '[{"total_count":0,"incomplete_results":false,"items":[]}]' })(args));
      expect(main().ok).toBe(false);
      expect(JSON.parse(readFileSync(path.join(root, "report.json"), "utf8"))).toMatchObject({ census_complete: true, attempts: [] });
      expect(transport).toHaveBeenCalledWith("gh", expect.any(Array), expect.objectContaining({ timeout: 60_000, maxBuffer: 16 * 1024 * 1024 }));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("runs reporting from trusted main code and retains findings even when release reporting fails", () => {
    const source = readFileSync(".github/workflows/release-reliability.yml", "utf8");
    const workflow = parseDocument(source);
    expect(workflow.errors).toEqual([]);
    const steps = (workflow.toJS() as { jobs: { report: { steps: Array<{ name: string; if?: string; run?: string }> } } }).jobs.report.steps;
    expect(steps.find((step) => step.name === "Evaluate rolling nightly recurrence reliability")?.if).toContain("always()");
    expect(steps.find((step) => step.name === "Preserve nightly reliability report")?.if).toBe("always()");
    expect(source).toContain("process.exitCode = report.ok ? 0 : 1");
    expect(source).toContain("persist-credentials: false");
    expect(readFileSync(".github/workflows/nightly.yml", "utf8").match(/Recurrence owner: \[pm-2zjs0g\]/gu)).toHaveLength(2);
  });
});
