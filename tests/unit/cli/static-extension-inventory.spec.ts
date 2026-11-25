import { execFileSync } from "node:child_process";
import fs, { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { registerSetupCommands } from "../../../src/cli/register-setup.js";
import { isStaticExtensionInventoryInvocation, shouldRegisterDynamicExtensionPaths } from "../../../src/cli/runtime/selection.js";
import { createPmCliProgram } from "../../../src/sdk/cli-program.js";
import { inspectStaticExtensionInventory, readStaticDefaultOutputFormat, readStaticDeprecationHints, refuseStaticInventoryForeignOptions, refuseStaticInventoryReadOutputControls } from "../../../src/sdk/extension/static-inventory.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

describe("static inventory foreign lifecycle options", () => {
  it("refuses options of other package actions and accepts the already-satisfied --offline (Codex review round 13)", () => {
    expect(() => refuseStaticInventoryForeignOptions({ offline: true, fields: "name", global: true })).not.toThrow();
    expect(() => refuseStaticInventoryForeignOptions({ fixManagedState: false })).not.toThrow();
    expect(() => refuseStaticInventoryForeignOptions({ fixManagedState: true })).toThrow("--fix-managed-state does not apply to pm package list");
    expect(() => refuseStaticInventoryForeignOptions({ runtimeProbe: true, detail: "deep" })).toThrow("--runtime-probe, --detail do not apply");
    // Action selectors and their arguments the parent command accepts are refused too (Codex review round 14).
    expect(() => refuseStaticInventoryForeignOptions({ install: true, output: "report.md" })).toThrow("--install, --output do not apply");
    // pm package --describe list reaches the list subcommand through Commander; it is refused, never silently listed (CodeRabbit review round 9).
    expect(() => refuseStaticInventoryForeignOptions({ describe: true })).toThrow("--describe does not apply");
  });
});

describe("static inventory read-output controls", () => {
  it("refuses every row-shaping control and keeps format and an unbounded budget", () => {
    expect(() => refuseStaticInventoryReadOutputControls({})).not.toThrow();
    // The raw format is validated before host option parsing could drop it (Codex review round 6).
    expect(() => refuseStaticInventoryReadOutputControls({ outputFormat: "json" })).not.toThrow();
    expect(() => refuseStaticInventoryReadOutputControls({ outputFormat: "jsno" })).toThrow("--output-format must be toon or json.");
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
    // Inherited host options between the noun and the verb skip their values (Codex review round 4).
    expect(isStaticExtensionInventoryInvocation(["package", "--pm-path", "/work/tracker", "list"])).toBe(true);
    expect(isStaticExtensionInventoryInvocation(["package", "--output-budget", "unbounded", "list"])).toBe(true);
    // Decided on the invocation Commander parses: a runner-injected pm token and a leading -- (Codex review round 5).
    expect(isStaticExtensionInventoryInvocation(["pm", "package", "list"])).toBe(true);
    expect(isStaticExtensionInventoryInvocation(["--", "package", "list"])).toBe(true);
    // A terminator after host options still routes to the command (Codex review round 6).
    expect(isStaticExtensionInventoryInvocation(["--json", "--", "package", "list"])).toBe(true);
    // A -- that is a host option's value is not a terminator (Codex review round 7).
    expect(isStaticExtensionInventoryInvocation(["--pm-path", "--", "package", "list"])).toBe(true);
    // The first -- is the path value, the second ends option parsing (Codex review round 9).
    expect(isStaticExtensionInventoryInvocation(["--pm-path", "--", "--json", "--", "package", "list"])).toBe(true);
    // An invocation normalization refuses is never treated as the static listing.
    expect(isStaticExtensionInventoryInvocation(["get", "pm-1", "--id", "pm-2"])).toBe(false);
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
        await expect(run(["package", "list", "--fields", "name,alias"])).rejects.toMatchObject({
          message: "Package list --fields has unknown field(s): alias",
          context: { recovery: { allowed_values: ["name", "directory", "scope", "installed", "status", "configured_enabled", "managed", "runtime_active", "version", "update"] } },
        });
        // The static listing applies no row-shaping output controls, so it refuses them instead of ignoring them.
        await expect(run(["package", "list", "--output-limit", "1"])).rejects.toMatchObject({ context: { code: "read_output_surface_unsupported", details: { output_option_keys: ["--output-limit"] } } });
        // The tracker's configured default format applies to the static listing too (Codex review round 9).
        const settingsPath = path.join(pmPath, "settings.json");
        const settings = JSON.parse(await readFile(settingsPath, "utf8"));
        await writeFile(settingsPath, JSON.stringify({ ...settings, output: { ...settings.output, default_format: "toon" } }));
        expect(await readStaticDefaultOutputFormat(pmPath)).toBe("toon");
        await writeFile(settingsPath, JSON.stringify({ ...settings, output: { ...settings.output, default_format: "yaml" } }));
        expect(await readStaticDefaultOutputFormat(pmPath)).toBeUndefined();
        // Without --json the listing renders in the tracker's default format.
        await writeFile(settingsPath, JSON.stringify({ ...settings, output: { ...settings.output, default_format: "json" } }));
        const program = createPmCliProgram("test");
        registerSetupCommands(program);
        await program.parseAsync(["--pm-path", pmPath, "package", "list", "--fields", "name"], { from: "user" });
        expect(JSON.parse(output.pop() ?? "{}").extensions).toEqual([{ name: "source-probe" }]);
        await writeFile(settingsPath, JSON.stringify(settings));
        expect(await readStaticDefaultOutputFormat(path.join(pmPath, "missing"))).toBeUndefined();
        // A settings path that is not a regular file, or a document that is not an object, yields no defaults.
        const odd = path.join(pmPath, "odd-root");
        await mkdir(path.join(odd, "settings.json"), { recursive: true });
        expect(await readStaticDefaultOutputFormat(odd)).toBeUndefined();
        await rm(path.join(odd, "settings.json"), { recursive: true });
        await writeFile(path.join(odd, "settings.json"), "null");
        expect(await readStaticDefaultOutputFormat(odd)).toBeUndefined();
        expect(await readStaticDeprecationHints(odd)).toBe(true);
        // Deprecation hints default on and follow ux.deprecation_hints; the deprecated extension spelling prints one.
        expect(await readStaticDeprecationHints(pmPath)).toBe(true);
        const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        try {
          await run(["extension", "list", "--fields", "name"]);
          output.pop();
          expect(stderr.mock.calls.map(([chunk]) => String(chunk)).join("")).toContain("extension");
          stderr.mockClear();
          await writeFile(settingsPath, JSON.stringify({ ...settings, ux: { ...settings.ux, deprecation_hints: false } }));
          expect(await readStaticDeprecationHints(pmPath)).toBe(false);
          await run(["extension", "list", "--fields", "name"]);
          output.pop();
          expect(stderr).not.toHaveBeenCalled();
        } finally {
          stderr.mockRestore();
          await writeFile(settingsPath, JSON.stringify(settings));
        }
        // An explicit encoding never needs the settings default.
        await run(["package", "list", "--output-format", "json", "--fields", "name"]);
        expect(JSON.parse(output.pop() ?? "{}").extensions).toEqual([{ name: "source-probe" }]);
        await run(["package", "list", "--output-budget", "unbounded"]);
        expect(JSON.parse(output.pop() ?? "{}")).toMatchObject({ updates_available: 1 });
        // The receipt and the update evidence come from one managed-state snapshot, read the way the runtime loader
        // reads it (following a link), so a linked file reports the same update in both (Codex review round 15).
        const managedPath = path.join(pmPath, "extensions", ".managed-extensions.json");
        const managedText = await readFile(managedPath, "utf8");
        const elsewhere = path.join(pmPath, "managed-elsewhere.json");
        await writeFile(elsewhere, managedText);
        await rm(managedPath);
        await symlink(elsewhere, managedPath);
        await run(["package", "list", "--fields", "name,update"]);
        expect(JSON.parse(output.pop() ?? "{}").extensions).toEqual([{ name: "source-probe", update: "1.2.0" }]);
        await rm(managedPath);
        await writeFile(managedPath, managedText);
        await expect(run(["package", "list", "--fix-managed-state"])).rejects.toThrow("--fix-managed-state does not apply");
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

describe("static inventory manifest reads", () => {
  it.skipIf(process.platform === "win32")("reports a FIFO manifest as unreadable instead of hanging, and still follows a linked manifest (Codex review round 13)", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const fifoRoot = path.join(pmPath, "extensions", "fifo-probe");
      const linkRoot = path.join(pmPath, "extensions", "link-probe");
      await mkdir(fifoRoot, { recursive: true });
      await mkdir(linkRoot, { recursive: true });
      execFileSync("mkfifo", [path.join(fifoRoot, "manifest.json")]);
      const real = path.join(pmPath, "link-probe-manifest.json");
      await writeFile(real, JSON.stringify({ name: "link-probe", version: "1.0.0", entry: "./index.mjs", manifest_version: 1, capabilities: [] }));
      await symlink(real, path.join(linkRoot, "manifest.json"));
      const result = await inspectStaticExtensionInventory({ pmPath, pmRoot: pmPath } as never);
      expect(result.complete).toBe(false);
      expect(result.errors).toContainEqual({ code: "manifest_unreadable", path: path.join(fifoRoot, "manifest.json") });
      expect(result.extensions.find((entry) => entry.directory === "link-probe")).toMatchObject({ name: "link-probe", status: "installed" });
      // A manifest read that fails for a reason other than absence is unreadable, not invalid.
      const spy = vi.spyOn(fs, "open").mockRejectedValue(Object.assign(new Error("denied"), { code: "EACCES" }));
      try {
        const denied = await inspectStaticExtensionInventory({ pmRoot: pmPath, name: "link-probe" });
        expect(denied.errors).toContainEqual({ code: "manifest_unreadable", path: path.join(linkRoot, "manifest.json") });
      } finally {
        spy.mockRestore();
      }
    });
  });
});
