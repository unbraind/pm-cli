import { describe, expect, it } from "vitest";

import {
  evaluateAssuranceGate,
  type AssuranceDocument,
} from "../../../../src/sdk/governance/assurance.js";
import { createAssuranceWorkspaceContext } from "../../../../src/sdk/governance/assurance-runtime.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";

describe("canonical graph composition policy", () => {
  it("permits honest mixed growth, rejects associative dilution, and preserves terminal evidence", async () => {
    await withTempPmPath(async ({ pmPath, runCliInProcess }) => {
      const ids: string[] = [];
      for (const title of ["Owner", "Evidence", "Sibling", "New sibling", "New evidence", "More evidence"]) {
        const created = await runCliInProcess(["create", "--title", title, "--type", "Task", "--json"], { expectJson: true });
        expect(created.code).toBe(0);
        ids.push((created.json as { item: { id: string } }).item.id);
      }
      const owner = ids[0]!;
      const document: AssuranceDocument = {
        version: 1,
        measurements: [{ id: "semantic-share", source: { kind: "graph", operation: "audit", field: "profile.semantic_edge_share" } }],
        assertions: [{
          id: "composition-floor", measurement_id: "semantic-share", owner_item_id: owner,
          scope: { kind: "all" }, floor: 0.4, lifetime: "hold", enforcement: "block",
          negative_control: { cases: [{ observed: 0.4, expected: "pass" }, { observed: 0.399, expected: "fail" }] },
        }],
        gates: [{ id: "composition", assertion_ids: ["composition-floor"], triggers: ["ci"] }],
      };
      for (const [target, kind, verdict] of [
        [ids[1]!, "verifies", "pass"],
        [ids[2]!, "related", "pass"],
        [ids[3]!, "related_to", "block"],
        [ids[4]!, "verifies", "pass"],
        [ids[5]!, "discovered_from", "pass"],
      ] as const) {
        const updated = await runCliInProcess(["update", owner, "--dep", `id=${target},kind=${kind}`, "--json"], { expectJson: true });
        expect(updated.code).toBe(0);
        const context = await createAssuranceWorkspaceContext(pmPath, { resolve_tree: false });
        expect(await evaluateAssuranceGate("composition", document, context, { trigger: "ci", dry_run: true })).toMatchObject({ verdict });
      }
      const closed = await runCliInProcess(["close", owner, "Composition verified", "--resolution", "Evidence retained", "--expected", "Mixed growth passes", "--actual", "Mixed growth passed", "--validate-close", "warn", "--json"], { expectJson: true });
      expect(closed.code).toBe(0);
      const context = await createAssuranceWorkspaceContext(pmPath, { resolve_tree: false });
      expect(await evaluateAssuranceGate("composition", document, context, { trigger: "ci", dry_run: true })).toMatchObject({ verdict: "pass" });
      expect(await context.external({ kind: "graph", operation: "audit", field: "profile.edges_by_kind.related" })).toMatchObject({ value: 2 });
    });
  });
});
