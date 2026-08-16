/**
 * @module sdk/relationship-kinds/contract
 *
 * Dependency-free relationship ontology shared by contracts and graph runtime.
 */

/** Direction exposed by a relationship kind. */
export type RelationshipDirection = "directed" | "undirected";
/** Cardinality constraint applied independently to outgoing and incoming edges. */
export type RelationshipCardinality = "one" | "many";
/** Lifecycle policy for a relationship kind. */
export type RelationshipLifecycle = "persistent" | "supersedable" | "ephemeral";
/** Temporal meaning carried by a directed relationship independently of execution precedence. */
export type RelationshipTemporalOrder = "source_after_target";
/** Direction in which an ordering edge contributes to execution precedence. */
export type RelationshipPrecedence =
  | "source_before_target"
  | "target_before_source";
/** Endpoint that represents the structural parent for hierarchy kinds. */
export type RelationshipHierarchyDirection = "source_parent" | "target_parent";

/** Versioned semantic definition for a built-in or application-defined edge kind. */
export interface RelationshipKindDefinition {
  /** Canonical, case-insensitive kind identifier. */
  kind: string;
  /** Whether traversing source to target has distinct meaning from the reverse. */
  direction: RelationshipDirection;
  /** Optional canonical kind used when traversing a directed edge in reverse. */
  inverse?: string;
  /** Whether the kind participates in execution-order cycle checks. */
  ordering: boolean;
  /** Optional chronological constraint; recurrence uses source-after-target without becoming scheduling precedence. */
  temporalOrder?: RelationshipTemporalOrder;
  /** Execution direction for ordering kinds; defaults to source before target. */
  precedence?: RelationshipPrecedence;
  /** Whether the kind contributes to structural ancestry. */
  hierarchy: boolean;
  /** Endpoint that represents the parent; defaults to source for custom kinds. */
  hierarchyDirection?: RelationshipHierarchyDirection;
  /** Maximum logical outgoing edges of this kind from one node. */
  outgoing: RelationshipCardinality;
  /** Maximum logical incoming edges of this kind to one node. */
  incoming: RelationshipCardinality;
  /** Edge replacement and retention behavior. */
  lifecycle: RelationshipLifecycle;
  /** JSON Schema for optional application-owned payloads. */
  payloadSchema?: Readonly<Record<string, unknown>>;
  /** Legacy spellings normalized to this definition. */
  aliases?: readonly string[];
  /** Compatibility version of this semantic contract. */
  compatibilityVersion: number;
  /** Whether source and target may be the same node. */
  allowSelf: boolean;
}

/** Stable built-in relationship ontology without graph or storage dependencies. */
export const BUILTIN_RELATIONSHIP_KINDS: readonly RelationshipKindDefinition[] = [
  { kind: "blocked_by", direction: "directed", inverse: "blocks", ordering: true, precedence: "target_before_source", hierarchy: false, outgoing: "many", incoming: "many", lifecycle: "persistent", aliases: ["depends_on"], compatibilityVersion: 1, allowSelf: false },
  { kind: "blocks", direction: "directed", inverse: "blocked_by", ordering: true, precedence: "source_before_target", hierarchy: false, outgoing: "many", incoming: "many", lifecycle: "persistent", compatibilityVersion: 1, allowSelf: false },
  { kind: "parent", direction: "directed", inverse: "child", ordering: false, hierarchy: true, hierarchyDirection: "target_parent", outgoing: "one", incoming: "many", lifecycle: "supersedable", aliases: ["child_of", "epic"], compatibilityVersion: 1, allowSelf: false },
  { kind: "child", direction: "directed", inverse: "parent", ordering: false, hierarchy: true, hierarchyDirection: "source_parent", outgoing: "many", incoming: "one", lifecycle: "supersedable", aliases: ["parent_child", "task"], compatibilityVersion: 1, allowSelf: false },
  { kind: "related", direction: "undirected", ordering: false, hierarchy: false, outgoing: "many", incoming: "many", lifecycle: "persistent", aliases: ["related_to"], compatibilityVersion: 1, allowSelf: false },
  { kind: "discovered_from", direction: "directed", ordering: false, hierarchy: false, outgoing: "many", incoming: "many", lifecycle: "persistent", compatibilityVersion: 1, allowSelf: false },
  { kind: "incident_from", direction: "directed", ordering: false, hierarchy: false, outgoing: "many", incoming: "many", lifecycle: "persistent", compatibilityVersion: 1, allowSelf: false },
  { kind: "implements", direction: "directed", ordering: false, hierarchy: false, outgoing: "many", incoming: "many", lifecycle: "persistent", compatibilityVersion: 1, allowSelf: false },
  { kind: "recurs_from", direction: "directed", ordering: false, temporalOrder: "source_after_target", hierarchy: false, outgoing: "many", incoming: "many", lifecycle: "persistent", compatibilityVersion: 1, allowSelf: false },
  { kind: "verifies", direction: "directed", ordering: false, hierarchy: false, outgoing: "many", incoming: "many", lifecycle: "persistent", compatibilityVersion: 1, allowSelf: false },
  { kind: "supersedes", direction: "directed", ordering: false, hierarchy: false, outgoing: "many", incoming: "many", lifecycle: "supersedable", compatibilityVersion: 1, allowSelf: false },
] as const;
