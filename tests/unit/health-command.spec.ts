import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runHealth } from "../../src/cli/commands/health.js";
import { clearActiveExtensionHooks, setActiveExtensionHooks } from "../../src/core/extensions/index.js";
import { EXIT_CODE } from "../../src/constants.js";
import { withTempPmPath, type TempPmContext } from "../helpers/withTempPmPath.js";

function createSeedItem(context: TempPmContext): string {
  const create = context.runCli(
    [
      "create",
      "--json",
      "--title",
      "Health Seed",
      "--description",
      "Seed item for health checks",
      "--type",
      "Task",
      "--status",
      "open",
      "--priority",
      "1",
      "--tags",
      "health,coverage",
      "--body",
      "",
      "--deadline",
      "none",
      "--estimate",
      "15",
      "--acceptance-criteria",
      "Health command summarizes storage",
      "--author",
      "test-author",
      "--message",
      "Create health seed",
      "--assignee",
      "none",
      "--dep",
      "none",
      "--comment",
      "none",
      "--note",
      "none",
      "--learning",
      "none",
      "--file",
      "none",
      "--test",
      "none",
      "--doc",
      "none",
    ],
    { expectJson: true },
  );
  expect(create.code).toBe(0);
  return (create.json as { item: { id: string } }).item.id;
}

