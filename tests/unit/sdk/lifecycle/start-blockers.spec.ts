import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveRuntimeStatusRegistry } from "../../../../src/core/schema/runtime-schema.js";
import { EXIT_CODE } from "../../../../src/core/shared/constants.js";
import { readSettings, writeSettings } from "../../../../src/core/store/settings.js";
import { runConfig } from "../../../../src/sdk/config.js";
import { runClaim } from "../../../../src/sdk/lifecycle/claim.js";
import {
  admitExplicitStartClaim,
  admitStartTransition,
  admitStartWithOpenBlockers,
  runAsExplicitStart,
  isStartTransition,
  START_BLOCKED_REFUSAL_CODE,
  START_BLOCKER_ENFORCEMENT_DEFAULT,
} from "../../../../src/sdk/lifecycle/start-blockers.js";
import { releaseRefusedStartClaim, runStartTask } from "../../../../src/sdk/lifecycle/task-composition.js";
import { PmCliError } from "../../../../src/core/shared/errors.js";
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
  it("judges the effective start status when the workflow names open as in-progress", async () => {
    await withTempPmPath(async (context) => {
      const settings = await readSettings(context.pmPath);
      const registry = resolveRuntimeStatusRegistry({ ...settings.schema, workflow: { ...settings.schema.workflow, in_progress_status: "open" } });
      expect(isStartTransition("open", "in_progress", registry)).toBe(true);
      expect(isStartTransition("in_progress", "in_progress", registry)).toBe(false);
    });
  });

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

  it("fails closed on an unverifiable blocker under strict, yet warn and --force still admit the start", async () => {
    await withTempPmPath(async (context) => {
      const { blocker, blocked } = blockedPair(context, "Unverifiable target");
      const settings = await readSettings(context.pmPath);
      const metadata = (await new PmClient({ pmRoot: context.pmPath, noExtensions: true }).get(blocked, { full: true })).item as unknown as ItemMetadata;
      const admit = (force?: boolean) => admitStartWithOpenBlockers({ pmRoot: context.pmPath, settings, metadata, force });
      const blockerPath = path.join(context.pmPath, "tasks", `${blocker}.toon`);
      await writeFile(blockerPath, Buffer.from([0xff, 0xfe, 0x00]));
      await expect(admit()).rejects.toMatchObject({ context: { code: "item_document_encoding_invalid" } });
      expect(await admit(true)).toEqual([`start_blocker_unverifiable:${blocked}:item_document_encoding_invalid`]);
      settings.governance.start_blocker_enforcement = "warn";
      expect(await admit()).toEqual([`start_blocker_unverifiable:${blocked}:item_document_encoding_invalid`]);
      // Filesystem failures and refusals outside the integrity set keep propagating, even under --force.
      await rm(blockerPath);
      await mkdir(blockerPath);
      await expect(admit(true)).rejects.toMatchObject({ code: "EISDIR" });
      await rm(blockerPath, { recursive: true });
      await writeFile(blockerPath, "<<<<<<< ours\nid: x\n=======\nid: y\n>>>>>>> theirs\n");
      // A merge-conflicted working tree is the user's to resolve, as every item-store read already demands.
      await expect(admit(true)).rejects.toMatchObject({ context: { code: "merge_conflict_markers_detected" } });
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
      // External blockers have no local read. A selector without source_kind would normalize the locator
      // (pm-gh:...) and miss the stored row, so the step is an inspection rather than a no-op removal.
      expect((several as PmCliError).context.nextSteps).toEqual(["pm get pm-missing", 'pm get pm-x --fields "blocked_by,dependencies"', "pm next"]);
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

describe("pm-urzubi explicit start composition", () => {
  it("re-judges the status write after its claim and de-duplicates admitted warnings", async () => {
    await withTempPmPath(async (context) => {
      const settings = await readSettings(context.pmPath);
      const registry = resolveRuntimeStatusRegistry(settings.schema);
      const open = { id: "pm-x", type: "Task", status: "open", title: "x" } as ItemMetadata;
      const blocked = { ...open, status: "in_progress", dependencies: [{ id: "pm-missing", kind: "blocked_by" }] } as ItemMetadata;
      const transition = { pmRoot: context.pmPath, settings, metadata: blocked, fromStatus: "open", registry };
      expect(await admitExplicitStartClaim({ pmRoot: context.pmPath, settings, metadata: open, registry })).toEqual([]);
      await runAsExplicitStart(async () => {
        expect(await admitExplicitStartClaim({ pmRoot: context.pmPath, settings, metadata: { ...open, status: "in_progress" } as ItemMetadata, registry })).toEqual([]);
        // A blocker opened after the claim still refuses the status write.
        await expect(admitStartTransition(transition)).rejects.toMatchObject({ context: { code: START_BLOCKED_REFUSAL_CODE } });
        settings.governance.start_blocker_enforcement = "warn";
        // The claim recorded no warning, so the newly found blocker still warns.
        expect(await admitStartTransition(transition)).toEqual(["start_with_open_blockers:pm-x:pm-missing"]);
      });
      await runAsExplicitStart(async () => {
        // The claim already recorded this exact warning, so the status write does not repeat it.
        expect(await admitExplicitStartClaim({ pmRoot: context.pmPath, settings, metadata: { ...blocked, status: "open" } as ItemMetadata, registry })).toEqual(["start_with_open_blockers:pm-x:pm-missing"]);
        expect(await admitStartTransition(transition)).toEqual([]);
      });
      expect(await admitStartTransition(transition)).toEqual(["start_with_open_blockers:pm-x:pm-missing"]);
    });
  });

  it("releases only the claim a refused start took, and passes every other failure through", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "Compensated start" });
      const global = { path: context.pmPath };
      const claim = await runClaim(id, false, global, {});
      const refusal = new PmCliError("blocked", EXIT_CODE.CONFLICT, { code: START_BLOCKED_REFUSAL_CODE, item_id: id, why: "open blocker" });
      const wrapped = Object.assign(new PmCliError("blocked", EXIT_CODE.CONFLICT, { code: START_BLOCKED_REFUSAL_CODE, why: "wrapped" }), { cause: refusal });
      const other = new PmCliError("other", EXIT_CODE.CONFLICT, { code: "stale_revision" });
      expect(await releaseRefusedStartClaim(other, claim, global, undefined)).toBe(other);
      expect(await releaseRefusedStartClaim(refusal, { ...claim, previous_assignee: "someone" }, global, undefined)).toBe(refusal);
      const released = await releaseRefusedStartClaim(wrapped, claim, global, "test-author") as PmCliError;
      expect(released.context.why).toBe("open blocker A blocker opened after this start's claim, so the claim was released and no ownership remains.");
      expect((await new PmClient({ pmRoot: context.pmPath, noExtensions: true }).get(id)).item.assignee ?? null).toBeNull();
      const again = await runClaim(id, false, global, {});
      const bare = await releaseRefusedStartClaim(new PmCliError("blocked", EXIT_CODE.CONFLICT, { code: START_BLOCKED_REFUSAL_CODE }), again, global, undefined) as PmCliError;
      expect(bare.context.why).toBe("A blocker opened after this start's claim, so the claim was released and no ownership remains.");
    });
  });

  it("quotes stored references in every suggested step and resolves aliased edge kinds", async () => {
    await withTempPmPath(async (context) => {
      const settings = await readSettings(context.pmPath);
      const open = createTestItemId(context, { title: "Aliased blocker" });
      const base = { id: "pm-x", type: "Task", status: "open", title: "x" } as ItemMetadata;
      const refuse = async (metadata: ItemMetadata) => (await admitStartWithOpenBlockers({ pmRoot: context.pmPath, settings, metadata }).catch((error: PmCliError) => error)) as PmCliError;
      const hostile = await refuse({ ...base, dependencies: [{ id: "pm-$(touch owned)", kind: "blocked_by" }] } as ItemMetadata);
      expect(hostile.context.nextSteps?.slice(0, 2)).toEqual([
        process.platform === "win32" ? 'pm get "pm-$(touch owned)"' : 'pm get "pm-\\$(touch owned)"',
        process.platform === "win32"
          ? 'pm update pm-x --dep-remove "id=pm-$(touch owned),kind=blocked_by"'
          : 'pm update pm-x --dep-remove "id=pm-\\$(touch owned),kind=blocked_by"',
      ]);
      // A depends_on edge canonicalizes to blocked_by and resolves to its live target instead of throwing.
      const aliased = await refuse({ ...base, dependencies: [{ id: open, kind: "depends_on" }] } as ItemMetadata);
      expect(aliased.context.details).toMatchObject({ open_blockers: [{ id: open, status: "open" }] });
    });
  });

  it("advertises a targeted unblock step that never drops another prerequisite", async () => {
    await withTempPmPath(async (context) => {
      const settings = await readSettings(context.pmPath);
      const base = { id: "pm-x", type: "Task", status: "open", title: "x" } as ItemMetadata;
      const nextSteps = async (metadata: ItemMetadata) => ((await admitStartWithOpenBlockers({ pmRoot: context.pmPath, settings, metadata }).catch((error: PmCliError) => error)) as PmCliError).context.nextSteps;
      // A scalar-only short alias is cleared by the scalar clear alone.
      expect(await nextSteps({ ...base, blocked_by: "missing" } as ItemMetadata))
        .toContain("pm update pm-x --unset blocked_by");
      // An alias-kind edge naming the same blocker survives both the scalar clear and a literal removal.
      expect(await nextSteps({ ...base, blocked_by: "pm-missing", dependencies: [{ id: "pm-missing", kind: "depends_on" }] } as ItemMetadata))
        .toContain('pm get pm-x --fields "blocked_by,dependencies"');
      expect(await nextSteps({ ...base, dependencies: [{ id: "pm-missing", kind: "blocked_by" }, { id: "pm-missing", kind: "depends_on" }] } as ItemMetadata))
        .toContain('pm get pm-x --fields "blocked_by,dependencies"');
      // The scalar and an edge with the same stored text are one declaration.
      expect(await nextSteps({ ...base, blocked_by: "PM-Missing", dependencies: [{ id: "pm-missing", kind: "blocked_by" }] } as ItemMetadata))
        .toContain("pm update pm-x --unset blocked_by");
      // A short scalar beside a prefixed edge may name two distinct items (a and pm-a), so clearing is not offered.
      expect(await nextSteps({ ...base, blocked_by: "missing", dependencies: [{ id: "pm-missing", kind: "blocked_by" }] } as ItemMetadata))
        .toContain('pm get pm-x --fields "blocked_by,dependencies"');
      // pm-4yxzvd: the canonical row a short scalar write derived is the scalar's own, so the clear removes it.
      for (const source_kind of ["cli:update:blocked_by", "cli:create:blocked_by"]) {
        expect(await nextSteps({ ...base, blocked_by: "missing", dependencies: [{ id: "pm-missing", kind: "blocked_by", source_kind }] } as ItemMetadata))
          .toContain("pm update pm-x --unset blocked_by");
      }
      // Removal selectors normalize ids and compare kinds literally: legacy rows get an inspection step.
      expect(await nextSteps({ ...base, dependencies: [{ id: "missing", kind: "blocked_by" }] } as ItemMetadata))
        .toContain('pm get pm-x --fields "blocked_by,dependencies"');
      expect(await nextSteps({ ...base, dependencies: [{ id: "pm-missing", kind: "depends_on" }] } as ItemMetadata))
        .toContain('pm get pm-x --fields "blocked_by,dependencies"');
      expect(await nextSteps({ ...base, dependencies: [{ id: "pm-missing", kind: "blocked_by" }] } as ItemMetadata))
        .toContain('pm update pm-x --dep-remove "id=pm-missing,kind=blocked_by"');
      // Two rows naming one blocker (pm-missing and a legacy short missing) cannot both go with one selector.
      expect(await nextSteps({ ...base, dependencies: [{ id: "pm-missing", kind: "blocked_by" }, { id: "missing", kind: "blocked_by" }] } as ItemMetadata))
        .toContain('pm get pm-x --fields "blocked_by,dependencies"');
      // pm-4yxzvd: the scalar clear keeps the independent edge, so it is offered for multi-edge items too.
      const multiEdge = await nextSteps({ ...base, blocked_by: "pm-missing", dependencies: [{ id: "pm-missing", kind: "blocked_by" }, { id: "pm-other", kind: "blocked_by" }] } as ItemMetadata);
      expect(multiEdge).toContain("pm update pm-x --unset blocked_by");
      expect(multiEdge).not.toContain('pm get pm-x --fields "blocked_by,dependencies"');
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
