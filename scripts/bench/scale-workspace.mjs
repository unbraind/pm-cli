#!/usr/bin/env node

/**
 * Deterministic scale-workspace generator for pm performance benchmarks.
 *
 * Tracker: pm-mi2x. Both write modes use public `@unbrained/pm-cli/sdk`
 * serialization and history primitives. `sdk` additionally uses atomic SDK
 * writes; `direct` writes the exact same bytes in bounded concurrent batches.
 */
import { access, mkdir, readdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PmClient,
  appendHistoryEntry,
  canonicalDocument,
  createHistoryEntry,
  emptyImportedDocument,
  getHistoryPath,
  getItemPath,
  serializeItemDocument,
  writeFileAtomic,
} from "../../dist/cli-bundle/sdk.js";
import { fail, parseFlags, repoRoot } from "../release/utils.mjs";

/** Named workspace sizes used by local smoke, regression, and scale runs. */
export const SCALE_TIER_ITEMS = Object.freeze({
  smoke: 100,
  ci: 10_000,
  large: 100_000,
  million: 1_000_000,
});

const AUTHOR = "pm-scale-benchmark";
const BATCH_SIZE = 128;
const FIXTURE_MANIFEST = ".pm-scale-fixture.json";
const BASE_TIMESTAMP_MS = Date.UTC(2026, 0, 1);
const WEIGHTED_TYPES = [
  "Task",
  "Task",
  "Task",
  "Task",
  "Issue",
  "Feature",
  "Feature",
  "Chore",
  "Story",
  "Decision",
];

/** Parse a positive integer flag with a useful label-specific error. */
export function parsePositiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return parsed;
}

/** Resolve either a named scale tier or an explicit positive item count. */
export function resolveScaleItemCount(value) {
  const normalized = String(value ?? "ci").trim().toLowerCase();
  if (Object.hasOwn(SCALE_TIER_ITEMS, normalized)) {
    return SCALE_TIER_ITEMS[normalized];
  }
  return parsePositiveInteger(normalized.replaceAll("_", ""), "--items");
}

/** Return a reproducible pseudo-random number generator for a numeric seed. */
export function createSeededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

/** Format the deterministic identifier used by generated benchmark items. */
export function scaleItemId(index) {
  return `pm-s${index.toString(36).padStart(7, "0")}`;
}

function timestampFor(index) {
  return new Date(BASE_TIMESTAMP_MS + index * 1000).toISOString();
}

function statusFor(index) {
  if (index % 20 === 0) return "open";
  const bucket = index % 20;
  if (bucket < 15) return "closed";
  if (bucket < 17) return "canceled";
  if (bucket < 19) return "open";
  return index % 40 === 19 ? "in_progress" : "blocked";
}

function typeFor(index, random) {
  if (index % 20 === 0) return "Epic";
  return WEIGHTED_TYPES[Math.floor(random() * WEIGHTED_TYPES.length)];
}

function buildDependencies(index, createdAt) {
  if (index < 3 || index % 3 !== 0) return undefined;
  const dependencies = [
    {
      id: scaleItemId(index - 1),
      kind: "related",
      created_at: createdAt,
      author: AUTHOR,
    },
  ];
  if (index >= 8 && index % 11 === 0) {
    dependencies.push({
      id: scaleItemId(index - 7),
      kind: "blocks",
      created_at: createdAt,
      author: AUTHOR,
    });
  }
  return dependencies;
}

