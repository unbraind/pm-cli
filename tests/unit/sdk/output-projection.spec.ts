import { describe, expect, it } from "vitest";
import {
  PM_MODE_PAIRED_OUTPUT_PROJECTION_CONTRACTS,
  attachOutputOmissionReceipt,
  createOutputOmissionReceipt,
  resolveModePairedOutputOmissionReceipt,
} from "../../../src/sdk/output-projection.js";

describe("output projection omission contracts", () => {
  it("derives explicit complete and incomplete receipts from contract data", () => {
    for (const contract of PM_MODE_PAIRED_OUTPUT_PROJECTION_CONTRACTS) {
      expect(
        resolveModePairedOutputOmissionReceipt(
          contract.command,
          contract.complete_mode,
        ),
      ).toEqual({
        has_omissions: false,
        omitted_field_group_count: 0,
        omitted_field_groups: [],
      });
      for (const [mode, groups] of Object.entries(
        contract.omissions_by_mode,
      )) {
        expect(
          resolveModePairedOutputOmissionReceipt(contract.command, mode),
        ).toEqual({
          has_omissions: true,
          omitted_field_group_count: groups.length,
          omitted_field_groups: groups,
        });
      }
    }
  });

  it("fails closed for unknown command modes and derives undeclared fixtures", () => {
    expect(() =>
      resolveModePairedOutputOmissionReceipt("unknown", "compact"),
    ).toThrow("Unknown mode-paired output command");
    expect(() =>
      resolveModePairedOutputOmissionReceipt("history", "summary"),
    ).toThrow("Unknown history output mode");
    expect(
      createOutputOmissionReceipt(
        [
          { name: "known", restore_with: "--known" },
          { name: "future_fixture", restore_with: "--future" },
        ],
        new Set(["known"]),
      ),
    ).toEqual({
      has_omissions: true,
      omitted_field_group_count: 1,
      omitted_field_groups: [
        { name: "future_fixture", restore_with: "--future" },
      ],
    });
  });

  it("attaches bounded receipts to context, get, list, and search shapes", () => {
    const context = attachOutputOmissionReceipt("context", {
      sections_included: ["hierarchy"],
      high_level: Array.from({ length: 100 }, (_, index) => ({ id: index })),
    }) as Record<string, unknown>;
    expect(context.omission_receipt).toMatchObject({
      has_omissions: true,
      omitted_field_group_count: 10,
    });

    const briefGet = attachOutputOmissionReceipt("get", {
      item: { id: "pm-1" },
    }) as Record<string, unknown>;
    expect(briefGet.omission_receipt).toMatchObject({
      omitted_field_group_count: 3,
      omitted_field_groups: [
        { name: "children", restore_with: "--fields children" },
        { name: "claim_state", restore_with: "--fields claim_state" },
        { name: "linked", restore_with: "--fields linked" },
      ],
    });
    const completeGet = attachOutputOmissionReceipt("get", {
      item: { id: "pm-1" },
      children: [],
      claim_state: { claimed: false },
      linked: {},
    }) as Record<string, unknown>;
    expect(completeGet.omission_receipt).toMatchObject({
      has_omissions: false,
    });

    for (const command of ["list-open", "search"]) {
      const projected = attachOutputOmissionReceipt(command, {
        projection: { mode: "brief", fields: ["id"] },
        items: [],
      }) as Record<string, unknown>;
      expect(projected.omission_receipt).toMatchObject({
        omitted_field_group_count: 1,
      });
    }
    const legacySearch = attachOutputOmissionReceipt("search", {
      items: [],
    }) as Record<string, unknown>;
    expect(legacySearch.omission_receipt).toMatchObject({
      omitted_field_groups: [
        { name: "projection_metadata", restore_with: "--full" },
      ],
    });
    const health = attachOutputOmissionReceipt("health", {
      projection: { mode: "brief" },
      checks: [],
    }) as Record<string, unknown>;
    expect(health.omission_receipt).toMatchObject({
      omitted_field_groups: [
        { name: "full_check_details", restore_with: "--full" },
      ],
    });
    expect(
      attachOutputOmissionReceipt("health", {
        projection: { mode: "full" },
        checks: [],
      }),
    ).toMatchObject({
      omission_receipt: { has_omissions: false },
    });
    expect(
      attachOutputOmissionReceipt("health", {
        projection: {},
        checks: [],
      }),
    ).not.toHaveProperty("omission_receipt");
    expect(
      attachOutputOmissionReceipt("health", {
        checks: [{ name: "storage", ok: true }],
      }),
    ).toMatchObject({
      omission_receipt: { has_omissions: false },
    });
    const contracts = attachOutputOmissionReceipt("contracts", {
      selected: { summary: false },
      commands: [],
    }) as Record<string, unknown>;
    expect(contracts.omission_receipt).toMatchObject({
      has_omissions: false,
      omitted_field_groups: [],
    });
    expect(
      attachOutputOmissionReceipt("contracts", {
        selected: { summary: true },
        command_summaries: [],
      }),
    ).toMatchObject({
      omission_receipt: { omitted_field_group_count: 1 },
    });
    expect(
      attachOutputOmissionReceipt("contracts", {
        selected: {},
      }),
    ).not.toHaveProperty("omission_receipt");
    expect(attachOutputOmissionReceipt("stats", { totals: {} })).toEqual({
      totals: {},
    });
    expect(
      attachOutputOmissionReceipt("get", {
        item: { id: "pm-1" },
        omission_receipt: { has_omissions: false },
      }),
    ).toEqual({
      item: { id: "pm-1" },
      omission_receipt: { has_omissions: false },
    });
    expect(attachOutputOmissionReceipt(undefined, {})).toEqual({});
    expect(attachOutputOmissionReceipt("get", [])).toEqual([]);
  });
});
