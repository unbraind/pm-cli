/**
 * @module sdk/read-output/extension
 * Resolves request-local package declarations and validates their structured results.
 */
import { getActiveExtensionRegistrations } from "../../core/extensions/index.js";
import type { RegisteredExtensionCommandDefinition } from "../../core/extensions/extension-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import { isNativeExtensionOutputCommand } from "../../core/extensions/read-output-contract.js";
import { PM_READ_ROW_JQ_SELECTOR } from "../output-projection.js";

/** Find the winning command declaration by CLI path, SDK action or receipt identity. */
export function resolveExtensionOutputCommand(command: string): RegisteredExtensionCommandDefinition | undefined {
  const canonicalPath = command.trim().toLowerCase().startsWith("extension:");
  const normalized = command.trim().toLowerCase().replace(/^extension:/u, "");
  if (isNativeExtensionOutputCommand(normalized)) return undefined;
  const commands = getActiveExtensionRegistrations()?.commands ?? [];
  const commandPath = [...commands].reverse().find((entry) => entry.command === normalized)?.command ?? (canonicalPath ? undefined : commands.find((entry) => entry.action === normalized)?.command);
  const registration = [...commands].reverse().find((entry) => entry.command === commandPath);
  return registration === undefined || isNativeExtensionOutputCommand(registration.command) || isNativeExtensionOutputCommand(registration.action) ? undefined : registration;
}

/** Resolve read permission only from the winning command registration. */
export function resolveExtensionReadOutput(command: string): RegisteredExtensionCommandDefinition | undefined {
  const registration = resolveExtensionOutputCommand(command);
  return registration?.read_output === undefined ? undefined : registration;
}

/** Validate declared rows before projection and attach the host-owned row contract. */
export function attachExtensionReadOutputRows(command: string, result: unknown): unknown {
  const registration = resolveExtensionReadOutput(command);
  const definition = registration?.read_output;
  if (definition === undefined) return result;
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    throw new PmCliError("Read-only extension commands must return a structured object.", EXIT_CODE.USAGE, { code: "extension_read_output_invalid" });
  }
  for (const rowPath of definition.row_keys) {
    let value: unknown = result;
    for (const segment of rowPath.split(".")) {
      value = typeof value === "object" && value !== null && Object.hasOwn(value, segment) ? Reflect.get(value, segment) : undefined;
    }
    if (value === null || typeof value !== "object") {
      throw new PmCliError(`Read-only extension result is missing declared row collection ${rowPath}.`, EXIT_CODE.USAGE, { code: "extension_read_output_invalid" });
    }
  }
  return { ...result, row_contract: {
    command: `extension:${registration!.command}`,
    row_kind: definition.row_keys.length > 0 ? "collection" : "none",
    row_keys: [...definition.row_keys],
    fields: "supported",
    ...(definition.row_keys.length > 0 ? { jq_selector: PM_READ_ROW_JQ_SELECTOR } : {}),
    toon_encoding: "tabular_when_uniform",
  } };
}
