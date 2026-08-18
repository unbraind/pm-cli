import { describe, expect, it } from "vitest";
import {
  PM_CLI_GRAMMAR_CONTRACT,
  PM_CLI_GRAMMAR_NOUNS,
  PM_COMMAND_DESTINATION_CONTRACTS,
  PM_COMMAND_POSITIONAL_CONTRACTS,
  PM_POSITIONAL_ACTION_CONTRACTS,
  verifyExplicitPositionalSlotCensus,
  verifyPmCliGrammar,
  verifyPmCommandPositionalContracts,
} from "../../../../src/sdk/cli-contracts/grammar-contracts.js";
import {
  PM_COMMAND_ALIAS_CONTRACTS,
  renderPmCommandAliasMigrationHint,
  resolvePmPositionalActionFlagContracts,
  resolvePmCommandAlias,
} from "../../../../src/sdk/cli-contracts.js";
import { WORKSPACE_SNAPSHOT_ACTIONS } from "../../../../src/sdk/workspace-snapshot.js";

describe("CLI noun-verb grammar contracts", () => {
  it("maps every checked-in command exactly once and keeps alias targets live", () => {
    const commands = PM_COMMAND_DESTINATION_CONTRACTS.map(
      (destination) => destination.command,
    );
    const report = verifyPmCliGrammar(commands, PM_COMMAND_ALIAS_CONTRACTS);

    expect(report).toMatchObject({
      ok: true,
      command_count: commands.length,
      destination_count: commands.length,
      hidden_alias_count: 7,
      visible_top_level_count: 61,
      visible_top_level_ceiling:
        PM_CLI_GRAMMAR_CONTRACT.visible_top_level_ceiling,
    });
    expect(
      verifyPmCliGrammar([...commands, "list-open"], PM_COMMAND_ALIAS_CONTRACTS)
        .visible_top_level_count,
    ).toBe(61);
    expect(new Set(PM_CLI_GRAMMAR_NOUNS).size).toBe(12);
  });

  it("fails upward for missing and stale census rows", () => {
    const liveCommands = PM_COMMAND_DESTINATION_CONTRACTS.map(
      (destination) => destination.command,
    );
    const missing = verifyPmCliGrammar(
      [...liveCommands, "rogue-command"],
      PM_COMMAND_ALIAS_CONTRACTS,
    );
    expect(missing.findings).toContainEqual(
      expect.objectContaining({
        code: "missing_destination",
        spelling: "rogue-command",
        nearest_target: "ops rogue-command",
      }),
    );
    const knownNounDestination = verifyPmCliGrammar(
      [...liveCommands, "item rogue"],
      PM_COMMAND_ALIAS_CONTRACTS,
    );
    expect(knownNounDestination.findings).toContainEqual(
      expect.objectContaining({
        code: "missing_destination",
        spelling: "item rogue",
        nearest_target: "item",
      }),
    );

    const stale = verifyPmCliGrammar(
      liveCommands.filter((command) => command !== "list"),
      PM_COMMAND_ALIAS_CONTRACTS,
    );
    expect(stale.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "stale_destination",
          spelling: "list",
        }),
        expect.objectContaining({
          code: "alias_target_missing",
          spelling: "list-all",
        }),
      ]),
    );
  });

  it("allows inactive package rows while rejecting undeclared active commands", () => {
    const coreCommands = PM_COMMAND_DESTINATION_CONTRACTS.filter(
      ({ disposition }) => disposition !== "package_owned",
    ).map(({ command }) => command);
    expect(
      verifyPmCliGrammar(coreCommands, PM_COMMAND_ALIAS_CONTRACTS),
    ).toMatchObject({ ok: true, command_count: coreCommands.length });

    const report = verifyPmCliGrammar(
      [...coreCommands, "package-provided-unknown"],
      PM_COMMAND_ALIAS_CONTRACTS,
    );
    expect(report.findings).toContainEqual(
      expect.objectContaining({
        code: "missing_destination",
        spelling: "package-provided-unknown",
      }),
    );
  });

  it("detects duplicate destinations and nouns outside the grammar", () => {
    const destinations = [
      ...PM_COMMAND_DESTINATION_CONTRACTS,
      {
        command: "list",
        noun: "unregistered-noun" as never,
        target: "list",
        disposition: "keep_as_is" as const,
        owner: "pm-wt43zj",
      },
    ];
    const report = (
      verifyPmCliGrammar as unknown as (
        commands: readonly string[],
        aliases: Parameters<typeof verifyPmCliGrammar>[1],
        census: readonly (typeof PM_COMMAND_DESTINATION_CONTRACTS)[number][],
      ) => ReturnType<typeof verifyPmCliGrammar>
    )(
      PM_COMMAND_DESTINATION_CONTRACTS.map(
        (destination) => destination.command,
      ),
      [],
      destinations,
    );
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "duplicate_destination",
          spelling: "list",
        }),
        expect.objectContaining({
          code: "missing_destination",
          spelling: "list",
          message: expect.stringContaining("without a documented reason"),
        }),
        expect.objectContaining({
          code: "unknown_noun",
          spelling: "list",
        }),
      ]),
    );
  });

  it("resolves deprecated list aliases with stable canonical hints", () => {
    const alias = resolvePmCommandAlias(" LIST-OPEN ");
    expect(alias).toMatchObject({
      canonical: "list",
      canonical_argv: ["list", "--status", "open"],
      lifecycle: "deprecated",
      hidden: true,
      owner: "pm-pfqi",
    });
    expect(renderPmCommandAliasMigrationHint(alias!)).toBe(
      "Deprecated command `list-open`; use `pm list --status open`.",
    );
    expect(resolvePmCommandAlias("unknown")).toBeUndefined();
    expect(resolvePmCommandAlias(" packages scaffold ")).toMatchObject({
      canonical: "packages init",
      canonical_argv: ["packages", "init"],
      lifecycle: "permanent",
      hidden: false,
      registration: "commander",
    });
  });

  it("fails when visible top-level growth exceeds the committed ceiling", () => {
    const liveCommands = PM_COMMAND_DESTINATION_CONTRACTS.map(
      (destination) => destination.command,
    );
    const overflow = Array.from(
      { length: PM_CLI_GRAMMAR_CONTRACT.visible_top_level_ceiling + 1 },
      (_value, index) => `new-${index}`,
    );
    const report = verifyPmCliGrammar([...liveCommands, ...overflow]);
    expect(report.findings).toContainEqual(
      expect.objectContaining({ code: "visible_surface_ceiling_exceeded" }),
    );
  });

  it("declares and gates every core and positional-action signature", () => {
    const report = verifyPmCommandPositionalContracts(
      PM_COMMAND_POSITIONAL_CONTRACTS.map(({ command, slots }) => ({
        command,
        slots,
      })),
    );
    expect(report).toMatchObject({
      ok: true,
      declared_command_count: PM_COMMAND_POSITIONAL_CONTRACTS.length,
      observed_command_count: PM_COMMAND_POSITIONAL_CONTRACTS.length,
      positional_shape_budget: PM_CLI_GRAMMAR_CONTRACT.positional_shape_budget,
      findings: [],
    });
    expect(report.positional_shape_count).toBeLessThanOrEqual(
      PM_CLI_GRAMMAR_CONTRACT.positional_shape_budget,
    );
    expect(
      PM_POSITIONAL_ACTION_CONTRACTS.find(
        ({ command }) => command === "plan create",
      ),
    ).toMatchObject({
      parent: "plan",
      action: "create",
      slots: [
        expect.objectContaining({
          name: "title",
          required: false,
          polymorphic: true,
        }),
      ],
      accepted_flags: expect.arrayContaining([
        "--create-mode",
        "--status",
        "--deadline",
        "--acceptance-criteria",
        "--reviewer",
        "--risk",
        "--reminder",
        "--event",
        "--doc",
        "--type-option",
      ]),
    });
    expect(
      PM_POSITIONAL_ACTION_CONTRACTS.find(
        ({ command }) => command === "assurance risk",
      ),
    ).toMatchObject({
      parent: "assurance",
      action: "risk",
      slots: [],
      accepted_flags: expect.arrayContaining(["--definition"]),
    });
    expect(
      PM_POSITIONAL_ACTION_CONTRACTS.find(
        ({ command }) => command === "assurance apply",
      )?.example,
    ).toBe("pm assurance apply software-delivery --owner <pm-item-id>");
    expect(
      PM_POSITIONAL_ACTION_CONTRACTS.filter(
        ({ parent }) => parent === "workspace snapshot",
      ).map(({ action }) => action),
    ).toEqual(WORKSPACE_SNAPSHOT_ACTIONS);
    expect(
      PM_POSITIONAL_ACTION_CONTRACTS.find(
        ({ command }) => command === "workspace snapshot restore",
      ),
    ).toMatchObject({
      slots: [expect.objectContaining({ name: "target", required: true })],
      accepted_flags: ["--author", "--dry-run", "--force", "--message"],
    });
    expect(
      PM_COMMAND_POSITIONAL_CONTRACTS.find(
        ({ command }) => command === "files lookup",
      ),
    ).toMatchObject({
      slots: [
        expect.objectContaining({
          name: "paths",
          required: true,
          variadic: true,
        }),
      ],
    });
    expect(
      PM_POSITIONAL_ACTION_CONTRACTS.find(
        ({ command }) => command === "plan complete-step",
      )?.description,
    ).toBe("Complete one declared Plan step.");
    expect(
      PM_POSITIONAL_ACTION_CONTRACTS.filter(({ parent }) => parent === "plan")
        .filter(({ slots }) => slots.length === 2)
        .map(({ action, description }) => [action, description]),
    ).toEqual([
      ["update-step", "Update one declared Plan step."],
      ["complete-step", "Complete one declared Plan step."],
      ["block-step", "Block one declared Plan step."],
      ["remove-step", "Remove one declared Plan step."],
      ["link", "Link one dependency to a declared Plan step."],
      ["unlink", "Unlink one dependency from a declared Plan step."],
    ]);
    expect(
      PM_POSITIONAL_ACTION_CONTRACTS.find(
        ({ command }) => command === "assurance presets",
      )?.description,
    ).toBe("List available assurance adoption presets.");
    expect(
      new Set(PM_COMMAND_POSITIONAL_CONTRACTS.map(({ command }) => command))
        .size,
    ).toBe(PM_COMMAND_POSITIONAL_CONTRACTS.length);
    expect(() =>
      resolvePmPositionalActionFlagContracts([
        {
          command: "synthetic action",
          parent: "synthetic" as never,
          action: "action",
          slots: [],
          accepted_flags: [],
          description: "Synthetic action",
          example: "pm synthetic action",
        },
      ]),
    ).toThrow("has no flag-contract index for synthetic");
  });

  it("fails closed for missing, stale, arity, and shape-budget drift", () => {
    const observed = PM_COMMAND_POSITIONAL_CONTRACTS.map(
      ({ command, slots }) => ({ command, slots }),
    ).filter(({ command }) => command !== "schema");
    const plan = observed.find(({ command }) => command === "plan");
    expect(plan).toBeDefined();
    plan!.slots = plan!.slots.map((slot) => ({
      ...slot,
      required: false,
    }));
    observed.push({
      command: "synthetic",
      slots: [
        {
          name: "value",
          required: true,
          variadic: false,
          value_kind: "string",
          polymorphic: false,
        },
      ],
    });
    const report = verifyPmCommandPositionalContracts(observed, {
      positionalShapeBudget: 0,
    });
    expect(report.findings.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        "missing_observed_signature",
        "stale_observed_signature",
        "positional_signature_mismatch",
        "positional_shape_budget_exceeded",
      ]),
    );

    const duplicate = PM_COMMAND_POSITIONAL_CONTRACTS.find(
      ({ command }) => command === "plan reorder-step",
    )!;
    expect(duplicate.slots.length).toBeGreaterThan(1);
    const duplicateReport = verifyPmCommandPositionalContracts(
      [duplicate, duplicate],
      {
        declared: [duplicate, duplicate],
      },
    );
    expect(duplicateReport).toMatchObject({
      ok: false,
      declared_command_count: 2,
      observed_command_count: 2,
    });
    expect(duplicateReport.findings).toEqual([
      expect.objectContaining({
        code: "positional_signature_mismatch",
        command: duplicate.command,
        detail: expect.stringContaining("declared positional signatures"),
      }),
      expect.objectContaining({
        code: "positional_signature_mismatch",
        command: duplicate.command,
        detail: expect.stringContaining("observed positional signatures"),
      }),
    ]);

    const spellingVariant = {
      ...duplicate,
      command: `  ${duplicate.command.toUpperCase().replaceAll(" ", "   ")}  `,
    };
    const normalizedDuplicateReport = verifyPmCommandPositionalContracts(
      [duplicate, spellingVariant],
      { declared: [duplicate, spellingVariant] },
    );
    expect(normalizedDuplicateReport.findings).toEqual([
      expect.objectContaining({
        code: "positional_signature_mismatch",
        command: duplicate.command,
        detail: expect.stringContaining("declared positional signatures"),
      }),
      expect.objectContaining({
        code: "positional_signature_mismatch",
        command: duplicate.command,
        detail: expect.stringContaining("observed positional signatures"),
      }),
    ]);

    const declared = [duplicate];
    const reorderedSlots = declared[0]!.slots.map(
      ({ name, required, variadic, value_kind: valueKind, polymorphic }) => ({
        polymorphic,
        value_kind: valueKind,
        variadic,
        required,
        name,
      }),
    );
    expect(
      verifyPmCommandPositionalContracts(
        [{ command: declared[0]!.command, slots: reorderedSlots }],
        { declared },
      ),
    ).toMatchObject({ ok: true, findings: [] });

    const requiredSlot = duplicate.slots[0]!;
    expect(
      verifyPmCommandPositionalContracts(
        [{ command: "synthetic", slots: [] }],
        {
          declared: [{ command: "synthetic", slots: [requiredSlot] }],
        },
      ).findings,
    ).toContainEqual(
      expect.objectContaining({
        code: "positional_signature_mismatch",
        detail: expect.stringContaining("observed=<none>"),
      }),
    );
    expect(
      verifyPmCommandPositionalContracts(
        [{ command: "synthetic", slots: [requiredSlot] }],
        { declared: [{ command: "synthetic", slots: [] }] },
      ).findings,
    ).toContainEqual(
      expect.objectContaining({
        code: "positional_signature_mismatch",
        detail: expect.stringContaining("declared=<none>"),
      }),
    );

    expect(
      verifyExplicitPositionalSlotCensus(
        ["orphan-explicit-command"],
        [declared[0]!.command],
      ),
    ).toContainEqual(
      expect.objectContaining({
        code: "positional_signature_mismatch",
        command: "orphan-explicit-command",
        detail: expect.stringContaining("no destination declaration"),
      }),
    );
  });
});
