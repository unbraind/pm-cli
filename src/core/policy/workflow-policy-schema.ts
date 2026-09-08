/**
 * @module core/policy/workflow-policy-schema
 *
 * Portable JSON Schema for workspace policy declarations; semantic parsing also
 * rejects duplicate ids and normalizes whitespace and duplicate selector terms.
 */
import { MAX_WORKFLOW_POLICIES, MAX_WORKFLOW_POLICY_TERMS } from "./workflow-policy.js";

const text = { type: "string", minLength: 1, maxLength: 128, pattern: "\\S" };
const terms = { type: "array", minItems: 1, maxItems: MAX_WORKFLOW_POLICY_TERMS, items: text };
const fields = { ...terms, items: { ...text, pattern: "^(?!(?:.*\\.)?(?:__proto__|constructor|prototype)(?:\\.|$))[a-zA-Z_][a-zA-Z0-9_]*(?:\\.[a-zA-Z_][a-zA-Z0-9_]*){0,7}$" } };

/** JSON Schema for a single workflow policy, usable by package authoring tools. */
export const WORKFLOW_POLICY_SCHEMA = {
  type: "object", additionalProperties: false, required: ["id", "rule"],
  properties: {
    id: { type: "string", minLength: 1, maxLength: 128, pattern: "^[a-zA-Z0-9][a-zA-Z0-9._-]*$" },
    description: { type: "string", minLength: 1, maxLength: 500, pattern: "\\S" },
    effect: { enum: ["advise", "warn", "refuse"] },
    subject: { type: "object", additionalProperties: false, properties: {
      ...Object.fromEntries(["types", "tags", "statuses", "operations", "parents"].map((key) => [key, terms])),
      dependency: { type: "object", additionalProperties: false, required: ["kind"], properties: { kind: text, id: text } },
    } },
    rule: { oneOf: [
      { type: "object", additionalProperties: false, required: ["kind", "fields"], properties: { kind: { const: "require_fields" }, fields } },
      { type: "object", additionalProperties: false, required: ["kind", "authors"], properties: { kind: { const: "authors" }, authors: terms } },
      ...["field_writers", "approval"].map((kind) => ({ type: "object", additionalProperties: false, required: ["kind", "fields", "authors"], properties: { kind: { const: kind }, fields, authors: terms } })),
      { type: "object", additionalProperties: false, required: ["kind", "allowed"], properties: {
        kind: { const: "transition" }, allowed: { type: "array", maxItems: MAX_WORKFLOW_POLICY_TERMS, items: { type: "array", minItems: 2, maxItems: 2, items: text } },
      } },
    ] },
  },
} as const;

/** Versioned document schema exported with the SDK so consumers can validate policy files offline. */
export const WORKFLOW_POLICY_DOCUMENT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "pm workflow policy registry",
  type: "object", additionalProperties: false, required: ["version", "policies"],
  properties: {
    version: { const: 1 }, enforcement: { enum: ["advise", "refuse"], default: "advise" },
    policies: { type: "array", maxItems: MAX_WORKFLOW_POLICIES, items: WORKFLOW_POLICY_SCHEMA },
  },
} as const;
