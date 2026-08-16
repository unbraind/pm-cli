import { describe, expect, it } from "vitest";
import { definePmErrorCodeCatalog } from "../../../src/sdk/error-code-catalog.js";
import {
  censusPmRecoveryReferenceProducers,
  derivePmRecoveryReferenceObligations,
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
      semantics: "recovery" as const,
      value: "pm schema add-type Example --json",
    },
    {
      id: "unknown:candidate-command:0",
      probe_id: "unknown",
      kind: "candidate_command" as const,
      semantics: "recovery" as const,
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
          semantics: "recovery",
        },
        {
          id: obligations[1].id,
          reachable: true,
          proof: "declared_command_path",
          semantics: "recovery",
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
        { kind: "migration_hint", declared: 0, observed: 0, passed: 0 },
        { kind: "restore_with", declared: 0, observed: 0, passed: 0 },
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
      {
        id: obligations[0].id,
        reachable: false,
        proof: "executed",
        semantics: "recovery",
      },
      {
        id: obligations[0].id,
        reachable: true,
        proof: "executed",
        semantics: "recovery",
      },
      {
        id: "orphan",
        reachable: true,
        proof: "linked_execution",
        semantics: "recovery",
      },
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
    const unique = { ...obligations[1]!, id: "unique-command" };
    const report = verifyPmRecoveryReferences(
      [obligations[0]!, duplicate, unique],
      [
        {
          id: obligations[0]!.id,
          reachable: true,
          proof: "executed",
          semantics: "recovery",
        },
        {
          id: unique.id,
          reachable: true,
          proof: "declared_command_path",
          semantics: "recovery",
        },
      ],
    );
    expect(report).toMatchObject({
      ok: false,
      declared_reference_count: 3,
      observed_reference_count: 2,
      pass_fraction: 0.5,
      coverage_by_kind: [
        { kind: "suggested_retry", declared: 1, observed: 0, passed: 0 },
        { kind: "candidate_command", declared: 2, observed: 1, passed: 1 },
        { kind: "example", declared: 0, observed: 0, passed: 0 },
        { kind: "next_step", declared: 0, observed: 0, passed: 0 },
        { kind: "migration_hint", declared: 0, observed: 0, passed: 0 },
        { kind: "restore_with", declared: 0, observed: 0, passed: 0 },
      ],
      findings: [expect.objectContaining({ kind: "duplicate_obligation" })],
    });
  });

  it("derives every typed producer family with source-path-stable semantics", () => {
    const derived = derivePmRecoveryReferenceObligations("probe", {
      recovery: {
        suggested_retry: "pm list --json",
        candidate_commands: ["list", "search"],
      },
      examples: ["pm list --status open"],
      next_steps: ["Run the bounded read"],
      migration_hints: ["Use --output-include"],
      output_budget_exceeded: { restore_with: "Unbounded" },
    });
    expect(derived.map(({ kind, semantics }) => [kind, semantics])).toEqual([
      ["example", "recovery"],
      ["migration_hint", "replacement"],
      ["next_step", "recovery"],
      ["restore_with", "behavior_preserving"],
      ["candidate_command", "recovery"],
      ["candidate_command", "recovery"],
      ["suggested_retry", "recovery"],
    ]);
    expect(new Set(derived.map(({ id }) => id)).size).toBe(derived.length);
  });

  it("censuses every literal producer kind and rejects uncontracted recovery fields", () => {
    const report = censusPmRecoveryReferenceProducers([
      {
        path: "src/producer.ts",
        content: `({
          suggested_retry: "pm list",
          candidate_commands: ["list"],
          examples: ["pm list"],
          next_steps: ["Run it"],
          migration_hint: "Use the replacement",
          restore_with: "Unbounded",
        })`,
      },
    ]);
    expect(report).toMatchObject({
      ok: true,
      scanned_file_count: 1,
      producer_count: 6,
      producer_count_by_kind: {
        suggested_retry: 1,
        candidate_command: 1,
        example: 1,
        next_step: 1,
        migration_hint: 1,
        restore_with: 1,
      },
      findings: [],
    });
    expect(report.producers[0]).toMatchObject({ path: "src/producer.ts", line: 2 });

    const broken = censusPmRecoveryReferenceProducers([
      {
        path: "src/broken.ts",
        content: `({ candidate_command_hint: "pm list", candidate_command_hint: "pm show" })`,
      },
    ]);
    expect(broken.ok).toBe(false);
    expect(broken.findings).toContainEqual(
      expect.objectContaining({ kind: "unknown_recovery_field" }),
    );
    expect(broken.findings.filter(({ kind }) => kind === "missing_kind_producer")).toHaveLength(6);

    const sorted = censusPmRecoveryReferenceProducers([
      { path: "src/z.ts", content: `({ examples: ["pm z"] })` },
      {
        path: "src/a.ts",
        content: `({ next_steps: ["Run"], examples: ["pm a"], candidate_command_total: 1 })`,
      },
    ]);
    expect(sorted.producers.map(({ path, field }) => `${path}:${field}`)).toEqual([
      "src/a.ts:examples",
      "src/a.ts:next_steps",
      "src/z.ts:examples",
    ]);

    const syntaxAware = censusPmRecoveryReferenceProducers([
      {
        path: "src/syntax.ts",
        content: `
          type RecoveryShape = { suggested_retry: string };
          // ({ candidate_command: "not executable" })
          const text = '({ examples: ["not executable"] })';
          const real = { "next_steps": ["Run it"] };
        `,
      },
      { path: "src/line-comment.ts", content: "// suggested_retry: never" },
      { path: "src/block-comment.ts", content: "/* candidate_command: never */" },
      { path: "src/identifier.ts", content: "identifier" },
    ]);
    expect(syntaxAware.producers).toEqual([
      expect.objectContaining({ field: "next_steps", kind: "next_step", line: 5 }),
    ]);
    expect(syntaxAware.producer_count_by_kind).toMatchObject({
      suggested_retry: 0,
      candidate_command: 0,
      example: 0,
      next_step: 1,
    });
  });

  it("keeps raw slash-bearing keys distinct from nested source paths", () => {
    const derived = derivePmRecoveryReferenceObligations("probe", {
      "a/b": { examples: ["pm list --status open"] },
      a: { b: { examples: ["pm list --status closed"] } },
    });
    expect(derived).toHaveLength(2);
    expect(new Set(derived.map(({ id }) => id)).size).toBe(2);
  });

  it("ignores empty recovery references and rejects mismatched semantics", () => {
    expect(
      derivePmRecoveryReferenceObligations("invalid", {
        examples: ["", 42, "pm list --status open"],
      }),
    ).toEqual([
      expect.objectContaining({
        kind: "example",
        semantics: "recovery",
        value: "pm list --status open",
      }),
    ]);

    const report = verifyPmRecoveryReferences(
      [obligations[0]!],
      [
        {
          id: obligations[0]!.id,
          reachable: true,
          proof: "executed",
          semantics: "replacement",
        },
      ],
    );
    expect(report).toMatchObject({ ok: false, pass_fraction: 0 });
    expect(report.findings).toContainEqual(
      expect.objectContaining({ kind: "wrong_semantics" }),
    );

    expect(
      derivePmRecoveryReferenceObligations("migration", {
        semantics: "behavior_preserving",
        migration_hint: "Use the stable replacement",
      }),
    ).toEqual([
      expect.objectContaining({
        kind: "migration_hint",
        semantics: "behavior_preserving",
      }),
    ]);
  });
});
