import { describe, expect, it } from "vitest";
import { definePmErrorCodeCatalog } from "../../../src/sdk/error-code-catalog.js";
import { verifyPmRefusalReachability } from "../../../src/sdk/agent/refusal-reachability.js";

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

  it("fails closed for missing, mistyped, and undeclared observations", () => {
    expect(verifyPmRefusalReachability(catalog, []).findings).toContainEqual(
      expect.objectContaining({ kind: "missing_probe" }),
    );
    const report = verifyPmRefusalReachability(catalog, [
      {
        probe_id: "schema-unknown-subcommand",
        code: "unclassified_runtime_error",
        exit_class: "generic_failure",
      },
      {
        probe_id: "orphan-probe",
        code: "unknown_subcommand",
        exit_class: "usage",
      },
    ]);
    expect(report.ok).toBe(false);
    expect(report.findings.map(({ kind }) => kind)).toEqual([
      "undeclared_probe",
      "wrong_error_code",
      "wrong_exit_class",
    ]);
  });
});
