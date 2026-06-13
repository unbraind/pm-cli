import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the per-command modules that the register-* action handlers load via
// dynamic import so the handlers' normalization closures run without touching
// real tracker state. registration-helpers is partially mocked only to stub the
// search-cache invalidation hook (which would otherwise spawn background
// refresh workers); every other helper stays real so its code is exercised.
const invalidateSearchCachesForMutation = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("../../../src/cli/registration-helpers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/cli/registration-helpers.js")>();
  return { ...actual, invalidateSearchCachesForMutation };
});

vi.mock("../../../src/cli/commands/list.js", () => ({ runList: vi.fn() }));
vi.mock("../../../src/cli/commands/aggregate.js", () => ({ runAggregate: vi.fn() }));
vi.mock("../../../src/cli/commands/context.js", () => ({
  runContext: vi.fn(),
  resolveContextOutputFormat: vi.fn(),
  renderContextMarkdown: vi.fn(),
}));
vi.mock("../../../src/cli/commands/search.js", () => ({ runSearch: vi.fn() }));
vi.mock("../../../src/cli/commands/get.js", () => ({ runGet: vi.fn() }));
vi.mock("../../../src/cli/commands/history.js", () => ({ runHistory: vi.fn() }));
vi.mock("../../../src/cli/commands/activity.js", () => ({ runActivity: vi.fn() }));
vi.mock("../../../src/cli/commands/test.js", () => ({ runTest: vi.fn() }));
vi.mock("../../../src/cli/commands/test-all.js", () => ({ runTestAll: vi.fn() }));
vi.mock("../../../src/cli/commands/test-runs.js", () => ({
  runStartBackgroundRun: vi.fn(),
  runTestRunsWorker: vi.fn(),
}));
vi.mock("../../../src/cli/commands/telemetry.js", () => ({ runTelemetry: vi.fn() }));
vi.mock("../../../src/cli/commands/stats.js", () => ({ runStats: vi.fn() }));
vi.mock("../../../src/cli/commands/health.js", () => ({ runHealth: vi.fn() }));
vi.mock("../../../src/cli/commands/validate.js", () => ({ runValidate: vi.fn() }));
vi.mock("../../../src/cli/commands/gc.js", () => ({ runGc: vi.fn() }));
vi.mock("../../../src/cli/commands/contracts.js", () => ({ runContracts: vi.fn() }));
vi.mock("../../../src/cli/commands/claim.js", () => ({ runClaim: vi.fn(), runRelease: vi.fn() }));
vi.mock("../../../src/cli/commands/create.js", () => ({ runCreate: vi.fn() }));
vi.mock("../../../src/cli/commands/copy.js", () => ({ runCopy: vi.fn() }));
vi.mock("../../../src/cli/commands/update.js", () => ({ runUpdate: vi.fn() }));
vi.mock("../../../src/cli/commands/update-many.js", () => ({ runUpdateMany: vi.fn() }));
vi.mock("../../../src/cli/commands/close.js", () => ({ runClose: vi.fn() }));
vi.mock("../../../src/cli/commands/close-many.js", () => ({ runCloseMany: vi.fn() }));
vi.mock("../../../src/cli/commands/delete.js", () => ({ runDelete: vi.fn() }));
vi.mock("../../../src/cli/commands/append.js", () => ({ runAppend: vi.fn() }));
vi.mock("../../../src/cli/commands/restore.js", () => ({ runRestore: vi.fn() }));
vi.mock("../../../src/cli/commands/plan.js", () => ({
  PLAN_SUBCOMMANDS: ["create", "show", "reorder-step", "decision"],
  runPlan: vi.fn(),
}));
vi.mock("../../../src/cli/commands/history-redact.js", () => ({ runHistoryRedact: vi.fn() }));
vi.mock("../../../src/cli/commands/history-repair.js", () => ({
  assertHistoryRepairTarget: vi.fn(),
  runHistoryRepair: vi.fn(),
  runHistoryRepairAll: vi.fn(),
}));
vi.mock("../../../src/cli/commands/history-compact.js", () => ({ runHistoryCompact: vi.fn() }));
vi.mock("../../../src/cli/commands/schema.js", () => ({
  SCHEMA_SUBCOMMANDS: ["list", "show", "show-status", "add-type", "remove-type", "add-status", "remove-status"],
  runSchemaAddType: vi.fn(),
  runSchemaRemoveType: vi.fn(),
  runSchemaAddStatus: vi.fn(),
  runSchemaRemoveStatus: vi.fn(),
  runSchemaList: vi.fn(),
  runSchemaShow: vi.fn(),
  runSchemaShowStatus: vi.fn(),
  formatSchemaAddTypeHuman: vi.fn(() => "added type"),
  formatSchemaRemoveTypeHuman: vi.fn(() => "removed type"),
  formatSchemaAddStatusHuman: vi.fn(() => "added status"),
  formatSchemaRemoveStatusHuman: vi.fn(() => "removed status"),
  formatSchemaListHuman: vi.fn(() => "schema list"),
  formatSchemaShowHuman: vi.fn(() => "schema show"),
  formatSchemaShowStatusHuman: vi.fn(() => "schema status"),
}));
vi.mock("../../../src/cli/commands/comments.js", () => ({ runComments: vi.fn() }));
vi.mock("../../../src/cli/commands/notes.js", () => ({ runNotes: vi.fn() }));
vi.mock("../../../src/cli/commands/learnings.js", () => ({ runLearnings: vi.fn() }));
vi.mock("../../../src/cli/commands/files.js", () => ({ runFiles: vi.fn(), runFilesDiscover: vi.fn() }));
vi.mock("../../../src/cli/commands/docs.js", () => ({ runDocs: vi.fn() }));
vi.mock("../../../src/cli/commands/deps.js", () => ({ runDeps: vi.fn() }));
vi.mock("../../../src/cli/commands/init.js", () => ({ runInit: vi.fn(), summarizeInitResult: vi.fn() }));
vi.mock("../../../src/cli/commands/config.js", () => ({ runConfig: vi.fn() }));
vi.mock("../../../src/cli/commands/extension.js", () => ({ runExtension: vi.fn() }));
vi.mock("../../../src/cli/commands/upgrade.js", () => ({ runUpgrade: vi.fn() }));

