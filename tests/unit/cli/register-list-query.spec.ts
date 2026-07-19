import { Command } from "commander";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/cli/commands/get.js", () => ({ runGet: vi.fn() }));
vi.mock("../../../src/cli/commands/history.js", () => ({ runHistory: vi.fn() }));
vi.mock("../../../src/cli/commands/activity.js", () => ({ runActivity: vi.fn() }));
vi.mock("../../../src/cli/commands/search.js", () => ({ runSearch: vi.fn() }));
vi.mock("../../../src/cli/commands/eval.js", () => ({ runEval: vi.fn() }));
vi.mock("../../../src/cli/commands/aggregate.js", () => ({ runAggregate: vi.fn() }));
vi.mock("../../../src/cli/commands/context.js", () => ({
  runContext: vi.fn(),
  resolveContextOutputFormat: vi.fn(),
  renderContextMarkdown: vi.fn(),
}));
vi.mock("../../../src/cli/commands/next.js", () => ({
  runNext: vi.fn(),
  resolveNextOutputFormat: vi.fn(),
  renderNextMarkdown: vi.fn(),
}));
vi.mock("../../../src/cli/commands/list.js", () => ({ runList: vi.fn() }));
vi.mock("../../../src/cli/commands/graph.js", () => ({ runGraph: vi.fn() }));

vi.mock("../../../src/cli/registration-helpers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/cli/registration-helpers.js")>();
  return {
    ...actual,
    printResult: vi.fn(),
    printError: vi.fn(),
    printActivityJsonStream: vi.fn(),
    printListJsonStream: vi.fn(),
    writeStdout: vi.fn(),
  };
});

import { _testOnlyRegisterListQuery, registerListQueryCommands } from "../../../src/cli/register-list-query.js";
import { runGet } from "../../../src/cli/commands/get.js";
import { runHistory } from "../../../src/cli/commands/history.js";
import { runActivity } from "../../../src/cli/commands/activity.js";
import { runSearch } from "../../../src/cli/commands/search.js";
import { runEval } from "../../../src/cli/commands/eval.js";
import { runAggregate } from "../../../src/cli/commands/aggregate.js";
import { renderContextMarkdown, resolveContextOutputFormat, runContext } from "../../../src/cli/commands/context.js";
import { renderNextMarkdown, resolveNextOutputFormat, runNext } from "../../../src/cli/commands/next.js";
import { runList } from "../../../src/cli/commands/list.js";
import { runGraph } from "../../../src/cli/commands/graph.js";
import { printActivityJsonStream, printError, printListJsonStream, printResult, writeStdout } from "../../../src/cli/registration-helpers.js";

let tmpRoot: string;

function buildProgram(): Command {
  const program = new Command();
  program
    .name("pm")
    .exitOverride()
    .configureOutput({ writeOut: () => {}, writeErr: () => {} })
    .option("--path <value>", "Tracker storage path")
    .option("--json", "JSON output")
    .option("--quiet", "Suppress stdout output")
    .option("--profile", "Emit per-command profile timing");
  registerListQueryCommands(program);
  return program;
}

async function runProfiled(...args: string[]): Promise<void> {
  await buildProgram().parseAsync(["--quiet", "--profile", "--path", tmpRoot, ...args], { from: "user" });
}

async function runRaw(...args: string[]): Promise<void> {
  await buildProgram().parseAsync(["--path", tmpRoot, ...args], { from: "user" });
}

function lastCall<T>(mock: { mock: { calls: unknown[][] } }, index: number): T {
  const { calls } = mock.mock;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1]![index] as T;
}

beforeAll(async () => {
  tmpRoot = await mkdtemp(path.join(tmpdir(), "pm-register-list-query-"));
});

afterAll(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(runGet).mockResolvedValue({ id: "pm-1" } as never);
  vi.mocked(runHistory).mockResolvedValue({ entries: [] } as never);
  vi.mocked(runActivity).mockResolvedValue({ count: 0, activity: [] } as never);
  vi.mocked(runSearch).mockResolvedValue({ hits: [] } as never);
  vi.mocked(runEval).mockResolvedValue({
    k: 10,
    query_count: 1,
    aggregate: { ndcg: 1, mrr: 1, precision: 1, recall: 1 },
    queries: [],
    passed: true,
  } as never);
  vi.mocked(runAggregate).mockResolvedValue({ rows: [] } as never);
  vi.mocked(runContext).mockResolvedValue({ summary: {} } as never);
  vi.mocked(resolveContextOutputFormat).mockReturnValue("json" as never);
  vi.mocked(renderContextMarkdown).mockReturnValue("# Context" as never);
  vi.mocked(runNext).mockResolvedValue({ summary: {}, recommended: null } as never);
  vi.mocked(resolveNextOutputFormat).mockReturnValue("json" as never);
  vi.mocked(renderNextMarkdown).mockReturnValue("# Next" as never);
  vi.mocked(runGraph).mockResolvedValue({
    subcommand: "analyze",
    node_count: 0,
    edge_count: 0,
    sample_limit: 10,
  } as never);
  vi.mocked(runList).mockResolvedValue({
    items: [
      { id: "pm-1", status: "open", type: "Task", title: "First" },
      { id: "pm-2", status: "open", type: "Epic", title: "Second" },
    ],
    count: 2,
  } as never);
});

