/**
 * @module release-run-selection tests
 *
 * Proves blocker recovery identifies an immutable tag across tag-push and
 * guarded workflow-dispatch runs, treats any completed successful publication
 * as authoritative over stale failures, and otherwise selects only a current
 * active or terminal run that is safe to observe or replace.
 */
import { describe, expect, it, vi } from "vitest";
import {
  RELEASE_RUN_SELECTION_SCHEMA,
  main,
  selectAuthoritativeReleaseRun,
  assertNoAcceptedPublication,
  rejectAcceptedPublication,
} from "../../../../scripts/release/release-run-selection.mjs";

const tag = "v2026.8.5";
const tagSha = "0449d15f045f881a574248d35774a656a8b1e55b";

describe("accepted publication admission", () => {
  const options = { tag, tagSha, defaultBranch: "main" };
  const jobs = (conclusion: string, id = 10, total = 1) => [{ total_count: total, jobs: [{ id, name: "Build, Test, Publish", run_id: 1, run_attempt: 1, steps: [
    { name: "Publish to npm", status: "completed", conclusion },
  ] }] }];

  it("refuses an accepted earlier attempt even when the newest attempt skipped publishing", () => {
    expect(() => assertNoAcceptedPublication([run({})], options, () => [
      ...jobs("skipped", 10, 2), ...jobs("success", 11, 2),
    ])).toThrow("previously accepted");
    expect(() => assertNoAcceptedPublication([run({})], options, () => jobs("failure"))).not.toThrow();
  });

  it("matches exact tag and source identity without treating another release as accepted", () => {
    const load = vi.fn(() => jobs("success"));
    expect(() => assertNoAcceptedPublication([
      run({ headBranch: "v2026.8.6" }), run({ headSha: "f".repeat(40) }),
      run({ event: "workflow_dispatch", headBranch: "feature", displayTitle: `Release ${tag}` }),
    ], options, load)).not.toThrow();
    expect(load).not.toHaveBeenCalled();
    expect(() => assertNoAcceptedPublication([run({
      event: "workflow_dispatch", headBranch: "main", displayTitle: `Release ${tag} (operator)`,
    })], options, load)).toThrow("previously accepted");
  });

  it("excludes only the current attempt while retaining previous accepted attempts of the same run", () => {
    const current = { total_count: 1, jobs: [{ id: 20, name: "Build, Test, Publish", run_id: 1, run_attempt: 2, steps: [] }] };
    const active = { ...options, currentRunId: 1, currentAttempt: 2 };
    expect(() => assertNoAcceptedPublication([run({})], active, () => [current])).not.toThrow();
    expect(() => assertNoAcceptedPublication([run({})], active, () => [{ ...current, total_count: 2 }, ...jobs("success", 10, 2)])).toThrow("previously accepted");
    expect(() => assertNoAcceptedPublication([run({})], { ...active, currentAttempt: 0 }, () => [current])).toThrow();
    expect(() => assertNoAcceptedPublication([run({})], options, () => [{ total_count: 1, jobs: [{ ...jobs("skipped")[0]!.jobs[0], run_id: 2 }] }])).toThrow("identity");
  });

  it("refuses incomplete inventories, missing jobs and unavailable provider evidence", () => {
    for (const runs of [null, [{}], [run({ event: "" })],
      [run({ headSha: "" })], [run({ headBranch: "" })], [run({ status: "" })],
      [run({ event: "workflow_dispatch", displayTitle: undefined })]]) {
      expect(() => assertNoAcceptedPublication(runs, options, () => jobs("skipped"))).toThrow();
    }
    const singleJob = (job: Record<string, unknown> | null) => [{ total_count: 1, jobs: [job] }];
    for (const pages of [null, [], [{}], [{ total_count: 0, jobs: [] }],
      singleJob(null), singleJob({ id: 10, name: "Build, Test, Publish" }),
      singleJob({ id: 10, name: "another job" }),
      singleJob({ id: 10, name: "Build, Test, Publish", run_id: 1, run_attempt: 1, steps: [] }),
      singleJob({ id: 10, name: "Build, Test, Publish", run_id: 1, run_attempt: 1, steps: [null, { name: "Publish to npm" }] }),
      singleJob({ id: 10, name: "Build, Test, Publish", run_id: 1, run_attempt: 1, steps: [{ name: "Publish to npm", status: "completed" }] }),
      singleJob({ id: 10, name: "Build, Test, Publish", run_id: 1, run_attempt: 1, steps: [{ name: "Publish to npm", status: "completed", conclusion: "unrecognized" }] }),
      singleJob({ id: 10, name: "Build, Test, Publish", run_id: 1, run_attempt: 1, steps: [{ name: "Publish to npm", status: "unknown" }] })]) {
      expect(() => assertNoAcceptedPublication([run({})], options, () => pages)).toThrow();
    }
    expect(() => assertNoAcceptedPublication([run({})], options, () => { throw new Error("provider unavailable"); })).toThrow("provider unavailable");
  });

  it("queries only the explicit Release workflow and all prior job attempts", () => {
    const execute = vi.fn().mockReturnValueOnce(JSON.stringify([runPage([run({})])])).mockReturnValueOnce(JSON.stringify(jobs("skipped")));
    const argv = ["--tag", tag, "--tag-sha", tagSha, "--default-branch", "main"];
    rejectAcceptedPublication(argv, { GITHUB_REPOSITORY: "fixture/project" }, execute);
    expect(execute.mock.calls[0]?.[1]).toEqual(["api", "repos/fixture/project/actions/workflows/release.yml/runs?per_page=100", "--paginate", "--slurp"]);
    expect(execute.mock.calls[1]?.[1]).toEqual(["api", "repos/fixture/project/actions/runs/1/jobs?filter=all&per_page=100", "--paginate", "--slurp"]);
    expect(() => rejectAcceptedPublication(argv, {}, execute)).toThrow("explicit GitHub repository");
    expect(() => rejectAcceptedPublication(argv, { GITHUB_REPOSITORY: "fixture/project" }, () => "invalid-json")).toThrow();
  });

  it("refuses partial or duplicate job pages before an omitted accepted attempt can be admitted", () => {
    const skipped = { id: 10, name: "Build, Test, Publish", run_id: 1, run_attempt: 1,
      steps: [{ name: "Publish to npm", status: "completed", conclusion: "skipped" }] };
    for (const pages of [[{ total_count: 2, jobs: [skipped] }],
      [{ total_count: 2, jobs: [skipped] }, { total_count: 2, jobs: [skipped] }],
      [{ total_count: 2, jobs: [skipped] }, { total_count: 1, jobs: [] }]]) {
      expect(() => assertNoAcceptedPublication([run({})], options, () => pages)).toThrow();
    }
    expect(() => assertNoAcceptedPublication([run({})], options, () => [
      { total_count: 2, jobs: [skipped] }, { total_count: 2, jobs: [{ ...skipped, id: 11, run_attempt: 2,
        steps: [{ name: "Publish to npm", status: "completed", conclusion: "success" }] }] },
    ])).toThrow("previously accepted");
  });

  it("retains accepted evidence after more than 1000 unrelated runs and validates pagination receipts", () => {
    const unrelated = Array.from({ length: 1001 }, (_, i) => run({ databaseId: i + 10, headBranch: "v2026.8.6" }));
    const pages = [runPage(unrelated, 1002), runPage([run({})], 1002)];
    const argv = ["--tag", tag, "--tag-sha", tagSha, "--default-branch", "main"];
    const execute = vi.fn().mockReturnValueOnce(JSON.stringify(pages)).mockReturnValueOnce(JSON.stringify(jobs("success")));
    expect(() => rejectAcceptedPublication(argv, { GITHUB_REPOSITORY: "fixture/project" }, execute)).toThrow("previously accepted");
    for (const invalid of [null, [], [null], [{}], [{ workflow_runs: [], total_count: -1 }],
      [{ workflow_runs: [null], total_count: 1 }],
      [runPage([run({})], 2)], [runPage([run({})], 1), runPage([], 2)],
      [runPage([run({})], 2), runPage([run({})], 2)]]) {
      expect(() => rejectAcceptedPublication(argv, { GITHUB_REPOSITORY: "fixture/project" }, () => JSON.stringify(invalid))).toThrow();
    }
    const current = vi.fn().mockReturnValueOnce(JSON.stringify([runPage([run({})])])).mockReturnValueOnce(JSON.stringify(jobs("skipped")));
    expect(() => rejectAcceptedPublication(argv, { GITHUB_REPOSITORY: "fixture/project", GITHUB_RUN_ID: "1", GITHUB_RUN_ATTEMPT: "2" }, current)).not.toThrow();
    expect(() => rejectAcceptedPublication(argv, { GITHUB_REPOSITORY: "fixture/project" }, () => JSON.stringify([runPage([])]))).not.toThrow();
  });
});

