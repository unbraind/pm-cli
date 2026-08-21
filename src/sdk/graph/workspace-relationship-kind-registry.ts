/**
 * @module sdk/graph/workspace-relationship-kind-registry
 *
 * Resolves the built-in relationship ontology together with active extension
 * registrations without coupling hierarchy analysis to graph assembly.
 */
import { getActiveExtensionRegistrations } from "../../core/extensions/index.js";
import {
  createRelationshipKindRegistry,
  type RelationshipKindRegistry,
} from "../relationships.js";

/**
 * Resolve the relationship-kind registry active for the current workspace.
 *
 * Callers that omit an explicit registry must still recognize extension-owned
 * hierarchy and ordering kinds instead of silently falling back to built-ins.
 */
export function resolveWorkspaceRelationshipKindRegistry(): RelationshipKindRegistry {
  const registry = createRelationshipKindRegistry();
  for (const registration of getActiveExtensionRegistrations()
    ?.relationship_kinds ?? []) {
    for (const definition of registration.definitions) {
      registry.register(definition);
    }
  }
  return registry;
}
