/**
 * pm-wlxf8f: CLI argv that sets one declared extension flag through two
 * spellings with different values is refused, as direct callers are.
 */
import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { captureCommandOptionTokens, refuseConflictingCommandOptionSpellings } from "../../../../src/cli/runtime/invocation-options.js";
import { applyDynamicExtensionFlagOptions } from "../../../../src/cli/extension-command-help.js";

const FLAGS = [
  { long: "--status-filter", short: "-s", value_type: "string" },
  { long: "--title", value_type: "string" },
  { long: "--verbose", short: "-v", value_type: "boolean" },
];

/** Parse argv into a dynamic command; returns the leaf after Commander folded the spellings. */
async function parse(argv: string[], capture: boolean): Promise<Command> {
  const program = new Command().exitOverride();
  program.option("--json");
  const demo = program.command("demo").allowUnknownOption(true).allowExcessArguments(true).action(() => {});
  applyDynamicExtensionFlagOptions(demo, FLAGS);
  if (capture) captureCommandOptionTokens(demo);
  await program.parseAsync(argv, { from: "user" });
  return demo;
}

describe("pm-wlxf8f command option spelling conflicts", () => {
  it("refuses --status-filter open -s closed from the tokens the command's own parser received", async () => {
    const switches = await parse(["demo", "--verbose=false", "-v"], true);
    expect(() => refuseConflictingCommandOptionSpellings(switches, FLAGS, "demo")).toThrow("both set --verbose");
    const demo = await parse(["demo", "--status-filter", "open", "--json", "-s", "closed"], true);
    expect(() => refuseConflictingCommandOptionSpellings(demo, FLAGS, "demo")).toThrow("Options '--status-filter' and '-s' both set --status-filter");
    // The root consumed --json, so the command's tokens hold only its own options.
    const accepted = await parse(["demo", "--status-filter", "open", "--title", "-s", "--json"], true);
    expect(() => refuseConflictingCommandOptionSpellings(accepted, FLAGS, "demo")).not.toThrow();
    expect(accepted.opts()).toMatchObject({ statusFilter: "open", title: "-s" });
  });

  it("negative control: without the captured tokens Commander keeps the last value silently", async () => {
    const demo = await parse(["demo", "--status-filter", "open", "-s", "closed"], false);
    expect(() => refuseConflictingCommandOptionSpellings(demo, FLAGS, "demo")).not.toThrow();
    expect(demo.opts()).toMatchObject({ statusFilter: "closed" });
  });

  it("sees occurrences an ancestor command consumed, and keeps a core owner's colliding short alias", async () => {
    const program = new Command().exitOverride();
    const demo = program.command("demo").allowUnknownOption(true).allowExcessArguments(true).action(() => {});
    const child = demo.command("child").allowUnknownOption(true).allowExcessArguments(true).action(() => {});
    applyDynamicExtensionFlagOptions(demo, FLAGS);
    applyDynamicExtensionFlagOptions(child, FLAGS);
    for (const command of [program, demo, child]) captureCommandOptionTokens(command);
    // Capturing twice patches once.
    captureCommandOptionTokens(child);
    await program.parseAsync(["demo", "child", "--status-filter", "open", "-s", "closed"], { from: "user" });
    // The parent parser consumed both spellings; the child's own tokens are empty.
    expect(() => refuseConflictingCommandOptionSpellings(child, FLAGS, "demo child")).toThrow("Options '--status-filter' and '-s' both set --status-filter");

    const core = new Command().exitOverride();
    const close = core.command("close").option("-r, --reason <text>").allowUnknownOption(true).allowExcessArguments(true).action(() => {});
    const colliding = [{ long: "--reason-note", short: "-r", value_type: "string" }];
    applyDynamicExtensionFlagOptions(close, colliding);
    captureCommandOptionTokens(close);
    await core.parseAsync(["close", "--reason-note", "why", "-r", "done"], { from: "user" });
    expect(() => refuseConflictingCommandOptionSpellings(close, colliding, "close")).not.toThrow();
  });

  it("reads a negative number as an option when the command path declares a numeric short option", async () => {
    const program = new Command().exitOverride().option("-1, --first");
    const demo = program.command("demo").allowUnknownOption(true).allowExcessArguments(true).action(() => {});
    const optional = [{ long: "--level [value]", short: "-l", value_type: "string" }];
    applyDynamicExtensionFlagOptions(demo, optional);
    captureCommandOptionTokens(demo);
    await program.parseAsync(["demo", "--level=-2", "-l", "-2"], { from: "user" }).catch(() => undefined);
    expect(() => refuseConflictingCommandOptionSpellings(demo, optional, "demo")).toThrow("both set --level");
  });

  it("skips commands without declared extension flags", async () => {
    const demo = await parse(["demo", "--status-filter", "open", "-s", "closed"], true);
    expect(() => refuseConflictingCommandOptionSpellings(demo, [], "demo")).not.toThrow();
  });
});
