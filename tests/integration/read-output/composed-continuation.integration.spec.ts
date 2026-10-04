import { cp, glob, lstat, mkdir, readFile, readdir, symlink } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

interface ReadPage {
  items?: { id: string }[];
  low_level?: { id: string }[];
  high_level?: { id: string }[];
  blocked_fallback?: { id: string }[];
  summary?: { blocked: number; returned_focus: { active_items: number; in_progress: number; open: number; blocked: number } };
  count?: number;
  total?: number;
  has_more?: boolean;
  next_cursor?: string;
  output_budget_truncation?: { continuations: { cursor: string; path: string }[]; recovery?: { cursor?: string; sdk?: { outputBudget?: number }; cli?: string } };
}

type RunRead = (args: string[]) => Promise<{ code: number | null; json?: unknown; stderr: string }>;

/** Check delivered-row counters independently of total query matches. */
function verifyDeliveredCounts(page: ReadPage, blocked = false): { section: string; id: string }[] {
  const sections = page.items ? { items: page.items } : {
    high_level: page.high_level ?? [], low_level: page.low_level ?? [], blocked_fallback: page.blocked_fallback ?? [],
  };
  const delivered = Object.entries(sections).flatMap(([section, rows]) => rows.map(({ id }) => ({ section, id })));
  if (page.items && page.count !== undefined) expect(page.count).toBe(page.items.length);
  if (page.summary) {
    expect(page.summary.returned_focus).toEqual({
      active_items: delivered.length, in_progress: blocked ? 0 : delivered.length,
      open: blocked ? delivered.length : 0, blocked: blocked ? delivered.length : 0,
    });
  }
  expect(new Set(delivered.map(({ id }) => id)).size).toBe(delivered.length);
  return delivered;
}

/** Preserve resumed collection duplicates as failures, allowing only companion repeats within one producer page. */
function appendProducerRows(rows: { section: string; id: string }[], continuedSection: string | undefined, producerRows: Set<string>, ids: string[]): number {
  let companions = 0;
  for (const row of rows) {
    if (continuedSection && row.section !== continuedSection && producerRows.has(row.id)) companions += 1;
    else ids.push(row.id);
    producerRows.add(row.id);
  }
  return companions;
}

/** Traverse both advertised cursor layers and reject loops or duplicate delivered rows. */
async function collectReadPages(run: RunRead, base: string[], blocked = false): Promise<{ ids: string[]; producerCursor: string; transitions: number; budgetContinuations: number; companionRows: number }> {
  const ids: string[] = [];
  const producerRows = new Set<string>();
  let after: string | undefined;
  let outputCursor: string | undefined;
  let continuedSection: string | undefined;
  let transitions = 0;
  let budgetContinuations = 0;
  let companionRows = 0;
  let producerCursor = "";
  let pages = 0;
  do {
    if (!outputCursor) producerRows.clear();
    const response = await run([...base, ...(after ? ["--after", after] : []), ...(outputCursor ? ["--output-cursor", outputCursor] : [])]);
    expect(response.code, `${base.join(" ")}: ${response.stderr}`).toBe(0);
    const page = response.json as ReadPage;
    companionRows += appendProducerRows(verifyDeliveredCounts(page, blocked), outputCursor ? continuedSection : undefined, producerRows, ids);
    outputCursor = page.output_budget_truncation?.recovery?.cursor;
    if (outputCursor) {
      continuedSection = page.output_budget_truncation!.continuations.find(({ cursor }) => cursor === outputCursor)?.path;
      expect(continuedSection, "Advertised recovery must identify its resumed collection").toBeDefined();
      budgetContinuations += 1;
    } else {
      after = page.has_more ? page.next_cursor : undefined;
      transitions += Number(Boolean(after));
      producerCursor = after ?? producerCursor;
    }
    pages += 1;
    expect(pages).toBeLessThan(30);
  } while (outputCursor || after);
  expect(new Set(ids).size).toBe(ids.length);
  return { ids, producerCursor, transitions, budgetContinuations, companionRows };
}

