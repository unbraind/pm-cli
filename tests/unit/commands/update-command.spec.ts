import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { _testOnlyUpdateCommand, runUpdate, type UpdateCommandOptions } from "../../../src/cli/commands/update.js";
import { runCreate } from "../../../src/cli/commands/create.js";
import { runGet } from "../../../src/cli/commands/get.js";
import { runDeps } from "../../../src/cli/commands/deps.js";
import { setActiveExtensionRegistrations } from "../../../src/core/extensions/index.js";
import { createEmptyExtensionRegistrationRegistry } from "../../../src/core/extensions/loader.js";
import { EXIT_CODE } from "../../../src/core/shared/constants.js";
import { PmCliError } from "../../../src/core/shared/errors.js";
import { withTempPmPath, type TempPmContext } from "../../helpers/withTempPmPath.js";

afterEach(() => {
  setActiveExtensionRegistrations(null);
  vi.restoreAllMocks();
});

describe("update command helper coverage", () => {
  it("normalizes legacy none tokens into explicit clears", () => {
    const normalized = _testOnlyUpdateCommand.normalizeLegacyNoneUpdateOptions({
      rank: "none",
      dep: ["null"],
      test: ["none"],
      replaceDeps: true,
      replaceTests: true,
    } as UpdateCommandOptions);

    expect(normalized.unset).toContain("order");
    expect(normalized.dep).toBeUndefined();
    expect(normalized.test).toBeUndefined();
    expect(normalized.clearDeps).toBe(true);
    expect(normalized.clearTests).toBe(true);
    expect(normalized.replaceDeps).toBe(false);
    expect(normalized.replaceTests).toBe(false);

    expect(() =>
      _testOnlyUpdateCommand.normalizeLegacyNoneUpdateOptions({ dep: ["none", "id=pm-1,kind=related"] } as UpdateCommandOptions),
    ).toThrow(expect.objectContaining({ exitCode: EXIT_CODE.USAGE }));

    const duplicateUnset = _testOnlyUpdateCommand.normalizeLegacyNoneUpdateOptions({
      unset: ["order"],
      rank: "none",
      template: "ignored",
    } as UpdateCommandOptions);
    expect(duplicateUnset.unset).toEqual(["order"]);

    // Non-legacy scalar strings should short-circuit without adding unset targets.
    const nonLegacyScalar = _testOnlyUpdateCommand.normalizeLegacyNoneUpdateOptions({
      tags: "alpha,beta",
    } as UpdateCommandOptions);
    expect(nonLegacyScalar.unset).toBeUndefined();
    expect(nonLegacyScalar.tags).toBe("alpha,beta");
  });

  it("falls back to the option key when canonical unset lookup is undefined", () => {
    const originalMapGet = Map.prototype.get;
    const mapGetSpy = vi.spyOn(Map.prototype, "get").mockImplementation(function (
      this: Map<unknown, unknown>,
      key: unknown,
    ) {
      const resolved = originalMapGet.call(this, key);
      if (key === "tags" && resolved === "tags") {
        return undefined;
      }
      return resolved;
    });
    try {
      const normalized = _testOnlyUpdateCommand.normalizeLegacyNoneUpdateOptions({
        tags: "none",
      } as UpdateCommandOptions);
      expect(normalized.unset).toContain("tags");
    } finally {
      mapGetSpy.mockRestore();
    }
  });

  it("parses built-in runtime and extension unset targets", () => {
    const registry = {
      definitions: [
        {
          key: "githubUrl",
          metadata_key: "github_url",
          cli_flag: "github-url",
          cli_aliases: ["gh-url"],
        },
        {
          key: "hidden",
          metadata_key: "hidden",
          cli_flag: "hidden",
          cli_aliases: [],
          allow_unset: false,
        },
      ],
    };

    expect(_testOnlyUpdateCommand.resolveRuntimeUnsetDefinition("github_url", registry)).toEqual({
      optionKey: "githubUrl",
      frontMatterKey: "github_url",
    });
    expect(_testOnlyUpdateCommand.resolveRuntimeUnsetDefinition("hidden", registry)).toBeUndefined();

    const parsed = _testOnlyUpdateCommand.parseUpdateUnsetTargets(
      ["deadline", "gh-url", "external-field"],
      registry,
      ["external_field"],
    );
    expect([...parsed.frontMatterKeys].sort()).toEqual(["deadline", "external_field", "github_url"]);
    expect([...parsed.optionKeys].sort()).toEqual(["deadline", "field", "githubUrl"]);

    expect(() => _testOnlyUpdateCommand.parseUpdateUnsetTargets([""], registry)).toThrow(
      expect.objectContaining({ exitCode: EXIT_CODE.USAGE }),
    );
    expect(() => _testOnlyUpdateCommand.parseUpdateUnsetTargets(["null"], registry)).toThrow(
      expect.objectContaining({ exitCode: EXIT_CODE.USAGE }),
    );
    expect(() => _testOnlyUpdateCommand.parseUpdateUnsetTargets(["missing"], registry)).toThrow(
      expect.objectContaining({ exitCode: EXIT_CODE.USAGE }),
    );
  });

  it("builds audit-scope errors with replacement examples only for matching flags", () => {
    const error = _testOnlyUpdateCommand.buildAuditScopeRestrictedOptionsError({
      id: "pm-1234",
      code: "audit_update_restricted_options",
      message: "restricted",
      required: "required text",
      why: "why text",
      disallowedFlags: ["--comment", "--file", "--doc", "--status", "--unknown"],
    });

    expect(error).toMatchObject({
      exitCode: EXIT_CODE.USAGE,
      context: expect.objectContaining({
        code: "audit_update_restricted_options",
        examples: expect.arrayContaining([
          'pm comments pm-1234 --add "<text>" --allow-audit-comment',
          'pm files pm-1234 --add "path=<path>,scope=<scope>,note=<note>" --force',
          'pm docs pm-1234 --add "path=<path>,scope=<scope>,note=<note>" --force',
        ]),
        nextSteps: expect.arrayContaining([
          "Re-run without: --comment, --file, --doc, --status, --unknown",
          'Replace --comment with: pm comments pm-1234 --add "<text>" --allow-audit-comment',
          'Replace --file with: pm files pm-1234 --add "path=<path>,scope=<scope>,note=<note>" --force',
          'Replace --doc with: pm docs pm-1234 --add "path=<path>,scope=<scope>,note=<note>" --force',
        ]),
      }),
    });
  });

  it("enforces audit update override scopes for restricted lifecycle and unsafe append fields", () => {
    expect(() =>
      _testOnlyUpdateCommand.enforceAllowAuditUpdateScope(
        "pm-1234",
        {
          allowAuditUpdate: true,
          allowAuditDepUpdate: true,
        } as UpdateCommandOptions,
        new Set(),
      ),
    ).toThrow(expect.objectContaining({ exitCode: EXIT_CODE.USAGE }));

    expect(() =>
      _testOnlyUpdateCommand.enforceAllowAuditUpdateScope(
        "pm-1234",
        {
          allowAuditDepUpdate: true,
        } as UpdateCommandOptions,
        new Set(),
      ),
    ).toThrow("--allow-audit-dep-update requires at least one --dep value");

    expect(() =>
      _testOnlyUpdateCommand.enforceAllowAuditUpdateScope(
        "pm-1234",
        {
          allowAuditDepUpdate: true,
          dep: ["id=pm-2,kind=related"],
          title: "Title",
          replaceTests: true,
          clearEvents: true,
          typeOption: ["severity=high"],
          force: true,
        } as UpdateCommandOptions,
        new Set(["status"]),
      ),
    ).toThrow(expect.objectContaining({
      context: expect.objectContaining({
        code: "audit_dep_update_restricted_options",
        nextSteps: expect.arrayContaining([
          expect.stringContaining("--title"),
          expect.stringContaining("--unset"),
        ]),
      }),
    }));

    expect(() =>
      _testOnlyUpdateCommand.enforceAllowAuditUpdateScope(
        "pm-1234",
        {
          allowAuditUpdate: true,
          status: "closed",
          closeReason: "done",
          assignee: "agent",
          parent: "pm-parent",
          blockedBy: "pm-blocker",
          blockedReason: "blocked",
          unblockNote: "unblocked",
          dep: ["id=pm-2,kind=related"],
          depRemove: ["pm-3"],
          replaceDeps: true,
          replaceTests: true,
          note: ["note"],
          learning: ["lesson"],
          test: ["command=pnpm test"],
          reminder: ["2026-01-01T00:00:00Z"],
          event: ["start=2026-01-01T00:00:00Z,end=2026-01-01T01:00:00Z"],
          clearDeps: true,
          clearComments: true,
          clearNotes: true,
          clearLearnings: true,
          clearFiles: true,
          clearTests: true,
          clearDocs: true,
          clearReminders: true,
          clearEvents: true,
        } as UpdateCommandOptions,
        new Set(["status", "assignee"]),
      ),
    ).toThrow(expect.objectContaining({
      context: expect.objectContaining({
        code: "audit_update_restricted_options",
        nextSteps: expect.arrayContaining([expect.stringContaining("--note")]),
      }),
    }));

    expect(() =>
      _testOnlyUpdateCommand.enforceAllowAuditUpdateScope(
        "pm-1234",
        {
          allowAuditDepUpdate: true,
          dep: ["id=pm-2,kind=related"],
        } as UpdateCommandOptions,
        new Set(),
      ),
    ).not.toThrow();
    expect(() =>
      _testOnlyUpdateCommand.enforceAllowAuditUpdateScope(
        "pm-1234",
        {
          allowAuditUpdate: true,
          title: "Allowed metadata",
          comment: ["text=allowed audit evidence"],
          file: ["path=src/a.ts"],
          doc: ["path=docs/a.md"],
        } as UpdateCommandOptions,
        new Set(),
      ),
    ).not.toThrow();
  });

  it("rejects audit-scope unsets for lifecycle metadata", () => {
    expect(() =>
      _testOnlyUpdateCommand.enforceAllowAuditUpdateScope(
        "pm-1234",
        { unset: ["close-reason"], allowAuditUpdate: true } as UpdateCommandOptions,
        new Set(["close_reason"]),
      ),
    ).toThrow(expect.objectContaining({ exitCode: EXIT_CODE.USAGE }));
  });

  it("covers update policy, workflow, dependency, and reconciliation helper branches", () => {
    expect(() => _testOnlyUpdateCommand.normalizeUpdatePolicyOptionKey("not-real", "Task")).toThrow(
      expect.objectContaining({ exitCode: EXIT_CODE.CONFLICT }),
    );

    const provided = _testOnlyUpdateCommand.collectProvidedUpdatePolicyOptions(
      {
        addTags: ["alpha"],
        replaceDeps: true,
        replaceTests: true,
        allowAuditUpdate: true,
        unset: ["external-field"],
      } as UpdateCommandOptions,
      ["external_field"],
    );
    expect([...provided].sort()).toEqual(expect.arrayContaining(["allowAuditUpdate", "dep", "field", "tags", "test"]));

    const statusRegistry = {
      definitions: [
        { id: "open" },
        { id: "blocked" },
        { id: "in_progress", aliases: ["doing"] },
      ],
      alias_to_id: new Map([["doing", "in_progress"]]),
    };
    expect(
      _testOnlyUpdateCommand.enforceTypeWorkflowTransition({
        enforcement: "off",
        typeWorkflows: [{ type: "task", allowed_transitions: [] }],
        statusRegistry,
        typeName: "Task",
        fromStatus: "open",
        toStatus: "blocked",
      } as never),
    ).toBeUndefined();
    expect(
      _testOnlyUpdateCommand.enforceTypeWorkflowTransition({
        enforcement: "warn",
        typeWorkflows: [],
        statusRegistry,
        typeName: "Task",
        fromStatus: "open",
        toStatus: "blocked",
      } as never),
    ).toBeUndefined();
    expect(
      _testOnlyUpdateCommand.enforceTypeWorkflowTransition({
        enforcement: "warn",
        typeWorkflows: [{ type: "task", allowed_transitions: [["open", "in_progress"]] }],
        statusRegistry,
        typeName: "Task",
        fromStatus: "open",
        toStatus: "blocked",
      } as never),
    ).toContain("workflow_transition_not_allowed");
    expect(() =>
      _testOnlyUpdateCommand.enforceTypeWorkflowTransition({
        enforcement: "strict",
        typeWorkflows: [{ type: "task", allowed_transitions: [["open", "in_progress"]] }],
        statusRegistry,
        typeName: "Task",
        fromStatus: "open",
        toStatus: "blocked",
      } as never),
    ).toThrow(expect.objectContaining({ exitCode: EXIT_CODE.USAGE }));

    expect(_testOnlyUpdateCommand.parseDependencyAdditions(undefined, "pm", "2026-01-01T00:00:00.000Z")).toEqual({
      additions: [],
    });
    expect(() =>
      _testOnlyUpdateCommand.parseDependencyAdditions(["id=pm-missing-kind"], "pm", "2026-01-01T00:00:00.000Z"),
    ).toThrow(expect.objectContaining({ exitCode: EXIT_CODE.USAGE }));
    expect(() =>
      _testOnlyUpdateCommand.parseDependencyAdditions(
        ["id=pm-a,kind=related,created_at=not-a-date"],
        "pm",
        "2026-01-01T00:00:00.000Z",
      ),
    ).toThrow(expect.objectContaining({ exitCode: EXIT_CODE.USAGE }));
    expect(_testOnlyUpdateCommand.parseDependencyAdditions(["id=pm-a,kind=related,author=  "], "pm", "2026-01-01T00:00:00.000Z").additions[0]?.author).toBeUndefined();

    expect(_testOnlyUpdateCommand.parseDependencyRemovals(undefined, "pm")).toEqual([]);
    expect(() => _testOnlyUpdateCommand.parseDependencyRemovals(["   "], "pm")).toThrow(
      expect.objectContaining({ exitCode: EXIT_CODE.USAGE }),
    );
    expect(() => _testOnlyUpdateCommand.parseDependencyRemovals(["id=undefined"], "pm")).toThrow(
      expect.objectContaining({ exitCode: EXIT_CODE.USAGE }),
    );
    expect(_testOnlyUpdateCommand.parseDependencyRemovals(["id=pm-a,type=blocked-by,source_kind=import"], "pm")).toEqual([
      { id: "pm-a", kind: "blocked_by", source_kind: "import" },
    ]);

    expect(
      _testOnlyUpdateCommand.matchesDependencySelector(
        { id: "pm-a", kind: "related", created_at: "now", source_kind: "import" },
        { id: "pm-b" },
      ),
    ).toBe(false);
    expect(
      _testOnlyUpdateCommand.matchesDependencySelector(
        { id: "pm-a", kind: "related", created_at: "now", source_kind: "import" },
        { id: "pm-a", kind: "blocked_by" },
      ),
    ).toBe(false);
    expect(
      _testOnlyUpdateCommand.matchesDependencySelector(
        { id: "pm-a", kind: "related", created_at: "now", source_kind: "import" },
        { id: "pm-a", source_kind: "manual" },
      ),
    ).toBe(false);
    expect(
      _testOnlyUpdateCommand.matchesDependencySelector(
        { id: "pm-a", kind: "related", created_at: "now", source_kind: "import" },
        { id: "pm-a", kind: "related", source_kind: "import" },
      ),
    ).toBe(true);

    expect(
      _testOnlyUpdateCommand.reconcileBlockedByDependency(
        [{ id: "pm-a", kind: "blocked_by", created_at: "old" }],
        "pm-a",
        "2026-01-01T00:00:00.000Z",
        "agent",
      ),
    ).toEqual({
      changed: false,
      dependencies: [{ id: "pm-a", kind: "blocked_by", created_at: "old" }],
    });
    expect(
      _testOnlyUpdateCommand.reconcileBlockedByDependency(
        [{ id: "pm-a", kind: "blocked_by", created_at: "old" }],
        undefined,
        "2026-01-01T00:00:00.000Z",
        "agent",
      ),
    ).toEqual({ changed: true, dependencies: undefined });
  });
});

