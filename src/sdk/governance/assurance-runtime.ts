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
  getActiveExtensionRegistrations,
  resolvePortableWorkspaceContext,
} from "../../core/extensions/index.js";
import { resolveRegisteredAssuranceMeasurementProvider } from "../../core/extensions/runtime-registrations.js";
import { stableStringify } from "../../core/shared/serialization.js";
import type {
  AssuranceMeasurementProviderDefinition,
  AssuranceMeasurementProviderResult,
} from "../../core/extensions/extension-types.js";
import {
  getHistoryPath,
  listAllItemMetadata,
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
  /** Capabilities for host-provided resolvers that are not extension registrations. */
  provider_capabilities?: AssuranceEvaluationContext["provider_capabilities"];
  /** Gate trigger supplied to extension provider resolvers. */
  trigger?: string;
}

const execFileAsync = promisify(execFile);
const HISTORY_READ_CONCURRENCY = 16;
const DEFAULT_PROVIDER_TIMEOUT_MS = 30_000;

function assertProviderResult(
  provider: AssuranceMeasurementProviderDefinition,
  key: string,
  result: AssuranceMeasurementProviderResult,
): AssuranceExternalMeasurementResult {
  const keyDefinition = provider.keys[key];
  const valueMatches =
    keyDefinition.value_type === "number"
      ? typeof result.value === "number" && Number.isFinite(result.value)
      : Array.isArray(result.value) &&
        result.value.every((entry) => typeof entry === "string");
  if (!valueMatches) {
    throw new TypeError(
      `assurance provider ${provider.id} key ${key} returned the wrong value type`,
    );
  }
  if (
    !Number.isInteger(result.population_size) ||
    result.population_size < 0 ||
    !Number.isFinite(result.cost) ||
    result.cost < 0
  ) {
    throw new TypeError(
      `assurance provider ${provider.id} returned an invalid population or cost`,
    );
  }
  return result;
}

function validateProviderParameters(
  provider: AssuranceMeasurementProviderDefinition,
  source: AssuranceProviderSource,
): Record<string, string | number | boolean | null> {
  const keyDefinition = provider.keys[source.key];
  if (!keyDefinition) {
    throw new TypeError(
      `assurance provider ${provider.id} does not declare key ${source.key}`,
    );
  }
  const parameters = source.parameters ?? {};
  const schema = keyDefinition.parameters ?? {};
  for (const required of Object.entries(schema)
    .filter(([, definition]) => definition.required === true)
    .map(([name]) => name)) {
    if (!Object.hasOwn(parameters, required)) {
      throw new TypeError(
        `assurance provider ${provider.id} key ${source.key} requires parameter ${required}`,
      );
    }
  }
  for (const [name, value] of Object.entries(parameters)) {
    const definition = schema[name];
    if (!definition) {
      throw new TypeError(
        `assurance provider ${provider.id} key ${source.key} does not declare parameter ${name}`,
      );
    }
    if (value === null || typeof value !== definition.type) {
      throw new TypeError(
        `assurance provider ${provider.id} parameter ${name} must be ${definition.type}`,
      );
    }
  }
  return { ...parameters };
}

async function runRegisteredProvider(
  provider: AssuranceMeasurementProviderDefinition,
  source: AssuranceProviderSource,
  pmRoot: string,
  trigger: string,
): Promise<AssuranceExternalMeasurementResult> {
  const parameters = validateProviderParameters(provider, source);
  const providerPromise = Promise.resolve().then(() =>
    provider.resolve({
      provider: provider.id,
      key: source.key,
      parameters,
      trigger,
      pm_root: pmRoot,
      ...resolvePortableWorkspaceContext(pmRoot),
    }),
  );
  providerPromise.catch(() => {});
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      providerPromise,
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(
          () =>
            reject(
              new TypeError(`assurance provider ${provider.id} timed out`),
            ),
          provider.timeout_ms ?? DEFAULT_PROVIDER_TIMEOUT_MS,
        );
        timeoutHandle.unref?.();
      }),
    ]);
    return assertProviderResult(provider, source.key, result);
  } finally {
    clearTimeout(timeoutHandle as ReturnType<typeof setTimeout>);
  }
}

