import { afterEach, describe, expect, it } from "vitest";
import {
  assembleWorkspaceRelationshipGraph,
  composeExtension,
  describeExtensionBlueprint,
  describeExtensionActivation,
  RelationshipKindRegistry,
  type RelationshipKindDefinition,
} from "../../../src/sdk/index.js";
import {
  resetActiveExtensionRuntimeState,
  setActiveExtensionRegistrations,
} from "../../../src/core/extensions/index.js";
import { activateExtensionForTest } from "../../../src/sdk/testing.js";

const customKind: RelationshipKindDefinition = {
  kind: "commits_to",
  direction: "directed",
  inverse: "contains_commit",
  ordering: true,
  precedence: "source_before_target",
  hierarchy: false,
  outgoing: "one",
  incoming: "many",
  lifecycle: "supersedable",
  aliases: ["merged_into"],
  payloadSchema: {
    type: "object",
    properties: { review: { type: "string" } },
  },
  compatibilityVersion: 1,
  allowSelf: false,
};

afterEach(() => resetActiveExtensionRuntimeState());

describe("extension relationship-kind registration", () => {
  it("rejects a non-array registration container", async () => {
    const activation = await activateExtensionForTest(
      {
        activate(api) {
          api.registerRelationshipKinds({} as never);
        },
      },
      { name: "invalid-container-domain-graph", capabilities: ["schema"] },
    );
    expect(activation.failed).toHaveLength(1);
    expect(activation.registrations.relationship_kinds).toEqual([]);
  });

  it("rejects null relationship definitions at the public registry boundary", () => {
    expect(() => new RelationshipKindRegistry([]).register(null as never)).toThrow(
      /requires an object/,
    );
  });

  it("activates, summarizes, and assembles custom semantics into native graphs", async () => {
    const activation = await activateExtensionForTest(
      {
        activate(api) {
          api.registerRelationshipKinds([customKind]);
        },
      },
      { name: "domain-graph", capabilities: ["schema"] },
    );

    expect(activation.failed).toEqual([]);
    expect(activation.registration_counts.relationship_kinds).toBe(1);
    expect(describeExtensionActivation(activation).relationship_kinds).toEqual([
      "commits_to",
    ]);
    setActiveExtensionRegistrations(activation.registrations);
    const assembly = assembleWorkspaceRelationshipGraph([
      {
        id: "change-1",
        title: "Change",
        status: "open",
        dependencies: [{ id: "main", kind: "merged_into" }],
      },
      { id: "main", title: "Main", status: "open" },
    ]);

    expect(assembly.graph.registry().require("merged_into").kind).toBe(
      "commits_to",
    );
    expect(
      assembly.graph.registry().require("commits_to").payloadSchema,
    ).toEqual({
      type: "object",
      properties: { review: { type: "string" } },
    });
    expect(assembly.graph.edges()).toEqual([
      { source: "change-1", target: "main", kind: "commits_to" },
    ]);
  });

  it("summarizes activation payloads produced before relationship kinds existed", async () => {
    const activation = await activateExtensionForTest(
      { activate() {} },
      { name: "legacy-domain-graph", capabilities: ["schema"] },
    );
    const legacyActivation = {
      ...activation,
      registrations: {
        ...activation.registrations,
        relationship_kinds: undefined,
      },
    } as never;

    const summary = describeExtensionActivation(legacyActivation);
    expect(summary.capabilities).toEqual([]);
    expect(summary).not.toHaveProperty("relationship_kinds");
  });

  it.each([
    ["definition", null],
    ["kind type", { kind: 7 }],
    ["kind syntax", { kind: "1bad" }],
    ["compatibility version", { compatibilityVersion: 0 }],
    ["direction", { direction: "sideways" }],
    ["missing ordering", { ordering: undefined }],
    ["ordering", { ordering: "yes" }],
    ["hierarchy", { hierarchy: "no" }],
    ["outgoing cardinality", { outgoing: "several" }],
    ["incoming cardinality", { incoming: "several" }],
    ["lifecycle", { lifecycle: "mutable" }],
    ["missing self edge", { allowSelf: undefined }],
    ["self edge", { allowSelf: "no" }],
    ["payload schema", { payloadSchema: [] }],
    ["alias container", { aliases: "alias" }],
    ["aliases", { aliases: [7] }],
  ])("rejects an invalid %s at activation", async (_label, invalid) => {
    const activation = await activateExtensionForTest(
      {
        activate(api) {
          api.registerRelationshipKinds(
            [
              invalid === null
                ? invalid
                : { ...customKind, ...invalid },
            ] as RelationshipKindDefinition[],
          );
        },
      },
      { name: "invalid-domain-graph", capabilities: ["schema"] },
    );

    expect(activation.failed).toHaveLength(1);
    expect(activation.registrations.relationship_kinds).toEqual([]);
  });

  it("keeps registration atomic when a later definition collides", async () => {
    const activation = await activateExtensionForTest(
      {
        activate(api) {
          api.registerRelationshipKinds([
            customKind,
            { ...customKind, kind: "second_kind", aliases: ["commits_to"] },
          ]);
        },
      },
      { name: "colliding-domain-graph", capabilities: ["schema"] },
    );

    expect(activation.failed).toHaveLength(1);
    expect(activation.registrations.relationship_kinds).toEqual([]);
  });

  it("rejects empty batches and merges repeated registrations atomically", async () => {
    const empty = await activateExtensionForTest(
      { activate: (api) => api.registerRelationshipKinds([]) },
      { name: "empty-domain-graph", capabilities: ["schema"] },
    );
    expect(empty.failed).toHaveLength(1);

    const repeated = await activateExtensionForTest(
      {
        activate(api) {
          api.registerRelationshipKinds([customKind]);
          api.registerRelationshipKinds([
            { ...customKind, kind: "reviews", aliases: [] },
          ]);
        },
      },
      { name: "repeated-domain-graph", capabilities: ["schema"] },
    );
    expect(repeated.failed).toEqual([]);
    expect(repeated.registration_counts.relationship_kinds).toBe(2);
  });

  it("composes and describes declarative relationship semantics", async () => {
    const blueprint = { relationshipKinds: [customKind] };
    expect(describeExtensionBlueprint(blueprint)).toMatchObject({
      capabilities: ["schema"],
      relationship_kinds: ["commits_to"],
    });
    const activation = await activateExtensionForTest(
      composeExtension(blueprint),
      { name: "composed-domain-graph", capabilities: ["schema"] },
    );
    expect(activation.registration_counts.relationship_kinds).toBe(1);
  });

  it("honors the dedicated extension policy surface", async () => {
    const activation = await activateExtensionForTest(
      {
        activate(api) {
          api.registerRelationshipKinds([customKind]);
        },
      },
      {
        name: "blocked-domain-graph",
        capabilities: ["schema"],
        policy: {
          mode: "enforce",
          blocked_surfaces: ["schema.relationshipkinds"],
        },
      },
    );

    expect(activation.failed).toEqual([]);
    expect(activation.registrations.relationship_kinds).toEqual([]);
    expect(activation.warnings).toContainEqual(
      expect.stringContaining("schema.relationshipkinds"),
    );
  });
});
