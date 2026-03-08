import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  PM_TOOL_ACTIONS,
  buildPmCliArgs,
  createPmToolDefinition,
  registerPmTool,
} from "../../.pi/extensions/pm-cli/index.ts";

describe("Pi agent extension wrapper for pm", () => {
  it("builds deterministic CLI args for mapped actions", () => {
    const args = buildPmCliArgs({
      action: "create",
      title: "Pi task",
      description: "created via pi tool",
      type: "Task",
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
        "--status",
        "open",
        "--priority",
        "1",
        "--assignee",
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
    });

    expect(updateArgs).toEqual(
      expect.arrayContaining([
        "update",
        "pm-a1b2",
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
      type: "object",
      required: ["action"],
    });
    expect((tool.parameters as { properties: { action: { enum: string[] } } }).properties.action.enum).toEqual(
      expect.arrayContaining(PM_TOOL_ACTIONS as unknown as string[]),
    );
    expect(
      (tool.parameters as { properties: { includeLinked: { type: string } } }).properties.includeLinked.type,
    ).toBe("boolean");
    expect((tool.parameters as { properties: { blockedBy: { type: string } } }).properties.blockedBy.type).toBe(
      "string",
    );
    expect((tool.parameters as { properties: { definitionOfReady: { type: string } } }).properties.definitionOfReady.type).toBe(
      "string",
    );
    expect((tool.parameters as { properties: { shell: { type: string } } }).properties.shell.type).toBe("string");
    expect(
      (
        tool.parameters as {
          properties: {
            regression: { anyOf: Array<{ type: string }> };
          };
        }
      ).properties.regression.anyOf,
    ).toEqual(expect.arrayContaining([{ type: "boolean" }, { type: "string" }, { type: "number" }]));
    expect(
      (
        tool.parameters as {
          properties: {
            priority: { anyOf: Array<{ type: string }> };
            estimate: { anyOf: Array<{ type: string }> };
            limit: { anyOf: Array<{ type: string }> };
            timeout: { anyOf: Array<{ type: string }> };
          };
        }
      ).properties.priority.anyOf,
    ).toEqual(expect.arrayContaining([{ type: "string" }, { type: "number" }]));
    expect(
      (
        tool.parameters as {
          properties: {
            priority: { anyOf: Array<{ type: string }> };
            estimate: { anyOf: Array<{ type: string }> };
            limit: { anyOf: Array<{ type: string }> };
            timeout: { anyOf: Array<{ type: string }> };
          };
        }
      ).properties.estimate.anyOf,
    ).toEqual(expect.arrayContaining([{ type: "string" }, { type: "number" }]));
    expect(
      (
        tool.parameters as {
          properties: {
            priority: { anyOf: Array<{ type: string }> };
            estimate: { anyOf: Array<{ type: string }> };
            limit: { anyOf: Array<{ type: string }> };
            timeout: { anyOf: Array<{ type: string }> };
          };
        }
      ).properties.limit.anyOf,
    ).toEqual(expect.arrayContaining([{ type: "string" }, { type: "number" }]));
    expect(
      (
        tool.parameters as {
          properties: {
            priority: { anyOf: Array<{ type: string }> };
            estimate: { anyOf: Array<{ type: string }> };
            limit: { anyOf: Array<{ type: string }> };
            timeout: { anyOf: Array<{ type: string }> };
          };
        }
      ).properties.timeout.anyOf,
    ).toEqual(expect.arrayContaining([{ type: "string" }, { type: "number" }]));

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
      "--author",
      "pi-bot",
      "--message",
      "comment",
      "--force",
    ]);

    expect(
      buildPmCliArgs({
        action: "files",
        id: "pm-a1b2",
        add: ["path=src/a.ts,scope=project"],
        remove: ["path=src/b.ts,scope=project"],
      }),
    ).toEqual([
      "--json",
      "files",
      "pm-a1b2",
      "--add",
      "path=src/a.ts,scope=project",
      "--remove",
      "path=src/b.ts,scope=project",
    ]);

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

  it("supports workflow presets like start-task and pause-task", async () => {
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
  });
});
