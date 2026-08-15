/**
 * @module tests/unit/sdk/history-author-acknowledgment-plan
 *
 * Verifies deterministic preview/apply planning for immutable history author
 * acknowledgements without touching the repository tracker.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  EXIT_CODE,
  PmCliError,
  acknowledgeUnknownAuthorHistoryEvents,
  acknowledgeUnknownAuthorHistoryEventsFromTransport,
  planUnknownAuthorHistoryAcknowledgment,
} from "../../../src/sdk/index.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((tempRoot) => rm(tempRoot, { recursive: true, force: true })),
  );
});

async function createTracker(): Promise<string> {
  const pmRoot = await mkdtemp(path.join(os.tmpdir(), "pm-author-plan-"));
  tempRoots.push(pmRoot);
  await mkdir(path.join(pmRoot, "history"));
  await writeFile(
    path.join(pmRoot, "settings.json"),
    JSON.stringify({ locks: { ttl_seconds: 30, wait_ms: 1_000 } }),
  );
  await writeFile(
    path.join(pmRoot, "history", "pm-plan.jsonl"),
    [
      { ts: "2026-07-16T00:00:00.000Z", author: "unknown", op: "update" },
      { ts: "2026-07-16T00:01:00.000Z", author: "unknown", op: "comment" },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n",
  );
  return pmRoot;
}

describe("history author acknowledgement plans", () => {
  it("produces a stable complete-set fingerprint and bounded ordered preview", async () => {
    const pmRoot = await createTracker();
    const plan = await planUnknownAuthorHistoryAcknowledgment(
      pmRoot,
      { all_actionable: true },
      1,
    );
    expect(plan).toMatchObject({
      selection: { kind: "all_actionable" },
      selected_count: 2,
      actionable_count: 2,
      already_acknowledged_count: 0,
      omitted_count: 1,
      coordinates: [
        {
          item_id: "pm-plan",
          line: 1,
          disposition: "actionable",
          source_event_hash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        },
      ],
      plan_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    await expect(
      planUnknownAuthorHistoryAcknowledgment(
        pmRoot,
        { events: [{ item_id: "pm-plan", line: 2 }] },
        10,
      ),
    ).resolves.toMatchObject({
      selection: { kind: "events" },
      selected_count: 1,
      omitted_count: 0,
    });
  });

  it("rejects negative and fractional preview limits", async () => {
    const pmRoot = await createTracker();
    for (const coordinateLimit of [-1, 0.5]) {
      const error = await planUnknownAuthorHistoryAcknowledgment(
        pmRoot,
        { all_actionable: true },
        coordinateLimit,
      ).then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(PmCliError);
      expect((error as PmCliError).code).toBe(
        "history_author_acknowledge_preview_limit_invalid",
      );
    }
  });

  it("normalizes numeric, string, and omitted transport preview limits", async () => {
    const pmRoot = await createTracker();
    const numeric = await acknowledgeUnknownAuthorHistoryEventsFromTransport(
      pmRoot,
      { allActionable: true, dryRun: true, limit: 1 },
    );
    const string = await acknowledgeUnknownAuthorHistoryEventsFromTransport(
      pmRoot,
      { all_actionable: true, dry_run: true, limit: "0" },
    );
    const omitted = await acknowledgeUnknownAuthorHistoryEventsFromTransport(
      pmRoot,
      { allActionable: true, dryRun: true },
    );
    expect(numeric.plan).toMatchObject({
      selected_count: 2,
      omitted_count: 1,
    });
    expect(numeric.plan.coordinates).toHaveLength(1);
    expect(string.plan).toMatchObject({
      selected_count: 2,
      omitted_count: 2,
      coordinates: [],
    });
    expect(omitted.plan).toMatchObject({
      selected_count: 2,
      omitted_count: 0,
    });
  });

  it("previews without identity fields and requires the exact plan to apply", async () => {
    const pmRoot = await createTracker();
    const preview = await acknowledgeUnknownAuthorHistoryEvents(pmRoot, {
      all_actionable: true,
      dry_run: true,
    });
    expect(preview).toMatchObject({
      dry_run: true,
      mutated: false,
      acknowledged: 0,
      outcome: "preview",
      exit_code: 0,
      plan: { selected_count: 2 },
    });
    await expect(
      readFile(path.join(pmRoot, "history", "_workspace.jsonl"), "utf8"),
    ).rejects.toThrow();

    const missingFingerprint = await acknowledgeUnknownAuthorHistoryEvents(
      pmRoot,
      {
        all_actionable: true,
        attributed_author: "original-agent",
        reviewer: "maintainer",
        reason: "Reviewed immutable provenance.",
      },
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(missingFingerprint).toBeInstanceOf(PmCliError);
    expect((missingFingerprint as PmCliError).exitCode).toBe(EXIT_CODE.USAGE);

    const applied = await acknowledgeUnknownAuthorHistoryEvents(pmRoot, {
      all_actionable: true,
      plan_fingerprint: preview.plan.plan_fingerprint,
      attributed_author: "original-agent",
      reviewer: "maintainer",
      reason: "Reviewed immutable provenance.",
    });
    expect(applied).toMatchObject({
      mutated: true,
      acknowledged: 2,
      outcome: "effect",
      exit_code: 0,
    });
  });

  it("reports no effect, partial effect, and selection drift without mutation", async () => {
    const pmRoot = await createTracker();
    const firstPlan = await planUnknownAuthorHistoryAcknowledgment(pmRoot, {
      events: [{ item_id: "pm-plan", line: 1 }],
    });
    await acknowledgeUnknownAuthorHistoryEvents(pmRoot, {
      events: [{ item_id: "pm-plan", line: 1 }],
      plan_fingerprint: firstPlan.plan_fingerprint,
      attributed_author: "original-agent",
      reviewer: "maintainer",
      reason: "Reviewed the first event.",
    });

    const alreadyPlan = await planUnknownAuthorHistoryAcknowledgment(pmRoot, {
      events: [{ item_id: "pm-plan", line: 1 }],
    });
    await expect(
      acknowledgeUnknownAuthorHistoryEvents(pmRoot, {
        events: [{ item_id: "pm-plan", line: 1 }],
        plan_fingerprint: alreadyPlan.plan_fingerprint,
        attributed_author: "original-agent",
        reviewer: "maintainer",
        reason: "No duplicate disposition.",
      }),
    ).resolves.toMatchObject({
      mutated: false,
      acknowledged: 0,
      outcome: "no_effect",
      exit_code: 6,
    });

    const mixedPlan = await planUnknownAuthorHistoryAcknowledgment(pmRoot, {
      events: [
        { item_id: "pm-plan", line: 2 },
        { item_id: "pm-plan", line: 1 },
      ],
    });
    await expect(
      acknowledgeUnknownAuthorHistoryEvents(pmRoot, {
        events: [
          { item_id: "pm-plan", line: 2 },
          { item_id: "pm-plan", line: 1 },
        ],
        plan_fingerprint: mixedPlan.plan_fingerprint,
        attributed_author: "original-agent",
        reviewer: "maintainer",
        reason: "Apply only the actionable subset.",
      }),
    ).resolves.toMatchObject({
      mutated: true,
      acknowledged: 1,
      outcome: "partial_effect",
      exit_code: 7,
    });

    const driftRoot = await createTracker();
    const driftPlan = await planUnknownAuthorHistoryAcknowledgment(driftRoot, {
      all_actionable: true,
    });
    await writeFile(
      path.join(driftRoot, "history", "pm-plan.jsonl"),
      `${JSON.stringify({ ts: "2026-07-16T00:00:00.000Z", author: "agent", op: "update" })}\n`,
    );
    const conflict = await acknowledgeUnknownAuthorHistoryEvents(driftRoot, {
      all_actionable: true,
      plan_fingerprint: driftPlan.plan_fingerprint,
      attributed_author: "original-agent",
      reviewer: "maintainer",
      reason: "Must reject stale plan.",
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(conflict).toBeInstanceOf(PmCliError);
    expect((conflict as PmCliError).exitCode).toBe(EXIT_CODE.CONFLICT);
  });
});
