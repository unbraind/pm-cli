/** Prove the executable controller preserves actual safe passes and assertion-sensitive source-mutant failures. */
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { runIfMain } from "../../../scripts/release/agent-evidence-consistency-control.mjs";

describe("agent evidence consistency controls", () => {
  it("refuses unsupported arguments and ignores other entrypoints", async () => {
    await expect(runIfMain("not-the-entrypoint")).resolves.toBeUndefined();
    const filename = fileURLToPath(new URL("../../../scripts/release/agent-evidence-consistency-control.mjs", import.meta.url));
    await expect(runIfMain(filename, ["--unsupported"])).rejects.toThrow("Only --negative-control is supported");
  });

  it.each([
    { negativeControl: false, expectedCode: 0 },
    { negativeControl: true, expectedCode: 1 },
  ])("preserves real verdicts for negative_control=$negativeControl", async ({ negativeControl, expectedCode }) => {
    const previousExitCode = process.exitCode;
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const filename = fileURLToPath(new URL("../../../scripts/release/agent-evidence-consistency-control.mjs", import.meta.url));
      await runIfMain(filename, negativeControl ? ["--negative-control"] : []);
      expect(process.exitCode).toBe(expectedCode);
      const receipts = write.mock.calls.map(([body]) => JSON.parse(String(body)) as { negative_control: boolean; controls: Array<{ name: string; exit_code: number }> });
      expect(receipts.map((receipt) => ({ negative_control: receipt.negative_control, codes: receipt.controls.map((control) => control.exit_code) }))).toEqual([
        { negative_control: negativeControl, codes: Array.from({ length: 15 }, () => expectedCode) },
      ]);
    } finally {
      process.exitCode = previousExitCode;
      write.mockRestore();
    }
  }, 240_000);
});
