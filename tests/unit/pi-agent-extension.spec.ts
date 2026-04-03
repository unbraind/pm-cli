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
      deadline: "none",
      estimate: "15",
      acceptanceCriteria: "works",
      author: "unit-test",
      message: "create",
      dep: ["none"],
      comment: ["none"],
      note: ["none"],
      learning: ["none"],
      linkedFile: ["none"],
      linkedTest: ["none"],
      doc: ["none"],
      reminder: ["none"],
      event: ["none"],
      path: "/tmp/pm-sandbox",
    });

    expect(args).toContain("--json");
    expect(args).toContain("--path");
    expect(args).toContain("/tmp/pm-sandbox");
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
        "none",
        "--reminder",
        "none",
        "--event",
        "none",
      ]),
    );
  });

  it("preserves explicit empty-string values for empty-allowed CLI flags", () => {
    const createArgs = buildPmCliArgs({
      action: "create",
      title: "Pi task",
      description: "",
      type: "Task",
      status: "open",
      priority: "1",
      tags: "",
      body: "",
      deadline: "none",
      estimate: "0",
      acceptanceCriteria: "",
      author: "unit-test",
      message: "",
      assignee: "none",
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
        "--dep",
        "none",
        "--comment",
        "none",
        "--note",
        "none",
        "--learning",
        "none",
        "--file",
        "none",
        "--test",
        "none",
        "--doc",
        "none",
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

    const createArgs = buildPmCliArgs({
      action: "create",
      title: "Pi numeric task",
      description: "",
      type: "Task",
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
      timeout: 1800,
    });
    expect(testAllArgs).toEqual(["--json", "test-all", "--status", "in_progress", "--timeout", "1800"]);

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

    const validateSchema = schemaForAction(tool.parameters as Record<string, unknown>, "validate");
    expect(validateSchema.required).toEqual(["action"]);
    expect(schemaProperty(validateSchema, "checkFiles").type).toBe("boolean");
    expect(schemaProperty(validateSchema, "scanMode").enum).toEqual(["default", "tracked-all"]);
    expect(schemaProperty(validateSchema, "includePmInternals").type).toBe("boolean");

    const calendarSchema = schemaForAction(tool.parameters as Record<string, unknown>, "calendar");
    expect(schemaProperty(calendarSchema, "view").type).toBe("string");
    expect(schemaProperty(calendarSchema, "past").type).toBe("boolean");
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
    expect(schemaProperty(updateSchema, "depRemove")).toMatchObject({
      type: "array",
      items: { type: "string" },
    });

    const completionSchema = schemaForAction(tool.parameters as Record<string, unknown>, "completion");
    expect(completionSchema.required).toEqual(expect.arrayContaining(["action", "shell"]));
    expect(schemaProperty(completionSchema, "shell").type).toBe("string");

    const contractsSchema = schemaForAction(tool.parameters as Record<string, unknown>, "contracts");
    expect(contractsSchema.required).toEqual(["action"]);
    expect(schemaProperty(contractsSchema, "contractAction").type).toBe("string");
    expect(schemaProperty(contractsSchema, "command").type).toBe("string");
    expect(schemaProperty(contractsSchema, "schemaOnly").type).toBe("boolean");

    const testAllSchema = schemaForAction(tool.parameters as Record<string, unknown>, "test-all");
    expect(schemaProperty(testAllSchema, "timeout").anyOf).toEqual(
      expect.arrayContaining([{ type: "string" }, { type: "number" }]),
    );
    expect(schemaProperty(testAllSchema, "status").type).toBe("string");

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
      "--limit",
      "20",
    ]);

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
        action: "extension-activate",
        target: "sample-ext",
        scope: "project",
      }),
    ).toEqual(["--json", "extension", "--activate", "sample-ext", "--project"]);

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
        checkHistoryDrift: true,
      }),
    ).toEqual([
      "--json",
      "validate",
      "--check-files",
      "--scan-mode",
      "tracked-all",
      "--include-pm-internals",
      "--check-history-drift",
    ]);

    expect(
      buildPmCliArgs({
        action: "calendar",
        view: "week",
        date: "2026-03-03T00:00:00.000Z",
        from: "2026-03-01T00:00:00.000Z",
        to: "2026-03-08T00:00:00.000Z",
        past: true,
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
        limit: "3",
      }),
    ).toEqual(["--json", "search", "linked parity", "--mode", "keyword", "--include-linked", "--limit", "3"]);

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
        force: true,
      }),
    ).toEqual([
      "--json",
      "release",
      "pm-a1b2",
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
      "--author",
      "pi-bot",
      "--message",
      "learning",
      "--force",
    ]);

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
        action: "deps",
        id: "pm-a1b2",
        format: "graph",
      }),
    ).toEqual(["--json", "deps", "pm-a1b2", "--format", "graph"]);

    expect(
      buildPmCliArgs({
        action: "test",
        id: "pm-a1b2",
        add: ["command=node scripts/run-tests.mjs coverage,scope=project,timeout_seconds=1200"],
        run: true,
        timeout: "1800",
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
    ]);

    expect(
      buildPmCliArgs({
        action: "test-all",
        status: "in_progress",
        timeout: "1800",
      }),
    ).toEqual(["--json", "test-all", "--status", "in_progress", "--timeout", "1800"]);

    expect(
      buildPmCliArgs({
        action: "contracts",
        contractAction: "create",
        command: "create",
        schemaOnly: true,
      }),
    ).toEqual(["--json", "contracts", "--action", "create", "--command", "create", "--schema-only"]);

    expect(
      buildPmCliArgs({
        action: "completion",
        shell: "fish",
      }),
    ).toEqual(["--json", "completion", "fish"]);

    expect(
      buildPmCliArgs({
        action: "beads-import",
        file: ".beads/issues.jsonl",
        author: "pi-bot",
        message: "import beads",
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
    ]);

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
    expect(execSpy).toHaveBeenCalledTimes(2);
    // Claim call
    expect(execSpy.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(["claim", "pm-a1b2", "--author", "pi-bot", "--force"]));
    // Update call
    expect(execSpy.mock.calls[1]?.[1]).toEqual(expect.arrayContaining(["update", "pm-a1b2", "--status", "in_progress", "--author", "pi-bot", "--force"]));

    execSpy.mockClear();

    await tool.execute("call-2", { action: "pause-task", id: "pm-a1b2", author: "pi-bot" });
    expect(execSpy).toHaveBeenCalledTimes(2);
    // Update call
    expect(execSpy.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(["update", "pm-a1b2", "--status", "open", "--author", "pi-bot"]));
    // Release call
    expect(execSpy.mock.calls[1]?.[1]).toEqual(expect.arrayContaining(["release", "pm-a1b2", "--author", "pi-bot"]));

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
