import path from "node:path";
import { describe, expect, it } from "vitest";

import { resolveEmbeddingProviders, resolveProviderConfigSource } from "../../../../src/core/search/providers.js";
import { resolveVectorStores } from "../../../../src/core/search/vector-stores.js";

// pm-7ilo / Codex follow-up: writing `search.provider` and
// `vector_store.adapter` is meaningless if the runtime doesn't honor them.
// These tests lock the contract: when both built-ins are configured, the
// preferred name wins; otherwise the first available falls through.

describe("resolveEmbeddingProviders honors settings.search.provider", () => {
  const bothConfigured = {
    providers: {
      openai: { base_url: "https://api.openai.com/v1", api_key: "x", model: "text-embedding-3-small" },
      ollama: { base_url: "http://localhost:11434", model: "nomic-embed-text" },
    },
  };

  it("returns the first available (openai > ollama) when no preference is set", () => {
    const resolution = resolveEmbeddingProviders({ ...bothConfigured });
    expect(resolution.active?.name).toBe("openai");
    expect(resolution.available.map((entry) => entry.name)).toEqual(["openai", "ollama"]);
  });

  it("selects ollama when `settings.search.provider = ollama`", () => {
    const resolution = resolveEmbeddingProviders({
      ...bothConfigured,
      search: { provider: "ollama" },
    });
    expect(resolution.active?.name).toBe("ollama");
  });

  it("selects openai when `settings.search.provider = openai`", () => {
    const resolution = resolveEmbeddingProviders({
      ...bothConfigured,
      search: { provider: "openai" },
    });
    expect(resolution.active?.name).toBe("openai");
  });

  it("falls back to the first available when the preferred name names a non-built-in (extension) provider", () => {
    const resolution = resolveEmbeddingProviders({
      ...bothConfigured,
      search: { provider: "an-extension-provider" },
    });
    expect(resolution.active?.name).toBe("openai");
  });

  it("applies settings.search.embedding_model as a model override across whichever provider wins", () => {
    const openaiOverride = resolveEmbeddingProviders({
      ...bothConfigured,
      search: { provider: "openai", embedding_model: "my-custom-openai-model" },
    });
    expect(openaiOverride.active?.model).toBe("my-custom-openai-model");

    const ollamaOverride = resolveEmbeddingProviders({
      ...bothConfigured,
      search: { provider: "ollama", embedding_model: "my-custom-ollama-model" },
    });
    expect(ollamaOverride.active?.model).toBe("my-custom-ollama-model");
  });

  it("leaves provider-specific model untouched when embedding_model is absent / empty", () => {
    const resolution = resolveEmbeddingProviders({ ...bothConfigured, search: { embedding_model: "" } });
    expect(resolution.active?.model).toBe("text-embedding-3-small");
  });

  it("matches the preferred provider name case-insensitively", () => {
    for (const variant of ["Ollama", "OLLAMA", "oLlAmA"]) {
      const resolution = resolveEmbeddingProviders({
        ...bothConfigured,
        search: { provider: variant },
      });
      expect(resolution.active?.name).toBe("ollama");
    }
  });
});

