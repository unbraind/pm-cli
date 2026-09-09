import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

it("rejects the historical low-token table clone and accepts its shared declaration", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pm-table-clone-"));
  try {
    const fixture = JSON.parse(await readFile("tests/fixtures/quality/gh508-normalizer-table.json", "utf8")) as { source: string };
    const config = JSON.parse(await readFile(".jscpd.tables.json", "utf8")) as Record<string, unknown>;
    const manifest = JSON.parse(await readFile("package.json", "utf8")) as { scripts: Record<string, string> };
    expect(manifest.scripts["lint:duplicates"]).toContain("jscpd --config .jscpd.tables.json");
    const configPath = path.join(root, "profile.json");
    await writeFile(configPath, JSON.stringify({ ...config, path: [root], reporters: ["json"], output: root }));
    await writeFile(path.join(root, "create.ts"), fixture.source);
    const updatePath = path.join(root, "update.ts");
    const executable = createRequire(import.meta.url).resolve("jscpd/run-jscpd.js");
    for (const duplicated of [true, false]) {
      await writeFile(updatePath, duplicated ? fixture.source : 'export { normalizers } from "./create.js";\n');
      const run = spawnSync(process.execPath, [executable, "--config", configPath], { encoding: "utf8", timeout: 20_000 });
      expect(run.error, run.stderr).toBeUndefined();
      expect(run.status, run.stdout + run.stderr).toBe(duplicated ? 1 : 0);
      const report = JSON.parse(await readFile(path.join(root, "jscpd-report.json"), "utf8")) as {
        statistics: { total: { sources: number; clones: number } };
        duplicates: { lines: number; tokens: number }[];
      };
      expect(report.statistics.total.sources).toBe(duplicated ? 2 : 1);
      expect(report.statistics.total.clones).toBe(duplicated ? 1 : 0);
      if (duplicated) {
        expect(report.duplicates[0].lines).toBeGreaterThanOrEqual(28);
        expect(report.duplicates[0].tokens).toBeLessThan(114);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
