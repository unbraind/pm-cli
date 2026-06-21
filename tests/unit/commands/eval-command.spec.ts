import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EXIT_CODE } from "../../../src/core/shared/constants.js";
import { PmCliError } from "../../../src/core/shared/errors.js";
import type { GlobalOptions } from "../../../src/core/shared/command-types.js";
import type { SearchResult } from "../../../src/cli/commands/search.js";

const { pathExistsMock, readFileMock, resolvePmRootMock, getSettingsPathMock, runSearchMock } = vi.hoisted(() => ({
  pathExistsMock: vi.fn<() => Promise<boolean>>(),
  readFileMock: vi.fn<(targetPath: string, encoding: string) => Promise<string>>(),
  resolvePmRootMock: vi.fn<() => string>(),
  getSettingsPathMock: vi.fn<() => string>(),
  runSearchMock: vi.fn<(query: string, options: unknown, global: GlobalOptions) => Promise<SearchResult>>(),
}));

vi.mock("node:fs/promises", () => ({
  default: { readFile: readFileMock },
}));
vi.mock("../../../src/core/fs/fs-utils.js", () => ({
  pathExists: pathExistsMock,
}));
vi.mock("../../../src/core/store/paths.js", () => ({
  resolvePmRoot: resolvePmRootMock,
  getSettingsPath: getSettingsPathMock,
}));
vi.mock("../../../src/cli/commands/search.js", () => ({
  runSearch: runSearchMock,
}));

import { runEval } from "../../../src/cli/commands/eval.js";

const GLOBAL: GlobalOptions = {} as GlobalOptions;

/** Build a minimal SearchResult carrying just the ranked ids the eval reads. */
function searchResultWithIds(ids: string[]): SearchResult {
  return { items: ids.map((id) => ({ id })) } as unknown as SearchResult;
}

function queueRankings(...rankings: string[][]): void {
  for (const ids of rankings) {
    runSearchMock.mockResolvedValueOnce(searchResultWithIds(ids));
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  pathExistsMock.mockResolvedValue(true);
  resolvePmRootMock.mockReturnValue("/pmroot");
  getSettingsPathMock.mockReturnValue("/pmroot/settings.json");
});

