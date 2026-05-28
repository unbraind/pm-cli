import path from "node:path";
import { describe, expect, it } from "vitest";
import { runConfig } from "../../src/cli/commands/config.js";
import {
  NESTED_SETTING_DESCRIPTORS,
  resolveNestedSettingDescriptor,
} from "../../src/core/config/nested-settings.js";
import { SETTINGS_DEFAULTS } from "../../src/core/shared/constants.js";
import { writeSettings } from "../../src/core/store/settings.js";
import type { GlobalOptions } from "../../src/core/shared/command-types.js";
import { withTempRoot } from "../helpers/temp.js";

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
  search_embedding_model: "search.embedding_model",
  search_embedding_batch_size: "search.embedding_batch_size",
  search_embedding_timeout_ms: "search.embedding_timeout_ms",
  search_score_threshold: "search.score_threshold",
  search_hybrid_semantic_weight: "search.hybrid_semantic_weight",
  search_max_results: "search.max_results",
  openai_base_url: "providers.openai.base_url",
  openai_api_key: "providers.openai.api_key",
  openai_model: "providers.openai.model",
  ollama_base_url: "providers.ollama.base_url",
  ollama_model: "providers.ollama.model",
  vector_store_adapter: "vector_store.adapter",
  qdrant_url: "vector_store.qdrant.url",
  qdrant_api_key: "vector_store.qdrant.api_key",
  lancedb_path: "vector_store.lancedb.path",
};

describe("config nested-setting aliases (pm-7ilo)", () => {
  it("registers all 16 search/provider/vector-store aliases with the expected settings paths", () => {
    const descriptorByKey = new Map(NESTED_SETTING_DESCRIPTORS.map((d) => [d.key, d]));
    for (const [alias, expectedPath] of Object.entries(EXPECTED_ALIASES)) {
      const descriptor = descriptorByKey.get(alias);
      expect(descriptor, `missing nested-setting alias: ${alias}`).toBeDefined();
      expect(descriptor!.path).toBe(expectedPath);
    }
    expect(Object.keys(EXPECTED_ALIASES)).toHaveLength(16);
  });

  it("resolves both kebab-case and snake_case forms of each alias", () => {
    for (const alias of Object.keys(EXPECTED_ALIASES)) {
      expect(resolveNestedSettingDescriptor(alias)).toBeDefined();
      // kebab-case is accepted by normalizing "-" → "_" in the resolver.
      expect(resolveNestedSettingDescriptor(alias.replaceAll("_", "-"))).toBeDefined();
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

  it("`pm config project list` surfaces nested_settings for discoverability", async () => {
    await withTempRoot("pm-cli-7ilo-aliases-", async (tempRoot) => {
      const pmRoot = path.join(tempRoot, ".agents", "pm");
      await writeSettings(pmRoot, structuredClone(SETTINGS_DEFAULTS));

      const result = await runConfig("project", "list", undefined, {}, { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot });

      expect(result.nested_settings).toBeDefined();
      expect(result.nested_settings).toHaveLength(16);
      const keys = (result.nested_settings ?? []).map((entry) => entry.key).sort();
      expect(keys).toEqual(Object.keys(EXPECTED_ALIASES).sort());
    });
  });
});
