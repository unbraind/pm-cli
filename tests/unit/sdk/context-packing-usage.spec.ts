import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  packContextCandidates,
  readContextUsageAffinity,
  recordContextUsageServing,
  recordContextUsageTouch,
  recordContextUsageTouches,
} from "../../../src/sdk/index.js";

const roots: string[] = [];

async function tempPmRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "pm-context-usage-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  delete process.env.PM_CONTEXT_USAGE_DISABLED;
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function candidate(
  id: string,
  rank: number,
  score: number,
  extra: Record<string, unknown> = {},
) {
  return {
    id,
    item: { id },
    rank,
    score,
    token_costs: { identity: 10, summary: 20, full: 40 },
    ...extra,
  };
}

describe("context packing", () => {
  it("admits required anchors, avoids redundant clusters, and upgrades projections before omission", () => {
    const report = packContextCandidates(
      [
        candidate("required", 3, 0.2, { required: true }),
        candidate("best", 1, 1, { cluster: "a" }),
        candidate("duplicate", 2, 0.9, {
          cluster: "a",
          token_costs: { identity: 20, summary: 25, full: 40 },
        }),
        candidate("diverse", 4, 0.8, { cluster: "b", uncertainty: 0.5 }),
      ],
      {
        tokenBudget: 40,
        redundancyPenalty: 0.5,
        uncertaintyPenalty: 0.2,
        profile: "context",
      },
    );

    expect(report.included.map((entry) => entry.id)).toEqual([
      "best",
      "required",
      "diverse",
    ]);
    expect(report.included.map((entry) => entry.projection)).toContain(
      "summary",
    );
    expect(report.omitted_ids).toEqual(["duplicate"]);
    expect(report).toMatchObject({
      token_budget: 40,
      used_tokens: 40,
      remaining_tokens: 0,
      complete: false,
      profile: "context",
      selection_complete: true,
      termination_reason: "exhausted",
    });
    expect(report.degradation_ladder).toEqual(["full", "summary", "identity"]);
  });

  it("discloses intent profiles and a deterministic latency completeness certificate", () => {
    let clock = 0;
    const report = packContextCandidates(
      [candidate("required", 1, 1, { required: true }), candidate("later", 2, 1)],
      {
        tokenBudget: 80,
        profile: "next",
        latencyBudgetMs: 1,
        readClock: () => clock++,
      },
    );
    expect(report.included.map((entry) => entry.id)).toEqual(["required"]);
    expect(report).toMatchObject({
      profile: "next",
      selection_complete: false,
      termination_reason: "latency_budget",
      latency_budget_ms: 1,
      evaluated_candidates: 0,
    });
  });

  it("returns a complete full-detail packet when the budget permits it", () => {
    const report = packContextCandidates([candidate("a", 1, 1)], {
      tokenBudget: 50,
    });
    expect(report.included[0]).toMatchObject({
      projection: "full",
      tokens: 40,
    });
    expect(report).toMatchObject({
      complete: true,
      profile: "balanced",
      remaining_tokens: 10,
    });
  });

  it("uses stable id tie-breakers and omits candidates whose identity exceeds the budget", () => {
    const tied = packContextCandidates(
      [candidate("b", 1, 1), candidate("a", 1, 1)],
      { tokenBudget: 80 },
    );
    expect(tied.included.map((entry) => entry.id)).toEqual(["a", "b"]);
    const oneUpgrade = packContextCandidates(
      [candidate("b", 1, 1), candidate("a", 1, 1)],
      { tokenBudget: 30 },
    );
    expect(oneUpgrade.included.map(({ id, projection }) => [id, projection])).toEqual([
      ["a", "summary"],
      ["b", "identity"],
    ]);

    const omitted = packContextCandidates(
      [candidate("required", 1, 1, { required: true })],
      { tokenBudget: 5 },
    );
    expect(omitted).toMatchObject({ included: [], omitted_ids: ["required"] });
  });

  it("validates budgets, penalties, identities, scores, costs, uncertainty, and duplicate ids", () => {
    expect(() => packContextCandidates([], { tokenBudget: 0 })).toThrow(
      "positive integer",
    );
    expect(() =>
      packContextCandidates([], { tokenBudget: 1, redundancyPenalty: 2 }),
    ).toThrow("penalties");
    expect(() =>
      packContextCandidates([], { tokenBudget: 1, profile: "unknown" as never }),
    ).toThrow("profile");
    expect(() =>
      packContextCandidates([], { tokenBudget: 1, latencyBudgetMs: 0 }),
    ).toThrow("latencyBudgetMs");
    expect(() =>
      packContextCandidates([candidate("", 0, 1)], { tokenBudget: 10 }),
    ).toThrow("positive integer rank");
    expect(() =>
      packContextCandidates([candidate("a", 1, -1)], { tokenBudget: 10 }),
    ).toThrow("scores");
    expect(() =>
      packContextCandidates(
        [
          {
            ...candidate("a", 1, 1),
            token_costs: { identity: 3, summary: 2, full: 1 },
          },
        ],
        { tokenBudget: 10 },
      ),
    ).toThrow("monotone");
    expect(() =>
      packContextCandidates([candidate("a", 1, 1, { uncertainty: -1 })], {
        tokenBudget: 10,
      }),
    ).toThrow("uncertainty");
    expect(() =>
      packContextCandidates([candidate("a", 1, 1), candidate("a", 2, 1)], {
        tokenBudget: 20,
      }),
    ).toThrow("unique ids");
  });
});

