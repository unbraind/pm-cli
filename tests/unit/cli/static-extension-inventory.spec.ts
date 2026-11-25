import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { registerSetupCommands } from "../../../src/cli/register-setup.js";
import { isStaticExtensionInventoryInvocation, shouldRegisterDynamicExtensionPaths } from "../../../src/cli/runtime/selection.js";
import { createPmCliProgram } from "../../../src/sdk/cli-program.js";
import { refuseStaticInventoryReadOutputControls } from "../../../src/sdk/extension/static-inventory.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

describe("static inventory read-output controls", () => {
  it("refuses every row-shaping control and keeps format and an unbounded budget", () => {
    expect(() => refuseStaticInventoryReadOutputControls({})).not.toThrow();
    expect(() => refuseStaticInventoryReadOutputControls({ outputBudget: "unbounded", outputRowContract: false })).not.toThrow();
    expect(() => refuseStaticInventoryReadOutputControls({
      outputLimit: "1", outputInclude: "name", outputSession: "s", outputCursor: "c", outputRowContract: true, outputBudget: "100",
    })).toThrow(expect.objectContaining({
      context: expect.objectContaining({
        code: "read_output_surface_unsupported",
        details: { command: "package list", output_option_keys: ["--output-limit", "--output-include", "--output-session", "--output-cursor", "--output-row-contract", "--output-budget"] },
      }),
    }));
  });
});

describe("static extension inventory command routing", () => {
  it("selects static invocations before dynamic extension registration", () => {
    const program = createPmCliProgram("test");
    for (const name of ["package", "packages", "extension"]) {
      for (const verb of ["inventory", "list"]) {
        expect(isStaticExtensionInventoryInvocation(["--json", name, verb])).toBe(true);
        expect(shouldRegisterDynamicExtensionPaths(program, [name, verb])).toBe(false);
      }
    }
    expect(isStaticExtensionInventoryInvocation(["package", "explore"])).toBe(false);
    expect(isStaticExtensionInventoryInvocation([])).toBe(false);
    expect(isStaticExtensionInventoryInvocation(["package"])).toBe(false);
    // A scope switch Commander accepts before the verb keeps the static path (Codex review round 1).
    expect(isStaticExtensionInventoryInvocation(["package", "--global", "list"])).toBe(true);
    expect(isStaticExtensionInventoryInvocation(["package", "--global", "explore"])).toBe(false);
    // Root switches and valued root options before the verb are skipped, and a value is never read as the verb (Codex review round 2).
    expect(isStaticExtensionInventoryInvocation(["package", "--offline", "list"])).toBe(true);
    expect(isStaticExtensionInventoryInvocation(["package", "--ref", "v1", "list"])).toBe(true);
    expect(isStaticExtensionInventoryInvocation(["package", "--ref", "list"])).toBe(false);
    expect(isStaticExtensionInventoryInvocation(["package", "--global"])).toBe(false);
    // Host flags before the noun are skipped with the host-option grammar (Codex review round 3).
    expect(isStaticExtensionInventoryInvocation(["--no-changed-fields", "package", "list"])).toBe(true);
    expect(isStaticExtensionInventoryInvocation(["--pm-path", "/x", "--author", "a", "packages", "inventory"])).toBe(true);
    expect(isStaticExtensionInventoryInvocation(["--json"])).toBe(false);
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
        // pm-gh1777: list is the installed listing, with the update the last manage check observed for this version.
        const installedAt = "2026-10-04T00:00:00.000Z";
        await writeFile(path.join(pmPath, "extensions", ".managed-extensions.json"), JSON.stringify({
          version: 1, updated_at: installedAt,
          entries: [{ name: "source-probe", directory: "source-probe", scope: "project", manifest_version: "1.0.0", manifest_entry: "./index.mjs", capabilities: [], installed_at: installedAt, updated_at: installedAt, source: { kind: "npm", input: "npm:source-probe", location: "package", package: "source-probe", version: "1.0.0" } }],
        }));
        await mkdir(path.join(pmPath, "runtime"), { recursive: true });
        await writeFile(path.join(pmPath, "runtime", "extension-update-observations.json"), JSON.stringify({
          version: 1,
          observations: [{ name: "source-probe", installed_version: "1.0.0", installed_updated_at: installedAt, remote_version: "1.2.0", update_available: true, checked_at: "2026-11-24T10:00:00.000Z" }],
        }));
        await run(["package", "list"]);
        expect(JSON.parse(output.pop() ?? "{}")).toMatchObject({ updates_available: 1, extensions: [{ name: "source-probe", version: "1.0.0", update: "1.2.0" }] });
        await run(["package", "list", "--fields", "name,update"]);
        expect(JSON.parse(output.pop() ?? "{}").extensions).toEqual([{ name: "source-probe", update: "1.2.0" }]);
        await expect(run(["package", "list", "--fields", "name,alias"])).rejects.toThrow("Package list --fields must be one of name|directory|scope|installed|status|configured_enabled|managed|runtime_active|version|update; unknown: alias");
        // The static listing applies no row-shaping output controls, so it refuses them instead of ignoring them.
        await expect(run(["package", "list", "--output-limit", "1"])).rejects.toMatchObject({ context: { code: "read_output_surface_unsupported", details: { output_option_keys: ["--output-limit"] } } });
        await run(["package", "list", "--output-budget", "unbounded"]);
        expect(JSON.parse(output.pop() ?? "{}")).toMatchObject({ updates_available: 1 });
        // A same-named copy in another directory does not borrow the managed copy's installation identity.
        const copyRoot = path.join(pmPath, "extensions", "source-probe-copy");
        await mkdir(copyRoot, { recursive: true });
        await writeFile(path.join(copyRoot, "manifest.json"), JSON.stringify({ name: "source-probe", version: "1.0.0", entry: "./index.mjs", manifest_version: 1, capabilities: [] }));
        await run(["package", "list"]);
        const copies = JSON.parse(output.pop() ?? "{}");
        expect(copies.updates_available).toBe(1);
        expect(copies.extensions.map((entry: { directory: string; update: string | null }) => [entry.directory, entry.update])).toEqual([["source-probe", "1.2.0"], ["source-probe-copy", null]]);
        await rm(copyRoot, { recursive: true });
        await run(["package", "list", "absent-probe"]);
        const absent = JSON.parse(output.pop() ?? "{}");
        expect(absent).toMatchObject({ updates_available: 0, extensions: [{ name: "absent-probe", installed: false }] });
        expect(absent.extensions[0]).not.toHaveProperty("update");
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