/** Stage the actual publish selectors and unchanged manifest without traversing development dependencies before real npm packing. */
async function stagePublishSources(repository: string, destination: string): Promise<{ files: string[] }> {
  const manifest = JSON.parse(await readFile(path.join(repository, "package.json"), "utf8")) as { files: string[] };
  await mkdir(destination);
  for await (const relative of glob(
    ["package.json", ...manifest.files.filter((selector) => !selector.startsWith("!"))],
    { cwd: repository, exclude: ["**/node_modules/**", ...manifest.files.filter((selector) => selector.startsWith("!")).map((selector) => selector.slice(1))] },
  )) {
    const source = path.join(repository, relative);
    if (!(await lstat(source)).isFile()) continue;
    const target = path.join(destination, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(source, target);
  }
  expect(await readdir(destination)).not.toContain("node_modules");
  return manifest;
}

describe("composed producer and budget continuation (GH-1371)", () => {
  it("finishes list, search and hierarchical context reads using advertised serialized cursors", { timeout: 120_000 }, async () => {
    await withTempPmPath(async (context) => {
      const run = (args: string[]) => context.runCliInProcess(args, { expectJson: true });
      const otherTracker = `${context.tempRoot}/other-tracker`;
      const emptyTracker = `${context.tempRoot}/empty-tracker`;
      const blockedTracker = `${context.tempRoot}/blocked-tracker`;
      expect((await run(["init", otherTracker, "--defaults", "--agent-guidance", "skip", "--json"])).code).toBe(0);
      expect((await run(["init", emptyTracker, "--defaults", "--agent-guidance", "skip", "--json"])).code).toBe(0);
      expect((await run(["init", blockedTracker, "--defaults", "--agent-guidance", "skip", "--json"])).code).toBe(0);
      for (let index = 0; index < 30; index += 1) {
        const created = await run(["create", "task", `Matrix work ${index}`, "--id", `matrix-long-projected-continuation-row-to-require-id-only-budget-truncation-${index}`, "--description", "Execution evidence ".repeat(150), "--tags", "matrix,alternate", "--status", "in_progress", ...(index === 29 ? ["--parent", "pm-matrix-long-projected-continuation-row-to-require-id-only-budget-truncation-28"] : []), "--json"]);
        expect(created.code).toBe(0);
      }
      for (let index = 0; index < 4; index += 1) expect((await run(["close", `pm-matrix-long-projected-continuation-row-to-require-id-only-budget-truncation-${index}`, "Fixture closure", "--json"])).code).toBe(0);
      for (let index = 0; index < 12; index += 1) expect((await run(["--pm-path", blockedTracker, "create", "task", `Blocked matrix work ${index}`, "--id", `blocked-matrix-long-projected-continuation-row-for-budget-pagination-${index}`, "--description", "Blocked execution evidence ".repeat(150), "--tags", "blocked-matrix", "--status", "blocked", "--json"])).code).toBe(0);
      await cp(context.pmPath, otherTracker, { recursive: true });
      for (const query of [
        ["list", "--all", "--limit", "25", "--output-budget", "1700"],
        ["search", "Matrix", "--mode", "keyword", "--status", "all", "--limit", "25", "--output-budget", "1500"],
        ["context", "--limit", "25", "--output-budget", "1500"],
        ["context", "--fields", "id", "--limit", "25", "--output-budget", "1300"],
      ]) {
        const base = ["--pm-path", context.pmPath, "--json", ...query, "--tag", "matrix"];
        const { ids, producerCursor, transitions, budgetContinuations, companionRows } = await collectReadPages(run, base);
        expect(ids).toHaveLength(query[0] === "context" ? 26 : 30);
        expect(transitions).toBeGreaterThan(0);
        expect(budgetContinuations, base.join(" ")).toBeGreaterThan(0);
        if (query[0] === "context") expect(companionRows).toBeGreaterThan(0);
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
      const blockedBase = ["--pm-path", blockedTracker, "--json", "context", "--limit", "12", "--token-budget", "100000", "--tag", "blocked-matrix"];
      const blockedComplete = await collectReadPages(run, [...blockedBase, "--output-budget", "2000"], true);
      expect(blockedComplete.ids).toHaveLength(12);
      const boundedBlocked = await run([...blockedBase, "--output-row-contract", "--output-budget", "1500"]);
      expect(boundedBlocked.code).toBe(0);
      const boundedPage = boundedBlocked.json as ReadPage;
      const boundedRows = verifyDeliveredCounts(boundedPage, true);
      expect(boundedRows.length).toBeGreaterThan(0);
      expect(boundedRows.length).toBeLessThan(12);
      expect(boundedPage.summary?.blocked).toBe(12);
      const recoveryBudget = boundedPage.output_budget_truncation?.recovery?.sdk?.outputBudget;
      expect(recoveryBudget).toBeGreaterThan(1500);
      expect(boundedPage.output_budget_truncation?.recovery?.cli).toBe(`--output-budget ${recoveryBudget}`);
      const blockedRecovery = await collectReadPages(run, [...blockedBase, "--output-budget", String(recoveryBudget)], true);
      expect(blockedRecovery.ids).toHaveLength(12);
      // Load the actual tarball public export in a separate Node consumer; the
      // dependency link keeps this cursor/export test network-free. The required
      // smoke:npx gate separately installs production dependencies in a fresh consumer.
      const repository = fileURLToPath(new URL("../../../", import.meta.url));
      const consumer = path.join(context.tempRoot, "packed-consumer");
      await mkdir(consumer);
      // Preserve the actual publish selectors while avoiding npm's traversal of
      // the checkout's development dependency tree. This remains a real npm
      // tarball and public export test, with the original process timeout.
      const packSource = path.join(context.tempRoot, "publish-source");
      const sourceManifest = await stagePublishSources(repository, packSource);
      // Invoke npm's Node entry directly so the timeout kills the pack process,
      // including on Windows where a cmd shell would leave its child running.
      let npmPackage: string;
      try {
        npmPackage = createRequire(import.meta.url).resolve("npm/package.json", { paths: [path.dirname(process.execPath), path.resolve(path.dirname(process.execPath), "../lib")] });
      } catch (cause) {
        throw new Error("Packed SDK continuation could not resolve npm/package.json. Install npm for this Node runtime or expose its package through NODE_PATH.", { cause });
      }
      const npmCli = path.join(path.dirname(npmPackage), "bin", "npm-cli.js");
      execFileSync(process.execPath, [npmCli, "pack", "--ignore-scripts", "--json", "--pack-destination", consumer], { cwd: packSource, env: context.env, encoding: "utf8", timeout: 30_000 });
      const tarballs = (await readdir(consumer)).filter((name) => name.endsWith(".tgz"));
      expect(tarballs, "npm pack must produce exactly one tarball in the fresh destination").toHaveLength(1);
      execFileSync("tar", ["-xzf", path.join(consumer, tarballs[0]!), "-C", consumer], { timeout: 10_000 });
      const packedRoot = path.join(consumer, "package");
      await mkdir(path.join(consumer, "node_modules", "@unbrained"), { recursive: true });
      await symlink(packedRoot, path.join(consumer, "node_modules", "@unbrained", "pm-cli"), "junction");
      await symlink(path.join(repository, "node_modules"), path.join(packedRoot, "node_modules"), "junction");
      const consumerScript = path.join(consumer, "consumer.mjs");
      await cp(new URL("../../fixtures/read-output/packed-continuation-consumer.mjs", import.meta.url), consumerScript);
      const manifest = JSON.parse(await readFile(path.join(packedRoot, "package.json"), "utf8")) as { exports: Record<string, unknown> };
      expect(manifest).toEqual(sourceManifest);
      expect(manifest.exports["./sdk"]).toBeDefined();
      const evidence = JSON.parse(execFileSync(process.execPath, [consumerScript, context.pmPath, emptyTracker, blockedTracker], { cwd: consumer, env: context.env, encoding: "utf8", timeout: 60_000 })) as { publicExport: string; results: { name: string; limit?: number; empty?: boolean; blocked?: boolean; recovery?: boolean; budgetTransitions: number; uniqueRows: number }[] };
      expect(evidence.publicExport).toBe("@unbrained/pm-cli/sdk");
      expect(evidence.results).toHaveLength(11);
      expect(evidence.results.filter((result) => result.limit === 25).every((result) => result.budgetTransitions > 0)).toBe(true);
      expect(evidence.results.filter((result) => result.empty)).toHaveLength(3);
      expect(evidence.results.filter((result) => result.blocked)).toHaveLength(2);
      expect(evidence.results.filter((result) => result.blocked).every((result) => result.uniqueRows === 12)).toBe(true);
      expect(evidence.results.some((result) => result.blocked && result.recovery)).toBe(true);
      console.log("Packed SDK continuation evidence", JSON.stringify(evidence));
    });
  });
});
