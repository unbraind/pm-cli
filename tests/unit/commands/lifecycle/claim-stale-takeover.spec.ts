import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  _testOnlyClaimCommand,
  runClaim,
  runClaimNext,
  STALE_CLAIM_TAKEOVER_REFUSED_CODE,
} from "../../../../src/sdk/lifecycle/claim.js";
import { runStartTask } from "../../../../src/sdk/lifecycle/task-composition.js";
import { runUpdate } from "../../../../src/sdk/lifecycle/update.js";
import { runRestore } from "../../../../src/sdk/lifecycle/restore.js";
import { runHistoryRepair } from "../../../../src/sdk/history-repair.js";
import { runHistoryCompact } from "../../../../src/sdk/history-compact.js";
import { runNext } from "../../../../src/sdk/query/next.js";
import { runAction } from "../../../../src/sdk/index.js";
import { EXIT_CODE } from "../../../../src/core/shared/constants.js";
import { PmCliError } from "../../../../src/core/shared/errors.js";
import { getHistoryPath, getItemPath } from "../../../../src/core/store/paths.js";
import { withTempPmPath, type TempPmContext } from "../../../helpers/withTempPmPath.js";

const HOUR = 3_600_000;
// Items are created by a real-time CLI subprocess, so the pinned clock starts after it, on a whole hour.
const T0 = new Date(Math.ceil(Date.now() / HOUR) * HOUR + 24 * HOUR);

function at(hours: number): Date {
  return new Date(T0.getTime() + hours * HOUR);
}

/** Pin the wall clock only; locks and the CLI harness keep real timers. */
function setClock(instant: Date): void {
  vi.useFakeTimers({ toFake: ["Date"], now: instant });
}

function createTask(context: TempPmContext, title: string): string {
  const created = context.runCli(
    ["create", "Task", title, "--json", "--author", "test-author"],
    { expectJson: true },
  );
  expect(created.code).toBe(0);
  return (created.json as { item: { id: string } }).item.id;
}

