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
} from "../../../../scripts/release/release-run-selection.mjs";

const tag = "v2026.8.5";
const tagSha = "0449d15f045f881a574248d35774a656a8b1e55b";

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
      { tag, tagSha, dispatchRunIds: new Set([20]) },
    );

    expect(selection).toEqual({
      schema: RELEASE_RUN_SELECTION_SCHEMA,
      tag,
      tag_sha: tagSha,
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
      { tag, tagSha },
    );

    expect(selection.reason).toBe("successful_run");
    expect(selection.selected?.database_id).toBe(25);
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
      { tag, tagSha },
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
      { tag, tagSha },
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
        run({ databaseId: 63, event: "schedule" }),
        run({ databaseId: 64, createdAt: "not-a-date" }),
        run({ databaseId: 65, createdAt: "2026-08-05T09:00:00Z" }),
      ],
      {
        tag,
        tagSha: tagSha.toUpperCase(),
        createdAfter: "2026-08-05T09:30:00Z",
      },
    );

    expect(selection).toEqual({
      schema: RELEASE_RUN_SELECTION_SCHEMA,
      tag,
      tag_sha: tagSha,
      matched_count: 0,
      reason: "no_matching_run",
      selected: null,
    });
  });

  it("uses database id as the stable tie-breaker and validates inputs", () => {
    const selection = selectAuthoritativeReleaseRun(
      [run({ databaseId: 70 }), run({ databaseId: 71 })],
      { tag, tagSha },
    );
    expect(selection.selected?.database_id).toBe(71);
    expect(() =>
      selectAuthoritativeReleaseRun([], { tag: "main", tagSha }),
    ).toThrow("exact release tag");
    expect(() =>
      selectAuthoritativeReleaseRun([], { tag, tagSha: "short" }),
    ).toThrow("40-character tag commit SHA");
    expect(() =>
      selectAuthoritativeReleaseRun([], {
        tag,
        tagSha,
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
        "--dispatch-run-ids",
        "80, 81,invalid",
      ],
      JSON.stringify([
        run({
          databaseId: 81,
          event: "workflow_dispatch",
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
      main(["--tag", tag, "--tag-sha", tagSha], "{}", vi.fn()),
    ).toThrow("JSON array");
  });
});