describe("register-list-query list output formats", () => {
  it("parses every supported list --format value and rejects others", () => {
    const { parseListFormat } = _testOnlyRegisterListQuery;
    expect(parseListFormat(undefined)).toBeUndefined();
    expect(parseListFormat(" CSV ")).toBe("csv");
    expect(parseListFormat("table")).toBe("table");
    expect(parseListFormat("json")).toBe("json");
    expect(parseListFormat("toon")).toBe("toon");
    expect(() => parseListFormat("yaml")).toThrow(/csv\|table\|json\|toon/);
    expect(() => parseListFormat(true as never)).toThrow(/csv\|table\|json\|toon/);
  });

  it("renders CSV output through writeStdout and bypasses printResult", async () => {
    await runRaw("list", "--format", "csv");
    expect(vi.mocked(printResult)).not.toHaveBeenCalled();
    const written = lastCall<string>(vi.mocked(writeStdout) as never, 0);
    expect(written).toBe("id,status,type,title\npm-1,open,Task,First\npm-2,open,Epic,Second\n");
  });

  it("renders an aligned table for --format table", async () => {
    await runRaw("list", "--format", "table");
    const written = lastCall<string>(vi.mocked(writeStdout) as never, 0);
    expect(written).toContain("id   | status | type | title");
    expect(written).toContain("pm-1 | open   | Task | First");
  });

  it("suppresses tabular output under --quiet", async () => {
    await runRaw("list", "--format", "csv", "--quiet");
    expect(vi.mocked(writeStdout)).not.toHaveBeenCalled();
  });

  it("emits nothing for an empty tabular result", async () => {
    vi.mocked(runList).mockResolvedValueOnce({ items: [], count: 0 } as never);
    await runRaw("list", "--format", "table");
    expect(vi.mocked(writeStdout)).not.toHaveBeenCalled();
  });

  it("routes --format json through printResult with json enabled", async () => {
    await runRaw("list", "--format", "json");
    const outputOptions = lastCall<Record<string, unknown>>(vi.mocked(printResult) as never, 1);
    expect(outputOptions.json).toBe(true);
  });

  it("emits a JSON stream when --stream and --json are set", async () => {
    await runRaw("list", "--json", "--stream");
    expect(vi.mocked(printListJsonStream)).toHaveBeenCalledTimes(1);
  });

  it("rejects --stream without an effective json output mode", async () => {
    await expect(runRaw("list", "--stream")).rejects.toThrow(/--stream requires --json/);
  });

  it("rejects combining --format csv with --stream", async () => {
    await expect(runRaw("list", "--json", "--format", "csv", "--stream")).rejects.toThrow(
      /--format csv\|table cannot be combined with --stream/,
    );
  });
});

describe("register-list-query get options", () => {
  it("passes depth, fields, historical target, and snake_case tree_depth through to runGet", async () => {
    await runProfiled("get", "pm-1", "--depth", "deep", "--fields", "id,title", "--tree", "--tree_depth", "2", "--at", "7");
    const projection = lastCall<Record<string, unknown>>(vi.mocked(runGet) as never, 2);
    expect(projection).toMatchObject({ depth: "deep", fields: "id,title", tree: true, treeDepth: "2", at: "7" });
  });

  it("prefers the hyphenated --tree-depth value when provided", async () => {
    await runRaw("get", "pm-1", "--tree", "--tree-depth", "5");
    const projection = lastCall<Record<string, unknown>>(vi.mocked(runGet) as never, 2);
    expect(projection.treeDepth).toBe("5");
  });

  it("prints get output as json when --format json is provided", async () => {
    await runRaw("get", "pm-1", "--format", "json");
    const outputOptions = lastCall<Record<string, unknown>>(vi.mocked(printResult) as never, 1);
    expect(outputOptions.json).toBe(true);
  });

  it("rejects conflicting get --json and --format toon options", async () => {
    await expect(buildProgram().parseAsync(["--path", tmpRoot, "--json", "get", "pm-1", "--format", "toon"], { from: "user" }))
      .rejects.toThrow(/cannot combine --json with --format toon/);
  });

  it("rejects non-string read command format values defensively", () => {
    expect(() =>
      _testOnlyRegisterListQuery.resolveReadCommandOutputFormat("Get", true, { quiet: false }),
    ).toThrow(/Get --format must be one of json\|toon/);
  });

  it("keeps non-json output when --format toon is provided without global json", () => {
    expect(
      _testOnlyRegisterListQuery.resolveReadCommandOutputFormat("Get", "toon", { quiet: false }),
    ).toEqual({ quiet: false, json: false });
  });
});

