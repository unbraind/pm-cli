import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runIfMain, runLifecycleEvidenceControl } from "../../../scripts/release/lifecycle-evidence-control.mjs";

describe("lifecycle evidence mutation controls", () => {
  afterEach(() => {
    process.exitCode = 0;
    vi.restoreAllMocks();
  });

  it("passes actual claim and freshness baselines while both unsafe mutants fail", async () => {
    expect(await runLifecycleEvidenceControl()).toMatchObject({ negative_control: false, exit_code: 0 });
    expect(await runLifecycleEvidenceControl("update-coverage")).toMatchObject({ negative_control: false, exit_code: 0 });
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runIfMain("not-the-entrypoint");
    const filename = fileURLToPath(new URL("../../../scripts/release/lifecycle-evidence-control.mjs", import.meta.url));
    for (const args of [["--negative-control"], ["--update-coverage", "--negative-control"]]) {
      process.exitCode = 0;
      await runIfMain(filename, args);
      expect(process.exitCode).toBe(1);
    }
    expect(output).toHaveBeenCalledWith(expect.stringContaining("shares MCP projection"));
    expect(output).toHaveBeenCalledWith(expect.stringContaining('"update_health_coverage": "full"'));
  }, 120_000);
});
