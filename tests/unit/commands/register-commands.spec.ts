import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
vi.mock("../../../src/cli/commands/focus.js", () => ({ runFocus: vi.fn() }));
vi.mock("../../../src/cli/commands/scheduling-shortcuts.js", () => ({
  runMeet: vi.fn(),
  runEvent: vi.fn(),
  runRemind: vi.fn(),
}));
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
vi.mock("../../../src/cli/commands/history-compact.js", () => ({
  assertHistoryCompactTarget: vi.fn(),
  runHistoryCompact: vi.fn(),
  runHistoryCompactBulk: vi.fn(),
}));
vi.mock("../../../src/cli/commands/schema.js", () => ({
  SCHEMA_SUBCOMMANDS: [
    "add-type",
    "remove-type",
    "add-status",
    "remove-status",
    "add-field",
    "remove-field",
    "list-fields",
    "show-field",
    "apply-preset",
    "list",
    "show",
    "show-status",
  ],
  runSchemaAddType: vi.fn(),
  runSchemaRemoveType: vi.fn(),
  runSchemaAddStatus: vi.fn(),
  runSchemaRemoveStatus: vi.fn(),
  runSchemaAddField: vi.fn(),
  runSchemaRemoveField: vi.fn(),
  runSchemaListFields: vi.fn(),
  runSchemaShowField: vi.fn(),
  runSchemaApplyPreset: vi.fn(),
  runSchemaInferTypes: vi.fn(),
  runSchemaList: vi.fn(),
  runSchemaShow: vi.fn(),
  runSchemaShowStatus: vi.fn(),
  formatSchemaAddTypeHuman: vi.fn(() => "added type"),
  formatSchemaRemoveTypeHuman: vi.fn(() => "removed type"),
  formatSchemaAddStatusHuman: vi.fn(() => "added status"),
  formatSchemaRemoveStatusHuman: vi.fn(() => "removed status"),
  formatSchemaAddFieldHuman: vi.fn(() => "added field"),
  formatSchemaRemoveFieldHuman: vi.fn(() => "removed field"),
  formatSchemaListFieldsHuman: vi.fn(() => "schema fields"),
  formatSchemaShowFieldHuman: vi.fn(() => "schema field"),
  formatSchemaApplyPresetHuman: vi.fn(() => "applied preset"),
  formatSchemaInferTypesHuman: vi.fn(() => "inferred types"),
  formatSchemaListHuman: vi.fn(() => "schema list"),
  formatSchemaShowHuman: vi.fn(() => "schema show"),
  formatSchemaShowStatusHuman: vi.fn(() => "schema status"),
}));
vi.mock("../../../src/cli/commands/profile.js", () => ({
  PROFILE_SUBCOMMANDS: ["list", "show", "apply", "lint"],
  runProfileList: vi.fn(() => ({ action: "list" })),
  runProfileShow: vi.fn(() => ({ action: "show" })),
  runProfileApply: vi.fn(() => ({ action: "apply", warnings: [] })),
  runProfileLint: vi.fn(() => ({ action: "lint", ok: true, findings: [], warnings: [] })),
  formatProfileListHuman: vi.fn(() => "profile list"),
  formatProfileShowHuman: vi.fn(() => "profile show"),
  formatProfileApplyHuman: vi.fn(() => "profile apply"),
  formatProfileLintHuman: vi.fn(() => "profile lint"),
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
import { resolveStartTaskInProgressStatus } from "../../../src/sdk/start-task-status.js";
import { resolveRuntimeStatusRegistry } from "../../../src/core/schema/runtime-schema.js";
import {
  looksLikeSchemaSubcommandTypo,
  registerMutationCommands,
  parseSchemaOrderOption,
  parsePositiveIntOption,
  registerCommanderOptionContracts,
} from "../../../src/cli/register-mutation.js";
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
import { runFocus } from "../../../src/cli/commands/focus.js";
import { runMeet, runEvent, runRemind } from "../../../src/cli/commands/scheduling-shortcuts.js";
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
import {
  assertHistoryCompactTarget,
  runHistoryCompact,
  runHistoryCompactBulk,
} from "../../../src/cli/commands/history-compact.js";
import {
  formatSchemaAddStatusHuman,
  formatSchemaAddTypeHuman,
  formatSchemaAddFieldHuman,
  formatSchemaRemoveFieldHuman,
  formatSchemaListFieldsHuman,
  formatSchemaShowFieldHuman,
  formatSchemaApplyPresetHuman,
  formatSchemaInferTypesHuman,
  formatSchemaListHuman,
  formatSchemaRemoveStatusHuman,
  formatSchemaRemoveTypeHuman,
  formatSchemaShowHuman,
  formatSchemaShowStatusHuman,
  runSchemaAddStatus,
  runSchemaAddType,
  runSchemaAddField,
  runSchemaRemoveField,
  runSchemaListFields,
  runSchemaShowField,
  runSchemaApplyPreset,
  runSchemaInferTypes,
  runSchemaList,
  runSchemaRemoveStatus,
  runSchemaRemoveType,
  runSchemaShow,
  runSchemaShowStatus,
} from "../../../src/cli/commands/schema.js";
import {
  formatProfileApplyHuman,
  formatProfileLintHuman,
  formatProfileListHuman,
  formatProfileShowHuman,
  runProfileApply,
  runProfileLint,
  runProfileList,
  runProfileShow,
} from "../../../src/cli/commands/profile.js";
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
import { EXIT_CODE, SETTINGS_DEFAULTS } from "../../../src/core/shared/constants.js";
import { PmCliError } from "../../../src/core/shared/errors.js";
import { writeSettings } from "../../../src/core/store/settings.js";

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
  vi.mocked(runFocus).mockResolvedValue({ action: "set", focused_item: "pm-1" } as never);
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
  vi.mocked(runSchemaAddField).mockResolvedValue({ action: "add-field", warnings: [] } as never);
  vi.mocked(runSchemaRemoveField).mockResolvedValue({ action: "remove-field", warnings: [] } as never);
  vi.mocked(runSchemaListFields).mockResolvedValue({ action: "list-fields" } as never);
  vi.mocked(runSchemaShowField).mockResolvedValue({ action: "show-field" } as never);
  vi.mocked(runSchemaApplyPreset).mockResolvedValue({ action: "apply-preset", warnings: [] } as never);
  vi.mocked(runSchemaInferTypes).mockResolvedValue({ action: "infer-types", warnings: [] } as never);
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

  it("defaults pm list-blocked to the compact status-list projection", async () => {
    await runCli("list-blocked");
    const options = lastCallArg<Record<string, unknown>>(vi.mocked(runList) as never, 1);
    expect(options.brief).toBe(true);
    expect(lastCallArg(vi.mocked(runList) as never, 0)).toBe("blocked");
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

  it("marks skipped-linked-test failures as dependency exits", async () => {
    vi.mocked(runTest).mockResolvedValue({
      run_results: [{ status: "passed" }],
      fail_on_skipped_triggered: true,
    } as never);
    await runCli("test", "pm-1", "--run");
    expect(process.exitCode).toBe(EXIT_CODE.DEPENDENCY_FAILED);
    process.exitCode = undefined;

    vi.mocked(runTestAll).mockResolvedValue({
      results: [{ id: "pm-1" }],
      failed: 0,
      fail_on_skipped_triggered: true,
    } as never);
    await runCli("test-all");
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

    await runCli("telemetry", "local-analytics", "flush");
    options = lastCallArg<Record<string, unknown>>(vi.mocked(runTelemetry) as never, 0);
    expect(options.subcommand).toBe("flush");

    await expect(runCli("telemetry", "status", "extra")).rejects.toThrow("Unknown pm telemetry path");
  });

  it("routes test/test-all background variants and omits profile timing when not requested", async () => {
    // Background test without an explicit author exercises the author-absent
    // branch of the background-run request builder.
    await runCliRaw("test", "pm-1", "--background", "--run");
    const testRequest = lastCallArg<Record<string, unknown>>(vi.mocked(runStartBackgroundRun) as never, 0);
    expect(testRequest.kind).toBe("test");
    expect(testRequest.author).toBeUndefined();

    // Background test-all without --status exercises the statusFilter-absent branch.
    await runCliRaw("test-all", "--background");
    const testAllRequest = lastCallArg<Record<string, unknown>>(vi.mocked(runStartBackgroundRun) as never, 0);
    expect(testAllRequest.kind).toBe("test-all");
    expect(testAllRequest.statusFilter).toBeUndefined();

    // Without --profile the trailing profile-timing branch is skipped across the
    // operation handlers; running them via runCliRaw covers those else paths.
    await runCliRaw("test", "pm-1", "--list");
    await runCliRaw("test-all");
    await runCliRaw("telemetry");
    await runCliRaw("stats");
    await runCliRaw("gc");
    await runCliRaw("contracts");
    await runCliRaw("claim", "pm-1");
    await runCliRaw("release", "pm-1");
    await runCliRaw("start-task", "pm-1");
    await runCliRaw("pause-task", "pm-1");
    await runCliRaw("close-task", "pm-1");
    await runCliRaw("health");
    await runCliRaw("validate");
    expect(vi.mocked(runContracts)).toHaveBeenCalled();
  });

  it("threads author/message and metadata-profile string options through operation handlers", async () => {
    await runCli("test", "pm-1", "--background", "--run", "--author", "agent");
    const backgroundRequest = lastCallArg<Record<string, unknown>>(vi.mocked(runStartBackgroundRun) as never, 0);
    expect(backgroundRequest.author).toBe("agent");

    await runCli("validate", "--check-metadata", "--metadata-profile", "strict");
    expect(lastCallArg<Record<string, unknown>>(vi.mocked(runValidate) as never, 0).metadataProfile).toBe("strict");

    await runCli("claim", "pm-1", "--message", "claiming");
    expect(vi.mocked(runClaim)).toHaveBeenLastCalledWith("pm-1", false, expect.anything(), {
      author: undefined,
      message: "claiming",
      ifAvailable: false,
    });

    await runCli("claim", "pm-1", "--assignee", "alias-agent");
    expect(vi.mocked(runClaim)).toHaveBeenLastCalledWith("pm-1", false, expect.anything(), {
      author: "alias-agent",
      message: undefined,
      ifAvailable: false,
    });

    await runCli("claim", "pm-1", "--author", "same-agent", "--assignee", "same-agent");
    expect(vi.mocked(runClaim)).toHaveBeenLastCalledWith("pm-1", false, expect.anything(), {
      author: "same-agent",
      message: undefined,
      ifAvailable: false,
    });
    await expect(runCli("claim", "pm-1", "--author", "author-agent", "--assignee", "alias-agent")).rejects.toThrow(
      "conflicting --author and --assignee",
    );

    await runCli("release", "pm-1", "--author", "agent", "--message", "handoff");
    expect(vi.mocked(runRelease)).toHaveBeenLastCalledWith("pm-1", false, expect.anything(), {
      author: "agent",
      message: "handoff",
      allowAuditRelease: false,
    });

    await runCli("release", "pm-1", "--assignee", "release-alias");
    expect(vi.mocked(runRelease)).toHaveBeenLastCalledWith("pm-1", false, expect.anything(), {
      author: "release-alias",
      message: undefined,
      allowAuditRelease: false,
    });

    await runCli("start-task", "pm-1", "--message", "begin");
    expect(lastCallArg<Record<string, unknown>>(vi.mocked(runUpdate) as never, 1).message).toBe("begin");

    await runCli("start-task", "pm-1", "--assignee", "start-alias");
    expect(lastCallArg<Record<string, unknown>>(vi.mocked(runClaim) as never, 3).author).toBe("start-alias");
    expect(lastCallArg<Record<string, unknown>>(vi.mocked(runUpdate) as never, 1).author).toBe("start-alias");

    await runCli("pause-task", "pm-1", "--author", "agent", "--message", "pause");
    expect(lastCallArg<Record<string, unknown>>(vi.mocked(runUpdate) as never, 1).author).toBe("agent");

    await runCli("pause-task", "pm-1", "--assignee", "pause-alias");
    expect(lastCallArg<Record<string, unknown>>(vi.mocked(runUpdate) as never, 1).author).toBe("pause-alias");
    expect(lastCallArg<Record<string, unknown>>(vi.mocked(runRelease) as never, 3).author).toBe("pause-alias");

    await runCli("close-task", "pm-1", "wrapped", "--author", "agent", "--message", "closing");
    expect(vi.mocked(runClose)).toHaveBeenLastCalledWith(
      "pm-1",
      "wrapped",
      expect.objectContaining({ author: "agent", message: "closing" }),
      expect.anything(),
    );

    await runCli("close-task", "pm-1", "wrapped", "--assignee", "close-alias");
    expect(vi.mocked(runClose)).toHaveBeenLastCalledWith(
      "pm-1",
      "wrapped",
      expect.objectContaining({ author: "close-alias" }),
      expect.anything(),
    );
    expect(lastCallArg<Record<string, unknown>>(vi.mocked(runRelease) as never, 3).author).toBe("close-alias");
  });

  it("delegates scheduling shortcuts to runMeet/runEvent/runRemind with translated options", async () => {
    const result = { item: { id: "pm-1" }, changed_fields: [], warnings: [] };
    vi.mocked(runMeet).mockResolvedValue(result as never);
    vi.mocked(runEvent).mockResolvedValue(result as never);
    vi.mocked(runRemind).mockResolvedValue(result as never);

    await runCli(
      "meet",
      "Sprint Planning",
      "--start",
      "+1h",
      "--duration",
      "1h",
      "--location",
      "Room A",
      "--timezone",
      "UTC",
      "--all-day",
      "--tags",
      "infra,demo",
      "--parent",
      "pm-epic",
      "--allow-missing-parent",
      "--priority",
      "1",
      "--body",
      "body",
      "--description",
      "desc",
      "--author",
      "agent",
      "--message",
      "msg",
    );
    expect(vi.mocked(runMeet)).toHaveBeenLastCalledWith(
      "Sprint Planning",
      expect.objectContaining({
        start: "+1h",
        duration: "1h",
        location: "Room A",
        timezone: "UTC",
        allDay: true,
        tags: "infra,demo",
        parent: "pm-epic",
        allowMissingParent: true,
        priority: "1",
        author: "agent",
        message: "msg",
      }),
      expect.anything(),
    );
    expect(invalidateSearchCachesForMutation).toHaveBeenCalled();

    // Omitting optional flags exercises the undefined branches of optionalString
    // and the all-day/allow-missing-parent falsey paths.
    await runCli("event", "Release v2", "--end", "2026-07-01T12:00:00Z");
    expect(vi.mocked(runEvent)).toHaveBeenLastCalledWith(
      "Release v2",
      expect.objectContaining({
        end: "2026-07-01T12:00:00Z",
        start: undefined,
        allDay: undefined,
        allowMissingParent: undefined,
        location: undefined,
      }),
      expect.anything(),
    );

    await runCli("event", "Release window", "--duration", "PT30M");
    expect(vi.mocked(runEvent)).toHaveBeenLastCalledWith(
      "Release window",
      expect.objectContaining({
        duration: "PT30M",
        end: undefined,
      }),
      expect.anything(),
    );

    await runCli("remind", "Review PR", "--at", "+2d", "--text", "ping");
    expect(vi.mocked(runRemind)).toHaveBeenLastCalledWith(
      "Review PR",
      expect.objectContaining({ at: "+2d", text: "ping" }),
      expect.anything(),
    );

    // Run without --profile to exercise the non-profile branch of each handler.
    await runCliRaw("meet", "No profile");
    await runCliRaw("event", "No profile");
    await runCliRaw("remind", "No profile");
  });

  it("resolves start-task to the registry's in_progress status when defined", () => {
    // The default registry defines in_progress, so the strict registry lookup
    // resolves it directly (the main branch of resolveStartTaskInProgressStatus).
    const registry = resolveRuntimeStatusRegistry(structuredClone(SETTINGS_DEFAULTS).schema);
    expect(resolveStartTaskInProgressStatus(registry)).toBe("in_progress");
  });

  it("falls back to the open status when the registry omits in_progress", () => {
    // A custom workflow whose statuses do not include in_progress makes the
    // strict registry lookup return undefined, exercising the
    // `?? statusRegistry.open_status` fallback. The registry is built directly
    // (not persisted via writeSettings, which re-seeds the built-in statuses).
    const registry = resolveRuntimeStatusRegistry({
      statuses: [
        { id: "open", roles: ["active", "default_open"] },
        { id: "review", roles: ["active"] },
        { id: "done", roles: ["terminal", "terminal_done", "default_close"] },
        { id: "canceled", roles: ["terminal", "terminal_canceled", "default_cancel"] },
      ],
      workflow: { open_status: "open", close_status: "done" },
    } as never);
    expect(registry.alias_to_id.has("in_progress")).toBe(false);
    expect(resolveStartTaskInProgressStatus(registry)).toBe("open");
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

  it("maps expanded operation option booleans and string payloads", async () => {
    await runCli(
      "test",
      "pm-1",
      "--run",
      "--add-json",
      "{\"command\":\"pnpm test\"}",
      "--remove",
      "path=tests/unit/a.spec.ts",
      "--only-index",
      "2",
      "--only-last",
      "--timeout",
      "45",
      "--progress",
      "--env-set",
      "A=1",
      "--env-clear",
      "B",
      "--shared-host-safe",
      "--pm-context",
      "tracker",
      "--override-linked-pm-context",
      "--fail-on-context-mismatch",
      "--fail-on-skipped",
      "--fail-on-empty-test-run",
      "--require-assertions-for-pm",
      "--check-context",
      "--auto-pm-context",
      "--author",
      "agent",
      "--message",
      "run linked tests",
      "--force",
    );
    const testOptions = lastCallArg<Record<string, unknown>>(vi.mocked(runTest) as never, 1);
    expect(testOptions.addJson).toEqual(["{\"command\":\"pnpm test\"}"]);
    expect(testOptions.remove).toEqual(["path=tests/unit/a.spec.ts"]);
    expect(testOptions.onlyIndex).toBe("2");
    expect(testOptions.onlyLast).toBe(true);
    expect(testOptions.timeout).toBe("45");
    expect(testOptions.progress).toBe(true);
    expect(testOptions.envSet).toEqual(["A=1"]);
    expect(testOptions.envClear).toEqual(["B"]);
    expect(testOptions.sharedHostSafe).toBe(true);
    expect(testOptions.pmContext).toBe("tracker");
    expect(testOptions.overrideLinkedPmContext).toBe(true);
    expect(testOptions.failOnContextMismatch).toBe(true);
    expect(testOptions.failOnSkipped).toBe(true);
    expect(testOptions.failOnEmptyTestRun).toBe(true);
    expect(testOptions.requireAssertionsForPm).toBe(true);
    expect(testOptions.checkContext).toBe(true);
    expect(testOptions.autoPmContext).toBe(true);
    expect(testOptions.author).toBe("agent");
    expect(testOptions.message).toBe("run linked tests");
    expect(testOptions.force).toBe(true);

    await runCli(
      "test-all",
      "--offset",
      "1",
      "--timeout",
      "30",
      "--progress",
      "--env-set",
      "K=V",
      "--env-clear",
      "NOPE",
      "--shared-host-safe",
      "--pm-context",
      "schema",
      "--override-linked-pm-context",
      "--fail-on-context-mismatch",
      "--fail-on-skipped",
      "--fail-on-empty-test-run",
      "--require-assertions-for-pm",
      "--check-context",
      "--auto-pm-context",
    );
    const testAllOptions = lastCallArg<Record<string, unknown>>(vi.mocked(runTestAll) as never, 0);
    expect(testAllOptions.offset).toBe("1");
    expect(testAllOptions.timeout).toBe("30");
    expect(testAllOptions.progress).toBe(true);
    expect(testAllOptions.envSet).toEqual(["K=V"]);
    expect(testAllOptions.envClear).toEqual(["NOPE"]);
    expect(testAllOptions.sharedHostSafe).toBe(true);
    expect(testAllOptions.pmContext).toBe("schema");
    expect(testAllOptions.overrideLinkedPmContext).toBe(true);
    expect(testAllOptions.failOnContextMismatch).toBe(true);
    expect(testAllOptions.failOnSkipped).toBe(true);
    expect(testAllOptions.failOnEmptyTestRun).toBe(true);
    expect(testAllOptions.requireAssertionsForPm).toBe(true);
    expect(testAllOptions.checkContext).toBe(true);
    expect(testAllOptions.autoPmContext).toBe(true);

    await runCli("stats", "--metadata-coverage", "--by-assignee", "--by-tag", "--by-priority", "--tag-prefix", "area:");
    const statsOptions = lastCallArg<Record<string, unknown>>(vi.mocked(runStats) as never, 1);
    expect(statsOptions.metadataCoverage).toBe(true);
    expect(statsOptions.byAssignee).toBe(true);
    expect(statsOptions.byTag).toBe(true);
    expect(statsOptions.byPriority).toBe(true);
    expect(statsOptions.tagPrefix).toBe("area:");

    await runCli(
      "health",
      "--strict-directories",
      "--check-only",
      "--check-telemetry",
      "--no-refresh",
      "--refresh-vectors",
      "--verbose-stale-items",
      "--brief",
      "--summary",
      "--skip-vectors",
      "--skip-integrity",
      "--skip-drift",
      "--full",
      "--fail-on-warn",
    );
    const healthOptions = lastCallArg<Record<string, unknown>>(vi.mocked(runHealth) as never, 1);
    expect(healthOptions.strictDirectories).toBe(true);
    expect(healthOptions.checkOnly).toBe(true);
    expect(healthOptions.checkTelemetry).toBe(true);
    expect(healthOptions.noRefresh).toBe(false);
    expect(healthOptions.refreshVectors).toBe(true);
    expect(healthOptions.verboseStaleItems).toBe(true);
    expect(healthOptions.brief).toBe(true);
    expect(healthOptions.summary).toBe(true);
    expect(healthOptions.skipVectors).toBe(true);
    expect(healthOptions.skipIntegrity).toBe(true);
    expect(healthOptions.skipDrift).toBe(true);
    expect(healthOptions.full).toBe(true);

    await runCli(
      "validate",
      "--check-resolution",
      "--check-lifecycle",
      "--check-stale-blockers",
      "--dependency-cycle-severity",
      "error",
      "--parent-cycle-severity",
      "error",
      "--check-files",
      "--check-command-references",
      "--scan-mode",
      "tracked-all",
      "--include-pm-internals",
      "--verbose-file-lists",
      "--verbose-diagnostics",
      "--all-affected-ids",
      "--strict-exit",
      "--fix-hints",
      "--auto-fix",
      "--dry-run",
      "--fix-scope",
      "metadata",
      "--fix-scope",
      "lifecycle",
      "--prune-missing",
      "--check-history-drift",
    );
    const validateOptions = lastCallArg<Record<string, unknown>>(vi.mocked(runValidate) as never, 0);
    expect(validateOptions.checkResolution).toBe(true);
    expect(validateOptions.checkLifecycle).toBe(true);
    expect(validateOptions.checkStaleBlockers).toBe(true);
    expect(validateOptions.dependencyCycleSeverity).toBe("error");
    expect(validateOptions.parentCycleSeverity).toBe("error");
    expect(validateOptions.checkFiles).toBe(true);
    expect(validateOptions.checkCommandReferences).toBe(true);
    expect(validateOptions.scanMode).toBe("tracked-all");
    expect(validateOptions.includePmInternals).toBe(true);
    expect(validateOptions.verboseFileLists).toBe(true);
    expect(validateOptions.verboseDiagnostics).toBe(true);
    expect(validateOptions.allAffectedIds).toBe(true);
    expect(validateOptions.fixHints).toBe(true);
    expect(validateOptions.autoFix).toBe(true);
    expect(validateOptions.dryRun).toBe(true);
    expect(validateOptions.fixScope).toEqual(["metadata", "lifecycle"]);
    expect(validateOptions.pruneMissing).toBe(true);
    expect(validateOptions.checkHistoryDrift).toBe(true);

    await runCli("contracts", "--action", "create", "--schema-only", "--availability-only", "--runtime-only", "--full");
    const contractsOptions = lastCallArg<Record<string, unknown>>(vi.mocked(runContracts) as never, 0);
    expect(contractsOptions.action).toBe("create");
    expect(contractsOptions.schemaOnly).toBe(true);
    expect(contractsOptions.availabilityOnly).toBe(true);
    expect(contractsOptions.runtimeOnly).toBe(true);
    expect(contractsOptions.full).toBe(true);
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

  it("maps focus set/show/clear option surfaces", async () => {
    await runCli("focus", "pm-1");
    expect(vi.mocked(runFocus)).toHaveBeenCalledWith("pm-1", { clear: false }, expect.anything());

    await runCli("focus");
    expect(lastCallArg<string | undefined>(vi.mocked(runFocus) as never, 0)).toBeUndefined();

    await runCli("focus", "--clear");
    expect(lastCallArg<Record<string, unknown>>(vi.mocked(runFocus) as never, 1).clear).toBe(true);
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
    await expect(runCli("schema", "list-statuses")).rejects.toThrow("Unknown pm schema subcommand");
    await expect(runCli("schema", "help")).rejects.toThrow("Unknown pm schema subcommand");

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

    await runCliRaw(
      "schema",
      "add-field",
      "severity_level",
      "--type",
      "string",
      "--commands",
      "create,update",
      "--cli-flag",
      "--sev",
      "--alias",
      "severity",
      "--required",
      "--required-on-create",
      "--no-allow-unset",
      "--required-types",
      "Bug,Story",
    );
    expect(vi.mocked(runSchemaAddField)).toHaveBeenCalledWith(
      "severity_level",
      expect.objectContaining({
        type: "string",
        commands: ["create", "update"],
        cliFlag: "--sev",
        alias: ["severity"],
        required: true,
        requiredOnCreate: true,
        allowUnset: false,
        requiredTypes: ["Bug", "Story"],
      }),
      expect.anything(),
    );
    expect(vi.mocked(formatSchemaAddFieldHuman)).toHaveBeenCalledTimes(1);

    // add-field with neither --type nor --cli-flag exercises the optional-flag fallbacks.
    await runCliRaw("schema", "add-field", "owner");
    expect(vi.mocked(runSchemaAddField)).toHaveBeenLastCalledWith(
      "owner",
      expect.objectContaining({ type: undefined, cliFlag: undefined, allowUnset: true }),
      expect.anything(),
    );

    await runCliRaw("schema", "list-fields");
    expect(vi.mocked(runSchemaListFields)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(formatSchemaListFieldsHuman)).toHaveBeenCalledTimes(1);

    await runCliRaw("schema", "show-field", "severity_level");
    expect(vi.mocked(runSchemaShowField)).toHaveBeenCalledWith("severity_level", expect.anything());
    expect(vi.mocked(formatSchemaShowFieldHuman)).toHaveBeenCalledTimes(1);

    await runCliRaw("schema", "remove-field", "severity_level", "--force");
    expect(vi.mocked(runSchemaRemoveField)).toHaveBeenCalledWith(
      "severity_level",
      { author: undefined, force: true },
      expect.anything(),
    );
    expect(vi.mocked(formatSchemaRemoveFieldHuman)).toHaveBeenCalledTimes(1);

    await runCliRaw("schema", "apply-preset", "agile");
    expect(vi.mocked(runSchemaApplyPreset)).toHaveBeenCalledWith(
      "agile",
      { author: undefined, force: false },
      expect.anything(),
    );
    expect(vi.mocked(formatSchemaApplyPresetHuman)).toHaveBeenCalledTimes(1);

    await runCliRaw("schema", "add-type", "--infer", "--min-count", "5", "--apply");
    expect(vi.mocked(runSchemaInferTypes)).toHaveBeenCalledWith(
      expect.objectContaining({ minCount: 5, apply: true }),
      expect.anything(),
    );
    expect(vi.mocked(formatSchemaInferTypesHuman)).toHaveBeenCalledTimes(1);

    // Bare --infer exercises the apply-false / minCount-undefined fallbacks.
    await runCliRaw("schema", "add-type", "--infer");
    expect(vi.mocked(runSchemaInferTypes)).toHaveBeenLastCalledWith(
      expect.objectContaining({ apply: false, minCount: undefined }),
      expect.anything(),
    );
  });

  it("routes profile subcommands, human/JSON rendering, apply warnings, and usage errors", async () => {
    await expect(runCli("profile")).rejects.toThrow("pm profile requires a subcommand");
    await expect(runCli("profile", "frobnicate")).rejects.toThrow("Unknown pm profile subcommand");

    // Human render path for each subcommand.
    await runCliRaw("profile", "list");
    expect(vi.mocked(runProfileList)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(formatProfileListHuman)).toHaveBeenCalledTimes(1);

    await runCliRaw("profile", "show", "agile");
    expect(vi.mocked(runProfileShow)).toHaveBeenCalledWith("agile");
    expect(vi.mocked(formatProfileShowHuman)).toHaveBeenCalledTimes(1);

    await runCliRaw("profile", "lint", "agile");
    expect(vi.mocked(runProfileLint)).toHaveBeenCalledWith("agile");
    expect(vi.mocked(formatProfileLintHuman)).toHaveBeenCalledTimes(1);
    // A clean lint (ok=true) leaves the success exit code untouched.
    expect(process.exitCode === undefined || process.exitCode === 0).toBe(true);

    // A lint with error findings fails the command for CI gating.
    vi.mocked(runProfileLint).mockReturnValueOnce({
      action: "lint",
      ok: false,
      findings: [{ severity: "error", code: "config_key_unknown", dimension: "config", message: "bad" }],
      warnings: [],
    } as never);
    await runCliRaw("profile", "lint", "broken");
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;

    await runCliRaw("profile", "apply", "agile", "--dry-run", "--author", "tester", "--force");
    expect(vi.mocked(runProfileApply)).toHaveBeenCalledWith(
      "agile",
      { dryRun: true, author: "tester", force: true },
      expect.anything(),
    );
    expect(vi.mocked(formatProfileApplyHuman)).toHaveBeenCalledTimes(1);

    // Apply that surfaces on-write hook warnings exercises the warnings branch.
    vi.mocked(runProfileApply).mockResolvedValueOnce({ action: "apply", warnings: ["hook:warn"] } as never);
    await runCliRaw("profile", "apply", "ops");

    // JSON output path and the --quiet/--profile (timing, no render) path.
    await runCliRaw("--json", "profile", "list");
    await runCli("profile", "apply", "research");
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

    // --edit/--delete are coerced to numbers and forwarded; both are mutations that refresh.
    await runCli("comments", "pm-1", "--edit", "2", "fixed text");
    const editArgs = lastCallArg<Record<string, unknown>>(vi.mocked(runComments) as never, 1);
    expect(editArgs.edit).toBe(2);
    expect(editArgs.add).toBe("fixed text");
    await runCli("comments", "pm-1", "--delete", "1");
    expect(lastCallArg<Record<string, unknown>>(vi.mocked(runComments) as never, 1).delete).toBe(1);
    expect(invalidateSearchCachesForMutation).toHaveBeenCalledTimes(3);

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

  it("routes docs mutations and close fallback fields", async () => {
    await runCli("close", "pm-1", "done via positional");
    const closeOptions = lastCallArg<Record<string, unknown>>(vi.mocked(runClose) as never, 2);
    expect(closeOptions.expectedResult).toBeUndefined();
    expect(closeOptions.actualResult).toBeUndefined();

    await runCli(
      "docs",
      "pm-1",
      "--add",
      "path=docs/a.md",
      "--add-glob",
      "pattern=docs/**/*.md",
      "--remove",
      "path=docs/old.md",
      "--migrate",
      "from=docs,to=guides",
      "--note",
      "batch docs migration",
    );
    const docsOptions = lastCallArg<Record<string, unknown>>(vi.mocked(runDocs) as never, 1);
    expect(docsOptions.add).toEqual(["path=docs/a.md"]);
    expect(docsOptions.addGlob).toEqual(["pattern=docs/**/*.md"]);
    expect(docsOptions.remove).toEqual(["path=docs/old.md"]);
    expect(docsOptions.migrate).toEqual(["from=docs,to=guides"]);
    expect(docsOptions.note).toBe("batch docs migration");

    await runCli("schema", "list");
    expect(vi.mocked(runSchemaList)).toHaveBeenCalledTimes(1);
    expect(invalidateSearchCachesForMutation).toHaveBeenCalledTimes(2);
  });

  it("registers required and repeatable-aliased commander option contracts", () => {
    const command = new Command("demo").exitOverride().configureOutput({ writeOut: () => {}, writeErr: () => {} });
    registerCommanderOptionContracts(command, [
      {
        target: "must",
        keys: ["must"],
        option: "--must <value>",
        description: "A required option",
        required: true,
      },
      {
        target: "tag",
        keys: ["tag"],
        option: "--tag <value>",
        description: "Repeatable with a semantically distinct alias",
        repeatable: true,
        aliasOptions: [{ target: "label", keys: ["label"], option: "--label <value>", description: "Alias for --tag" }],
      },
    ] as never);
    const optionFlags = command.options.map((option) => option.flags);
    expect(optionFlags).toContain("--must <value>");
    expect(optionFlags).toContain("--tag <value>");
    expect(optionFlags).toContain("--label <value>");
    command.parse(["node", "demo", "--must", "present", "--label", "B", "--tag", "A"]);
    expect(command.opts()).toMatchObject({ tag: ["B", "A"], label: ["B", "A"] });
    command.parse(["node", "demo", "--must", "present", "--tag", "next"]);
    expect(command.opts().tag).toEqual(["next"]);
  });

  it("handles create with no positionals and with both a positional and a --title flag", async () => {
    // No positional title/type: the positional-resolution else branches are taken.
    await runCli("create", "--title", "Flag title", "--type", "Task");
    let normalized = lastCallArg<Record<string, unknown>>(vi.mocked(runCreate) as never, 0);
    expect(normalized.title).toBe("Flag title");

    // A positional title plus an explicit --title: the --title flag wins (title already set).
    await runCli("create", "task", "Positional title", "--title", "Flag wins");
    normalized = lastCallArg<Record<string, unknown>>(vi.mocked(runCreate) as never, 0);
    expect(normalized.title).toBe("Flag wins");
    expect(normalized.type).toBe("task");

    // A single positional plus explicit --title should treat the positional as
    // type (pm-8sr3), not as a discarded title.
    await runCli("create", "feature", "--title", "Flag title");
    normalized = lastCallArg<Record<string, unknown>>(vi.mocked(runCreate) as never, 0);
    expect(normalized.title).toBe("Flag title");
    expect(normalized.type).toBe("feature");
  });

  it("suggests list alternatives for a plan ls/list subcommand", async () => {
    await expect(runCli("plan", "ls")).rejects.toThrow("Unknown pm plan subcommand");
    await runCliRaw("plan", "show", "pm-1");
    expect(vi.mocked(runPlan)).toHaveBeenCalled();
  });

  it("parses the schema --order option from numbers, numeric strings, and rejects non-integers", () => {
    expect(parseSchemaOrderOption(undefined)).toBeUndefined();
    expect(parseSchemaOrderOption(null)).toBeUndefined();
    expect(parseSchemaOrderOption(7)).toBe(7);
    expect(() => parseSchemaOrderOption(2.5)).toThrow("--order must be a finite integer");
    expect(parseSchemaOrderOption("   ")).toBeUndefined();
    expect(parseSchemaOrderOption("9")).toBe(9);
    expect(() => parseSchemaOrderOption("abc")).toThrow("--order must be a finite integer");
    // A non-number, non-string value (e.g. boolean) reaches the trailing throw.
    expect(() => parseSchemaOrderOption(true)).toThrow("--order must be a finite integer");
  });

  it("classifies schema shorthand tokens that look like subcommand typos", () => {
    expect(looksLikeSchemaSubcommandTypo("")).toBe(false);
    expect(looksLikeSchemaSubcommandTypo("   ")).toBe(false);
    expect(looksLikeSchemaSubcommandTypo("Spike")).toBe(false);
    expect(looksLikeSchemaSubcommandTypo("help")).toBe(true);
    expect(looksLikeSchemaSubcommandTypo("types")).toBe(true);
    expect(looksLikeSchemaSubcommandTypo("list-statuses")).toBe(true);
    expect(looksLikeSchemaSubcommandTypo("show-all")).toBe(true);
  });

  it("coerces a positive 1-based integer option and rejects non-positive/non-integer values", () => {
    const parse = parsePositiveIntOption("--edit");
    expect(parse("1")).toBe(1);
    expect(parse("42")).toBe(42);
    expect(() => parse("0")).toThrow("--edit must be a positive integer (1-based index).");
    expect(() => parse("-3")).toThrow("--edit must be a positive integer (1-based index).");
    expect(() => parse("2.5")).toThrow("--edit must be a positive integer (1-based index).");
    expect(() => parse("abc")).toThrow("--edit must be a positive integer (1-based index).");
  });

  it("resolves --body-file content for create and update and rejects --body + --body-file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pm-register-bodyfile-"));
    try {
      const bodyPath = path.join(dir, "body.md");
      await writeFile(bodyPath, "# From file\n\nLong body.", "utf8");

      await runCli("create", "task", "Titled", "--body-file", bodyPath);
      const createNormalized = lastCallArg<Record<string, unknown>>(vi.mocked(runCreate) as never, 0);
      expect(createNormalized.body).toBe("# From file\n\nLong body.");

      await runCli("update", "pm-1", "--body-file", bodyPath);
      const updateOptions = lastCallArg<Record<string, unknown>>(vi.mocked(runUpdate) as never, 1);
      expect(updateOptions.body).toBe("# From file\n\nLong body.");

      // --body + --body-file are mutually exclusive on both create and update.
      await expect(runCli("create", "task", "X", "--body", "inline", "--body-file", bodyPath)).rejects.toThrow(
        "mutually exclusive",
      );
      await expect(runCli("update", "pm-1", "--body", "inline", "--body-file", bodyPath)).rejects.toThrow(
        "mutually exclusive",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("forwards copy/delete/append/restore author and message option values", async () => {
    await runCli("copy", "pm-1", "--title", "Cloned", "--author", "agent", "--message", "cloned it");
    expect(vi.mocked(runCopy)).toHaveBeenCalledWith(
      "pm-1",
      { title: "Cloned", author: "agent", message: "cloned it" },
      expect.anything(),
    );

    await runCli("delete", "pm-1", "--author", "agent", "--message", "removing");
    const deleteOptions = lastCallArg<Record<string, unknown>>(vi.mocked(runDelete) as never, 1);
    expect(deleteOptions).toMatchObject({ author: "agent", message: "removing" });

    await runCli("append", "pm-1", "--text", "appended via alias", "--author", "agent", "--message", "note");
    const appendOptions = lastCallArg<Record<string, unknown>>(vi.mocked(runAppend) as never, 1);
    expect(appendOptions).toMatchObject({ body: "appended via alias", author: "agent", message: "note" });

    await runCli("append", "pm-1", "--body", "via body flag");
    expect(lastCallArg<Record<string, unknown>>(vi.mocked(runAppend) as never, 1).body).toBe("via body flag");

    await runCli("restore", "pm-1", "3", "--author", "agent", "--message", "rollback");
    expect(vi.mocked(runRestore)).toHaveBeenCalledWith(
      "pm-1",
      "3",
      { author: "agent", message: "rollback", force: false },
      expect.anything(),
    );
  });

  it("maps the full update-many and close-many filter/mutation surfaces", async () => {
    await runCli(
      "update-many",
      "--filter-status", "open",
      "--filter-type", "Task",
      "--filter-tag", "infra",
      "--filter-priority", "1",
      "--filter-deadline-before", "2026-12-31",
      "--filter-deadline-after", "2026-01-01",
      "--filter-updated-after", "2026-01-01",
      "--filter-updated-before", "2026-12-31",
      "--filter-created-after", "2026-01-01",
      "--filter-created-before", "2026-12-31",
      "--filter-assignee", "alice",
      "--filter-assignee-filter", "assigned",
      "--filter-parent", "pm-epic",
      "--filter-sprint", "s1",
      "--filter-release", "r1",
      "--ids", "pm-1,pm-2",
      "--limit", "10",
      "--offset", "2",
      "--filter-ac-missing",
      "--filter-estimate-missing",
      "--filter-resolution-missing",
      "--filter-metadata-missing",
      "--rollback", "ckpt-1",
      "--no-checkpoint",
      "--title", "Bulk",
    );
    const umRequest = lastCallArg<Record<string, unknown>>(vi.mocked(runUpdateMany) as never, 0);
    const umList = umRequest.list as Record<string, unknown>;
    expect(umRequest.status).toBe("open");
    expect(umList).toMatchObject({
      type: "Task",
      tag: "infra",
      priority: "1",
      deadlineBefore: "2026-12-31",
      deadlineAfter: "2026-01-01",
      updatedAfter: "2026-01-01",
      updatedBefore: "2026-12-31",
      createdAfter: "2026-01-01",
      createdBefore: "2026-12-31",
      assignee: "alice",
      assigneeFilter: "assigned",
      parent: "pm-epic",
      sprint: "s1",
      release: "r1",
      ids: "pm-1,pm-2",
      limit: "10",
      offset: "2",
      filterAcMissing: true,
      filterEstimatesMissing: true,
      filterResolutionMissing: true,
      filterMetadataMissing: true,
    });
    expect(umRequest.rollback).toBe("ckpt-1");
    expect(umRequest.checkpoint).toBe(false);

    await runCli(
      "close-many",
      "--filter-status", "open",
      "--filter-type", "Task",
      "--filter-tag", "infra",
      "--filter-priority", "1",
      "--filter-deadline-before", "2026-12-31",
      "--filter-deadline-after", "2026-01-01",
      "--filter-updated-after", "2026-01-01",
      "--filter-updated-before", "2026-12-31",
      "--filter-created-after", "2026-01-01",
      "--filter-created-before", "2026-12-31",
      "--filter-assignee", "alice",
      "--filter-assignee-filter", "assigned",
      "--filter-parent", "pm-epic",
      "--filter-sprint", "s1",
      "--filter-release", "r1",
      "--ids", "pm-1,pm-2",
      "--limit", "10",
      "--offset", "2",
      "--reason", "cleanup",
      "--resolution", "fixed",
      "--expected-result", "pass",
      "--actual-result", "passed",
      "--validate-close", "strict",
      "--author", "agent",
      "--message", "bulk close",
      "--rollback", "ckpt-2",
      "--no-checkpoint",
    );
    const cmRequest = lastCallArg<Record<string, unknown>>(vi.mocked(runCloseMany) as never, 0);
    const cmList = cmRequest.list as Record<string, unknown>;
    expect(cmRequest.status).toBe("open");
    expect(cmList).toMatchObject({
      type: "Task",
      tag: "infra",
      priority: "1",
      deadlineBefore: "2026-12-31",
      deadlineAfter: "2026-01-01",
      updatedAfter: "2026-01-01",
      updatedBefore: "2026-12-31",
      createdAfter: "2026-01-01",
      createdBefore: "2026-12-31",
      assignee: "alice",
      assigneeFilter: "assigned",
      parent: "pm-epic",
      sprint: "s1",
      release: "r1",
      ids: "pm-1,pm-2",
      limit: "10",
      offset: "2",
    });
    expect(cmRequest).toMatchObject({
      reason: "cleanup",
      resolution: "fixed",
      expectedResult: "pass",
      actualResult: "passed",
      validateClose: "strict",
      author: "agent",
      message: "bulk close",
      rollback: "ckpt-2",
      checkpoint: false,
    });
  });

  it("maps every bulk content + governance filter flag to its selector field (true branch)", async () => {
    // Presence + governance-missing flags through update-many's selector builder.
    await runCli(
      "update-many",
      "--filter-has-notes",
      "--filter-has-learnings",
      "--filter-has-files",
      "--filter-has-docs",
      "--filter-has-tests",
      "--filter-has-comments",
      "--filter-has-deps",
      "--filter-has-body",
      "--filter-has-linked-command",
      "--filter-reviewer-missing",
      "--filter-risk-missing",
      "--filter-confidence-missing",
      "--filter-sprint-missing",
      "--filter-release-missing",
      "--title", "Bulk",
    );
    const presenceList = lastCallArg<Record<string, unknown>>(vi.mocked(runUpdateMany) as never, 0).list as Record<
      string,
      unknown
    >;
    expect(presenceList).toMatchObject({
      hasNotes: true,
      hasLearnings: true,
      hasFiles: true,
      hasDocs: true,
      hasTests: true,
      hasComments: true,
      hasDeps: true,
      hasBody: true,
      hasLinkedCommand: true,
      filterReviewerMissing: true,
      filterRiskMissing: true,
      filterConfidenceMissing: true,
      filterSprintMissing: true,
      filterReleaseMissing: true,
    });

    // Absence flags + empty-body through close-many's selector builder.
    await runCli(
      "close-many",
      "--filter-no-notes",
      "--filter-no-learnings",
      "--filter-no-files",
      "--filter-no-docs",
      "--filter-no-tests",
      "--filter-no-comments",
      "--filter-no-deps",
      "--filter-empty-body",
      "--filter-no-linked-command",
      "--reason", "cleanup",
    );
    const absenceList = lastCallArg<Record<string, unknown>>(vi.mocked(runCloseMany) as never, 0).list as Record<
      string,
      unknown
    >;
    expect(absenceList).toMatchObject({
      noNotes: true,
      noLearnings: true,
      noFiles: true,
      noDocs: true,
      noTests: true,
      noComments: true,
      noDeps: true,
      emptyBody: true,
      noLinkedCommand: true,
    });
  });

  it("rejects a both-present-and-absent bulk content filter with the --filter-* flag names", async () => {
    // The conflict is caught in mapBulkContentAndGovernanceFilters so the message
    // names the bulk flags the user typed (not the downstream --has-/--no- flags),
    // and runUpdateMany is never reached.
    await expect(
      runCli("update-many", "--filter-has-notes", "--filter-no-notes", "--title", "X"),
    ).rejects.toThrow("Cannot combine --filter-has-notes with --filter-no-notes for the same field.");
    expect(vi.mocked(runUpdateMany)).not.toHaveBeenCalled();
  });

  it("maps the full close option surface including duplicate-of and validate string mode", async () => {
    await runCli(
      "close", "pm-1", "shipped it",
      "--author", "agent",
      "--message", "closing",
      "--validate-close", "strict",
      "--duplicate-of", "pm-canonical",
      "--resolution", "fixed",
      "--expected-result", "pass",
      "--actual-result", "passed",
    );
    const closeOptions = lastCallArg<Record<string, unknown>>(vi.mocked(runClose) as never, 2);
    expect(closeOptions).toMatchObject({
      author: "agent",
      message: "closing",
      validateClose: "strict",
      duplicateOf: "pm-canonical",
      resolution: "fixed",
      expectedResult: "pass",
      actualResult: "passed",
    });
  });

  it("maps full history-redact/compact options and resolves close reason from --close-reason", async () => {
    await runCli(
      "history-redact", "pm-1",
      "--literal", "secret",
      "--regex", "/token/gi",
      "--replacement", "[x]",
      "--author", "agent",
      "--message", "redacting",
      "--force",
    );
    expect(vi.mocked(runHistoryRedact)).toHaveBeenCalledWith(
      "pm-1",
      expect.objectContaining({ replacement: "[x]", author: "agent", message: "redacting", force: true }),
      expect.anything(),
    );

    await runCli(
      "history-compact", "pm-1",
      "--before", "12",
      "--author", "agent",
      "--message", "compacting",
      "--force",
    );
    expect(vi.mocked(runHistoryCompact)).toHaveBeenCalledWith(
      "pm-1",
      expect.objectContaining({ before: "12", author: "agent", message: "compacting", force: true }),
      expect.anything(),
    );

    // --close-reason alias supplies the close reason when no positional/--reason is present.
    await runCli("close", "pm-1", "--close-reason", "closed via alias");
    expect(vi.mocked(runClose)).toHaveBeenLastCalledWith(
      "pm-1",
      "closed via alias",
      expect.anything(),
      expect.anything(),
    );
  });

  it("covers remaining close/close-many/history/files-discover option arms", async () => {
    // close --validate-close with no value coerces to "warn".
    await runCli("close", "pm-1", "done", "--validate-close");
    expect(lastCallArg<Record<string, unknown>>(vi.mocked(runClose) as never, 2).validateClose).toBe("warn");

    // close-many with --dry-run and no reason.
    await runCli("close-many", "--filter-status", "open", "--dry-run");
    const cm = lastCallArg<Record<string, unknown>>(vi.mocked(runCloseMany) as never, 0);
    expect(cm.dryRun).toBe(true);
    expect(cm.reason).toBeUndefined();

    // history-redact with no --literal/--regex leaves them undefined.
    await runCli("history-redact", "pm-1", "--replacement", "[x]");
    const redact = lastCallArg<Record<string, unknown>>(vi.mocked(runHistoryRedact) as never, 1);
    expect(redact.literal).toBeUndefined();
    expect(redact.regex).toBeUndefined();

    // history-repair single-target with --author.
    await runCli("history-repair", "pm-1", "--author", "agent");
    expect(lastCallArg<Record<string, unknown>>(vi.mocked(runHistoryRepair) as never, 1).author).toBe("agent");

    // history-repair --all where no streams failed leaves the exit code clean.
    vi.mocked(runHistoryRepairAll).mockResolvedValueOnce({ totals: { failed: 0 } } as never);
    await runCli("history-repair", "--all");
    expect(process.exitCode).toBeUndefined();

    // history-compact with no author/message.
    await runCli("history-compact", "pm-1", "--before", "3");
    const compact = lastCallArg<Record<string, unknown>>(vi.mocked(runHistoryCompact) as never, 1);
    expect(compact.author).toBeUndefined();

    // files discover with --author/--message merged from the parent command opts.
    await runCli("files", "discover", "pm-1", "--apply", "--author", "agent", "--message", "discovered");
    const discover = lastCallArg<Record<string, unknown>>(vi.mocked(runFilesDiscover) as never, 1);
    expect(discover).toMatchObject({ apply: true, author: "agent", message: "discovered" });

    // update-many with no --filter-status leaves status undefined.
    await runCli("update-many", "--filter-tag", "infra", "--title", "Z");
    expect(lastCallArg<Record<string, unknown>>(vi.mocked(runUpdateMany) as never, 0).status).toBeUndefined();

    // history-compact with no --before leaves before undefined.
    await runCli("history-compact", "pm-1", "--force");
    expect(lastCallArg<Record<string, unknown>>(vi.mocked(runHistoryCompact) as never, 1).before).toBeUndefined();

    // An unknown plan subcommand that is not list/ls carries no did-you-mean examples.
    await expect(runCli("plan", "frobnicate")).rejects.toThrow("Unknown pm plan subcommand");
  });

  it("routes history-compact bulk selectors and validates their inputs", async () => {
    vi.mocked(runHistoryCompactBulk).mockResolvedValue({ totals: { items_errored: 0 } } as never);

    // --ids → bulk mode with a parsed id list (no positional id).
    await runCli("history-compact", "--ids", "pm-1,pm-2", "--dry-run");
    expect(vi.mocked(assertHistoryCompactTarget)).toHaveBeenLastCalledWith(undefined, {
      ids: ["pm-1", "pm-2"],
      allOver: undefined,
      scope: undefined,
    });
    expect(lastCallArg<Record<string, unknown>>(vi.mocked(runHistoryCompactBulk) as never, 0)).toMatchObject({
      ids: ["pm-1", "pm-2"],
      dryRun: true,
    });

    // --all-over + --all-streams + --min-entries map to numbers / scope, and
    // --message/--author flow through to the bulk runner.
    await runCli(
      "history-compact",
      "--all-over", "50",
      "--all-streams",
      "--min-entries", "4",
      "--author", "agent",
      "--message", "bulk sweep",
    );
    expect(lastCallArg<Record<string, unknown>>(vi.mocked(runHistoryCompactBulk) as never, 0)).toMatchObject({
      allOver: 50,
      scope: "all-streams",
      minEntries: 4,
      author: "agent",
      message: "bulk sweep",
    });

    // --closed maps to scope "closed", and items_errored > 0 propagates a failure exit code.
    vi.mocked(runHistoryCompactBulk).mockResolvedValueOnce({ totals: { items_errored: 2 } } as never);
    await runCli("history-compact", "--closed");
    expect(lastCallArg<Record<string, unknown>>(vi.mocked(runHistoryCompactBulk) as never, 0).scope).toBe("closed");
    expect(process.exitCode).toBe(EXIT_CODE.GENERIC_FAILURE);
    process.exitCode = undefined;

    // --closed + --all-streams are mutually exclusive.
    await expect(runCli("history-compact", "--closed", "--all-streams")).rejects.toThrow(/mutually exclusive/);

    // --before is rejected in bulk mode.
    await expect(runCli("history-compact", "--all-streams", "--before", "5")).rejects.toThrow(
      /--before applies only in single-id mode/,
    );

    // --all-over / --min-entries reject negative, non-numeric, and truncating-float inputs.
    await expect(runCli("history-compact", "--all-over", "-3")).rejects.toThrow(/--all-over/);
    await expect(runCli("history-compact", "--all-over", "notanumber")).rejects.toThrow(/--all-over/);
    await expect(runCli("history-compact", "--all-over", "3.5")).rejects.toThrow(/--all-over/);
    await expect(runCli("history-compact", "--min-entries", "-1")).rejects.toThrow(/--min-entries/);
    await expect(runCli("history-compact", "--min-entries", "10abc")).rejects.toThrow(/--min-entries/);
  });

  it("maps full schema add-status/add-type options and string-form alias/role inputs", async () => {
    await runCliRaw(
      "schema", "add-status", "review",
      "--role", "active",
      "--alias", "in_review",
      "--description", "Code review",
      "--order", "5",
      "--author", "agent",
      "--force",
    );
    expect(vi.mocked(runSchemaAddStatus)).toHaveBeenCalledWith(
      "review",
      expect.objectContaining({
        role: ["active"],
        alias: ["in_review"],
        description: "Code review",
        order: 5,
        author: "agent",
        force: true,
      }),
      expect.anything(),
    );

    await runCliRaw(
      "schema", "add-status", "blocked",
      "--role", "active",
      "--role", "blocked",
      "--alias", "waiting",
      "--alias", "hold",
    );
    expect(vi.mocked(runSchemaAddStatus)).toHaveBeenLastCalledWith(
      "blocked",
      expect.objectContaining({
        role: ["active", "blocked"],
        alias: ["waiting", "hold"],
      }),
      expect.anything(),
    );

    // --default-status (kebab) provides defaultStatus as a direct string.
    await runCliRaw("schema", "add-type", "Spike", "--description", "Investigation", "--folder", "spikes", "--default-status", "open", "--author", "agent");
    expect(vi.mocked(runSchemaAddType)).toHaveBeenCalledWith(
      "Spike",
      expect.objectContaining({ description: "Investigation", folder: "spikes", defaultStatus: "open", author: "agent" }),
      expect.anything(),
    );

    // add-type with neither --description nor --folder leaves both undefined.
    await runCliRaw("schema", "add-type", "Bare");
    const bareAddType = lastCallArg<Record<string, unknown>>(vi.mocked(runSchemaAddType) as never, 1);
    expect(bareAddType.description).toBeUndefined();
    expect(bareAddType.folder).toBeUndefined();
  });

  it("preserves defensive string coercion for programmatic schema alias and role options", async () => {
    const program = buildProgram();
    const schemaCommand = program.commands.find((candidate) => candidate.name() === "schema");
    if (!schemaCommand) {
      throw new Error("schema command was not registered");
    }
    schemaCommand.setOptionValue("alias", "in_review");
    schemaCommand.setOptionValue("role", "active");

    await schemaCommand.parseAsync(["add-status", "review"], { from: "user" });

    expect(vi.mocked(runSchemaAddStatus)).toHaveBeenLastCalledWith(
      "review",
      expect.objectContaining({
        alias: ["in_review"],
        role: ["active"],
      }),
      expect.anything(),
    );
  });

  it("rejects read-like unknown schema subcommands instead of add-type shorthand mutation (GH-293)", async () => {
    for (const token of ["list-types", "list-statuses", "show-all", "show-statuses"]) {
      await expect(runCliRaw("schema", token)).rejects.toThrow(`Unknown pm schema subcommand "${token}"`);
    }
    expect(vi.mocked(runSchemaAddType)).not.toHaveBeenCalledWith(
      expect.stringMatching(/^(list-types|list-statuses|show-all|show-statuses)$/),
      expect.anything(),
      expect.anything(),
    );
  });

  it("maps full comments/notes/learnings/files/docs option surfaces", async () => {
    await runCli(
      "comments", "pm-1",
      "--add", "looks good",
      "--limit", "5",
      "--author", "agent",
      "--message", "review",
      "--allow-audit-comment",
      "--force",
    );
    const commentsOptions = lastCallArg<Record<string, unknown>>(vi.mocked(runComments) as never, 1);
    expect(commentsOptions).toMatchObject({
      add: "looks good",
      limit: "5",
      author: "agent",
      message: "review",
      allowAuditComment: true,
      force: true,
    });

    await runCli("comments", "pm-1", "--file", "/tmp/comment.md");
    expect(lastCallArg<Record<string, unknown>>(vi.mocked(runComments) as never, 1).file).toBe("/tmp/comment.md");

    await runCli("notes", "pm-1", "--add", "noted", "--limit", "3", "--author", "agent", "--message", "m");
    expect(lastCallArg<Record<string, unknown>>(vi.mocked(runNotes) as never, 1)).toMatchObject({
      add: "noted",
      limit: "3",
      author: "agent",
      message: "m",
    });

    await runCli("learnings", "pm-1", "--add", "learned", "--limit", "2", "--author", "agent", "--message", "m");
    expect(lastCallArg<Record<string, unknown>>(vi.mocked(runLearnings) as never, 1)).toMatchObject({
      add: "learned",
      limit: "2",
      author: "agent",
      message: "m",
    });

    await runCli(
      "files", "pm-1",
      "--add", "path=src/a.ts",
      "--add-glob", "pattern=src/**/*.ts",
      "--remove", "path=src/old.ts",
      "--migrate", "from=src,to=lib",
      "--note", "linking",
      "--append-stable",
      "--audit",
      "--author", "agent",
      "--message", "files",
      "--force",
    );
    const filesOptions = lastCallArg<Record<string, unknown>>(vi.mocked(runFiles) as never, 1);
    expect(filesOptions).toMatchObject({
      add: ["path=src/a.ts"],
      addGlob: ["pattern=src/**/*.ts"],
      remove: ["path=src/old.ts"],
      migrate: ["from=src,to=lib"],
      note: "linking",
      appendStable: true,
      audit: true,
      author: "agent",
      message: "files",
      force: true,
    });

    await runCli(
      "docs", "pm-1",
      "--note", "doc note",
      "--audit",
      "--author", "agent",
      "--message", "docs",
      "--force",
    );
    const docsOptions = lastCallArg<Record<string, unknown>>(vi.mocked(runDocs) as never, 1);
    expect(docsOptions).toMatchObject({ note: "doc note", audit: true, author: "agent", message: "docs", force: true });

    await runCli("deps", "pm-1", "--collapse", "repeated", "--max-depth", "3");
    expect(lastCallArg<Record<string, unknown>>(vi.mocked(runDeps) as never, 1)).toMatchObject({
      collapse: "repeated",
      maxDepth: "3",
    });
  });

  it("runs every mutation command without --profile and skips refresh for read-only listings", async () => {
    // runCliRaw omits --profile so each handler's profiling guard takes its
    // else branch; read-only invocations (no --add/--remove) also exercise the
    // search-cache skip branches.
    await runCliRaw("create", "task", "No profile");
    await runCliRaw("copy", "pm-1");
    await runCliRaw("focus", "pm-1");
    await runCliRaw("update", "pm-1", "--title", "X");
    await runCliRaw("update-many", "--filter-status", "open", "--title", "Y");
    await runCliRaw("close", "pm-1", "done");
    await runCliRaw("close-many", "--filter-status", "open", "--reason", "done");
    await runCliRaw("delete", "pm-1", "--force");
    await runCliRaw("append", "pm-1", "text");
    await runCliRaw("restore", "pm-1", "2");
    await runCliRaw("history-redact", "pm-1", "--literal", "x");
    await runCliRaw("history-repair", "pm-1");
    await runCliRaw("history-compact", "pm-1", "--before", "2");

    // Read-only annotation listings (no --add) skip search-cache invalidation.
    await runCliRaw("comments", "pm-1");
    await runCliRaw("notes", "pm-1");
    await runCliRaw("learnings", "pm-1");
    // Read-only file/doc listings (no add/remove/migrate) skip invalidation.
    await runCliRaw("files", "pm-1", "--list");
    await runCliRaw("docs", "pm-1", "--list");
    await runCliRaw("deps", "pm-1");

    // history-redact with no change and files discover with no change skip invalidation.
    vi.mocked(runHistoryRedact).mockResolvedValueOnce({ id: "pm-1", changed: false, dry_run: false } as never);
    await runCliRaw("history-redact", "pm-1", "--literal", "y");
    vi.mocked(runFilesDiscover).mockResolvedValueOnce({ id: "pm-1", changed: false } as never);
    await runCliRaw("files", "discover", "pm-1");

    expect(vi.mocked(runCreate)).toHaveBeenCalled();
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

  it("forwards every typed config flag through to runConfig", async () => {
    await runCli(
      "config",
      "set",
      "context",
      "--format",
      "toon",
      "--policy",
      "warn",
      "--value",
      "ollama",
      "--clear-criteria",
      "--default-depth",
      "deep",
      "--activity-limit",
      "5",
      "--stale-threshold-days",
      "30",
      "--section-hierarchy",
      "true",
      "--section-activity",
      "false",
      "--section-progress",
      "true",
      "--section-blockers",
      "false",
      "--section-files",
      "true",
      "--section-workload",
      "false",
      "--section-staleness",
      "true",
      "--section-tests",
      "false",
    );
    const options = lastCallArg<Record<string, unknown>>(vi.mocked(runConfig) as never, 3);
    expect(options).toMatchObject({
      format: "toon",
      policy: "warn",
      value: "ollama",
      clearCriteria: true,
      defaultDepth: "deep",
      activityLimit: "5",
      staleThresholdDays: "30",
      sectionHierarchy: "true",
      sectionActivity: "false",
      sectionProgress: "true",
      sectionBlockers: "false",
      sectionFiles: "true",
      sectionWorkload: "false",
      sectionStaleness: "true",
      sectionTests: "false",
    });
  });

  it("forwards all init setup options through to runInit", async () => {
    await runCli(
      "init",
      "demo",
      "--preset",
      "strict",
      "--author",
      "agent",
      "--agent-guidance",
      "add",
      "--type-preset",
      "agile",
      "--with-packages",
      "--force",
      "--workspace",
      "./workspace",
    );
    expect(vi.mocked(runInit)).toHaveBeenLastCalledWith(
      "demo",
      expect.anything(),
      expect.objectContaining({
        preset: "strict",
        author: "agent",
        agentGuidance: "add",
        typePreset: "agile",
        withPackages: true,
        force: true,
        workspace: "./workspace",
      }),
    );
  });

  it("emits the full init tree for --json and skips profiling without --profile", async () => {
    await runCliRaw("init", "--json");
    expect(vi.mocked(summarizeInitResult)).not.toHaveBeenCalled();
    expect(vi.mocked(runInit)).toHaveBeenCalledTimes(1);
  });

  it("skips profiling for config without --profile", async () => {
    await runCliRaw("config", "list");
    expect(vi.mocked(runConfig)).toHaveBeenCalledTimes(1);
  });

  it("skips profiling for extension and upgrade commands without --profile", async () => {
    await runCliRaw("extension", "--explore");
    expect(vi.mocked(runExtension)).toHaveBeenCalledTimes(1);

    vi.mocked(runUpgrade).mockResolvedValue({ ok: true } as never);
    await runCliRaw("upgrade");
    expect(process.exitCode).toBeUndefined();
    expect(vi.mocked(runUpgrade)).toHaveBeenCalledTimes(1);
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

    await runCli("package", "describe");
    expect(lastCallArg(vi.mocked(runExtension) as never, 0)).toBeUndefined();
    normalized = lastCallArg<Record<string, unknown>>(vi.mocked(runExtension) as never, 1);
    expect(normalized.describe).toBe(true);
    expect(normalized.vocabulary).toBe("package");

    await runCli("extension", "describe", "my-ext");
    expect(lastCallArg(vi.mocked(runExtension) as never, 0)).toBe("my-ext");
    normalized = lastCallArg<Record<string, unknown>>(vi.mocked(runExtension) as never, 1);
    expect(normalized.describe).toBe(true);
  });

  it("renders describe output as Markdown to stdout or a file when --markdown is set", async () => {
    const emptySurfaces = {
      capabilities: [],
      commands: ["pm-x ping"],
      command_overrides: [],
      command_handlers: [],
      hooks: [],
      flag_commands: [],
      item_types: [],
      item_fields: [],
      migrations: [],
      profiles: [],
      importers: [],
      exporters: [],
      search_providers: [],
      vector_store_adapters: [],
      parser_overrides: [],
      service_overrides: [],
      renderer_overrides: [],
      preflight_overrides: 0,
    };
    vi.mocked(runExtension).mockResolvedValue({
      action: "describe",
      warnings: ["pm-x failed to load on the global layer"],
      details: {
        target: "pm-x",
        total: 1,
        extensions: [{ name: "pm-x", layer: "project", version: "1.0.0", activation_status: "ok", surfaces: emptySurfaces }],
        union: emptySurfaces,
      },
    } as never);
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    let written: string;
    let warned: string;
    try {
      await runCliRaw("package", "describe", "pm-x", "--markdown");
      // Capture before mockRestore(), which clears the recorded call history.
      written = stdout.mock.calls.map((call) => String(call[0])).join("");
      warned = stderr.mock.calls.map((call) => String(call[0])).join("");
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
    expect(written).toContain("# Package surface reference");
    expect(written).toContain("## pm-x (project v1.0.0, loaded)");
    expect(written).toContain("- `pm-x ping`");
    // Exactly one trailing newline (no extra blank line at EOF).
    expect(written.endsWith("\n")).toBe(true);
    expect(written.endsWith("\n\n")).toBe(false);
    // Warnings are surfaced to stderr rather than swallowed in markdown mode.
    expect(warned).toContain("warning: pm-x failed to load on the global layer");

    // --quiet still resolves to the describe action (no throw) but suppresses stdout.
    const quietStdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    let quietWrites: number;
    try {
      await runCli("package", "describe", "pm-x", "--markdown");
      quietWrites = quietStdout.mock.calls.length;
    } finally {
      quietStdout.mockRestore();
    }
    expect(quietWrites).toBe(0);

    const outputDir = await mkdtemp(path.join(tmpdir(), "pm-describe-markdown-output-"));
    const outputPath = path.join(outputDir, "docs", "pm-x-reference.md");
    const outputStdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      await runCli("package", "describe", "pm-x", "--markdown", "--output", outputPath);
      const fileMarkdown = await readFile(outputPath, "utf8");
      expect(fileMarkdown).toContain("# Package surface reference");
      expect(fileMarkdown).toContain("## pm-x (project v1.0.0, loaded)");
      expect(fileMarkdown).toContain("- `pm-x ping`");
      expect(outputStdout.mock.calls.length).toBe(0);
      outputStdout.mockClear();
      const outputStderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      try {
        await runCliRaw("package", "describe", "pm-x", "--markdown", "--output", path.join(outputDir, "pm-x-visible.md"));
        expect(outputStdout.mock.calls.length).toBe(0);
        expect(outputStderr.mock.calls.map((call) => String(call[0])).join("")).toContain(
          "warning: pm-x failed to load on the global layer",
        );
      } finally {
        outputStderr.mockRestore();
      }
    } finally {
      outputStdout.mockRestore();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("rejects --markdown combined with --json", async () => {
    await expect(runCliRaw("package", "describe", "--markdown", "--json")).rejects.toThrow(
      "Cannot combine --json with --markdown",
    );
  });

  it("rejects --markdown for a non-describe action", async () => {
    // The guard runs before runExtension: --manage sets normalizedOptions.describe
    // to false, so the dispatch rejects --markdown without performing any action
    // (the mock's resolved action is irrelevant here).
    await expect(runCliRaw("package", "--manage", "--markdown")).rejects.toThrow(
      "--markdown is only supported by the describe action",
    );
  });

  it("rejects --output without markdown or a non-empty path", async () => {
    vi.mocked(runExtension).mockClear();
    await expect(runCliRaw("package", "describe", "pm-x", "--output", "docs/pm-x.md")).rejects.toThrow(
      "--output is only supported with --markdown describe output",
    );
    expect(vi.mocked(runExtension)).not.toHaveBeenCalled();

    await expect(runCliRaw("package", "describe", "pm-x", "--markdown", "--output", "   ")).rejects.toThrow(
      "--output requires a non-empty file path",
    );
    expect(vi.mocked(runExtension)).not.toHaveBeenCalled();
  });

  it("routes adopt/adopt-all/activate/deactivate lifecycle subcommands", async () => {
    await runCli("extension", "adopt", "ext-managed", "--github", "owner/repo", "--ref", "main");
    expect(lastCallArg(vi.mocked(runExtension) as never, 0)).toBe("ext-managed");
    let normalized = lastCallArg<Record<string, unknown>>(vi.mocked(runExtension) as never, 1);
    expect(normalized).toMatchObject({
      adopt: true,
      github: "owner/repo",
      ref: "main",
      vocabulary: "extension",
    });

    await runCli("extension", "adopt-all");
    expect(lastCallArg(vi.mocked(runExtension) as never, 0)).toBeUndefined();
    normalized = lastCallArg<Record<string, unknown>>(vi.mocked(runExtension) as never, 1);
    expect(normalized).toMatchObject({
      adoptAll: true,
      vocabulary: "extension",
    });

    await runCli("extension", "activate", "ext-managed");
    expect(lastCallArg(vi.mocked(runExtension) as never, 0)).toBe("ext-managed");
    normalized = lastCallArg<Record<string, unknown>>(vi.mocked(runExtension) as never, 1);
    expect(normalized).toMatchObject({
      activate: true,
      vocabulary: "extension",
    });

    await runCli("package", "deactivate", "pkg-managed", "--global");
    expect(lastCallArg(vi.mocked(runExtension) as never, 0)).toBe("pkg-managed");
    normalized = lastCallArg<Record<string, unknown>>(vi.mocked(runExtension) as never, 1);
    expect(normalized).toMatchObject({
      deactivate: true,
      global: true,
      vocabulary: "package",
    });
  });

  it("routes uninstall/manage/reload/catalog lifecycle subcommands", async () => {
    await runCli("extension", "uninstall", "ext-managed", "--global");
    expect(lastCallArg(vi.mocked(runExtension) as never, 0)).toBe("ext-managed");
    let normalized = lastCallArg<Record<string, unknown>>(vi.mocked(runExtension) as never, 1);
    expect(normalized).toMatchObject({ uninstall: true, global: true, vocabulary: "extension" });

    await runCli("package", "manage", "--runtime-probe", "--fix-managed-state");
    normalized = lastCallArg<Record<string, unknown>>(vi.mocked(runExtension) as never, 1);
    expect(normalized).toMatchObject({
      manage: true,
      runtimeProbe: true,
      fixManagedState: true,
      vocabulary: "package",
    });

    await runCli("extension", "reload", "--watch");
    normalized = lastCallArg<Record<string, unknown>>(vi.mocked(runExtension) as never, 1);
    expect(normalized).toMatchObject({ reload: true, watch: true, vocabulary: "extension" });

    await runCli("package", "catalog", "--fields", "alias,installed");
    normalized = lastCallArg<Record<string, unknown>>(vi.mocked(runExtension) as never, 1);
    expect(normalized).toMatchObject({
      catalog: true,
      fields: "alias,installed",
      vocabulary: "package",
    });
  });

  it("supports package install with no explicit target", async () => {
    await runCli("package", "install", "--project");
    expect(lastCallArg(vi.mocked(runExtension) as never, 0)).toBeUndefined();
    const normalized = lastCallArg<Record<string, unknown>>(vi.mocked(runExtension) as never, 1);
    expect(normalized).toMatchObject({
      install: true,
      project: true,
      vocabulary: "package",
    });
  });

  it("installs multiple explicit package targets while preserving shell-expanded wildcard recovery", async () => {
    await runCli("install", "pkg-a", "pkg-b");
    expect(vi.mocked(runExtension).mock.calls.map((call) => call[0])).toEqual(["pkg-a", "pkg-b"]);
    expect(lastCallArg<Record<string, unknown>>(vi.mocked(runExtension) as never, 1)).toMatchObject({
      install: true,
      vocabulary: "package",
    });

    vi.mocked(runExtension).mockClear();

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

  it("continues multi-target install after target failures and marks the aggregate failed", async () => {
    vi.mocked(runExtension)
      .mockResolvedValueOnce({
        ok: true,
        action: "install",
        details: { extension: { name: "pkg-a" }, destination_path: "/tmp/pkg-a" },
        warnings: ["warn:a", "warn:shared"],
      } as never)
      .mockResolvedValueOnce({
        ok: true,
        action: "install",
        details: { extension: { name: "pkg-b" }, destination_path: "/tmp/pkg-b" },
        warnings: ["warn:shared"],
      } as never)
      .mockResolvedValueOnce({
        ok: true,
        action: "install",
      } as never)
      .mockResolvedValueOnce({
        ok: false,
        action: "install",
        details: {
          extension: { name: "pkg-soft" },
          activated: false,
          runtime_activation_status: "failed",
          activation_diagnostics: { failed_count: 1 },
          command_discovery: { extension_name: "pkg-soft" },
          verification: { status: "degraded" },
        },
      } as never)
      .mockRejectedValueOnce(
        new PmCliError("registry unavailable", EXIT_CODE.NOT_FOUND, {
          code: "npm_package_not_found",
          required: "Use an install source that exists.",
          why: "Registry 404s need deterministic recovery.",
          examples: ["pm install npm:pkg-c"],
          nextSteps: ["Check the package name."],
          recovery: { next_best_command: "pm install npm:pkg-c" },
        }),
      )
      .mockRejectedValueOnce(new PmCliError("local source missing", EXIT_CODE.NOT_FOUND))
      .mockRejectedValueOnce(new Error("plain error failure"))
      .mockRejectedValueOnce("string failure");

    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    let written: string;
    try {
      await runCliRaw("--json", "install", "pkg-a", "pkg-b", "pkg-empty", "pkg-soft", "pkg-c", "pkg-d", "pkg-e", "pkg-f", "--global");
      written = stdout.mock.calls.map((call) => String(call[0])).join("");
    } finally {
      stdout.mockRestore();
    }
    expect(vi.mocked(runExtension).mock.calls.map((call) => call[0])).toEqual([
      "pkg-a",
      "pkg-b",
      "pkg-empty",
      "pkg-soft",
      "pkg-c",
      "pkg-d",
      "pkg-e",
      "pkg-f",
    ]);
    expect(lastCallArg<Record<string, unknown>>(vi.mocked(runExtension) as never, 1)).toMatchObject({
      install: true,
      global: true,
      vocabulary: "package",
    });
    expect(JSON.parse(written) as unknown).toMatchObject({
      ok: false,
      action: "install",
      scope: "global",
      installed_count: 3,
      failed_count: 5,
      warnings: ["warn:a", "warn:shared"],
      targets: [
        { target: "pkg-a", ok: true, destination_path: "/tmp/pkg-a", warnings: ["warn:a", "warn:shared"] },
        { target: "pkg-b", ok: true, warnings: ["warn:shared"] },
        { target: "pkg-empty", ok: true, warnings: [] },
        {
          target: "pkg-soft",
          ok: false,
          extension: { name: "pkg-soft" },
          activated: false,
          runtime_activation_status: "failed",
          activation_diagnostics: { failed_count: 1 },
          command_discovery: { extension_name: "pkg-soft" },
          verification: { status: "degraded" },
          warnings: [],
          error: {
            message: "Extension install returned ok=false without throwing an error.",
            exit_code: EXIT_CODE.GENERIC_FAILURE,
            code: "extension_install_soft_failed",
          },
        },
        {
          target: "pkg-c",
          ok: false,
          error: {
            message: "registry unavailable",
            exit_code: EXIT_CODE.NOT_FOUND,
            code: "npm_package_not_found",
            required: "Use an install source that exists.",
            why: "Registry 404s need deterministic recovery.",
            examples: ["pm install npm:pkg-c"],
            nextSteps: ["Check the package name."],
            recovery: { next_best_command: "pm install npm:pkg-c" },
          },
        },
        {
          target: "pkg-d",
          ok: false,
          error: {
            message: "local source missing",
            exit_code: EXIT_CODE.NOT_FOUND,
          },
        },
        {
          target: "pkg-e",
          ok: false,
          error: {
            message: "plain error failure",
            exit_code: EXIT_CODE.GENERIC_FAILURE,
          },
        },
        {
          target: "pkg-f",
          ok: false,
          error: {
            message: "string failure",
            exit_code: EXIT_CODE.GENERIC_FAILURE,
          },
        },
      ],
    });
    expect(process.exitCode).toBe(EXIT_CODE.NOT_FOUND);
  });

  it("rejects multi-target install with forced GitHub sources before dispatch", async () => {
    vi.mocked(runExtension).mockClear();
    await expect(runCliRaw("install", "pkg-a", "pkg-b", "--github", "owner/repo")).rejects.toMatchObject<PmCliError>({
      exitCode: EXIT_CODE.USAGE,
      context: expect.objectContaining({
        code: "multi_target_github_install_ambiguous",
        examples: expect.arrayContaining(["pm install --gh owner/repo"]),
      }),
    });
    await expect(runCliRaw("install", "pkg-a", "pkg-b", "--gh", "owner/repo")).rejects.toMatchObject<PmCliError>({
      exitCode: EXIT_CODE.USAGE,
      context: expect.objectContaining({
        code: "multi_target_github_install_ambiguous",
        examples: expect.arrayContaining(["pm install --gh owner/repo"]),
      }),
    });
    expect(vi.mocked(runExtension)).not.toHaveBeenCalled();
  });

  it("escalates doctor warnings and failed upgrades through exit codes", async () => {
    vi.mocked(runExtension).mockResolvedValue({
      ok: false,
      action: "install",
      details: {},
      warnings: [],
    } as never);
    await runCli("extension", "--install", "broken-package");
    expect(process.exitCode).toBe(EXIT_CODE.GENERIC_FAILURE);
    process.exitCode = undefined;

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

    vi.mocked(runExtension).mockResolvedValue({
      action: "doctor",
      details: { summary: { status: "ok" } },
      warnings: ["advisory"],
    } as never);
    await runCli("extension", "--doctor", "--strict-exit");
    expect(process.exitCode).toBe(EXIT_CODE.GENERIC_FAILURE);
    process.exitCode = undefined;

    vi.mocked(runExtension).mockResolvedValue({
      action: "doctor",
      details: "not-an-object",
      warnings: [],
    } as never);
    await runCli("extension", "--doctor", "--strict-exit");
    expect(process.exitCode).toBeUndefined();

    vi.mocked(runUpgrade).mockResolvedValue({ ok: false } as never);
    await runCli("upgrade", "--dry-run", "--cli-only");
    expect(lastCallArg<Record<string, unknown>>(vi.mocked(runUpgrade) as never, 1).dryRun).toBe(true);
    expect(process.exitCode).toBe(EXIT_CODE.GENERIC_FAILURE);
  });
});
