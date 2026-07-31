import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  PM_READ_ROW_CONTRACTS,
  resolveReadRowContract,
} from "../../src/sdk/output-projection.js";

describe("universal read row jq selector", () => {
  it("iterates every declared array and map row without publishing vacuous selectors", () => {
    for (const [command, declaration] of Object.entries(
      PM_READ_ROW_CONTRACTS,
    )) {
      const result: Record<string, unknown> = {};
      for (const [index, key] of declaration.row_keys.entries()) {
        const segments = key.split(".");
        let owner = result;
        for (const segment of segments.slice(0, -1)) {
          owner[segment] ??= {};
          owner = owner[segment] as Record<string, unknown>;
        }
        owner[segments.at(-1)!] =
          index % 2 === 0
            ? [{ key, ordinal: 1 }]
            : { [key]: { ordinal: 1 } };
      }
      const sentinelByCommand: Readonly<Record<string, string>> = {
        context: "sections_included",
        get: "item",
        list: "projection",
        next: "recommended",
        search: "projection",
        activity: "activity",
        history: "history",
        deps: "tree",
        health: "checks",
        aggregate: "groups",
        duplicates: "clusters",
        stats: "totals",
      };
      result[sentinelByCommand[command]!] ??= {};
      const rowContract = resolveReadRowContract(command, result);
      expect(rowContract).toBeDefined();
      if (declaration.row_keys.length === 0) {
        expect(rowContract).toMatchObject({
          row_kind: "none",
          row_keys: [],
        });
        expect(rowContract?.jq_selector).toBeUndefined();
        continue;
      }
      const envelope = JSON.stringify({ ...result, row_contract: rowContract });
      const selected = execFileSync(
        "jq",
        ["-c", rowContract!.jq_selector!],
        {
          encoding: "utf8",
          input: envelope,
          windowsHide: true,
        },
      )
        .trim()
        .split("\n")
        .filter(Boolean);
      expect(selected).toHaveLength(declaration.row_keys.length);
    }
  });
});