function runPage(runs: Record<string, unknown>[], total = runs.length) {
  return { total_count: total, workflow_runs: runs.map((r) => ({ id: r.databaseId, created_at: r.createdAt,
    status: r.status, conclusion: r.conclusion, event: r.event, head_branch: r.headBranch,
    head_sha: r.headSha, display_title: r.displayTitle })) };
}

function run(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    databaseId: 1,
    status: "completed",
    conclusion: "failure",
    event: "push",
    headBranch: tag,
    headSha: tagSha,
    displayTitle: "Release",
    createdAt: "2026-08-05T10:00:00Z",
    ...overrides,
  };
}

describe("selectAuthoritativeReleaseRun", () => {
  it("lets a successful exact-tag dispatch win over a stale failed push", () => {
    const selection = selectAuthoritativeReleaseRun(
      [
        run({ databaseId: 10 }),
        run({
          databaseId: 20,
          event: "workflow_dispatch",
          headBranch: "main",
          headSha: "b5a936064479c78b81e7612024985ecd7cba5d15",
          conclusion: "success",
          createdAt: "2026-08-05T11:33:42Z",
        }),
      ],
      { tag, tagSha, defaultBranch: "main", dispatchRunIds: new Set([20]) },
    );

    expect(selection).toEqual({
      schema: RELEASE_RUN_SELECTION_SCHEMA,
      tag,
      tag_sha: tagSha,
      default_branch: "main",
      matched_count: 2,
      reason: "successful_run",
      selected: expect.objectContaining({
        database_id: 20,
        event: "workflow_dispatch",
        conclusion: "success",
      }),
    });
  });

  it("recognizes self-identifying dispatch runs and prefers immutable success over newer failure", () => {
    const selection = selectAuthoritativeReleaseRun(
      [
        run({ databaseId: 30, createdAt: "2026-08-05T13:00:00Z" }),
        run({
          databaseId: 25,
          event: "workflow_dispatch",
          headBranch: "main",
          displayTitle: `Release ${tag}`,
          conclusion: "success",
          createdAt: "2026-08-05T12:00:00Z",
        }),
      ],
      { tag, tagSha, defaultBranch: "main" },
    );

    expect(selection.reason).toBe("successful_run");
    expect(selection.selected?.database_id).toBe(25);
  });

  it("recognizes origin-bearing exact-tag recovery without accepting a different tag or origin", () => {
    const selection = selectAuthoritativeReleaseRun(
      [
        run({ databaseId: 26, event: "workflow_dispatch", headBranch: "main", displayTitle: `Release ${tag} (morning_dispatcher)` }),
        run({ databaseId: 27, event: "workflow_dispatch", headBranch: "main", displayTitle: "Release v2026.8.6 (morning_dispatcher)" }),
        run({ databaseId: 28, event: "workflow_dispatch", headBranch: "main", displayTitle: `Release ${tag} (unverified)` }),
      ],
      { tag, tagSha, defaultBranch: "main" },
    );
    expect(selection.matched_count).toBe(1);
    expect(selection.selected?.database_id).toBe(26);
  });

  it("selects the newest active run when publication has not succeeded", () => {
    const selection = selectAuthoritativeReleaseRun(
      [
        run({ databaseId: 40 }),
        run({
          databaseId: 41,
          status: "queued",
          conclusion: "",
          createdAt: "2026-08-05T12:00:00Z",
        }),
        run({
          databaseId: 42,
          status: "in_progress",
          conclusion: null,
          createdAt: "2026-08-05T12:30:00Z",
        }),
      ],
      { tag, tagSha, defaultBranch: "main" },
    );

    expect(selection.reason).toBe("active_run");
    expect(selection.selected?.database_id).toBe(42);
    expect(selection.selected?.conclusion).toBe("");
  });

  it("falls back to the newest terminal exact-tag run", () => {
    const selection = selectAuthoritativeReleaseRun(
      [
        run({ databaseId: 50 }),
        run({
          databaseId: 51,
          conclusion: "cancelled",
          createdAt: "2026-08-05T12:00:00Z",
        }),
      ],
      { tag, tagSha, defaultBranch: "main" },
    );

    expect(selection.reason).toBe("latest_terminal_run");
    expect(selection.selected?.database_id).toBe(51);
  });

  it("rejects wrong-tag, wrong-SHA, malformed, stale, and unproved dispatch candidates", () => {
    const selection = selectAuthoritativeReleaseRun(
      [
        null,
        run({ databaseId: "bad" }),
        run({ databaseId: 60, headBranch: "v2026.8.4" }),
        run({ databaseId: 61, headSha: "f".repeat(40) }),
        run({ databaseId: 62, event: "workflow_dispatch", headBranch: "main" }),
        run({
          databaseId: 66,
          event: "workflow_dispatch",
          headBranch: "feature/unreviewed",
          displayTitle: `Release ${tag}`,
          conclusion: "success",
        }),
        run({
          databaseId: 67,
          event: "workflow_dispatch",
          headBranch: "feature/unreviewed",
          conclusion: "success",
        }),
        run({ databaseId: 63, event: "schedule" }),
        run({ databaseId: 64, createdAt: "not-a-date" }),
        run({ databaseId: 65, createdAt: "2026-08-05T09:00:00Z" }),
      ],
      {
        tag,
        tagSha: tagSha.toUpperCase(),
        defaultBranch: "main",
        dispatchRunIds: new Set([67]),
        createdAfter: "2026-08-05T09:30:00Z",
      },
    );

    expect(selection).toEqual({
      schema: RELEASE_RUN_SELECTION_SCHEMA,
      tag,
      tag_sha: tagSha,
      default_branch: "main",
      matched_count: 0,
      reason: "no_matching_run",
      selected: null,
    });
  });

  it("uses database id as the stable tie-breaker and validates inputs", () => {
    const selection = selectAuthoritativeReleaseRun(
      [run({ databaseId: 70 }), run({ databaseId: 71 })],
      { tag, tagSha, defaultBranch: "main" },
    );
    expect(selection.selected?.database_id).toBe(71);
    expect(() =>
      selectAuthoritativeReleaseRun([], {
        tag: "main",
        tagSha,
        defaultBranch: "main",
      }),
    ).toThrow("exact release tag");
    expect(() =>
      selectAuthoritativeReleaseRun([], {
        tag,
        tagSha: "short",
        defaultBranch: "main",
      }),
    ).toThrow("40-character tag commit SHA");
    expect(() =>
      selectAuthoritativeReleaseRun([], { tag, tagSha, defaultBranch: "" }),
    ).toThrow("default branch");
    expect(() =>
      selectAuthoritativeReleaseRun([], {
        tag,
        tagSha,
        defaultBranch: "main",
        createdAfter: "invalid",
      }),
    ).toThrow("created-after");
  });
});

