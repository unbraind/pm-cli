import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getWorkspaceHistoryPath, WORKSPACE_HISTORY_ID } from "../../../../src/core/history/workspace-history.js";
import { readHistoryEntries } from "../../../../src/core/history/read.js";
import {
  readSettingsSection,
  settingsSectionRevision,
  writeSettingsSection,
} from "../../../../src/core/store/settings-sections.js";
import { readSettings } from "../../../../src/core/store/settings.js";
import { createExtensionCommandSdk } from "../../../../src/sdk/extension-command-context.js";
import * as sdk from "../../../../src/sdk/index.js";
import { PmClient } from "../../../../src/sdk/runtime.js";
import { withTempRoot } from "../../../helpers/temp.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";

// pm-gh1580: extensions read and write their own settings section through the
// host instead of re-reading settings.json by path.

interface LintSettings {
  strict: boolean;
}

function parseLint(raw: unknown): LintSettings {
  if (typeof raw !== "object" || raw === null || typeof (raw as { strict?: unknown }).strict !== "boolean") {
    throw new Error("lint.strict must be a boolean");
  }
  return { strict: (raw as { strict: boolean }).strict };
}

async function addSection(pmPath: string, section: string, value: unknown): Promise<void> {
  const settingsPath = path.join(pmPath, "settings.json");
  const document = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
  document[section] = value;
  await writeFile(settingsPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
}

describe("readSettingsSection", () => {
  it("returns a stored, validated section with its revision while core reads strip it", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      await addSection(pmPath, "lint", { strict: true, extra: "kept" });

      const read = await readSettingsSection(pmPath, "lint", { validate: parseLint });

      expect(read).toEqual({
        section: "lint",
        source: "stored",
        value: { strict: true },
        revision: settingsSectionRevision({ strict: true, extra: "kept" }),
      });
      expect(read.revision).toMatch(/^sha256:[0-9a-f]{64}$/u);
      expect("lint" in (await readSettings(pmPath))).toBe(false);
    });
  });

  it("hashes the stored value before validation and gives the validator a detached copy", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      await addSection(pmPath, "lint", { strict: true });
      const normalizeInPlace = (raw: unknown): { strict: boolean; level: string } => {
        const record = raw as { strict: boolean; level?: string };
        record.level ??= "default";
        return record as { strict: boolean; level: string };
      };
      const read = await readSettingsSection(pmPath, "lint", { validate: normalizeInPlace });
      expect(read.value).toEqual({ strict: true, level: "default" });
      expect(read.revision).toBe(settingsSectionRevision({ strict: true }));
      await expect(
        writeSettingsSection(pmPath, "lint", { strict: false }, { expectedRevision: read.revision }),
      ).resolves.toMatchObject({ changed: true, previous_revision: read.revision });
    });
  });

  it("returns the default, unvalidated, for an absent section or a missing settings file", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      await expect(readSettingsSection(pmPath, "lint", { defaultValue: { strict: false } })).resolves.toEqual({
        section: "lint",
        source: "default",
        value: { strict: false },
        revision: null,
      });
      await rm(path.join(pmPath, "settings.json"));
      await expect(readSettingsSection(pmPath, "lint")).resolves.toMatchObject({ source: "default", value: undefined });
    });
  });

  it("refuses an invalid stored section with a typed, bounded diagnostic", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      await addSection(pmPath, "lint", { strict: "yes" });
      await expect(readSettingsSection(pmPath, "lint", { validate: parseLint })).rejects.toMatchObject({
        exitCode: 2,
        context: { code: "settings_section_invalid", field: "lint" },
        message: 'Settings section "lint" is invalid: lint.strict must be a boolean',
      });
    });
  });

  it.each([
    ["malformed JSON", "{ nope", "settings_json_malformed"],
    ["a non-object root", "[1]\n", "settings_json_not_object"],
  ])("refuses %s instead of throwing a parse error", async (_label, raw, reason) => {
    await withTempPmPath(async ({ pmPath }) => {
      await writeFile(path.join(pmPath, "settings.json"), raw, "utf8");
      await expect(readSettingsSection(pmPath, "lint")).rejects.toMatchObject({
        context: { code: "settings_section_document_malformed", reason },
      });
    });
  });

  it.each([
    ["Lint", "settings_section_name_invalid"],
    ["9lint", "settings_section_name_invalid"],
    ["constructor", "settings_section_name_invalid"],
    ["locks", "settings_section_reserved"],
    ["context", "settings_section_reserved"],
  ])("refuses the section name %s", async (section, code) => {
    await withTempPmPath(async ({ pmPath }) => {
      await expect(readSettingsSection(pmPath, section)).rejects.toMatchObject({ exitCode: 2, context: { code } });
      await expect(writeSettingsSection(pmPath, section, {})).rejects.toMatchObject({ context: { code } });
    });
  });
});