import { registerListQueryCommands } from "../../../src/cli/register-list-query.js";
import { registerOperationCommands } from "../../../src/cli/register-operations.js";
import { registerMutationCommands } from "../../../src/cli/register-mutation.js";
import { registerSetupCommands } from "../../../src/cli/register-setup.js";
import { runList } from "../../../src/cli/commands/list.js";
import { runAggregate } from "../../../src/cli/commands/aggregate.js";
import {
  renderContextMarkdown,
  resolveContextOutputFormat,
  runContext,
} from "../../../src/cli/commands/context.js";
import { runSearch } from "../../../src/cli/commands/search.js";
import { runGet } from "../../../src/cli/commands/get.js";
import { runHistory } from "../../../src/cli/commands/history.js";
import { runActivity } from "../../../src/cli/commands/activity.js";
import { runTest } from "../../../src/cli/commands/test.js";
import { runTestAll } from "../../../src/cli/commands/test-all.js";
import { runStartBackgroundRun, runTestRunsWorker } from "../../../src/cli/commands/test-runs.js";
import { runTelemetry } from "../../../src/cli/commands/telemetry.js";
import { runStats } from "../../../src/cli/commands/stats.js";
import { runHealth } from "../../../src/cli/commands/health.js";
import { runValidate } from "../../../src/cli/commands/validate.js";
import { runGc } from "../../../src/cli/commands/gc.js";
import { runContracts } from "../../../src/cli/commands/contracts.js";
import { runClaim, runRelease } from "../../../src/cli/commands/claim.js";
import { runCreate } from "../../../src/cli/commands/create.js";
import { runCopy } from "../../../src/cli/commands/copy.js";
import { runUpdate } from "../../../src/cli/commands/update.js";
import { runUpdateMany } from "../../../src/cli/commands/update-many.js";
import { runClose } from "../../../src/cli/commands/close.js";
import { runCloseMany } from "../../../src/cli/commands/close-many.js";
import { runDelete } from "../../../src/cli/commands/delete.js";
import { runAppend } from "../../../src/cli/commands/append.js";
import { runRestore } from "../../../src/cli/commands/restore.js";
import { runPlan } from "../../../src/cli/commands/plan.js";
import { runHistoryRedact } from "../../../src/cli/commands/history-redact.js";
import { assertHistoryRepairTarget, runHistoryRepair, runHistoryRepairAll } from "../../../src/cli/commands/history-repair.js";
import { runHistoryCompact } from "../../../src/cli/commands/history-compact.js";
import {
  formatSchemaAddStatusHuman,
  formatSchemaAddTypeHuman,
  formatSchemaListHuman,
  formatSchemaRemoveStatusHuman,
  formatSchemaRemoveTypeHuman,
  formatSchemaShowHuman,
  formatSchemaShowStatusHuman,
  runSchemaAddStatus,
  runSchemaAddType,
  runSchemaList,
  runSchemaRemoveStatus,
  runSchemaRemoveType,
  runSchemaShow,
  runSchemaShowStatus,
} from "../../../src/cli/commands/schema.js";
import { runComments } from "../../../src/cli/commands/comments.js";
import { runNotes } from "../../../src/cli/commands/notes.js";
import { runLearnings } from "../../../src/cli/commands/learnings.js";
import { runFiles, runFilesDiscover } from "../../../src/cli/commands/files.js";
import { runDocs } from "../../../src/cli/commands/docs.js";
import { runDeps } from "../../../src/cli/commands/deps.js";
import { runInit, summarizeInitResult } from "../../../src/cli/commands/init.js";
import { runConfig } from "../../../src/cli/commands/config.js";
import { runExtension } from "../../../src/cli/commands/extension.js";
import { runUpgrade } from "../../../src/cli/commands/upgrade.js";
import { EXIT_CODE } from "../../../src/core/shared/constants.js";

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
  registerOperationCommands(program);
  registerMutationCommands(program);
  registerSetupCommands(program);
  return program;
}

async function runCli(...args: string[]): Promise<void> {
  const program = buildProgram();
  await program.parseAsync(["--quiet", "--profile", "--path", tmpRoot, ...args], { from: "user" });
}

async function runCliRaw(...args: string[]): Promise<void> {
  const program = buildProgram();
  await program.parseAsync([...args, "--path", tmpRoot], { from: "user" });
}

function lastCallArg<T>(mock: { mock: { calls: unknown[][] } }, index: number): T {
  const calls = mock.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1]![index] as T;
}

beforeAll(async () => {
  tmpRoot = await mkdtemp(path.join(tmpdir(), "pm-register-commands-"));
});

