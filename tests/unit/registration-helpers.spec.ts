import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { getGlobalOptions, setResolvedGlobalOptions } from "../../src/cli/registration-helpers.js";

describe("registration helpers", () => {
  it("uses resolved global options when command-like objects lack commander globals", () => {
    const command = { opts: () => ({ json: true, quiet: true, path: ".pm" }) } as unknown as Command;

    expect(getGlobalOptions(command)).toEqual({
      json: true,
      quiet: true,
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
});
