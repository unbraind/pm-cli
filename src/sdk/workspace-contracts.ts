/**
 * @module sdk/workspace-contracts
 *
 * Declares live workspace customization metadata for SDK and MCP consumers.
 */
import type { RegisteredExtensionCommandDefinition } from "../core/extensions/extension-types.js";
import {
  runtimeFieldOptionTarget,
  type RuntimeFieldDefinitionResolved,
} from "../core/schema/runtime-schema.js";
import type { RuntimeFieldType } from "../types/index.js";

/** Runtime custom-field metadata exposed to SDK and MCP consumers. */
export interface WorkspaceFieldContract {
  /** Stable schema key persisted in item metadata. */
  key: string;
  /** Camel-case action option accepted by SDK and MCP calls. */
  optionName: string;
  /** Persisted metadata key. */
  metadataKey: string;
  /** JSON-compatible field value type. */
  type: RuntimeFieldType;
  /** Actions on which the field is accepted. */
  commands: string[];
  /** Whether the action accepts more than one value. */
  repeatable: boolean;
  /** Whether create requires the field for every item. */
  requiredOnCreate: boolean;
  /** Optional agent-facing explanation. */
  description?: string;
}

/** Activated extension command metadata exposed to SDK and MCP consumers. */
export interface WorkspaceExtensionCommandContract {
  /** Canonical command path. */
  command: string;
  /** Action name accepted by generic SDK dispatch. */
  action: string;
  /** Positional argument definitions. */
  arguments: Array<{
    /** Stable positional argument name. */
    name: string;
    /** Whether callers must provide the argument. */
    required: boolean;
    /** Whether the argument accepts multiple values. */
    variadic: boolean;
    /** Optional agent-facing explanation. */
    description?: string;
  }>;
  /** Optional agent-facing explanation. */
  description?: string;
  /** Minimum agent surface tier requested by the extension. */
  tier: "core" | "standard" | "full" | "internal";
}

/** Project resolved custom-field definitions into the public workspace shape. */
export function buildWorkspaceFieldContracts(
  definitions: RuntimeFieldDefinitionResolved[],
): WorkspaceFieldContract[] {
  return definitions.map((definition) => ({
    key: definition.key,
    optionName: runtimeFieldOptionTarget(definition),
    metadataKey: definition.metadata_key,
    type: definition.type,
    commands: [...definition.commands],
    repeatable: definition.repeatable,
    requiredOnCreate: definition.required_on_create,
    ...(definition.description ? { description: definition.description } : {}),
  }));
}

/** Project activated extension registrations into the public workspace shape. */
export function buildWorkspaceExtensionCommandContracts(
  definitions: RegisteredExtensionCommandDefinition[],
): WorkspaceExtensionCommandContract[] {
  return definitions.map((definition) => ({
    command: definition.command,
    action: definition.action,
    arguments: definition.arguments.map((argument) => ({
      name: argument.name,
      required: argument.required === true,
      variadic: argument.variadic === true,
      description: argument.description,
    })),
    description: definition.description,
    tier: definition.tier ?? "standard",
  }));
}
