/**
 * End-to-end delivered-output budget contract: GH-1678 (custom renderers),
 * GH-1662 (one budget contract for intent reads) and pm-sj66lm (TOON explicit
 * selection), driven through the real CLI against a sandbox tracker.
 */
import { describe, expect, it } from "vitest";
import { PmClient } from "../../../src/sdk/runtime.js";
import {
  isReadOutputBudgetExceeded,
  isReadResultOmittedForBudget,
} from "../../../src/sdk/read-output-contracts.js";
import { runPmCli } from "../../../src/cli/main.js";
import { runInProcessDistCli } from "../../helpers/cliRunner.js";
import { writeTestExtension } from "../../helpers/extensions.js";
import { createTestItemId } from "../../helpers/itemFactory.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

const tokensOf = (text: string): number => Math.ceil(Buffer.byteLength(text, "utf8") / 4);
/** Timestamps differ between two otherwise identical reads. */
const withoutTimestamps = (text: string): string => text.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/gu, "<ts>");
const omitted = (stdout: string): boolean => /budget_exceeded/u.test(stdout);
/** Run the CLI from source in-process, so the delivery paths count toward source coverage. */
const runSource = (context: { env: NodeJS.ProcessEnv }, args: string[]) =>
  runInProcessDistCli(args, { env: context.env }, runPmCli);

describe("GH-1678 scoped renderer output obeys the caller's output budget", () => {
  it("measures the delivered string, refuses natively when it cannot fit, and keeps unbounded rendering", async () => {
    await withTempPmPath(async (context) => {
      await writeTestExtension({
        root: context.pmPath,
        placement: "projectRoot",
        directory: "budget-demo",
        entryFilename: "index.mjs",
        manifest: { name: "budget-demo", version: "1.0.0", entry: "./index.mjs", capabilities: ["commands", "renderers"] },
        entrySource: `export default { activate(api) {
  api.registerCommand({ name: 'budget-demo rows', read_output: { row_keys: ['items'] }, run: () => ({ items: [{ id: 'row-1', title: 'Sample' }], count: 1, total: 1 }) });
  api.registerCommand({ name: 'budget-demo artifact', run: () => ({ kind: 'artifact' }) });
  api.registerRenderer('toon', (ctx) => 'detail: ' + 'x'.repeat(10000) + '\\n' + JSON.stringify(ctx.result), { commands: ['budget-demo rows', 'budget-demo artifact'] });
} };`,
      });
      const run = (args: string[]) => runSource(context, ["budget-demo", ...args]);
      for (const budget of ["400", "1"]) {
        const refused = await run(["rows", "--output-budget", budget, "--output-row-contract"]);
        expect(refused.code).toBe(2);
        expect(refused.stdout).toContain("output_budget_exceeded:");
        // The refusal is rendered natively, never expanded through the renderer.
        expect(refused.stdout).not.toContain("detail: ");
        expect(tokensOf(refused.stdout)).toBeLessThanOrEqual(400);
      }
      const fitting = await run(["rows", "--output-budget", "3000", "--output-row-contract"]);
      expect(fitting.code, fitting.stderr).toBe(0);
      const receipt = (JSON.parse(fitting.stdout.trim().split("\n").at(-1)!) as { read_output: Record<string, unknown> }).read_output;
      // Negative control: the native-payload estimate the defect reported was 179 tokens.
      expect(receipt).toMatchObject({ estimated_tokens: tokensOf(fitting.stdout), within_budget: true });
      // An undeclared command's renderer is untouched (it refuses read controls, so it takes none).
      for (const args of [["rows", "--output-budget", "unbounded"], ["rows"], ["artifact"]]) {
        const delivered = await run(args);
        expect(delivered.code, `${args.join(" ")}: ${delivered.stderr}`).toBe(0);
        expect(delivered.stdout.startsWith("detail: ")).toBe(true);
      }
      const json = await run(["rows", "--output-budget", "400", "--output-row-contract", "--json"]);
      expect(JSON.parse(json.stdout)).toMatchObject({ items: [{ id: "row-1" }], read_output: { estimated_tokens: tokensOf(json.stdout) } });
    });
  });
});

