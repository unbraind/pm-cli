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
import { RelationshipGraph } from "./relationships.js";
import { createRelationshipKindRegistry } from "./relationships.js";
import type { PmClient } from "./runtime.js";
import { commitWorkspaceTransaction } from "./workspace-transaction.js";

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
      const registry = createRelationshipKindRegistry();
      for (const definition of options.definitions) {
        registry.register(definition);
      }
      return RelationshipEventStore.open({
        pmRoot,
        nodes: options.nodes,
        registry,
        ...(options.relativePath === undefined
          ? {}
          : { relativePath: options.relativePath }),
      });
    },
    createRelationshipGraph: (options) => {
      const registry = createRelationshipKindRegistry();
      for (const definition of options.definitions) {
        registry.register(definition);
      }
      return new RelationshipGraph(options.nodes, options.edges, registry);
    },
    analyzeRelationshipImpact: (graph, root, options) =>
      analyzeGraphImpact(graph, root, options),
    validateRelationshipEvents: (options) => {
      const registry = createRelationshipKindRegistry();
      for (const definition of options.definitions) {
        registry.register(definition);
      }
      const log = new RelationshipEventLog(options.nodes, { registry });
      return options.events.map((event) =>
        log.append({ ...event, expectedVersion: log.version }),
      );
    },
    commitWorkspaceTransaction: (options) =>
      commitWorkspaceTransaction({ ...options, pmRoot }),
  };
}
