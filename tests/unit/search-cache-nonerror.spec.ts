import { beforeEach, describe, expect, it, vi } from "vitest";

const pathExistsMock = vi.fn<() => Promise<boolean>>();
const removeFileIfExistsMock = vi.fn<(targetPath: string) => Promise<void>>();
const readSettingsMock = vi.fn<() => Promise<unknown>>();

vi.mock("../../src/core/fs/fs-utils.js", () => ({
  pathExists: pathExistsMock,
  removeFileIfExists: removeFileIfExistsMock,
}));

vi.mock("../../src/core/store/settings.js", () => ({
  readSettings: readSettingsMock,
}));

describe("core/search/cache non-error warning formatting", () => {
  beforeEach(() => {
    pathExistsMock.mockReset();
    removeFileIfExistsMock.mockReset();
    readSettingsMock.mockReset();
    pathExistsMock.mockResolvedValue(true);
    readSettingsMock.mockRejectedValue("boom");
    removeFileIfExistsMock.mockResolvedValue();
  });

  it("formats settings-read failures deterministically when dependency throws non-Error values", async () => {
    const { refreshSemanticEmbeddingsForMutatedItems } = await import("../../src/core/search/cache.js");
    const result = await refreshSemanticEmbeddingsForMutatedItems("/tmp/pm-cache-nonerror", ["pm-abc"]);
    expect(result).toEqual({
      refreshed: [],
      skipped: ["pm-abc"],
      warnings: ["search_semantic_refresh_skipped:settings_read_failed:boom"],
    });
  });

  it("falls back to error name when thrown Error message is blank", async () => {
    readSettingsMock.mockRejectedValueOnce(new Error(" "));
    const { refreshSemanticEmbeddingsForMutatedItems } = await import("../../src/core/search/cache.js");
    const result = await refreshSemanticEmbeddingsForMutatedItems("/tmp/pm-cache-empty-error", ["pm-xyz"]);
    expect(result).toEqual({
      refreshed: [],
      skipped: ["pm-xyz"],
      warnings: ["search_semantic_refresh_skipped:settings_read_failed:Error"],
    });
  });
});
