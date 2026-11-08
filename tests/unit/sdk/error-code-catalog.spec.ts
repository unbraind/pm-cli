import { describe, expect, it } from "vitest";
import {
  definePmErrorCodeCatalog,
  resolveCanonicalPmErrorCodeContract,
  resolvePmErrorCodeContract,
} from "../../../src/sdk/error-code-catalog.js";
import { expandPmErrorCodeCatalogRows } from "../../../src/sdk/generated/error-code-catalog-rows.js";
import { PM_ERROR_CODE_CATALOG } from "../../../src/sdk/generated-error-code-catalog.js";

describe("error code catalog", () => {
  const catalog = definePmErrorCodeCatalog([
    {
      code: "unknown_command",
      meaning: "The requested command is not registered.",
      stability: "stable",
      exit_code: 2,
      class: "usage",
      recovery: "Use a command returned by pm contracts.",
      sources: ["cli"],
      emitting_commands: ["help"],
      canonical_code: "unknown_command",
      aliases: ["unknown_subcommand"],
      owned_states: [
        {
          state: "command_token_is_unknown",
          probe_id: "unknown-command",
          entrypoints: ["help"],
          expected_exit_class: "usage",
        },
        {
          state: "command_token_is_blank",
          probe_id: "blank-command",
          entrypoints: ["help"],
          expected_exit_class: "usage",
        },
      ],
    },
    {
      code: "unknown_subcommand",
      meaning: "A nested command token is not registered.",
      stability: "stable",
      exit_code: 2,
      class: "usage",
      recovery: "Use a subcommand returned by pm contracts.",
      sources: ["cli"],
      emitting_commands: ["help"],
      canonical_code: "unknown_command",
      aliases: [],
    },
    {
      code: "extension_unavailable",
      meaning: "A package-owned command is not active.",
      stability: "provisional",
      exit_code: 1,
      class: "generic_failure",
      recovery: "Install or activate the package.",
      sources: ["extension"],
      emitting_commands: ["package"],
      canonical_code: "extension_unavailable",
      aliases: [],
    },
  ]);

  it("normalizes and resolves stable machine-readable errors", () => {
    expect(catalog.map(({ code }) => code)).toEqual([
      "extension_unavailable",
      "unknown_command",
      "unknown_subcommand",
    ]);
    expect(
      resolvePmErrorCodeContract("unknown_command", catalog),
    ).toMatchObject({
      exit_code: 2,
      stability: "stable",
      class: "usage",
      emitting_commands: ["help"],
    });
    expect(
      resolveCanonicalPmErrorCodeContract("unknown_subcommand", catalog),
    ).toMatchObject({
      code: "unknown_command",
      aliases: ["unknown_subcommand"],
    });

    const defaults = definePmErrorCodeCatalog([
      {
        code: "default_contract",
        meaning: "Uses normalized defaults.",
        stability: "stable",
        exit_code: 1,
        class: "generic_failure",
        recovery: "Retry.",
        sources: ["sdk"],
        emitting_commands: ["contracts"],
      },
    ]);
    expect(defaults[0]).toMatchObject({
      canonical_code: "default_contract",
      aliases: [],
      owned_states: [],
    });
    expect(
      resolveCanonicalPmErrorCodeContract("default_contract", [
        {
          ...defaults[0]!,
          canonical_code: undefined,
        },
      ]),
    ).toMatchObject({ code: "default_contract" });
  });

  it("rejects duplicate and invalid catalog rows", () => {
    expect(() => definePmErrorCodeCatalog([...catalog, catalog[0]!])).toThrow(
      "Duplicate pm error code",
    );
    expect(() =>
      definePmErrorCodeCatalog([
        {
          code: "Bad Code",
          meaning: "Invalid.",
          stability: "stable",
          exit_code: 99,
          recovery: "Retry.",
          sources: [],
        },
      ]),
    ).toThrow("Invalid pm error code");
    for (const invalid of [
      { ...catalog[0]!, meaning: " " },
      { ...catalog[0]!, recovery: " " },
      { ...catalog[0]!, sources: [] },
      { ...catalog[0]!, sources: [" "] },
      { ...catalog[0]!, emitting_commands: [] },
      { ...catalog[0]!, emitting_commands: [" "] },
      { ...catalog[0]!, exit_code: 9 as 1 },
      { ...catalog[0]!, class: "conflict" as const },
      { ...catalog[0]!, canonical_code: "missing" },
      { ...catalog[0]!, aliases: ["missing"] },
      {
        ...catalog[0]!,
        owned_states: [
          {
            state: "Bad State",
            probe_id: "bad-state",
            entrypoints: ["help"],
            expected_exit_class: "usage" as const,
          },
        ],
      },
      {
        ...catalog[0]!,
        owned_states: [
          {
            state: "command_token_is_unknown",
            probe_id: "unknown-command",
            entrypoints: ["help"],
            expected_exit_class: "conflict" as const,
          },
        ],
      },
    ]) {
      expect(() => definePmErrorCodeCatalog([invalid])).toThrow(
        /Invalid pm (error code contract|refusal state)/u,
      );
    }
    expect(() => resolvePmErrorCodeContract("missing", catalog)).toThrow(
      'Unknown pm error code "missing"',
    );
  });

  it("rejects alias cycles and transport-incompatible canonical groups", () => {
    expect(() =>
      definePmErrorCodeCatalog([
        {
          ...catalog[1]!,
          canonical_code: "unknown_subcommand",
          aliases: [],
        },
        { ...catalog[2]!, aliases: [] },
      ]),
    ).toThrow("Alias cycle");
    expect(() =>
      definePmErrorCodeCatalog([
        catalog[1]!,
        {
          ...catalog[2]!,
          exit_code: 4,
          class: "conflict",
        },
      ]),
    ).toThrow("Alias transport mismatch");
  });
});

