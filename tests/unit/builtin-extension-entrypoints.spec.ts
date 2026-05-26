import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  CommandDefinition,
  CommandOverride,
  ExtensionApi,
  ExtensionServiceName,
  RendererOverride,
  ServiceOverride,
} from "../../src/core/extensions/loader.js";
import beadsBuiltin, { activate as activateBeads, manifest as beadsManifest } from "../../packages/pm-beads/extensions/beads/index.js";
import calendarBuiltin, { activate as activateCalendar, manifest as calendarManifest } from "../../packages/pm-calendar/extensions/calendar/index.js";
import todosBuiltin, { activate as activateTodos, manifest as todosManifest } from "../../packages/pm-todos/extensions/todos/index.js";

const PM_PACKAGE_ROOT_ENV = "PM_CLI_PACKAGE_ROOT";
const RUNTIME_CALLS_KEY = "__PM_TEST_RUNTIME_CALLS";

interface RuntimeCall {
  kind: "beads" | "calendar" | "todos-import" | "todos-export";
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
  const beadsPackageRoot = path.join(packageRoot, "packages", "pm-beads");
  const calendarPackageRoot = path.join(packageRoot, "packages", "pm-calendar");
  const todosPackageRoot = path.join(packageRoot, "packages", "pm-todos");
  const sdkRuntimeRoot = path.join(packageRoot, "dist", "sdk");
  const beadsRuntimeRoot = path.join(beadsPackageRoot, "extensions", "beads");
  const calendarRuntimeRoot = path.join(calendarPackageRoot, "extensions", "calendar");
  const todosRuntimeRoot = path.join(todosPackageRoot, "extensions", "todos");
  await mkdir(beadsPackageRoot, { recursive: true });
  await mkdir(calendarPackageRoot, { recursive: true });
  await mkdir(todosPackageRoot, { recursive: true });
  await writeFile(
    path.join(beadsPackageRoot, "package.json"),
    JSON.stringify({ name: "@example/pm-beads", version: "0.0.0", pm: { extensions: ["extensions/beads"] } }),
    "utf8",
  );
  await writeFile(
    path.join(calendarPackageRoot, "package.json"),
    JSON.stringify({ name: "@example/pm-calendar", version: "0.0.0", pm: { extensions: ["extensions/calendar"] } }),
    "utf8",
  );
  await writeFile(
    path.join(todosPackageRoot, "package.json"),
    JSON.stringify({ name: "@example/pm-todos", version: "0.0.0", pm: { extensions: ["extensions/todos"] } }),
    "utf8",
  );
  await mkdir(beadsRuntimeRoot, { recursive: true });
  await mkdir(calendarRuntimeRoot, { recursive: true });
  await mkdir(todosRuntimeRoot, { recursive: true });
  await mkdir(sdkRuntimeRoot, { recursive: true });
  await writeFile(
    path.join(sdkRuntimeRoot, "runtime.js"),
    `export async function runCalendar(options, global) {
  const calls = Array.isArray(globalThis.${RUNTIME_CALLS_KEY}) ? globalThis.${RUNTIME_CALLS_KEY} : [];
  calls.push({ kind: "calendar", options, global });
  globalThis.${RUNTIME_CALLS_KEY} = calls;
  return {
    view: options?.view ?? "agenda",
    output_default: "markdown",
    now: "2026-04-02T00:00:00.000Z",
    anchor: "2026-04-02T00:00:00.000Z",
    range: {
      start: null,
      end: null,
      period_start: null,
      period_end: null,
      full_period: false,
      past: false,
      from: null,
      to: null,
    },
    filters: {},
    summary: {
      events: 0,
      items: 0,
      deadlines: 0,
      reminders: 0,
      scheduled: 0,
      by_kind: { deadline: 0, reminder: 0, event: 0 },
      by_type: {},
      by_status: {},
      recurring_events: 0,
    },
    events: [],
    days: [],
  };
}

export function renderCalendarMarkdown() {
  return "# package calendar";
}

export function resolveCalendarOutputFormat(options) {
  return options?.format === "json" ? "json" : "markdown";
}
`,
    "utf8",
  );
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
    path.join(calendarRuntimeRoot, "runtime.js"),
    `export async function runCalendarPackage(options, global) {
  const calls = Array.isArray(globalThis.${RUNTIME_CALLS_KEY}) ? globalThis.${RUNTIME_CALLS_KEY} : [];
  calls.push({ kind: "calendar", options, global });
  globalThis.${RUNTIME_CALLS_KEY} = calls;
  return {
    view: options?.view ?? "agenda",
    output_default: "markdown",
    now: "2026-04-02T00:00:00.000Z",
    anchor: "2026-04-02T00:00:00.000Z",
    range: {
      start: null,
      end: null,
      period_start: null,
      period_end: null,
      full_period: false,
      past: false,
      from: null,
      to: null,
    },
    filters: {},
    summary: {
      events: 0,
      items: 0,
      deadlines: 0,
      reminders: 0,
      scheduled: 0,
      by_kind: { deadline: 0, reminder: 0, event: 0 },
      by_type: {},
      by_status: {},
      recurring_events: 0,
    },
    events: [],
    days: [],
  };
}

export function renderCalendarPackageOutput(context) {
  if (context.command !== "calendar" && context.command !== "cal") {
    return null;
  }
  const result = context.payload?.result ?? context.payload;
  if (context.options?.format === "json") {
    return JSON.stringify(result, null, 2) + "\\n";
  }
  return "# package calendar\\n";
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

function createCommandOnlyApi(): { api: ExtensionApi; commands: CommandDefinition[]; services: Array<{ service: ExtensionServiceName; override: ServiceOverride }> } {
  const commands: CommandDefinition[] = [];
  const services: Array<{ service: ExtensionServiceName; override: ServiceOverride }> = [];
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
    registerService(service: ExtensionServiceName, override: ServiceOverride): void {
      services.push({ service, override });
    },
    registerParser(): void {
      throw new Error("Unexpected parser registration");
    },
    registerPreflight(): void {
      throw new Error("Unexpected preflight registration");
    },
    registerFlags(): void {
      throw new Error("Unexpected flags registration");
    },
    registerItemFields(): void {
      throw new Error("Unexpected item fields registration");
    },
    registerItemTypes(): void {
      throw new Error("Unexpected item types registration");
    },
    registerMigration(): void {
      throw new Error("Unexpected migration registration");
    },
    registerImporter(): void {
      throw new Error("Unexpected importer registration");
    },
    registerExporter(): void {
      throw new Error("Unexpected exporter registration");
    },
    registerSearchProvider(): void {
      throw new Error("Unexpected search provider registration");
    },
    registerVectorStoreAdapter(): void {
      throw new Error("Unexpected vector store adapter registration");
    },
    hooks: {
      beforeCommand: () => undefined,
      afterCommand: () => undefined,
      onWrite: () => undefined,
      onRead: () => undefined,
      onIndex: () => undefined,
    },
  };
  return { api, commands, services };
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

    expect(calendarManifest).toEqual({
      name: "builtin-calendar",
      version: "0.1.0",
      entry: "./index.js",
      priority: 0,
      capabilities: ["commands", "schema", "services"],
    });
    expect(calendarBuiltin).toEqual({
      manifest: calendarManifest,
      activate: activateCalendar,
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

  it("registers calendar handlers and package output service", async () => {
    const { api, commands, services } = createCommandOnlyApi();

    activateCalendar(api);
    expect(commands.map((command) => command.name)).toEqual(["calendar", "cal"]);
    expect(commands.map((command) => command.action)).toEqual(["calendar", "calendar"]);
    expect(commands[0]?.flags).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ long: "--view" }),
        expect.objectContaining({ long: "--full-period" }),
        expect.objectContaining({ long: "--format" }),
      ]),
    );
    expect(services.map((entry) => entry.service)).toEqual(["output_format"]);

    const result = await commands[0]!.run({
      command: "calendar",
      args: [],
      options: { view: "week" },
      global: globalFlags,
      pm_root: "/tmp/pm",
    });

    const calls = readRuntimeCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      kind: "calendar",
      options: { view: "week" },
      global: globalFlags,
    });
    expect(result).toMatchObject({
      view: "week",
      output_default: "markdown",
    });

    const rendered = services[0]!.override({
      service: "output_format",
      command: "calendar",
      args: [],
      options: {},
      global: globalFlags,
      pm_root: "/tmp/pm",
      payload: {
        format: "toon",
        options: globalFlags,
        result,
      },
    });
    expect(rendered).toBe("# package calendar\n");
  });

  it("accepts a positional view combined with --date (loose flag tokens are not extra positionals)", async () => {
    const { api, commands } = createCommandOnlyApi();
    activateCalendar(api);

    // context.args still contains the loose flag tokens for `pm cal day --date +7d`.
    const result = await commands[0]!.run({
      command: "cal",
      args: ["day", "--date", "+7d"],
      options: { date: "+7d" },
      global: globalFlags,
      pm_root: "/tmp/pm",
    });

    const calls = readRuntimeCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      kind: "calendar",
      options: { date: "+7d", view: "day" },
      global: globalFlags,
    });
    expect(result).toMatchObject({ view: "day" });
  });

  it("still rejects two positional views and surfaces a recovery hint", async () => {
    const { api, commands } = createCommandOnlyApi();
    activateCalendar(api);

    await expect(
      commands[0]!.run({
        command: "cal",
        args: ["day", "week"],
        options: {},
        global: globalFlags,
        pm_root: "/tmp/pm",
      }),
    ).rejects.toMatchObject({
      name: "PmCliError",
      exitCode: 2,
      message: expect.stringContaining("but received: day, week"),
    });
  });

  it("flags an invalid first positional and falls back to a valid recovery view", async () => {
    const { api, commands } = createCommandOnlyApi();
    activateCalendar(api);

    let captured: unknown;
    try {
      await commands[0]!.run({
        command: "cal",
        args: ["totally-bogus", "week"],
        options: {},
        global: globalFlags,
        pm_root: "/tmp/pm",
      });
    } catch (error) {
      captured = error;
    }

    const error = captured as { message: string; exitCode: number };
    expect(error.exitCode).toBe(2);
    expect(error.message).toContain("Unknown view alias(es): totally-bogus");
    // Recovery hint falls back to the first VALID view (week), not the invalid first positional.
    expect(error.message).toContain("pm calendar week");
    expect(error.message).toContain("--view week --date +7d");
    expect(error.message).not.toContain("pm calendar totally-bogus\n");
  });

  it("tolerates empty/whitespace-only trailing positionals (shell expansion produces no extras)", async () => {
    const { api, commands } = createCommandOnlyApi();
    activateCalendar(api);

    // pm calendar agenda "" — empty positional from unset shell variable.
    const result = await commands[0]!.run({
      command: "cal",
      args: ["agenda", "", "   "],
      options: {},
      global: globalFlags,
      pm_root: "/tmp/pm",
    });

    const calls = readRuntimeCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ kind: "calendar", options: { view: "agenda" } });
    expect(result).toMatchObject({ view: "agenda" });
  });

  it("falls back to 'agenda' when no positional is a recognized view", async () => {
    const { api, commands } = createCommandOnlyApi();
    activateCalendar(api);

    let captured: unknown;
    try {
      await commands[0]!.run({
        command: "cal",
        args: ["alpha", "beta"],
        options: {},
        global: globalFlags,
        pm_root: "/tmp/pm",
      });
    } catch (error) {
      captured = error;
    }

    const error = captured as { message: string };
    expect(error.message).toContain("Unknown view alias(es): alpha, beta");
    expect(error.message).toContain("pm calendar agenda");
    expect(error.message).toContain("--view agenda --date +7d");
  });

  it("flags unknown view aliases when rejecting extra positional args", async () => {
    const { api, commands } = createCommandOnlyApi();
    activateCalendar(api);

    let captured: unknown;
    try {
      await commands[0]!.run({
        command: "cal",
        args: ["agenda", "totally-bogus"],
        options: {},
        global: globalFlags,
        pm_root: "/tmp/pm",
      });
    } catch (error) {
      captured = error;
    }

    expect(captured).toBeDefined();
    const error = captured as { message: string; exitCode: number; name: string };
    expect(error.name).toBe("PmCliError");
    expect(error.exitCode).toBe(2);
    expect(error.message).toContain("but received: agenda, totally-bogus");
    expect(error.message).toContain("Unknown view alias(es): totally-bogus");
    expect(error.message).toContain("pm calendar agenda");
    expect(error.message).toContain("--view agenda --date +7d");
  });

  it("registers beads import handler and coerces extension options", async () => {
    const { api, commands } = createCommandOnlyApi();

    activateBeads(api);
    expect(commands.map((command) => command.name)).toEqual(["beads import"]);
    expect(commands[0]?.action).toBe("beads-import");
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
    expect(commands.map((command) => command.action)).toEqual(["todos-import", "todos-export"]);
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