function valueAtPath(input: unknown, field: string): AssuranceValue {
  let current: unknown = input;
  for (const segment of field.split(".")) {
    if (
      typeof current !== "object" ||
      current === null ||
      Array.isArray(current)
    ) {
      throw new TypeError(`assurance field ${field} is not present`);
    }
    current = (current as Record<string, unknown>)[segment];
  }
  if (typeof current === "number" && Number.isFinite(current)) return current;
  if (
    Array.isArray(current) &&
    current.every((entry) => typeof entry === "string")
  ) {
    return current;
  }
  throw new TypeError(
    `assurance field ${field} must resolve to a finite number or string array`,
  );
}

function checkValue(
  result: {
    checks: Array<{
      name: string;
      status: string;
      ok: boolean;
      details?: Record<string, unknown>;
    }>;
  },
  checkName: string,
  field: string,
): AssuranceExternalMeasurementResult {
  const check = result.checks.find((entry) => entry.name === checkName);
  if (!check)
    throw new TypeError(`assurance check ${checkName} is not present`);
  const value =
    field === "status" || field === "ok"
      ? check.ok
        ? 0
        : 1
      : valueAtPath(check.details, field);
  return { value, population_size: 1, cost: result.checks.length };
}

async function resolveTreeId(
  pmRoot: string,
  explicit: string | undefined,
): Promise<string> {
  if (explicit?.trim()) return explicit.trim();
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "HEAD^{commit}"],
      {
        cwd: pmRoot,
        encoding: "utf8",
        timeout: 5_000,
        windowsHide: true,
      },
    );
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
  const metadata = await listAllItemMetadata(
    pmRoot,
    settings.item_format,
    typeRegistry.type_to_folder,
    undefined,
    settings.schema,
  );
  const items: AssuranceItemRecord[] = metadata.map((item) => ({
    ...item,
    id: item.id,
    status: item.status,
    type: item.type,
  }));
  const global = { path: pmRoot };
  const activeRegistrations = getActiveExtensionRegistrations();
  const registeredProviderCapabilities = Object.fromEntries(
    (activeRegistrations?.assurance_providers ?? []).map((registration) => [
      registration.definition.id,
      {
        cost_class: registration.runtime_definition.cost_class,
        network: registration.runtime_definition.network,
      },
    ]),
  );
  const graphRuns = new Map<string, ReturnType<typeof runGraph>>();
  let validateRun: ReturnType<typeof runValidate> | undefined;
  let healthRun: ReturnType<typeof runHealth> | undefined;
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
    provider_capabilities: {
      ...registeredProviderCapabilities,
      ...options.provider_capabilities,
    },
    external: async (
      source:
        | AssuranceGraphSource
        | AssuranceValidateSource
        | AssuranceHealthSource
      | AssuranceProviderSource,
    ) => {
      if (source.kind === "graph") {
        const key = stableStringify({
          operation: source.operation,
          parameters: source.parameters ?? {},
        });
        let pending = graphRuns.get(key);
        if (pending === undefined) {
          pending = runGraph(
            source.operation,
            undefined,
            undefined,
            { ...source.parameters, full: true } as GraphCommandOptions,
            global,
          );
          graphRuns.set(key, pending);
        }
        const result = await pending;
        return {
          value: valueAtPath(result, source.field),
          population_size: items.length,
          cost: items.length,
        };
      }
      if (source.kind === "validate") {
        validateRun ??= runValidate({ counts: true }, global);
        const result = await validateRun;
        return checkValue(result, source.check, source.field);
      }
      if (source.kind === "health") {
        healthRun ??= runHealth(global, { checkOnly: true, full: true });
        const result = await healthRun;
        return checkValue(result, source.check, source.field);
      }
      const hostProvider = options.providers?.[source.provider];
      if (hostProvider) return hostProvider(source);
      const registeredProvider = resolveRegisteredAssuranceMeasurementProvider(
        activeRegistrations,
        source.provider,
      );
      if (!registeredProvider) {
        throw new TypeError(
          `assurance provider ${source.provider} is not registered`,
        );
      }
      return runRegisteredProvider(
        registeredProvider.runtime_definition,
        source,
        pmRoot,
        options.trigger ?? "sdk",
      );
    },
  };
}
