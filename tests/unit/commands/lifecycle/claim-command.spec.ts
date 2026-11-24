import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { _testOnlyClaimCommand, assertPauseKeepsLaterHolder } from "../../../../src/sdk/lifecycle/claim.js";
import {
  claimNextFromRecommendations,
  isAlreadyClaimedError,
  parseClaimNextAttempts,
  runClaim,
  runClaimNext,
  runRelease,
  type ClaimMutationOptions,
} from "../../../../src/cli/commands/lifecycle/claim.js";
import type { GlobalOptions } from "../../../../src/core/shared/command-types.js";
import { EXIT_CODE } from "../../../../src/core/shared/constants.js";
import { PmCliError } from "../../../../src/core/shared/errors.js";
import { runWithHarnessDetectionSignals } from "../../../../src/core/shared/author.js";
import { getHistoryPath } from "../../../../src/core/store/paths.js";
import { locateItem } from "../../../../src/core/store/item-store.js";
import {
  readSettings,
  writeSettings,
} from "../../../../src/core/store/settings.js";
import {
  withTempPmPath,
  type TempPmContext,
} from "../../../helpers/withTempPmPath.js";
import { withIsolatedHarnessEnvironment } from "../../../helpers/withIsolatedHarnessEnvironment.js";
import { runPauseTask } from "../../../../src/sdk/lifecycle/task-composition.js";

function createTask(
  context: TempPmContext,
  params: {
    title: string;
    status: "open" | "in_progress" | "closed";
    assignee?: string;
  },
): string {
  const result = context.runCli(
    [
      "create",
      "--json",
      "--title",
      params.title,
      "--description",
      `${params.title} description`,
      "--type",
      "Task",
      "--status",
      params.status,
      "--priority",
      "1",
      "--tags",
      "testing",
      "--body",
      "",
      "--deadline",
      "none",
      "--estimate",
      "10",
      "--acceptance-criteria",
      `${params.title} acceptance`,
      "--author",
      "test-author",
      "--message",
      `Create ${params.title}`,
      "--assignee",
      params.assignee ?? "none",
      "--dep",
      "none",
      "--comment",
      "none",
      "--note",
      "none",
      "--learning",
      "none",
      "--file",
      "none",
      "--test",
      "none",
      "--doc",
      "none",
    ],
    { expectJson: true },
  );
  expect(result.code).toBe(0);
  const payload = result.json as { item?: { id?: string } };
  expect(typeof payload.item?.id).toBe("string");
  return payload.item?.id ?? "";
}

function setGovernancePreset(
  context: TempPmContext,
  preset: "minimal" | "default" | "strict",
): void {
  const result = context.runCli(
    [
      "config",
      "project",
      "set",
      "governance-preset",
      "--policy",
      preset,
      "--json",
    ],
    {
      expectJson: true,
    },
  );
  expect(result.code).toBe(0);
}

