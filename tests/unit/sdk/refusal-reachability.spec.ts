import { describe, expect, it } from "vitest";
import { definePmErrorCodeCatalog } from "../../../src/sdk/error-code-catalog.js";
import {
  verifyPmRecoveryReferences,
  verifyPmRefusalReachability,
} from "../../../src/sdk/agent/refusal-reachability.js";

const catalog = definePmErrorCodeCatalog([
  {
    code: "unknown_subcommand",
    meaning: "A nested command token is unknown.",
    stability: "stable",
    exit_code: 2,
    class: "usage",
    recovery: "Use a declared subcommand.",
    sources: ["cli"],
    emitting_commands: ["schema"],
    owned_states: [
      {
        state: "nested_token_is_unknown",
        probe_id: "schema-unknown-subcommand",
        entrypoints: ["schema"],
        expected_exit_class: "usage",
      },
    ],
  },
  {
    code: "generic_failure",
    meaning: "A generic failure without an owned refusal state.",
    stability: "provisional",
    exit_code: 1,
    class: "generic_failure",
    recovery: "Inspect the failure.",
    sources: ["sdk"],
    emitting_commands: ["*"],
  },
]);

describe("refusal reachability", () => {
  it("accepts matching real-entrypoint observations", () => {
    expect(
      verifyPmRefusalReachability(catalog, [
        {
          probe_id: "schema-unknown-subcommand",
          entrypoint: "schema",
          code: "unknown_subcommand",
          exit_class: "usage",
        },
      ]),
    ).toEqual({
      ok: true,
      declared_probe_count: 1,
      observed_probe_count: 1,
      findings: [],
    });
    expect(
      verifyPmRefusalReachability(
        [{ ...catalog[0]!, owned_states: undefined }],
        [],
      ),
    ).toMatchObject({ ok: true, declared_probe_count: 0 });
  });

  it("fails closed for missing, mistyped, duplicated, and undeclared observations", () => {
    expect(verifyPmRefusalReachability(catalog, []).findings).toContainEqual(
      expect.objectContaining({ kind: "missing_probe" }),
    );
    const report = verifyPmRefusalReachability(catalog, [
      {
        probe_id: "schema-unknown-subcommand",
        entrypoint: "graph",
        code: "unclassified_runtime_error",
        exit_class: "generic_failure",
      },
      {
        probe_id: "orphan-probe",
        entrypoint: "schema",
        code: "unknown_subcommand",
        exit_class: "usage",
      },
      {
        probe_id: "schema-unknown-subcommand",
        entrypoint: "schema",
        code: "unknown_subcommand",
        exit_class: "usage",
      },
    ]);
    expect(report.ok).toBe(false);
    expect(report.findings.map(({ kind }) => kind)).toEqual([
      "undeclared_probe",
      "duplicate_probe",
      "wrong_entrypoint",
      "wrong_error_code",
      "wrong_exit_class",
    ]);
  });
});

describe("recovery-reference reachability", () => {
  const obligations = [
    {
      id: "unknown:suggested-retry:0",
      probe_id: "unknown",
      kind: "suggested_retry" as const,
      value: "pm schema add-type Example --json",
    },
    {
      id: "unknown:candidate-command:0",
      probe_id: "unknown",
      kind: "candidate_command" as const,
      value: "schema",
    },
  ];

  it("reports complete per-kind coverage for executable promises", () => {
    expect(
      verifyPmRecoveryReferences(obligations, [
        {
          id: obligations[0].id,
          reachable: true,
          proof: "executed",
        },
        {
          id: obligations[1].id,
          reachable: true,
          proof: "declared_command_path",
        },
      ]),
    ).toMatchObject({
      ok: true,
      declared_reference_count: 2,
      observed_reference_count: 2,
      pass_fraction: 1,
      coverage_by_kind: [
        { kind: "suggested_retry", declared: 1, observed: 1, passed: 1 },
        { kind: "candidate_command", declared: 1, observed: 1, passed: 1 },
        { kind: "example", declared: 0, observed: 0, passed: 0 },
        { kind: "next_step", declared: 0, observed: 0, passed: 0 },
      ],
      findings: [],
    });
    expect(verifyPmRecoveryReferences([], [])).toMatchObject({
      ok: true,
      pass_fraction: 1,
    });
  });

  it("fails closed for missing, duplicate, unreachable, and undeclared proof", () => {
    const report = verifyPmRecoveryReferences(obligations, [
      { id: obligations[0].id, reachable: false, proof: "executed" },
      { id: obligations[0].id, reachable: true, proof: "executed" },
      { id: "orphan", reachable: true, proof: "linked_execution" },
    ]);
    expect(report).toMatchObject({ ok: false, pass_fraction: 0 });
    expect(report.findings.map(({ kind }) => kind)).toEqual([
      "undeclared_observation",
      "missing_observation",
      "duplicate_observation",
      "unreachable_reference",
    ]);
  });

  it("does not let one observation discharge duplicate obligation ids", () => {
    const duplicate = { ...obligations[1]!, id: obligations[0]!.id };
    const report = verifyPmRecoveryReferences(
      [obligations[0]!, duplicate],
      [{ id: obligations[0]!.id, reachable: true, proof: "executed" }],
    );
    expect(report).toMatchObject({
      ok: false,
      declared_reference_count: 2,
      observed_reference_count: 1,
      pass_fraction: 0,
      coverage_by_kind: [
        { kind: "suggested_retry", declared: 1, observed: 0, passed: 0 },
        { kind: "candidate_command", declared: 1, observed: 0, passed: 0 },
        { kind: "example", declared: 0, observed: 0, passed: 0 },
        { kind: "next_step", declared: 0, observed: 0, passed: 0 },
      ],
      findings: [expect.objectContaining({ kind: "duplicate_obligation" })],
    });
  });
});
