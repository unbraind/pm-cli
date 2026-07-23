/**
 * @module sdk/extension-command-context
 *
 * Builds the host-owned SDK services injected into extension commands so
 * package runtimes never need private imports or runtime package resolution.
 */
import type { ExtensionCommandSdk } from "../core/extensions/extension-types.js";
import { EXIT_CODE } from "../core/shared/constants.js";
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
  };
}
