import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runConfig } from "../../../../src/cli/commands/workspace/config.js";
import { getWorkspaceHistoryPath } from "../../../../src/core/history/workspace-history.js";
import { SETTINGS_DEFAULTS } from "../../../../src/core/shared/constants.js";
import { canonicalDocument, serializeItemDocument } from "../../../../src/core/item/item-format.js";
import { getItemPath, getSettingsPath } from "../../../../src/core/store/paths.js";
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

describe("explicit repairs to the default value", () => {
  it("refuses a snapshot-only repair to the default and applies it once the path is assigned", async () => {
    await withSchemaInvalidSettings(async ({ pmRoot, settingsPath, original }) => {
      const settings = await readSettings(pmRoot);
      settings.context.next_ranking_policy = SETTINGS_DEFAULTS.context.next_ranking_policy;
      await expect(writeSettings(pmRoot, settings)).rejects.toMatchObject({
        code: "settings_write_invalid_existing_schema",
        context: { field: "context.next_ranking_policy" },
      });
      expect(await fs.readFile(settingsPath, "utf8")).toBe(original);
      await expect(fs.stat(getWorkspaceHistoryPath(pmRoot))).rejects.toMatchObject({ code: "ENOENT" });

      await writeSettings(pmRoot, settings, undefined, {
        assignedPaths: ["context.next_ranking_policy", "lint.strict", "context.not_a_setting"],
      });
      const written = JSON.parse(await fs.readFile(settingsPath, "utf8")) as Record<string, unknown>;
      expect(written).toMatchObject({
        id_prefix: "acme-",
        author_default: "stored-author",
        context: { next_ranking_policy: SETTINGS_DEFAULTS.context.next_ranking_policy },
        lint: { strict: true, rules: ["no-orphans"] },
      });
      expect((written.context as Record<string, unknown>).not_a_setting).toBeUndefined();
      expect((await readSettingsWithMetadata(pmRoot)).warnings).toEqual([]);
    });
  });

  it("applies an assigned default through a cached read", async () => {
    await withSchemaInvalidSettings(async ({ pmRoot, settingsPath }) => {
      await readSettings(pmRoot);
      const cached = await readSettings(pmRoot);
      await writeSettings(pmRoot, cached, undefined, { assignedPaths: ["context.next_ranking_policy"] });
      const written = JSON.parse(await fs.readFile(settingsPath, "utf8")) as Record<string, unknown>;
      expect(written).toMatchObject({ id_prefix: "acme-", context: { next_ranking_policy: "priority_floor" } });
    });
  });

  it("still refuses an unrelated write whose assigned path leaves the invalid field alone", async () => {
    await withSchemaInvalidSettings(async ({ pmRoot, settingsPath, original }) => {
      const settings = await readSettings(pmRoot);
      settings.locks.ttl_seconds = 61;
      await expect(
        writeSettings(pmRoot, settings, undefined, { assignedPaths: ["locks.ttl_seconds"] }),
      ).rejects.toMatchObject({ code: "settings_write_invalid_existing_schema" });
      expect(await fs.readFile(settingsPath, "utf8")).toBe(original);
    });
  });

  it("still refuses an assigned repair when the document stays invalid elsewhere", async () => {
    await withTempRoot("pm-settings-fallback-", async (tempRoot) => {
      const pmRoot = path.join(tempRoot, ".agents", "pm");
      const settingsPath = getSettingsPath(pmRoot);
      await fs.mkdir(path.dirname(settingsPath), { recursive: true });
      await fs.writeFile(settingsPath, "[]\n", "utf8");
      const settings = await readSettings(pmRoot);
      // The omitted governance.create_default_type has no stored parent to clear.
      await expect(
        writeSettings(pmRoot, settings, undefined, {
          assignedPaths: ["context.next_ranking_policy", "governance.create_default_type"],
        }),
      ).rejects.toMatchObject({ code: "settings_write_invalid_existing_schema", context: { field: "version" } });
      expect(await fs.readFile(settingsPath, "utf8")).toBe("[]\n");
    });
  });

  it("replaces a scalar parent with an object to apply an assigned path", async () => {
    await withTempRoot("pm-settings-fallback-", async (tempRoot) => {
      const pmRoot = path.join(tempRoot, ".agents", "pm");
      const settingsPath = getSettingsPath(pmRoot);
      await fs.mkdir(path.dirname(settingsPath), { recursive: true });
      const stored = { ...JSON.parse(JSON.stringify(SETTINGS_DEFAULTS)), id_prefix: "acme-", context: "bogus" };
      await fs.writeFile(settingsPath, `${JSON.stringify(stored, null, 2)}\n`, "utf8");
      const settings = await readSettings(pmRoot);
      expect(isSettingsReadFallback(settings)).toBe(true);
      await writeSettings(pmRoot, settings, undefined, {
        assignedPaths: Object.keys(SETTINGS_DEFAULTS.context).map((key) => `context.${key}`),
      });
      const written = JSON.parse(await fs.readFile(settingsPath, "utf8")) as Record<string, unknown>;
      expect(written).toMatchObject({ id_prefix: "acme-", context: { next_ranking_policy: "priority_floor" } });
      expect((await readSettingsWithMetadata(pmRoot)).warnings).toEqual([]);
    });
  });

  it("measures a second write from the same fallback object from what it last wrote, keeping a peer's edit", async () => {
    await withSchemaInvalidSettings(async ({ pmRoot, settingsPath }) => {
      const settings = await readSettings(pmRoot);
      settings.context.next_ranking_policy = "weighted";
      await writeSettings(pmRoot, settings);

      const peer = await readSettings(pmRoot);
      expect(isSettingsReadFallback(peer)).toBe(false);
      peer.context.next_ranking_policy = "priority_floor";
      await writeSettings(pmRoot, peer);

      settings.locks.ttl_seconds = 93;
      await writeSettings(pmRoot, settings);
      const written = JSON.parse(await fs.readFile(settingsPath, "utf8")) as Record<string, unknown>;
      expect(written).toMatchObject({
        id_prefix: "acme-",
        locks: { ttl_seconds: 93 },
        context: { next_ranking_policy: "priority_floor" },
      });
    });
  });

  it.each(["", "context..next_ranking_policy", "__proto__.polluted", "context.next ranking"])(
    "refuses the assigned path %j before reading or writing",
    async (assignedPath) => {
      await withSchemaInvalidSettings(async ({ pmRoot, settingsPath, original }) => {
        const settings = await readSettings(pmRoot);
        await expect(writeSettings(pmRoot, settings, undefined, { assignedPaths: [assignedPath] })).rejects.toMatchObject({
          code: "settings_write_assigned_path_invalid",
          exitCode: 2,
          context: { field: assignedPath, reason: "assigned_path_segment_invalid" },
        });
        expect(await fs.readFile(settingsPath, "utf8")).toBe(original);
      });
    },
  );

  it("ignores assigned paths on a readable document", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const settings = await readSettings(pmPath);
      settings.author_default = "assigned";
      await writeSettings(pmPath, settings, undefined, { assignedPaths: ["author_default"] });
      expect((await readSettings(pmPath)).author_default).toBe("assigned");
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

async function writeLegacyMarkdownTask(pmPath: string, id: string): Promise<{ markdownPath: string; toonPath: string }> {
  const markdownPath = getItemPath(pmPath, "Task", id, "json_markdown");
  await fs.mkdir(path.dirname(markdownPath), { recursive: true });
  const document = canonicalDocument({
    metadata: {
      id,
      title: `Legacy ${id}`,
      description: "legacy markdown item",
      type: "Task",
      status: "open",
      priority: 1,
      tags: [],
      created_at: "2026-03-31T00:00:00.000Z",
      updated_at: "2026-03-31T00:00:00.000Z",
    },
    body: "legacy body",
  });
  await fs.writeFile(markdownPath, serializeItemDocument(document, { format: "json_markdown" }), "utf8");
  return { markdownPath, toonPath: getItemPath(pmPath, "Task", id, "toon") };
}

describe("runConfig repairs over a schema-invalid settings.json (in process)", () => {
  const global = { json: true, quiet: false, profile: false };

  it("reports changed: true when a policy setter repairs its own field to the default", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const settingsPath = path.join(pmPath, "settings.json");
      const stored = JSON.parse(await fs.readFile(settingsPath, "utf8")) as Record<string, Record<string, unknown>>;
      stored.validation = { ...stored.validation, sprint_release_format: "bogus" };
      await fs.writeFile(settingsPath, `${JSON.stringify(stored, null, 2)}\n`, "utf8");

      const result = await runConfig("project", "set", "sprint_release_format_policy", { policy: "warn" }, { ...global, path: pmPath });
      expect(result.changed).toBe(true);
      const written = JSON.parse(await fs.readFile(settingsPath, "utf8")) as Record<string, Record<string, unknown>>;
      expect(written.validation.sprint_release_format).toBe("warn");
    });
  });

  it("refuses an item_format change before migrating when the document stays invalid elsewhere", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const settingsPath = path.join(pmPath, "settings.json");
      const stored = JSON.parse(await fs.readFile(settingsPath, "utf8")) as Record<string, unknown>;
      delete stored.item_format;
      stored.context = { ...(stored.context as Record<string, unknown>), next_ranking_policy: "bogus" };
      await fs.writeFile(settingsPath, `${JSON.stringify(stored, null, 2)}\n`, "utf8");
      const { markdownPath } = await writeLegacyMarkdownTask(pmPath, "pm-legacy3");

      await expect(
        runConfig("project", "set", "item_format", { format: "toon" }, { ...global, path: pmPath }),
      ).rejects.toMatchObject({ code: "settings_write_invalid_existing_schema" });
      await expect(fs.stat(markdownPath)).resolves.toBeDefined();
    });
  });

  it("repairs an invalid item_format, then migrates items with the repaired document", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const settingsPath = path.join(pmPath, "settings.json");
      const stored = JSON.parse(await fs.readFile(settingsPath, "utf8")) as Record<string, unknown>;
      stored.item_format = "bogus";
      await fs.writeFile(settingsPath, `${JSON.stringify(stored, null, 2)}\n`, "utf8");
      const { markdownPath, toonPath } = await writeLegacyMarkdownTask(pmPath, "pm-legacy4");

      const result = await runConfig("project", "set", "item_format", { format: "toon" }, { ...global, path: pmPath });
      expect(result).toMatchObject({ changed: true, format: "toon", migration: { migrated: ["pm-legacy4"] } });
      await expect(fs.stat(markdownPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.stat(toonPath)).resolves.toBeDefined();
    });
  });
});

