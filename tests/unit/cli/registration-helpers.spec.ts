import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import {
  collectMandatoryMigrationBlockers,
  decideWriteGate,
  enforceItemFormatWriteGateAndPreflightMigration,
  enforceMandatoryMigrationWriteGate,
  resolveMigrationId,
  resolveNormalizedMigrationStatus,
} from "../../../src/cli/migration-gates.js";
import {
  _testOnly,
  applyDefaultOutputFormat,
  buildBackgroundTestAllCommandArgs,
  buildBackgroundTestCommandArgs,
  collect,
  extractUpdateManyMutationOptionSource,
  getCommandPath,
  getGlobalOptions,
  invalidateSearchCachesForMutation,
  normalizeActivityOptions,
  normalizeAggregateOptions,
  normalizeContextOptions,
  normalizeCreateOptions,
  normalizeListOptions,
  normalizeSearchOptions,
  normalizeSearchKeywordsInput,
  normalizeUpdateOptions,
  printActivityJsonStream,
  printListJsonStream,
  resolveActivityStreamMode,
  clearResolvedGlobalOptions,
  setResolvedGlobalOptions,
} from "../../../src/cli/registration-helpers.js";
import { readSettings, writeSettings } from "../../../src/core/store/settings.js";
import { EXIT_CODE } from "../../../src/core/shared/constants.js";
import { PmCliError } from "../../../src/core/shared/errors.js";

