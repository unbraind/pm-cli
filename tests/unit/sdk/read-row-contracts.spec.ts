import { describe, expect, it } from "vitest";
import {
  PM_READ_ROW_JQ_SELECTOR,
  attachOutputOmissionReceipt,
  isReadRowContract,
  resolveReadRowContract,
} from "../../../src/sdk/output-projection.js";

describe("read row contracts", () => {
  it("declares canonical rows and field support for core read results", () => {
    expect(
      resolveReadRowContract("list-open", { items: [{ id: "pm-a" }] }),
    ).toEqual({
      command: "list",
      row_keys: ["items"],
      fields: "supported",
      jq_selector: PM_READ_ROW_JQ_SELECTOR,
    });
    expect(
      resolveReadRowContract("next", {
        recommended: [{ id: "pm-a" }],
        ready: [],
      }),
    ).toMatchObject({
      command: "next",
      row_keys: ["recommended", "ready"],
      fields: "unsupported",
    });
  });

  it("derives graph row keys from the executed subcommand", () => {
    expect(
      resolveReadRowContract("graph", {
        subcommand: "impact",
        affected: [],
      }),
    ).toMatchObject({
      command: "graph",
      row_keys: ["affected"],
      fields: "unsupported",
    });
  });

  it("does not annotate package overrides that only share a command name", () => {
    expect(resolveReadRowContract("list", { result: [] })).toBeUndefined();
    expect(
      resolveReadRowContract("stats", { action: "stats" }),
    ).toBeUndefined();
    expect(resolveReadRowContract("graph", {})).toBeUndefined();
    expect(
      resolveReadRowContract("graph", {
        subcommand: "package-report",
        rows: [],
      }),
    ).toBeUndefined();
  });

  it("preserves an existing row declaration without replacing it", () => {
    const rowContract = {
      command: "package-list",
      row_keys: ["rows"],
      fields: "unsupported" as const,
      jq_selector: ".rows[]",
    };
    expect(
      attachOutputOmissionReceipt("list", {
        items: [],
        row_contract: rowContract,
      }),
    ).toMatchObject({ row_contract: rowContract });
  });

  it("replaces malformed declarations with the canonical row contract", () => {
    for (const invalid of [
      null,
      {},
      { command: "", row_keys: [], fields: "supported", jq_selector: ".x" },
      {
        command: "custom",
        row_keys: "rows",
        fields: "supported",
        jq_selector: ".x",
      },
      {
        command: "custom",
        row_keys: [1],
        fields: "supported",
        jq_selector: ".x",
      },
      {
        command: "custom",
        row_keys: [""],
        fields: "supported",
        jq_selector: ".x",
      },
      {
        command: "custom",
        row_keys: ["rows", "rows"],
        fields: "supported",
        jq_selector: ".x",
      },
      {
        command: "custom",
        row_keys: ["rows"],
        fields: "maybe",
        jq_selector: ".x",
      },
      {
        command: "custom",
        row_keys: ["rows"],
        fields: "supported",
        jq_selector: 1,
      },
      {
        command: "custom",
        row_keys: ["rows"],
        fields: "supported",
        jq_selector: " ",
      },
    ]) {
      expect(isReadRowContract(invalid)).toBe(false);
    }
    expect(
      isReadRowContract({
        command: "package-list",
        row_keys: ["rows"],
        fields: "unsupported",
        jq_selector: ".rows[]",
      }),
    ).toBe(true);
    expect(
      attachOutputOmissionReceipt("list", {
        items: [],
        row_contract: {},
      }),
    ).toMatchObject({
      row_contract: {
        command: "list",
        row_keys: ["items"],
        fields: "supported",
        jq_selector: PM_READ_ROW_JQ_SELECTOR,
      },
    });
    expect(
      attachOutputOmissionReceipt("package-report", {
        rows: [],
        row_contract: {},
      }),
    ).toEqual({ rows: [] });
  });

  it("attaches row metadata alongside omission evidence without changing rows", () => {
    const items = [{ id: "pm-a" }];
    const result = attachOutputOmissionReceipt("list", {
      items,
      projection: {
        mode: "compact",
        declared_field_groups: [
          { name: "full_item_fields", restore_with: "--full" },
        ],
        included_field_groups: [],
      },
    });
    expect(result).toMatchObject({
      items,
      row_contract: {
        row_keys: ["items"],
        fields: "supported",
      },
      omission_receipt: {
        has_omissions: true,
      },
    });
  });
});
