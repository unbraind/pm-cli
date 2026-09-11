import { describe, expect, it } from "vitest";
import {
  createHistoryEntry,
  verifyHistoryRecordHash,
} from "../../../../src/core/history/history.js";
import {
  PM_HISTORY_OPERATION_CONTRACT,
  requireHistoryOperation,
  resolveHistoryOperation,
} from "../../../../src/core/history/operation-contract.js";
import { runContracts } from "../../../../src/sdk/cli-contracts/runtime-contracts.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";
import { HISTORY_SCHEMA_MIGRATION_OPERATIONS } from "../../../types/history-operation-families.test-d.js";
import type { ItemDocument } from "../../../../src/types/index.js";

describe("immutable operation contract", () => {
  it("enumerates core identities and rejects misspellings while supporting package namespaces", () => {
    for (const operation of Object.values(
      HISTORY_SCHEMA_MIGRATION_OPERATIONS,
    )) {
      expect(requireHistoryOperation(operation)).toBe(operation);
      expect(requireHistoryOperation(`${operation}_compensate`)).toBe(
        `${operation}_compensate`,
      );
    }
    for (const operation of [
      ...PM_HISTORY_OPERATION_CONTRACT.item,
      ...PM_HISTORY_OPERATION_CONTRACT.workspace,
    ])
      expect(requireHistoryOperation(operation)).toBe(operation);
    for (const operation of [
      "config:set:context.limit",
      "assurance:gate:put",
      "schema_rename_field_compensate",
      "extension:domain_pack:approve",
    ])
      expect(requireHistoryOperation(operation)).toBe(operation);
    for (const operation of [
      "updaet",
      "init:type--preset",
      "extension::approve",
      "extension:domain:Approve",
      "config:set:",
      "__proto__",
    ])
      expect(() => requireHistoryOperation(operation)).toThrow(
        /Undeclared history operation/,
      );
    expect(resolveHistoryOperation("future_unknown")).toBe("future_unknown");
    expect(resolveHistoryOperation("init:type-preset")).toBe(
      "init:type_preset",
    );
  });

  it("discloses the catalogue through targeted and full SDK contracts without inflating narrow projections", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const global = { path: pmPath };
      expect(
        (await runContracts({ command: "history" }, global)).history_operations,
      ).toEqual(PM_HISTORY_OPERATION_CONTRACT);
      expect(
        (await runContracts({ full: true }, global)).history_operations,
      ).toEqual(PM_HISTORY_OPERATION_CONTRACT);
      for (const projection of [
        { flagsOnly: true },
        { schemaOnly: true },
        { availabilityOnly: true },
        { summary: true },
      ]) {
        expect(
          (await runContracts({ command: "history", ...projection }, global))
            .history_operations,
        ).toBeUndefined();
      }
    });
  });

  it("canonicalizes aliases before sealing and preserves valid custom SDK operations", () => {
    const empty = { metadata: {}, body: "" } as ItemDocument;
    const input = {
      nowIso: "2026-01-01T00:00:00.000Z",
      author: "fixture",
      before: empty,
      after: empty,
    };
    const entry = createHistoryEntry({ ...input, op: "init:type-preset" });
    expect(entry.op).toBe("init:type_preset");
    expect(verifyHistoryRecordHash(entry).ok).toBe(true);
    expect(createHistoryEntry({ ...input, op: "custom_review" }).op).toBe(
      "custom_review",
    );
    expect(
      createHistoryEntry({
        ...input,
        op: "schema_migration_reference:retry:schema/WorkItem.json",
      }).op,
    ).toBe("schema_migration_reference:retry:schema/WorkItem.json");
    expect(() => createHistoryEntry({ ...input, op: "bad operation" })).toThrow(
      /History operation must/,
    );
  });
});
