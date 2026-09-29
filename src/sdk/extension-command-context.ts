/**
 * @module sdk/extension-command-context
 *
 * Builds the host-owned SDK services injected into extension commands so
 * package runtimes never need private imports or runtime package resolution.
 */
import type { ExtensionCommandSdk } from "../core/extensions/extension-types.js";
import type { PmSettings } from "../types/index.js";
import { mutateWorkspaceJsonWithHistory } from "../core/history/workspace-history.js";
import { resolveAuthor } from "../core/shared/author.js";
import { EXIT_CODE } from "../core/shared/constants.js";
import { PmCliError } from "../core/shared/errors.js";
import { stableValueEquals } from "../core/shared/serialization.js";
import { getSettingsPath } from "../core/store/paths.js";
import { readSettings } from "../core/store/settings.js";
import { clearSettingsReadCache } from "../core/store/settings-read-cache.js";
import { validateSettings } from "../core/store/settings-validator.js";
import { isPmCliExpectedError } from "./errors.js";
import { getItemAt } from "./history-read.js";
import {
  RelationshipEventLog,
  RelationshipEventStore,
} from "./relationship-history.js";
import { analyzeGraphImpact } from "./relationship-analytics.js";
import {
  RelationshipGraph,
  createRelationshipKindRegistry,
} from "./relationships.js";
import type {
  RelationshipKindDefinition,
  RelationshipKindRegistry,
} from "./relationships.js";
import type { PmClient } from "./runtime.js";
import { commitWorkspaceTransaction } from "./workspace-transaction.js";

/** Build a relationship-kind registry from extension-owned definitions. */
function buildRelationshipKindRegistry(
  definitions: readonly RelationshipKindDefinition[],
): RelationshipKindRegistry {
  const registry = createRelationshipKindRegistry();
  for (const definition of definitions) registry.register(definition);
  return registry;
}

/** Bind public SDK services to one tracker and one caller-owned client. */
export function createExtensionCommandSdk(
  pmRoot: string,
  client: PmClient,
  invocationAuthor?: string,
): ExtensionCommandSdk {
  return {
    client,
    isItemNotFoundError: (error) =>
      isPmCliExpectedError(error) && error.exitCode === EXIT_CODE.NOT_FOUND,
    getItemAt: (id, target) => getItemAt(id, target, { pmRoot }),
    openRelationshipEventStore: (options) => {
      return RelationshipEventStore.open({
        pmRoot,
        nodes: options.nodes,
        registry: buildRelationshipKindRegistry(options.definitions),
        ...(options.relativePath === undefined
          ? {}
          : { relativePath: options.relativePath }),
      });
    },
    createRelationshipGraph: (options) =>
      new RelationshipGraph(
        options.nodes,
        options.edges,
        buildRelationshipKindRegistry(options.definitions),
      ),
    analyzeRelationshipImpact: (graph, root, options) =>
      analyzeGraphImpact(graph, root, options),
    validateRelationshipEvents: (options) => {
      const log = new RelationshipEventLog(options.nodes, {
        registry: buildRelationshipKindRegistry(options.definitions),
      });
      return options.events.map((event) =>
        log.append({ ...event, expectedVersion: log.version }),
      );
    },
    commitWorkspaceTransaction: (options) =>
      commitWorkspaceTransaction({ ...options, pmRoot }),
    mutateWorkspaceSettings: async (options) => {
      if (!/^[a-zA-Z0-9._-]{1,128}$/u.test(options.operationId)) {
        throw new PmCliError(
          "Workspace settings operationId must be 1-128 letters, digits, dots, underscores, or hyphens.",
          EXIT_CODE.USAGE,
        );
      }
      const settings = await readSettings(pmRoot);
      try {
        const mutation = await mutateWorkspaceJsonWithHistory({
          pmRoot,
          filePath: getSettingsPath(pmRoot),
          op: "extension:pm:settings",
          idempotencyKey: options.operationId,
          author: invocationAuthor ?? resolveAuthor(undefined, settings.author_default),
          lockTtlSeconds: settings.locks.ttl_seconds,
          lockWaitMs: settings.locks.wait_ms,
          recordCreation: false,
          dryRun: options.dryRun === true,
          mutate: async (beforeRaw) => {
            const current: unknown = beforeRaw === null ? null : JSON.parse(beforeRaw);
            if (!validateSettings(current).success) {
              throw new PmCliError(
                "Workspace settings mutation requires a valid initialized settings.json.",
                EXIT_CODE.USAGE,
              );
            }
            const next = await options.mutate(structuredClone(current as PmSettings));
            if (!validateSettings(next).success) {
              throw new PmCliError(
                "Workspace settings mutation returned invalid settings.json.",
                EXIT_CODE.USAGE,
              );
            }
            return {
              raw: stableValueEquals(current, next)
                ? beforeRaw!
                : `${JSON.stringify(next, null, 2)}\n`,
              result: undefined,
            };
          },
        });
        return {
          changed: mutation.changed,
          dry_run: options.dryRun === true,
          replayed: mutation.replayed === true,
        };
      } finally {
        clearSettingsReadCache(pmRoot);
      }
    },
  };
}
