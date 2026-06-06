import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearActiveExtensionHooks, setActiveExtensionHooks } from "../../src/core/extensions/index.js";
import type { ExtensionHookRegistry } from "../../src/core/extensions/loader.js";
import { normalizeRuntimeSchemaSettings } from "../../src/core/schema/runtime-schema.js";
import { DEFAULT_STATUS_DEFINITIONS, SETTINGS_DEFAULTS } from "../../src/core/shared/constants.js";
import { getSettingsPath } from "../../src/core/store/paths.js";
import { readSettings, readSettingsWithMetadata, resolveGovernanceKnobs, serializeSettings, writeSettings } from "../../src/core/store/settings.js";
import { withTempRoot } from "../helpers/temp.js";

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
      custom.author_default = "settings-author";
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
        "author_default",
        "item_format",
        "locks",
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
      expectOrderedObjectKeys(parsed.locks, ["ttl_seconds"]);
      expectOrderedObjectKeys(parsed.output, ["default_format"]);
      expectOrderedObjectKeys(parsed.history, ["missing_stream"]);
      expectOrderedObjectKeys(parsed.validation, [
        "sprint_release_format",
        "parent_reference",
        "metadata_profile",
        "metadata_required_fields",
        "lifecycle_stale_blocker_reason_patterns",
        "lifecycle_closure_like_blocked_reason_patterns",
        "lifecycle_closure_like_resolution_patterns",
        "lifecycle_closure_like_actual_result_patterns",
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
      ]);

      const providers = parsed.providers as Record<string, unknown>;
      expectOrderedObjectKeys(providers, ["openai", "ollama"]);
      expectOrderedObjectKeys(providers.openai, ["base_url", "api_key", "model"]);
      expectOrderedObjectKeys(providers.ollama, ["base_url", "model"]);

      const vectorStore = parsed.vector_store as Record<string, unknown>;
      expectOrderedObjectKeys(vectorStore, ["adapter", "qdrant", "lancedb"]);
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

  it("resolves governance knobs for built-in presets and custom overrides", () => {
    expect(resolveGovernanceKnobs({ governance: { preset: "minimal" } })).toEqual({
      preset: "minimal",
      ownership_enforcement: "none",
      create_mode_default: "progressive",
      close_validation_default: "off",
      parent_reference: "warn",
      metadata_profile: "core",
      force_required_for_stale_lock: false,
    });
    expect(resolveGovernanceKnobs({ governance: { preset: "default" } })).toEqual({
      preset: "default",
      ownership_enforcement: "warn",
      create_mode_default: "progressive",
      close_validation_default: "warn",
      parent_reference: "warn",
      metadata_profile: "core",
      force_required_for_stale_lock: true,
    });
    expect(resolveGovernanceKnobs({ governance: { preset: "strict" } })).toEqual({
      preset: "strict",
      ownership_enforcement: "strict",
      create_mode_default: "strict",
      close_validation_default: "strict",
      parent_reference: "strict_error",
      metadata_profile: "strict",
      force_required_for_stale_lock: true,
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
      parent_reference: "warn",
      metadata_profile: "core",
      force_required_for_stale_lock: false,
    });
  });
});
