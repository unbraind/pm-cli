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
    // Work whose time no record keeps (a legacy baseline, a salvaged tail): reported idle, never stale.
    for (const reason of ["legacy_compaction_baseline", "discarded_history_tail"] as const) {
      expect(
        evaluateClaimActivity(null, undefined, {
          updated_at: "2026-07-01T00:00:00.000Z",
          threshold_hours: 72,
          now: NOW,
          unproven_activity: reason,
        }),
      ).toMatchObject({ unproven_activity: reason, idle_hours: 564, stale_policy: { stale: false, eligible_at: null } });
    }
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
      for (const [index, line] of [
        "null",
        '"text"',
        '{"patch":[]}',
        '{"ts":"2026-07-02T00:00:00.000Z"}',
        '{"ts":"2026-07-24T11:00:00.000Z","patch":[]}',
        '{"ts":"2026-07-24T11:00:00.000Z","op":"update","patch":[null]}',
        '{"ts":"2026-07-24T11:00:00.000Z","op":"update","patch":[{"op":"replace"}]}',
        // Well-formed but unparseable: skipping it could hide the recent work, so the stream is unreadable.
        '{"ts":"not-a-date","op":"restore","patch":[]}',
        // A compaction receipt whose recorded activity cannot be read is no evidence either.
        '{"ts":"2026-07-24T11:00:00.000Z","op":"history_compact_baseline","patch":[],"context":{"history_compaction":{"last_activity_at":"invalid"}}}',
        '{"ts":"2026-07-24T11:00:00.000Z","op":"history_compact_baseline","patch":[],"context":{"history_compaction":null}}',
        '{"ts":"2026-07-24T11:00:00.000Z","op":"history_compact_baseline","patch":[],"context":null}',
        '{"ts":"2026-07-24T11:00:00.000Z","op":"history_compact_baseline","patch":[],"context":[]}',
        '{"ts":"2026-07-24T11:00:00.000Z","op":"history_compact_baseline","patch":[],"context":{"history_compaction":[]}}',
        // An unknown unproven-activity reason is a damaged receipt, not a judgeable one.
        '{"ts":"2026-07-24T11:00:00.000Z","op":"history_compact_baseline","patch":[],"context":{"history_compaction":{"last_activity_at":null,"unproven_activity":"other"}}}',
      ].entries()) {
        const id = `pm-malformed-${index}`;
        await writeFile(path.join(pmRoot, "history", `${id}.jsonl`), `${entries[0]}\n${line}\n`);
        await expect(
          resolveItemOwnershipActivity(pmRoot, id, "agent-a", { updated_at: "2026-07-01T00:00:00.000Z", threshold_hours: 72, now: NOW }),
        ).resolves.toMatchObject({ source: "unknown", activity: { history_unreadable: true, stale_policy: { stale: false } } });
      }
      // A legacy baseline (no recorded field) is readable, so the holder evidence survives, but its own
      // time does not bound the pruned work: the claim is never judged stale. The July 5 example: a pruned
      // restore at July 4 23:00 hides behind a baseline whose last pruned entry is a July 1 maintenance record.
      const july5 = new Date("2026-07-05T00:00:00.000Z");
      const baseline = (receipt: Record<string, unknown>) =>
        JSON.stringify({ ts: "2026-07-01T00:00:00.000Z", author: "m", op: "history_compact_baseline", patch: [{ op: "add", path: "/metadata/assignee", value: "agent-a" }], context: { history_compaction: { contract_version: 1, ...receipt } }, before_hash: "x", after_hash: "y" });
      const judge = async (id: string, receipt: Record<string, unknown>) => {
        await writeFile(path.join(pmRoot, "history", `${id}.jsonl`), `${baseline(receipt)}\n`);
        return resolveItemOwnershipActivity(pmRoot, id, "agent-a", { updated_at: "2026-07-01T00:00:00.000Z", threshold_hours: 72, now: july5 });
      };
      const legacy = await judge("pm-legacy", {});
      expect(legacy).toMatchObject({ source: "assignment", since: "2026-07-01T00:00:00.000Z" });
      expect(legacy.activity).toEqual({
        last_activity_at: "2026-07-01T00:00:00.000Z",
        unproven_activity: "legacy_compaction_baseline",
        claim_age_hours: 96,
        idle_hours: 96,
        stale_policy: { setting: "mutation_guard.stale_in_progress_hours", threshold_hours: 72, stale: false, eligible_at: null },
      });
      expect(legacy.activity).not.toHaveProperty("history_unreadable");
      // The same stream with the pruned restore recorded: one idle hour, not stale.
      expect((await judge("pm-recorded-recent", { last_activity_at: "2026-07-04T23:00:00.000Z" })).activity).toMatchObject({
        last_activity_at: "2026-07-04T23:00:00.000Z",
        idle_hours: 1,
        stale_policy: { stale: false, eligible_at: "2026-07-07T23:00:00.000Z" },
      });
      // A valid older recorded time, and a recorded null (no pruned work), leave metadata as the newest activity.
      for (const [id, receipt] of [
        ["pm-recorded-old", { last_activity_at: "2026-06-30T00:00:00.000Z" }],
        ["pm-recorded-null", { last_activity_at: null }],
      ] as const) {
        const judged = (await judge(id, receipt)).activity;
        expect(judged).toMatchObject({ last_activity_at: "2026-07-01T00:00:00.000Z", idle_hours: 96, stale_policy: { stale: true } });
        expect(judged).not.toHaveProperty("unproven_activity");
      }
      // A receipt that carries the pruned prefix's unproven reason forward stays unproven despite its recorded time.
      expect(
        (await judge("pm-recorded-unproven", { last_activity_at: "2026-06-30T00:00:00.000Z", unproven_activity: "discarded_history_tail" })).activity,
      ).toMatchObject({ unproven_activity: "discarded_history_tail", stale_policy: { stale: false, eligible_at: null } });
      // A salvage record means a discarded tail of unknown time: the stream is readable but proves nothing.
      const salvage = JSON.stringify({ ts: "2026-07-01T00:00:00.000Z", author: "m", op: "history_salvage", patch: [], context: { history_salvage: { discarded_bytes: 40 } }, before_hash: "x", after_hash: "x" });
      await writeFile(path.join(pmRoot, "history", "pm-salvaged.jsonl"), `${baseline({ last_activity_at: null })}\n${salvage}\n`);
      const salvaged = await resolveItemOwnershipActivity(pmRoot, "pm-salvaged", "agent-a", { updated_at: "2026-07-01T00:00:00.000Z", threshold_hours: 72, now: july5 });
      expect(salvaged.activity).toMatchObject({ unproven_activity: "discarded_history_tail", idle_hours: 96, stale_policy: { stale: false } });
      // A missing stream is empty, not unreadable.
      expect(
        (await resolveItemOwnershipActivity(pmRoot, "pm-missing", "agent-z", { updated_at: "2026-07-01T00:00:00.000Z", threshold_hours: 72, now: NOW })).activity,
      ).not.toHaveProperty("history_unreadable");
    } finally {
      await rm(pmRoot, { recursive: true, force: true });
    }
  });
});