afterAll(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(runList).mockResolvedValue({
    count: 1,
    now: "2026-06-10T00:00:00.000Z",
    filters: {},
    items: [{ id: "pm-1" }],
    warnings: [],
  } as never);
  vi.mocked(runAggregate).mockResolvedValue({ groups: [] } as never);
  vi.mocked(runContext).mockResolvedValue({ focus: [] } as never);
  vi.mocked(resolveContextOutputFormat).mockReturnValue("toon" as never);
  vi.mocked(renderContextMarkdown).mockReturnValue("# context" as never);
  vi.mocked(runSearch).mockResolvedValue({ hits: [] } as never);
  vi.mocked(runGet).mockResolvedValue({ id: "pm-1" } as never);
  vi.mocked(runHistory).mockResolvedValue({ entries: [] } as never);
  vi.mocked(runActivity).mockResolvedValue({
    count: 1,
    activity: [{ id: "pm-1", op: "update" }],
    compact: true,
    compact_activity: [{ id: "pm-1", op: "update" }],
  } as never);
  vi.mocked(runTest).mockResolvedValue({ run_results: [], fail_on_skipped_triggered: false } as never);
  vi.mocked(runTestAll).mockResolvedValue({ results: [{ id: "pm-1" }], failed: 0 } as never);
  vi.mocked(runStartBackgroundRun).mockResolvedValue({ run_id: "run-1" } as never);
  vi.mocked(runTestRunsWorker).mockResolvedValue(undefined as never);
  vi.mocked(runTelemetry).mockResolvedValue({ status: "ok" } as never);
  vi.mocked(runStats).mockResolvedValue({ totals: {} } as never);
  vi.mocked(runHealth).mockResolvedValue({ ok: true, warnings: [] } as never);
  vi.mocked(runValidate).mockResolvedValue({ ok: true, has_warnings: false } as never);
  vi.mocked(runGc).mockResolvedValue({ removed: [] } as never);
  vi.mocked(runContracts).mockResolvedValue({ contracts: {} } as never);
  vi.mocked(runClaim).mockResolvedValue({ id: "pm-1", claimed: true } as never);
  vi.mocked(runRelease).mockResolvedValue({ id: "pm-1", released: true } as never);
  vi.mocked(runCreate).mockResolvedValue({ id: "pm-2" } as never);
  vi.mocked(runCopy).mockResolvedValue({ id: "pm-3" } as never);
  vi.mocked(runUpdate).mockResolvedValue({ id: "pm-1" } as never);
  vi.mocked(runUpdateMany).mockResolvedValue({ ids: ["pm-1"] } as never);
  vi.mocked(runClose).mockResolvedValue({ id: "pm-1", status: "closed" } as never);
  vi.mocked(runCloseMany).mockResolvedValue({ ids: ["pm-1"] } as never);
  vi.mocked(runDelete).mockResolvedValue({ id: "pm-1", dry_run: false } as never);
  vi.mocked(runAppend).mockResolvedValue({ id: "pm-1" } as never);
  vi.mocked(runRestore).mockResolvedValue({ id: "pm-1" } as never);
  vi.mocked(runPlan).mockResolvedValue({ id: "pm-plan" } as never);
  vi.mocked(runHistoryRedact).mockResolvedValue({ id: "pm-1", changed: true, dry_run: false } as never);
  vi.mocked(assertHistoryRepairTarget).mockReturnValue(undefined as never);
  vi.mocked(runHistoryRepair).mockResolvedValue({ id: "pm-1", repaired: true } as never);
  vi.mocked(runHistoryRepairAll).mockResolvedValue({ totals: { failed: 0 } } as never);
  vi.mocked(runHistoryCompact).mockResolvedValue({ id: "pm-1", compacted: true } as never);
  vi.mocked(runSchemaAddType).mockResolvedValue({ action: "add-type", warnings: [] } as never);
  vi.mocked(runSchemaRemoveType).mockResolvedValue({ action: "remove-type", warnings: [] } as never);
  vi.mocked(runSchemaAddStatus).mockResolvedValue({ action: "add-status", warnings: [] } as never);
  vi.mocked(runSchemaRemoveStatus).mockResolvedValue({ action: "remove-status", warnings: [] } as never);
  vi.mocked(runSchemaList).mockResolvedValue({ action: "list" } as never);
  vi.mocked(runSchemaShow).mockResolvedValue({ action: "show" } as never);
  vi.mocked(runSchemaShowStatus).mockResolvedValue({ action: "show-status" } as never);
  vi.mocked(runComments).mockResolvedValue({ id: "pm-1", comments: [] } as never);
  vi.mocked(runNotes).mockResolvedValue({ id: "pm-1", notes: [] } as never);
  vi.mocked(runLearnings).mockResolvedValue({ id: "pm-1", learnings: [] } as never);
  vi.mocked(runFiles).mockResolvedValue({ id: "pm-1", files: [] } as never);
  vi.mocked(runFilesDiscover).mockResolvedValue({ id: "pm-1", changed: true } as never);
  vi.mocked(runDocs).mockResolvedValue({ id: "pm-1", docs: [] } as never);
  vi.mocked(runDeps).mockResolvedValue({ id: "pm-1", tree: [] } as never);
  vi.mocked(runInit).mockResolvedValue({ initialized: true, settings: {} } as never);
  vi.mocked(summarizeInitResult).mockReturnValue({ initialized: true } as never);
  vi.mocked(runConfig).mockResolvedValue({ scope: "project" } as never);
  vi.mocked(runExtension).mockResolvedValue({
    action: "explore",
    details: {},
    warnings: [],
  } as never);
  vi.mocked(runUpgrade).mockResolvedValue({ ok: true } as never);
});

afterEach(() => {
  process.exitCode = undefined;
});

describe("register modules command surface", () => {
  it("registers the full built-in command surface across all register modules", () => {
    const program = buildProgram();
    const names = new Set(program.commands.map((command) => command.name()));
    for (const expected of [
      "list", "list-all", "list-draft", "list-open", "list-in-progress", "list-blocked",
      "list-closed", "list-canceled", "aggregate", "context", "search", "get", "history",
      "activity", "test", "test-all", "test-runs-worker", "telemetry", "stats", "health",
      "validate", "gc", "contracts", "claim", "release", "start-task", "pause-task",
      "close-task", "create", "copy", "update", "update-many", "close", "close-many",
      "delete", "append", "restore", "plan", "history-redact", "history-repair",
      "history-compact", "schema", "comments", "notes", "learnings", "files", "docs",
      "deps", "init", "config", "extension", "package", "install", "upgrade",
    ]) {
      expect(names.has(expected), `missing command ${expected}`).toBe(true);
    }
    const context = program.commands.find((command) => command.name() === "context");
    expect(context?.aliases()).toContain("ctx");
    const packageCommand = program.commands.find((command) => command.name() === "package");
    expect(packageCommand?.aliases()).toContain("packages");
  });

  it("keeps hidden snake_case aliases parse-functional but out of help text", () => {
    const program = buildProgram();
    const list = program.commands.find((command) => command.name() === "list");
    const hidden = list?.options.find((option) => option.long === "--assignee_filter");
    expect(hidden).toBeDefined();
    expect(hidden?.hidden).toBe(true);
    const update = program.commands.find((command) => command.name() === "update");
    expect(update?.options.some((option) => option.long === "--allow_audit_update")).toBe(true);
  });

  it("honors the list-query command filter including the ctx alias", () => {
    const program = new Command();
    registerListQueryCommands(program, { commandFilter: new Set(["ctx", "list-open"]) });
    const names = program.commands.map((command) => command.name());
    expect(names).toContain("context");
    expect(names).toContain("list-open");
    expect(names).not.toContain("list");
    expect(names).not.toContain("search");

    const empty = new Command();
    registerListQueryCommands(empty, { commandFilter: new Set() });
    expect(empty.commands.map((command) => command.name())).toContain("list");
  });
});

