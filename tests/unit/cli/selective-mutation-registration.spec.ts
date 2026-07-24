import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { registerMutationCommands } from "../../../src/cli/register-mutation.js";

describe("selective mutation command registration", () => {
  it("registers only create for the create startup fast path", () => {
    const program = new Command();
    registerMutationCommands(program, { targetCommandName: "create" });
    expect(program.commands.map((command) => command.name())).toEqual([
      "create",
    ]);
    expect(
      program.commands[0].options.map((option) => option.long),
    ).toContain("--allow-duplicate");
  });

  it("retains the complete mutation family by default", () => {
    const program = new Command();
    registerMutationCommands(program);
    expect(program.commands.map((command) => command.name())).toEqual(
      expect.arrayContaining(["create", "copy", "update", "close", "schema"]),
    );
  });
});
