import { Command } from "commander";
import { describe, expect, it } from "vitest";
import {
  applyDynamicExtensionFlagOptions,
  buildExtensionCommandCollisionWarning,
  collectSafeExtensionCommandPaths,
  ensureCommandPath,
  findExtensionCommandPathCollision,
  reportExtensionCommandCollision,
} from "../../../src/cli/extension-command-help.js";

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
    const parseListValue = command.options[0]?.parseArg as
      | ((value: string, previous: string | string[]) => string[])
      | undefined;
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

    expect(parseListValue?.("alpha", "seed")).toEqual(["seed", "alpha"]);
    expect(options.repos).toEqual(["alpha", "beta,gamma", "delta"]);
  });

  it("distinguishes core-prefix collisions from extension-owned paths", () => {
    const program = new Command();
    program.command("get");

    expect(findExtensionCommandPathCollision(program, ["get", "alias"])).toEqual({
      core_path: "get",
      extension_path: "get alias",
    });
    expect(findExtensionCommandPathCollision(program, ["package", "probe"])).toBeNull();

    ensureCommandPath(program, ["package", "probe"]);
    expect(findExtensionCommandPathCollision(program, ["package", "probe"])).toBeNull();
  });

  it("filters colliding aliases and reports their package owner", () => {
    const program = new Command();
    program.command("get");
    const aliases = new Map([["get", "package get"]]);
    const descriptors = new Map([
      [
        "get",
        {
          command: "get",
          action: "get",
          examples: [],
          failure_hints: [],
          arguments: [],
          flags: [],
          source: { layer: "project" as const, name: "example", package: "example-package" },
        },
      ],
    ]);
    const warnings: string[] = [];
    expect(
      collectSafeExtensionCommandPaths(
        program,
        ["", "get", "package probe", "package probe"],
        descriptors,
        aliases,
        (warning) => warnings.push(warning),
      ),
    ).toEqual(["package probe"]);
    expect(warnings[0]).toContain("extension_owner=example-package");

    const messages: string[] = [];
    reportExtensionCommandCollision(warnings, (message) => messages.push(message), "collision");
    expect(warnings.at(-1)).toBe("collision");
    expect(messages[0]).toContain("core command preserved");
    expect(
      buildExtensionCommandCollisionWarning(program, "get alias", new Map(), {
        ...descriptors.get("get")!,
        source: { layer: "project", name: "named-extension" },
      }),
    ).toContain("extension_owner=named-extension");
    expect(
      buildExtensionCommandCollisionWarning(
        program,
        "get alias",
        new Map(),
        undefined,
      ),
    ).toContain("extension_owner=unknown-extension");
    expect(
      buildExtensionCommandCollisionWarning(program, "get", new Map(), undefined),
    ).toBeNull();
  });
});
