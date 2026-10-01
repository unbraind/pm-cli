import { cp, mkdir, readFile, symlink } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

interface ReadPage {
  items?: { id: string }[];
  low_level?: { id: string }[];
  high_level?: { id: string }[];
  summary?: { returned_focus: { active_items: number; in_progress: number; open: number } };
  count?: number;
  total?: number;
  has_more?: boolean;
  next_cursor?: string;
  output_budget_truncation?: { recovery?: { cursor?: string } };
}

type RunRead = (args: string[]) => Promise<{ code: number | null; json?: unknown; stderr: string }>;

/** Replay an advertised output cursor before advancing the enclosing producer page. */
function continuationArgs(base: string[], after: string | undefined, outputCursor: string | undefined): string[] {
  return [...base, ...(after ? ["--after", after] : []), ...(outputCursor ? ["--output-cursor", outputCursor] : [])];
}

/** Check delivered-row counters independently of total query matches. */
function verifyDeliveredCounts(page: ReadPage): void {
  if (page.items && page.count !== undefined) expect(page.count).toBe(page.items.length);
  if (page.summary) {
    const rows = (page.low_level?.length ?? 0) + (page.high_level?.length ?? 0);
    expect(page.summary.returned_focus).toMatchObject({ active_items: rows, in_progress: rows, open: 0 });
  }
}

/** Traverse both advertised cursor layers and reject loops or duplicate delivered rows. */
async function collectReadPages(run: RunRead, base: string[]): Promise<{ ids: string[]; hierarchy: Set<string>; producerCursor: string }> {
  const ids: string[] = [];
  const hierarchy = new Set<string>();
  let after: string | undefined;
  let outputCursor: string | undefined;
  let transitions = 0;
  let budgetContinuations = 0;
  let producerCursor = "";
  let pages = 0;
  do {
    const response = await run(continuationArgs(base, after, outputCursor));
    expect(response.code, `${base.join(" ")}: ${response.stderr}`).toBe(0);
    const page = response.json as ReadPage;
    const rows = page.items ?? page.low_level ?? [];
    ids.push(...rows.map((row) => row.id));
    for (const row of page.high_level ?? []) hierarchy.add(row.id);
    verifyDeliveredCounts(page);
    const nextOutput = page.output_budget_truncation?.recovery?.cursor;
    outputCursor = nextOutput;
    if (nextOutput) budgetContinuations += 1;
    if (!nextOutput) {
      after = page.has_more ? page.next_cursor : undefined;
      if (after) { transitions += 1; producerCursor = after; }
    }
    pages += 1;
    expect(pages).toBeLessThan(30);
  } while (outputCursor || after);
  expect(transitions).toBeGreaterThan(0);
  expect(budgetContinuations, base.join(" ")).toBeGreaterThan(0);
  expect(new Set(ids).size).toBe(ids.length);
  return { ids, hierarchy, producerCursor };
}

