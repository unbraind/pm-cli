import path from "node:path";
import { describe, expect, it } from "vitest";
import { runConfig } from "../../../src/cli/commands/config.js";
import {
  NESTED_SETTING_DESCRIPTORS,
  resolveNestedSettingDescriptor,
} from "../../../src/core/config/nested-settings.js";
import { SETTINGS_DEFAULTS } from "../../../src/core/shared/constants.js";
import { writeSettings } from "../../../src/core/store/settings.js";
import type { GlobalOptions } from "../../../src/core/shared/command-types.js";
import { withTempRoot } from "../../helpers/temp.js";

const DEFAULT_GLOBAL_OPTIONS: GlobalOptions = {
  json: false,
  quiet: false,
  profile: false,
};

// pm-7ilo — every search/provider/vector-store CLI alias must resolve to its
// known dotted settings path. The descriptor table is the source of truth, so
// a missing or misnamed entry breaks this test immediately.
const EXPECTED_ALIASES: Record<string, string> = {
  search_provider: "search.provider",
  search_mutation_refresh_policy: "search.mutation_refresh_policy",
  search_query_expansion_enabled: "search.query_expansion.enabled",
  search_query_expansion_provider: "search.query_expansion.provider",
  search_rerank_enabled: "search.rerank.enabled",
  search_rerank_model: "search.rerank.model",
  search_rerank_top_k: "search.rerank.top_k",
  search_embedding_model: "search.embedding_model",
  search_embedding_corpus_max_characters: "search.embedding_corpus_max_characters",
  search_embedding_batch_size: "search.embedding_batch_size",
  search_embedding_timeout_ms: "search.embedding_timeout_ms",
  search_score_threshold: "search.score_threshold",
  search_hybrid_semantic_weight: "search.hybrid_semantic_weight",
  search_max_results: "search.max_results",
  search_bm25_k1: "search.bm25.k1",
  search_bm25_b: "search.bm25.b",
  openai_base_url: "providers.openai.base_url",
  openai_api_key: "providers.openai.api_key",
  openai_model: "providers.openai.model",
  ollama_base_url: "providers.ollama.base_url",
  ollama_model: "providers.ollama.model",
  vector_store_adapter: "vector_store.adapter",
  vector_store_collection_name: "vector_store.collection_name",
  qdrant_url: "vector_store.qdrant.url",
  qdrant_api_key: "vector_store.qdrant.api_key",
  lancedb_path: "vector_store.lancedb.path",
};

// pm-9byd / pm-nnaq — general workspace leaves (id/author/output/locks/schema
// governance) exposed via the same nested-setting descriptor table.
const EXPECTED_GENERAL_ALIASES: Record<string, string> = {
  id_prefix: "id_prefix",
  author_default: "author_default",
  output_default_format: "output.default_format",
  locks_ttl_seconds: "locks.ttl_seconds",
  checkpoints_retention_days: "checkpoints.retention_days",
  schema_unknown_field_policy: "schema.unknown_field_policy",
  history_compact_policy_enabled: "history.compact_policy.enabled",
  history_compact_policy_max_entries: "history.compact_policy.max_entries",
  history_compact_policy_trigger: "history.compact_policy.trigger",
};

const ALL_EXPECTED_ALIASES: Record<string, string> = {
  ...EXPECTED_ALIASES,
  ...EXPECTED_GENERAL_ALIASES,
};