describe("runHealth", () => {
  afterEach(() => {
    clearActiveExtensionHooks();
  });

  it("fails when tracker is not initialized", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pm-health-not-init-"));
    try {
      await expect(runHealth({ path: tempDir })).rejects.toMatchObject({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("returns deterministic ok checks for initialized storage", async () => {
    await withTempPmPath(async (context) => {
      createSeedItem(context);
      const health = await runHealth({ path: context.pmPath });
      expect(health.ok).toBe(true);
      expect(health.warnings).toEqual([]);
      expect(health.checks.map((check) => check.name)).toEqual([
        "settings",
        "directories",
        "settings_values",
        "extensions",
        "storage",
      ]);

      const directoriesCheck = health.checks.find((check) => check.name === "directories");
      expect(directoriesCheck?.status).toBe("ok");
      expect(directoriesCheck?.details).toMatchObject({
        missing: [],
      });

      const settingValuesCheck = health.checks.find((check) => check.name === "settings_values");
      expect(settingValuesCheck?.status).toBe("ok");
      expect(settingValuesCheck?.details).toEqual({ warnings: [] });

      const extensionCheck = health.checks.find((check) => check.name === "extensions");
      expect(extensionCheck?.status).toBe("ok");
      expect(extensionCheck?.details).toMatchObject({
        disabled_by_flag: false,
        configured_enabled: [],
        configured_disabled: [],
        discovered: [],
        warnings: [],
      });
      const defaultLoaded = (
        extensionCheck?.details as { loaded?: Array<{ name: string; has_activate: boolean; module?: unknown }> }
      ).loaded ?? [];
      expect(defaultLoaded).toEqual([
        expect.objectContaining({
          name: "builtin-beads-import",
          has_activate: true,
        }),
        expect.objectContaining({
          name: "builtin-todos-import-export",
          has_activate: true,
        }),
      ]);
      expect(defaultLoaded.every((entry) => !("module" in entry))).toBe(true);

      const storageCheck = health.checks.find((check) => check.name === "storage");
      expect(storageCheck?.details).toEqual({
        items: 1,
        history_streams: 1,
      });
      expect(health.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  it("reports warn checks for missing directories and invalid settings values", async () => {
    await withTempPmPath(async (context) => {
      const settingsPath = path.join(context.pmPath, "settings.json");
      const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
        id_prefix: string;
        locks: { ttl_seconds: number };
      };
      settings.id_prefix = "";
      settings.locks.ttl_seconds = 0;
      await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

      await rm(path.join(context.pmPath, "history"), { recursive: true, force: true });
      await rm(path.join(context.pmPath, "search"), { recursive: true, force: true });

      const health = await runHealth({ path: context.pmPath });
      expect(health.ok).toBe(false);
      expect(health.warnings).toEqual([
        "missing_directory:history",
        "missing_directory:search",
        "settings:id_prefix_empty",
        "settings:locks_ttl_non_positive",
      ]);

      const directoriesCheck = health.checks.find((check) => check.name === "directories");
      expect(directoriesCheck?.status).toBe("warn");
      expect(directoriesCheck?.details).toMatchObject({
        missing: ["history", "search"],
      });

      const settingValuesCheck = health.checks.find((check) => check.name === "settings_values");
      expect(settingValuesCheck?.status).toBe("warn");
      expect(settingValuesCheck?.details).toEqual({
        warnings: ["settings:id_prefix_empty", "settings:locks_ttl_non_positive"],
      });

      const extensionCheck = health.checks.find((check) => check.name === "extensions");
      expect(extensionCheck?.status).toBe("ok");
      expect(extensionCheck?.details).toMatchObject({
        disabled_by_flag: false,
        discovered: [],
        warnings: [],
      });

      const storageCheck = health.checks.find((check) => check.name === "storage");
      expect(storageCheck?.details).toEqual({
        items: 0,
        history_streams: 0,
      });
    });
  });

  it("marks extension check unhealthy when runtime load probe fails", async () => {
    await withTempPmPath(async (context) => {
      const projectExtensionsRoot = path.join(context.pmPath, "extensions");

      await mkdir(path.join(projectExtensionsRoot, "boom"), { recursive: true });
      await writeFile(
        path.join(projectExtensionsRoot, "boom", "manifest.json"),
        `${JSON.stringify(
          {
            name: "boom-ext",
            version: "1.0.0",
            entry: "./index.js",
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await writeFile(path.join(projectExtensionsRoot, "boom", "index.js"), "throw new Error('boom-load');\n", "utf8");

      await mkdir(path.join(projectExtensionsRoot, "ok"), { recursive: true });
      await writeFile(
        path.join(projectExtensionsRoot, "ok", "manifest.json"),
        `${JSON.stringify(
          {
            name: "ok-ext",
            version: "1.0.0",
            entry: "./index.js",
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await writeFile(path.join(projectExtensionsRoot, "ok", "index.js"), "export default { ok: true };\n", "utf8");

      await mkdir(path.join(projectExtensionsRoot, "primitive"), { recursive: true });
      await writeFile(
        path.join(projectExtensionsRoot, "primitive", "manifest.json"),
        `${JSON.stringify(
          {
            name: "primitive-ext",
            version: "1.0.0",
            entry: "./index.js",
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await writeFile(path.join(projectExtensionsRoot, "primitive", "index.js"), "export default 1;\n", "utf8");

      const health = await runHealth({ path: context.pmPath });
      expect(health.ok).toBe(false);
      expect(health.warnings).toEqual(["extension_load_failed:project:boom-ext"]);

      const extensionCheck = health.checks.find((check) => check.name === "extensions");
      expect(extensionCheck?.status).toBe("warn");
      expect(extensionCheck?.details).toMatchObject({
        disabled_by_flag: false,
        warnings: ["extension_load_failed:project:boom-ext"],
        failed: [
          expect.objectContaining({
            layer: "project",
            name: "boom-ext",
          }),
        ],
      });

      const loaded = (
        extensionCheck?.details as { loaded?: Array<{ name: string; has_activate: boolean; module?: unknown }> }
      ).loaded ?? [];
      expect(loaded).toEqual([
        expect.objectContaining({
          name: "builtin-beads-import",
          has_activate: true,
        }),
        expect.objectContaining({
          name: "builtin-todos-import-export",
          has_activate: true,
        }),
        expect.objectContaining({
          name: "ok-ext",
          has_activate: false,
        }),
        expect.objectContaining({
          name: "primitive-ext",
          has_activate: false,
        }),
      ]);
      expect(loaded.every((entry) => !("module" in entry))).toBe(true);
    });
  });

  it("marks extension check unhealthy when runtime activation probe fails", async () => {
    await withTempPmPath(async (context) => {
      const projectExtensionsRoot = path.join(context.pmPath, "extensions");

      await mkdir(path.join(projectExtensionsRoot, "activate-boom"), { recursive: true });
      await writeFile(
        path.join(projectExtensionsRoot, "activate-boom", "manifest.json"),
        `${JSON.stringify(
          {
            name: "activate-boom-ext",
            version: "1.0.0",
            entry: "./index.js",
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await writeFile(
        path.join(projectExtensionsRoot, "activate-boom", "index.js"),
        "export default { activate() { throw new Error('activate-boom'); } };\n",
        "utf8",
      );

      await mkdir(path.join(projectExtensionsRoot, "ok"), { recursive: true });
      await writeFile(
        path.join(projectExtensionsRoot, "ok", "manifest.json"),
        `${JSON.stringify(
          {
            name: "ok-ext",
            version: "1.0.0",
            entry: "./index.js",
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await writeFile(
        path.join(projectExtensionsRoot, "ok", "index.js"),
        "export default { activate() {} };\n",
        "utf8",
      );

      const health = await runHealth({ path: context.pmPath });
      expect(health.ok).toBe(false);
      expect(health.warnings).toEqual(["extension_activate_failed:project:activate-boom-ext"]);

      const extensionCheck = health.checks.find((check) => check.name === "extensions");
      expect(extensionCheck?.status).toBe("warn");
      expect(extensionCheck?.details).toMatchObject({
        disabled_by_flag: false,
        failed: [],
        warnings: ["extension_activate_failed:project:activate-boom-ext"],
        activation: {
          warnings: ["extension_activate_failed:project:activate-boom-ext"],
          failed: [
            expect.objectContaining({
              layer: "project",
              name: "activate-boom-ext",
              error: "activate-boom",
            }),
          ],
          hook_counts: {
            before_command: 0,
            after_command: 0,
            on_write: 0,
            on_read: 0,
            on_index: 0,
          },
          command_override_count: 0,
          command_handler_count: 3,
          renderer_override_count: 0,
        },
      });

      const loaded = (extensionCheck?.details as { loaded?: Array<{ name: string }> }).loaded ?? [];
      expect(loaded.map((entry) => entry.name)).toEqual([
        "builtin-beads-import",
        "builtin-todos-import-export",
        "activate-boom-ext",
        "ok-ext",
      ]);
    });
  });

  it("reports applied pending and failed extension migrations in health diagnostics", async () => {
    await withTempPmPath(async (context) => {
      const projectExtensionsRoot = path.join(context.pmPath, "extensions");
      const globalExtensionsRoot = path.join(context.env.PM_GLOBAL_PATH as string, "extensions");

      await mkdir(path.join(globalExtensionsRoot, "global-migration-ext"), { recursive: true });
      await writeFile(
        path.join(globalExtensionsRoot, "global-migration-ext", "manifest.json"),
        `${JSON.stringify(
          {
            name: "global-migration-ext",
            version: "1.0.0",
            entry: "./index.js",
            capabilities: ["schema"],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await writeFile(
        path.join(globalExtensionsRoot, "global-migration-ext", "index.js"),
        [
          "export default {",
          "  activate(api) {",
          "    api.registerMigration({ id: 'global-migrate' });",
          "  },",
          "};",
          "",
        ].join("\n"),
        "utf8",
      );

      await mkdir(path.join(projectExtensionsRoot, "a-ext"), { recursive: true });
      await writeFile(
        path.join(projectExtensionsRoot, "a-ext", "manifest.json"),
        `${JSON.stringify(
          {
            name: "a-ext",
            version: "1.0.0",
            entry: "./index.js",
            capabilities: ["schema"],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await writeFile(
        path.join(projectExtensionsRoot, "a-ext", "index.js"),
        [
          "export default {",
          "  activate(api) {",
          "    api.registerMigration({});",
          "    api.registerMigration({ id: 'zzz-migrate' });",
          "  },",
          "};",
          "",
        ].join("\n"),
        "utf8",
      );

      await mkdir(path.join(projectExtensionsRoot, "b-ext"), { recursive: true });
      await writeFile(
        path.join(projectExtensionsRoot, "b-ext", "manifest.json"),
        `${JSON.stringify(
          {
            name: "b-ext",
            version: "1.0.0",
            entry: "./index.js",
            capabilities: ["schema"],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await writeFile(
        path.join(projectExtensionsRoot, "b-ext", "index.js"),
        [
          "export default {",
          "  activate(api) {",
          "    api.registerMigration({ id: 'applied-migrate', status: 'APPLIED' });",
          "    api.registerMigration({ id: 'bbb-migrate' });",
          "    api.registerMigration({ id: 'failed-migrate', status: 'FAILED', error: 'checksum_mismatch' });",
          "  },",
          "};",
          "",
        ].join("\n"),
        "utf8",
      );

      const health = await runHealth({ path: context.pmPath });
      expect(health.ok).toBe(false);
      expect(health.warnings).toEqual([
        "extension_migration_failed:project:b-ext:failed-migrate",
        "extension_migration_pending:global:global-migration-ext:global-migrate",
        "extension_migration_pending:project:a-ext:migration-002",
        "extension_migration_pending:project:a-ext:zzz-migrate",
        "extension_migration_pending:project:b-ext:bbb-migrate",
      ]);

      const extensionCheck = health.checks.find((check) => check.name === "extensions");
      expect(extensionCheck?.status).toBe("warn");
      expect(extensionCheck?.details).toMatchObject({
        warnings: [
          "extension_migration_failed:project:b-ext:failed-migrate",
          "extension_migration_pending:global:global-migration-ext:global-migrate",
          "extension_migration_pending:project:a-ext:migration-002",
          "extension_migration_pending:project:a-ext:zzz-migrate",
          "extension_migration_pending:project:b-ext:bbb-migrate",
        ],
        activation: {
          migration_status: {
            applied_count: 1,
            pending_count: 4,
            failed_count: 1,
            applied: [
              {
                layer: "project",
                name: "b-ext",
                id: "applied-migrate",
                status: "applied",
              },
            ],
            pending: [
              {
                layer: "global",
                name: "global-migration-ext",
                id: "global-migrate",
                status: "pending",
              },
              {
                layer: "project",
                name: "a-ext",
                id: "migration-002",
                status: "pending",
              },
              {
                layer: "project",
                name: "a-ext",
                id: "zzz-migrate",
                status: "pending",
              },
              {
                layer: "project",
                name: "b-ext",
                id: "bbb-migrate",
                status: "pending",
              },
            ],
            failed: [
              {
                layer: "project",
                name: "b-ext",
                id: "failed-migrate",
                status: "failed",
                reason: "checksum_mismatch",
              },
            ],
          },
        },
      });
    });
  });

  it("normalizes blank migration metadata and falls back to message reason", async () => {
    await withTempPmPath(async (context) => {
      const projectExtensionsRoot = path.join(context.pmPath, "extensions");

      await mkdir(path.join(projectExtensionsRoot, "fallback-ext"), { recursive: true });
      await writeFile(
        path.join(projectExtensionsRoot, "fallback-ext", "manifest.json"),
        `${JSON.stringify(
          {
            name: "fallback-ext",
            version: "1.0.0",
            entry: "./index.js",
            capabilities: ["schema"],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await writeFile(
        path.join(projectExtensionsRoot, "fallback-ext", "index.js"),
        [
          "export default {",
          "  activate(api) {",
          "    api.registerMigration({ id: '   ' });",
          "    api.registerMigration({ id: 'failed-message', status: 'failed', reason: '   ', error: '   ', message: 'message_only' });",
          "  },",
          "};",
          "",
        ].join("\n"),
        "utf8",
      );

      const health = await runHealth({ path: context.pmPath });
      expect(health.warnings).toEqual([
        "extension_migration_failed:project:fallback-ext:failed-message",
        "extension_migration_pending:project:fallback-ext:migration-001",
      ]);

      const extensionCheck = health.checks.find((check) => check.name === "extensions");
      expect(extensionCheck?.details).toMatchObject({
        activation: {
          migration_status: {
            pending_count: 1,
            failed_count: 1,
            pending: [
              {
                layer: "project",
                name: "fallback-ext",
                id: "migration-001",
                status: "pending",
              },
            ],
            failed: [
              {
                layer: "project",
                name: "fallback-ext",
                id: "failed-message",
                status: "failed",
                reason: "message_only",
              },
            ],
          },
        },
      });
    });
  });

  it("reports extension manifest issues and respects --no-extensions", async () => {
    await withTempPmPath(async (context) => {
      const projectExtensionsRoot = path.join(context.pmPath, "extensions");
      const globalExtensionsRoot = path.join(context.env.PM_GLOBAL_PATH as string, "extensions");

      await mkdir(path.join(projectExtensionsRoot, "broken-manifest"), { recursive: true });
      await writeFile(path.join(projectExtensionsRoot, "broken-manifest", "manifest.json"), "{not-json", "utf8");
      await mkdir(path.join(projectExtensionsRoot, "invalid-entry"), { recursive: true });
      await writeFile(
        path.join(projectExtensionsRoot, "invalid-entry", "manifest.json"),
        `${JSON.stringify(
          {
            name: "invalid-entry-ext",
            version: "0.1.0",
            entry: "",
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await mkdir(path.join(projectExtensionsRoot, "invalid-name"), { recursive: true });
      await writeFile(
        path.join(projectExtensionsRoot, "invalid-name", "manifest.json"),
        `${JSON.stringify(
          {
            name: "",
            version: "0.1.0",
            entry: "./index.js",
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await mkdir(path.join(projectExtensionsRoot, "invalid-version"), { recursive: true });
      await writeFile(
        path.join(projectExtensionsRoot, "invalid-version", "manifest.json"),
        `${JSON.stringify(
          {
            name: "invalid-version-ext",
            version: "",
            entry: "./index.js",
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await mkdir(path.join(projectExtensionsRoot, "missing-manifest"), { recursive: true });
      await mkdir(path.join(projectExtensionsRoot, "missing-entry"), { recursive: true });
      await writeFile(
        path.join(projectExtensionsRoot, "missing-entry", "manifest.json"),
        `${JSON.stringify(
          {
            name: "project-missing-entry",
            version: "0.1.0",
            entry: "./dist/index.js",
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await mkdir(path.join(projectExtensionsRoot, "non-object"), { recursive: true });
      await writeFile(path.join(projectExtensionsRoot, "non-object", "manifest.json"), '"not-an-object"\n', "utf8");
      await mkdir(path.join(projectExtensionsRoot, "outside-entry"), { recursive: true });
      await writeFile(
        path.join(projectExtensionsRoot, "outside-entry", "manifest.json"),
        `${JSON.stringify(
          {
            name: "outside-entry-ext",
            version: "0.1.0",
            entry: "../outside-target.js",
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await writeFile(path.join(context.pmPath, "outside-target.js"), "export default {};\n", "utf8");

      await mkdir(path.join(globalExtensionsRoot, "global-valid"), { recursive: true });
      await writeFile(
        path.join(globalExtensionsRoot, "global-valid", "manifest.json"),
        `${JSON.stringify(
          {
            name: "global-valid-ext",
            version: "1.0.0",
            entry: "./index.js",
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await writeFile(path.join(globalExtensionsRoot, "global-valid", "index.js"), "export default {};\n", "utf8");

      const settingsPath = path.join(context.pmPath, "settings.json");
      const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
        extensions: {
          enabled: string[];
          disabled: string[];
        };
      };
      settings.extensions.enabled = [" zed ", "alpha", "alpha"];
      settings.extensions.disabled = ["gamma", " beta "];
      await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

      const health = await runHealth({ path: context.pmPath });
      expect(health.ok).toBe(false);
      expect(health.warnings).toEqual([
        "extension_manifest_invalid:project:broken-manifest",
        "extension_manifest_invalid:project:invalid-entry",
        "extension_manifest_invalid:project:invalid-name",
        "extension_manifest_invalid:project:invalid-version",
        "extension_entry_missing:project:project-missing-entry",
        "extension_manifest_missing:project:missing-manifest",
        "extension_manifest_invalid:project:non-object",
        "extension_entry_outside_extension:project:outside-entry-ext",
      ]);

      const extensionCheck = health.checks.find((check) => check.name === "extensions");
      expect(extensionCheck?.status).toBe("warn");
      expect(extensionCheck?.details).toMatchObject({
        disabled_by_flag: false,
        configured_enabled: ["alpha", "zed"],
        configured_disabled: ["beta", "gamma"],
        warnings: [
          "extension_manifest_invalid:project:broken-manifest",
          "extension_manifest_invalid:project:invalid-entry",
          "extension_manifest_invalid:project:invalid-name",
          "extension_manifest_invalid:project:invalid-version",
          "extension_entry_missing:project:project-missing-entry",
          "extension_manifest_missing:project:missing-manifest",
          "extension_manifest_invalid:project:non-object",
          "extension_entry_outside_extension:project:outside-entry-ext",
        ],
      });
      const filteredLoaded = (extensionCheck?.details as { loaded?: Array<{ name: string }> }).loaded ?? [];
      expect(filteredLoaded.map((entry) => entry.name)).toEqual([]);

      const discovered = (extensionCheck?.details as { discovered?: Array<{ name: string | null }> }).discovered ?? [];
      expect(discovered.map((entry) => entry.name)).toEqual([
        "global-valid-ext",
        null,
        null,
        null,
        null,
        "project-missing-entry",
        null,
        null,
        "outside-entry-ext",
      ]);

      const skipped = await runHealth({ path: context.pmPath, noExtensions: true });
      expect(skipped.ok).toBe(true);
      expect(skipped.warnings).toEqual([]);
      const skippedCheck = skipped.checks.find((check) => check.name === "extensions");
      expect(skippedCheck?.status).toBe("ok");
      expect(skippedCheck?.details).toMatchObject({
        disabled_by_flag: true,
        discovered: [],
        loaded: [],
        warnings: [],
      });
    });
  });

  it("reports extension hook warnings from health read-path dispatch", async () => {
    await withTempPmPath(async (context) => {
      const firstSeedId = createSeedItem(context);
      const secondSeedId = createSeedItem(context);
      const events: string[] = [];
      setActiveExtensionHooks({
        beforeCommand: [],
        afterCommand: [],
        onWrite: [],
        onRead: [
          {
            layer: "project",
            name: "boom-read-hook",
            run: () => {
              throw new Error("boom-read");
            },
          },
          {
            layer: "project",
            name: "ok-read-hook",
            run: (hookContext) => {
              events.push(path.basename(hookContext.path));
            },
          },
        ],
        onIndex: [],
      });

      const health = await runHealth({ path: context.pmPath });
      expect(health.ok).toBe(false);
      expect(health.warnings).toContain("extension_hook_failed:project:boom-read-hook:onRead");
      expect(events).toContain("history");
      const expectedHistoryEvents = [firstSeedId, secondSeedId]
        .sort((left, right) => left.localeCompare(right))
        .map((id) => `${id}.jsonl`);
      const historyStreamEvents = events.filter((event) => event.endsWith(".jsonl"));
      expect(historyStreamEvents).toEqual(expectedHistoryEvents);
    });
  });
});