describe("context usage feedback", () => {
  it("records propensity rows and derives decayed served-then-touched affinity", async () => {
    const pmRoot = await tempPmRoot();
    await recordContextUsageServing({
      pmRoot,
      author: "agent",
      surface: "context",
      profile: "",
      now: "2026-07-01T00:00:00.000Z",
      rows: [
        { id: "pm-used", rank: 1, included: true },
        { id: "pm-ignored", rank: 2, included: true },
        { id: "pm-omitted", rank: 3, included: false },
      ],
    });
    await recordContextUsageTouches({
      pmRoot,
      author: "agent",
      itemIds: ["pm-used", "pm-unserved"],
      intent: "update",
      now: "2026-07-01T01:00:00.000Z",
    });
    const result = await readContextUsageAffinity({
      pmRoot,
      author: "agent",
      now: "2026-07-02T00:00:00.000Z",
    });

    expect(result).toEqual({
      affinity: { "pm-used": 1 },
      positive_judgments: 1,
      serving_events: 1,
    });
    const ledger = await readFile(
      path.join(pmRoot, "runtime", "context-usage.jsonl"),
      "utf8",
    );
    expect(ledger).not.toContain("pm-ignored description");
    expect(await readContextUsageAffinity({ pmRoot, author: "other" })).toEqual(
      { affinity: {}, positive_judgments: 0, serving_events: 0 },
    );
  });

  it("compacts by retention and count while tolerating malformed derived rows", async () => {
    const pmRoot = await tempPmRoot();
    await mkdir(path.join(pmRoot, "runtime"), { recursive: true });
    await writeFile(
      path.join(pmRoot, "runtime", "context-usage.jsonl"),
      "not-json\n",
      "utf8",
    );
    for (const day of [1, 2, 3]) {
      await recordContextUsageTouch({
        pmRoot,
        author: "agent",
        itemId: `pm-${day}`,
        intent: "update",
        now: `2026-07-0${day}T00:00:00.000Z`,
        maxEvents: 2,
        retentionDays: 10,
      });
    }
    const lines = (
      await readFile(
        path.join(pmRoot, "runtime", "context-usage.jsonl"),
        "utf8",
      )
    )
      .trim()
      .split("\n");
    expect(lines).toHaveLength(2);
    await recordContextUsageTouches({
      pmRoot,
      author: "agent",
      itemIds: ["pm-4", "pm-5"],
      intent: "batch-update",
      now: "2026-07-04T00:00:00.000Z",
      maxEvents: 3,
      retentionDays: 10,
    });
    const batchedLines = (await readFile(path.join(pmRoot, "runtime", "context-usage.jsonl"), "utf8")).trim().split("\n");
    expect(batchedLines).toHaveLength(3);
    expect(batchedLines.map((line) => JSON.parse(line).item_id)).toEqual(["pm-3", "pm-4", "pm-5"]);
  });

  it("keeps the exploration floor when decay underflows to zero", async () => {
    const pmRoot = await tempPmRoot();
    await recordContextUsageServing({
      pmRoot,
      author: "agent",
      surface: "context",
      profile: "context",
      rows: [{ id: "pm-ancient", rank: 1, included: true }],
      now: "2000-01-01T00:00:00.000Z",
      retentionDays: 3_000_000,
    });
    await recordContextUsageTouch({
      pmRoot,
      author: "agent",
      itemId: "pm-ancient",
      intent: "get",
      now: "2000-01-01T00:01:00.000Z",
      retentionDays: 3_000_000,
    });
    await expect(readContextUsageAffinity({
      pmRoot,
      author: "agent",
      now: "9999-01-01T00:00:00.000Z",
      retentionDays: 3_000_000,
      horizonHours: 1,
    })).resolves.toMatchObject({ affinity: { "pm-ancient": 0.05 } });
  });

  it("supports a zero-cost disabled mode and rejects malformed inputs", async () => {
    const pmRoot = await tempPmRoot();
    process.env.PM_CONTEXT_USAGE_DISABLED = "1";
    await recordContextUsageTouches({
      pmRoot,
      author: "agent",
      itemIds: ["pm-a"],
      intent: "update",
    });
    delete process.env.PM_CONTEXT_USAGE_DISABLED;
    await recordContextUsageTouches({
      pmRoot,
      author: "",
      itemIds: ["pm-a"],
      intent: "",
      enabled: false,
    });
    await recordContextUsageServing({
      pmRoot,
      author: "",
      surface: "next",
      profile: "",
      rows: [],
      enabled: false,
    });
    await recordContextUsageTouch({
      pmRoot,
      author: "",
      itemId: "",
      intent: "",
      enabled: false,
    });
    await expect(
      readContextUsageAffinity({ pmRoot, author: "agent", enabled: false }),
    ).resolves.toEqual({
      affinity: {},
      positive_judgments: 0,
      serving_events: 0,
    });
    await expect(
      recordContextUsageTouches({
        pmRoot,
        author: "",
        itemIds: ["pm-a"],
        intent: "update",
      }),
    ).rejects.toThrow("author and intent");
    await expect(
      recordContextUsageTouches({
        pmRoot,
        author: "agent",
        itemIds: [""],
        intent: "update",
      }),
    ).rejects.toThrow("non-empty itemId");
    await expect(
      recordContextUsageServing({
        pmRoot,
        author: "",
        surface: "context",
        profile: "",
        rows: [],
      }),
    ).rejects.toThrow("author");
    await expect(
      recordContextUsageServing({
        pmRoot,
        author: "agent",
        surface: "context",
        profile: "",
        rows: [{ id: "", rank: 0, included: true }],
      }),
    ).rejects.toThrow("ranked rows");
    await expect(
      recordContextUsageTouch({
        pmRoot,
        author: "agent",
        itemId: "",
        intent: "update",
      }),
    ).rejects.toThrow("itemId");
    await expect(
      readContextUsageAffinity({ pmRoot, author: "agent", now: "invalid" }),
    ).rejects.toThrow("valid timestamp");
    await expect(
      readContextUsageAffinity({ pmRoot, author: "agent", horizonHours: 0 }),
    ).rejects.toThrow("horizonHours");
    await expect(
      recordContextUsageTouch({
        pmRoot,
        author: "agent",
        itemId: "pm-a",
        intent: "update",
        maxEvents: 0,
      }),
    ).rejects.toThrow("retention");
  });
});
