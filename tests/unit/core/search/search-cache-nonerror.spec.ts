import { beforeEach, describe, expect, it, vi } from "vitest";

const pathExistsMock = vi.fn<() => Promise<boolean>>();
const removeFileIfExistsMock = vi.fn<(targetPath: string) => Promise<void>>();
const readSettingsMock = vi.fn<() => Promise<unknown>>();
const readSettingsWarnings = { current: [] as string[] };

vi.mock("../../../../src/core/fs/fs-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/core/fs/fs-utils.js")>()),
  pathExists: pathExistsMock,
  removeFileIfExists: removeFileIfExistsMock,
}));

vi.mock("../../../../src/core/store/settings.js", () => ({
  readSettings: readSettingsMock,
  readSettingsWithMetadata: async () => ({
    settings: await readSettingsMock(),
    warnings: readSettingsWarnings.current,
  }),
}));

describe("core/search/cache non-error warning formatting", () => {
  beforeEach(() => {
    pathExistsMock.mockReset();
    removeFileIfExistsMock.mockReset();
    readSettingsMock.mockReset();
    readSettingsWarnings.current = [];
    pathExistsMock.mockResolvedValue(true);
    readSettingsMock.mockRejectedValue("boom");
    removeFileIfExistsMock.mockResolvedValue();
  });

  it("formats settings-read failures deterministically when dependency throws non-Error values", async () => {
    const { refreshSemanticEmbeddingsForMutatedItems } = await import("../../../../src/core/search/cache.js");
    const result = await refreshSemanticEmbeddingsForMutatedItems("/tmp/pm-cache-nonerror", ["pm-abc"]);
    expect(result).toEqual({
      refreshed: [],
      skipped: ["pm-abc"],
      warnings: ["search_semantic_refresh_skipped:settings_read_failed:boom"],
    });
  });

  it("falls back to error name when thrown Error message is blank", async () => {
    readSettingsMock.mockRejectedValueOnce(new Error(" "));
    const { refreshSemanticEmbeddingsForMutatedItems } = await import("../../../../src/core/search/cache.js");
    const result = await refreshSemanticEmbeddingsForMutatedItems("/tmp/pm-cache-empty-error", ["pm-xyz"]);
    expect(result).toEqual({
      refreshed: [],
      skipped: ["pm-xyz"],
      warnings: ["search_semantic_refresh_skipped:settings_read_failed:Error"],
    });
  });

  it("keeps mutation refresh non-fatal when settings metadata throws", async () => {
    const { refreshSearchArtifactsForMutation } = await import("../../../../src/core/search/cache.js");
    const result = await refreshSearchArtifactsForMutation("/tmp/pm-cache-mutation-error", [
      "pm-b",
      "pm-a",
    ]);
    expect(result).toEqual({
      invalidated: ["index/manifest.json", "search/embeddings.jsonl"],
      refreshed: [],
      skipped: ["pm-a", "pm-b"],
      warnings: ["search_semantic_refresh_skipped:settings_read_failed:boom"],
    });
  });

  it("keeps the background worker non-fatal when settings metadata throws", async () => {
    const { runSemanticRefreshWorker } = await import("../../../../src/core/search/background-refresh.js");
    const scheduleRetry = vi.fn();
    const result = await runSemanticRefreshWorker("/tmp/pm-background-settings-error", async () => {
      throw new Error("refresh must not run");
    }, scheduleRetry);
    expect(result).toEqual({
      processed: [],
      rounds: 0,
      warnings: ["search_background_refresh_settings_read_failed:boom"],
    });
    expect(scheduleRetry).toHaveBeenCalledWith("/tmp/pm-background-settings-error");
  });

  it("preserves filesystem warning provenance for mutation and background refresh", async () => {
    readSettingsMock.mockResolvedValue({});
    readSettingsWarnings.current = ["settings_read_fs_error"];
    const { refreshSearchArtifactsForMutation } = await import("../../../../src/core/search/cache.js");
    const { runSemanticRefreshWorker } = await import("../../../../src/core/search/background-refresh.js");
    const scheduleRetry = vi.fn();

    await expect(
      refreshSearchArtifactsForMutation("/tmp/pm-cache-settings-warning", ["pm-warning"]),
    ).resolves.toEqual({
      invalidated: ["index/manifest.json", "search/embeddings.jsonl"],
      refreshed: [],
      skipped: ["pm-warning"],
      warnings: [
        "search_semantic_refresh_skipped:settings_read_failed:settings_read_fs_error",
      ],
    });
    await expect(
      runSemanticRefreshWorker("/tmp/pm-background-settings-warning", async () => {
        throw new Error("refresh must not run");
      }, scheduleRetry),
    ).resolves.toEqual({
      processed: [],
      rounds: 0,
      warnings: [
        "search_background_refresh_settings_read_failed:settings_read_fs_error",
      ],
    });
    expect(scheduleRetry).toHaveBeenCalledWith("/tmp/pm-background-settings-warning");
  });
});
