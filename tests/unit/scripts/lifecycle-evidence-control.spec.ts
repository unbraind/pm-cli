import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runIfMain,
  runLifecycleEvidenceControl,
} from "../../../scripts/release/lifecycle-evidence-control.mjs";

describe("lifecycle evidence mutation controls", () => {
  afterEach(() => {
    process.exitCode = 0;
    vi.restoreAllMocks();
  });

  it.each(["claim-receipts", "update-coverage"])(
    "passes the actual %s baseline",
    async (control) => {
      expect(await runLifecycleEvidenceControl(control)).toMatchObject({
        negative_control: false,
        exit_code: 0,
      });
    },
    120_000,
  );

  it.each([
    { args: ["--negative-control"], evidence: "shares MCP projection" },
    {
      args: ["--update-coverage", "--negative-control"],
      evidence: '"update_health_coverage": "full"',
    },
  ])(
    "fails the unsafe mutant selected by $args",
    async ({ args, evidence }) => {
      const output = vi
        .spyOn(process.stdout, "write")
        .mockImplementation(() => true);
      await runIfMain("not-the-entrypoint");
      const filename = fileURLToPath(
        new URL(
          "../../../scripts/release/lifecycle-evidence-control.mjs",
          import.meta.url,
        ),
      );
      await runIfMain(filename, args);
      expect(process.exitCode).toBe(1);
      expect(output).toHaveBeenCalledWith(expect.stringContaining(evidence));
    },
    120_000,
  );
});
