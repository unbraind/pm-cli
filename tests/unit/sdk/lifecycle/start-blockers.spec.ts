import { describe, expect, it } from "vitest";
import { resolveRuntimeStatusRegistry } from "../../../../src/core/schema/runtime-schema.js";
import { EXIT_CODE } from "../../../../src/core/shared/constants.js";
import type { PmCliError } from "../../../../src/core/shared/errors.js";
import { readSettings, writeSettings } from "../../../../src/core/store/settings.js";
import { runConfig } from "../../../../src/sdk/config.js";
import { runClaim } from "../../../../src/sdk/lifecycle/claim.js";
import {
  admitStartWithOpenBlockers,
  isStartTransition,
  START_BLOCKED_REFUSAL_CODE,
  START_BLOCKER_ENFORCEMENT_DEFAULT,
} from "../../../../src/sdk/lifecycle/start-blockers.js";
import { runStartTask } from "../../../../src/sdk/lifecycle/task-composition.js";
import { runUpdate } from "../../../../src/sdk/lifecycle/update.js";
import { PmClient } from "../../../../src/sdk/runtime.js";
import type { ItemMetadata } from "../../../../src/types/index.js";
import { createTestItemId } from "../../../helpers/itemFactory.js";
import { withTempPmPath, type TempPmContext } from "../../../helpers/withTempPmPath.js";

async function setEnforcement(context: TempPmContext, mode: "off" | "warn" | "strict" | undefined): Promise<void> {
  const settings = await readSettings(context.pmPath);
  if (mode === undefined) delete settings.governance.start_blocker_enforcement;
  else settings.governance.start_blocker_enforcement = mode;
  await writeSettings(context.pmPath, settings, "test:start-blocker-enforcement");
}

function blockedPair(context: TempPmContext, title: string): { blocker: string; blocked: string } {
  const blocker = createTestItemId(context, { title: `${title} blocker` });
  const blocked = createTestItemId(context, { title, dep: `id=${blocker},kind=blocked_by` });
  return { blocker, blocked };
}

describe("pm-urzubi start transitions", () => {
  it("recognizes only moves into the in-progress status", async () => {
    await withTempPmPath(async (context) => {
      const registry = resolveRuntimeStatusRegistry((await readSettings(context.pmPath)).schema);
      expect(isStartTransition("open", "in_progress", registry)).toBe(true);
      expect(isStartTransition("blocked", "in-progress", registry)).toBe(true);
      expect(isStartTransition(undefined, "in_progress", registry)).toBe(true);
      expect(isStartTransition("in_progress", "in_progress", registry)).toBe(false);
      expect(isStartTransition("open", "closed", registry)).toBe(false);
      expect(isStartTransition("open", undefined, registry)).toBe(false);
      expect(START_BLOCKER_ENFORCEMENT_DEFAULT).toBe("strict");
    });
  });
});

describe("pm-urzubi admission policy", () => {
  it("refuses under strict, warns under warn or force, and ignores under off", async () => {
    await withTempPmPath(async (context) => {
      const { blocker, blocked } = blockedPair(context, "Policy target");
      const settings = await readSettings(context.pmPath);
      const metadata = (await new PmClient({ pmRoot: context.pmPath, noExtensions: true }).get(blocked, { full: true })).item as unknown as ItemMetadata;
      const admit = (force?: boolean) => admitStartWithOpenBlockers({ pmRoot: context.pmPath, settings, metadata, force });
      const refusal = await admit().then(() => { throw new Error("expected refusal"); }, (error: PmCliError) => error);
      expect(refusal).toMatchObject({
        exitCode: EXIT_CODE.CONFLICT,
        context: {
          code: START_BLOCKED_REFUSAL_CODE,
          item_id: blocked,
          details: { enforcement: "strict", open_blockers: [{ id: blocker, status: "open", external: false }] },
        },
      });
      expect(refusal.message).toContain("its blocker");
      expect(refusal.context.nextSteps).toEqual([`pm get ${blocker}`, `pm update ${blocked} --dep-remove "id=${blocker},kind=blocked_by"`, "pm next"]);
      expect(await admit(true)).toEqual([`start_blocker_override:${blocked}:${blocker}`]);
      settings.governance.start_blocker_enforcement = "warn";
      expect(await admit()).toEqual([`start_with_open_blockers:${blocked}:${blocker}`]);
      settings.governance.start_blocker_enforcement = "off";
      expect(await admit()).toEqual([]);
      settings.governance.start_blocker_enforcement = "strict";
      expect(await admitStartWithOpenBlockers({ pmRoot: context.pmPath, settings, metadata: { ...metadata, dependencies: [] } })).toEqual([]);
    });
  });

  it("treats terminal targets as resolved and missing or external targets as open", async () => {
    await withTempPmPath(async (context) => {
      const settings = await readSettings(context.pmPath);
      const done = createTestItemId(context, { title: "Done blocker", status: "closed" });
      const base = { id: "pm-x", type: "Task", status: "open", title: "x" } as ItemMetadata;
      const admit = (metadata: ItemMetadata) => admitStartWithOpenBlockers({ pmRoot: context.pmPath, settings, metadata });
      expect(await admit({ ...base, dependencies: [{ id: done, kind: "blocked_by" }] } as ItemMetadata)).toEqual([]);
      const several = await admit({ ...base, blocked_by: "pm-missing", dependencies: [{ id: "gh:org/repo#12", kind: "blocked_by", source_kind: "external" }] } as ItemMetadata)
        .catch((error: PmCliError) => error);
      expect((several as PmCliError).message).toContain("2 of its blockers");
      expect((several as PmCliError).context.details).toMatchObject({
        open_blockers: expect.arrayContaining([
          expect.objectContaining({ id: "pm-missing", external: false }),
          expect.objectContaining({ external: true }),
        ]),
      });
      // External blockers have no local read; the first open blocker's edge is dropped with --dep-remove.
      expect((several as PmCliError).context.nextSteps).toEqual(["pm get pm-missing", 'pm update pm-x --dep-remove "id=gh:org/repo#12,kind=blocked_by"', "pm next"]);
      const scalarOnly = await admit({ ...base, blocked_by: "pm-missing" } as ItemMetadata).catch((error: PmCliError) => error);
      expect((scalarOnly as PmCliError).context.nextSteps).toEqual(["pm get pm-missing", "pm update pm-x --unset blocked_by", "pm next"]);
    });
  });
});