describe("register-list-query history options", () => {
  it("requires verification for strict history exits", async () => {
    await expect(runRaw("history", "pm-1", "--strict-exit")).rejects.toThrow(
      /--strict-exit requires --verify/,
    );
  });

  it("sets a failing exit code when strict verification reports a broken chain", async () => {
    vi.mocked(runHistory).mockResolvedValueOnce({
      entries: [],
      verification: { ok: false, errors: ["broken"] },
    } as never);
    const priorExitCode = process.exitCode;
    try {
      await runRaw("history", "pm-1", "--verify", "--strict-exit");
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = priorExitCode;
    }
  });

  it("treats --field as implying --diff and scopes to that field", async () => {
    await runProfiled("history", "pm-1", "--field", "status");
    const options = lastCall<Record<string, unknown>>(vi.mocked(runHistory) as never, 1);
    expect(options).toMatchObject({ field: "status", diff: true, compact: true });
  });

  it("disables compact projection when --full is set", async () => {
    await runRaw("history", "pm-1", "--full", "--limit", "5", "--verify");
    const options = lastCall<Record<string, unknown>>(vi.mocked(runHistory) as never, 1);
    expect(options).toMatchObject({ compact: false, limit: "5", verify: true });
  });

  it("prints history output as json when --format json is provided", async () => {
    await runRaw("history", "pm-1", "--format", "json");
    const outputOptions = lastCall<Record<string, unknown>>(vi.mocked(printResult) as never, 1);
    expect(outputOptions.json).toBe(true);
  });
});

describe("register-list-query search options", () => {
  it("prints search output as json when --format json is provided", async () => {
    await runRaw("search", "token", "--format", "json");
    const outputOptions = lastCall<Record<string, unknown>>(vi.mocked(printResult) as never, 1);
    expect(outputOptions.json).toBe(true);
  });

  it("rejects unsupported read command formats", async () => {
    await expect(runRaw("search", "token", "--format", "markdown")).rejects.toThrow(/Search --format must be one of json\|toon/);
  });
});

describe("register-list-query eval command (pm-u8n5)", () => {
  it("forwards every eval flag and prints the report", async () => {
    await runProfiled(
      "eval",
      "--mode",
      "hybrid",
      "--k",
      "5",
      "--fail-under",
      "0.5",
      "--queries",
      "custom/eval.json",
      "--format",
      "json",
    );
    const evalOptions = lastCall<Record<string, unknown>>(vi.mocked(runEval) as never, 0);
    expect(evalOptions).toEqual({ mode: "hybrid", k: "5", failUnder: "0.5", queries: "custom/eval.json", format: "json" });
    const outputOptions = lastCall<Record<string, unknown>>(vi.mocked(printResult) as never, 1);
    expect(outputOptions.json).toBe(true);
  });

  it("passes undefined for omitted eval flags and runs without profile output", async () => {
    await runRaw("eval");
    const evalOptions = lastCall<Record<string, unknown>>(vi.mocked(runEval) as never, 0);
    expect(evalOptions).toEqual({ mode: undefined, k: undefined, failUnder: undefined, queries: undefined, format: undefined });
  });

  it("throws when the relevance gate fails", async () => {
    vi.mocked(runEval).mockResolvedValueOnce({
      k: 10,
      query_count: 1,
      aggregate: { ndcg: 0, mrr: 0, precision: 0, recall: 0 },
      queries: [],
      fail_under: 0.5,
      passed: false,
    } as never);
    await expect(runRaw("eval", "--fail-under", "0.5")).rejects.toThrow(/Eval gate failed/);
  });
});

