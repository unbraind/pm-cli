import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  activateExtensions,
  discoverExtensions,
  loadExtensions,
  runCommandHandler,
  runCommandOverride,
  resolveExtensionRoots,
  runAfterCommandHooks,
  runBeforeCommandHooks,
  runOnIndexHooks,
  runOnReadHooks,
  runRendererOverride,
  runOnWriteHooks,
  type ExtensionManifest,
} from "../../src/core/extensions/loader.js";
import { readSettings } from "../../src/core/store/settings.js";
import { withTempPmPath, type TempPmContext } from "../helpers/withTempPmPath.js";

async function createExtension(
  root: string,
  directory: string,
  manifest: Partial<ExtensionManifest> | null,
  entrySource?: string,
): Promise<void> {
  const extensionDir = path.join(root, directory);
  await mkdir(extensionDir, { recursive: true });

  if (manifest !== null) {
    await writeFile(path.join(extensionDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }

  if (entrySource !== undefined && manifest?.entry) {
    const entryPath = path.join(extensionDir, manifest.entry);
    await mkdir(path.dirname(entryPath), { recursive: true });
    await writeFile(entryPath, entrySource, "utf8");
  }
}

async function loadSettings(context: TempPmContext) {
  return readSettings(context.pmPath);
}

describe("extension loader", () => {
  it("resolves project and global extension roots from PM paths", async () => {
    await withTempPmPath(async (context) => {
      const roots = resolveExtensionRoots(context.pmPath);
      expect(roots).toEqual({
        global: path.join(context.env.PM_GLOBAL_PATH as string, "extensions"),
        project: path.join(context.pmPath, "extensions"),
      });
    });
  });

  it("discovers deterministic effective extension order with project precedence", async () => {
    await withTempPmPath(async (context) => {
      const roots = resolveExtensionRoots(context.pmPath);
      await createExtension(
        roots.global,
        "g-alpha",
        {
          name: "alpha-ext",
          version: "1.0.0",
          entry: "./index.mjs",
        },
        "export default {name: 'alpha-ext'};\n",
      );
      await createExtension(
        roots.global,
        "g-shared",
        {
          name: "shared-ext",
          version: "1.0.0",
          entry: "./index.mjs",
          priority: 20,
        },
        "export default {layer: 'global'};\n",
      );
      await createExtension(
        roots.project,
        "p-other",
        {
          name: "other-ext",
          version: "1.0.0",
          entry: "./index.mjs",
        },
        "export default {name: 'other-ext'};\n",
      );
      await createExtension(
        roots.project,
        "p-shared",
        {
          name: "shared-ext",
          version: "2.0.0",
          entry: "./index.mjs",
          priority: 5,
        },
        "export default {layer: 'project'};\n",
      );

      const settings = await loadSettings(context);
      settings.extensions.enabled = [" shared-ext ", "alpha-ext", "shared-ext"];
      settings.extensions.disabled = ["alpha-ext"];

      const discovery = await discoverExtensions({
        pmRoot: context.pmPath,
        settings,
      });

      expect(discovery.disabled_by_flag).toBe(false);
      expect(discovery.configured_enabled).toEqual(["alpha-ext", "shared-ext"]);
      expect(discovery.configured_disabled).toEqual(["alpha-ext"]);
      expect(discovery.warnings).toEqual([]);
      expect(discovery.discovered.map((entry) => entry.name)).toEqual([
        "alpha-ext",
        "shared-ext",
        "other-ext",
        "shared-ext",
      ]);
      expect(discovery.effective).toEqual([
        expect.objectContaining({
          name: "shared-ext",
          layer: "project",
          version: "2.0.0",
          priority: 5,
        }),
      ]);
    });
  });

  it("reports deterministic manifest and entry warnings", async () => {
    await withTempPmPath(async (context) => {
      const roots = resolveExtensionRoots(context.pmPath);

      await createExtension(
        roots.project,
        "invalid-capabilities",
        {
          name: "invalid-capabilities-ext",
          version: "1.0.0",
          entry: "./index.mjs",
          capabilities: ["hooks", 1 as unknown as string],
        },
        "export default {};\n",
      );
      await createExtension(
        roots.project,
        "invalid-priority",
        {
          name: "invalid-priority-ext",
          version: "1.0.0",
          entry: "./index.mjs",
          priority: 1.5,
        },
        "export default {};\n",
      );
      await createExtension(roots.project, "missing-entry", {
        name: "missing-entry-ext",
        version: "1.0.0",
        entry: "./missing.mjs",
      });
      await createExtension(roots.project, "missing-manifest", null);
      await writeFile(path.join(roots.project, "outside-target.mjs"), "export default { escaped: true };\n", "utf8");
      await createExtension(roots.project, "outside-entry", {
        name: "outside-entry-ext",
        version: "1.0.0",
        entry: "../outside-target.mjs",
      });
      await createExtension(roots.project, "symlink-escape", {
        name: "symlink-escape-ext",
        version: "1.0.0",
        entry: "./index.mjs",
      });
      await symlink(
        path.join(roots.project, "outside-target.mjs"),
        path.join(roots.project, "symlink-escape", "index.mjs"),
        "file",
      );

      const settings = await loadSettings(context);
      const discovery = await discoverExtensions({
        pmRoot: context.pmPath,
        settings,
      });

      expect(discovery.warnings).toEqual([
        "extension_manifest_invalid:project:invalid-capabilities",
        "extension_manifest_invalid:project:invalid-priority",
        "extension_entry_missing:project:missing-entry-ext",
        "extension_manifest_missing:project:missing-manifest",
        "extension_entry_outside_extension:project:outside-entry-ext",
        "extension_entry_outside_extension:project:symlink-escape-ext",
      ]);
      expect(discovery.effective).toEqual([]);
    });
  });

  it("reports deterministic warnings for unknown manifest capabilities without blocking load", async () => {
    await withTempPmPath(async (context) => {
      const roots = resolveExtensionRoots(context.pmPath);
      await createExtension(
        roots.project,
        "unknown-capabilities",
        {
          name: "unknown-capability-ext",
          version: "1.0.0",
          entry: "./index.mjs",
          capabilities: ["hooks", "Future-Capability", "search"],
        },
        "export default { ok: true };\n",
      );

      const settings = await loadSettings(context);
      const discovery = await discoverExtensions({
        pmRoot: context.pmPath,
        settings,
      });
      expect(discovery.warnings).toEqual(["extension_capability_unknown:project:unknown-capability-ext:future-capability"]);
      expect(discovery.effective).toEqual([
        expect.objectContaining({
          name: "unknown-capability-ext",
          capabilities: ["future-capability", "hooks", "search"],
        }),
      ]);

      const loaded = await loadExtensions({
        pmRoot: context.pmPath,
        settings,
      });
      expect(loaded.warnings).toEqual(["extension_capability_unknown:project:unknown-capability-ext:future-capability"]);
      expect(loaded.loaded.map((entry) => entry.name)).toEqual(["unknown-capability-ext"]);
      expect(loaded.failed).toEqual([]);
    });
  });

  it("applies deterministic same-name tie breaks within a layer", async () => {
    await withTempPmPath(async (context) => {
      const roots = resolveExtensionRoots(context.pmPath);
      await createExtension(
        roots.project,
        "a-dup",
        {
          name: "dup-ext",
          version: "1.0.0",
          entry: "./index.mjs",
          priority: 30,
        },
        "export default { source: 'a' };\n",
      );
      await createExtension(
        roots.project,
        "z-dup",
        {
          name: "dup-ext",
          version: "2.0.0",
          entry: "./index.mjs",
          priority: 30,
        },
        "export default { source: 'z' };\n",
      );
      await createExtension(
        roots.project,
        "beta",
        {
          name: "beta-ext",
          version: "1.0.0",
          entry: "./index.mjs",
          priority: 10,
        },
        "export default { source: 'beta' };\n",
      );

      const settings = await loadSettings(context);
      const discovery = await discoverExtensions({
        pmRoot: context.pmPath,
        settings,
      });

      expect(discovery.warnings).toEqual([]);
      expect(discovery.effective).toEqual([
        expect.objectContaining({
          name: "beta-ext",
          priority: 10,
          version: "1.0.0",
        }),
        expect.objectContaining({
          name: "dup-ext",
          priority: 30,
          version: "2.0.0",
          directory: "z-dup",
        }),
      ]);
    });
  });

  it("accepts entry paths that resolve to extension directory root", async () => {
    await withTempPmPath(async (context) => {
      const roots = resolveExtensionRoots(context.pmPath);
      await createExtension(roots.project, "self-entry", {
        name: "self-entry-ext",
        version: "1.0.0",
        entry: ".",
      });

      const settings = await loadSettings(context);
      const discovery = await discoverExtensions({
        pmRoot: context.pmPath,
        settings,
      });

      expect(discovery.warnings).toEqual([]);
      expect(discovery.effective).toEqual([
        expect.objectContaining({
          name: "self-entry-ext",
          layer: "project",
          entry: ".",
          entry_path: path.join(roots.project, "self-entry"),
        }),
      ]);
    });
  });

  it("accepts in-tree symlink entry targets after canonical resolution", async () => {
    await withTempPmPath(async (context) => {
      const roots = resolveExtensionRoots(context.pmPath);
      await createExtension(roots.project, "in-tree-symlink", {
        name: "in-tree-symlink-ext",
        version: "1.0.0",
        entry: "./index.mjs",
      });
      const extensionDir = path.join(roots.project, "in-tree-symlink");
      const targetPath = path.join(extensionDir, "nested", "entry.mjs");
      await mkdir(path.dirname(targetPath), { recursive: true });
      await writeFile(targetPath, "export default { inTree: true };\n", "utf8");
      await symlink(targetPath, path.join(extensionDir, "index.mjs"), "file");

      const settings = await loadSettings(context);
      const discovery = await discoverExtensions({
        pmRoot: context.pmPath,
        settings,
      });

      expect(discovery.warnings).toEqual([]);
      expect(discovery.effective).toEqual([
        expect.objectContaining({
          name: "in-tree-symlink-ext",
          layer: "project",
          entry: "./index.mjs",
          entry_path: path.join(extensionDir, "index.mjs"),
        }),
      ]);
    });
  });

  it("loads extensions and isolates entry load failures", async () => {
    await withTempPmPath(async (context) => {
      const roots = resolveExtensionRoots(context.pmPath);
      await createExtension(
        roots.global,
        "a-boom",
        {
          name: "boom-ext",
          version: "1.0.0",
          entry: "./index.mjs",
        },
        "throw new Error('boom-load');\n",
      );
      await createExtension(
        roots.global,
        "z-good",
        {
          name: "good-ext",
          version: "1.0.0",
          entry: "./index.mjs",
        },
        "export default { ok: true };\n",
      );

      const settings = await loadSettings(context);
      const loaded = await loadExtensions({
        pmRoot: context.pmPath,
        settings,
      });

      expect(loaded.loaded.map((entry) => entry.name)).toEqual(["good-ext"]);
      expect(loaded.failed).toEqual([
        expect.objectContaining({
          layer: "global",
          name: "boom-ext",
        }),
      ]);
      expect(loaded.warnings).toContain("extension_load_failed:global:boom-ext");
    });
  });

  it("activates extension hooks with deterministic registration order", async () => {
    await withTempPmPath(async (context) => {
      const roots = resolveExtensionRoots(context.pmPath);
      await createExtension(
        roots.global,
        "g-alpha-hooks",
        {
          name: "alpha-hook-ext",
          version: "1.0.0",
          entry: "./index.mjs",
          priority: 5,
          capabilities: ["hooks"],
        },
        [
          "export default {",
          "  activate(api) {",
          "    api.hooks.beforeCommand(() => {});",
          "    api.hooks.afterCommand(() => {});",
          "    api.hooks.onWrite(() => {});",
          "  }",
          "};",
          "",
        ].join("\n"),
      );
      await createExtension(
        roots.project,
        "p-beta-hooks",
        {
          name: "beta-hook-ext",
          version: "1.0.0",
          entry: "./index.mjs",
          priority: 50,
          capabilities: ["hooks"],
        },
        [
          "export default {",
          "  activate(api) {",
          "    api.hooks.beforeCommand(() => {});",
          "    api.hooks.afterCommand(() => {});",
          "    api.hooks.onRead(() => {});",
          "    api.hooks.onIndex(() => {});",
          "  }",
          "};",
          "",
        ].join("\n"),
      );

      const settings = await loadSettings(context);
      const loaded = await loadExtensions({
        pmRoot: context.pmPath,
        settings,
      });
      const activation = await activateExtensions(loaded);

      expect(activation.failed).toEqual([]);
      expect(activation.warnings).toEqual([]);
      expect(activation.hook_counts).toEqual({
        before_command: 2,
        after_command: 2,
        on_write: 1,
        on_read: 1,
        on_index: 1,
      });
      expect(activation.hooks.beforeCommand.map((entry) => entry.name)).toEqual(["alpha-hook-ext", "beta-hook-ext"]);
      expect(activation.hooks.afterCommand.map((entry) => entry.name)).toEqual(["alpha-hook-ext", "beta-hook-ext"]);
    });
  });

  it("contains activation and runtime hook failures without stopping later hooks", async () => {
    await withTempPmPath(async (context) => {
      const roots = resolveExtensionRoots(context.pmPath);
      await createExtension(
        roots.project,
        "activation-boom",
        {
          name: "activation-boom-ext",
          version: "1.0.0",
          entry: "./index.mjs",
        },
        [
          "export default {",
          "  activate() {",
          "    throw new Error('activate-boom');",
          "  }",
          "};",
          "",
        ].join("\n"),
      );
      await createExtension(
        roots.project,
        "runtime-hooks",
        {
          name: "hook-runtime-ext",
          version: "1.0.0",
          entry: "./index.mjs",
          capabilities: ["hooks"],
        },
        [
          "export const state = { before: 0, after: 0 };",
          "export default {",
          "  activate(api) {",
          "    api.hooks.beforeCommand(() => {",
          "      throw new Error('before-boom');",
          "    });",
          "    api.hooks.beforeCommand(() => {",
          "      state.before += 1;",
          "    });",
          "    api.hooks.afterCommand(() => {",
          "      state.after += 1;",
          "    });",
          "  }",
          "};",
          "",
        ].join("\n"),
      );

      const settings = await loadSettings(context);
      const loaded = await loadExtensions({
        pmRoot: context.pmPath,
        settings,
      });
      const activation = await activateExtensions(loaded);

      expect(activation.failed).toEqual([
        expect.objectContaining({
          layer: "project",
          name: "activation-boom-ext",
          error: "activate-boom",
        }),
      ]);
      expect(activation.warnings).toContain("extension_activate_failed:project:activation-boom-ext");

      const runtimeLoaded = loaded.loaded.find((entry) => entry.name === "hook-runtime-ext");
      const runtimeModule = runtimeLoaded?.module as { state?: { before: number; after: number } } | undefined;
      expect(runtimeModule?.state).toEqual({
        before: 0,
        after: 0,
      });

      const beforeWarnings = await runBeforeCommandHooks(activation.hooks, {
        command: "list-open",
        args: ["--limit", "1"],
        pm_root: context.pmPath,
      });
      expect(beforeWarnings).toEqual(["extension_hook_failed:project:hook-runtime-ext:beforeCommand"]);
      expect(runtimeModule?.state?.before).toBe(1);

      const afterWarnings = await runAfterCommandHooks(activation.hooks, {
        command: "list-open",
        args: ["--limit", "1"],
        pm_root: context.pmPath,
        ok: true,
      });
      expect(afterWarnings).toEqual([]);
      expect(runtimeModule?.state?.after).toBe(1);
    });
  });

  it("isolates hook context snapshots across callbacks and caller state", async () => {
    const observed: Array<{ command: string; args: string[]; pm_root: string }> = [];
    const hooks = {
      beforeCommand: [
        {
          layer: "project" as const,
          name: "mutate-hook",
          run: (context: { command: string; args: string[]; pm_root: string }) => {
            context.command = "mutated";
            context.args.push("--json");
            context.pm_root = "/tmp/mutated";
          },
        },
        {
          layer: "project" as const,
          name: "observe-hook",
          run: (context: { command: string; args: string[]; pm_root: string }) => {
            observed.push({
              command: context.command,
              args: [...context.args],
              pm_root: context.pm_root,
            });
          },
        },
      ],
      afterCommand: [],
      onWrite: [],
      onRead: [],
      onIndex: [],
    };
    const callerContext = {
      command: "list-open",
      args: ["--limit", "1"],
      pm_root: "/tmp/project",
    };

    const warnings = await runBeforeCommandHooks(hooks, callerContext);
    expect(warnings).toEqual([]);
    expect(observed).toEqual([
      {
        command: "list-open",
        args: ["--limit", "1"],
        pm_root: "/tmp/project",
      },
    ]);
    expect(callerContext).toEqual({
      command: "list-open",
      args: ["--limit", "1"],
      pm_root: "/tmp/project",
    });
  });

  it("supports named activate exports and skips non-activatable modules", async () => {
    const namedState = { write: 0, read: 0, index: 0 };
    const activation = await activateExtensions({
      disabled_by_flag: false,
      roots: {
        global: "/tmp/global",
        project: "/tmp/project",
      },
      configured_enabled: [],
      configured_disabled: [],
      discovered: [],
      effective: [],
      warnings: [],
      loaded: [
        {
          layer: "project",
          directory: "non-object-module",
          manifest_path: "/tmp/project/non-object-module/manifest.json",
          name: "non-object-module",
          version: "1.0.0",
          entry: "./index.mjs",
          priority: 100,
          entry_path: "/tmp/project/non-object-module/index.mjs",
          module: 42 as unknown,
        },
        {
          layer: "project",
          directory: "no-activate",
          manifest_path: "/tmp/project/no-activate/manifest.json",
          name: "no-activate",
          version: "1.0.0",
          entry: "./index.mjs",
          priority: 100,
          entry_path: "/tmp/project/no-activate/index.mjs",
          module: {
            default: "not-an-object",
          },
        },
        {
          layer: "project",
          directory: "named-activate",
          manifest_path: "/tmp/project/named-activate/manifest.json",
          name: "named-activate",
          version: "1.0.0",
          entry: "./index.mjs",
          priority: 100,
          entry_path: "/tmp/project/named-activate/index.mjs",
          module: {
            activate(api: {
              hooks: {
                onWrite: (hook: (context: { path: string; scope: "project" | "global"; op: string }) => void) => void;
                onRead: (hook: (context: { path: string; scope: "project" | "global" }) => void) => void;
                onIndex: (hook: (context: { mode: string; total_items?: number }) => void) => void;
              };
            }) {
              api.hooks.onWrite(() => {
                namedState.write += 1;
              });
              api.hooks.onRead(() => {
                namedState.read += 1;
              });
              api.hooks.onIndex(() => {
                namedState.index += 1;
              });
            },
          },
        },
      ],
      failed: [],
    });

    expect(activation.failed).toEqual([]);
    expect(activation.warnings).toEqual([]);
    expect(activation.hook_counts).toEqual({
      before_command: 0,
      after_command: 0,
      on_write: 1,
      on_read: 1,
      on_index: 1,
    });

    const writeWarnings = await runOnWriteHooks(activation.hooks, {
      path: "src/cli/main.ts",
      scope: "project",
      op: "update",
    });
    const readWarnings = await runOnReadHooks(activation.hooks, {
      path: "README.md",
      scope: "project",
    });
    const indexWarnings = await runOnIndexHooks(activation.hooks, {
      mode: "keyword",
      total_items: 3,
    });

    expect(writeWarnings).toEqual([]);
    expect(readWarnings).toEqual([]);
    expect(indexWarnings).toEqual([]);
    expect(namedState).toEqual({
      write: 1,
      read: 1,
      index: 1,
    });
  });

  it("handles malformed manifests and non-Error module failures", async () => {
    await withTempPmPath(async (context) => {
      const roots = resolveExtensionRoots(context.pmPath);
      await createExtension(
        roots.project,
        "caps-valid",
        {
          name: "caps-ext",
          version: "1.0.0",
          entry: "./index.mjs",
          capabilities: ["hooks", "commands", "hooks"],
        },
        "export default { ok: true };\n",
      );
      await createExtension(
        roots.project,
        "blank-entry",
        {
          name: "blank-entry-ext",
          version: "1.0.0",
          entry: "   ",
        },
        "export default {};\n",
      );
      await createExtension(
        roots.project,
        "string-throw",
        {
          name: "string-throw-ext",
          version: "1.0.0",
          entry: "./index.mjs",
        },
        "throw 'string-load-failure';\n",
      );

      const invalidJsonDir = path.join(roots.project, "invalid-json");
      await mkdir(invalidJsonDir, { recursive: true });
      await writeFile(path.join(invalidJsonDir, "manifest.json"), "{not-json", "utf8");
      const nonObjectDir = path.join(roots.project, "non-object");
      await mkdir(nonObjectDir, { recursive: true });
      await writeFile(path.join(nonObjectDir, "manifest.json"), '"not-an-object"\n', "utf8");
      await createExtension(
        roots.project,
        "missing-name",
        {
          name: "  ",
          version: "1.0.0",
          entry: "./index.mjs",
        },
        "export default {};\n",
      );
      await createExtension(
        roots.project,
        "missing-version",
        {
          name: "missing-version-ext",
          version: " ",
          entry: "./index.mjs",
        },
        "export default {};\n",
      );

      const settings = await loadSettings(context);
      const discovery = await discoverExtensions({
        pmRoot: context.pmPath,
        settings,
      });
      expect(discovery.warnings).toEqual([
        "extension_manifest_invalid:project:blank-entry",
        "extension_manifest_invalid:project:invalid-json",
        "extension_manifest_invalid:project:missing-name",
        "extension_manifest_invalid:project:missing-version",
        "extension_manifest_invalid:project:non-object",
      ]);
      expect(discovery.effective.map((entry) => entry.name)).toEqual(["caps-ext", "string-throw-ext"]);

      const loaded = await loadExtensions({
        pmRoot: context.pmPath,
        settings,
      });
      expect(loaded.loaded.map((entry) => entry.name)).toEqual(["caps-ext"]);
      expect(loaded.failed).toEqual([
        expect.objectContaining({
          layer: "project",
          name: "string-throw-ext",
          error: "string-load-failure",
        }),
      ]);
      expect(loaded.warnings).toEqual([
        "extension_manifest_invalid:project:blank-entry",
        "extension_manifest_invalid:project:invalid-json",
        "extension_manifest_invalid:project:missing-name",
        "extension_manifest_invalid:project:missing-version",
        "extension_manifest_invalid:project:non-object",
        "extension_load_failed:project:string-throw-ext",
      ]);
    });
  });

  it("skips discovery and loading when noExtensions is set", async () => {
    await withTempPmPath(async (context) => {
      const roots = resolveExtensionRoots(context.pmPath);
      await createExtension(
        roots.project,
        "skipped",
        {
          name: "skipped-ext",
          version: "1.0.0",
          entry: "./index.mjs",
        },
        "export default { skipped: true };\n",
      );

      const settings = await loadSettings(context);
      const loaded = await loadExtensions({
        pmRoot: context.pmPath,
        settings,
        noExtensions: true,
      });

      expect(loaded.disabled_by_flag).toBe(true);
      expect(loaded.discovered).toEqual([]);
      expect(loaded.effective).toEqual([]);
      expect(loaded.loaded).toEqual([]);
      expect(loaded.failed).toEqual([]);
      expect(loaded.warnings).toEqual([]);
    });
  });

  it("registers deterministic command and renderer overrides from activated extensions", async () => {
    const activation = await activateExtensions({
      disabled_by_flag: false,
      roots: {
        global: "/tmp/global",
        project: "/tmp/project",
      },
      configured_enabled: [],
      configured_disabled: [],
      discovered: [],
      effective: [],
      warnings: [],
      loaded: [
        {
          layer: "global",
          directory: "global-overrides",
          manifest_path: "/tmp/global/global-overrides/manifest.json",
          name: "global-overrides",
          version: "1.0.0",
          entry: "./index.mjs",
          priority: 10,
          entry_path: "/tmp/global/global-overrides/index.mjs",
          module: {
            activate(api: {
              registerCommand: (
                command: string,
                run: (context: { result: unknown; command: string; args: string[]; pm_root: string }) => unknown,
              ) => void;
              registerRenderer: (format: "toon" | "json", run: (context: { result: unknown }) => string) => void;
            }) {
              api.registerCommand("list-open", (context) => ({
                ...(context.result as Record<string, unknown>),
                source: "global",
              }));
              api.registerRenderer("json", (context) => JSON.stringify({ source: "global", result: context.result }));
            },
          },
        },
        {
          layer: "project",
          directory: "project-overrides",
          manifest_path: "/tmp/project/project-overrides/manifest.json",
          name: "project-overrides",
          version: "1.0.0",
          entry: "./index.mjs",
          priority: 20,
          entry_path: "/tmp/project/project-overrides/index.mjs",
          module: {
            activate(api: {
              registerCommand: (
                command: string,
                run: (context: { result: unknown; command: string; args: string[]; pm_root: string }) => unknown,
              ) => void;
              registerRenderer: (format: "toon" | "json", run: (context: { result: unknown }) => string) => void;
            }) {
              api.registerCommand("list-open", (context) => ({
                ...(context.result as Record<string, unknown>),
                source: "project",
              }));
              api.registerRenderer("json", (context) => JSON.stringify({ source: "project", result: context.result }));
            },
          },
        },
      ],
      failed: [],
    });

    expect(activation.command_override_count).toBe(2);
    expect(activation.command_handler_count).toBe(0);
    expect(activation.renderer_override_count).toBe(2);

    const commandResult = runCommandOverride(activation.commands, {
      command: "list-open",
      args: ["--limit", "1"],
      pm_root: "/tmp/project",
      result: { count: 1 },
    });
    expect(commandResult).toEqual({
      overridden: true,
      result: { count: 1, source: "project" },
      warnings: [],
    });

    const rendererResult = runRendererOverride(activation.renderers, {
      format: "json",
      result: { ok: true },
    });
    expect(rendererResult).toEqual({
      overridden: true,
      rendered: JSON.stringify({ source: "project", result: { ok: true } }),
      warnings: [],
    });
  });

  it("registers deterministic command handlers from activated extensions", async () => {
    const activation = await activateExtensions({
      disabled_by_flag: false,
      roots: {
        global: "/tmp/global",
        project: "/tmp/project",
      },
      configured_enabled: [],
      configured_disabled: [],
      discovered: [],
      effective: [],
      warnings: [],
      loaded: [
        {
          layer: "global",
          directory: "global-handlers",
          manifest_path: "/tmp/global/global-handlers/manifest.json",
          name: "global-handlers",
          version: "1.0.0",
          entry: "./index.mjs",
          priority: 10,
          entry_path: "/tmp/global/global-handlers/index.mjs",
          module: {
            activate(api: {
              registerCommand: (
                definition: {
                  name: string;
                  run: (context: { command: string; options: Record<string, unknown> }) => unknown;
                },
              ) => void;
            }) {
              api.registerCommand({
                name: "beads import",
                run: (context) => ({
                  source: "global",
                  command: context.command,
                }),
              });
            },
          },
        },
        {
          layer: "project",
          directory: "project-handlers",
          manifest_path: "/tmp/project/project-handlers/manifest.json",
          name: "project-handlers",
          version: "1.0.0",
          entry: "./index.mjs",
          priority: 20,
          entry_path: "/tmp/project/project-handlers/index.mjs",
          module: {
            activate(api: {
              registerCommand: (
                definition: {
                  name: string;
                  run: (context: { command: string; options: Record<string, unknown> }) => unknown;
                },
              ) => void;
            }) {
              api.registerCommand({
                name: "beads import",
                run: (context) => ({
                  source: "project",
                  file: context.options.file,
                }),
              });
            },
          },
        },
      ],
      failed: [],
    });

    expect(activation.command_override_count).toBe(0);
    expect(activation.command_handler_count).toBe(2);
    expect(activation.renderer_override_count).toBe(0);

    const handlerResult = await runCommandHandler(activation.commands, {
      command: "beads import",
      args: ["--file", "source.jsonl"],
      options: { file: "source.jsonl" },
      global: {
        json: true,
        quiet: false,
        noExtensions: false,
        profile: false,
      },
      pm_root: "/tmp/project",
    });
    expect(handlerResult).toEqual({
      handled: true,
      result: {
        source: "project",
        file: "source.jsonl",
      },
      warnings: [],
    });
  });

  it("canonicalizes repeated whitespace for extension command names", async () => {
    const activation = await activateExtensions({
      disabled_by_flag: false,
      roots: {
        global: "/tmp/global",
        project: "/tmp/project",
      },
      configured_enabled: [],
      configured_disabled: [],
      discovered: [],
      effective: [],
      warnings: [],
      loaded: [
        {
          layer: "project",
          directory: "canonical-command-names",
          manifest_path: "/tmp/project/canonical-command-names/manifest.json",
          name: "canonical-command-names",
          version: "1.0.0",
          entry: "./index.mjs",
          priority: 10,
          entry_path: "/tmp/project/canonical-command-names/index.mjs",
          module: {
            activate(api: {
              registerCommand: (
                commandOrDefinition:
                  | string
                  | {
                      name: string;
                      run: (context: {
                        command: string;
                        options: Record<string, unknown>;
                        result?: unknown;
                      }) => unknown;
                    },
                run?: (context: { result: unknown }) => unknown,
              ) => void;
            }) {
              api.registerCommand("  beads   import  ", (context) => ({
                ...(context.result as Record<string, unknown>),
                source: "override",
              }));
              api.registerCommand({
                name: "  todos   export  ",
                run: (context) => ({
                  source: "handler",
                  command: context.command,
                  folder: context.options.folder,
                }),
              });
            },
          },
        },
      ],
      failed: [],
    });

    expect(activation.command_override_count).toBe(1);
    expect(activation.command_handler_count).toBe(1);
    expect(activation.commands.overrides.map((entry) => entry.command)).toEqual(["beads import"]);
    expect(activation.commands.handlers.map((entry) => entry.command)).toEqual(["todos export"]);

    const overrideResult = runCommandOverride(activation.commands, {
      command: "beads import",
      args: ["--file", "source.jsonl"],
      pm_root: "/tmp/project",
      result: { ok: true },
    });
    expect(overrideResult).toEqual({
      overridden: true,
      result: { ok: true, source: "override" },
      warnings: [],
    });

    const handlerResult = await runCommandHandler(activation.commands, {
      command: "todos export",
      args: ["--folder", ".pi/todos"],
      options: { folder: ".pi/todos" },
      global: {
        json: false,
        quiet: false,
        noExtensions: false,
        profile: false,
      },
      pm_root: "/tmp/project",
    });
    expect(handlerResult).toEqual({
      handled: true,
      result: {
        source: "handler",
        command: "todos export",
        folder: ".pi/todos",
      },
      warnings: [],
    });
  });

  it("captures deterministic metadata for extended extension registration APIs", async () => {
    const activation = await activateExtensions({
      disabled_by_flag: false,
      roots: {
        global: "/tmp/global",
        project: "/tmp/project",
      },
      configured_enabled: [],
      configured_disabled: [],
      discovered: [],
      effective: [],
      warnings: [],
      loaded: [
        {
          layer: "project",
          directory: "registration-baseline",
          manifest_path: "/tmp/project/registration-baseline/manifest.json",
          name: "registration-baseline",
          version: "1.0.0",
          entry: "./index.mjs",
          priority: 10,
          entry_path: "/tmp/project/registration-baseline/index.mjs",
          module: {
            activate(api: {
              registerFlags: (targetCommand: string, flags: Array<Record<string, unknown>>) => void;
              registerItemFields: (fields: Array<Record<string, unknown>>) => void;
              registerMigration: (definition: Record<string, unknown>) => void;
              registerImporter: (name: string, importer: (context: unknown) => unknown) => void;
              registerExporter: (name: string, exporter: (context: unknown) => unknown) => void;
              registerSearchProvider: (provider: Record<string, unknown>) => void;
              registerVectorStoreAdapter: (adapter: Record<string, unknown>) => void;
            }) {
              api.registerFlags("  list-open  ", [{ long: "--example", short: "-e" }]);
              api.registerItemFields([{ name: "custom_field", type: "string" }]);
              api.registerMigration({
                big_count: 3n,
                marker: Symbol.for("migration"),
                version: 2,
                run: () => "ok",
              });
              api.registerImporter("  beads   jsonl  ", () => "imported");
              api.registerExporter("  todos   markdown  ", () => "exported");
              api.registerSearchProvider({
                metadata: [null, { tags: ["x", "y"] }],
                name: "semantic-provider",
                query: () => [0.1, 0.2],
              });
              api.registerVectorStoreAdapter({
                name: "vector-adapter",
                upsert: () => true,
              });
            },
          },
        },
      ],
      failed: [],
    });

    expect(activation.failed).toEqual([]);
    expect(activation.warnings).toEqual([]);
    expect(activation.registration_counts).toEqual({
      flags: 1,
      item_fields: 1,
      migrations: 1,
      importers: 1,
      exporters: 1,
      search_providers: 1,
      vector_store_adapters: 1,
    });
    expect(activation.registrations.flags).toEqual([
      {
        layer: "project",
        name: "registration-baseline",
        target_command: "list-open",
        flags: [{ long: "--example", short: "-e" }],
      },
    ]);
    expect(activation.registrations.item_fields).toEqual([
      {
        layer: "project",
        name: "registration-baseline",
        fields: [{ name: "custom_field", type: "string" }],
      },
    ]);
    expect(activation.registrations.migrations).toEqual([
      {
        layer: "project",
        name: "registration-baseline",
        definition: {
          big_count: "3",
          marker: "Symbol(migration)",
          run: "[Function]",
          version: 2,
        },
      },
    ]);
    expect(activation.registrations.importers).toEqual([
      {
        layer: "project",
        name: "registration-baseline",
        importer: "beads jsonl",
      },
    ]);
    expect(activation.registrations.exporters).toEqual([
      {
        layer: "project",
        name: "registration-baseline",
        exporter: "todos markdown",
      },
    ]);
    expect(activation.registrations.search_providers).toEqual([
      {
        layer: "project",
        name: "registration-baseline",
        definition: {
          metadata: [null, { tags: ["x", "y"] }],
          name: "semantic-provider",
          query: "[Function]",
        },
      },
    ]);
    expect(activation.registrations.vector_store_adapters).toEqual([
      {
        layer: "project",
        name: "registration-baseline",
        definition: {
          name: "vector-adapter",
          upsert: "[Function]",
        },
      },
    ]);
  });

  it("fails activation when extended registration APIs receive invalid input", async () => {
    const activation = await activateExtensions({
      disabled_by_flag: false,
      roots: {
        global: "/tmp/global",
        project: "/tmp/project",
      },
      configured_enabled: [],
      configured_disabled: [],
      discovered: [],
      effective: [],
      warnings: [],
      loaded: [
        {
          layer: "project",
          directory: "invalid-register-flags",
          manifest_path: "/tmp/project/invalid-register-flags/manifest.json",
          name: "invalid-register-flags",
          version: "1.0.0",
          entry: "./index.mjs",
          priority: 10,
          entry_path: "/tmp/project/invalid-register-flags/index.mjs",
          module: {
            activate(api: { registerFlags: (targetCommand: string, flags: Array<Record<string, unknown>>) => void }) {
              api.registerFlags("list-open", []);
            },
          },
        },
        {
          layer: "project",
          directory: "invalid-register-flags-shape",
          manifest_path: "/tmp/project/invalid-register-flags-shape/manifest.json",
          name: "invalid-register-flags-shape",
          version: "1.0.0",
          entry: "./index.mjs",
          priority: 15,
          entry_path: "/tmp/project/invalid-register-flags-shape/index.mjs",
          module: {
            activate(api: { registerFlags: (targetCommand: string, flags: Array<Record<string, unknown>>) => void }) {
              api.registerFlags("list-open", undefined as unknown as Array<Record<string, unknown>>);
            },
          },
        },
        {
          layer: "project",
          directory: "invalid-register-item-fields",
          manifest_path: "/tmp/project/invalid-register-item-fields/manifest.json",
          name: "invalid-register-item-fields",
          version: "1.0.0",
          entry: "./index.mjs",
          priority: 18,
          entry_path: "/tmp/project/invalid-register-item-fields/index.mjs",
          module: {
            activate(api: {
              registerItemFields: (fields: Array<Record<string, unknown>>) => void;
            }) {
              api.registerItemFields([]);
            },
          },
        },
        {
          layer: "project",
          directory: "invalid-register-importer",
          manifest_path: "/tmp/project/invalid-register-importer/manifest.json",
          name: "invalid-register-importer",
          version: "1.0.0",
          entry: "./index.mjs",
          priority: 20,
          entry_path: "/tmp/project/invalid-register-importer/index.mjs",
          module: {
            activate(api: {
              registerImporter: (name: string, importer: (context: unknown) => unknown) => void;
            }) {
              api.registerImporter("beads", undefined as unknown as (context: unknown) => unknown);
            },
          },
        },
        {
          layer: "project",
          directory: "invalid-register-importer-name",
          manifest_path: "/tmp/project/invalid-register-importer-name/manifest.json",
          name: "invalid-register-importer-name",
          version: "1.0.0",
          entry: "./index.mjs",
          priority: 25,
          entry_path: "/tmp/project/invalid-register-importer-name/index.mjs",
          module: {
            activate(api: {
              registerImporter: (name: string, importer: (context: unknown) => unknown) => void;
            }) {
              api.registerImporter("   ", () => "ok");
            },
          },
        },
        {
          layer: "project",
          directory: "invalid-register-search-provider",
          manifest_path: "/tmp/project/invalid-register-search-provider/manifest.json",
          name: "invalid-register-search-provider",
          version: "1.0.0",
          entry: "./index.mjs",
          priority: 30,
          entry_path: "/tmp/project/invalid-register-search-provider/index.mjs",
          module: {
            activate(api: {
              registerSearchProvider: (provider: Record<string, unknown>) => void;
            }) {
              api.registerSearchProvider(undefined as unknown as Record<string, unknown>);
            },
          },
        },
      ],
      failed: [],
    });

    expect(activation.failed).toEqual([
      expect.objectContaining({ name: "invalid-register-flags" }),
      expect.objectContaining({ name: "invalid-register-flags-shape" }),
      expect.objectContaining({ name: "invalid-register-item-fields" }),
      expect.objectContaining({ name: "invalid-register-importer" }),
      expect.objectContaining({ name: "invalid-register-importer-name" }),
      expect.objectContaining({ name: "invalid-register-search-provider" }),
    ]);
    expect(activation.warnings).toEqual([
      "extension_activate_failed:project:invalid-register-flags",
      "extension_activate_failed:project:invalid-register-flags-shape",
      "extension_activate_failed:project:invalid-register-item-fields",
      "extension_activate_failed:project:invalid-register-importer",
      "extension_activate_failed:project:invalid-register-importer-name",
      "extension_activate_failed:project:invalid-register-search-provider",
    ]);
  });

  it("fails activation when command or renderer registration inputs are invalid", async () => {
    const activation = await activateExtensions({
      disabled_by_flag: false,
      roots: {
        global: "/tmp/global",
        project: "/tmp/project",
      },
      configured_enabled: [],
      configured_disabled: [],
      discovered: [],
      effective: [],
      warnings: [],
      loaded: [
        {
          layer: "project",
          directory: "invalid-command",
          manifest_path: "/tmp/project/invalid-command/manifest.json",
          name: "invalid-command",
          version: "1.0.0",
          entry: "./index.mjs",
          priority: 10,
          entry_path: "/tmp/project/invalid-command/index.mjs",
          module: {
            activate(api: { registerCommand: (command: string, run: (context: unknown) => unknown) => void }) {
              api.registerCommand("   ", (context) => context);
            },
          },
        },
        {
          layer: "project",
          directory: "invalid-renderer",
          manifest_path: "/tmp/project/invalid-renderer/manifest.json",
          name: "invalid-renderer",
          version: "1.0.0",
          entry: "./index.mjs",
          priority: 20,
          entry_path: "/tmp/project/invalid-renderer/index.mjs",
          module: {
            activate(api: {
              registerRenderer: (format: "toon" | "json", run: (context: unknown) => string) => void;
            }) {
              api.registerRenderer("xml" as unknown as "toon" | "json", () => "noop");
            },
          },
        },
        {
          layer: "project",
          directory: "invalid-command-missing-handler",
          manifest_path: "/tmp/project/invalid-command-missing-handler/manifest.json",
          name: "invalid-command-missing-handler",
          version: "1.0.0",
          entry: "./index.mjs",
          priority: 30,
          entry_path: "/tmp/project/invalid-command-missing-handler/index.mjs",
          module: {
            activate(api: {
              registerCommand: (command: string, run: (context: unknown) => unknown) => void;
            }) {
              api.registerCommand("list-open", undefined as unknown as (context: unknown) => unknown);
            },
          },
        },
        {
          layer: "project",
          directory: "invalid-command-definition",
          manifest_path: "/tmp/project/invalid-command-definition/manifest.json",
          name: "invalid-command-definition",
          version: "1.0.0",
          entry: "./index.mjs",
          priority: 40,
          entry_path: "/tmp/project/invalid-command-definition/index.mjs",
          module: {
            activate(api: {
              registerCommand: (
                definition: {
                  name: string;
                  run: (context: unknown) => unknown;
                },
              ) => void;
            }) {
              api.registerCommand({
                name: "  ",
                run: undefined as unknown as (context: unknown) => unknown,
              });
            },
          },
        },
        {
          layer: "project",
          directory: "invalid-command-definition-run",
          manifest_path: "/tmp/project/invalid-command-definition-run/manifest.json",
          name: "invalid-command-definition-run",
          version: "1.0.0",
          entry: "./index.mjs",
          priority: 50,
          entry_path: "/tmp/project/invalid-command-definition-run/index.mjs",
          module: {
            activate(api: {
              registerCommand: (
                definition: {
                  name: string;
                  run: (context: unknown) => unknown;
                },
              ) => void;
            }) {
              api.registerCommand({
                name: "beads import",
                run: undefined as unknown as (context: unknown) => unknown,
              });
            },
          },
        },
        {
          layer: "project",
          directory: "invalid-command-definition-object",
          manifest_path: "/tmp/project/invalid-command-definition-object/manifest.json",
          name: "invalid-command-definition-object",
          version: "1.0.0",
          entry: "./index.mjs",
          priority: 60,
          entry_path: "/tmp/project/invalid-command-definition-object/index.mjs",
          module: {
            activate(api: {
              registerCommand: (
                definition: {
                  name: string;
                  run: (context: unknown) => unknown;
                },
              ) => void;
            }) {
              api.registerCommand(undefined as unknown as { name: string; run: (context: unknown) => unknown });
            },
          },
        },
        {
          layer: "project",
          directory: "invalid-command-definition-name-type",
          manifest_path: "/tmp/project/invalid-command-definition-name-type/manifest.json",
          name: "invalid-command-definition-name-type",
          version: "1.0.0",
          entry: "./index.mjs",
          priority: 65,
          entry_path: "/tmp/project/invalid-command-definition-name-type/index.mjs",
          module: {
            activate(api: {
              registerCommand: (
                definition: {
                  name: string;
                  run: (context: unknown) => unknown;
                },
              ) => void;
            }) {
              api.registerCommand({
                name: 123 as unknown as string,
                run: (context) => context,
              });
            },
          },
        },
        {
          layer: "project",
          directory: "invalid-renderer-handler",
          manifest_path: "/tmp/project/invalid-renderer-handler/manifest.json",
          name: "invalid-renderer-handler",
          version: "1.0.0",
          entry: "./index.mjs",
          priority: 70,
          entry_path: "/tmp/project/invalid-renderer-handler/index.mjs",
          module: {
            activate(api: {
              registerRenderer: (format: "toon" | "json", run: (context: unknown) => string) => void;
            }) {
              api.registerRenderer("json", undefined as unknown as (context: unknown) => string);
            },
          },
        },
      ],
      failed: [],
    });

    expect(activation.failed).toEqual([
      expect.objectContaining({ name: "invalid-command" }),
      expect.objectContaining({ name: "invalid-renderer" }),
      expect.objectContaining({ name: "invalid-command-missing-handler" }),
      expect.objectContaining({ name: "invalid-command-definition" }),
      expect.objectContaining({ name: "invalid-command-definition-run" }),
      expect.objectContaining({ name: "invalid-command-definition-object" }),
      expect.objectContaining({ name: "invalid-command-definition-name-type" }),
      expect.objectContaining({ name: "invalid-renderer-handler" }),
    ]);
    expect(activation.warnings).toEqual([
      "extension_activate_failed:project:invalid-command",
      "extension_activate_failed:project:invalid-renderer",
      "extension_activate_failed:project:invalid-command-missing-handler",
      "extension_activate_failed:project:invalid-command-definition",
      "extension_activate_failed:project:invalid-command-definition-run",
      "extension_activate_failed:project:invalid-command-definition-object",
      "extension_activate_failed:project:invalid-command-definition-name-type",
      "extension_activate_failed:project:invalid-renderer-handler",
    ]);
  });

  it("fails activation when API registrations exceed declared manifest capabilities", async () => {
    const activation = await activateExtensions({
      disabled_by_flag: false,
      roots: {
        global: "/tmp/global",
        project: "/tmp/project",
      },
      configured_enabled: [],
      configured_disabled: [],
      discovered: [],
      effective: [],
      warnings: [],
      loaded: [
        {
          layer: "project",
          directory: "missing-commands-capability",
          manifest_path: "/tmp/project/missing-commands-capability/manifest.json",
          name: "missing-commands-capability",
          version: "1.0.0",
          entry: "./index.mjs",
          priority: 10,
          entry_path: "/tmp/project/missing-commands-capability/index.mjs",
          capabilities: ["hooks"],
          module: {
            activate(api: { registerCommand: (command: string, run: (context: unknown) => unknown) => void }) {
              api.registerCommand("list-open", (context) => context);
            },
          },
        },
        {
          layer: "project",
          directory: "missing-renderers-capability",
          manifest_path: "/tmp/project/missing-renderers-capability/manifest.json",
          name: "missing-renderers-capability",
          version: "1.0.0",
          entry: "./index.mjs",
          priority: 20,
          entry_path: "/tmp/project/missing-renderers-capability/index.mjs",
          capabilities: ["commands"],
          module: {
            activate(api: { registerRenderer: (format: "toon" | "json", run: (context: unknown) => string) => void }) {
              api.registerRenderer("json", () => "{}");
            },
          },
        },
        {
          layer: "project",
          directory: "missing-hooks-capability",
          manifest_path: "/tmp/project/missing-hooks-capability/manifest.json",
          name: "missing-hooks-capability",
          version: "1.0.0",
          entry: "./index.mjs",
          priority: 30,
          entry_path: "/tmp/project/missing-hooks-capability/index.mjs",
          capabilities: ["commands"],
          module: {
            activate(api: { hooks: { beforeCommand: (hook: (context: unknown) => void) => void } }) {
              api.hooks.beforeCommand(() => {});
            },
          },
        },
        {
          layer: "project",
          directory: "missing-schema-capability",
          manifest_path: "/tmp/project/missing-schema-capability/manifest.json",
          name: "missing-schema-capability",
          version: "1.0.0",
          entry: "./index.mjs",
          priority: 40,
          entry_path: "/tmp/project/missing-schema-capability/index.mjs",
          capabilities: ["commands"],
          module: {
            activate(api: { registerFlags: (targetCommand: string, flags: Array<Record<string, unknown>>) => void }) {
              api.registerFlags("list-open", [{ long: "--sample" }]);
            },
          },
        },
        {
          layer: "project",
          directory: "missing-importers-capability",
          manifest_path: "/tmp/project/missing-importers-capability/manifest.json",
          name: "missing-importers-capability",
          version: "1.0.0",
          entry: "./index.mjs",
          priority: 50,
          entry_path: "/tmp/project/missing-importers-capability/index.mjs",
          capabilities: ["commands"],
          module: {
            activate(api: {
              registerImporter: (name: string, importer: (context: unknown) => unknown) => void;
            }) {
              api.registerImporter("sample", () => "ok");
            },
          },
        },
        {
          layer: "project",
          directory: "missing-search-capability",
          manifest_path: "/tmp/project/missing-search-capability/manifest.json",
          name: "missing-search-capability",
          version: "1.0.0",
          entry: "./index.mjs",
          priority: 60,
          entry_path: "/tmp/project/missing-search-capability/index.mjs",
          capabilities: ["commands", "custom-capability"],
          module: {
            activate(api: { registerSearchProvider: (provider: Record<string, unknown>) => void }) {
              api.registerSearchProvider({ name: "sample-search" });
            },
          },
        },
      ],
      failed: [],
    });

    expect(activation.failed).toEqual([
      expect.objectContaining({ name: "missing-commands-capability" }),
      expect.objectContaining({ name: "missing-renderers-capability" }),
      expect.objectContaining({ name: "missing-hooks-capability" }),
      expect.objectContaining({ name: "missing-schema-capability" }),
      expect.objectContaining({ name: "missing-importers-capability" }),
      expect.objectContaining({ name: "missing-search-capability" }),
    ]);
    expect(activation.warnings).toEqual([
      "extension_activate_failed:project:missing-commands-capability",
      "extension_activate_failed:project:missing-renderers-capability",
      "extension_activate_failed:project:missing-hooks-capability",
      "extension_activate_failed:project:missing-schema-capability",
      "extension_activate_failed:project:missing-importers-capability",
      "extension_activate_failed:project:missing-search-capability",
    ]);
  });

  it("fails activation when hook registration handlers are invalid", async () => {
    const activation = await activateExtensions({
      disabled_by_flag: false,
      roots: {
        global: "/tmp/global",
        project: "/tmp/project",
      },
      configured_enabled: [],
      configured_disabled: [],
      discovered: [],
      effective: [],
      warnings: [],
      loaded: [
        {
          layer: "project",
          directory: "invalid-before-hook",
          manifest_path: "/tmp/project/invalid-before-hook/manifest.json",
          name: "invalid-before-hook",
          version: "1.0.0",
          entry: "./index.mjs",
          priority: 10,
          entry_path: "/tmp/project/invalid-before-hook/index.mjs",
          module: {
            activate(api: {
              hooks: {
                beforeCommand: (hook: (context: unknown) => void) => void;
              };
            }) {
              api.hooks.beforeCommand(undefined as unknown as (context: unknown) => void);
            },
          },
        },
        {
          layer: "project",
          directory: "invalid-after-hook",
          manifest_path: "/tmp/project/invalid-after-hook/manifest.json",
          name: "invalid-after-hook",
          version: "1.0.0",
          entry: "./index.mjs",
          priority: 20,
          entry_path: "/tmp/project/invalid-after-hook/index.mjs",
          module: {
            activate(api: {
              hooks: {
                afterCommand: (hook: (context: unknown) => void) => void;
              };
            }) {
              api.hooks.afterCommand(undefined as unknown as (context: unknown) => void);
            },
          },
        },
        {
          layer: "project",
          directory: "invalid-on-write-hook",
          manifest_path: "/tmp/project/invalid-on-write-hook/manifest.json",
          name: "invalid-on-write-hook",
          version: "1.0.0",
          entry: "./index.mjs",
          priority: 30,
          entry_path: "/tmp/project/invalid-on-write-hook/index.mjs",
          module: {
            activate(api: {
              hooks: {
                onWrite: (hook: (context: unknown) => void) => void;
              };
            }) {
              api.hooks.onWrite(undefined as unknown as (context: unknown) => void);
            },
          },
        },
        {
          layer: "project",
          directory: "invalid-on-read-hook",
          manifest_path: "/tmp/project/invalid-on-read-hook/manifest.json",
          name: "invalid-on-read-hook",
          version: "1.0.0",
          entry: "./index.mjs",
          priority: 40,
          entry_path: "/tmp/project/invalid-on-read-hook/index.mjs",
          module: {
            activate(api: {
              hooks: {
                onRead: (hook: (context: unknown) => void) => void;
              };
            }) {
              api.hooks.onRead(undefined as unknown as (context: unknown) => void);
            },
          },
        },
        {
          layer: "project",
          directory: "invalid-on-index-hook",
          manifest_path: "/tmp/project/invalid-on-index-hook/manifest.json",
          name: "invalid-on-index-hook",
          version: "1.0.0",
          entry: "./index.mjs",
          priority: 50,
          entry_path: "/tmp/project/invalid-on-index-hook/index.mjs",
          module: {
            activate(api: {
              hooks: {
                onIndex: (hook: (context: unknown) => void) => void;
              };
            }) {
              api.hooks.onIndex(undefined as unknown as (context: unknown) => void);
            },
          },
        },
      ],
      failed: [],
    });

    expect(activation.failed).toEqual([
      expect.objectContaining({ name: "invalid-before-hook" }),
      expect.objectContaining({ name: "invalid-after-hook" }),
      expect.objectContaining({ name: "invalid-on-write-hook" }),
      expect.objectContaining({ name: "invalid-on-read-hook" }),
      expect.objectContaining({ name: "invalid-on-index-hook" }),
    ]);
    expect(activation.warnings).toEqual([
      "extension_activate_failed:project:invalid-before-hook",
      "extension_activate_failed:project:invalid-after-hook",
      "extension_activate_failed:project:invalid-on-write-hook",
      "extension_activate_failed:project:invalid-on-read-hook",
      "extension_activate_failed:project:invalid-on-index-hook",
    ]);
  });

  it("contains command override failures and unsupported async overrides", () => {
    const registry = {
      overrides: [
        {
          layer: "project" as const,
          name: "async-ext",
          command: "list-all",
          run: (context: { result: { ok: boolean; nested: { preserved: boolean } } }) => {
            context.result.nested.preserved = false;
            return Promise.resolve({ bad: true });
          },
        },
        {
          layer: "project" as const,
          name: "boom-ext",
          command: "stats",
          run: (context: { result: { ok: boolean; nested: { preserved: boolean } } }) => {
            context.result.nested.preserved = false;
            throw new Error("boom");
          },
        },
      ],
      handlers: [],
    };

    expect(
      runCommandOverride(registry, {
        command: "   ",
        args: [],
        pm_root: "/tmp/project",
        result: { ok: true },
      }),
    ).toEqual({
      overridden: false,
      result: { ok: true },
      warnings: [],
    });

    expect(
      runCommandOverride(registry, {
        command: "get",
        args: [],
        pm_root: "/tmp/project",
        result: { ok: true },
      }),
    ).toEqual({
      overridden: false,
      result: { ok: true },
      warnings: [],
    });

    const listAllResult = {
      ok: true,
      nested: { preserved: true },
    };
    expect(
      runCommandOverride(registry, {
        command: "list-all",
        args: ["--limit", "1"],
        pm_root: "/tmp/project",
        result: listAllResult,
      }),
    ).toEqual({
      overridden: false,
      result: {
        ok: true,
        nested: { preserved: true },
      },
      warnings: ["extension_command_override_async_unsupported:project:async-ext:list-all"],
    });
    expect(listAllResult).toEqual({
      ok: true,
      nested: { preserved: true },
    });

    const statsResult = {
      ok: true,
      nested: { preserved: true },
    };
    expect(
      runCommandOverride(registry, {
        command: "stats",
        args: [],
        pm_root: "/tmp/project",
        result: statsResult,
      }),
    ).toEqual({
      overridden: false,
      result: {
        ok: true,
        nested: { preserved: true },
      },
      warnings: ["extension_command_override_failed:project:boom-ext:stats"],
    });
    expect(statsResult).toEqual({
      ok: true,
      nested: { preserved: true },
    });
  });

  it("contains command handler lookup and failure cases", async () => {
    const registry = {
      overrides: [],
      handlers: [
        {
          layer: "project" as const,
          name: "handler-boom-ext",
          command: "beads import",
          run: () => {
            throw new Error("boom");
          },
        },
      ],
    };

    expect(
      await runCommandHandler(registry, {
        command: "   ",
        args: [],
        options: {},
        global: {
          json: false,
          quiet: false,
          noExtensions: false,
          profile: false,
        },
        pm_root: "/tmp/project",
      }),
    ).toEqual({
      handled: false,
      result: null,
      warnings: [],
    });

    expect(
      await runCommandHandler(registry, {
        command: "list-open",
        args: [],
        options: {},
        global: {
          json: false,
          quiet: false,
          noExtensions: false,
          profile: false,
        },
        pm_root: "/tmp/project",
      }),
    ).toEqual({
      handled: false,
      result: null,
      warnings: [],
    });

    expect(
      await runCommandHandler(registry, {
        command: "beads import",
        args: ["--file", "source.jsonl"],
        options: { file: "source.jsonl" },
        global: {
          json: true,
          quiet: false,
          noExtensions: false,
          profile: false,
        },
        pm_root: "/tmp/project",
      }),
    ).toEqual({
      handled: false,
      result: null,
      warnings: ["extension_command_handler_failed:project:handler-boom-ext:beads import"],
    });
  });

  it("isolates command handler context snapshots from caller mutation", async () => {
    const registry = {
      overrides: [],
      handlers: [
        {
          layer: "project" as const,
          name: "handler-mutate-ext",
          command: "todos export",
          run: (context: {
            args: string[];
            options: Record<string, unknown>;
            global: { json: boolean; quiet: boolean; noExtensions: boolean; profile: boolean };
          }) => {
            context.args.push("--quiet");
            context.options.folder = "mutated-folder";
            (context.options.nested as { immutable: boolean }).immutable = false;
            context.global.quiet = true;
            return {
              args: context.args,
              options: context.options,
              global: context.global,
            };
          },
        },
      ],
    };

    const callerArgs = ["--folder", ".pi/todos"];
    const callerOptions: Record<string, unknown> = {
      folder: ".pi/todos",
      nested: {
        immutable: true,
      },
    };
    const callerGlobal = {
      json: false,
      quiet: false,
      noExtensions: false,
      profile: false,
    };

    const result = await runCommandHandler(registry, {
      command: "todos export",
      args: callerArgs,
      options: callerOptions,
      global: callerGlobal,
      pm_root: "/tmp/project",
    });

    expect(result).toEqual({
      handled: true,
      result: {
        args: ["--folder", ".pi/todos", "--quiet"],
        options: {
          folder: "mutated-folder",
          nested: {
            immutable: false,
          },
        },
        global: {
          json: false,
          quiet: true,
          noExtensions: false,
          profile: false,
        },
      },
      warnings: [],
    });
    expect(callerArgs).toEqual(["--folder", ".pi/todos"]);
    expect(callerOptions).toEqual({
      folder: ".pi/todos",
      nested: {
        immutable: true,
      },
    });
    expect(callerGlobal).toEqual({
      json: false,
      quiet: false,
      noExtensions: false,
      profile: false,
    });
  });

  it("contains renderer override invalid-result and failure cases", () => {
    const validRegistry = {
      overrides: [
        {
          layer: "project" as const,
          name: "json-renderer",
          format: "json" as const,
          run: (context: { result: unknown }) => JSON.stringify({ wrapped: context.result }),
        },
      ],
    };
    expect(
      runRendererOverride(validRegistry, {
        format: "json",
        result: { ok: true },
      }),
    ).toEqual({
      overridden: true,
      rendered: JSON.stringify({ wrapped: { ok: true } }),
      warnings: [],
    });

    expect(
      runRendererOverride(validRegistry, {
        format: "toon",
        result: { ok: true },
      }),
    ).toEqual({
      overridden: false,
      rendered: null,
      warnings: [],
    });

    const invalidRegistry = {
      overrides: [
        {
          layer: "project" as const,
          name: "invalid-renderer",
          format: "json" as const,
          run: () => 42 as unknown as string,
        },
      ],
    };
    expect(
      runRendererOverride(invalidRegistry, {
        format: "json",
        result: { ok: true },
      }),
    ).toEqual({
      overridden: false,
      rendered: null,
      warnings: ["extension_renderer_invalid_result:project:invalid-renderer:json"],
    });

    const throwingRegistry = {
      overrides: [
        {
          layer: "project" as const,
          name: "boom-renderer",
          format: "toon" as const,
          run: (context: { result: { ok: boolean; nested: { preserved: boolean } } }) => {
            context.result.nested.preserved = false;
            throw new Error("boom");
          },
        },
      ],
    };
    const rendererFallbackResult = {
      ok: true,
      nested: { preserved: true },
    };
    expect(
      runRendererOverride(throwingRegistry, {
        format: "toon",
        result: rendererFallbackResult,
      }),
    ).toEqual({
      overridden: false,
      rendered: null,
      warnings: ["extension_renderer_failed:project:boom-renderer:toon"],
    });
    expect(rendererFallbackResult).toEqual({
      ok: true,
      nested: { preserved: true },
    });
  });
});
