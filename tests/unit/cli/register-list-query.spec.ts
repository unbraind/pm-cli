import { Command } from "commander";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/cli/commands/get.js", () => ({ runGet: vi.fn() }));
vi.mock("../../../src/cli/commands/history.js", () => ({ runHistory: vi.fn() }));
vi.mock("../../../src/cli/commands/activity.js", () => ({ runActivity: vi.fn() }));
vi.mock("../../../src/cli/commands/search.js", () => ({ runSearch: vi.fn() }));
vi.mock("../../../src/cli/commands/aggregate.js", () => ({ runAggregate: vi.fn() }));
vi.mock("../../../src/cli/commands/context.js", () => ({
  runContext: vi.fn(),
  resolveContextOutputFormat: vi.fn(),
  renderContextMarkdown: vi.fn(),
}));
vi.mock("../../../src/cli/commands/list.js", () => ({ runList: vi.fn() }));

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
import { runAggregate } from "../../../src/cli/commands/aggregate.js";
import { renderContextMarkdown, resolveContextOutputFormat, runContext } from "../../../src/cli/commands/context.js";
import { runList } from "../../../src/cli/commands/list.js";
import { printActivityJsonStream, printListJsonStream, printResult, writeStdout } from "../../../src/cli/registration-helpers.js";

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
  vi.mocked(runAggregate).mockResolvedValue({ rows: [] } as never);
  vi.mocked(runContext).mockResolvedValue({ summary: {} } as never);
  vi.mocked(resolveContextOutputFormat).mockReturnValue("json" as never);
  vi.mocked(renderContextMarkdown).mockReturnValue("# Context" as never);
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
  it("passes string depth/fields and snake_case tree_depth through to runGet", async () => {
    await runProfiled("get", "pm-1", "--depth", "deep", "--fields", "id,title", "--tree", "--tree_depth", "2");
    const projection = lastCall<Record<string, unknown>>(vi.mocked(runGet) as never, 2);
    expect(projection).toMatchObject({ depth: "deep", fields: "id,title", tree: true, treeDepth: "2" });
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