describe("GH-1662 one budget contract for intent reads", () => {
  it("gives --token-budget and --output-budget the same outcome in JSON and TOON, and fails every omission", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "Budget contract target", description: "A claimed task with evidence" });
      expect(context.runCli(["claim", id]).code).toBe(0);
      const outcomes = new Set<boolean>();
      for (const budget of ["300", "600", "900", "3000"]) {
        for (const format of [[], ["--json"]]) {
          const legacy = await runSource(context, ["context", "--for", "orient", "--token-budget", budget, ...format]);
          const canonical = await runSource(context, ["context", "--for", "orient", "--output-budget", budget, ...format]);
          const label = `${budget} ${format.join(" ") || "toon"}`;
          expect(canonical.code, label).toBe(legacy.code);
          expect(omitted(canonical.stdout), label).toBe(omitted(legacy.stdout));
          // An omitted required result is unsuccessful; a delivered one succeeds and fits.
          expect(legacy.code, label).toBe(omitted(legacy.stdout) ? 2 : 0);
          if (!omitted(legacy.stdout)) {
            expect(withoutTimestamps(canonical.stdout), label).toBe(withoutTimestamps(legacy.stdout));
            expect(tokensOf(legacy.stdout), label).toBeLessThanOrEqual(Number(budget));
          }
          outcomes.add(omitted(legacy.stdout));
        }
      }
      expect([...outcomes].sort()).toEqual([false, true]);

      // Find the intent omission (the receipt envelope fits, the result does not) and check every receipt and the retry.
      let intentOmission: { stdout: string } | undefined;
      for (let budget = 300; budget <= 3000 && intentOmission === undefined; budget += 50) {
        const read = await runSource(context, ["context", "--for", "orient", "--token-budget", String(budget), "--json"]);
        if (read.stdout.includes('"budget_exceeded"') && !read.stdout.includes('"output_budget_exceeded"')) intentOmission = read;
      }
      const envelope = JSON.parse(intentOmission!.stdout) as Record<string, Record<string, unknown>>;
      expect(envelope.context_intent).toMatchObject({ result_omitted: true, within_budget: false });
      expect(envelope.read_output).toMatchObject({ result_omitted: true, within_budget: false });
      const restore = String(envelope.budget_exceeded!.restore_with).split(" ").slice(1);
      const retried = await runSource(context, [...restore, "--json"]);
      expect(retried.code, retried.stderr).toBe(0);
      expect(omitted(retried.stdout)).toBe(false);

      // An explicitly unbounded canonical read keeps its result.
      const unbounded = await runSource(context, ["context", "--for", "orient", "--output-budget", "unbounded", "--json"]);
      expect(unbounded.code).toBe(0);
      expect(omitted(unbounded.stdout)).toBe(false);

      // SDK consumers detect both branches.
      const client = new PmClient({ pmRoot: context.pmPath });
      expect(isReadResultOmittedForBudget(await client.context({ for: "orient", tokenBudget: "256" }))).toBe(true);
      expect(isReadOutputBudgetExceeded(await client.context({ for: "orient", outputBudget: "256" }))).toBe(true);
    });
  });

  it("estimates get and list intent receipts over the complete emitted envelope", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "Estimate target", description: "d".repeat(400) });
      createTestItemId(context, { title: "Second row" });
      for (const args of [["get", id, "--for", "inspect"], ["list", "--for", "triage", "--limit", "2"]]) {
        for (const budget of ["500", "3000"]) {
          for (const flag of ["--token-budget", "--output-budget"]) {
            const read = await runSource(context, [...args, flag, budget, "--json"]);
            const label = `${args[0]} ${flag} ${budget}`;
            const receipt = (JSON.parse(read.stdout) as { context_intent: { estimated_tokens: number; within_budget: boolean; result_omitted: boolean } }).context_intent;
            expect(receipt.estimated_tokens, label).toBeGreaterThanOrEqual(tokensOf(read.stdout));
            if (receipt.within_budget) expect(tokensOf(read.stdout), label).toBeLessThanOrEqual(Number(budget));
            expect(read.code, label).toBe(receipt.result_omitted ? 2 : 0);
          }
        }
      }
    });
  });
});

describe("pm-sj66lm TOON get --fields", () => {
  it("renders requested empty collections and a one-line complete receipt, keeping JSON typed", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "Sample task for budget repro" });
      const toon = await runSource(context, ["get", id, "--fields", "id,title,comments"]);
      expect(toon.code, toon.stderr).toBe(0);
      expect(toon.stdout).toBe(`item:\n  id: "${id}"\n  title: "Sample task for budget repro"\n  comments: []\nomission_receipt: complete\n`);
      const json = JSON.parse((await runSource(context, ["get", id, "--fields", "id,title,comments", "--json"])).stdout) as Record<string, unknown>;
      expect(json).toEqual({ item: { id, title: "Sample task for budget repro", comments: [] }, omission_receipt: { has_omissions: false, omitted_field_group_count: 0, omitted_field_groups: [] } });
      // A default read that omits groups keeps its full receipt in TOON.
      expect((await runSource(context, ["get", id])).stdout).toContain("has_omissions: true");
    });
  });
});
