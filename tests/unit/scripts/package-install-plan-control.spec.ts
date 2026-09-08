import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runIfMain, runInstallPlanControl } from "../../../scripts/release/package-install-plan-control.mjs";

describe("install-plan mutation control", () => {
  afterEach(() => {
    process.exitCode = 0;
    vi.restoreAllMocks();
  });

  it("passes the real baseline and rejects a source mutation that lies about entry-limit completeness", async () => {
    expect(await runInstallPlanControl()).toMatchObject({ negative_control: false, exit_code: 0 });
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runIfMain("not-the-entrypoint");
    await runIfMain(fileURLToPath(new URL("../../../scripts/release/package-install-plan-control.mjs", import.meta.url)), ["--negative-control"]);
    expect(process.exitCode).toBe(1);
    expect(output).toHaveBeenCalledWith(expect.stringContaining('"complete": true'));
  }, 120_000);
});