// pm-998juj: the generated catalog ships compact rows; expansion must restore
// the exact contracts, field values and key order the full rows carried.

const CONTRACT_KEY_ORDER = [
  "code",
  "meaning",
  "stability",
  "exit_code",
  "class",
  "recovery",
  "sources",
  "emitting_commands",
  "canonical_code",
  "aliases",
  "owned_states",
];

describe("expandPmErrorCodeCatalogRows", () => {
  it("restores every derivable field from a minimal row", () => {
    expect(
      expandPmErrorCodeCatalogRows([{ code: "lock_path_unsafe", exit_code: 4, sources: ["core/lock/lock-confinement.ts"] }]),
    ).toEqual([
      {
        code: "lock_path_unsafe",
        meaning: "Lock path unsafe condition.",
        stability: "provisional",
        exit_code: 4,
        class: "conflict",
        recovery: "Inspect the structured error guidance, then retry the suggested command when one is present.",
        sources: ["core/lock/lock-confinement.ts"],
        emitting_commands: ["*"],
        canonical_code: "lock_path_unsafe",
        aliases: [],
      },
    ]);
  });

  it("keeps explicit fields and the canonical key order through catalog definition", () => {
    const catalog = definePmErrorCodeCatalog(
      expandPmErrorCodeCatalogRows([
        {
          code: "unknown_command",
          exit_code: 2,
          stable: true,
          sources: ["cli/main.ts"],
          emitting_commands: ["config", "list"],
          aliases: ["unknown_subcommand"],
          owned_states: [
            { state: "unknown_command_token", probe_id: "unknown-command", entrypoints: ["pm"], expected_exit_class: "usage" },
          ],
        },
        { code: "unknown_subcommand", exit_code: 2, stable: true, sources: ["cli/main.ts"], canonical_code: "unknown_command" },
      ]),
    );
    expect(catalog.map((entry) => Object.keys(entry))).toEqual([CONTRACT_KEY_ORDER, CONTRACT_KEY_ORDER]);
    expect(catalog[0]).toMatchObject({ stability: "stable", class: "usage", emitting_commands: ["config", "list"] });
    expect(catalog[1]).toMatchObject({ canonical_code: "unknown_command", aliases: [], owned_states: [] });
  });

  it("serializes every generated catalog entry in the canonical key order", () => {
    expect(PM_ERROR_CODE_CATALOG.length).toBeGreaterThan(400);
    for (const entry of PM_ERROR_CODE_CATALOG) {
      expect(Object.keys(entry)).toEqual(CONTRACT_KEY_ORDER);
    }
  });
});