describe("pm config item_format over a schema-invalid settings.json", () => {
  it("refuses before migrating any item when the document stays invalid elsewhere", async () => {
    await withTempPmPath(async (context) => {
      const settingsPath = path.join(context.pmPath, "settings.json");
      const stored = JSON.parse(await fs.readFile(settingsPath, "utf8")) as Record<string, unknown>;
      delete stored.item_format;
      stored.context = { ...(stored.context as Record<string, unknown>), next_ranking_policy: "bogus" };
      const original = `${JSON.stringify(stored, null, 2)}\n`;
      await fs.writeFile(settingsPath, original, "utf8");
      const { markdownPath, toonPath } = await writeLegacyMarkdownTask(context.pmPath, "pm-legacy1");
      const markdown = await fs.readFile(markdownPath, "utf8");

      const result = context.runCli(["config", "project", "set", "item_format", "toon", "--json"]);
      expect(result.code).toBe(2);
      expect(`${result.stdout}${result.stderr}`).toContain("settings_write_invalid_existing_schema");
      expect(await fs.readFile(settingsPath, "utf8")).toBe(original);
      expect(await fs.readFile(markdownPath, "utf8")).toBe(markdown);
      await expect(fs.stat(toonPath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("repairs an invalid item_format first, then migrates items with the repaired document", async () => {
    await withTempPmPath(async (context) => {
      const settingsPath = path.join(context.pmPath, "settings.json");
      const stored = JSON.parse(await fs.readFile(settingsPath, "utf8")) as Record<string, unknown>;
      stored.id_prefix = "acme-";
      stored.item_format = "bogus";
      await fs.writeFile(settingsPath, `${JSON.stringify(stored, null, 2)}\n`, "utf8");
      const { markdownPath, toonPath } = await writeLegacyMarkdownTask(context.pmPath, "pm-legacy2");

      const result = context.runCli(["config", "project", "set", "item_format", "toon", "--json"], { expectJson: true });
      expect(result.code, `${result.stdout}${result.stderr}`).toBe(0);
      expect(result.json).toMatchObject({ changed: true, format: "toon", migration: { migrated: ["pm-legacy2"] } });
      const written = JSON.parse(await fs.readFile(settingsPath, "utf8")) as Record<string, unknown>;
      expect(written).toMatchObject({ id_prefix: "acme-", item_format: "toon" });
      await expect(fs.stat(markdownPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.stat(toonPath)).resolves.toBeDefined();
    });
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

  it("repairs to the default value with changed: true and keeps unrelated keys", async () => {
    await withTempPmPath(async (context) => {
      const settingsPath = path.join(context.pmPath, "settings.json");
      const stored = JSON.parse(await fs.readFile(settingsPath, "utf8")) as Record<string, unknown>;
      stored.id_prefix = "acme-";
      stored.lint = { strict: true };
      stored.context = { ...(stored.context as Record<string, unknown>), next_ranking_policy: "bogus" };
      await fs.writeFile(settingsPath, `${JSON.stringify(stored, null, 2)}\n`, "utf8");

      const repaired = context.runCli(
        ["config", "project", "set", "context.next_ranking_policy", "priority_floor", "--json"],
        { expectJson: true },
      );
      expect(repaired.code, repaired.stderr).toBe(0);
      expect(repaired.json).toMatchObject({ changed: true, nested_setting: { path: "context.next_ranking_policy", value: "priority_floor" } });
      const written = JSON.parse(await fs.readFile(settingsPath, "utf8")) as Record<string, unknown>;
      expect(written).toMatchObject({
        id_prefix: "acme-",
        lint: { strict: true },
        context: { next_ranking_policy: "priority_floor" },
      });
    });
  });

  it.each([
    ["a policy setter", ["sprint_release_format_policy", "warn"], "validation", "sprint_release_format", "warn"],
    ["the context setter", ["context", "--stale-threshold-days", "7"], "context", "stale_threshold_days", 7],
  ])("repairs its own field to the default through %s", async (_label, args, section, key, expected) => {
    await withTempPmPath(async (context) => {
      const settingsPath = path.join(context.pmPath, "settings.json");
      const stored = JSON.parse(await fs.readFile(settingsPath, "utf8")) as Record<string, Record<string, unknown>>;
      stored.id_prefix = "acme-" as never;
      stored[section] = { ...stored[section], [key]: "bogus" };
      await fs.writeFile(settingsPath, `${JSON.stringify(stored, null, 2)}\n`, "utf8");

      const result = context.runCli(["config", "project", "set", ...args, "--json"], { expectJson: true });
      expect(result.code, `${result.stdout}${result.stderr}`).toBe(0);
      // The repair is a change even though the value equals the fallback default.
      expect(result.json).toMatchObject({ changed: true });
      const written = JSON.parse(await fs.readFile(settingsPath, "utf8")) as Record<string, Record<string, unknown>>;
      expect(written.id_prefix).toBe("acme-");
      expect(written[section][key]).toBe(expected);
    });
  });

  it.each([
    ["repairs a default-valued key that serialization omits", ["governance_require_close_reason", "enabled"], "require_close_reason", "yes"],
    ["clears an invalid key with an empty value", ["governance_create_default_type", ""], "create_default_type", 42],
  ])("%s by removing the stored value", async (_label, args, key, invalid) => {
    await withTempPmPath(async (context) => {
      const settingsPath = path.join(context.pmPath, "settings.json");
      const stored = JSON.parse(await fs.readFile(settingsPath, "utf8")) as Record<string, Record<string, unknown>>;
      stored.id_prefix = "acme-" as never;
      stored.governance = { ...stored.governance, [key]: invalid };
      await fs.writeFile(settingsPath, `${JSON.stringify(stored, null, 2)}\n`, "utf8");

      const result = context.runCli(["config", "project", "set", ...args, "--json"], { expectJson: true });
      expect(result.code, `${result.stdout}${result.stderr}`).toBe(0);
      expect(result.json).toMatchObject({ changed: true });
      const written = JSON.parse(await fs.readFile(settingsPath, "utf8")) as Record<string, Record<string, unknown>>;
      expect(written.id_prefix).toBe("acme-");
      expect(written.governance).not.toHaveProperty(key);
      const reread = await readSettingsWithMetadata(context.pmPath);
      expect(reread.warnings).toEqual([]);
    });
  });

  it("never clears an extension-owned section through an assigned path the core settings omit", async () => {
    await withSchemaInvalidSettings(async ({ pmRoot, settingsPath }) => {
      const settings = await readSettings(pmRoot);
      settings.context.next_ranking_policy = "weighted";
      await writeSettings(pmRoot, settings, undefined, { assignedPaths: ["lint", "context.next_ranking_policy"] });
      const written = JSON.parse(await fs.readFile(settingsPath, "utf8")) as Record<string, unknown>;
      expect(written).toMatchObject({ lint: { strict: true, rules: ["no-orphans"] }, context: { next_ranking_policy: "weighted" } });
    });
  });

  it.each([
    ["a policy setter", ["sprint_release_format_policy", "warn"]],
    ["the context setter", ["context", "--stale-threshold-days", "7"]],
  ])("refuses instead of a silent no-op when %s keeps the default of a different field", async (_label, args) => {
    await withTempPmPath(async (context) => {
      const settingsPath = path.join(context.pmPath, "settings.json");
      const stored = JSON.parse(await fs.readFile(settingsPath, "utf8")) as Record<string, unknown>;
      stored.context = { ...(stored.context as Record<string, unknown>), next_ranking_policy: "bogus" };
      const original = `${JSON.stringify(stored, null, 2)}\n`;
      await fs.writeFile(settingsPath, original, "utf8");

      const result = context.runCli(["config", "project", "set", ...args, "--json"]);
      expect(result.code).toBe(2);
      expect(`${result.stdout}${result.stderr}`).toContain("settings_write_invalid_existing_schema");
      expect(await fs.readFile(settingsPath, "utf8")).toBe(original);
    });
  });
});
