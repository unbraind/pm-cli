import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getWorkspaceHistoryPath } from "../../../../src/core/history/workspace-history.js";
import { SETTINGS_DEFAULTS } from "../../../../src/core/shared/constants.js";
import { getSettingsPath } from "../../../../src/core/store/paths.js";
import {
  isSettingsReadFallback,
  persistSelectedItemFormat,
  readSettings,
  readSettingsWithMetadata,
  writeSettings,
} from "../../../../src/core/store/settings.js";
import { validateSettings } from "../../../../src/core/store/settings-validator.js";
import { withTempRoot } from "../../../helpers/temp.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";

// pm-4zpq71: a write against a schema-invalid settings.json must never replace
// the stored document with the defaults fallback the read returned.

async function withSchemaInvalidSettings(
  run: (context: { pmRoot: string; settingsPath: string; original: string }) => Promise<void>,
): Promise<void> {
  await withTempRoot("pm-settings-fallback-", async (tempRoot) => {
    const pmRoot = path.join(tempRoot, ".agents", "pm");
    const settingsPath = getSettingsPath(pmRoot);
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    const stored = {
      ...JSON.parse(JSON.stringify(SETTINGS_DEFAULTS)),
      id_prefix: "acme-",
      author_default: "stored-author",
      context: { ...SETTINGS_DEFAULTS.context, next_ranking_policy: "bogus" },
      lint: { strict: true, rules: ["no-orphans"] },
    };
    const original = `${JSON.stringify(stored, null, 2)}\n`;
    await fs.writeFile(settingsPath, original, "utf8");
    await run({ pmRoot, settingsPath, original });
  });
}

