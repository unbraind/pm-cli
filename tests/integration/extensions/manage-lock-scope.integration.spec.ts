import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runExtension } from "../../../src/sdk/extension.js";
import { withExtensionInstallLock } from "../../../src/sdk/extension/install-runtime.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

// pm-9x9drr: manage --fix-managed-state holds the extension state lock only
// for adoption, so a stalled remote lookup never makes a concurrent locked
// package action wait for it.
afterEach(() => vi.unstubAllEnvs());

async function waitForFile(file: string, limitMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < limitMs) {
    if ((await readFile(file, "utf8").catch(() => "")).trim().length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${file}`);
}

describe("manage --fix-managed-state lock scope", () => {
  it("releases the extension state lock before its remote update lookups run", async () => {
    await withTempPmPath(async (context) => {
      const fixture = path.join(context.tempRoot, "lock-scope-extension");
      await mkdir(fixture);
      await writeFile(path.join(fixture, "manifest.json"), JSON.stringify({ name: "lock-scope-extension", version: "1.0.0", entry: "index.mjs", capabilities: ["commands"] }));
      await writeFile(path.join(fixture, "index.mjs"), "export function activate(api) { api.registerCommand({ name: 'lock-scope-probe', description: 'Lock scope fixture', run: () => ({ ok: true }) }); }\n");
      await runExtension(fixture, { install: true, project: true }, { path: context.pmPath });
      const managedPath = path.join(context.pmPath, "extensions", ".managed-extensions.json");
      const state = JSON.parse(await readFile(managedPath, "utf8"));
      state.entries[0].source = { kind: "npm", input: "npm:lock-scope-package", location: "lock-scope-package", package: "lock-scope-package", version: "1.0.0" };
      await writeFile(managedPath, JSON.stringify(state));

      // A stalled npm on PATH records that the lookup started and then hangs.
      const stalledBin = path.join(context.tempRoot, "stalled-npm-bin");
      const marker = path.join(context.tempRoot, "lookup-started");
      await mkdir(stalledBin);
      await writeFile(path.join(stalledBin, "npm"), `#!/bin/sh\necho started > "${marker}"\nsleep 30\n`, { mode: 0o755 });
      await writeFile(path.join(stalledBin, "npm.cmd"), `@echo started> "${marker}"\r\n@ping -n 31 127.0.0.1 >nul\r\n`);
      vi.stubEnv("PATH", `${stalledBin}${path.delimiter}${process.env.PATH ?? ""}`);
      vi.stubEnv("PM_EXTENSION_UPDATE_CHECK_TIMEOUT_MS", "5000");

      const manage = runExtension(undefined, { manage: true, project: true, fixManagedState: true }, { path: context.pmPath });
      await waitForFile(marker, 20_000);
      // One attempt: this refuses at once if the lookup still held the lock.
      await expect(withExtensionInstallLock(context.pmPath, "lock-scope-probe", async () => "acquired", { attempts: 1 })).resolves.toBe("acquired");
      expect((await manage).details).toMatchObject({ extensions: [{ update_check_status: "failed", update_error: "npm_registry_lookup_timed_out", update_check_timeout_ms: 5000 }] });
    });
  }, 60_000);
});
