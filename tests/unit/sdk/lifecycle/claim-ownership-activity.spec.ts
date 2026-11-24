import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  callerClaimEndedByClose,
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
      state: "stale",
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
    ).toMatchObject({ history_unreadable: true, state: "unknown", idle_hours: 564, stale_policy: { stale: false, eligible_at: null } });
    // Activity the holder's records cannot prove (see unprovenClaimActivity): reported idle, never stale.
    for (const reason of ["claim_record_unavailable", "discarded_history_tail", "rewritten_history", "workspace_restored"] as const) {
      expect(
        evaluateClaimActivity(null, undefined, {
          updated_at: "2026-07-01T00:00:00.000Z",
          threshold_hours: 72,
          now: NOW,
          unproven_activity: reason,
        }),
      ).toMatchObject({ unproven_activity: reason, state: "unknown", idle_hours: 564, stale_policy: { stale: false, eligible_at: null } });
    }
    expect(
      evaluateClaimActivity(null, undefined, { updated_at: "2026-07-01T00:00:00.000Z", threshold_hours: 3_000_000_000, now: NOW }),
    ).toMatchObject({ idle_hours: 564, stale_policy: { stale: false, eligible_at: null } });
    expect(
      evaluateClaimActivity("not-a-date", undefined, { updated_at: "invalid", threshold_hours: 0.5, now: NOW }),
    ).toEqual({
      last_activity_at: null,
      state: "unknown",
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
    ).toMatchObject({ state: "active", claim_age_hours: null, idle_hours: 1, stale_policy: { stale: false } });
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
      ].entries()) {
        const id = `pm-malformed-${index}`;
        await writeFile(path.join(pmRoot, "history", `${id}.jsonl`), `${entries[0]}\n${line}\n`);
        await expect(
          resolveItemOwnershipActivity(pmRoot, id, "agent-a", { updated_at: "2026-07-01T00:00:00.000Z", threshold_hours: 72, now: NOW }),
        ).resolves.toMatchObject({ source: "unknown", activity: { history_unreadable: true, stale_policy: { stale: false } } });
      }
      // A takeover anchors on the holder's own claim record. The July 5 example: a legacy baseline whose own
      // time (July 1) hides a pruned July 4 23:00 restore. When the baseline folded the claim, nothing proves
      // the holder's activity, so the claim is never stale; the holder evidence survives (the stream is readable).
      const july5 = new Date("2026-07-05T00:00:00.000Z");
      const judge = (id: string) =>
        resolveItemOwnershipActivity(pmRoot, id, "agent-a", { updated_at: "2026-07-01T00:00:00.000Z", threshold_hours: 72, now: july5 });
      const write = async (id: string, records: Array<Record<string, unknown>>) =>
        writeFile(path.join(pmRoot, "history", `${id}.jsonl`), `${records.map((record) => JSON.stringify({ author: "m", before_hash: "x", after_hash: "y", ...record })).join("\n")}\n`);
      const claimRecord = { ts: "2026-07-01T00:00:00.000Z", op: "claim", patch: [{ op: "add", path: "/metadata/assignee", value: "agent-a" }] };
      const legacyBaseline = (patch: unknown[]) => ({ ts: "2026-07-01T00:00:00.000Z", op: "history_compact_baseline", patch, context: { history_compaction: { contract_version: 1 } } });
      await write("pm-legacy", [legacyBaseline(claimRecord.patch)]);
      const legacy = await judge("pm-legacy");
      expect(legacy).toMatchObject({ source: "assignment", since: "2026-07-01T00:00:00.000Z" });
      expect(legacy.activity).toEqual({
        last_activity_at: "2026-07-01T00:00:00.000Z",
        unproven_activity: "claim_record_unavailable",
        state: "unknown",
        claim_age_hours: 96,
        idle_hours: 96,
        stale_policy: { setting: "mutation_guard.stale_in_progress_hours", threshold_hours: 72, stale: false, eligible_at: null },
      });
      expect(legacy.activity).not.toHaveProperty("history_unreadable");
      // A claim recorded after any prefix is provable: whatever the baseline hides predates the holder's claim.
      await write("pm-claimed-after-compaction", [legacyBaseline([]), claimRecord]);
      const anchored = (await judge("pm-claimed-after-compaction")).activity;
      expect(anchored).toMatchObject({ idle_hours: 96, stale_policy: { stale: true } });
      expect(anchored).not.toHaveProperty("unproven_activity");
      // Discards and rewrites after the claim leave its activity unproven; the same records before it do not.
      for (const [op, reason] of [
        ["history_salvage", "discarded_history_tail"],
        ["history_repair", "rewritten_history"],
        ["history_redact", "rewritten_history"],
        ["merge_reconcile", "rewritten_history"],
      ] as const) {
        const maintenance = { ts: "2026-07-01T00:00:00.000Z", op, patch: [] };
        await write(`pm-after-${op}`, [claimRecord, maintenance]);
        expect((await judge(`pm-after-${op}`)).activity).toMatchObject({ unproven_activity: reason, stale_policy: { stale: false, eligible_at: null } });
        await write(`pm-before-${op}`, [maintenance, claimRecord]);
        expect((await judge(`pm-before-${op}`)).activity).toMatchObject({ stale_policy: { stale: true } });
      }
      // Another session of the same principal took the item: its claim moved only claim_principal, and anchors the judgement
      // even after compaction folded the first session's claim. A principal change outside a claim is no anchor.
      const principalClaim = { ts: "2026-07-01T00:00:00.000Z", op: "claim", patch: [{ op: "replace", path: "/metadata/claim_principal", value: "session-b" }] };
      await write("pm-same-principal", [legacyBaseline(claimRecord.patch), principalClaim, { ts: "2026-07-01T00:00:00.000Z", op: "comment_add", patch: [] }]);
      expect(await judge("pm-same-principal")).toMatchObject({ source: "claim", since: "2026-07-01T00:00:00.000Z", activity: { idle_hours: 96, stale_policy: { stale: true } } });
      await write("pm-principal-normalized", [legacyBaseline(claimRecord.patch), { ...principalClaim, op: "normalize" }]);
      expect((await judge("pm-principal-normalized")).activity).toMatchObject({ unproven_activity: "claim_record_unavailable" });
      // A principal-only claim is evidence only when the holder name it kept is the current holder.
      await write("pm-principal-diverged", [{ ...claimRecord, patch: [{ op: "add", path: "/metadata/assignee", value: "agent-z" }] }, principalClaim]);
      expect(await judge("pm-principal-diverged")).toMatchObject({ source: "unknown", since: null, activity: { unproven_activity: "claim_record_unavailable" } });
      // A newest assignee change that removed the holder (a release) proves no current claim.
      await write("pm-released", [claimRecord, { ts: "2026-07-02T00:00:00.000Z", op: "release", patch: [{ op: "remove", path: "/metadata/assignee" }] }]);
      expect(await judge("pm-released")).toMatchObject({ source: "unknown", since: null, activity: { unproven_activity: "claim_record_unavailable" } });
      // A holder no record sets (silent history) is unproven too.
      await write("pm-silent", [{ ts: "2026-07-01T00:00:00.000Z", op: "comment_add", patch: [] }]);
      expect((await judge("pm-silent")).activity).toMatchObject({ unproven_activity: "claim_record_unavailable", stale_policy: { stale: false } });
      // A missing stream is empty, not unreadable, and proves no claim record.
      const missing = (await resolveItemOwnershipActivity(pmRoot, "pm-missing", "agent-z", { updated_at: "2026-07-01T00:00:00.000Z", threshold_hours: 72, now: NOW })).activity;
      expect(missing).not.toHaveProperty("history_unreadable");
      expect(missing).toMatchObject({ unproven_activity: "claim_record_unavailable" });
      // A workspace snapshot restore at or after the claim may have replaced the holder's later work; one before it did not.
      const workspacePath = path.join(pmRoot, "history", "_workspace.jsonl");
      const restoreAt = async (lines: string[]) => {
        await writeFile(workspacePath, `${lines.join("\n")}\n`);
        return (await judge("pm-claimed-after-compaction")).activity;
      };
      const restore = (ts: unknown) => JSON.stringify({ ts, author: "m", op: "workspace_snapshot_restore", patch: [], before_hash: "x", after_hash: "y" });
      const other = JSON.stringify({ ts: "2026-07-03T00:00:00.000Z", author: "m", op: "workspace_settings_update", patch: [], before_hash: "x", after_hash: "y" });
      expect(await restoreAt([restore("2026-06-30T00:00:00.000Z"), other])).toMatchObject({ stale_policy: { stale: true } });
      // A compacted workspace stream bounds any pruned restore by its recorded last_activity_at.
      const workspaceBaseline = (receipt: Record<string, unknown> | undefined) =>
        JSON.stringify({ ts: "2026-06-29T00:00:00.000Z", author: "m", op: "history_compact_baseline", patch: [], ...(receipt === undefined ? {} : { context: { history_compaction: receipt } }), before_hash: "x", after_hash: "y" });
      // Discards and rewrites of the workspace stream may have removed a restore; dated before the claim, they predate it.
      const workspaceRewrite = (op: string, ts: string) => JSON.stringify({ ts, author: "m", op, patch: [], before_hash: "x", after_hash: "y" });
      for (const lines of [
        [workspaceBaseline({ last_activity_at: "2026-06-30T00:00:00.000Z" }), other],
        [workspaceBaseline({ last_activity_at: null })],
        [workspaceRewrite("history_salvage", "2026-06-30T00:00:00.000Z"), workspaceRewrite("history_repair", "2026-06-30T00:00:00.000Z")],
      ]) {
        expect(await restoreAt(lines)).toMatchObject({ stale_policy: { stale: true } });
      }
      for (const op of ["history_salvage", "history_repair", "history_redact", "merge_reconcile"]) {
        expect(await restoreAt([workspaceRewrite(op, "2026-07-04T23:00:00.000Z")])).toMatchObject({ unproven_activity: "workspace_restored" });
      }
      // A baseline whose last pruned record is at or after the claim may have folded such a record, even with no recorded work.
      expect(
        await restoreAt([JSON.stringify({ ...JSON.parse(workspaceBaseline({ last_activity_at: null })), ts: "2026-07-02T00:00:00.000Z" })]),
      ).toMatchObject({ unproven_activity: "workspace_restored" });
      for (const lines of [
        [restore("2026-07-01T00:00:00.000Z")],
        [restore("2026-07-03T00:00:00.000Z")],
        [restore("not-a-date")],
        [restore(5)],
        ["null"],
        ['{"ts":"2026-06-01T00:00:00.000Z"}'],
        ["not-json"],
        [workspaceBaseline({ last_activity_at: "2026-07-02T00:00:00.000Z" })],
        [workspaceBaseline(undefined)],
        [workspaceBaseline({ last_activity_at: "invalid" })],
      ]) {
        expect(await restoreAt(lines)).toMatchObject({ unproven_activity: "workspace_restored", stale_policy: { stale: false } });
      }
      // Only an otherwise-stale claim reads the workspace stream: an active claim is judged without it, even when it is unreadable.
      await writeFile(workspacePath, "not-json\n");
      await write("pm-active", [{ ...claimRecord, ts: "2026-07-04T23:00:00.000Z" }]);
      const active = (await judge("pm-active")).activity;
      expect(active).toMatchObject({ idle_hours: 1, stale_policy: { stale: false, eligible_at: "2026-07-07T23:00:00.000Z" } });
      expect(active).not.toHaveProperty("unproven_activity");
    } finally {
      await rm(pmRoot, { recursive: true, force: true });
    }
  });

  it("reports whether a caller's most recent claim was ended by a close (GH-1774)", async () => {
    const pmRoot = await mkdtemp(path.join(os.tmpdir(), "pm-close-ended-claim-"));
    try {
      await mkdir(path.join(pmRoot, "history"));
      const write = async (id: string, records: unknown[]) =>
        writeFile(path.join(pmRoot, "history", `${id}.jsonl`), `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
      const record = (op: string, patch: unknown[]) => ({ ts: "2026-07-01T00:00:00.000Z", op, author: "m", patch });
      const set = (path: string, value: unknown) => ({ op: "add", path, value });
      const remove = (path: string) => ({ op: "remove", path });
      const claimA = record("claim", [set("/metadata/assignee", "agent-a"), set("/metadata/claim_principal", "agent-a#1")]);
      const closeAll = record("close", [remove("/metadata/claim_principal"), remove("/metadata/assignee")]);
      const claimB = record("claim", [set("/metadata/assignee", "agent-b")]);

      await write("pm-closed", [claimA, closeAll, claimB]);
      expect(await callerClaimEndedByClose(pmRoot, "pm-closed", "agent-a#1")).toBe(true);
      // The guard's principal is the claim principal: the bare assignee name is a different principal.
      expect(await callerClaimEndedByClose(pmRoot, "pm-closed", "agent-a")).toBe(false);
      expect(await callerClaimEndedByClose(pmRoot, "pm-closed", "agent-b")).toBe(false);

      // A later claim by the caller starts a new claim, which a takeover (not a close) then ends.
      const reclaimA = record("claim", [{ op: "replace", path: "/metadata/assignee", value: "agent-a" }, set("/metadata/claim_principal", "agent-a#1")]);
      const takeoverB = record("claim", [{ op: "replace", path: "/metadata/assignee", value: "agent-b" }, remove("/metadata/claim_principal")]);
      await write("pm-retaken", [claimA, closeAll, reclaimA, takeoverB]);
      expect(await callerClaimEndedByClose(pmRoot, "pm-retaken", "agent-a#1")).toBe(false);

      // Values that are not strings and operations other than add, replace and remove leave the holder unchanged.
      await write("pm-ignored", [
        record("claim", [set("/metadata/assignee", "agent-a")]),
        record("update", [set("/metadata/assignee", 42), { op: "move", path: "/metadata/assignee", from: "/x" }, set("/metadata/title", "t")]),
        closeAll,
      ]);
      expect(await callerClaimEndedByClose(pmRoot, "pm-ignored", "agent-a")).toBe(true);

      // A missing stream, an unparseable one (invalid JSON or a null line) and a decoded value that is not a
      // well-formed record (no patch list) all prove nothing.
      expect(await callerClaimEndedByClose(pmRoot, "pm-missing", "agent-a")).toBe(false);
      await writeFile(path.join(pmRoot, "history", "pm-corrupt.jsonl"), "not-json\n");
      expect(await callerClaimEndedByClose(pmRoot, "pm-corrupt", "agent-a")).toBe(false);
      await write("pm-null", [claimA, closeAll, null]);
      expect(await callerClaimEndedByClose(pmRoot, "pm-null", "agent-a#1")).toBe(false);
      await write("pm-malformed", [claimA, closeAll, { ts: "2026-07-01T00:00:00.000Z", op: "update" }]);
      expect(await callerClaimEndedByClose(pmRoot, "pm-malformed", "agent-a#1")).toBe(false);
    } finally {
      await rm(pmRoot, { recursive: true, force: true });
    }
  });
});
