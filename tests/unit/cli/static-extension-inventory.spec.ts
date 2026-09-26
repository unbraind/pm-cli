import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { registerSetupCommands } from "../../../src/cli/register-setup.js";
import { isStaticExtensionInventoryInvocation, shouldRegisterDynamicExtensionPaths } from "../../../src/cli/runtime/selection.js";
import { createPmCliProgram } from "../../../src/sdk/cli-program.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

describe("static extension inventory command routing", () => {
  it("selects static invocations before dynamic extension registration", () => {
    const program = createPmCliProgram("test");
    for (const name of ["package", "packages", "extension"]) {
      expect(isStaticExtensionInventoryInvocation(["--json", name, "inventory"])).toBe(true);
      expect(shouldRegisterDynamicExtensionPaths(program, [name, "inventory"])).toBe(false);
    }
    expect(isStaticExtensionInventoryInvocation(["package", "explore"])).toBe(false);
    expect(isStaticExtensionInventoryInvocation([])).toBe(false);
  });

  it("dispatches source CLI inventory with scope and incomplete-read receipts", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const extensionRoot = path.join(pmPath, "extensions", "source-probe");
      await mkdir(extensionRoot, { recursive: true });
      const manifestPath = path.join(extensionRoot, "manifest.json");
      await writeFile(manifestPath, JSON.stringify({ name: "source-probe", version: "1.0.0", entry: "./index.mjs", manifest_version: 1, capabilities: [] }));
      const output: string[] = [];
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
        output.push(String(chunk));
        return true;
      });
      const previousExitCode = process.exitCode;
      try {
        const run = async (args: string[]): Promise<void> => {
          const program = createPmCliProgram("test");
          registerSetupCommands(program);
          await program.parseAsync(["--pm-path", pmPath, "--json", ...args], { from: "user" });
        };
        await run(["package", "inventory", "--project"]);
        expect(JSON.parse(output.pop() ?? "{}")).toMatchObject({ complete: true, extensions: [{ name: "source-probe" }] });
        await run(["packages", "inventory", "--global"]);
        expect(JSON.parse(output.pop() ?? "{}")).toMatchObject({ complete: true, scope: "global", extensions: [] });
        await expect(run(["extension", "inventory", "--global", "--local"])).rejects.toThrow(/mutually exclusive/);
        await writeFile(manifestPath, "{");
        await run(["package", "inventory"]);
        expect(JSON.parse(output.pop() ?? "{}")).toMatchObject({ complete: false, errors: [{ code: "manifest_invalid" }] });
        expect(process.exitCode).not.toBe(0);
      } finally {
        process.exitCode = previousExitCode;
        stdout.mockRestore();
      }
    });
  });
});
