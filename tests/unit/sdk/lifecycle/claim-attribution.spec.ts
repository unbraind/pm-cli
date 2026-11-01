import { describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/sdk/context/semantic-session-attribution.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/sdk/context/semantic-session-attribution.js")>()),
  recordClaimSemanticAttribution: vi.fn().mockRejectedValue(new Error("session state lock busy")),
}));

import { CLAIM_ATTRIBUTION_UNRECORDED_WARNING, runClaim, runClaimNext } from "../../../../src/sdk/lifecycle/claim.js";
import { createTestItemId } from "../../../helpers/itemFactory.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";

describe("claim attribution after commit", () => {
  it("reports a committed claim and start with a warning when session attribution fails", async () => {
    await withTempPmPath(async (context) => {
      const explicit = createTestItemId(context, { title: "Explicit attribution", priority: "1" });
      expect(await runClaim(explicit, false, { path: context.pmPath })).toMatchObject({
        item: { id: explicit, assignee: "test-author" },
        warnings: [CLAIM_ATTRIBUTION_UNRECORDED_WARNING],
      });
      const ranked = createTestItemId(context, { title: "Ranked attribution", priority: "0" });
      expect(await runClaimNext(false, { path: context.pmPath }, { start: true })).toMatchObject({
        item: { id: ranked, status: "in_progress" },
        start: { to_status: "in_progress" },
        warnings: [CLAIM_ATTRIBUTION_UNRECORDED_WARNING],
      });
    });
  });
});
