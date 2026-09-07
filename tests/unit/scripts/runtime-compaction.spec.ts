import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { transform } from "esbuild";
import { expect, it } from "vitest";
import { createScriptHarness } from "../../helpers/scriptModule";

const harness = createScriptHarness();

it("compacts runtime whitespace while preserving names, declarations, bundles, and original source mappings", async () => {
  const root = await harness.createTempRoot("pm-runtime-compact-");
  const dist = path.join(root, "dist");
  await mkdir(path.join(dist, "cli-bundle"), { recursive: true });
  const source =
    "/** Original documented source. */\nexport function importantName(value: number): number {\n  if (value < 0) {\n    throw new RangeError('negative');\n  }\n  const adjusted = value + 1;\n  return adjusted;\n}\n";
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
  await mod.compactRuntimeOutputs(dist);
  const compact = await readFile(runtime, "utf8");
  expect(compact).toContain("function importantName");
  expect(compact.length).toBeLessThan(emitted.code.length + 39);
  expect(await readFile(path.join(dist, "example.d.ts"), "utf8")).toBe(
    declaration,
  );
  expect(await readFile(path.join(dist, "cli-bundle", "sdk.js"), "utf8")).toBe(
    bundle,
  );
  const mapping = JSON.parse(await readFile(`${runtime}.map`, "utf8")) as {
    sources: string[];
    sourcesContent: string[];
  };
  expect(mapping.sources).toContain("original.ts");
  expect(mapping.sourcesContent).toContain(source);
  const consumer = path.join(dist, "consumer.mjs");
  await writeFile(
    consumer,
    'import { importantName } from "./example.js"; console.log(importantName.name, importantName(2));',
  );
  expect(
    execFileSync(process.execPath, [consumer], { encoding: "utf8" }).trim(),
  ).toBe("importantName 3");
  await mod.compactRuntimeOutputs(dist);
  expect(await readFile(runtime, "utf8")).toBe(compact);
});