interface CreateTaskOptions {
  type?: string;
  assignee?: string;
  deadline?: string;
  estimate?: string;
  acceptanceCriteria?: string;
}

function createTask(context: TempPmContext, title: string, options: CreateTaskOptions = {}): string {
  const args = [
    "create",
    "--json",
    "--title",
    title,
    "--description",
    `${title} description`,
    "--type",
    options.type ?? "Task",
    "--create-mode",
    "progressive",
    "--status",
    "open",
    "--priority",
    "1",
    "--tags",
    "update,unit",
    "--body",
    "",
    "--deadline",
    options.deadline ?? "2026-03-01T00:00:00.000Z",
    "--estimate",
    options.estimate ?? "30",
    "--acceptance-criteria",
    options.acceptanceCriteria ?? `${title} acceptance`,
    "--author",
    "seed-author",
    "--message",
    `Create ${title}`,
  ];
  if (options.assignee !== undefined) {
    args.push("--assignee", options.assignee);
  }

  const created = context.runCli(args, { expectJson: true });

  expect(created.code).toBe(0);
  return (created.json as { item: { id: string } }).item.id;
}

function latestUpdateAuthor(context: TempPmContext, id: string): string | undefined {
  const history = context.runCli(["history", id, "--json", "--full"], { expectJson: true });
  expect(history.code).toBe(0);
  const entries = (history.json as { history: Array<{ op: string; author: string }> }).history;
  return [...entries].reverse().find((entry) => entry.op === "update")?.author;
}

function latestUpdateOperation(context: TempPmContext, id: string): string | undefined {
  const history = context.runCli(["history", id, "--json", "--full"], { expectJson: true });
  expect(history.code).toBe(0);
  const entries = (history.json as { history: Array<{ op: string }> }).history;
  return [...entries].reverse().find((entry) => entry.op.startsWith("update"))?.op;
}

function setGovernancePreset(context: TempPmContext, preset: "minimal" | "default" | "strict" | "custom"): void {
  const result = context.runCli(["config", "project", "set", "governance-preset", "--policy", preset, "--json"], {
    expectJson: true,
  });
  expect(result.code).toBe(0);
}

