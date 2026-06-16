import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SETTINGS_DEFAULTS } from "../../../../src/core/shared/constants.js";
import * as settingsReadCache from "../../../../src/core/store/settings-read-cache.js";

const settingsModule = await vi.importActual<typeof import("../../../../src/core/store/settings.js")>(
  "../../../../src/core/store/settings.js",
);
const {
  normalizeItemTypeDefinitions,
  readSettingsWithMetadata,
  resolveGovernanceKnobs,
  settingsStoreTestOnly,
} = settingsModule;

function buildReadResult() {
  return {
    settings: structuredClone(SETTINGS_DEFAULTS),
    metadata: { has_explicit_item_format: false },
    warnings: [] as string[],
  };
}

async function withTempPmRoot(run: (pmRoot: string) => Promise<void>): Promise<void> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pm-settings-internal-"));
  const pmRoot = path.join(tempRoot, ".agents", "pm");
  try {
    await run(pmRoot);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

describe("settings internal helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    settingsReadCache.clearSettingsReadCache();
  });

  it("covers governance/policy normalization fallback branches", () => {
    expect(resolveGovernanceKnobs({} as never).preset).toBe(SETTINGS_DEFAULTS.governance.preset);
    expect(resolveGovernanceKnobs({ governance: { preset: "custom" } } as never).preset).toBe("custom");

    const merged = settingsStoreTestOnly.mergeSettings({
      ...structuredClone(SETTINGS_DEFAULTS),
      item_format: "json_markdown",
    } as never);
    expect(merged.item_format).toBe("toon");

    expect(settingsStoreTestOnly.normalizeExtensionPolicySettings(undefined)).toMatchObject({
      mode: "off",
      trust_mode: "off",
      allowed_extensions: [],
    });
    expect(
      settingsStoreTestOnly.normalizeExtensionPolicySettings({
        mode: "warn",
        trust_mode: "warn",
        allowed_extensions: ["Project-Only"],
      } as never),
    ).toMatchObject({
      mode: "warn",
      trust_mode: "warn",
      allowed_extensions: ["project-only"],
    });

    expect(settingsStoreTestOnly.normalizeValidationPatternList(undefined)).toEqual([]);
    expect(settingsStoreTestOnly.normalizeStringList(undefined)).toEqual([]);
    expect(settingsStoreTestOnly.normalizeLowerStringList(undefined)).toEqual([]);
    expect(settingsStoreTestOnly.normalizeExtensionPolicyOverrides(undefined)).toEqual([]);
    expect(settingsStoreTestOnly.valueOrDefault(undefined, "fallback")).toBe("fallback");
    expect(settingsStoreTestOnly.valueOrDefault("value", "fallback")).toBe("value");
    expect(settingsStoreTestOnly.arrayOrEmpty("not-array")).toEqual([]);
    expect(settingsStoreTestOnly.arrayOrEmpty(["ok"])).toEqual(["ok"]);
    expect(settingsStoreTestOnly.normalizePmMaxVersionExceededModeSetting({ global: "warn" })).toEqual({ global: "warn" });
    expect(settingsStoreTestOnly.normalizePmMaxVersionExceededModeSetting({ project: "warn" })).toEqual({ project: "warn" });
    expect(settingsStoreTestOnly.normalizePmMaxVersionExceededModeSetting({ global: "warn", project: "block" })).toEqual({
      global: "warn",
      project: "block",
    });
    expect(
      normalizeItemTypeDefinitions([
        { name: "Zulu", folder: "z" },
        { name: "Alpha", folder: "a" },
      ] as never).map((definition) => definition.name),
    ).toEqual(["Alpha", "Zulu"]);
  });

  it("covers settings read-cache helper error and mismatch paths", async () => {
    const pmRoot = path.join(os.tmpdir(), "pm-settings-cache-helper");
    const trackedPath = path.join(pmRoot, "settings.json");
    const result = buildReadResult();

    const collectSpy = vi.spyOn(settingsReadCache, "collectSettingsReadCacheSignatures");
    collectSpy.mockRejectedValueOnce(new Error("collect failed"));
    await settingsStoreTestOnly.cacheSettingsReadResultSafe(pmRoot, [trackedPath], result);
    expect(settingsReadCache.getSettingsReadCacheEntry(pmRoot)).toBeUndefined();

    collectSpy.mockResolvedValueOnce([{ path: trackedPath, mtime_ms: 2, size: 2 }]);
    await settingsStoreTestOnly.cacheSettingsReadResultIfStable(
      pmRoot,
      [trackedPath],
      result,
      [{ path: trackedPath, mtime_ms: 1, size: 1 }],
      [trackedPath],
    );
    expect(settingsReadCache.getSettingsReadCacheEntry(pmRoot)).toBeUndefined();

    collectSpy.mockRejectedValueOnce(new Error("collect failed"));
    await settingsStoreTestOnly.cacheSettingsReadResultIfStable(
      pmRoot,
      [trackedPath],
      result,
      [{ path: trackedPath, mtime_ms: 1, size: 1 }],
      [trackedPath],
    );
    expect(settingsReadCache.getSettingsReadCacheEntry(pmRoot)).toBeUndefined();
  });

  it("retries on settings signature drift and clears cache on schema drift", async () => {
    await withTempPmRoot(async (pmRoot) => {
      const settingsPath = path.join(pmRoot, "settings.json");
      await fs.mkdir(path.dirname(settingsPath), { recursive: true });
      await fs.writeFile(settingsPath, `${JSON.stringify(SETTINGS_DEFAULTS, null, 2)}\n`, "utf8");
      await fs.mkdir(path.join(pmRoot, "schema"), { recursive: true });
      await fs.writeFile(path.join(pmRoot, "schema", "types.json"), `${JSON.stringify({ definitions: [] })}\n`, "utf8");
      await fs.writeFile(path.join(pmRoot, "schema", "statuses.json"), `${JSON.stringify({ statuses: [] })}\n`, "utf8");
      await fs.writeFile(path.join(pmRoot, "schema", "fields.json"), `${JSON.stringify({ fields: [] })}\n`, "utf8");
      await fs.writeFile(path.join(pmRoot, "schema", "workflows.json"), `${JSON.stringify({ workflow: {} })}\n`, "utf8");

      const collectSpy = vi.spyOn(settingsReadCache, "collectSettingsReadCacheSignatures");
      const signatureFor = (stamp: number) => [{ path: settingsPath, mtime_ms: stamp, size: stamp }];
      let call = 0;
      collectSpy.mockImplementation(async (paths) => {
        call += 1;
        if (call === 1) return signatureFor(1);
        if (call === 2) return signatureFor(2);
        if (call === 3) return signatureFor(2);
        if (call === 4) return signatureFor(2);
        if (call === 5) return signatureFor(3);
        if (call === 6) return signatureFor(4);
        return settingsReadCache.collectSettingsReadCacheSignatures(paths);
      });

      const read = await readSettingsWithMetadata(pmRoot);
      expect(read.settings.item_format).toBe("toon");
      expect(settingsReadCache.getSettingsReadCacheEntry(pmRoot)).toBeUndefined();
      expect(call).toBeGreaterThanOrEqual(6);
    });
  });

  it("reuses source-backed schema sections when source flags are present and unchanged", () => {
    const rawSettings = {
      ...structuredClone(SETTINGS_DEFAULTS),
      schema: {
        ...structuredClone(SETTINGS_DEFAULTS.schema),
        statuses: [{ id: "triaged", roles: ["active"] }],
        fields: [{ key: "severity", type: "string", commands: ["create", "update"] }],
        type_workflows: [{ type: "Task", statuses: ["triaged"] }],
      },
    };
    const merged = settingsStoreTestOnly.mergeSettings(rawSettings as never);
    const snapshot = settingsStoreTestOnly.buildSettingsPersistSourceSnapshot(rawSettings as never, merged);
    const persisted = settingsStoreTestOnly.resolvePersistedFileBackedSchemaSections(merged, snapshot);
    expect(persisted.schema_statuses).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "triaged" })]),
    );
    expect(persisted.schema_fields).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: "severity" })]),
    );
    expect(persisted.schema_type_workflows).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "Task" })]),
    );
  });

  it("emits legacy item_format warning branch", async () => {
    await withTempPmRoot(async (pmRoot) => {
      const settingsPath = path.join(pmRoot, "settings.json");
      await fs.mkdir(path.dirname(settingsPath), { recursive: true });
      await fs.writeFile(
        settingsPath,
        `${JSON.stringify({ ...SETTINGS_DEFAULTS, item_format: "json_markdown" }, null, 2)}\n`,
        "utf8",
      );
      const read = await readSettingsWithMetadata(pmRoot);
      expect(read.warnings).toContain("settings_item_format_legacy_json_markdown_coerced_to_toon");
    });
  });
});
