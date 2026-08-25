import { describe, expect, it } from "vitest";

import { listCoreClosedDomainContracts } from "../../../../src/sdk/agent/closed-domain-contracts.js";
import {
  buildPmRefusalClosureCensus,
  PM_REFUSAL_CLOSURE_EXECUTABLE_CANONICAL_CODE_BASELINE_V2,
  PM_REFUSAL_CLOSURE_EXECUTABLE_CODE_BASELINE_V2,
  renderPmRefusalClosureCensusMarkdown,
  verifyPmRefusalClosureIdentityRatchet,
  verifyPmRefusalClosureRatchet,
} from "../../../../src/sdk/agent/refusal-closure-census.js";
import {
  listPmRequiredArgumentRefusalContracts,
  listPmSubcommandRefusalContracts,
} from "../../../../src/sdk/agent/refusal-corpus-contracts.js";
import { definePmErrorCodeCatalog } from "../../../../src/sdk/error-code-catalog.js";
import { PM_ERROR_CODE_CATALOG } from "../../../../src/sdk/generated-error-code-catalog.js";

describe("refusal closure census", () => {
  it("joins every catalog code to executable evidence or an explicit uncovered row", () => {
    const catalog = definePmErrorCodeCatalog([
      {
        code: "owned",
        meaning: "Owned state.",
        stability: "stable",
        exit_code: 2,
        class: "usage",
        recovery: "Recover.",
        sources: ["cli"],
        emitting_commands: ["list"],
        owned_states: [
          {
            state: "owned_state",
            probe_id: "owned-state",
            entrypoints: ["list"],
            expected_exit_class: "usage",
          },
        ],
      },
      {
        code: "uncovered",
        meaning: "No executable proof.",
        stability: "provisional",
        exit_code: 1,
        class: "generic_failure",
        recovery: "Inspect.",
        sources: ["sdk"],
        emitting_commands: ["*"],
      },
    ]);

    const report = buildPmRefusalClosureCensus(catalog, [], []);
    expect(report).toMatchObject({
      ok: false,
      catalog_error_code_count: 2,
      executable_error_code_count: 1,
      uncovered_error_code_count: 1,
      coverage_fraction: 0.5,
      uncovered_error_codes: ["uncovered"],
    });
    expect(report.rows).toEqual([
      expect.objectContaining({ code: "owned", disposition: "executable" }),
      expect.objectContaining({ code: "uncovered", disposition: "uncovered" }),
    ]);
  });

  it("sorts catalog codes by locale-independent code units", () => {
    const catalog = ["aa", "z_code", "a_z"].map((code) => ({
      code,
      meaning: "Ordering fixture.",
      stability: "provisional" as const,
      exit_code: 1,
      class: "generic_failure" as const,
      recovery: "Inspect.",
      sources: ["sdk"] as const,
      emitting_commands: ["*"] as const,
    }));

    expect(
      buildPmRefusalClosureCensus(catalog, [], []).rows.map(({ code }) => code),
    ).toEqual(["a_z", "aa", "z_code"]);
  });

  it("reports the complete live catalog and all generated refusal families", () => {
    const closedDomains = listCoreClosedDomainContracts();
    const grammar = [
      ...listPmRequiredArgumentRefusalContracts(),
      ...listPmSubcommandRefusalContracts(),
    ];
    const report = buildPmRefusalClosureCensus(
      PM_ERROR_CODE_CATALOG,
      closedDomains,
      grammar,
    );

    expect(report.catalog_error_code_count).toBe(PM_ERROR_CODE_CATALOG.length);
    expect(report.closed_domain_probe_count).toBe(closedDomains.length);
    expect(report.grammar_probe_count).toBe(grammar.length);
    expect(report.executable_error_code_count).toBeGreaterThan(6);
    expect(
      report.executable_error_code_count + report.uncovered_error_code_count,
    ).toBe(report.catalog_error_code_count);
    expect(renderPmRefusalClosureCensusMarkdown(report)).toContain(
      "Every catalog code is listed",
    );
    expect(verifyPmRefusalClosureRatchet(report)).toEqual({
      ok: true,
      baseline: PM_REFUSAL_CLOSURE_EXECUTABLE_CODE_BASELINE_V2,
      actual: report.executable_error_code_count,
    });
    expect(verifyPmRefusalClosureIdentityRatchet(report)).toEqual({
      ok: true,
      required_canonical_codes: [
        ...PM_REFUSAL_CLOSURE_EXECUTABLE_CANONICAL_CODE_BASELINE_V2,
      ],
      missing_required_canonical_codes: [],
    });
    expect(
      verifyPmRefusalClosureRatchet(
        { ...report, executable_error_code_count: 12 },
        PM_REFUSAL_CLOSURE_EXECUTABLE_CODE_BASELINE_V2,
      ).ok,
    ).toBe(false);

    const identityRegression = {
      ...report,
      rows: report.rows.map((row, index) =>
        row.canonical_code === "invalid_argument_value"
          ? { ...row, disposition: "uncovered" as const }
          : index === 0 && row.disposition === "uncovered"
            ? { ...row, disposition: "executable" as const }
            : row,
      ),
    };
    expect(
      verifyPmRefusalClosureIdentityRatchet(identityRegression),
    ).toMatchObject({
      ok: false,
      missing_required_canonical_codes: ["invalid_argument_value"],
    });
  });

  it("joins aliases and every evidence family while ignoring foreign probe codes", () => {
    const catalog = definePmErrorCodeCatalog([
      {
        code: "canonical",
        meaning: "Canonical state.",
        stability: "stable",
        exit_code: 2,
        class: "usage",
        recovery: "Recover.",
        sources: ["cli"],
        emitting_commands: ["list"],
        aliases: ["compatibility_alias"],
      },
      {
        code: "compatibility_alias",
        canonical_code: "canonical",
        meaning: "Compatibility spelling.",
        stability: "stable",
        exit_code: 2,
        class: "usage",
        recovery: "Recover.",
        sources: ["cli"],
        emitting_commands: ["list"],
      },
    ]);
    const report = buildPmRefusalClosureCensus(
      catalog,
      [
        { error_code: "canonical", probe_id: "closed-z" },
        { error_code: "foreign", probe_id: "ignored-closed" },
      ] as never,
      [
        { error_code: "compatibility_alias", probe_id: "grammar-a" },
        { error_code: "foreign", probe_id: "ignored-grammar" },
      ] as never,
    );

    expect(report).toMatchObject({
      ok: true,
      catalog_error_code_count: 2,
      executable_error_code_count: 2,
      coverage_fraction: 1,
      closed_domain_probe_count: 1,
      grammar_probe_count: 1,
    });
    expect(report.rows).toEqual([
      {
        code: "canonical",
        canonical_code: "canonical",
        disposition: "executable",
        evidence_kinds: ["closed_domain", "grammar"],
        probe_ids: ["closed-z", "grammar-a"],
      },
      {
        code: "compatibility_alias",
        canonical_code: "canonical",
        disposition: "executable",
        evidence_kinds: ["closed_domain", "grammar"],
        probe_ids: ["closed-z", "grammar-a"],
      },
    ]);
  });

  it("defines empty-catalog closure and renders rows with no evidence", () => {
    expect(buildPmRefusalClosureCensus([], [], [])).toMatchObject({
      ok: true,
      coverage_fraction: 1,
      rows: [],
    });
    const report = buildPmRefusalClosureCensus(
      definePmErrorCodeCatalog([
        {
          code: "uncovered",
          meaning: "No executable proof.",
          stability: "provisional",
          exit_code: 1,
          class: "generic_failure",
          recovery: "Inspect.",
          sources: ["sdk"],
          emitting_commands: ["*"],
        },
      ]),
      [],
      [],
    );
    expect(renderPmRefusalClosureCensusMarkdown(report)).toContain(
      "| `uncovered` | `uncovered` | uncovered | none | 0 |",
    );
    expect(
      buildPmRefusalClosureCensus(
        [
          {
            code: "raw-contract",
            meaning: "Unnormalized contract.",
            stability: "provisional",
            exit_code: 1,
            class: "generic_failure",
            recovery: "Inspect.",
            sources: ["sdk"],
            emitting_commands: ["*"],
          },
        ],
        [],
        [],
      ).rows,
    ).toEqual([
      expect.objectContaining({
        code: "raw-contract",
        canonical_code: "raw-contract",
        disposition: "uncovered",
      }),
    ]);
  });
});
