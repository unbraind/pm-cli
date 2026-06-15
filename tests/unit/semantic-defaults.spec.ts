import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SETTINGS_DEFAULTS } from "../../src/core/shared/constants.js";
import { resolveSettingsWithSemanticRuntimeDefaults } from "../../src/core/search/semantic-defaults.js";

const { spawnSyncMock } = vi.hoisted(() => ({
  spawnSyncMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawnSync: spawnSyncMock,
}));

function makeSettings() {
  return structuredClone(SETTINGS_DEFAULTS);
}

describe("resolveSettingsWithSemanticRuntimeDefaults", () => {
  const previousDisableEnv = process.env.PM_DISABLE_OLLAMA_AUTO_DEFAULTS;
  const previousModelEnv = process.env.PM_OLLAMA_MODEL;

  beforeEach(() => {
    spawnSyncMock.mockReset();
    delete process.env.PM_DISABLE_OLLAMA_AUTO_DEFAULTS;
    delete process.env.PM_OLLAMA_MODEL;
    spawnSyncMock.mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "",
    });
  });

  it("applies Ollama-backed semantic defaults when no explicit semantic config exists", () => {
    const settings = makeSettings();
    spawnSyncMock.mockImplementation((_command: string, args: string[]) => {
      if (args[0] === "--version") {
        return {
          status: 0,
          stdout: "ollama version is 0.0.0",
          stderr: "",
        };
      }
      if (args[0] === "list") {
        return {
          status: 0,
          stdout: "NAME ID SIZE MODIFIED\nllama3.2:latest abc 2 GB now\nqwen3-embedding:0.6b def 380 MB now\n",
          stderr: "",
        };
      }
      return {
        status: 1,
        stdout: "",
        stderr: "",
      };
    });

    const resolved = resolveSettingsWithSemanticRuntimeDefaults(settings);
    expect(resolved.auto_ollama_defaults_applied).toBe(true);
    expect(resolved.settings.providers.ollama.base_url).toBe("http://localhost:11434");
    expect(resolved.settings.providers.ollama.model).toBe("qwen3-embedding:0.6b");
    expect(resolved.settings.search.embedding_model).toBe("qwen3-embedding:0.6b");
    expect(resolved.settings.vector_store.lancedb.path).toBe(".agents/pm/search/lancedb/");
  });

  it("prefers qwen embedding models over other listed embedding models", () => {
    const settings = makeSettings();
    spawnSyncMock.mockImplementation((_command: string, args: string[]) => {
      if (args[0] === "--version") {
        return {
          status: 0,
          stdout: "ollama version is 0.0.0",
          stderr: "",
        };
      }
      if (args[0] === "list") {
        return {
          status: 0,
          stdout:
            "NAME ID SIZE MODIFIED\nnomic-embed-text-v2-moe:latest abc 957 MB now\nqwen3-embedding:0.6b def 639 MB now\n",
          stderr: "",
        };
      }
      return {
        status: 1,
        stdout: "",
        stderr: "",
      };
    });

    const resolved = resolveSettingsWithSemanticRuntimeDefaults(settings);

    expect(resolved.auto_ollama_defaults_applied).toBe(true);
    expect(resolved.settings.providers.ollama.model).toBe("qwen3-embedding:0.6b");
    expect(resolved.settings.search.embedding_model).toBe("qwen3-embedding:0.6b");
  });

  it("does not select a non-embedding Ollama chat model as an auto default", () => {
    const settings = makeSettings();
    spawnSyncMock.mockImplementation((_command: string, args: string[]) => {
      if (args[0] === "--version") {
        return {
          status: 0,
          stdout: "ollama version is 0.0.0",
          stderr: "",
        };
      }
      if (args[0] === "list") {
        return {
          status: 0,
          stdout: "NAME ID SIZE MODIFIED\nllama3.2:latest abc 2 GB now\ngemma4:latest def 4 GB now\n",
          stderr: "",
        };
      }
      return {
        status: 1,
        stdout: "",
        stderr: "",
      };
    });

    const resolved = resolveSettingsWithSemanticRuntimeDefaults(settings);

    expect(resolved.auto_ollama_defaults_applied).toBe(true);
    expect(resolved.settings.providers.ollama.model).toBe("qwen3-embedding:0.6b");
    expect(resolved.settings.search.embedding_model).toBe("qwen3-embedding:0.6b");
  });

  it("uses PM_OLLAMA_MODEL override when auto defaults are applied", () => {
    const settings = makeSettings();
    process.env.PM_OLLAMA_MODEL = "custom-embed-model:latest";
    spawnSyncMock.mockImplementation((_command: string, args: string[]) => {
      if (args[0] === "--version") {
        return {
          status: 0,
          stdout: "ollama version is 0.0.0",
          stderr: "",
        };
      }
      return {
        status: 1,
        stdout: "",
        stderr: "",
      };
    });

    const resolved = resolveSettingsWithSemanticRuntimeDefaults(settings);
    expect(resolved.auto_ollama_defaults_applied).toBe(true);
    expect(resolved.settings.providers.ollama.model).toBe("custom-embed-model:latest");
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
  });

  it("does not apply auto defaults when explicitly disabled", () => {
    const settings = makeSettings();
    process.env.PM_DISABLE_OLLAMA_AUTO_DEFAULTS = "1";
    const resolved = resolveSettingsWithSemanticRuntimeDefaults(settings);
    expect(resolved.auto_ollama_defaults_applied).toBe(false);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("does not apply auto defaults when the Ollama/LanceDB stack is fully configured", () => {
    const settings = makeSettings();
    settings.providers.ollama.base_url = "http://localhost:11434";
    settings.providers.ollama.model = "already-configured";
    settings.search.embedding_model = "already-configured";
    settings.vector_store.lancedb.path = ".agents/pm/search/lancedb";

    const resolved = resolveSettingsWithSemanticRuntimeDefaults(settings);
    expect(resolved.auto_ollama_defaults_applied).toBe(false);
    expect(resolved.settings.providers.ollama.model).toBe("already-configured");
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("fills only the missing leaves when Ollama is partially configured (no all-or-nothing bail)", () => {
    const settings = makeSettings();
    // The user set just the base URL — previously this disabled ALL auto defaults and
    // then hard-errored `pm reindex`. Now the remaining Ollama/LanceDB leaves are filled.
    settings.providers.ollama.base_url = "http://localhost:11434";
    spawnSyncMock.mockImplementation((_command: string, args: string[]) => {
      if (args[0] === "--version") {
        return { status: 0, stdout: "ollama version is 0.0.0", stderr: "" };
      }
      if (args[0] === "list") {
        return {
          status: 0,
          stdout: "NAME ID SIZE MODIFIED\nqwen3-embedding:0.6b def 380 MB now\n",
          stderr: "",
        };
      }
      return { status: 1, stdout: "", stderr: "" };
    });

    const resolved = resolveSettingsWithSemanticRuntimeDefaults(settings);
    expect(resolved.auto_ollama_defaults_applied).toBe(true);
    expect(resolved.settings.providers.ollama.base_url).toBe("http://localhost:11434");
    expect(resolved.settings.providers.ollama.model).toBe("qwen3-embedding:0.6b");
    expect(resolved.settings.search.embedding_model).toBe("qwen3-embedding:0.6b");
    expect(resolved.settings.vector_store.lancedb.path).toBe(".agents/pm/search/lancedb/");
  });

  it("mirrors a user-configured model into embedding_model without probing Ollama", () => {
    const settings = makeSettings();
    settings.providers.ollama.base_url = "http://localhost:11434";
    settings.providers.ollama.model = "user-embed:latest";
    settings.vector_store.lancedb.path = ".agents/pm/search/lancedb";
    // embedding_model intentionally left empty — the only gap.

    const resolved = resolveSettingsWithSemanticRuntimeDefaults(settings);
    expect(resolved.auto_ollama_defaults_applied).toBe(true);
    expect(resolved.settings.search.embedding_model).toBe("user-embed:latest");
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("bails entirely when a competing provider/store is configured", () => {
    const openaiSettings = makeSettings();
    openaiSettings.providers.openai.api_key = "sk-test";
    const openaiResolved = resolveSettingsWithSemanticRuntimeDefaults(openaiSettings);
    expect(openaiResolved.auto_ollama_defaults_applied).toBe(false);

    const qdrantSettings = makeSettings();
    qdrantSettings.vector_store.adapter = "qdrant";
    const qdrantResolved = resolveSettingsWithSemanticRuntimeDefaults(qdrantSettings);
    expect(qdrantResolved.auto_ollama_defaults_applied).toBe(false);

    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("does not auto-apply when a model must be discovered but Ollama is absent", () => {
    const settings = makeSettings();
    settings.providers.ollama.base_url = "http://localhost:11434";
    spawnSyncMock.mockReturnValue({ status: 1, stdout: "", stderr: "" });

    const resolved = resolveSettingsWithSemanticRuntimeDefaults(settings);
    expect(resolved.auto_ollama_defaults_applied).toBe(false);
    expect(resolved.settings.providers.ollama.model).toBe("");
  });

  it("fills a missing leaf without throwing when its parent object is absent (partial settings)", () => {
    // Ollama + LanceDB configured but NO `search` block at all — readSettings would
    // normalize this, but callers can pass a partial object. The embedding_model leaf
    // must be filled (mirroring the configured model) instead of crashing on
    // `nextSettings.search.embedding_model` when `search` is undefined.
    const partial = {
      providers: { ollama: { base_url: "http://localhost:11434", model: "nomic-embed-text" } },
      vector_store: { lancedb: { path: "/tmp/lancedb" } },
    } as unknown as Parameters<typeof resolveSettingsWithSemanticRuntimeDefaults>[0];

    const resolved = resolveSettingsWithSemanticRuntimeDefaults(partial);
    expect(resolved.auto_ollama_defaults_applied).toBe(true);
    expect(resolved.settings.search.embedding_model).toBe("nomic-embed-text");
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("treats a spawn error from `ollama --version` as not installed", () => {
    const settings = makeSettings();
    settings.providers.ollama.base_url = "http://localhost:11434";
    // base_url present but model missing → model discovery requires an install probe.
    spawnSyncMock.mockImplementation((_command: string, args: string[]) => {
      if (args[0] === "--version") {
        return { error: new Error("spawn ENOENT"), status: null, stdout: "", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "" };
    });

    const resolved = resolveSettingsWithSemanticRuntimeDefaults(settings);
    expect(resolved.auto_ollama_defaults_applied).toBe(false);
    expect(resolved.settings.providers.ollama.model).toBe("");
    // Only the version probe runs; `ollama list` is never reached.
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to the default model when `ollama list` yields no models", () => {
    const settings = makeSettings();
    spawnSyncMock.mockImplementation((_command: string, args: string[]) => {
      if (args[0] === "--version") {
        return { status: 0, stdout: "ollama version is 0.0.0", stderr: "" };
      }
      if (args[0] === "list") {
        // Whitespace-only output → no parseable lines at all.
        return { status: 0, stdout: "   \n\n", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "" };
    });

    const resolved = resolveSettingsWithSemanticRuntimeDefaults(settings);
    expect(resolved.auto_ollama_defaults_applied).toBe(true);
    expect(resolved.settings.providers.ollama.model).toBe("qwen3-embedding:0.6b");
  });

  it("falls back to the default model when `ollama list` shows only the header row", () => {
    const settings = makeSettings();
    spawnSyncMock.mockImplementation((_command: string, args: string[]) => {
      if (args[0] === "--version") {
        return { status: 0, stdout: "ollama version is 0.0.0", stderr: "" };
      }
      if (args[0] === "list") {
        // Header-only listing → the NAME row is filtered out, leaving no models.
        return { status: 0, stdout: "NAME ID SIZE MODIFIED\n", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "" };
    });

    const resolved = resolveSettingsWithSemanticRuntimeDefaults(settings);
    expect(resolved.auto_ollama_defaults_applied).toBe(true);
    expect(resolved.settings.providers.ollama.model).toBe("qwen3-embedding:0.6b");
  });

  afterEach(() => {
    if (previousDisableEnv === undefined) {
      delete process.env.PM_DISABLE_OLLAMA_AUTO_DEFAULTS;
    } else {
      process.env.PM_DISABLE_OLLAMA_AUTO_DEFAULTS = previousDisableEnv;
    }
    if (previousModelEnv === undefined) {
      delete process.env.PM_OLLAMA_MODEL;
    } else {
      process.env.PM_OLLAMA_MODEL = previousModelEnv;
    }
  });
});
