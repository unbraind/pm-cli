import { describe, expect, it } from "vitest";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

describe("advertised cursor recovery (GH-1457)", () => {
  it("exposes output continuation and executes wrong-kind recovery without losing rows", async () => {
    await withTempPmPath(async ({ runCliInProcess }) => {
      const run = (args: string[]) => runCliInProcess([...args, "--json", "--no-extensions"], { expectJson: true });
      for (let index = 0; index < 20; index += 1) {
        expect((await run(["create", "Task", `Cursor recovery ${index}`, "--id", `cursor-recovery-with-a-long-stable-identity-to-exercise-budget-continuation-${index}`, "--status", "in_progress", "--description", "long context ".repeat(80), "--create-mode", "progressive"])).code).toBe(0);
      }
      // Request wide rows explicitly so the unchanged budget must produce a cursor.
      for (const command of [["list", "--all", "--full"], ["search", "Cursor", "--mode", "keyword", "--status", "all"], ["context", "--token-budget", "100000"]]) {
        const help = await runCliInProcess([command[0], "--help"]);
        expect(help.stdout).toMatch(/^\s+--output-cursor <cursor>/mu);
        expect(help.stdout).toContain("continuation_kind");
        const base = [...command, "--limit", "100", "--output-budget", "1600"];
        const first = await run(base);
        expect(first.code).toBe(0);
        const page = first.json as { output_budget_truncation: { recovery: { cursor: string } } };
        const cursor = page.output_budget_truncation.recovery.cursor;
        expect(cursor).toBeTruthy();
        const refused = await run([...base, "--after", cursor]);
        expect(refused.code).toBe(2);
        expect(JSON.parse(refused.stderr)).toMatchObject({ code: "invalid_query_cursor", next_steps: [expect.stringContaining(`--output-cursor ${cursor}`)] });
        const continued = await run([...base, "--output-cursor", cursor]);
        expect(continued.code, continued.stderr).toBe(0);
        expect(continued.json).not.toEqual(first.json);
      }
      const complete = await run(["list", "--all", "--no-truncate", "--limit", "100"]);
      expect(complete.code).toBe(0);
      expect(complete.json).toMatchObject({ count: 20, truncated: false, has_more: false });
      const capped = await run(["list", "--all", "--no-truncate", "--limit", "5"]);
      expect(capped.json).toMatchObject({ count: 5, has_more: true });
      const explicitBudget = await run(["list", "--all", "--full", "--no-truncate", "--limit", "100", "--output-budget", "1600"]);
      expect(explicitBudget.json).toHaveProperty("output_budget_truncation");
    });
  }, 30_000);

  it("emits next_cursor whole under string compaction and diagnoses a shortened cursor (GH-1710)", async () => {
    await withTempPmPath(async ({ runCliInProcess }) => {
      const run = (args: string[]) => runCliInProcess([...args, "--json", "--no-extensions"], { expectJson: true });
      for (let index = 0; index < 8; index += 1) {
        const created = await run(["create", "Task", `${"T".repeat(2000)}${index}`, "--id", `gh1710-${index}${"a".repeat(170)}`, "--description", "d", "--create-mode", "progressive"]);
        expect(created.code, created.stderr).toBe(0);
      }
      for (const intent of [[], ["--for", "triage"]]) {
        const base = ["list", ...intent, "--output-budget", "2000", "--limit", "4"];
        const first = await run(base);
        expect(first.code, first.stderr).toBe(0);
        const page = first.json as { items: { id: string; title: string }[]; next_cursor: string; has_more: boolean };
        expect(page.has_more).toBe(true);
        expect(page.items[0]!.title).toMatch(/…\[\+1761 chars\]$/u);
        expect(page.next_cursor).not.toContain("…");
        const second = await run([...base, "--after", page.next_cursor]);
        expect(second.code, second.stderr).toBe(0);
        const ids = (second.json as { items: { id: string }[] }).items.map((item) => item.id);
        expect(ids).toHaveLength(4);
        expect(ids.filter((id) => page.items.some((item) => item.id === id))).toEqual([]);
        const shortened = await run([...base, "--after", `${page.next_cursor.slice(0, 240)}…`]);
        expect(shortened.code).toBe(2);
        expect(JSON.parse(shortened.stderr)).toMatchObject({
          code: "invalid_query_cursor",
          detail: expect.stringContaining("shortened by output compaction"),
          next_steps: [expect.stringContaining("--output-budget unbounded"), expect.stringContaining("without --after")],
        });
      }
    });
  }, 60_000);
});
