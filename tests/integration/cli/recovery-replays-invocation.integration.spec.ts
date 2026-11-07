import path from "node:path";

import { describe, expect, it } from "vitest";

import { EXIT_CODE } from "../../../src/core/shared/constants.js";
import { withTempPmPath, type TempPmContext } from "../../helpers/withTempPmPath.js";

/**
 * Refusal recovery is executed, not just read: each spec replays the commands a
 * refusal prescribes and checks they act on the tracker the caller selected.
 * The temp tracker (PM_PATH) is a decoy holding the same item id, so a
 * recovery command that drops the caller's --pm-path reads the decoy instead.
 */
const TARGET = path.join("target", ".agents", "pm");

function run(context: TempPmContext, args: string[]) {
  // The caller's exact argv: no harness-injected mutation output flags.
  return context.runCli(args, { cwd: context.tempRoot, preserveDefaultMutationOutput: true });
}

/** Replay one rendered recovery command; operands here never need shell quoting. */
function replay(context: TempPmContext, command: string) {
  const [binary, ...args] = command.split(" ");
  expect(binary).toBe("pm");
  return run(context, args);
}

function seedDecoyAndTarget(context: TempPmContext): void {
  expect(run(context, ["--pm-path", TARGET, "init", "--defaults", "--agent-guidance", "skip", "--json"]).code).toBe(0);
  expect(run(context, ["create", "Task", "DECOY item", "--id", "same", "--json"]).code).toBe(0);
  expect(run(context, ["--pm-path", TARGET, "create", "Task", "TARGET item", "--id", "same", "--json"]).code).toBe(0);
}

function targetHash(context: TempPmContext): string {
  return (JSON.parse(run(context, ["--pm-path", TARGET, "get", "pm-same", "--fields", "item_hash", "--json"]).stdout) as { item_hash: string }).item_hash;
}

