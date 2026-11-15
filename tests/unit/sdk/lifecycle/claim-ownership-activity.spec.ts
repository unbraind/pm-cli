import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  describeItemOwnershipConflict,
  evaluateClaimActivity,
  resolveItemOwnershipActivity,
  resolveItemOwnershipConflict,
} from "../../../../src/sdk/index.js";

const NOW = new Date("2026-07-24T12:00:00.000Z");

describe("claim activity evidence (GH-1336)", () => {
  it("judges idleness from the newer of metadata and history, and fails closed without provable evidence", () => {
    // A newer history entry (for example a restore) keeps the claim active.
    expect(
      evaluateClaimActivity("2026-07-20T12:00:00.000Z", "2026-07-23T12:00:00.000Z", {
        updated_at: "2026-07-21T12:00:00.000Z",
        threshold_hours: 72,
        now: NOW,
      }),
    ).toMatchObject({ last_activity_at: "2026-07-23T12:00:00.000Z", idle_hours: 24, stale_policy: { stale: false } });
    expect(
      evaluateClaimActivity("2026-07-20T12:00:00.000Z", "2026-07-20T12:00:00.000Z", {
        updated_at: "2026-07-21T12:00:00.000Z",
        threshold_hours: 72,
        now: NOW,
      }),
    ).toEqual({
      last_activity_at: "2026-07-21T12:00:00.000Z",
      claim_age_hours: 96,
      idle_hours: 72,
      stale_policy: {
        setting: "mutation_guard.stale_in_progress_hours",
        threshold_hours: 72,
        stale: true,
        eligible_at: "2026-07-24T12:00:00.000Z",
      },
    });
    // An unreadable stream may hide recent work: never stale, no eligibility, and the reason is explicit.
    expect(
      evaluateClaimActivity(null, undefined, {
        updated_at: "2026-07-01T00:00:00.000Z",
        threshold_hours: 72,
        now: NOW,
        history_unreadable: true,
      }),
    ).toMatchObject({ history_unreadable: true, idle_hours: 564, stale_policy: { stale: false, eligible_at: null } });
    expect(
      evaluateClaimActivity(null, undefined, { updated_at: "2026-07-01T00:00:00.000Z", threshold_hours: 3_000_000_000, now: NOW }),
    ).toMatchObject({ idle_hours: 564, stale_policy: { stale: false, eligible_at: null } });
    expect(
      evaluateClaimActivity("not-a-date", undefined, { updated_at: "invalid", threshold_hours: 0.5, now: NOW }),
    ).toEqual({
      last_activity_at: null,
      claim_age_hours: null,
      idle_hours: null,
      stale_policy: {
        setting: "mutation_guard.stale_in_progress_hours",
        threshold_hours: 1,
        stale: false,
        eligible_at: null,
      },
    });
    expect(
      evaluateClaimActivity(null, undefined, { updated_at: "2026-07-24T11:00:00.000Z", threshold_hours: 72, now: NOW }),
    ).toMatchObject({ claim_age_hours: null, idle_hours: 1, stale_policy: { stale: false } });
  });

  it("derives the holder and its activity from one stream read", async () => {
    const pmRoot = await mkdtemp(path.join(os.tmpdir(), "pm-ownership-activity-"));
    try {
      await mkdir(path.join(pmRoot, "history"));
      const entries = [
        { ts: "2026-07-01T00:00:00.000Z", author: "agent-a", op: "claim", patch: [{ op: "add", path: "/metadata/assignee", value: "agent-a" }] },
        { ts: "2026-07-02T00:00:00.000Z", author: "agent-a", op: "comment_add", patch: [] },
      ].map((entry) => JSON.stringify({ ...entry, before_hash: "x", after_hash: "y" }));
      await writeFile(path.join(pmRoot, "history", "pm-held.jsonl"), `${entries.join("\n")}\n`);
      await expect(resolveItemOwnershipConflict(pmRoot, "pm-held", "agent-a")).resolves.toEqual({
        phrase: "claimed by agent-a",
        holder: "agent-a",
        source: "claim",
        since: "2026-07-01T00:00:00.000Z",
      });
      await expect(describeItemOwnershipConflict(pmRoot, "pm-held", "agent-a")).resolves.toBe("claimed by agent-a");
      await expect(
        resolveItemOwnershipActivity(pmRoot, "pm-held", "agent-a", {
          updated_at: "2026-07-01T00:00:00.000Z",
          threshold_hours: 72,
          now: NOW,
        }),
      ).resolves.toMatchObject({
        holder: "agent-a",
        since: "2026-07-01T00:00:00.000Z",
        activity: {
          last_activity_at: "2026-07-02T00:00:00.000Z",
          claim_age_hours: 564,
          idle_hours: 540,
          stale_policy: { stale: true },
        },
      });
      await writeFile(path.join(pmRoot, "history", "pm-corrupt.jsonl"), `${entries[0]}\nnot-json\n`);
      const corrupt = await resolveItemOwnershipActivity(pmRoot, "pm-corrupt", "agent-a", {
        updated_at: "2026-07-01T00:00:00.000Z",
        threshold_hours: 72,
        now: NOW,
      });
      expect(corrupt).toMatchObject({ source: "unknown", activity: { history_unreadable: true, stale_policy: { stale: false } } });
      await expect(
        resolveItemOwnershipActivity(pmRoot, "pm-missing", "agent-z", {
          updated_at: "2026-07-24T11:00:00.000Z",
          threshold_hours: 72,
          now: NOW,
        }),
      ).resolves.toMatchObject({
        phrase: "assigned to agent-z",
        source: "unknown",
        since: null,
        activity: { last_activity_at: "2026-07-24T11:00:00.000Z", idle_hours: 1, stale_policy: { stale: false } },
      });
      // A trailing maintenance entry (history-compact) is not work: idle time is unchanged.
      const compactEntry = JSON.stringify({ ts: "2026-07-24T11:00:00.000Z", author: "maintainer", op: "history_compact", patch: [], before_hash: "x", after_hash: "y" });
      await writeFile(path.join(pmRoot, "history", "pm-compacted.jsonl"), `${entries.join("\n")}\n${compactEntry}\n`);
      await expect(
        resolveItemOwnershipActivity(pmRoot, "pm-compacted", "agent-a", { updated_at: "2026-07-01T00:00:00.000Z", threshold_hours: 72, now: NOW }),
      ).resolves.toMatchObject({ activity: { last_activity_at: "2026-07-02T00:00:00.000Z", stale_policy: { stale: true } } });
      // Lines that decode but are no history record make the stream unreadable, so the claim is never judged stale.
      for (const [index, line] of ["null", '"text"', '{"patch":[]}', '{"ts":"2026-07-02T00:00:00.000Z"}'].entries()) {
        const id = `pm-malformed-${index}`;
        await writeFile(path.join(pmRoot, "history", `${id}.jsonl`), `${entries[0]}\n${line}\n`);
        await expect(
          resolveItemOwnershipActivity(pmRoot, id, "agent-a", { updated_at: "2026-07-01T00:00:00.000Z", threshold_hours: 72, now: NOW }),
        ).resolves.toMatchObject({ source: "unknown", activity: { history_unreadable: true, stale_policy: { stale: false } } });
      }
      // A missing stream is empty, not unreadable.
      expect(
        (await resolveItemOwnershipActivity(pmRoot, "pm-missing", "agent-z", { updated_at: "2026-07-01T00:00:00.000Z", threshold_hours: 72, now: NOW })).activity,
      ).not.toHaveProperty("history_unreadable");
    } finally {
      await rm(pmRoot, { recursive: true, force: true });
    }
  });
});