/** Build one deterministic, realistic item document for a scale fixture. */
export function buildSyntheticItemDocument(index, seed = 42) {
  const random = createSeededRandom(seed + index);
  const id = scaleItemId(index);
  const createdAt = timestampFor(index);
  const status = statusFor(index);
  const type = typeFor(index, random);
  const terminal = status === "closed" || status === "canceled";
  const parentIndex = index - (index % 20);
  return canonicalDocument({
    metadata: {
      id,
      title: `Synthetic ${type.toLowerCase()} ${index}`,
      description: `Deterministic scale fixture item ${index} for read, graph, history, and serialization benchmarks.`,
      type,
      status,
      priority: index % 5,
      tags: [
        "benchmark",
        `area:synthetic-${index % 16}`,
        `team:${index % 32}`,
      ],
      created_at: createdAt,
      updated_at: createdAt,
      author: AUTHOR,
      estimated_minutes: 15 + (index % 16) * 15,
      acceptance_criteria: `Synthetic acceptance criterion ${index}`,
      ...(index % 20 === 0 ? {} : { parent: scaleItemId(parentIndex) }),
      ...(terminal ? { closed_at: createdAt, close_reason: `Synthetic ${status} fixture` } : {}),
      ...(status === "closed"
        ? {
            resolution: "Synthetic benchmark work completed",
            expected_result: "Fixture remains queryable and valid",
            actual_result: "Fixture generated deterministically",
          }
        : {}),
      ...(status === "in_progress" ? { assignee: `agent-${index % 64}` } : {}),
      ...(status === "blocked"
        ? {
            blocked_by: scaleItemId(Math.max(0, index - 1)),
            blocked_reason: "Synthetic dependency wait",
          }
        : {}),
      ...(buildDependencies(index, createdAt) === undefined
        ? {}
        : { dependencies: buildDependencies(index, createdAt) }),
      ...(index % 13 === 0
        ? {
            comments: [
              {
                created_at: createdAt,
                author: AUTHOR,
                text: `Synthetic evidence comment ${index}`,
              },
            ],
          }
        : {}),
      ...(index % 29 === 0
        ? {
            notes: [
              {
                created_at: createdAt,
                author: AUTHOR,
                text: `Private synthetic context note ${index}`,
              },
            ],
          }
        : {}),
      ...(index % 31 === 0
        ? {
            learnings: [
              {
                created_at: createdAt,
                author: AUTHOR,
                text: `Durable synthetic learning ${index}`,
              },
            ],
          }
        : {}),
    },
    body: [
      `## Synthetic context ${index}`,
      "",
      `This seeded body represents project knowledge for item ${id}.`,
      `Signal bucket: ${Math.floor(random() * 1000)}.`,
    ].join("\n"),
  });
}

async function pathExists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function assertSafeWorkspaceRoot(workspaceRoot, force) {
  const resolved = path.resolve(workspaceRoot);
  if (resolved === repoRoot || resolved.startsWith(`${repoRoot}${path.sep}`)) {
    throw new Error(`Refusing to generate benchmark data inside the repository: ${resolved}`);
  }
  if (!(await pathExists(resolved))) return;
  const entries = await readdir(resolved);
  if (entries.length > 0 && !force) {
    throw new Error(`Benchmark workspace is not empty: ${resolved}; pass --force to replace it`);
  }
  if (
    entries.length > 0 &&
    !(await pathExists(path.join(resolved, FIXTURE_MANIFEST)))
  ) {
    throw new Error(
      `Refusing to replace non-fixture directory: ${resolved}; choose an empty output directory`,
    );
  }
  if (force) await rm(resolved, { recursive: true, force: true });
}

async function writeGeneratedItem(pmRoot, document, mode) {
  const itemPath = getItemPath(pmRoot, document.metadata.type, document.metadata.id, "toon");
  const historyPath = getHistoryPath(pmRoot, document.metadata.id);
  const historyEntry = createHistoryEntry({
    nowIso: document.metadata.created_at,
    author: AUTHOR,
    op: "create",
    before: emptyImportedDocument(),
    after: document,
    message: "Synthetic scale fixture",
  });
  const itemBytes = serializeItemDocument(document, { format: "toon" });
  if (mode === "sdk") {
    await writeFileAtomic(itemPath, itemBytes);
    await appendHistoryEntry(historyPath, historyEntry);
    return;
  }
  await Promise.all([
    writeFile(itemPath, itemBytes, "utf8"),
    writeFile(historyPath, `${JSON.stringify(historyEntry)}\n`, "utf8"),
  ]);
}

