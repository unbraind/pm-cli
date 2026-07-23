import { Command } from "commander";
import { describe, expect, it } from "vitest";
import {
  _testOnlyRegisterSetup,
  registerSetupCommands,
} from "../../../src/cli/register-setup.js";

describe("repeatable scaffold capability selection", () => {
  it("collects repeated occurrences instead of silently keeping the last value", () => {
    const program = new Command();
    registerSetupCommands(program);
    const extension = program.commands.find(
      (command) => command.name() === "extension",
    );
    const capability = extension?.options.find(
      (option) => option.long === "--capability",
    );

    expect(capability?.parseArg?.("hooks", undefined)).toEqual(["hooks"]);
    expect(capability?.parseArg?.("search", ["hooks"])).toEqual([
      "hooks",
      "search",
    ]);
  });

  it("accepts duplicate selections idempotently and rejects ambiguous combinations", () => {
    expect(
      _testOnlyRegisterSetup.normalizeExtensionOptions({
        init: true,
        capability: "hooks",
      }),
    ).toMatchObject({ capability: "hooks" });
    expect(
      _testOnlyRegisterSetup.normalizeExtensionOptions({
        init: true,
        capability: ["hooks", "hooks"],
      }),
    ).toMatchObject({ capability: "hooks" });
    expect(() =>
      _testOnlyRegisterSetup.normalizeExtensionOptions({
        init: true,
        capability: ["hooks", "search"],
      }),
    ).toThrow(/cannot be combined/);
  });
});