describe("runUpdate", () => {
  it("fails when tracker is not initialized", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pm-update-not-init-"));
    try {
      await expect(runUpdate("pm-missing", { description: "new description" }, { path: tempDir })).rejects.toMatchObject<
        PmCliError
      >({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("returns a noop success when no field-changing flag is provided (pm-7cup)", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "update-no-flags");
      const result = await runUpdate(id, {}, { path: context.pmPath });
      expect(result.changed_fields).toEqual([]);
      expect(result.warnings).toContain("noop_no_update_fields");
      const item = result.item as { id: string };
      expect(item.id).toBe(id);
    });
  });

  it("rejects unknown keys in --dep and --dep-remove matching test --add (GH-258)", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "update-unknown-dep-keys");
      await expect(
        runUpdate(id, { dep: ["id=pm-2,kind=related,boguskey=v"] }, { path: context.pmPath }),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: '--dep does not recognize key "boguskey". Allowed keys: id, kind, type, author, created_at, source_kind.',
      });
      await expect(
        runUpdate(id, { depRemove: ["id=pm-2,boguskey=v"] }, { path: context.pmPath }),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: '--dep-remove does not recognize key "boguskey". Allowed keys: id, kind, type, source_kind.',
      });
      // A FIRST-key typo must not bypass validation by being read as a bare item id (GH-258).
      await expect(
        runUpdate(id, { dep: ["boguskey=v,id=pm-2,kind=related"] }, { path: context.pmPath }),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: '--dep does not recognize key "boguskey". Allowed keys: id, kind, type, author, created_at, source_kind.',
      });
    });
  });

  it("returns NOT_FOUND for unknown id with did-you-mean suggestion (pm-99x5)", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "did-you-mean-seed");
      // Mutate one character of the known id so Levenshtein distance == 1.
      const mistyped = `${id.slice(0, -1)}${id.endsWith("a") ? "b" : "a"}`;
      await expect(runUpdate(mistyped, {}, { path: context.pmPath })).rejects.toMatchObject({
        exitCode: EXIT_CODE.NOT_FOUND,
        context: {
          nextSteps: expect.arrayContaining([expect.stringContaining(id)]),
        },
      });
    });
  });

  it("auto-routes pm update --status closed --close-reason to pm close (pm-12ib)", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "auto-route-close");
      const result = await runUpdate(
        id,
        { status: "closed", closeReason: "done via auto-route" },
        { path: context.pmPath },
      );
      expect(result.changed_fields).toEqual(expect.arrayContaining(["status", "close_reason"]));
      expect(result.warnings).toContain("auto_routed_from_update_to_close");
      const item = result.item as { status: string; close_reason: string };
      expect(item.status).toBe("closed");
      expect(item.close_reason).toBe("done via auto-route");
    });
  });

  it("auto-routes pm update --status closed combined with other field updates (never blocks agents)", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "auto-route-close-with-others");
      const result = await runUpdate(
        id,
        { status: "closed", closeReason: "done", title: "new title" },
        { path: context.pmPath },
      );
      expect(result.warnings).toContain("auto_routed_from_update_to_close");
      expect(result.changed_fields).toEqual(expect.arrayContaining(["title", "status", "close_reason"]));
      const item = result.item as { status: string; title: string; close_reason: string };
      expect(item.status).toBe("closed");
      expect(item.title).toBe("new title");
      expect(item.close_reason).toBe("done");
    });
  });

  it("auto-routes pm update --status closed without a reason using a derived default (never blocks agents)", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "auto-route-close-no-reason");
      const result = await runUpdate(id, { status: "closed" }, { path: context.pmPath });
      expect(result.warnings).toContain("auto_routed_from_update_to_close");
      expect(result.warnings).toContain("close_reason_defaulted");
      const item = result.item as { status: string; close_reason: string };
      expect(item.status).toBe("closed");
      expect(item.close_reason).toBe("Closed via pm update");
    });
  });

  it("derives the close reason from --message without flagging it as defaulted", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "auto-route-close-message-reason");
      const result = await runUpdate(
        id,
        { status: "closed", message: "shipped in v2" },
        { path: context.pmPath },
      );
      expect(result.warnings).toContain("auto_routed_from_update_to_close");
      // A real reason came from --message, so it is not a defaulted placeholder.
      expect(result.warnings).not.toContain("close_reason_defaulted");
      const item = result.item as { close_reason: string };
      expect(item.close_reason).toBe("shipped in v2");
    });
  });

  it("enforces update command_option_policies required and disabled options", async () => {
    await withTempPmPath(async (context) => {
      const settingsPath = path.join(context.pmPath, "settings.json");
      const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
        item_types?: { definitions?: Array<Record<string, unknown>> };
      };
      settings.item_types = {
        definitions: [
          {
            name: "Asset",
            folder: "assets",
            required_create_fields: [],
            required_create_repeatables: [],
            command_option_policies: [
              { command: "update", option: "message", required: true },
              { command: "update", option: "goal", enabled: false },
            ],
          },
        ],
      };
      await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

      const id = createTask(context, "update-policy-seed");

      await expect(
        runUpdate(
          id,
          {
            type: "Asset",
            status: "in_progress",
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining("--message"),
      });

      await expect(
        runUpdate(
          id,
          {
            type: "Asset",
            goal: "forbidden-goal",
            message: "attempt disabled goal option",
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining("--goal"),
      });

      const updated = await runUpdate(
        id,
        {
          type: "Asset",
          status: "in_progress",
          message: "apply update policy compliant change",
        },
        { path: context.pmPath },
      );
      expect((updated.item as Record<string, unknown>).type).toBe("Asset");
      expect((updated.item as Record<string, unknown>).status).toBe("in_progress");
    });
  });

  it("rejects unsupported update command_option_policies option keys", async () => {
    await withTempPmPath(async (context) => {
      const settingsPath = path.join(context.pmPath, "settings.json");
      const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
        item_types?: { definitions?: Array<Record<string, unknown>> };
      };
      settings.item_types = {
        definitions: [
          {
            name: "Task",
            command_option_policies: [{ command: "update", option: "not_real_option", enabled: false }],
          },
        ],
      };
      await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

      const id = createTask(context, "update-policy-invalid-option");
      await expect(
        runUpdate(
          id,
          {
            status: "in_progress",
            message: "trigger policy validation",
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.CONFLICT,
        message: expect.stringContaining("command_option_policies"),
      });
    });
  });

  it("updates scalar fields with valid values", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "update-explicit-values");
      const parentId = createTask(context, "update-parent-existing");
      const result = await runUpdate(
        id,
        {
          title: "updated title",
          description: "updated description",
          body: "updated body content",
          status: "blocked",
          priority: "4",
          type: "Issue",
          tags: "zeta,alpha,alpha",
          deadline: "+1d",
          estimatedMinutes: "45",
          acceptanceCriteria: "new acceptance",
          definitionOfReady: " ready with fixtures ",
          order: "8",
          assignee: " next-assignee ",
          goal: " goal-next ",
          objective: " objective-next ",
          value: " value-next ",
          impact: " impact-next ",
          outcome: " outcome-next ",
          whyNow: " why-now-next ",
          parent: ` ${parentId} `,
          reviewer: " reviewer-next ",
          risk: "med",
          confidence: "88",
          sprint: " sprint-next ",
          release: " release-next ",
          blockedBy: " pm-blocking-next ",
          blockedReason: " blocked waiting reason ",
          unblockNote: " unblocked after dependency update ",
          reporter: " reporter-next ",
          severity: "med",
          environment: " linux:node25 ",
          reproSteps: " run command and inspect output ",
          resolution: " update metadata parser ",
          expectedResult: " issue metadata should persist ",
          actualResult: " issue metadata was missing ",
          affectedVersion: " 0.1.0 ",
          fixedVersion: " 0.1.1 ",
          component: " cli/update ",
          regression: "true",
          customerImpact: " triage reports missing details ",
          reminder: [
            "at=2026-03-03T12:00:00.000Z,text= reminder beta ",
            "at=2026-03-03T12:00:00.000Z,text=reminder alpha",
          ],
          event: [
            "start=2026-03-04T08:00:00.000Z,title=Daily defaults,recur_freq=daily",
            "start=2026-03-05T10:00:00.000Z,end=2026-03-05T11:00:00.000Z,title=Planning review,all_day=yes",
            "start=2026-03-06T09:00:00.000Z,title=Recurring standup,all_day=false,recur_freq=weekly,recur_by_weekday=fri|mon|fri,recur_by_month_day=10|2,recur_exdates=2026-03-13T09:00:00.000Z|2026-03-06T09:00:00.000Z",
          ],
          author: " explicit-author ",
          message: "apply explicit update",
        },
        { path: context.pmPath },
      );

      // --blocked-by here targets a non-existent item, so the scalar is still
      // recorded but the kyd6 reconciler surfaces the unresolved-blocker warning.
      expect(result.warnings).toEqual(["blocked_by_unresolved:pm-blocking-next"]);
      expect(result.changed_fields).toEqual(
        expect.arrayContaining([
          "title",
          "description",
          "body",
          "status",
          "priority",
          "type",
          "tags",
          "deadline",
          "estimated_minutes",
          "acceptance_criteria",
          "definition_of_ready",
          "order",
          "goal",
          "objective",
          "value",
          "impact",
          "outcome",
          "why_now",
          "assignee",
          "parent",
          "reviewer",
          "risk",
          "confidence",
          "sprint",
          "release",
          "blocked_by",
          "blocked_reason",
          "unblock_note",
          "reporter",
          "severity",
          "environment",
          "repro_steps",
          "resolution",
          "expected_result",
          "actual_result",
          "affected_version",
          "fixed_version",
          "component",
          "regression",
          "customer_impact",
          "reminders",
          "events",
        ]),
      );

      const item = result.item as Record<string, unknown>;
      expect(item.title).toBe("updated title");
      expect(item.description).toBe("updated description");
      expect(item.status).toBe("blocked");
      expect(item.priority).toBe(4);
      expect(item.type).toBe("Issue");
      expect(item.tags).toEqual(["alpha", "zeta"]);
      expect(typeof item.deadline).toBe("string");
      expect(Number.isNaN(Date.parse(String(item.deadline)))).toBe(false);
      expect(item.estimated_minutes).toBe(45);
      expect(item.acceptance_criteria).toBe("new acceptance");
      expect(item.definition_of_ready).toBe("ready with fixtures");
      expect(item.order).toBe(8);
      expect(item.assignee).toBe("next-assignee");
      expect(item.goal).toBe("goal-next");
      expect(item.objective).toBe("objective-next");
      expect(item.value).toBe("value-next");
      expect(item.impact).toBe("impact-next");
      expect(item.outcome).toBe("outcome-next");
      expect(item.why_now).toBe("why-now-next");
      expect(item.parent).toBe(parentId);
      expect(item.reviewer).toBe("reviewer-next");
      expect(item.risk).toBe("medium");
      expect(item.confidence).toBe(88);
      expect(item.sprint).toBe("sprint-next");
      expect(item.release).toBe("release-next");
      expect(item.blocked_by).toBe("pm-blocking-next");
      expect(item.blocked_reason).toBe("blocked waiting reason");
      expect(item.unblock_note).toBe("unblocked after dependency update");
      expect(item.reporter).toBe("reporter-next");
      expect(item.severity).toBe("medium");
      expect(item.environment).toBe("linux:node25");
      expect(item.repro_steps).toBe("run command and inspect output");
      expect(item.resolution).toBe("update metadata parser");
      expect(item.expected_result).toBe("issue metadata should persist");
      expect(item.actual_result).toBe("issue metadata was missing");
      expect(item.affected_version).toBe("0.1.0");
      expect(item.fixed_version).toBe("0.1.1");
      expect(item.component).toBe("cli/update");
      expect(item.regression).toBe(true);
      expect(item.customer_impact).toBe("triage reports missing details");
      const loaded = context.runCli(["get", id, "--json"], { expectJson: true });
      expect(loaded.code).toBe(0);
      expect((loaded.json as { item: { body: string } }).item.body).toBe("updated body content");
      expect(item.reminders).toEqual([
        { at: "2026-03-03T12:00:00.000Z", text: "reminder alpha" },
        { at: "2026-03-03T12:00:00.000Z", text: "reminder beta" },
      ]);
      expect(item.events).toEqual([
        {
          start_at: "2026-03-04T08:00:00.000Z",
          title: "Daily defaults",
          recurrence: {
            freq: "daily",
          },
        },
        {
          start_at: "2026-03-05T10:00:00.000Z",
          end_at: "2026-03-05T11:00:00.000Z",
          title: "Planning review",
          all_day: true,
        },
        {
          start_at: "2026-03-06T09:00:00.000Z",
          title: "Recurring standup",
          all_day: false,
          recurrence: {
            freq: "weekly",
            by_weekday: ["mon", "fri"],
            by_month_day: [2, 10],
            exdates: ["2026-03-06T09:00:00.000Z", "2026-03-13T09:00:00.000Z"],
          },
        },
      ]);
      expect(latestUpdateAuthor(context, id)).toBe("explicit-author");

      const mediumConfidence = await runUpdate(
        id,
        {
          confidence: "med",
          author: "next-assignee",
          message: "normalize confidence med alias",
        },
        { path: context.pmPath },
      );
      expect((mediumConfidence.item as Record<string, unknown>).confidence).toBe("medium");

      const highConfidence = await runUpdate(
        id,
        {
          confidence: "high",
          author: "next-assignee",
          message: "set confidence text level",
        },
        { path: context.pmPath },
      );
      expect((highConfidence.item as Record<string, unknown>).confidence).toBe("high");

      const falseRegression = await runUpdate(
        id,
        {
          regression: "0",
          author: "next-assignee",
          message: "set regression false alias",
        },
        { path: context.pmPath },
      );
      expect((falseRegression.item as Record<string, unknown>).regression).toBe(false);
    });
  });

  it("supports explicit unset/clear semantics and clears assignee for canceled status", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "update-unset-fields", { assignee: "active-owner" });
      const result = await runUpdate(
        id,
        {
          description: "closed description",
          status: "canceled",
          unset: [
            "deadline",
            "estimate",
            "acceptance-criteria",
            "definition-of-ready",
            "order",
            "goal",
            "objective",
            "value",
            "impact",
            "outcome",
            "why-now",
            "assignee",
            "parent",
            "reviewer",
            "risk",
            "confidence",
            "sprint",
            "release",
            "blocked-by",
            "blocked-reason",
            "unblock-note",
            "reporter",
            "severity",
            "environment",
            "repro-steps",
            "resolution",
            "expected-result",
            "actual-result",
            "affected-version",
            "fixed-version",
            "component",
            "regression",
            "customer-impact",
          ],
          clearReminders: true,
          clearEvents: true,
          author: "active-owner",
          message: "cancel and clear optional fields",
        },
        { path: context.pmPath },
      );

      expect(result.changed_fields).toEqual(
        expect.arrayContaining([
          "description",
          "status",
          "deadline",
          "estimated_minutes",
          "acceptance_criteria",
          "definition_of_ready",
          "order",
          "goal",
          "objective",
          "value",
          "impact",
          "outcome",
          "why_now",
          "assignee",
          "parent",
          "reviewer",
          "risk",
          "confidence",
          "sprint",
          "release",
          "blocked_by",
          "blocked_reason",
          "unblock_note",
          "reporter",
          "severity",
          "environment",
          "repro_steps",
          "resolution",
          "expected_result",
          "actual_result",
          "affected_version",
          "fixed_version",
          "component",
          "regression",
          "customer_impact",
          "reminders",
          "events",
        ]),
      );

      const item = result.item as Record<string, unknown>;
      expect(item.status).toBe("canceled");
      expect(item.deadline).toBeUndefined();
      expect(item.estimated_minutes).toBeUndefined();
      expect(item.acceptance_criteria).toBeUndefined();
      expect(item.definition_of_ready).toBeUndefined();
      expect(item.order).toBeUndefined();
      expect(item.goal).toBeUndefined();
      expect(item.objective).toBeUndefined();
      expect(item.value).toBeUndefined();
      expect(item.impact).toBeUndefined();
      expect(item.outcome).toBeUndefined();
      expect(item.why_now).toBeUndefined();
      expect(item.assignee).toBeUndefined();
      expect(item.parent).toBeUndefined();
      expect(item.reviewer).toBeUndefined();
      expect(item.risk).toBeUndefined();
      expect(item.confidence).toBeUndefined();
      expect(item.sprint).toBeUndefined();
      expect(item.release).toBeUndefined();
      expect(item.blocked_by).toBeUndefined();
      expect(item.blocked_reason).toBeUndefined();
      expect(item.unblock_note).toBeUndefined();
      expect(item.reporter).toBeUndefined();
      expect(item.severity).toBeUndefined();
      expect(item.environment).toBeUndefined();
      expect(item.repro_steps).toBeUndefined();
      expect(item.resolution).toBeUndefined();
      expect(item.expected_result).toBeUndefined();
      expect(item.actual_result).toBeUndefined();
      expect(item.affected_version).toBeUndefined();
      expect(item.fixed_version).toBeUndefined();
      expect(item.component).toBeUndefined();
      expect(item.regression).toBeUndefined();
      expect(item.customer_impact).toBeUndefined();
      expect(item.reminders).toBeUndefined();
      expect(item.events).toBeUndefined();
    });
  });

  it("rejects blank assignee values and requires --unset assignee", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "update-blank-assignee");
      await expect(
        runUpdate(
          id,
          {
            description: "clear assignee with whitespace",
            assignee: "   ",
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      const cleared = await runUpdate(
        id,
        {
          description: "clear assignee with explicit unset",
          unset: ["assignee"],
        },
        { path: context.pmPath },
      );
      const item = cleared.item as Record<string, unknown>;
      expect(item.assignee).toBeUndefined();
    });
  });

  it("accepts in-progress status alias and stores canonical status", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "update-status-alias");
      const result = await runUpdate(
        id,
        {
          status: "in-progress",
          message: "set status using alias",
        },
        { path: context.pmPath },
      );

      const item = result.item as Record<string, unknown>;
      expect(item.status).toBe("in_progress");
    });
  });

  it("auto-clears close_reason when reopening from closed to non-terminal status", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "update-reopen-clears-close-reason");
      const closed = context.runCli(
        ["close", id, "Completed work", "--json", "--author", "test-author", "--message", "close for reopen test"],
        { expectJson: true },
      );
      expect(closed.code).toBe(0);
      expect((closed.json as { item: { close_reason?: string } }).item.close_reason).toBe("Completed work");

      const reopened = await runUpdate(
        id,
        {
          status: "open",
          author: "test-author",
          message: "reopen item",
        },
        { path: context.pmPath },
      );

      const item = reopened.item as Record<string, unknown>;
      expect(item.status).toBe("open");
      expect(item.close_reason).toBeUndefined();
      expect(reopened.changed_fields).toEqual(expect.arrayContaining(["status", "close_reason"]));
    });
  });

  it("supports explicit close_reason set and clear via unset flag", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "update-explicit-close-reason");

      const setReason = await runUpdate(
        id,
        {
          closeReason: "Paused pending dependency triage",
          author: "test-author",
          message: "set close reason explicitly",
        },
        { path: context.pmPath },
      );
      expect((setReason.item as Record<string, unknown>).close_reason).toBe("Paused pending dependency triage");
      expect(setReason.changed_fields).toContain("close_reason");

      const clearedReason = await runUpdate(
        id,
        {
          unset: ["close-reason"],
          author: "test-author",
          message: "clear close reason explicitly",
        },
        { path: context.pmPath },
      );
      expect((clearedReason.item as Record<string, unknown>).close_reason).toBeUndefined();
      expect(clearedReason.changed_fields).toContain("close_reason");
    });
  });

  it("accepts month-relative and normalized date-string deadline updates", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "update-deadline-format-expansion");

      const monthRelative = await runUpdate(
        id,
        {
          deadline: "+6m",
          author: "update-deadline-owner",
          message: "set month-relative deadline",
        },
        { path: context.pmPath },
      );
      expect(Number.isNaN(Date.parse(String((monthRelative.item as Record<string, unknown>).deadline)))).toBe(false);

      const normalizedDateString = await runUpdate(
        id,
        {
          deadline: "2026-03-31T13-59Z",
          author: "update-deadline-owner",
          message: "set normalized date-string deadline",
        },
        { path: context.pmPath },
      );
      expect((normalizedDateString.item as Record<string, unknown>).deadline).toBe("2026-03-31T13:59:00.000Z");
    });
  });

  it("validates enum and numeric inputs", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "update-invalid-values");

      await expect(runUpdate(id, { status: "not-a-status" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(runUpdate(id, { type: "NotAType" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(runUpdate(id, { priority: "9" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(runUpdate(id, { priority: "nope" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(runUpdate(id, { risk: "extreme" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(runUpdate(id, { confidence: "-1" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(runUpdate(id, { confidence: "uncertain" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(runUpdate(id, { severity: "urgent" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(runUpdate(id, { closeReason: "   " }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(runUpdate(id, { regression: "sometimes" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(runUpdate(id, { order: "3.7" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(runUpdate(id, { order: "1", rank: "2" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
    });
  });

  it("warns for non-conforming sprint and release values under default policy", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "update-sprint-release-warn");

      const result = await runUpdate(
        id,
        {
          sprint: "Sprint 2026 W14",
          release: "Release Candidate 1",
          message: "set non-conforming sprint/release metadata",
        },
        { path: context.pmPath },
      );

      expect((result.item as Record<string, unknown>).sprint).toBe("Sprint 2026 W14");
      expect((result.item as Record<string, unknown>).release).toBe("Release Candidate 1");
      expect(result.warnings).toEqual(
        expect.arrayContaining([
          "validation_warning:sprint_format:Sprint 2026 W14",
          "validation_warning:release_format:Release Candidate 1",
        ]),
      );
    });
  });

  it("rejects non-conforming sprint and release values under strict policy", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "update-sprint-release-strict");
      const settingsPath = path.join(context.pmPath, "settings.json");
      const parsed = JSON.parse(await readFile(settingsPath, "utf8")) as {
        validation?: { sprint_release_format?: string };
      };
      parsed.validation = {
        ...(parsed.validation ?? {}),
        sprint_release_format: "strict_error",
      };
      await writeFile(settingsPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");

      await expect(
        runUpdate(
          id,
          {
            release: "Release Candidate 1",
            message: "attempt invalid release in strict mode",
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
    });
  });

  it("rejects missing parent references under default policy", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "update-parent-warn");

      await expect(
        runUpdate(
          id,
          {
            parent: "pm-parent-missing-default",
            message: "attempt missing parent under default strict policy",
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
    });
  });

  it("rejects missing parent references under strict policy", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "update-parent-strict");
      setGovernancePreset(context, "strict");

      await expect(
        runUpdate(
          id,
          {
            parent: "pm-parent-missing-strict",
            message: "attempt missing parent in strict mode",
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
    });
  });

  it("rejects undefined parent placeholder tokens", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "update-parent-undefined");
      await expect(
        runUpdate(
          id,
          {
            parent: "undefined",
            message: "attempt undefined parent placeholder",
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
    });
  });

  it("adds and removes dependencies for existing items", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "update-dependency-mutations");
      const added = await runUpdate(
        id,
        {
          dep: [
            "id=dep-alpha,kind=blocks,author=dep-owner,created_at=2026-03-01T00:00:00.000Z",
            "id=dep-alpha,kind=blocks,author=duplicate-owner,created_at=2026-03-03T00:00:00.000Z",
            "id=dep-beta,kind=related,author=dep-owner,source_kind=imported,created_at=2026-03-02T00:00:00.000Z",
            "type=blocked-by,id=dep-blocker,author=dep-owner,created_at=2026-03-02T12:00:00.000Z",
            "dep-gamma",
          ],
          message: "add dependencies through update command",
        },
        { path: context.pmPath },
      );

      expect(added.changed_fields).toContain("dependencies");
      expect((added.item as { dependencies?: Array<Record<string, unknown>> }).dependencies).toEqual([
        {
          id: "pm-dep-alpha",
          kind: "blocks",
          created_at: "2026-03-01T00:00:00.000Z",
          author: "dep-owner",
        },
        {
          id: "pm-dep-beta",
          kind: "related",
          created_at: "2026-03-02T00:00:00.000Z",
          author: "dep-owner",
          source_kind: "imported",
        },
        {
          id: "pm-dep-blocker",
          kind: "blocked_by",
          created_at: "2026-03-02T12:00:00.000Z",
          author: "dep-owner",
        },
        expect.objectContaining({
          id: "pm-dep-gamma",
          kind: "related",
        }),
      ]);

      const removedById = await runUpdate(
        id,
        {
          depRemove: ["dep-alpha"],
          message: "remove dependency by id",
        },
        { path: context.pmPath },
      );
      expect((removedById.item as { dependencies?: Array<Record<string, unknown>> }).dependencies).toEqual([
        {
          id: "pm-dep-beta",
          kind: "related",
          created_at: "2026-03-02T00:00:00.000Z",
          author: "dep-owner",
          source_kind: "imported",
        },
        {
          id: "pm-dep-blocker",
          kind: "blocked_by",
          created_at: "2026-03-02T12:00:00.000Z",
          author: "dep-owner",
        },
        expect.objectContaining({
          id: "pm-dep-gamma",
          kind: "related",
        }),
      ]);

      const removedBySelector = await runUpdate(
        id,
        {
          depRemove: ["id=dep-beta,kind=related,source_kind=imported", "id=dep-blocker,type=blocked-by", "dep-gamma"],
          message: "remove dependency by selector",
        },
        { path: context.pmPath },
      );
      expect((removedBySelector.item as { dependencies?: Array<Record<string, unknown>> }).dependencies).toBeUndefined();
    });
  });

  it("supports clearing dependencies with --clear-deps", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "update-clear-dependencies");
      await runUpdate(
        id,
        {
          dep: ["id=dep-clear,kind=blocks,created_at=2026-03-01T00:00:00.000Z"],
          message: "seed one dependency before clear",
        },
        { path: context.pmPath },
      );

      const cleared = await runUpdate(
        id,
        {
          clearDeps: true,
          message: "clear dependency list",
        },
        { path: context.pmPath },
      );
      expect(cleared.changed_fields).toContain("dependencies");
      expect((cleared.item as { dependencies?: Array<Record<string, unknown>> }).dependencies).toBeUndefined();
    });
  });

  it("reinterprets legacy none/null tokens as deterministic unset and clear actions", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "update-legacy-none-compat");

      await runUpdate(
        id,
        {
          tags: "alpha,beta",
          deadline: "2026-03-15T00:00:00.000Z",
          dep: ["id=dep-seed,kind=blocks,created_at=2026-03-01T00:00:00.000Z"],
          comment: ["text=seed comment payload"],
          file: ["path=README.md,scope=project"],
          test: ["command=node scripts/run-tests.mjs test -- tests/unit/update-command.spec.ts,scope=project"],
          doc: ["path=README.md,scope=project"],
          reminder: ["at=2026-03-20T09:00:00.000Z,text=seed reminder"],
          event: ["start=2026-03-21T09:00:00.000Z,title=seed event"],
          message: "seed mutable fields",
        },
        { path: context.pmPath },
      );

      const cleared = await runUpdate(
        id,
        {
          tags: "none",
          deadline: "null",
          dep: ["none"],
          comment: ["null"],
          file: ["none"],
          test: ["null"],
          doc: ["none"],
          reminder: ["none"],
          event: ["null"],
          message: "legacy none clear compatibility",
        },
        { path: context.pmPath },
      );

      const item = cleared.item as Record<string, unknown>;
      expect(item.tags === undefined || (Array.isArray(item.tags) && item.tags.length === 0)).toBe(true);
      expect(item.deadline).toBeUndefined();
      expect(item.dependencies).toBeUndefined();
      expect(item.comments).toBeUndefined();
      expect(item.files).toBeUndefined();
      expect(item.tests).toBeUndefined();
      expect(item.docs).toBeUndefined();
      expect(item.reminders).toBeUndefined();
      expect(item.events).toBeUndefined();
    });
  });

  it("supports atomic dependency replacement with --replace-deps", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "update-replace-dependencies");
      await runUpdate(
        id,
        {
          dep: [
            "id=dep-alpha,kind=blocks,created_at=2026-03-01T00:00:00.000Z",
            "id=dep-beta,kind=related,created_at=2026-03-02T00:00:00.000Z",
          ],
          message: "seed dependencies before replacement",
        },
        { path: context.pmPath },
      );

      const replaced = await runUpdate(
        id,
        {
          replaceDeps: true,
          dep: ["id=dep-gamma,kind=related,created_at=2026-03-03T00:00:00.000Z"],
          message: "replace dependencies atomically",
        },
        { path: context.pmPath },
      );

      expect(replaced.changed_fields).toContain("dependencies");
      expect((replaced.item as { dependencies?: Array<Record<string, unknown>> }).dependencies).toEqual([
        {
          id: "pm-dep-gamma",
          kind: "related",
          created_at: "2026-03-03T00:00:00.000Z",
        },
      ]);
    });
  });

  it("supports atomic linked test replacement with --replace-tests", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "update-replace-tests");
      await runUpdate(
        id,
        {
          test: [
            "command=node scripts/run-tests.mjs test -- tests/unit/update-command.spec.ts,scope=project",
            "command=node scripts/run-tests.mjs test -- tests/unit/create-command.spec.ts,scope=project",
          ],
          message: "seed tests before replacement",
        },
        { path: context.pmPath },
      );

      const replaced = await runUpdate(
        id,
        {
          replaceTests: true,
          test: [
            "command=node scripts/run-tests.mjs test -- tests/unit/validate-command.spec.ts,scope=project",
            "command=node scripts/run-tests.mjs test -- tests/unit/validate-command.spec.ts,scope=project",
          ],
          message: "replace tests atomically",
        },
        { path: context.pmPath },
      );

      expect(replaced.changed_fields).toContain("tests");
      expect((replaced.item as { tests?: Array<Record<string, unknown>> }).tests).toEqual([
        {
          command: "node scripts/run-tests.mjs test -- tests/unit/validate-command.spec.ts",
          scope: "project",
        },
      ]);
    });
  });

  it("accepts cmd as a structured update --test alias without corrupting linked test commands", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "update-test-cmd-alias");
      const result = await runUpdate(
        id,
        {
          test: ["CMD=node --version,SCOPE=project,note=cmd alias"],
          message: "add linked test through cmd alias",
        },
        { path: context.pmPath },
      );

      const tests = (result.item as { tests?: Array<{ command: string; scope?: string; note?: string }> }).tests ?? [];
      expect(tests).toEqual([
        expect.objectContaining({
          command: "node --version",
          scope: "project",
          note: "cmd alias",
        }),
      ]);
      expect(tests.some((entry) => entry.command.includes("cmd="))).toBe(false);
    });
  });

  it("rejects unknown structured update --test keys instead of storing them as commands", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "update-test-unknown-key");

      await expect(
        runUpdate(
          id,
          {
            test: ["cmd=node --version,name=smoke"],
            message: "unknown linked test key",
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining("--test does not recognize key \"name\""),
      });

      await expect(
        runUpdate(
          id,
          {
            test: ["command=node --version,cmd=node --help"],
            message: "conflicting linked test command aliases",
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining("--test command and cmd must match"),
      });

      const listed = context.runCli(["get", id, "--json", "--fields", "tests"], { expectJson: true });
      expect((listed.json as { item?: { tests?: unknown[] } }).item?.tests).toBeUndefined();
    });
  });

  it("keeps bare update --test commands containing equals signs working", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "update-test-bare-equals");
      const result = await runUpdate(
        id,
        {
          test: ['node -e "process.env.FOO=\\"bar\\""'],
          message: "add bare command with equals",
        },
        { path: context.pmPath },
      );

      const tests = (result.item as { tests?: Array<{ command: string; scope?: string }> }).tests ?? [];
      expect(tests).toEqual([
        expect.objectContaining({
          command: 'node -e "process.env.FOO=\\"bar\\""',
          scope: "project",
        }),
      ]);
    });
  });

  it("validates --replace-tests requirements and preserves clear/value conflict behavior", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "update-replace-tests-validation");

      await expect(
        runUpdate(
          id,
          {
            replaceTests: true,
            message: "missing replacement values",
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining("--replace-tests requires at least one --test entry"),
      });

      await expect(
        runUpdate(
          id,
          {
            replaceTests: true,
            clearTests: true,
            test: ["command=node scripts/run-tests.mjs test -- tests/unit/update-command.spec.ts,scope=project"],
            message: "conflicting replacement and clear flags",
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining("--replace-tests cannot be combined with --clear-tests"),
      });

      await expect(
        runUpdate(
          id,
          {
            clearTests: true,
            test: ["command=node scripts/run-tests.mjs test -- tests/unit/update-command.spec.ts,scope=project"],
            message: "clear/value conflict still rejected",
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining("Cannot combine --clear-tests with --test"),
      });
    });
  });

  it("supports transactional linked collection mutations in a single update", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "update-transactional-annotate");

      const result = await runUpdate(
        id,
        {
          description: "update description and append linked collections",
          comment: ["text=comment from update transaction"],
          note: ["text=note from update transaction"],
          learning: ["text=learning from update transaction"],
          file: ["path=src/cli/main.ts,note=update transaction file"],
          test: ["command=node scripts/run-tests.mjs test -- tests/unit/update-command.spec.ts"],
          doc: ["path=README.md,note=update transaction doc"],
          author: "transaction-owner",
          message: "update metadata and linked collections transactionally",
        },
        { path: context.pmPath },
      );

      expect(result.changed_fields).toEqual(
        expect.arrayContaining(["description", "comments", "notes", "learnings", "files", "tests", "docs"]),
      );
      const item = result.item as {
        description?: string;
        comments?: Array<{ text: string }>;
        notes?: Array<{ text: string }>;
        learnings?: Array<{ text: string }>;
        files?: Array<{ path: string; scope: string }>;
        tests?: Array<{ command: string; scope: string }>;
        docs?: Array<{ path: string; scope: string }>;
      };
      expect(item.description).toBe("update description and append linked collections");
      expect(item.comments?.at(-1)?.text).toBe("comment from update transaction");
      expect(item.notes?.at(-1)?.text).toBe("note from update transaction");
      expect(item.learnings?.at(-1)?.text).toBe("learning from update transaction");
      expect(item.files).toEqual(expect.arrayContaining([expect.objectContaining({ path: "src/cli/main.ts", scope: "project" })]));
      expect(item.tests).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            command: "node scripts/run-tests.mjs test -- tests/unit/update-command.spec.ts",
            scope: "project",
          }),
        ]),
      );
      expect(item.docs).toEqual(expect.arrayContaining([expect.objectContaining({ path: "README.md", scope: "project" })]));

      const history = context.runCli(["history", id, "--json", "--full"], { expectJson: true });
      expect(history.code).toBe(0);
      const updateOps = (history.json as { history: Array<{ op: string; message?: string }> }).history.filter(
        (entry) => entry.op === "update",
      );
      expect(updateOps).toHaveLength(1);
      expect(updateOps[0]?.message).toBe("update metadata and linked collections transactionally");
    });
  });

  it("clears transactional linked collections with explicit clear flags", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "update-transactional-clear");
      await runUpdate(
        id,
        {
          comment: ["text=seed comment"],
          note: ["text=seed note"],
          learning: ["text=seed learning"],
          file: ["path=src/cli/main.ts,scope=project"],
          test: ["command=node scripts/run-tests.mjs test -- tests/unit/update-command.spec.ts,scope=project"],
          doc: ["path=README.md,scope=project"],
          message: "seed transactional linked collections",
        },
        { path: context.pmPath },
      );

      const cleared = await runUpdate(
        id,
        {
          clearComments: true,
          clearNotes: true,
          clearLearnings: true,
          clearFiles: true,
          clearTests: true,
          clearDocs: true,
          message: "clear transactional linked collections",
        },
        { path: context.pmPath },
      );

      expect(cleared.changed_fields).toEqual(
        expect.arrayContaining(["comments", "notes", "learnings", "files", "tests", "docs"]),
      );
      const item = cleared.item as Record<string, unknown>;
      expect(item.comments).toBeUndefined();
      expect(item.notes).toBeUndefined();
      expect(item.learnings).toBeUndefined();
      expect(item.files).toBeUndefined();
      expect(item.tests).toBeUndefined();
      expect(item.docs).toBeUndefined();
    });
  });

  it("validates dependency mutation payloads", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "update-invalid-dependencies");

      await expect(
        runUpdate(
          id,
          {
            dep: ["none", "id=dep-one,kind=blocks"],
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      await expect(
        runUpdate(
          id,
          {
            dep: ["id=dep-one"],
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      await expect(
        runUpdate(
          id,
          {
            dep: ["id=undefined,kind=blocks"],
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      await expect(
        runUpdate(
          id,
          {
            depRemove: ["none"],
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      await expect(
        runUpdate(
          id,
          {
            depRemove: ["undefined"],
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      await expect(
        runUpdate(
          id,
          {
            depRemove: ["kind=blocks"],
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      await expect(
        runUpdate(
          id,
          {
            clearDeps: true,
            dep: ["id=dep-clear,kind=blocks"],
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      await expect(
        runUpdate(
          id,
          {
            replaceDeps: true,
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      await expect(
        runUpdate(
          id,
          {
            replaceDeps: true,
            dep: ["id=dep-replaced,kind=blocks"],
            depRemove: ["dep-replaced"],
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      await expect(
        runUpdate(
          id,
          {
            comment: ["none", "text=mixed comment payload"],
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      await expect(
        runUpdate(
          id,
          {
            file: ["none", "path=README.md,scope=project"],
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });
    });
  });

  it("validates reminder update inputs", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "update-invalid-reminders");

      const dateTitleAliasResult = await runUpdate(
        id,
        { reminder: ["date=2026-03-03T12:00:00.000Z,title=date title alias"], message: "set date title alias reminder" },
        { path: context.pmPath },
      );
      expect(dateTitleAliasResult.item.reminders?.[0]).toMatchObject({
        at: "2026-03-03T12:00:00.000Z",
        text: "date title alias",
      });

      await expect(
        runUpdate(
          id,
          { reminder: ["none", "at=2026-03-03T12:00:00.000Z,text=mixed"] },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      await expect(
        runUpdate(
          id,
          { reminder: ["text=missing-at"] },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      await expect(
        runUpdate(
          id,
          { reminder: ["at=+1d,text=   "] },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      await expect(
        runUpdate(
          id,
          { reminder: ['at=+1d,text="   "'] },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining(
          "--reminder requires at=<iso|relative> or date=<iso|relative>, plus text=<value> or title=<value>",
        ),
      });

      await expect(
        runUpdate(
          id,
          { reminder: ["at=+3d+1h,text=compound-relative"] },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining('Invalid reminder.at value "+3d+1h"'),
      });
    });
  });

  it("validates event update inputs", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "update-invalid-events");

      const dateAliasResult = await runUpdate(
        id,
        { event: ["date=2026-03-03T12:00:00.000Z,title=date alias"], message: "set date alias event" },
        { path: context.pmPath },
      );
      expect(dateAliasResult.item.events?.[0]).toMatchObject({
        start_at: "2026-03-03T12:00:00.000Z",
        title: "date alias",
      });

      await expect(
        runUpdate(
          id,
          { event: ["none", "start=2026-03-03T12:00:00.000Z,title=mixed"] },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      await expect(
        runUpdate(
          id,
          { event: ["title=missing-start"] },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      await expect(
        runUpdate(
          id,
          { event: ["start=2026-03-03T12:00:00.000Z,end=2026-03-03T11:00:00.000Z"] },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      const instantUpdate = await runUpdate(
        id,
        { event: ["start=2026-03-03T12:00:00.000Z,end=2026-03-03T12:00:00.000Z,title=instant"], message: "instant event" },
        { path: context.pmPath },
      );
      expect(instantUpdate.item.events?.[0]).toMatchObject({ start_at: "2026-03-03T12:00:00.000Z", title: "instant" });
      expect(instantUpdate.item.events?.[0]?.end_at).toBeUndefined();

      await expect(
        runUpdate(
          id,
          { event: ["start=2026-03-03T12:00:00.000Z,title=   "] },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      await expect(
        runUpdate(
          id,
          { event: ["start=2026-03-03T12:00:00.000Z,description=   "] },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      await expect(
        runUpdate(
          id,
          { event: ["start=2026-03-03T12:00:00.000Z,location=   "] },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      await expect(
        runUpdate(
          id,
          { event: ["start=2026-03-03T12:00:00.000Z,timezone=   "] },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      await expect(
        runUpdate(
          id,
          { event: ["start=2026-03-03T12:00:00.000Z,all_day=maybe"] },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      const emptyGuardUpdate = await runUpdate(
        id,
        {
          event: ["start=2026-03-03T12:00:00.000Z,title=empty guards,all_day=,recur_freq=daily,recur_interval="],
          message: "empty event parser guards",
        },
        { path: context.pmPath },
      );
      expect(emptyGuardUpdate.item.events?.[0]).toMatchObject({
        start_at: "2026-03-03T12:00:00.000Z",
        title: "empty guards",
        recurrence: { freq: "daily" },
      });
      expect(emptyGuardUpdate.item.events?.[0]?.all_day).toBeUndefined();
      expect(emptyGuardUpdate.item.events?.[0]?.recurrence?.interval).toBeUndefined();

      await expect(
        runUpdate(
          id,
          { event: ["start=2026-03-03T12:00:00.000Z,recur_interval=2"] },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      await expect(
        runUpdate(
          id,
          { event: ["start=2026-03-03T12:00:00.000Z,recur_freq=daily,recur_interval=0"] },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      await expect(
        runUpdate(
          id,
          { event: ["start=2026-03-03T12:00:00.000Z,recur_freq=daily,recur_count=0"] },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      await expect(
        runUpdate(
          id,
          { event: ["start=2026-03-03T12:00:00.000Z,recur_freq=daily,recur_until=2026-03-02T12:00:00.000Z"] },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      await expect(
        runUpdate(
          id,
          { event: ["start=2026-03-03T12:00:00.000Z,recur_freq=monthly,recur_by_month_day=0"] },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      await expect(
        runUpdate(
          id,
          { event: ["start=+3d,end=+3d+1h,title=compound-relative"] },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining('Invalid event.end value "+3d+1h"'),
      });
    });
  });

  it("treats equal start/end as instant and supports duration= on event update", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "update-event-instant-duration");

      const instant = await runUpdate(
        id,
        { event: ["start=2026-03-03T12:00:00.000Z,end=2026-03-03T12:00:00.000Z,title=instant"], message: "instant" },
        { path: context.pmPath },
      );
      expect(instant.item.events?.[0]).toMatchObject({ start_at: "2026-03-03T12:00:00.000Z", title: "instant" });
      expect(instant.item.events?.[0]?.end_at).toBeUndefined();

      await expect(
        runUpdate(
          id,
          { event: ["start=2026-03-03T12:00:00.000Z,end=2026-03-03T11:00:00.000Z"], message: "earlier end" },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining("end must be strictly after start"),
      });

      const withDuration = await runUpdate(
        id,
        { event: ["start=2026-03-03T12:00:00.000Z,duration=3h,title=window"], message: "duration window" },
        { path: context.pmPath },
      );
      expect(withDuration.item.events?.[0]).toMatchObject({
        start_at: "2026-03-03T12:00:00.000Z",
        end_at: "2026-03-03T15:00:00.000Z",
        title: "window",
      });

      const withMinuteDuration = await runUpdate(
        id,
        { event: ["start=2026-03-03T12:00:00.000Z,duration=30min,title=minute-window"], message: "30min window" },
        { path: context.pmPath },
      );
      expect(withMinuteDuration.item.events?.[0]).toMatchObject({
        start_at: "2026-03-03T12:00:00.000Z",
        end_at: "2026-03-03T12:30:00.000Z",
        title: "minute-window",
      });

      const withIsoDuration = await runUpdate(
        id,
        { event: ["start=2026-03-03T12:00:00.000Z,duration=PT30M,title=iso-window"], message: "iso 30m window" },
        { path: context.pmPath },
      );
      expect(withIsoDuration.item.events?.[0]).toMatchObject({
        start_at: "2026-03-03T12:00:00.000Z",
        end_at: "2026-03-03T12:30:00.000Z",
        title: "iso-window",
      });

      // Keep legacy semantics where bare `m` means months.
      const withMonthDuration = await runUpdate(
        id,
        { event: ["start=2026-03-03T12:00:00.000Z,duration=45m,title=month-window"], message: "legacy month window" },
        { path: context.pmPath },
      );
      expect(withMonthDuration.item.events?.[0]).toMatchObject({
        start_at: "2026-03-03T12:00:00.000Z",
        end_at: "2029-12-03T12:00:00.000Z",
        title: "month-window",
      });

      await expect(
        runUpdate(
          id,
          { event: ["start=2026-03-03T12:00:00.000Z,end=2026-03-03T13:00:00.000Z,duration=2h"], message: "both" },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining("mutually exclusive"),
      });
    });
  });

  it("resolves update author from env, settings, and unknown fallback", async () => {
    await withTempPmPath(async (context) => {
      const envAuthorId = createTask(context, "update-env-author");
      await runUpdate(
        envAuthorId,
        {
          description: "env-based author update",
          message: "env author",
        },
        { path: context.pmPath },
      );
      expect(latestUpdateAuthor(context, envAuthorId)).toBe("test-author");

      const previousPmAuthor = process.env.PM_AUTHOR;
      delete process.env.PM_AUTHOR;
      try {
        const settingsPath = path.join(context.pmPath, "settings.json");
        const settings = JSON.parse(await readFile(settingsPath, "utf8")) as { author_default?: string };
        settings.author_default = "settings-author";
        await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

        const settingsAuthorId = createTask(context, "update-settings-author");
        await runUpdate(
          settingsAuthorId,
          {
            description: "settings-based author update",
            message: "settings author",
          },
          { path: context.pmPath },
        );
        expect(latestUpdateAuthor(context, settingsAuthorId)).toBe("settings-author");

        settings.author_default = "   ";
        await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

        const unknownAuthorId = createTask(context, "update-unknown-author");
        await runUpdate(
          unknownAuthorId,
          {
            description: "unknown author update",
            author: "   ",
            message: "unknown author",
          },
          { path: context.pmPath },
        );
        expect(latestUpdateAuthor(context, unknownAuthorId)).toBe("unknown");
      } finally {
        if (previousPmAuthor === undefined) {
          delete process.env.PM_AUTHOR;
        } else {
          process.env.PM_AUTHOR = previousPmAuthor;
        }
      }
    });
  });

  it("blocks foreign assignment updates unless forced", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "update-force", { assignee: "foreign-assignee" });
      setGovernancePreset(context, "strict");

      await expect(runUpdate(id, { description: "blocked update" }, { path: context.pmPath })).rejects.toMatchObject<
        PmCliError
      >({
        exitCode: EXIT_CODE.CONFLICT,
      });

      const forced = await runUpdate(
        id,
        {
          description: "forced update",
          force: true,
          message: "force update for foreign assignment",
        },
        { path: context.pmPath },
      );

      const item = forced.item as Record<string, unknown>;
      expect(item.description).toBe("forced update");
    });
  });

  it("allows non-owner metadata updates with --allow-audit-update", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "update-audit-override", { assignee: "foreign-assignee" });
      const result = await runUpdate(
        id,
        {
          description: "audited metadata update",
          allowAuditUpdate: true,
          message: "audit override metadata sync",
        },
        { path: context.pmPath },
      );
      expect((result.item as Record<string, unknown>).description).toBe("audited metadata update");
      expect(result.audit_update).toBe(true);
      expect(latestUpdateOperation(context, id)).toBe("update_audit");
    });
  });

  it("rejects lifecycle and ownership fields when --allow-audit-update is used", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "update-audit-scope-guard", { assignee: "foreign-assignee" });
      await expect(
        runUpdate(
          id,
          {
            allowAuditUpdate: true,
            status: "blocked",
            message: "attempt lifecycle mutation via audit mode",
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining("--status"),
      });
    });
  });

  it("allows audit-update evidence comments files and docs without ownership", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "update-audit-evidence-appends", { assignee: "foreign-assignee" });
      const result = await runUpdate(
        id,
        {
          allowAuditUpdate: true,
          comment: ["author=audit-bot,created_at=2026-03-01T00:00:00.000Z,text=audit note"],
          file: ["path=src/cli/commands/update.ts,scope=project,note=audit file"],
          doc: ["path=docs/COMMANDS.md,scope=project,note=audit doc"],
          author: "actual-audit-owner",
          message: "append audit evidence without claiming",
        },
        { path: context.pmPath },
      );

      expect(result.audit_update).toBe(true);
      expect(result.changed_fields).toEqual(expect.arrayContaining(["comments", "files", "docs"]));
      expect(latestUpdateOperation(context, id)).toBe("update_audit");
      const item = result.item as {
        comments?: Array<{ author?: string; text?: string }>;
        files?: Array<{ path: string; note?: string }>;
        docs?: Array<{ path: string; note?: string }>;
      };
      expect(item.comments?.at(-1)).toMatchObject({ author: "actual-audit-owner", text: "audit note" });
      expect(item.files).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "src/cli/commands/update.ts", note: "audit file" }),
        ]),
      );
      expect(item.docs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "docs/COMMANDS.md", note: "audit doc" }),
        ]),
      );
    });
  });

  it("still guides audit-update attempts for unsafe append fields", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "update-audit-unsafe-append-guidance", { assignee: "foreign-assignee" });
      const error = await runUpdate(
        id,
        {
          allowAuditUpdate: true,
          note: ["text=audit note"],
          test: ["command=node --version"],
          message: "attempt unsafe append mutation via audit mode",
        },
        { path: context.pmPath },
      ).then(
        () => {
          throw new Error("expected runUpdate to reject");
        },
        (caught: unknown) => caught as PmCliError,
      );

      expect(error.exitCode).toBe(EXIT_CODE.USAGE);
      expect(error.context.code).toBe("audit_update_restricted_options");
      expect(error.context.nextSteps).toEqual(
        expect.arrayContaining([
          expect.stringContaining("Re-run without: --note, --test"),
        ]),
      );
    });
  });

  it("allows non-owner dependency additions with --allow-audit-dep-update", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "update-audit-dep-override", { assignee: "foreign-assignee" });
      const result = await runUpdate(
        id,
        {
          allowAuditDepUpdate: true,
          dep: ["id=dep-audit,kind=related,author=audit-owner,created_at=2026-03-01T00:00:00.000Z"],
          message: "audit dependency add",
        },
        { path: context.pmPath },
      );
      expect((result.item as { dependencies?: Array<Record<string, unknown>> }).dependencies).toEqual([
        {
          id: "pm-dep-audit",
          kind: "related",
          author: "audit-owner",
          created_at: "2026-03-01T00:00:00.000Z",
        },
      ]);
      expect(result.audit_update).toBe(true);
      expect(latestUpdateOperation(context, id)).toBe("update_audit");
    });
  });

  it("rejects non-dependency mutations when --allow-audit-dep-update is used", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "update-audit-dep-scope-guard", { assignee: "foreign-assignee" });
      await expect(
        runUpdate(
          id,
          {
            allowAuditDepUpdate: true,
            status: "blocked",
            dep: ["id=dep-audit,kind=related"],
            message: "attempt lifecycle mutation in dep-audit mode",
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining("--status"),
      });

      await expect(
        runUpdate(
          id,
          {
            allowAuditDepUpdate: true,
            message: "missing dependency payload",
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining("requires at least one --dep"),
      });

      const docError = await runUpdate(
        id,
        {
          allowAuditDepUpdate: true,
          dep: ["id=dep-audit,kind=related"],
          doc: ["path=docs/COMMANDS.md,scope=project,note=audit doc"],
          message: "attempt doc append in dep-audit mode",
        },
        { path: context.pmPath },
      ).then(
        () => {
          throw new Error("expected runUpdate to reject");
        },
        (caught: unknown) => caught as PmCliError,
      );

      expect(docError.exitCode).toBe(EXIT_CODE.USAGE);
      expect(docError.context.code).toBe("audit_dep_update_restricted_options");
      expect(docError.context.examples).toEqual([
        `pm docs ${id} --add "path=<path>,scope=<scope>,note=<note>" --force`,
      ]);
      expect(docError.context.nextSteps).toEqual(
        expect.arrayContaining([
          expect.stringContaining("Re-run without: --doc"),
          expect.stringContaining("Replace --doc with:"),
        ]),
      );
    });
  });

  it("rejects additive tag mutations in --allow-audit-dep-update scope (pm-1lws)", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "dep-audit-tag-guard", { assignee: "foreign-assignee" });
      for (const tagOption of [{ addTags: ["sneaky"] }, { removeTags: ["unit"] }]) {
        await expect(
          runUpdate(
            id,
            {
              allowAuditDepUpdate: true,
              dep: ["id=dep-audit,kind=related"],
              message: "attempt tag mutation in dep-audit mode",
              ...tagOption,
            },
            { path: context.pmPath },
          ),
        ).rejects.toMatchObject<PmCliError>({
          exitCode: EXIT_CODE.USAGE,
          message: expect.stringMatching(/--add-tags|--remove-tags/),
        });
      }
    });
  });

  it("rejects combining --unset tags with additive tag mutations (pm-1lws)", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "unset-tags-conflict");
      await expect(
        runUpdate(id, { unset: ["tags"], addTags: ["x"], message: "conflict" }, { path: context.pmPath }),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining("Cannot combine --unset tags with --add-tags"),
      });
      await expect(
        runUpdate(id, { unset: ["tags"], removeTags: ["unit"], message: "conflict" }, { path: context.pmPath }),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining("Cannot combine --unset tags with --remove-tags"),
      });
    });
  });

  it("lists allowed dependency kinds when dependency kind is invalid", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "update-invalid-dependency-kind");
      // pm-fl0c #4 (2026-05-28): depends_on is now ACCEPTED as an input alias
      // for blocked_by (pm plan vocab). Exercise a kind that is truly unknown
      // ("totally-invalid") so the diagnostic listing all allowed kinds still
      // surfaces.
      await expect(
        runUpdate(
          id,
          {
            dep: ["id=dep-invalid,kind=totally-invalid"],
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining("Allowed:"),
      });
    });
  });

  it("accepts depends_on as an input alias for blocked_by (pm-fl0c #4)", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "update-depends-on-alias");
      const result = await runUpdate(
        id,
        {
          dep: ["id=pm-zzzz,kind=depends_on"],
        },
        { path: context.pmPath },
      );
      const dependencies = (result.item as { dependencies?: Array<{ kind: string; id: string }> }).dependencies ?? [];
      expect(dependencies).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "pm-zzzz", kind: "blocked_by" }),
        ]),
      );
    });
  });

  it("accepts colon and markdown formats for update type-option entries", async () => {
    await withTempPmPath(async (context) => {
      const settingsPath = path.join(context.pmPath, "settings.json");
      const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
        item_types?: { definitions?: Array<Record<string, unknown>> };
      };
      settings.item_types = {
        definitions: [
          {
            name: "Asset",
            folder: "assets",
            required_create_fields: [],
            required_create_repeatables: [],
            options: [
              { key: "category", values: ["feature", "maintenance"] },
              { key: "workflow", values: ["seeded", "regression"] },
            ],
          },
        ],
      };
      await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

      const id = createTask(context, "update-type-option-colon", { type: "Asset" });
      const colonResult = await runUpdate(
        id,
        {
          typeOption: ["category:maintenance"],
          message: "update type option colon",
        },
        { path: context.pmPath },
      );
      expect((colonResult.item as { type_options?: Record<string, string> }).type_options).toEqual({
        category: "maintenance",
      });

      const markdownResult = await runUpdate(
        id,
        {
          typeOption: ["key: workflow\nvalue: regression"],
          message: "update type option markdown",
        },
        { path: context.pmPath },
      );
      expect((markdownResult.item as { type_options?: Record<string, string> }).type_options).toEqual({
        workflow: "regression",
      });
    });
  });

  it("rejects existing type options that are incompatible with a new type", async () => {
    await withTempPmPath(async (context) => {
      const settingsPath = path.join(context.pmPath, "settings.json");
      const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
        item_types?: { definitions?: Array<Record<string, unknown>> };
      };
      settings.item_types = {
        definitions: [
          {
            name: "Asset",
            folder: "assets",
            required_create_fields: [],
            required_create_repeatables: [],
            options: [{ key: "category", values: ["feature"] }],
          },
          {
            name: "Service",
            folder: "services",
            required_create_fields: [],
            required_create_repeatables: [],
            options: [{ key: "category", values: ["platform"] }],
          },
        ],
      };
      await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

      const created = await runCreate(
        {
          title: "update-incompatible-type-options",
          description: "seed incompatible type options",
          type: "Asset",
          createMode: "progressive",
          typeOption: ["category=feature"],
        },
        { path: context.pmPath },
      );

      await expect(
        runUpdate(created.item.id, { type: "Service", message: "switch type" }, { path: context.pmPath }),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining("Use --clear-type-options to clear them"),
      });
    });
  });

  it("deduplicates linked files, tests, and docs during update mutations", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "update-dedupe-linked-artifacts");
      const first = await runUpdate(
        id,
        {
          file: ["path=src/cli.ts,scope=project,note=entry"],
          test: ["command=node --version,path=tests/unit/update-command.spec.ts,scope=project"],
          doc: ["path=README.md,scope=project,note=readme"],
          message: "seed linked artifacts",
        },
        { path: context.pmPath },
      );
      const second = await runUpdate(
        id,
        {
          file: ["path=src/cli.ts,scope=project,note=entry"],
          test: ["command=node --version,path=tests/unit/update-command.spec.ts,scope=project"],
          doc: ["path=README.md,scope=project,note=readme"],
          message: "dedupe linked artifacts",
        },
        { path: context.pmPath },
      );

      expect((second.item as { files?: unknown[] }).files).toHaveLength((first.item as { files?: unknown[] }).files?.length ?? 0);
      expect((second.item as { tests?: unknown[] }).tests).toHaveLength((first.item as { tests?: unknown[] }).tests?.length ?? 0);
      expect((second.item as { docs?: unknown[] }).docs).toHaveLength((first.item as { docs?: unknown[] }).docs?.length ?? 0);
    });
  });

  it("rejects replace-tests combined with clear-tests before mutation", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "update-replace-tests-branches");
      await expect(
        runUpdate(
          id,
          {
            clearTests: true,
            replaceTests: true,
            test: ["command=node --version", "command=node --version"],
            message: "replace tests with dedupe",
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining("--replace-tests cannot be combined with --clear-tests"),
      });
    });
  });

  it("updates declared extension item fields through repeatable --field values", async () => {
    await withTempPmPath(async (context) => {
      const registrations = createEmptyExtensionRegistrationRegistry();
      registrations.item_fields.push({
        layer: "project",
        name: "github-importer",
        fields: [
          { name: "github_url", type: "string" },
          { name: "github_number", type: "number" },
        ],
      });
      setActiveExtensionRegistrations(registrations);

      const id = createTask(context, "update-extension-field-values");
      const result = await runUpdate(
        id,
        {
          field: ["github_url=https://example.test/2", "github_number=7"],
          message: "update extension fields",
        },
        { path: context.pmPath },
      );

      expect((result.item as { github_url?: string }).github_url).toBe("https://example.test/2");
      expect((result.item as { github_number?: number }).github_number).toBe(7);
      expect(result.changed_fields).toEqual(expect.arrayContaining(["github_url", "github_number"]));
    });
  });

  it("skips unchanged runtime and extension item-field update values", async () => {
    await withTempPmPath(async (context) => {
      const settingsPath = path.join(context.pmPath, "settings.json");
      const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
        schema?: { fields?: Array<Record<string, unknown>> };
      };
      settings.schema = {
        ...(settings.schema ?? {}),
        fields: [
          {
            key: "reviewUrl",
            metadata_key: "review_url",
            type: "string",
            cli_flag: "review-url",
            commands: ["update"],
          },
        ],
      };
      await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

      const registrations = createEmptyExtensionRegistrationRegistry();
      registrations.item_fields.push({
        layer: "project",
        name: "github-importer",
        fields: [{ name: "github_url", type: "string" }],
      });
      setActiveExtensionRegistrations(registrations);

      const id = createTask(context, "update-runtime-extension-noops");
      const setValues = await runUpdate(
        id,
        {
          reviewUrl: "https://example.test/review",
          field: ["github_url=https://example.test/field"],
          message: "set runtime and extension fields",
        },
        { path: context.pmPath },
      );
      expect(setValues.changed_fields).toEqual(expect.arrayContaining(["review_url", "github_url"]));

      const sameValues = await runUpdate(
        id,
        {
          reviewUrl: "https://example.test/review",
          field: ["github_url=https://example.test/field"],
          message: "same runtime and extension fields",
        },
        { path: context.pmPath },
      );
      expect(sameValues.changed_fields).not.toContain("review_url");
      expect(sameValues.changed_fields).not.toContain("github_url");
    });
  });

  it("surfaces extension item-field validation failures as usage errors on update", async () => {
    await withTempPmPath(async (context) => {
      const registrations = createEmptyExtensionRegistrationRegistry();
      registrations.item_fields.push({
        layer: "project",
        name: "github-importer",
        fields: [{ name: "github_url", type: "string", values: ["https://example.test/allowed"] }],
      });
      setActiveExtensionRegistrations(registrations);

      const id = createTask(context, "update-extension-field-invalid-value");
      await expect(
        runUpdate(
          id,
          {
            field: ["github_url=https://example.test/denied"],
            message: "invalid extension field value",
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining("github_url"),
      });
    });
  });

  it("unsets declared extension item fields through --unset", async () => {
    await withTempPmPath(async (context) => {
      const registrations = createEmptyExtensionRegistrationRegistry();
      registrations.item_fields.push({
        layer: "project",
        name: "github-importer",
        fields: [{ name: "github_url", type: "string" }],
      });
      setActiveExtensionRegistrations(registrations);

      const id = createTask(context, "unset-extension-field-values");
      await runUpdate(
        id,
        {
          field: ["github_url=https://example.test/2"],
          message: "seed extension field",
        },
        { path: context.pmPath },
      );
      const result = await runUpdate(
        id,
        {
          unset: ["github-url"],
          message: "unset extension field",
        },
        { path: context.pmPath },
      );

      expect((result.item as { github_url?: string }).github_url).toBeUndefined();
      expect(result.changed_fields).toContain("github_url");
    });
  });

  it("reads declared extension item fields after strict-schema updates", async () => {
    await withTempPmPath(async (context) => {
      const settingsPath = path.join(context.pmPath, "settings.json");
      const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
        schema?: { unknown_field_policy?: string };
      };
      settings.schema = {
        ...(settings.schema ?? {}),
        unknown_field_policy: "reject",
      };
      await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

      const registrations = createEmptyExtensionRegistrationRegistry();
      registrations.item_fields.push({
        layer: "project",
        name: "github-importer",
        fields: [{ name: "github_url", type: "string" }],
      });
      setActiveExtensionRegistrations(registrations);

      const id = createTask(context, "read-extension-field-strict-schema");
      await runUpdate(
        id,
        {
          field: ["github_url=https://example.test/read"],
          message: "set strict extension field",
        },
        { path: context.pmPath },
      );

      const read = await runGet(id, { path: context.pmPath });
      expect((read.item as { github_url?: string }).github_url).toBe("https://example.test/read");
    });
  });

  it("rejects combining --unset and --field for the same extension field", async () => {
    await withTempPmPath(async (context) => {
      const registrations = createEmptyExtensionRegistrationRegistry();
      registrations.item_fields.push({
        layer: "project",
        name: "github-importer",
        fields: [{ name: "github_url", type: "string" }],
      });
      setActiveExtensionRegistrations(registrations);

      const id = createTask(context, "conflicting-extension-field-update");
      await expect(
        runUpdate(
          id,
          {
            unset: ["github-url"],
            field: ["github_url=https://example.test/conflict"],
            message: "conflicting extension field update",
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining("Cannot combine --unset github-url with --field github_url=..."),
      });
    });
  });

  it("does not reapply extension defaults for explicitly unset fields", async () => {
    await withTempPmPath(async (context) => {
      const registrations = createEmptyExtensionRegistrationRegistry();
      registrations.item_fields.push({
        layer: "project",
        name: "github-importer",
        fields: [{ name: "github_url", type: "string", default: "https://example.test/default" }],
      });
      setActiveExtensionRegistrations(registrations);

      const id = createTask(context, "unset-extension-field-default");
      await runUpdate(
        id,
        {
          field: ["github_url=https://example.test/custom"],
          message: "seed custom extension field",
        },
        { path: context.pmPath },
      );
      const result = await runUpdate(
        id,
        {
          unset: ["github-url"],
          message: "unset extension field with default",
        },
        { path: context.pmPath },
      );

      expect((result.item as { github_url?: string }).github_url).toBeUndefined();
      expect(result.changed_fields).toContain("github_url");
    });
  });

  it("allows declared extension item fields on update when strict schema rejects unknown fields", async () => {
    await withTempPmPath(async (context) => {
      const settingsPath = path.join(context.pmPath, "settings.json");
      const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
        schema?: { unknown_field_policy?: string };
      };
      settings.schema = {
        ...(settings.schema ?? {}),
        unknown_field_policy: "reject",
      };
      await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

      const registrations = createEmptyExtensionRegistrationRegistry();
      registrations.item_fields.push({
        layer: "project",
        name: "github-importer",
        fields: [{ name: "github_url", type: "string" }],
      });
      setActiveExtensionRegistrations(registrations);

      const id = createTask(context, "update-extension-field-strict-schema");
      const result = await runUpdate(
        id,
        {
          field: ["github_url=https://example.test/strict"],
          message: "update strict extension field",
        },
        { path: context.pmPath },
      );

      expect((result.item as { github_url?: string }).github_url).toBe("https://example.test/strict");
      expect(result.changed_fields).toContain("github_url");
    });
  });

  it("enforces command_option_policies for the extension --field setter on update", async () => {
    await withTempPmPath(async (context) => {
      const settingsPath = path.join(context.pmPath, "settings.json");
      const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
        item_types?: { definitions?: Array<Record<string, unknown>> };
      };
      settings.item_types = {
        definitions: [
          {
            name: "Task",
            command_option_policies: [{ command: "update", option: "field", enabled: false }],
          },
        ],
      };
      await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

      const registrations = createEmptyExtensionRegistrationRegistry();
      registrations.item_fields.push({
        layer: "project",
        name: "github-importer",
        fields: [{ name: "github_url", type: "string" }],
      });
      setActiveExtensionRegistrations(registrations);

      const id = createTask(context, "update-extension-field-policy");
      await expect(
        runUpdate(
          id,
          {
            field: ["github_url=https://example.test/policy"],
            message: "update disabled extension field",
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining("--field"),
      });
    });
  });

  it("rejects reserved extension item field names on update", async () => {
    await withTempPmPath(async (context) => {
      const registrations = createEmptyExtensionRegistrationRegistry();
      registrations.item_fields.push({
        layer: "project",
        name: "bad-extension",
        fields: [{ name: "id", type: "string" }],
      });
      setActiveExtensionRegistrations(registrations);

      const id = createTask(context, "update-extension-field-reserved");
      await expect(
        runUpdate(
          id,
          {
            field: ["id=pm-other"],
            message: "update reserved extension field",
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        context: { code: "extension_item_field_reserved" },
      });
    });
  });

  it("rejects undeclared extension item fields on update", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "update-unknown-extension-field");
      await expect(
        runUpdate(
          id,
          {
            field: ["github_url=https://example.test/2"],
            message: "update unknown extension field",
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        context: { code: "extension_item_field_unknown" },
      });
    });
  });

  it("accepts stdin token for update repeatable entries", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "update-repeatable-stdin");
      const stdin = new PassThrough();
      stdin.end(["at: +1d", "text: reminder from stdin"].join("\n"));
      Object.defineProperty(stdin, "isTTY", { value: false, configurable: true });
      vi.spyOn(process, "stdin", "get").mockReturnValue(stdin as unknown as NodeJS.ReadStream);

      const updated = await runUpdate(
        id,
        {
          reminder: ["-"],
          message: "update reminder from stdin",
        },
        { path: context.pmPath },
      );

      expect((updated.item as { reminders?: Array<{ text: string }> }).reminders?.at(0)?.text).toBe("reminder from stdin");
    });
  });

  it("accepts stdin token for update body value", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "update-body-stdin");
      const stdin = new PassThrough();
      stdin.end("body from stdin token");
      Object.defineProperty(stdin, "isTTY", { value: false, configurable: true });
      vi.spyOn(process, "stdin", "get").mockReturnValue(stdin as unknown as NodeJS.ReadStream);

      const updated = await runUpdate(
        id,
        {
          body: "-",
          message: "update body from stdin",
        },
        { path: context.pmPath },
      );

      expect(updated.changed_fields).toContain("body");
      const loaded = context.runCli(["get", id, "--json"], { expectJson: true });
      expect((loaded.json as { item: { body: string } }).item.body).toBe("body from stdin token");
    });
  });

  describe("additive tag mutations (pm-1lws)", () => {
    it("--add-tags extends the existing list without losing prior tags", async () => {
      await withTempPmPath(async (context) => {
        const id = createTask(context, "add-tags-extends");
        // Sanity: createTask seeds tags=["update","unit"].
        const updated = await runUpdate(
          id,
          { addTags: ["fix,security"], message: "extend tags additively" },
          { path: context.pmPath },
        );
        expect(updated.changed_fields).toContain("tags");
        const item = updated.item as { tags?: string[] };
        expect(item.tags).toEqual(["fix", "security", "unit", "update"]);
      });
    });

    it("--remove-tags prunes entries without touching the rest", async () => {
      await withTempPmPath(async (context) => {
        const id = createTask(context, "remove-tags-prunes");
        const updated = await runUpdate(
          id,
          { removeTags: ["unit"], message: "drop one tag" },
          { path: context.pmPath },
        );
        expect(updated.changed_fields).toContain("tags");
        const item = updated.item as { tags?: string[] };
        expect(item.tags).toEqual(["update"]);
      });
    });

    it("supports combined --tags replace + --add-tags additive + --remove-tags subtraction in one call", async () => {
      await withTempPmPath(async (context) => {
        const id = createTask(context, "tags-combined");
        const updated = await runUpdate(
          id,
          {
            tags: "alpha,beta",
            addTags: ["gamma"],
            removeTags: ["beta"],
            message: "combined tag mutation",
          },
          { path: context.pmPath },
        );
        const item = updated.item as { tags?: string[] };
        // --tags replaces first → [alpha,beta], --add-tags adds gamma → [alpha,beta,gamma],
        // --remove-tags strips beta → [alpha,gamma].
        expect(item.tags).toEqual(["alpha", "gamma"]);
      });
    });

    it("--add-tags accepts CSV inside a single value and repeated --add-tags flags", async () => {
      await withTempPmPath(async (context) => {
        const id = createTask(context, "add-tags-csv");
        const updated = await runUpdate(
          id,
          { addTags: ["alpha,beta", "gamma"], message: "csv and repeated" },
          { path: context.pmPath },
        );
        const item = updated.item as { tags?: string[] };
        expect(item.tags).toEqual(["alpha", "beta", "gamma", "unit", "update"]);
      });
    });

    it("--remove-tags is a no-op when the tag is not present", async () => {
      await withTempPmPath(async (context) => {
        const id = createTask(context, "remove-tags-noop");
        const updated = await runUpdate(
          id,
          { removeTags: ["nonexistent"], message: "remove nothing" },
          { path: context.pmPath },
        );
        const item = updated.item as { tags?: string[] };
        expect(item.tags).toEqual(["unit", "update"]);
      });
    });
  });

  describe("--add-tags / --remove-tags CLI alias contracts (pm-1lws)", () => {
    it("pm update --add-tags flag accepted and extends existing tags", async () => {
      await withTempPmPath(async (context) => {
        const id = createTask(context, "cli-add-tags");
        const result = context.runCli(
          ["update", id, "--add-tags", "fix,security", "--json", "--message", "extend additively"],
          { expectJson: true },
        );
        expect(result.code).toBe(0);
        const item = (result.json as { item: { tags?: string[] } }).item;
        expect(item.tags).toEqual(["fix", "security", "unit", "update"]);
      });
    });

    it("pm update --remove-tags flag accepted and strips entries", async () => {
      await withTempPmPath(async (context) => {
        const id = createTask(context, "cli-remove-tags");
        const result = context.runCli(
          ["update", id, "--remove-tags", "unit", "--json", "--message", "drop one tag"],
          { expectJson: true },
        );
        expect(result.code).toBe(0);
        const item = (result.json as { item: { tags?: string[] } }).item;
        expect(item.tags).toEqual(["update"]);
      });
    });
  });

  describe("--expected/--actual short aliases (pm-1lws)", () => {
    it("pm update accepts --expected and --actual as short forms of --expected-result/--actual-result", async () => {
      await withTempPmPath(async (context) => {
        const created = context.runCli(
          [
            "create",
            "--json",
            "--title",
            "expected-alias-issue",
            "--description",
            "alias test",
            "--type",
            "Issue",
            "--create-mode",
            "progressive",
            "--status",
            "open",
            "--priority",
            "1",
            "--body",
            "",
            "--author",
            "seed-author",
            "--message",
            "create alias issue",
          ],
          { expectJson: true },
        );
        expect(created.code).toBe(0);
        const issueId = (created.json as { item: { id: string } }).item.id;
        const updated = context.runCli(
          [
            "update",
            issueId,
            "--json",
            "--expected",
            "alias should set expected_result",
            "--actual",
            "alias should set actual_result",
            "--message",
            "exercise short aliases",
          ],
          { expectJson: true },
        );
        expect(updated.code).toBe(0);
        const payload = updated.json as {
          changed_fields: string[];
          item: { expected_result?: string; actual_result?: string };
        };
        expect(payload.changed_fields).toEqual(expect.arrayContaining(["expected_result", "actual_result"]));
        expect(payload.item.expected_result).toBe("alias should set expected_result");
        expect(payload.item.actual_result).toBe("alias should set actual_result");
      });
    });
  });

  describe("--blocked-by dependency graph (pm-kyd6)", () => {
    it("creates a blocked_by dependency edge so pm deps reflects the blocker", async () => {
      await withTempPmPath(async (context) => {
        const blockerId = createTask(context, "kyd6-blocker");
        const blockedId = createTask(context, "kyd6-blocked");

        const updated = await runUpdate(
          blockedId,
          { blockedBy: blockerId, message: "block on upstream" },
          { path: context.pmPath },
        );

        expect(updated.changed_fields).toContain("blocked_by");
        expect(updated.changed_fields).toContain("dependencies");
        const item = updated.item as { blocked_by?: string; dependencies?: { id: string; kind: string }[] };
        expect(item.blocked_by).toBe(blockerId);
        expect(item.dependencies).toEqual([
          expect.objectContaining({ id: blockerId, kind: "blocked_by" }),
        ]);

        const graph = await runDeps(blockedId, { format: "graph" }, { path: context.pmPath });
        expect(graph.edge_count).toBe(1);
        expect(graph.graph?.edges).toEqual([
          { from: blockedId, to: blockerId, kind: "blocked_by" },
        ]);
      });
    });

    it("removes the blocked_by edge when the blocker is cleared", async () => {
      await withTempPmPath(async (context) => {
        const blockerId = createTask(context, "kyd6-clear-blocker");
        const blockedId = createTask(context, "kyd6-clear-blocked");
        await runUpdate(blockedId, { blockedBy: blockerId }, { path: context.pmPath });

        const cleared = await runUpdate(
          blockedId,
          { unset: ["blocked-by"], message: "unblock" },
          { path: context.pmPath },
        );

        expect(cleared.changed_fields).toContain("blocked_by");
        expect(cleared.changed_fields).toContain("dependencies");
        const item = cleared.item as { blocked_by?: string; dependencies?: unknown[] };
        expect(item.blocked_by).toBeUndefined();
        expect(item.dependencies).toBeUndefined();

        const graph = await runDeps(blockedId, { format: "graph" }, { path: context.pmPath });
        expect(graph.edge_count).toBe(0);
      });
    });

    it("warns (never blocks) when --blocked-by points at a non-existent item", async () => {
      await withTempPmPath(async (context) => {
        const blockedId = createTask(context, "kyd6-unresolved-blocked");
        const updated = await runUpdate(
          blockedId,
          { blockedBy: "pm-doesnotexist", message: "block on a ghost" },
          { path: context.pmPath },
        );

        // Scalar is still recorded (forward-reference allowed, mirrors create.ts),
        // but no edge is fabricated and the mismatch is surfaced as a warning.
        const item = updated.item as { blocked_by?: string; dependencies?: unknown[] };
        expect(item.blocked_by).toBe("pm-doesnotexist");
        expect(item.dependencies).toBeUndefined();
        expect(updated.warnings).toContain("blocked_by_unresolved:pm-doesnotexist");
      });
    });

    it("repoints the edge to the new blocker without leaving the stale one", async () => {
      await withTempPmPath(async (context) => {
        const firstBlocker = createTask(context, "kyd6-first-blocker");
        const secondBlocker = createTask(context, "kyd6-second-blocker");
        const blockedId = createTask(context, "kyd6-repoint-blocked");
        await runUpdate(blockedId, { blockedBy: firstBlocker }, { path: context.pmPath });

        const repointed = await runUpdate(
          blockedId,
          { blockedBy: secondBlocker, message: "repoint blocker" },
          { path: context.pmPath },
        );

        const item = repointed.item as { dependencies?: { id: string; kind: string }[] };
        const blockedByEdges = (item.dependencies ?? []).filter((dep) => dep.kind === "blocked_by");
        expect(blockedByEdges).toEqual([
          expect.objectContaining({ id: secondBlocker, kind: "blocked_by" }),
        ]);
      });
    });

    it("drops manually added stale blocked_by edges when setting a scalar blocker", async () => {
      await withTempPmPath(async (context) => {
        const staleBlocker = createTask(context, "kyd6-stale-blocker");
        const activeBlocker = createTask(context, "kyd6-active-blocker");
        const blockedId = createTask(context, "kyd6-stale-edge-blocked");
        await runUpdate(
          blockedId,
          { dep: [`id=${staleBlocker},kind=blocked_by`], message: "seed stale blocker edge" },
          { path: context.pmPath },
        );

        const updated = await runUpdate(
          blockedId,
          { blockedBy: activeBlocker, message: "set scalar blocker" },
          { path: context.pmPath },
        );

        const item = updated.item as { blocked_by?: string; dependencies?: { id: string; kind: string }[] };
        expect(item.blocked_by).toBe(activeBlocker);
        const blockedByEdges = (item.dependencies ?? []).filter((dep) => dep.kind === "blocked_by");
        expect(blockedByEdges).toEqual([
          expect.objectContaining({ id: activeBlocker, kind: "blocked_by" }),
        ]);
      });
    });
  });
});

