/**
 * @module sdk/extension-command-context
 *
 * Builds the host-owned SDK services injected into extension commands so
 * package runtimes never need private imports or runtime package resolution.
 */
import type {
  ExtensionCommandSdk,
} from "../core/extensions/extension-types.js";
import { getItemAt } from "./history-read.js";
import { RelationshipEventStore } from "./relationship-history.js";
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
    commitWorkspaceTransaction: (options) =>
      commitWorkspaceTransaction({ ...options, pmRoot }),
  };
}