describe("list-query command actions", () => {
  it("defaults pm list to brief projection and terminal exclusion", async () => {
    await runCli("list");
    const options = lastCallArg<Record<string, unknown>>(vi.mocked(runList) as never, 1);
    expect(options.brief).toBe(true);
    expect(options.excludeTerminal).toBe(true);
    expect(lastCallArg(vi.mocked(runList) as never, 0)).toBeUndefined();
  });

  it("does not force brief when an explicit projection is requested", async () => {
    await runCli("list", "--fields", "id,title", "--status", "open", "--limit", "5");
    const options = lastCallArg<Record<string, unknown>>(vi.mocked(runList) as never, 1);
    expect(options.brief).not.toBe(true);
    expect(options.fields).toBe("id,title");
    await runCli("list-closed", "--tag", "infra");
    expect(lastCallArg(vi.mocked(runList) as never, 0)).toBe("closed");
  });

  it("rejects --stream without --json and streams NDJSON rows with --json", async () => {
    await expect(runCli("list", "--stream")).rejects.toThrow("--stream requires --json");
    await runCliRaw("--json", "list", "--stream");
    expect(vi.mocked(runList)).toHaveBeenCalledTimes(2);
  });

  it("normalizes aggregate options through the real helper", async () => {
    await runCli("aggregate", "--group-by", "type,status", "--completion", "--include-unparented");
    const options = lastCallArg<Record<string, unknown>>(vi.mocked(runAggregate) as never, 0);
    expect(options.groupBy).toBe("type,status");
    expect(options.completion).toBe(true);
    expect(options.includeUnparented).toBe(true);
  });

  it("renders context markdown output and falls through to printResult otherwise", async () => {
    vi.mocked(resolveContextOutputFormat).mockReturnValue("markdown" as never);
    await runCliRaw("context", "--depth", "deep", "--section", "hierarchy", "--section", "progress");
    expect(vi.mocked(renderContextMarkdown)).toHaveBeenCalledTimes(1);
    const normalized = lastCallArg<Record<string, unknown>>(vi.mocked(runContext) as never, 0);
    expect(normalized.depth).toBe("deep");
    expect(normalized.section).toEqual(["hierarchy", "progress"]);

    vi.mocked(resolveContextOutputFormat).mockReturnValue("json" as never);
    await runCli("ctx", "--limit", "3");
    expect(vi.mocked(runContext)).toHaveBeenCalledTimes(2);
  });

  it("joins search keywords and resolves the search mode shorthands", async () => {
    await runCli("search", "vector", "cache");
    expect(lastCallArg(vi.mocked(runSearch) as never, 0)).toBe("vector cache");
    let options = lastCallArg<Record<string, unknown>>(vi.mocked(runSearch) as never, 1);
    expect(options.mode).toBe("keyword");

    await runCli("search", "--semantic", "drift");
    options = lastCallArg<Record<string, unknown>>(vi.mocked(runSearch) as never, 1);
    expect(options.mode).toBe("semantic");

    await expect(runCli("search", "   ")).rejects.toThrow("Search query must not be empty");
  });

  it("maps get tree flags onto runGet options", async () => {
    await runCli("get", "pm-1", "--tree", "--tree-depth", "2", "--fields", "id,title");
    const options = lastCallArg<Record<string, unknown>>(vi.mocked(runGet) as never, 2);
    expect(options.tree).toBe(true);
    expect(options.treeDepth).toBe("2");
    expect(options.fields).toBe("id,title");
  });

  it("guards history projection conflicts and derives diff mode from --field", async () => {
    await expect(runCli("history", "pm-1", "--compact", "--full")).rejects.toThrow(
      "mutually exclusive",
    );
    await runCli("history", "pm-1", "--field", "status", "--verify");
    const options = lastCallArg<Record<string, unknown>>(vi.mocked(runHistory) as never, 1);
    expect(options.diff).toBe(true);
    expect(options.field).toBe("status");
    expect(options.verify).toBe(true);
    expect(options.compact).toBe(true);
  });

  it("validates activity stream modes and streams entries with --json", async () => {
    await expect(runCli("activity", "--compact", "--full")).rejects.toThrow("mutually exclusive");
    await expect(runCli("activity", "--stream", "bogus")).rejects.toThrow(
      "accepts rows|ndjson|jsonl",
    );
    await expect(runCli("activity", "--stream", "rows")).rejects.toThrow(
      "--stream requires --json",
    );
    await runCliRaw("--json", "activity", "--stream", "ndjson", "--author", "agent");
    const normalized = lastCallArg<Record<string, unknown>>(vi.mocked(runActivity) as never, 0);
    expect(normalized.author).toBe("agent");
    expect(normalized.compact).toBe(true);
  });
});