describe("release-run-selection CLI", () => {
  it("parses stdin and writes the machine-readable selection", () => {
    const write = vi.fn<(chunk: string) => void>();
    const result = main(
      [
        "--tag",
        tag,
        "--tag-sha",
        tagSha,
        "--default-branch",
        "main",
        "--dispatch-run-ids",
        "80, 81,invalid",
      ],
      JSON.stringify([
        run({
          databaseId: 81,
          event: "workflow_dispatch",
          headBranch: "main",
          conclusion: "success",
        }),
      ]),
      write,
    );

    expect(result.selected?.database_id).toBe(81);
    expect(JSON.parse(write.mock.calls[0]?.[0] ?? "")).toEqual(result);
  });

  it("requires flags and an array-shaped run document", () => {
    expect(() => main([], "[]", vi.fn())).toThrow("Missing --tag");
    expect(() => main(["--tag", tag], "[]", vi.fn())).toThrow(
      "Missing --tag-sha",
    );
    expect(() =>
      main(["--tag", tag, "--tag-sha", tagSha], "[]", vi.fn()),
    ).toThrow("Missing --default-branch");
    expect(() =>
      main(
        ["--tag", tag, "--tag-sha", tagSha, "--default-branch", "main"],
        "{}",
        vi.fn(),
      ),
    ).toThrow("JSON array");
  });
});