describe("composed producer and budget continuation (GH-1371)", () => {
  it("finishes list, search and hierarchical context reads using advertised serialized cursors", async () => {
    await withTempPmPath(async (context) => {
      const run = (args: string[]) => context.runCliInProcess(args, { expectJson: true });
      const otherTracker = `${context.tempRoot}/other-tracker`;
      const emptyTracker = `${context.tempRoot}/empty-tracker`;
      expect((await run(["init", otherTracker, "--defaults", "--agent-guidance", "skip", "--json"])).code).toBe(0);
      expect((await run(["init", emptyTracker, "--defaults", "--agent-guidance", "skip", "--json"])).code).toBe(0);
      for (let index = 0; index < 30; index += 1) {
        const created = await run(["create", "task", `Matrix work ${index}`, "--id", `matrix-long-projected-continuation-row-to-require-id-only-budget-truncation-${index}`, "--description", "Execution evidence ".repeat(150), "--tags", "matrix,alternate", "--status", "in_progress", ...(index === 29 ? ["--parent", "pm-matrix-long-projected-continuation-row-to-require-id-only-budget-truncation-28"] : []), "--json"]);
        expect(created.code).toBe(0);
      }
      for (let index = 0; index < 4; index += 1) expect((await run(["close", `pm-matrix-long-projected-continuation-row-to-require-id-only-budget-truncation-${index}`, "Fixture closure", "--json"])).code).toBe(0);
      await cp(context.pmPath, otherTracker, { recursive: true });
      for (const query of [
        ["list", "--all", "--limit", "25", "--output-budget", "1700"],
        ["search", "Matrix", "--mode", "keyword", "--status", "all", "--limit", "25", "--output-budget", "1500"],
        ["context", "--limit", "25", "--output-budget", "1500"],
        ["context", "--fields", "id", "--limit", "25", "--output-budget", "1300"],
      ]) {
        const base = ["--pm-path", context.pmPath, "--json", ...query, "--tag", "matrix"];
        const { ids, hierarchy, producerCursor } = await collectReadPages(run, base);
        expect(new Set([...ids, ...hierarchy]).size).toBe(query[0] === "context" ? 26 : 30);
        const changedFilter = [...base]; changedFilter[changedFilter.lastIndexOf("matrix")] = "alternate";
        const filterRefusal = await run([...changedFilter, "--after", producerCursor]);
        expect(filterRefusal.code).toBe(2);
        expect(JSON.parse(filterRefusal.stderr)).toMatchObject({ code: "invalid_query_cursor" });
        const changedScope = [...base]; changedScope[1] = otherTracker;
        const scopeRefusal = await run([...changedScope, "--after", producerCursor]);
        expect(scopeRefusal.code).toBe(2);
        expect(JSON.parse(scopeRefusal.stderr)).toMatchObject({ code: "invalid_query_cursor" });
        changedFilter[changedFilter.lastIndexOf("alternate")] = "nonexistent";
        const emptyFilterRefusal = await run([...changedFilter, "--after", producerCursor]);
        expect(emptyFilterRefusal.code).toBe(2);
        expect(JSON.parse(emptyFilterRefusal.stderr)).toMatchObject({ code: "invalid_query_cursor" });
        changedScope[1] = emptyTracker;
        const emptyScopeRefusal = await run([...changedScope, "--after", producerCursor]);
        expect(emptyScopeRefusal.code).toBe(2);
        expect(JSON.parse(emptyScopeRefusal.stderr)).toMatchObject({ code: "invalid_query_cursor" });
      }
      // Load the actual tarball public export in a separate Node consumer; the
      // dependency link supplies installed dependencies without source imports.
      const repository = fileURLToPath(new URL("../../../", import.meta.url));
      const consumer = path.join(context.tempRoot, "packed-consumer");
      await mkdir(consumer);
      const packed = JSON.parse(execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", consumer], { cwd: repository, env: context.env, encoding: "utf8", shell: process.platform === "win32" }))[0] as { filename: string };
      execFileSync("tar", ["-xzf", path.join(consumer, packed.filename), "-C", consumer]);
      const packedRoot = path.join(consumer, "package");
      await mkdir(path.join(consumer, "node_modules", "@unbrained"), { recursive: true });
      await symlink(packedRoot, path.join(consumer, "node_modules", "@unbrained", "pm-cli"), "junction");
      await symlink(path.join(repository, "node_modules"), path.join(packedRoot, "node_modules"), "junction");
      const consumerScript = path.join(consumer, "consumer.mjs");
      await cp(new URL("../../fixtures/read-output/packed-continuation-consumer.mjs", import.meta.url), consumerScript);
      const manifest = JSON.parse(await readFile(path.join(packedRoot, "package.json"), "utf8")) as { exports: Record<string, unknown> };
      expect(manifest.exports["./sdk"]).toBeDefined();
      const evidence = JSON.parse(execFileSync(process.execPath, [consumerScript, context.pmPath, emptyTracker], { cwd: consumer, env: context.env, encoding: "utf8", timeout: 90_000 })) as { publicExport: string; results: { name: string; limit?: number; empty?: boolean; budgetTransitions: number }[] };
      expect(evidence.publicExport).toBe("@unbrained/pm-cli/sdk");
      expect(evidence.results).toHaveLength(9);
      expect(evidence.results.filter((result) => result.limit === 25).every((result) => result.budgetTransitions > 0)).toBe(true);
      expect(evidence.results.filter((result) => result.empty)).toHaveLength(3);
      console.log("Packed SDK continuation evidence", JSON.stringify(evidence));
    });
  });
});
