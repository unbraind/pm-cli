import { pathToFileURL } from "node:url";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Branch coverage for the policy-restricted-extension reference example
 * (docs/examples/policy-restricted-extension/index.ts), driven through its
 * TypeScript source and a collecting extension API. The `./index.ts` source is
 * itself the manifest entry the loader imports directly via Node's native type
 * stripping (ADR pm-2c28 / pm-m1uz) — there is no compiled `.js`.
 */

function cacheBustToken(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function importRepoModule<T>(relativePath: string, queryPrefix: string): Promise<T> {
  const absolutePath = path.join(process.cwd(), relativePath);
  return (await import(`${pathToFileURL(absolutePath).href}?${queryPrefix}=${cacheBustToken()}`)) as T;
}

interface PolicyArtifacts {
  commands: Array<Record<string, unknown>>;
  services: Array<{ name: string; handler: (context: unknown) => unknown }>;
  beforeCommand: Array<(context: unknown) => unknown>;
}

function createPolicyApi(): { api: Record<string, unknown>; artifacts: PolicyArtifacts } {
  const artifacts: PolicyArtifacts = { commands: [], services: [], beforeCommand: [] };
  const api = {
    registerCommand(command: Record<string, unknown>) {
      artifacts.commands.push(command);
    },
    registerService(name: string, handler: (context: unknown) => unknown) {
      artifacts.services.push({ name, handler });
    },
    hooks: {
      beforeCommand(handler: (context: unknown) => unknown) {
        artifacts.beforeCommand.push(handler);
      },
    },
  };
  return { api, artifacts };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("policy-restricted-extension example", () => {
  it("registers a command, service, and before-command hook with runtime behavior", async () => {
    const policyModule = await importRepoModule<{ default: { activate: (api: Record<string, unknown>) => void } }>(
      "docs/examples/policy-restricted-extension/index.ts",
      "policyExample",
    );
    const collector = createPolicyApi();
    policyModule.default.activate(collector.api);

    expect(collector.artifacts.commands).toHaveLength(1);
    expect(collector.artifacts.services).toHaveLength(1);
    expect(collector.artifacts.beforeCommand).toHaveLength(1);

    collector.artifacts.beforeCommand[0]?.({ command: "policy demo" });

    const run = await (collector.artifacts.commands[0]?.run as (context: unknown) => Promise<unknown>)({
      command: "policy demo",
      options: {},
    });
    expect(run).toEqual({
      ok: true,
      command: "policy demo",
      source: "policy-restricted-extension",
    });

    // The output_format override is an identity formatter: it receives a
    // ServiceOverrideContext and returns its `payload` (the value to format).
    expect(collector.artifacts.services[0]?.handler({ payload: { ok: true } })).toEqual({ ok: true });
  });
});
