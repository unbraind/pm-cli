import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  renderContextMarkdown,
  runContext,
} from "../../../../src/sdk/query/context.js";
import { renderPmCommand } from "../../../../src/sdk/command-line.js";
import { writeTestExtension } from "../../../helpers/extensions.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";

describe("context extension health", () => {
  it("reports static package health without importing modules and supports opt-out", async () => {
    await withTempPmPath(async (context) => {
      const empty = await runContext(
        { depth: "brief" },
        { path: context.pmPath },
      );
      expect(empty).not.toHaveProperty("extension_health");

      await writeTestExtension({
        root: path.join(context.pmPath, "extensions"),
        directory: "healthy-context-package",
        manifest: {
          name: "healthy-context-package",
          version: "1.0.0",
          entry: "index.mjs",
          capabilities: ["commands"],
          contributions: {
            schema_version: 1,
            commands: ["healthy ping"],
            command_handlers: ["healthy ping"],
          },
        },
        entryFilename: "index.mjs",
        entrySource: "throw new Error('context health must not import extension modules');\n",
      });
      await writeTestExtension({
        root: path.join(context.pmPath, "extensions"),
        directory: "degraded-context-package",
        manifest: {
          name: "degraded-context-package",
          version: "1.0.0",
          entry: "missing.mjs",
          capabilities: ["commands"],
        },
        entryFilename: "unused.mjs",
        entrySource: "export default {};\n",
      });

      const result = await runContext(
        { depth: "brief" },
        { path: context.pmPath },
      );
      expect(result.extension_health).toEqual({
        total: 2,
        ok: 1,
        degraded: 1,
        updates_available: 0,
        packages: [
          { name: "degraded-context-package", scope: "project", version: "1.0.0", status: "degraded", update: null, shadowed_by: null },
          { name: "healthy-context-package", scope: "project", version: "1.0.0", status: "ok", update: null, shadowed_by: null },
        ],
      });
      expect(renderContextMarkdown(result)).toContain(
        "- extensions: 1 ok, 1 degraded (degraded-context-package)",
      );
      expect(
        renderContextMarkdown({
          ...result,
          extension_health: {
            total: 1,
            ok: 1,
            degraded: 0,
            packages: [{ name: "healthy-context-package", status: "ok" }],
          },
        }),
      ).toContain("- extensions: 1 ok, 0 degraded\n");

      const suppressed = await runContext(
        { depth: "brief", noExtensionHealth: true },
        { path: context.pmPath },
      );
      expect(suppressed).not.toHaveProperty("extension_health");

      await Promise.all(
        Array.from({ length: 21 }, (_, index) =>
          fs.mkdir(
            path.join(
              context.pmPath,
              "extensions",
              `missing-manifest-${String(index).padStart(2, "0")}`,
            ),
            { recursive: true },
          ),
        ),
      );
      const bounded = await runContext(
        { depth: "brief" },
        { path: context.pmPath },
      );
      expect(bounded.extension_health).toMatchObject({
        total: 23,
        ok: 1,
        degraded: 22,
        truncated: true,
      });
      expect(bounded.extension_health?.packages).toHaveLength(20);
      expect(bounded.extension_health?.packages[0]).toMatchObject({
        name: "degraded-context-package",
        status: "degraded",
      });
    });
  });
  it("marks a shadowed copy, reports observed updates for the installed version, and names the upgrade (pm-gh1778)", async () => {
    await withTempPmPath(async (context) => {
      const globalRoot = process.env.PM_GLOBAL_PATH!;
      const manifest = (version: string) => ({ name: "pm-github", version, entry: "index.mjs", capabilities: ["commands"] });
      for (const [root, version] of [[context.pmPath, "2026.10.4"], [globalRoot, "2026.10.14"]] as const) {
        await writeTestExtension({ root: path.join(root, "extensions"), directory: "pm-github", manifest: manifest(version), entryFilename: "index.mjs", entrySource: "throw new Error('no import');\n" });
      }
      for (const name of ["pm-csv", "pm-todos"]) {
        await writeTestExtension({ root: path.join(globalRoot, "extensions"), directory: name, manifest: { ...manifest("1.0.0"), name }, entryFilename: "index.mjs", entrySource: "throw new Error('no import');\n" });
      }
      const INSTALLED_AT = "2026-10-04T00:00:00.000Z";
      const hint = (scope: "project" | "global", name: string) => renderPmCommand([
        ...(scope === "project" ? ["--pm-path", path.resolve(context.pmPath)] : []), "package", "upgrade", `--${scope}`, "--packages-only", "--", name,
      ]);
      const observation = (name: string, installed: string, remote: string) => ({ name, installed_version: installed, installed_updated_at: INSTALLED_AT, remote_version: remote, update_available: true, checked_at: "2026-11-24T10:00:00.000Z" });
      const write = async (root: string, observations: unknown[]) => {
        await fs.mkdir(path.join(root, "runtime"), { recursive: true });
        await fs.writeFile(path.join(root, "runtime", "extension-update-observations.json"), JSON.stringify({ version: 1, observations }));
      };
      // Observations apply only to a managed installation; record each package's install in its scope.
      const managedRecord = (name: string, scope: string, version: string) => ({
        name, directory: name, scope, manifest_version: version, manifest_entry: "index.mjs", capabilities: ["commands"],
        installed_at: INSTALLED_AT, updated_at: INSTALLED_AT, source: { kind: "npm", input: `npm:${name}`, location: "package", package: name, version },
      });
      await fs.writeFile(path.join(context.pmPath, "extensions", ".managed-extensions.json"), JSON.stringify({ version: 1, updated_at: INSTALLED_AT, entries: [managedRecord("pm-github", "project", "2026.10.4")] }));
      await fs.writeFile(path.join(globalRoot, "extensions", ".managed-extensions.json"), JSON.stringify({ version: 1, updated_at: INSTALLED_AT, entries: [managedRecord("pm-github", "global", "2026.10.14"), managedRecord("pm-csv", "global", "1.0.0"), managedRecord("pm-todos", "global", "1.0.0")] }));
      // The project observation matches the installed version; the global one for pm-github is for the shadowed copy.
      await write(context.pmPath, [observation("pm-github", "2026.10.4", "2026.11.23")]);
      await write(globalRoot, [observation("pm-github", "2026.10.14", "2026.11.23"), observation("pm-csv", "1.0.0", "1.1.0"), observation("pm-todos", "0.9.0", "1.1.0")]);

      const result = await runContext({ depth: "brief" }, { path: context.pmPath });
      expect(result.extension_health).toEqual({
        total: 4,
        ok: 4,
        degraded: 0,
        updates_available: 2,
        // One targeted command per package, rendered from argv; a project command names the absolute tracker.
        next: [hint("global", "pm-csv"), hint("project", "pm-github")],
        packages: [
          { name: "pm-csv", scope: "global", version: "1.0.0", status: "ok", update: "1.1.0", shadowed_by: null },
          { name: "pm-github", scope: "global", version: "2026.10.14", status: "ok", update: "2026.11.23", shadowed_by: "project" },
          { name: "pm-github", scope: "project", version: "2026.10.4", status: "ok", update: "2026.11.23", shadowed_by: null },
          // An observation for another installed version (an update since the check) does not apply.
          { name: "pm-todos", scope: "global", version: "1.0.0", status: "ok", update: null, shadowed_by: null },
        ],
      });
      expect(renderContextMarkdown(result)).toContain(
        `- extensions: 4 ok, 0 degraded, 2 with a known update (${hint("global", "pm-csv")}; ${hint("project", "pm-github")})`,
      );

      // Only one scope with a known update: one hint.
      await write(globalRoot, []);
      expect((await runContext({ depth: "brief" }, { path: context.pmPath })).extension_health).toMatchObject({
        updates_available: 1,
        next: [hint("project", "pm-github")],
      });
      await write(globalRoot, [observation("pm-csv", "1.0.0", "1.1.0"), observation("pm-todos", "1.0.0", "1.1.0")]);
      // Two updates in one scope are still two targeted commands, never a scope-wide upgrade of every package.
      expect((await runContext({ depth: "brief" }, { path: context.pmPath })).extension_health?.next).toEqual([
        hint("global", "pm-csv"),
        hint("project", "pm-github"),
        hint("global", "pm-todos"),
      ]);
      // Corrupt managed metadata in one scope means unknown updates there, never a failed context read.
      await fs.writeFile(path.join(globalRoot, "extensions", ".managed-extensions.json"), "{");
      expect((await runContext({ depth: "brief" }, { path: context.pmPath })).extension_health).toMatchObject({
        updates_available: 1,
        next: [hint("project", "pm-github")],
      });
    });
  });
  it("gives a disabled copy no upgrade hint and keeps a dash-leading name from becoming an option (Codex review round 1)", async () => {
    await withTempPmPath(async (context) => {
      const INSTALLED_AT = "2026-10-04T00:00:00.000Z";
      const names = ["pm-disabled", "-x"];
      for (const name of names) {
        await writeTestExtension({ root: path.join(context.pmPath, "extensions"), directory: name, manifest: { name, version: "1.0.0", entry: "index.mjs", capabilities: ["commands"] }, entryFilename: "index.mjs", entrySource: "throw new Error('no import');\n" });
      }
      await fs.writeFile(path.join(context.pmPath, "extensions", ".managed-extensions.json"), JSON.stringify({
        version: 1, updated_at: INSTALLED_AT,
        entries: names.map((name) => ({ name, directory: name, scope: "project", manifest_version: "1.0.0", manifest_entry: "index.mjs", capabilities: ["commands"], installed_at: INSTALLED_AT, updated_at: INSTALLED_AT, source: { kind: "npm", input: `npm:${name}`, location: "package", package: name, version: "1.0.0" } })),
      }));
      await fs.mkdir(path.join(context.pmPath, "runtime"), { recursive: true });
      await fs.writeFile(path.join(context.pmPath, "runtime", "extension-update-observations.json"), JSON.stringify({
        version: 1,
        observations: names.map((name) => ({ name, installed_version: "1.0.0", installed_updated_at: INSTALLED_AT, remote_version: "1.1.0", update_available: true, checked_at: "2026-11-24T10:00:00.000Z" })),
      }));
      const settingsPath = path.join(context.pmPath, "settings.json");
      const settings = JSON.parse(await fs.readFile(settingsPath, "utf8"));
      await fs.writeFile(settingsPath, JSON.stringify({ ...settings, extensions: { ...settings.extensions, disabled: ["pm-disabled"] } }));
      const health = (await runContext({ depth: "brief" }, {})).extension_health;
      expect(health?.packages.find((row) => row.name === "pm-disabled")).toMatchObject({ update: "1.1.0", shadowed_by: null });
      // The name sits after -- and --packages-only keeps a lost target from upgrading the CLI.
      expect(health).toMatchObject({ updates_available: 1, next: [renderPmCommand(["--pm-path", path.resolve(process.env.PM_PATH!), "package", "upgrade", "--project", "--packages-only", "--", "-x"])] });
    });
  });
});