describe("operation command actions", () => {
  it("maps pm test flags and flags dependency failures via exit code", async () => {
    await runCli("test", "pm-1", "--list", "--match", "unit", "--env-set", "A=1");
    let options = lastCallArg<Record<string, unknown>>(vi.mocked(runTest) as never, 1);
    expect(options.list).toBe(true);
    expect(options.match).toBe("unit");
    expect(options.envSet).toEqual(["A=1"]);
    expect(invalidateSearchCachesForMutation).not.toHaveBeenCalled();

    vi.mocked(runTest).mockResolvedValue({
      run_results: [{ status: "failed" }],
      fail_on_skipped_triggered: false,
    } as never);
    await runCli("test", "pm-1", "--run", "--add", "command=pnpm test");
    options = lastCallArg<Record<string, unknown>>(vi.mocked(runTest) as never, 1);
    expect(options.run).toBe(true);
    expect(options.add).toEqual(["command=pnpm test"]);
    expect(invalidateSearchCachesForMutation).toHaveBeenCalled();
    expect(process.exitCode).toBe(EXIT_CODE.DEPENDENCY_FAILED);
  });

  it("routes pm test --background through the background run starter", async () => {
    await expect(runCli("test", "pm-1", "--background")).rejects.toThrow("--background requires --run");
    await expect(runCli("test", "pm-1", "--background", "--run", "--add", "x")).rejects.toThrow(
      "does not support --add",
    );
    await runCli("test", "pm-1", "--background", "--run", "--timeout", "30");
    const request = lastCallArg<Record<string, unknown>>(vi.mocked(runStartBackgroundRun) as never, 0);
    expect(request.kind).toBe("test");
    expect(request.targetId).toBe("pm-1");
    expect(request.commandArgs).toContain("--timeout");
  });

  it("runs test-all in foreground and background modes", async () => {
    await runCli("test-all", "--status", "open", "--limit", "2");
    const options = lastCallArg<Record<string, unknown>>(vi.mocked(runTestAll) as never, 0);
    expect(options.status).toBe("open");
    expect(options.limit).toBe("2");
    expect(invalidateSearchCachesForMutation).toHaveBeenCalledWith(
      expect.anything(),
      { ids: ["pm-1"] },
    );

    vi.mocked(runTestAll).mockResolvedValue({ results: [], failed: 2 } as never);
    await runCli("test-all");
    expect(process.exitCode).toBe(EXIT_CODE.DEPENDENCY_FAILED);

    await runCli("test-all", "--background", "--status", "open");
    const request = lastCallArg<Record<string, unknown>>(vi.mocked(runStartBackgroundRun) as never, 0);
    expect(request.kind).toBe("test-all");
    expect(request.statusFilter).toBe("open");
  });

  it("dispatches the hidden test-runs worker command", async () => {
    await runCli("test-runs-worker", "run-42");
    expect(vi.mocked(runTestRunsWorker)).toHaveBeenCalledWith("run-42", expect.anything());
  });

  it("resolves telemetry subcommand routing including the legacy namespace", async () => {
    await runCli("telemetry");
    let options = lastCallArg<Record<string, unknown>>(vi.mocked(runTelemetry) as never, 0);
    expect(options.subcommand).toBeUndefined();

    await runCli("telemetry", "local-analytics");
    options = lastCallArg<Record<string, unknown>>(vi.mocked(runTelemetry) as never, 0);
    expect(options.subcommand).toBe("status");

    await runCli("telemetry", "stats", "--limit", "10");
    options = lastCallArg<Record<string, unknown>>(vi.mocked(runTelemetry) as never, 0);
    expect(options.subcommand).toBe("stats");
    expect(options.limit).toBe("10");

    await expect(runCli("telemetry", "status", "extra")).rejects.toThrow("Unknown pm telemetry path");
  });

  it("maps stats, gc, and contracts options", async () => {
    await runCli("stats", "--storage");
    expect(lastCallArg<Record<string, unknown>>(vi.mocked(runStats) as never, 1).storage).toBe(true);

    await runCli("gc", "--dry-run", "--scope", "locks", "--scope", "index");
    const gcOptions = lastCallArg<Record<string, unknown>>(vi.mocked(runGc) as never, 1);
    expect(gcOptions.dryRun).toBe(true);
    expect(gcOptions.scope).toEqual(["locks", "index"]);

    await runCli("contracts", "--command", "create", "--flags-only", "--active-only");
    const contractsOptions = lastCallArg<Record<string, unknown>>(vi.mocked(runContracts) as never, 0);
    expect(contractsOptions.command).toBe("create");
    expect(contractsOptions.flagsOnly).toBe(true);
    expect(contractsOptions.runtimeOnly).toBe(true);
  });

  it("escalates health and validate findings under strict exit", async () => {
    await runCli("health", "--summary", "--skip-drift");
    const healthOptions = lastCallArg<Record<string, unknown>>(vi.mocked(runHealth) as never, 1);
    expect(healthOptions.summary).toBe(true);
    expect(healthOptions.skipDrift).toBe(true);
    expect(process.exitCode).toBeUndefined();

    vi.mocked(runHealth).mockResolvedValue({ ok: false, warnings: ["w"] } as never);
    await runCli("health", "--strict-exit");
    expect(process.exitCode).toBe(EXIT_CODE.GENERIC_FAILURE);
    process.exitCode = undefined;

    vi.mocked(runValidate).mockResolvedValue({ ok: true, has_warnings: true } as never);
    await runCli("validate", "--check-metadata", "--fail-on-warn");
    const validateOptions = lastCallArg<Record<string, unknown>>(vi.mocked(runValidate) as never, 0);
    expect(validateOptions.checkMetadata).toBe(true);
    expect(process.exitCode).toBe(EXIT_CODE.GENERIC_FAILURE);
  });

  it("maps claim/release options and refreshes search caches", async () => {
    await runCli("claim", "pm-1", "--force", "--if-available", "--author", "agent");
    expect(vi.mocked(runClaim)).toHaveBeenCalledWith("pm-1", true, expect.anything(), {
      author: "agent",
      message: undefined,
      ifAvailable: true,
    });
    await runCli("release", "pm-1", "--allow-audit-release");
    expect(vi.mocked(runRelease)).toHaveBeenCalledWith("pm-1", false, expect.anything(), {
      author: undefined,
      message: undefined,
      allowAuditRelease: true,
    });
    expect(invalidateSearchCachesForMutation).toHaveBeenCalledTimes(2);
  });

  it("composes lifecycle aliases from claim/update/close/release", async () => {
    await runCli("start-task", "pm-1", "--author", "agent");
    expect(vi.mocked(runClaim)).toHaveBeenCalledTimes(1);
    let updateOptions = lastCallArg<Record<string, unknown>>(vi.mocked(runUpdate) as never, 1);
    expect(updateOptions.status).toBe("in_progress");

    await runCli("pause-task", "pm-1");
    updateOptions = lastCallArg<Record<string, unknown>>(vi.mocked(runUpdate) as never, 1);
    expect(updateOptions.status).toBe("open");
    expect(vi.mocked(runRelease)).toHaveBeenCalledTimes(1);

    await runCli("close-task", "pm-1", "shipped", "--validate-close", "strict");
    expect(vi.mocked(runClose)).toHaveBeenCalledWith(
      "pm-1",
      "shipped",
      expect.objectContaining({ validateClose: "strict" }),
      expect.anything(),
    );
    expect(vi.mocked(runRelease)).toHaveBeenCalledTimes(2);
  });
});

