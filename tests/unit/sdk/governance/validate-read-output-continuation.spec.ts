/**
 * @file Exercises resumable budget degradation for validate diagnostics.
 */
import { describe, expect, it } from "vitest";
import {
  applyReadOutputDimensions,
  type PmReadOutputTruncationDisclosure,
} from "../../../../src/sdk/read-output-contracts.js";
import { readOutputRowCollections } from "../../../../src/sdk/read-output-rows.js";

function diagnosticResult(
  detailKey: "missing_resolution_rows" | "history_drift_rows",
): Record<string, unknown> {
  return {
    status: "invalid",
    checks: [
      {
        name: "diagnostics",
        details: {
          [detailKey]: Array.from({ length: 40 }, (_, index) => ({
            id: `pm-${index}`,
            detail: `${index}-${"diagnostic context ".repeat(50)}`,
          })),
        },
      },
    ],
    projection: {
      mode: "full",
      declared_field_groups: [
        { name: "diagnostic_rows", restore_with: "--full" },
      ],
      included_field_groups: ["diagnostic_rows"],
    },
    row_contract: {
      command: "validate",
      row_kind: "collection",
      row_keys: ["checks", "warnings"],
      fields: "unsupported",
      jq_selector: ".row_contract.row_keys[]",
    },
  };
}

describe("validate read-output continuation", () => {
  it.each(["missing_resolution_rows", "history_drift_rows"] as const)(
    "continues budget-truncated %s without repeating retained diagnostics",
    (detailKey) => {
      const first = applyReadOutputDimensions(
        "validate",
        { outputBudget: 1_200 },
        diagnosticResult(detailKey),
      );
      const truncation = first.output_budget_truncation as
        | PmReadOutputTruncationDisclosure
        | undefined;
      const cursor = first.next_cursor;
      expect(first).toMatchObject({
        continuation_kind: "output_cursor",
        truncated: true,
        row_contract: {
          jq_selector: ".row_contract.row_keys[]",
        },
      });
      expect(truncation).toMatchObject({
        continuation_available: true,
        continuations: [
          expect.objectContaining({
            path: `checks.0.details.${detailKey}`,
            remaining_rows: expect.any(Number),
          }),
        ],
        recovery: {
          cli: "--output-cursor",
          sdk: "outputCursor",
          mcp: "outputCursor",
        },
      });
      expect(typeof cursor).toBe("string");

      const second = applyReadOutputDimensions(
        "validate",
        { outputBudget: 1_200, outputCursor: cursor },
        diagnosticResult(detailKey),
      );
      const firstRows = ((
        first.checks as Array<{ details: Record<string, unknown[]> }>
      )[0]!.details[detailKey] ?? []) as Array<{ id: string }>;
      const secondRows = ((
        second.checks as Array<{ details: Record<string, unknown[]> }>
      )[0]!.details[detailKey] ?? []) as Array<{ id: string }>;
      expect(firstRows.length).toBeGreaterThan(0);
      expect(secondRows.length).toBeGreaterThan(0);
      expect(secondRows[0]!.id).toBe(`pm-${firstRows.length}`);
      expect(secondRows.map(({ id }) => id)).not.toEqual(
        expect.arrayContaining(firstRows.map(({ id }) => id)),
      );
    },
  );

  it("declares diagnostics without a pre-existing row contract", () => {
    const result = diagnosticResult("missing_resolution_rows");
    delete result.row_contract;
    expect(
      applyReadOutputDimensions("validate", { outputBudget: 1_200 }, result),
    ).toMatchObject({
      continuation_kind: "output_cursor",
      row_contract: {
        row_keys: ["checks.0.details.missing_resolution_rows"],
        jq_selector: ".checks[].details",
      },
    });
  });

  it("leaves absent and already-declared diagnostic collections unchanged", () => {
    const withoutDiagnostics = {
      status: "valid",
      checks: [{ name: "diagnostics", details: { checked: 1 } }],
      projection: {
        declared_field_groups: [{ name: "diagnostic_rows" }],
      },
    };
    expect(
      applyReadOutputDimensions(
        "validate",
        { outputLimit: 1 },
        withoutDiagnostics,
      ),
    ).not.toHaveProperty("row_contract");

    const alreadyDeclared = diagnosticResult("history_drift_rows");
    alreadyDeclared.row_contract = {
      row_keys: ["checks.0.details.history_drift_rows"],
    };
    expect(
      applyReadOutputDimensions(
        "validate",
        { outputLimit: 1 },
        alreadyDeclared,
      ),
    ).toMatchObject({
      row_contract: {
        row_keys: ["checks.0.details.history_drift_rows"],
      },
    });
  });

  it("rejects non-numeric array segments while resolving declared rows", () => {
    expect(
      readOutputRowCollections({
        checks: [{ details: { rows: ["one"] } }],
        row_contract: { row_keys: ["checks.invalid.details.rows"] },
      }),
    ).toEqual([]);
  });
});
