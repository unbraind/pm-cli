import { pathToFileURL } from "node:url";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ARGV = [...process.argv];

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
  process.argv = [...ORIGINAL_ARGV];
  vi.doUnmock("@unbrained/pm-cli/sdk");
  vi.doUnmock("node:child_process");
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("lane-b docs examples", () => {
  it("covers policy and starter extension examples through runtime registration hooks", async () => {
    const policyModule = await importRepoModule<{ default: { activate: (api: Record<string, unknown>) => void } }>(
      "docs/examples/policy-restricted-extension/index.js",
      "policyExample",
    );
    const policyCollector = createExtensionApiCollector();
    policyModule.default.activate(policyCollector.api);
    expect(policyCollector.artifacts.commands).toHaveLength(1);
    expect(policyCollector.artifacts.services).toHaveLength(1);
    expect(policyCollector.artifacts.hooks.beforeCommand).toHaveLength(1);
    policyCollector.artifacts.hooks.beforeCommand[0]?.({ command: "policy demo" });

    const policyRun = await (policyCollector.artifacts.commands[0]?.run as (context: unknown) => Promise<unknown>)({
      command: "policy demo",
      options: {},
    });
    expect(policyRun).toEqual({
      ok: true,
      command: "policy demo",
      source: "policy-restricted-extension",
    });
    expect(
      policyCollector.artifacts.services[0]?.handler({
        ok: true,
      }),
    ).toEqual({ ok: true });

    const starterModule = await importRepoModule<{ default: { activate: (api: Record<string, unknown>) => void } }>(
      "docs/examples/starter-extension/index.js",
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

    starterCollector.artifacts.hooks.beforeCommand[0]?.({ command: "starter ping" });
    starterCollector.artifacts.hooks.afterCommand[0]?.({ command: "starter ping" });
    starterCollector.artifacts.hooks.onWrite[0]?.({ path: "/tmp/item.md" });
    starterCollector.artifacts.hooks.onRead[0]?.({ path: "/tmp/item.md" });
    starterCollector.artifacts.hooks.onIndex[0]?.({ id: "pm-1" });

    const starterRun = await (starterCollector.artifacts.commands[0]?.run as (context: unknown) => Promise<Record<string, unknown>>)({
      command: "starter ping",
      options: { name: "  lane-b  " },
    });
    expect(starterRun.hello).toBe("lane-b");
    expect(starterRun.hook_counts).toEqual({
      before: 1,
      after: 1,
      write: 1,
      read: 1,
      index: 1,
    });
    const starterFallbackRun = await (starterCollector.artifacts.commands[0]?.run as (context: unknown) => Promise<Record<string, unknown>>)({
      command: "starter ping",
      options: null,
    });
    expect(starterFallbackRun.hello).toBe("agent");

    const parsed = await (starterCollector.artifacts.parsers[0]?.handler as (context: unknown) => Promise<Record<string, unknown>>)({
      options: { name: "  agent  " },
    });
    expect(parsed.options).toEqual({ name: "agent" });

    const preflightOther = starterCollector.artifacts.preflights[0]?.({ command: "context" }) as Record<string, unknown>;
    const preflightStarter = starterCollector.artifacts.preflights[0]?.({ command: "starter ping" }) as Record<string, unknown>;
    expect(preflightOther).toEqual({});
    expect(preflightStarter).toEqual({ run_extension_migrations: false });

    const outputService = starterCollector.artifacts.services.find((service) => service.name === "output_format");
    expect(
      outputService?.handler({
        command: "starter ping",
        payload: { result: starterRun },
        options: { uppercase: true },
      }),
    ).toBe("starter_service_output hello=LANE-B command=starter ping");
    expect(
      outputService?.handler({
        command: "context",
        payload: { passthrough: true },
      }),
    ).toEqual({ passthrough: true });

    const jsonRenderer = starterCollector.artifacts.renderers.find((renderer) => renderer.format === "json");
    const toonRenderer = starterCollector.artifacts.renderers.find((renderer) => renderer.format === "toon");
    const renderedJson = jsonRenderer?.handler({ command: "starter ping", result: starterRun });
    const renderedToon = toonRenderer?.handler({ command: "starter ping", result: starterRun });
    expect(String(renderedJson)).toContain('"source": "starter-extension"');
    expect(String(renderedToon)).toContain("starter_ping");
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(String(jsonRenderer?.handler({ command: "starter ping", result: circular }))).toContain(
      '"error": "non_serializable_payload"',
    );
    expect(jsonRenderer?.handler({ command: "context", result: {} })).toBeNull();
    expect(toonRenderer?.handler({ command: "context", result: {} })).toBeNull();

    const imported = await starterCollector.artifacts.importers[0]?.handler({
      source: "fixture.json",
      count: 1,
    });
    const exported = await starterCollector.artifacts.exporters[0]?.handler({
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

  it("covers sdk-app-embedding script branches with mocked pm subprocess calls", async () => {
    vi.doUnmock("@unbrained/pm-cli/sdk");
    const embeddedScript = "docs/examples/sdk-app-embedding/run-embedded-pm.mjs";
    const outputSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    process.argv = ["node", "run-embedded-pm.mjs", "extension-reload"];
    const successSpawn = vi.fn((command: string, args: string[]) => {
      expect(command).toBe("pm");
      if (args[0] === "contracts") {
        return {
          status: 0,
          stdout: JSON.stringify({
            action_availability: [{ action: "extension-reload", available: true, policy_state: "enabled" }],
          }),
          stderr: "",
        };
      }
      return {
        status: 0,
        stdout: JSON.stringify({ ok: true, command: args.join(" ") }),
        stderr: "",
      };
    });
    vi.doMock("node:child_process", () => ({ spawnSync: successSpawn }));
    await importRepoModule(embeddedScript, "embeddedSuccess");
    expect(successSpawn).toHaveBeenCalledTimes(2);
    expect(String(outputSpy.mock.calls.at(-1)?.[0] ?? "")).toContain('"action": "extension-reload"');
    expect(String(outputSpy.mock.calls.at(-1)?.[0] ?? "")).toContain('"command": "pm extension --reload --project --json"');

    vi.resetModules();
    process.argv = ["node", "run-embedded-pm.mjs", "extension-reload"];
    vi.doMock("@unbrained/pm-cli/sdk", () => ({
      PM_TOOL_ACTION_PARAMETER_CONTRACTS: {
        "extension-reload": {},
      },
      isPmToolAction: () => true,
    }));
    vi.doMock("node:child_process", () => ({
      spawnSync: vi.fn((command: string, args: string[]) => {
        if (command !== "pm") {
          throw new Error("unexpected command");
        }
        if (args[0] === "contracts") {
          return {
            status: 0,
            stdout: JSON.stringify({ actions: ["extension-reload"] }),
            stderr: "",
          };
        }
        return {
          status: 0,
          stdout: JSON.stringify({ ok: true }),
          stderr: "",
        };
      }),
    }));
    await importRepoModule(embeddedScript, "embeddedContractFallbacks");
    expect(String(outputSpy.mock.calls.at(-1)?.[0] ?? "")).toContain('"required_parameters": []');
    expect(String(outputSpy.mock.calls.at(-1)?.[0] ?? "")).toContain('"optional_parameters": []');

    vi.resetModules();
    process.argv = ["node", "run-embedded-pm.mjs", "extension-reload"];
    vi.doMock("@unbrained/pm-cli/sdk", () => ({
      PM_TOOL_ACTION_PARAMETER_CONTRACTS: {
        "extension-reload": { required: [], optional: [] },
      },
      isPmToolAction: () => true,
    }));
    vi.doMock("node:child_process", () => ({
      spawnSync: vi.fn(() => ({
        status: 0,
        stdout: JSON.stringify({
          action_availability: [{ action: "extension-reload", available: false }],
        }),
        stderr: "",
      })),
    }));
    await expect(importRepoModule(embeddedScript, "embeddedUnavailableUnknownReason")).rejects.toThrow(
      'Action "extension-reload" is not available in this runtime (unknown_reason).',
    );

    vi.resetModules();
    vi.doUnmock("@unbrained/pm-cli/sdk");
    process.argv = ["node", "run-embedded-pm.mjs", "contracts"];
    vi.doMock("node:child_process", () => ({
      spawnSync: vi.fn(() => ({
        status: 0,
        stdout: JSON.stringify({
          action_availability: [{ action: "contracts", available: false, disabled_reason: "policy_blocked" }],
          actions: ["contracts"],
        }),
        stderr: "",
      })),
    }));
    await expect(importRepoModule(embeddedScript, "embeddedUnavailable")).rejects.toThrow(
      'Action "contracts" is not available in this runtime (policy_blocked).',
    );

    vi.resetModules();
    process.argv = ["node", "run-embedded-pm.mjs", "not-a-real-action"];
    vi.doMock("node:child_process", () => ({ spawnSync: vi.fn() }));
    await expect(importRepoModule(embeddedScript, "embeddedUnsupported")).rejects.toThrow(
      'Unsupported pm action "not-a-real-action".',
    );

    vi.resetModules();
    process.argv = ["node", "run-embedded-pm.mjs", "extension-reload"];
    vi.doMock("node:child_process", () => ({
      spawnSync: vi.fn(() => ({
        status: 1,
        stdout: "",
        stderr: "pm contracts failed",
      })),
    }));
    await expect(importRepoModule(embeddedScript, "embeddedContractsFailure")).rejects.toThrow("pm contracts failed");
  });

  it("covers sdk-contract-consumer script branches with mocked contract responses", async () => {
    vi.doUnmock("@unbrained/pm-cli/sdk");
    const contractsScript = "docs/examples/sdk-contract-consumer/inspect-contracts.mjs";
    const outputSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    process.argv = ["node", "inspect-contracts.mjs", "create"];
    vi.doMock("node:child_process", () => ({
      spawnSync: vi.fn(() => ({
        status: 0,
        stdout: JSON.stringify({
          actions: ["create", "update"],
          action_availability: [{ action: "create", available: true, policy_state: "enabled" }],
          extension_contracts: {
            compatibility: "compatible",
            manifest_versions: [1, 2],
          },
        }),
        stderr: "",
      })),
    }));
    await importRepoModule(contractsScript, "contractsSuccess");
    expect(String(outputSpy.mock.calls.at(-1)?.[0] ?? "")).toContain('"action": "create"');
    expect(String(outputSpy.mock.calls.at(-1)?.[0] ?? "")).toContain('"runtime_available": true');

    vi.resetModules();
    process.argv = ["node", "inspect-contracts.mjs", "create"];
    vi.doMock("@unbrained/pm-cli/sdk", () => ({
      PM_TOOL_ACTION_PARAMETER_CONTRACTS: {
        create: {},
      },
      isPmToolAction: () => true,
    }));
    vi.doMock("node:child_process", () => ({
      spawnSync: vi.fn(() => ({
        status: 0,
        stdout: JSON.stringify({
          actions: ["create"],
          action_availability: null,
          extension_contracts: null,
        }),
        stderr: "",
      })),
    }));
    await importRepoModule(contractsScript, "contractsFallbackPayload");
    expect(String(outputSpy.mock.calls.at(-1)?.[0] ?? "")).toContain('"required_parameters": []');
    expect(String(outputSpy.mock.calls.at(-1)?.[0] ?? "")).toContain('"optional_parameters": []');
    expect(String(outputSpy.mock.calls.at(-1)?.[0] ?? "")).toContain('"any_of_required_groups": []');

    vi.resetModules();
    vi.doUnmock("@unbrained/pm-cli/sdk");
    process.argv = ["node", "inspect-contracts.mjs", "invalid-action"];
    vi.doMock("node:child_process", () => ({ spawnSync: vi.fn() }));
    await expect(importRepoModule(contractsScript, "contractsUnsupported")).rejects.toThrow(
      'Unsupported pm action "invalid-action".',
    );

    vi.resetModules();
    process.argv = ["node", "inspect-contracts.mjs", "create"];
    vi.doMock("node:child_process", () => ({
      spawnSync: vi.fn(() => ({
        status: 0,
        stdout: JSON.stringify({
          actions: ["update"],
        }),
        stderr: "",
      })),
    }));
    await expect(importRepoModule(contractsScript, "contractsUnavailable")).rejects.toThrow(
      'Action "create" is not currently invocable in this runtime.',
    );

    vi.resetModules();
    process.argv = ["node", "inspect-contracts.mjs", "create"];
    vi.doMock("node:child_process", () => ({
      spawnSync: vi.fn(() => ({
        status: 1,
        stdout: "",
        stderr: "pm contracts failed hard",
      })),
    }));
    await expect(importRepoModule(contractsScript, "contractsFailure")).rejects.toThrow("pm contracts failed hard");
  });
});
