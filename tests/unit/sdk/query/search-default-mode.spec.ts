import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NESTED_SETTING_DESCRIPTORS } from "../../../../src/core/config/nested-settings.js";
import { EXIT_CODE, SETTINGS_DEFAULTS } from "../../../../src/core/shared/constants.js";
import { getSettingsPath } from "../../../../src/core/store/paths.js";
import { clearSettingsReadCache } from "../../../../src/core/store/settings-read-cache.js";
import { readSettings, serializeSettings } from "../../../../src/core/store/settings.js";
import {
  SEARCH_DEFAULT_MODE_VALUES,
  parseSearchMode,
  resolveEffectiveSearchMode,
  resolveSearchDefaultModeSetting,
} from "../../../../src/sdk/query/search-contracts.js";
import { withTempRoot } from "../../../helpers/temp.js";

// pm-n8a6e7 — the default search mode is SDK policy resolved from
// search.default_mode and workspace state, never a presentation-layer literal.
describe("sdk/query search default mode (pm-n8a6e7)", () => {
  afterEach(() => {
    clearSettingsReadCache();
  });

  it("declares every accepted default-mode value with auto first", () => {
    expect(SEARCH_DEFAULT_MODE_VALUES).toEqual(["auto", "keyword", "semantic", "hybrid"]);
    expect(SETTINGS_DEFAULTS.search.default_mode).toBe("auto");
  });

  it("reads search.default_mode and falls back to auto for absent, non-string, or unknown values", () => {
    expect(resolveSearchDefaultModeSetting({})).toBe("auto");
    expect(resolveSearchDefaultModeSetting({ search: {} })).toBe("auto");
    expect(resolveSearchDefaultModeSetting({ search: { default_mode: 7 } })).toBe("auto");
    expect(resolveSearchDefaultModeSetting({ search: { default_mode: "sometimes" } })).toBe("auto");
    expect(resolveSearchDefaultModeSetting({ search: { default_mode: " HYBRID " } })).toBe("hybrid");
    expect(resolveSearchDefaultModeSetting({ search: { default_mode: "keyword" } })).toBe("keyword");
    expect(resolveSearchDefaultModeSetting({ search: { default_mode: "semantic" } })).toBe("semantic");
  });

  it("keeps the raw parser's keyword fallback for callers that pass no mode", () => {
    // The runtime resolver never calls the parser without a mode, but the
    // parser stays a public helper whose absent-input contract is keyword.
    expect(parseSearchMode(undefined)).toBe("keyword");
    expect(parseSearchMode(" Hybrid ")).toBe("hybrid");
  });

  it("lets an explicit request win and validates it", () => {
    expect(
      resolveEffectiveSearchMode({ requested: "semantic", settings: { search: { default_mode: "keyword" } }, semanticRunnable: false }),
    ).toEqual({ mode: "semantic", source: "explicit" });
    expect(() =>
      resolveEffectiveSearchMode({ requested: "fuzzy", settings: {}, semanticRunnable: true }),
    ).toThrow(expect.objectContaining({ exitCode: EXIT_CODE.USAGE }));
  });

  it("pins the declared mode when search.default_mode is concrete", () => {
    expect(
      resolveEffectiveSearchMode({ requested: "   ", settings: { search: { default_mode: "keyword" } }, semanticRunnable: true }),
    ).toEqual({ mode: "keyword", source: "settings" });
    expect(
      resolveEffectiveSearchMode({ requested: undefined, settings: { search: { default_mode: "hybrid" } }, semanticRunnable: false }),
    ).toEqual({ mode: "hybrid", source: "settings" });
  });

  it("derives hybrid under auto only when the semantic path is runnable", () => {
    expect(resolveEffectiveSearchMode({ requested: undefined, settings: {}, semanticRunnable: true })).toEqual({
      mode: "hybrid",
      source: "auto",
    });
    expect(resolveEffectiveSearchMode({ requested: undefined, settings: { search: { default_mode: "auto" } }, semanticRunnable: false })).toEqual({
      mode: "keyword",
      source: "auto",
    });
  });

  it("exposes search_default_mode as a choice-bound config key", () => {
    const descriptor = NESTED_SETTING_DESCRIPTORS.find((entry) => entry.key === "search_default_mode");
    expect(descriptor).toMatchObject({
      path: "search.default_mode",
      kind: "string",
      choices: ["auto", "keyword", "semantic", "hybrid"],
    });
  });

  it("normalizes the stored key on read: concrete values survive, unknown values fall back to auto", async () => {
    await withTempRoot("pm-cli-search-default-mode-", async (tempRoot) => {
      const pmRoot = path.join(tempRoot, ".agents", "pm");
      const settingsPath = getSettingsPath(pmRoot);
      await fs.mkdir(path.dirname(settingsPath), { recursive: true });
      const pinned = structuredClone(SETTINGS_DEFAULTS);
      pinned.search.default_mode = "hybrid";
      await fs.writeFile(settingsPath, serializeSettings(pinned), "utf8");
      expect((await readSettings(pmRoot)).search.default_mode).toBe("hybrid");
      clearSettingsReadCache();
      // Raw JSON on purpose: serializeSettings would already normalize the value.
      const raw = JSON.parse(serializeSettings(pinned)) as { search: { default_mode: string } };
      raw.search.default_mode = "sometimes";
      await fs.writeFile(settingsPath, JSON.stringify(raw, null, 2), "utf8");
      expect((await readSettings(pmRoot)).search.default_mode).toBe("auto");
    });
  });
});
