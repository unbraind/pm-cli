import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { _testOnly } from "../../../src/cli/help-json-payload.js";
import { hasSubcommandFlagContractsForCommand } from "../../../src/sdk/index.js";

describe("structured help command-path resolution", () => {
  it("derives synthetic extension parents from their most visible descendants", () => {
    const descriptors = new Map([
      [
        "automation hidden",
        {
          command: "automation hidden",
          description: "Hidden automation",
          tier: "internal" as const,
          family: "automation" as const,
        },
      ],
      [
        "automation visible",
        {
          command: "automation visible",
          description: "Visible extension",
          tier: "standard" as const,
          family: "extensions" as const,
        },
      ],
    ]);

    expect(_testOnly.resolveExtensionCommandSurface("automation hidden", descriptors)).toMatchObject({
      tier: "internal",
      family: "automation",
    });
    expect(_testOnly.resolveExtensionCommandSurface("automation", descriptors)).toEqual({
      tier: "standard",
      family: "extensions",
    });
    expect(_testOnly.resolveExtensionCommandSurface("missing", descriptors)).toBeUndefined();

    const root = new Command("pm");
    const automation = root.command("automation");
    expect(
      _testOnly.buildJsonHelpPayload(
        root,
        automation,
        ["automation", "--help", "--json"],
        ["automation"],
        new Map([
          [
            "automation",
            {
              command: "automation",
              description: "Automate work",
              examples: ["pm automation run"],
              failure_hints: [],
              arguments: [],
              flags: [],
              tier: "standard",
              family: "automation",
            },
          ],
        ]),
      ).examples,
    ).toEqual(["pm automation run"]);
    expect(
      _testOnly.buildJsonHelpPayload(
        root,
        automation,
        ["automation", "--help", "--json"],
        ["automation"],
        new Map([
          [
            "automation",
            {
              command: "automation",
              description: "Automate work",
              examples: [],
              failure_hints: [],
              arguments: [],
              flags: [],
              tier: "standard",
              family: "automation",
            },
          ],
        ]),
      ).examples,
    ).toEqual(["pm init"]);
  });

  it("resolves exact, implicit, and contract-backed positional command paths", () => {
    const root = new Command("pm");
    const workspace = root.command("workspace");
    const snapshot = workspace.command("snapshot");

    expect(_testOnly.resolveCommandFromPathTokens(root, [])).toBe(root);
    expect(_testOnly.resolveCommandFromPathTokens(root, ["workspace"])).toBe(
      workspace,
    );
    expect(_testOnly.resolveCommandFromPathTokens(root, ["help"])).toBe(root);
    expect(
      _testOnly.resolveCommandFromPathTokens(root, [
        "workspace",
        "snapshot",
        "create",
      ]),
    ).toBe(snapshot);
    expect(
      _testOnly.resolveCommandFromPathTokens(root, ["missing"]),
    ).toBeNull();

    expect(
      _testOnly.buildJsonHelpPayload(
        root,
        snapshot,
        [],
        ["workspace", "snapshot", "create"],
        new Map(),
      ).resolved_path,
    ).toBe("workspace snapshot create");
    expect(
      _testOnly.buildJsonHelpPayload(
        root,
        snapshot,
        [],
        ["workspace", "snapshot"],
        new Map(),
      ).resolved_path,
    ).toBe("workspace snapshot");
  });

  it("fails closed when a known virtual path has no registered parent", () => {
    expect(
      _testOnly.resolveCommandFromPathTokens(new Command("pm"), [
        "workspace",
        "snapshot",
        "create",
      ]),
    ).toBeNull();
  });

  it("distinguishes concrete flag-contract paths from surface-less or invalid paths", () => {
    expect(
      hasSubcommandFlagContractsForCommand("workspace snapshot create"),
    ).toBe(true);
    expect(hasSubcommandFlagContractsForCommand(" extension init ")).toBe(true);
    expect(hasSubcommandFlagContractsForCommand("package install")).toBe(true);
    expect(hasSubcommandFlagContractsForCommand("packages doctor")).toBe(true);
    expect(hasSubcommandFlagContractsForCommand(undefined)).toBe(false);
    expect(hasSubcommandFlagContractsForCommand("help")).toBe(false);
    expect(hasSubcommandFlagContractsForCommand("extension unknown")).toBe(
      false,
    );
    expect(hasSubcommandFlagContractsForCommand("extension init extra")).toBe(
      false,
    );
    expect(hasSubcommandFlagContractsForCommand("plan create")).toBe(true);
    expect(hasSubcommandFlagContractsForCommand("assurance risk")).toBe(true);
  });

  it("projects positional actions as precise virtual help paths", () => {
    const root = new Command("pm");
    const plan = root
      .command("plan")
      .argument("<subcommand>")
      .argument("[id]")
      .argument("[stepRef]")
      .argument("[reorderTo]")
      .argument("[extensionOwned]")
      .option("--title <value>", "Plan title")
      .option("--step-status <value>", "Step status");
    const payload = _testOnly.buildJsonHelpPayload(
      root,
      plan,
      ["plan", "create", "--help", "--json"],
      ["plan", "create"],
      new Map(),
    );

    expect(payload).toMatchObject({
      resolved_path: "plan create",
      usage: "plan create [title]",
      arguments: [expect.objectContaining({ name: "title", required: false })],
      intent: expect.stringContaining("Create a Plan item"),
      subcommands: [],
      has_subcommands: false,
    });
    expect(payload.options).toEqual(
      expect.arrayContaining([expect.objectContaining({ long: "--title" })]),
    );

    const parentPayload = _testOnly.buildJsonHelpPayload(
      root,
      plan,
      ["plan", "--help", "--json"],
      ["plan"],
      new Map(),
    );
    expect(parentPayload.subcommands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "create" }),
        expect.objectContaining({ name: "reorder-step" }),
      ]),
    );
    expect(parentPayload.has_subcommands).toBe(true);
    expect(parentPayload.arguments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "extensionOwned",
          required: false,
          variadic: false,
        }),
      ]),
    );

    const assurance = root.command("assurance").argument("[subcommand]");
    const flaglessActionPayload = _testOnly.buildJsonHelpPayload(
      root,
      assurance,
      ["assurance", "list", "--help", "--json"],
      ["assurance", "list"],
      new Map(),
    );
    expect(flaglessActionPayload.tips).toEqual(["Applicable flags: none."]);

    const actionWithOperand = _testOnly.buildJsonHelpPayload(
      root,
      plan,
      ["plan", "add-step", "pm-a1b2", "--help", "--json"],
      ["plan", "add-step", "pm-a1b2"],
      new Map(),
    );
    expect(actionWithOperand).toMatchObject({
      requested_path: ["plan", "add-step", "pm-a1b2"],
      resolved_path: "plan add-step",
      usage: "plan add-step <plan-id>",
      arguments: [expect.objectContaining({ name: "plan-id", required: true })],
    });
    expect(
      _testOnly.resolveCommandFromPathTokens(root, [
        "plan",
        "add-step",
        "pm-a1b2",
      ]),
    ).toBe(plan);
  });

  it("prefixes concrete command usage with its resolved path", () => {
    const root = new Command("pm");
    const get = root.command("get").argument("<id>");

    expect(
      _testOnly.buildJsonHelpPayload(
        root,
        get,
        ["get", "--help", "--json"],
        ["get"],
        new Map(),
      ).usage,
    ).toBe("get [options] <id>");
  });

  it("does not duplicate a positional action registered as a subcommand", () => {
    const root = new Command("pm");
    const plan = root.command("plan");
    plan.command("create").description("Registered create command");

    const projection = _testOnly.buildPositionalActionHelpProjection(
      undefined,
      plan,
      "plan",
      [],
    );
    expect(
      projection.subcommands.filter(({ name }) => name === "create"),
    ).toEqual([
      expect.objectContaining({
        name: "create",
        description: "Registered create command",
      }),
    ]);
  });

  it("lists only visible Commander commands and includes built-in help", () => {
    const root = new Command("pm");
    root.command("visible").description("Visible command");
    root.command("internal", { hidden: true }).description("Internal command");

    expect(_testOnly.buildHelpSubcommandSummaries(root)).toEqual([
      expect.objectContaining({ name: "help" }),
      expect.objectContaining({ name: "visible" }),
    ]);
  });

  it("filters action options through aliases and renders every slot shape", () => {
    const projection = _testOnly.buildPositionalActionHelpProjection(
      {
        command: "plan synthetic",
        parent: "plan",
        action: "synthetic",
        accepted_flags: ["--accepted-alias"],
        description: "Synthetic positional action.",
        example: "pm plan synthetic one two",
        slots: [
          {
            name: "values",
            required: true,
            variadic: true,
            value_kind: "string",
            polymorphic: false,
          },
        ],
      },
      new Command("plan"),
      "plan synthetic",
      [
        {
          flags: "--canonical",
          long: "--canonical",
          short: null,
          description: "Canonical option",
          takes_value: false,
          value_required: false,
          value_name: null,
          variadic: false,
          required: false,
          aliases: ["--accepted-alias"],
          alias_for: null,
        },
      ],
    );

    expect(projection).toMatchObject({
      usage: "plan synthetic <values...>",
      arguments: [
        expect.objectContaining({
          description: "string value.",
          required: true,
          variadic: true,
        }),
      ],
      options: [expect.objectContaining({ long: "--canonical" })],
    });
  });
});