describe("settings writes over a schema-invalid document", () => {
  it("refuses an unrelated change with the invalid field named and leaves file and history untouched", async () => {
    await withSchemaInvalidSettings(async ({ pmRoot, settingsPath, original }) => {
      const read = await readSettingsWithMetadata(pmRoot);
      expect(read.warnings).toEqual(["settings_read_invalid_schema"]);
      expect(read.settings.id_prefix).toBe(SETTINGS_DEFAULTS.id_prefix);

      read.settings.locks.ttl_seconds = 77;
      await expect(writeSettings(pmRoot, read.settings)).rejects.toMatchObject({
        code: "settings_write_invalid_existing_schema",
        exitCode: 2,
        context: {
          field: "context.next_ranking_policy",
          reason: "existing_settings_schema_invalid",
          original_code: "settings_read_invalid_schema",
        },
      });
      expect(await fs.readFile(settingsPath, "utf8")).toBe(original);
      await expect(fs.stat(getWorkspaceHistoryPath(pmRoot))).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("applies a change that repairs the invalid field while every unrelated stored key survives", async () => {
    await withSchemaInvalidSettings(async ({ pmRoot, settingsPath }) => {
      const settings = await readSettings(pmRoot);
      settings.context.next_ranking_policy = "weighted";
      await writeSettings(pmRoot, settings);

      const written = JSON.parse(await fs.readFile(settingsPath, "utf8")) as Record<string, unknown>;
      expect(written).toMatchObject({
        id_prefix: "acme-",
        author_default: "stored-author",
        context: { next_ranking_policy: "weighted" },
        lint: { strict: true, rules: ["no-orphans"] },
      });
      const reread = await readSettingsWithMetadata(pmRoot);
      expect(reread.warnings).toEqual([]);
      expect(reread.settings.id_prefix).toBe("acme-");
      expect(reread.settings.context.next_ranking_policy).toBe("weighted");
    });
  });

  it("keeps the protection on a cached fallback read", async () => {
    await withSchemaInvalidSettings(async ({ pmRoot, settingsPath, original }) => {
      await readSettings(pmRoot);
      const cached = await readSettings(pmRoot);
      cached.author_default = "replacement";
      await expect(writeSettings(pmRoot, cached)).rejects.toMatchObject({
        code: "settings_write_invalid_existing_schema",
      });
      expect(await fs.readFile(settingsPath, "utf8")).toBe(original);
    });
  });

  it("preserves a stored document that became valid after an unreadable read", async () => {
    await withSchemaInvalidSettings(async ({ pmRoot, settingsPath }) => {
      const settings = await readSettings(pmRoot);
      const repaired = JSON.parse(await fs.readFile(settingsPath, "utf8")) as Record<string, unknown>;
      (repaired.context as Record<string, unknown>).next_ranking_policy = "priority_floor";
      await fs.writeFile(settingsPath, `${JSON.stringify(repaired, null, 2)}\n`, "utf8");

      settings.locks.ttl_seconds = 91;
      await writeSettings(pmRoot, settings);

      const written = JSON.parse(await fs.readFile(settingsPath, "utf8")) as Record<string, unknown>;
      expect(written).toMatchObject({
        id_prefix: "acme-",
        locks: { ttl_seconds: 91 },
        context: { next_ranking_policy: "priority_floor" },
        lint: { strict: true },
      });
    });
  });

  it("applies the change onto an empty object when the stored root is not an object", async () => {
    await withTempRoot("pm-settings-fallback-", async (tempRoot) => {
      const pmRoot = path.join(tempRoot, ".agents", "pm");
      const settingsPath = getSettingsPath(pmRoot);
      await fs.mkdir(path.dirname(settingsPath), { recursive: true });
      await fs.writeFile(settingsPath, "[]\n", "utf8");
      const settings = await readSettings(pmRoot);
      settings.author_default = "x";
      await expect(writeSettings(pmRoot, settings)).rejects.toMatchObject({
        code: "settings_write_invalid_existing_schema",
        context: { field: "version" },
      });
      expect(await fs.readFile(settingsPath, "utf8")).toBe("[]\n");
    });
  });
});

describe("fallback identification", () => {
  it("marks only defaults returned for an unreadable document", async () => {
    await withSchemaInvalidSettings(async ({ pmRoot }) => {
      const fallback = await readSettings(pmRoot);
      expect(isSettingsReadFallback(fallback)).toBe(true);
      const caller = structuredClone(SETTINGS_DEFAULTS);
      expect(isSettingsReadFallback(caller)).toBe(false);
      // A caller-constructed object has no persist snapshot to pin into.
      persistSelectedItemFormat(caller);
      expect(caller).toEqual(SETTINGS_DEFAULTS);
    });
  });
});

describe("validateSettings failure paths", () => {
  it.each([
    ["a non-object root", [], ""],
    ["a nested object field", { ...SETTINGS_DEFAULTS, context: { ...SETTINGS_DEFAULTS.context, next_ranking_policy: 1 } }, "context.next_ranking_policy"],
    ["an array element", { ...SETTINGS_DEFAULTS, extensions: { ...SETTINGS_DEFAULTS.extensions, enabled: ["ok", 7] } }, "extensions.enabled.1"],
    [
      "a record entry",
      {
        ...SETTINGS_DEFAULTS,
        agent_identity: { harness_signals: [], identity_vocabulary: { version: 1, aliases: { codex: "Not Valid" } } },
      },
      "agent_identity.identity_vocabulary.aliases.codex",
    ],
  ])("names %s", (_label, raw, expectedPath) => {
    expect(validateSettings(raw)).toEqual({ success: false, path: expectedPath });
  });
});

describe("pm config over a schema-invalid settings.json", () => {
  it("refuses an unrelated set without writing and accepts the repairing set", async () => {
    await withTempPmPath(async (context) => {
      const settingsPath = path.join(context.pmPath, "settings.json");
      const stored = JSON.parse(await fs.readFile(settingsPath, "utf8")) as Record<string, unknown>;
      stored.id_prefix = "acme-";
      stored.lint = { strict: true };
      stored.context = { ...(stored.context as Record<string, unknown>), next_ranking_policy: "bogus" };
      const original = `${JSON.stringify(stored, null, 2)}\n`;
      await fs.writeFile(settingsPath, original, "utf8");

      const refused = context.runCli(["config", "project", "set", "locks.ttl_seconds", "120", "--json"]);
      expect(refused.code).toBe(2);
      expect(`${refused.stdout}${refused.stderr}`).toContain("settings_write_invalid_existing_schema");
      expect(`${refused.stdout}${refused.stderr}`).toContain("context.next_ranking_policy");
      expect(await fs.readFile(settingsPath, "utf8")).toBe(original);

      const repaired = context.runCli(["config", "project", "set", "context.next_ranking_policy", "weighted", "--json"]);
      expect(repaired.code, repaired.stderr).toBe(0);
      const written = JSON.parse(await fs.readFile(settingsPath, "utf8")) as Record<string, unknown>;
      expect(written).toMatchObject({
        id_prefix: "acme-",
        lint: { strict: true },
        context: { next_ranking_policy: "weighted" },
      });
    });
  });
});