describe("mutation command actions", () => {
  it("supports both create positional forms and guards bare type positionals", async () => {
    await runCli("create", "Fix flaky test");
    let normalized = lastCallArg<Record<string, unknown>>(vi.mocked(runCreate) as never, 0);
    expect(normalized.title).toBe("Fix flaky test");

    await runCli("create", "task", "Fix flaky test");
    normalized = lastCallArg<Record<string, unknown>>(vi.mocked(runCreate) as never, 0);
    expect(normalized.type).toBe("task");
    expect(normalized.title).toBe("Fix flaky test");

    await expect(runCli("create", "Epic")).rejects.toThrow("looks like an item type");
    expect(invalidateSearchCachesForMutation).toHaveBeenCalledTimes(2);
  });

  it("maps copy, update, and append option surfaces", async () => {
    await runCli("copy", "pm-1", "--title", "Cloned");
    expect(vi.mocked(runCopy)).toHaveBeenCalledWith(
      "pm-1",
      { title: "Cloned", author: undefined, message: undefined },
      expect.anything(),
    );

    await runCli("update", "pm-1", "--title", "New", "--add-tags", "a,b", "--force");
    const updateOptions = lastCallArg<Record<string, unknown>>(vi.mocked(runUpdate) as never, 1);
    expect(updateOptions.title).toBe("New");
    expect(updateOptions.force).toBe(true);

    await runCli("append", "pm-1", "more detail");
    expect(lastCallArg<Record<string, unknown>>(vi.mocked(runAppend) as never, 1).body).toBe("more detail");
    await expect(runCli("append", "pm-1", "x", "--body", "y")).rejects.toThrow("exactly one source");
    await expect(runCli("append", "pm-1")).rejects.toThrow("Missing append text");
  });

  it("maps bulk update/close filters and mutation payloads", async () => {
    await runCli(
      "update-many",
      "--filter-status", "open",
      "--filter-tag", "infra",
      "--ids", "pm-1,pm-2",
      "--dry-run",
      "--title", "Bulk",
    );
    const updateManyRequest = lastCallArg<{
      status?: string;
      list: Record<string, unknown>;
      update: Record<string, unknown>;
      dryRun?: boolean;
    }>(vi.mocked(runUpdateMany) as never, 0);
    expect(updateManyRequest.status).toBe("open");
    expect(updateManyRequest.list.tag).toBe("infra");
    expect(updateManyRequest.list.ids).toBe("pm-1,pm-2");
    expect(updateManyRequest.dryRun).toBe(true);
    expect(updateManyRequest.update.title).toBe("Bulk");

    await runCli(
      "close-many",
      "--filter-tag", "infra",
      "--reason", "batch cleanup",
      "--expected", "tidy",
      "--actual", "tidy",
      "--validate-close",
    );
    const closeManyRequest = lastCallArg<Record<string, unknown>>(vi.mocked(runCloseMany) as never, 0);
    expect(closeManyRequest.reason).toBe("batch cleanup");
    expect(closeManyRequest.expectedResult).toBe("tidy");
    expect(closeManyRequest.actualResult).toBe("tidy");
    expect(closeManyRequest.validateClose).toBe("warn");
  });

  it("resolves close reason aliases and inline closure fields", async () => {
    await runCli(
      "close", "pm-1",
      "--reason", "done",
      "--resolution", "fixed",
      "--expected", "pass",
      "--actual_result", "passed",
    );
    expect(vi.mocked(runClose)).toHaveBeenCalledWith(
      "pm-1",
      "done",
      expect.objectContaining({
        resolution: "fixed",
        expectedResult: "pass",
        actualResult: "passed",
      }),
      expect.anything(),
    );
  });

  it("skips search-cache invalidation for delete dry runs", async () => {
    vi.mocked(runDelete).mockResolvedValue({ id: "pm-1", dry_run: true } as never);
    await runCli("delete", "pm-1", "--dry-run");
    expect(invalidateSearchCachesForMutation).not.toHaveBeenCalled();

    vi.mocked(runDelete).mockResolvedValue({ id: "pm-1", dry_run: false } as never);
    await runCli("delete", "pm-1", "--force");
    expect(invalidateSearchCachesForMutation).toHaveBeenCalledTimes(1);
    const deleteOptions = lastCallArg<Record<string, unknown>>(vi.mocked(runDelete) as never, 1);
    expect(deleteOptions.force).toBe(true);
  });

  it("maps restore and deps options", async () => {
    await runCli("restore", "pm-1", "3", "--force");
    expect(vi.mocked(runRestore)).toHaveBeenCalledWith(
      "pm-1",
      "3",
      { author: undefined, message: undefined, force: true },
      expect.anything(),
    );
    await runCli("deps", "pm-1", "--format", "graph", "--summary", "--max-depth", "2");
    const depsOptions = lastCallArg<Record<string, unknown>>(vi.mocked(runDeps) as never, 1);
    expect(depsOptions.format).toBe("graph");
    expect(depsOptions.summary).toBe(true);
    expect(depsOptions.maxDepth).toBe("2");
  });

  it("routes plan subcommands, aliases, positional titles, and reorder validation", async () => {
    await expect(runCli("plan")).rejects.toThrow("pm plan requires a subcommand");
    await expect(runCli("plan", "list")).rejects.toThrow("Unknown pm plan subcommand");

    await runCli("plan", "create", "Refactor retries", "--step", "read", "--blocked_by", "pm-a", "--from_search", "locks");
    let request = lastCallArg<{
      subcommand: string;
      id?: string;
      options: Record<string, unknown>;
    }>(vi.mocked(runPlan) as never, 0);
    expect(request.subcommand).toBe("create");
    expect(request.id).toBeUndefined();
    expect(request.options.title).toBe("Refactor retries");
    expect(request.options.step).toEqual(["read"]);
    expect(request.options.blockedBy).toEqual(["pm-a"]);
    expect(request.options.fromSearch).toBe("locks");

    await expect(runCli("plan", "reorder-step", "pm-plan", "step-1", "not-int")).rejects.toThrow(
      "requires an integer new order",
    );
    await runCli("plan", "reorder-step", "pm-plan", "step-1", "7", "--allow_multiple_active");
    request = lastCallArg(vi.mocked(runPlan) as never, 0);
    expect(request).toMatchObject({
      subcommand: "reorder-step",
      id: "pm-plan",
      stepRef: "step-1",
      reorderTo: 7,
    });
    expect(request.options.allowMultipleActive).toBe(true);
    expect(invalidateSearchCachesForMutation).toHaveBeenCalled();
  });

  it("routes history redaction, repair, repair-all, and compaction actions", async () => {
    await runCli("history-redact", "pm-1", "--literal", "secret", "--regex", "/token/gi", "--replacement", "[x]");
    expect(vi.mocked(runHistoryRedact)).toHaveBeenCalledWith(
      "pm-1",
      expect.objectContaining({
        literal: ["secret"],
        regex: ["/token/gi"],
        replacement: "[x]",
        dryRun: false,
      }),
      expect.anything(),
    );
    expect(invalidateSearchCachesForMutation).toHaveBeenCalledTimes(1);

    vi.mocked(runHistoryRedact).mockResolvedValueOnce({ id: "pm-1", changed: true, dry_run: true } as never);
    await runCli("history-redact", "pm-1", "--literal", "secret", "--dry-run");
    expect(invalidateSearchCachesForMutation).toHaveBeenCalledTimes(1);

    await runCli("history-repair", "pm-1", "--dry-run", "--message", "repair");
    expect(vi.mocked(assertHistoryRepairTarget)).toHaveBeenCalledWith("pm-1", false);
    expect(vi.mocked(runHistoryRepair)).toHaveBeenCalledWith(
      "pm-1",
      expect.objectContaining({ dryRun: true, message: "repair" }),
      expect.anything(),
    );

    vi.mocked(runHistoryRepairAll).mockResolvedValueOnce({ totals: { failed: 2 } } as never);
    await runCli("history-repair", "--all", "--force");
    expect(vi.mocked(assertHistoryRepairTarget)).toHaveBeenCalledWith(undefined, true);
    expect(vi.mocked(runHistoryRepairAll)).toHaveBeenCalledWith(
      expect.objectContaining({ force: true }),
      expect.anything(),
    );
    expect(process.exitCode).toBe(EXIT_CODE.GENERIC_FAILURE);
    process.exitCode = undefined;

    await runCli("history-compact", "pm-1", "--before", "12", "--dry-run");
    expect(vi.mocked(runHistoryCompact)).toHaveBeenCalledWith(
      "pm-1",
      expect.objectContaining({ before: "12", dryRun: true }),
      expect.anything(),
    );
  });

  it("routes schema subcommands, shorthand add-type, aliases, warnings, and JSON output", async () => {
    await expect(runCli("schema")).rejects.toThrow("pm schema requires a subcommand");
    await expect(runCli("schema", "bogus", "Name")).rejects.toThrow("Unknown pm schema subcommand");

    await runCliRaw("schema", "list");
    expect(vi.mocked(runSchemaList)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(formatSchemaListHuman)).toHaveBeenCalledTimes(1);

    await runCliRaw("schema", "show", "Task");
    expect(vi.mocked(runSchemaShow)).toHaveBeenCalledWith("Task", expect.anything());
    expect(vi.mocked(formatSchemaShowHuman)).toHaveBeenCalledTimes(1);

    await runCliRaw("schema", "show-status", "open");
    expect(vi.mocked(runSchemaShowStatus)).toHaveBeenCalledWith("open", expect.anything());
    expect(vi.mocked(formatSchemaShowStatusHuman)).toHaveBeenCalledTimes(1);

    await runCliRaw("schema", "remove-type", "Spike", "--force");
    expect(vi.mocked(runSchemaRemoveType)).toHaveBeenCalledWith(
      "Spike",
      { author: undefined, force: true },
      expect.anything(),
    );
    expect(vi.mocked(formatSchemaRemoveTypeHuman)).toHaveBeenCalledTimes(1);

    await runCliRaw("schema", "Spike", "--description", "Investigation", "--default_status", "open", "--folder", "spikes", "--alias", "spike");
    expect(vi.mocked(runSchemaAddType)).toHaveBeenCalledWith(
      "Spike",
      expect.objectContaining({
        description: "Investigation",
        defaultStatus: "open",
        folder: "spikes",
        alias: ["spike"],
      }),
      expect.anything(),
    );
    expect(vi.mocked(formatSchemaAddTypeHuman)).toHaveBeenCalledTimes(1);

    vi.mocked(runSchemaAddStatus).mockResolvedValueOnce({ action: "add-status", warnings: ["hook:warn"] } as never);
    await runCliRaw("schema", "add-status", "review", "--role", "active", "--alias", "in_review", "--order", "5");
    expect(vi.mocked(runSchemaAddStatus)).toHaveBeenCalledWith(
      "review",
      expect.objectContaining({ role: ["active"], alias: ["in_review"], order: 5 }),
      expect.anything(),
    );
    expect(vi.mocked(formatSchemaAddStatusHuman)).toHaveBeenCalledTimes(1);

    await runCliRaw("schema", "remove-status", "review");
    expect(vi.mocked(runSchemaRemoveStatus)).toHaveBeenCalledWith(
      "review",
      { author: undefined, force: false },
      expect.anything(),
    );
    expect(vi.mocked(formatSchemaRemoveStatusHuman)).toHaveBeenCalledTimes(1);

    await runCliRaw("--json", "schema", "list");
    expect(vi.mocked(formatSchemaListHuman)).toHaveBeenCalledTimes(1);
    await expect(runCli("schema", "add-status", "bad", "--order", "not-a-number")).rejects.toThrow(
      "--order must be a finite integer",
    );
  });

  it("guards annotation text sources and skips refresh for read-only listings", async () => {
    await runCli("comments", "pm-1", "looks good");
    expect(lastCallArg<Record<string, unknown>>(vi.mocked(runComments) as never, 1).add).toBe("looks good");
    await expect(runCli("comments", "pm-1", "a", "--add", "b")).rejects.toThrow(
      "either as positional [text] or with --add",
    );
    await expect(runCli("comments", "pm-1", "a", "--stdin", "--file", "x")).rejects.toThrow(
      "exactly one source",
    );
    await runCli("comments", "pm-1", "--limit", "3");
    expect(invalidateSearchCachesForMutation).toHaveBeenCalledTimes(1);

    await runCli("notes", "pm-1", "--add", "note text");
    expect(lastCallArg<Record<string, unknown>>(vi.mocked(runNotes) as never, 1).add).toBe("note text");
    await expect(runCli("notes", "pm-1", "a", "--add", "b")).rejects.toThrow("not both");

    await runCli("learnings", "pm-1", "lesson", "--allow-audit-learning");
    const learningsOptions = lastCallArg<Record<string, unknown>>(vi.mocked(runLearnings) as never, 1);
    expect(learningsOptions.add).toBe("lesson");
    expect(learningsOptions.allowAuditComment).toBe(true);
    await expect(runCli("learnings", "pm-1", "a", "--add", "b")).rejects.toThrow("not both");
  });

  it("maps files/docs link management and discover routing", async () => {
    await runCli("files", "pm-1", "--add", "path=src/a.ts", "--validate-paths");
    const filesOptions = lastCallArg<Record<string, unknown>>(vi.mocked(runFiles) as never, 1);
    expect(filesOptions.add).toEqual(["path=src/a.ts"]);
    expect(filesOptions.validatePaths).toBe(true);
    expect(invalidateSearchCachesForMutation).toHaveBeenCalledTimes(1);

    await runCli("files", "discover", "pm-1", "--apply", "--note", "found");
    const discoverOptions = lastCallArg<Record<string, unknown>>(vi.mocked(runFilesDiscover) as never, 1);
    expect(discoverOptions.apply).toBe(true);
    expect(discoverOptions.note).toBe("found");
    expect(invalidateSearchCachesForMutation).toHaveBeenCalledTimes(2);

    await runCli("docs", "pm-1", "--list");
    expect(lastCallArg<Record<string, unknown>>(vi.mocked(runDocs) as never, 1).list).toBe(true);
    expect(invalidateSearchCachesForMutation).toHaveBeenCalledTimes(2);
  });
});

