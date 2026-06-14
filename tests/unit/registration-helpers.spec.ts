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
} from "../../src/cli/migration-gates.js";
import {
  _testOnly,
  applyDefaultOutputFormat,
  buildBackgroundTestAllCommandArgs,
  buildBackgroundTestCommandArgs,
  collect,
  extractUpdateManyMutationOptionSource,
  getGlobalOptions,
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
} from "../../src/cli/registration-helpers.js";
import { readSettings, writeSettings } from "../../src/core/store/settings.js";
import { EXIT_CODE } from "../../src/core/shared/constants.js";
import { PmCliError } from "../../src/core/shared/errors.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

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
    await withTempPmPath(async (context) => {
      const settings = await readSettings(context.pmPath);
      settings.output.default_format = "json";
      await writeSettings(context.pmPath, settings, "test:output-default");

      await expect(applyDefaultOutputFormat({ json: true, quiet: false, path: context.pmPath })).resolves.toEqual({
        json: true,
        quiet: false,
        path: context.pmPath,
      });
      await expect(applyDefaultOutputFormat({ quiet: false, path: context.pmPath })).resolves.toMatchObject({
        defaultOutputFormat: "json",
      });
    });

    const emptyRoot = await mkdtemp(path.join(tmpdir(), "pm-empty-settings-"));
    try {
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
