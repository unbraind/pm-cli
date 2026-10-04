/** Prove the executable controller preserves actual safe passes and assertion-sensitive source-mutant failures. */
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { runIfMain } from "../../../scripts/release/agent-evidence-consistency-control.mjs";

describe("agent evidence consistency controls", () => {
  it("passes all real baselines and preserves all unsafe-source failure verdicts", async () => {
    const previousExitCode = process.exitCode;
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await expect(runIfMain("not-the-entrypoint")).resolves.toBeUndefined();
      const filename = fileURLToPath(new URL("../../../scripts/release/agent-evidence-consistency-control.mjs", import.meta.url));
      await expect(runIfMain(filename, ["--unsupported"])).rejects.toThrow("Only --negative-control is supported");
      await runIfMain(filename, []);
      expect(process.exitCode).toBe(0);
      await runIfMain(filename, ["--negative-control"]);
      expect(process.exitCode).toBe(1);
      const receipts = write.mock.calls.map(([body]) => JSON.parse(String(body)) as { negative_control: boolean; controls: Array<{ name: string; exit_code: number }> });
      expect(receipts.map((receipt) => ({ negative_control: receipt.negative_control, codes: receipt.controls.map((control) => control.exit_code) }))).toEqual([
        { negative_control: false, codes: [0, 0, 0, 0, 0, 0] },
        { negative_control: true, codes: [1, 1, 1, 1, 1, 1] },
      ]);
    } finally {
      process.exitCode = previousExitCode;
      write.mockRestore();
    }
  }, 240_000);
});