describe("register-list-query next command (pm-nj90)", () => {
  it("normalizes every filter, snake_case alias, and the boolean ready-only flag", async () => {
    await runProfiled(
      "next",
      "--type",
      "Task",
      "--tag",
      "area:cli",
      "--priority",
      "0",
      "--assignee",
      "me",
      "--assignee_filter",
      "assigned",
      "--sprint",
      "s1",
      "--release",
      "r1",
      "--parent",
      "pm-epic",
      "--limit",
      "3",
      "--blocked_limit",
      "2",
      "--ready_only",
    );
    const nextOptions = lastCall<Record<string, unknown>>(vi.mocked(runNext) as never, 0);
    expect(nextOptions).toMatchObject({
      type: "Task",
      tag: "area:cli",
      priority: "0",
      assignee: "me",
      assigneeFilter: "assigned",
      sprint: "s1",
      release: "r1",
      parent: "pm-epic",
      limit: "3",
      blockedLimit: "2",
      readyOnly: true,
    });
    const outputOptions = lastCall<Record<string, unknown>>(vi.mocked(printResult) as never, 1);
    expect(outputOptions.json).toBe(true);
  });

  it("forwards the canonical --ready-only flag and leaves omitted flags undefined", async () => {
    await runRaw("next", "--ready-only");
    const nextOptions = lastCall<Record<string, unknown>>(vi.mocked(runNext) as never, 0);
    expect(nextOptions).toMatchObject({ readyOnly: true, type: undefined, blockedLimit: undefined });
  });

  it("writes markdown output through writeStdout when not quiet", async () => {
    vi.mocked(resolveNextOutputFormat).mockReturnValue("markdown" as never);
    await runRaw("next", "--format", "markdown");
    expect(vi.mocked(writeStdout)).toHaveBeenCalledWith("# Next\n");
    expect(vi.mocked(printResult)).not.toHaveBeenCalled();
  });

  it("suppresses markdown output under --quiet", async () => {
    vi.mocked(resolveNextOutputFormat).mockReturnValue("markdown" as never);
    await runProfiled("next", "--format", "markdown");
    expect(vi.mocked(writeStdout)).not.toHaveBeenCalled();
  });

  it("routes toon output through printResult without json", async () => {
    vi.mocked(resolveNextOutputFormat).mockReturnValue("toon" as never);
    await runRaw("next");
    const outputOptions = lastCall<Record<string, unknown>>(vi.mocked(printResult) as never, 1);
    expect(outputOptions.json).toBe(false);
  });
});

describe("register-list-query activity streaming", () => {
  it("rejects --stream without --json", async () => {
    await expect(runRaw("activity", "--stream")).rejects.toThrow(/--stream requires --json/);
  });

  it("prints non-stream activity output through printResult", async () => {
    await runRaw("activity");
    expect(vi.mocked(printResult)).toHaveBeenCalledTimes(1);
  });

  it("emits a JSON stream when --stream and --json are set", async () => {
    await runProfiled("activity", "--json", "--stream", "rows");
    expect(vi.mocked(printActivityJsonStream)).toHaveBeenCalledTimes(1);
  });
});

describe("register-list-query graph action", () => {
  it("maps repeatable and scalar graph options onto the runner contract", async () => {
    await runRaw(
      "graph",
      "successors",
      "pm-root",
      "--kind",
      "blocked_by",
      "--kind",
      "parent",
      "--max-depth",
      "3",
      "--limit",
      "5",
      "--after",
      "pm-cursor",
      "--direction",
      "outgoing",
      "--summary",
    );
    expect(vi.mocked(runGraph)).toHaveBeenCalledWith(
      "successors",
      "pm-root",
      undefined,
      expect.objectContaining({
        kind: ["blocked_by", "parent"],
        maxDepth: "3",
        limit: "5",
        after: "pm-cursor",
        direction: "outgoing",
        summary: true,
      }),
      expect.objectContaining({ path: tmpRoot }),
    );
    expect(vi.mocked(printResult)).toHaveBeenCalledTimes(1);
  });

  it("passes paths positionals plus audit bounds and profiles timing", async () => {
    await runProfiled(
      "graph",
      "paths",
      "pm-a",
      "pm-b",
      "--max-paths",
      "4",
      "--sample",
      "2",
      "--exempt-isolate",
      "pm-x,pm-y",
    );
    expect(vi.mocked(runGraph)).toHaveBeenCalledWith(
      "paths",
      "pm-a",
      "pm-b",
      expect.objectContaining({
        maxPaths: "4",
        sample: "2",
        exemptIsolate: ["pm-x,pm-y"],
        summary: false,
      }),
      expect.anything(),
    );
    const profiled = lastCall<string>(vi.mocked(printError) as never, 0);
    expect(profiled).toMatch(/profile:command=graph took_ms=\d+/);
  });
});

describe("register-list-query profile false branches", () => {
  it("runs aggregate and search without profile output", async () => {
    await runRaw("aggregate", "--group-by", "type", "--count");
    await runRaw("search", "coverage");
  });

  it("skips markdown write when context output is quiet", async () => {
    vi.mocked(resolveContextOutputFormat).mockReturnValue("markdown" as never);
    await runRaw("context", "--format", "markdown", "--quiet");
  });
});