describe("refusal recovery replays the caller's own invocation", () => {
  it("pm-gh1677: a stale write's recovery reads keep the caller's tracker, extension isolation and output mode", async () => {
    await withTempPmPath(async (context) => {
      seedDecoyAndTarget(context);
      const decided = targetHash(context);
      expect(run(context, ["--pm-path", TARGET, "update", "pm-same", "--description", "Peer edit", "--json"]).code).toBe(0);
      const current = targetHash(context);

      const stale = run(context, ["--no-extensions", "--pm-path", TARGET, "--expect-hash", decided, "update", "pm-same", "--title", "Stale change", "--json"]);
      expect(stale.code).toBe(EXIT_CODE.CONFLICT);
      const refusal = JSON.parse(stale.stderr) as { code: string; current_revision: string; next_steps: string[]; examples: string[]; required: string };
      expect(refusal).toMatchObject({ code: "item_revision_conflict", current_revision: current });
      const scoped = `pm --pm-path ${TARGET} --no-extensions`;
      expect(refusal.next_steps).toEqual([`${scoped} get pm-same --json`, `${scoped} history pm-same --limit 5 --json`]);
      expect(refusal.examples[0]).toBe(`${scoped} get pm-same --fields item_hash --json`);
      expect(refusal.required).toContain(`(${scoped} get pm-same --json reports item_hash)`);

      // The prescribed reads return the refused item at exactly the revision the guard found.
      const [read, history] = refusal.next_steps.map((step) => replay(context, step));
      expect(read!.code).toBe(0);
      const item = JSON.parse(read!.stdout) as { item: { title: string; description: string }; item_hash: string };
      expect(item).toMatchObject({ item: { title: "TARGET item", description: "Peer edit" }, item_hash: current });
      expect(JSON.parse(history!.stdout)).toMatchObject({ id: "pm-same", total: 2 });
      // The guard refused without writing, and never retried on its own.
      expect(targetHash(context)).toBe(current);

      // TOON callers get TOON recovery reads.
      const toon = run(context, ["--no-extensions", "--pm-path", TARGET, "--expect-hash", decided, "update", "pm-same", "--title", "Stale change"]);
      expect(toon.code).toBe(EXIT_CODE.CONFLICT);
      expect(toon.stderr).toContain(`  - ${scoped} get pm-same\n  - ${scoped} history pm-same --limit 5\n`);
      expect(replay(context, `${scoped} get pm-same`).stdout).toContain(`item_hash: "${current}"`);
    });
  });

  it("pm-gh1677: a whitespace-only typed tracker defers to the environment, so the recovery reads name the tracker the refused write used", async () => {
    await withTempPmPath(async (context) => {
      seedDecoyAndTarget(context);
      // PM_PATH selects the temp tracker; the caller runs inside the target workspace and types a blank tracker,
      // which tracker resolution trims and defers to PM_PATH.
      const inTarget = { cwd: path.join(context.tempRoot, "target"), preserveDefaultMutationOutput: true };
      const environmentTracker = path.join("..", ".agents", "pm");
      const envHash = () => (JSON.parse(run(context, ["get", "pm-same", "--fields", "item_hash", "--json"]).stdout) as { item_hash: string }).item_hash;
      const decided = envHash();
      expect(run(context, ["update", "pm-same", "--description", "Peer edit", "--json"]).code).toBe(0);
      const current = envHash();
      for (const blank of [["--pm-path", " "], ["--pm-path=  "]]) {
        const stale = await context.runCliInProcess([...blank, "--expect-hash", decided, "update", "pm-same", "--title", "Stale change", "--json"], inTarget);
        expect(stale.code).toBe(EXIT_CODE.CONFLICT);
        const refusal = JSON.parse(stale.stderr) as { current_revision: string; next_steps: string[] };
        // Negative control: before the fix the reads named the blank value, so replaying them without PM_PATH read the target tracker.
        expect(refusal).toMatchObject({ current_revision: current });
        expect(refusal.next_steps).toEqual([`pm --pm-path ${environmentTracker} get pm-same --json`, `pm --pm-path ${environmentTracker} history pm-same --limit 5 --json`]);
        const read = await context.runCliInProcess(refusal.next_steps[0]!.split(" ").slice(1), inTarget);
        expect(JSON.parse(read.stdout)).toMatchObject({ item: { title: "DECOY item", description: "Peer edit" }, item_hash: current });
      }
    });
  });

  it("pm-gh1676: a retry names the environment-selected tracker, decided by the parsed options, not by a literal operand", async () => {
    await withTempPmPath(async (context) => {
      seedDecoyAndTarget(context);
      // PM_PATH selects the temp tracker while the process runs inside the target workspace.
      const refused = context.runCli(["close", "pm-same", "--validate-close", "strict", "--json", "--", "--pm-path=literal-reason"], { cwd: path.join(context.tempRoot, "target"), preserveDefaultMutationOutput: true });
      expect(refused.code).toBe(EXIT_CODE.USAGE);
      const refusal = JSON.parse(refused.stderr) as { recovery: { suggested_retry_args: string[] } };
      expect(refusal.recovery.suggested_retry_args).toEqual(["--pm-path", path.join("..", ".agents", "pm"), "close", "--resolution", "<value>", "--expected-result", "<value>", "--actual-result", "<value>", "pm-same", "--validate-close", "strict", "--json", "--", "--pm-path=literal-reason"]);
    });
  });

  it("pm-gh1676: proposes no retry when a typed empty tracker option would override the environment's tracker", async () => {
    await withTempPmPath(async (context) => {
      seedDecoyAndTarget(context);
      const inTarget = { cwd: path.join(context.tempRoot, "target"), preserveDefaultMutationOutput: true };
      const scoped = await context.runCliInProcess(["close", "pm-same", "Done", "--validate-close", "strict", "--json"], inTarget);
      expect((JSON.parse(scoped.stderr) as { recovery: { suggested_retry_args: string[] } }).recovery.suggested_retry_args.slice(0, 3)).toEqual(["--pm-path", path.join("..", ".agents", "pm"), "close"]);
      // The parser keeps an empty --pm-path as its last value, so a prepended tracker would not bind.
      // The final value decides, including an empty one typed after a non-empty tracker.
      // A whitespace-only value resolves like an empty one (tracker resolution trims it), so it is blank too.
      for (const empty of [["--pm-path", ""], ["--pm-path="], ["--pm-path", ".agents/pm", "--pm-path="], ["--pm-path", " "], ["--pm-path=  "]]) {
        const refused = await context.runCliInProcess([...empty, "close", "pm-same", "Done", "--validate-close", "strict", "--json"], inTarget);
        expect(refused.code).toBe(EXIT_CODE.USAGE);
        const recovery = (JSON.parse(refused.stderr) as { recovery: Record<string, unknown> }).recovery;
        expect(recovery.suggested_retry_args).toBeUndefined();
        expect(recovery.missing).toEqual(["--resolution", "--expected-result", "--actual-result"]);
      }
    });
  });

  it("pm-gh1676: a command that cannot accept the missing close fields gets no invented retry", async () => {
    await withTempPmPath(async (context) => {
      seedDecoyAndTarget(context);
      // close-task accepts --validate-close but none of the evidence flags.
      const refused = await context.runCliInProcess(["--pm-path", TARGET, "close-task", "pm-same", "Done", "--validate-close", "strict", "--json"], { cwd: context.tempRoot, preserveDefaultMutationOutput: true });
      expect(refused.code).toBe(EXIT_CODE.USAGE);
      const refusal = JSON.parse(refused.stderr) as { code: string; recovery: Record<string, unknown> };
      expect(refusal.code).toBe("close_validation_missing_fields");
      // Message-text inference must not rebuild a retry the typed producer withdrew.
      expect(refusal.recovery.suggested_retry).toBeUndefined();
      expect(refusal.recovery.suggested_retry_args).toBeUndefined();
      expect(refusal.recovery).toMatchObject({ missing: ["--resolution", "--expected-result", "--actual-result"], next_best_command: expect.stringContaining(" update pm-same ") });
      // The guidance stays truthful without a retry: record the evidence, then repeat the original command.
      const guidance = JSON.parse(refused.stderr) as { required: string; next_steps: string[] };
      expect(guidance.next_steps).toContain("Without it, record the evidence with recovery.next_best_command, then repeat the original close.");
      expect(guidance.required).not.toContain("this pm close");
    });
  });

  it("pm-gh1676: a strict close refused for missing close fields retries as the same close, in one write, guard included", async () => {
    await withTempPmPath(async (context) => {
      seedDecoyAndTarget(context);
      const decided = targetHash(context);
      const invocation = ["--pm-path", TARGET, "close", "pm-same", "Delivered", "-m", "audit", "--expect-hash", `pm-same=${decided}`, "--validate-close", "strict", "--resolution", "", "--json"];
      const refused = run(context, invocation);
      expect(refused.code).toBe(EXIT_CODE.USAGE);
      const refusal = JSON.parse(refused.stderr) as { code: string; next_steps: string[]; recovery: { suggested_retry_args: string[]; next_best_command: string } };
      expect(refusal.code).toBe("close_validation_missing_fields");
      // Every typed token survives, short options and the revision guard included; the appended
      // --resolution overrides the blank one because the parser keeps the last value. The producer's
      // guard repeats the typed one at the same revision, which the binder accepts.
      expect(refusal.recovery.suggested_retry_args).toEqual([...invocation, "--resolution", "<value>", "--expected-result", "<value>", "--actual-result", "<value>", `--expect-hash=pm-same=${decided}`]);
      expect(refusal.next_steps[0]).toContain("Run recovery.suggested_retry when it is present");
      expect(refusal.recovery.next_best_command).toContain(" update pm-same ");
      const retry = refusal.recovery.suggested_retry_args.map((token) => (token === "<value>" ? "Recorded at close" : token));

      // The carried guard still protects the retry: a peer edit after the refusal makes it refuse.
      expect(run(context, ["--pm-path", TARGET, "update", "pm-same", "--description", "Peer edit", "--json"]).code).toBe(0);
      expect(run(context, retry).code).toBe(EXIT_CODE.CONFLICT);

      const current = targetHash(context);
      const fresh = retry.map((token) => token.replace(`pm-same=${decided}`, `pm-same=${current}`));
      const closed = run(context, fresh);
      expect(closed.code, closed.stderr).toBe(0);
      const history = JSON.parse(run(context, ["--pm-path", TARGET, "history", "pm-same", "--json"]).stdout) as { total: number; compact_history: Array<{ op: string }> };
      // One write closes: the evidence and the closure share the close entry after the peer's update.
      expect(history.total).toBe(3);
      expect(history.compact_history.map((entry) => entry.op).sort()).toEqual(["close", "create", "update"]);
      const item = JSON.parse(run(context, ["--pm-path", TARGET, "get", "pm-same", "--json"]).stdout) as { item: Record<string, unknown> };
      expect(item.item).toMatchObject({ status: "closed", resolution: "Recorded at close", expected_result: "Recorded at close", actual_result: "Recorded at close" });
    });
  });
});
