import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runExtension } from "../../../src/sdk/extension.js";
import { writeTestExtension } from "../../helpers/extensions.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";
import { inspectWorkspaceHistoryState } from "../../../src/core/history/workspace-history.js";
import { EXIT_CODE } from "../../../src/core/shared/constants.js";
import { PmCliError } from "../../../src/core/shared/errors.js";
import { execFileSync, spawnSync } from "node:child_process";

describe("verified package replacement", () => {
  it("reports that a failed in-place install has no earlier version to recover", async () => {
    await withTempPmPath(async (context) => {
      const source = path.join(context.pmPath, "extensions", "in-place-package");
      await writeTestExtension({ root: source, name: "in-place-package", entrySource: "export function activate() { throw new Error('rejected'); }\n" });
      expect(await runExtension(source, { install: true, project: true }, { path: context.pmPath })).toMatchObject({ ok: false, details: { installed_in_place: true, previous_state_preserved: false } });
    });
  });

  it("restores prior enablement with an audited settings compensation", async () => {
    await withTempPmPath(async (context) => {
      const source = path.join(context.tempRoot, "original");
      await writeTestExtension({ root: source, name: "disabled-package" });
      await runExtension(source, { install: true, project: true }, { path: context.pmPath });
      await runExtension("disabled-package", { deactivate: true, project: true }, { path: context.pmPath });
      const settingsPath = path.join(context.pmPath, "settings.json");
      const before = await fs.readFile(settingsPath);
      const replacement = path.join(context.tempRoot, "replacement");
      await writeTestExtension({ root: replacement, name: "disabled-package", manifestOverrides: { version: "2.0.0" }, entrySource: "export function activate() { throw new Error('rejected'); }\n" });
      expect((await runExtension(replacement, { install: true, project: true }, { path: context.pmPath })).details.previous_state_preserved).toBe(true);
      expect(await fs.readFile(settingsPath)).toEqual(before);
      expect(await inspectWorkspaceHistoryState(context.pmPath)).toMatchObject({ ok: true });
      const inventory = context.runCli(["package", "inventory", "disabled-package", "--json"], { expectJson: true });
      expect(inventory.json).toMatchObject({ extensions: [expect.objectContaining({ configured_enabled: false })] });
    });
  });

  it.each(["activate", "load", "disabled-host"])("restores a working installation after %s verification fails", async (failure) => {
    await withTempPmPath(async (context) => {
      const source = path.join(context.tempRoot, "original");
      await writeTestExtension({ root: source, name: "verified-package", entrySource: "export function activate(api) { api.registerCommand({ name: 'verified ping', run: () => ({ marker: 'original' }) }); }\n" });
      expect((await runExtension(source, { install: true, project: true }, { path: context.pmPath })).ok).toBe(true);
      const destination = path.join(context.pmPath, "extensions", "verified-package");
      const files = [path.join(destination, "manifest.json"), path.join(destination, "index.js"), path.join(context.pmPath, "extensions", ".managed-extensions.json"), path.join(context.pmPath, "settings.json")];
      const before = await Promise.all(files.map((file) => fs.readFile(file)));
      const replacement = path.join(context.tempRoot, "replacement");
      await writeTestExtension({ root: replacement, name: "verified-package", manifestOverrides: { version: "2.0.0" }, entrySource: failure === "load" ? "throw new Error('replacement load rejected');\n" : "export function activate() { throw new Error('replacement activation rejected'); }\n" });
      const result = await runExtension(replacement, { install: true, project: true }, { path: context.pmPath, noExtensions: failure === "disabled-host" });
      expect(result).toMatchObject({ ok: false, details: { previous_state_preserved: true, overwritten: false, settings_changed: false, rollback: { status: "restored" } } });
      expect(await Promise.all(files.map((file) => fs.readFile(file)))).toEqual(before);
      const invoked = context.runCli(["verified", "ping", "--json"], { expectJson: true });
      expect(invoked.code, invoked.stderr).toBe(0);
      expect(invoked.json, invoked.stdout).toMatchObject({ marker: "original" });
      expect((await fs.readdir(path.dirname(destination))).some((entry) => entry.startsWith(".pm-extension-install-backup-"))).toBe(false);
    });
  });

  it.each(["verification", "persistence", "persistence-typed", "persistence-untyped-pm"])("retains a recovery source and a concrete command when restoring a %s failure fails", async (phase) => {
    await withTempPmPath(async (context) => {
      const gitEnv = { ...process.env };
      for (const key of Object.keys(gitEnv)) if (key.startsWith("GIT_")) delete gitEnv[key];
      execFileSync("git", ["init", "--quiet"], { cwd: context.tempRoot, env: gitEnv });
      const source = path.join(context.tempRoot, "original");
      await writeTestExtension({ root: source, name: "recover-package" });
      await runExtension(source, { install: true, project: true }, { path: context.pmPath });
      const replacement = path.join(context.tempRoot, "replacement");
      await writeTestExtension({ root: replacement, name: "recover-package", manifestOverrides: { version: "2.0.0" }, entrySource: "export function activate() { throw new Error('rejected'); }\n" });
      const copy = fs.cp;
      const write = fs.writeFile;
      let rejectedWrite = false;
      const original = phase === "persistence-typed"
        ? new PmCliError("managed state rejected", EXIT_CODE.USAGE, { code: "original_install_refusal" })
        : phase === "persistence-untyped-pm"
          ? new PmCliError("managed state rejected", EXIT_CODE.USAGE)
          : new Error("managed state rejected");
      const writeSpy = vi.spyOn(fs, "writeFile").mockImplementation(async (file, data, options) => {
        if (phase.startsWith("persistence") && !rejectedWrite && String(file) === path.join(context.pmPath, "extensions", ".managed-extensions.json")) {
          rejectedWrite = true;
          throw original;
        }
        return write(file, data, options);
      });
      const spy = vi.spyOn(fs, "cp").mockImplementation(async (from, to, options) => {
        if (String(from).includes(".pm-extension-install-backup-")) throw new Error("restore copy refused");
        return copy(from, to, options);
      });
      let result: Awaited<ReturnType<typeof runExtension>> | PmCliError;
      try {
        result = await runExtension(replacement, { install: true, project: true }, { path: context.pmPath }).catch((error: unknown) => {
          expect(error).toBeInstanceOf(PmCliError);
          return error as PmCliError;
        });
      } finally {
        spy.mockRestore();
        writeSpy.mockRestore();
      }
      let rollback: { backup_directory: string; recovery_args: string[] };
      if (result! instanceof PmCliError) {
        expect(result).toMatchObject({ code: "extension_install_rollback_failed", context: { required: expect.stringContaining("not preserved"), recovery: { suggested_retry: expect.stringContaining("pm package install") } } });
        expect(result.exitCode).toBe(EXIT_CODE.GENERIC_FAILURE);
        expect(result.cause).toBe(original);
        expect(result.context.original_code).toBe(phase === "persistence-typed" ? "original_install_refusal" : undefined);
        const args = result.context.recovery!.suggested_retry_args!;
        rollback = { backup_directory: args[2], recovery_args: args };
      } else {
        expect(result!).toMatchObject({ ok: false, details: { previous_state_preserved: false, rollback: { status: "failed", recovery_command: expect.stringContaining("pm package install") } } });
        rollback = result!.details.rollback as typeof rollback;
      }
      expect(JSON.parse(await fs.readFile(path.join(rollback.backup_directory, "manifest.json"), "utf8"))).toMatchObject({ version: "1.0.0" });
      expect(spawnSync("git", ["check-ignore", "--no-index", "--", path.relative(context.tempRoot, rollback.backup_directory)], { cwd: context.tempRoot, env: gitEnv }).status).toBe(0);
      expect(context.runCli([...rollback.recovery_args, "--json"], { expectJson: true }).code).toBe(0);
    });
  });
});
