import { describe, expect, it } from "vitest";
import { getEnabledBuiltInExtensions } from "../../src/core/extensions/builtins.js";
import { SETTINGS_DEFAULTS } from "../../src/core/shared/constants.js";
import type { PmSettings } from "../../src/types/index.js";

function createSettings(): PmSettings {
  return structuredClone(SETTINGS_DEFAULTS);
}

function getLoadedBuiltInNames(settings: PmSettings): string[] {
  return getEnabledBuiltInExtensions(settings).map((entry) => entry.name);
}

describe("core/extensions/builtins", () => {
  it("includes both built-ins when extension filters are empty", () => {
    const settings = createSettings();
    expect(getLoadedBuiltInNames(settings)).toEqual(["builtin-beads-import", "builtin-todos-import-export"]);
  });

  it("respects disabled built-in entries", () => {
    const settings = createSettings();
    settings.extensions.disabled = [" builtin-beads-import ", "builtin-beads-import"];
    expect(getLoadedBuiltInNames(settings)).toEqual(["builtin-todos-import-export"]);
  });

  it("respects enabled allow-list for built-ins", () => {
    const settings = createSettings();
    settings.extensions.enabled = ["builtin-todos-import-export", " builtin-todos-import-export "];
    expect(getLoadedBuiltInNames(settings)).toEqual(["builtin-todos-import-export"]);
  });
});
