import { describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import {
  main,
  runIfMain,
  verifyFlagLexiconGate,
} from "../../../scripts/release/flag-lexicon-gate.mjs";

describe("flag lexicon gate", () => {
  it("passes the generated corpus and blocks seeded command growth", () => {
    expect(verifyFlagLexiconGate()).toMatchObject({ ok: true, findings: [] });
    expect(verifyFlagLexiconGate({ injectMismatch: true })).toMatchObject({
      ok: false,
      findings: [expect.objectContaining({ code: "budget_exceeded" })],
    });
  });

  it("reports standalone success and negative-control exit status", () => {
    const originalExitCode = process.exitCode;
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      process.exitCode = undefined;
      runIfMain("");
      runIfMain(
        fileURLToPath(
          new URL(
            "../../../scripts/release/flag-lexicon-gate.mjs",
            import.meta.url,
          ),
        ),
      );
      expect(process.exitCode).toBeUndefined();
      expect(main(["--inject-mismatch"])).toMatchObject({ ok: false });
      expect(process.exitCode).toBe(1);
    } finally {
      write.mockRestore();
      process.exitCode = originalExitCode;
    }
  });
});
