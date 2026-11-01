import { describe, expect, it } from "vitest";
import { resolveRuntimeStatusRegistry } from "../../../../src/core/schema/runtime-schema.js";
import { readSettings } from "../../../../src/core/store/settings.js";
import { EXIT_CODE } from "../../../../src/core/shared/constants.js";
import type { PmCliError } from "../../../../src/core/shared/errors.js";
import { applyClaimStart, requireClaimTarget, runClaimNext } from "../../../../src/sdk/lifecycle/claim.js";
import { PmClient, runAction } from "../../../../src/sdk/runtime.js";
import type { ItemMetadata } from "../../../../src/types/index.js";
import { createTestItemId } from "../../../helpers/itemFactory.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";

/** Collect the guidance a refusal gives so it can be checked against the flags the caller passed. */
function refusalGuidance(run: () => void): { code: unknown; text: string } {
  try {
    run();
  } catch (error) {
    const context = (error as PmCliError).context;
    return {
      code: context.code,
      text: [(error as Error).message, context.required ?? "", ...(context.nextSteps ?? [])].join(" "),
    };
  }
  throw new Error("expected a refusal");
}

describe("GH-1643 claim target refusals", () => {
  it("accepts exactly one of an id or --next", () => {
    expect(requireClaimTarget(undefined, true)).toBeUndefined();
    expect(requireClaimTarget("pm-a", false)).toBeUndefined();
    expect(requireClaimTarget(undefined, true, true)).toBeUndefined();
  });

  it("types a missing target and suggests --next only when the caller did not pass it", () => {
    const plain = refusalGuidance(() => requireClaimTarget(undefined, false));
    expect(plain).toMatchObject({ code: "missing_required_argument" });
    expect(plain.text).toContain("Specify an item id or pass --next");
    const start = refusalGuidance(() => requireClaimTarget(undefined, false, true));
    expect(start.code).toBe("missing_required_argument");
    expect(start.text).toContain("pm claim --next --start");
    expect(start.text).toContain("pm claim <id> --start");
  });

  it("never tells a caller who passed --next to pass it again", () => {
    for (const start of [false, true]) {
      const refusal = refusalGuidance(() => requireClaimTarget("pm-a", true, start));
      expect(refusal.code).toBe("ambiguous_option_combination");
      expect(refusal.text).not.toMatch(/pass --next|add --next/u);
      expect(refusal.text).toContain(`pm claim pm-a${start ? " --start" : ""}`);
    }
  });
});

describe("GH-1643 applyClaimStart", () => {
  it("is a no-op without a start status and refuses terminal items", async () => {
    await withTempPmPath(async (context) => {
      const settings = await readSettings(context.pmPath);
      const registry = resolveRuntimeStatusRegistry(settings.schema);
      const open = { id: "pm-a", type: "Task", status: "open" } as ItemMetadata;
      expect(applyClaimStart(open, false, settings, registry)).toEqual({ changedFields: [], warnings: [] });
      expect(open.status).toBe("open");
      expect(() =>
        applyClaimStart({ id: "pm-b", type: "Task", status: "closed" } as ItemMetadata, true, settings, registry),
      ).toThrow(expect.objectContaining({ exitCode: EXIT_CODE.CONFLICT, context: expect.objectContaining({ code: "terminal_state_conflict" }) }));
      const running = { id: "pm-c", type: "Task", status: "in_progress" } as ItemMetadata;
      expect(applyClaimStart(running, true, settings, registry)).toEqual({
        start: { from_status: "in_progress", to_status: "in_progress" },
        changedFields: [],
        warnings: [],
      });
      expect(applyClaimStart(open, true, settings, registry)).toMatchObject({
        start: { from_status: "open", to_status: "in_progress" },
        changedFields: ["status"],
      });
      expect(open.status).toBe("in_progress");
    });
  });

  it("enforces configured type workflows with a warning or a refusal", async () => {
    await withTempPmPath(async (context) => {
      const settings = await readSettings(context.pmPath);
      const registry = resolveRuntimeStatusRegistry(settings.schema);
      settings.schema = { ...settings.schema, type_workflows: [{ type: "Task", allowed_transitions: [["open", "closed"]] }] };
      settings.governance = { ...settings.governance, workflow_enforcement: "warn" };
      const warned = applyClaimStart({ id: "pm-a", type: "Task", status: "open" } as ItemMetadata, true, settings, registry);
      expect(warned.warnings).toHaveLength(1);
      expect(warned.changedFields).toEqual(["status"]);
      settings.governance = { ...settings.governance, workflow_enforcement: "strict" };
      expect(() =>
        applyClaimStart({ id: "pm-a", type: "Task", status: "open" } as ItemMetadata, true, settings, registry),
      ).toThrow("Disallowed transition");
    });
  });
});

describe("GH-1643 claim --next --start", () => {
  it("selects, claims and starts in one claim history event through the SDK", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "Next start", priority: "0" });
      const result = await runClaimNext(false, { path: context.pmPath }, { start: true });
      expect(result).toMatchObject({
        available: true,
        item: { id, status: "in_progress", assignee: "test-author" },
        start: { from_status: "open", to_status: "in_progress" },
      });
      expect(result.changed_fields).toEqual(["assignee", "claim_principal", "status"]);
      const history = context.runCli(["history", id, "--full", "--json"], { expectJson: true }).json as {
        history: Array<{ op: string }>;
      };
      expect(history.history.map((entry) => entry.op)).toEqual(["create", "claim"]);
      expect(await runClaimNext(false, { path: context.pmPath }, { start: true, ifAvailable: true }, { assigneeFilter: "unassigned" })).toMatchObject({
        available: false,
        item: null,
      });
    });
  });

  it("starts through the CLI, MCP and the typed client, and refuses a start without a target", async () => {
    await withTempPmPath(async (context) => {
      const first = createTestItemId(context, { title: "CLI start", priority: "0" });
      const cli = await context.runCliInProcess(["claim", "--next", "--start", "--json"]);
      expect(cli.code, cli.stderr).toBe(0);
      expect(JSON.parse(cli.stdout)).toMatchObject({ item: { id: first, status: "in_progress" }, available: true });

      const second = createTestItemId(context, { title: "MCP start", priority: "0" });
      const common = { path: context.pmPath, noExtensions: true, author: "mcp-author" };
      expect(await runAction({ ...common, action: "claim", next: true, start: true })).toMatchObject({ id: second, status: "in_progress" });

      const third = createTestItemId(context, { title: "Client start", priority: "0" });
      const client = new PmClient({ pmRoot: context.pmPath, noExtensions: true, author: "client-author" });
      expect(await client.claimNext({ start: true })).toMatchObject({ item: { id: third, status: "in_progress" }, start: { to_status: "in_progress" } });

      const refused = await context.runCliInProcess(["claim", "--start", "--json"]);
      expect(refused.code).toBe(EXIT_CODE.USAGE);
      expect(refused.stderr).toContain("missing_required_argument");
      expect(refused.stderr).toContain("pm claim --next --start");
      await expect(runAction({ ...common, action: "claim", start: true })).rejects.toMatchObject({ context: { code: "missing_required_argument" } });
      // Nested options win over flat arguments for both dispatch and the target check.
      await expect(runAction({ ...common, action: "claim", next: true, options: { next: false, start: true } })).rejects.toMatchObject({
        context: { code: "missing_required_argument" },
      });
      // An explicit id with next and start is refused by the explicit-start composition before any write.
      await expect(runAction({ ...common, action: "claim", id: third, next: true, start: true })).rejects.toMatchObject({
        context: { code: "invalid_argument_value" },
      });
    });
  });
});
