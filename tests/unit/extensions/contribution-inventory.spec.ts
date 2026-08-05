import { describe, expect, it } from "vitest";
import {
  createExtensionContributionInventory,
  normalizeExtensionContributionInventory,
} from "../../../src/core/extensions/contribution-inventory.js";
import { _testOnlyLoader } from "../../../src/core/extensions/loader.js";
import {
  createEmptyManagedExtensionState,
  normalizeManagedState,
  persistManagedContributionInventory,
} from "../../../src/sdk/extension/managed-state.js";

describe("static extension contribution inventory", () => {
  it("normalizes command paths and rejects malformed versioned inventories", () => {
    expect(
      normalizeExtensionContributionInventory({
        schema_version: 1,
        commands: ["  Foo   Bar ", "foo bar"],
        hooks: ["zeta", "before_command"],
        renderer_ownership: [
          {
            format: "json",
            commands: ["List Open"],
            result_discriminator: false,
          },
        ],
        preflight_overrides: 1,
        preflight_ownership: [
          { commands: ["Zulu", "Create", " create ", " "] },
          { commands: [] },
        ],
      }),
    ).toEqual({
      schema_version: 1,
      commands: ["foo bar"],
      hooks: ["before_command", "zeta"],
      renderer_ownership: [
        {
          format: "json",
          commands: ["list open"],
          result_discriminator: false,
        },
      ],
      preflight_overrides: 1,
      preflight_ownership: [
        { commands: ["create", "zulu"] },
        { commands: [] },
      ],
    });
    expect(
      normalizeExtensionContributionInventory({
        schema_version: 2,
        commands: [],
      }),
    ).toBeNull();
    expect(
      normalizeExtensionContributionInventory({
        schema_version: 1,
        preflight_overrides: -1,
      }),
    ).toBeNull();
    for (const malformed of [
      undefined,
      null,
      [],
      { schema_version: 1, commands: "not-an-array" },
      { schema_version: 1, hooks: [1] },
      { schema_version: 1, renderer_ownership: "not-an-array" },
      { schema_version: 1, renderer_ownership: [null] },
      { schema_version: 1, preflight_ownership: "not-an-array" },
      { schema_version: 1, preflight_ownership: [null] },
      { schema_version: 1, preflight_ownership: [{ commands: [1] }] },
      {
        schema_version: 1,
        renderer_ownership: [
          { format: "yaml", commands: [], result_discriminator: false },
        ],
      },
      { schema_version: 1, preflight_overrides: 1.5 },
    ]) {
      const normalized = normalizeExtensionContributionInventory(malformed);
      if (malformed === undefined || malformed === null) {
        expect(normalized).toBeUndefined();
      } else {
        expect(normalized).toBeNull();
      }
    }
    expect(
      normalizeExtensionContributionInventory({
        schema_version: 1,
        renderer_ownership: [
          {
            format: "toon",
            commands: ["Zulu", "alpha"],
            result_discriminator: true,
          },
          {
            format: "json",
            commands: [],
            result_discriminator: false,
          },
        ],
      }),
    ).toMatchObject({
      renderer_ownership: [
        { format: "json" },
        { format: "toon", commands: ["alpha", "zulu"] },
      ],
    });
    expect(
      _testOnlyLoader.parseManifest({
        name: "bad-contributions",
        version: "1.0.0",
        entry: "index.mjs",
        contributions: { schema_version: 1, commands: [1] },
      }),
    ).toBeNull();
    expect(
      normalizeManagedState({
        version: 1,
        entries: [
          {
            name: "bad-contributions",
            directory: "bad-contributions",
            scope: "project",
            manifest_version: "1.0.0",
            manifest_entry: "index.mjs",
            capabilities: [],
            contributions: { schema_version: 1, commands: [1] },
            installed_at: "2026-08-03T00:00:00.000Z",
            updated_at: "2026-08-03T00:00:00.000Z",
            source: {
              kind: "local",
              input: "./bad-contributions",
              location: "/tmp/bad-contributions",
            },
          },
        ],
      })?.entries,
    ).toEqual([]);
  });

  it("projects activation summaries into manifests and managed install state", () => {
    const contributions = createExtensionContributionInventory({
      commands: ["package ping"],
      command_overrides: [],
      command_handlers: ["package ping"],
      hooks: ["after_command"],
      flag_commands: [],
      item_types: ["Milestone"],
      item_fields: ["customer"],
      relationship_kinds: ["depends_on"],
      migrations: [],
      profiles: [],
      importers: [],
      exporters: [],
      search_providers: [],
      vector_store_adapters: [],
      parser_overrides: [],
      service_overrides: [],
      renderer_overrides: ["json"],
      renderer_ownership: [
        {
          format: "json",
          commands: ["package ping"],
          result_discriminator: false,
        },
      ],
      preflight_overrides: 0,
      preflight_ownership: [{ commands: ["package ping"] }],
    });
    expect(
      _testOnlyLoader.parseManifest({
        name: "package",
        version: "1.0.0",
        entry: "index.mjs",
        priority: 100,
        capabilities: ["commands"],
        contributions,
      }),
    ).toMatchObject({ contributions });
    expect(
      normalizeManagedState({
        version: 1,
        updated_at: "2026-08-03T00:00:00.000Z",
        entries: [
          {
            name: "package",
            directory: "package",
            scope: "project",
            manifest_version: "1.0.0",
            manifest_entry: "index.mjs",
            capabilities: ["commands"],
            contributions,
            installed_at: "2026-08-03T00:00:00.000Z",
            updated_at: "2026-08-03T00:00:00.000Z",
            source: {
              kind: "local",
              input: "./package",
              location: "/tmp/package",
            },
          },
        ],
      })?.entries[0]?.contributions,
    ).toEqual(contributions);
    expect(
      createExtensionContributionInventory({
        commands: [],
        command_overrides: [],
        command_handlers: [],
        hooks: [],
        flag_commands: [],
        item_types: [],
        item_fields: [],
        migrations: [],
        profiles: [],
        importers: [],
        exporters: [],
        search_providers: [],
        vector_store_adapters: [],
        parser_overrides: [],
        service_overrides: [],
        renderer_overrides: [],
        preflight_overrides: 0,
      }),
    ).not.toHaveProperty("preflight_ownership");
  });

  it("leaves managed state unchanged when an install-time inventory has no matching record", async () => {
    const state = createEmptyManagedExtensionState();
    await expect(
      persistManagedContributionInventory("/missing", state, "absent", {
        schema_version: 1,
      }),
    ).resolves.toBe(state);
  });
});
