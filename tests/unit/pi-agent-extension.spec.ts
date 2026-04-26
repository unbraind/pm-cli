import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  PM_TOOL_ACTIONS,
  buildPmCliArgs,
  createPmToolDefinition,
  registerPmTool,
} from "../../.pi/extensions/pm-cli/index.ts";

function schemaForAction(parameters: Record<string, unknown>, action: string): Record<string, unknown> {
  const branches = Array.isArray(parameters.oneOf) ? (parameters.oneOf as Array<Record<string, unknown>>) : [];
  const branch = branches.find((entry) => {
    const properties = entry.properties as Record<string, unknown> | undefined;
    const actionProperty = properties?.action as Record<string, unknown> | undefined;
    return actionProperty?.const === action;
  });
  if (!branch) {
    throw new Error(`Missing schema branch for action "${action}"`);
  }
  return branch;
}

function schemaProperty(schema: Record<string, unknown>, key: string): Record<string, unknown> {
  const properties = schema.properties as Record<string, unknown> | undefined;
  const property = properties?.[key] as Record<string, unknown> | undefined;
  if (!property) {
    throw new Error(`Missing schema property "${key}"`);
  }
  return property;
}

describe("Pi agent extension wrapper for pm", () => {
  it("builds deterministic CLI args for mapped actions", () => {
    const args = buildPmCliArgs({
      action: "create",
      title: "Pi task",
      description: "created via pi tool",
      type: "Task",
      createMode: "progressive",
      status: "open",
      priority: "1",
      tags: "pi,wrapper",
      body: "body",
      deadline: "+1d",
      estimate: "15",
      acceptanceCriteria: "works",
      author: "unit-test",
      message: "create",
      assignee: "pi-owner",
      dep: ["id=pm-seed,kind=related"],
      comment: ["author=unit-test,text=seed comment"],
      note: ["author=unit-test,text=seed note"],
      learning: ["author=unit-test,text=seed learning"],
      linkedFile: ["path=README.md,scope=project"],
      linkedTest: ["command=node dist/cli.js --version,scope=project"],
      doc: ["path=README.md,scope=project"],
      reminder: ["at=+1d,text=seed reminder"],
      event: ["start=+1d,title=seed event"],
      path: "/tmp/pm-sandbox",
      noPager: true,
    });

    expect(args).toContain("--json");
    expect(args).toContain("--path");
    expect(args).toContain("/tmp/pm-sandbox");
    expect(args).toContain("--no-pager");
    expect(args.slice(args.indexOf("create"))).toEqual(
      expect.arrayContaining([
        "create",
        "--title",
        "Pi task",
        "--description",
        "created via pi tool",
        "--type",
        "Task",
        "--create-mode",
        "progressive",
        "--status",
        "open",
        "--priority",
        "1",
        "--assignee",
        "pi-owner",
        "--reminder",
        "at=+1d,text=seed reminder",
        "--event",
        "start=+1d,title=seed event",
      ]),
    );
  });

  it("preserves explicit empty-string values for empty-allowed CLI flags", () => {
    const createArgs = buildPmCliArgs({
      action: "create",
      title: "Pi task",
      description: "",
      type: "Task",
      schedulePreset: "lightweight",
      status: "open",
      priority: "1",
      tags: "",
      body: "",
      deadline: "+1d",
      estimate: "0",
      acceptanceCriteria: "",
      author: "unit-test",
      message: "",
      assignee: "unit-assignee",
    });
    expect(createArgs).toEqual(
      expect.arrayContaining([
        "--description",
        "",
        "--tags",
        "",
        "--body",
        "",
        "--acceptance-criteria",
        "",
        "--message",
        "",
      ]),
    );

    const updateArgs = buildPmCliArgs({
      action: "update",
      id: "pm-a1b2",
      title: "new title",
      description: "",
      body: "",
      closeReason: "legacy close reason",
      tags: "",
      acceptanceCriteria: "",
      message: "",
    });
    expect(updateArgs).toEqual(
      expect.arrayContaining([
        "--title",
        "new title",
        "--description",
        "",
        "--body",
        "",
        "--close-reason",
        "legacy close reason",
        "--tags",
        "",
        "--acceptance-criteria",
        "",
        "--message",
        "",
      ]),
    );

    const appendArgs = buildPmCliArgs({
      action: "append",
      id: "pm-a1b2",
      body: "",
      message: "",
    });
    expect(appendArgs).toEqual(expect.arrayContaining(["--body", "", "--message", ""]));
  });

  it("accepts numeric scalar inputs for numeric CLI flags", () => {
    const configArgs = buildPmCliArgs({
      action: "config",
      scope: "project",
      configAction: "set",
      key: "definition-of-done",
      criterion: ["tests pass", "linked files/tests/docs present"],
      policy: "strict_error",
    });
    expect(configArgs).toEqual([
      "--json",
      "config",
      "project",
      "set",
      "definition-of-done",
      "--criterion",
      "tests pass",
      "--criterion",
      "linked files/tests/docs present",
      "--policy",
      "strict_error",
    ]);

    const configListArgs = buildPmCliArgs({
      action: "config",
      scope: "project",
      configAction: "list",
    });
    expect(configListArgs).toEqual(["--json", "config", "project", "list"]);

    const configExportArgs = buildPmCliArgs({
      action: "config",
      scope: "project",
      configAction: "export",
    });
    expect(configExportArgs).toEqual(["--json", "config", "project", "export"]);

    const createArgs = buildPmCliArgs({
      action: "create",
      title: "Pi numeric task",
      description: "",
      type: "Task",
      schedulePreset: "lightweight",
      status: "open",
      priority: 1,
      tags: "",
      body: "",
      deadline: "none",
      estimate: 0,
      acceptanceCriteria: "",
      assignee: "none",
    });
    expect(createArgs).toEqual(expect.arrayContaining(["--priority", "1", "--estimate", "0"]));

    const listArgs = buildPmCliArgs({
      action: "list-open",
      priority: 2,
      limit: 5,
    });
    expect(listArgs).toEqual(["--json", "list-open", "--priority", "2", "--limit", "5"]);

    const listDraftArgs = buildPmCliArgs({
      action: "list-draft",
      limit: 3,
    });
    expect(listDraftArgs).toEqual(["--json", "list-draft", "--limit", "3"]);

    const testAllArgs = buildPmCliArgs({
      action: "test-all",
      status: "in_progress",
      limit: 5,
      offset: 2,
      timeout: 1800,
    });
    expect(testAllArgs).toEqual([
      "--json",
      "test-all",
      "--status",
      "in_progress",
      "--limit",
      "5",
      "--offset",
      "2",
      "--timeout",
      "1800",
    ]);

    const invalidNumericArgs = buildPmCliArgs({
      action: "list-open",
      limit: Number.NaN,
    });
    expect(invalidNumericArgs).toEqual(["--json", "list-open"]);
  });

  it("maps canonical create and update parity fields for planning and issue metadata", () => {
    const createArgs = buildPmCliArgs({
      action: "create",
      title: "Pi parity task",
      description: "full metadata",
      type: "Task",
      schedulePreset: "lightweight",
      status: "open",
      priority: "1",
      tags: "pi,parity",
      body: "",
      deadline: "none",
      estimate: "30",
      acceptanceCriteria: "all fields map",
      author: "pi-bot",
      message: "create parity task",
      assignee: "none",
      parent: "none",
      reviewer: "none",
      risk: "medium",
      confidence: "high",
      sprint: "sprint-1",
      release: "v0.1",
      blockedBy: "none",
      blockedReason: "none",
      unblockNote: "none",
      reporter: "none",
      severity: "none",
      environment: "none",
      reproSteps: "none",
      resolution: "none",
      expectedResult: "none",
      actualResult: "none",
      affectedVersion: "none",
      fixedVersion: "none",
      component: "none",
      regression: false,
      customerImpact: "none",
      definitionOfReady: "ready",
      order: 7,
      goal: "Release-hardening",
      objective: "Parity",
      value: "Complete wrapper coverage",
      impact: "No metadata loss",
      outcome: "Pi wrapper matches CLI",
      whyNow: "Docs already require it",
      dep: ["none"],
      comment: ["none"],
      note: ["none"],
      learning: ["none"],
      linkedFile: ["none"],
      linkedTest: ["none"],
      doc: ["none"],
    });

    expect(createArgs).toEqual(
      expect.arrayContaining([
        "--parent",
        "none",
        "--reviewer",
        "none",
        "--risk",
        "medium",
        "--confidence",
        "high",
        "--sprint",
        "sprint-1",
        "--release",
        "v0.1",
        "--blocked-by",
        "none",
        "--blocked-reason",
        "none",
        "--unblock-note",
        "none",
        "--reporter",
        "none",
        "--severity",
        "none",
        "--environment",
        "none",
        "--repro-steps",
        "none",
        "--resolution",
        "none",
        "--expected-result",
        "none",
        "--actual-result",
        "none",
        "--affected-version",
        "none",
        "--fixed-version",
        "none",
        "--component",
        "none",
        "--regression",
        "false",
        "--schedule-preset",
        "lightweight",
        "--customer-impact",
        "none",
        "--definition-of-ready",
        "ready",
        "--order",
        "7",
        "--goal",
        "Release-hardening",
        "--objective",
        "Parity",
        "--value",
        "Complete wrapper coverage",
        "--impact",
        "No metadata loss",
        "--outcome",
        "Pi wrapper matches CLI",
        "--why-now",
        "Docs already require it",
      ]),
    );

    const updateArgs = buildPmCliArgs({
      action: "update",
      id: "pm-a1b2",
      body: "replacement body",
      blockedBy: "pm-z9y8",
      blockedReason: "",
      unblockNote: "waiting on merge",
      regression: true,
      definitionOfReady: "",
      order: "9",
      customerImpact: "none",
      expectedResult: "fixed",
      actualResult: "broken",
      whyNow: "still urgent",
      closeReason: "none",
      dep: ["id=pm-a1b3,kind=related"],
      depRemove: ["id=pm-a1b4,kind=blocks"],
      replaceDeps: true,
      replaceTests: true,
    });

    expect(updateArgs).toEqual(
      expect.arrayContaining([
        "update",
        "pm-a1b2",
        "--body",
        "replacement body",
        "--blocked-by",
        "pm-z9y8",
        "--unblock-note",
        "waiting on merge",
        "--regression",
        "true",
        "--definition-of-ready",
        "",
        "--order",
        "9",
        "--customer-impact",
        "none",
        "--expected-result",
        "fixed",
        "--actual-result",
        "broken",
        "--why-now",
        "still urgent",
        "--close-reason",
        "none",
        "--dep",
        "id=pm-a1b3,kind=related",
        "--dep-remove",
        "id=pm-a1b4,kind=blocks",
        "--replace-deps",
        "--replace-tests",
      ]),
    );
  });

  it("validates required positional arguments for action mappings", () => {
    expect(() => buildPmCliArgs({ action: "config" })).toThrow('Action "config" requires "scope".');
    expect(() => buildPmCliArgs({ action: "config", scope: "project" })).toThrow(
      'Action "config" requires "configAction".',
    );
    expect(() => buildPmCliArgs({ action: "config", scope: "project", configAction: "set" })).toThrow(
      'Action "config" requires "key".',
    );
    expect(() =>
      buildPmCliArgs({
        action: "config",
        scope: "project",
        configAction: "nope",
      }),
    ).toThrow('Unsupported configAction "nope". Expected get|set|list|export.');
    expect(() => buildPmCliArgs({ action: "get" })).toThrow('Action "get" requires "id".');
    expect(() => buildPmCliArgs({ action: "restore", id: "pm-a1b2" })).toThrow(
      'Action "restore" requires "target".',
    );
    expect(() => buildPmCliArgs({ action: "extension-install" })).toThrow(
      'Action "extension-install" requires "target" or "github".',
    );
    expect(() => buildPmCliArgs({ action: "extension-uninstall" })).toThrow(
      'Action "extension-uninstall" requires "target".',
    );
    expect(() => buildPmCliArgs({ action: "extension-activate" })).toThrow(
      'Action "extension-activate" requires "target".',
    );
    expect(() => buildPmCliArgs({ action: "extension-deactivate" })).toThrow(
      'Action "extension-deactivate" requires "target".',
    );
    expect(() => buildPmCliArgs({ action: "close", id: "pm-a1b2" })).toThrow('Action "close" requires "text".');
    expect(() => buildPmCliArgs({ action: "delete" })).toThrow('Action "delete" requires "id".');
    expect(() => buildPmCliArgs({ action: "search" })).toThrow('Action "search" requires "query".');
    expect(() => buildPmCliArgs({ action: "completion" })).toThrow('Action "completion" requires "shell".');
    expect(() => buildPmCliArgs({ action: "unknown-action" })).toThrow('Unsupported action "unknown-action".');
  });

  it("registers pm tool and executes with pm->node fallback", async () => {
    const registerToolSpy = vi.fn();
    const execSpy = vi
      .fn()
      .mockResolvedValueOnce({
        code: 127,
        stdout: "",
        stderr: "pm: command not found",
      })
      .mockResolvedValueOnce({
        code: 0,
        stdout: "{\"ok\":true}",
        stderr: "",
      });

    const api = {
      registerTool: registerToolSpy,
      exec: execSpy,
    };

    registerPmTool(api);
    expect(registerToolSpy).toHaveBeenCalledTimes(1);
    const tool = registerToolSpy.mock.calls[0]?.[0];
    expect(tool.name).toBe("pm");

    expect(tool.parameters).toMatchObject({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      "x-schema-version": "4.0.0",
    });

    const oneOf = (tool.parameters as { oneOf?: Array<Record<string, unknown>> }).oneOf;
    expect(Array.isArray(oneOf)).toBe(true);
    const actionValues = (oneOf as Array<Record<string, unknown>>)
      .map((entry) => ((entry.properties as Record<string, unknown> | undefined)?.action as { const?: string } | undefined)?.const)
      .filter((value): value is string => typeof value === "string")
      .sort((left, right) => left.localeCompare(right));
    expect(actionValues).toEqual([...PM_TOOL_ACTIONS].sort((left, right) => left.localeCompare(right)));

    const searchSchema = schemaForAction(tool.parameters as Record<string, unknown>, "search");
    expect(searchSchema.required).toEqual(["action"]);
    expect(searchSchema.anyOf).toEqual(
      expect.arrayContaining([expect.objectContaining({ required: ["query"] }), expect.objectContaining({ required: ["keywords"] })]),
    );
    expect(schemaProperty(searchSchema, "includeLinked").type).toBe("boolean");
    expect(schemaProperty(searchSchema, "titleExact").type).toBe("boolean");
    expect(schemaProperty(searchSchema, "phraseExact").type).toBe("boolean");
    expect(schemaProperty(searchSchema, "compact").type).toBe("boolean");
    expect(schemaProperty(searchSchema, "full").type).toBe("boolean");
    expect(schemaProperty(searchSchema, "fields").type).toBe("string");

    const listOpenSchema = schemaForAction(tool.parameters as Record<string, unknown>, "list-open");
    expect(schemaProperty(listOpenSchema, "parent").type).toBe("string");
    expect(schemaProperty(listOpenSchema, "compact").type).toBe("boolean");
    expect(schemaProperty(listOpenSchema, "includeBody").type).toBe("boolean");
    expect(schemaProperty(listOpenSchema, "fields").type).toBe("string");
    expect(schemaProperty(listOpenSchema, "sort").enum).toEqual([
      "priority",
      "deadline",
      "updated_at",
      "created_at",
      "title",
      "parent",
    ]);

    const aggregateSchema = schemaForAction(tool.parameters as Record<string, unknown>, "aggregate");
    expect(aggregateSchema.required).toEqual(["action"]);
    expect(schemaProperty(aggregateSchema, "groupBy").type).toBe("string");
    expect(schemaProperty(aggregateSchema, "count").type).toBe("boolean");
    expect(schemaProperty(aggregateSchema, "includeUnparented").type).toBe("boolean");
    expect(schemaProperty(aggregateSchema, "status").type).toBe("string");

    const dedupeSchema = schemaForAction(tool.parameters as Record<string, unknown>, "dedupe-audit");
    expect(dedupeSchema.required).toEqual(["action"]);
    expect(schemaProperty(dedupeSchema, "mode").enum).toEqual(
      expect.arrayContaining(["title_exact", "title_fuzzy", "parent_scope"]),
    );
    expect(schemaProperty(dedupeSchema, "threshold").anyOf).toEqual(
      expect.arrayContaining([{ type: "string" }, { type: "number" }]),
    );

    const extensionInstallSchema = schemaForAction(tool.parameters as Record<string, unknown>, "extension-install");
    expect(extensionInstallSchema.required).toEqual(["action"]);
    expect(extensionInstallSchema.anyOf).toEqual(
      expect.arrayContaining([expect.objectContaining({ required: ["target"] }), expect.objectContaining({ required: ["github"] })]),
    );
    expect(schemaProperty(extensionInstallSchema, "scope").enum).toEqual(["project", "global"]);
    expect(schemaProperty(extensionInstallSchema, "github").type).toBe("string");
    expect(schemaProperty(extensionInstallSchema, "ref").type).toBe("string");

    const extensionActivateSchema = schemaForAction(tool.parameters as Record<string, unknown>, "extension-activate");
    expect(extensionActivateSchema.required).toEqual(expect.arrayContaining(["action", "target"]));
    expect(schemaProperty(extensionActivateSchema, "scope").enum).toEqual(["project", "global"]);

    const extensionAdoptSchema = schemaForAction(tool.parameters as Record<string, unknown>, "extension-adopt");
    expect(extensionAdoptSchema.required).toEqual(expect.arrayContaining(["action", "target"]));
    expect(schemaProperty(extensionAdoptSchema, "scope").enum).toEqual(["project", "global"]);
    expect(schemaProperty(extensionAdoptSchema, "github").type).toBe("string");
    expect(schemaProperty(extensionAdoptSchema, "ref").type).toBe("string");

    const extensionAdoptAllSchema = schemaForAction(tool.parameters as Record<string, unknown>, "extension-adopt-all");
    expect(extensionAdoptAllSchema.required).toEqual(["action"]);
    expect(schemaProperty(extensionAdoptAllSchema, "scope").enum).toEqual(["project", "global"]);

    const extensionManageSchema = schemaForAction(tool.parameters as Record<string, unknown>, "extension-manage");
    expect(extensionManageSchema.required).toEqual(["action"]);
    expect(schemaProperty(extensionManageSchema, "runtimeProbe").type).toBe("boolean");
    expect(schemaProperty(extensionManageSchema, "fixManagedState").type).toBe("boolean");

    const extensionDoctorSchema = schemaForAction(tool.parameters as Record<string, unknown>, "extension-doctor");
    expect(extensionDoctorSchema.required).toEqual(["action"]);
    expect(schemaProperty(extensionDoctorSchema, "scope").enum).toEqual(["project", "global"]);
    expect(schemaProperty(extensionDoctorSchema, "detail").enum).toEqual(["summary", "deep"]);
    expect(schemaProperty(extensionDoctorSchema, "trace").type).toBe("boolean");
    expect(schemaProperty(extensionDoctorSchema, "fixManagedState").type).toBe("boolean");
    expect(schemaProperty(extensionDoctorSchema, "strictExit").type).toBe("boolean");
    expect(schemaProperty(extensionDoctorSchema, "failOnWarn").type).toBe("boolean");

    const validateSchema = schemaForAction(tool.parameters as Record<string, unknown>, "validate");
    expect(validateSchema.required).toEqual(["action"]);
    expect(schemaProperty(validateSchema, "checkFiles").type).toBe("boolean");
    expect(schemaProperty(validateSchema, "scanMode").enum).toEqual(["default", "tracked-all", "tracked-all-strict"]);
    expect(schemaProperty(validateSchema, "includePmInternals").type).toBe("boolean");
    expect(schemaProperty(validateSchema, "verboseFileLists").type).toBe("boolean");
    expect(schemaProperty(validateSchema, "strictExit").type).toBe("boolean");
    expect(schemaProperty(validateSchema, "failOnWarn").type).toBe("boolean");
    expect(schemaProperty(validateSchema, "checkLifecycle").type).toBe("boolean");
    expect(schemaProperty(validateSchema, "checkStaleBlockers").type).toBe("boolean");
    expect(schemaProperty(validateSchema, "checkCommandReferences").type).toBe("boolean");

    const healthSchema = schemaForAction(tool.parameters as Record<string, unknown>, "health");
    expect(healthSchema.required).toEqual(["action"]);
    expect(schemaProperty(healthSchema, "strictDirectories").type).toBe("boolean");
    expect(schemaProperty(healthSchema, "strictExit").type).toBe("boolean");
    expect(schemaProperty(healthSchema, "failOnWarn").type).toBe("boolean");
    expect(schemaProperty(healthSchema, "checkOnly").type).toBe("boolean");
    expect(schemaProperty(healthSchema, "noRefresh").type).toBe("boolean");
    expect(schemaProperty(healthSchema, "refreshVectors").type).toBe("boolean");
    expect(schemaProperty(healthSchema, "verboseStaleItems").type).toBe("boolean");

    const releaseSchema = schemaForAction(tool.parameters as Record<string, unknown>, "release");
    expect(releaseSchema.required).toEqual(expect.arrayContaining(["action", "id"]));
    expect(schemaProperty(releaseSchema, "allowAuditRelease").type).toBe("boolean");

    const notesSchema = schemaForAction(tool.parameters as Record<string, unknown>, "notes");
    expect(notesSchema.required).toEqual(expect.arrayContaining(["action", "id"]));
    expect(schemaProperty(notesSchema, "allowAuditNote").type).toBe("boolean");
    expect(schemaProperty(notesSchema, "allowAuditComment").type).toBe("boolean");

    const learningsSchema = schemaForAction(tool.parameters as Record<string, unknown>, "learnings");
    expect(learningsSchema.required).toEqual(expect.arrayContaining(["action", "id"]));
    expect(schemaProperty(learningsSchema, "allowAuditLearning").type).toBe("boolean");
    expect(schemaProperty(learningsSchema, "allowAuditComment").type).toBe("boolean");

    const commentsAuditSchema = schemaForAction(tool.parameters as Record<string, unknown>, "comments-audit");
    expect(schemaProperty(commentsAuditSchema, "limit").anyOf).toEqual(
      expect.arrayContaining([{ type: "string" }, { type: "number" }]),
    );
    expect(schemaProperty(commentsAuditSchema, "limitItems").anyOf).toEqual(
      expect.arrayContaining([{ type: "string" }, { type: "number" }]),
    );

    const calendarSchema = schemaForAction(tool.parameters as Record<string, unknown>, "calendar");
    expect(schemaProperty(calendarSchema, "view").type).toBe("string");
    expect(schemaProperty(calendarSchema, "past").type).toBe("boolean");
    expect(schemaProperty(calendarSchema, "fullPeriod").type).toBe("boolean");
    expect(schemaProperty(calendarSchema, "include").type).toBe("string");
    expect(schemaProperty(calendarSchema, "recurrenceLookaheadDays").anyOf).toEqual(
      expect.arrayContaining([{ type: "string" }, { type: "number" }]),
    );
    expect(schemaProperty(calendarSchema, "recurrenceLookbackDays").anyOf).toEqual(
      expect.arrayContaining([{ type: "string" }, { type: "number" }]),
    );
    expect(schemaProperty(calendarSchema, "occurrenceLimit").anyOf).toEqual(
      expect.arrayContaining([{ type: "string" }, { type: "number" }]),
    );

    const activitySchema = schemaForAction(tool.parameters as Record<string, unknown>, "activity");
    expect(schemaProperty(activitySchema, "id").type).toBe("string");
    expect(schemaProperty(activitySchema, "op").type).toBe("string");
    expect(schemaProperty(activitySchema, "author").type).toBe("string");
    expect(schemaProperty(activitySchema, "from").type).toBe("string");
    expect(schemaProperty(activitySchema, "to").type).toBe("string");
    expect(schemaProperty(activitySchema, "limit").anyOf).toEqual(
      expect.arrayContaining([{ type: "string" }, { type: "number" }]),
    );
    expect(schemaProperty(activitySchema, "stream").anyOf).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "boolean" }), expect.objectContaining({ type: "string" })]),
    );

    const createSchema = schemaForAction(tool.parameters as Record<string, unknown>, "create");
    expect(createSchema.required).toEqual(expect.arrayContaining(["action", "title", "description", "type", "status", "priority"]));
    expect(schemaProperty(createSchema, "reminder")).toMatchObject({
      type: "array",
      items: { type: "string" },
    });
    expect(schemaProperty(createSchema, "event")).toMatchObject({
      type: "array",
      items: { type: "string" },
    });
    expect(schemaProperty(createSchema, "blockedBy").type).toBe("string");
    expect(schemaProperty(createSchema, "schedulePreset").type).toBe("string");
    expect(schemaProperty(createSchema, "schedulePreset").enum).toEqual(["lightweight"]);
    expect(schemaProperty(createSchema, "definitionOfReady").type).toBe("string");
    expect(schemaProperty(createSchema, "priority").anyOf).toEqual(
      expect.arrayContaining([{ type: "string" }, { type: "number" }]),
    );
    expect(schemaProperty(createSchema, "estimate").anyOf).toEqual(
      expect.arrayContaining([{ type: "string" }, { type: "number" }]),
    );
    expect(schemaProperty(createSchema, "regression").anyOf).toEqual(
      expect.arrayContaining([{ type: "boolean" }, { type: "string" }, { type: "number" }]),
    );

    const updateSchema = schemaForAction(tool.parameters as Record<string, unknown>, "update");
    expect(updateSchema.required).toEqual(expect.arrayContaining(["action", "id"]));
    expect(schemaProperty(updateSchema, "closeReason").type).toBe("string");
    expect(schemaProperty(updateSchema, "replaceTests").type).toBe("boolean");
    expect(schemaProperty(updateSchema, "depRemove")).toMatchObject({
      type: "array",
      items: { type: "string" },
    });

    const updateManySchema = schemaForAction(tool.parameters as Record<string, unknown>, "update-many");
    expect(updateManySchema.required).toEqual(["action"]);
    expect(schemaProperty(updateManySchema, "filterStatus").type).toBe("string");
    expect(schemaProperty(updateManySchema, "filterAssigneeFilter").enum).toEqual(["assigned", "unassigned"]);
    expect(schemaProperty(updateManySchema, "rollback").type).toBe("string");
    expect(schemaProperty(updateManySchema, "noCheckpoint").type).toBe("boolean");
    expect(schemaProperty(updateManySchema, "allowAuditDepUpdate").type).toBe("boolean");

    const templatesSaveSchema = schemaForAction(tool.parameters as Record<string, unknown>, "templates-save");
    const templatesSaveProperties = templatesSaveSchema.properties as Record<string, unknown>;
    expect(templatesSaveProperties.createMode).toBeUndefined();
    expect(templatesSaveProperties.schedulePreset).toBeUndefined();
    expect(templatesSaveProperties.unset).toBeUndefined();
    expect(templatesSaveProperties.clearDeps).toBeUndefined();

    const completionSchema = schemaForAction(tool.parameters as Record<string, unknown>, "completion");
    expect(completionSchema.required).toEqual(expect.arrayContaining(["action", "shell"]));
    expect(schemaProperty(completionSchema, "shell").type).toBe("string");
    expect(schemaProperty(completionSchema, "eagerTags").type).toBe("boolean");

    const contractsSchema = schemaForAction(tool.parameters as Record<string, unknown>, "contracts");
    expect(contractsSchema.required).toEqual(["action"]);
    expect(schemaProperty(contractsSchema, "contractAction").type).toBe("string");
    expect(schemaProperty(contractsSchema, "command").type).toBe("string");
    expect(schemaProperty(contractsSchema, "schemaOnly").type).toBe("boolean");
    expect(schemaProperty(contractsSchema, "flagsOnly").type).toBe("boolean");
    expect(schemaProperty(contractsSchema, "availabilityOnly").type).toBe("boolean");
    expect(schemaProperty(contractsSchema, "runtimeOnly").type).toBe("boolean");
    expect(schemaProperty(contractsSchema, "activeOnly").type).toBe("boolean");

    const testSchema = schemaForAction(tool.parameters as Record<string, unknown>, "test");
    expect(schemaProperty(testSchema, "failOnEmptyTestRun").type).toBe("boolean");
    expect(schemaProperty(testSchema, "overrideLinkedPmContext").type).toBe("boolean");

    const testAllSchema = schemaForAction(tool.parameters as Record<string, unknown>, "test-all");
    expect(schemaProperty(testAllSchema, "timeout").anyOf).toEqual(
      expect.arrayContaining([{ type: "string" }, { type: "number" }]),
    );
    expect(schemaProperty(testAllSchema, "limit").anyOf).toEqual(
      expect.arrayContaining([{ type: "string" }, { type: "number" }]),
    );
    expect(schemaProperty(testAllSchema, "offset").anyOf).toEqual(
      expect.arrayContaining([{ type: "string" }, { type: "number" }]),
    );
    expect(schemaProperty(testAllSchema, "status").type).toBe("string");
    expect(schemaProperty(testAllSchema, "envSet")).toMatchObject({
      type: "array",
      items: { type: "string" },
    });
    expect(schemaProperty(testAllSchema, "envClear")).toMatchObject({
      type: "array",
      items: { type: "string" },
    });
    expect(schemaProperty(testAllSchema, "sharedHostSafe").type).toBe("boolean");
    expect(schemaProperty(testAllSchema, "pmContext").enum).toEqual(["schema", "tracker", "auto"]);
    expect(schemaProperty(testAllSchema, "overrideLinkedPmContext").type).toBe("boolean");
    expect(schemaProperty(testAllSchema, "failOnContextMismatch").type).toBe("boolean");
    expect(schemaProperty(testAllSchema, "failOnSkipped").type).toBe("boolean");
    expect(schemaProperty(testAllSchema, "failOnEmptyTestRun").type).toBe("boolean");
    expect(schemaProperty(testAllSchema, "requireAssertionsForPm").type).toBe("boolean");

    const beadsImportSchema = schemaForAction(tool.parameters as Record<string, unknown>, "beads-import");
    expect(beadsImportSchema.required).toEqual(["action"]);
    expect(schemaProperty(beadsImportSchema, "file").type).toBe("string");
    expect(schemaProperty(beadsImportSchema, "preserveSourceIds").type).toBe("boolean");

    const result = await tool.execute("call-1", { action: "stats" });
    expect(execSpy).toHaveBeenCalledTimes(2);
    expect(execSpy.mock.calls[0]?.[0]).toBe("pm");
    expect(execSpy.mock.calls[1]?.[0]).toBe("node");
    const nodeFallbackArgs = execSpy.mock.calls[1]?.[1];
    const fallbackCliPath = String(nodeFallbackArgs?.[0] ?? "");
    const normalizedFallbackCliPath = fallbackCliPath.replaceAll("\\", "/");
    expect(fallbackCliPath.length).toBeGreaterThan(0);
    expect(path.isAbsolute(fallbackCliPath)).toBe(true);
    expect(normalizedFallbackCliPath).toMatch(/\/pm-cli\/dist\/cli\.js$/);
    expect(fs.existsSync(fallbackCliPath)).toBe(true);
    expect(nodeFallbackArgs).toEqual(expect.arrayContaining(["--json", "stats"]));
    expect(result.isError).toBe(false);
    expect(result.content[0]?.text).toBe("{\"ok\":true}");
    expect(result.details).toMatchObject({
      action: "stats",
      ok: true,
      exit_code: 0,
      invocation: {
        command: "node",
      },
    });
  });

  it("supports direct tool definition creation", async () => {
    const api = {
      registerTool: vi.fn(),
      exec: vi.fn().mockResolvedValue({
        code: 0,
        stdout: "{\"items\":[]}",
        stderr: "",
      }),
    };
    const tool = createPmToolDefinition(api);
    expect(tool.name).toBe("pm");

    const onUpdate = vi.fn();
    const result = await tool.execute("call-2", { action: "list-open", limit: "5" }, undefined, onUpdate);
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(result.details).toMatchObject({
      action: "list-open",
      ok: true,
    });
  });

  it("maps extended action set to deterministic CLI args", () => {
    expect(
      buildPmCliArgs({
        action: "list-all",
        type: "Task",
        tag: "pi",
        priority: "1",
        parent: "pm-epic01",
        deadlineBefore: "2026-12-31T00:00:00.000Z",
        deadlineAfter: "2026-01-01T00:00:00.000Z",
        limit: "20",
      }),
    ).toEqual([
      "--json",
      "list-all",
      "--type",
      "Task",
      "--tag",
      "pi",
      "--priority",
      "1",
      "--deadline-before",
      "2026-12-31T00:00:00.000Z",
      "--deadline-after",
      "2026-01-01T00:00:00.000Z",
      "--parent",
      "pm-epic01",
      "--limit",
      "20",
    ]);

    expect(
      buildPmCliArgs({
        action: "list-open",
        compact: true,
        includeBody: true,
        fields: "id,title,parent,type",
        sort: "deadline",
        order: "asc",
      }),
    ).toEqual([
      "--json",
      "list-open",
      "--fields",
      "id,title,parent,type",
      "--sort",
      "deadline",
      "--order",
      "asc",
      "--compact",
      "--include-body",
    ]);

    expect(
      buildPmCliArgs({
        action: "aggregate",
        groupBy: "parent,type",
        count: true,
        includeUnparented: true,
        status: "open",
        type: "Feature",
      }),
    ).toEqual([
      "--json",
      "aggregate",
      "--group-by",
      "parent,type",
      "--status",
      "open",
      "--type",
      "Feature",
      "--count",
      "--include-unparented",
    ]);

    expect(
      buildPmCliArgs({
        action: "dedupe-audit",
        mode: "title_fuzzy",
        threshold: 0.8,
        status: "open",
      }),
    ).toEqual(["--json", "dedupe-audit", "--mode", "title_fuzzy", "--threshold", "0.8", "--status", "open"]);

    expect(
      buildPmCliArgs({
        action: "update-many",
        filterStatus: "open",
        filterType: "Task",
        filterTag: "pi",
        filterPriority: 1,
        filterAssignee: "pi-bot",
        filterAssigneeFilter: "assigned",
        filterParent: "pm-epic01",
        filterSprint: "sprint-7",
        filterRelease: "vnext",
        limit: 5,
        offset: 1,
        dryRun: true,
        noCheckpoint: true,
        status: "in_progress",
        assignee: "pi-owner",
        parent: "pm-feature01",
        blockedBy: "pm-dep01",
        blockedReason: "waiting on dependency",
        unblockNote: "resume after merge",
        dep: ["id=pm-dep01,kind=related"],
        replaceDeps: true,
        replaceTests: true,
        allowAuditDepUpdate: true,
      }),
    ).toEqual(
      expect.arrayContaining([
        "--json",
        "update-many",
        "--filter-status",
        "open",
        "--filter-type",
        "Task",
        "--filter-tag",
        "pi",
        "--filter-priority",
        "1",
        "--filter-assignee",
        "pi-bot",
        "--filter-assignee-filter",
        "assigned",
        "--filter-parent",
        "pm-epic01",
        "--filter-sprint",
        "sprint-7",
        "--filter-release",
        "vnext",
        "--limit",
        "5",
        "--offset",
        "1",
        "--dry-run",
        "--no-checkpoint",
        "--status",
        "in_progress",
        "--assignee",
        "pi-owner",
        "--parent",
        "pm-feature01",
        "--blocked-by",
        "pm-dep01",
        "--blocked-reason",
        "waiting on dependency",
        "--unblock-note",
        "resume after merge",
        "--dep",
        "id=pm-dep01,kind=related",
        "--replace-deps",
        "--replace-tests",
        "--allow-audit-dep-update",
      ]),
    );

    expect(
      buildPmCliArgs({
        action: "extension-install",
        target: "github.com/unbraind/pm-cli/pi",
        scope: "project",
      }),
    ).toEqual(["--json", "extension", "--install", "--project", "github.com/unbraind/pm-cli/pi"]);

    expect(
      buildPmCliArgs({
        action: "extension-install",
        github: "unbraind/pm-cli/pi",
        scope: "global",
        ref: "main",
      }),
    ).toEqual(["--json", "extension", "--install", "--global", "--github", "unbraind/pm-cli/pi", "--ref", "main"]);

    expect(
      buildPmCliArgs({
        action: "extension-uninstall",
        target: "sample-ext",
        scope: "project",
      }),
    ).toEqual(["--json", "extension", "--uninstall", "sample-ext", "--project"]);

    expect(
      buildPmCliArgs({
        action: "extension-explore",
        scope: "project",
      }),
    ).toEqual(["--json", "extension", "--explore", "--project"]);

    expect(
      buildPmCliArgs({
        action: "extension-manage",
        scope: "global",
      }),
    ).toEqual(["--json", "extension", "--manage", "--global"]);

    expect(
      buildPmCliArgs({
        action: "extension-manage",
        scope: "project",
        runtimeProbe: true,
        fixManagedState: true,
      }),
    ).toEqual(["--json", "extension", "--manage", "--project", "--runtime-probe", "--fix-managed-state"]);

    expect(
      buildPmCliArgs({
        action: "extension-doctor",
        scope: "project",
        detail: "deep",
        strictExit: true,
        failOnWarn: true,
      }),
    ).toEqual(["--json", "extension", "--doctor", "--project", "--detail", "deep", "--strict-exit", "--fail-on-warn"]);

    expect(
      buildPmCliArgs({
        action: "extension-doctor",
        scope: "project",
        detail: "deep",
        trace: true,
        fixManagedState: true,
      }),
    ).toEqual(["--json", "extension", "--doctor", "--project", "--detail", "deep", "--trace", "--fix-managed-state"]);

    expect(
      buildPmCliArgs({
        action: "extension-activate",
        target: "sample-ext",
        scope: "project",
      }),
    ).toEqual(["--json", "extension", "--activate", "sample-ext", "--project"]);

    expect(
      buildPmCliArgs({
        action: "extension-adopt",
        target: "sample-ext",
        scope: "project",
        github: "owner/repo/sample-ext",
        ref: "main",
      }),
    ).toEqual([
      "--json",
      "extension",
      "--adopt",
      "sample-ext",
      "--project",
      "--github",
      "owner/repo/sample-ext",
      "--ref",
      "main",
    ]);

    expect(
      buildPmCliArgs({
        action: "extension-adopt-all",
        scope: "global",
      }),
    ).toEqual(["--json", "extension", "--adopt-all", "--global"]);

    expect(
      buildPmCliArgs({
        action: "extension-deactivate",
        target: "sample-ext",
        scope: "global",
      }),
    ).toEqual(["--json", "extension", "--deactivate", "sample-ext", "--global"]);

    expect(
      buildPmCliArgs({
        action: "validate",
        checkFiles: true,
        scanMode: "tracked-all",
        includePmInternals: true,
        verboseFileLists: true,
        strictExit: true,
        failOnWarn: true,
        checkLifecycle: true,
        checkStaleBlockers: true,
        checkHistoryDrift: true,
        checkCommandReferences: true,
      }),
    ).toEqual([
      "--json",
      "validate",
      "--check-lifecycle",
      "--check-stale-blockers",
      "--check-files",
      "--scan-mode",
      "tracked-all",
      "--include-pm-internals",
      "--verbose-file-lists",
      "--strict-exit",
      "--fail-on-warn",
      "--check-history-drift",
      "--check-command-references",
    ]);

    expect(
      buildPmCliArgs({
        action: "health",
        strictDirectories: true,
        strictExit: true,
        failOnWarn: true,
        verboseStaleItems: true,
      }),
    ).toEqual(["--json", "health", "--strict-directories", "--strict-exit", "--fail-on-warn", "--verbose-stale-items"]);

    expect(
      buildPmCliArgs({
        action: "health",
        checkOnly: true,
        noRefresh: true,
        refreshVectors: true,
      }),
    ).toEqual(["--json", "health", "--check-only", "--no-refresh", "--refresh-vectors"]);

    expect(
      buildPmCliArgs({
        action: "comments-audit",
        status: "open",
        type: "Task",
        assignee: "pi-bot",
        assigneeFilter: "assigned",
        parent: "pm-epic01",
        tag: "pi",
        sprint: "sprint-7",
        release: "vnext",
        priority: 1,
        limitItems: 5,
        fullHistory: true,
        latest: 2,
      }),
    ).toEqual([
      "--json",
      "comments-audit",
      "--status",
      "open",
      "--type",
      "Task",
      "--assignee",
      "pi-bot",
      "--assignee-filter",
      "assigned",
      "--parent",
      "pm-epic01",
      "--tag",
      "pi",
      "--sprint",
      "sprint-7",
      "--release",
      "vnext",
      "--priority",
      "1",
      "--limit-items",
      "5",
      "--full-history",
      "--latest",
      "2",
    ]);

    expect(
      buildPmCliArgs({
        action: "comments-audit",
        status: "open",
        limit: 7,
      }),
    ).toEqual(["--json", "comments-audit", "--status", "open", "--limit", "7"]);

    expect(
      buildPmCliArgs({
        action: "calendar",
        view: "week",
        date: "2026-03-03T00:00:00.000Z",
        from: "2026-03-01T00:00:00.000Z",
        to: "2026-03-08T00:00:00.000Z",
        past: true,
        fullPeriod: true,
        type: "Task",
        tag: "pi",
        priority: "1",
        status: "open",
        assignee: "none",
        sprint: "sprint-7",
        release: "vnext",
        include: "events",
        recurrenceLookaheadDays: "30",
        recurrenceLookbackDays: "7",
        occurrenceLimit: "120",
        limit: "20",
        format: "markdown",
      }),
    ).toEqual([
      "--json",
      "calendar",
      "--view",
      "week",
      "--date",
      "2026-03-03T00:00:00.000Z",
      "--from",
      "2026-03-01T00:00:00.000Z",
      "--to",
      "2026-03-08T00:00:00.000Z",
      "--past",
      "--full-period",
      "--type",
      "Task",
      "--tag",
      "pi",
      "--priority",
      "1",
      "--status",
      "open",
      "--assignee",
      "none",
      "--sprint",
      "sprint-7",
      "--release",
      "vnext",
      "--include",
      "events",
      "--recurrence-lookahead-days",
      "30",
      "--recurrence-lookback-days",
      "7",
      "--occurrence-limit",
      "120",
      "--limit",
      "20",
      "--format",
      "markdown",
    ]);

    expect(
      buildPmCliArgs({
        action: "activity",
        id: "pm-a1b2",
        op: "update",
        author: "pi-bot",
        from: "2026-03-01T00:00:00.000Z",
        to: "2026-03-08T00:00:00.000Z",
        limit: "50",
        stream: "rows",
      }),
    ).toEqual([
      "--json",
      "activity",
      "--id",
      "pm-a1b2",
      "--op",
      "update",
      "--author",
      "pi-bot",
      "--from",
      "2026-03-01T00:00:00.000Z",
      "--to",
      "2026-03-08T00:00:00.000Z",
      "--limit",
      "50",
      "--stream",
      "rows",
    ]);

    expect(
      buildPmCliArgs({
        action: "context",
        date: "2026-03-03T00:00:00.000Z",
        from: "2026-03-01T00:00:00.000Z",
        to: "2026-03-08T00:00:00.000Z",
        past: true,
        type: "Task",
        tag: "pi",
        priority: "1",
        assignee: "none",
        sprint: "sprint-7",
        release: "vnext",
        limit: "20",
        format: "markdown",
      }),
    ).toEqual([
      "--json",
      "context",
      "--date",
      "2026-03-03T00:00:00.000Z",
      "--from",
      "2026-03-01T00:00:00.000Z",
      "--to",
      "2026-03-08T00:00:00.000Z",
      "--past",
      "--type",
      "Task",
      "--tag",
      "pi",
      "--priority",
      "1",
      "--assignee",
      "none",
      "--sprint",
      "sprint-7",
      "--release",
      "vnext",
      "--limit",
      "20",
      "--format",
      "markdown",
    ]);

    expect(
      buildPmCliArgs({
        action: "search",
        query: "linked parity",
        mode: "keyword",
        includeLinked: true,
        titleExact: true,
        phraseExact: true,
        compact: true,
        full: true,
        fields: "id,title",
        limit: "3",
      }),
    ).toEqual([
      "--json",
      "search",
      "linked parity",
      "--mode",
      "keyword",
      "--include-linked",
      "--title-exact",
      "--phrase-exact",
      "--compact",
      "--full",
      "--fields",
      "id,title",
      "--limit",
      "3",
    ]);

    expect(
      buildPmCliArgs({
        action: "history",
        id: "pm-a1b2",
        limit: "50",
      }),
    ).toEqual(["--json", "history", "pm-a1b2", "--limit", "50"]);

    expect(
      buildPmCliArgs({
        action: "close",
        id: "pm-a1b2",
        text: "done",
        author: "pi-bot",
        message: "close item",
        force: true,
      }),
    ).toEqual([
      "--json",
      "close",
      "pm-a1b2",
      "done",
      "--author",
      "pi-bot",
      "--message",
      "close item",
      "--force",
    ]);

    expect(
      buildPmCliArgs({
        action: "delete",
        id: "pm-a1b2",
        author: "pi-bot",
        message: "delete item",
        force: true,
      }),
    ).toEqual([
      "--json",
      "delete",
      "pm-a1b2",
      "--author",
      "pi-bot",
      "--message",
      "delete item",
      "--force",
    ]);

    expect(
      buildPmCliArgs({
        action: "claim",
        id: "pm-a1b2",
        author: "pi-bot",
        message: "claim item",
        force: true,
      }),
    ).toEqual([
      "--json",
      "claim",
      "pm-a1b2",
      "--author",
      "pi-bot",
      "--message",
      "claim item",
      "--force",
    ]);

    expect(
      buildPmCliArgs({
        action: "release",
        id: "pm-a1b2",
        author: "pi-bot",
        message: "release item",
        allowAuditRelease: true,
        force: true,
      }),
    ).toEqual([
      "--json",
      "release",
      "pm-a1b2",
      "--allow-audit-release",
      "--author",
      "pi-bot",
      "--message",
      "release item",
      "--force",
    ]);

    expect(
      buildPmCliArgs({
        action: "comments",
        id: "pm-a1b2",
        text: "investigating parity",
        limit: "10",
        allowAuditComment: true,
        author: "pi-bot",
        message: "comment",
        force: true,
      }),
    ).toEqual([
      "--json",
      "comments",
      "pm-a1b2",
      "--add",
      "investigating parity",
      "--limit",
      "10",
      "--allow-audit-comment",
      "--author",
      "pi-bot",
      "--message",
      "comment",
      "--force",
    ]);

    expect(
      buildPmCliArgs({
        action: "notes",
        id: "pm-a1b2",
        text: "capture implementation note",
        limit: "5",
        allowAuditComment: true,
        author: "pi-bot",
        message: "note",
        force: true,
      }),
    ).toEqual([
      "--json",
      "notes",
      "pm-a1b2",
      "--add",
      "capture implementation note",
      "--limit",
      "5",
      "--allow-audit-comment",
      "--author",
      "pi-bot",
      "--message",
      "note",
      "--force",
    ]);

    expect(
      buildPmCliArgs({
        action: "learnings",
        id: "pm-a1b2",
        text: "capture learning",
        limit: "5",
        allowAuditComment: true,
        author: "pi-bot",
        message: "learning",
        force: true,
      }),
    ).toEqual([
      "--json",
      "learnings",
      "pm-a1b2",
      "--add",
      "capture learning",
      "--limit",
      "5",
      "--allow-audit-comment",
      "--author",
      "pi-bot",
      "--message",
      "learning",
      "--force",
    ]);

    expect(
      buildPmCliArgs({
        action: "notes",
        id: "pm-a1b2",
        text: "capture implementation note",
        allowAuditNote: true,
      }),
    ).toEqual(["--json", "notes", "pm-a1b2", "--add", "capture implementation note", "--allow-audit-note"]);

    expect(
      buildPmCliArgs({
        action: "learnings",
        id: "pm-a1b2",
        text: "capture learning",
        allowAuditLearning: true,
      }),
    ).toEqual(["--json", "learnings", "pm-a1b2", "--add", "capture learning", "--allow-audit-learning"]);

    expect(
      buildPmCliArgs({
        action: "files",
        id: "pm-a1b2",
        add: ["path=src/a.ts,scope=project"],
        addGlob: ["src/**/*.ts"],
        remove: ["path=src/b.ts,scope=project"],
        appendStable: true,
      }),
    ).toEqual([
      "--json",
      "files",
      "pm-a1b2",
      "--add",
      "path=src/a.ts,scope=project",
      "--add-glob",
      "src/**/*.ts",
      "--remove",
      "path=src/b.ts,scope=project",
      "--append-stable",
    ]);

    expect(
      buildPmCliArgs({
        action: "files",
        id: "pm-a1b2",
        discover: true,
        apply: true,
        discoveryNote: "found in comments",
        appendStable: true,
      }),
    ).toEqual([
      "--json",
      "files",
      "discover",
      "pm-a1b2",
      "--apply",
      "--note",
      "found in comments",
      "--append-stable",
    ]);

    expect(
      buildPmCliArgs({
        action: "deps",
        id: "pm-a1b2",
        format: "graph",
      }),
    ).toEqual(["--json", "deps", "pm-a1b2", "--format", "graph"]);

    expect(
      buildPmCliArgs({
        action: "deps",
        id: "pm-a1b2",
        maxDepth: "2",
        collapse: "repeated",
        summary: true,
      }),
    ).toEqual(["--json", "deps", "pm-a1b2", "--max-depth", "2", "--collapse", "repeated", "--summary"]);

    expect(
      buildPmCliArgs({
        action: "test",
        id: "pm-a1b2",
        add: ["command=node scripts/run-tests.mjs coverage,scope=project,timeout_seconds=1200"],
        run: true,
        timeout: "1800",
        envSet: ["PORT=0"],
        envClear: ["PLAYWRIGHT_BASE_URL"],
        sharedHostSafe: true,
        pmContext: "tracker",
        overrideLinkedPmContext: true,
        failOnContextMismatch: true,
        failOnSkipped: true,
        failOnEmptyTestRun: true,
        requireAssertionsForPm: true,
      }),
    ).toEqual([
      "--json",
      "test",
      "pm-a1b2",
      "--add",
      "command=node scripts/run-tests.mjs coverage,scope=project,timeout_seconds=1200",
      "--run",
      "--timeout",
      "1800",
      "--env-set",
      "PORT=0",
      "--env-clear",
      "PLAYWRIGHT_BASE_URL",
      "--shared-host-safe",
      "--pm-context",
      "tracker",
      "--override-linked-pm-context",
      "--fail-on-context-mismatch",
      "--fail-on-skipped",
      "--fail-on-empty-test-run",
      "--require-assertions-for-pm",
    ]);

    expect(
      buildPmCliArgs({
        action: "test-all",
        status: "in_progress",
        limit: 3,
        offset: 1,
        timeout: "1800",
        envSet: ["PORT=0"],
        envClear: ["PLAYWRIGHT_BASE_URL"],
        sharedHostSafe: true,
        pmContext: "tracker",
        overrideLinkedPmContext: true,
        failOnContextMismatch: true,
        failOnSkipped: true,
        failOnEmptyTestRun: true,
        requireAssertionsForPm: true,
      }),
    ).toEqual([
      "--json",
      "test-all",
      "--status",
      "in_progress",
      "--limit",
      "3",
      "--offset",
      "1",
      "--timeout",
      "1800",
      "--env-set",
      "PORT=0",
      "--env-clear",
      "PLAYWRIGHT_BASE_URL",
      "--shared-host-safe",
      "--pm-context",
      "tracker",
      "--override-linked-pm-context",
      "--fail-on-context-mismatch",
      "--fail-on-skipped",
      "--fail-on-empty-test-run",
      "--require-assertions-for-pm",
    ]);

    expect(
      buildPmCliArgs({
        action: "contracts",
        contractAction: "create",
        command: "create",
        schemaOnly: true,
        flagsOnly: true,
        availabilityOnly: true,
        runtimeOnly: true,
        activeOnly: true,
      }),
    ).toEqual([
      "--json",
      "contracts",
      "--action",
      "create",
      "--command",
      "create",
      "--schema-only",
      "--flags-only",
      "--availability-only",
      "--runtime-only",
      "--active-only",
    ]);

    expect(
      buildPmCliArgs({
        action: "completion",
        shell: "fish",
      }),
    ).toEqual(["--json", "completion", "fish"]);

    expect(
      buildPmCliArgs({
        action: "completion",
        shell: "bash",
        eagerTags: true,
      }),
    ).toEqual(["--json", "completion", "bash", "--eager-tags"]);

    expect(
      buildPmCliArgs({
        action: "templates-save",
        template: "pi-template",
        title: "Pi template title",
        description: "Pi template description",
        type: "Task",
        status: "open",
        priority: 1,
        assignee: "pi-bot",
        createMode: "progressive",
        schedulePreset: "lightweight",
        unset: ["author"],
        clearDeps: true,
      }),
    ).toEqual([
      "--json",
      "templates",
      "save",
      "pi-template",
      "--title",
      "Pi template title",
      "--description",
      "Pi template description",
      "--type",
      "Task",
      "--status",
      "open",
      "--priority",
      "1",
      "--assignee",
      "pi-bot",
    ]);

    expect(
      buildPmCliArgs({
        action: "beads-import",
        file: ".beads/issues.jsonl",
        author: "pi-bot",
        message: "import beads",
        preserveSourceIds: true,
      }),
    ).toEqual([
      "--json",
      "beads",
      "import",
      "--file",
      ".beads/issues.jsonl",
      "--author",
      "pi-bot",
      "--message",
      "import beads",
      "--preserve-source-ids",
    ]);

    expect(
      buildPmCliArgs({
        action: "beads-import",
        author: "pi-bot",
      }),
    ).toEqual(["--json", "beads", "import", "--author", "pi-bot"]);

    expect(
      buildPmCliArgs({
        action: "todos-import",
        folder: ".pi/todos",
        author: "pi-bot",
        message: "import todos",
      }),
    ).toEqual([
      "--json",
      "todos",
      "import",
      "--folder",
      ".pi/todos",
      "--author",
      "pi-bot",
      "--message",
      "import todos",
    ]);

    expect(
      buildPmCliArgs({
        action: "todos-export",
        folder: ".pi/todos",
      }),
    ).toEqual(["--json", "todos", "export", "--folder", ".pi/todos"]);
  });

  it("returns error envelope when invocation attempts fail", async () => {
    const api = {
      registerTool: vi.fn(),
      exec: vi
        .fn()
        .mockResolvedValueOnce({
          code: 127,
          stdout: "",
          stderr: "pm: command not found",
        })
        .mockResolvedValueOnce({
          code: 1,
          stdout: "",
          stderr: "validation failed",
        }),
    };

    const tool = createPmToolDefinition(api);
    const result = await tool.execute("call-3", { action: "get", id: "pm-a1b2" });

    expect(api.exec).toHaveBeenCalledTimes(2);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("validation failed");
    expect(result.details).toMatchObject({
      action: "get",
      ok: false,
      exit_code: 1,
      invocation: {
        command: "node",
      },
    });
  });

  it("supports workflow presets like start-task pause-task and close-task", async () => {
    const execSpy = vi
      .fn()
      .mockResolvedValue({ code: 0, stdout: "{}", stderr: "" });
    const api = { registerTool: vi.fn(), exec: execSpy };
    const tool = createPmToolDefinition(api);

    await tool.execute("call-1", { action: "start-task", id: "pm-a1b2", author: "pi-bot", force: true });
    expect(execSpy).toHaveBeenCalledTimes(1);
    expect(execSpy.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining(["start-task", "pm-a1b2", "--author", "pi-bot", "--force"]),
    );

    execSpy.mockClear();

    await tool.execute("call-2", { action: "pause-task", id: "pm-a1b2", author: "pi-bot" });
    expect(execSpy).toHaveBeenCalledTimes(1);
    expect(execSpy.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(["pause-task", "pm-a1b2", "--author", "pi-bot"]));

    execSpy.mockClear();

    await tool.execute("call-3", {
      action: "close-task",
      id: "pm-a1b2",
      text: "Completed workflow preset validation",
      author: "pi-bot",
      force: true,
    });
    expect(execSpy).toHaveBeenCalledTimes(2);
    // Close call
    expect(execSpy.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining([
        "close",
        "pm-a1b2",
        "Completed workflow preset validation",
        "--author",
        "pi-bot",
        "--force",
      ]),
    );
    // Release call
    expect(execSpy.mock.calls[1]?.[1]).toEqual(
      expect.arrayContaining(["release", "pm-a1b2", "--author", "pi-bot", "--force"]),
    );
  });

  it("requires close reason text for close-task workflow preset", async () => {
    const execSpy = vi.fn().mockResolvedValue({ code: 0, stdout: "{}", stderr: "" });
    const api = { registerTool: vi.fn(), exec: execSpy };
    const tool = createPmToolDefinition(api);

    await expect(tool.execute("call-4", { action: "close-task", id: "pm-a1b2", author: "pi-bot" })).rejects.toThrow(
      'Action "close-task" requires "text".',
    );
    expect(execSpy).toHaveBeenCalledTimes(0);
  });
});
