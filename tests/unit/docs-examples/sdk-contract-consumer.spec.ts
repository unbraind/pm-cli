import { afterEach, describe, expect, it, vi } from "vitest";
import { importExampleScript, resetExampleScriptHarness } from "./example-script-harness.js";

/**
 * Branch coverage for the sdk-contract-consumer reference script
 * (docs/examples/sdk-contract-consumer/inspect-contracts.mjs), driven by
 * mocking the pm subprocess (node:child_process) and the SDK contract exports.
 */

afterEach(resetExampleScriptHarness);

const SCRIPT = "docs/examples/sdk-contract-consumer/inspect-contracts.mjs";

describe("sdk-contract-consumer example", () => {
  it("covers inspect-contracts script branches with mocked contract responses", async () => {
    vi.doUnmock("@unbrained/pm-cli/sdk");
    const outputSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    process.argv = ["node", "inspect-contracts.mjs", "create"];
    vi.doMock("node:child_process", () => ({
      execFile: vi.fn(),
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
    await importExampleScript(SCRIPT, "contractsSuccess");
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
      execFile: vi.fn(),
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
    await importExampleScript(SCRIPT, "contractsFallbackPayload");
    expect(String(outputSpy.mock.calls.at(-1)?.[0] ?? "")).toContain('"required_parameters": []');
    expect(String(outputSpy.mock.calls.at(-1)?.[0] ?? "")).toContain('"optional_parameters": []');
    expect(String(outputSpy.mock.calls.at(-1)?.[0] ?? "")).toContain('"any_of_required_groups": []');

    vi.resetModules();
    vi.doUnmock("@unbrained/pm-cli/sdk");
    process.argv = ["node", "inspect-contracts.mjs", "invalid-action"];
    vi.doMock("node:child_process", () => ({ execFile: vi.fn(), spawnSync: vi.fn() }));
    await expect(importExampleScript(SCRIPT, "contractsUnsupported")).rejects.toThrow(
      'Unsupported pm action "invalid-action".',
    );

    vi.resetModules();
    process.argv = ["node", "inspect-contracts.mjs", "create"];
    vi.doMock("node:child_process", () => ({
      execFile: vi.fn(),
      spawnSync: vi.fn(() => ({
        status: 0,
        stdout: JSON.stringify({
          actions: ["update"],
        }),
        stderr: "",
      })),
    }));
    await expect(importExampleScript(SCRIPT, "contractsUnavailable")).rejects.toThrow(
      'Action "create" is not currently invocable in this runtime.',
    );

    vi.resetModules();
    process.argv = ["node", "inspect-contracts.mjs", "create"];
    vi.doMock("node:child_process", () => ({
      execFile: vi.fn(),
      spawnSync: vi.fn(() => ({
        status: 1,
        stdout: "",
        stderr: "pm contracts failed hard",
      })),
    }));
    await expect(importExampleScript(SCRIPT, "contractsFailure")).rejects.toThrow("pm contracts failed hard");

    // Failure with null stderr exercises the `?? ""` and exit-code ternary-else.
    vi.resetModules();
    process.argv = ["node", "inspect-contracts.mjs", "create"];
    vi.doMock("node:child_process", () => ({
      execFile: vi.fn(),
      spawnSync: vi.fn(() => ({ status: 4, stdout: null, stderr: null })),
    }));
    await expect(importExampleScript(SCRIPT, "contractsFailureNoStderr")).rejects.toThrow(
      "pm contracts failed with exit code 4",
    );

    vi.resetModules();
    process.argv = ["node", "inspect-contracts.mjs", "create"];
    vi.doMock("node:child_process", () => ({
      execFile: vi.fn(),
      spawnSync: vi.fn(() => ({ error: new Error("spawn pm ENOENT"), status: null, stdout: null, stderr: null })),
    }));
    await expect(importExampleScript(SCRIPT, "contractsSpawnFailure")).rejects.toThrow(
      "Failed to run pm contracts: spawn pm ENOENT",
    );

    vi.resetModules();
    process.argv = ["node", "inspect-contracts.mjs", "create"];
    vi.doMock("node:child_process", () => ({
      execFile: vi.fn(),
      spawnSync: vi.fn(() => ({ status: 0, stdout: "warning before json\n{", stderr: "" })),
    }));
    await expect(importExampleScript(SCRIPT, "contractsMalformedJson")).rejects.toThrow(
      "Failed to parse JSON from pm contracts:",
    );

    // Default action (no argv[2]), non-array actions (the [] fallback) then the
    // not-invocable throw.
    vi.resetModules();
    vi.doUnmock("@unbrained/pm-cli/sdk");
    process.argv = ["node", "inspect-contracts.mjs"];
    let contractsCall = 0;
    vi.doMock("node:child_process", () => ({
      execFile: vi.fn(),
      spawnSync: vi.fn(() => {
        contractsCall += 1;
        if (contractsCall === 1) {
          return { status: 0, stdout: JSON.stringify({ actions: "nope" }), stderr: "" };
        }
        return { status: 0, stdout: null, stderr: "" };
      }),
    }));
    await expect(importExampleScript(SCRIPT, "contractsActionsNotArray")).rejects.toThrow(
      'Action "create" is not currently invocable in this runtime.',
    );

    // Default action present, matched availability entry (covers `.find` hit and
    // `entry?.action`).
    vi.resetModules();
    process.argv = ["node", "inspect-contracts.mjs"];
    vi.doMock("node:child_process", () => ({
      execFile: vi.fn(),
      spawnSync: vi.fn(() => ({
        status: 0,
        stdout: JSON.stringify({
          actions: ["create"],
          action_availability: [null, { action: "create", available: true, policy_state: "enabled" }],
          extension_contracts: { compatibility: "compatible", manifest_versions: [3] },
        }),
        stderr: "",
      })),
    }));
    const consumerOutputSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await importExampleScript(SCRIPT, "contractsDefaultActionMatched");
    expect(String(consumerOutputSpy.mock.calls.at(-1)?.[0] ?? "")).toContain('"runtime_available": true');
    expect(String(consumerOutputSpy.mock.calls.at(-1)?.[0] ?? "")).toContain('"policy_state": "enabled"');
    consumerOutputSpy.mockRestore();

    // Null stdout trims to an empty payload and falls back to the empty contracts
    // object, which then lacks the requested action and surfaces not-invocable.
    vi.resetModules();
    process.argv = ["node", "inspect-contracts.mjs", "create"];
    vi.doMock("node:child_process", () => ({
      execFile: vi.fn(),
      spawnSync: vi.fn(() => ({ status: 0, stdout: null, stderr: "" })),
    }));
    await expect(importExampleScript(SCRIPT, "contractsNullStdout")).rejects.toThrow(
      'Action "create" is not currently invocable in this runtime.',
    );

    // Empty stdout is the real spawnSync-with-encoding no-output shape; it
    // should fall back to an empty contracts object just like null stdout.
    vi.resetModules();
    process.argv = ["node", "inspect-contracts.mjs", "create"];
    vi.doMock("node:child_process", () => ({
      execFile: vi.fn(),
      spawnSync: vi.fn(() => ({ status: 0, stdout: "", stderr: "" })),
    }));
    await expect(importExampleScript(SCRIPT, "contractsEmptyStdout")).rejects.toThrow(
      'Action "create" is not currently invocable in this runtime.',
    );

    // Availability array with no matching entry exercises the `.find(...) ?? null`
    // right arm while the action is still listed in actions.
    vi.resetModules();
    process.argv = ["node", "inspect-contracts.mjs", "create"];
    vi.doMock("node:child_process", () => ({
      execFile: vi.fn(),
      spawnSync: vi.fn(() => ({
        status: 0,
        stdout: JSON.stringify({
          actions: ["create"],
          action_availability: [{ action: "other" }],
          extension_contracts: null,
        }),
        stderr: "",
      })),
    }));
    const consumerOutputSpy2 = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await importExampleScript(SCRIPT, "contractsNoAvailabilityMatch");
    expect(String(consumerOutputSpy2.mock.calls.at(-1)?.[0] ?? "")).toContain('"runtime_available": false');
    expect(String(consumerOutputSpy2.mock.calls.at(-1)?.[0] ?? "")).toContain('"policy_state": null');
    consumerOutputSpy2.mockRestore();
  });
});
