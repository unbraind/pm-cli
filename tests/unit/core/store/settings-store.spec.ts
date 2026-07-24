import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearActiveExtensionHooks, setActiveExtensionHooks } from "../../../../src/core/extensions/index.js";
import type { ExtensionHookRegistry } from "../../../../src/core/extensions/loader.js";
import { normalizeRuntimeSchemaSettings } from "../../../../src/core/schema/runtime-schema.js";
import { DEFAULT_STATUS_DEFINITIONS, SETTINGS_DEFAULTS } from "../../../../src/core/shared/constants.js";
import { getSettingsPath } from "../../../../src/core/store/paths.js";
import {
  clearSettingsReadCache,
  collectSettingsReadCacheSignatures,
  getSettingsReadCacheEntry,
  setSettingsReadCacheEntry,
  settingsReadCacheSignaturesEqual,
} from "../../../../src/core/store/settings-read-cache.js";
import {
  readSettings,
  readSettingsWithMetadata,
  resolveGovernanceKnobs,
  serializeSettings,
  settingsStoreTestOnly,
  writeSettings,
} from "../../../../src/core/store/settings.js";
import { withTempRoot } from "../../../helpers/temp.js";

async function withTempPmRoot(run: (pmRoot: string) => Promise<void>): Promise<void> {
  await withTempRoot("pm-cli-settings-test-", async (tempRoot) => {
    await run(path.join(tempRoot, ".agents", "pm"));
  });
}

/**
 * Base legacy settings JSON shared by the merge/explicitness specs. The block
 * deliberately omits later-added keys (e.g. `workflow`, `item_format`) so each
 * test can express only the scenario field under test via `overrides`. Keys can
 * be added through `overrides`; the object is serialized with `JSON.stringify`,
 * so the base never carries fields a given test means to leave absent.
 */
function legacySettingsFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    id_prefix: "pm-",
    author_default: "legacy",
    locks: { ttl_seconds: 1800 },
    output: { default_format: "toon" },
    extensions: { enabled: [], disabled: [] },
    search: {
      score_threshold: 0,
      hybrid_semantic_weight: 0.7,
      max_results: 50,
      embedding_model: "",
      embedding_batch_size: 32,
      scanner_max_batch_retries: 3,
    },
    providers: {
      openai: { base_url: "", api_key: "", model: "" },
      ollama: { base_url: "", model: "" },
    },
    vector_store: {
      qdrant: { url: "", api_key: "" },
      lancedb: { path: "" },
    },
    ...overrides,
  };
}

/** Write a legacy settings JSON fixture (see `legacySettingsFixture`) to `pmRoot`. */
async function writeLegacySettings(pmRoot: string, overrides: Record<string, unknown> = {}): Promise<void> {
  const settingsPath = getSettingsPath(pmRoot);
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, JSON.stringify(legacySettingsFixture(overrides)), "utf8");
}

function expectOrderedObjectKeys(value: unknown, expectedKeys: string[]): void {
  expect(value).toBeTypeOf("object");
  expect(value).not.toBeNull();
  expect(Object.keys(value as Record<string, unknown>)).toEqual(expectedKeys);
}

