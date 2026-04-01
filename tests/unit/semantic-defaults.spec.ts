import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SETTINGS_DEFAULTS } from "../../src/constants.js";
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

  it("does not apply auto defaults when semantic provider/vector settings already exist", () => {
    const settings = makeSettings();
    settings.providers.ollama.base_url = "http://localhost:11434";
    settings.providers.ollama.model = "already-configured";
    settings.vector_store.lancedb.path = ".agents/pm/search/lancedb";

    const resolved = resolveSettingsWithSemanticRuntimeDefaults(settings);
    expect(resolved.auto_ollama_defaults_applied).toBe(false);
    expect(resolved.settings.providers.ollama.model).toBe("already-configured");
    expect(spawnSyncMock).not.toHaveBeenCalled();
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
