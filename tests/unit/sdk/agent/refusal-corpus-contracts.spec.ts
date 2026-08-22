import { describe, expect, it, vi } from "vitest";
import {
  PM_COMMAND_DESTINATION_CONTRACTS,
  PM_COMMAND_POSITIONAL_CONTRACTS,
  PM_POSITIONAL_ACTION_CONTRACTS,
} from "../../../../src/sdk/cli-contracts/grammar-contracts.js";
import {
  listPmRequiredArgumentRefusalContracts,
  listPmSubcommandRefusalContracts,
  scorePmGrammarRefusalClosure,
} from "../../../../src/sdk/agent/refusal-corpus-contracts.js";

describe("grammar-derived refusal corpus contracts", () => {
  it("declares one deterministic probe for every required positional slot", () => {
    const contracts = listPmRequiredArgumentRefusalContracts();
    const coreCommands = new Set(
      PM_COMMAND_DESTINATION_CONTRACTS.filter(
        ({ disposition }) => disposition !== "package_owned",
      ).map(({ command }) => command),
    );
    const requiredSlotCount = PM_COMMAND_POSITIONAL_CONTRACTS.reduce(
      (count, contract) =>
        count +
        (coreCommands.has(contract.command)
          ? contract.slots.filter(({ required }) => required).length
          : 0),
      0,
    );

    expect(contracts).toHaveLength(requiredSlotCount);
    expect(
      new Set(contracts.map(({ probe_id: probeId }) => probeId)).size,
    ).toBe(contracts.length);
    expect(contracts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          command: "restore",
          missing_argument: "target",
          refusal_args: ["restore", "pm-domain"],
          recovery_args: ["restore", "--help"],
        }),
        expect.objectContaining({
          command: "plan reorder-step",
          missing_argument: "new-order",
          refusal_args: ["plan", "reorder-step", "pm-domain", "example"],
          recovery_args: ["plan", "reorder-step", "--help"],
        }),
      ]),
    );
  });

  it("derives every closed positional-action family from authoritative domains", () => {
    const contracts = listPmSubcommandRefusalContracts();
    const actionParents = new Set(
      PM_COMMAND_POSITIONAL_CONTRACTS.filter(
        ({ slots }) => slots[0]?.required && slots[0].value_kind === "action",
      ).map(({ command }) => command),
    );

    expect(new Set(contracts.map(({ command }) => command))).toEqual(
      actionParents,
    );
    expect(
      contracts.find(({ command }) => command === "plan")?.allowed_values,
    ).toEqual(
      PM_POSITIONAL_ACTION_CONTRACTS.filter(({ parent }) => parent === "plan")
        .map(({ action }) => action)
        .sort(),
    );
    expect(contracts.find(({ command }) => command === "schema")).toMatchObject(
      {
        refusal_args: ["schema", "not-a-declared-action"],
        recovery_args: ["schema", "--help"],
      },
    );
  });

  it("fails closed when a required action family has no authoritative domain", () => {
    expect(() =>
      listPmSubcommandRefusalContracts([
        {
          command: "synthetic action-family",
          slots: [
            {
              name: "action",
              required: true,
              variadic: false,
              value_kind: "action",
              polymorphic: false,
            },
          ],
        },
      ]),
    ).toThrow(
      "Required positional action family synthetic action-family has no authoritative value domain.",
    );
  });

  it("synthesizes every supported preceding positional kind and rejects an action placeholder", () => {
    const contracts = listPmRequiredArgumentRefusalContracts([
      {
        command: "synthetic integer",
        slots: [
          {
            name: "count",
            required: true,
            variadic: false,
            value_kind: "integer",
            polymorphic: false,
          },
          {
            name: "label",
            required: true,
            variadic: false,
            value_kind: "string",
            polymorphic: false,
          },
          {
            name: "ignored",
            required: false,
            variadic: false,
            value_kind: "string",
            polymorphic: false,
          },
        ],
      },
    ]);
    expect(
      contracts.find(({ missing_argument: argument }) => argument === "label")
        ?.refusal_args,
    ).toEqual(["synthetic", "integer", "1"]);

    expect(() =>
      listPmRequiredArgumentRefusalContracts([
        {
          command: "synthetic action",
          slots: [
            {
              name: "action",
              required: true,
              variadic: false,
              value_kind: "action",
              polymorphic: false,
            },
            {
              name: "operand",
              required: true,
              variadic: false,
              value_kind: "string",
              polymorphic: false,
            },
          ],
        },
      ]),
    ).toThrow(
      "Cannot synthesize a preceding action value for positional slot action.",
    );
  });

  it("keeps a required boolean flag valueless in generated refusal argv", async () => {
    vi.resetModules();
    vi.doMock(
      "../../../../src/sdk/cli-contracts/flag-contracts.js",
      async (importOriginal) => ({
        ...(await importOriginal()),
        resolveSubcommandFlagContractsForCommand: () => [
          { flag: "--required-switch", required: true },
        ],
      }),
    );
    try {
      const { listPmRequiredArgumentRefusalContracts: listContracts } =
        await import("../../../../src/sdk/agent/refusal-corpus-contracts.js");
      expect(
        listContracts([
          {
            command: "synthetic boolean-flag",
            slots: [
              {
                name: "id",
                required: true,
                variadic: false,
                value_kind: "item_id",
                polymorphic: false,
              },
            ],
          },
        ])[0]?.refusal_args,
      ).toEqual(["synthetic", "boolean-flag", "--required-switch"]);
    } finally {
      vi.doUnmock("../../../../src/sdk/cli-contracts/flag-contracts.js");
      vi.resetModules();
    }
  });

  it("fails closed for missing probes, state mutation, code drift, and dead recovery", () => {
    const contracts = [
      ...listPmRequiredArgumentRefusalContracts(),
      ...listPmSubcommandRefusalContracts(),
    ].slice(0, 4);
    const observations = contracts.slice(0, 3).map((contract, index) => ({
      probe_id: contract.probe_id,
      error_code: index === 1 ? "wrong" : contract.error_code,
      exit_code: 2,
      allowed_values:
        "allowed_values" in contract ? [...contract.allowed_values] : [],
      recovery_succeeded: index !== 2,
      refusal_mutated_state: index === 0,
    }));

    expect(
      scorePmGrammarRefusalClosure(contracts, observations).findings.map(
        ({ code }) => code,
      ),
    ).toEqual(
      expect.arrayContaining([
        "refusal_probe_missing",
        "refusal_mutated_state",
        "refusal_error_code_mismatch",
        "refusal_recovery_failed",
      ]),
    );
  });

  it("reports exit, domain, empty-code, mutated-path, and unexpected-probe drift", () => {
    const contract = listPmSubcommandRefusalContracts().find(
      ({ command }) => command === "schema",
    )!;
    const unexpected = {
      probe_id: "unexpected-probe",
      error_code: "unknown_subcommand",
      exit_code: 2,
      allowed_values: [],
      recovery_succeeded: true,
      refusal_mutated_state: false,
    };
    const report = scorePmGrammarRefusalClosure(
      [contract],
      [
        {
          probe_id: contract.probe_id,
          error_code: "",
          exit_code: 1,
          allowed_values: ["wrong"],
          recovery_succeeded: false,
          refusal_mutated_state: true,
          mutated_paths: ["schema/types.json"],
        },
        unexpected,
      ],
    );

    expect(report).toMatchObject({
      ok: false,
      probe_count: 1,
      closed_probe_count: 0,
      findings: expect.arrayContaining([
        expect.objectContaining({ code: "refusal_allowed_values_mismatch" }),
        expect.objectContaining({ code: "refusal_error_code_mismatch" }),
        expect.objectContaining({ code: "refusal_exit_code_mismatch" }),
        expect.objectContaining({ code: "refusal_mutated_state" }),
        expect.objectContaining({ code: "refusal_recovery_failed" }),
        expect.objectContaining({ code: "unexpected_refusal_probe" }),
      ]),
    });
    expect(
      report.findings.find(({ code }) => code === "refusal_mutated_state")
        ?.detail,
    ).toContain("schema/types.json");

    expect(
      scorePmGrammarRefusalClosure(
        [contract],
        [
          {
            ...unexpected,
            probe_id: contract.probe_id,
            allowed_values: contract.allowed_values.map((value, index) =>
              index === 0 ? "wrong" : value,
            ),
          },
        ],
      ).findings,
    ).toEqual([
      expect.objectContaining({ code: "refusal_allowed_values_mismatch" }),
    ]);

    expect(
      scorePmGrammarRefusalClosure(
        [contract],
        [
          {
            ...unexpected,
            probe_id: contract.probe_id,
            allowed_values: [...contract.allowed_values].reverse(),
          },
        ],
      ),
    ).toMatchObject({ ok: true, closed_probe_count: 1, findings: [] });
  });
});
