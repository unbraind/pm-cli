import { Command } from "commander";
import { afterEach, describe, expect, it } from "vitest";
import { resolveCommanderUsageContext } from "../../../src/cli/commander-usage.js";
import { formatCommanderErrorForJson } from "../../../src/cli/error-guidance.js";

const originalArgv = process.argv;

afterEach(() => {
  process.argv = originalArgv;
});

describe("Commander positional subcommand recovery", () => {
  it("recognizes split schema actions and preserves every trailing token", async () => {
    process.argv = ["node", "pm", "schema", "add", "type", "Example", "--json"];
    const context = await resolveCommanderUsageContext(
      { message: "error: too many arguments" },
      new Command().name("pm"),
      new Map(),
    );
    expect(context).toMatchObject({
      unknownSubcommandPath: "schema",
      unknownSubcommandToken: "add type",
      suggestedRetryCommand: "pm schema add-type Example --json",
    });
    expect(context.unknownSubcommandAllowedValues).toHaveLength(15);

    const envelope = formatCommanderErrorForJson(
      context.message,
      context.commandName,
      context.allowedTypes,
      2,
      context,
    );
    expect(envelope).toMatchObject({
      code: "unknown_subcommand",
      recovery: {
        suggested_retry: "pm schema add-type Example --json",
      },
    });
  });

  it("leaves unrelated arity failures on the generic path", async () => {
    const cases = [
      ["list", "extra"],
      ["--pm-path", "schema", "list", "schema", "add", "type"],
      ["schema", "add"],
      ["schema", "add", "unknown"],
    ];
    for (const args of cases) {
      process.argv = ["node", "pm", ...args];
      const context = await resolveCommanderUsageContext(
        { message: "error: too many arguments" },
        new Command().name("pm"),
        new Map(),
      );
      expect(context.unknownSubcommandPath).toBeUndefined();
    }
    process.argv = ["node", "pm", "schema", "add", "type"];
    const unrelatedMessage = await resolveCommanderUsageContext(
      { message: "error: unknown option '--bad'" },
      new Command().name("pm"),
      new Map(),
    );
    expect(unrelatedMessage.unknownSubcommandPath).toBeUndefined();

    const envelopeWithoutRetry = formatCommanderErrorForJson(
      "error: too many arguments",
      "schema",
      "Task|Issue",
      2,
      {
        unknownSubcommandPath: "schema",
        unknownSubcommandToken: "unknown action",
        unknownSubcommandAllowedValues: ["list", "show"],
      },
    );
    expect(envelopeWithoutRetry.examples).toEqual(["pm schema --help"]);
    expect(envelopeWithoutRetry.next_steps).toEqual([
      "Choose one value from recovery.allowed_values.",
    ]);
  });
});
