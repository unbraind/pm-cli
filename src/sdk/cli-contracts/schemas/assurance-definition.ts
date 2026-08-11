/**
 * @module sdk/cli-contracts/schemas/assurance-definition
 *
 * Defines the strict JSON Schema accepted by assurance definition mutations.
 */

const ASSURANCE_VALUE_SCHEMA = {
  oneOf: [{ type: "number" }, { type: "array", items: { type: "string" } }],
};

const ITEMS_FIELD_CONDITIONAL_SCHEMA: Record<string, unknown> = {
  if: { required: ["field"] },
};
Reflect.set(ITEMS_FIELD_CONDITIONAL_SCHEMA, "then", {
  required: ["equals"],
});

/** JSON Schema for measurement, assertion, and gate assurance definitions. */
export const ASSURANCE_DEFINITION_SCHEMA = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["id", "source"],
      properties: {
        id: { type: "string", minLength: 1 },
        description: { type: "string" },
        max_cost: { type: "number", minimum: 0 },
        source: {
          oneOf: [
            {
              type: "object",
              additionalProperties: false,
              required: ["kind"],
              allOf: [ITEMS_FIELD_CONDITIONAL_SCHEMA],
              properties: {
                kind: { const: "items" },
                statuses: { type: "array", items: { type: "string" } },
                types: { type: "array", items: { type: "string" } },
                tags: { type: "array", items: { type: "string" } },
                field: { type: "string" },
                equals: { type: ["string", "number", "boolean", "null"] },
              },
            },
            {
              type: "object",
              additionalProperties: false,
              required: ["kind", "dependency_kind"],
              properties: {
                kind: { const: "dependency_kind" },
                dependency_kind: { type: "string", minLength: 1 },
              },
            },
            {
              type: "object",
              required: ["kind", "operation", "field"],
              properties: {
                kind: { const: "graph" },
                operation: { type: "string", minLength: 1 },
                field: { type: "string", minLength: 1 },
                parameters: { type: "object" },
              },
              additionalProperties: false,
            },
            ...["validate", "health"].map((kind) => ({
              type: "object",
              required: ["kind", "check", "field"],
              properties: {
                kind: { const: kind },
                check: { type: "string", minLength: 1 },
                field: { type: "string", minLength: 1 },
              },
              additionalProperties: false,
            })),
            {
              type: "object",
              additionalProperties: false,
              required: ["kind"],
              properties: {
                kind: { const: "history" },
                op: { type: "string" },
                author: { type: "string" },
                harness: { type: "string" },
                model: { type: "string" },
              },
            },
            {
              type: "object",
              additionalProperties: false,
              required: ["kind", "link", "state"],
              properties: {
                kind: { const: "links" },
                link: { enum: ["files", "tests", "docs"] },
                state: { enum: ["present", "missing"] },
              },
            },
            {
              type: "object",
              additionalProperties: false,
              required: ["kind", "provider", "key"],
              properties: {
                kind: { const: "provider" },
                provider: { type: "string", minLength: 1 },
                key: { type: "string", minLength: 1 },
                parameters: { type: "object" },
              },
            },
            {
              type: "object",
              additionalProperties: false,
              required: ["kind", "expression"],
              properties: {
                kind: { const: "derived" },
                expression: { type: "object", minProperties: 1 },
              },
            },
          ],
        },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: [
        "id",
        "measurement_id",
        "owner_item_id",
        "scope",
        "enforcement",
        "negative_control",
      ],
      oneOf: [
        { required: ["ceiling"] },
        { required: ["floor"] },
        { required: ["equals"] },
        { required: ["zero"] },
        { required: ["monotone_nondecreasing"] },
        { required: ["monotone_nonincreasing"] },
        { required: ["subset_of"] },
      ],
      properties: {
        id: { type: "string", minLength: 1 },
        measurement_id: { type: "string", minLength: 1 },
        owner_item_id: { type: "string", minLength: 1 },
        scope: {
          oneOf: [
            {
              type: "object",
              additionalProperties: false,
              required: ["kind"],
              properties: { kind: { enum: ["all", "active"] } },
            },
            {
              type: "object",
              additionalProperties: false,
              required: ["kind", "measurement_id"],
              properties: {
                kind: { const: "filter" },
                measurement_id: { type: "string", minLength: 1 },
              },
            },
          ],
        },
        ceiling: { type: "number" },
        floor: { type: "number" },
        equals: ASSURANCE_VALUE_SCHEMA,
        zero: { const: true },
        monotone_nondecreasing: { type: "number" },
        monotone_nonincreasing: { type: "number" },
        subset_of: { type: "array", items: { type: "string" } },
        lifetime: { enum: ["hold", "retire"] },
        retire_reason: { type: "string" },
        enforcement: { enum: ["block", "warn", "observe"] },
        authorization_decision: { type: "string", minLength: 1 },
        negative_control: {
          type: "object",
          additionalProperties: false,
          required: ["cases"],
          properties: {
            cases: {
              type: "array",
              minItems: 2,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["observed", "expected"],
                properties: {
                  observed: ASSURANCE_VALUE_SCHEMA,
                  expected: { enum: ["pass", "fail"] },
                },
              },
            },
          },
        },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["id", "assertion_ids", "triggers"],
      properties: {
        id: { type: "string", minLength: 1 },
        description: { type: "string" },
        assertion_ids: {
          type: "array",
          minItems: 1,
          items: { type: "string", minLength: 1 },
        },
        triggers: {
          type: "array",
          minItems: 1,
          items: {
            enum: [
              "pre-commit",
              "pre-push",
              "pre-merge",
              "ci",
              "pre-release",
              "post-release",
              "scheduled",
              "on-claim",
              "on-close",
            ],
          },
        },
      },
    },
  ],
};
