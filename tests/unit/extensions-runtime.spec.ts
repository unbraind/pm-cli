import { afterEach, describe, expect, it } from "vitest";
import {
  runActiveCommandHandler,
  clearActiveExtensionHooks,
  runActiveCommandOverride,
  runActiveOnIndexHooks,
  runActiveOnReadHooks,
  runActiveOnWriteHooks,
  runActiveRendererOverride,
  setActiveCommandContext,
  setActiveExtensionCommands,
  setActiveExtensionHooks,
  setActiveExtensionRenderers,
  type ExtensionHookRegistry,
} from "../../src/core/extensions/index.js";

describe("core/extensions runtime wrappers", () => {
  afterEach(() => {
    clearActiveExtensionHooks();
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
});
