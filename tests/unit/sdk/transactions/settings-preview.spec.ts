import { readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SETTINGS_DEFAULTS } from "../../../../src/core/shared/constants.js";
import { readSettings, runWithConfigurationOnlySettings } from "../../../../src/core/store/settings.js";
import { getWorkspaceHistoryPath, WORKSPACE_HISTORY_ID } from "../../../../src/core/history/workspace-history.js";
import { readHistoryEntries } from "../../../../src/core/history/read.js";
import { createExtensionCommandSdk } from "../../../../src/sdk/extension-command-context.js";
import { PmClient } from "../../../../src/sdk/runtime.js";
import type { PmSettings } from "../../../../src/types/index.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";

describe("canonical host settings preview", () => {
  it.each(["minimal", "strict", "custom"] as const)("returns the persisted %s preset rather than the callback proposal", async (preset) => {
    await withTempPmPath(async ({ pmPath }) => {
      const sdk = createExtensionCommandSdk(pmPath, new PmClient({ pmRoot: pmPath, noExtensions: true }));
      const settingsPath = path.join(pmPath, "settings.json");
      const before = await readFile(settingsPath, "utf8");
      const historyPath = getWorkspaceHistoryPath(pmPath);
      const mutate = (current: PmSettings): PmSettings => ({
        ...current,
        governance: { ...SETTINGS_DEFAULTS.governance, preset, ownership_enforcement: "strict", metadata_profile: "strict" },
        item_format: "json_markdown" as PmSettings["item_format"],
        vector_store: { ...SETTINGS_DEFAULTS.vector_store, collection_name: "bad/name" },
      });
      const options = { operationId: "canonical-preview", dryRun: true, includePreview: true, mutate };
      const preview = await sdk.mutateWorkspaceSettings(options);
      expect(preview).toMatchObject({ changed: true, dry_run: true, replayed: false, preview: {
        item_format: "toon", vector_store: { collection_name: "bad_name" },
        governance: { preset, ownership_enforcement: preset === "minimal" ? "none" : "strict", metadata_profile: preset === "minimal" ? "core" : "strict" },
      } });
      expect(await readFile(settingsPath, "utf8")).toBe(before);
      expect(await readHistoryEntries(historyPath, WORKSPACE_HISTORY_ID)).toHaveLength(0);
      const applied = await sdk.mutateWorkspaceSettings({ ...options, dryRun: false });
      const persisted = await runWithConfigurationOnlySettings(pmPath, () => readSettings(pmPath));
      expect(applied).toEqual({ changed: true, dry_run: false, replayed: false, preview: persisted });
      expect(preview).toMatchObject({ preview: persisted });
      const callback = vi.fn(mutate);
      expect(await sdk.mutateWorkspaceSettings({ ...options, mutate: callback })).toEqual({ changed: false, dry_run: true, replayed: true });
      expect(callback).not.toHaveBeenCalled();
      const noop = await sdk.mutateWorkspaceSettings({ ...options, operationId: "fresh-noop", mutate: (current) => current });
      expect(noop).toEqual({ changed: false, dry_run: true, replayed: false, preview: persisted });
      expect(await readHistoryEntries(historyPath, WORKSPACE_HISTORY_ID)).toHaveLength(1);
    });
  });

  it("does not scaffold missing optional schemas during a direct host dry run", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const sdk = createExtensionCommandSdk(pmPath, new PmClient({ pmRoot: pmPath, noExtensions: true }));
      const schemaPath = path.join(pmPath, "schema");
      await rm(schemaPath, { recursive: true });
      const before = await readFile(path.join(pmPath, "settings.json"), "utf8");
      const options = { operationId: "read-only", dryRun: true, includePreview: true, mutate: (current: PmSettings) => current };
      await expect(sdk.mutateWorkspaceSettings(options)).resolves.toMatchObject({ changed: false, preview: { version: 1 } });
      await expect(stat(schemaPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(path.join(pmPath, "settings.json"), "utf8")).toBe(before);
      expect(await readHistoryEntries(getWorkspaceHistoryPath(pmPath), WORKSPACE_HISTORY_ID)).toHaveLength(0);
    });
  });

  it("returns each concurrent writer's locked result without losing the preceding update", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const sdk = createExtensionCommandSdk(pmPath, new PmClient({ pmRoot: pmPath, noExtensions: true }));
      const results = await Promise.all(["first", "second"].map((operationId) => sdk.mutateWorkspaceSettings({
        operationId, includePreview: true,
        mutate: (current) => ({ ...current, author_default: `${current.author_default}/next` }),
      })));
      expect(results.map((receipt) => receipt.preview?.author_default).sort()).toEqual(["test-author/next", "test-author/next/next"]);
      expect((await readSettings(pmPath)).author_default).toBe("test-author/next/next");
      expect(await readHistoryEntries(getWorkspaceHistoryPath(pmPath), WORKSPACE_HISTORY_ID)).toHaveLength(2);
    });
  });

  it("supplies canonical callbacks while preserving sparse no-ops and unknown fields on changes", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const settingsPath = path.join(pmPath, "settings.json");
      const sparse = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
      delete sparse.governance;
      delete sparse.ux;
      sparse.item_format = "json_markdown";
      const sourceVector = sparse.vector_store as Record<string, unknown>;
      sourceVector.collection_name = "old/name";
      sparse.future_setting = { version: 2, custom: ["preserved", { enabled: true }] };
      const sourceSearch = sparse.search as Record<string, unknown>;
      sourceSearch.future_provider = { options: ["vendor", { enabled: true }] };
      const sourceRerank = sourceSearch.rerank as Record<string, unknown>;
      sourceRerank.future_ranker = { strategy: "custom" };
      const before = `${JSON.stringify(sparse)}\n`;
      await writeFile(settingsPath, before);
      const expected = await runWithConfigurationOnlySettings(pmPath, () => readSettings(pmPath));
      const sdk = createExtensionCommandSdk(pmPath, new PmClient({ pmRoot: pmPath, noExtensions: true }));
      const options = { operationId: "sparse-noop", dryRun: true, includePreview: true, mutate: (current: PmSettings) => {
        expect(current).toEqual(expected);
        expect(Object.hasOwn(current, "future_setting")).toBe(false);
        return current;
      } };
      expect(await sdk.mutateWorkspaceSettings(options)).toEqual({ changed: false, dry_run: true, replayed: false, preview: expected });
      expect(await readFile(settingsPath, "utf8")).toBe(before);
      expect(await readHistoryEntries(getWorkspaceHistoryPath(pmPath), WORKSPACE_HISTORY_ID)).toHaveLength(0);
      const changedOptions = {
        ...options, operationId: "sparse-change",
        mutate: (current: PmSettings) => {
          expect(current).toEqual(expected);
          return { ...current, author_default: "changed", search: { ...current.search, rerank: { ...current.search.rerank, top_k: current.search.rerank.top_k + 1 } } };
        },
      };
      const changedPreview = await sdk.mutateWorkspaceSettings(changedOptions);
      expect(changedPreview).toEqual({
        changed: true, dry_run: true, replayed: false,
        preview: { ...expected, author_default: "changed", search: { ...expected.search, rerank: { ...expected.search.rerank, top_k: expected.search.rerank.top_k + 1 } } },
      });
      expect(await readFile(settingsPath, "utf8")).toBe(before);
      expect(await readHistoryEntries(getWorkspaceHistoryPath(pmPath), WORKSPACE_HISTORY_ID)).toHaveLength(0);
      const applied = await sdk.mutateWorkspaceSettings({ ...changedOptions, dryRun: false });
      expect(applied).toEqual({ ...changedPreview, dry_run: false });
      const saved = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
      expect(saved).toMatchObject({
        author_default: "changed", item_format: "toon", vector_store: { collection_name: "old_name" }, future_setting: sparse.future_setting,
        search: { future_provider: sourceSearch.future_provider, rerank: { future_ranker: sourceRerank.future_ranker } },
      });
      expect(saved).not.toHaveProperty("governance");
      expect(saved).not.toHaveProperty("ux");
      expect(await runWithConfigurationOnlySettings(pmPath, () => readSettings(pmPath))).toEqual(changedPreview.preview);
      expect(await readHistoryEntries(getWorkspaceHistoryPath(pmPath), WORKSPACE_HISTORY_ID)).toHaveLength(1);
    });
  });

  it("refuses a proposal that changes during serialization before writing settings or history", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const sdk = createExtensionCommandSdk(pmPath, new PmClient({ pmRoot: pmPath, noExtensions: true }));
      const before = await readFile(path.join(pmPath, "settings.json"), "utf8");
      await expect(sdk.mutateWorkspaceSettings({
        operationId: "unstable-proposal",
        mutate: (current) => {
          let reads = 0;
          return Object.defineProperty({ ...current, author_default: "proposed" }, "version", {
            enumerable: true, get: () => ++reads === 1 ? 1 : "invalid",
          });
        },
      })).rejects.toThrow(/serialized invalid settings/);
      expect(await readFile(path.join(pmPath, "settings.json"), "utf8")).toBe(before);
      expect(await readHistoryEntries(getWorkspaceHistoryPath(pmPath), WORKSPACE_HISTORY_ID)).toHaveLength(0);
    });
  });
});