describe("setup command actions", () => {
  it("summarizes init output by default and emits the full tree with --verbose", async () => {
    await runCli("init", "--defaults", "--author", "agent");
    expect(vi.mocked(runInit)).toHaveBeenCalledWith(
      undefined,
      expect.anything(),
      expect.objectContaining({ defaults: true, author: "agent" }),
    );
    expect(vi.mocked(summarizeInitResult)).toHaveBeenCalledTimes(1);

    await runCli("init", "demo", "--yes", "--verbose");
    expect(vi.mocked(runInit)).toHaveBeenCalledWith(
      "demo",
      expect.anything(),
      expect.objectContaining({ defaults: true }),
    );
    expect(vi.mocked(summarizeInitResult)).toHaveBeenCalledTimes(1);
  });

  it("shifts config positionals when the scope is an action shorthand", async () => {
    await runCli("config", "set", "item-format", "toon");
    expect(vi.mocked(runConfig)).toHaveBeenCalledWith(
      "project",
      "set",
      "item-format",
      expect.anything(),
      expect.anything(),
      "toon",
    );

    await runCli("config", "global", "get", "definition-of-done", "--criterion", "tests pass");
    expect(vi.mocked(runConfig)).toHaveBeenCalledWith(
      "global",
      "get",
      "definition-of-done",
      expect.objectContaining({ criterion: ["tests pass"] }),
      expect.anything(),
      undefined,
    );

    await runCli("config");
    expect(vi.mocked(runConfig)).toHaveBeenLastCalledWith(
      "project",
      "list",
      undefined,
      expect.anything(),
      expect.anything(),
      undefined,
    );
  });

  it("routes lifecycle subcommands to forced extension actions", async () => {
    // Scope flags shared between the lifecycle parent and its subcommands
    // (--global/--strict-exit/...) are hoisted onto the parent by commander;
    // executeExtensionCommand reads optsWithGlobals() so both the top-level
    // flag form and the subcommand form reach normalizeExtensionOptions.
    await runCli("extension", "--explore", "--global");
    let normalized = lastCallArg<Record<string, unknown>>(vi.mocked(runExtension) as never, 1);
    expect(normalized.explore).toBe(true);
    expect(normalized.global).toBe(true);
    expect(normalized.vocabulary).toBe("extension");

    await runCli("extension", "explore");
    normalized = lastCallArg<Record<string, unknown>>(vi.mocked(runExtension) as never, 1);
    expect(normalized.explore).toBe(true);

    await runCli("extension", "explore", "--global");
    normalized = lastCallArg<Record<string, unknown>>(vi.mocked(runExtension) as never, 1);
    expect(normalized.explore).toBe(true);
    expect(normalized.global).toBe(true);

    await runCli("extension", "doctor", "--strict-exit", "--detail", "deep");
    normalized = lastCallArg<Record<string, unknown>>(vi.mocked(runExtension) as never, 1);
    expect(normalized.doctor).toBe(true);
    expect(normalized.strictExit).toBe(true);
    expect(normalized.detail).toBe("deep");

    await runCli("package", "install", "npm:pm-brief");
    expect(lastCallArg(vi.mocked(runExtension) as never, 0)).toBe("npm:pm-brief");
    normalized = lastCallArg<Record<string, unknown>>(vi.mocked(runExtension) as never, 1);
    expect(normalized.install).toBe(true);
    expect(normalized.vocabulary).toBe("package");

    await runCli("extension", "init", "./my-ext");
    normalized = lastCallArg<Record<string, unknown>>(vi.mocked(runExtension) as never, 1);
    expect(normalized.init).toBe(true);

    await runCli("package", "--catalog");
    normalized = lastCallArg<Record<string, unknown>>(vi.mocked(runExtension) as never, 1);
    expect(normalized.catalog).toBe(true);
  });

  it("rejects multiple install targets unless they are a shell-expanded wildcard", async () => {
    await expect(runCli("install", "pkg-a", "pkg-b")).rejects.toThrow(
      "one package source at a time",
    );

    const wildcardDir = await mkdtemp(path.join(tmpdir(), "pm-register-wildcard-"));
    const previousCwd = process.cwd();
    try {
      await writeFile(path.join(wildcardDir, "pkg-a"), "", "utf8");
      await writeFile(path.join(wildcardDir, "pkg-b"), "", "utf8");
      process.chdir(wildcardDir);
      await runCli("install", "pkg-a", "pkg-b");
      expect(lastCallArg(vi.mocked(runExtension) as never, 0)).toBe("*");
    } finally {
      process.chdir(previousCwd);
      await rm(wildcardDir, { recursive: true, force: true });
    }
  });

  it("escalates doctor warnings and failed upgrades through exit codes", async () => {
    vi.mocked(runExtension).mockResolvedValue({
      action: "doctor",
      details: { summary: { status: "warn" } },
      warnings: ["w"],
    } as never);
    await runCli("extension", "--doctor", "--strict-exit");
    expect(process.exitCode).toBe(EXIT_CODE.GENERIC_FAILURE);
    process.exitCode = undefined;

    vi.mocked(runExtension).mockResolvedValue({
      action: "doctor",
      details: { summary: { status: "ok" } },
      warnings: [],
    } as never);
    await runCli("extension", "--doctor", "--fail-on-warn");
    expect(process.exitCode).toBeUndefined();

    vi.mocked(runExtension).mockResolvedValue({
      action: "doctor",
      details: {},
      warnings: ["unmanaged"],
    } as never);
    await runCli("extension", "--doctor", "--strict-exit");
    expect(process.exitCode).toBe(EXIT_CODE.GENERIC_FAILURE);
    process.exitCode = undefined;

    vi.mocked(runUpgrade).mockResolvedValue({ ok: false } as never);
    await runCli("upgrade", "--dry-run", "--cli-only");
    expect(lastCallArg<Record<string, unknown>>(vi.mocked(runUpgrade) as never, 1).dryRun).toBe(true);
    expect(process.exitCode).toBe(EXIT_CODE.GENERIC_FAILURE);
  });
});