describe("resolveVectorStores honors settings.vector_store.adapter", () => {
  const bothConfigured = {
    vector_store: {
      qdrant: { url: "http://localhost:6333" },
      lancedb: { path: ".agents/pm/search/lancedb" },
    },
  };

  it("returns the first available (qdrant > lancedb) when no adapter is set", () => {
    const resolution = resolveVectorStores({ ...bothConfigured });
    expect(resolution.active?.name).toBe("qdrant");
  });

  it("selects lancedb when `settings.vector_store.adapter = lancedb`", () => {
    const resolution = resolveVectorStores({
      ...bothConfigured,
      vector_store: { ...bothConfigured.vector_store, adapter: "lancedb" },
    });
    expect(resolution.active?.name).toBe("lancedb");
  });

  it("selects qdrant when `settings.vector_store.adapter = qdrant`", () => {
    const resolution = resolveVectorStores({
      ...bothConfigured,
      vector_store: { ...bothConfigured.vector_store, adapter: "qdrant" },
    });
    expect(resolution.active?.name).toBe("qdrant");
  });

  it("falls back to first available when adapter names a non-built-in (extension) adapter", () => {
    const resolution = resolveVectorStores({
      ...bothConfigured,
      vector_store: { ...bothConfigured.vector_store, adapter: "an-extension-adapter" },
    });
    expect(resolution.active?.name).toBe("qdrant");
  });

  it("matches the preferred adapter name case-insensitively", () => {
    for (const variant of ["LanceDB", "LANCEDB", "LaNcEdB"]) {
      const resolution = resolveVectorStores({
        ...bothConfigured,
        vector_store: { ...bothConfigured.vector_store, adapter: variant },
      });
      expect(resolution.active?.name).toBe("lancedb");
    }
  });
});

describe("resolveVectorStores anchors relative lancedb paths to the workspace root (pm-og1v)", () => {
  const lancedbOnly = {
    vector_store: {
      lancedb: { path: ".agents/pm/search/lancedb/" },
    },
  };

  it("anchors a workspace-relative path to the workspace root for a conventional pm root", () => {
    const pmRoot = path.join(path.sep, "workspace", "project", ".agents", "pm");
    const resolution = resolveVectorStores(lancedbOnly, pmRoot);
    expect(resolution.active).toMatchObject({
      name: "lancedb",
      path: path.join(path.sep, "workspace", "project", ".agents", "pm", "search", "lancedb"),
    });
  });

  it("anchors a relative path to the pm root itself for a bare --path root", () => {
    const pmRoot = path.join(path.sep, "sandboxes", "run-1");
    const resolution = resolveVectorStores(lancedbOnly, pmRoot);
    expect(resolution.active?.name).toBe("lancedb");
    expect((resolution.active as { path: string }).path).toBe(
      path.join(path.sep, "sandboxes", "run-1", ".agents", "pm", "search", "lancedb"),
    );
  });

  it("leaves absolute lancedb paths untouched", () => {
    const absolute = path.join(path.sep, "var", "data", "vectors");
    const resolution = resolveVectorStores(
      { vector_store: { lancedb: { path: absolute } } },
      path.join(path.sep, "workspace", ".agents", "pm"),
    );
    expect((resolution.active as { path: string }).path).toBe(absolute);
  });

  it("preserves the raw relative path when no pm root is provided (back-compat)", () => {
    const resolution = resolveVectorStores(lancedbOnly);
    expect((resolution.active as { path: string }).path).toBe(".agents/pm/search/lancedb/");
  });
});

describe("resolveProviderConfigSource (GH-244)", () => {
  it("reports 'unconfigured' when nothing is active", () => {
    expect(resolveProviderConfigSource(null, "")).toBe("unconfigured");
    expect(resolveProviderConfigSource("", "ollama")).toBe("unconfigured");
    expect(resolveProviderConfigSource(undefined, undefined)).toBe("unconfigured");
  });

  it("reports 'configured' when the persisted setting names the active resolution", () => {
    expect(resolveProviderConfigSource("ollama", "ollama")).toBe("configured");
    expect(resolveProviderConfigSource("lancedb", "  lancedb  ")).toBe("configured");
  });

  it("reports 'auto-detected' when active but the persisted setting is empty", () => {
    expect(resolveProviderConfigSource("ollama", "")).toBe("auto-detected");
    expect(resolveProviderConfigSource("lancedb", null)).toBe("auto-detected");
  });

  it("reports 'auto-detected' when the persisted value does not match the active resolution", () => {
    // A configured-but-unhonored value (typo/unsupported) that the runtime fell
    // back from must not be reported as "configured".
    expect(resolveProviderConfigSource("ollama", "openai")).toBe("auto-detected");
    expect(resolveProviderConfigSource("lancedb", "qdrant")).toBe("auto-detected");
  });
});
