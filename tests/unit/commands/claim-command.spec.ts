import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { claimNextFromRecommendations, isAlreadyClaimedError, parseClaimNextAttempts, runClaim, runClaimNext, runRelease, type ClaimMutationOptions } from "../../../src/cli/commands/claim.js";
import type { GlobalOptions } from "../../../src/core/shared/command-types.js";
import { EXIT_CODE } from "../../../src/core/shared/constants.js";
import { PmCliError } from "../../../src/core/shared/errors.js";
import { getHistoryPath } from "../../../src/core/store/paths.js";
import { readSettings, writeSettings } from "../../../src/core/store/settings.js";
import { withTempPmPath, type TempPmContext } from "../../helpers/withTempPmPath.js";

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

function setGovernancePreset(context: TempPmContext, preset: "minimal" | "default" | "strict"): void {
  const result = context.runCli(["config", "project", "set", "governance-preset", "--policy", preset, "--json"], {
    expectJson: true,
  });
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
    expect(isAlreadyClaimedError(new PmCliError("other", EXIT_CODE.CONFLICT, { code: "other" }))).toBe(false);
    expect(isAlreadyClaimedError(new PmCliError("held", EXIT_CODE.CONFLICT, { code: "already_claimed_by" }))).toBe(true);
  });

  it("propagates non-conflict failures from ranked claim composition", async () => {
    const recommendation = { id: "pm-x", reasons: [] } as never;
    await expect(
      claimNextFromRecommendations([recommendation], false, {}, {}, async () => {
        throw new Error("storage unavailable");
      }),
    ).rejects.toThrow("storage unavailable");
  });

  it("honors if-available while advancing skipped ranked candidates", async () => {
    const recommendations = [
      { id: "pm-held", reasons: [] },
      { id: "pm-free", reasons: [] },
    ] as never;
    const runner = vi.fn(async (id: string, _force: boolean, _global: GlobalOptions, options: ClaimMutationOptions) => ({
      item: { id },
      claimed_by: id === "pm-held" ? "other" : "agent",
      previous_assignee: id === "pm-held" ? "other" : null,
      forced: false,
      ...(id === "pm-held" ? { skipped: true } : {}),
      options,
    }));
    const claimed = await claimNextFromRecommendations(recommendations, false, {}, { ifAvailable: true }, runner);
    expect(claimed.recommendation.id).toBe("pm-free");
    expect(claimed.attempts).toBe(2);
    expect(runner).toHaveBeenCalledWith("pm-held", false, {}, { ifAvailable: true });
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
      const unknown = await claimNextFromRecommendations(
        [recommendation],
        false,
        {},
        { ifAvailable: true },
        claimRunner,
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
      claimNextFromRecommendations([recommendation], false, {}, {}, async () => {
        throw new PmCliError("held", EXIT_CODE.CONFLICT, { code: "already_claimed_by" });
      }),
    ).rejects.toMatchObject<Partial<PmCliError>>({
      message: "No actionable item remained available to claim",
      exitCode: EXIT_CODE.CONFLICT,
      context: {
        code: "no_available_next_item",
        why: "Every ranked candidate was claimed by another agent before this atomic selection completed.",
        nextSteps: ["Run pm claim --next again to refresh the ranked candidate set."],
      },
    });
  });
  it("fails when tracker is not initialized", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pm-claim-not-init-"));
    try {
      await expect(runClaim("pm-missing", false, { path: tempDir })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
      await expect(runRelease("pm-missing", false, { path: tempDir })).rejects.toMatchObject<PmCliError>({
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
    });
  });

  it("atomically claims the next caller-available recommendation", async () => {
    await withTempPmPath(async (context) => {
      const first = createTask(context, { title: "claim-next-first", status: "open" });
      const second = createTask(context, { title: "claim-next-second", status: "open" });
      const result = await runClaimNext(false, { path: context.pmPath }, { author: "next-agent" });
      expect([first, second]).toContain(result.recommendation.id);
      expect(result.claimed_by).toBe("next-agent");
      expect(result.attempts).toBe(1);
    });
  });

  it("uses the explicit claim author for next-work ownership ranking", async () => {
    await withTempPmPath(async (context) => {
      const mine = createTask(context, { title: "explicit-author-work", status: "in_progress" });
      context.runCli(["update", mine, "--assignee", "next-agent", "--json"], { expectJson: true });
      createTask(context, { title: "other-work", status: "open" });
      const result = await runClaimNext(false, { path: context.pmPath }, { author: "next-agent" });
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
      expect(new Set(claimed.map((result) => result.recommendation.id)).size).toBe(2);
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
      await expect(runClaimNext(false, { path: context.pmPath }, { author: "nobody" })).rejects.toMatchObject({
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
      await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
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
      const id = createTask(context, { title: "claim-closed", status: "closed" });
      await expect(runClaim(id, false, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
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
      await expect(runClaim(foreign, false, { path: context.pmPath })).rejects.toMatchObject<Partial<PmCliError>>({
        exitCode: EXIT_CODE.CONFLICT,
        message: expect.stringContaining("already assigned to other-author") as unknown as string,
        context: expect.objectContaining({ code: "already_claimed_by" }) as unknown as PmCliError["context"],
      });

      const takeover = await runClaim(foreign, true, { path: context.pmPath });
      expect(takeover.previous_assignee).toBe("other-author");
      expect(takeover.forced).toBe(true);
      expect(takeover.item.assignee).toBe("test-author");
      expect(takeover.warnings).toEqual(expect.arrayContaining(["claim_takeover:other-author->test-author"]));

      const claimed = createTask(context, {
        title: "claim-explicitly-claimed",
        status: "open",
      });
      await runClaim(claimed, false, { path: context.pmPath }, { author: "other-author" });
      await expect(runClaim(claimed, false, { path: context.pmPath })).rejects.toMatchObject<Partial<PmCliError>>({
        exitCode: EXIT_CODE.CONFLICT,
        message: expect.stringContaining("already claimed by other-author") as unknown as string,
      });
    });
  });

  it("falls back to assignment wording when ownership history is corrupt", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, {
        title: "claim-corrupt-history",
        status: "open",
        assignee: "other-author",
      });
      await writeFile(getHistoryPath(context.pmPath, id), "{invalid-json\n", "utf8");

      await expect(runClaim(id, false, { path: context.pmPath })).rejects.toMatchObject<Partial<PmCliError>>({
        exitCode: EXIT_CODE.CONFLICT,
        message: expect.stringContaining("already assigned to other-author") as unknown as string,
        context: expect.objectContaining({ code: "already_claimed_by" }) as unknown as PmCliError["context"],
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
      const beforeGet = context.runCli(["get", id, "--json"], { expectJson: true });
      const beforeHistory = context.runCli(["history", id, "--json", "--full"], { expectJson: true });
      const beforeUpdatedAt = (beforeGet.json as { item: { updated_at: string } }).item.updated_at;
      const beforeHistoryCount = (beforeHistory.json as { history: unknown[] }).history.length;

      const result = await runClaim(id, false, { path: context.pmPath }, { ifAvailable: true });

      const afterGet = context.runCli(["get", id, "--json"], { expectJson: true });
      const afterHistory = context.runCli(["history", id, "--json", "--full"], { expectJson: true });
      expect(result.skipped).toBe(true);
      expect(result.previous_assignee).toBe("other-author");
      expect(result.item.assignee).toBe("other-author");
      expect(result.warnings).toEqual(expect.arrayContaining(["claim_skipped_held_by:other-author"]));
      expect((afterGet.json as { item: { updated_at: string } }).item.updated_at).toBe(beforeUpdatedAt);
      expect((afterHistory.json as { history: unknown[] }).history.length).toBe(beforeHistoryCount);
    });
  });

  it("returns unchanged when releasing unassigned items", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, { title: "release-unassigned", status: "open" });
      const result = await runRelease(id, false, { path: context.pmPath });
      expect(result.previous_assignee).toBeNull();
      expect(result.forced).toBe(false);
      expect(result.item.assignee).toBeUndefined();
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
      const currentResult = await runRelease(current, false, { path: context.pmPath });
      expect(currentResult.previous_assignee).toBe("test-author");
      expect(currentResult.forced).toBe(false);
      expect(currentResult.item.assignee).toBeUndefined();

      const foreign = createTask(context, {
        title: "release-foreign-assignee",
        status: "open",
        assignee: "other-author",
      });
      await expect(runRelease(foreign, false, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.CONFLICT,
      });

      const forced = await runRelease(foreign, true, { path: context.pmPath });
      expect(forced.previous_assignee).toBe("other-author");
      expect(forced.forced).toBe(true);
      expect(forced.item.assignee).toBeUndefined();
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
      await expect(runRelease("pm-missing-id", false, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
    });
  });

  it("covers missing PM_AUTHOR fallback for claim and release", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, { title: "author-fallback", status: "open" });
      const settings = await readSettings(context.pmPath);
      await writeSettings(context.pmPath, { ...settings, author_default: "" });
      const previousAuthor = process.env.PM_AUTHOR;
      delete process.env.PM_AUTHOR;
      try {
        const claimResult = await runClaim(id, false, { path: context.pmPath });
        expect(claimResult.item.assignee).toBe("unknown");

        const releaseResult = await runRelease(id, false, { path: context.pmPath });
        expect(releaseResult.item.assignee).toBeUndefined();
      } finally {
        if (previousAuthor === undefined) {
          delete process.env.PM_AUTHOR;
        } else {
          process.env.PM_AUTHOR = previousAuthor;
        }
      }
    });
  });

  it("uses explicit author and message metadata when provided", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, { title: "explicit-mutation-metadata", status: "open" });
      const previousAuthor = process.env.PM_AUTHOR;
      process.env.PM_AUTHOR = "env-default-author";
      try {
        await runClaim(id, false, { path: context.pmPath }, { author: "claim-author", message: "claim message" });
        const claimHistory = context.runCli(["history", id, "--json", "--full", "--limit", "1"], { expectJson: true });
        expect(claimHistory.code).toBe(0);
        const claimEntry = (claimHistory.json as { history: Array<{ op: string; author: string; message?: string }> }).history[0];
        expect(claimEntry.op).toBe("claim");
        expect(claimEntry.author).toBe("claim-author");
        expect(claimEntry.message).toBe("claim message");

        await runRelease(id, true, { path: context.pmPath }, { author: "release-author", message: "release message" });
        const releaseHistory = context.runCli(["history", id, "--json", "--full", "--limit", "1"], { expectJson: true });
        expect(releaseHistory.code).toBe(0);
        const releaseEntry = (releaseHistory.json as { history: Array<{ op: string; author: string; message?: string }> })
          .history[0];
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