describe("runClaim/runRelease", () => {
  it("validates the bounded claim-next candidate walk", () => {
    expect(parseClaimNextAttempts(undefined)).toBe(10);
    expect(parseClaimNextAttempts("4")).toBe(4);
    expect(parseClaimNextAttempts(4)).toBe(4);
    expect(() => parseClaimNextAttempts("0")).toThrow(/1 to 100/);
    expect(() => parseClaimNextAttempts("101")).toThrow(/1 to 100/);
    expect(() => parseClaimNextAttempts("1.5")).toThrow(/1 to 100/);
  });
  it("classifies only structured already-claimed conflicts as retryable", () => {
    expect(isAlreadyClaimedError(new Error("ordinary"))).toBe(false);
    expect(
      isAlreadyClaimedError(
        new PmCliError("other", EXIT_CODE.CONFLICT, { code: "other" }),
      ),
    ).toBe(false);
    expect(
      isAlreadyClaimedError(
        new PmCliError("held", EXIT_CODE.CONFLICT, {
          code: "already_claimed_by",
        }),
      ),
    ).toBe(true);
  });

  it("propagates non-conflict failures from ranked claim composition", async () => {
    const recommendation = { id: "pm-x", reasons: [] } as never;
    await expect(
      claimNextFromRecommendations(
        [recommendation],
        false,
        {},
        {},
        async () => {
          throw new Error("storage unavailable");
        },
      ),
    ).rejects.toThrow("storage unavailable");
  });

  it("names candidates refused for an open blocker when the walk is exhausted", async () => {
    const blocked = new PmCliError("blocked", EXIT_CODE.CONFLICT, { code: "start_blocked_by_open_dependency" });
    const held = new PmCliError("held", EXIT_CODE.CONFLICT, { code: "already_claimed_by" });
    const runner = async (id: string) => {
      throw id === "pm-held" ? held : blocked;
    };
    const onlyRefused = await claimNextFromRecommendations([{ id: "pm-a", reasons: [] }] as never, false, {}, { start: true }, runner)
      .then(() => { throw new Error("expected refusal"); }, (error: PmCliError) => error);
    expect(onlyRefused).toMatchObject({ exitCode: EXIT_CODE.CONFLICT, context: { code: "no_available_next_item", details: { start_refused: ["pm-a"] } } });
    // The retry keeps the start request (CodeRabbit PR 1658): following it must not claim without starting.
    expect(onlyRefused.context.nextSteps).toEqual(["Run pm claim --next --start again, with the same filters, to refresh the ranked candidate set."]);
    expect(onlyRefused.context.why).toBe("1 of 1 attempted candidates refused their start because a declared blocker is open (pm-a), and nothing was written to them; no other candidate was attempted.");
    const mixed = await claimNextFromRecommendations([{ id: "pm-a", reasons: [] }, { id: "pm-held", reasons: [] }] as never, false, {}, { start: true }, runner)
      .then(() => { throw new Error("expected refusal"); }, (error: PmCliError) => error);
    expect(mixed.context.why).toContain("every other attempted candidate was claimed by another agent");
    const unavailable = await claimNextFromRecommendations([{ id: "pm-a", reasons: [] }] as never, false, {}, { start: true, ifAvailable: true }, runner);
    expect(unavailable).toMatchObject({ available: false, attempts: 1, start_refused: ["pm-a"], warnings: ["no_available_next_item"] });
    const heldOnly = await claimNextFromRecommendations([{ id: "pm-held", reasons: [] }] as never, false, {}, {}, runner)
      .then(() => { throw new Error("expected refusal"); }, (error: PmCliError) => error);
    expect(heldOnly.context.why).toBe("Every ranked candidate was claimed by another agent before this atomic selection completed.");
    expect(heldOnly.context).not.toHaveProperty("details");
  });

  it("honors if-available while advancing skipped ranked candidates", async () => {
    const recommendations = [
      { id: "pm-held", reasons: [] },
      { id: "pm-free", reasons: [] },
    ] as never;
    const runner = vi.fn(
      async (
        id: string,
        _force: boolean,
        _global: GlobalOptions,
        options: ClaimMutationOptions,
      ) => ({
        item: { id },
        claimed_by: id === "pm-held" ? "other" : "agent",
        previous_assignee: id === "pm-held" ? "other" : null,
        forced: false,
        ...(id === "pm-held" ? { skipped: true } : {}),
        options,
      }),
    );
    const claimed = await claimNextFromRecommendations(
      recommendations,
      false,
      {},
      { ifAvailable: true },
      runner,
    );
    expect(claimed.recommendation.id).toBe("pm-free");
    expect(claimed.attempts).toBe(2);
    expect(runner).toHaveBeenCalledWith(
      "pm-held",
      false,
      {},
      { ifAvailable: true },
    );
  });

  it("returns a non-failing skip when every if-available candidate is held", async () => {
    const recommendation = { id: "pm-held", reasons: [] } as never;
    const previousAuthor = process.env.PM_AUTHOR;
    delete process.env.PM_AUTHOR;
    try {
      const claimRunner = async () => ({
        item: { id: "pm-held" },
        claimed_by: "other",
        previous_assignee: "other",
        forced: false,
        skipped: true,
      });
      const unknown = await withIsolatedHarnessEnvironment({}, () =>
        claimNextFromRecommendations(
          [recommendation],
          false,
          {},
          { ifAvailable: true },
          claimRunner,
        ),
      );
      process.env.PM_AUTHOR = "environment-author";
      const environment = await claimNextFromRecommendations(
        [recommendation],
        false,
        {},
        { ifAvailable: true },
        claimRunner,
      );
      const explicit = await claimNextFromRecommendations(
        [recommendation],
        false,
        {},
        { ifAvailable: true, author: "explicit-author" },
        claimRunner,
      );

      expect(unknown).toMatchObject({
        available: false,
        claimed_by: "unknown",
        skipped: true,
        attempts: 1,
        recommendation: null,
      });
      expect(environment.claimed_by).toBe("environment-author");
      expect(explicit.claimed_by).toBe("explicit-author");
    } finally {
      if (previousAuthor === undefined) delete process.env.PM_AUTHOR;
      else process.env.PM_AUTHOR = previousAuthor;
    }
  });
  it("reports conflict guidance when every attempted candidate loses its claim race", async () => {
    const recommendation = { id: "pm-raced", reasons: [] } as never;
    await expect(
      claimNextFromRecommendations(
        [recommendation],
        false,
        {},
        {},
        async () => {
          throw new PmCliError("held", EXIT_CODE.CONFLICT, {
            code: "already_claimed_by",
          });
        },
      ),
    ).rejects.toMatchObject<Partial<PmCliError>>({
      message: "No actionable item remained available to claim",
      exitCode: EXIT_CODE.CONFLICT,
      context: {
        code: "no_available_next_item",
        why: "Every ranked candidate was claimed by another agent before this atomic selection completed.",
        nextSteps: [
          "Run pm claim --next again, with the same filters, to refresh the ranked candidate set.",
        ],
      },
    });
  });
  it("fails when tracker is not initialized", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pm-claim-not-init-"));
    try {
      await expect(
        runClaim("pm-missing", false, { path: tempDir }),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
      await expect(
        runRelease("pm-missing", false, { path: tempDir }),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("claims unassigned items for current author", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, { title: "claim-open", status: "open" });
      const result = await runClaim(id, false, { path: context.pmPath });
      expect(result.claimed_by).toBe("test-author");
      expect(result.previous_assignee).toBeNull();
      expect(result.forced).toBe(false);
      expect(result.item.assignee).toBe("test-author");
      expect(result).toHaveProperty("changed_fields", ["assignee", "claim_principal"]);
      const repeated = await runClaim(id, false, { path: context.pmPath });
      expect(repeated).toHaveProperty("changed_fields", []);
    });
  });

  it("atomically claims the next caller-available recommendation", async () => {
    await withTempPmPath(async (context) => {
      const first = createTask(context, {
        title: "claim-next-first",
        status: "open",
      });
      const second = createTask(context, {
        title: "claim-next-second",
        status: "open",
      });
      const result = await runClaimNext(
        false,
        { path: context.pmPath },
        { author: "next-agent" },
      );
      expect([first, second]).toContain(result.recommendation.id);
      expect(result.claimed_by).toBe("next-agent");
      expect(result.attempts).toBe(1);
    });
  });

  it("uses the explicit claim author for next-work ownership ranking", async () => {
    await withTempPmPath(async (context) => {
      const mine = createTask(context, {
        title: "explicit-author-work",
        status: "in_progress",
      });
      context.runCli(["update", mine, "--assignee", "next-agent", "--json"], {
        expectJson: true,
      });
      createTask(context, { title: "other-work", status: "open" });
      const result = await runClaimNext(
        false,
        { path: context.pmPath },
        { author: "next-agent" },
      );
      expect(result.recommendation.id).toBe(mine);
      expect(result.claimed_by).toBe("next-agent");
    });
  });

  it("distributes parallel claim-next calls and reports exhaustion", async () => {
    await withTempPmPath(async (context) => {
      createTask(context, { title: "parallel-next-a", status: "open" });
      createTask(context, { title: "parallel-next-b", status: "open" });
      const claimed = await Promise.all([
        runClaimNext(false, { path: context.pmPath }, { author: "parallel-a" }),
        runClaimNext(false, { path: context.pmPath }, { author: "parallel-b" }),
      ]);
      expect(
        new Set(claimed.map((result) => result.recommendation.id)).size,
      ).toBe(2);
    });
    await withTempPmPath(async (context) => {
      const empty = await runClaimNext(
        false,
        { path: context.pmPath },
        { author: "nobody", ifAvailable: true },
      );
      expect(empty).toMatchObject({
        available: false,
        item: null,
        skipped: true,
        recommendation: null,
        attempts: 0,
        warnings: ["no_available_next_item"],
      });
      await expect(
        runClaimNext(false, { path: context.pmPath }, { author: "nobody" }),
      ).rejects.toMatchObject({
        exitCode: EXIT_CODE.NOT_FOUND,
        context: expect.objectContaining({ code: "no_available_next_item" }),
      });
      const missingId = context.runCli(["claim", "--json"]);
      expect(missingId.code).toBe(EXIT_CODE.USAGE);
    });
  });

  it("uses the configured default author in an empty if-available envelope", async () => {
    await withTempPmPath(async (context) => {
      const settingsPath = path.join(context.pmPath, "settings.json");
      const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
        author_default?: string;
      };
      settings.author_default = "settings-author";
      await writeFile(
        settingsPath,
        `${JSON.stringify(settings, null, 2)}\n`,
        "utf8",
      );
      const previousAuthor = process.env.PM_AUTHOR;
      delete process.env.PM_AUTHOR;
      try {
        const empty = await runClaimNext(
          false,
          { path: context.pmPath },
          { ifAvailable: true },
        );
        expect(empty.claimed_by).toBe("settings-author");
      } finally {
        if (previousAuthor === undefined) delete process.env.PM_AUTHOR;
        else process.env.PM_AUTHOR = previousAuthor;
      }
    });
  });

  it("rejects claiming terminal items unless forced", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, {
        title: "claim-closed",
        status: "closed",
      });
      await expect(
        runClaim(id, false, { path: context.pmPath }),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.CONFLICT,
      });

      const forcedResult = await runClaim(id, true, { path: context.pmPath });
      expect(forcedResult.forced).toBe(true);
      expect(forcedResult.item.assignee).toBe("test-author");
    });
  });

  it("re-claims already-owned items idempotently and rejects held items unless forced (pm-8t5x)", async () => {
    await withTempPmPath(async (context) => {
      const mine = createTask(context, {
        title: "claim-current-assignee",
        status: "open",
        assignee: "test-author",
      });
      const mineResult = await runClaim(mine, false, { path: context.pmPath });
      expect(mineResult.previous_assignee).toBe("test-author");
      expect(mineResult.forced).toBe(false);

      const foreign = createTask(context, {
        title: "claim-foreign-assignee",
        status: "open",
        assignee: "other-author",
      });
      await expect(
        runClaim(foreign, false, { path: context.pmPath }),
      ).rejects.toMatchObject<Partial<PmCliError>>({
        exitCode: EXIT_CODE.CONFLICT,
        message: expect.stringContaining(
          "already assigned to other-author",
        ) as unknown as string,
        // GH-1610: the holder is a typed field, not only prose.
        context: expect.objectContaining({
          code: "already_claimed_by",
          item_id: foreign,
          claimed_by: "other-author",
          claim_source: "assignment",
          claimed_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
        }) as unknown as PmCliError["context"],
      });

      const takeover = await runClaim(foreign, true, { path: context.pmPath });
      expect(takeover.previous_assignee).toBe("other-author");
      expect(takeover.forced).toBe(true);
      expect(takeover.item.assignee).toBe("test-author");
      expect(takeover.warnings).toEqual(
        expect.arrayContaining(["claim_takeover:other-author->test-author"]),
      );

      const claimed = createTask(context, {
        title: "claim-explicitly-claimed",
        status: "open",
      });
      await runClaim(
        claimed,
        false,
        { path: context.pmPath },
        { author: "other-author" },
      );
      await expect(
        runClaim(claimed, false, { path: context.pmPath }),
      ).rejects.toMatchObject<Partial<PmCliError>>({
        exitCode: EXIT_CODE.CONFLICT,
        message: expect.stringContaining(
          "already claimed by other-author",
        ) as unknown as string,
        context: expect.objectContaining({
          claimed_by: "other-author",
          claim_source: "claim",
          claimed_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
        }) as unknown as PmCliError["context"],
      });
    });
  });

  it("keeps assignment wording but reports an unknown origin when ownership history is corrupt", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, {
        title: "claim-corrupt-history",
        status: "open",
        assignee: "other-author",
      });
      await writeFile(
        getHistoryPath(context.pmPath, id),
        "{invalid-json\n",
        "utf8",
      );

      await expect(
        runClaim(id, false, { path: context.pmPath }),
      ).rejects.toMatchObject<Partial<PmCliError>>({
        exitCode: EXIT_CODE.CONFLICT,
        message: expect.stringContaining(
          "already assigned to other-author",
        ) as unknown as string,
        context: expect.objectContaining({
          code: "already_claimed_by",
          claimed_by: "other-author",
          claim_source: "unknown",
          claimed_at: null,
        }) as unknown as PmCliError["context"],
      });
    });
  });

  it("reports an unknown origin when the newest assignee history entry set a different holder", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, {
        title: "claim-diverged-history",
        status: "open",
        assignee: "other-author",
      });
      // Item state now names a holder that no history entry recorded.
      const settings = await readSettings(context.pmPath);
      const located = await locateItem(context.pmPath, id, settings.id_prefix, settings.item_format);
      const itemPath = located!.itemPath;
      await writeFile(itemPath, (await readFile(itemPath, "utf8")).replace("other-author", "third-author"), "utf8");

      await expect(
        runClaim(id, false, { path: context.pmPath }),
      ).rejects.toMatchObject<Partial<PmCliError>>({
        exitCode: EXIT_CODE.CONFLICT,
        context: expect.objectContaining({
          claimed_by: "third-author",
          claim_source: "unknown",
          claimed_at: null,
        }) as unknown as PmCliError["context"],
      });
    });
  });

  it("supports --if-available to skip silently when item is held by another author (pm-d4bo)", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, {
        title: "claim-if-available-held",
        status: "open",
        assignee: "other-author",
      });
      const beforeGet = context.runCli(["get", id, "--json"], {
        expectJson: true,
      });
      const beforeHistory = context.runCli(
        ["history", id, "--json", "--full"],
        { expectJson: true },
      );
      const beforeUpdatedAt = (
        beforeGet.json as { item: { updated_at: string } }
      ).item.updated_at;
      const beforeHistoryCount = (beforeHistory.json as { history: unknown[] })
        .history.length;

      const result = await runClaim(
        id,
        false,
        { path: context.pmPath },
        { ifAvailable: true },
      );

      const afterGet = context.runCli(["get", id, "--json"], {
        expectJson: true,
      });
      const afterHistory = context.runCli(["history", id, "--json", "--full"], {
        expectJson: true,
      });
      expect(result.skipped).toBe(true);
      expect(result).toHaveProperty("changed_fields", []);
      expect(result.previous_assignee).toBe("other-author");
      expect(result.item.assignee).toBe("other-author");
      expect(result.warnings).toEqual(
        expect.arrayContaining(["claim_skipped_held_by:other-author"]),
      );
      expect(
        (afterGet.json as { item: { updated_at: string } }).item.updated_at,
      ).toBe(beforeUpdatedAt);
      expect((afterHistory.json as { history: unknown[] }).history.length).toBe(
        beforeHistoryCount,
      );
    });
  });

  it("returns unchanged when releasing unassigned items", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, {
        title: "release-unassigned",
        status: "open",
      });
      const result = await runRelease(id, false, { path: context.pmPath });
      expect(result.previous_assignee).toBeNull();
      expect(result.forced).toBe(false);
      expect(result.item.assignee).toBeUndefined();
    });
  });

  it("clears a durable claim principal after terminal transitions remove the assignee", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, {
        title: "release-terminal-claim-principal",
        status: "open",
      });
      await runClaim(id, false, { path: context.pmPath });
      const closed = context.runCli(["close", id, "completed", "--json"], {
        expectJson: true,
      });
      expect(closed.code).toBe(0);
      const beforeHistory = context.runCli(
        ["history", id, "--json", "--full"],
        { expectJson: true },
      );

      const released = await runRelease(id, false, {
        path: context.pmPath,
      });
      const afterHistory = context.runCli(["history", id, "--json", "--full"], {
        expectJson: true,
      });

      expect(released.previous_assignee).toBeNull();
      expect(released.item.assignee).toBeUndefined();
      expect(released.item.claim_principal).toBeUndefined();
      expect((afterHistory.json as { history: unknown[] }).history.length).toBe(
        (beforeHistory.json as { history: unknown[] }).history.length + 1,
      );
    });
  });

  it("releases current author assignments and blocks foreign assignees unless forced", async () => {
    await withTempPmPath(async (context) => {
      setGovernancePreset(context, "strict");
      const current = createTask(context, {
        title: "release-current-assignee",
        status: "open",
        assignee: "test-author",
      });
      const currentResult = await runRelease(current, false, {
        path: context.pmPath,
      });
      expect(currentResult.previous_assignee).toBe("test-author");
      expect(currentResult.forced).toBe(false);
      expect(currentResult.item.assignee).toBeUndefined();

      const foreign = createTask(context, {
        title: "release-foreign-assignee",
        status: "open",
        assignee: "other-author",
      });
      await expect(
        runRelease(foreign, false, { path: context.pmPath }),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.CONFLICT,
      });

      const forced = await runRelease(foreign, true, { path: context.pmPath });
      expect(forced.previous_assignee).toBe("other-author");
      expect(forced.forced).toBe(true);
      expect(forced.item.assignee).toBeUndefined();
    });
  });

  describe("a release by the holder a close ended (GH-1774)", () => {
    /** Claim as agent-a, close as agent-a, then force-claim the closed item as agent-b. */
    async function closedThenReclaimed(context: TempPmContext, title: string): Promise<string> {
      const id = createTask(context, { title, status: "open" });
      const global = { path: context.pmPath };
      await runClaim(id, false, global, { author: "agent-a" });
      const closed = context.runCli(
        ["close", id, "completed", "--author", "agent-a", "--resolution", "done", "--expected-result", "done", "--actual-result", "done", "--json"],
        { expectJson: true },
      );
      expect(closed.code, `${closed.stdout}${closed.stderr}`).toBe(0);
      const reclaimed = await runClaim(id, true, global, { author: "agent-b" });
      expect(reclaimed.item.assignee).toBe("agent-b");
      return id;
    }

    async function itemState(context: TempPmContext, id: string): Promise<{ raw: string; history: string }> {
      const located = await locateItem(context.pmPath, id);
      return {
        raw: await readFile(located!.itemPath, "utf8"),
        history: await readFile(getHistoryPath(context.pmPath, id), "utf8"),
      };
    }

    for (const preset of ["default", "strict"] as const) {
      for (const force of [false, true]) {
        it(`keeps the replacement holder under the ${preset} policy${force ? " with --force" : ""} and writes nothing`, async () => {
          await withTempPmPath(async (context) => {
            setGovernancePreset(context, preset);
            const id = await closedThenReclaimed(context, `release-after-close-${preset}-${force}`);
            const before = await itemState(context, id);

            const released = await runRelease(id, force, { path: context.pmPath }, { author: "agent-a" });

            expect(released.item.assignee).toBe("agent-b");
            expect(released.previous_assignee).toBeNull();
            expect(released.changed_fields).toEqual([]);
            expect(released.warnings).toEqual([`release_claim_ended_by_close:${id}:agent-b`]);
            expect(released.warnings?.some((warning) => warning.startsWith("ownership_warning:"))).toBe(false);
            expect(released.suggestions).toEqual([
              `A close of ${id} already ended your claim; agent-b claimed it afterwards and keeps it. The item was not changed.`,
            ]);
            // The holder's item and its activity clock are untouched.
            expect(await itemState(context, id)).toEqual(before);
          });
        });
      }
    }

    /** Claim and close as agent-a, reopen, then claim (and start) as agent-b. */
    async function reopenedThenReclaimed(context: TempPmContext, title: string): Promise<string> {
      const id = await closedThenReclaimed(context, title);
      const global = { path: context.pmPath };
      await runRelease(id, false, global, { author: "agent-b" });
      const reopened = context.runCli(["item", "reopen", id, "Reopened for more work", "--author", "agent-b", "--json"], { expectJson: true });
      expect(reopened.code, `${reopened.stdout}${reopened.stderr}`).toBe(0);
      await runClaim(id, false, global, { author: "agent-b", start: true });
      return id;
    }

    it("refuses a handoff by the closed holder without moving or releasing the later claim", async () => {
      await withTempPmPath(async (context) => {
        expect(context.runCli(["schema", "add-status", "review", "--role", "active"]).code).toBe(0);
        const id = await reopenedThenReclaimed(context, "release-after-close-handoff");
        const before = await itemState(context, id);
        await expect(
          runRelease(id, true, { path: context.pmPath }, { author: "agent-a", handoff: "review", message: "Implemented; verify" }),
        ).rejects.toMatchObject<PmCliError>({
          exitCode: EXIT_CODE.CONFLICT,
          code: "release_claim_ended_by_close",
          context: expect.objectContaining({
            claimed_by: "agent-b",
            item_id: id,
            nextSteps: expect.arrayContaining([expect.stringContaining(`--pm-path ${context.pmPath} claim ${id} --force --author agent-a`)]),
          }),
        });
        expect(await itemState(context, id)).toEqual(before);
      });
    });

    it("refuses a pause by the closed holder before its status write", async () => {
      await withTempPmPath(async (context) => {
        setGovernancePreset(context, "default");
        const id = await reopenedThenReclaimed(context, "release-after-close-pause");
        const before = await itemState(context, id);
        await expect(runPauseTask(id, { author: "agent-a", force: true }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
          code: "release_claim_ended_by_close",
        });
        expect(await itemState(context, id)).toEqual(before);
        // The holder itself still pauses normally.
        const paused = await runPauseTask(id, { author: "agent-b" }, { path: context.pmPath });
        expect(paused.release.item.assignee).toBeUndefined();
      });
    });

    it("fences the pause's status write to the holder it judged, so a claim landing in between is never moved", async () => {
      await withTempPmPath(async (context) => {
        const global = { path: context.pmPath };
        const id = createTask(context, { title: "pause-race", status: "in_progress" });
        const fence = await assertPauseKeepsLaterHolder(id, global, "agent-a");
        // B claims after the judgement and before the status write takes the lock.
        await runClaim(id, false, global, { author: "agent-b" });
        const before = await itemState(context, id);
        await expect(fence(() => runRelease(id, true, global, { author: "agent-a" }))).rejects.toMatchObject<PmCliError>({
          code: "pause_item_changed",
          context: expect.objectContaining({ item_id: id, nextSteps: [expect.stringContaining(`release ${id} --pause`)] }),
        });
        expect(await itemState(context, id)).toEqual(before);
        // The same holder with a newer write (a close and reclaim, or any other change) also refuses.
        const judgedOnce = await assertPauseKeepsLaterHolder(id, global, "agent-b");
        expect(context.runCli(["comments", id, "--add", "progress", "--author", "agent-b"]).code).toBe(0);
        await expect(judgedOnce(() => runRelease(id, false, global, { author: "agent-b" }))).rejects.toMatchObject<PmCliError>({ code: "pause_item_changed" });
        // An unchanged item passes the fence.
        const unchanged = await assertPauseKeepsLaterHolder(id, global, "agent-b");
        await expect(unchanged(() => runRelease(id, false, global, { author: "agent-b" }))).resolves.toMatchObject({ previous_assignee: "agent-b" });
      });
    });

    it("keeps the takeover hint on the detected author when no explicit author was passed", () => {
      for (const author of [undefined, "  "]) {
        const refusal = _testOnlyClaimCommand.releaseClaimEndedRefusal("pm-x", "agent-b", "--pause", { path: "/tmp/other tracker" }, author);
        expect(refusal.context.nextSteps?.[1]).toBe('Take the item first with a coordinated pm --pm-path "/tmp/other tracker" claim pm-x --force only when that takeover is approved.');
      }
    });

    it("leaves every other pause to the ownership policy", async () => {
      await withTempPmPath(async (context) => {
        setGovernancePreset(context, "default");
        const global = { path: context.pmPath };
        // Unclaimed, missing and stranger-held items pass the pre-check; the pause's own writes judge them.
        const unclaimed = createTask(context, { title: "pause-unclaimed", status: "in_progress" });
        await expect(assertPauseKeepsLaterHolder(unclaimed, global, "agent-a")).resolves.toBeTypeOf("function");
        // A missing item gets a pass-through fence; the pause's own update reports it.
        const missingFence = await assertPauseKeepsLaterHolder("pm-missing-id", global, "agent-a");
        await expect(missingFence(async () => "written")).resolves.toBe("written");
        // An assignment without a claim principal is compared by its assignee, as the ownership guard compares it.
        const assigned = createTask(context, { title: "pause-assigned", status: "open", assignee: "agent-b" });
        await expect(assertPauseKeepsLaterHolder(assigned, global, "agent-a")).resolves.toBeTypeOf("function");
        await expect(assertPauseKeepsLaterHolder(assigned, global, "agent-b")).resolves.toBeTypeOf("function");
        const held = createTask(context, { title: "pause-stranger", status: "open" });
        await runClaim(held, false, global, { author: "agent-b", start: true });
        await expect(assertPauseKeepsLaterHolder(held, global, "agent-c")).resolves.toBeTypeOf("function");
        const paused = await runPauseTask(held, { author: "agent-c" }, global);
        expect(paused.release.warnings).toContain(`ownership_warning:assignee_conflict:${held}:agent-b`);
      });
    });

    it("leaves a stored leftover deferral alone on a scoped no-op", async () => {
      await withTempPmPath(async (context) => {
        const created = context.runCli(
          ["create", "Task", "--title", "release-after-close-deferral", "--description", "d", "--defer", "deadline", "--defer-reason", "later", "--json"],
          { expectJson: true },
        );
        expect(created.code, created.stderr).toBe(0);
        const payload = created.json as { id?: string; item?: { id?: string } };
        const id = (payload.item?.id ?? payload.id)!;
        const global = { path: context.pmPath };
        await runClaim(id, false, global, { author: "agent-a" });
        const closed = context.runCli(
          ["close", id, "completed", "--author", "agent-a", "--resolution", "done", "--expected-result", "done", "--actual-result", "done", "--json"],
          { expectJson: true },
        );
        expect(closed.code, `${closed.stdout}${closed.stderr}`).toBe(0);
        await runClaim(id, true, global, { author: "agent-b" });
        // A value recorded out of band leaves the deferral resolved but stored, which any write would prune.
        const located = await locateItem(context.pmPath, id);
        await writeFile(located!.itemPath, `${await readFile(located!.itemPath, "utf8")}deadline: "2026-12-31T00:00:00.000Z"\n`);
        const before = await itemState(context, id);
        const released = await runRelease(id, false, global, { author: "agent-a" });
        expect(released.changed_fields).toEqual([]);
        expect(await itemState(context, id)).toEqual(before);
      });
    });

    it("lets the replacement holder release itself", async () => {
      await withTempPmPath(async (context) => {
        const id = await closedThenReclaimed(context, "release-after-close-self");
        const released = await runRelease(id, false, { path: context.pmPath }, { author: "agent-b" });
        expect(released.previous_assignee).toBe("agent-b");
        expect(released.item.assignee).toBeUndefined();
      });
    });

    it("keeps the ownership policy when the caller's later claim was ended by a takeover, not a close", async () => {
      await withTempPmPath(async (context) => {
        setGovernancePreset(context, "strict");
        const id = await closedThenReclaimed(context, "release-after-close-reclaimed");
        const global = { path: context.pmPath };
        await runClaim(id, true, global, { author: "agent-a" });
        await runClaim(id, true, global, { author: "agent-b" });
        await expect(runRelease(id, false, global, { author: "agent-a" })).rejects.toMatchObject<PmCliError>({
          exitCode: EXIT_CODE.CONFLICT,
        });
      });
    });

    it("keeps the ownership policy for a caller that never held the item and for an unreadable stream", async () => {
      await withTempPmPath(async (context) => {
        setGovernancePreset(context, "strict");
        const id = await closedThenReclaimed(context, "release-after-close-stranger");
        const global = { path: context.pmPath };
        await expect(runRelease(id, false, global, { author: "agent-c" })).rejects.toMatchObject<PmCliError>({
          exitCode: EXIT_CODE.CONFLICT,
        });
        const historyPath = getHistoryPath(context.pmPath, id);
        await writeFile(historyPath, `${await readFile(historyPath, "utf8")}not-json\n`);
        await expect(runRelease(id, false, global, { author: "agent-a" })).rejects.toMatchObject<PmCliError>({
          exitCode: EXIT_CODE.CONFLICT,
        });
      });
    });

    it("warns and clears under the default policy when the caller's claim did not end at a close", async () => {
      await withTempPmPath(async (context) => {
        setGovernancePreset(context, "default");
        const id = createTask(context, { title: "release-open-takeover", status: "open" });
        const global = { path: context.pmPath };
        await runClaim(id, false, global, { author: "agent-a" });
        await runClaim(id, true, global, { author: "agent-b" });
        const released = await runRelease(id, false, global, { author: "agent-a" });
        expect(released.previous_assignee).toBe("agent-b");
        expect(released.item.assignee).toBeUndefined();
        expect(released.warnings).toContain(`ownership_warning:assignee_conflict:${id}:agent-b`);
      });
    });
  });

  it("supports audited non-owner release handoffs without force", async () => {
    await withTempPmPath(async (context) => {
      setGovernancePreset(context, "strict");
      const foreign = createTask(context, {
        title: "release-audit-foreign-assignee",
        status: "open",
        assignee: "other-author",
      });

      const audited = await runRelease(
        foreign,
        false,
        { path: context.pmPath },
        {
          author: "audit-reviewer",
          message: "audit release handoff",
          ownershipReleaseBypass: true,
        },
      );
      expect(audited.previous_assignee).toBe("other-author");
      expect(audited.forced).toBe(false);
      expect(audited.item.assignee).toBeUndefined();
    });
  });

  it("rethrows non-ownership release errors unchanged", async () => {
    await withTempPmPath(async (context) => {
      await expect(
        runRelease("pm-missing-id", false, { path: context.pmPath }),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
    });
  });

  it("uses detected harness ownership when PM_AUTHOR and configured author are absent", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, {
        title: "author-fallback",
        status: "open",
      });
      const settings = await readSettings(context.pmPath);
      await writeSettings(context.pmPath, { ...settings, author_default: "" });
      await withIsolatedHarnessEnvironment(
        { CODEX_THREAD_ID: "claim-test-thread" },
        async () => {
          const claimResult = await runClaim(id, false, {
            path: context.pmPath,
          });
          expect(claimResult.item.assignee).toBe("harness:codex");

          const releaseResult = await runRelease(id, false, {
            path: context.pmPath,
          });
          expect(releaseResult.item.assignee).toBeUndefined();
        },
      );
    });
  });

  it("keeps concurrent sessions of one detected harness as distinct claim principals", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, {
        title: "same-harness-distinct-sessions",
        status: "open",
      });
      const settings = await readSettings(context.pmPath);
      await writeSettings(context.pmPath, { ...settings, author_default: "" });
      const claimFromSession = (session: string) =>
        runWithHarnessDetectionSignals(
          {
            env: {
              CODEX_HOME: "/tmp/codex",
              CODEX_THREAD_ID: session,
            },
          },
          () => runClaim(id, false, { path: context.pmPath }),
        );

      const first = await claimFromSession("thread-a");
      expect(first.item.assignee).toBe("harness:codex");
      expect(first.item.claim_principal).toMatch(
        /^harness:codex#[a-f0-9]{24}$/,
      );
      await expect(claimFromSession("thread-b")).rejects.toMatchObject({
        exitCode: EXIT_CODE.CONFLICT,
        context: expect.objectContaining({ code: "already_claimed_by" }),
      });
      expect((await claimFromSession("thread-a")).skipped).toBeUndefined();

      const stored = await readFile(
        path.join(context.pmPath, "tasks", `${id}.toon`),
        "utf8",
      );
      expect(stored).not.toContain("thread-a");
      expect(stored).not.toContain("thread-b");
    });
  });

  it("uses explicit author and message metadata when provided", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, {
        title: "explicit-mutation-metadata",
        status: "open",
      });
      const previousAuthor = process.env.PM_AUTHOR;
      process.env.PM_AUTHOR = "env-default-author";
      try {
        await runClaim(
          id,
          false,
          { path: context.pmPath },
          { author: "claim-author", message: "claim message" },
        );
        const claimHistory = context.runCli(
          ["history", id, "--json", "--full", "--limit", "1"],
          { expectJson: true },
        );
        expect(claimHistory.code).toBe(0);
        const claimEntry = (
          claimHistory.json as {
            history: Array<{ op: string; author: string; message?: string }>;
          }
        ).history[0];
        expect(claimEntry.op).toBe("claim");
        expect(claimEntry.author).toBe("claim-author");
        expect(claimEntry.message).toBe("claim message");

        await runRelease(
          id,
          true,
          { path: context.pmPath },
          { author: "release-author", message: "release message" },
        );
        const releaseHistory = context.runCli(
          ["history", id, "--json", "--full", "--limit", "1"],
          { expectJson: true },
        );
        expect(releaseHistory.code).toBe(0);
        const releaseEntry = (
          releaseHistory.json as {
            history: Array<{ op: string; author: string; message?: string }>;
          }
        ).history[0];
        expect(releaseEntry.op).toBe("release");
        expect(releaseEntry.author).toBe("release-author");
        expect(releaseEntry.message).toBe("release message");
      } finally {
        if (previousAuthor === undefined) {
          delete process.env.PM_AUTHOR;
        } else {
          process.env.PM_AUTHOR = previousAuthor;
        }
      }
    });
  });
});
