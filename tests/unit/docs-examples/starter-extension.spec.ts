import { pathToFileURL } from "node:url";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Branch coverage for the starter-extension reference example
 * (docs/examples/starter-extension/index.ts), driven through its TypeScript
 * source and a collecting extension API. The `./index.ts` source is itself the
 * manifest entry the loader imports directly via Node's native type stripping
 * (ADR pm-2c28 / pm-m1uz) — there is no compiled `.js`. The tiny
 * starter-extension-example.spec.ts only asserts the migration source string;
 * this file covers the remaining runtime branches
 * (command/parser/renderer/service/hook/provider/adapter behavior).
 */

function cacheBustToken(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function importRepoModule<T>(relativePath: string, queryPrefix: string): Promise<T> {
  const absolutePath = path.join(process.cwd(), relativePath);
  return (await import(`${pathToFileURL(absolutePath).href}?${queryPrefix}=${cacheBustToken()}`)) as T;
}

interface RegisteredArtifacts {
  commands: Array<Record<string, unknown>>;
  services: Array<{ name: string; handler: (context: unknown) => unknown }>;
  renderers: Array<{ format: string; handler: (context: unknown) => unknown }>;
  parsers: Array<{ command: string; handler: (context: unknown) => unknown }>;
  preflights: Array<(context: unknown) => unknown>;
  itemFields: unknown[];
  itemTypes: unknown[];
  migrations: unknown[];
  importers: Array<{ name: string; handler: (context: unknown) => unknown }>;
  exporters: Array<{ name: string; handler: (context: unknown) => unknown }>;
  searchProviders: Array<Record<string, unknown>>;
  vectorAdapters: Array<Record<string, unknown>>;
  hooks: {
    beforeCommand: Array<(context: unknown) => unknown>;
    afterCommand: Array<(context: unknown) => unknown>;
    onWrite: Array<(context: unknown) => unknown>;
    onRead: Array<(context: unknown) => unknown>;
    onIndex: Array<(context: unknown) => unknown>;
  };
}

function createExtensionApiCollector(): { api: Record<string, unknown>; artifacts: RegisteredArtifacts } {
  const artifacts: RegisteredArtifacts = {
    commands: [],
    services: [],
    renderers: [],
    parsers: [],
    preflights: [],
    itemFields: [],
    itemTypes: [],
    migrations: [],
    importers: [],
    exporters: [],
    searchProviders: [],
    vectorAdapters: [],
    hooks: {
      beforeCommand: [],
      afterCommand: [],
      onWrite: [],
      onRead: [],
      onIndex: [],
    },
  };

  const api = {
    registerCommand(command: Record<string, unknown>) {
      artifacts.commands.push(command);
    },
    registerService(name: string, handler: (context: unknown) => unknown) {
      artifacts.services.push({ name, handler });
    },
    registerRenderer(format: string, handler: (context: unknown) => unknown) {
      artifacts.renderers.push({ format, handler });
    },
    registerParser(command: string, handler: (context: unknown) => unknown) {
      artifacts.parsers.push({ command, handler });
    },
    registerPreflight(handler: (context: unknown) => unknown) {
      artifacts.preflights.push(handler);
    },
    registerFlags() {
      return undefined;
    },
    registerItemFields(fields: unknown[]) {
      artifacts.itemFields.push(...fields);
    },
    registerItemTypes(types: unknown[]) {
      artifacts.itemTypes.push(...types);
    },
    registerMigration(migration: unknown) {
      artifacts.migrations.push(migration);
    },
    registerImporter(name: string, handler: (context: unknown) => unknown) {
      artifacts.importers.push({ name, handler });
    },
    registerExporter(name: string, handler: (context: unknown) => unknown) {
      artifacts.exporters.push({ name, handler });
    },
    registerSearchProvider(provider: Record<string, unknown>) {
      artifacts.searchProviders.push(provider);
    },
    registerVectorStoreAdapter(adapter: Record<string, unknown>) {
      artifacts.vectorAdapters.push(adapter);
    },
    hooks: {
      beforeCommand(handler: (context: unknown) => unknown) {
        artifacts.hooks.beforeCommand.push(handler);
      },
      afterCommand(handler: (context: unknown) => unknown) {
        artifacts.hooks.afterCommand.push(handler);
      },
      onWrite(handler: (context: unknown) => unknown) {
        artifacts.hooks.onWrite.push(handler);
      },
      onRead(handler: (context: unknown) => unknown) {
        artifacts.hooks.onRead.push(handler);
      },
      onIndex(handler: (context: unknown) => unknown) {
        artifacts.hooks.onIndex.push(handler);
      },
    },
  };
  return { api, artifacts };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("starter-extension example", () => {
  it("registers all artifacts and exercises every runtime branch", async () => {
    const starterModule = await importRepoModule<{ default: { activate: (api: Record<string, unknown>) => void } }>(
      "docs/examples/starter-extension/index.ts",
      "starterExample",
    );
    const starterCollector = createExtensionApiCollector();
    starterModule.default.activate(starterCollector.api);

    expect(starterCollector.artifacts.commands.map((command) => command.name)).toEqual(["starter ping"]);
    expect(starterCollector.artifacts.parsers).toHaveLength(1);
    expect(starterCollector.artifacts.preflights).toHaveLength(1);
    expect(starterCollector.artifacts.services.map((service) => service.name)).toContain("output_format");
    expect(starterCollector.artifacts.renderers.map((renderer) => renderer.format).sort()).toEqual(["json", "toon"]);
    expect(starterCollector.artifacts.itemFields).toHaveLength(1);
    expect(starterCollector.artifacts.itemTypes).toHaveLength(1);
    expect(starterCollector.artifacts.migrations).toHaveLength(1);
    expect(starterCollector.artifacts.importers.map((entry) => entry.name)).toEqual(["starter-json"]);
    expect(starterCollector.artifacts.exporters.map((entry) => entry.name)).toEqual(["starter-json"]);
    expect(starterCollector.artifacts.searchProviders).toHaveLength(1);
    expect(starterCollector.artifacts.vectorAdapters).toHaveLength(1);

    const beforeCommand = starterCollector.artifacts.hooks.beforeCommand[0];
    const afterCommand = starterCollector.artifacts.hooks.afterCommand[0];
    const onWrite = starterCollector.artifacts.hooks.onWrite[0];
    const onRead = starterCollector.artifacts.hooks.onRead[0];
    const onIndex = starterCollector.artifacts.hooks.onIndex[0];
    expect(beforeCommand).toBeDefined();
    expect(afterCommand).toBeDefined();
    expect(onWrite).toBeDefined();
    expect(onRead).toBeDefined();
    expect(onIndex).toBeDefined();
    if (
      beforeCommand === undefined ||
      afterCommand === undefined ||
      onWrite === undefined ||
      onRead === undefined ||
      onIndex === undefined
    ) {
      throw new TypeError("starter extension hooks were not registered");
    }
    beforeCommand({ command: "starter ping" });
    afterCommand({ command: "starter ping" });
    onWrite({ path: "/tmp/item.md" });
    onRead({ path: "/tmp/item.md" });
    onIndex({ id: "pm-1" });

    const starterCommandRun = starterCollector.artifacts.commands[0]?.run;
    expect(typeof starterCommandRun).toBe("function");
    if (typeof starterCommandRun !== "function") {
      throw new TypeError("starter ping command run handler was not registered");
    }
    const runStarterCommand = starterCommandRun as (context: unknown) => Promise<Record<string, unknown>>;
    const starterRun = await runStarterCommand({
      command: "starter ping",
      options: { name: "  starter  " },
    });
    expect(starterRun.hello).toBe("starter");
    expect(starterRun.hook_counts).toEqual({
      before: 1,
      after: 1,
      write: 1,
      read: 1,
      index: 1,
    });

    const starterFallbackRun = await runStarterCommand({
      command: "starter ping",
      options: null,
    });
    expect(starterFallbackRun.hello).toBe("agent");

    // Whitespace-only name collapses to empty after trim, hitting the
    // `rawName.length > 0 ? rawName : "agent"` false arm.
    const starterBlankNameRun = await runStarterCommand({
      command: "starter ping",
      options: { name: "   " },
    });
    expect(starterBlankNameRun.hello).toBe("agent");

    const starterParser = starterCollector.artifacts.parsers[0]?.handler;
    expect(typeof starterParser).toBe("function");
    if (typeof starterParser !== "function") {
      throw new TypeError("starter parser handler was not registered");
    }
    const parseStarterCommand = starterParser as (context: unknown) => Promise<Record<string, unknown>>;
    const parsed = await parseStarterCommand({
      options: { name: "  agent  " },
    });
    expect(parsed.options).toEqual({ name: "agent" });

    // Non-string name skips the trim branch.
    const parsedNonString = await parseStarterCommand({
      options: { name: 42 },
    });
    expect(parsedNonString.options).toEqual({ name: 42 });

    const preflight = starterCollector.artifacts.preflights[0];
    expect(preflight).toBeDefined();
    if (preflight === undefined) {
      throw new TypeError("starter preflight handler was not registered");
    }
    const preflightOther = preflight({ command: "context" }) as Record<string, unknown>;
    const preflightStarter = preflight({ command: "starter ping" }) as Record<string, unknown>;
    expect(preflightOther).toEqual({});
    expect(preflightStarter).toEqual({ run_extension_migrations: false });

    const outputService = starterCollector.artifacts.services.find((service) => service.name === "output_format");
    expect(outputService).toBeDefined();
    if (outputService === undefined) {
      throw new TypeError("starter output service was not registered");
    }
    expect(
      outputService.handler({
        command: "starter ping",
        payload: { result: starterRun },
        options: { uppercase: true },
      }),
    ).toBe("starter_service_output hello=STARTER command=starter ping");
    // uppercase absent/non-true exercises the `uppercase ? ... : helloRaw` else arm.
    expect(
      outputService.handler({
        command: "starter ping",
        payload: { result: starterRun },
        options: { uppercase: false },
      }),
    ).toBe("starter_service_output hello=starter command=starter ping");
    expect(
      outputService.handler({
        command: "context",
        payload: { passthrough: true },
      }),
    ).toEqual({ passthrough: true });

    const jsonRenderer = starterCollector.artifacts.renderers.find((renderer) => renderer.format === "json");
    const toonRenderer = starterCollector.artifacts.renderers.find((renderer) => renderer.format === "toon");
    expect(jsonRenderer).toBeDefined();
    expect(toonRenderer).toBeDefined();
    if (jsonRenderer === undefined || toonRenderer === undefined) {
      throw new TypeError("starter renderers were not registered");
    }
    const renderedJson = jsonRenderer.handler({ command: "starter ping", result: starterRun });
    const renderedToon = toonRenderer.handler({ command: "starter ping", result: starterRun });
    expect(String(renderedJson)).toContain('"source": "starter-extension"');
    expect(String(renderedToon)).toContain("starter_ping");
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(String(jsonRenderer.handler({ command: "starter ping", result: circular }))).toContain(
      '"error": "non_serializable_payload"',
    );
    expect(jsonRenderer.handler({ command: "context", result: {} })).toBeNull();
    expect(toonRenderer.handler({ command: "context", result: {} })).toBeNull();

    // A result whose hook_counts lack before/after exercises the `?? 0` right arms.
    const renderedToonNoHooks = toonRenderer.handler({
      command: "starter ping",
      result: { hello: "x", command: "starter ping", hook_counts: {} },
    });
    expect(String(renderedToonNoHooks)).toContain("hooks.before: 0");
    expect(String(renderedToonNoHooks)).toContain("hooks.after: 0");

    const importer = starterCollector.artifacts.importers[0];
    const exporter = starterCollector.artifacts.exporters[0];
    expect(importer).toBeDefined();
    expect(exporter).toBeDefined();
    if (importer === undefined || exporter === undefined) {
      throw new TypeError("starter importer/exporter handlers were not registered");
    }
    const imported = await importer.handler({
      source: "fixture.json",
      count: 1,
    });
    const exported = await exporter.handler({
      destination: "fixture.json",
      count: 1,
    });
    expect(imported).toMatchObject({ imported: true, source: "starter-extension" });
    expect(exported).toMatchObject({ exported: true, source: "starter-extension" });

    const provider = starterCollector.artifacts.searchProviders[0];
    const providerQuery = provider.query as (context: unknown) => Promise<unknown[]>;
    await expect(providerQuery({ query: "calendar" })).resolves.toEqual([
      {
        id: "starter-result-1",
        score: 1,
        title: "Starter Search Result",
        snippet: "Echo match for: calendar",
        source: "starter-extension",
      },
    ]);
    await expect(providerQuery({ query: "   " })).resolves.toEqual([]);

    const vectorAdapter = starterCollector.artifacts.vectorAdapters[0] as {
      upsert: () => Promise<unknown>;
      query: () => Promise<unknown>;
      delete: () => Promise<unknown>;
    };
    await expect(vectorAdapter.upsert()).resolves.toEqual({ upserted: 0 });
    await expect(vectorAdapter.query()).resolves.toEqual([]);
    await expect(vectorAdapter.delete()).resolves.toEqual({ deleted: 0 });

    const migration = starterCollector.artifacts.migrations[0] as { run: () => Promise<unknown> };
    await expect(migration.run()).resolves.toEqual({ applied: true });
  });
});