describe("config nested-setting aliases (pm-7ilo)", () => {
  it("registers all search/provider/vector-store aliases with the expected settings paths", () => {
    const descriptorByKey = new Map(NESTED_SETTING_DESCRIPTORS.map((d) => [d.key, d]));
    for (const [alias, expectedPath] of Object.entries(EXPECTED_ALIASES)) {
      const descriptor = descriptorByKey.get(alias);
      expect(descriptor, `missing nested-setting alias: ${alias}`).toBeDefined();
      expect(descriptor!.path).toBe(expectedPath);
    }
    expect(Object.keys(EXPECTED_ALIASES)).toHaveLength(26);
  });

  it("resolves both kebab-case and snake_case forms of each alias", () => {
    for (const [alias, expectedPath] of Object.entries(EXPECTED_ALIASES)) {
      const descriptor = resolveNestedSettingDescriptor(alias);
      expect(descriptor).toMatchObject({ key: alias, path: expectedPath });
      // kebab-case is accepted by normalizing "-" → "_" in the resolver, so it
      // must resolve to the very same descriptor object as the snake_case form.
      expect(resolveNestedSettingDescriptor(alias.replaceAll("_", "-"))).toBe(descriptor);
    }
  });

  it("returns undefined for unknown keys (so the regular ConfigKey path still rejects them)", () => {
    expect(resolveNestedSettingDescriptor("definition_of_done")).toBeUndefined();
    expect(resolveNestedSettingDescriptor("bogus_key")).toBeUndefined();
    expect(resolveNestedSettingDescriptor("")).toBeUndefined();
    expect(resolveNestedSettingDescriptor(undefined)).toBeUndefined();
  });

  it("`pm config project set search_provider <value>` writes the nested leaf", async () => {
    await withTempRoot("pm-cli-7ilo-aliases-", async (tempRoot) => {
      const pmRoot = path.join(tempRoot, ".agents", "pm");
      await writeSettings(pmRoot, structuredClone(SETTINGS_DEFAULTS));

      const result = await runConfig(
        "project",
        "set",
        "search_provider",
        {},
        { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot },
        "ollama",
      );

      expect(result).toMatchObject({
        scope: "project",
        key: "search_provider",
        nested_setting: {
          key: "search_provider",
          path: "search.provider",
          kind: "string",
          value: "ollama",
        },
        changed: true,
      });
    });
  });

  it("`pm config project set search_hybrid_semantic_weight 0.5` parses ratios", async () => {
    await withTempRoot("pm-cli-7ilo-aliases-", async (tempRoot) => {
      const pmRoot = path.join(tempRoot, ".agents", "pm");
      await writeSettings(pmRoot, structuredClone(SETTINGS_DEFAULTS));

      const result = await runConfig(
        "project",
        "set",
        "search_hybrid_semantic_weight",
        {},
        { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot },
        "0.5",
      );

      expect(result.nested_setting).toEqual({
        key: "search_hybrid_semantic_weight",
        path: "search.hybrid_semantic_weight",
        kind: "ratio",
        value: 0.5,
      });
    });
  });

  it("`pm config project set search_rerank_enabled true` parses booleans", async () => {
    await withTempRoot("pm-cli-7ilo-aliases-", async (tempRoot) => {
      const pmRoot = path.join(tempRoot, ".agents", "pm");
      await writeSettings(pmRoot, structuredClone(SETTINGS_DEFAULTS));

      const result = await runConfig(
        "project",
        "set",
        "search_rerank_enabled",
        {},
        { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot },
        "true",
      );

      expect(result.nested_setting).toEqual({
        key: "search_rerank_enabled",
        path: "search.rerank.enabled",
        kind: "boolean",
        value: true,
      });
    });
  });

  it("rejects ratio values outside [0, 1]", async () => {
    await withTempRoot("pm-cli-7ilo-aliases-", async (tempRoot) => {
      const pmRoot = path.join(tempRoot, ".agents", "pm");
      await writeSettings(pmRoot, structuredClone(SETTINGS_DEFAULTS));

      await expect(
        runConfig(
          "project",
          "set",
          "search_hybrid_semantic_weight",
          {},
          { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot },
          "1.5",
        ),
      ).rejects.toThrow(/number in \[0, 1\]/);
    });
  });

  it("`pm config project set search_provider --value ollama` (no positional) succeeds", async () => {
    // Regression for the --value flag handling: previously, supplying --value
    // without a positional triggered a spurious "received both positional and
    // --value" error AND would have overwritten options.value with undefined.
    await withTempRoot("pm-cli-7ilo-aliases-", async (tempRoot) => {
      const pmRoot = path.join(tempRoot, ".agents", "pm");
      await writeSettings(pmRoot, structuredClone(SETTINGS_DEFAULTS));

      const result = await runConfig(
        "project",
        "set",
        "search_provider",
        { value: "ollama" },
        { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot },
      );

      expect(result.nested_setting).toMatchObject({
        key: "search_provider",
        path: "search.provider",
        value: "ollama",
      });
    });
  });

  it("rejects passing both positional value and --value when they differ", async () => {
    await withTempRoot("pm-cli-7ilo-aliases-", async (tempRoot) => {
      const pmRoot = path.join(tempRoot, ".agents", "pm");
      await writeSettings(pmRoot, structuredClone(SETTINGS_DEFAULTS));

      await expect(
        runConfig(
          "project",
          "set",
          "search_provider",
          { value: "openai" },
          { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot },
          "ollama",
        ),
      ).rejects.toThrow(/received both positional/);
    });
  });

  it("accepts both positional and --value when they're equal", async () => {
    await withTempRoot("pm-cli-7ilo-aliases-", async (tempRoot) => {
      const pmRoot = path.join(tempRoot, ".agents", "pm");
      await writeSettings(pmRoot, structuredClone(SETTINGS_DEFAULTS));

      const result = await runConfig(
        "project",
        "set",
        "search_provider",
        { value: "ollama" },
        { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot },
        "ollama",
      );

      expect(result.nested_setting?.value).toBe("ollama");
    });
  });

  it("`pm config project list` surfaces nested_settings for discoverability", async () => {
    await withTempRoot("pm-cli-7ilo-aliases-", async (tempRoot) => {
      const pmRoot = path.join(tempRoot, ".agents", "pm");
      await writeSettings(pmRoot, structuredClone(SETTINGS_DEFAULTS));

      const result = await runConfig("project", "list", undefined, {}, { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot });

      expect(result.nested_settings).toBeDefined();
      expect(result.nested_settings).toHaveLength(Object.keys(ALL_EXPECTED_ALIASES).length);
      const keys = (result.nested_settings ?? []).map((entry) => entry.key).sort();
      expect(keys).toEqual(Object.keys(ALL_EXPECTED_ALIASES).sort());
    });
  });
});

