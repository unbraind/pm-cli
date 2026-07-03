import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect } from "vitest";
import { parseItemDocument, serializeItemDocument } from "../../src/core/item/item-format.js";
import type { ItemFormat } from "../../src/types/index.js";
import type { TempPmContext } from "./withTempPmPath.js";

interface TaskDocumentLocation {
  taskPath: string;
  format: ItemFormat;
  source: string;
}

async function readTaskDocument(context: TempPmContext, id: string): Promise<TaskDocumentLocation> {
  const toonPath = path.join(context.pmPath, "tasks", `${id}.toon`);
  const markdownPath = path.join(context.pmPath, "tasks", `${id}.md`);
  let taskPath = toonPath;
  let source: string;
  try {
    source = await readFile(taskPath, "utf8");
  } catch (error) {
    if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    taskPath = markdownPath;
    source = await readFile(taskPath, "utf8");
  }
  const format = taskPath.endsWith(".toon") ? "toon" : "json_markdown";
  return { taskPath, format, source };
}

/**
 * Reads the persisted front matter of a task item in a temp workspace,
 * resolving the on-disk document format (TOON or JSON-markdown) automatically.
 */
export async function loadTaskFrontMatter(context: TempPmContext, id: string): Promise<Record<string, unknown>> {
  const { format, source } = await readTaskDocument(context, id);
  return parseItemDocument(source, { format }).metadata as unknown as Record<string, unknown>;
}

/**
 * Replaces the `tests` front-matter array of a task item on disk, bypassing
 * CLI validation so specs can seed arbitrary linked-test metadata.
 */
export async function overwriteTaskTests(
  context: TempPmContext,
  id: string,
  tests: Array<Record<string, unknown>>,
): Promise<void> {
  const { taskPath, format, source } = await readTaskDocument(context, id);
  const parsed = parseItemDocument(source, { format });
  parsed.metadata.tests = tests as unknown as never;
  await writeFile(taskPath, serializeItemDocument(parsed, { format }), "utf8");
}

/**
 * Replaces the `test_runs` front-matter array of a task item on disk,
 * bypassing CLI validation so specs can seed arbitrary tracked run history.
 */
export async function overwriteTaskTestRuns(
  context: TempPmContext,
  id: string,
  testRuns: Array<Record<string, unknown>>,
): Promise<void> {
  const { taskPath, format, source } = await readTaskDocument(context, id);
  const parsed = parseItemDocument(source, { format });
  parsed.metadata.test_runs = testRuns as unknown as never;
  await writeFile(taskPath, serializeItemDocument(parsed, { format }), "utf8");
}

/**
 * Toggles `testing.record_results_to_items` in the workspace settings.json so
 * specs can enable or disable linked-test result tracking.
 */
export async function setTestResultTracking(pmPath: string, enabled: boolean): Promise<void> {
  const settingsPath = path.join(pmPath, "settings.json");
  const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
    testing?: { record_results_to_items?: boolean };
  };
  settings.testing = {
    ...settings.testing,
    record_results_to_items: enabled,
  };
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

/**
 * Replaces `item_types.definitions` in the workspace settings.json so specs
 * can seed custom item-type definitions without repeating settings plumbing.
 */
export async function writeItemTypeDefinitions(pmPath: string, definitions: Array<Record<string, unknown>>): Promise<void> {
  const settingsPath = path.join(pmPath, "settings.json");
  const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
    item_types?: Record<string, unknown> & { definitions?: Array<Record<string, unknown>> };
  };
  settings.item_types = { ...settings.item_types, definitions };
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

/**
 * Applies a governance preset to the temp workspace via the real CLI and
 * asserts the command succeeded.
 */
export function setGovernancePreset(context: TempPmContext, preset: "minimal" | "default" | "strict" | "custom"): void {
  const result = context.runCli(["config", "project", "set", "governance-preset", "--policy", preset, "--json"], {
    expectJson: true,
  });
  expect(result.code).toBe(0);
}

/**
 * Writes a minimal schema-capability extension (manifest + entry module) into
 * a PM root that registers a single custom item type.
 */
export async function writeSchemaTypeExtension(pmRoot: string, extensionDirName: string, typeName: string): Promise<void> {
  const extensionDir = path.join(pmRoot, "extensions", extensionDirName);
  await mkdir(extensionDir, { recursive: true });
  await writeFile(
    path.join(extensionDir, "manifest.json"),
    `${JSON.stringify(
      {
        name: `${extensionDirName}-ext`,
        version: "1.0.0",
        entry: "index.mjs",
        capabilities: ["schema"],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(
    path.join(extensionDir, "index.mjs"),
    [
      "export function activate(api) {",
      "  api.registerItemTypes([",
      `    { name: "${typeName}", folder: "${typeName.toLowerCase()}" },`,
      "  ]);",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
}
