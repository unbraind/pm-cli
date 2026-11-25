import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  renderContextMarkdown,
  runContext,
} from "../../../../src/sdk/query/context.js";
import { renderPmCommand } from "../../../../src/sdk/command-line.js";
import { buildExtensionUpgradeHints, renderTrimSafeTrackerPath } from "../../../../src/sdk/extension/upgrade-hints.js";
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
      // The hint is the live, scoped manage check; it names no package, so no manifest name can steer it.
      const manage = (scope: "project" | "global") => renderPmCommand([
        ...(scope === "project" ? ["--pm-path", path.resolve(context.pmPath)] : []), "package", "manage", `--${scope}`,
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
        // One live check per scope with a known update; a project command names the absolute tracker.
        next: [manage("project"), manage("global")],
        packages: [
          { name: "pm-csv", scope: "global", version: "1.0.0", status: "ok", update: "1.1.0", shadowed_by: null },
          { name: "pm-github", scope: "global", version: "2026.10.14", status: "ok", update: "2026.11.23", shadowed_by: "project" },
          { name: "pm-github", scope: "project", version: "2026.10.4", status: "ok", update: "2026.11.23", shadowed_by: null },
          // An observation for another installed version (an update since the check) does not apply.
          { name: "pm-todos", scope: "global", version: "1.0.0", status: "ok", update: null, shadowed_by: null },
        ],
      });
      expect(renderContextMarkdown(result)).toContain(
        [
          "- extensions: 4 ok, 0 degraded, 2 with a known update (check with the commands below)",
          // Copies that carry more than "ok" get their own line, so same-named copies are told apart (CodeRabbit review round 8).
          "  - pm-csv (global, 1.0.0): ok, update 1.1.0",
          "  - pm-github (global, 2026.10.14): ok, update 2026.11.23, shadowed by project",
          "  - pm-github (project, 2026.10.4): ok, update 2026.11.23",
          `\`\`\`sh\n${manage("project")}\n\`\`\``,
          `\`\`\`sh\n${manage("global")}\n\`\`\``,
        ].join("\n"),
      );

      // Only one scope with a known update: one hint.
      await write(globalRoot, []);
      expect((await runContext({ depth: "brief" }, { path: context.pmPath })).extension_health).toMatchObject({
        updates_available: 1,
        next: [manage("project")],
      });
      await write(globalRoot, [observation("pm-csv", "1.0.0", "1.1.0"), observation("pm-todos", "1.0.0", "1.1.0")]);
      // Two updates in one scope still mean one check of that scope.
      expect((await runContext({ depth: "brief" }, { path: context.pmPath })).extension_health).toMatchObject({
        updates_available: 3,
        next: [manage("project"), manage("global")],
      });
      // Corrupt managed metadata in one scope means unknown updates there, never a failed context read.
      await fs.writeFile(path.join(globalRoot, "extensions", ".managed-extensions.json"), "{");
      expect((await runContext({ depth: "brief" }, { path: context.pmPath })).extension_health).toMatchObject({
        updates_available: 1,
        next: [manage("project")],
      });
    });
  });
  it("gives a disabled copy no upgrade hint, and no package name ever reaches a hint (Codex review rounds 1-3)", async () => {
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
      expect(health).toMatchObject({ updates_available: 1, next: [renderPmCommand(["--pm-path", path.resolve(process.env.PM_PATH!), "package", "manage", "--project"])] });
      // No hint carries the package name as a token (a random temp path may contain "-x" as a substring).
      expect(health?.next?.some((hint) => hint.split(" ").includes("-x"))).toBe(false);
      // Markdown puts every hint in its own fenced block, so shell quoting, line breaks and backticks stay verbatim,
      // and escapes manifest-controlled degraded names, so none can open a code span around a command (Codex review round 7).
      const rendered = renderContextMarkdown({
        ...(await runContext({ depth: "brief" }, {})),
        extension_health: {
          ...health!,
          degraded: 1,
          packages: [...health!.packages, { name: "evil`name*", scope: "project", version: "1.0.0", status: "degraded", update: null, shadowed_by: null }, { name: "bare", status: "degraded" }, { name: "multi\nline", scope: "global", version: "1.0.0", status: "ok", update: "abc\n```sh\nrm -rf /", shadowed_by: null }],
          next: ["pm --pm-path \"/a\\$b\" package manage --project", "pm --pm-path \"/a\nb\" package manage --project", "pm --pm-path \"/x\n```\" package manage --project"],
        },
      });
      expect(rendered).toContain("degraded (evil\\`name\\*, bare), 1 with a known update (check with the commands below)");
      expect(rendered).toContain("  - evil\\`name\\* (project, 1.0.0): degraded");
      expect(rendered).toContain("  - bare (unknown scope, unknown version): degraded");
      // Untrusted labels render as one line, so an edited cache cannot inject Markdown blocks (Codex review round 14).
      expect(rendered).toContain("  - multi line (global, 1.0.0): ok, update abc \\`\\`\\`sh rm -rf /");
      expect(rendered).toContain("```sh\npm --pm-path \"/a\\$b\" package manage --project\n```");
      expect(rendered).toContain("```sh\npm --pm-path \"/a\nb\" package manage --project\n```");
      // A fence is always longer than any backtick run inside the command.
      expect(rendered).toContain("````sh\npm --pm-path \"/x\n```\" package manage --project\n````");
    });
  });
  it("keeps a tracker path ending in whitespace intact through the trimmed --pm-path option (Codex review round 6)", () => {
    const spaced = path.resolve("tracker ");
    expect(renderTrimSafeTrackerPath(spaced)).toBe(`${spaced}${path.sep}.`);
    expect(renderTrimSafeTrackerPath("/plain/tracker")).toBe(path.resolve("/plain/tracker"));
    expect(buildExtensionUpgradeHints([{ scope: "project" }, { scope: "project" }], spaced)).toEqual([
      renderPmCommand(["--pm-path", `${spaced}${path.sep}.`, "package", "manage", "--project"]),
    ]);
    expect(buildExtensionUpgradeHints([{ scope: "global" }], spaced)).toEqual(["pm package manage --global"]);
    // A caller's explicit --no-extensions carries over: the live check runs before manage's activation probe (Codex review round 14).
    expect(buildExtensionUpgradeHints([{ scope: "global" }], spaced, true)).toEqual(["pm --no-extensions package manage --global"]);
    expect(buildExtensionUpgradeHints([], spaced)).toEqual([]);
  });
  it("marks a same-scope copy that loses to a same-named one as shadowed (Codex review round 8)", async () => {
    await withTempPmPath(async (context) => {
      for (const directory of ["a-first", "b-second"]) {
        await writeTestExtension({ root: path.join(context.pmPath, "extensions"), directory, manifest: { name: "pm-same", version: "1.0.0", entry: "index.mjs", capabilities: ["commands"] }, entryFilename: "index.mjs", entrySource: "throw new Error('no import');\n" });
      }
      const rows = (await runContext({ depth: "brief" }, { path: context.pmPath })).extension_health?.packages ?? [];
      expect(rows.map((row) => row.shadowed_by).sort()).toEqual([null, "project"]);
    });
  });
});