describe("core/store/settings", () => {
  afterEach(() => {
    clearActiveExtensionHooks();
    clearSettingsReadCache();
  });

  it("returns cloned defaults when settings file is missing", async () => {
    await withTempPmRoot(async (pmRoot) => {
      const settings = await readSettings(pmRoot);
      expect(settings).toEqual(SETTINGS_DEFAULTS);
      expect(settings).not.toBe(SETTINGS_DEFAULTS);
      const metadataRead = await readSettingsWithMetadata(pmRoot);
      expect(metadataRead.warnings).toEqual([]);
    });
  });

  it("falls back to defaults when settings JSON is invalid", async () => {
    await withTempPmRoot(async (pmRoot) => {
      const settingsPath = getSettingsPath(pmRoot);
      await fs.mkdir(path.dirname(settingsPath), { recursive: true });
      await fs.writeFile(settingsPath, "{ invalid-json", "utf8");

      const settings = await readSettings(pmRoot);
      expect(settings).toEqual(SETTINGS_DEFAULTS);
      const metadataRead = await readSettingsWithMetadata(pmRoot);
      expect(metadataRead.settings).toEqual(SETTINGS_DEFAULTS);
      expect(metadataRead.warnings).toEqual(["settings_read_invalid_json"]);
    });
  });

  it("falls back and recovers when settings.json cannot be read as a file", async () => {
    await withTempPmRoot(async (pmRoot) => {
      const settingsPath = getSettingsPath(pmRoot);
      await fs.mkdir(settingsPath, { recursive: true });

      const unreadable = await readSettingsWithMetadata(pmRoot);
      expect(unreadable.settings).toEqual(SETTINGS_DEFAULTS);
      expect(unreadable.warnings).toEqual(["settings_read_fs_error"]);
      expect(getSettingsReadCacheEntry(pmRoot)).toBeUndefined();
      expect((await readSettingsWithMetadata(pmRoot)).warnings).toEqual([
        "settings_read_fs_error",
      ]);
      expect(getSettingsReadCacheEntry(pmRoot)).toBeUndefined();

      await fs.rmdir(settingsPath);
      await writeLegacySettings(pmRoot, { author_default: "recovered" });

      const recovered = await readSettingsWithMetadata(pmRoot);
      expect(recovered.settings.author_default).toBe("recovered");
      expect(recovered.warnings).not.toContain("settings_read_fs_error");
      expect((await readSettingsWithMetadata(pmRoot)).warnings).toEqual([]);
    });
  });

  it("falls back to defaults when settings object fails schema validation", async () => {
    await withTempPmRoot(async (pmRoot) => {
      const settingsPath = getSettingsPath(pmRoot);
      await fs.mkdir(path.dirname(settingsPath), { recursive: true });
      await fs.writeFile(settingsPath, JSON.stringify({ version: 1 }), "utf8");

      const settings = await readSettings(pmRoot);
      expect(settings).toEqual(SETTINGS_DEFAULTS);
      const metadataRead = await readSettingsWithMetadata(pmRoot);
      expect(metadataRead.settings).toEqual(SETTINGS_DEFAULTS);
      expect(metadataRead.warnings).toEqual(["settings_read_invalid_schema"]);
    });
  });

  it("round-trips ids.token_length and rejects out-of-range values (pm-pibw)", async () => {
    await withTempPmRoot(async (pmRoot) => {
      await writeLegacySettings(pmRoot, { ids: { token_length: 6 } });
      expect((await readSettings(pmRoot)).ids.token_length).toBe(6);
      clearSettingsReadCache();

      await writeLegacySettings(pmRoot, { ids: { token_length: 13 } });
      const tooLong = await readSettingsWithMetadata(pmRoot);
      expect(tooLong.settings.ids.token_length).toBe(4);
      expect(tooLong.warnings).toEqual(["settings_read_invalid_schema"]);
      clearSettingsReadCache();

      await writeLegacySettings(pmRoot, { ids: { token_length: 3 } });
      const tooShort = await readSettingsWithMetadata(pmRoot);
      expect(tooShort.settings.ids.token_length).toBe(4);
      expect(tooShort.warnings).toEqual(["settings_read_invalid_schema"]);
    });
  });

  it("merges defaults when legacy settings omit workflow block", async () => {
    await withTempPmRoot(async (pmRoot) => {
      // Base fixture omits the workflow block; defaults should be merged in.
      await writeLegacySettings(pmRoot);

      const settings = await readSettings(pmRoot);
      expect(settings.author_default).toBe("legacy");
      expect(settings.workflow.definition_of_done).toEqual([]);
    });
  });

  it("writes deterministic settings content and reads it back", async () => {
    await withTempPmRoot(async (pmRoot) => {
      const custom = structuredClone(SETTINGS_DEFAULTS);
      custom.id_prefix = "zz-";
      custom.ids.token_length = 6;
      custom.author_default = "settings-author";
      custom.validation.parent_reference = "strict_error";
      custom.search.max_results = 12;
      custom.search.hybrid_semantic_weight = 0.25;
      custom.extensions.enabled = ["ext-a"];
      custom.extensions.disabled = ["ext-b"];
      custom.providers.ollama.base_url = "http://localhost:11434";
      custom.vector_store.lancedb.path = ".agents/pm/vector";

      await writeSettings(pmRoot, custom);

      const settingsPath = getSettingsPath(pmRoot);
      const raw = await fs.readFile(settingsPath, "utf8");
      expect(raw.endsWith("\n")).toBe(true);
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      expectOrderedObjectKeys(parsed, [
        "version",
        "id_prefix",
        "ids",
        "author_default",
        "mutation_guard",
        "item_format",
        "locks",
        "checkpoints",
        "output",
        "history",
        "validation",
        "governance",
        "workflow",
        "testing",
        "telemetry",
        "agent_guidance",
        "item_types",
        "schema",
        "context",
        "extensions",
        "search",
        "providers",
        "vector_store",
      ]);
      expectOrderedObjectKeys(parsed.locks, ["ttl_seconds", "wait_ms"]);
      expectOrderedObjectKeys(parsed.ids, ["token_length"]);
      expectOrderedObjectKeys(parsed.mutation_guard, [
        "require_attributed_author",
        "secret_guard",
        "stale_in_progress_hours",
      ]);
      expectOrderedObjectKeys(parsed.checkpoints, ["retention_days"]);
      expectOrderedObjectKeys(parsed.output, ["default_format"]);
      expectOrderedObjectKeys(parsed.history, ["missing_stream", "compact_policy"]);
      expectOrderedObjectKeys(parsed.validation, [
        "sprint_release_format",
        "parent_reference",
        "metadata_profile",
        "metadata_required_fields",
        "lifecycle_stale_blocker_reason_patterns",
        "lifecycle_closure_like_blocked_reason_patterns",
        "lifecycle_closure_like_resolution_patterns",
        "lifecycle_closure_like_actual_result_patterns",
        "estimate_defaults_by_type",
      ]);
      expectOrderedObjectKeys(parsed.governance, ["preset"]);
      expectOrderedObjectKeys(parsed.workflow, ["definition_of_done"]);
      expectOrderedObjectKeys(parsed.testing, ["record_results_to_items"]);
      expectOrderedObjectKeys(parsed.telemetry, [
        "enabled",
        "first_run_prompt_completed",
        "capture_level",
        "endpoint",
        "installation_id",
        "retention_days",
      ]);
      expectOrderedObjectKeys(parsed.agent_guidance, [
        "prompt_completed",
        "declined",
        "declined_at",
        "template_version",
        "last_checked_files",
      ]);
      expectOrderedObjectKeys(parsed.item_types, ["definitions"]);
      expectOrderedObjectKeys(parsed.schema, ["version", "files", "statuses", "fields", "workflow", "unknown_field_policy"]);
      expectOrderedObjectKeys(parsed.extensions, ["enabled", "disabled", "policy"]);
      expectOrderedObjectKeys((parsed.extensions as Record<string, unknown>).policy, [
        "mode",
        "trust_mode",
        "require_provenance",
        "trusted_extensions",
        "default_sandbox_profile",
        "allowed_extensions",
        "blocked_extensions",
        "allowed_capabilities",
        "blocked_capabilities",
        "allowed_surfaces",
        "blocked_surfaces",
        "allowed_commands",
        "blocked_commands",
        "allowed_actions",
        "blocked_actions",
        "allowed_services",
        "blocked_services",
        "extension_overrides",
      ]);
      expectOrderedObjectKeys(parsed.search, [
        "score_threshold",
        "hybrid_semantic_weight",
        "max_results",
        "embedding_model",
        "embedding_batch_size",
        "embedding_timeout_ms",
        "scanner_max_batch_retries",
        "provider",
        "mutation_refresh_policy",
        "query_expansion",
        "rerank",
      ]);
      expectOrderedObjectKeys((parsed.search as Record<string, unknown>).query_expansion, ["enabled", "provider"]);
      expectOrderedObjectKeys((parsed.search as Record<string, unknown>).rerank, ["enabled", "model", "top_k"]);

      const providers = parsed.providers as Record<string, unknown>;
      expectOrderedObjectKeys(providers, ["openai", "ollama"]);
      expectOrderedObjectKeys(providers.openai, ["base_url", "api_key", "model"]);
      expectOrderedObjectKeys(providers.ollama, ["base_url", "model"]);

      const vectorStore = parsed.vector_store as Record<string, unknown>;
      expectOrderedObjectKeys(vectorStore, ["adapter", "collection_name", "qdrant", "lancedb"]);
      expectOrderedObjectKeys(vectorStore.qdrant, ["url", "api_key"]);
      expectOrderedObjectKeys(vectorStore.lancedb, ["path"]);

      const loaded = await readSettings(pmRoot);
      expect(loaded).toMatchObject({
        ...custom,
        schema: expect.objectContaining({
          version: normalizeRuntimeSchemaSettings(custom.schema).version,
          unknown_field_policy: normalizeRuntimeSchemaSettings(custom.schema).unknown_field_policy,
        }),
      });
      expect(loaded.schema.statuses.map((definition) => definition.id)).toEqual(
        normalizeRuntimeSchemaSettings(custom.schema).statuses.map((definition) => definition.id),
      );
    });
  });

  it("preserves configured pm_max_version_exceeded_mode through deterministic settings writes", async () => {
    await withTempPmRoot(async (pmRoot) => {
      const settings = structuredClone(SETTINGS_DEFAULTS);
      settings.extensions.policy.pm_max_version_exceeded_mode = {
        global: "block",
        project: "warn",
      };

      await writeSettings(pmRoot, settings);

      const raw = await fs.readFile(getSettingsPath(pmRoot), "utf8");
      const parsed = JSON.parse(raw) as {
        extensions: {
          policy: Record<string, unknown>;
        };
      };
      expect(Object.keys(parsed.extensions.policy).slice(0, 4)).toEqual([
        "mode",
        "trust_mode",
        "pm_max_version_exceeded_mode",
        "require_provenance",
      ]);
      expect(parsed.extensions.policy.pm_max_version_exceeded_mode).toEqual({
        global: "block",
        project: "warn",
      });

      const loaded = await readSettings(pmRoot);
      expect(loaded.extensions.policy.pm_max_version_exceeded_mode).toEqual({
        global: "block",
        project: "warn",
      });
    });
  });

  it("keeps runtime schema file sections out of settings writes after read-time merges", async () => {
    await withTempPmRoot(async (pmRoot) => {
      // Legacy fixture omits schema/item_type blocks from persisted JSON.
      await writeLegacySettings(pmRoot, { workflow: { definition_of_done: [] } });

      // Initial read scaffolds schema files and attaches read-time persist source.
      await readSettings(pmRoot);
      const statusesPath = path.join(pmRoot, "schema", "statuses.json");
      const seededStatuses = [...structuredClone(DEFAULT_STATUS_DEFINITIONS), { id: "qa_ready", roles: ["active"] as const }];
      await fs.writeFile(statusesPath, `${JSON.stringify({ statuses: seededStatuses }, null, 2)}\n`, "utf8");

      const merged = await readSettings(pmRoot);
      expect(merged.schema.statuses.map((definition) => definition.id)).toContain("qa_ready");

      // Unrelated settings write should not copy merged file-backed sections.
      merged.telemetry.enabled = false;
      await writeSettings(pmRoot, merged);

      const persisted = JSON.parse(await fs.readFile(getSettingsPath(pmRoot), "utf8")) as Record<string, unknown>;
      const persistedSchema = (persisted.schema ?? {}) as Record<string, unknown>;
      expect(persistedSchema.statuses ?? []).toEqual([]);
      expect(persistedSchema.fields ?? []).toEqual([]);
      expect(Array.isArray(persistedSchema.type_workflows) ? persistedSchema.type_workflows : []).toEqual([]);

      // File edits remain authoritative after the write.
      await fs.writeFile(
        statusesPath,
        `${JSON.stringify({ statuses: structuredClone(DEFAULT_STATUS_DEFINITIONS) }, null, 2)}\n`,
        "utf8",
      );
      const afterRemoval = await readSettings(pmRoot);
      expect(afterRemoval.schema.statuses.map((definition) => definition.id)).not.toContain("qa_ready");
    });
  });

  it("reports whether item_format was explicitly selected in settings JSON", async () => {
    await withTempPmRoot(async (pmRoot) => {
      // Includes the workflow block but no item_format, so explicitness is false.
      await writeLegacySettings(pmRoot, { workflow: { definition_of_done: [] } });

      const legacyRead = await readSettingsWithMetadata(pmRoot);
      expect(legacyRead.settings.item_format).toBe("toon");
      expect(legacyRead.metadata.has_explicit_item_format).toBe(false);

      const settings = structuredClone(SETTINGS_DEFAULTS);
      settings.item_format = "toon";
      await writeSettings(pmRoot, settings);
      const explicitRead = await readSettingsWithMetadata(pmRoot);
      expect(explicitRead.settings.item_format).toBe("toon");
      expect(explicitRead.metadata.has_explicit_item_format).toBe(true);
    });
  });

  it("treats non-object settings payloads as lacking explicit item_format selection", async () => {
    await withTempPmRoot(async (pmRoot) => {
      const settingsPath = getSettingsPath(pmRoot);
      await fs.mkdir(path.dirname(settingsPath), { recursive: true });
      await fs.writeFile(settingsPath, "[]\n", "utf8");
      const loaded = await readSettingsWithMetadata(pmRoot);
      expect(loaded.metadata.has_explicit_item_format).toBe(false);
      expect(loaded.settings.item_format).toBe("toon");
    });
  });

  it("dispatches active onRead/onWrite hooks for settings read and write", async () => {
    await withTempPmRoot(async (pmRoot) => {
      const events: string[] = [];
      const hooks: ExtensionHookRegistry = {
        beforeCommand: [],
        afterCommand: [],
        onRead: [
          {
            layer: "project",
            name: "settings-read-hook",
            run: (context) => {
              events.push(`read:${path.basename(context.path)}`);
            },
          },
        ],
        onWrite: [
          {
            layer: "project",
            name: "settings-write-hook",
            run: (context) => {
              events.push(`write:${context.op}:${path.basename(context.path)}`);
            },
          },
        ],
        onIndex: [],
      };
      setActiveExtensionHooks(hooks);

      const settings = structuredClone(SETTINGS_DEFAULTS);
      settings.author_default = "hook-author";
      await writeSettings(pmRoot, settings);
      const loaded = await readSettings(pmRoot);

      expect(loaded.author_default).toBe("hook-author");
      expect(events).toContain("write:settings:write:settings.json");
      expect(events).toContain("read:settings.json");
    });
  });

  it("clears cached settings reads even when a settings write hook fails", async () => {
    await withTempPmRoot(async (pmRoot) => {
      const before = structuredClone(SETTINGS_DEFAULTS);
      before.author_default = "before-failing-hook";
      await writeSettings(pmRoot, before);
      expect((await readSettingsWithMetadata(pmRoot)).settings.author_default).toBe("before-failing-hook");

      setActiveExtensionHooks({
        beforeCommand: [],
        afterCommand: [],
        onRead: [],
        onWrite: [
          {
            layer: "project",
            name: "failing-settings-write-hook",
            run: () => {
              throw new Error("settings hook failed");
            },
          },
        ],
        onIndex: [],
      });

      const after = structuredClone(SETTINGS_DEFAULTS);
      after.author_default = "after-failing-hook";
      await writeSettings(pmRoot, after);
      clearActiveExtensionHooks();

      expect((await readSettingsWithMetadata(pmRoot)).settings.author_default).toBe("after-failing-hook");
    });
  });

  it("caches settings reads while still honoring onRead hooks and schema file invalidation", async () => {
    await withTempPmRoot(async (pmRoot) => {
      const events: string[] = [];
      const hooks: ExtensionHookRegistry = {
        beforeCommand: [],
        afterCommand: [],
        onRead: [
          {
            layer: "project",
            name: "cache-read-hook",
            run: (context) => {
              events.push(`read:${path.basename(context.path)}`);
            },
          },
        ],
        onWrite: [],
        onIndex: [],
      };
      setActiveExtensionHooks(hooks);

      await writeSettings(pmRoot, structuredClone(SETTINGS_DEFAULTS));

      const firstRead = await readSettingsWithMetadata(pmRoot);
      const secondRead = await readSettingsWithMetadata(pmRoot);
      expect(firstRead.settings.id_prefix).toBe("pm-");
      expect(secondRead.settings.id_prefix).toBe("pm-");
      expect(secondRead.settings).not.toBe(firstRead.settings);
      expect(events).toEqual(["read:settings.json", "read:settings.json"]);

      const statusesPath = path.join(pmRoot, "schema", "statuses.json");
      const statusesWithExtra = [...structuredClone(DEFAULT_STATUS_DEFINITIONS), { id: "qa_ready", roles: ["active"] as const }];
      await fs.writeFile(statusesPath, `${JSON.stringify({ statuses: statusesWithExtra }, null, 2)}\n`, "utf8");

      const thirdRead = await readSettingsWithMetadata(pmRoot);
      expect(thirdRead.settings.schema.statuses.map((definition) => definition.id)).toContain("qa_ready");

      const fourthRead = await readSettingsWithMetadata(pmRoot);
      expect(fourthRead.settings.schema.statuses.map((definition) => definition.id)).toContain("qa_ready");
      expect(events).toEqual(["read:settings.json", "read:settings.json", "read:settings.json", "read:settings.json"]);
    });
  });

  it("does not cache settings parsed before an onRead hook updates settings.json", async () => {
    await withTempPmRoot(async (pmRoot) => {
      const initialSettings = structuredClone(SETTINGS_DEFAULTS);
      initialSettings.author_default = "before-hook";
      await writeSettings(pmRoot, initialSettings);

      let hookRuns = 0;
      const hooks: ExtensionHookRegistry = {
        beforeCommand: [],
        afterCommand: [],
        onRead: [
          {
            layer: "project",
            name: "settings-refresh-hook",
            run: async () => {
              hookRuns += 1;
              if (hookRuns !== 1) {
                return;
              }
              const refreshedSettings = structuredClone(SETTINGS_DEFAULTS);
              refreshedSettings.author_default = "after-hook";
              await fs.writeFile(getSettingsPath(pmRoot), serializeSettings(refreshedSettings), "utf8");
            },
          },
        ],
        onWrite: [],
        onIndex: [],
      };
      setActiveExtensionHooks(hooks);

      const firstRead = await readSettingsWithMetadata(pmRoot);
      const secondRead = await readSettingsWithMetadata(pmRoot);

      expect(firstRead.settings.author_default).toBe("after-hook");
      expect(secondRead.settings.author_default).toBe("after-hook");
      expect(hookRuns).toBe(2);
    });
  });

  it("invalidates merge-failure cache when tracked schema files change", async () => {
    await withTempPmRoot(async (pmRoot) => {
      const settings = structuredClone(SETTINGS_DEFAULTS);
      settings.schema.files.statuses = "schema-blocker/statuses.json";
      await writeSettings(pmRoot, settings);

      const schemaBlockerPath = path.join(pmRoot, "schema-blocker");
      await fs.writeFile(schemaBlockerPath, "blocked\n", "utf8");

      const firstRead = await readSettingsWithMetadata(pmRoot);
      expect(firstRead.warnings).toContain("settings_read_merge_failed");

      await fs.rm(schemaBlockerPath, { force: true });
      await fs.mkdir(schemaBlockerPath, { recursive: true });
      await fs.writeFile(
        path.join(schemaBlockerPath, "statuses.json"),
        `${JSON.stringify({ statuses: structuredClone(DEFAULT_STATUS_DEFINITIONS) }, null, 2)}\n`,
        "utf8",
      );

      const secondRead = await readSettingsWithMetadata(pmRoot);
      expect(secondRead.warnings).not.toContain("settings_read_merge_failed");
      expect(secondRead.settings.schema.statuses.map((definition) => definition.id)).toEqual(
        DEFAULT_STATUS_DEFINITIONS.map((definition) => definition.id),
      );
    });
  });

  it("normalizes item type command option policies deterministically", async () => {
    await withTempPmRoot(async (pmRoot) => {
      const settings = structuredClone(SETTINGS_DEFAULTS);
      settings.item_types.definitions = [
        {
          name: "Asset",
          command_option_policies: [
            { command: "update", option: " goal ", enabled: false },
            { command: "create", option: " message ", required: true },
            { command: "create", option: "message", required: false },
          ],
        },
      ];

      await writeSettings(pmRoot, settings);
      const loaded = await readSettings(pmRoot);
      expect(loaded.item_types.definitions).toEqual([
        {
          name: "Asset",
          command_option_policies: [
            { command: "create", option: "message", required: false },
            { command: "update", option: "goal", enabled: false },
          ],
        },
      ]);
    });
  });

  it("serializes missing nested provider and vector blocks with deterministic empty objects", () => {
    const sparse = {
      ...structuredClone(SETTINGS_DEFAULTS),
      providers: {},
      vector_store: {},
    };
    const serialized = serializeSettings(sparse as never);
    const parsed = JSON.parse(serialized) as Record<string, unknown>;
    const providers = parsed.providers as Record<string, unknown>;
    const vectorStore = parsed.vector_store as Record<string, unknown>;

    expect(providers.openai).toEqual({});
    expect(providers.ollama).toEqual({});
    expect(vectorStore.qdrant).toEqual({});
    expect(vectorStore.lancedb).toEqual({});
  });

  it("sanitizes vector_store.collection_name to safe storage identifiers", () => {
    const settings = structuredClone(SETTINGS_DEFAULTS);
    settings.vector_store.collection_name = "workspace docs/../prod";

    const serialized = serializeSettings(settings);
    const parsed = JSON.parse(serialized) as Record<string, unknown>;
    const vectorStore = parsed.vector_store as Record<string, unknown>;
    const collectionName = vectorStore.collection_name as string;

    expect(collectionName).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(collectionName).toContain("workspace_docs");
  });

  it("truncates sanitized vector_store.collection_name to deterministic maximum length", () => {
    const settings = structuredClone(SETTINGS_DEFAULTS);
    settings.vector_store.collection_name = `${"workspace".repeat(30)} docs`;

    const serialized = serializeSettings(settings);
    const parsed = JSON.parse(serialized) as Record<string, unknown>;
    const vectorStore = parsed.vector_store as Record<string, unknown>;
    const collectionName = vectorStore.collection_name as string;

    expect(collectionName).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(collectionName.length).toBe(128);
  });

  it("falls back from invalid runtime customization leaves during serialization", () => {
    const settings = structuredClone(SETTINGS_DEFAULTS) as unknown as Record<string, unknown>;
    settings.search = {
      mutation_refresh_policy: "always",
      query_expansion: { enabled: "yes", provider: 42 },
      rerank: { enabled: "no", model: 99, top_k: 0 },
    };
    settings.vector_store = {
      adapter: undefined,
      collection_name: "   ",
      qdrant: undefined,
      lancedb: undefined,
    };

    const parsed = JSON.parse(serializeSettings(settings as never)) as {
      search: {
        mutation_refresh_policy: string;
        query_expansion: { enabled: boolean; provider: string };
        rerank: { enabled: boolean; model: string; top_k: number };
      };
      vector_store: {
        adapter: string;
        collection_name: string;
        qdrant: Record<string, unknown>;
        lancedb: Record<string, unknown>;
      };
    };

    expect(parsed.search.mutation_refresh_policy).toBe(SETTINGS_DEFAULTS.search.mutation_refresh_policy);
    expect(parsed.search.query_expansion).toEqual(SETTINGS_DEFAULTS.search.query_expansion);
    expect(parsed.search.rerank).toEqual(SETTINGS_DEFAULTS.search.rerank);
    expect(parsed.vector_store.adapter).toBe(SETTINGS_DEFAULTS.vector_store.adapter);
    expect(parsed.vector_store.collection_name).toBe(SETTINGS_DEFAULTS.vector_store.collection_name);
    expect(parsed.vector_store.qdrant).toEqual({});
    expect(parsed.vector_store.lancedb).toEqual({});
  });

  it("normalizes extension policy overrides and pm max-version modes during serialization", () => {
    const settings = structuredClone(SETTINGS_DEFAULTS);
    settings.extensions.enabled = [" beta ", "alpha", "alpha"];
    settings.extensions.disabled = [" off ", "beta"];
    settings.extensions.policy = {
      ...settings.extensions.policy,
      mode: "enforce",
      trust_mode: "warn",
      pm_max_version_exceeded_mode: { global: "warn", project: "bogus" as never },
      default_sandbox_profile: "strict",
      extension_overrides: [
        { name: " ", disabled: true },
        {
          name: " Alpha ",
          disabled: true,
          require_trusted: true,
          require_provenance: true,
          sandbox_profile: "bad" as never,
          allowed_capabilities: [" hooks ", "hooks", ""],
          blocked_surfaces: ["schema.flags"],
          allowed_commands: ["Create"],
          blocked_actions: [" Drop "],
          allowed_services: ["item_store_write"],
        },
      ],
    };

    const parsed = JSON.parse(serializeSettings(settings)) as {
      extensions: {
        enabled: string[];
        disabled: string[];
        policy: {
          pm_max_version_exceeded_mode?: unknown;
          extension_overrides: Array<Record<string, unknown>>;
        };
      };
    };

    expect(parsed.extensions.enabled).toEqual(["alpha", "beta"]);
    expect(parsed.extensions.disabled).toEqual(["beta", "off"]);
    expect(parsed.extensions.policy.pm_max_version_exceeded_mode).toEqual({ global: "warn" });
    expect(parsed.extensions.policy.extension_overrides).toEqual([
      {
        name: "alpha",
        disabled: true,
        require_trusted: true,
        require_provenance: true,
        sandbox_profile: "none",
        allowed_capabilities: ["hooks"],
        blocked_surfaces: ["schema.flags"],
        allowed_commands: ["create"],
        blocked_actions: ["drop"],
        allowed_services: ["item_store_write"],
      },
    ]);

    settings.extensions.policy.pm_max_version_exceeded_mode = "block";
    const stringMode = JSON.parse(serializeSettings(settings)) as {
      extensions: { policy: { pm_max_version_exceeded_mode?: unknown } };
    };
    expect(stringMode.extensions.policy.pm_max_version_exceeded_mode).toBe("block");

    settings.extensions.policy.pm_max_version_exceeded_mode = { global: "bad" as never, project: "also-bad" as never };
    const invalidMode = JSON.parse(serializeSettings(settings)) as {
      extensions: { policy: { pm_max_version_exceeded_mode?: unknown } };
    };
    expect(invalidMode.extensions.policy.pm_max_version_exceeded_mode).toBeUndefined();
  });

  it("resolves governance knobs for built-in presets and custom overrides", () => {
    expect(resolveGovernanceKnobs({ governance: { preset: "minimal" } })).toEqual({
      preset: "minimal",
      ownership_enforcement: "none",
      create_mode_default: "progressive",
      close_validation_default: "off",
      parent_reference: "strict_error",
      metadata_profile: "core",
      force_required_for_stale_lock: false,
      require_close_reason: true,
    });
    expect(resolveGovernanceKnobs({ governance: { preset: "default" } })).toEqual({
      preset: "default",
      ownership_enforcement: "warn",
      create_mode_default: "progressive",
      close_validation_default: "warn",
      parent_reference: "strict_error",
      metadata_profile: "core",
      force_required_for_stale_lock: true,
      require_close_reason: true,
    });
    expect(resolveGovernanceKnobs({ governance: { preset: "strict" } })).toEqual({
      preset: "strict",
      ownership_enforcement: "strict",
      create_mode_default: "strict",
      close_validation_default: "strict",
      parent_reference: "strict_error",
      metadata_profile: "strict",
      force_required_for_stale_lock: true,
      require_close_reason: true,
    });
    expect(
      resolveGovernanceKnobs({
        governance: {
          preset: "custom",
          ownership_enforcement: "none",
          force_required_for_stale_lock: false,
        },
      }),
    ).toEqual({
      preset: "custom",
      ownership_enforcement: "none",
      create_mode_default: "progressive",
      close_validation_default: "warn",
      parent_reference: "strict_error",
      metadata_profile: "core",
      force_required_for_stale_lock: false,
      require_close_reason: true,
    });
    expect(
      resolveGovernanceKnobs({
        governance: {
          preset: "strict",
          create_default_type: " Feature ",
          workflow_enforcement: "strict",
          require_close_reason: false,
        },
      }),
    ).toMatchObject({
      preset: "strict",
      create_default_type: "Feature",
      workflow_enforcement: "strict",
      require_close_reason: false,
    });
  });

  it("persists custom governance extras and falls back from invalid governance presets", () => {
    expect(resolveGovernanceKnobs({ governance: { preset: "unknown" as never } }).preset).toBe(
      SETTINGS_DEFAULTS.governance.preset,
    );

    const settings = structuredClone(SETTINGS_DEFAULTS);
    settings.governance = {
      ...settings.governance,
      preset: "custom",
      ownership_enforcement: "strict",
      create_mode_default: "strict",
      close_validation_default: "strict",
      parent_reference: "warn",
      metadata_profile: "strict",
      force_required_for_stale_lock: false,
      create_default_type: "Issue",
      workflow_enforcement: "warn",
      require_close_reason: false,
    };

    const parsed = JSON.parse(serializeSettings(settings)) as {
      governance: Record<string, unknown>;
    };

    expect(parsed.governance).toMatchObject({
      preset: "custom",
      ownership_enforcement: "strict",
      create_mode_default: "strict",
      close_validation_default: "strict",
      parent_reference: "warn",
      metadata_profile: "strict",
      force_required_for_stale_lock: false,
      create_default_type: "Issue",
      workflow_enforcement: "warn",
      require_close_reason: false,
    });
  });

  it("collects deterministic settings-cache signatures and marks missing files with null stats", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pm-settings-cache-signatures-"));
    const existingPath = path.join(tempRoot, "settings.json");
    const missingPath = path.join(tempRoot, "missing.json");
    await fs.writeFile(existingPath, "{}\n", "utf8");

    const signatures = await collectSettingsReadCacheSignatures([missingPath, existingPath, existingPath]);
    expect(signatures.map((entry) => entry.path)).toEqual(
      [existingPath, missingPath].sort((left, right) => left.localeCompare(right)),
    );
    const existingSignature = signatures.find((entry) => entry.path === existingPath);
    const missingSignature = signatures.find((entry) => entry.path === missingPath);
    expect(existingSignature?.mtime_ms).not.toBeNull();
    expect(existingSignature?.size).toBeGreaterThan(0);
    expect(missingSignature).toEqual({
      path: missingPath,
      mtime_ms: null,
      size: null,
    });
  });

  it("compares settings-cache signatures by path/mtime/size values", () => {
    const base = [
      { path: "/tmp/a", mtime_ms: 1, size: 10 },
      { path: "/tmp/b", mtime_ms: null, size: null },
    ];
    expect(settingsReadCacheSignaturesEqual(base, [...base])).toBe(true);
    expect(settingsReadCacheSignaturesEqual(base, base.slice(0, 1))).toBe(false);
    expect(
      settingsReadCacheSignaturesEqual(base, [
        { path: "/tmp/a", mtime_ms: 2, size: 10 },
        { path: "/tmp/b", mtime_ms: null, size: null },
      ]),
    ).toBe(false);
    expect(
      settingsReadCacheSignaturesEqual(base, [
        { path: "/tmp/b", mtime_ms: null, size: null },
        { path: "/tmp/a", mtime_ms: 1, size: 10 },
      ]),
    ).toBe(false);
  });

  it("stores, reads, and clears cache entries per pm root", () => {
    setSettingsReadCacheEntry("/tmp/root-a", {
      tracked_paths: [" /tmp/path-a ", "/tmp/path-a", "/tmp/path-b"],
      signatures: [
        { path: "/tmp/path-b", mtime_ms: 2, size: 20 },
        { path: "/tmp/path-a", mtime_ms: 1, size: 10 },
      ],
      value: { value: "cached-a" },
    });
    setSettingsReadCacheEntry("/tmp/root-b", {
      tracked_paths: ["/tmp/path-c"],
      signatures: [{ path: "/tmp/path-c", mtime_ms: 3, size: 30 }],
      value: { value: "cached-b" },
    });

    expect(getSettingsReadCacheEntry<{ value: string }>("/tmp/root-a")).toEqual({
      tracked_paths: ["/tmp/path-a", "/tmp/path-b"],
      signatures: [
        { path: "/tmp/path-a", mtime_ms: 1, size: 10 },
        { path: "/tmp/path-b", mtime_ms: 2, size: 20 },
      ],
      value: { value: "cached-a" },
    });

    clearSettingsReadCache("/tmp/root-a");
    expect(getSettingsReadCacheEntry("/tmp/root-a")).toBeUndefined();
    expect(getSettingsReadCacheEntry("/tmp/root-b")).toBeDefined();

    clearSettingsReadCache();
    expect(getSettingsReadCacheEntry("/tmp/root-b")).toBeUndefined();
  });

  it("covers private settings normalization edge cases", () => {
    expect(settingsStoreTestOnly.hasExplicitItemFormat(null)).toBe(false);
    expect(settingsStoreTestOnly.hasExplicitItemFormat([])).toBe(false);
    expect(settingsStoreTestOnly.hasExplicitItemFormat({ item_format: "json_markdown" })).toBe(true);
    expect(settingsStoreTestOnly.hasExplicitItemFormat({ item_format: "bad" })).toBe(false);
    expect(settingsStoreTestOnly.normalizeStringList([" b ", "", "a", "b"])).toEqual(["a", "b"]);
    expect(settingsStoreTestOnly.normalizeLowerStringList([" B ", "", "a", "b"])).toEqual(["a", "b"]);
    expect(settingsStoreTestOnly.normalizeValidationMetadataRequiredFields(["author", "bad", "close-reason", "AUTHOR"])).toEqual([
      "author",
      "close_reason",
    ]);
    expect(settingsStoreTestOnly.normalizeExtensionPolicyOverride({ name: "  " })).toBeNull();
    expect(settingsStoreTestOnly.normalizeExtensionPolicyMode("bad" as never)).toBe(SETTINGS_DEFAULTS.extensions.policy.mode);
    expect(settingsStoreTestOnly.normalizeExtensionTrustMode("bad" as never)).toBe(
      SETTINGS_DEFAULTS.extensions.policy.trust_mode,
    );
    expect(settingsStoreTestOnly.normalizeExtensionSandboxProfile("bad" as never)).toBe(
      SETTINGS_DEFAULTS.extensions.policy.default_sandbox_profile,
    );
    expect(
      settingsStoreTestOnly.normalizeExtensionPolicyOverrides([
        {
          name: "Beta",
          blocked_capabilities: [" Filesystem ", "filesystem"],
          allowed_surfaces: [" Cli "],
          blocked_commands: [" Delete "],
          allowed_actions: [" Read "],
        },
        {
          name: "alpha",
          allowed_capabilities: [" Network "],
          blocked_surfaces: [" Mcp "],
          allowed_commands: [" Create ", "create"],
          blocked_actions: [" Write "],
          allowed_services: [" Settings_Read "],
          blocked_services: [" Item_Store_Write "],
        },
        { name: "" },
      ]),
    ).toEqual([
      {
        name: "alpha",
        allowed_capabilities: ["network"],
        allowed_commands: ["create"],
        allowed_services: ["settings_read"],
        blocked_actions: ["write"],
        blocked_services: ["item_store_write"],
        blocked_surfaces: ["mcp"],
      },
      {
        name: "beta",
        allowed_actions: ["read"],
        allowed_surfaces: ["cli"],
        blocked_capabilities: ["filesystem"],
        blocked_commands: ["delete"],
      },
    ]);
    expect(
      settingsStoreTestOnly.selectedSettingsReadCacheSignaturesEqual(
        [{ path: "/tmp/a", mtime_ms: 1, size: 1 }],
        [{ path: "/tmp/a", mtime_ms: 1, size: 1 }],
        ["/tmp/a"],
      ),
    ).toBe(true);
    expect(
      settingsStoreTestOnly.selectedSettingsReadCacheSignaturesEqual(
        [{ path: "/tmp/a", mtime_ms: 1, size: 1 }],
        [{ path: "/tmp/a", mtime_ms: 2, size: 1 }],
        ["/tmp/a"],
      ),
    ).toBe(false);
  });

  it("preserves or drops file-backed schema sections based on source snapshots", () => {
    const settings = structuredClone(SETTINGS_DEFAULTS);
    settings.item_types.definitions = [{ name: "Risk", folder: "risks" }];
    settings.schema.statuses = [{ name: "triaged", role: "active" }];
    settings.schema.fields = [{ name: "severity", type: "string" }];
    settings.schema.type_workflows = [{ type: "Risk", statuses: ["triaged"] }];
    const source = settingsStoreTestOnly.buildSettingsPersistSourceSnapshot(
      {
        item_types: { definitions: [{ name: "Risk", folder: "source-risks" }] },
        schema: {
          statuses: [{ name: "source", role: "active" }],
          fields: [{ name: "source_field", type: "string" }],
          type_workflows: [{ type: "Source", statuses: ["source"] }],
        },
      } as never,
      settings,
    );

    const persisted = settingsStoreTestOnly.resolvePersistedFileBackedSchemaSections(settings, source);
    expect(persisted.item_type_definitions).toEqual([expect.objectContaining({ name: "Risk", folder: "source-risks" })]);
    expect(persisted.schema_statuses.length).toBeGreaterThan(0);
    expect(persisted.schema_fields).toEqual([]);
    expect(persisted.schema_type_workflows).toBeUndefined();

    const changed = structuredClone(settings);
    changed.item_types.definitions = [{ name: "Changed", folder: "changed-items" }];
    expect(settingsStoreTestOnly.resolvePersistedFileBackedSchemaSections(changed, source).item_type_definitions).toEqual([
      expect.objectContaining({ name: "Changed", folder: "changed-items" }),
    ]);
    const withoutSource = settingsStoreTestOnly.resolvePersistedFileBackedSchemaSections(settings, undefined);
    expect(withoutSource.item_type_definitions).toEqual(settings.item_types.definitions);
    expect(withoutSource.schema_statuses.length).toBeGreaterThan(0);
  });

  it("serializes sparse settings payloads using normalize fallbacks", () => {
    const sparse = structuredClone(SETTINGS_DEFAULTS) as Record<string, unknown>;
    sparse.validation = {};
    sparse.telemetry = {};
    sparse.agent_guidance = {};
    sparse.item_types = {};
    sparse.schema = {};
    sparse.context = {};
    sparse.extensions = {
      enabled: [],
      disabled: [],
      policy: {},
    };
    sparse.search = {};
    sparse.providers = {};
    sparse.vector_store = {};

    const serialized = serializeSettings(sparse as never);
    const parsed = JSON.parse(serialized) as Record<string, unknown>;

    expect(parsed.item_format).toBe("toon");
    expect(parsed.search).toMatchObject({
      mutation_refresh_policy: SETTINGS_DEFAULTS.search.mutation_refresh_policy,
    });
    expect(parsed.context).toMatchObject({
      default_depth: SETTINGS_DEFAULTS.context.default_depth,
      activity_limit: SETTINGS_DEFAULTS.context.activity_limit,
      stale_threshold_days: SETTINGS_DEFAULTS.context.stale_threshold_days,
    });
    expect(parsed.extensions).toMatchObject({
      enabled: [],
      disabled: [],
    });
    expect(parsed.vector_store).toMatchObject({
      adapter: SETTINGS_DEFAULTS.vector_store.adapter,
      collection_name: SETTINGS_DEFAULTS.vector_store.collection_name,
    });
  });

  it("detects selected settings cache signature path mismatches", () => {
    expect(
      settingsStoreTestOnly.selectedSettingsReadCacheSignaturesEqual(
        [{ path: "/tmp/a", mtime_ms: 1, size: 1 }],
        [{ path: "/tmp/b", mtime_ms: 1, size: 1 }],
        ["/tmp/a"],
      ),
    ).toBe(false);
  });
});