describe("config general-setting aliases (pm-9byd / pm-nnaq)", () => {
  it("registers all general workspace aliases with the expected settings paths", () => {
    const descriptorByKey = new Map(NESTED_SETTING_DESCRIPTORS.map((d) => [d.key, d]));
    for (const [alias, expectedPath] of Object.entries(EXPECTED_GENERAL_ALIASES)) {
      const descriptor = descriptorByKey.get(alias);
      expect(descriptor, `missing nested-setting alias: ${alias}`).toBeDefined();
      expect(descriptor!.path).toBe(expectedPath);
    }
    expect(Object.keys(EXPECTED_GENERAL_ALIASES)).toHaveLength(9);
  });

  it("resolves both kebab-case and snake_case forms of each general alias", () => {
    for (const [alias, expectedPath] of Object.entries(EXPECTED_GENERAL_ALIASES)) {
      const descriptor = resolveNestedSettingDescriptor(alias);
      expect(descriptor).toMatchObject({ key: alias, path: expectedPath });
      expect(resolveNestedSettingDescriptor(alias.replaceAll("_", "-"))).toBe(descriptor);
    }
  });

  it("`pm config project set id_prefix <value>` writes the top-level leaf and round-trips", async () => {
    await withTempRoot("pm-cli-9byd-aliases-", async (tempRoot) => {
      const pmRoot = path.join(tempRoot, ".agents", "pm");
      await writeSettings(pmRoot, structuredClone(SETTINGS_DEFAULTS));

      const setResult = await runConfig(
        "project",
        "set",
        "id_prefix",
        {},
        { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot },
        "task",
      );
      expect(setResult).toMatchObject({
        key: "id_prefix",
        nested_setting: { key: "id_prefix", path: "id_prefix", kind: "string", value: "task" },
        changed: true,
      });

      const getResult = await runConfig(
        "project",
        "get",
        "id_prefix",
        {},
        { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot },
      );
      expect(getResult.nested_setting).toMatchObject({ key: "id_prefix", value: "task" });
    });
  });

  it("`pm config project set author_default <value>` round-trips", async () => {
    await withTempRoot("pm-cli-9byd-aliases-", async (tempRoot) => {
      const pmRoot = path.join(tempRoot, ".agents", "pm");
      await writeSettings(pmRoot, structuredClone(SETTINGS_DEFAULTS));

      const setResult = await runConfig(
        "project",
        "set",
        "author_default",
        {},
        { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot },
        "release-bot",
      );
      expect(setResult.nested_setting).toEqual({
        key: "author_default",
        path: "author_default",
        kind: "string",
        value: "release-bot",
      });
    });
  });

  it("rejects empty author_default (non_empty descriptor)", async () => {
    await withTempRoot("pm-cli-9byd-aliases-", async (tempRoot) => {
      const pmRoot = path.join(tempRoot, ".agents", "pm");
      await writeSettings(pmRoot, structuredClone(SETTINGS_DEFAULTS));

      await expect(
        runConfig("project", "set", "author_default", {}, { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot }, "   "),
      ).rejects.toThrow(/non-empty/);
    });
  });

  it("`pm config project set output_default_format json` accepts a valid choice", async () => {
    await withTempRoot("pm-cli-9byd-aliases-", async (tempRoot) => {
      const pmRoot = path.join(tempRoot, ".agents", "pm");
      await writeSettings(pmRoot, structuredClone(SETTINGS_DEFAULTS));

      const result = await runConfig(
        "project",
        "set",
        "output_default_format",
        {},
        { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot },
        "json",
      );
      expect(result.nested_setting).toEqual({
        key: "output_default_format",
        path: "output.default_format",
        kind: "string",
        value: "json",
      });
    });
  });

  it("rejects an invalid output_default_format choice", async () => {
    await withTempRoot("pm-cli-9byd-aliases-", async (tempRoot) => {
      const pmRoot = path.join(tempRoot, ".agents", "pm");
      await writeSettings(pmRoot, structuredClone(SETTINGS_DEFAULTS));

      await expect(
        runConfig(
          "project",
          "set",
          "output_default_format",
          {},
          { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot },
          "human",
        ),
      ).rejects.toThrow(/toon\|json/);
    });
  });

  it("`pm config project set locks_ttl_seconds 60` parses integers and rejects 0", async () => {
    await withTempRoot("pm-cli-9byd-aliases-", async (tempRoot) => {
      const pmRoot = path.join(tempRoot, ".agents", "pm");
      await writeSettings(pmRoot, structuredClone(SETTINGS_DEFAULTS));

      const accepted = await runConfig(
        "project",
        "set",
        "locks_ttl_seconds",
        {},
        { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot },
        "60",
      );
      expect(accepted.nested_setting).toEqual({
        key: "locks_ttl_seconds",
        path: "locks.ttl_seconds",
        kind: "integer",
        value: 60,
      });

      await expect(
        runConfig("project", "set", "locks_ttl_seconds", {}, { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot }, "0"),
      ).rejects.toThrow(/>= 1/);
    });
  });

  it("`pm config project set checkpoints_retention_days 30` parses integers and rejects 0", async () => {
    await withTempRoot("pm-cli-ckpt-aliases-", async (tempRoot) => {
      const pmRoot = path.join(tempRoot, ".agents", "pm");
      await writeSettings(pmRoot, structuredClone(SETTINGS_DEFAULTS));

      const accepted = await runConfig(
        "project",
        "set",
        "checkpoints_retention_days",
        {},
        { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot },
        "30",
      );
      expect(accepted.nested_setting).toEqual({
        key: "checkpoints_retention_days",
        path: "checkpoints.retention_days",
        kind: "integer",
        value: 30,
      });

      await expect(
        runConfig("project", "set", "checkpoints_retention_days", {}, { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot }, "0"),
      ).rejects.toThrow(/>= 1/);
    });
  });

  it("`pm config project set schema_unknown_field_policy reject` accepts valid policies", async () => {
    await withTempRoot("pm-cli-nnaq-aliases-", async (tempRoot) => {
      const pmRoot = path.join(tempRoot, ".agents", "pm");
      await writeSettings(pmRoot, structuredClone(SETTINGS_DEFAULTS));

      for (const policy of ["allow", "warn", "reject"]) {
        const result = await runConfig(
          "project",
          "set",
          "schema_unknown_field_policy",
          {},
          { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot },
          policy,
        );
        expect(result.nested_setting).toEqual({
          key: "schema_unknown_field_policy",
          path: "schema.unknown_field_policy",
          kind: "string",
          value: policy,
        });
      }
    });
  });

  it("rejects an invalid schema_unknown_field_policy choice", async () => {
    await withTempRoot("pm-cli-nnaq-aliases-", async (tempRoot) => {
      const pmRoot = path.join(tempRoot, ".agents", "pm");
      await writeSettings(pmRoot, structuredClone(SETTINGS_DEFAULTS));

      await expect(
        runConfig(
          "project",
          "set",
          "schema_unknown_field_policy",
          {},
          { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot },
          "strict",
        ),
      ).rejects.toThrow(/allow\|warn\|reject/);
    });
  });
});