describe("registration helpers", () => {
  it("falls back to opts() for command-like objects without optsWithGlobals", () => {
    const command = { opts: () => ({ json: true, quiet: true, path: ".pm" }) } as unknown as Command;

    expect(getGlobalOptions(command)).toEqual({
      json: true,
      quiet: true,
      noChangedFields: false,
      path: ".pm",
      noExtensions: false,
      noPager: false,
      profile: false,
      idOnly: false,
    });
  });

  it("reads globals through optsWithGlobals and defaults a non-command input to empty options", () => {
    const command = {
      optsWithGlobals: () => ({
        pmPath: "/explicit/pm",
        changedFields: false,
        idOnly: true,
        extensions: false,
        noPager: true,
        profile: true,
      }),
    } as unknown as Command;
    expect(getGlobalOptions(command)).toEqual({
      json: undefined,
      quiet: false,
      noChangedFields: true,
      idOnly: true,
      path: "/explicit/pm",
      noExtensions: true,
      noPager: true,
      profile: true,
    });

    // A primitive (non-object) command yields an empty options reader so every option resolves to its default.
    expect(getGlobalOptions("not-a-command" as unknown as Command)).toEqual({
      json: undefined,
      quiet: false,
      noChangedFields: false,
      idOnly: false,
      path: undefined,
      noExtensions: false,
      noPager: false,
      profile: false,
    });
  });

  it("builds a space-joined command path from the commander parent chain", () => {
    const program = new Command("pm");
    const parent = program.command("schema");
    const child = parent.command("add-type");
    expect(getCommandPath(child)).toBe("schema add-type");
    // A root command with no parent yields an empty path.
    expect(getCommandPath(program)).toBe("");
  });

  it("prefers explicit resolved globals over command option fallbacks", () => {
    const command = new Command("demo");
    setResolvedGlobalOptions(command, {
      json: true,
      quiet: true,
      path: ".agents/pm",
      noExtensions: true,
      noPager: true,
      profile: true,
    });

    expect(getGlobalOptions(command)).toEqual({
      json: true,
      quiet: true,
      path: ".agents/pm",
      noExtensions: true,
      noPager: true,
      profile: true,
    });

    clearResolvedGlobalOptions(command);
    expect(getGlobalOptions(command)).toMatchObject({
      json: undefined,
      quiet: false,
      path: undefined,
    });
  });

  it("builds background test command arguments from valid option values only", () => {
    expect(
      buildBackgroundTestCommandArgs("pm-123", {
        add: ["pnpm test", "", 42],
        addJson: ["{\"command\":\"pnpm typecheck\"}"],
        remove: ["old"],
        match: " unit ",
        onlyIndex: 2,
        onlyLast: true,
        timeout: "120",
        envSet: ["A=1"],
        envClear: ["OLD"],
        sharedHostSafe: true,
        pmContext: "pm-w13j",
        overrideLinkedPmContext: true,
        failOnContextMismatch: true,
        failOnSkipped: true,
        failOnEmptyTestRun: true,
        requireAssertionsForPm: true,
        checkContext: true,
        autoPmContext: true,
        author: "agent",
        message: "coverage",
        force: true,
      }),
    ).toEqual([
      "test",
      "pm-123",
      "--run",
      "--json",
      "--progress",
      "--add",
      "pnpm test",
      "--add-json",
      "{\"command\":\"pnpm typecheck\"}",
      "--remove",
      "old",
      "--match",
      "unit",
      "--only-last",
      "--timeout",
      "120",
      "--env-set",
      "A=1",
      "--env-clear",
      "OLD",
      "--shared-host-safe",
      "--pm-context",
      "pm-w13j",
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
      "coverage",
      "--force",
    ]);
  });

  it("builds background test-all command arguments without item-only controls", () => {
    expect(
      buildBackgroundTestAllCommandArgs({
        status: "open",
        limit: "5",
        offset: "1",
        timeout: "30",
        envSet: ["A=1"],
        envClear: ["B"],
        sharedHostSafe: true,
        pmContext: "pm-w13j",
        overrideLinkedPmContext: true,
        failOnContextMismatch: true,
        failOnSkipped: true,
        failOnEmptyTestRun: true,
        requireAssertionsForPm: true,
        checkContext: true,
        autoPmContext: true,
      }),
    ).toEqual([
      "test-all",
      "--json",
      "--progress",
      "--status",
      "open",
      "--limit",
      "5",
      "--offset",
      "1",
      "--timeout",
      "30",
      "--env-set",
      "A=1",
      "--env-clear",
      "B",
      "--shared-host-safe",
      "--pm-context",
      "pm-w13j",
      "--override-linked-pm-context",
      "--fail-on-context-mismatch",
      "--fail-on-skipped",
      "--fail-on-empty-test-run",
      "--require-assertions-for-pm",
      "--check-context",
      "--auto-pm-context",
    ]);
  });

  it("collects repeatable option values in-place for Commander callbacks", () => {
    const existing = ["first"];
    expect(collect("second", existing)).toBe(existing);
    expect(existing).toEqual(["first", "second"]);
    expect(collect("only", undefined)).toEqual(["only"]);
  });

  it("normalizes create and update options from camel and underscore aliases", () => {
    expect(() => normalizeCreateOptions({ title: "Missing type" })).toThrow(PmCliError);
    try {
      normalizeCreateOptions({ title: "Missing type" });
    } catch (error) {
      expect(error).toMatchObject({ exitCode: EXIT_CODE.USAGE });
    }

    const create = normalizeCreateOptions(
      {
        title: "Title",
        description: "Description",
        type: "Task",
        addTags: ["coverage"],
        allowMissingParent: true,
        clearDocs: true,
        customRuntimeField: "kept",
      },
      { requireType: false },
    );
    expect(create).toMatchObject({
      title: "Title",
      description: "Description",
      type: "Task",
      addTags: ["coverage"],
      allowMissingParent: true,
      clearDocs: true,
      customRuntimeField: "kept",
    });

    const update = normalizeUpdateOptions({
      addTags: ["tests"],
      depRemove: ["pm-old"],
      allow_audit_update: true,
      allow_audit_dep_update: true,
      replaceTests: true,
      clearEvents: true,
      extra: "kept",
    });
    expect(update).toMatchObject({
      addTags: ["tests"],
      depRemove: ["pm-old"],
      allowAuditUpdate: true,
      allowAuditDepUpdate: true,
      replaceTests: true,
      clearEvents: true,
      extra: "kept",
    });
  });

  it("emits profiled search refresh warnings for mutation invalidation", async () => {
    const cacheModule = await import("../../../src/core/search/cache.js");
    const backgroundRefreshModule = await import("../../../src/core/search/background-refresh.js");
    const refreshSpy = vi
      .spyOn(cacheModule, "refreshSearchArtifactsForMutation")
      .mockResolvedValueOnce({ warnings: ["refresh_warning"] } as never);
    const foregroundSpy = vi.spyOn(backgroundRefreshModule, "shouldRunSearchRefreshInForeground").mockReturnValueOnce(false);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await invalidateSearchCachesForMutation({ profile: true, path: undefined } as never, { id: "pm-123" });
      expect(stderrSpy.mock.calls.map((call) => String(call[0])).join("")).toContain("profile:search_refresh_warnings=");
    } finally {
      stderrSpy.mockRestore();
      foregroundSpy.mockRestore();
      refreshSpy.mockRestore();
    }
  });

  it("skips optional value flags whose trimmed value is empty", () => {
    // A whitespace-only --match value trims to empty, so the flag is dropped.
    expect(
      buildBackgroundTestCommandArgs("pm-1", { match: "   " }),
    ).toEqual(["test", "pm-1", "--run", "--json", "--progress"]);
  });

  it("leaves create and update clear/boolean flags undefined when absent", () => {
    const create = normalizeCreateOptions({ type: "Task" });
    expect(create).toMatchObject({
      allowMissingParent: false,
      clearDeps: undefined,
      clearComments: undefined,
      clearNotes: undefined,
      clearLearnings: undefined,
      clearFiles: undefined,
      clearTests: undefined,
      clearDocs: undefined,
      clearReminders: undefined,
      clearEvents: undefined,
      clearTypeOptions: undefined,
    });

    const update = normalizeUpdateOptions({});
    expect(update).toMatchObject({
      force: false,
      allowAuditUpdate: undefined,
      allowAuditDepUpdate: undefined,
      replaceDeps: undefined,
      replaceTests: undefined,
      clearDeps: undefined,
      clearEvents: undefined,
      clearTypeOptions: undefined,
    });
  });

  it("leaves list and aggregate boolean filters undefined when their flags are absent", () => {
    const list = normalizeListOptions({});
    expect(list).toMatchObject({
      includeBody: undefined,
      compact: undefined,
      brief: undefined,
      full: undefined,
      tree: undefined,
      noTruncate: undefined,
      filterAcMissing: undefined,
      filterEstimatesMissing: undefined,
      filterResolutionMissing: undefined,
      filterMetadataMissing: undefined,
    });

    const aggregate = normalizeAggregateOptions({});
    expect(aggregate).toMatchObject({
      groupBy: undefined,
      count: undefined,
      completion: undefined,
      sum: undefined,
      avg: undefined,
      includeUnparented: false,
      status: undefined,
    });
  });

  it("sets every create and update clear/boolean flag when all are enabled", () => {
    const create = normalizeCreateOptions({
      type: "Task",
      allowMissingParent: true,
      clearDeps: true,
      clearComments: true,
      clearNotes: true,
      clearLearnings: true,
      clearFiles: true,
      clearTests: true,
      clearDocs: true,
      clearReminders: true,
      clearEvents: true,
      clearTypeOptions: true,
    });
    expect(create).toMatchObject({
      allowMissingParent: true,
      clearDeps: true,
      clearComments: true,
      clearNotes: true,
      clearLearnings: true,
      clearFiles: true,
      clearTests: true,
      clearDocs: true,
      clearReminders: true,
      clearEvents: true,
      clearTypeOptions: true,
    });

    const update = normalizeUpdateOptions({
      force: true,
      allowAuditUpdate: true,
      allowAuditDepUpdate: true,
      replaceDeps: true,
      replaceTests: true,
      clearDeps: true,
      clearComments: true,
      clearNotes: true,
      clearLearnings: true,
      clearFiles: true,
      clearTests: true,
      clearDocs: true,
      clearReminders: true,
      clearEvents: true,
      clearTypeOptions: true,
    });
    expect(update).toMatchObject({
      force: true,
      allowAuditUpdate: true,
      allowAuditDepUpdate: true,
      replaceDeps: true,
      clearDeps: true,
      clearTypeOptions: true,
    });
  });

  it("sets every list/aggregate boolean filter when its flag is enabled", () => {
    const list = normalizeListOptions({
      brief: true,
      full: true,
      filterAcMissing: true,
      filterEstimateMissing: true,
      filterResolutionMissing: true,
      filterMetadataMissing: true,
    });
    expect(list).toMatchObject({
      brief: true,
      full: true,
      filterAcMissing: true,
      filterEstimatesMissing: true,
      filterResolutionMissing: true,
      filterMetadataMissing: true,
    });

    const aggregate = normalizeAggregateOptions({ includeUnparented: true, status: "open" });
    expect(aggregate).toMatchObject({ includeUnparented: true, status: "open" });
  });

  it("sets every search boolean filter when its flag is enabled", () => {
    const normalized = normalizeSearchOptions({
      count: true,
      includeLinked: true,
      titleExact: true,
      phraseExact: true,
    });
    expect(normalized).toMatchObject({
      count: true,
      includeLinked: true,
      titleExact: true,
      phraseExact: true,
    });

    // String-valued minScore/semanticWeight flow through readSearchStringOrNumber's string branch.
    const stringScores = normalizeSearchOptions({ minScore: "0.5", semanticWeight: "0.3" });
    expect(stringScores).toMatchObject({ minScore: "0.5", semanticWeight: "0.3" });
  });

  it("resolves activity compact mode across full/compact/default inputs", () => {
    // --full forces compact:false.
    expect(normalizeActivityOptions({ full: true }).compact).toBe(false);
    // --no-compact (compact===false) forces compact:false.
    expect(normalizeActivityOptions({ compact: false }).compact).toBe(false);
    // Neither flag: compact defaults to true.
    expect(normalizeActivityOptions({}).compact).toBe(true);
  });

  it("separates update-many mutation options from selector controls", () => {
    expect(
      extractUpdateManyMutationOptionSource({
        ids: "pm-1,pm-2",
        filterStatus: "open",
        filterAssignee_filter: "alice",
        dryRun: true,
        rollback: true,
        message: "done",
        status: "closed",
      }),
    ).toEqual({
      message: "done",
      status: "closed",
    });
  });

  it("normalizes list and aggregate filters with numeric list fallbacks", () => {
    expect(
      normalizeListOptions({
        status: "open",
        ids: "pm-1",
        priority: 1,
        includeBody: true,
        compact: true,
        tree: true,
        treeDepth: 2,
        custom: "kept",
      }),
    ).toMatchObject({
      status: "open",
      ids: "pm-1",
      priority: "1",
      includeBody: true,
      compact: true,
      tree: true,
      treeDepth: "2",
      custom: "kept",
    });

    // Commander stores --no-truncate as truncate=false; --all is the positive alias.
    expect(normalizeListOptions({ truncate: false }).noTruncate).toBe(true);
    expect(normalizeListOptions({ all: true }).noTruncate).toBe(true);
    expect(normalizeListOptions({ truncate: true }).noTruncate).toBeUndefined();

    expect(
      normalizeAggregateOptions({
        groupBy: "status",
        count: true,
        completion: true,
        sum: "estimate",
        avg: "estimate",
        include_unparented: true,
        type: "Task",
        priority: 2,
      }),
    ).toMatchObject({
      groupBy: "status",
      count: true,
      completion: true,
      sum: "estimate",
      avg: "estimate",
      includeUnparented: true,
      type: "Task",
      priority: "2",
    });
  });

  it("prints list and activity JSON streams with warnings and quiet/write-stop paths", () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write");
    stdoutSpy.mockImplementation(() => true);
    try {
      printListJsonStream(
        "list",
        {
          count: 2,
          now: "2026-06-13T00:00:00.000Z",
          filters: { status: "open" },
          warnings: ["stale"],
          items: [{ id: "pm-a" }, { id: "pm-b" }],
        } as never,
        { quiet: false },
      );
      const listLines = stdoutSpy.mock.calls.map((call) => String(call[0]).trim()).filter(Boolean).map((line) => JSON.parse(line));
      expect(listLines).toEqual([
        {
          type: "meta",
          command: "list",
          count: 2,
          now: "2026-06-13T00:00:00.000Z",
          filters: { status: "open" },
          warnings: ["stale"],
        },
        { type: "item", command: "list", item: { id: "pm-a" } },
        { type: "item", command: "list", item: { id: "pm-b" } },
        { type: "end", command: "list", count: 2 },
      ]);

      stdoutSpy.mockClear();
      printActivityJsonStream(
        {
          count: 1,
          compact: true,
          compact_activity: [{ op: "comment" }],
          activity: [{ op: "raw" }],
        } as never,
        { id: "pm-a", op: "comment", author: "agent", from: "a", to: "b", limit: "1" },
        { quiet: false },
      );
      const activityLines = stdoutSpy.mock.calls.map((call) => String(call[0]).trim()).filter(Boolean).map((line) => JSON.parse(line));
      expect(activityLines).toEqual([
        {
          type: "meta",
          command: "activity",
          count: 1,
          filters: { id: "pm-a", op: "comment", author: "agent", from: "a", to: "b", limit: "1" },
        },
        { type: "entry", command: "activity", entry: { op: "comment" } },
        { type: "end", command: "activity", count: 1 },
      ]);

      stdoutSpy.mockClear();
      printListJsonStream("list", { count: 0, now: "now", filters: {}, items: [] } as never, { quiet: true });
      printActivityJsonStream({ count: 0, activity: [] } as never, {}, { quiet: true });
      expect(stdoutSpy).not.toHaveBeenCalled();

      stdoutSpy.mockClear();
      stdoutSpy.mockImplementationOnce(() => false);
      printListJsonStream("list", { count: 1, now: "now", filters: {}, items: [{ id: "pm-a" }] } as never, {
        quiet: false,
      });
      const writeStopLines = stdoutSpy.mock.calls.map((call) => String(call[0]).trim()).filter(Boolean).map((line) => JSON.parse(line));
      expect(writeStopLines).toEqual([
        { type: "meta", command: "list", count: 1, now: "now", filters: {} },
        { type: "item", command: "list", item: { id: "pm-a" } },
        { type: "end", command: "list", count: 1 },
      ]);

      // result without warnings omits the warnings key entirely.
      stdoutSpy.mockClear();
      printListJsonStream("list", { count: 0, now: "now", filters: {}, items: [] } as never, { quiet: false });
      const noWarnMeta = JSON.parse(String(stdoutSpy.mock.calls[0]![0]));
      expect(noWarnMeta).not.toHaveProperty("warnings");

      // Activity stream without compact data falls back to result.activity.
      stdoutSpy.mockClear();
      printActivityJsonStream(
        { count: 1, compact: false, activity: [{ op: "raw" }] } as never,
        {},
        { quiet: false },
      );
      const rawActivity = stdoutSpy.mock.calls.map((call) => String(call[0]).trim()).filter(Boolean).map((line) => JSON.parse(line));
      expect(rawActivity).toContainEqual({ type: "entry", command: "activity", entry: { op: "raw" } });
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  it("stops the list stream when stdout signals a broken pipe", () => {
    // writeStdout returns false only when process.stdout.write throws EPIPE, so
    // simulate the broken pipe to exercise the early-return backpressure guards.
    const epipe = Object.assign(new Error("broken pipe"), { code: "EPIPE" });
    const stdoutSpy = vi.spyOn(process.stdout, "write");
    try {
      // Meta write succeeds, the first item write throws EPIPE: the stream stops before --end.
      stdoutSpy.mockImplementationOnce(() => true).mockImplementationOnce(() => {
        throw epipe;
      });
      printListJsonStream(
        "list",
        { count: 2, now: "now", filters: {}, items: [{ id: "pm-a" }, { id: "pm-b" }] } as never,
        { quiet: false },
      );
      expect(stdoutSpy).toHaveBeenCalledTimes(2);

      // The meta write itself throws EPIPE: nothing else is written.
      stdoutSpy.mockReset();
      stdoutSpy.mockImplementationOnce(() => {
        throw epipe;
      });
      printListJsonStream("list", { count: 1, now: "now", filters: {}, items: [{ id: "pm-a" }] } as never, {
        quiet: false,
      });
      expect(stdoutSpy).toHaveBeenCalledTimes(1);

      // Activity meta write succeeds, the entry write throws EPIPE.
      stdoutSpy.mockReset();
      stdoutSpy.mockImplementationOnce(() => true).mockImplementationOnce(() => {
        throw epipe;
      });
      printActivityJsonStream(
        { count: 2, activity: [{ op: "a" }, { op: "b" }] } as never,
        {},
        { quiet: false },
      );
      expect(stdoutSpy).toHaveBeenCalledTimes(2);

      // Activity meta write itself throws EPIPE: returns before any entries.
      stdoutSpy.mockReset();
      stdoutSpy.mockImplementationOnce(() => {
        throw epipe;
      });
      printActivityJsonStream({ count: 1, activity: [{ op: "a" }] } as never, {}, { quiet: false });
      expect(stdoutSpy).toHaveBeenCalledTimes(1);
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  it("preserves numeric semanticWeight values while normalizing search options", () => {
    const normalized = normalizeSearchOptions({
      hybrid: true,
      semanticWeight: 0.4,
    });

    expect(normalized.mode).toBe("hybrid");
    expect(normalized.semanticWeight).toBe(0.4);
  });

  it("accepts semantic_weight alias from tool-style payloads", () => {
    const normalized = normalizeSearchOptions({
      mode: "hybrid",
      semantic_weight: 0.25,
    });

    expect(normalized.mode).toBe("hybrid");
    expect(normalized.semanticWeight).toBe(0.25);
  });

  it("defaults search output to compact and leaves boolean filters undefined when absent", () => {
    // No --compact/--full/--fields, so the default-compact path sets compact and leaves full undefined.
    const normalized = normalizeSearchOptions({});
    expect(normalized).toMatchObject({
      mode: undefined,
      count: undefined,
      includeLinked: undefined,
      titleExact: undefined,
      phraseExact: undefined,
      compact: true,
      full: undefined,
    });

    // --fields suppresses default-compact; --full takes precedence over the compact default.
    const withFields = normalizeSearchOptions({ fields: "id,title" });
    expect(withFields.compact).toBeUndefined();
    const withFull = normalizeSearchOptions({ full: true });
    expect(withFull).toMatchObject({ full: true, compact: undefined });

    // semantic mode wins over hybrid/string mode; a non-finite numeric weight is dropped.
    const semantic = normalizeSearchOptions({ semantic: true, semanticWeight: Number.NaN });
    expect(semantic.mode).toBe("semantic");
    expect(semantic.semanticWeight).toBeUndefined();
  });

  it("normalizes search keywords and rejects empty search input", () => {
    expect(normalizeSearchKeywordsInput([" coverage ", "", " main.ts "])).toBe("coverage main.ts");
    expect(() => normalizeSearchKeywordsInput([" ", "\t"])).toThrow("Search query must not be empty");
  });

  it("normalizes activity stream and context option variants", () => {
    expect(resolveActivityStreamMode(true)).toBe(true);
    expect(resolveActivityStreamMode("")).toBe(true);
    expect(resolveActivityStreamMode("yes")).toBe(true);
    expect(resolveActivityStreamMode("jsonl")).toBe(true);
    expect(resolveActivityStreamMode("0")).toBe(false);
    expect(resolveActivityStreamMode("off")).toBe(false);
    expect(resolveActivityStreamMode(null)).toBe(false);
    expect(() => resolveActivityStreamMode("maybe")).toThrow("Activity --stream accepts rows|ndjson|jsonl");
    // A non-string, non-boolean value skips the string-parsing block and reaches the throw.
    expect(() => resolveActivityStreamMode(42)).toThrow("Activity --stream accepts rows|ndjson|jsonl");

    expect(
      normalizeActivityOptions({
        id: "pm-w13j",
        op: "comment",
        author: "agent",
        full: true,
      }),
    ).toEqual({
      id: "pm-w13j",
      op: "comment",
      author: "agent",
      from: undefined,
      to: undefined,
      limit: undefined,
      compact: false,
    });

    expect(
      normalizeContextOptions({
        date: "2026-06-13",
        past: true,
        section: "summary",
        activityLimit: "3",
        staleThreshold: 14,
        extra: "kept",
      }),
    ).toMatchObject({
      date: "2026-06-13",
      past: true,
      section: ["summary"],
      activityLimit: "3",
      staleThreshold: undefined,
      extra: "kept",
    });

    expect(normalizeContextOptions({ section: [" agenda ", "", "items"] })).toMatchObject({
      section: [" agenda ", "items"],
    });

    // --parent subtree scope flows through context normalization (pm-ds0m).
    expect(normalizeContextOptions({ parent: "pm-epic" })).toMatchObject({ parent: "pm-epic" });
    expect(normalizeContextOptions({}).parent).toBeUndefined();
  });

  it("applies default output format only when settings are available and JSON was not requested", async () => {
    const settingsRoot = await mkdtemp(path.join(tmpdir(), "pm-output-default-"));
    try {
      // Persist settings.json directly into the temp root so resolvePmRoot
      // treats it as an initialized tracker without spawning the CLI.
      const settings = await readSettings(settingsRoot);
      settings.output.default_format = "json";
      await writeSettings(settingsRoot, settings, "test:output-default");

      // --json short-circuits before reading settings, so the input is returned untouched.
      await expect(applyDefaultOutputFormat({ json: true, quiet: false, path: settingsRoot })).resolves.toEqual({
        json: true,
        quiet: false,
        path: settingsRoot,
      });
      // Without --json, the persisted default_format flows through onto the resolved options.
      await expect(applyDefaultOutputFormat({ quiet: false, path: settingsRoot })).resolves.toMatchObject({
        defaultOutputFormat: "json",
      });
    } finally {
      await rm(settingsRoot, { recursive: true, force: true });
    }

    const emptyRoot = await mkdtemp(path.join(tmpdir(), "pm-empty-settings-"));
    try {
      // No settings.json present, so the options are returned without a default format.
      await expect(applyDefaultOutputFormat({ quiet: false, path: emptyRoot })).resolves.toEqual({
        quiet: false,
        path: emptyRoot,
      });
    } finally {
      await rm(emptyRoot, { recursive: true, force: true });
    }
  });

  it("collects affected mutation item ids from result variants for search refresh", () => {
    expect(_testOnly.collectMutationItemIds(null)).toEqual([]);
    expect(
      _testOnly.collectMutationItemIds({
        id: " pm-b ",
        item: { id: "pm-a" },
        ids: ["pm-c", "", 42, "pm-a"],
        items: [{ id: "pm-d" }, null, { id: " " }],
      }),
    ).toEqual(["pm-a", "pm-b", "pm-c", "pm-d"]);
  });

  it("sorts mandatory migration blockers and enforces write gates with force semantics", async () => {
    expect(resolveMigrationId({}, 4)).toBe("migration-005");
    expect(resolveNormalizedMigrationStatus({ status: " PENDING " })).toBe("pending");
    expect(
      collectMandatoryMigrationBlockers([
        { layer: "project", name: "zeta", definition: { mandatory: true, id: "z", status: "pending" } },
        { layer: "global", name: "alpha", definition: { mandatory: true } },
        { layer: "project", name: "done", definition: { mandatory: true, status: "applied" } },
        { layer: "project", name: "optional", definition: { mandatory: false } },
      ]),
    ).toEqual([
      { layer: "global", name: "alpha", id: "migration-002", status: "pending" },
      { layer: "project", name: "zeta", id: "z", status: "pending" },
    ]);

    expect(decideWriteGate("list", {})).toEqual({ isMutation: false, forceCapable: false, forceRequested: false });
    expect(decideWriteGate("comments", { add: "note", force: true })).toEqual({
      isMutation: true,
      forceCapable: true,
      forceRequested: true,
    });
    expect(decideWriteGate("files", { add: [], remove: ["path=src/a.ts"] })).toMatchObject({ isMutation: true });
    expect(() =>
      enforceMandatoryMigrationWriteGate("create", {}, [{ layer: "project", name: "pkg", id: "m1", status: "pending" }]),
    ).toThrow(/does not support --force bypass/);
    expect(() =>
      enforceMandatoryMigrationWriteGate("update", { force: true }, [
        { layer: "project", name: "pkg", id: "m1", status: "pending" },
      ]),
    ).not.toThrow();

    const emptyRoot = await mkdtemp(path.join(tmpdir(), "pm-migration-gate-"));
    try {
      await expect(
        enforceItemFormatWriteGateAndPreflightMigration("list", {}, emptyRoot, {
          enforce_item_format_gate: true,
          run_preflight_item_format_sync: true,
          enforce_mandatory_migration_gate: true,
          run_extension_migrations: true,
        }),
      ).resolves.toBeUndefined();
      await expect(
        enforceItemFormatWriteGateAndPreflightMigration("update", {}, emptyRoot, {
          enforce_item_format_gate: false,
          run_preflight_item_format_sync: false,
          enforce_mandatory_migration_gate: true,
          run_extension_migrations: true,
        }),
      ).resolves.toBeUndefined();
    } finally {
      await rm(emptyRoot, { recursive: true, force: true });
    }
  });
});
