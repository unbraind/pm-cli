import { afterEach, describe, expect, it } from "vitest";
import {
  runActiveCommandHandler,
  clearActiveExtensionHooks,
  consumeAfterCommandAffectedItems,
  projectAfterCommandItemSnapshot,
  recordAfterCommandAffectedItem,
  runActiveCommandOverride,
  runActiveOnIndexHooks,
  runActiveParserOverride,
  runActivePreflightOverride,
  runActiveOnReadHooks,
  runActiveServiceOverride,
  runActiveServiceOverrideSync,
  runActiveOnWriteHooks,
  runActiveRendererOverride,
  setActiveCommandContext,
  setActiveExtensionCommands,
  setActiveExtensionHooks,
  setActiveExtensionParsers,
  setActiveExtensionPreflight,
  setActiveExtensionRenderers,
  setActiveExtensionServices,
  type ExtensionHookRegistry,
} from "../../src/core/extensions/index.js";

describe("core/extensions runtime wrappers", () => {
  afterEach(() => {
    clearActiveExtensionHooks();
  });

  it("records afterCommand affected items only when afterCommand hooks are active", () => {
    recordAfterCommandAffectedItem({ id: "pm-skip", op: "update", status: "open" });
    expect(consumeAfterCommandAffectedItems()).toBeUndefined();

    setActiveExtensionHooks({
      beforeCommand: [],
      afterCommand: [{ layer: "project", name: "after-ext", run: () => undefined }],
      onWrite: [],
      onRead: [],
      onIndex: [],
    });

    recordAfterCommandAffectedItem({ id: "pm-one", op: "update", previous_status: "open", status: "closed" });

    expect(consumeAfterCommandAffectedItems()).toEqual([
      { id: "pm-one", op: "update", previous_status: "open", status: "closed" },
    ]);
    expect(consumeAfterCommandAffectedItems()).toBeUndefined();
  });

  it("drops invalid affected-item payloads and clears queue on hook reset", () => {
    setActiveExtensionHooks({
      beforeCommand: [],
      afterCommand: [{ layer: "project", name: "after-ext", run: () => undefined }],
      onWrite: [],
      onRead: [],
      onIndex: [],
    });

    recordAfterCommandAffectedItem({ id: "pm-one", op: "update", previous_status: "open", status: "closed" });
    recordAfterCommandAffectedItem(null as unknown as { id: string });
    expect(consumeAfterCommandAffectedItems()).toEqual([
      { id: "pm-one", op: "update", previous_status: "open", status: "closed" },
    ]);

    recordAfterCommandAffectedItem({ id: "pm-two", op: "delete", previous_status: "closed" });
    clearActiveExtensionHooks();
    expect(consumeAfterCommandAffectedItems()).toBeUndefined();
  });

  it("projects compact afterCommand item snapshots from changed front matter", () => {
    const snapshot = projectAfterCommandItemSnapshot(
      {
        id: "pm-one",
        title: "Important item",
        type: "Task",
        status: "open",
        priority: 1,
        assignee: "agent",
        body: "large body",
        comments: [{ text: "large comment", created_at: "2026-06-06T00:00:00.000Z" }],
        tests: [{ command: "pnpm test", scope: "project" }],
      },
      ["title", "unset:assignee", "body", "comments", "tests", "missing", 42 as unknown as string],
    );

    expect(snapshot).toEqual({
      id: "pm-one",
      type: "Task",
      status: "open",
      title: "Important item",
      assignee: "agent",
    });
  });

  it("projects fallback snapshots when changed fields are malformed or metadata has no id", () => {
    expect(
      projectAfterCommandItemSnapshot(
        {
          id: "pm-base",
          type: "Task",
          status: "open",
          title: "Fallback",
        },
        null as unknown as readonly string[],
      ),
    ).toEqual({
      id: "pm-base",
      type: "Task",
      status: "open",
    });

    expect(
      projectAfterCommandItemSnapshot(
        {
          type: "Task",
          status: "open",
          title: "No id",
        } as unknown as { id: string; type: string; status: string; title: string },
        ["title"],
      ),
    ).toEqual({});
  });

  it("returns empty warnings when no active hooks are registered", async () => {
    expect(
      await runActiveOnWriteHooks({
        path: "src/cli/main.ts",
        scope: "project",
        op: "update",
      }),
    ).toEqual([]);

    expect(
      await runActiveOnReadHooks({
        path: "README.md",
        scope: "project",
      }),
    ).toEqual([]);

    expect(
      await runActiveOnIndexHooks({
        mode: "keyword",
        total_items: 0,
      }),
    ).toEqual([]);
  });

  it("dispatches active onRead/onWrite/onIndex hooks", async () => {
    const trace: string[] = [];
    const hooks: ExtensionHookRegistry = {
      beforeCommand: [],
      afterCommand: [],
      onWrite: [
        {
          layer: "project",
          name: "write-ext",
          run: (context) => {
            trace.push(`write:${context.op}:${context.scope}`);
          },
        },
      ],
      onRead: [
        {
          layer: "global",
          name: "read-ext",
          run: (context) => {
            trace.push(`read:${context.path}:${context.scope}`);
          },
        },
      ],
      onIndex: [
        {
          layer: "project",
          name: "index-ext",
          run: (context) => {
            trace.push(`index:${context.mode}:${context.total_items ?? 0}`);
          },
        },
      ],
    };
    setActiveExtensionHooks(hooks);

    expect(
      await runActiveOnWriteHooks({
        path: "src/core/store/item-store.ts",
        scope: "project",
        op: "create",
      }),
    ).toEqual([]);
    expect(
      await runActiveOnReadHooks({
        path: "README.md",
        scope: "project",
      }),
    ).toEqual([]);
    expect(
      await runActiveOnIndexHooks({
        mode: "keyword",
        total_items: 3,
      }),
    ).toEqual([]);

    expect(trace).toEqual(["write:create:project", "read:README.md:project", "index:keyword:3"]);
  });

  it("contains active hook failures and continues later hooks", async () => {
    let successCalls = 0;
    setActiveExtensionHooks({
      beforeCommand: [],
      afterCommand: [],
      onWrite: [
        {
          layer: "project",
          name: "boom-write-ext",
          run: () => {
            throw new Error("write boom");
          },
        },
        {
          layer: "project",
          name: "ok-write-ext",
          run: () => {
            successCalls += 1;
          },
        },
      ],
      onRead: [],
      onIndex: [],
    });

    const warnings = await runActiveOnWriteHooks({
      path: "src/core/store/item-store.ts",
      scope: "project",
      op: "update",
    });

    expect(warnings).toEqual(["extension_hook_failed:project:boom-write-ext:onWrite"]);
    expect(successCalls).toBe(1);
  });

  it("stops dispatching once active hooks are cleared", async () => {
    let readCalls = 0;
    setActiveExtensionHooks({
      beforeCommand: [],
      afterCommand: [],
      onWrite: [],
      onRead: [
        {
          layer: "project",
          name: "read-ext",
          run: () => {
            readCalls += 1;
          },
        },
      ],
      onIndex: [],
    });

    clearActiveExtensionHooks();
    const warnings = await runActiveOnReadHooks({
      path: "README.md",
      scope: "project",
    });

    expect(warnings).toEqual([]);
    expect(readCalls).toBe(0);
  });

  it("runs active command overrides using current command context", () => {
    expect(runActiveCommandOverride({ ok: true })).toEqual({
      overridden: false,
      result: { ok: true },
      warnings: [],
    });

    setActiveExtensionCommands({
      overrides: [
        {
          layer: "project",
          name: "command-override-ext",
          command: "list-open",
          run: (context) => ({
            ...(context.result as Record<string, unknown>),
            overridden: true,
            command: context.command,
            limit: context.options.limit,
            json: context.global.json,
          }),
        },
      ],
      handlers: [],
    });
    setActiveCommandContext({
      command: "list-open",
      args: ["--limit", "1"],
      options: { limit: "1" },
      global: {
        json: true,
        quiet: false,
        noExtensions: false,
        profile: false,
      },
      pm_root: "/tmp/project",
    });

    expect(runActiveCommandOverride({ count: 1 })).toEqual({
      overridden: true,
      result: {
        count: 1,
        overridden: true,
        command: "list-open",
        limit: "1",
        json: true,
      },
      warnings: [],
    });
  });

  it("runs active command handlers through the active registry", async () => {
    expect(
      await runActiveCommandHandler({
        command: "beads import",
        args: [],
        options: {},
        global: {
          json: true,
          quiet: false,
          noExtensions: false,
          profile: false,
        },
        pm_root: "/tmp/project",
      }),
    ).toEqual({
      handled: false,
      result: null,
      warnings: [],
    });

    setActiveExtensionCommands({
      overrides: [],
      handlers: [
        {
          layer: "project",
          name: "command-handler-ext",
          command: "beads import",
          run: async (context) => ({
            ok: true,
            source: context.command,
          }),
        },
      ],
    });
    expect(
      await runActiveCommandHandler({
        command: "beads import",
        args: ["--json"],
        options: { file: ".beads/issues.jsonl" },
        global: {
          json: true,
          quiet: false,
          noExtensions: false,
          profile: false,
        },
        pm_root: "/tmp/project",
      }),
    ).toEqual({
      handled: true,
      result: {
        ok: true,
        source: "beads import",
      },
      warnings: [],
    });
  });

  it("runs active parser, preflight, and service overrides", async () => {
    setActiveExtensionParsers({
      overrides: [
        {
          layer: "project",
          name: "parser-ext",
          command: "create",
          run: (context) => ({
            options: {
              ...context.options,
              estimate: 30,
            },
          }),
        },
      ],
    });
    const parserResult = await runActiveParserOverride({
      command: "create",
      args: [],
      options: {},
      global: {
        json: false,
        quiet: false,
        noExtensions: false,
        profile: false,
      },
      pm_root: "/tmp/project",
    });
    expect(parserResult.overridden).toBe(true);
    expect(parserResult.context.options).toEqual({ estimate: 30 });

    setActiveExtensionPreflight({
      overrides: [
        {
          layer: "project",
          name: "preflight-ext",
          run: () => ({
            run_extension_migrations: false,
          }),
        },
      ],
    });
    const preflightResult = await runActivePreflightOverride({
      command: "update",
      args: [],
      options: {},
      global: {
        json: false,
        quiet: false,
        noExtensions: false,
        profile: false,
      },
      pm_root: "/tmp/project",
      decision: {
        enforce_item_format_gate: true,
        run_preflight_item_format_sync: true,
        run_extension_migrations: true,
        enforce_mandatory_migration_gate: true,
      },
    });
    expect(preflightResult.overridden).toBe(true);
    expect(preflightResult.decision.run_extension_migrations).toBe(false);

    setActiveCommandContext({
      command: "list-open",
      args: [],
      options: {},
      global: {
        json: true,
        quiet: false,
        noExtensions: false,
        profile: false,
      },
      pm_root: "/tmp/project",
    });
    setActiveExtensionServices({
      overrides: [
        {
          layer: "project",
          name: "service-ext",
          service: "output_format",
          run: (context) => JSON.stringify({ wrapped: (context.payload as { result: unknown }).result }),
        },
      ],
    });
    expect(
      runActiveServiceOverrideSync("output_format", {
        result: { ok: true },
      }),
    ).toEqual({
      handled: true,
      result: JSON.stringify({ wrapped: { ok: true } }),
      warnings: [],
    });
    expect(
      await runActiveServiceOverride("output_format", {
        result: { ok: true },
      }),
    ).toEqual({
      handled: true,
      result: JSON.stringify({ wrapped: { ok: true } }),
      warnings: [],
    });
  });

  it("runs active renderer overrides and resets on clear", () => {
    expect(runActiveRendererOverride("json", { ok: true })).toEqual({
      overridden: false,
      rendered: null,
      warnings: [],
    });

    setActiveExtensionRenderers({
      overrides: [
        {
          layer: "project",
          name: "renderer-override-ext",
          format: "json",
          run: (context) =>
            JSON.stringify({
              wrapped: context.result,
              command: context.command,
              limit: context.options.limit,
              json: context.global.json,
              pm_root: context.pm_root,
            }),
        },
      ],
    });
    setActiveCommandContext({
      command: "list-open",
      args: ["--limit", "1"],
      options: { limit: "1" },
      global: {
        json: true,
        quiet: false,
        noExtensions: false,
        profile: false,
      },
      pm_root: "/tmp/project",
    });

    expect(runActiveRendererOverride("json", { ok: true })).toEqual({
      overridden: true,
      rendered: JSON.stringify({
        wrapped: { ok: true },
        command: "list-open",
        limit: "1",
        json: true,
        pm_root: "/tmp/project",
      }),
      warnings: [],
    });

    clearActiveExtensionHooks();
    expect(runActiveRendererOverride("json", { ok: true })).toEqual({
      overridden: false,
      rendered: null,
      warnings: [],
    });
  });

  it("contains active override failures and falls back to original runtime context", async () => {
    setActiveExtensionCommands({
      handlers: [],
      overrides: [
        {
          layer: "project",
          name: "async-command-override",
          command: "list-open",
          run: async () => ({ unreachable: true }),
        },
      ],
    });
    setActiveCommandContext({
      command: " list-open ",
      args: ["--limit", "1"],
      options: { limit: "1" },
      global: {
        json: false,
        quiet: false,
        noExtensions: false,
        profile: false,
      },
      pm_root: "/tmp/project",
    });
    expect(runActiveCommandOverride({ count: 1 })).toEqual({
      overridden: false,
      result: { count: 1 },
      warnings: ["extension_command_override_async_unsupported:project:async-command-override:list-open"],
    });

    setActiveExtensionParsers({
      overrides: [
        {
          layer: "project",
          name: "parser-boom",
          command: "create",
          run: () => {
            throw new Error("parser boom");
          },
        },
      ],
    });
    const parserResult = await runActiveParserOverride({
      command: " create ",
      args: ["--title", "One"],
      options: { title: "One" },
      global: {
        json: false,
        quiet: false,
        noExtensions: false,
        profile: false,
      },
      pm_root: "/tmp/project",
    });
    expect(parserResult).toEqual({
      overridden: false,
      context: {
        command: "create",
        args: ["--title", "One"],
        options: { title: "One" },
        global: {
          json: false,
          quiet: false,
          noExtensions: false,
          profile: false,
        },
        pm_root: "/tmp/project",
      },
      warnings: ["extension_parser_override_failed:project:parser-boom:create"],
    });

    setActiveExtensionPreflight({
      overrides: [
        {
          layer: "project",
          name: "preflight-boom",
          run: () => {
            throw new Error("preflight boom");
          },
        },
      ],
    });
    const decision = {
      enforce_item_format_gate: true,
      run_preflight_item_format_sync: true,
      run_extension_migrations: true,
      enforce_mandatory_migration_gate: true,
    };
    const preflightResult = await runActivePreflightOverride({
      command: "update",
      args: [],
      options: {},
      global: {
        json: false,
        quiet: false,
        noExtensions: false,
        profile: false,
      },
      pm_root: "/tmp/project",
      decision,
    });
    expect(preflightResult).toEqual({
      overridden: false,
      context: {
        command: "update",
        args: [],
        options: {},
        global: {
          json: false,
          quiet: false,
          noExtensions: false,
          profile: false,
        },
        pm_root: "/tmp/project",
      },
      decision,
      warnings: ["extension_preflight_override_failed:project:preflight-boom"],
    });
  });

  it("falls through service and renderer override failures in active registries", async () => {
    setActiveExtensionServices({
      overrides: [
        {
          layer: "project",
          name: "async-sync-service",
          service: "output_format",
          run: async () => "async output",
        },
        {
          layer: "project",
          name: "throwing-service",
          service: "output_format",
          run: () => {
            throw new Error("service boom");
          },
        },
      ],
    });
    expect(runActiveServiceOverrideSync("output_format", { ok: true })).toEqual({
      handled: false,
      result: { ok: true },
      warnings: [
        "extension_service_override_failed:project:throwing-service:output_format",
        "extension_service_override_async_unsupported:project:async-sync-service:output_format",
      ],
    });
    expect(await runActiveServiceOverride("missing_service", { ok: true })).toEqual({
      handled: false,
      result: { ok: true },
      warnings: [],
    });

    setActiveExtensionRenderers({
      overrides: [
        {
          layer: "project",
          name: "invalid-renderer",
          format: "json",
          run: () => ({ not: "a string" }),
        },
        {
          layer: "project",
          name: "throwing-renderer",
          format: "toon",
          run: () => {
            throw new Error("renderer boom");
          },
        },
      ],
    });
    expect(runActiveRendererOverride("json", { ok: true })).toEqual({
      overridden: false,
      rendered: null,
      warnings: ["extension_renderer_invalid_result:project:invalid-renderer:json"],
    });
    expect(runActiveRendererOverride("toon", { ok: true })).toEqual({
      overridden: false,
      rendered: null,
      warnings: ["extension_renderer_failed:project:throwing-renderer:toon"],
    });
  });
});
