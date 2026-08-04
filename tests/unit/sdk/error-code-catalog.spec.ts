import { describe, expect, it } from "vitest";
import {
  definePmErrorCodeCatalog,
  resolvePmErrorCodeContract,
} from "../../../src/sdk/error-code-catalog.js";

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
    },
  ]);

  it("normalizes and resolves stable machine-readable errors", () => {
    expect(catalog.map(({ code }) => code)).toEqual([
      "extension_unavailable",
      "unknown_command",
    ]);
    expect(
      resolvePmErrorCodeContract("unknown_command", catalog),
    ).toMatchObject({
      exit_code: 2,
      stability: "stable",
    });
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
      { ...catalog[0]!, emitting_commands: [] },
      { ...catalog[0]!, exit_code: 9 as 1 },
      { ...catalog[0]!, class: "conflict" as const },
    ]) {
      expect(() => definePmErrorCodeCatalog([invalid])).toThrow(
        "Invalid pm error code contract",
      );
    }
    expect(() => resolvePmErrorCodeContract("missing", catalog)).toThrow(
      'Unknown pm error code "missing"',
    );
  });
});
