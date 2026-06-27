import { afterEach, describe, expect, it, vi } from "vitest";
import { importExampleScript, resetExampleScriptHarness } from "./example-script-harness.js";

/**
 * Branch coverage for the sdk-app-embedding reference script
 * (docs/examples/sdk-app-embedding/run-embedded-pm.mjs), driven by mocking the
 * pm subprocess (node:child_process) and the SDK contract exports.
 */

afterEach(resetExampleScriptHarness);

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
    await importExampleScript(SCRIPT, "embeddedSuccess");
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
    await importExampleScript(SCRIPT, "embeddedContractFallbacks");
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
    await expect(importExampleScript(SCRIPT, "embeddedUnavailableUnknownReason")).rejects.toThrow(
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
    await expect(importExampleScript(SCRIPT, "embeddedUnavailable")).rejects.toThrow(
      'Action "contracts" is not available in this runtime (policy_blocked).',
    );

    vi.resetModules();
    process.argv = ["node", "run-embedded-pm.mjs", "not-a-real-action"];
    vi.doMock("node:child_process", () => ({ spawnSync: vi.fn() }));
    await expect(importExampleScript(SCRIPT, "embeddedUnsupported")).rejects.toThrow(
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
    await expect(importExampleScript(SCRIPT, "embeddedContractsFailure")).rejects.toThrow("pm contracts failed");

    // Failure with empty stderr exercises the `?? ""` and ternary-else exit-code message.
    vi.resetModules();
    process.argv = ["node", "run-embedded-pm.mjs", "extension-reload"];
    vi.doMock("node:child_process", () => ({
      spawnSync: vi.fn(() => ({ status: 7, stdout: null, stderr: null })),
    }));
    await expect(importExampleScript(SCRIPT, "embeddedContractsFailureNoStderr")).rejects.toThrow(
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
    await importExampleScript(SCRIPT, "embeddedDefaultActionEmptyStdout");
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
    await importExampleScript(SCRIPT, "embeddedUnmappedAction");
    expect(String(outputSpy.mock.calls.at(-1)?.[0] ?? "")).toContain('"command": "pm stats --json"');
  });
});
