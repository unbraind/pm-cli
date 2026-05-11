import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CommandDefinition, CommandOverride, ExtensionApi, RendererOverride } from "../../src/core/extensions/loader.js";
import beadsBuiltin, { activate as activateBeads, manifest as beadsManifest } from "../../.agents/pm/extensions/beads/index.js";
import todosBuiltin, { activate as activateTodos, manifest as todosManifest } from "../../.agents/pm/extensions/todos/index.js";

const PM_PACKAGE_ROOT_ENV = "PM_CLI_PACKAGE_ROOT";
const RUNTIME_CALLS_KEY = "__PM_TEST_RUNTIME_CALLS";

interface RuntimeCall {
  kind: "beads" | "todos-import" | "todos-export";
  options: Record<string, unknown>;
  global: Record<string, unknown>;
}

function readRuntimeCalls(): RuntimeCall[] {
  const raw = (globalThis as Record<string, unknown>)[RUNTIME_CALLS_KEY];
  return Array.isArray(raw) ? (raw as RuntimeCall[]) : [];
}

function resetRuntimeCalls(): void {
  (globalThis as Record<string, unknown>)[RUNTIME_CALLS_KEY] = [];
}

let testPackageRoot = "";

async function seedRuntimeCommandStubs(packageRoot: string): Promise<void> {
  const beadsRuntimeRoot = path.join(packageRoot, ".agents", "pm", "extensions", "beads");
  const todosRuntimeRoot = path.join(packageRoot, ".agents", "pm", "extensions", "todos");
  await mkdir(beadsRuntimeRoot, { recursive: true });
  await mkdir(todosRuntimeRoot, { recursive: true });
  await writeFile(
    path.join(beadsRuntimeRoot, "runtime.js"),
    `export async function runBeadsImport(options, global) {
  const calls = Array.isArray(globalThis.${RUNTIME_CALLS_KEY}) ? globalThis.${RUNTIME_CALLS_KEY} : [];
  calls.push({ kind: "beads", options, global });
  globalThis.${RUNTIME_CALLS_KEY} = calls;
  return {
    ok: true,
    source: typeof options?.file === "string" ? options.file : "issues.jsonl",
    imported: 1,
    skipped: 0,
    ids: ["pm-bead"],
    warnings: [],
  };
}
`,
    "utf8",
  );
  await writeFile(
    path.join(todosRuntimeRoot, "runtime.js"),
    `export async function runTodosImport(options, global) {
  const calls = Array.isArray(globalThis.${RUNTIME_CALLS_KEY}) ? globalThis.${RUNTIME_CALLS_KEY} : [];
  calls.push({ kind: "todos-import", options, global });
  globalThis.${RUNTIME_CALLS_KEY} = calls;
  return {
    ok: true,
    folder: typeof options?.folder === "string" ? options.folder : ".pm/todos",
    imported: 2,
    skipped: 0,
    ids: ["pm-a", "pm-b"],
    warnings: [],
  };
}

export async function runTodosExport(options, global) {
  const calls = Array.isArray(globalThis.${RUNTIME_CALLS_KEY}) ? globalThis.${RUNTIME_CALLS_KEY} : [];
  calls.push({ kind: "todos-export", options, global });
  globalThis.${RUNTIME_CALLS_KEY} = calls;
  return {
    ok: true,
    folder: typeof options?.folder === "string" ? options.folder : ".pm/todos",
    exported: 3,
    ids: ["pm-a", "pm-b", "pm-c"],
    warnings: [],
  };
}
`,
    "utf8",
  );
}

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
  beforeEach(async () => {
    resetRuntimeCalls();
    testPackageRoot = await mkdtemp(path.join(os.tmpdir(), "pm-bundled-extension-runtime-"));
    await seedRuntimeCommandStubs(testPackageRoot);
    process.env[PM_PACKAGE_ROOT_ENV] = testPackageRoot;
  });

  afterEach(async () => {
    delete process.env[PM_PACKAGE_ROOT_ENV];
    resetRuntimeCalls();
    if (testPackageRoot.length > 0) {
      await rm(testPackageRoot, { recursive: true, force: true });
      testPackageRoot = "";
    }
  });

  it("exposes deterministic manifests and default exports", () => {
    expect(beadsManifest).toEqual({
      name: "builtin-beads-import",
      version: "0.1.0",
      entry: "./index.js",
      priority: 0,
      capabilities: ["commands", "schema"],
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
      capabilities: ["commands", "schema"],
    });
    expect(todosBuiltin).toEqual({
      manifest: todosManifest,
      activate: activateTodos,
    });
  });

  it("registers beads import handler and coerces extension options", async () => {
    const { api, commands } = createCommandOnlyApi();

    activateBeads(api);
    expect(commands.map((command) => command.name)).toEqual(["beads import"]);
    expect(commands[0]?.flags).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ long: "--file" }),
        expect.objectContaining({ long: "--author" }),
        expect.objectContaining({ long: "--message" }),
        expect.objectContaining({ long: "--preserve-source-ids" }),
      ]),
    );

    const result = await commands[0]!.run({
      command: "beads import",
      args: [],
      options: {
        file: ".beads/issues.jsonl",
        author: 123,
        message: "entrypoint import",
        preserveSourceIds: true,
      },
      global: globalFlags,
      pm_root: "/tmp/pm",
    });

    const calls = readRuntimeCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      kind: "beads",
      options: {
        file: ".beads/issues.jsonl",
        author: undefined,
        message: "entrypoint import",
        preserveSourceIds: true,
      },
      global: globalFlags,
    });
    expect(result).toEqual({
      ok: true,
      source: ".beads/issues.jsonl",
      imported: 1,
      skipped: 0,
      ids: ["pm-bead"],
      warnings: [],
    });
  });

  it("drops non-boolean preserveSourceIds values when coercing extension options", async () => {
    const { api, commands } = createCommandOnlyApi();

    activateBeads(api);
    await commands[0]!.run({
      command: "beads import",
      args: [],
      options: {
        preserveSourceIds: "true",
      },
      global: globalFlags,
      pm_root: "/tmp/pm",
    });

    const calls = readRuntimeCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      kind: "beads",
      options: {
        file: undefined,
        author: undefined,
        message: undefined,
        preserveSourceIds: undefined,
      },
      global: globalFlags,
    });
  });

  it("registers todos import/export handlers and coerces option fields", async () => {
    const { api, commands } = createCommandOnlyApi();

    activateTodos(api);
    expect(commands.map((command) => command.name)).toEqual([
      "todos import",
      "todos export",
    ]);
    expect(commands[0]?.flags).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ long: "--folder" }),
        expect.objectContaining({ long: "--author" }),
        expect.objectContaining({ long: "--message" }),
      ]),
    );
    expect(commands[1]?.flags).toEqual(expect.arrayContaining([expect.objectContaining({ long: "--folder" })]));

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
    let calls = readRuntimeCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      kind: "todos-import",
      options: {
        folder: "/tmp/todos",
        author: undefined,
        message: "entrypoint todos import",
      },
      global: globalFlags,
    });
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
    calls = readRuntimeCalls();
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual({
      kind: "todos-export",
      options: {
        folder: undefined,
      },
      global: globalFlags,
    });
    expect(exportResult).toEqual({
      ok: true,
      folder: ".pm/todos",
      exported: 3,
      ids: ["pm-a", "pm-b", "pm-c"],
      warnings: [],
    });
  });
});
