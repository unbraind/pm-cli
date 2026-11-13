import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runClaim, runRelease } from "../../../../src/sdk/lifecycle/claim.js";
import { readSessionState } from "../../../../src/core/session/session-state.js";
import { createTestItemId } from "../../../helpers/itemFactory.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";

/** An expired session-state lease from a crashed agent, as GH-1706 reproduces it. */
async function plantExpiredSessionLock(pmPath: string): Promise<string> {
  const lockPath = path.join(pmPath, "locks", "session-state.lock");
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  await fs.writeFile(
    lockPath,
    JSON.stringify({
      id: "session-state",
      pid: 1,
      owner: "session-state",
      created_at: "2000-01-01T00:00:00.000Z",
      ttl_seconds: 1800,
      token: "stale",
    }),
  );
  return lockPath;
}

describe("stale session-state lock (GH-1706)", () => {
  it("lets claim and release reclaim an expired session lease instead of refusing after the write", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "Stale session lease" });
      await plantExpiredSessionLock(context.pmPath);

      const claimed = await runClaim(id, false, { path: context.pmPath });
      expect(claimed).toMatchObject({ item: { id, assignee: "test-author" } });
      expect(claimed.warnings).toBeUndefined();
      expect(claimed.suggestions).toBeUndefined();
      expect((await readSessionState(context.pmPath)).semantic_attribution).toBeDefined();

      // The crashed agent's lease returns before the release: the release still succeeds once.
      await plantExpiredSessionLock(context.pmPath);
      const released = await runRelease(id, false, { path: context.pmPath });
      expect(released).toMatchObject({ item: { id }, changed_fields: ["assignee", "claim_principal"] });
      expect(released.item.assignee).toBeUndefined();
      expect(released.warnings).toBeUndefined();
      expect((await readSessionState(context.pmPath)).semantic_attribution).toBeUndefined();
    });
  });
});
