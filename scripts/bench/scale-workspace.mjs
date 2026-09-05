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
  buildCorpusShapeItemPlan,
  canonicalDocument,
  createCorpusShapeMeasurement,
  createHistoryEntry,
  emptyImportedDocument,
  getHistoryPath,
  getItemPath,
  resolveBuiltinCorpusShape,
  runWithReproducibleProcessEnvironment,
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

function buildDependencies(plan, itemCount, shape, seed) {
  if (plan.index === 0 || plan.dependency_kinds.length === 0) return undefined;
  return plan.dependency_kinds.map((kind, offset) => ({
    id: buildCorpusShapeItemPlan(
      shape,
      offset > 0 && plan.index + 1 < itemCount
        ? plan.index + 1
        : plan.index - 1,
      itemCount,
      seed,
    ).id,
    kind,
    created_at: plan.timestamp,
    author: plan.author,
  }));
}

/** Build one deterministic, realistic item document for a scale fixture. */
export function buildSyntheticItemDocument(
  index,
  seed = 42,
  shape = resolveBuiltinCorpusShape("scratch"),
  itemCount = Math.max(100, index + 1),
  itemPlan = buildCorpusShapeItemPlan(shape, index, itemCount, seed),
) {
  const plan = itemPlan;
  const random = createSeededRandom(seed + index);
  const id = plan.id;
  const createdAt = plan.timestamp;
  const status = plan.custom_status ?? statusFor(index);
  const type = plan.custom_type ?? typeFor(index, random);
  const terminalStatuses = new Set([
    "closed",
    "canceled",
    ...shape.terminal_statuses,
  ]);
  const terminal = terminalStatuses.has(status);
  const dependencies = buildDependencies(plan, itemCount, shape, seed);
  const customFields = Object.fromEntries(
    shape.custom_fields.map((field) => [
      field,
      `synthetic-${shape.name}-${index % 8}`,
    ]),
  );
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
      author: plan.author,
      estimated_minutes: 15 + (index % 16) * 15,
      acceptance_criteria: `Synthetic acceptance criterion ${index}`,
      ...(plan.parent === undefined ? {} : { parent: plan.parent }),
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
      ...(dependencies === undefined ? {} : { dependencies }),
      ...(plan.has_comment
        ? {
            comments: [
              {
                created_at: createdAt,
                author: plan.author,
                text: `Synthetic evidence comment ${index}`,
              },
            ],
          }
        : {}),
      ...(plan.has_note
        ? {
            notes: [
              {
                created_at: createdAt,
                author: plan.author,
                text: `Private synthetic context note ${index}`,
              },
            ],
          }
        : {}),
      ...(plan.has_learning
        ? {
            learnings: [
              {
                created_at: createdAt,
                author: plan.author,
                text: `Durable synthetic learning ${index}`,
              },
            ],
          }
        : {}),
      ...customFields,
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

async function writeGeneratedItem(pmRoot, document, mode, historyEntryCount) {
  const itemPath = getItemPath(pmRoot, document.metadata.type, document.metadata.id, "toon");
  const historyPath = getHistoryPath(pmRoot, document.metadata.id);
  const historyEntries = [createHistoryEntry({
    nowIso: document.metadata.created_at,
    author: document.metadata.author,
    op: "create",
    before: emptyImportedDocument(),
    after: document,
    message: "Synthetic scale fixture",
  })];
  for (let index = 1; index < historyEntryCount; index += 1) {
    historyEntries.push(
      createHistoryEntry({
        nowIso: new Date(
          Date.parse(document.metadata.created_at) + index,
        ).toISOString(),
        author: document.metadata.author,
        op: `synthetic:history:${index}`,
        before: document,
        after: document,
        message: "Synthetic history depth fixture",
      }),
    );
  }
  const itemBytes = serializeItemDocument(document, { format: "toon" });
  if (mode === "sdk") {
    await writeFileAtomic(itemPath, itemBytes);
    for (const historyEntry of historyEntries) {
      await appendHistoryEntry(historyPath, historyEntry);
    }
    return;
  }
  await Promise.all([
    writeFile(itemPath, itemBytes, "utf8"),
    writeFile(
      historyPath,
      `${historyEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      "utf8",
    ),
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
  const shape = resolveBuiltinCorpusShape(options.shape ?? "scratch");
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
  await runWithReproducibleProcessEnvironment({ PM_CLOCK: "2026-01-01T00:00:00.000Z", PM_SEED: String(seed) }, async () => {
    await client.init(undefined, { defaults: true, force: true });
    const schema = await client.schemaList();
    const registeredTypes = new Set([...schema.builtin, ...schema.custom, ...schema.extension].map(({ name }) => name));
    for (const type of new Set(["Epic", ...WEIGHTED_TYPES, ...shape.custom_types])) {
      if (registeredTypes.has(type)) continue;
      await client.schemaAddType(type, {
        description: `Synthetic ${shape.name} corpus type`,
        author: AUTHOR,
      });
    }
    for (const status of shape.custom_statuses) {
      await client.schemaAddStatus(status, {
        description: `Synthetic ${shape.name} corpus status`,
        role:
          shape.terminal_statuses.includes(status)
            ? ["terminal", "terminal_done"]
            : ["active"],
        author: AUTHOR,
      });
    }
    for (const field of shape.custom_fields) {
      await client.schemaAddField(field, {
        type: "string",
        commands: ["create", "update", "list", "search", "context"],
        description: `Synthetic ${shape.name} corpus field`,
        author: AUTHOR,
      });
    }
  });

  const itemDirectories = new Set(
    ["Epic", ...WEIGHTED_TYPES, ...shape.custom_types].map((type) =>
      path.dirname(getItemPath(pmRoot, type, scaleItemId(0), "toon")),
    ),
  );
  itemDirectories.add(path.join(pmRoot, "history"));
  await Promise.all([...itemDirectories].map((directory) => mkdir(directory, { recursive: true })));

  const startedAt = performance.now();
  const sampleIds = { get: undefined, open: [] };
  const measurement = (
    options.createShapeMeasurement ?? createCorpusShapeMeasurement
  )(shape);
  for (let offset = 0; offset < itemCount; offset += BATCH_SIZE) {
    const writes = [];
    for (let index = offset; index < Math.min(itemCount, offset + BATCH_SIZE); index += 1) {
      const plan = buildCorpusShapeItemPlan(shape, index, itemCount, seed);
      const document = buildSyntheticItemDocument(
        index,
        seed,
        shape,
        itemCount,
        plan,
      );
      measurement.add(plan);
      recordFixtureSample(sampleIds, document);
      writes.push(
        writeGeneratedItem(
          pmRoot,
          document,
          mode,
          plan.history_entry_count,
        ),
      );
    }
    await Promise.all(writes);
  }
  const canonicalWorkspaceRoot = await realpath(workspaceRoot);
  const measuredShape = measurement.finish();
  if (!measuredShape.matches_declaration) {
    throw new Error(
      `Generated corpus shape drifted: ${measuredShape.mismatches.join(", ")}`,
    );
  }
  const manifest = {
    version: 2,
    generated_at: new Date().toISOString(),
    workspace_root: canonicalWorkspaceRoot,
    pm_root: path.join(canonicalWorkspaceRoot, ".agents", "pm"),
    item_count: itemCount,
    history_stream_count: itemCount,
    history_entry_count: measuredShape.history_entry_count,
    seed,
    shape,
    measured_shape: measuredShape,
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
    shape:
      flags.get("shape") === undefined
        ? "scratch"
        : String(flags.get("shape")),
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
