import { execFileSync } from "node:child_process";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { transform } from "esbuild";
import { expect, it } from "vitest";
import { createScriptHarness } from "../../helpers/scriptModule";

const harness = createScriptHarness();

it.each([false, true])("compacts redundant runtime syntax and private identifiers while preserving export names, behavior, declarations, bundles, and original source mappings (aliased root: %s)", async (aliased) => {
  const root = await harness.createTempRoot("pm-runtime-compact-");
  const dist = path.join(root, "dist");
  await mkdir(path.join(dist, "cli-bundle"), { recursive: true });
  const source =
    "/** Original documented source. */\nexport function importantName(value: number): number {\n  if (value < 0) {\n    throw new RangeError('negative');\n  }\n  if (false) throw new Error('unreachable fixture branch');\n  const adjusted = value + 1;\n  return adjusted;\n}\n";
  const emitted = await transform(source, {
    loader: "ts",
    sourcefile: "original.ts",
    sourcemap: "external",
    sourcesContent: true,
  });
  const runtime = path.join(dist, "example.js");
  await writeFile(
    runtime,
    `${emitted.code}\n//# sourceMappingURL=example.js.map\n`,
  );
  await writeFile(`${runtime}.map`, emitted.map);
  const declaration =
    "/** Public API documentation. */\nexport declare function importantName(value: number): number;\n";
  await writeFile(path.join(dist, "example.d.ts"), declaration);
  const bundle = "/* Immutable bundle */ export const untouched = true;\n";
  await writeFile(path.join(dist, "cli-bundle", "sdk.js"), bundle);
  await writeFile(path.join(root, "package.json"), '{"type":"module"}');
  const mod = await harness.importModule<{
    compactRuntimeOutputs: (directory: string) => Promise<void>;
  }>("scripts/finalize-build.mjs");
  const buildRoot = aliased ? path.join(root, "dist-alias") : dist;
  if (aliased) await symlink(dist, buildRoot, "junction");
  await mod.compactRuntimeOutputs(buildRoot);
  const compact = await readFile(runtime, "utf8");
  expect(compact).toMatch(/export\{\w+ as importantName\}/u);
  expect(compact).not.toContain("adjusted");
  expect(compact).not.toContain("unreachable fixture branch");
  expect(compact.length).toBeLessThan(emitted.code.length + 39);
  expect(await readFile(path.join(dist, "example.d.ts"), "utf8")).toBe(
    declaration,
  );
  expect(await readFile(path.join(dist, "cli-bundle", "sdk.js"), "utf8")).toBe(
    bundle,
  );
  const mapping = JSON.parse(await readFile(`${runtime}.map`, "utf8")) as {
    names: string[];
    sources: string[];
    sourcesContent: string[];
  };
  expect(mapping.names).toEqual(expect.arrayContaining(["importantName", "value"]));
  expect(mapping.sources).toContain("original.ts");
  expect(mapping.sourcesContent).toContain(source);
  const consumer = path.join(dist, "consumer.mjs");
  await writeFile(
    consumer,
    'import { importantName } from "./example.js"; console.log(importantName(2)); try { importantName(-1); } catch (error) { console.log(error.name, error.message); }',
  );
  expect(
    execFileSync(process.execPath, [consumer], { encoding: "utf8" }).trim(),
  ).toBe("3\nRangeError negative");
  const compactMap = await readFile(`${runtime}.map`, "utf8");
  const ledgerPath = path.join(dist, ".runtime-compaction.json");
  const ledger = await readFile(ledgerPath, "utf8");
  expect(Object.keys((JSON.parse(ledger) as { files: Record<string, string> }).files)).toEqual(["example.js"]);
  // An incremental compile leaves unchanged outputs in place: a repeated finalization must keep their bytes.
  await mod.compactRuntimeOutputs(buildRoot);
  expect(await readFile(runtime, "utf8")).toBe(compact);
  expect(await readFile(`${runtime}.map`, "utf8")).toBe(compactMap);
  expect(await readFile(ledgerPath, "utf8")).toBe(ledger);
  // A re-emitted output no longer matches its recorded digest and is compacted again.
  await writeFile(runtime, "export function importantName(value) {\n  return value + 2;\n}\n");
  await mod.compactRuntimeOutputs(buildRoot);
  expect(await readFile(runtime, "utf8")).toMatch(/^function \w\(\w\)\{return \w\+2\}export\{\w as importantName\};/u);
  // An unreadable or malformed ledger records nothing, and an empty output set still writes a ledger.
  for (const broken of ["not json", "null", '{"files":null}']) {
    await writeFile(ledgerPath, broken);
    await mod.compactRuntimeOutputs(buildRoot);
    expect(Object.keys((JSON.parse(await readFile(ledgerPath, "utf8")) as { files: Record<string, string> }).files)).toEqual(["example.js"]);
  }
  // A finalization stopped after it began overwriting modules leaves no ledger, so the next build starts from raw compiler output.
  await writeFile(path.join(dist, "broken.js"), "export const = ;\n");
  await expect(mod.compactRuntimeOutputs(buildRoot)).rejects.toThrow();
  await expect(readFile(ledgerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  const empty = path.join(root, "empty-dist");
  await mkdir(empty);
  await mod.compactRuntimeOutputs(empty);
  expect(await readFile(path.join(empty, ".runtime-compaction.json"), "utf8")).toBe('{"schema_version":1,"files":{}}\n');
});
