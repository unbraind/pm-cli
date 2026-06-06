import { Command } from "commander";
import { describe, expect, it } from "vitest";
import {
  getGlobalOptions,
  normalizeSearchOptions,
  setResolvedGlobalOptions,
} from "../../src/cli/registration-helpers.js";

describe("registration helpers", () => {
  it("falls back to opts() for command-like objects without optsWithGlobals", () => {
    const command = { opts: () => ({ json: true, quiet: true, path: ".pm" }) } as unknown as Command;

    expect(getGlobalOptions(command)).toEqual({
      json: true,
      quiet: true,
      noChangedFields: false,
      path: ".pm",
      noExtensions: false,
      noPager: false,
      profile: false,
    });
  });

  it("prefers explicit resolved globals over command option fallbacks", () => {
    const command = new Command("demo");
    setResolvedGlobalOptions(command, {
      json: true,
      quiet: true,
      path: ".agents/pm",
      noExtensions: true,
      noPager: true,
      profile: true,
    });

    expect(getGlobalOptions(command)).toEqual({
      json: true,
      quiet: true,
      path: ".agents/pm",
      noExtensions: true,
      noPager: true,
      profile: true,
    });
  });

  it("preserves numeric semanticWeight values while normalizing search options", () => {
    const normalized = normalizeSearchOptions({
      hybrid: true,
      semanticWeight: 0.4,
    });

    expect(normalized.mode).toBe("hybrid");
    expect(normalized.semanticWeight).toBe(0.4);
  });

  it("accepts semantic_weight alias from tool-style payloads", () => {
    const normalized = normalizeSearchOptions({
      mode: "hybrid",
      semantic_weight: 0.25,
    });

    expect(normalized.mode).toBe("hybrid");
    expect(normalized.semanticWeight).toBe(0.25);
  });
});