describe("writeSettingsSection", () => {
  it("adds, replaces and removes a section, keeping every other key and recording history", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const settingsPath = path.join(pmPath, "settings.json");
      const before = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;

      const added = await writeSettingsSection(pmPath, "lint", { strict: true }, { expectedRevision: null, validate: parseLint });
      expect(added).toEqual({
        section: "lint",
        changed: true,
        previous_revision: null,
        revision: settingsSectionRevision({ strict: true }),
      });
      const replaced = await writeSettingsSection(pmPath, "lint", { strict: false }, { expectedRevision: added.revision });
      expect(replaced).toMatchObject({ changed: true, previous_revision: added.revision });

      const document = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
      expect(document.lint).toEqual({ strict: false });
      expect({ ...document, lint: undefined }).toEqual({ ...before, lint: undefined });

      const removed = await writeSettingsSection(pmPath, "lint", undefined);
      expect(removed).toMatchObject({ changed: true, revision: null });
      expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual(before);

      const history = await readHistoryEntries(getWorkspaceHistoryPath(pmPath), WORKSPACE_HISTORY_ID);
      expect(history.filter((entry) => entry.op === "settings:section:write")).toHaveLength(3);
    });
  });

  it("writes nothing for an unchanged value", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      await writeSettingsSection(pmPath, "lint", { strict: true });
      const settingsPath = path.join(pmPath, "settings.json");
      const bytes = await readFile(settingsPath, "utf8");
      const again = await writeSettingsSection(pmPath, "lint", { strict: true });
      expect(again.changed).toBe(false);
      expect(await readFile(settingsPath, "utf8")).toBe(bytes);
      await expect(writeSettingsSection(pmPath, "absent", undefined)).resolves.toMatchObject({
        changed: false,
        previous_revision: null,
        revision: null,
      });
    });
  });

  it("keeps ordinary revisions stable and distinguishes values that differ only beneath a __proto__ key", async () => {
    expect(settingsSectionRevision({ b: [1, "x"], a: true })).toBe(
      `sha256:${createHash("sha256").update('{"a":true,"b":[1,"x"]}').digest("hex")}`,
    );
    const first = JSON.parse('{"__proto__":{"x":1}}') as unknown;
    const second = JSON.parse('{"__proto__":{"x":2}}') as unknown;
    expect(settingsSectionRevision(first)).not.toBe(settingsSectionRevision(second));

    // A hand-edited document can hold such a key; a concurrent edit beneath it
    // must still fail the stale compare-and-set write.
    await withTempPmPath(async ({ pmPath }) => {
      const settingsPath = path.join(pmPath, "settings.json");
      const original = await readFile(settingsPath, "utf8");
      const withSection = (inner: number): string =>
        `${original.trimEnd().replace(/\}$/u, `,"jev":{"__proto__":{"x":${inner}}}}`)}\n`;
      await writeFile(settingsPath, withSection(1), "utf8");
      const stale = await readSettingsSection(pmPath, "jev");
      await writeFile(settingsPath, withSection(2), "utf8");
      await expect(
        writeSettingsSection(pmPath, "jev", { replaced: true }, { expectedRevision: stale.revision }),
      ).rejects.toMatchObject({ context: { code: "settings_section_revision_conflict" } });
      expect(await readFile(settingsPath, "utf8")).toBe(withSection(2));
    });
  });

  it.each([
    ["an own __proto__ key", '{"strict":true,"nested":{"__proto__":{"x":1}}}', "nested.__proto__"],
    ["prototype beneath constructor", '{"constructor":{"prototype":{"x":1}}}', "constructor.prototype"],
  ])("refuses %s with a typed refusal instead of an untyped history failure", async (_label, json, keyPath) => {
    await withTempPmPath(async ({ pmPath }) => {
      await expect(writeSettingsSection(pmPath, "jev", JSON.parse(json) as unknown)).rejects.toMatchObject({
        context: { code: "settings_section_invalid", field: "jev" },
        message: `Settings section "jev" is invalid: ${keyPath} is a reserved key that settings history cannot record`,
      });
    });
  });

  it("refuses a stale compare-and-set write and leaves the section unchanged", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const first = await writeSettingsSection(pmPath, "lint", { strict: true });
      await writeSettingsSection(pmPath, "lint", { strict: false });

      await expect(
        writeSettingsSection(pmPath, "lint", { strict: true }, { expectedRevision: first.revision }),
      ).rejects.toMatchObject({
        exitCode: 4,
        context: {
          code: "settings_section_revision_conflict",
          expected_revision: first.revision,
          current_revision: settingsSectionRevision({ strict: false }),
        },
      });
      await expect(writeSettingsSection(pmPath, "lint", { strict: true }, { expectedRevision: null })).rejects.toMatchObject({
        context: { code: "settings_section_revision_conflict", expected_revision: null },
      });
      expect((await readSettingsSection(pmPath, "lint")).value).toEqual({ strict: false });
    });
  });

  it("refuses values the validator or JSON cannot accept before taking the lock", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      await expect(writeSettingsSection(pmPath, "lint", { strict: 1 }, { validate: parseLint })).rejects.toMatchObject({
        context: { code: "settings_section_invalid" },
      });
      await expect(writeSettingsSection(pmPath, "lint", () => undefined)).rejects.toMatchObject({
        context: { code: "settings_section_invalid" },
        message: expect.stringContaining("not representable as JSON") as unknown as string,
      });
      await expect(writeSettingsSection(pmPath, "lint", { size: 1n })).rejects.toMatchObject({
        context: { code: "settings_section_invalid" },
      });
    });
  });

  it.each([
    ["a non-finite number", { limit: Infinity }, "limit is a non-finite number"],
    ["a nested NaN", { thresholds: [1, Number.NaN] }, "thresholds.1 is a non-finite number"],
    ["an undefined array element", [1, undefined], "1 is undefined"],
    ["a function-valued key", { strict: true, hook: () => true }, "hook is function"],
    ["a non-plain object", { since: new Date(0) }, "since is not a plain JSON object"],
    ["a symbol key", { strict: true, [Symbol("hidden")]: 1 }, "the value is not a plain JSON object"],
    ["an array with a toJSON hook", { rules: Object.assign(["a"], { toJSON: () => ({ replaced: true }) }) }, "rules is not a plain JSON array"],
    ["an array with an extra key", { rules: Object.assign(["a"], { note: "dropped" }) }, "rules is not a plain JSON array"],
    ["a sparse array", { rules: Object.assign(new Array<number>(3), { 0: 1, 2: 3 }) }, "rules is not a plain JSON array"],
    ["an array subclass", { rules: new (class Rules extends Array<string> {})() }, "rules is not a plain JSON array"],
    ["an array with a symbol key", { rules: Object.assign(["a"], { [Symbol("hidden")]: 1 }) }, "rules is not a plain JSON array"],
    [
      "an array whose toJSON hook deletes itself",
      (() => {
        const rules: string[] & { toJSON?: () => unknown } = ["a"];
        rules.toJSON = () => {
          delete rules.toJSON;
          return { replaced: true };
        };
        return { rules };
      })(),
      "rules is not a plain JSON array",
    ],
    [
      "a hidden non-enumerable array property",
      { rules: Object.defineProperty(["a"], "strict", { value: true, enumerable: false }) },
      "rules is not a plain JSON array",
    ],
    [
      "an array element backed by a getter",
      { rules: Object.defineProperty(["a"], "0", { get: () => "computed", enumerable: true }) },
      "rules is not a plain JSON array",
    ],
    [
      "a getter-backed value",
      Object.defineProperty({ strict: true }, "level", { get: () => "computed", enumerable: true }),
      "the value is not a plain JSON object",
    ],
    [
      "a self-removing toJSON getter that rewrites a validated field",
      (() => {
        const value: Record<string, unknown> = { strict: true };
        Object.defineProperty(value, "toJSON", {
          configurable: true,
          get: () => {
            delete value.toJSON;
            value.strict = false;
            return undefined;
          },
        });
        return value;
      })(),
      "the value is not a plain JSON object",
    ],
    [
      "a non-enumerable data property JSON would drop",
      Object.defineProperty({ strict: true }, "level", { value: "critical", enumerable: false }),
      "the value is not a plain JSON object",
    ],
    [
      "an object with a non-enumerable toJSON hook",
      Object.defineProperty({ strict: true }, "toJSON", { value: () => "replaced", enumerable: false }),
      "the value is not a plain JSON object",
    ],
  ])("refuses %s instead of storing a different value than it validated", async (_label, value, detail) => {
    await withTempPmPath(async ({ pmPath }) => {
      const settingsPath = path.join(pmPath, "settings.json");
      const before = await readFile(settingsPath, "utf8");
      await expect(writeSettingsSection(pmPath, "lint", value)).rejects.toMatchObject({
        context: { code: "settings_section_invalid", field: "lint" },
        message: `Settings section "lint" is invalid: the value would change when stored as JSON: ${detail}`,
      });
      expect(await readFile(settingsPath, "utf8")).toBe(before);
    });
  });

  it("refuses a circular value as not representable without serializing it", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const value: Record<string, unknown> = { strict: true };
      value.self = { parent: value };
      await expect(writeSettingsSection(pmPath, "lint", value)).rejects.toMatchObject({
        context: { code: "settings_section_invalid" },
        message: 'Settings section "lint" is invalid: the value is not representable as JSON: self.parent is a circular reference',
      });
    });
  });

  it("stores a data key named toJSON as ordinary JSON", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      await writeSettingsSection(pmPath, "lint", { toJSON: "kept", strict: true });
      expect((await readSettingsSection(pmPath, "lint")).value).toEqual({ toJSON: "kept", strict: true });
    });
  });

  it("stores a null-prototype object and nested plain JSON exactly", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const value = Object.assign(Object.create(null) as Record<string, unknown>, {
        strict: true,
        rules: [{ id: "a", weight: 0.5 }, null, "b"],
      });
      await writeSettingsSection(pmPath, "lint", value);
      expect((await readSettingsSection(pmPath, "lint")).value).toEqual({
        strict: true,
        rules: [{ id: "a", weight: 0.5 }, null, "b"],
      });
    });
  });

  it("refuses to create settings.json for an uninitialized tracker", async () => {
    await withTempRoot("pm-settings-section-", async (tempRoot) => {
      const pmRoot = path.join(tempRoot, ".agents", "pm");
      await mkdir(pmRoot, { recursive: true });
      await expect(writeSettingsSection(pmRoot, "lint", { strict: true })).rejects.toMatchObject({
        exitCode: 3,
        context: { code: "settings_section_document_missing" },
      });
    });
  });
});

describe("settings sections on the public and host-bound SDK", () => {
  it("exports the primitives and binds them to the invocation tracker", async () => {
    expect(sdk.readSettingsSection).toBe(readSettingsSection);
    expect(sdk.writeSettingsSection).toBe(writeSettingsSection);
    expect(sdk.settingsSectionRevision).toBe(settingsSectionRevision);
    await withTempPmPath(async ({ pmPath }) => {
      const bound = createExtensionCommandSdk(
        pmPath,
        new PmClient({ pmRoot: pmPath, noExtensions: true }),
        "invocation-author",
      );
      const written = await bound.writeSettingsSection("jev", { calibration: 0.5 });
      await expect(bound.readSettingsSection("jev")).resolves.toEqual({
        section: "jev",
        source: "stored",
        value: { calibration: 0.5 },
        revision: written.revision,
      });
      await writeSettingsSection(pmPath, "jev", { calibration: 0.7 }, { author: "explicit-author" });
      const authors = (await readHistoryEntries(getWorkspaceHistoryPath(pmPath), WORKSPACE_HISTORY_ID))
        .filter((entry) => entry.op === "settings:section:write")
        .map((entry) => entry.author);
      expect(authors).toEqual(["invocation-author", "explicit-author"]);
    });
  });
});