function recordFixtureSample(sampleIds, document) {
  if (sampleIds.get === undefined) sampleIds.get = document.metadata.id;
  if (document.metadata.status === "open" && sampleIds.open.length < 100) {
    sampleIds.open.push(document.metadata.id);
  }
}

/**
 * Generate a complete isolated pm workspace without mutating the current repo.
 * The returned manifest is also written beside the workspace for later runs.
 */
export async function generateSyntheticWorkspace(options) {
  const workspaceRoot = path.resolve(options.workspaceRoot);
  const itemCount = resolveScaleItemCount(options.itemCount);
  const seed = parsePositiveInteger(options.seed ?? 42, "--seed");
  const mode = options.mode ?? "direct";
  if (mode !== "direct" && mode !== "sdk") {
    throw new Error("--mode must be direct or sdk");
  }
  await assertSafeWorkspaceRoot(workspaceRoot, options.force === true);
  await mkdir(workspaceRoot, { recursive: true });
  const pmRoot = path.join(workspaceRoot, ".agents", "pm");
  const client = new PmClient({
    pmRoot,
    cwd: workspaceRoot,
    author: AUTHOR,
    noExtensions: true,
  });
  await client.init(undefined, { defaults: true, force: true });

  const itemDirectories = new Set(
    ["Epic", ...WEIGHTED_TYPES].map((type) =>
      path.dirname(getItemPath(pmRoot, type, scaleItemId(0), "toon")),
    ),
  );
  itemDirectories.add(path.join(pmRoot, "history"));
  await Promise.all([...itemDirectories].map((directory) => mkdir(directory, { recursive: true })));

  const startedAt = performance.now();
  const sampleIds = { get: undefined, open: [] };
  for (let offset = 0; offset < itemCount; offset += BATCH_SIZE) {
    const writes = [];
    for (let index = offset; index < Math.min(itemCount, offset + BATCH_SIZE); index += 1) {
      const document = buildSyntheticItemDocument(index, seed);
      recordFixtureSample(sampleIds, document);
      writes.push(writeGeneratedItem(pmRoot, document, mode));
    }
    await Promise.all(writes);
  }
  const canonicalWorkspaceRoot = await realpath(workspaceRoot);
  const manifest = {
    version: 1,
    generated_at: new Date().toISOString(),
    workspace_root: canonicalWorkspaceRoot,
    pm_root: path.join(canonicalWorkspaceRoot, ".agents", "pm"),
    item_count: itemCount,
    history_stream_count: itemCount,
    seed,
    mode,
    generation_ms: Math.round(performance.now() - startedAt),
    sample_ids: sampleIds,
  };
  await writeFile(
    path.join(workspaceRoot, FIXTURE_MANIFEST),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  return manifest;
}

/** Execute the scale generator command-line interface. */
export async function main(argv = process.argv.slice(2)) {
  const { flags } = parseFlags(argv);
  const outputValue = flags.get("output");
  if (outputValue === undefined || outputValue === true) {
    throw new Error("--output <directory> is required");
  }
  return generateSyntheticWorkspace(generatorOptionsFromFlags(flags, String(outputValue)));
}

/** Convert parsed generator flags into stable workspace-generation options. */
export function generatorOptionsFromFlags(flags, workspaceRoot) {
  return {
    workspaceRoot,
    itemCount: flags.get("items") ?? "ci",
    seed: flags.get("seed") ?? 42,
    mode: flags.get("mode") === undefined ? "direct" : String(flags.get("mode")),
    force: flags.has("force"),
  };
}

function isMainModule() {
  return process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  main()
    .then((manifest) => process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`))
    .catch((error) => fail(String(error)));
}
