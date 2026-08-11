/**
 * @module sdk/assurance-runtime
 *
 * Binds assurance evaluation to a real pm workspace while leaving declaration
 * and verdict semantics in the host-neutral assurance module.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type {
  AssuranceEvaluationContext,
  AssuranceExternalMeasurementResult,
  AssuranceGraphSource,
  AssuranceHealthSource,
  AssuranceHistoryRecord,
  AssuranceItemRecord,
  AssuranceProviderSource,
  AssuranceValidateSource,
  AssuranceValue,
} from "./assurance.js";
import { runGraph, type GraphCommandOptions } from "../graph/run.js";
import { runHealth } from "./health.js";
import { runValidate } from "./validate.js";
import {
  getHistoryPath,
  listAllItemMetadataLight,
  readHistoryEntries,
  readSettings,
  resolveItemTypeRegistry,
  resolveRuntimeStatusRegistry,
} from "../runtime-primitives.js";

/** Resolver contributed by an embedding host or extension package. */
export type AssuranceProviderResolver = (
  source: AssuranceProviderSource,
) => Promise<AssuranceExternalMeasurementResult>;

/** Workspace binding options. */
export interface CreateAssuranceWorkspaceContextOptions {
  /** Explicit tree identity; otherwise the current Git commit is used. */
  tree_id?: string;
  /** Load immutable item history for history-backed measurements. */
  include_history?: boolean;
  /** Resolve a Git identity; item-only callers can skip this subprocess. */
  resolve_tree?: boolean;
  /** Provider resolvers keyed by stable provider id. */
  providers?: Readonly<Record<string, AssuranceProviderResolver>>;
}

const execFileAsync = promisify(execFile);
const HISTORY_READ_CONCURRENCY = 16;

function valueAtPath(input: unknown, field: string): AssuranceValue {
  let current: unknown = input;
  for (const segment of field.split(".")) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) {
      throw new TypeError(`assurance field ${field} is not present`);
    }
    current = (current as Record<string, unknown>)[segment];
  }
  if (typeof current === "number" && Number.isFinite(current)) return current;
  if (Array.isArray(current) && current.every((entry) => typeof entry === "string")) {
    return current;
  }
  throw new TypeError(`assurance field ${field} must resolve to a finite number or string array`);
}

function checkValue(
  result: { checks: Array<{ name: string; status: string; details?: Record<string, unknown> }> },
  checkName: string,
  field: string,
): AssuranceExternalMeasurementResult {
  const check = result.checks.find((entry) => entry.name === checkName);
  if (!check) throw new TypeError(`assurance check ${checkName} is not present`);
  const value =
    field === "status"
      ? check.status === "ok"
        ? 0
        : 1
      : valueAtPath(check.details, field);
  return { value, population_size: 1, cost: result.checks.length };
}

async function resolveTreeId(pmRoot: string, explicit: string | undefined): Promise<string> {
  if (explicit?.trim()) return explicit.trim();
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD^{commit}"], {
      cwd: pmRoot,
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
    });
    return stdout.trim();
  } catch {
    return "working-copy";
  }
}

async function readWorkspaceHistory(
  pmRoot: string,
  items: AssuranceItemRecord[],
): Promise<AssuranceHistoryRecord[]> {
  const streams = new Array<AssuranceHistoryRecord[]>(items.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(HISTORY_READ_CONCURRENCY, items.length) },
    async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        const item = items[index];
        const entries = await readHistoryEntries(
          getHistoryPath(pmRoot, item.id),
          item.id,
        );
        streams[index] = entries.map((entry) => ({
          op: entry.op,
          author: entry.author,
          agent_harness: entry.agent_harness,
          agent_model: entry.agent_model,
        }));
      }
    },
  );
  await Promise.all(workers);
  return streams.flat();
}

/**
 * Build an assurance context from authoritative workspace data and public SDK
 * operations. Graph, validate, and health selectors run through their existing
 * SDK implementations, so presentation surfaces cannot acquire divergent rules.
 */
export async function createAssuranceWorkspaceContext(
  pmRoot: string,
  options: CreateAssuranceWorkspaceContextOptions = {},
): Promise<AssuranceEvaluationContext> {
  const settings = await readSettings(pmRoot);
  const typeRegistry = resolveItemTypeRegistry(settings);
  const statusRegistry = resolveRuntimeStatusRegistry(settings.schema);
  const metadata = await listAllItemMetadataLight(
    pmRoot,
    settings.item_format,
    typeRegistry.type_to_folder,
    undefined,
    settings.schema,
  );
  const items: AssuranceItemRecord[] = metadata.map((item) => ({
    ...(item as AssuranceItemRecord),
    id: item.id,
    status: item.status,
    type: item.type,
  }));
  const global = { path: pmRoot };
  return {
    tree_id:
      options.resolve_tree === false
        ? (options.tree_id ?? "working-copy")
        : await resolveTreeId(pmRoot, options.tree_id),
    items,
    history:
      options.include_history === false
        ? []
        : await readWorkspaceHistory(pmRoot, items),
    terminal_statuses: [...statusRegistry.terminal_statuses],
    external: async (
      source:
        | AssuranceGraphSource
        | AssuranceValidateSource
        | AssuranceHealthSource
        | AssuranceProviderSource,
    ) => {
      if (source.kind === "graph") {
        const result = await runGraph(
          source.operation,
          undefined,
          undefined,
          { ...source.parameters, full: true } as GraphCommandOptions,
          global,
        );
        return {
          value: valueAtPath(result, source.field),
          population_size: items.length,
          cost: items.length,
        };
      }
      if (source.kind === "validate") {
        const result = await runValidate({ counts: true }, global);
        return checkValue(result, source.check, source.field);
      }
      if (source.kind === "health") {
        const result = await runHealth(global, { checkOnly: true, full: true });
        return checkValue(result, source.check, source.field);
      }
      const provider = options.providers?.[source.provider];
      if (!provider) {
        throw new TypeError(`assurance provider ${source.provider} is not registered`);
      }
      return provider(source);
    },
  };
}
