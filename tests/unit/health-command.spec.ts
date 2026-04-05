import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runHealth } from "../../src/cli/commands/health.js";
import { clearActiveExtensionHooks, setActiveExtensionHooks } from "../../src/core/extensions/index.js";
import { EXIT_CODE } from "../../src/constants.js";
import { readSettings, writeSettings } from "../../src/settings.js";
import { withTempPmPath, type TempPmContext } from "../helpers/withTempPmPath.js";

const initialDisableAutoDefaults = process.env.PM_DISABLE_OLLAMA_AUTO_DEFAULTS;

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
  beforeEach(() => {
    process.env.PM_DISABLE_OLLAMA_AUTO_DEFAULTS = "1";
  });

  afterEach(() => {
    clearActiveExtensionHooks();
    if (initialDisableAutoDefaults === undefined) {
      delete process.env.PM_DISABLE_OLLAMA_AUTO_DEFAULTS;
    } else {
      process.env.PM_DISABLE_OLLAMA_AUTO_DEFAULTS = initialDisableAutoDefaults;
    }
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
        "integrity",
        "history_drift",
        "vectorization",
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
        triage: {
          status: "ok",
          warning_count: 0,
          load_failure_count: 0,
          activation_failure_count: 0,
        },
      });
      expect(extensionCheck?.details).toMatchObject({
        activation: {
          managed_extensions: {
            project: {
              count: 0,
              entries: [],
            },
            global: {
              count: 0,
              entries: [],
            },
          },
        },
      });
      const defaultLoaded = (
        extensionCheck?.details as { loaded?: Array<{ name: string; has_activate: boolean; module?: unknown }> }
      ).loaded ?? [];
      expect(defaultLoaded).toEqual([]);
      expect(defaultLoaded.every((entry) => !("module" in entry))).toBe(true);

      const storageCheck = health.checks.find((check) => check.name === "storage");
      expect(storageCheck?.details).toEqual({
        items: 1,
        history_streams: 1,
      });

      const historyDriftCheck = health.checks.find((check) => check.name === "history_drift");
      expect(historyDriftCheck?.status).toBe("ok");
      expect(historyDriftCheck?.details).toMatchObject({
        checked_items: 1,
        drifted_items: [],
        counts: {
          drifted: 0,
          missing_streams: 0,
          unreadable_streams: 0,
          hash_mismatches: 0,
        },
      });

      const vectorizationCheck = health.checks.find((check) => check.name === "vectorization");
      expect(vectorizationCheck?.status).toBe("ok");
      expect(vectorizationCheck?.details).toMatchObject({
        semantic_runtime_available: false,
        stale_items_before: [],
        stale_items_after: [],
      });

      const integrityCheck = health.checks.find((check) => check.name === "integrity");
      expect(integrityCheck?.status).toBe("ok");
      expect(integrityCheck?.details).toMatchObject({
        counts: {
          item_unreadable: 0,
          item_conflict_markers: 0,
          item_parse_failures: 0,
          history_unreadable: 0,
          history_conflict_markers: 0,
          history_invalid_json: 0,
        },
      });
      expect(health.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  it("detects missing unreadable and hash-mismatched history drift", async () => {
    await withTempPmPath(async (context) => {
      const missingId = createSeedItem(context);
      const unreadableId = createSeedItem(context);
      const mismatchId = createSeedItem(context);

      await rm(path.join(context.pmPath, "history", `${missingId}.jsonl`), { force: true });
      await writeFile(path.join(context.pmPath, "history", `${unreadableId}.jsonl`), "not-json\n", "utf8");

      const mismatchPath = path.join(context.pmPath, "history", `${mismatchId}.jsonl`);
      const mismatchRaw = await readFile(mismatchPath, "utf8");
      const mismatchLines = mismatchRaw.trim().split(/\r?\n/);
      const lastEntry = JSON.parse(mismatchLines[mismatchLines.length - 1]) as { after_hash: string };
      lastEntry.after_hash = "corrupted-after-hash";
      mismatchLines[mismatchLines.length - 1] = JSON.stringify(lastEntry);
      await writeFile(mismatchPath, `${mismatchLines.join("\n")}\n`, "utf8");

      const health = await runHealth({ path: context.pmPath });
      expect(health.ok).toBe(false);
      expect(health.warnings).toEqual(
        expect.arrayContaining([
          `history_drift_missing_stream:${missingId}`,
          `history_drift_unreadable_stream:${unreadableId}`,
          `history_drift_hash_mismatch:${mismatchId}`,
        ]),
      );

      const historyDriftCheck = health.checks.find((check) => check.name === "history_drift");
      expect(historyDriftCheck?.status).toBe("warn");
      expect(historyDriftCheck?.details).toMatchObject({
        checked_items: 3,
        drifted_items: [mismatchId, missingId, unreadableId].sort((left, right) => left.localeCompare(right)),
        missing_streams: [missingId],
        unreadable_streams: [unreadableId],
        hash_mismatches: [mismatchId],
      });
    });
  });

  it("reports integrity conflict-marker diagnostics for item and history files", async () => {
    await withTempPmPath(async (context) => {
      const itemConflictId = createSeedItem(context);
      const historyConflictId = createSeedItem(context);

      const markdownItemPath = path.join(context.pmPath, "tasks", `${itemConflictId}.md`);
      const toonItemPath = path.join(context.pmPath, "tasks", `${itemConflictId}.toon`);
      let itemPath = markdownItemPath;
      try {
        await access(itemPath);
      } catch {
        itemPath = toonItemPath;
      }
      await writeFile(itemPath, "<<<<<<< HEAD\n{}\n=======\n{}\n>>>>>>> branch\n", "utf8");
      await writeFile(
        path.join(context.pmPath, "history", `${historyConflictId}.jsonl`),
        "<<<<<<< HEAD\n{}\n=======\n{}\n>>>>>>> branch\n",
        "utf8",
      );

      const health = await runHealth({ path: context.pmPath });
      expect(health.ok).toBe(false);
      const relativeItemPath = path.relative(context.pmPath, itemPath).replaceAll("\\", "/");
      expect(health.warnings).toEqual(
        expect.arrayContaining([
          `integrity_item_conflict_marker:${relativeItemPath}:L1`,
          `integrity_history_conflict_marker:${historyConflictId}:L1`,
        ]),
      );

      const integrityCheck = health.checks.find((check) => check.name === "integrity");
      expect(integrityCheck?.status).toBe("warn");
      expect(integrityCheck?.details).toMatchObject({
        counts: {
          item_conflict_markers: 1,
          history_conflict_markers: 1,
        },
      });
    });
  });

  it("reports integrity unreadable and parse-failure diagnostics", async () => {
    await withTempPmPath(async (context) => {
      createSeedItem(context);

      await mkdir(path.join(context.pmPath, "tasks", "integrity-unreadable.md"), { recursive: true });
      await writeFile(path.join(context.pmPath, "tasks", "integrity-parse-failure.md"), "{ invalid-json", "utf8");
      await mkdir(path.join(context.pmPath, "history", "integrity-unreadable.jsonl"), { recursive: true });

      const health = await runHealth({ path: context.pmPath });
      expect(health.ok).toBe(false);
      expect(health.warnings).toEqual(
        expect.arrayContaining([
          "integrity_item_unreadable:tasks/integrity-unreadable.md",
          "integrity_item_parse_failed:tasks/integrity-parse-failure.md",
          "integrity_history_unreadable:integrity-unreadable",
        ]),
      );

      const integrityCheck = health.checks.find((check) => check.name === "integrity");
      expect(integrityCheck?.status).toBe("warn");
      expect(integrityCheck?.details).toMatchObject({
        counts: {
          item_unreadable: 1,
          item_parse_failures: 1,
          history_unreadable: 1,
        },
      });
    });
  });

  it("fails in strict mode when required history streams are missing", async () => {
    await withTempPmPath(async (context) => {
      const missingId = createSeedItem(context);
      const settings = await readSettings(context.pmPath);
      settings.history.missing_stream = "strict_error";
      await writeSettings(context.pmPath, settings);
      await rm(path.join(context.pmPath, "history", `${missingId}.jsonl`), { force: true });

      await expect(runHealth({ path: context.pmPath })).rejects.toMatchObject({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
    });
  });

  it("auto-refreshes stale vectorization entries through targeted semantic refresh", async () => {
    await withTempPmPath(async (context) => {
      const itemId = createSeedItem(context);
      const settings = await readSettings(context.pmPath);
      settings.providers.openai.base_url = "https://api.example.test/v1";
      settings.providers.openai.model = "text-embedding-3-small";
      settings.vector_store.qdrant.url = "https://qdrant.example.test:6333";
      await writeSettings(context.pmPath, settings);

      const originalFetch = globalThis.fetch;
      const fetchCalls: string[] = [];
      globalThis.fetch = (async (url: unknown) => {
        const target = String(url);
        fetchCalls.push(target);
        if (target.endsWith("/v1/embeddings")) {
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => ({ data: [{ index: 0, embedding: [0.1, 0.2] }] }),
            text: async () => "",
          } as unknown as Response;
        }
        if (target.endsWith("/collections/pm_items/points?wait=true")) {
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => ({ result: { status: "acknowledged" } }),
            text: async () => "",
          } as unknown as Response;
        }
        throw new Error(`Unexpected fetch target: ${target}`);
      }) as typeof globalThis.fetch;

      try {
        const health = await runHealth({ path: context.pmPath });
        expect(health.ok).toBe(true);
        expect(health.warnings).toEqual([]);

        const vectorizationCheck = health.checks.find((check) => check.name === "vectorization");
        expect(vectorizationCheck?.status).toBe("ok");
        expect(vectorizationCheck?.details).toMatchObject({
          semantic_runtime_available: true,
          stale_items_before: [itemId],
          refresh_attempted: true,
          stale_items_after: [],
          refresh_result: {
            refreshed: [itemId],
            skipped: [],
            warnings: [],
          },
        });
        expect(fetchCalls).toEqual([
          "https://api.example.test/v1/embeddings",
          "https://qdrant.example.test:6333/collections/pm_items/points?wait=true",
        ]);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  it("warns when targeted vectorization refresh fails and stale items remain", async () => {
    await withTempPmPath(async (context) => {
      const itemId = createSeedItem(context);
      const settings = await readSettings(context.pmPath);
      settings.providers.openai.base_url = "https://api.example.test/v1";
      settings.providers.openai.model = "text-embedding-3-small";
      settings.vector_store.qdrant.url = "https://qdrant.example.test:6333";
      await writeSettings(context.pmPath, settings);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () => ({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        json: async () => ({}),
        text: async () => "embedding unavailable",
      })) as typeof globalThis.fetch;

      try {
        const health = await runHealth({ path: context.pmPath });
        expect(health.ok).toBe(false);
        expect(health.warnings).toEqual(expect.arrayContaining([`vectorization_stale_items_remaining:1`]));

        const vectorizationCheck = health.checks.find((check) => check.name === "vectorization");
        expect(vectorizationCheck?.status).toBe("warn");
        expect(vectorizationCheck?.details).toMatchObject({
          semantic_runtime_available: true,
          stale_items_before: [itemId],
          stale_items_after: [itemId],
        });
      } finally {
        globalThis.fetch = originalFetch;
      }
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

  it("treats missing optional type directories as informational by default", async () => {
    await withTempPmPath(async (context) => {
      await rm(path.join(context.pmPath, "events"), { recursive: true, force: true });
      await rm(path.join(context.pmPath, "reminders"), { recursive: true, force: true });
      await rm(path.join(context.pmPath, "milestones"), { recursive: true, force: true });
      await rm(path.join(context.pmPath, "meetings"), { recursive: true, force: true });

      const health = await runHealth({ path: context.pmPath });
      expect(health.ok).toBe(true);
      expect(health.warnings).toEqual([]);

      const directoriesCheck = health.checks.find((check) => check.name === "directories");
      expect(directoriesCheck?.status).toBe("ok");
      expect(directoriesCheck?.details).toMatchObject({
        missing: [],
        missing_optional: ["events", "meetings", "milestones", "reminders"],
        strict_directories: false,
      });
    });
  });

  it("fails on missing optional directories when strict mode is enabled", async () => {
    await withTempPmPath(async (context) => {
      await rm(path.join(context.pmPath, "events"), { recursive: true, force: true });
      await rm(path.join(context.pmPath, "reminders"), { recursive: true, force: true });
      await rm(path.join(context.pmPath, "milestones"), { recursive: true, force: true });
      await rm(path.join(context.pmPath, "meetings"), { recursive: true, force: true });

      const health = await runHealth({ path: context.pmPath }, { strictDirectories: true });
      expect(health.ok).toBe(false);
      expect(health.warnings).toEqual([
        "missing_directory:events",
        "missing_directory:meetings",
        "missing_directory:milestones",
        "missing_directory:reminders",
      ]);

      const directoriesCheck = health.checks.find((check) => check.name === "directories");
      expect(directoriesCheck?.status).toBe("warn");
      expect(directoriesCheck?.details).toMatchObject({
        missing: ["events", "meetings", "milestones", "reminders"],
        missing_optional: ["events", "meetings", "milestones", "reminders"],
        strict_directories: true,
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
      expect(health.warnings).toEqual([
        "extension_load_failed:project:boom-ext",
        "extension_update_health_partial_coverage:skipped_unmanaged:2",
      ]);

      const extensionCheck = health.checks.find((check) => check.name === "extensions");
      expect(extensionCheck?.status).toBe("warn");
      expect(extensionCheck?.details).toMatchObject({
        disabled_by_flag: false,
        warnings: [
          "extension_load_failed:project:boom-ext",
          "extension_update_health_partial_coverage:skipped_unmanaged:2",
        ],
        failed: [
          expect.objectContaining({
            layer: "project",
            name: "boom-ext",
          }),
        ],
        triage: {
          status: "warn",
          warning_count: 2,
          load_failure_count: 1,
          activation_failure_count: 0,
        },
      });

      const loaded = (
        extensionCheck?.details as { loaded?: Array<{ name: string; has_activate: boolean; module?: unknown }> }
      ).loaded ?? [];
      expect(loaded).toEqual([
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
      expect(health.warnings).toEqual([
        "extension_activate_failed:project:activate-boom-ext",
        "extension_update_health_partial_coverage:skipped_unmanaged:2",
      ]);

      const extensionCheck = health.checks.find((check) => check.name === "extensions");
      expect(extensionCheck?.status).toBe("warn");
      expect(extensionCheck?.details).toMatchObject({
        disabled_by_flag: false,
        failed: [],
        warnings: [
          "extension_activate_failed:project:activate-boom-ext",
          "extension_update_health_partial_coverage:skipped_unmanaged:2",
        ],
        triage: {
          status: "warn",
          warning_count: 2,
          load_failure_count: 0,
          activation_failure_count: 1,
        },
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
          command_handler_count: 0,
          renderer_override_count: 0,
        },
      });

      const loaded = (extensionCheck?.details as { loaded?: Array<{ name: string }> }).loaded ?? [];
      expect(loaded.map((entry) => entry.name)).toEqual([
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
        "extension_update_health_partial_coverage:skipped_unmanaged:3",
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
          "extension_update_health_partial_coverage:skipped_unmanaged:3",
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

  it("includes allowed capability guidance and nearest-match suggestions for unknown capabilities", async () => {
    await withTempPmPath(async (context) => {
      const projectExtensionsRoot = path.join(context.pmPath, "extensions");
      await mkdir(path.join(projectExtensionsRoot, "unknown-capability"), { recursive: true });
      await writeFile(
        path.join(projectExtensionsRoot, "unknown-capability", "manifest.json"),
        `${JSON.stringify(
          {
            name: "unknown-capability-ext",
            version: "1.0.0",
            entry: "./index.js",
            capabilities: ["service"],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await writeFile(path.join(projectExtensionsRoot, "unknown-capability", "index.js"), "export default { activate() {} };\n", "utf8");

      const health = await runHealth({ path: context.pmPath });
      expect(health.ok).toBe(false);
      const capabilityWarning = health.warnings.find((warning) =>
        warning.startsWith("extension_capability_unknown:project:unknown-capability-ext:service"),
      );
      expect(capabilityWarning).toBeDefined();
      expect(capabilityWarning).toContain("allowed=commands,renderers,hooks,schema,importers,search,parser,preflight,services");
      expect(capabilityWarning).toContain("suggested=services");

      const extensionCheck = health.checks.find((check) => check.name === "extensions");
      const details = extensionCheck?.details as {
        capability_guidance?: Array<Record<string, unknown>>;
        triage?: { unknown_capability_count?: number; remediation?: string[] };
      };
      expect(details.capability_guidance).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            layer: "project",
            name: "unknown-capability-ext",
            capability: "service",
            suggested_capability: "services",
          }),
        ]),
      );
      expect((details.capability_guidance?.[0]?.allowed_capabilities as string[]) ?? []).toContain("services");
      expect(details.triage?.unknown_capability_count).toBeGreaterThanOrEqual(1);
      expect((details.triage?.remediation ?? []).some((entry) => entry.includes("Allowed capabilities"))).toBe(true);
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
        "extension_update_health_partial_coverage:skipped_unmanaged:1",
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
