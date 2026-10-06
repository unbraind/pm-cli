import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readHistoryEntries } from "../../../../src/core/history/read.js";
import { getWorkspaceHistoryPath, WORKSPACE_HISTORY_ID } from "../../../../src/core/history/workspace-history.js";
import { createExtensionCommandSdk } from "../../../../src/sdk/extension-command-context.js";
import { PmClient } from "../../../../src/sdk/runtime.js";
import { readSettings, runWithConfigurationOnlySettings } from "../../../../src/core/store/settings.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";

describe("audited owned settings subtrees", () => {
  it("removes omitted owned keys while preserving unrelated future fields, dry runs and replay", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const settingsPath = path.join(pmPath, "settings.json");
      const raw = JSON.parse(await readFile(settingsPath, "utf8"));
      raw.governance = { ...raw.governance, retired_rule: "obsolete" };
      raw.search = { ...raw.search, future_search: { retained: true } };
      raw.future_root = { retained: true };
      const before = `${JSON.stringify(raw, null, 2)}\n`;
      await writeFile(settingsPath, before);
      const sdk = createExtensionCommandSdk(pmPath, new PmClient({ pmRoot: pmPath, noExtensions: true }));
      expect(await sdk.mutateWorkspaceSettings({ operationId: "empty-ownership", replaceSubtrees: [], mutate: (current) => current })).toMatchObject({ changed: false });
      expect(await readFile(settingsPath, "utf8")).toBe(before);
      const options = {
        operationId: "owned-governance", replaceSubtrees: ["governance"], includePreview: true,
        mutate: vi.fn((current) => current),
      } satisfies Parameters<typeof sdk.mutateWorkspaceSettings>[0];
      expect(await sdk.mutateWorkspaceSettings({ ...options, dryRun: true })).toMatchObject({ changed: true, dry_run: true });
      expect(await readFile(settingsPath, "utf8")).toBe(before);
      expect(await readHistoryEntries(getWorkspaceHistoryPath(pmPath), WORKSPACE_HISTORY_ID)).toHaveLength(0);
      const receipt = await sdk.mutateWorkspaceSettings(options);
      const persisted = JSON.parse(await readFile(settingsPath, "utf8"));
      expect(receipt).toMatchObject({ changed: true, replayed: false });
      expect(receipt.preview).toEqual(await runWithConfigurationOnlySettings(pmPath, () => readSettings(pmPath)));
      expect(persisted).toMatchObject({ search: { future_search: { retained: true } }, future_root: { retained: true } });
      expect(persisted.governance).not.toHaveProperty("retired_rule");
      expect(await readHistoryEntries(getWorkspaceHistoryPath(pmPath), WORKSPACE_HISTORY_ID)).toHaveLength(1);
      options.mutate.mockClear();
      expect(await sdk.mutateWorkspaceSettings(options)).toMatchObject({ changed: false, replayed: true });
      expect(options.mutate).not.toHaveBeenCalled();
      expect(await sdk.mutateWorkspaceSettings({ ...options, operationId: "owned-noop" })).toMatchObject({ changed: false });
    });
  });

  it("replaces nested objects and materializes only the selected sparse path", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const settingsPath = path.join(pmPath, "settings.json");
      const raw = JSON.parse(await readFile(settingsPath, "utf8"));
      raw.search = { ...raw.search, rerank: { ...raw.search.rerank, retired: true }, sibling: "retained" };
      delete raw.history;
      await writeFile(settingsPath, JSON.stringify(raw));
      const sdk = createExtensionCommandSdk(pmPath, new PmClient({ pmRoot: pmPath, noExtensions: true }));
      const receipt = await sdk.mutateWorkspaceSettings({
        operationId: "nested-owned", replaceSubtrees: ["search.rerank", "history.compact_policy"], includePreview: true,
        mutate: (current) => current,
      });
      const persisted = JSON.parse(await readFile(settingsPath, "utf8"));
      expect(persisted.search).toEqual({ ...raw.search, rerank: receipt.preview?.search.rerank });
      expect(persisted.history).toMatchObject({ compact_policy: receipt.preview?.history.compact_policy });
    });
  });

  it.each(["", "__proto__", "search.constructor", "unknown", "author_default", "author_default.child", "extensions.enabled", "extensions.enabled.child", "search.missing.child", "search..rerank"])("rejects unsafe or non-object ownership path %j without writes", async (ownedPath) => {
    await withTempPmPath(async ({ pmPath }) => {
      const settingsPath = path.join(pmPath, "settings.json");
      const before = await readFile(settingsPath, "utf8");
      const sdk = createExtensionCommandSdk(pmPath, new PmClient({ pmRoot: pmPath, noExtensions: true }));
      await expect(sdk.mutateWorkspaceSettings({ operationId: "invalid-owned", replaceSubtrees: [ownedPath], mutate: (current) => current })).rejects.toThrow("settings subtree");
      expect(await readFile(settingsPath, "utf8")).toBe(before);
      expect(await readHistoryEntries(getWorkspaceHistoryPath(pmPath), WORKSPACE_HISTORY_ID)).toHaveLength(0);
    });
  });
});
