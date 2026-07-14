import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { applyDynamicExtensionFlagOptions } from "../../../src/cli/extension-command-help.js";

describe("dynamic extension Commander options", () => {
  it("accumulates repeated long and short list flag occurrences", async () => {
    const program = new Command().exitOverride();
    const command = program.command("probe");
    let options: Record<string, unknown> = {};
    applyDynamicExtensionFlagOptions(command, [
      {
        long: "--repos",
        short: "-r",
        value_name: "path",
        value_type: "string",
        list: true,
      },
    ]);
    command.action((_, invoked: Command) => {
      options = invoked.opts<Record<string, unknown>>();
    });

    await program.parseAsync([
      "node",
      "pm",
      "probe",
      "-r",
      "alpha",
      "--repos",
      "beta,gamma",
      "--repos=delta",
    ]);

    expect(options.repos).toEqual(["alpha", "beta,gamma", "delta"]);
  });
});
