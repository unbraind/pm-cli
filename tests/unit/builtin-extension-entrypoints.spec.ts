import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CommandDefinition,
  CommandOverride,
  ExtensionApi,
  RendererOverride,
} from "../../src/core/extensions/loader.js";

const mocked = vi.hoisted(() => ({
  runBeadsImport: vi.fn(),
  runTodosImport: vi.fn(),
  runTodosExport: vi.fn(),
}));

vi.mock("../../src/cli/commands/beads.js", () => ({
  runBeadsImport: mocked.runBeadsImport,
}));

vi.mock("../../src/extensions/builtins/todos/import-export.js", () => ({
  runTodosImport: mocked.runTodosImport,
  runTodosExport: mocked.runTodosExport,
}));

import beadsBuiltin, {
  activate as activateBeads,
  manifest as beadsManifest,
} from "../../src/extensions/builtins/beads/index.js";
import todosBuiltin, {
  activate as activateTodos,
  manifest as todosManifest,
} from "../../src/extensions/builtins/todos/index.js";

const globalFlags = {
  json: false,
  quiet: false,
  noExtensions: false,
  profile: false,
};

function createCommandOnlyApi(): { api: ExtensionApi; commands: CommandDefinition[] } {
  const commands: CommandDefinition[] = [];
  const api: ExtensionApi = {
    registerCommand(first: string | CommandDefinition, _override?: CommandOverride): void {
      if (typeof first === "string") {
        throw new TypeError(`Unexpected command override registration: ${first}`);
      }
      commands.push(first);
    },
    registerRenderer(_format: "toon" | "json", _renderer: RendererOverride): void {
      throw new Error("Unexpected renderer registration");
    },
    hooks: {
      beforeCommand: () => undefined,
      afterCommand: () => undefined,
      onWrite: () => undefined,
      onRead: () => undefined,
      onIndex: () => undefined,
    },
  };
  return { api, commands };
}

describe("built-in extension entrypoints", () => {
  beforeEach(() => {
    mocked.runBeadsImport.mockReset();
    mocked.runTodosImport.mockReset();
    mocked.runTodosExport.mockReset();
  });

  it("exposes deterministic manifests and default exports", () => {
    expect(beadsManifest).toEqual({
      name: "builtin-beads-import",
      version: "0.1.0",
      entry: "./index.js",
      priority: 0,
      capabilities: ["commands"],
    });
    expect(beadsBuiltin).toEqual({
      manifest: beadsManifest,
      activate: activateBeads,
    });

    expect(todosManifest).toEqual({
      name: "builtin-todos-import-export",
      version: "0.1.0",
      entry: "./index.js",
      priority: 0,
      capabilities: ["commands"],
    });
    expect(todosBuiltin).toEqual({
      manifest: todosManifest,
      activate: activateTodos,
    });
  });

  it("registers beads import handler and coerces extension options", async () => {
    const { api, commands } = createCommandOnlyApi();
    mocked.runBeadsImport.mockResolvedValue({
      ok: true,
      source: ".beads/issues.jsonl",
      imported: 1,
      skipped: 0,
      ids: ["pm-bead"],
      warnings: [],
    });

    activateBeads(api);
    expect(commands.map((command) => command.name)).toEqual(["beads import"]);

    const result = await commands[0]!.run({
      command: "beads import",
      args: [],
      options: {
        file: ".beads/issues.jsonl",
        author: 123,
        message: "entrypoint import",
      },
      global: globalFlags,
      pm_root: "/tmp/pm",
    });

    expect(mocked.runBeadsImport).toHaveBeenCalledTimes(1);
    expect(mocked.runBeadsImport).toHaveBeenCalledWith(
      {
        file: ".beads/issues.jsonl",
        author: undefined,
        message: "entrypoint import",
      },
      globalFlags,
    );
    expect(result).toEqual({
      ok: true,
      source: ".beads/issues.jsonl",
      imported: 1,
      skipped: 0,
      ids: ["pm-bead"],
      warnings: [],
    });
  });

  it("registers todos import/export handlers and coerces option fields", async () => {
    const { api, commands } = createCommandOnlyApi();
    mocked.runTodosImport.mockResolvedValue({
      ok: true,
      folder: "/tmp/todos",
      imported: 2,
      skipped: 0,
      ids: ["pm-a", "pm-b"],
      warnings: [],
    });
    mocked.runTodosExport.mockResolvedValue({
      ok: true,
      folder: ".pi/todos",
      exported: 3,
      ids: ["pm-a", "pm-b", "pm-c"],
      warnings: [],
    });

    activateTodos(api);
    expect(commands.map((command) => command.name)).toEqual([
      "todos import",
      "todos export",
    ]);

    const importResult = await commands[0]!.run({
      command: "todos import",
      args: [],
      options: {
        folder: "/tmp/todos",
        author: false,
        message: "entrypoint todos import",
      },
      global: globalFlags,
      pm_root: "/tmp/pm",
    });
    expect(mocked.runTodosImport).toHaveBeenCalledTimes(1);
    expect(mocked.runTodosImport).toHaveBeenCalledWith(
      {
        folder: "/tmp/todos",
        author: undefined,
        message: "entrypoint todos import",
      },
      globalFlags,
    );
    expect(importResult).toEqual({
      ok: true,
      folder: "/tmp/todos",
      imported: 2,
      skipped: 0,
      ids: ["pm-a", "pm-b"],
      warnings: [],
    });

    const exportResult = await commands[1]!.run({
      command: "todos export",
      args: [],
      options: {
        folder: 42,
      },
      global: globalFlags,
      pm_root: "/tmp/pm",
    });
    expect(mocked.runTodosExport).toHaveBeenCalledTimes(1);
    expect(mocked.runTodosExport).toHaveBeenCalledWith(
      {
        folder: undefined,
      },
      globalFlags,
    );
    expect(exportResult).toEqual({
      ok: true,
      folder: ".pi/todos",
      exported: 3,
      ids: ["pm-a", "pm-b", "pm-c"],
      warnings: [],
    });
  });
});
