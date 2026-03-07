import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearActiveExtensionHooks, setActiveExtensionHooks } from "../../src/core/extensions/index.js";
import type { ExtensionHookRegistry } from "../../src/core/extensions/loader.js";
import { SETTINGS_DEFAULTS } from "../../src/core/shared/constants.js";
import { getSettingsPath } from "../../src/core/store/paths.js";
import { readSettings, serializeSettings, writeSettings } from "../../src/core/store/settings.js";

async function withTempRoot(run: (pmRoot: string) => Promise<void>): Promise<void> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pm-cli-settings-test-"));
  const pmRoot = path.join(tempRoot, ".agents", "pm");
  try {
    await run(pmRoot);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
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
    await withTempRoot(async (pmRoot) => {
      const settings = await readSettings(pmRoot);
      expect(settings).toEqual(SETTINGS_DEFAULTS);
      expect(settings).not.toBe(SETTINGS_DEFAULTS);
    });
  });

  it("falls back to defaults when settings JSON is invalid", async () => {
    await withTempRoot(async (pmRoot) => {
      const settingsPath = getSettingsPath(pmRoot);
      await fs.mkdir(path.dirname(settingsPath), { recursive: true });
      await fs.writeFile(settingsPath, "{ invalid-json", "utf8");

      const settings = await readSettings(pmRoot);
      expect(settings).toEqual(SETTINGS_DEFAULTS);
    });
  });

  it("falls back to defaults when settings object fails schema validation", async () => {
    await withTempRoot(async (pmRoot) => {
      const settingsPath = getSettingsPath(pmRoot);
      await fs.mkdir(path.dirname(settingsPath), { recursive: true });
      await fs.writeFile(settingsPath, JSON.stringify({ version: 1 }), "utf8");

      const settings = await readSettings(pmRoot);
      expect(settings).toEqual(SETTINGS_DEFAULTS);
    });
  });

  it("writes deterministic settings content and reads it back", async () => {
    await withTempRoot(async (pmRoot) => {
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
        "locks",
        "output",
        "extensions",
        "search",
        "providers",
        "vector_store",
      ]);
      expectOrderedObjectKeys(parsed.locks, ["ttl_seconds"]);
      expectOrderedObjectKeys(parsed.output, ["default_format"]);
      expectOrderedObjectKeys(parsed.extensions, ["enabled", "disabled"]);
      expectOrderedObjectKeys(parsed.search, [
        "score_threshold",
        "hybrid_semantic_weight",
        "max_results",
        "embedding_model",
        "embedding_batch_size",
        "scanner_max_batch_retries",
      ]);

      const providers = parsed.providers as Record<string, unknown>;
      expectOrderedObjectKeys(providers, ["openai", "ollama"]);
      expectOrderedObjectKeys(providers.openai, ["base_url", "api_key", "model"]);
      expectOrderedObjectKeys(providers.ollama, ["base_url", "model"]);

      const vectorStore = parsed.vector_store as Record<string, unknown>;
      expectOrderedObjectKeys(vectorStore, ["qdrant", "lancedb"]);
      expectOrderedObjectKeys(vectorStore.qdrant, ["url", "api_key"]);
      expectOrderedObjectKeys(vectorStore.lancedb, ["path"]);

      const loaded = await readSettings(pmRoot);
      expect(loaded).toEqual(custom);
    });
  });

  it("dispatches active onRead/onWrite hooks for settings read and write", async () => {
    await withTempRoot(async (pmRoot) => {
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
});
