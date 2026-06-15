import { pathToFileURL } from "node:url";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Branch coverage for the sdk-app-embedding reference script
 * (docs/examples/sdk-app-embedding/run-embedded-pm.mjs), driven by mocking the
 * pm subprocess (node:child_process) and the SDK contract exports.
 */

const ORIGINAL_ARGV = [...process.argv];

function cacheBustToken(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function importRepoModule<T>(relativePath: string, queryPrefix: string): Promise<T> {
  const absolutePath = path.join(process.cwd(), relativePath);
  return (await import(`${pathToFileURL(absolutePath).href}?${queryPrefix}=${cacheBustToken()}`)) as T;
}

afterEach(() => {
  process.argv = [...ORIGINAL_ARGV];
  vi.doUnmock("@unbrained/pm-cli/sdk");
  vi.doUnmock("node:child_process");
  vi.restoreAllMocks();
  vi.resetModules();
});

const SCRIPT = "docs/examples/sdk-app-embedding/run-embedded-pm.mjs";

describe("sdk-app-embedding example", () => {
  it("covers run-embedded-pm script branches with mocked pm subprocess calls", async () => {
    vi.doUnmock("@unbrained/pm-cli/sdk");
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
    await importRepoModule(SCRIPT, "embeddedSuccess");
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
    await importRepoModule(SCRIPT, "embeddedContractFallbacks");
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
    await expect(importRepoModule(SCRIPT, "embeddedUnavailableUnknownReason")).rejects.toThrow(
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
    await expect(importRepoModule(SCRIPT, "embeddedUnavailable")).rejects.toThrow(
      'Action "contracts" is not available in this runtime (policy_blocked).',
    );

    vi.resetModules();
    process.argv = ["node", "run-embedded-pm.mjs", "not-a-real-action"];
    vi.doMock("node:child_process", () => ({ spawnSync: vi.fn() }));
    await expect(importRepoModule(SCRIPT, "embeddedUnsupported")).rejects.toThrow(
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
    await expect(importRepoModule(SCRIPT, "embeddedContractsFailure")).rejects.toThrow("pm contracts failed");

    // Failure with empty stderr exercises the `?? ""` and ternary-else exit-code message.
    vi.resetModules();
    process.argv = ["node", "run-embedded-pm.mjs", "extension-reload"];
    vi.doMock("node:child_process", () => ({
      spawnSync: vi.fn(() => ({ status: 7, stdout: null, stderr: null })),
    }));
    await expect(importRepoModule(SCRIPT, "embeddedContractsFailureNoStderr")).rejects.toThrow(
      "pm contracts --json failed with exit code 7",
    );

    // Default action (no argv[2]) + an action absent from commandMap + null/empty
    // stdout on the command call exercise the remaining nullish/ternary right arms.
    vi.resetModules();
    process.argv = ["node", "run-embedded-pm.mjs"];
    vi.doMock("@unbrained/pm-cli/sdk", () => ({
      PM_TOOL_ACTION_PARAMETER_CONTRACTS: {
        "extension-reload": { required: ["a"], optional: ["b"] },
      },
      isPmToolAction: () => true,
    }));
    vi.doMock("node:child_process", () => ({
      spawnSync: vi.fn((command: string, args: string[]) => {
        if (args[0] === "contracts") {
          return { status: 0, stdout: JSON.stringify({ action_availability: "not-an-array" }), stderr: "" };
        }
        return { status: 0, stdout: null, stderr: "" };
      }),
    }));
    await importRepoModule(SCRIPT, "embeddedDefaultActionEmptyStdout");
    expect(String(outputSpy.mock.calls.at(-1)?.[0] ?? "")).toContain('"action": "extension-reload"');
    expect(String(outputSpy.mock.calls.at(-1)?.[0] ?? "")).toContain('"result": {}');
    expect(String(outputSpy.mock.calls.at(-1)?.[0] ?? "")).toContain('"policy_state": null');

    // An available action that is NOT one of the mapped commands hits the
    // `commandMap[action] ?? [action, "--json"]` right arm and the
    // `.find(...) ?? null` / `entry?.action` undefined-entry guards.
    vi.resetModules();
    process.argv = ["node", "run-embedded-pm.mjs", "stats"];
    vi.doMock("@unbrained/pm-cli/sdk", () => ({
      PM_TOOL_ACTION_PARAMETER_CONTRACTS: { stats: { required: [], optional: [] } },
      isPmToolAction: () => true,
    }));
    vi.doMock("node:child_process", () => ({
      spawnSync: vi.fn((command: string, args: string[]) => {
        if (args[0] === "contracts") {
          return {
            status: 0,
            stdout: JSON.stringify({ action_availability: [null, { action: "other" }] }),
            stderr: "",
          };
        }
        return { status: 0, stdout: JSON.stringify({ ok: true }), stderr: "" };
      }),
    }));
    await importRepoModule(SCRIPT, "embeddedUnmappedAction");
    expect(String(outputSpy.mock.calls.at(-1)?.[0] ?? "")).toContain('"command": "pm stats --json"');
  });
});
