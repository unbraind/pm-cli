import { mkdir, readFile, readdir, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { inspectStaticExtensionInventory } from "../../../src/sdk/index.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

describe("read-only configured extension inventory", () => {
  it("reports saved enablement and absent names without importing extension code or changing tracker files", async () => {
    await withTempPmPath(async ({ pmPath, tempRoot, runCli }) => {
      const extensionRoot = path.join(pmPath, "extensions", "probe");
      const marker = path.join(tempRoot, "activated");
      await mkdir(extensionRoot, { recursive: true });
      await writeFile(path.join(extensionRoot, "manifest.json"), JSON.stringify({ name: "probe", version: "1.0.0", entry: "./index.mjs", manifest_version: 1, capabilities: ["commands"] }));
      await writeFile(path.join(extensionRoot, "index.mjs"), `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "activated"); export function activate() {}`);
      const settingsPath = path.join(pmPath, "settings.json");
      const settingsBefore = await readFile(settingsPath);
      const modifiedBefore = (await stat(settingsPath)).mtimeMs;
      const filesBefore = (await readdir(pmPath, { recursive: true })).sort();

      const cli = runCli(["package", "inventory", "--project", "--json"], { cwd: tempRoot, expectJson: true });
      expect(cli.code).toBe(0);
      expect(cli.json).toMatchObject({ complete: true, extensions: [{ name: "probe", status: "installed", configured_enabled: true, managed: false, runtime_active: null }] });
      expect(runCli(["extension", "inventory", "probe", "--json"], { cwd: tempRoot, expectJson: true }).json)
        .toMatchObject({ complete: true, extensions: [{ name: "probe" }] });
      expect(runCli(["package", "inventory", "--global", "--project"], { cwd: tempRoot }).code).not.toBe(0);
      expect(await inspectStaticExtensionInventory({ pmRoot: pmPath, name: "missing" })).toMatchObject({ complete: true, extensions: [{ name: "missing", status: "absent", installed: false }] });
      expect((await readdir(pmPath, { recursive: true })).sort()).toEqual(filesBefore);
      expect(await readFile(settingsPath)).toEqual(settingsBefore);
      expect((await stat(settingsPath)).mtimeMs).toBe(modifiedBefore);
      expect(await readdir(tempRoot)).not.toContain("activated");

      const settings = JSON.parse(settingsBefore.toString()) as { extensions: { disabled: string[] } };
      settings.extensions.disabled = ["probe"];
      await writeFile(settingsPath, JSON.stringify(settings));
      const inactive = await inspectStaticExtensionInventory({ pmRoot: pmPath, name: "probe" });
      expect(inactive.extensions).toMatchObject([{ status: "inactive", configured_enabled: false }]);
    });
  });

  it("keeps global and project installations distinct", async () => {
    await withTempPmPath(async ({ pmPath, tempRoot }) => {
      const globalRoot = path.join(tempRoot, ".pm-cli-global", "extensions", "global-probe");
      await mkdir(globalRoot, { recursive: true });
      await writeFile(path.join(globalRoot, "manifest.json"), JSON.stringify({ name: "global-probe", version: "2.0.0", entry: "./index.mjs", manifest_version: 1, capabilities: [] }));
      expect(await inspectStaticExtensionInventory({ pmRoot: pmPath, scope: "global", cwd: tempRoot })).toMatchObject({ scope: "global", complete: true, settings_status: "absent", extensions: [{ name: "global-probe", scope: "global", status: "installed" }] });
      expect(await inspectStaticExtensionInventory({ pmRoot: pmPath, scope: "project", name: "global-probe" })).toMatchObject({ scope: "project", extensions: [{ status: "absent" }] });
      expect((await inspectStaticExtensionInventory({ pmRoot: pmPath, scope: "global" })).extensions).toMatchObject([{ name: "global-probe" }]);
    });
  });

  it("surfaces malformed settings, managed records, and manifests as incomplete", async () => {
    await withTempPmPath(async ({ pmPath, tempRoot, runCli }) => {
      const extensionsRoot = path.join(pmPath, "extensions");
      const probeRoot = path.join(extensionsRoot, "broken");
      await mkdir(probeRoot, { recursive: true });
      await writeFile(path.join(probeRoot, "manifest.json"), "{");
      await writeFile(path.join(pmPath, "settings.json"), "{");
      await writeFile(path.join(extensionsRoot, ".managed-extensions.json"), JSON.stringify({ version: 1, entries: [{ name: "incomplete" }] }));
      const sdk = await inspectStaticExtensionInventory({ pmRoot: pmPath });
      expect(sdk).toMatchObject({ complete: false, settings_status: "invalid", managed_state_status: "invalid", extensions: [{ status: "malformed_manifest", configured_enabled: null, managed: null }] });
      expect(sdk.errors.map((error) => error.code)).toEqual(["settings_invalid", "managed_state_invalid", "manifest_invalid"]);
      const cli = runCli(["package", "inventory", "--json"], { cwd: tempRoot, expectJson: true });
      expect(cli.code).not.toBe(0);
      expect(cli.json).toMatchObject({ complete: false });
      expect((cli.json as { errors: Array<{ code: string }> }).errors.map((error) => error.code)).toEqual(["settings_invalid", "managed_state_invalid", "manifest_invalid"]);
    });
  });

  it("reports filesystem read failures instead of treating them as empty inventory", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const settingsPath = path.join(pmPath, "settings.json");
      const extensionsRoot = path.join(pmPath, "extensions");
      await mkdir(extensionsRoot, { recursive: true });
      await writeFile(path.join(extensionsRoot, ".managed-extensions.json"), "{}");
      await mkdir(path.join(extensionsRoot, "unreadable"));
      await mkdir(path.join(extensionsRoot, "unreadable", "manifest.json"));
      const inventory = await inspectStaticExtensionInventory({ pmRoot: pmPath });
      expect(inventory.errors.map((error) => error.code)).toEqual(["managed_state_invalid", "manifest_unreadable"]);
      expect(inventory.extensions).toMatchObject([{ status: "malformed_manifest" }]);
      expect((await stat(settingsPath)).isFile()).toBe(true);
    });
  });

  it("preserves explicit errors for unreadable roots and sources", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const extensionsRoot = path.join(pmPath, "extensions");
      await rmdir(extensionsRoot);
      await writeFile(extensionsRoot, "not a directory");
      const result = await inspectStaticExtensionInventory({ pmRoot: pmPath, name: "missing" });
      expect(result.complete).toBe(false);
      expect(result.errors.map((error) => error.code)).toEqual(["managed_state_unreadable", "extensions_unreadable"]);
      expect(result.extensions).toEqual([]);
    });
  });

  it("rejects malformed enablement shapes and reports unreadable settings", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const settingsPath = path.join(pmPath, "settings.json");
      for (const settings of ["null", "[]", '{"extensions":null}', '{"extensions":[]}', '{"extensions":{"enabled":1}}', '{"extensions":{"enabled":[1]}}', '{"extensions":{"disabled":1}}', '{"extensions":{"disabled":[1]}}']) {
        await writeFile(settingsPath, settings);
        expect(await inspectStaticExtensionInventory({ pmRoot: pmPath })).toMatchObject({ complete: false, settings_status: "invalid", errors: [{ code: "settings_invalid" }] });
      }
      await writeFile(settingsPath, "{}");
      expect(await inspectStaticExtensionInventory({ pmRoot: pmPath })).toMatchObject({ complete: true, settings_status: "ok" });
      await writeFile(settingsPath, '{"extensions":{}}');
      expect(await inspectStaticExtensionInventory({ pmRoot: pmPath })).toMatchObject({ complete: true, settings_status: "ok" });
      await unlink(settingsPath);
      await mkdir(settingsPath);
      expect(await inspectStaticExtensionInventory({ pmRoot: pmPath })).toMatchObject({ complete: false, settings_status: "unreadable", errors: [{ code: "settings_unreadable" }] });
    });
  });

  it("distinguishes valid managed installs, enablement allowlists, and bad manifests", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const root = path.join(pmPath, "extensions");
      const installed = path.join(root, "managed-dir");
      await mkdir(installed);
      await writeFile(path.join(installed, "manifest.json"), JSON.stringify({ name: "managed-name", version: "1.0.0", entry: "./index.mjs", manifest_version: 1, capabilities: [] }));
      await writeFile(path.join(pmPath, "settings.json"), JSON.stringify({ extensions: { enabled: ["elsewhere"], disabled: [] } }));
      const managedPath = path.join(root, ".managed-extensions.json");
      await writeFile(managedPath, JSON.stringify({ version: 1, entries: [{ name: "managed-name", directory: "managed-dir", scope: "project", manifest_version: "1", manifest_entry: "./index.mjs", capabilities: [], installed_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", source: { kind: "local", input: "fixture", location: "fixture" } }] }));
      expect(await inspectStaticExtensionInventory({ pmRoot: pmPath, name: "managed-dir" })).toMatchObject({ complete: true, managed_state_status: "ok", extensions: [{ name: "managed-name", managed: true, status: "inactive" }] });
      await writeFile(path.join(pmPath, "settings.json"), JSON.stringify({ extensions: { enabled: ["managed-name"], disabled: [] } }));
      expect((await inspectStaticExtensionInventory({ pmRoot: pmPath })).extensions).toMatchObject([{ configured_enabled: true, status: "installed" }]);
      await writeFile(managedPath, JSON.stringify({ version: 1, entries: [{ name: "different", directory: "managed-dir", scope: "project", manifest_version: "1", manifest_entry: "./index.mjs", capabilities: [], installed_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", source: { kind: "local", input: "fixture", location: "fixture" } }] }));
      expect((await inspectStaticExtensionInventory({ pmRoot: pmPath })).extensions).toMatchObject([{ managed: true }]);
      await writeFile(path.join(installed, "manifest.json"), "{}");
      expect(await inspectStaticExtensionInventory({ pmRoot: pmPath })).toMatchObject({ complete: false, extensions: [{ status: "malformed_manifest" }], errors: [{ code: "manifest_invalid" }] });
      await writeFile(managedPath, "{");
      expect((await inspectStaticExtensionInventory({ pmRoot: pmPath })).managed_state_status).toBe("invalid");
    });
  });

  it("treats missing optional sources as absent and missing manifests as incomplete", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const root = path.join(pmPath, "extensions");
      await mkdir(path.join(root, "without-manifest"));
      await mkdir(path.join(root, "another-missing-manifest"));
      expect(await inspectStaticExtensionInventory({ pmRoot: pmPath })).toMatchObject({ complete: false, extensions: [{ directory: "another-missing-manifest", status: "malformed_manifest" }, { directory: "without-manifest", status: "malformed_manifest" }], errors: [{ code: "manifest_invalid" }, { code: "manifest_invalid" }] });
      await rmdir(path.join(root, "another-missing-manifest"));
      await rmdir(path.join(root, "without-manifest"));
      await rmdir(root);
      expect(await inspectStaticExtensionInventory({ pmRoot: pmPath, name: "missing" })).toMatchObject({ complete: true, managed_state_status: "absent", extensions: [{ status: "absent" }] });
    });
  });
});
