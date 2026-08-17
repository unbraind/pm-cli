import { describe, expect, it, vi } from "vitest";
import { PM_COMMAND_DESTINATION_CONTRACTS } from "../../../../src/sdk/cli-contracts/grammar-contracts.js";
import { createScriptHarness } from "../../../helpers/scriptModule.js";

const harness = createScriptHarness();

async function runGrammarGate(commandSummaries: unknown): Promise<{
  report: { ok: boolean; command_count: number };
  exitCode: number | string | null | undefined;
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

  await harness.importModule(
    "scripts/release/command-grammar-gate.mjs",
    "commandGrammarGate",
  );
  expect(execFileSync).toHaveBeenCalledWith(
    process.execPath,
    expect.arrayContaining(["contracts", "--summary", "--json"]),
    expect.objectContaining({ encoding: "utf8" }),
  );
  return {
    report: JSON.parse(output) as { ok: boolean; command_count: number },
    exitCode: process.exitCode,
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
    });
    expect(result.exitCode).not.toBe(1);
  });

  it("fails closed when the contracts response omits its summary array", async () => {
    const result = await runGrammarGate(undefined);
    expect(result.report.ok).toBe(false);
    expect(result.report.command_count).toBe(0);
    expect(result.exitCode).toBe(1);
  });
});