describe("runEval", () => {
  it("evaluates the golden set, reporting per-query and aggregate metrics", async () => {
    readFileMock.mockResolvedValue(
      JSON.stringify([
        { query: "database connection", relevant_ids: ["pm-a"] },
        { query: "retry backoff", relevant_ids: ["pm-b"], mode: "hybrid" },
      ]),
    );
    queueRankings(["pm-a", "pm-x"], ["pm-x", "pm-b"]);

    const result = await runEval({}, GLOBAL);

    expect(result.k).toBe(10);
    expect(result.query_count).toBe(2);
    expect(result.queries[0]).toMatchObject({ query: "database connection", mode: "keyword", mrr: 1, ndcg: 1 });
    expect(result.queries[1]).toMatchObject({ query: "retry backoff", mode: "hybrid", mrr: 0.5 });
    expect(result.passed).toBe(true);
    expect(result).not.toHaveProperty("fail_under");
    // First query ran keyword mode with the configured cutoff + id projection.
    expect(runSearchMock).toHaveBeenNthCalledWith(1, "database connection", { mode: "keyword", limit: "10", fields: "id" }, GLOBAL);
    expect(runSearchMock).toHaveBeenNthCalledWith(2, "retry backoff", { mode: "hybrid", limit: "10", fields: "id" }, GLOBAL);
  });

  it("applies the default --mode to queries without their own and honors --k", async () => {
    readFileMock.mockResolvedValue(JSON.stringify([{ query: "x", relevant_ids: ["pm-a"] }]));
    queueRankings(["pm-a"]);

    const result = await runEval({ mode: "semantic", k: "5" }, GLOBAL);

    expect(result.k).toBe(5);
    expect(result.queries[0].mode).toBe("semantic");
    expect(runSearchMock).toHaveBeenCalledWith("x", { mode: "semantic", limit: "5", fields: "id" }, GLOBAL);
  });

  it("ignores non-string ids in the search result ranking", async () => {
    readFileMock.mockResolvedValue(JSON.stringify([{ query: "x", relevant_ids: ["pm-a"] }]));
    runSearchMock.mockResolvedValueOnce({ items: [{ id: 7 }, { id: "pm-a" }] } as unknown as SearchResult);

    const result = await runEval({}, GLOBAL);
    // The non-string id is dropped, so pm-a is the only ranked id (rank 1).
    expect(result.queries[0].retrieved_relevant).toBe(1);
    expect(result.queries[0].mrr).toBe(1);
  });

  it("passes the gate when aggregate nDCG meets --fail-under", async () => {
    readFileMock.mockResolvedValue(JSON.stringify([{ query: "x", relevant_ids: ["pm-a"] }]));
    queueRankings(["pm-a"]);

    const result = await runEval({ failUnder: "0.5" }, GLOBAL);
    expect(result.fail_under).toBe(0.5);
    expect(result.passed).toBe(true);
  });

  it("accepts numeric --k and --fail-under (programmatic invocation)", async () => {
    readFileMock.mockResolvedValue(JSON.stringify([{ query: "x", relevant_ids: ["pm-a"] }]));
    queueRankings(["pm-a"]);

    const result = await runEval({ k: 5, failUnder: 0.5 }, GLOBAL);
    expect(result.k).toBe(5);
    expect(result.fail_under).toBe(0.5);
    expect(result.passed).toBe(true);
  });

  it("fails the gate when aggregate nDCG is below --fail-under", async () => {
    readFileMock.mockResolvedValue(JSON.stringify([{ query: "x", relevant_ids: ["pm-missing"] }]));
    queueRankings(["pm-other"]);

    const result = await runEval({ failUnder: "0.5" }, GLOBAL);
    expect(result.aggregate.ndcg).toBe(0);
    expect(result.passed).toBe(false);
  });

  it("reads the golden set from an explicit --queries path", async () => {
    readFileMock.mockResolvedValue(JSON.stringify([{ query: "x", relevant_ids: ["pm-a"] }]));
    queueRankings(["pm-a"]);

    await runEval({ queries: "custom/eval.json" }, GLOBAL);
    expect(readFileMock).toHaveBeenCalled();
    const [targetPath] = readFileMock.mock.calls[0];
    expect(targetPath.replaceAll(path.sep, "/")).toContain("custom/eval.json");
  });

  it("defaults the golden-set path under the pm root", async () => {
    readFileMock.mockResolvedValue(JSON.stringify([{ query: "x", relevant_ids: ["pm-a"] }]));
    queueRankings(["pm-a"]);

    await runEval({}, GLOBAL);
    expect(readFileMock).toHaveBeenCalled();
    const [targetPath] = readFileMock.mock.calls[0];
    const normalizedTargetPath = targetPath.replaceAll(path.sep, "/");
    expect(normalizedTargetPath).toContain("/pmroot");
    expect(normalizedTargetPath).toContain("eval-queries.json");
  });

  it("throws NOT_FOUND when the tracker is not initialized", async () => {
    pathExistsMock.mockResolvedValue(false);
    await expect(runEval({}, GLOBAL)).rejects.toMatchObject({ exitCode: EXIT_CODE.NOT_FOUND });
  });

  it("throws NOT_FOUND with guidance when the golden set is missing", async () => {
    readFileMock.mockRejectedValue(new Error("ENOENT"));
    await expect(runEval({}, GLOBAL)).rejects.toBeInstanceOf(PmCliError);
    await expect(runEval({}, GLOBAL)).rejects.toMatchObject({ exitCode: EXIT_CODE.NOT_FOUND });
  });

  it("throws USAGE when the golden set is not valid JSON", async () => {
    readFileMock.mockResolvedValue("{ not json");
    await expect(runEval({}, GLOBAL)).rejects.toMatchObject({ exitCode: EXIT_CODE.USAGE });
  });

  it("throws USAGE when the golden set is structurally invalid", async () => {
    readFileMock.mockResolvedValue(JSON.stringify([{ query: "" }]));
    await expect(runEval({}, GLOBAL)).rejects.toMatchObject({ exitCode: EXIT_CODE.USAGE });
  });

  it("rejects an invalid --mode", async () => {
    readFileMock.mockResolvedValue(JSON.stringify([{ query: "x", relevant_ids: ["pm-a"] }]));
    await expect(runEval({ mode: "fuzzy" }, GLOBAL)).rejects.toMatchObject({ exitCode: EXIT_CODE.USAGE });
  });

  it("rejects a non-positive --k", async () => {
    readFileMock.mockResolvedValue(JSON.stringify([{ query: "x", relevant_ids: ["pm-a"] }]));
    await expect(runEval({ k: "0" }, GLOBAL)).rejects.toMatchObject({ exitCode: EXIT_CODE.USAGE });
  });

  it("rejects an out-of-range --fail-under", async () => {
    readFileMock.mockResolvedValue(JSON.stringify([{ query: "x", relevant_ids: ["pm-a"] }]));
    await expect(runEval({ failUnder: "1.5" }, GLOBAL)).rejects.toMatchObject({ exitCode: EXIT_CODE.USAGE });
  });
});
