import { describe, expect, it, vi } from "vitest";
import { EXIT_CODE } from "../../../../src/core/shared/constants.js";
import { PmCliError } from "../../../../src/core/shared/errors.js";

const releaseAttribution = vi.hoisted(() => ({ next: undefined as unknown }));

vi.mock("../../../../src/sdk/context/semantic-session-attribution.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/sdk/context/semantic-session-attribution.js")>()),
  recordClaimSemanticAttribution: vi.fn().mockRejectedValue(new Error("session state lock busy")),
  recordReleaseSemanticAttribution: vi.fn().mockImplementation(() => Promise.reject(releaseAttribution.next)),
}));

import {
  CLAIM_ATTRIBUTION_UNRECORDED_WARNING,
  RELEASE_ATTRIBUTION_UNRECORDED_WARNING,
  isAlreadyClaimedError,
  runClaim,
  runClaimNext,
  runRelease,
} from "../../../../src/sdk/lifecycle/claim.js";
import { renderPmCommand } from "../../../../src/core/shared/command-line.js";
import { createTestItemId } from "../../../helpers/itemFactory.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";

/** The suggestion's recovery commands, scoped to the tracker the call selected. */
function attributionHint(pmPath: string): string {
  return `If ${renderPmCommand(["--pm-path", pmPath, "health"])} reports a stale lock, remove it with ${renderPmCommand(["--pm-path", pmPath, "gc", "--scope", "locks"])}.`;
}

describe("claim attribution after commit", () => {
  it("reports a committed claim and start with a warning when session attribution fails", async () => {
    await withTempPmPath(async (context) => {
      const explicit = createTestItemId(context, { title: "Explicit attribution", priority: "1" });
      expect(await runClaim(explicit, false, { path: context.pmPath })).toMatchObject({
        item: { id: explicit, assignee: "test-author" },
        warnings: [CLAIM_ATTRIBUTION_UNRECORDED_WARNING],
        // A plain error names no refusal code, and its message (which may carry a host path) is withheld.
        suggestions: [
          `The claim of ${explicit} is saved, but the session attribution that names this agent's active work was not updated (unexpected_error); nothing needs a retry. ${attributionHint(context.pmPath)}`,
        ],
      });
      const ranked = createTestItemId(context, { title: "Ranked attribution", priority: "0" });
      expect(await runClaimNext(false, { path: context.pmPath }, { start: true })).toMatchObject({
        item: { id: ranked, status: "in_progress" },
        start: { to_status: "in_progress" },
        warnings: [CLAIM_ATTRIBUTION_UNRECORDED_WARNING],
      });
    });
  });

  it("keeps a committed release successful and names the refusal code when its attribution fails (GH-1706)", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "Release attribution" });
      releaseAttribution.next = new PmCliError("Item session-state is locked", EXIT_CODE.CONFLICT, { code: "lock_conflict" });
      await runClaim(id, false, { path: context.pmPath });
      const released = await runRelease(id, false, { path: context.pmPath });
      expect(released).toMatchObject({
        changed_fields: ["assignee", "claim_principal"],
        warnings: [RELEASE_ATTRIBUTION_UNRECORDED_WARNING],
        suggestions: [
          `The release of ${id} is saved, but the session attribution that names this agent's active work was not updated (lock_conflict); nothing needs a retry. ${attributionHint(context.pmPath)}`,
        ],
      });
      expect(released.item.assignee).toBeUndefined();

      // Both suggestions follow the in-progress handoff hint when the item stays started.
      await runClaim(id, false, { path: context.pmPath }, { start: true });
      const startedRelease = await runRelease(id, false, { path: context.pmPath });
      expect(startedRelease.warnings).toEqual(["released_unclaimed_in_progress", RELEASE_ATTRIBUTION_UNRECORDED_WARNING]);
      expect(startedRelease.suggestions).toHaveLength(2);
      expect(startedRelease.suggestions?.[0]).toContain("--pause");
    });
  });

  it("reads a refusal code only from a well-formed context, so foreign errors never escape (CodeRabbit review)", async () => {
    const contextless = Object.assign(new Error("foreign"), { name: "PmCliError" });
    expect(isAlreadyClaimedError(contextless)).toBe(false);
    expect(isAlreadyClaimedError(Object.assign(new Error("odd"), { name: "PmCliError", context: { code: 7 } }))).toBe(false);
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "Foreign attribution error" });
      for (const failure of [contextless, new PmCliError("no code", EXIT_CODE.CONFLICT)]) {
        releaseAttribution.next = failure;
        await runClaim(id, false, { path: context.pmPath });
        const released = await runRelease(id, false, { path: context.pmPath });
        expect(released.warnings).toEqual([RELEASE_ATTRIBUTION_UNRECORDED_WARNING]);
        expect(released.suggestions?.[0]).toContain("(unexpected_error)");
      }
    });
  });
});