describe("pm-urzubi transports share one check before any write", () => {
  it("refuses update --status in_progress, and admits an update that drops the blocker in the same call", async () => {
    await withTempPmPath(async (context) => {
      const { blocker, blocked } = blockedPair(context, "Update start");
      const global = { path: context.pmPath };
      await expect(runUpdate(blocked, { status: "in_progress" }, global)).rejects.toMatchObject({ context: { code: START_BLOCKED_REFUSAL_CODE } });
      const forced = await runUpdate(blocked, { status: "in_progress", force: true }, global);
      expect(forced.warnings).toContain(`start_blocker_override:${blocked}:${blocker}`);
      const second = blockedPair(context, "Drop and start");
      const dropped = await runUpdate(second.blocked, { status: "in_progress", depRemove: [`id=${second.blocker},kind=blocked_by`] }, global);
      expect(dropped.item).toMatchObject({ status: "in_progress" });
      // Editing an item that is already in progress is not a start.
      expect((await runUpdate(blocked, { priority: "2" }, global)).item).toMatchObject({ status: "in_progress" });
    });
  });

  it("refuses claim --start before the claim write, so no claim is left behind", async () => {
    await withTempPmPath(async (context) => {
      const { blocked } = blockedPair(context, "Claim start");
      const global = { path: context.pmPath };
      await expect(runStartTask(blocked, {}, global)).rejects.toMatchObject({ context: { code: START_BLOCKED_REFUSAL_CODE } });
      const after = await new PmClient({ pmRoot: context.pmPath, noExtensions: true }).get(blocked);
      expect(after.item.assignee ?? null).toBeNull();
      expect((await runStartTask(blocked, { force: true }, global)).update.item).toMatchObject({ status: "in_progress" });
      // Starting an item already in progress re-claims without re-judging its blockers.
      expect((await runStartTask(blocked, {}, global)).update.item).toMatchObject({ status: "in_progress" });
      await expect(runStartTask("pm-missing", {}, global)).rejects.toMatchObject({ context: { code: "item_not_found" } });
    });
  });

  it("re-checks the in-lock start of claim --next --start", async () => {
    await withTempPmPath(async (context) => {
      const { blocker, blocked } = blockedPair(context, "Locked start");
      const global = { path: context.pmPath };
      await expect(runClaim(blocked, false, global, { start: true })).rejects.toMatchObject({ context: { code: START_BLOCKED_REFUSAL_CODE } });
      expect((await runClaim(blocked, true, global, { start: true })).warnings).toContain(`start_blocker_override:${blocked}:${blocker}`);
      expect((await runClaim(blocked, false, global, { start: true })).start).toMatchObject({ from_status: "in_progress" });
    });
  });

  it("starts through the CLI and MCP-shaped dispatch with the same refusal", async () => {
    await withTempPmPath(async (context) => {
      const { blocked } = blockedPair(context, "Transport start");
      const cli = await context.runCliInProcess(["claim", blocked, "--start", "--json"]);
      expect(cli.code).toBe(EXIT_CODE.CONFLICT);
      expect(cli.stderr).toContain(START_BLOCKED_REFUSAL_CODE);
      const pm = new PmClient({ pmRoot: context.pmPath, noExtensions: true, author: "mcp-agent" });
      await expect(pm.run("start-task", { id: blocked })).rejects.toMatchObject({ context: { code: START_BLOCKED_REFUSAL_CODE } });
    });
  });
});

describe("pm-urzubi governance setting", () => {
  it("round-trips through pm config and settings persistence", async () => {
    await withTempPmPath(async (context) => {
      const global = { path: context.pmPath };
      expect(await runConfig("project", "get", "governance-start-blocker-enforcement", {}, global)).toMatchObject({ policy: "strict" });
      expect(await runConfig("project", "set", "governance-start-blocker-enforcement", { policy: "warn" }, global)).toMatchObject({ policy: "warn", changed: true });
      expect(await runConfig("project", "set", "governance_start_blocker_enforcement", { policy: "warn" }, global)).toMatchObject({ changed: false });
      expect((await readSettings(context.pmPath)).governance.start_blocker_enforcement).toBe("warn");
      expect(await runConfig("project", "set", "governance-start-blocker-enforcement", { policy: "disabled" }, global)).toMatchObject({ policy: "off" });
      await expect(runConfig("project", "set", "governance-start-blocker-enforcement", { policy: "sometimes" }, global)).rejects.toThrow(
        "Config set governance-start-blocker-enforcement requires one of: off, warn, strict",
      );
      await setEnforcement(context, "strict");
      expect((await readSettings(context.pmPath)).governance.start_blocker_enforcement).toBe("strict");
      await setEnforcement(context, undefined);
      expect((await readSettings(context.pmPath)).governance.start_blocker_enforcement).toBeUndefined();
    });
  });
});
