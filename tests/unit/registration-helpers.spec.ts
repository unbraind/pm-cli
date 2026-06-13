import { Command } from "commander";
import { describe, expect, it } from "vitest";
import {
  buildBackgroundTestAllCommandArgs,
  buildBackgroundTestCommandArgs,
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
  resolveActivityStreamMode,
  clearResolvedGlobalOptions,
  setResolvedGlobalOptions,
} from "../../src/cli/registration-helpers.js";
import { EXIT_CODE } from "../../src/core/shared/constants.js";
import { PmCliError } from "../../src/core/shared/errors.js";

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
    expect(resolveActivityStreamMode("jsonl")).toBe(true);
    expect(resolveActivityStreamMode("0")).toBe(false);
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
        section: [" agenda ", "", "items"],
        activityLimit: "3",
        staleThreshold: 14,
        extra: "kept",
      }),
    ).toMatchObject({
      date: "2026-06-13",
      past: true,
      section: [" agenda ", "items"],
      activityLimit: "3",
      staleThreshold: undefined,
      extra: "kept",
    });
  });
});
