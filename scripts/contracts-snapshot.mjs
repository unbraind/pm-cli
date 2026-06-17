#!/usr/bin/env node
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const snapshotPath = resolve(repoRoot, "tests/fixtures/contracts/full.json");
const cliPath = resolve(repoRoot, "dist/cli.js");
const mode = process.argv.includes("--update") ? "update" : process.argv.includes("--check") ? "check" : null;

if (mode === null) {
  console.error("Usage: node scripts/contracts-snapshot.mjs --update|--check");
  process.exit(2);
}

if (!existsSync(cliPath)) {
  console.error("Missing dist/cli.js. Run pnpm build before checking contract snapshots.");
  process.exit(1);
}

function runContracts() {
  const isolatedGlobalPath = mkdtempSync(resolve(tmpdir(), "pm-cli-contracts-global-"));
  let result;
  try {
    result = spawnSync(process.execPath, [cliPath, "contracts", "--full", "--json"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        NO_COLOR: "1",
        PM_GLOBAL_PATH: isolatedGlobalPath,
      },
      maxBuffer: 50 * 1024 * 1024,
    });
  } finally {
    rmSync(isolatedGlobalPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
  if (result.error !== undefined) {
    throw new Error(`pm contracts --full --json failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    process.stderr.write(result.stderr ?? "");
    process.stderr.write(result.stdout ?? "");
    throw new Error(`pm contracts --full --json failed with exit code ${result.status ?? "unknown"}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    /* c8 ignore next -- JSON.parse only throws SyntaxError (an Error); String(error) fallback is unreachable */
    throw new Error(`pm contracts produced invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function stableValue(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => stableValue(entry));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return value;
}

function stableJson(value) {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

function firstDiffLine(left, right) {
  const leftLines = left.split("\n");
  const rightLines = right.split("\n");
  const max = Math.max(leftLines.length, rightLines.length);
  for (let index = 0; index < max; index += 1) {
    if (leftLines[index] !== rightLines[index]) {
      return index + 1;
    }
  }
  /* c8 ignore next -- only reached if the two strings are equal, but firstDiffLine is only called when current !== next */
  return 0;
}

const next = stableJson(runContracts());

if (mode === "update") {
  await mkdir(dirname(snapshotPath), { recursive: true });
  await writeFile(snapshotPath, next, "utf8");
  console.log(`Updated ${snapshotPath}`);
  process.exit(0);
}

let current;
try {
  current = await readFile(snapshotPath, "utf8");
} catch (error) {
  console.error(`Missing contracts snapshot at ${snapshotPath}. Run pnpm contracts:update.`);
  process.exit(1);
}

if (current !== next) {
  const line = firstDiffLine(current, next);
  console.error(`Contract snapshot is stale at ${snapshotPath} (first differing line ${line}).`);
  console.error("Run pnpm contracts:update and include the generated diff with an intentional changelog entry.");
  process.exit(1);
}

console.log(`Contract snapshot is current: ${snapshotPath}`);
