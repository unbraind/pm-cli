import { describe, expect, it, vi } from "vitest";
import { PM_COMMAND_DESTINATION_CONTRACTS } from "../../../../src/sdk/cli-contracts/grammar-contracts.js";
import { createScriptHarness } from "../../../helpers/scriptModule.js";

const harness = createScriptHarness();

async function runGrammarGate(commandSummaries: unknown): Promise<{
  report: {
    ok: boolean;
    command_count: number;
    mcp: { ok: boolean; findings: Array<{ code: string }> };
  };
  exitCode: number | string | null | undefined;
  module: {
    verifyMcpGrammar: (
      actions: string[],
      tools: Array<Record<string, unknown>>,
      narrowActions: Record<string, string>,
    ) => { ok: boolean; findings: Array<{ code: string }> };
  };
}> {
  const execFileSync = vi.fn(() =>
    JSON.stringify({ command_summaries: commandSummaries }),
  );
  vi.doMock("node:child_process", async (importOriginal) => ({
    ...(await importOriginal<typeof import("node:child_process")>()),
    execFileSync,
  }));
  let output = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output += String(chunk);
    return true;
  });

  const module = await harness.importModule<{
    verifyMcpGrammar: (
      actions: string[],
      tools: Array<Record<string, unknown>>,
      narrowActions: Record<string, string>,
    ) => { ok: boolean; findings: Array<{ code: string }> };
  }>("scripts/release/command-grammar-gate.mjs", "commandGrammarGate");
  expect(execFileSync).toHaveBeenCalledWith(
    process.execPath,
    expect.arrayContaining(["contracts", "--summary", "--json"]),
    expect.objectContaining({ encoding: "utf8" }),
  );
  return {
    report: JSON.parse(output) as {
      ok: boolean;
      command_count: number;
      mcp: { ok: boolean; findings: Array<{ code: string }> };
    },
    exitCode: process.exitCode,
    module,
  };
}

describe("command grammar gate", () => {
  it("accepts the exhaustive live destination census and ignores malformed rows", async () => {
    const result = await runGrammarGate([
      ...PM_COMMAND_DESTINATION_CONTRACTS.map(({ command }) => ({ command })),
      null,
      { command: 42 },
      {},
    ]);
    expect(result.report).toMatchObject({
      ok: true,
      command_count: PM_COMMAND_DESTINATION_CONTRACTS.length,
      mcp: { ok: true, findings: [] },
    });
    expect(result.exitCode).not.toBe(1);
  });

  it("fails closed for MCP action and narrow-tool drift", async () => {
    const { module } = await runGrammarGate(
      PM_COMMAND_DESTINATION_CONTRACTS.map(({ command }) => ({ command })),
    );
    const result = module.verifyMcpGrammar(
      ["create"],
      [
        {
          name: "pm_run",
          inputSchema: { properties: { action: { enum: ["update"] } } },
        },
        { name: "pm_run", inputSchema: {} },
        { name: "pm_orphan", inputSchema: {} },
        { name: "pm_unbound", inputSchema: {} },
      ],
      { pm_missing: "create", pm_orphan: "missing" },
    );

    expect(result.ok).toBe(false);
    expect(result.findings.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        "duplicate_mcp_tool",
        "missing_pm_run_action",
        "stale_pm_run_action",
        "missing_narrow_mcp_tool",
        "undiscoverable_narrow_action",
        "unbound_narrow_mcp_tool",
      ]),
    );
  });

  it("rejects a missing or untyped pm_run dispatcher", async () => {
    const { module } = await runGrammarGate(
      PM_COMMAND_DESTINATION_CONTRACTS.map(({ command }) => ({ command })),
    );
    expect(module.verifyMcpGrammar([], [], {}).findings).toContainEqual(
      expect.objectContaining({ code: "missing_pm_run_tool" }),
    );
    expect(
      module.verifyMcpGrammar([], [{ name: "pm_run", inputSchema: {} }], {})
        .findings,
    ).toContainEqual(
      expect.objectContaining({ code: "invalid_pm_run_action_enum" }),
    );
  });

  it("fails closed when the contracts response omits its summary array", async () => {
    const result = await runGrammarGate(undefined);
    expect(result.report.ok).toBe(false);
    expect(result.report.command_count).toBe(0);
    expect(result.exitCode).toBe(1);
  });
});