describe("runUpdate per-type workflow enforcement (pm-f4r1)", () => {
  // Seed inline settings.json with a per-type allowed-transition rule for Issue:
  // open -> in_progress and in_progress -> closed only.
  async function seedWorkflowEnforcement(
    context: TempPmContext,
    enforcement: "off" | "warn" | "strict",
  ): Promise<void> {
    const settingsPath = path.join(context.pmPath, "settings.json");
    const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
      governance?: Record<string, unknown>;
      schema?: Record<string, unknown>;
    };
    settings.governance = { ...(settings.governance ?? {}), workflow_enforcement: enforcement };
    settings.schema = {
      ...(settings.schema ?? {}),
      type_workflows: [
        {
          type: "Issue",
          allowed_transitions: [
            ["open", "in_progress"],
            ["in_progress", "closed"],
          ],
        },
      ],
    };
    await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  }

  it("throws under strict on a disallowed transition", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "wf-strict-disallowed", { type: "Issue" });
      await seedWorkflowEnforcement(context, "strict");
      await expect(
        runUpdate(id, { status: "blocked", message: "disallowed jump" }, { path: context.pmPath }),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining("Disallowed transition"),
      });
    });
  });

  it("allows a listed transition under strict", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "wf-strict-allowed", { type: "Issue" });
      await seedWorkflowEnforcement(context, "strict");
      const result = await runUpdate(
        id,
        { status: "in_progress", message: "allowed transition" },
        { path: context.pmPath },
      );
      expect((result.item as { status: string }).status).toBe("in_progress");
      expect(result.warnings).not.toContain(
        expect.stringContaining("workflow_transition_not_allowed"),
      );
    });
  });

  it("surfaces a warning under warn on a disallowed transition but still applies it", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "wf-warn-disallowed", { type: "Issue" });
      await seedWorkflowEnforcement(context, "warn");
      const result = await runUpdate(
        id,
        { status: "blocked", message: "warned transition" },
        { path: context.pmPath },
      );
      expect((result.item as { status: string }).status).toBe("blocked");
      expect(result.warnings.some((warning) => warning.startsWith("workflow_transition_not_allowed"))).toBe(true);
    });
  });

  it("ignores rules entirely when enforcement is off", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "wf-off", { type: "Issue" });
      await seedWorkflowEnforcement(context, "off");
      const result = await runUpdate(
        id,
        { status: "blocked", message: "off ignores rules" },
        { path: context.pmPath },
      );
      expect((result.item as { status: string }).status).toBe("blocked");
      expect(result.warnings.some((warning) => warning.startsWith("workflow_transition_not_allowed"))).toBe(false);
    });
  });

  it("gates a transition toward the close status before the close reroute (strict)", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "wf-strict-close-gate", { type: "Issue" });
      await seedWorkflowEnforcement(context, "strict");
      // open -> closed is not listed (only in_progress -> closed is), so the
      // close-routing path must be gated rather than silently closing the item.
      await expect(
        runUpdate(id, { status: "closed", closeReason: "premature close" }, { path: context.pmPath }),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining("Disallowed transition"),
      });
    });
  });

  it("leaves an unrestricted type unaffected even under strict", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "wf-unrestricted-task", { type: "Task" });
      await seedWorkflowEnforcement(context, "strict");
      const result = await runUpdate(
        id,
        { status: "blocked", message: "task is unrestricted" },
        { path: context.pmPath },
      );
      expect((result.item as { status: string }).status).toBe("blocked");
    });
  });

  // An explicit empty allowed_transitions array is a DENY-ALL rule, not "no
  // rule". It must survive every normalization layer (settings.schema normalize +
  // resolveTypeWorkflows) so the type is NOT treated as unrestricted.
  async function seedDenyAllWorkflow(context: TempPmContext): Promise<void> {
    const settingsPath = path.join(context.pmPath, "settings.json");
    const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
      governance?: Record<string, unknown>;
      schema?: Record<string, unknown>;
    };
    settings.governance = { ...(settings.governance ?? {}), workflow_enforcement: "strict" };
    settings.schema = {
      ...(settings.schema ?? {}),
      type_workflows: [{ type: "Issue", allowed_transitions: [] }],
    };
    await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  }

  it("denies every cross-status transition under an explicit deny-all rule (strict)", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "wf-deny-all", { type: "Issue" });
      await seedDenyAllWorkflow(context);
      await expect(
        runUpdate(id, { status: "in_progress", message: "deny-all blocks this" }, { path: context.pmPath }),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining("Disallowed transition"),
      });
    });
  });

  it("still allows a same-status no-op under an explicit deny-all rule (strict)", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "wf-deny-all-noop", { type: "Issue" });
      await seedDenyAllWorkflow(context);
      const result = await runUpdate(
        id,
        { status: "open", message: "no-op stays allowed" },
        { path: context.pmPath },
      );
      expect((result.item as { status: string }).status).toBe("open");
    });
  });
});