async function historyLines(context: TempPmContext, id: string): Promise<Array<Record<string, unknown>>> {
  return (await readFile(getHistoryPath(context.pmPath, id), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function refusal(operation: Promise<unknown>): Promise<PmCliError> {
  return operation.then(
    () => {
      throw new Error("expected a refusal");
    },
    (error: unknown) => error as PmCliError,
  );
}

describe("stale-claim takeover (GH-1336)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("refuses an active claim with typed activity evidence and writes nothing", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "Active claim");
      const global = { path: context.pmPath };
      setClock(at(0));
      await runClaim(id, false, global, { author: "agent-a" });
      const before = await historyLines(context, id);

      setClock(at(5));
      const error = await refusal(runClaim(id, false, global, { author: "agent-b", takeoverStale: true }));
      expect(error.exitCode).toBe(EXIT_CODE.CONFLICT);
      expect(error.context).toMatchObject({
        code: STALE_CLAIM_TAKEOVER_REFUSED_CODE,
        item_id: id,
        claimed_by: "agent-a",
        claimed_at: at(0).toISOString(),
        claim_source: "claim",
        claim_activity: {
          last_activity_at: at(0).toISOString(),
          claim_age_hours: 5,
          idle_hours: 5,
          stale_policy: {
            setting: "mutation_guard.stale_in_progress_hours",
            threshold_hours: 72,
            stale: false,
            eligible_at: at(72).toISOString(),
          },
        },
        required: "The claim must be idle for at least 72h (mutation_guard.stale_in_progress_hours) before --takeover-stale may take it.",
      });
      expect(error.message).toContain("(idle 5h of 72h)");
      expect(error.context.nextSteps?.[0]).toBe(
        `Retry with --takeover-stale after ${at(72).toISOString()} if nothing else is recorded on ${id}.`,
      );
      expect(await historyLines(context, id)).toEqual(before);
    });
  });

  it("takes over an idle claim and seals the evidence into the claim history entry", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "Abandoned claim");
      const global = { path: context.pmPath };
      setClock(at(0));
      await runClaim(id, false, global, { author: "agent-a" });

      setClock(at(96));
      const result = await runClaim(id, false, global, {
        author: "agent-b",
        takeoverStale: true,
        message: "Take over abandoned work",
      });
      const receipt = {
        previous_holder: "agent-a",
        new_holder: "agent-b",
        claimed_at: at(0).toISOString(),
        last_activity_at: at(0).toISOString(),
        idle_hours: 96,
        threshold_hours: 72,
        policy: "mutation_guard.stale_in_progress_hours",
      };
      expect(result).toMatchObject({
        claimed_by: "agent-b",
        previous_assignee: "agent-a",
        forced: false,
        takeover: receipt,
      });
      expect(result.warnings).toContain("claim_stale_takeover:agent-a->agent-b:idle_hours=96");
      const latest = (await historyLines(context, id)).at(-1);
      expect(latest).toMatchObject({
        op: "claim",
        author: "agent-b",
        message: "Take over abandoned work",
        context: { stale_claim_takeover: receipt },
      });
    });
  });

  it("refuses again on retry when the holder renewed the claim after a refusal", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "Renewed claim");
      const global = { path: context.pmPath };
      setClock(at(0));
      await runClaim(id, false, global, { author: "agent-a" });

      setClock(at(100));
      // The holder records work: every recorded mutation renews the activity clock.
      await runUpdate(id, { description: "Still working", author: "agent-a" }, global);

      setClock(at(101));
      const error = await refusal(runClaim(id, false, global, { author: "agent-b", takeoverStale: true }));
      expect(error.context).toMatchObject({
        code: STALE_CLAIM_TAKEOVER_REFUSED_CODE,
        claim_activity: { idle_hours: 1, claim_age_hours: 101, stale_policy: { stale: false } },
      });
    });
  });

  it("counts a holder's restore as activity even though it writes an older updated_at", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "Restored claim");
      const global = { path: context.pmPath };
      setClock(at(0));
      await runClaim(id, false, global, { author: "agent-a" });
      await runUpdate(id, { description: "Second version", author: "agent-a" }, global);

      setClock(at(100));
      // The holder restores version 2: the document keeps its T0 updated_at, the new entry is T+100h.
      await runRestore(id, "2", { author: "agent-a" }, global);
      setClock(at(101));
      const error = await refusal(runClaim(id, false, global, { author: "agent-b", takeoverStale: true }));
      expect(error.context).toMatchObject({
        code: STALE_CLAIM_TAKEOVER_REFUSED_CODE,
        claim_activity: { last_activity_at: at(100).toISOString(), idle_hours: 1, stale_policy: { stale: false } },
      });
    });
  });

  it("refuses a takeover whose history stream cannot be read, because recent work may hide behind it", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "Corrupt stream");
      const global = { path: context.pmPath };
      setClock(at(0));
      await runClaim(id, false, global, { author: "agent-a" });
      const historyPath = getHistoryPath(context.pmPath, id);
      await writeFile(historyPath, `${await readFile(historyPath, "utf8")}not-json\n`);

      setClock(at(200));
      const error = await refusal(runClaim(id, false, global, { author: "agent-b", takeoverStale: true }));
      expect(error.context).toMatchObject({
        code: STALE_CLAIM_TAKEOVER_REFUSED_CODE,
        claim_activity: { history_unreadable: true, stale_policy: { stale: false, eligible_at: null } },
      });
      expect(error.message).toContain("its history stream could not be read");
      expect(error.context.nextSteps?.[0]).toBe(`Repair the history stream of ${id} (pm history ${id} --verify), then retry --takeover-stale.`);
    });
  });

  it("refuses a takeover over a legacy compaction baseline without writing, because its pruned work is unknown", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "Legacy compacted claim");
      const global = { path: context.pmPath };
      setClock(at(0));
      await runClaim(id, false, global, { author: "agent-a" });
      // A baseline an older version wrote: the receipt has no last_activity_at, only the last pruned entry's time.
      const historyPath = getHistoryPath(context.pmPath, id);
      const lines = await historyLines(context, id);
      const legacyBaseline = {
        ...lines.at(-1),
        op: "history_compact_baseline",
        context: { history_compaction: { contract_version: 1, checkpoint_timestamp_semantics: "last_compacted_entry" } },
      };
      await writeFile(historyPath, `${JSON.stringify(legacyBaseline)}\n`);
      const itemPath = getItemPath(context.pmPath, "Task", id);
      const before = { history: await readFile(historyPath, "utf8"), item: await readFile(itemPath, "utf8") };

      setClock(at(200));
      const error = await refusal(runClaim(id, false, global, { author: "agent-b", takeoverStale: true }));
      expect(error.exitCode).toBe(EXIT_CODE.CONFLICT);
      expect(error.context).toMatchObject({
        code: STALE_CLAIM_TAKEOVER_REFUSED_CODE,
        claimed_by: "agent-a",
        claim_activity: { unproven_activity: "legacy_compaction_baseline", idle_hours: 200, stale_policy: { stale: false, eligible_at: null } },
      });
      expect(error.context.claim_activity).not.toHaveProperty("history_unreadable");
      expect(error.message).toContain(
        "(an older pm version compacted its history without recording the newest pruned activity, so idleness cannot be proven)",
      );
      expect(error.context.nextSteps?.[0]).toBe(`Ask the holder to release ${id} (pm release ${id}): no later compaction can prove its idleness.`);
      // A plain claim names no stale takeover either.
      const plain = await refusal(runClaim(id, false, global, { author: "agent-b" }));
      expect(plain.context.nextSteps?.join("\n")).not.toContain("--takeover-stale");
      expect({ history: await readFile(historyPath, "utf8"), item: await readFile(itemPath, "utf8") }).toEqual(before);
    });
  });

  it("refuses a takeover after a tail salvage discarded a record of unknown time, and keeps refusing after compaction", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "Salvaged claim");
      const global = { path: context.pmPath };
      setClock(at(0));
      await runClaim(id, false, global, { author: "agent-a" });
      // A torn append: the holder's recent restore never finished its line, so its time is unreadable.
      const historyPath = getHistoryPath(context.pmPath, id);
      await writeFile(historyPath, `${await readFile(historyPath, "utf8")}{"ts":"${at(199).toISOString()}","op":"rest`);
      await runHistoryRepair(id, { salvageTail: true, author: "maintainer" }, global);
      expect((await historyLines(context, id)).at(-1)).toMatchObject({ op: "history_salvage" });

      setClock(at(200));
      const refused = async () => refusal(runClaim(id, false, global, { author: "agent-b", takeoverStale: true }));
      const salvaged = await refused();
      expect(salvaged.context).toMatchObject({
        code: STALE_CLAIM_TAKEOVER_REFUSED_CODE,
        claim_activity: { unproven_activity: "discarded_history_tail", stale_policy: { stale: false, eligible_at: null } },
      });
      expect(salvaged.message).toContain("(a history salvage discarded an unreadable record whose time is unknown, so idleness cannot be proven)");
      // Compaction prunes the salvage record but records its reason, so the unknown work never becomes proven idleness.
      await runHistoryCompact(id, { author: "maintainer" }, global);
      expect((await historyLines(context, id))[0]).toMatchObject({
        op: "history_compact_baseline",
        context: { history_compaction: { unproven_activity: "discarded_history_tail" } },
      });
      expect((await refused()).context).toMatchObject({ claim_activity: { unproven_activity: "discarded_history_tail", stale_policy: { stale: false } } });
    });
  });

  it("skips an active claim and takes a stale one when combined with --if-available", async () => {
    await withTempPmPath(async (context) => {
      const active = createTask(context, "Active");
      const stale = createTask(context, "Stale");
      const global = { path: context.pmPath };
      setClock(at(0));
      await runClaim(stale, false, global, { author: "agent-a" });
      setClock(at(90));
      await runClaim(active, false, global, { author: "agent-a" });

      setClock(at(91));
      const skipped = await runClaim(active, false, global, { author: "agent-b", takeoverStale: true, ifAvailable: true });
      expect(skipped).toMatchObject({ skipped: true, claimed_by: "agent-a", warnings: ["claim_skipped_held_by:agent-a"] });
      expect(skipped).not.toHaveProperty("takeover");
      const taken = await runClaim(stale, false, global, { author: "agent-b", takeoverStale: true, ifAvailable: true });
      expect(taken).toMatchObject({ claimed_by: "agent-b", takeover: { previous_holder: "agent-a", idle_hours: 91 } });
      expect(taken).not.toHaveProperty("skipped");
    });
  });

  it("behaves as a plain claim for unclaimed and self-held items", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "Unclaimed");
      const global = { path: context.pmPath };
      const first = await runClaim(id, false, global, { author: "agent-a", takeoverStale: true });
      expect(first).toMatchObject({ claimed_by: "agent-a", previous_assignee: null });
      expect(first).not.toHaveProperty("takeover");
      const again = await runClaim(id, false, global, { author: "agent-a", takeoverStale: true });
      expect(again).toMatchObject({ claimed_by: "agent-a", changed_fields: [] });
      expect(again).not.toHaveProperty("takeover");
    });
  });

  it("names the stale takeover in a plain already_claimed_by refusal only once the claim is stale", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "Held");
      const global = { path: context.pmPath };
      setClock(at(0));
      await runClaim(id, false, global, { author: "agent-a" });

      setClock(at(10));
      const active = await refusal(runClaim(id, false, global, { author: "agent-b" }));
      expect(active.context).toMatchObject({
        code: "already_claimed_by",
        claim_activity: { idle_hours: 10, stale_policy: { stale: false } },
      });
      expect(active.context.nextSteps?.join("\n")).not.toContain("--takeover-stale");

      setClock(at(80));
      const stale = await refusal(runClaim(id, false, global, { author: "agent-b" }));
      expect(stale.context.nextSteps).toContain(
        "Re-run with --takeover-stale: the claim has been idle 80h, past mutation_guard.stale_in_progress_hours=72.",
      );
    });
  });

  it("refuses --takeover-stale with --force or --next before touching the tracker", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "Combination");
      const global = { path: context.pmPath };
      const forced = await refusal(runClaim(id, true, global, { takeoverStale: true }));
      expect(forced).toMatchObject({
        message: "--takeover-stale cannot be combined with --force",
        exitCode: EXIT_CODE.USAGE,
        context: { code: "ambiguous_option_combination" },
      });
      const next = await refusal(runClaimNext(false, global, { takeoverStale: true }));
      expect(next).toMatchObject({
        message: "--takeover-stale cannot be combined with --next",
        exitCode: EXIT_CODE.USAGE,
        context: { code: "ambiguous_option_combination" },
      });
      expect(await historyLines(context, id)).toHaveLength(1);
    });
  });

  it("starts a stale item through the explicit start composition", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "Start stale");
      const global = { path: context.pmPath };
      setClock(at(0));
      await runClaim(id, false, global, { author: "agent-a" });

      setClock(at(73));
      const started = await runStartTask(id, { author: "agent-b", takeoverStale: true }, global);
      expect(started.claim).toMatchObject({ claimed_by: "agent-b", takeover: { idle_hours: 73 } });
      expect(started.update.item).toMatchObject({ status: "in_progress", assignee: "agent-b" });
    });
  });

  it("forwards a flat takeoverStale through the MCP transport for claim and start-task", async () => {
    await withTempPmPath(async (context) => {
      const claimed = createTask(context, "Transport claim");
      const started = createTask(context, "Transport start");
      const global = { path: context.pmPath };
      setClock(at(0));
      await runClaim(claimed, false, global, { author: "agent-a" });
      await runClaim(started, false, global, { author: "agent-a" });

      setClock(at(80));
      const common = { path: context.pmPath, noExtensions: true, author: "agent-b", takeoverStale: true };
      expect(await runAction({ ...common, action: "claim", id: claimed })).toMatchObject({ takeover: { idle_hours: 80 } });
      expect(await runAction({ ...common, action: "start-task", id: started })).toMatchObject({
        action: "start_task",
        claim: { takeover: { idle_hours: 80 } },
      });
    });
  });

  it("lets a nested snake_case takeover_stale override the flat argument on the MCP transport", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "Nested precedence");
      const global = { path: context.pmPath };
      setClock(at(0));
      await runClaim(id, false, global, { author: "agent-a" });
      setClock(at(80));
      const common = { path: context.pmPath, noExtensions: true, author: "agent-b", id };
      const error = await refusal(runAction({ ...common, action: "claim", takeoverStale: true, options: { takeover_stale: false } }));
      expect(error.context).toMatchObject({ code: "already_claimed_by", claim_activity: { stale_policy: { stale: true } } });
      expect(await runAction({ ...common, action: "claim", takeoverStale: false, options: { takeover_stale: true } })).toMatchObject({
        takeover: { idle_hours: 80 },
      });
    });
  });

  it("reports held rows in pm next with claim time, idle hours and stale eligibility", async () => {
    await withTempPmPath(async (context) => {
      const recent = createTask(context, "Recent hold");
      const old = createTask(context, "Old hold");
      const global = { path: context.pmPath };
      setClock(at(0));
      await runClaim(old, false, global, { author: "agent-a" });
      setClock(at(70));
      await runClaim(recent, false, global, { author: "agent-a" });

      setClock(at(75));
      const next = await runNext({ callerAuthor: "agent-b" }, global);
      expect(next.held_by_others).toEqual(
        expect.arrayContaining([
          {
            id: old,
            assignee: "agent-a",
            claimed_at: at(0).toISOString(),
            idle_hours: 75,
            stale: true,
          },
          {
            id: recent,
            assignee: "agent-a",
            claimed_at: at(70).toISOString(),
            idle_hours: 5,
            stale: false,
          },
        ]),
      );
    });
  });

  it("redacts URL credentials a legacy holder identity carries in pm next occupancy rows", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "Legacy holder");
      await runClaim(id, false, { path: context.pmPath }, { author: "agent-a" });
      // An older version stored credentialed identities verbatim; this one refuses to write them.
      const itemPath = path.join(context.pmPath, "tasks", `${id}.toon`);
      await writeFile(
        itemPath,
        (await readFile(itemPath, "utf8")).replace(/^assignee: .*$/mu, 'assignee: "https://agent:s3cret@example.test/bot"'),
      );
      const next = await runNext({ callerAuthor: "agent-b" }, { path: context.pmPath });
      expect(next.held_by_others.map((row) => row.id)).toContain(id);
      expect(JSON.stringify(next.held_by_others)).not.toContain("s3cret");
    });
  });

  it("judges a takeover from the history stream the item lock guards, not the embedded id", async () => {
    const pmRoot = await mkdtemp(path.join(os.tmpdir(), "pm-takeover-storage-id-"));
    try {
      await mkdir(path.join(pmRoot, "history"));
      // Stored as PM-STORE with an embedded id pm-store: the lock and the stream use the storage id.
      const recent = { ts: "2026-07-24T11:00:00.000Z", author: "agent-a", op: "restore", patch: [], before_hash: "x", after_hash: "y" };
      await writeFile(path.join(pmRoot, "history", "PM-STORE.jsonl"), `${JSON.stringify(recent)}\n`);
      setClock(new Date("2026-07-24T12:00:00.000Z"));
      const error = await refusal(
        _testOnlyClaimCommand.decideHeldClaim({
          pmRoot,
          storageId: "PM-STORE",
          metadata: { id: "pm-store", updated_at: "2026-07-01T00:00:00.000Z" },
          holder: "agent-a",
          author: "agent-b",
          thresholdHours: 72,
          force: false,
          ifAvailable: false,
          takeoverStale: true,
        }),
      );
      expect(error.context).toMatchObject({
        code: STALE_CLAIM_TAKEOVER_REFUSED_CODE,
        item_id: "pm-store",
        claim_activity: { last_activity_at: "2026-07-24T11:00:00.000Z", idle_hours: 1, stale_policy: { stale: false } },
      });
    } finally {
      await rm(pmRoot, { recursive: true, force: true });
    }
  });

  it("explains a claim whose activity time cannot be judged", () => {
    const ownership = {
      phrase: "claimed by agent-a",
      holder: "agent-a",
      source: "claim" as const,
      since: null,
      activity: {
        last_activity_at: null,
        claim_age_hours: null,
        idle_hours: null,
        stale_policy: {
          setting: "mutation_guard.stale_in_progress_hours" as const,
          threshold_hours: 72,
          stale: false,
          eligible_at: null,
        },
      },
    };
    const takeover = _testOnlyClaimCommand.claimConflictRefusal("pm-x", ownership, true);
    expect(takeover.message).toBe(
      "Item pm-x is claimed by agent-a, and its claim is not stale under mutation_guard.stale_in_progress_hours (no valid activity time is recorded).",
    );
    expect(takeover.context.nextSteps?.[0]).toBe("No eligibility time can be computed for pm-x; inspect pm history pm-x.");
    expect(_testOnlyClaimCommand.staleTakeoverReceipt(ownership, "agent-b")).toBeUndefined();
    // A threshold settings accept but the Date range cannot represent: idle hours known, no eligibility.
    const unbounded = _testOnlyClaimCommand.claimConflictRefusal(
      "pm-x",
      {
        ...ownership,
        activity: {
          ...ownership.activity,
          last_activity_at: "2026-07-01T00:00:00.000Z",
          idle_hours: 564,
          stale_policy: { ...ownership.activity.stale_policy, threshold_hours: 3_000_000_000 },
        },
      },
      true,
    );
    expect(unbounded.message).toContain("(idle 564h of 3000000000h)");
    expect(unbounded.context.nextSteps?.[0]).toBe("No eligibility time can be computed for pm-x; inspect pm history pm-x.");
  });
});
